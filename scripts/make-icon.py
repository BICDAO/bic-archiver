#!/usr/bin/env python3
"""
Generates the application icon.

A packaged Electron app with no icon ships the default Electron logo, which
looks unfinished and — for something a DAO asks its members to download and
run — quietly undermines trust in the download. This draws a simple mark
instead: an isometric block, echoing both a sealed archive box and the
content-addressed blocks the app actually stores.

Deliberately geometric and high-contrast so it stays legible at 16px in a dock
or a file listing, where most of these pixels will actually be seen.

    python3 scripts/make-icon.py            # writes resources/icon.png + .icns
"""
from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources"

# Rendered large, then downsampled — cheap supersampling, much cleaner edges
# than drawing at final size.
S = 2048
SCALE = S / 1024

INDIGO_TOP = (99, 102, 241)
INDIGO_BOTTOM = (67, 56, 202)
FACE_LIGHT = (255, 255, 255)
FACE_MID = (214, 218, 255)
FACE_DARK = (167, 174, 245)


def squircle_mask(size: int, radius_ratio: float = 0.2237) -> Image.Image:
    """macOS app icons sit on a rounded square with ~22.37% corner radius."""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    g = Image.new("RGB", (1, size))
    px = g.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return g.resize((size, size), Image.BICUBIC)


def iso_block(d: ImageDraw.ImageDraw, cx: float, cy: float, w: float, h: float) -> None:
    """
    An isometric cube: top rhombus, then left and right faces in three tones so
    the form reads without any outline.
    """
    hw = w / 2
    top = (cx, cy - h / 2)
    right = (cx + hw, cy - h / 2 + hw * 0.5)
    bottom_r = (cx + hw, cy + h / 2 - hw * 0.5)
    bottom = (cx, cy + h / 2)
    bottom_l = (cx - hw, cy + h / 2 - hw * 0.5)
    left = (cx - hw, cy - h / 2 + hw * 0.5)
    mid = (cx, cy - h / 2 + hw)

    d.polygon([top, right, mid, left], fill=FACE_LIGHT)          # top
    d.polygon([left, mid, bottom, bottom_l], fill=FACE_DARK)     # left
    d.polygon([mid, right, bottom_r, bottom], fill=FACE_MID)     # right


def build() -> Image.Image:
    base = vertical_gradient(S, INDIGO_TOP, INDIGO_BOTTOM).convert("RGBA")
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx = S / 2
    cy = S / 2 + 30 * SCALE
    w = 520 * SCALE
    h = 600 * SCALE

    iso_block(d, cx, cy, w, h)

    # Three dots above the block: the copies that keep content alive. One
    # brighter than the others, because in practice only one usually is.
    r = 26 * SCALE
    gap = 130 * SCALE
    y = cy - h / 2 - 150 * SCALE
    for i, alpha in enumerate((150, 255, 150)):
        x = cx + (i - 1) * gap
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, alpha))

    base.alpha_composite(layer)
    base.putalpha(squircle_mask(S))
    return base


def main() -> int:
    RES.mkdir(parents=True, exist_ok=True)
    icon = build()

    png = RES / "icon.png"
    icon.resize((1024, 1024), Image.LANCZOS).save(png)
    print(f"wrote {png}")

    if sys.platform != "darwin":
        print("not macOS — skipping .icns")
        return 0

    iconset = RES / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 64, 128, 256, 512, 1024):
        icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        if size <= 512:
            icon.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png"
            )

    icns = RES / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    print(f"wrote {icns}")

    for f in iconset.iterdir():
        f.unlink()
    iconset.rmdir()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
