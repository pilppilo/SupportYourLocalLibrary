// Cipher and probe fixtures for the pure blocks in the two userscripts.
//
// The scripts are single files, so the tests do not import them: they extract the
// block between the `pure-cipher-block` markers and run that exact text here.
// Since the split, `descramble`/`parseArrayLiteral`/`b64ToUtf8`/`probeEData`/
// `extractSpine` live in BOTH scripts (audio uses the eData fallback too), while
// `cfc1`/`probeCfc1`/`namespaceSvg`/`assetRefs` live only in the read script.
// The shared functions are therefore tested twice, once per file.
//
// The oracles are independent of the port:
//   - `scramble` brute-forces the printable char whose scrambled output is the
//     target, inverting descramble position by position.
//   - `refCfc1` is the original one-line regex transform the port hand-rolls.
//   - `refDescramble` is the character-loop reference the port must match.
//
//     node --test "test/*.test.mjs"

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const BLOCK_START = "// ---- pure-cipher-block:start ----";
const BLOCK_END = "// ---- pure-cipher-block:end ----";

function loadApi(file, names) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const start = source.indexOf(BLOCK_START);
    const end = source.indexOf(BLOCK_END);
    assert.ok(start !== -1 && end > start, `${file}: the pure-cipher-block markers must be present`);
    const block = source.slice(start + BLOCK_START.length, end);
    return new Function(`${block}\nreturn { ${names.join(", ")} };`)();
}

const SHARED = ["descramble", "parseArrayLiteral", "b64ToUtf8", "probeEData", "extractSpine"];
const READ_ONLY = ["cfc1", "probeCfc1", "namespaceSvg", "assetRefs"];

const apis = {
    "libby-audio": loadApi("libby-audio.user.js", SHARED),
    "libby-read": loadApi("libby-read.user.js", [...SHARED, ...READ_ONLY]),
};

// ---------------------------------------------------------------- oracles

// Forward (encode) direction of bifocal's descramble. The shift is constant at
// each position, so the mapping is injective there and this inverts exactly.
function scramble(key, data) {
    let out = "";
    for (let a = 0; a < data.length; a++) {
        const target = data.charCodeAt(a);
        const d = parseFloat(key[a % key.length]);
        if (!d) { out += data[a]; continue; }
        let found = data[a];
        for (let c = 32; c <= 126; c++) {
            let y = c + ((a + d) % 94);
            if (y > 126) y = (y % 126) + 32;
            if (y === target) { found = String.fromCharCode(c); break; }
        }
        out += found;
    }
    return out;
}

// The character-loop reference the port must match, including its exact wrap.
function refDescramble(key, data) {
    const klen = key.length;
    const shifts = new Array(klen);
    for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
    const out = new Array(data.length);
    for (let a = 0; a < data.length; a++) {
        let ch = data.charCodeAt(a);
        const d = shifts[a % klen];
        if (d) {
            ch += (a + d) % 94;
            if (ch > 126) ch = (ch % 126) + 32;
        }
        out[a] = String.fromCharCode(ch);
    }
    return out.join("");
}

// Exactly what cfc1 did before the hand-rolled loop.
const refCfc1 = s => Buffer.from(s.replace(/(.)(.)(.)(.)/g, "$4$2$3$1"), "base64").toString("utf8");
const encodeCfc1 = s => Buffer.from(s, "utf8").toString("base64").replace(/(.)(.)(.)(.)/g, "$4$2$3$1");

const page = literal => `<!doctype html><script>window.eData = ${literal};SPARK.bifocalPath='bifocal.js';</script>`;
const BUID = "ab9cd"; // carries a nonzero digit, so the scramble engages

