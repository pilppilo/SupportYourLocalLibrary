// ==UserScript==
// @name         Libby Read (ebooks & magazines)
// @namespace    http://tampermonkey.net/
// @version      9
// @description  Rebuild a borrowed Libby ebook/magazine from the reader page as one .epub. A fallback/option — for real ebooks use ebook.py (the .acsm route).
// @author       LibbyRip
// @license      MIT
// @match        *://*.read.libbyapp.com/?*
// @match        *://*.read.overdrive.com/?*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// The eData descramble, the `__bif_cfc1` cipher, the staged probes and the EPUB
// layout are ported from JavaGT/libby-archiver (MIT © JavaGT) —
// https://github.com/JavaGT/libby-archiver — see LICENSE-JavaGT.txt. Everything
// else is LibbyRip's own.
//
// WHAT THIS IS: a reconstruction, not a download. The reader never sends the
// original file — only per-page `<body>` fragments — so the publisher's CSS and
// fonts are gone and typesetting will not match the real book. It is kept as an
// option because magazines (image scans) reconstruct faithfully and usually have
// no .acsm download at all. For reflowable ebooks, prefer `ebook.py`.

// Chrome/MV3 runs userscripts in an isolated JS world, so `window.BIF` and the
// JSON.parse hook must be installed in the page's own context. Everything below
// lives in `main`, which is stringified and injected once.

