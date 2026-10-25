// The ZIP writer and the EPUB assembly, exercised as real code.
//
// The userscript is one file, so the tests extract the marked blocks and run that
// exact text here. Node's Blob/CompressionStream/Response stand in for the
// browser's, and the finished .epub is handed to the independent Python validator
// (test/epub-validator.py) — the same claim the plan makes, checked end to end.
//
//     node --test "test/*.test.mjs"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../libby-read.user.js", import.meta.url), "utf8");
const validator = new URL("./epub-validator.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function block(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    assert.ok(start !== -1 && end > start, `${startMarker} must be present`);
    return source.slice(start + startMarker.length, end);
}

const zipBlock = block("// ---- pure-zip-block:start ----", "// ---- pure-zip-block:end ----");
const epubBlock = block("// ---- pure-epub-block:start ----", "// ---- pure-epub-block:end ----");

// `CompressionStream` is shadowed by a parameter so a harness can pretend the
// browser has none and exercise the store-only fallback.
function harness({ deflate = true } = {}) {
    const logs = [];
    const factory = new Function("log", "warn", "CompressionStream", `
        ${zipBlock}
        ${epubBlock}
        return { buildZip, buildBookEntries, crc32Of, dosStamp };
    `);
    const api = factory(
        (...a) => logs.push(a.join(" ")),
        (...a) => logs.push(a.join(" ")),
        deflate ? globalThis.CompressionStream : undefined,
    );
    return { ...api, logs };
}

const JPEG = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

function sampleBook({ fixedLayout = false } = {}) {
    return {
        meta: {
            identifier: "libby-test-id",
            title: "Test Book",
            subtitle: "A Subtitle",
            creator: "A. Author",
            publisher: "A Publisher",
            language: "en",
            description: "A description.",
        },
        pages: [
            { path: "pages/1.xhtml", body: '<body><p>one</p><img src="../assets/pic.jpg"/></body>' },
            {
                path: "pages/2.xhtml",
                body: '<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect/></svg>' +
                    '<img src="../assets/pic.jpg"/></body>',
                viewport: { width: 1200, height: 1600 },
            },
        ],
        assets: [{ path: "assets/pic.jpg", blob: JPEG }],
        cover: { path: "cover.jpg", blob: JPEG },
        nav: [{ title: "One", href: "pages/1.xhtml" }, { title: "Two", href: "pages/2.xhtml" }],
        fixedLayout,
    };
}

function writeEpub(api, book) {
    return api.buildZip(api.buildBookEntries(book));
}

async function toFile(blob) {
    const file = path.join(os.tmpdir(), `libby-epub-${process.pid}-${Math.random().toString(36).slice(2)}.epub`);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    return file;
}

function validate(file) {
    const result = spawnSync("python", [validator, file], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function methodsOf(file) {
    const snippet = "import sys,zipfile;print(sorted({i.compress_type for i in zipfile.ZipFile(sys.argv[1]).infolist()}))";
    return execFileSync("python", ["-c", snippet, file], { encoding: "utf8" }).trim();
}

test("buildBookEntries lays out the archive the way EPUB wants", () => {
    const api = harness();
    const entries = api.buildBookEntries(sampleBook());
    const names = entries.map(entry => entry.name);

    assert.equal(names[0], "mimetype", "mimetype must be first");
    assert.equal(entries[0].compress, false, "mimetype must be stored");
    assert.deepEqual(names.slice(1, 3), ["META-INF/container.xml", "OEBPS/pages/1.xhtml"]);
    for (const wanted of ["OEBPS/pages/2.xhtml", "OEBPS/assets/pic.jpg", "OEBPS/cover.jpg",
        "OEBPS/nav.xhtml", "OEBPS/toc.ncx", "OEBPS/content.opf"]) {
        assert.ok(names.includes(wanted), `${wanted} should be in the archive`);
    }

    const opf = entries.find(entry => entry.name === "OEBPS/content.opf").text;
    assert.match(opf, /unique-identifier="pub-id"/);
    assert.match(opf, /properties="nav"/);
    assert.match(opf, /properties="cover-image"/);
    assert.match(opf, /<dc:creator>A. Author<\/dc:creator>/);
    assert.match(opf, /<dc:publisher>A Publisher<\/dc:publisher>/);
    assert.doesNotMatch(opf, /rendition:layout/, "a reflowable book is not pre-paginated");

    const page = entries.find(entry => entry.name === "OEBPS/pages/2.xhtml").text;
    assert.match(page, /<meta name="viewport" content="width=1200, height=1600"\/>/);
});

test("buildBookEntries marks a fixed-layout book pre-paginated", () => {
    const api = harness();
    const entries = api.buildBookEntries(sampleBook({ fixedLayout: true }));
    const opf = entries.find(entry => entry.name === "OEBPS/content.opf").text;
    assert.match(opf, /<meta property="rendition:layout">pre-paginated<\/meta>/);
    assert.match(opf, /rendition:orientation/);
});

test("the assembled EPUB passes the independent validator", async () => {
    const api = harness();
    const file = await toFile(await writeEpub(api, sampleBook()));
    try {
        const result = validate(file);
        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /OK/);
        assert.equal(methodsOf(file), "[0, 8]", "text deflated, images and mimetype stored");
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test("without deflate-raw the EPUB is still valid, just stored", async () => {
    const api = harness({ deflate: false });
    const file = await toFile(await writeEpub(api, sampleBook()));
    try {
        const result = validate(file);
        assert.equal(result.status, 0, result.output);
        assert.equal(methodsOf(file), "[0]", "everything stored when the browser cannot deflate");
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test("a magazine-shaped book (svg pages, no cover) validates too", async () => {
    const api = harness();
    const book = sampleBook({ fixedLayout: true });
    book.cover = null;
    book.pages = [
        { path: "pages/1.xhtml", body: '<body><svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="../assets/scan.jpg"/></svg></body>', viewport: { width: 900, height: 1200 } },
    ];
    book.assets = [{ path: "assets/scan.jpg", blob: JPEG }];
    book.nav = [{ title: "Cover story", href: "pages/1.xhtml" }];
    const file = await toFile(await writeEpub(api, book));
    try {
        const result = validate(file);
        assert.equal(result.status, 0, result.output);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test("the validator catches the failures it claims to catch", async () => {
    const api = harness();
    const entries = api.buildBookEntries(sampleBook());
    // Break three things the plan's verification list names: mimetype order, a
    // manifest target, and a relative reference that resolves nowhere.
    entries.unshift({ name: "extra.txt", blob: new Blob(["x"]), compress: false });
    const opf = entries.find(entry => entry.name === "OEBPS/content.opf");
    opf.text = opf.text.replace(/href="pages\/2\.xhtml"/, 'href="pages/gone.xhtml"');
    opf.blob = new Blob([opf.text], { type: "application/xhtml+xml" });
    const page = entries.find(entry => entry.name === "OEBPS/pages/1.xhtml");
    page.text = page.text.replace("../assets/pic.jpg", "../assets/missing.jpg");
    page.blob = new Blob([page.text], { type: "application/xhtml+xml" });

    const file = await toFile(await api.buildZip(entries));
    try {
        const result = validate(file);
        assert.equal(result.status, 1);
        assert.match(result.output, /mimetype is not the first entry/);
        assert.match(result.output, /pages\/gone\.xhtml is missing/);
        assert.match(result.output, /assets\/missing\.jpg is not in the archive/);
    } finally {
        fs.rmSync(file, { force: true });
    }
});
