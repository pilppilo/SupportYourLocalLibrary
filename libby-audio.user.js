// ==UserScript==
// @name         Libby Audio Only
// @namespace    http://tampermonkey.net/
// @version      7
// @description  Download the MP3 parts of a borrowed Libby audiobook (plus metadata/ for bakeMetadata.py). No EPUB, no FFmpeg.
// @author       LibbyRip
// @license      MIT
// @match        *://*.listen.libbyapp.com/*
// @match        *://*.listen.overdrive.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Chrome/MV3 runs userscripts in an isolated JS world, so `window.BIF` and the
// JSON.parse hook must be installed in the page's own context. Everything below
// lives in `main`, which is stringified and injected once.

(function () {
    // Log before anything else: if this line never appears, the script did not
    // run at all (usually a @match problem), which is otherwise indistinguishable
    // from "ran but the injection was blocked".
    console.log("[lgrab] v7 userscript running on " + location.href +
        (window.top === window ? " (top frame)" : " (iframe)"));

    let injected = false;
    // DOM events cross the isolated/page world boundary, so the injected code
    // reports back through one instead of touching `window`.
    document.addEventListener("libregrab:ready", () => {
        injected = true;
        console.log("[lgrab] injected into the page context — run __lg.diagnose() in this console");
    }, { once: true });

    function injectPageScript(fn) {
        const code = `(${fn.toString()})();`;
        let done = false;
        let observer = null;

        const run = () => {
            if (done) return;
            // At document-start <html> does not exist yet, and appending to
            // `document` itself is not allowed.
            const root = document.documentElement || document.head || document.body;
            if (!root) return;
            done = true;
            if (observer) observer.disconnect();

            const script = document.createElement("script");
            script.textContent = code;
            try {
                root.appendChild(script);
            } catch (e) {
                // A syntax error in the injected text surfaces here as a
                // DOMException; never let it take the page down.
                console.error("[lgrab] could not inject into the page context:", e && e.message ? e.message : e);
            } finally {
                script.remove();
            }
        };

        // A MutationObserver callback is a microtask, so it fires before the
        // next inline <script> in the page runs. Waiting for readystatechange
        // instead would be far too late: every inline script would already have
        // executed, and the JSON.parse hook would miss the part tokens.
        observer = new MutationObserver(run);
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener("readystatechange", run, { once: true });
        run();

        setTimeout(() => {
            if (injected) return;
            console.error(
                "[lgrab] the injected code never reported ready. Usual cause: this " +
                "page's Content-Security-Policy blocked the inline <script>, so " +
                "window.BIF and the JSON.parse hook were never installed."
            );
        }, 3000);
    }

    function main() {
        "use strict";

        // A second injection into the same frame (Tampermonkey can run a
        // document-start script more than once) would otherwise overwrite
        // window.__lg with a fresh, empty state and make captured tokens look
        // like they were never captured.
        if (window.__lg) {
            console.warn("[lgrab] already running in this frame; keeping the existing instance");
            document.dispatchEvent(new CustomEvent("libregrab:ready"));
            return;
        }

        const PART_DELAY_MS = 1500;      // politeness gap between parts
        const RETRY_DELAY_MS = 5000;
        const REVOKE_DELAY_MS = 60000;   // immediate revoke breaks Firefox downloads
        const MOUNT_INTERVAL_MS = 500;
        const HALT_STATUSES = [403, 429];

        // A ZIP entry cannot describe a file of 4 GiB or more without ZIP64
        // records, so a book that big is downloaded as separate files instead.
        // In an object so the guard can be exercised without a 4 GiB book.
        const limits = { zipMaxTotal: 0xffffffff, zipMaxEntries: 0xffff };

        const state = {
            params: null,        // per-part signed tokens
            parts: null,         // [{ index, spinePosition, path, token, name, url }]
            dirHandle: null,     // FileSystemDirectoryHandle of the book folder
            zipName: null,       // name of the single archive, when there is no folder
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
                // Reference implementation (userscript.js getUrls): the signed
                // token is indexed by `spinePosition`, while the part *number*
                // comes from `meta["-odread-spine-position"]`. They are normally
                // equal, but they are not the same field and must not be
                // conflated: using one for both silently downloads the wrong part.
                const tokenIndex = typeof component.spinePosition === "number" ? component.spinePosition : i;
                const index = typeof meta["-odread-spine-position"] === "number"
                    ? meta["-odread-spine-position"]
                    : tokenIndex;
                const path = String(meta.path || "").replace(/^\/+/, "");
                const token = params[tokenIndex];
                return {
                    index,
                    tokenIndex,
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
                if (!part.token) problems.push(`part ${part.index}: no signed token (spinePosition ${part.tokenIndex})`);
                if (part.index < 0 || part.index >= count) problems.push(`part ${part.index}: index out of range`);
                if (part.tokenIndex < 0 || part.tokenIndex >= count) {
                    problems.push(`part ${part.index}: spinePosition ${part.tokenIndex} out of range`);
                }
                if (seen.has(part.index)) problems.push(`part ${part.index}: duplicate index`);
                if (part.spinePosition !== undefined && part.spinePosition !== part.tokenIndex) {
                    warn(`part ${part.index}: spinePosition ${part.spinePosition} differs from the field used for the token (${part.tokenIndex})`);
                }
                if (part.index !== part.tokenIndex) {
                    warn(`part ${part.index}: the part number differs from the field used for the token (${part.tokenIndex}) — using the token index for the URL and the part number for the file name`);
                }
                seen.add(part.index);
            }

            if (problems.length) {
                console.table(parts.map(p => ({
                    index: p.index,
                    tokenIndex: p.tokenIndex,
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
                log("no File System Access API here: falling back to one ZIP download");
                state.dirHandle = null;
                return;
            }
            let parent;
            try {
                parent = await window.showDirectoryPicker({ mode: "readwrite" });
            } catch (e) {
                if (e && e.name === "AbortError") throw e; // the user closed the picker
                // The player runs in a cross-origin subframe of the app, and a
                // cross-origin subframe is not allowed to show a file picker at
                // all. Nothing inside the frame can change that, so fall back to
                // a single ZIP download instead of failing the whole run.
                state.dirHandle = null;
                warn("folder picker unavailable (" + (e && e.message ? e.message : e) +
                    ") — falling back to one ZIP download");
                return;
            }
            const book = await parent.getDirectoryHandle(
                sanitize(getAuthorString() + " - " + getTitle()),
                { create: true }
            );
            await book.getDirectoryHandle("metadata", { create: true });
            state.dirHandle = book;
        }

        // Fallback path: a plain download, no File System Access API involved.
        function saveViaDownload(name, blob) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            (document.body || document.documentElement).appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
        }

        async function writeFile(dir, name, data) {
            const handle = await dir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
        }

        // ------------------------------------------------------------------ zip

        // A store-only ZIP writer. The parts are already-compressed MP3s, so
        // deflate would burn CPU to save nothing, and a ZIP needs no library:
        // local file headers, a central directory, an end-of-central-directory
        // record. Names are UTF-8 (flag bit 11), because "José Author" has to
        // survive the round trip.

        const utf8 = new TextEncoder();
        const ZIP_CHUNK_BYTES = 4 * 1024 * 1024;

        const CRC_TABLE = (() => {
            const table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                table[n] = c >>> 0;
            }
            return table;
        })();

        // Chunked, so a 500 MB part is never held as one ArrayBuffer.
        async function crc32Of(blob) {
            let crc = 0xffffffff;
            for (let at = 0; at < blob.size; at += ZIP_CHUNK_BYTES) {
                const bytes = new Uint8Array(await blob.slice(at, at + ZIP_CHUNK_BYTES).arrayBuffer());
                for (let i = 0; i < bytes.length; i++) {
                    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
                }
            }
            return (crc ^ 0xffffffff) >>> 0;
        }

        function dosStamp(date) {
            return {
                time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
                date: (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
            };
        }

        // entries: [{ name, blob }]. The caller must have refused anything over
        // `limits.zipMaxTotal`; without ZIP64 there is no way to describe it.
        async function buildZip(entries, options) {
            const prefix = (options && options.prefix) || "";
            const stamp = dosStamp(new Date());
            const files = [];
            for (const entry of entries) {
                files.push({
                    name: utf8.encode(prefix + entry.name),
                    blob: entry.blob,
                    size: entry.blob.size,
                    crc: await crc32Of(entry.blob),
                });
            }

            const parts = [];
            const central = [];
            let offset = 0;
            for (const file of files) {
                const header = new Uint8Array(30 + file.name.length);
                const head = new DataView(header.buffer);
                head.setUint32(0, 0x04034b50, true);   // local file header
                head.setUint16(4, 20, true);           // version needed
                head.setUint16(6, 0x0800, true);       // UTF-8 names
                head.setUint16(8, 0, true);            // method: store
                head.setUint16(10, stamp.time, true);
                head.setUint16(12, stamp.date, true);
                head.setUint32(14, file.crc, true);
                head.setUint32(18, file.size, true);
                head.setUint32(22, file.size, true);
                head.setUint16(26, file.name.length, true);
                head.setUint16(28, 0, true);           // no extra field
                header.set(file.name, 30);
                parts.push(header, file.blob);

                const record = new Uint8Array(46 + file.name.length);
                const dir = new DataView(record.buffer);
                dir.setUint32(0, 0x02014b50, true);    // central directory header
                dir.setUint16(4, 20, true);            // version made by
                dir.setUint16(6, 20, true);            // version needed
                dir.setUint16(8, 0x0800, true);        // UTF-8 names
                dir.setUint16(10, 0, true);            // method: store
                dir.setUint16(12, stamp.time, true);
                dir.setUint16(14, stamp.date, true);
                dir.setUint32(16, file.crc, true);
                dir.setUint32(20, file.size, true);
                dir.setUint32(24, file.size, true);
                dir.setUint16(28, file.name.length, true);
                dir.setUint32(42, offset, true);       // local header offset
                record.set(file.name, 46);
                central.push(record);

                offset += header.length + file.size;
            }

            const centralSize = central.reduce((n, record) => n + record.length, 0);
            const end = new Uint8Array(22);
            const eocd = new DataView(end.buffer);
            eocd.setUint32(0, 0x06054b50, true);       // end of central directory
            eocd.setUint16(8, files.length, true);     // entries on this disk
            eocd.setUint16(10, files.length, true);    // total entries
            eocd.setUint32(12, centralSize, true);
            eocd.setUint32(16, offset, true);          // central directory offset
            return new Blob([...parts, ...central, end], { type: "application/zip" });
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
            if (!state.dirHandle) return; // no folder: downloadAsZip() owns the metadata
            const metadata = getMetadata();
            if (!metadata) return;

            const dir = await state.dirHandle.getDirectoryHandle("metadata", { create: true });
            await writeFile(dir, "metadata.json", JSON.stringify(metadata, null, 2));

            if (metadata.coverUrl) {
                const name = "cover." + coverExtension(metadata.coverUrl);
                // Resuming must not re-download the cover on every run.
                const existing = await dir.getFileHandle(name).catch(() => null);
                if (existing) {
                    const file = await existing.getFile().catch(() => null);
                    if (file && file.size > 0) {
                        log("cover already present, not re-downloading");
                        log("wrote metadata/metadata.json");
                        return;
                    }
                }
                try {
                    const response = await fetch(metadata.coverUrl);
                    if (!response.ok) throw statusError(response.status);
                    await writeFile(dir, name, await response.blob());
                } catch (e) {
                    warn("cover download failed:", e.message || e);
                }
            }
            log("wrote metadata/metadata.json");
        }

        async function fetchPart(part) {
            const response = await fetch(part.url);
            if (!response.ok) throw statusError(response.status);
            assertAudio(response);
            return response;
        }

        async function savePartOnce(part) {
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

            const response = await fetchPart(part);
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

        // One retry for a transient failure, never for a status that means "stop
        // asking" (403/429): hammering those only digs the hole deeper.
        async function retrying(label, fn, attempt = 0) {
            try {
                return await fn();
            } catch (e) {
                const fatal = e && HALT_STATUSES.includes(e.status);
                if (fatal || attempt >= 1) throw e;
                warn(`retrying ${label} in ${RETRY_DELAY_MS / 1000}s:`, e.message || e);
                await sleep(RETRY_DELAY_MS);
                return retrying(label, fn, attempt + 1);
            }
        }

        const savePart = part => retrying(part.name, () => savePartOnce(part));

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

        // Fallback mode. A cross-origin subframe cannot open a folder picker, so
        // the parts, the metadata and the cover go into one store-only ZIP: a
        // single download that unpacks into exactly the folder layout the folder
        // path would have written.
        async function downloadAsZip(parts) {
            const book = sanitize(getAuthorString() + " - " + getTitle());
            const zipName = book + ".zip";
            const entries = [];
            let total = 0;
            let zipping = true;

            // Whether the archive still fits is only known as the parts arrive
            // (the sizes are not known up front), so crossing the limit hands the
            // buffered entries to the plain download path and continues there.
            const add = (name, blob) => {
                if (!zipping) {
                    saveViaDownload(name.split("/").pop(), blob);
                    return;
                }
                entries.push({ name, blob });
                total += blob.size;
                if (total >= limits.zipMaxTotal || entries.length >= limits.zipMaxEntries) {
                    zipping = false;
                    warn(`too big for one ZIP (${Math.round(total / 1048576)} MB): ` +
                        "downloading the files individually instead");
                    for (const entry of entries) saveViaDownload(entry.name.split("/").pop(), entry.blob);
                    entries.length = 0;
                }
            };

            for (let i = 0; i < parts.length; i++) {
                if (state.cancelled) {
                    state.lastError = "cancelled";
                    return;
                }
                const part = parts[i];
                setProgress(i + 1, parts.length, part.name);
                let blob;
                try {
                    blob = await retrying(part.name, async () => (await fetchPart(part)).blob());
                } catch (e) {
                    if (e && HALT_STATUSES.includes(e.status)) {
                        state.lastError = `stopped: server returned ${e.status} — reload the page and click again`;
                        warn(state.lastError);
                        return;
                    }
                    // A missing part would make a silently incomplete archive.
                    if (zipping) throw new Error(`${part.name}: ${e.message || e}`);
                    warn("failed", part.name, e);
                    continue;
                }
                add(part.name, blob);
                state.files.push({ name: part.name, size: blob.size, handle: null });
                log("fetched", part.name);
                await sleep(PART_DELAY_MS);
            }

            const metadata = getMetadata();
            if (metadata) {
                add("metadata/metadata.json", new Blob(
                    [JSON.stringify(metadata, null, 2)], { type: "application/json" }));
                if (metadata.coverUrl) {
                    try {
                        const response = await fetch(metadata.coverUrl);
                        if (!response.ok) throw statusError(response.status);
                        add("metadata/cover." + coverExtension(metadata.coverUrl), await response.blob());
                    } catch (e) {
                        warn("cover download failed:", e.message || e);
                    }
                }
            }
            if (!zipping) return;

            if (ui) {
                ui.button.textContent = "zip";
                ui.status.textContent = "building zip…";
            }
            saveViaDownload(zipName, await buildZip(entries, { prefix: book + "/" }));
            state.zipName = zipName;
            log(`downloaded ${zipName}: ${state.files.length} part(s) + metadata/`);
        }

        async function downloadAll() {
            if (state.running) return state.files;

            state.running = true;
            state.cancelled = false;
            state.lastError = null;
            state.zipName = null;
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

                if (state.dirHandle) {
                    await exportMetadata();
                    await downloadParts(parts);
                } else {
                    await downloadAsZip(parts);
                }
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

        // A fixed, self-contained panel. The app's own bars are where this used
        // to be inserted, and its layout has changed enough that the button
        // ended up clipped off the left edge. Nothing about the app's DOM is
        // needed now, so a redesign cannot hide it.
        function createUi() {
            const wrap = document.createElement("div");
            wrap.id = "lgrab";
            wrap.style.cssText = [
                "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
                "display:flex", "align-items:center", "gap:8px",
                "padding:8px 10px", "border-radius:10px",
                "background:rgba(18,18,22,.9)", "color:#fff",
                "font:13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif",
                "box-shadow:0 2px 12px rgba(0,0,0,.45)",
            ].join(";");

            const button = document.createElement("button");
            button.id = "lgrabBtn";
            button.textContent = "Grab audio";
            button.style.cssText = [
                "padding:6px 12px", "cursor:pointer", "border:0", "border-radius:7px",
                "background:#fff", "color:#111", "font:inherit", "font-weight:600",
            ].join(";");

            const status = document.createElement("span");
            status.id = "lgrabStatus";
            status.style.cssText = "max-width:260px;opacity:.85;word-break:break-word";

            button.onclick = () => downloadAll().catch(e => warn(e));
            wrap.append(button, status);
            return { wrap, button, status };
        }

        function mountUi() {
            // In a page with frames, only the frame holding the book mounts a
            // panel, otherwise a nested player would show two of them.
            if (window.top !== window && !components()) return;

            if (!ui) ui = createUi();
            if (!ui.wrap.isConnected) {
                const parent = document.body || document.documentElement;
                if (!parent) return;
                parent.appendChild(ui.wrap);
                updateUi();
            }
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
            else if (state.files.length) {
                if (state.dirHandle) ui.status.textContent = `${state.files.length} file(s) saved`;
                else if (state.zipName) ui.status.textContent = `${state.files.length} parts in 1 zip`;
                else ui.status.textContent = `${state.files.length} file(s) downloaded`;
            }
            else if (summary) ui.status.textContent = summary;
            else ui.status.textContent = "";
        }

        // ------------------------------------------------------ auto report

        // One line, once, without anyone typing into a console: whether the
        // captured tokens line up with the parts is the only thing that has to
        // be known before clicking. Kept in a variable as well as in the panel,
        // because the panel may not exist yet when this runs.
        const startedAt = Date.now();
        let reported = false;
        let summary = null;

        function autoReport() {
            if (reported) return;
            const list = components();
            if (!list) return;
            captureParamsFromBif();
            if (!state.params && Date.now() - startedAt < 15000) return; // give the hook a moment
            reported = true;

            let parts = [];
            try {
                parts = readParts();
            } catch (e) {
                warn(e.message);
            }
            const tokens = state.params ? state.params.length : 0;
            const line = `${tokens} tokens / ${list.length} components / ${parts.length} parts`;
            const aligned = tokens === list.length && parts.length === list.length;
            if (aligned) {
                log(`ready: ${line} — click Grab audio`);
            } else {
                warn(`NOT READY: ${line} — do not start yet, the numbers should match`);
                if (parts.length) validate(parts);
            }
            // Same verdict on the panel, so nothing has to be read in a console.
            summary = aligned
                ? `${list.length} parts ready`
                : `check: ${tokens}/${list.length} tokens`;
            if (ui) updateUi();
        }

        setInterval(autoReport, 500);

        // ---------------------------------------------------------- diagnostics

        // The player runs in a frame, and DevTools evaluates in the top frame by
        // default, so `__lg.diagnose()` there reports an empty state and looks
        // broken. This walks every same-origin frame and says where the book is.
        function where() {
            const rows = [];
            const visit = (win, depth) => {
                const row = { depth, url: null, bif: null, tokens: null, progressBar: null, button: null };
                try { row.url = win.location.href; } catch (e) { row.url = "(cross-origin)"; }
                try {
                    row.bif = !!win.BIF;
                    row.progressBar = !!win.document.querySelector(".nav-progress-bar");
                    row.button = !!win.document.getElementById("lgrabBtn");
                    row.tokens = win.__lg && win.__lg.state && win.__lg.state.params
                        ? win.__lg.state.params.length
                        : null;
                } catch (e) { /* cross-origin frame */ }
                rows.push(row);
                try {
                    for (let i = 0; i < win.frames.length; i++) visit(win.frames[i], depth + 1);
                } catch (e) { /* cross-origin frame */ }
            };
            visit(window.top, 0);
            console.table(rows);
            const book = rows.find(r => r.bif);
            if (!book) log("no frame has window.BIF — open an audiobook, then run this again");
            else if (book.url === location.href) log("this frame has the book; __lg.diagnose() works here");
            else log("the book is in the frame: " + book.url + " — pick it in the DevTools console context dropdown, then run __lg.diagnose()");
            return rows;
        }

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
                frame: window.top === window ? "top" : "iframe",
                url: location.href,
                hasBif: !!window.BIF,
                hasProgressBar: !!document.querySelector(".nav-progress-bar"),
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
                tokenIndex: p.tokenIndex,
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
            where,
            parts: readParts,
            validate: () => validate(readParts()),
            capture: captureParams,
            download: downloadAll,
            zip: buildZip,
            limits,
            cancel: () => { state.cancelled = true; },
        };
        setInterval(mountUi, MOUNT_INTERVAL_MS);
        document.dispatchEvent(new CustomEvent("libregrab:ready"));
        log("ready — run __lg.diagnose() before downloading");
    }

    injectPageScript(main);
})();