function encodedFixture(doc, { singleQuoted = false } = {}) {
    const json = Buffer.from(JSON.stringify(doc)).toString("base64");
    const scrambled = scramble(BUID.split("").reverse().join(""), json);
    if (!singleQuoted) return JSON.stringify(scrambled.split('"'));
    const escaped = scrambled.split('"').map(s => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
    return "[" + escaped.map(s => `'${s}'`).join(",") + "]";
}

// ------------------------------------------------- shared: both scripts

for (const [file, api] of Object.entries(apis)) {
    const { descramble, parseArrayLiteral, b64ToUtf8, probeEData, extractSpine } = api;

    test(`${file}: descramble inverts the scramble`, () => {
        const doc = { b: { spine: [{ path: "p1.mp3" }], title: { main: "Dune" } } };
        const payload = Buffer.from(JSON.stringify(doc)).toString("base64");
        assert.equal(descramble(BUID.split("").reverse().join(""), scramble(BUID.split("").reverse().join(""), payload)), payload);
    });

    test(`${file}: descramble matches the character-loop reference`, () => {
        const cases = [
            ["dcba9", ""],
            ["dcba9", "abcdefghijklmnopqrstuvwxyz0123456789+/= ABCDEF"],
            ["9a2f4ed7", "x".repeat(5000) + "\x7f tail"],
            ["dcba0", "digit zero parses to shift 0 — untouched"],
            ["dcba9", "é-latin1-range\uffff"],
            ["9a2f4ed7", "a\u2028b€c\ud83d\ude00"],
        ];
        for (const [key, data] of cases) {
            assert.equal(descramble(key, data), refDescramble(key, data), JSON.stringify(data.slice(0, 24)));
        }
    });

    test(`${file}: parseArrayLiteral accepts JSON and single-quoted literals`, () => {
        assert.deepEqual(parseArrayLiteral('["a","b c"]'), ["a", "b c"]);
        assert.deepEqual(parseArrayLiteral("['a', 'b']"), ["a", "b"]);
        assert.deepEqual(parseArrayLiteral("['a\\'b', 'c\\\\d']"), ["a'b", "c\\d"]);
        assert.deepEqual(parseArrayLiteral('["\\u00e9", "\\x41"]'), ["é", "A"]);
        assert.deepEqual(parseArrayLiteral("[\n  'a',\n  'b'\n]"), ["a", "b"]);
    });

    test(`${file}: parseArrayLiteral never evaluates and rejects anything else`, () => {
        assert.throws(() => parseArrayLiteral("[process.exit(1)]"), /non-string token/);
        assert.throws(() => parseArrayLiteral('[{"evil":1}]'), /non-string token/);
        assert.throws(() => parseArrayLiteral("['unterminated]"), /unterminated string/);
        assert.throws(() => parseArrayLiteral('{"a":1}'), /non-string token/);
    });

    test(`${file}: probeEData decodes a healthy page and reports every stage`, () => {
        const doc = { b: { spine: [{ path: "a.mp3" }], title: { main: "Dune" } }, objects: { spool: 1 } };
        const probe = probeEData(page(encodedFixture(doc)), BUID);
        assert.equal(probe.ok, true);
        assert.deepEqual(probe.stages.map(s => s.stage), [
            "eData-marker", "eData-literal", "eData-json", "openbook-shape",
        ]);
        assert.ok(probe.stages.every(s => s.ok));
        assert.deepEqual(probe.openbook, doc.b);
        assert.deepEqual(probe.extra, { objects: doc.objects });
    });

    test(`${file}: probeEData handles a single-quoted literal without eval`, () => {
        const doc = { b: { ok: true, chars: 'a"b c/d=e+f' } };
        const probe = probeEData(page(encodedFixture(doc, { singleQuoted: true })), BUID);
        assert.equal(probe.ok, true);
        assert.deepEqual(probe.openbook, doc.b);
    });

    test(`${file}: probeEData names the broken contract on drift`, () => {
        // A drifted shift modulus (94 -> 95) must fail at eData-json, not silently.
        const json = Buffer.from(JSON.stringify({ b: { ok: 1 } })).toString("base64");
        const key = BUID.split("").reverse().join("");
        let drifted = "";
        for (let a = 0; a < json.length; a++) {
            let ch = json.charCodeAt(a);
            const d = parseFloat(key[a % key.length]);
            if (d) { ch += (a + d) % 95; if (ch > 126) ch = (ch % 126) + 32; }
            drifted += String.fromCharCode(ch);
        }
        const probe = probeEData(page(JSON.stringify(drifted.split('"'))), BUID);
        assert.equal(probe.ok, false);
        const failed = probe.stages.find(s => !s.ok);
        assert.equal(failed.stage, "eData-json");
        assert.match(failed.drift, /scramble/);
    });

    test(`${file}: probeEData reports a missing marker and a non-string literal`, () => {
        const missing = probeEData("<html>nothing here</html>", BUID);
        assert.equal(missing.ok, false);
        assert.equal(missing.stages[0].stage, "eData-marker");

        const badLiteral = probeEData(page("[process.exit(1)]"), BUID);
        assert.equal(badLiteral.ok, false);
        assert.equal(badLiteral.stages.find(s => !s.ok).stage, "eData-literal");
    });

    test(`${file}: b64ToUtf8 ignores stray characters and stops at \`=\`, like Buffer`, () => {
        // The cipher itself is positional (the quad swap runs first), so this pins
        // the decoder. Buffer's exact partial-group rules on interior garbage
        // (e.g. 'AB*CDE') are not reproduced; real blobs are valid base64.
        const cases = ["QQ==", "QQ==QQ==", "A", "AAAAA", "A=B", "AB*CD", "QU JD\nRA==", "=", "", "AB\nCDEFGH"];
        for (const s of cases) {
            assert.equal(b64ToUtf8(s), Buffer.from(s, "base64").toString("utf8"), JSON.stringify(s));
        }
    });

    test(`${file}: extractSpine pairs spine paths with their signed cmpt params`, () => {
        const openbook = {
            spine: [
                { path: "a.mp3", "-odread-spine-position": 1, "-odread-file-bytes": 12345, "-odread-original-path": "Part 002.mp3" },
                { path: "b.mp3", "-odread-spine-position": 0 },
            ],
            "-odread-cmpt-params": ["sig=first", "sig=second"],
        };
        const pages = extractSpine(openbook, "https://dewey-x.listen.libbyapp.com/");
        assert.equal(pages[0].url, "https://dewey-x.listen.libbyapp.com/a.mp3?sig=second");
        assert.equal(pages[0].tokenIndex, 1);
        assert.equal(pages[0].bytes, 12345);
        assert.equal(pages[0].path, "Part 002.mp3");
        assert.equal(pages[1].url, "https://dewey-x.listen.libbyapp.com/b.mp3?sig=first");
        assert.equal(pages[1].path, "b.mp3");
    });

    test(`${file}: extractSpine carries fixed-layout fields and tolerates a missing token`, () => {
        const openbook = {
            spine: [{ path: "pages/1.xhtml", "-odread-spine-position": 0, "rendition-layout": "pre-paginated", "rendition-viewport": { width: 1200, height: 1600 } }],
        };
        const pages = extractSpine(openbook, "https://dewey-x.read.libbyapp.com");
        assert.equal(pages[0].url, "https://dewey-x.read.libbyapp.com/pages/1.xhtml");
        assert.equal(pages[0].renditionLayout, "pre-paginated");
        assert.deepEqual(pages[0].renditionViewport, { width: 1200, height: 1600 });
        assert.equal(pages[0].token, "");
    });
}

// ------------------------------------------------- read-only: cfc1 + friends

const { cfc1, probeCfc1, namespaceSvg, assetRefs } = apis["libby-read"];

test("cfc1 reverses the swapped-base64 blob", () => {
    const text = "The quick brown fox — ünïcodé & <tags>";
    assert.equal(cfc1(encodeCfc1(text)), text);
});

test("cfc1 handles 4n and 4n+k lengths like the regex", () => {
    const blob = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    for (const len of [0, 4, 8, 16, 1, 2, 3, 5, 6, 7, 9, 13, 31]) {
        const s = blob.slice(0, len);
        assert.equal(cfc1(s), refCfc1(s), `length ${len}`);
    }
});

test("cfc1 skips groups containing line terminators, resuming after them", () => {
    const cases = [
        "ab\ncdefgh", "a\nbcdefg", "\n\n\n\nABCDEFGH", "ABCDEFGH\n\n\n\n",
        "AB\rC\u2028DE\u2029FGH", "\u2028abc", "abc\u2029", "QQ==", "QQ==QQ==",
        "A", "AAAAA", "A=B", "Q===", "=", "QUJDRA==", "QUJDRA",
        "ab\x00cd\x7fef", "\u2028abc\r\nQUJD",
    ];
    for (const s of cases) assert.equal(cfc1(s), refCfc1(s), JSON.stringify(s));
});

test("cfc1 matches the regex on a deterministic sweep of hostile inputs", () => {
    let seed = 0x9e3779b9;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
    const alphabet = ["A", "B", "C", "D", "=", "\n", "\r", "\u2028", "\u2029"];
    for (let iter = 0; iter < 600; iter++) {
        const len = Math.floor(next() * 64);
        let s = "";
        for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
        assert.equal(cfc1(s), refCfc1(s), `iter ${iter}: ${JSON.stringify(s)}`);
    }
});

test("probeCfc1 decodes a healthy page and reports every stage", () => {
    const body = '<body><svg xmlns="http://www.w3.org/2000/svg"/></body>';
    const html = `<html><script>parent.__bif_cfc1(self, '${encodeCfc1(body)}');</script></html>`;
    const probe = probeCfc1(html);
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.stages.map(s => s.stage), ["cfc1-marker", "content-shape"]);
    assert.equal(probe.body, body);
});