(function () {
    // Log before anything else: if this line never appears, the script did not
    // run at all (usually a @match problem), which is otherwise indistinguishable
    // from "ran but the injection was blocked".
    console.log("[lgrab] v9 read userscript running on " + location.href +
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

        // Pages and assets are small and many; `part` is unused here but kept so
        // both scripts expose the same `__lg.pacing` shape.
        const pacing = { part: 1500, page: 400, retry: 5000, revoke: 60000 };
        const MOUNT_INTERVAL_MS = 500;
        const HALT_STATUSES = [403, 429];

        const HOST = location.hostname;

        // A ZIP entry cannot describe a file of 4 GiB or more without ZIP64
        // records, so a book that big is downloaded as separate files instead.
        // In an object so the guard can be exercised without a 4 GiB book.
        const limits = { zipMaxTotal: 0xffffffff, zipMaxEntries: 0xffff };

        const state = {
            params: null,        // per-page signed tokens (from the openbook)
            zipName: null,       // name of the single archive
            files: [],           // [{ name, size, handle }]
            running: false,
            cancelled: false,
            lastError: null,
            source: null,        // which discovery path supplied the openbook ("edata" | "bif")
            edata: null,         // last probeEData result (stages + openbook)
            pages: null,         // Map path -> decoded reader page (survives a re-click)
            assets: null,        // Map ref -> { path, blob }
            bookKey: null,       // identity of the book those maps belong to
        };

        const log = (...a) => console.log("[lgrab]", ...a);
        const warn = (...a) => console.warn("[lgrab]", ...a);
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // ---------------------------------------------------------- pure ciphers
        // Self-contained and side-effect free: the eData descramble, the
        // `__bif_cfc1` cipher, the staged probes and the page/asset helpers.
        // Ported from JavaGT/libby-archiver (MIT © JavaGT). The markers below are
        // load-bearing: test/ciphers.test.mjs extracts this exact block and runs
        // it under node:test, so keep everything between them free of page globals
        // (no `location`, `log`, `state`).
        // ---- pure-cipher-block:start ----
        const CFC1_RE = /parent\.__bif_cfc1\(\s*self\s*,\s*'([^']*)'\s*\)/;

        // The four code units a regex `.` refuses to match. A 4-char window holding
        // one cannot match, and the engine resumes just past it.
        function isTerminator(code) {
            return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
        }

        // Swap chars 1 and 4 of every 4-char group — exactly what
        // `blob.replace(/(.)(.)(.)(.)/g, '$4$2$3$1')` does, retries included.
        function swapQuads(text) {
            const n = text.length;
            if (n < 4) return text;
            const units = new Uint16Array(n);
            for (let i = 0; i < n; i++) units[i] = text.charCodeAt(i);
            let i = 0;
            while (i + 4 <= n) {
                let bad = -1;
                for (let k = 0; k < 4; k++) {
                    if (isTerminator(units[i + k])) { bad = i + k; break; }
                }
                if (bad !== -1) { i = bad + 1; continue; }
                const swap = units[i];
                units[i] = units[i + 3];
                units[i + 3] = swap;
                i += 4;
            }
            let out = "";
            for (let at = 0; at < n; at += 8192) {
                out += String.fromCharCode.apply(null, units.subarray(at, Math.min(at + 8192, n)));
            }
            return out;
        }

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

        function cfc1(blob) {
            return b64ToUtf8(swapQuads(blob));
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

        // Decode one `__bif_cfc1` page body in named stages: cfc1-marker (the page
        // still calls parent.__bif_cfc1), content-shape (the body is markup).
        function probeCfc1(html) {
            const stages = [];
            const match = String(html).match(CFC1_RE);
            stages.push({
                stage: "cfc1-marker",
                ok: !!match,
                detail: match ? undefined : "the parent.__bif_cfc1(self, '…') call was not found in the page",
            });
            if (!match) return { ok: false, stages };

            let body;
            try {
                body = cfc1(match[1]);
            } catch (e) {
                stages.push({ stage: "content-shape", ok: false, detail: "decode failed: " + (e && e.message || e) });
                return { ok: false, stages };
            }
            // A cipher drift never throws — it yields base64-ish garbage. Canary on markup-ness.
            const markup = /^\s*</.test(body);
            stages.push({
                stage: "content-shape",
                ok: markup,
                detail: markup ? undefined : "the deciphered body starts with " + JSON.stringify(body[0] || "") + ", not '<'",
            });
            return markup ? { ok: true, stages, body } : { ok: false, stages };
        }

        // Decoded SVG omits the namespace declarations (the browser infers them when
        // injecting into an HTML document). Add them so the page is valid standalone.
        function namespaceSvg(body) {
            return String(body).replace(/<svg\b[^>]*>/gi, tag =>
                /xmlns=/i.test(tag)
                    ? tag
                    : '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' + tag.slice(4));
        }

        // Distinct `assets/…` references (images) out of a decoded page body.
        function assetRefs(body) {
            const refs = new Set();
            for (const m of String(body).matchAll(/(?:href|src)="([^"]*assets\/[^"]+)"/gi)) {
                refs.add(m[1].replace(/^(\.\.\/)+/, "")); // ../assets/x -> assets/x
            }
            return [...refs];
        }

        // Openbook -> ordered page descriptors. The signed token is indexed by
        // `-odread-spine-position` (the reference convention; spine entries have no
        // spool `spinePosition` field), and the EPUB entry name comes from
        // `-odread-original-path`.
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

        // ------------------------------------------------------- discovery (read)

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

        // Same-origin re-fetch of the reader page, which carries window.eData.
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

        // --------------------------------------------------------------- files

        function sanitize(name) {
            const clean = String(name || "")
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
                .replace(/[. ]+$/, "")
                .trim()
                .slice(0, 120);
            return clean || "book";
        }

        function coverExtension(url) {
            const path = String(url).split("?")[0].split("#")[0];
            const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
            return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "jpg";
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

        // ------------------------------------------------------------------ zip

        // A dependency-free ZIP writer: local file headers, a central directory, an
        // end-of-central-directory record. Already-compressed assets are stored;
        // EPUB text entries opt into deflate-raw. Names are UTF-8 (flag bit 11),
        // because "José Author" has to survive the round trip.

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

        // Chunked, so a 500 MB entry is never held as one ArrayBuffer.
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

        // deflate-raw is Chrome 103+/Firefox 113+/Safari 16.4+. When it is missing
        // (or refuses the format), text entries are stored: the EPUB is still valid,
        // just larger. Probed once, then cached.
        let deflateSupport = null;
        async function deflateBlob(blob) {
            if (deflateSupport === false) return null;
            if (typeof CompressionStream !== "function" || !blob.stream) {
                deflateSupport = false;
                return null;
            }
            try {
                const out = await new Response(
                    blob.stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
                deflateSupport = true;
                return out;
            } catch (e) {
                deflateSupport = false;
                warn("deflate-raw is unavailable in this browser; storing the EPUB uncompressed");
                return null;
            }
        }

        // entries: [{ name, blob, compress? }]. `compress` asks for deflate-raw on
        // that entry (still stored if it would not shrink, or if the browser cannot
        // deflate). The caller must have refused anything over `limits.zipMaxTotal`;
        // without ZIP64 there is no way to describe it.
        async function buildZip(entries, options) {
            const prefix = (options && options.prefix) || "";
            const stamp = dosStamp(new Date());
            const files = [];
            for (const entry of entries) {
                const raw = entry.blob;
                let payload = raw;
                let method = 0;
                if (entry.compress) {
                    const deflated = await deflateBlob(raw);
                    if (deflated && deflated.size < raw.size) {
                        payload = deflated;
                        method = 8;
                    }
                }
                files.push({
                    name: utf8.encode(prefix + entry.name),
                    blob: payload,
                    size: payload.size,      // what is on disk
                    rawSize: raw.size,
                    method,
                    crc: await crc32Of(raw), // the CRC is always over the uncompressed bytes
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
                head.setUint16(8, file.method, true);
                head.setUint16(10, stamp.time, true);
                head.setUint16(12, stamp.date, true);
                head.setUint32(14, file.crc, true);
                head.setUint32(18, file.size, true);   // compressed size
                head.setUint32(22, file.rawSize, true); // uncompressed size
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
                dir.setUint16(10, file.method, true);
                dir.setUint16(12, stamp.time, true);
                dir.setUint16(14, stamp.date, true);
                dir.setUint32(16, file.crc, true);
                dir.setUint32(20, file.size, true);
                dir.setUint32(24, file.rawSize, true);
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

        // ----------------------------------------------------------------- books

        // ---- pure-epub-block:start ----
        const STORE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "mp3", "mp4", "m4a", "pdf"]);

        function xmlEscape(value) {
            return String(value == null ? "" : value)
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // invalid in XML 1.0
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        }

        // Entry names come from the openbook — refuse anything that could escape OEBPS/.
        function safeZipName(name) {
            const clean = String(name);
            if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) {
                throw new Error("unsafe EPUB entry name: " + name);
            }
            return clean;
        }

        function mimeOf(name) {
            const ext = String(name).split(".").pop().toLowerCase();
            return {
                jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
                gif: "image/gif", svg: "image/svg+xml",
            }[ext] || "application/octet-stream";
        }

        function idFor(path, used) {
            const base = "i" + String(path).replace(/[^A-Za-z0-9]+/g, "_");
            let id = base;
            let n = 1;
            while (used.has(id)) id = base + "_" + (n++);
            used.add(id);
            return id;
        }

        function wrapPage(body, viewport) {
            const vp = viewport && viewport.width && viewport.height
                ? `\n  <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}"/>` : "";
            return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
                '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
                '<head>\n  <meta charset="utf-8"/>\n  <title></title>' + vp + '\n' +
                '  <style>html,body{margin:0;padding:0}svg,img{display:block;max-width:100%}</style>\n' +
                '</head>\n' + body + '\n</html>\n';
        }

        // EPUB 3 entry list: mimetype first and stored, text entries deflated where
        // the browser can, already-compressed images stored. Pages keep their
        // openbook-relative paths so the un-rewritten ../assets/… hrefs inside them
        // resolve; assets land flat at OEBPS/assets/….
        function buildBookEntries(book) {
            const used = new Set();
            const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            const textEntry = (name, value) => ({
                name,
                blob: new Blob([value], { type: "application/xhtml+xml" }),
                text: value,
                compress: true,
            });

            const pageItems = book.pages.map(page => ({ id: idFor(page.path, used), href: page.path, page }));
            const assetItems = book.assets.map(asset => ({ id: idFor(asset.path, used), href: asset.path, asset }));
            const coverItem = book.cover ? { id: idFor(book.cover.path, used), href: book.cover.path, cover: book.cover } : null;

            const entries = [
                { name: "mimetype", blob: new Blob(["application/epub+zip"], { type: "text/plain" }), text: "application/epub+zip", compress: false },
                textEntry("META-INF/container.xml",
                    '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
                    '  <rootfiles>\n' +
                    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
                    '  </rootfiles>\n</container>\n'),
            ];

            for (const item of pageItems) {
                entries.push(textEntry(safeZipName("OEBPS/" + item.href), wrapPage(item.page.body, item.page.viewport)));
            }
            for (const item of assetItems) {
                const ext = String(item.href).split(".").pop().toLowerCase();
                entries.push({ name: safeZipName("OEBPS/" + item.href), blob: item.asset.blob, compress: !STORE_EXT.has(ext) });
            }
            if (coverItem) {
                const ext = String(coverItem.href).split(".").pop().toLowerCase();
                entries.push({ name: safeZipName("OEBPS/" + coverItem.href), blob: coverItem.cover.blob, compress: !STORE_EXT.has(ext) });
            }

            const spinePaths = new Set(book.pages.map(page => page.path));
            const navList = (book.nav || []).filter(entry => spinePaths.has(entry.href));
            const fallbackNav = pageItems.map(item => ({ title: item.href, href: item.href }));
            const navBody = (navList.length ? navList : fallbackNav)
                .map(entry => `      <li><a href="${xmlEscape(entry.href)}">${xmlEscape(entry.title)}</a></li>`).join("\n");
            entries.push(textEntry("OEBPS/nav.xhtml",
                '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
                '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
                `<head><meta charset="utf-8"/><title>${xmlEscape(book.meta.title)}</title></head>\n` +
                '<body>\n  <nav epub:type="toc" id="toc">\n' +
                `    <h1>${xmlEscape(book.meta.title)}</h1>\n    <ol>\n${navBody}\n    </ol>\n` +
                '  </nav>\n</body>\n</html>\n'));

            const ncxPoints = (navList.length ? navList : fallbackNav)
                .map((entry, i) => `    <navPoint id="np${i}" playOrder="${i + 1}">\n` +
                    `      <navLabel><text>${xmlEscape(entry.title)}</text></navLabel>\n` +
                    `      <content src="${xmlEscape(entry.href)}"/>\n    </navPoint>`).join("\n");
            entries.push(textEntry("OEBPS/toc.ncx",
                '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
                `  <head><meta name="dtb:uid" content="${xmlEscape(book.meta.identifier)}"/></head>\n` +
                `  <docTitle><text>${xmlEscape(book.meta.title)}</text></docTitle>\n  <navMap>\n${ncxPoints}\n  </navMap>\n</ncx>\n`));

            const dc = [
                `    <dc:identifier id="pub-id">${xmlEscape(book.meta.identifier)}</dc:identifier>`,
                `    <dc:title>${xmlEscape(book.meta.title)}${book.meta.subtitle ? ": " + xmlEscape(book.meta.subtitle) : ""}</dc:title>`,
                `    <dc:language>${xmlEscape(book.meta.language || "en")}</dc:language>`,
                book.meta.creator ? `    <dc:creator>${xmlEscape(book.meta.creator)}</dc:creator>` : "",
                book.meta.publisher ? `    <dc:publisher>${xmlEscape(book.meta.publisher)}</dc:publisher>` : "",
                book.meta.description ? `    <dc:description>${xmlEscape(book.meta.description)}</dc:description>` : "",
                `    <meta property="dcterms:modified">${modified}</meta>`,
                coverItem ? `    <meta name="cover" content="${coverItem.id}"/>` : "",
                book.fixedLayout ? `    <meta property="rendition:layout">pre-paginated</meta>` : "",
                book.fixedLayout ? `    <meta property="rendition:orientation">auto</meta>` : "",
                book.fixedLayout ? `    <meta property="rendition:spread">auto</meta>` : "",
            ].filter(Boolean);

            const manifest = [
                `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
                `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
                coverItem ? `    <item id="${coverItem.id}" href="${xmlEscape(coverItem.href)}" media-type="${mimeOf(coverItem.href)}" properties="cover-image"/>` : "",
                ...pageItems.map(item => `    <item id="${item.id}" href="${xmlEscape(item.href)}" media-type="application/xhtml+xml"/>`),
                ...assetItems.map(item => `    <item id="${item.id}" href="${xmlEscape(item.href)}" media-type="${mimeOf(item.href)}"/>`),
            ].filter(Boolean);

            entries.push(textEntry("OEBPS/content.opf",
                '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"' +
                ' prefix="rendition: http://www.idpf.org/vocab/rendition/#">\n' +
                `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n${dc.join("\n")}\n  </metadata>\n` +
                `  <manifest>\n${manifest.join("\n")}\n  </manifest>\n` +
                '  <spine toc="ncx">\n' +
                `${pageItems.map(item => `    <itemref idref="${item.id}"/>`).join("\n")}\n  </spine>\n` +
                '</package>\n'));

            return entries;
        }
        // ---- pure-epub-block:end ----

        function publisherOf(creators) {
            const publisher = (creators || []).find(c => /pbl|publish/i.test(String(c.role || "")));
            return publisher ? publisher.name : undefined;
        }

        function bookMeta(openbook) {
            const creators = openbook.creator || [];
            const author = (creators.find(c => /aut/i.test(String(c.role || ""))) || creators[0] || {}).name;
            const description = String(openbook.description || "")
                .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
            const mapTitle = window.BIF && window.BIF.map && window.BIF.map.title;
            return {
                identifier: openbook["-odread-buid"] || "libby-" + HOST,
                title: (openbook.title && openbook.title.main) || (mapTitle && mapTitle.main) || "book",
                subtitle: (openbook.title && openbook.title.subtitle) || (mapTitle && mapTitle.subtitle),
                creator: author || "Unknown",
                publisher: publisherOf(creators),
                language: Array.isArray(openbook.language) ? openbook.language[0] : openbook.language,
                description: description || undefined,
            };
        }

        // TOC entries that resolve to real spine pages. Magazines anchor their TOC
        // to story files; the printed page number maps to pages/N.xhtml.
        function buildBookNav(openbook, spinePaths) {
            const out = [];
            for (const entry of (openbook.nav && openbook.nav.toc) || []) {
                let href = String(entry.path || "").split("#")[0];
                if (!spinePaths.has(href)) {
                    const digits = String(entry.pageRange || "").match(/\d+/);
                    const guess = digits && "pages/" + digits[0] + ".xhtml";
                    href = guess && spinePaths.has(guess) ? guess : null;
                }
                if (href) out.push({ title: entry.title || entry.sectionName || entry.pageRange || href, href });
            }
            return out;
        }

        async function fetchBookCover() {
            let url = null;
            try {
                const image = window.BIF && window.BIF.root && window.BIF.root.querySelector("image");
                url = image && image.getAttribute("href");
            } catch (e) { /* no BIF root in this frame */ }
            if (!url) return null;
            try {
                const response = await fetch(url);
                if (!response.ok) throw await responseError(response);
                const blob = await response.blob();
                return blob.size ? { path: "cover." + coverExtension(url), blob } : null;
            } catch (e) {
                warn("cover download failed:", e.message || e);
                return null;
            }
        }

        // In-page structural check before saving: every page parses as XML and
        // every relative reference resolves to an entry in the archive. The
        // independent Python validator is the real judge; this catches a broken
        // assembly while the data is still in hand.
        function verifyBookEntries(entries) {
            const problems = [];
            const names = new Set(entries.map(entry => entry.name));
            const byName = new Map(entries.map(entry => [entry.name, entry]));
            const parser = new DOMParser();

            if (entries[0].name !== "mimetype") problems.push("mimetype is not the first entry");
            if (!byName.has("META-INF/container.xml")) problems.push("no META-INF/container.xml");
            for (const entry of entries) {
                if (!entry.blob || !entry.blob.size) problems.push(`${entry.name}: empty entry`);
            }

            for (const entry of entries) {
                if (!entry.name.startsWith("OEBPS/") || !/\.x?html?$/.test(entry.name) || !entry.text) continue;
                const doc = parser.parseFromString(entry.text, "application/xml");
                if (doc.getElementsByTagName("parsererror").length) {
                    problems.push(`${entry.name}: does not parse as XML`);
                    continue;
                }
                for (const match of entry.text.matchAll(/(?:src|href)="([^"]+)"/gi)) {
                    const ref = match[1];
                    if (/^([a-z]+:|#)/i.test(ref)) continue;
                    const resolved = new URL(ref, "http://epub.invalid/" + entry.name).pathname.slice(1);
                    if (!names.has(resolved)) problems.push(`${entry.name}: ${ref} -> ${resolved} is not in the archive`);
                }
            }

            const opf = byName.get("OEBPS/content.opf");
            if (!opf || !opf.text) {
                problems.push("no OEBPS/content.opf");
                return problems;
            }
            const doc = parser.parseFromString(opf.text, "application/xml");
            if (doc.getElementsByTagName("parsererror").length) problems.push("OEBPS/content.opf: does not parse as XML");
            const manifestIds = new Set();
            for (const item of doc.getElementsByTagName("item")) {
                manifestIds.add(item.getAttribute("id"));
                const href = item.getAttribute("href");
                if (href && !names.has("OEBPS/" + href)) problems.push(`content.opf: manifest href ${href} is missing`);
            }
            for (const itemref of doc.getElementsByTagName("itemref")) {
                const idref = itemref.getAttribute("idref");
                if (!manifestIds.has(idref)) problems.push(`content.opf: spine idref ${idref} is not in the manifest`);
            }
            return problems;
        }

        async function grabBook() {
            if (state.running) return state.files;

            state.running = true;
            state.cancelled = false;
            state.lastError = null;
            state.zipName = null;
            state.files = [];
            state.pages = state.pages || new Map();
            state.assets = state.assets || new Map();
            updateUi();

            try {
                // 1. the openbook: eData is primary on this host, window.BIF the
                //    already-decoded fallback.
                let openbook = null;
                let probe = null;
                try {
                    probe = await probeEDataFromPage();
                } catch (e) {
                    warn("could not re-read the reader page for eData:", e.message || e);
                }
                if (probe && probe.ok) {
                    openbook = probe.openbook;
                    state.source = "edata";
                } else {
                    const failed = probe && probe.stages.find(s => !s.ok);
                    warn("the eData probe failed" +
                        (failed ? " at " + failed.stage : "") +
                        (failed && failed.detail ? " (" + failed.detail + ")" : "") +
                        " — falling back to window.BIF");
                    const map = window.BIF && window.BIF.map;
                    if (map && map.spine) {
                        openbook = {
                            spine: map.spine,
                            "-odread-cmpt-params": map["-odread-cmpt-params"] || state.params || [],
                        };
                        state.source = "bif";
                    }
                }
                if (!openbook) throw new Error("no openbook: the eData probe failed and window.BIF has no spine");
                log("openbook from " + state.source + ":", (openbook.spine || []).length, "page(s)");

                const pages = extractSpine(openbook, location.origin);
                if (!pages.length) throw new Error("the openbook has no spine pages");
                const fixedLayout = pages.some(page => page.renditionLayout === "pre-paginated");

                // A different loan opened in the same frame must not mix its pages in.
                const bookKey = String(openbook["-odread-buid"] || "") + "|" + pages.map(p => p.path).join(",");
                if (state.bookKey !== bookKey) {
                    state.bookKey = bookKey;
                    state.pages = new Map();
                    state.assets = new Map();
                }

                // 2. pages: fetch and decode, skipping anything already decoded.
                for (let i = 0; i < pages.length; i++) {
                    if (state.cancelled) { state.lastError = "cancelled"; return state.files; }
                    const page = pages[i];
                    setProgress(i + 1, pages.length, page.path);
                    if (state.pages.has(page.path)) continue;
                    const response = await fetch(page.url, { headers: { Accept: "*/*" } });
                    if (!response.ok) throw await responseError(response);
                    const decoded = probeCfc1(await response.text());
                    if (!decoded.ok) {
                        const failed = decoded.stages.find(s => !s.ok);
                        throw new Error("page " + page.path + " failed at " + failed.stage +
                            (failed.detail ? ": " + failed.detail : ""));
                    }
                    const body = namespaceSvg(decoded.body);
                    state.pages.set(page.path, {
                        path: page.path,
                        body,
                        viewport: page.renditionViewport,
                        refs: assetRefs(body),
                    });
                    await sleep(pacing.page);
                }

                // 3. assets: cookie only, no signed token needed.
                const wanted = [];
                for (const page of state.pages.values()) {
                    for (const ref of page.refs) if (!wanted.includes(ref)) wanted.push(ref);
                }
                for (let i = 0; i < wanted.length; i++) {
                    if (state.cancelled) { state.lastError = "cancelled"; return state.files; }
                    const ref = wanted[i];
                    if (state.assets.has(ref)) continue;
                    setProgress(i + 1, wanted.length, ref);
                    try {
                        const response = await fetch(location.origin + "/" + ref, { headers: { Accept: "*/*" } });
                        if (!response.ok) {
                            warn("asset " + ref + " -> HTTP " + response.status + " (skipped)");
                            continue;
                        }
                        state.assets.set(ref, { path: ref, blob: await response.blob() });
                    } catch (e) {
                        warn("asset " + ref + " failed:", e.message || e);
                    }
                    await sleep(pacing.page);
                }

                // 4. assemble, check, save.
                const meta = bookMeta(openbook);
                const entries = buildBookEntries({
                    meta,
                    pages: [...state.pages.values()],
                    assets: [...state.assets.values()],
                    cover: await fetchBookCover(),
                    nav: buildBookNav(openbook, new Set(pages.map(page => page.path))),
                    fixedLayout,
                });
                const problems = verifyBookEntries(entries);
                for (const problem of problems) warn("verify:", problem);
                const fatal = problems.find(problem =>
                    /mimetype|empty entry|no META-INF|no OEBPS|manifest href|idref/.test(problem));
                if (fatal) throw new Error("the EPUB did not verify: " + fatal);

                if (ui) {
                    ui.button.textContent = "zip";
                    ui.status.textContent = "building epub…";
                }
                const name = sanitize(meta.creator + " - " + meta.title) + ".epub";
                saveViaDownload(name, await buildZip(entries));
                state.zipName = name;
                state.files = entries.map(entry => ({ name: entry.name, size: entry.blob.size, handle: null }));
                log(`downloaded ${name}: ${state.files.length} entries, ` +
                    `${state.pages.size} page(s), ${state.assets.size} asset(s)`);
                if (problems.length) state.lastError = `saved with ${problems.length} warning(s) — see the console`;
            } catch (e) {
                state.lastError = e && e.message ? e.message : String(e);
                warn("run failed:", e);
            } finally {
                state.running = false;
                updateUi();
                document.dispatchEvent(new CustomEvent("libregrab:done", { detail: state.files.slice() }));
            }
            return state.files;
        }

        // ------------------------------------------------------------------ ui

        let ui = null;

        // A fixed, self-contained panel. Nothing about the app's DOM is needed, so
        // a redesign cannot hide it.
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
            button.textContent = "Grab book";
            button.style.cssText = [
                "padding:6px 12px", "cursor:pointer", "border:0", "border-radius:7px",
                "background:#fff", "color:#111", "font:inherit", "font-weight:600",
            ].join(";");

            const status = document.createElement("span");
            status.id = "lgrabStatus";
            status.style.cssText = "max-width:260px;opacity:.85;word-break:break-word";

            button.onclick = () => grabBook().catch(e => warn(e));
            wrap.append(button, status);
            return { wrap, button, status };
        }

        function mountUi() {
            // The reader root frame is the only frame that is not a spine-page
            // iframe, so only it mounts a panel.
            if (location.pathname !== "/") return;

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
            ui.button.textContent = "Grab book";

            if (state.running) ui.status.textContent = "starting…";
            else if (state.lastError) ui.status.textContent = state.lastError;
            else if (state.files.length) {
                if (state.zipName) ui.status.textContent = `1 epub (${state.pages ? state.pages.size : 0} page(s))`;
                else ui.status.textContent = `${state.files.length} file(s) downloaded`;
            }
            else if (summary) ui.status.textContent = summary;
            else ui.status.textContent = "";
        }

        // ------------------------------------------------------ auto report

        const startedAt = Date.now();
        let reported = false;
        let summary = null;

        function autoReport() {
            if (reported) return;
            // No polling requests on a reader page: report the decoded spine if
            // the page has already decoded it for us.
            const map = window.BIF && window.BIF.map;
            if (!map || !map.spine) return;
            reported = true;
            summary = `${map.spine.length} page(s) ready`;
            log(`ready: ${summary} — click Grab book`);
            if (ui) updateUi();
        }

        setInterval(autoReport, 500);

        // ---------------------------------------------------------- diagnostics

        async function diagnose() {
            const report = {
                mode: "book",
                frame: window.top === window ? "top" : "iframe",
                url: location.href,
                hasBif: !!window.BIF,
                directoryPicker: !!window.showDirectoryPicker,
                source: state.source || null,
                pagesDecoded: state.pages ? state.pages.size : 0,
                assetsFetched: state.assets ? state.assets.size : 0,
            };

            try {
                const probe = await probeEDataFromPage();
                report.eData = probe.stages;
                if (probe.ok) {
                    const pages = extractSpine(probe.openbook, location.origin);
                    report.openbookFrom = "edata";
                    report.pages = pages.length;
                    report.fixedLayout = pages.some(p => p.renditionLayout === "pre-paginated");
                    report.firstPageUrl = pages[0] && pages[0].url;
                    console.table(pages.map(p => ({
                        position: p.position,
                        tokenIndex: p.tokenIndex,
                        path: p.path,
                        hasToken: !!p.token,
                    })));
                } else {
                    report.openbookFrom = window.BIF && window.BIF.map && window.BIF.map.spine ? "bif" : null;
                }
            } catch (e) {
                report.eDataError = e.message || String(e);
            }
            log(report);
            return report;
        }

        // -------------------------------------------------------------- expose

        window.__lg = {
            state,
            mode: "book",
            pacing,
            diagnose,
            grabBook,
            probeEData: probeEDataFromPage,
            cipher: { descramble, cfc1, parseArrayLiteral, probeEData, probeCfc1, extractSpine, namespaceSvg, assetRefs },
            zip: buildZip,
            limits,
            cancel: () => { state.cancelled = true; },
        };
        setInterval(mountUi, MOUNT_INTERVAL_MS);
        document.dispatchEvent(new CustomEvent("libregrab:ready"));
        log("ready (book) — run __lg.diagnose() before downloading");
    }

    injectPageScript(main);
})();
