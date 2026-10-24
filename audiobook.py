#!/usr/bin/env python3
"""Turn a grabbed Libby audiobook into the format you want.

    python audiobook.py m4b "Author - Title.zip"   -> one .m4b with chapters
    python audiobook.py mp3 "Author - Title.zip"   -> tagged .mp3 parts

Both take the .zip the userscript downloads, or an already-unzipped folder.
Nothing is uploaded anywhere; this is ffmpeg on your own machine.

m4b: the parts are concatenated in spine order and encoded to AAC in an MP4
container, carrying the chapter list from metadata/metadata.json, the cover, and
the title/author/narrator tags. This is the format audiobook players understand.

mp3: the parts stay separate and each one is tagged (title, artist, album, track,
cover, chapter frames). That is bakeMetadata.py's job; this just accepts a .zip
for it too.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path


# --------------------------------------------------------------------- helpers

def configure_stdio() -> None:
    "Windows defaults stdio to cp1252, which cannot encode most chapter titles."
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def sanitize(name: str) -> str:
    "The same rules the userscript uses, so names stay consistent."
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or ""))
    clean = clean.rstrip(". ").strip()[:120]
    return clean or "audiobook"


def require_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        try:
            subprocess.run((tool, "-version"), stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            die(f"{tool} not found. Install FFmpeg and put it on PATH: "
                "https://www.ffmpeg.org/download.html")


def find_book_dir_or_none(root: Path) -> Path | None:
    "The directory holding metadata/metadata.json, whether it is root or one level down."
    if not root.is_dir():
        return None
    for candidate in [root, *sorted(d for d in root.iterdir() if d.is_dir())]:
        if (candidate / "metadata" / "metadata.json").is_file():
            return candidate
    return None


def find_book_dir(root: Path) -> Path:
    found = find_book_dir_or_none(root)
    if found is None:
        die(f"no metadata/metadata.json under {root} - is this what the userscript made?")
    return found


@contextmanager
def book_input(path: Path):
    "Yield a directory with the parts and metadata/, extracting a .zip if needed."
    if path.is_dir():
        yield find_book_dir(path)
        return
    if path.suffix.lower() != ".zip":
        die(f"expected a .zip or a folder, got {path.name}")

    # The archive holds one top-level folder (<Author> - <Title>/), but
    # find_book_dir() copes with a flat one too.
    tmp = Path(tempfile.mkdtemp(prefix="audiobook-"))
    try:
        with zipfile.ZipFile(path) as archive:
            archive.extractall(tmp)
        yield find_book_dir(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def load_metadata(book: Path) -> dict:
    path = book / "metadata" / "metadata.json"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        die(f"cannot read {path}: {error}")


def book_title(metadata: dict) -> str:
    title = metadata.get("title")
    if isinstance(title, dict):
        title = title.get("main")
    return str(title or "audiobook")


def creators_with_role(metadata: dict, role: str) -> list[str]:
    return [str(c["name"]) for c in metadata.get("creator") or []
            if str(c.get("role", "")) == role and c.get("name")]


def book_author(metadata: dict) -> str:
    authors = creators_with_role(metadata, "author")
    if not authors:
        authors = creators_with_role(metadata, "author and narrator")
    return ", ".join(authors) or "Unknown"


def book_narrator(metadata: dict) -> str | None:
    for role in ("narrator", "author and narrator"):
        names = creators_with_role(metadata, role)
        if names:
            return ", ".join(names)
    return None


PART_NAME = re.compile(r"^part\s+(\d+)\.mp3$", re.IGNORECASE)


def discover_parts(book: Path) -> list[Path]:
    "Part files by number, for the rare book whose metadata has no spine list."
    numbered = []
    for entry in book.iterdir():
        match = PART_NAME.match(entry.name)
        if entry.is_file() and match:
            numbered.append((int(match.group(1)), entry))
    return [path for _, path in sorted(numbered)]


def part_paths(book: Path, count: int) -> list[Path]:
    "Parts in spine order, named the way the userscript names them."
    if count <= 0:
        found = discover_parts(book)
        if not found:
            die(f"no 'Part NNN.mp3' files in {book}")
        return found

    paths = []
    for index in range(count):
        candidates = [book / f"Part {index + 1:03d}.mp3", book / f"Part {index + 1}.mp3"]
        found = next((p for p in candidates if p.is_file()), None)
        if not found:
            die(f"missing part {index + 1} of {count} in {book}")
        paths.append(found)
    return paths


def probe_duration(path: Path) -> float:
    "Real duration in seconds, or 0.0 if ffprobe cannot say."
    result = subprocess.run(
        ("ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)),
        capture_output=True, text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def probe_bitrate(path: Path) -> int | None:
    "Bits per second of the first audio stream, or None."
    result = subprocess.run(
        ("ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=bit_rate", "-of", "default=noprint_wrappers=1:nokey=1", str(path)),
        capture_output=True, text=True,
    )
    try:
        value = int(result.stdout.strip())
    except ValueError:
        return None
    return value or None


def as_seconds(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


# -------------------------------------------------------------------- chapters

def build_chapters(metadata: dict, durations: list[float]) -> tuple[list[tuple[str, int, int]], float]:
    """(title, start_ms, end_ms) on the real timeline, plus the total duration.

    Spine offsets come from the probed part durations when they are available,
    because measuring the files is more trustworthy than trusting the manifest's
    numbers to the millisecond.
    """
    spine = metadata.get("spine") or []
    starts: list[float] = []
    total = 0.0
    for index, item in enumerate(spine):
        starts.append(total)
        probed = durations[index] if index < len(durations) else 0.0
        total += probed or as_seconds(item.get("duration"))

    entries: list[tuple[str, int]] = []
    skipped = 0
    for chapter in metadata.get("chapters") or []:
        index = chapter.get("spine")
        title = str(chapter.get("title") or "").strip()
        if not isinstance(index, int) or not 0 <= index < len(starts):
            skipped += 1
            continue
        position = int(round((starts[index] + as_seconds(chapter.get("offset"))) * 1000))
        # A chapter that runs over several parts repeats its title once per part;
        # keep the first, or the file ends up with "Ch 4" three times over.
        if entries and entries[-1][0] == title:
            continue
        entries.append((title, position))

    if skipped:
        print(f"warning: skipped {skipped} chapter(s) that point at a part this book does not have")

    cleaned: list[tuple[str, int]] = []
    for title, position in entries:
        position = max(0, position)
        if cleaned and position <= cleaned[-1][1]:
            print(f"warning: dropped chapter {title!r} - it starts before the previous one")
            continue
        cleaned.append((title, position))

    total_ms = int(round(total * 1000))
    chapters = []
    for index, (title, start) in enumerate(cleaned):
        end = cleaned[index + 1][1] if index + 1 < len(cleaned) else total_ms
        chapters.append((title, start, max(end, start + 1000)))
    return chapters, total


FFMETADATA_SPECIALS = re.compile(r"(=|;|#|\\)")


def escape_ffmetadata(text: str) -> str:
    return FFMETADATA_SPECIALS.sub(r"\\\1", text.replace("\n", " ").replace("\r", " "))


def write_ffmetadata(path: Path, chapters: list[tuple[str, int, int]]) -> None:
    lines = [";FFMETADATA1"]
    for title, start, end in chapters:
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start}",
            f"END={end}",
            f"title={escape_ffmetadata(title)}",
        ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------------ m4b

def make_m4b(book: Path, metadata: dict, out: Path, bitrate: int | None = None) -> None:
    parts = part_paths(book, len(metadata.get("spine") or []))
    durations = [probe_duration(part) for part in parts]
    if not any(durations):
        die("ffprobe could not read the duration of any part - are these really mp3 files?")

    # Re-encoding at 128k would double the size of a 64k mono book for no audible
    # gain, so follow the source unless told otherwise.
    source_bitrate = next((rate for rate in (probe_bitrate(part) for part in parts) if rate), None)
    rate = bitrate or min(source_bitrate or 64000, 128000)

    chapters, total = build_chapters(metadata, durations)
    if not chapters:
        print("warning: this book has no chapter list, so the m4b will have no chapters")

    cover = next((entry for entry in sorted((book / "metadata").iterdir())
                  if entry.is_file() and entry.stem.lower().startswith("cover")), None)

    with tempfile.TemporaryDirectory(prefix="audiobook-") as tmp:
        chapter_file = Path(tmp) / "chapters.txt"
        write_ffmetadata(chapter_file, chapters)

        inputs: list[str] = []
        for part in parts:
            inputs += ["-i", str(part)]
        cover_index = None
        if cover:
            cover_index = len(parts)
            inputs += ["-i", str(cover)]
        chapter_index = len(parts) + (1 if cover else 0)
        inputs += ["-f", "ffmetadata", "-i", str(chapter_file)]

        graph = "".join(f"[{index}:a]" for index in range(len(parts)))
        graph += f"concat=n={len(parts)}:v=0:a=1[aout]"

        command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
                   *inputs, "-filter_complex", graph,
                   "-map", "[aout]", "-map_chapters", str(chapter_index),
                   "-c:a", "aac", "-b:a", f"{round(rate / 1000)}k",
                   "-metadata", f"title={book_title(metadata)}",
                   "-metadata", f"artist={book_author(metadata)}",
                   "-metadata", f"album={book_title(metadata)}",
                   "-metadata", f"album_artist={book_author(metadata)}",
                   "-metadata", "genre=Audiobook",
                   "-metadata", "media_type=2"]
        narrator = book_narrator(metadata)
        if narrator:
            # m4b has no narrator field; composer is the convention players read.
            command += ["-metadata", f"composer={narrator}",
                        "-metadata", f"description=Narrated by {narrator}"]
        if cover_index is not None:
            command += ["-map", f"{cover_index}:v", "-c:v", "mjpeg",
                        "-disposition:v", "attached_pic",
                        "-metadata:s:v", "title=Cover", "-metadata:s:v", "comment=Cover (front)"]
        command += ["-movflags", "+faststart", "-f", "ipod", str(out)]

        print(f"merging {len(parts)} part(s) into {len(chapters)} chapter(s), "
              f"{formatted(total)} of audio, {round(rate / 1000)}k AAC ...")
        result = subprocess.run(command)
        if result.returncode != 0:
            die(f"ffmpeg failed with exit code {result.returncode}")

    verify_m4b(out, total, len(chapters))


def formatted(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 3600:d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def verify_m4b(path: Path, expected_seconds: float, expected_chapters: int) -> None:
    "Read the file back, so a silent ffmpeg failure cannot be reported as success."
    result = subprocess.run(
        ("ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_chapters", str(path)),
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        die(f"the m4b cannot be read back: {result.stderr.strip()}")

    info = json.loads(result.stdout or "{}")
    chapters = info.get("chapters") or []
    duration = as_seconds((info.get("format") or {}).get("duration"))
    size = path.stat().st_size / 1048576
    print(f"wrote {path.name}: {formatted(duration)}, {len(chapters)} chapter(s), {size:.1f} MB")

    if expected_chapters and len(chapters) != expected_chapters:
        die(f"expected {expected_chapters} chapter(s) in the output, found {len(chapters)}")
    drift = abs(duration - expected_seconds)
    if expected_seconds and drift > max(2.0, expected_seconds * 0.02):
        print(f"warning: the m4b is {drift:.1f}s away from the {formatted(expected_seconds)} "
              "the parts add up to")


# ------------------------------------------------------------------------ mp3

def make_mp3(source: Path, out: Path | None) -> None:
    try:
        from bakeMetadata import bake_metadata
    except ImportError as error:
        if "eyed3" in str(error):
            die("the mp3 option needs eyed3: python -m pip install -r requirements.txt")
        raise

    if source.is_dir():
        target = find_book_dir(source)
    else:
        target = out or source.with_suffix("")
        already = find_book_dir_or_none(target)
        if already is not None:
            # Running it twice, or after unzipping by hand, must not be an error.
            print(f"using the folder that is already there: {already}")
            target = already
        elif target.exists():
            die(f"{target} already exists and is not an audiobook folder - remove it, or pass --out")
        else:
            # Unpack into a staging directory first: the archive already has a
            # top-level folder, and extracting straight into the target would
            # give downloads/<Book>/<Book>/Part 001.mp3.
            staging = Path(tempfile.mkdtemp(prefix="audiobook-extract-", dir=target.parent))
            try:
                with zipfile.ZipFile(source) as archive:
                    archive.extractall(staging)
                shutil.move(str(find_book_dir(staging)), str(target))
            finally:
                shutil.rmtree(staging, ignore_errors=True)

    print(f"tagging the parts in {target} ...")
    bake_metadata(str(target), progress_callback=lambda message, progress: print(f"{message} ({progress}%)"))
    print(f"done: {target}")


# ----------------------------------------------------------------------- main

def main() -> None:
    configure_stdio()

    parser = argparse.ArgumentParser(
        description="Convert a grabbed Libby audiobook to m4b or tagged mp3.")
    parser.add_argument("format", choices=("m4b", "mp3"), help="output format")
    parser.add_argument("input", help="the .zip the userscript downloaded, or a folder")
    parser.add_argument("--out", help="output file (m4b) or folder (mp3)")
    parser.add_argument("--bitrate", type=int, help="m4b audio bitrate in kbps (default: follow the source)")
    args = parser.parse_args()

    source = Path(args.input).expanduser()
    if not source.exists():
        die(f"{source} does not exist")

    if args.format == "mp3":
        make_mp3(source, Path(args.out) if args.out else None)
        return

    require_ffmpeg()
    with book_input(source) as book:
        metadata = load_metadata(book)
        default = f"{sanitize(book_author(metadata) + ' - ' + book_title(metadata))}.m4b"
        out = Path(args.out) if args.out else source.parent / default
        make_m4b(book, metadata, out, args.bitrate * 1000 if args.bitrate else None)


if __name__ == "__main__":
    main()
