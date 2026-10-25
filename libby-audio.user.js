// ==UserScript==
// @name         Libby Audio
// @namespace    http://tampermonkey.net/
// @version      9
// @description  Download a borrowed Libby audiobook's MP3 parts (plus metadata/ for bakeMetadata.py). No FFmpeg, no sign-in.
// @author       LibbyRip
// @license      MIT
// @match        *://*.listen.libbyapp.com/*
// @match        *://*.listen.overdrive.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// The eData descramble, the staged probe and `extractSpine` are ported from
// JavaGT/libby-archiver (MIT © JavaGT) — https://github.com/JavaGT/libby-archiver
// — see LICENSE-JavaGT.txt. Everything else is LibbyRip's own.
//
// This script is audio only. Ebooks and magazines are a separate concern:
// real ebooks come from `ebook.py` (the .acsm route), and the reader-page
// reconstruction lives in `libby-read.user.js`.

// Chrome/MV3 runs userscripts in an isolated JS world, so `window.BIF` and the
// JSON.parse hook must be installed in the page's own context. Everything below
// lives in `main`, which is stringified and injected once.

(function () {
    // Log before anything else: if this line never appears, the script did not
    // run at all (usually a @match problem), which is otherwise indistinguishable
    // from "ran but the injection was blocked".
    console.log("[lgrab] v9 audio userscript running on " + location.href +
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

        // A part is large and few. Kept in one object so __lg.pacing can retune a
        // run live.
        const pacing = { part: 1500, retry: 5000, revoke: 60000 };
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
            source: null,        // which discovery path supplied the parts ("bif" | "edata")
            edata: null,         // last probeEData result (stages + openbook)
        };

        const log = (...a) => console.log("[lgrab]", ...a);
        const warn = (...a) => console.warn("[lgrab]", ...a);
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // ---------------------------------------------------------- pure ciphers
        // Self-contained and side-effect free: the eData descramble, the staged
        // probe and `extractSpine`. Ported from JavaGT/libby-archiver (MIT ©
        // JavaGT). The markers below are load-bearing: test/ciphers.test.mjs
        // extracts this exact block and runs it under node:test, so keep
        // everything between them free of page globals (no `location`, `log`,
        // `state`).
        // ---- pure-cipher-block:start ----
        // `Buffer.from(x, "base64")` is lenient: whitespace and stray characters
        // are ignored, the data ends at the first `=`, and a trailing group of one
        // character is dropped. `atob` is strict, so mirror that behaviour first,
        // then decode as UTF-8 (OverDrive's base64-utf8-safe).
        function b64ToUtf8(text) {
            let clean = String(text);
            const pad = clean.indexOf("=");
            if (pad !== -1) clean = clean.slice(0, pad);
            clean = clean.replace(/[^A-Za-z0-9+/]/g, "");
            if (clean.length % 4 === 1) clean = clean.slice(0, -1);
            while (clean.length % 4) clean += "=";
            const binary = atob(clean);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        }

        // Undo bifocal's per-position scramble: the key is the reversed buid, a
        // nonzero digit at position a shifts by (a + digit) % 94 with a
        // % 126 + 32 wrap. Non-digits (and zero) are a no-op.
        function descramble(key, data) {
            const klen = key.length || 1;
            const shifts = new Array(klen);
            for (let i = 0; i < klen; i++) shifts[i] = parseInt(key[i], 10) || 0;
            const n = data.length;
            const units = new Uint16Array(n);
            for (let a = 0; a < n; a++) {
                let ch = data.charCodeAt(a);
                const d = shifts[a % klen];
                if (d) {
                    ch += (a + d) % 94;
                    if (ch > 126) ch = (ch % 126) + 32;
                }
                units[a] = ch;
            }
            let out = "";
            for (let at = 0; at < n; at += 8192) {
                out += String.fromCharCode.apply(null, units.subarray(at, Math.min(at + 8192, n)));
            }
            return out;
        }

        const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

        // Parse the eData array literal WITHOUT evaluating it — this text comes off
        // the wire. Strict JSON first, then a character parser that accepts only an
        // array of quoted strings with JS escapes. Anything else is rejected.
        function parseArrayLiteral(literal) {
            try {
                const parsed = JSON.parse(literal);
                if (Array.isArray(parsed) && parsed.every(s => typeof s === "string")) return parsed;
            } catch (e) { /* fall through to the strict string-array parser */ }

            const out = [];
            let cur = "";
            let inString = false;
            let quote = "";
            let seenOpen = false;
            let i = 0;
            const text = String(literal);
            const len = text.length;
            while (i < len) {
                if (!inString) {
                    const c = text[i];
                    if (c === '"' || c === "'") { inString = true; quote = c; i++; }
                    else if (c === "[" && !seenOpen && out.length === 0) { seenOpen = true; i++; }
                    else if (c === "]" || c === "," || /\s/.test(c)) { i++; }
                    else throw new Error("eData literal contains a non-string token near " + JSON.stringify(c));
                    continue;
                }
                if (text[i] === quote) { inString = false; out.push(cur); cur = ""; i++; continue; }
                if (text[i] === "\\") {
                    const e = text[++i];
                    if (e === "x") { cur += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
                    else if (e === "u") { cur += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; }
                    else if (e === undefined) throw new Error("eData literal ends mid-escape");
                    else if (e in SIMPLE_ESCAPES) cur += SIMPLE_ESCAPES[e];
                    else cur += e;
                    i++;
                    continue;
                }
                cur += text[i++];
            }
            if (inString) throw new Error("unterminated string in eData literal");
            if (!seenOpen) throw new Error("eData literal is not an array");
            return out;
        }

        // Decode `window.eData` in named stages, so a wire-format drift is reported
        // as the exact broken contract. Stages: eData-marker (the page still embeds
        // eData), eData-literal (the string array parses), eData-json (descramble +
        // base64 + JSON.parse yield an object), openbook-shape (it carries `.b`).
        function probeEData(playerHtml, buid) {
            const stages = [];
            const match = String(playerHtml).match(
                /window\.eData\s*=\s*(\[[\s\S]*?\])\s*;\s*SPARK\.bifocalPath/);
            stages.push({
                stage: "eData-marker",
                ok: !!match,
                detail: match ? undefined : "window.eData = [...];SPARK.bifocalPath block not found in the page",
            });
            if (!match) return { ok: false, stages };

            let parts;
            try {
                parts = parseArrayLiteral(match[1]);
                stages.push({ stage: "eData-literal", ok: true });
            } catch (e) {
                stages.push({ stage: "eData-literal", ok: false, detail: e.message, drift: "the eData array literal shape changed" });
                return { ok: false, stages };
            }

            let json;
            try {
                const key = String(buid).split("").reverse().join("");
                json = b64ToUtf8(descramble(key, parts.join('"')));
            } catch (e) {
                stages.push({ stage: "eData-json", ok: false, detail: "decode failed: " + (e && e.message || e), drift: "scramble changed (shift %94 / wrap %126+32 / reversed-buid key)" });
                return { ok: false, stages };
            }
            // A scramble drift never throws — it produces garbage text. Canary on JSON-ness.
            if (!/^[\s{\[]/.test(json)) {
                stages.push({
                    stage: "eData-json",
                    ok: false,
                    detail: "decoded payload starts with " + JSON.stringify(json[0] || "") + ", not JSON",
                    drift: "scramble changed (shift %94 / wrap %126+32 / reversed-buid key)",
                });
                return { ok: false, stages };
            }
            let doc;
            try {
                doc = JSON.parse(json);
                stages.push({ stage: "eData-json", ok: true });
            } catch (e) {
                stages.push({ stage: "eData-json", ok: false, detail: e.message, drift: "scramble changed (shift %94 / wrap %126+32 / reversed-buid key)" });
                return { ok: false, stages };
            }

            stages.push({ stage: "openbook-shape", ok: !!doc.b, detail: doc.b ? undefined : "the decoded openbook has no `.b`" });
            if (!doc.b) return { ok: false, stages };

            // Payload keys beside `.b` (spool/reader objects) are kept, not read.
            const extra = { ...doc };
            delete extra.b;
            return {
                ok: true,
                stages,
                openbook: doc.b,
                ...(Object.keys(extra).length ? { extra } : {}),
            };
        }

        // Openbook -> ordered page descriptors. The signed token is indexed by
        // `-odread-spine-position` (the reference convention), and the name comes
        // from `-odread-original-path`.
        function extractSpine(openbook, base) {
            const book = openbook || {};
            const spine = Array.isArray(book.spine) ? book.spine : [];
            const cmpts = book["-odread-cmpt-params"] || [];
            const root = String(base).replace(/\/+$/, "");
            return spine.map((part, i) => {
                const position = typeof part["-odread-spine-position"] === "number" ? part["-odread-spine-position"] : i;
                const token = cmpts[position] || "";
                const urlPath = String(part.path || "").replace(/^\/+/, "");
                return {
                    position: i,
                    tokenIndex: position,
                    path: String(part["-odread-original-path"] || part.path || "").replace(/^\/+/, ""),
                    urlPath,
                    token,
                    url: root + "/" + urlPath + (token ? "?" + token : ""),
                    bytes: part["-odread-file-bytes"],
                    mediaType: part["-media-type"] !== undefined ? part["-media-type"] : part["media-type"],
                    duration: part["audio-duration"],
                    renditionLayout: part["rendition-layout"],
                    renditionViewport: part["rendition-viewport"],
                    meta: part,
                };
            });
        }
        // ---- pure-cipher-block:end ----

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

        // Primary discovery, unchanged from v8: the decoded BIF spool plus the signed
        // tokens captured off the wire. This is the proven path on the real player.
        function readPartsFromBif() {
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

        // ------------------------------------------------------- discovery (audio)

        // The buid is the `dewey-<buid>` subdomain label; the eData key is it reversed.
        function buid() {
            return location.hostname.split(".")[0].replace(/^[^-]+-/, "");
        }

        // Read a failed response: `403 {"result":"whoa"}` is OverDrive's throttling
        // signal and is worth naming; everything else is just the status.
        async function responseError(response) {
            let detail = "";
            try { detail = await response.text(); } catch (e) { /* the body is gone */ }
            let whoa = false;
            try { whoa = JSON.parse(detail).result === "whoa"; } catch (e) { /* not JSON */ }
            const error = new Error(whoa
                ? `server returned ${response.status} (throttling: "whoa") — wait a while, then reload and click again`
                : `server returned ${response.status}`);
            error.status = response.status;
            error.whoa = whoa;
            return error;
        }

        // Same-origin re-fetch of the player page, which carries window.eData.
        // Freshly minted signed tokens come with it, so this is also how a resumed
        // run gets past tokens that expired while the tab sat open.
        async function fetchPlayerHtml() {
            const response = await fetch(location.origin + "/", { headers: { Accept: "text/html" } });
            if (!response.ok) throw await responseError(response);
            return response.text();
        }

        async function probeEDataFromPage() {
            const result = probeEData(await fetchPlayerHtml(), buid());
            state.edata = {
                at: Date.now(),
                ok: result.ok,
                stages: result.stages,
                openbook: result.openbook,
                extra: result.extra,
            };
            return result;
        }

        // Audio-style part list built from a decoded openbook, shaped exactly like
        // readPartsFromBif's output so the rest of the run cannot tell them apart.
        function partsFromOpenbook(openbook) {
            state.params = Array.from(openbook["-odread-cmpt-params"] || []);
            const pages = extractSpine(openbook, location.origin);
            const parts = pages.map((page, i) => {
                const index = typeof page.meta["-odread-spine-position"] === "number"
                    ? page.meta["-odread-spine-position"]
                    : i;
                return {
                    index,
                    tokenIndex: page.tokenIndex,
                    spinePosition: page.tokenIndex,
                    path: page.urlPath,
                    originalPath: page.path,
                    token: page.token,
                    size: page.bytes,
                    name: "Part " + String(index + 1).padStart(3, "0") + ".mp3",
                    url: page.url,
                };
            }).sort((a, b) => a.index - b.index);
            state.parts = parts;
            return parts;
        }

        // Audio discovery with the eData fallback: the proven BIF path stays primary;
        // if it cannot produce a usable list, decode eData ourselves and use that.
        async function discoverParts() {
            let primary = null;
            let problem = null;
            try {
                captureParamsFromBif();
                primary = readPartsFromBif();
                problem = validate(primary)[0] || null;
            } catch (e) {
                problem = e && e.message ? e.message : String(e);
            }
            if (primary && !problem) {
                state.source = "bif";
                return { parts: primary, source: "bif" };
            }

            warn("the BIF path is not usable (" + problem + ") — trying the eData decode");
            let probe = null;
            try {
                probe = await probeEDataFromPage();
            } catch (e) {
                throw new Error("no usable part list: " + problem + "; the eData re-fetch failed (" +
                    (e && e.message ? e.message : e) + ")");
            }
            if (!probe.ok) {
                const failed = probe.stages.find(s => !s.ok);
                throw new Error("no usable part list: " + problem + "; the eData probe failed at " +
                    (failed ? failed.stage : "an unknown stage") +
                    (failed && failed.detail ? " (" + failed.detail + ")" : ""));
            }
            const parts = partsFromOpenbook(probe.openbook);
            const problems = validate(parts, (probe.openbook.spine || []).length);
            if (problems.length) throw new Error("the eData part list did not validate: " + problems[0]);
            state.source = "edata";
            log("using the eData decode:", parts.length, "part(s)");
            return { parts, source: "edata" };
        }

        // Console-facing alias: the primary path only, never a network request.
        function readParts() {
            return readPartsFromBif();
        }

        // Refuse to start on anything that would silently misnumber or miss parts.
        // `expected` overrides the spool count for the eData path, where there are no
        // spool components to count.
        function validate(parts, expected) {
            const count = expected != null ? expected : ((components() || []).length || parts.length);
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

        function publisherOf(creators) {
            const publisher = (creators || []).find(c => /pbl|publish/i.test(String(c.role || "")));
            return publisher ? publisher.name : undefined;
        }

        function getMetadata() {
            const map = window.BIF && window.BIF.map;
            if (!map) return null;

            const spine = map.spine || [];
            const spinePaths = spine.map(x => x["-odread-original-path"]);
            // Everything here is additive: audiobook.py (part_paths, build_chapters)
            // and bakeMetadata.py read the existing keys and ignore new ones.
            const metadata = {
                title: map.title && map.title.main,
                subtitle: map.title && map.title.subtitle,
                description: map.description,
                language: map.language,
                identifier: map["-odread-buid"],
                publisher: publisherOf(map.creator),
                coverUrl: coverUrl(),
                creator: map.creator,
                spine: spine.map(x => ({
                    duration: x["audio-duration"],
                    type: x["media-type"],
                    bitrate: x["audio-bitrate"],
                    bytes: x["-odread-file-bytes"],
                    path: x["-odread-original-path"],
                })),
            };

            const toc = map.nav && map.nav.toc;
            if (toc) {
                metadata.chapters = toc.map(entry => {
                    const [path, offset] = String(entry.path).split("#");
                    // The offset is seconds into that part, and it is not always a
                    // whole number: `| 0` used to throw the fraction away, which
                    // puts every chapter up to a second early once it is baked in.
                    const seconds = parseFloat(offset);
                    return {
                        title: entry.title,
                        spine: spinePaths.indexOf(path),
                        offset: Number.isFinite(seconds) ? seconds : 0,
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
            setTimeout(() => URL.revokeObjectURL(url), pacing.revoke);
        }

        async function writeFile(dir, name, data) {
            const handle = await dir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
        }

        // ------------------------------------------------------------------ zip

        // A dependency-free ZIP writer: local file headers, a central directory, an
        // end-of-central-directory record. Parts are stored (they are already
        // compressed MP3s, so deflate would burn CPU to save nothing). Names are
        // UTF-8 (flag bit 11), because "José Author" has to survive the round trip.

        // ---- pure-zip-block:start ----
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

        // entries: [{ name, blob }]. Store-only: every entry keeps method 0 and the
        // same size in both fields, byte for byte as v8 wrote them. The caller must
        // have refused anything over `limits.zipMaxTotal`; without ZIP64 there is no
        // way to describe it.
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
        // ---- pure-zip-block:end ----

        function assertAudio(response) {
            const type = String(response.headers.get("content-type") || "").toLowerCase();
            if (type.includes("text/html") || type.includes("application/json")) {
                throw new Error(`unexpected content-type "${type}"`);
            }
        }

        // The openbook carries the byte size of every part (`-odread-file-bytes`).
        // A short download is a failed part (the retry path should see it); a long
        // one only warns, in case the manifest number is stale.
        function checkSize(part, size, label) {
            const expected = Number(part && part.size);
            if (!Number.isFinite(expected) || expected <= 0) return;
            if (size < expected) throw new Error(`${label}: received ${size} bytes, expected ${expected}`);
            if (size > expected) warn(`${label}: received ${size} bytes, the manifest says ${expected}`);
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
                    if (!response.ok) throw await responseError(response);
                    await writeFile(dir, name, await response.blob());
                } catch (e) {
                    warn("cover download failed:", e.message || e);
                }
            }
            log("wrote metadata/metadata.json");
        }

        async function fetchPart(part) {
            const response = await fetch(part.url);
            if (!response.ok) throw await responseError(response);
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
            try {
                checkSize(part, size, part.name);
            } catch (e) {
                await state.dirHandle.removeEntry(part.name).catch(() => {});
                throw e;
            }
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
                warn(`retrying ${label} in ${pacing.retry / 1000}s:`, e.message || e);
                await sleep(pacing.retry);
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
                await sleep(pacing.part);
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
                    blob = await retrying(part.name, async () => {
                        const fetched = await fetchPart(part);
                        const body = await fetched.blob();
                        checkSize(part, body.size, part.name);
                        return body;
                    });
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
                await sleep(pacing.part);
            }

            const metadata = getMetadata();
            if (metadata) {
                add("metadata/metadata.json", new Blob(
                    [JSON.stringify(metadata, null, 2)], { type: "application/json" }));
                if (metadata.coverUrl) {
                    try {
                        const response = await fetch(metadata.coverUrl);
                        if (!response.ok) throw await responseError(response);
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
                const discovery = await discoverParts();
                const parts = discovery.parts;
                log(`part discovery: ${discovery.source}`);

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
                parts = readPartsFromBif();
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

        async function diagnose() {
            captureParamsFromBif();
            let parts = [];
            try {
                parts = readPartsFromBif();
            } catch (e) {
                warn(e.message);
            }
            const toc = window.BIF && window.BIF.map && window.BIF.map.nav && window.BIF.map.nav.toc;
            const report = {
                mode: "audio",
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
                source: state.source || null,
                eData: state.edata ? state.edata.stages : "not probed — run __lg.probeEData()",
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
            mode: "audio",
            pacing,
            diagnose,
            where,
            parts: readParts,
            validate: () => validate(readParts()),
            capture: captureParams,
            download: downloadAll,
            probeEData: probeEDataFromPage,
            cipher: { descramble, parseArrayLiteral, probeEData, extractSpine },
            zip: buildZip,
            limits,
            cancel: () => { state.cancelled = true; },
        };
        setInterval(mountUi, MOUNT_INTERVAL_MS);
        document.dispatchEvent(new CustomEvent("libregrab:ready"));
        log("ready (audio) — run __lg.diagnose() before downloading");
    }

    injectPageScript(main);
})();
