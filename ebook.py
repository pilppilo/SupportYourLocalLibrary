#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ebook.py -- turn a Libby/OverDrive .acsm into a real, DRM-free .epub.

No Adobe Digital Editions, no Calibre, no Docker, no Adobe account. The ACSM
fulfilment (Adobe ADEPT) is vendored from Leseratte10's "ACSM Input" plugin
(GPLv3, see vendor/deacsm/LICENSE); the ADEPT decryption is vendored from
noDRM's DeDRM (GPLv3, see LICENSE-DeDRM.txt). This wrapper is the only part
that is LibbyRip's own.

    python ebook.py "Author - Title.acsm"      # -> "Author - Title.epub"
    python ebook.py ~/Downloads                # every .acsm (and .epub) in a folder
    python ebook.py --register                 # (optional) create the activation up front

An anonymous Adobe activation is created automatically on first use, in
~/.libbyrip/adept (see --account-dir). It is only consulted while converting a
.acsm; the .epub it produces is DRM-free and needs no key to read.

Where the .acsm comes from: in Libby, open the loan and pick
    Manage Loan -> Read With... -> Other Options... -> EPUB
That downloads a <title>.acsm. Some titles are DRM-free and download as a
plain .epub instead; those are passed straight through, no engine needed.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The vendored engines import each other as top-level modules, so their folders
# go on sys.path rather than being imported as packages.
for _sub in ("deacsm", "dedrm"):
    _dir = HERE / "vendor" / _sub
    if _dir.is_dir() and str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import libadobe  # noqa: E402  (vendored, path set above)
from libadobe import createDeviceKeyFile, update_account_path, sendHTTPRequest_DL2FILE  # noqa: E402
from libadobeAccount import (  # noqa: E402
    createDeviceFile,
    createUser,
    signIn,
    activateDevice,
    exportAccountEncryptionKeyBytes,
)
from libadobeFulfill import fulfill, buildRights  # noqa: E402
from lxml import etree  # noqa: E402
import ineptepub  # noqa: E402

DEFAULT_ACCOUNT_DIR = Path.home() / ".libbyrip" / "adept"

ADNS = "http://ns.adobe.com/adept"
DCNS = "http://purl.org/dc/elements/1.1/"


def ad(tag: str) -> str:
    return "{%s}%s" % (ADNS, tag)


def dc(tag: str) -> str:
    return "{%s}%s" % (DCNS, tag)


def sanitize(name: str) -> str:
    """The same rules the userscript and audiobook.py use, so names stay consistent."""
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or ""))
    clean = clean.rstrip(". ").strip()[:120]
    return clean or "book"


# --------------------------------------------------------------------- account

def account_is_registered(account_dir: Path) -> bool:
    return (account_dir / "activation.xml").is_file()


def register(account_dir: Path, ade_version: int) -> None:
    """Create an anonymous ADEPT activation. No Adobe account, no sign-in."""
    account_dir.mkdir(parents=True, exist_ok=True)
    update_account_path(str(account_dir))

    print("Creating an anonymous Adobe activation (no account needed)...")
    createDeviceKeyFile()

    if createDeviceFile(True, ade_version) is False:
        raise SystemExit("error: could not create the device file")

    ok, resp = createUser(ade_version, None)
    if not ok:
        raise SystemExit("error: could not create the ADEPT user: %s" % resp)

    ok, resp = signIn("anonymous", "", "")
    if not ok:
        raise SystemExit("error: anonymous sign-in failed: %s" % resp)

    ok, resp = activateDevice(ade_version, None)
    if not ok:
        raise SystemExit("error: device activation failed: %s" % resp)

    print("Activated. Account files are in %s" % account_dir)
    print("Nothing to do with them — they are only used while converting a .acsm.")


# -------------------------------------------------------------------- fulfil

def fulfill_and_download(acsm_path: Path, tmp_dir: Path):
    """Fulfil one .acsm and download the (still encrypted) file.

    Returns (path, kind, title, creator); kind is "epub" or "pdf".
    """
    print("Fulfilling %s ..." % acsm_path.name)
    ok, reply = fulfill(str(acsm_path))
    if ok is False:
        raise RuntimeError("fulfilment failed: %s" % reply)

    root = etree.fromstring(reply)
    info = root.find("./%s/%s" % (ad("fulfillmentResult"), ad("resourceItemInfo")))
    if info is None:
        raise RuntimeError("the fulfilment reply has no resourceItemInfo")

    src = info.find("./%s" % ad("src"))
    token = info.find("./%s" % ad("licenseToken"))
    if src is None or token is None:
        raise RuntimeError("the fulfilment reply is missing src/licenseToken")

    rights_xml = buildRights(token)
    if rights_xml is None:
        raise RuntimeError("could not build rights.xml")

    meta = info.find("./%s" % ad("metadata"))
    title = None
    creator = None
    if meta is not None:
        t = meta.find("./%s" % dc("title"))
        c = meta.find("./%s" % dc("creator"))
        title = t.text if t is not None else None
        creator = c.text if c is not None else None
    title = title or acsm_path.stem

    tmp_file = tmp_dir / "fulfilled.tmp"
    print("Downloading the book ...")
    rc = sendHTTPRequest_DL2FILE(src.text, str(tmp_file))
    if rc != 200:
        raise RuntimeError("download failed with HTTP %s" % rc)

    with open(tmp_file, "rb") as handle:
        head = handle.read(4)

    if head.startswith(b"%PDF"):
        return tmp_file, "pdf", title, creator
    if not head.startswith(b"PK"):
        raise RuntimeError("the fulfilled file is neither EPUB (PK) nor PDF")

    # The EPUB arrives ADEPT-encrypted; rights.xml is what the decrypter reads.
    with zipfile.ZipFile(tmp_file, "a") as archive:
        archive.writestr("META-INF/rights.xml", rights_xml)
    return tmp_file, "epub", title, creator