test("probeCfc1 names the broken contract on drift", () => {
    // A changed permutation (swap 1<->2) must fail at content-shape.
    const drifted = Buffer.from("<svg/>", "utf8").toString("base64").replace(/(.)(.)(.)(.)/g, "$2$1$4$3");
    const probe = probeCfc1(`<html><script>parent.__bif_cfc1(self, '${drifted}');</script></html>`);
    assert.equal(probe.ok, false);
    assert.equal(probe.stages.find(s => !s.ok).stage, "content-shape");

    const missing = probeCfc1("<html>error page</html>");
    assert.equal(missing.ok, false);
    assert.equal(missing.stages[0].stage, "cfc1-marker");
});

test("namespaceSvg adds namespaces only when missing", () => {
    const bare = '<svg viewBox="0 0 2 2">';
    const patched = namespaceSvg(bare);
    assert.match(patched, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink=/);
    assert.match(patched, /viewBox="0 0 2 2">$/);

    const withNs = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    assert.equal(namespaceSvg(withNs), withNs);
});

test("assetRefs collects asset hrefs/srcs normalized to assets/", () => {
    const body = '<svg><image xlink:href="../assets/urlHash-1.jpg"/><use href="assets/x.png"/></svg>';
    assert.deepEqual(assetRefs(body), ["assets/urlHash-1.jpg", "assets/x.png"]);
    assert.deepEqual(assetRefs("<p>no assets here</p>"), []);
});
