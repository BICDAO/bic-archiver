#!/usr/bin/env python3
"""
Generates the application icon from the official BIC logo.

A packaged Electron app with no icon ships the default Electron logo, which
looks unfinished and — for something a DAO asks its members to download and
run — quietly undermines trust in the download. The icon is the DAO's own mark
instead: the V2 globe, one of the two official BIC logos. The other, the seal,
is unreadable below about 160px, and most of these pixels are seen at 16-64px
in a dock or a file listing.

The source is scripts/brand/bic-official-globe-v2-1080.png, a byte-identical
copy of the designer's PNG export from the BIC brand kit. Keep the name; if the
mark ever changes, replace the file and run this again. It lives under scripts/
rather than resources/ so it isn't packaged into the app.

The globe is a self-contained round badge: black linework on an opaque white
disc, transparent outside the circle. That gives two icons:

  macOS (.icns)      Apple's 1024 grid: an 824px rounded square with a soft
                     shadow, inset 100px, with the globe on it. macOS expects
                     that shape; recent versions put anything else on a grey
                     tile of their own.
  Windows/Linux      The badge on its own, filling the canvas. The white disc
  (.png)             keeps the black lines visible on a dark taskbar.

    python3 scripts/make-icon.py            # writes resources/icon.png + .icns
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources"
GLOBE = ROOT / "scripts" / "brand" / "bic-official-globe-v2-1080.png"

CANVAS = 1024

# Apple's macOS icon grid, at 1024.
PLATE = 824
PLATE_INSET = (CANVAS - PLATE) // 2
PLATE_RADIUS = 185
PLATE_TOP = (255, 255, 255)
PLATE_BOTTOM = (241, 241, 241)
SHADOW_OFFSET = 12
SHADOW_BLUR = 18
SHADOW_ALPHA = 64

# How much of the plate the globe's circle spans. Large, because at 16-32px the
# linework is all that's left and every pixel of it counts.
GLOBE_ON_PLATE = 0.86


def load_globe() -> tuple[Image.Image, int]:
    """The globe, and the diameter of its visible circle in source pixels."""
    globe = Image.open(GLOBE).convert("RGBA")
    box = globe.getchannel("A").getbbox()
    if box is None:
        raise SystemExit(f"{GLOBE} is fully transparent")
    return globe, box[2] - box[0]


def globe_at(diameter: int) -> Image.Image:
    """The globe resized so its visible circle is `diameter` pixels across."""
    globe, visible = load_globe()
    size = round(globe.width * diameter / visible)
    return globe.resize((size, size), Image.LANCZOS)


def paste_centred(base: Image.Image, layer: Image.Image) -> None:
    """Composite `layer` onto the middle of `base`, cropping any overhang."""
    x = (base.width - layer.width) // 2
    y = (base.height - layer.height) // 2
    if x < 0 or y < 0:
        layer = layer.crop((-x, -y, -x + base.width, -y + base.height))
        x = y = 0
    base.alpha_composite(layer, (x, y))


def plate_mask(scale: int = 4) -> Image.Image:
    """The rounded square, drawn 4x and scaled down for clean edges."""
    big = Image.new("L", (CANVAS * scale, CANVAS * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [
            PLATE_INSET * scale,
            PLATE_INSET * scale,
            (PLATE_INSET + PLATE) * scale - 1,
            (PLATE_INSET + PLATE) * scale - 1,
        ],
        radius=PLATE_RADIUS * scale,
        fill=255,
    )
    return big.resize((CANVAS, CANVAS), Image.LANCZOS)


def vertical_gradient(top: tuple, bottom: tuple) -> Image.Image:
    g = Image.new("RGB", (1, CANVAS))
    px = g.load()
    for y in range(CANVAS):
        t = y / (CANVAS - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return g.resize((CANVAS, CANVAS), Image.BICUBIC)


def build_mac() -> Image.Image:
    mask = plate_mask()

    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_alpha = Image.new("L", (CANVAS, CANVAS), 0)
    shadow_alpha.paste(mask.point(lambda v: v * SHADOW_ALPHA // 255), (0, SHADOW_OFFSET))
    shadow.putalpha(shadow_alpha.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)))

    plate = vertical_gradient(PLATE_TOP, PLATE_BOTTOM).convert("RGBA")
    plate.putalpha(mask)

    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    icon.alpha_composite(shadow)
    icon.alpha_composite(plate)
    paste_centred(icon, globe_at(round(PLATE * GLOBE_ON_PLATE)))
    return icon


def build_badge() -> Image.Image:
    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    paste_centred(icon, globe_at(CANVAS - 2 * 20))
    return icon


def write_icns(icon: Image.Image) -> None:
    iconset = RES / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        icon.resize((size * 2, size * 2), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}@2x.png"
        )

    icns = RES / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    print(f"wrote {icns}")

    for f in iconset.iterdir():
        f.unlink()
    iconset.rmdir()


def main() -> int:
    RES.mkdir(parents=True, exist_ok=True)

    png = RES / "icon.png"
    build_badge().save(png, optimize=True)
    print(f"wrote {png}")

    if sys.platform != "darwin":
        print("not macOS — skipping .icns")
        return 0

    write_icns(build_mac())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
