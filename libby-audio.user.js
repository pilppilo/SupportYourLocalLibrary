// ==UserScript==
// @name         Libby Audio Only
// @namespace    http://tampermonkey.net/
// @version      1
// @description  Download the MP3 parts of a borrowed Libby audiobook (plus metadata/ for bakeMetadata.py). No EPUB, no ZIP, no FFmpeg.
// @author       LibbyRip
// @license      MIT
// @match        *://*.listen.libbyapp.com/*
// @match        *://*.listen.overdrive.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

// Chrome/MV3 runs userscripts in an isolated JS world, so `window.BIF` and the
// JSON.parse hook must be installed in the page's own context. Everything below
// lives in `main`, which is stringified and injected once.

(function () {
    function injectPageScript(fn) {
        const code = `(${fn.toString()})();`;
        const run = () => {
            const script = document.createElement("script");
            script.textContent = code;
            (document.documentElement || document.head || document.body).appendChild(script);
            script.remove();
        };
        if (document.documentElement || document.head || document.body) run();
        else document.addEventListener("readystatechange", run, { once: true });
    }

    function main() {
        "use strict";

        const PART_DELAY_MS = 1500;      // politeness gap between parts
        const RETRY_DELAY_MS = 5000;
        const REVOKE_DELAY_MS = 60000;   // immediate revoke breaks Firefox downloads
        const MOUNT_INTERVAL_MS = 500;
        const HALT_STATUSES = [403, 429];

        const state = {
            params: null,        // per-part signed tokens
            parts: null,         // [{ index, spinePosition, path, token, name, url }]
            dirHandle: null,     // FileSystemDirectoryHandle of the book folder
            files: [],           // [{ name, size, handle }]
            running: false,
            cancelled: false,
            lastError: null,
        };

        const log = (...a) => console.log("[lgrab]", ...a);
        const warn = (...a) => console.warn("[lgrab]", ...a);
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // ---------------------------------------------------------------- setup

        // Libby uses the signed `-odread-cmpt-params` to build the mp3 urls and
        // then drops them before exposing the BIF. Catch them as they are parsed.
        function captureParams() {
            if (window.__libregrabHooked) return;
            window.__libregrabHooked = true;

            const original = JSON.parse;
            const hooked = function (...args) {
                const value = original.apply(this, args);
                try {
                    const payload = value && typeof value === "object" && !Array.isArray(value)
                        ? value.b
                        : null;
                    const tokens = payload && payload["-odread-cmpt-params"];
                    if (tokens) {
                        state.params = Array.from(tokens);
                        log("captured", state.params.length, "part tokens");
                    }
                } catch (e) {
                    // never break the page
                }
                return value;
            };
            hooked.__libregrab = true;
            JSON.parse = hooked;
        }

        function captureParamsFromBif() {
            if (state.params) return;
            const tokens = window.BIF && window.BIF.map && window.BIF.map["-odread-cmpt-params"];
            if (tokens) state.params = Array.from(tokens);
        }

        // ---------------------------------------------------------------- data

        function components() {
            const bif = window.BIF;
            const list = bif && bif.objects && bif.objects.spool && bif.objects.spool.components;
            return Array.isArray(list) ? list : null;
        }

        function readParts() {
            const list = components();
            if (!list) throw new Error("BIF not ready (open an audiobook page first)");
            const params = state.params || [];

            const parts = list.map((component, i) => {
                const meta = component.meta || {};
                const index = typeof meta["-odread-spine-position"] === "number"
                    ? meta["-odread-spine-position"]
                    : i;
                const path = String(meta.path || "").replace(/^\/+/, "");
                const token = params[index];
                return {
                    index,
                    spinePosition: component.spinePosition,
                    path,
                    token,
                    name: "Part " + String(index + 1).padStart(3, "0") + ".mp3",
                    url: token ? location.origin + "/" + path + "?" + token : null,
                };
            }).sort((a, b) => a.index - b.index);

            state.parts = parts;
            return parts;
        }

        // Refuse to start on anything that would silently misnumber or miss parts.
        function validate(parts) {
            const count = (components() || []).length;
            const problems = [];

            if (!state.params) problems.push("signed part tokens were not captured yet (reload the page)");
            else if (state.params.length !== count) {
                problems.push(`token count (${state.params.length}) does not match part count (${count})`);
            }

            const seen = new Set();
            for (const part of parts) {
                if (!part.path) problems.push(`part ${part.index}: empty path`);
                if (!part.token) problems.push(`part ${part.index}: no signed token`);
                if (part.index < 0 || part.index >= count) problems.push(`part ${part.index}: index out of range`);
                if (seen.has(part.index)) problems.push(`part ${part.index}: duplicate index`);
                if (typeof part.spinePosition === "number" && part.spinePosition !== part.index) {
                    warn(`part ${part.index}: spinePosition ${part.spinePosition} differs from spine position ${part.index}`);
                }
                seen.add(part.index);
            }

            if (problems.length) {
                console.table(parts.map(p => ({
                    index: p.index,
                    spinePosition: p.spinePosition,
                    path: p.path,
                    hasToken: !!p.token,
                })));
                for (const problem of problems) warn(problem);
            }
            return problems;
        }

        function getTitle() {
            const title = window.BIF && window.BIF.map && window.BIF.map.title;
            return (title && title.main) || "audiobook";
        }

        function getAuthorString() {
            const creators = (window.BIF && window.BIF.map && window.BIF.map.creator) || [];
            const authors = creators
                .filter(c => String(c.role || "").includes("author"))
                .map(c => c.name);
            return authors.join(", ") || "Unknown";
        }

        function coverUrl() {
            try {
                const image = window.BIF.root.querySelector("image");
                return (image && image.getAttribute("href")) || null;
            } catch (e) {
                return null;
            }
        }

        function getMetadata() {
            const map = window.BIF && window.BIF.map;
            if (!map) return null;

            const spine = map.spine || [];
            const spinePaths = spine.map(x => x["-odread-original-path"]);
            const metadata = {
                title: map.title && map.title.main,
                description: map.description,
                coverUrl: coverUrl(),
                creator: map.creator,
                spine: spine.map(x => ({
                    duration: x["audio-duration"],
                    type: x["media-type"],
                    bitrate: x["audio-bitrate"],
                })),
            };

            const toc = map.nav && map.nav.toc;
            if (toc) {
                metadata.chapters = toc.map(entry => {
                    const [path, offset] = String(entry.path).split("#");
                    return {
                        title: entry.title,
                        spine: spinePaths.indexOf(path),
                        offset: 1 * (offset | 0),
                    };
                });
            }
            return metadata;
        }

        // --------------------------------------------------------------- files

        function sanitize(name) {
            const clean = String(name || "")
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
                .replace(/[. ]+$/, "")
                .trim()
                .slice(0, 120);
            return clean || "audiobook";
        }

        function coverExtension(url) {
            const path = String(url).split("?")[0].split("#")[0];
            const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
            return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "jpg";
        }

        async function pickFolder() {
            if (!window.showDirectoryPicker) {
                log("no File System Access API: falling back to per-file downloads");
                state.dirHandle = null;
                return;
            }
            const parent = await window.showDirectoryPicker({ mode: "readwrite" });
            const book = await parent.getDirectoryHandle(
                sanitize(getAuthorString() + " - " + getTitle()),
                { create: true }
            );
            await book.getDirectoryHandle("metadata", { create: true });
            state.dirHandle = book;
        }

        async function writeFile(dir, name, data) {
            const handle = await dir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
        }

        function statusError(status) {
            const error = new Error(`server returned ${status}`);
            error.status = status;
            return error;
        }

        function assertAudio(response) {
            const type = String(response.headers.get("content-type") || "").toLowerCase();
            if (type.includes("text/html") || type.includes("application/json")) {
                throw new Error(`unexpected content-type "${type}"`);
            }
        }

        async function exportMetadata() {
            if (!state.dirHandle) return; // fallback mode: no extra download prompts
            const metadata = getMetadata();
            if (!metadata) return;

            const dir = await state.dirHandle.getDirectoryHandle("metadata", { create: true });
            await writeFile(dir, "metadata.json", JSON.stringify(metadata, null, 2));

            if (metadata.coverUrl) {
                try {
                    const response = await fetch(metadata.coverUrl);
                    if (!response.ok) throw statusError(response.status);
                    await writeFile(dir, "cover." + coverExtension(metadata.coverUrl), await response.blob());
                } catch (e) {
                    warn("cover download failed:", e.message || e);
                }
            }
            log("wrote metadata/metadata.json");
        }

        async function savePartOnce(part) {
            if (state.dirHandle) {
                // Check for an existing file *before* fetching, so resuming a
                // partial download does not re-download finished parts.
                const existing = await state.dirHandle.getFileHandle(part.name).catch(() => null);
                if (existing) {
                    const file = await existing.getFile();
                    if (file.size > 0) {
                        state.files.push({ name: part.name, size: file.size, handle: existing });
                        return false;
                    }
                }
            }

            const response = await fetch(part.url);
            if (!response.ok) throw statusError(response.status);
            assertAudio(response);

            if (!state.dirHandle) {
                // Fallback: one download prompt per part.
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = part.name;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
                state.files.push({ name: part.name, size: blob.size, handle: null });
                return true;
            }

            if (!response.body) throw new Error("empty response body");
            const handle = await state.dirHandle.getFileHandle(part.name, { create: true });
            const writable = await handle.createWritable();
            try {
                await response.body.pipeTo(writable);
            } catch (e) {
                // Never leave a partial file behind to be mistaken for a finished part.
                await writable.abort().catch(() => {});
                await state.dirHandle.removeEntry(part.name).catch(() => {});
                throw e;
            }
            const size = (await handle.getFile()).size;
            state.files.push({ name: part.name, size, handle });
            return true;
        }

        async function savePart(part, attempt = 0) {
            try {
                return await savePartOnce(part);
            } catch (e) {
                const fatal = e && HALT_STATUSES.includes(e.status);
                if (fatal || attempt >= 1) throw e;
                warn(`retrying ${part.name} in ${RETRY_DELAY_MS / 1000}s:`, e.message || e);
                await sleep(RETRY_DELAY_MS);
                return savePart(part, attempt + 1);
            }
        }

        // ------------------------------------------------------------ download

        async function downloadParts(parts) {
            for (let i = 0; i < parts.length; i++) {
                if (state.cancelled) {
                    state.lastError = "cancelled";
                    return;
                }
                const part = parts[i];
                setProgress(i + 1, parts.length, part.name);
                try {
                    const saved = await savePart(part);
                    log(saved ? "saved" : "skipped (already present)", part.name);
                } catch (e) {
                    if (e && HALT_STATUSES.includes(e.status)) {
                        state.lastError = `stopped: server returned ${e.status} — reload the page and click again`;
                        warn(state.lastError);
                        return;
                    }
                    state.lastError = `${part.name}: ${e.message || e}`;
                    warn("failed", part.name, e);
                }
                await sleep(PART_DELAY_MS);
            }
        }

        async function downloadAll() {
            if (state.running) return state.files;

            state.running = true;
            state.cancelled = false;
            state.lastError = null;
            state.files = [];
            updateUi();

            try {
                captureParamsFromBif();
                const parts = readParts();
                const problems = validate(parts);
                if (problems.length) throw new Error(problems[0]);

                try {
                    await pickFolder();
                } catch (e) {
                    if (e && e.name === "AbortError") {
                        state.lastError = "cancelled";
                        return state.files;
                    }
                    throw e;
                }

                await exportMetadata();
                await downloadParts(parts);
            } catch (e) {
                state.lastError = e && e.message ? e.message : String(e);
                warn("run failed:", e);
            } finally {
                state.running = false;
                updateUi();
                log(`finished: ${state.files.length}/${(state.parts || []).length} file(s)`);
                document.dispatchEvent(new CustomEvent("libregrab:done", { detail: state.files.slice() }));
            }
            return state.files;
        }

        // ------------------------------------------------------------------ ui

        let ui = null;

        function mountUi() {
            if (document.getElementById("lgrab")) return;
            const bar = document.querySelector(".nav-progress-bar");
            if (!bar) return;

            const wrap = document.createElement("span");
            wrap.id = "lgrab";
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:.5em;margin:0 .5em";

            const button = document.createElement("button");
            button.id = "lgrabBtn";
            button.textContent = "Grab audio";
            button.style.cssText = "padding:.25em .75em;cursor:pointer";

            const status = document.createElement("span");
            status.id = "lgrabStatus";
            status.style.cssText = "font-size:.85em;opacity:.85";

            button.onclick = () => downloadAll().catch(e => warn(e));
            wrap.append(button, status);
            bar.prepend(wrap);

            ui = { button, status };
            updateUi();
        }

        function setProgress(done, total, name) {
            if (!ui) return;
            ui.button.textContent = `${done}/${total}`;
            ui.status.textContent = name;
        }

        function updateUi() {
            if (!ui) return;
            ui.button.disabled = state.running;
            ui.button.textContent = "Grab audio";

            if (state.running) ui.status.textContent = "starting…";
            else if (state.lastError) ui.status.textContent = state.lastError;
            else if (state.files.length) ui.status.textContent = `${state.files.length} file(s) saved`;
            else ui.status.textContent = "";
        }

        // ---------------------------------------------------------- diagnostics

        function diagnose() {
            captureParamsFromBif();
            let parts = [];
            try {
                parts = readParts();
            } catch (e) {
                warn(e.message);
            }
            const toc = window.BIF && window.BIF.map && window.BIF.map.nav && window.BIF.map.nav.toc;
            const report = {
                tokensCaptured: state.params ? state.params.length : 0,
                components: (components() || []).length,
                parts: parts.length,
                firstUrl: parts[0] && parts[0].url,
                lastUrl: parts.length ? parts[parts.length - 1].url : null,
                hasTOC: !!toc,
                chapters: toc ? toc.length : 0,
                title: getTitle(),
                author: getAuthorString(),
                directoryPicker: !!window.showDirectoryPicker,
            };
            console.table(parts.map(p => ({
                index: p.index,
                spinePosition: p.spinePosition,
                name: p.name,
                hasToken: !!p.token,
            })));
            log(report);
            return report;
        }

        // -------------------------------------------------------------- expose

        captureParams();
        window.__lg = {
            state,
            diagnose,
            parts: readParts,
            validate: () => validate(readParts()),
            capture: captureParams,
            download: downloadAll,
            cancel: () => { state.cancelled = true; },
        };
        setInterval(mountUi, MOUNT_INTERVAL_MS);
        log("ready — run __lg.diagnose() before downloading");
    }

    injectPageScript(main);
})();
