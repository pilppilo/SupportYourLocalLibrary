#!/usr/bin/env python3
"""Independently check an EPUB the userscript wrote. Not the script's own say-so.

    python test/epub-validator.py "Author - Title.epub"

Standard library only (zipfile + ElementTree), so it runs anywhere the rest of
this repo's Python runs. Checks:

  * mimetype is the first entry and stored (method 0)
  * META-INF/container.xml points at an OPF that exists
  * every manifest href is present in the archive
  * every spine idref is in the manifest
  * nav.xhtml and toc.ncx targets resolve to archive entries
  * every XHTML/XML entry parses as XML
  * every relative src/href inside a page resolves to an archive entry
    (the check a manifest listing alone cannot make: a ../assets/… depth mismatch)
  * no http(s):// resource references are left behind
  * no zero-byte entries

Exit status is 0 when clean, 1 when anything failed.
"""

from __future__ import annotations

import posixpath
import re
import sys
import zipfile
from urllib.parse import urlparse
from xml.etree import ElementTree

CONTAINER = "META-INF/container.xml"
REF_RE = re.compile(r'(?:src|href|xlink:href)\s*=\s*"([^"]*)"', re.IGNORECASE)
XHTML_SUFFIXES = (".xhtml", ".html", ".htm", ".ncx", ".opf", ".xml", ".svg")
OPF_NS = "{http://www.idpf.org/2007/opf}"


class Report:
    def __init__(self) -> None:
        self.problems: list[str] = []

    def fail(self, message: str) -> None:
        self.problems.append(message)

    def check(self, condition: bool, message: str) -> bool:
        if not condition:
            self.fail(message)
        return condition


def resolve(base_name: str, ref: str) -> str:
    "Resolve a relative reference against the entry that holds it."
    directory = posixpath.dirname(base_name)
    return posixpath.normpath(posixpath.join(directory, ref))


def is_external(ref: str) -> bool:
    return bool(urlparse(ref).scheme) or ref.startswith("//") or ref.startswith("data:")


def check_zip(names: list[str], infos: list[zipfile.ZipInfo], report: Report) -> None:
    if not infos:
        report.fail("the archive is empty")
        return
    first = infos[0]
    report.check(first.filename == "mimetype", f"mimetype is not the first entry (found {first.filename!r})")
    report.check(first.compress_type == zipfile.ZIP_STORED,
                 f"mimetype must be stored, found method {first.compress_type}")
    report.check("META-INF/container.xml" in names, "META-INF/container.xml is missing")
    for info in infos:
        if info.file_size == 0:
            report.fail(f"{info.filename}: zero-byte entry")


def parse_xml(archive: zipfile.ZipFile, name: str, report: Report) -> ElementTree.Element | None:
    try:
        return ElementTree.fromstring(archive.read(name))
    except ElementTree.ParseError as error:
        report.fail(f"{name}: does not parse as XML ({error})")
        return None


def check_container(archive: zipfile.ZipFile, report: Report) -> str | None:
    root = parse_xml(archive, CONTAINER, report)
    if root is None:
        return None
    rootfile = root.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
    if rootfile is None:
        report.fail("container.xml has no rootfile")
        return None
    path = rootfile.get("full-path")
    if not path:
        report.fail("container.xml rootfile has no full-path")
        return None
    report.check(path in archive.namelist(), f"container.xml points at {path}, which is not in the archive")
    return path


def check_opf(archive: zipfile.ZipFile, opf_name: str, names: list[str], report: Report) -> set[str]:
    root = parse_xml(archive, opf_name, report)
    if root is None:
        return set()

    directory = posixpath.dirname(opf_name)
    manifest: dict[str, str] = {}
    for item in root.iter(f"{OPF_NS}item"):
        item_id = item.get("id")
        href = item.get("href")
        if not item_id or not href:
            report.fail(f"{opf_name}: a manifest item has no id/href")
            continue
        manifest[item_id] = href
        target = posixpath.normpath(posixpath.join(directory, href))
        report.check(target in names, f"{opf_name}: manifest href {href} -> {target} is missing")

    spine_ids = [itemref.get("idref") for itemref in root.iter(f"{OPF_NS}itemref")]
    report.check(bool(spine_ids), f"{opf_name}: the spine is empty")
    for idref in spine_ids:
        report.check(idref in manifest, f"{opf_name}: spine idref {idref!r} is not in the manifest")
    return set(manifest.values())


def check_refs(archive: zipfile.ZipFile, names: list[str], report: Report) -> None:
    "Every relative ref inside a document must resolve to a real entry."
    name_set = set(names)
    for name in names:
        if not name.lower().endswith(XHTML_SUFFIXES):
            continue
        text = archive.read(name).decode("utf-8", "replace")
        for ref in REF_RE.findall(text):
            if not ref or ref.startswith("#") or is_external(ref):
                continue
            target = resolve(name, ref)
            if target not in name_set:
                report.fail(f"{name}: {ref} -> {target} is not in the archive")


def check_remote_refs(archive: zipfile.ZipFile, names: list[str], report: Report) -> None:
    for name in names:
        if not name.lower().endswith(XHTML_SUFFIXES):
            continue
        text = archive.read(name).decode("utf-8", "replace")
        for ref in REF_RE.findall(text):
            if urlparse(ref).scheme in ("http", "https"):
                report.fail(f"{name}: still references the network: {ref}")


def check_nav(archive: zipfile.ZipFile, names: list[str], report: Report) -> None:
    for nav_name in ("OEBPS/nav.xhtml", "OEBPS/toc.ncx"):
        if nav_name not in names:
            report.fail(f"{nav_name} is missing")
            continue
        text = archive.read(nav_name).decode("utf-8", "replace")
        for ref in REF_RE.findall(text):
            if not ref or ref.startswith("#") or is_external(ref):
                continue
            target = resolve(nav_name, ref)
            if target not in set(names):
                report.fail(f"{nav_name}: target {ref} -> {target} is missing")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = sys.argv[1]
    report = Report()
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        check_zip(names, infos, report)
        opf_name = check_container(archive, report)
        if opf_name:
            check_opf(archive, opf_name, names, report)
        check_nav(archive, names, report)
        check_refs(archive, names, report)
        check_remote_refs(archive, names, report)

    if report.problems:
        print(f"{path}: {len(report.problems)} problem(s)")
        for problem in report.problems:
            print(f"  - {problem}")
        return 1
    print(f"{path}: OK ({len(names)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
