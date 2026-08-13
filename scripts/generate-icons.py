#!/usr/bin/env python3
"""Regenerate the PWA icon set from assets/icon-master.png.

Run after replacing the master artwork:

    python scripts/generate-icons.py

Requires Pillow (`pip install pillow`). Output is committed to the repo, so
this only needs to run when the artwork changes.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "icon-master.png"
PUBLIC = ROOT / "public"
ICONS = PUBLIC / "icons"

# Android masks adaptive icons down to a circle of 80% diameter, so the artwork
# is inset and the black canvas (the app background) fills the bleed.
MASKABLE_SCALE = 0.78
BACKGROUND = (0, 0, 0)


def resized(source: Image.Image, size: int) -> Image.Image:
    return source.resize((size, size), Image.LANCZOS)


def maskable(source: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), BACKGROUND)
    inner = round(size * MASKABLE_SCALE)
    offset = (size - inner) // 2
    canvas.paste(resized(source, inner), (offset, offset))
    return canvas


def main() -> None:
    source = Image.open(MASTER).convert("RGB")
    ICONS.mkdir(parents=True, exist_ok=True)

    for size in (192, 512):
        resized(source, size).save(ICONS / f"icon-{size}.png", optimize=True)
        maskable(source, size).save(ICONS / f"icon-maskable-{size}.png", optimize=True)

    # iOS applies its own rounded-corner mask and never a circle, so Apple's
    # icon stays full bleed. It must also be opaque — hence RGB throughout.
    resized(source, 180).save(PUBLIC / "apple-touch-icon.png", optimize=True)

    resized(source, 32).save(PUBLIC / "favicon-32.png", optimize=True)
    resized(source, 48).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    print(f"icons written to {PUBLIC}")


if __name__ == "__main__":
    main()