def decrypt(encrypted_path: Path, out_path: Path) -> None:
    key = exportAccountEncryptionKeyBytes()
    if not key:
        raise RuntimeError("could not read the account encryption key (is the account registered?)")
    rc = ineptepub.decryptBook(key, str(encrypted_path), str(out_path))
    if rc != 0:
        raise RuntimeError("decryption failed (see the messages above)")


# ------------------------------------------------------------------ per input

def output_name(title: str, creator: str | None, fallback: str) -> str:
    stem = sanitize(("%s - %s" % (creator, title)) if creator else title)
    return stem + ".epub"


def process_acsm(acsm_path: Path, out_dir: Path, account_dir: Path, keep_encrypted: bool) -> Path | None:
    update_account_path(str(account_dir))
    with tempfile.TemporaryDirectory(prefix="libbyrip-") as tmp:
        tmp_dir = Path(tmp)
        fulfilled, kind, title, creator = fulfill_and_download(acsm_path, tmp_dir)
        if kind == "pdf":
            print("!  %s fulfilled to a PDF; this tool only produces EPUB." % acsm_path.name)
            if keep_encrypted:
                kept = out_dir / (sanitize(title) + ".pdf")
                shutil.copy2(fulfilled, kept)
                print("   kept the encrypted PDF as %s" % kept.name)
            return None

        out_path = out_dir / output_name(title, creator, acsm_path.stem)
        decrypt(fulfilled, out_path)
        if keep_encrypted:
            shutil.copy2(fulfilled, out_dir / (sanitize(title) + ".encrypted.epub"))
    print("-> %s" % out_path)
    return out_path


def process_epub(epub_path: Path, out_dir: Path) -> Path:
    """A DRM-free title: Libby hands over a plain .epub. Just file it."""
    dest = out_dir / epub_path.name
    if epub_path.resolve() != dest.resolve():
        shutil.copy2(epub_path, dest)
    print("-> %s (already DRM-free)" % dest)
    return dest


def collect_inputs(inputs: list[str]) -> list[Path]:
    found: list[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_dir():
            found.extend(sorted(path.glob("*.acsm")))
            found.extend(sorted(path.glob("*.epub")))
        elif path.is_file():
            found.append(path)
        else:
            print("!  skipping %s (not a file or folder)" % raw)
    return found


# ------------------------------------------------------------------------ main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ebook.py",
        description="Turn a Libby/OverDrive .acsm into a real, DRM-free .epub.",
    )
    parser.add_argument("inputs", nargs="*", help="one or more .acsm files, .epub files, or folders")
    parser.add_argument("--register", action="store_true",
                        help="create an anonymous Adobe activation, then continue")
    parser.add_argument("-o", "--out", default=".", help="output folder (default: current folder)")
    parser.add_argument("--account-dir", default=str(DEFAULT_ACCOUNT_DIR),
                        help="where the Adobe activation lives (default: %(default)s)")
    parser.add_argument("--ade-version", type=int, default=1, choices=(1, 2),
                        help="ADE version to emulate: 1 = 2.0.1, 2 = 3.0.1 (default: 1)")
    parser.add_argument("--keep-encrypted", action="store_true",
                        help="also keep the pre-decryption file, for debugging")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    account_dir = Path(args.account_dir).expanduser()
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    inputs = collect_inputs(args.inputs)

    # The anonymous activation is created on demand, so a new user never has to
    # know it exists.
    if args.register or (inputs and not account_is_registered(account_dir)):
        register(account_dir, args.ade_version)

    if not inputs:
        if args.register:
            return 0
        print("Nothing to do. Pass an .acsm file or a folder (or --register).")
        return 1

    failures = 0
    for path in inputs:
        try:
            if path.suffix.lower() == ".epub":
                process_epub(path, out_dir)
            else:
                process_acsm(path, out_dir, account_dir, args.keep_encrypted)
        except Exception as error:  # noqa: BLE001 - one bad book must not stop the rest
            failures += 1
            print("!  %s failed: %s" % (path.name, error))

    print("Done. %d succeeded, %d failed." % (len(inputs) - failures, failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
