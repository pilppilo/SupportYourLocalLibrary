# LibbyRip

Rip a borrowed Libby audiobook to MP3, then turn it into one chaptered `.m4b` — or keep the
tagged MP3 parts. Grab a borrowed ebook as the **real** publisher EPUB, or rebuild a magazine
from the reader page. No in-browser FFmpeg, no 50 MB download, no sign-in.

This is a fork of [PsychedelicPalimpsest/LibbyRip](https://github.com/PsychedelicPalimpsest/LibbyRip)
(MIT, © HeronErin). Everything upstream is still here and untouched — `userscript.js`,
`bakeMetadata.py`, `buildChapters.py`, `convertToM4b.py`, the EPUB downloader. What this fork
adds is `libby-audio.user.js` (grab the audio), `ebook.py` (a real ebook from a `.acsm`),
`libby-read.user.js` (rebuild a magazine) and `audiobook.py` (make the audiobook).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [1. Grabbing the audio](#1-grabbing-the-audio)
- [2. Grabbing an ebook](#2-grabbing-an-ebook)
- [3. Rebuilding a magazine](#3-rebuilding-a-magazine)
- [4. Making an audiobook](#4-making-an-audiobook)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Upstream tools](#upstream-tools)
- [Credits](#credits)
- [Disclaimer](#disclaimer)

## Requirements

- A browser with [Tampermonkey](https://www.tampermonkey.net/) — Chrome, Edge or Firefox.
- **Python 3.8+** for `ebook.py` and the audiobook tools.
- For audiobooks only: **FFmpeg** on your `PATH`
  ([download](https://www.ffmpeg.org/download.html)). The `.m4b` path needs nothing else. The
  tagged-MP3 path also needs `eyeD3`.
- Install the Python dependencies once:

  ```bash
  python -m pip install -r requirements.txt
  ```

  That pulls in `eyeD3` and `PyQt5` for the audiobook tools, and `lxml`, `pycryptodomex` and
  `oscrypto` for `ebook.py`.

## Quick start

1. Install the userscripts in Tampermonkey: open `libby-audio.user.js` (audiobooks) and
   `libby-read.user.js` (magazines) in this repo, or paste them into Tampermonkey's
   *Create a new script*.
2. Open a borrowed audiobook on Libby and click **Grab audio** in the bottom-right corner. You
   get a folder, or a single `.zip`, laid out as `<Author> - <Title>/Part 001.mp3 …` plus
   `metadata/`.
3. Turn it into an audiobook:

   ```bash
   python audiobook.py m4b "Author - Title.zip"   # one .m4b with chapters and cover
   python audiobook.py mp3 "Author - Title.zip"   # tagged Part 001.mp3 …
   ```

4. For an ebook, download its `.acsm` from Libby and run `ebook.py` — you get the real publisher
   EPUB. See [section 2](#2-grabbing-an-ebook).
5. For a magazine, open it in Libby's reader and click **Grab book**. See
   [section 3](#3-rebuilding-a-magazine).

## 1. Grabbing the audio

`libby-audio.user.js` on a player page (`*.listen.libbyapp.com`, `*.listen.overdrive.com`) does
one thing: download the MP3 parts of a borrowed audiobook, plus the `metadata/` folder that
`bakeMetadata.py` and `buildChapters.py` already consume.

1. Open a borrowed audiobook. A small **Grab audio** panel appears in the bottom-right corner.
2. Click it. If the page can open a folder picker, pick a parent folder and files are written
   to `<parent>/<Author> - <Title>/Part 001.mp3 …` plus `metadata/`. Otherwise (see below)
   you get a single `<Author> - <Title>.zip` instead.

Notes:

- Parts are downloaded one at a time, ~1.5 s apart. Parts that are already in the folder are
  skipped, so clicking again resumes instead of starting over.
- A `403`/`429` stops the run with a message in the status line instead of saving an error
  page as an `.mp3`; OverDrive's `{"result":"whoa"}` throttling answer is named as such. Signed
  part URLs expire, so reload the page and click again if a tab has been open for a long time.
- Each part's size is checked against the manifest's `-odread-file-bytes` before it is accepted,
  so a truncated download is retried instead of being saved as a finished part.
- The player runs in a **cross-origin iframe** of the Libby app, and a cross-origin iframe is
  not allowed to open a folder picker at all (`SecurityError: … Cross origin sub frames aren't
  allowed to show a file picker`). On those pages, and in browsers without the File System
  Access API (e.g. Firefox), the script builds one **store-only ZIP** instead — a single
  download named `<Author> - <Title>.zip` that unpacks into exactly the layout the folder path
  writes:

  ```
  <Author> - <Title>/
    Part 001.mp3 …
    metadata/
      metadata.json
      cover.jpg
  ```

  Set Chrome to *Ask where to save each file* (`chrome://settings/downloads`) and that one
  download asks you for a folder. ZIP64 is not implemented, so a book over 4 GiB is
  downloaded as separate files with a message saying why.
- Debugging: open the console and run `__lg.diagnose()`. It reports how many signed part
  tokens were captured, the part count, the first/last part URL, whether the book has a
  chapter table of contents, and which discovery path supplied the parts (`bif` — the decoded
  player object, the proven path — or `edata` — the page's own scrambled manifest, decoded by
  this script as a fallback). Run `__lg.probeEData()` to see the staged eData probe on its own.
- The script logs `[lgrab] userscript running on <url>` as soon as it starts. If you do not
  see that line on a book page, the script never ran at all — check the Tampermonkey icon
  (a `0` there means the URL is not matched) before suspecting the script's code.
- It also reports on its own once the book is loaded, e.g.
  `[lgrab] ready: 15 tokens / 15 components / 15 parts — click Grab audio`. If those three
  numbers differ, the run is refused instead of writing mis-numbered files.
- The panel floats in its own fixed container, so it does not depend on the player's layout.
  In a page with frames the panel is in the frame that holds the book; `__lg` (and the panel)
  are per-frame, so if the console says `__lg is not defined` you are in the wrong frame —
  switch the console's context dropdown from `top` to the player frame.

## 2. Grabbing an ebook

This is the **real** ebook — the publisher's file, with its own CSS, fonts, images and cover. It
comes from the `.acsm` Libby hands you, fulfilled and decrypted by `ebook.py`.

### Get the `.acsm`

In Libby (`libbyapp.com`), open the loan and pick:

> Shelf → Loans → the book → **Manage Loan** → **Read With…** → **Other Options…** → **EPUB**

That downloads a `<title>.acsm`. (Some titles are DRM-free and download as a plain `.epub`
instead; `ebook.py` passes those straight through.)

### Fulfil and decrypt it

```bash
python ebook.py "Author - Title.acsm"      # -> "Author - Title.epub"
python ebook.py ~/Downloads                # every .acsm (and .epub) in a folder
```

- On first use `ebook.py` creates an **anonymous** Adobe activation — no Adobe account, no
  sign-in, no Adobe Digital Editions, no Calibre. It lives in `~/.libbyrip/adept` (change it
  with `--account-dir`) and is only used while converting a `.acsm`; the `.epub` it produces is
  DRM-free and needs no key to read. `--register` creates it up front if you would rather.
- `-o DIR` chooses the output folder (default: the current folder).
- `--keep-encrypted` also keeps the pre-decryption file, for debugging.

The ACSM fulfilment is vendored from
[Leseratte10's ACSM Input plugin](https://github.com/Leseratte10/acsm-calibre-plugin) and the
ADEPT decryption from [noDRM's DeDRM](https://github.com/noDRM/DeDRM_tools). Both are GPLv3;
see `LICENSE-DeACSM.txt` and `LICENSE-DeDRM.txt`.

Notes:

- Magazines are usually **browser-read only** and have no EPUB download — that is what
  [section 3](#3-rebuilding-a-magazine) is for.
- Not every title offers an EPUB download (Kindle-only and browser-only titles do not).
- A given `.acsm` is fulfilled by one Adobe activation, which `ebook.py` creates and manages
  for you.
- If Adobe has changed something, the error names the step that failed rather than leaving you
  with a bad file.

## 3. Rebuilding a magazine

`libby-read.user.js` rebuilds a magazine (or a reflowable ebook) **from the reader page**. It is
a reconstruction, not a download: the reader never sends the original file, only per-page
`<body>` fragments, so the publisher's CSS and fonts are gone and typesetting will not match the
real book. Magazines are image scans, so they reconstruct faithfully — which is why this path
exists.

On a reader page (`*.read.libbyapp.com`, `*.read.overdrive.com`) the script shows **Grab book**.
Click it and you get one `<Author> - <Title>.epub`.

How it works, in one paragraph: Libby's reader page carries the book's manifest as a scrambled
`window.eData` array, and each spine page's `<body>` is a single `parent.__bif_cfc1(self, '…')`
call holding the real XHTML or SVG. The script fetches the page, decodes both transforms
itself, pulls the image assets, and assembles a valid EPUB 3 (nav, NCX, cover, fixed-layout
metadata for magazines) in memory — then hands it to one download. Nothing is uploaded, and
there is no FFmpeg or Python in this path.

Notes:

- Pages and assets are fetched one at a time, 0.4 s apart, with the same stop-on-`403`/`429`
  behaviour. A 300-page magazine is a couple of minutes.
- Re-clicking resumes: pages and assets already decoded are kept, so a run stopped by a `403`
  does not start over. A re-click also re-reads the reader page, which is how it gets freshly
  signed page tokens instead of insisting on a reload.
- Pages are verified in the browser before saving (every page parses as XML, every relative
  reference resolves inside the archive) and the console warns about anything it finds. The
  script's opinion is not the last word — `test/epub-validator.py` is the independent check.
- Delivery is one `<a download>`. Chrome's *Ask where to save each file*
  (`chrome://settings/downloads`) makes it ask you where to put it.
- Debugging: `__lg.diagnose()` fetches the reader page, prints the staged eData probe
  (`eData-marker`, `eData-literal`, `eData-json`, `openbook-shape`) and the spine it decodes.
  If OverDrive changes either transform, that report names the broken stage instead of leaving
  you with a corrupt file.
- Browsers without `CompressionStream('deflate-raw')` (Chrome before 103, Firefox before 113,
  Safari before 16.4) still produce a valid EPUB — the text entries are stored uncompressed
  instead.
- Fixed-layout comics are unverified: magazines and reflowable ebooks are what this path is
  built and tested for.

## 4. Making an audiobook

`audiobook.py` turns the `.zip` (or the folder) the userscript produced into the format you
want.

**Which one?** If you will listen in Apple Books, Audiobookshelf, Prologue or Smart Audiobook
Player, take the `.m4b` — it is the only one of the two those players show a chapter menu for.
If you want the separate files, or your player builds chapters on its own, take `mp3`.

### Start to finish (Windows)

1. Press `Win` + `R`, type `powershell`, press Enter.
2. Go to the folder you cloned this into:

   ```bash
   cd C:\Users\you\LibbyRip
   ```

3. Run it on the zip the userscript downloaded, using the full path to that zip:

   ```bash
   python audiobook.py m4b "C:\Users\you\Downloads\Author - Title.zip"
   ```

4. Wait. It prints the merge as it goes; a 10 hour book takes roughly 13 minutes. Ignore the
   scrolling numbers. It is finished when it prints the file it wrote:

   ```text
   wrote Author - Title.m4b: 9:43:23, 15 chapter(s), 278.5 MB
   ```

   That line is `ffprobe` reading the finished file back, so it only appears if the file is
   actually good. If it does not appear, nothing usable was written.

5. The `.m4b` is written **next to the zip** — in the example above,
   `C:\Users\you\Downloads\Author - Title.m4b`. Double-click it, or copy it to a phone or into
   Apple Books / Audiobookshelf / Smart Audiobook Player. The chapter menu is the book's real
   table of contents.

### The two formats

```bash
python audiobook.py m4b "Author - Title.zip"    # one .m4b, chapters and cover embedded
python audiobook.py mp3 "Author - Title.zip"    # unpacked, tagged Part 001.mp3 ...
```

- **m4b** joins the parts into one file, encodes AAC, and writes the chapter list from
  `metadata/metadata.json` as real chapters, along with the cover, title, author, album and
  narrator. This is the format audiobook players show a chapter menu for (Apple Books,
  Prologue, Audiobookshelf, Smart Audiobook Player). Chapter frames inside separate MP3s are
  read by very few players, which is what the m4b is for.
- Chapter positions are computed from the **measured** duration of each part (`ffprobe`), not
  from the manifest's numbers, and a chapter that runs across several parts is written once
  instead of once per part.
- The result is read back with `ffprobe` before it is reported as done, so a failed merge
  cannot look like a successful one.
- `--out` chooses the destination (`--out "D:\books\Author - Title.m4b"`), and both formats
  accept an already-unzipped folder instead of the zip.
- `--bitrate 96` overrides the encoder's bitrate. By default it follows the source, and a
  Libby book is 64k, so re-encoding does not inflate the file.
- The mp3 mode needs `eyeD3` first: `python -m pip install -r requirements.txt`. Running it
  twice is fine: it reuses the folder it made.

## Troubleshooting

- **No panel appears.** `libby-audio.user.js` runs on the player pages
  (`*.listen.libbyapp.com`, `*.listen.overdrive.com`) and `libby-read.user.js` on the reader
  root (`*.read.libbyapp.com/?…`), not on Libby's search or shelf pages. Open the book and
  start it playing. The Tampermonkey icon should show a `1`, and the console should print
  `[lgrab] v9 audio userscript running on …` (or `… read userscript …`) — if that line is
  missing, the script never ran. (If it printed but nothing happened, the page's
  Content-Security-Policy blocked the injected `<script>`: the console says so, and `window.BIF`
  will be undefined in that frame.)
- **`python: can't open file 'audiobook.py'`** — you are not in the folder the script lives in.
  Either `cd` there first, or give the full path:
  `python "C:\path\to\audiobook.py" m4b "Author - Title.zip"`.
- **`ffmpeg not found`** — install FFmpeg and put it on your `PATH`, then open a new terminal.
- **The mp3 mode says `eyeD3` is missing** — `python -m pip install -r requirements.txt`.
- **I got a `.zip` instead of a folder.** Expected on the Libby player: it runs in a
  cross-origin iframe, which browsers do not allow to open a folder picker. Set Chrome to
  *Ask where to save each file* (`chrome://settings/downloads`) if you want to choose where it
  lands.
- **The grab stopped with a `403` or `429`.** Signed part URLs expire. Reload the page and
  click **Grab audio** again — parts already saved are skipped, so it resumes.
- **The `.m4b` has no chapters.** Some books have no chapter list in Libby's manifest at all.
  Nothing can invent one; the audio still converts.
- **Where does the output go?** Next to the zip (or wherever `--out` says). Nothing is written
  into the repo folder.
- **A book over 4 GiB.** ZIP64 is not implemented, so it is downloaded as separate files with a
  message saying why.
- **`ebook.py` says a module is missing** (`lxml`, `Cryptodome`, `oscrypto`). Run
  `python -m pip install -r requirements.txt`.
- **`ebook.py` fails during fulfilment or decryption.** That is Adobe's end, and it is the one
  part of this repo that a server-side Adobe change can break. The error names the step. If
  fulfilment works but decryption fails, the activation may not match that `.acsm`.
- **A magazine has no EPUB download in Libby.** Expected — most are browser-read only. Use
  `libby-read.user.js` ([section 3](#3-rebuilding-a-magazine)).
- **No panel on a magazine.** `libby-read.user.js` runs only on the reader's root frame, not on
  the spine page iframes it loads. If `[lgrab] v9 read userscript running on …` is missing
  entirely, the Tampermonkey icon should show `0` — the URL is not matched.
- **The rebuilt epub is missing a chapter menu.** A book with no TOC in Libby's manifest gets
  one nav entry per page instead. Nothing can invent a table of contents.
- **The rebuilt epub looks wrong (plain text, no styling).** Expected: the reader does not send
  the original CSS or fonts. For ebooks use `ebook.py` ([section 2](#2-grabbing-an-ebook));
  reconstruction is only a good fit for magazines.
- **A `403 {"result":"whoa"}` on a magazine.** That is OverDrive throttling, not a bug. Wait,
  then click **Grab book** again — decoded pages and fetched assets are kept.
- **Some pages or images are missing from the rebuilt epub.** The console says which: look for
  `verify:` and `asset … -> HTTP …` lines. `python test/epub-validator.py <file.epub>` is the
  independent second opinion.

## Tests

Two node:test files cover the transforms and the packaging; both extract the real code out of
the userscripts, so there is no second copy to drift. `test/ciphers.test.mjs` reads **both**
`libby-audio.user.js` and `libby-read.user.js` (the shared ciphers are tested once per file);
`test/epub.test.mjs` reads `libby-read.user.js`.

```bash
node --test "test/*.test.mjs"                        # ciphers, probes, EPUB assembly
python test/epub-validator.py "Author - Title.epub"  # independent EPUB check
```

`test/ciphers.test.mjs` round-trips `descramble` and `cfc1` against independent oracles (a
brute-force inverse of the scramble, and the original one-line regex cipher), including the
`\n`/`\r` window cases, and pins the probe stages that name a drift. `test/epub.test.mjs`
builds a real `.epub` and runs the Python validator on it — with and without
`CompressionStream('deflate-raw')` — and checks that the validator actually catches a wrong
mimetype order, a missing manifest target, and a relative reference that resolves nowhere.
Fixtures prove the port matches the documented algorithm; only a live loan proves OverDrive
still uses it. `ebook.py` is not covered by fixtures — it talks to Adobe and can only be
checked with a real `.acsm`.

## Upstream tools

This fork tracks [PsychedelicPalimpsest/LibbyRip](https://github.com/PsychedelicPalimpsest/LibbyRip)
(MIT, © HeronErin) and is powered by
[FFmpeg.js](https://github.com/PsychedelicPalimpsest/FFmpeg-js). The sections below are
upstream's own documentation, kept as-is; see their repo for the current version.

![Exporting audiobook](imgs/export.png)
![Showing chapters](imgs/chapters.png)

<sup>Be careful, I have had multiple library cards banned in the past from using this tool (See [#14](https://github.com/PsychedelicPalimpsest/LibbyRip/issues/14), [#12](https://github.com/PsychedelicPalimpsest/LibbyRip/issues/12), and [#8](https://github.com/PsychedelicPalimpsest/LibbyRip/issues/8) for more details) </sup>

### How to use the main userscript

1. Install the [TamperMonkey](https://www.tampermonkey.net/) extension for your browser.
2. Install the userscript from the [GreasyFork page](https://greasyfork.org/en/scripts/498782-libregrab)
3. Find your audiobook on Libby and export.

**NOTE:** If you do not see anything, it _could_ be because TamperMonkey is not set up properly on Chrome (and chromeium based) browsers! See the TamperMonkey [FAQ](https://www.tampermonkey.net/faq.php#Q209) page here for more info.

<a href='https://ko-fi.com/V7V81BFLAH' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

## Using the Python Script (`bakeMetadata.py`)

This repository includes a Python script that allows you to bake metadata into your downloaded audiobook MP3s, either via the command-line or a GUI.

### Script Requirements

Python 3.x is required, along with the dependencies listed in `requirements.txt`. Install them using:

```bash
pip install -r requirements.txt
```

`PyQt5` is only needed for GUI mode (`--gui`). Command-line mode only requires `eyeD3`.

### Running The Script

You can run the script in either **CLI mode** or **GUI mode**, depending on your needs:

#### Command-Line Mode

```bash
python bakeMetadata.py [<audiobook_directory>]
```

- If no directory is passed as an argument, you will be prompted to enter one.
- This mode is ideal for batch automation or terminal workflows.
- Output, progress, and errors will appear in the console.

#### GUI Mode

```bash
python bakeMetadata.py --gui [<audiobook_directory>]
```

- Launches a PyQt5 graphical interface.
- If no directory is passed, you'll be prompted to select one with a file dialog.
- All output and errors (including warnings like `Lame tag CRC check failed`) will be shown in a scrollable status window within the GUI instead of the terminal.
- Useful for users who prefer a more visual interface.

### What The Script Does

This script does the following:
- Loads the metadata exported with your audiobook from Libby (`metadata.json`).
- Embeds chapter information and cover art into each `Part *.mp3` file using the `eyed3` library.
- Sets ID3 tags including title, artist, album, and track number.

### Notes

- The audiobook directory **must** contain a `metadata` subdirectory with `metadata.json` and a cover image.
- The script assumes filenames follow the `Part X.mp3` naming convention.
- The message `Lame tag CRC check failed` is a **harmless warning** and can be safely ignored. It is now shown in the status window when using the GUI.

#### `buildChapters.py`

`buildChapters.py` can be used to help add chapter metadata to a *compiled* m4b file.

When concatenating all of the smaller `Part XXX.mp3` files together, chapter metadata is often lost or becomes less reliable.  This script writes chapter metadata to a file which can then be embeded using other tools.

**Usage**:

```bash
# Produce a chapters.txt file for use with m4b-tool and tone
python buildChapters.py --chapters < /path/to/audiobook/metadata/metadata.json > chapters.txt

# Produce an ffmetadata metadata.txt file for use with ffmpeg
python buildChapters.py --ffmpeg < /path/to/audiobook/metadata/metadata.json > metadata.txt
```

## Note on EPUBs
The EPUB downloader is **unstable**, and **unreliable**. It works with a majority of books, however Libby does some processing to the xhtml before it is sent to the client, so that needs repaired, and this is not perfect, in addition I have no experience with the EPUB format. I am always open to contributions, so if you find an issue and want to fix it, please do.

<sup>That note is upstream's, about `userscript.js`, and is kept as-is. This fork's paths are
separate: the real-ebook route is `ebook.py` ([section 2](#2-grabbing-an-ebook)), and the
reader-page reconstruction is `libby-read.user.js`
([section 3](#3-rebuilding-a-magazine)).</sup>

## Credits

`libby-audio.user.js` and `libby-read.user.js` port the eData descramble, the `__bif_cfc1`
cipher, the staged probes and the EPUB layout from
[JavaGT/libby-archiver](https://github.com/JavaGT/libby-archiver) (MIT, © JavaGT) — that
repository is where these transforms are documented, and its `docs/raw-payloads.md` is the
field-by-field record. The ported code keeps their copyright and permission notice; see
`LICENSE-JavaGT.txt`. The rest of the repository stays under `LICENSE.txt` (upstream, MIT ©
HeronErin).

`ebook.py` vendors the ACSM fulfilment from
[Leseratte10/acsm-calibre-plugin](https://github.com/Leseratte10/acsm-calibre-plugin) (GPLv3,
© Leseratte10) and the ADEPT decryption from
[noDRM/DeDRM_tools](https://github.com/noDRM/DeDRM_tools) (GPLv3, © i♥cabbages, Apprentice
Harper et al.). Those components are GPLv3; see `LICENSE-DeACSM.txt` and `LICENSE-DeDRM.txt`.
The rest of the repository stays MIT.

On pacing: parts are fetched 1.5 s apart and pages/assets 0.4 s apart, one at a time, and a
`403`/`429`/`whoa` stops the run. That is deliberately slower than the reference
implementation, which fetches four at a time — upstream's own warning above (library cards
banned for using this tool) is the reason. Both delays are tunable at runtime in the console:
`__lg.pacing.part = 800; __lg.pacing.page = 250;`.

<hr>

## Disclaimer

This tool is intended for educational and personal research purposes only. The developers do not condone or encourage any illegal activity, including the unauthorized distribution or reproduction of copyrighted content. By using this tool, you accept full responsibility for your actions and agree to comply with all applicable laws. Use at your own risk.
