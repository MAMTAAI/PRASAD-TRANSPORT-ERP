#!/usr/bin/env python
"""Turn a scanned pump bill into images a reader can actually read.

WHY THIS EXISTS. Five pumps — Hey krishna, Jon N Well, Pawan, Shivam,
Hatsingimari — hand us 30 PDFs that are a photograph of a piece of paper. Text
extraction returns either nothing or mojibake ("CEN'rRE", "3 0 7 4 0 . . O 4("),
so the coordinate parser in pump_bill_parser.py cannot see them at all. They
have to be read as pictures.

WHY IT DOES NOT RE-RENDER THE PAGE. The obvious way to get a picture of a PDF
page is page.get_pixmap(dpi=600). On A4 that is 4960x7016 pixels, ~139 MB
uncompressed, and rendering thirty of them without letting go of the previous
one is what exhausted memory and took the machine down. Every one of these
files is a single embedded image already: the scan itself. Pulling that image
out is a decompress of what is on disk, at its own native resolution — no
upsampling, no invented pixels, and one page held at a time.

WHY IT SLICES. A fuel bill is a dense table of four-digit figures. Readers
downsample a large image to roughly 1500px on the long edge before looking at
it, and an A4 sheet reduced to 1500px turns "3,074.04" into a grey smudge —
which is exactly the kind of error that puts a wrong rupee on a real truck's
khata. So a tall page is cut into horizontal bands sized to survive that
downsample intact, with an overlap so no row is orphaned on a cut line.

Bands are written one at a time and the source image is dropped before the next
file opens. Peak memory is one scan, not thirty.
"""
from __future__ import annotations

import argparse
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import pymupdf
from PIL import Image

DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
GROUPS = {
    "Prasad Pump": "PRASAD TRANSPORT",
    "Jaiswal pump": "JAISWAL ENTERPRISE",
}
# The pumps pump_bill_parser.py marks UNREADABLE. Kept in sync by hand rather
# than imported, so this tool still runs if the parser is mid-edit.
NEEDS_OCR = ["Hey krishna", "Jon N Well", "Pawan", "Shivam", "Hatsingimari"]

# A band this tall, once downsampled to BAND_WIDTH, keeps four-digit figures
# separable. Overlap so a row cut in half by a band edge appears whole in the
# next one.
BAND_MAX_H = 1150
BAND_OVERLAP = 130
BAND_WIDTH = 1450
JPEG_Q = 82
MIN_SCAN_PX = 1000   # below this, a page's lone image is a logo, not the bill


def pdfs_in(folder: str) -> list[str]:
    """Every PDF in a folder, exactly once (Windows is case-insensitive)."""
    seen: dict[str, str] = {}
    for fn in sorted(os.listdir(folder)):
        if fn.lower().endswith(".pdf"):
            seen.setdefault(fn.lower(), os.path.join(folder, fn))
    return list(seen.values())


def page_image(page) -> Image.Image | None:
    """The scan embedded in this page, at its own resolution.

    Falls back to a 200-DPI render only when a page carries no single dominant
    image — a real case in this set (one Pawan file is two pages) and cheap at
    that DPI. Never renders above 200: past that we are inventing pixels the
    scanner never captured.
    """
    imgs = page.get_images(full=True)
    # Only if that image is plausibly the SCAN. Two of Shivam's bills embed a
    # 318px graphic on an A4 page and carry the content as text; taking the lone
    # image there hands back a logo and silently loses the whole bill. A real
    # scan of a page is thousands of pixels across, so anything under this is
    # something else and the page gets rendered instead.
    if len(imgs) == 1 and max(imgs[0][2], imgs[0][3]) >= MIN_SCAN_PX:
        xref = imgs[0][0]
        try:
            raw = page.parent.extract_image(xref)
            return Image.open(io.BytesIO(raw["image"]))
        except Exception:
            pass
    pix = page.get_pixmap(dpi=200)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def bands(img: Image.Image) -> list[Image.Image]:
    """Cut a tall scan into overlapping horizontal bands, scaled for reading."""
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    # Scale so the width lands at BAND_WIDTH, then band by height. Doing it in
    # this order means every band comes out at the same, known legibility.
    if img.width != BAND_WIDTH:
        h = round(img.height * BAND_WIDTH / img.width)
        img = img.resize((BAND_WIDTH, h), Image.LANCZOS)

    if img.height <= BAND_MAX_H:
        return [img]

    out, top = [], 0
    while top < img.height:
        bottom = min(top + BAND_MAX_H, img.height)
        out.append(img.crop((0, top, img.width, bottom)))
        if bottom >= img.height:
            break
        top = bottom - BAND_OVERLAP
    return out


def run(outdir: str, only: list[str] | None, limit: int | None) -> None:
    os.makedirs(outdir, exist_ok=True)
    manifest: list[tuple[str, str, str, int]] = []
    done = 0

    for grp in GROUPS:
        base = os.path.join(DESKTOP, grp)
        if not os.path.isdir(base):
            continue
        for pump in sorted(os.listdir(base)):
            d = os.path.join(base, pump)
            if not os.path.isdir(d) or pump not in NEEDS_OCR:
                continue
            if only and pump not in only:
                continue

            for path in pdfs_in(d):
                if limit is not None and done >= limit:
                    print(f"\n  stopped at --limit {limit}")
                    _write_manifest(outdir, manifest)
                    return
                fn = os.path.basename(path)
                stem = f"{pump}__{os.path.splitext(fn)[0]}".replace(" ", "_")
                stem = "".join(c for c in stem if c.isalnum() or c in "._-")

                doc = pymupdf.open(path)
                nb = 0
                for pno, page in enumerate(doc):
                    img = page_image(page)
                    if img is None:
                        continue
                    for i, band in enumerate(bands(img)):
                        name = f"{stem}__p{pno + 1}_b{i + 1}.jpg"
                        band.convert("RGB").save(
                            os.path.join(outdir, name), "JPEG",
                            quality=JPEG_Q, optimize=True)
                        band.close()
                        nb += 1
                    img.close()          # let the scan go before the next file
                doc.close()

                manifest.append((grp, pump, fn, nb))
                done += 1
                print(f"  {pump:14}{fn[:40]:42}{nb:>3} band(s)")

    _write_manifest(outdir, manifest)


def _write_manifest(outdir: str, manifest) -> None:
    total = sum(m[3] for m in manifest)
    with open(os.path.join(outdir, "_manifest.tsv"), "w", encoding="utf-8") as fh:
        fh.write("group\tpump\tsource_file\tbands\n")
        for g, p, f, n in manifest:
            fh.write(f"{g}\t{p}\t{f}\t{n}\n")
    print(f"\n  {len(manifest)} PDFs -> {total} band images in {outdir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="reports/ocr_bands", help="where to write band images")
    ap.add_argument("--pump", action="append", help="only this pump (repeatable)")
    ap.add_argument("--limit", type=int, help="stop after N PDFs (batching)")
    a = ap.parse_args()
    run(a.out, a.pump, a.limit)
