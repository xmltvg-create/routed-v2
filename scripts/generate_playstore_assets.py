"""
Generate Play Store assets from existing RouTeD branding.

Outputs (to /app/frontend/assets/playstore/):
  - icon-playstore-512.png  — 512x512 high-res icon for Play Console
  - feature-graphic-1024x500.png — required hero banner

Design choices:
  - Icon: downscale 1024x1024 with high-quality Lanczos, strip alpha (Play
    Console rejects transparent icons), composite on the brand navy.
  - Feature graphic: deep-navy → sky-blue diagonal gradient, app icon on
    the left, headline "Smart routing. Driver-first." in white Inter Black.
    No screenshots inside (Google strips them on many surfaces).
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path("/app/frontend/assets")
OUT = ROOT / "playstore"
OUT.mkdir(exist_ok=True)

SRC_ICON = ROOT / "images" / "icon.png"

# Brand colors
NAVY = (11, 18, 32)       # #0b1220
SKY = (14, 165, 233)      # #0ea5e9
WHITE = (255, 255, 255)
SOFT_WHITE = (226, 232, 240)  # #e2e8f0

# Fonts — fall back through the usual suspects so this runs on any container.
def _load_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


# ── 1. 512×512 Play Store icon ─────────────────────────────────────────
def build_icon_512() -> Path:
    """Downscale the 1024×1024 source to 512×512 and flatten on navy. Play
    Console requires opaque PNGs with no rounded corners (Google applies
    its own adaptive-icon mask)."""
    src = Image.open(SRC_ICON).convert("RGBA")
    src = src.resize((512, 512), Image.LANCZOS)

    # Flatten transparency onto a navy bg
    bg = Image.new("RGB", (512, 512), NAVY)
    bg.paste(src, (0, 0), src)
    out = OUT / "icon-playstore-512.png"
    bg.save(out, "PNG", optimize=True)
    return out


# ── 2. 1024×500 Feature graphic ────────────────────────────────────────
def _diagonal_gradient(size, c1, c2):
    """Top-left → bottom-right linear gradient."""
    w, h = size
    base = Image.new("RGB", size, c1)
    overlay = Image.new("L", size)
    px = overlay.load()
    for y in range(h):
        for x in range(w):
            # 0 at top-left, 255 at bottom-right
            t = (x / w + y / h) / 2
            px[x, y] = int(255 * t)
    grad = Image.new("RGB", size, c2)
    return Image.composite(grad, base, overlay)


def build_feature_graphic() -> Path:
    """1024×500, no body copy, single hook + brand icon. Left 60% is text,
    right 40% is a faux route polyline rendered into the gradient."""
    W, H = 1024, 500
    canvas = _diagonal_gradient((W, H), NAVY, SKY)
    draw = ImageDraw.Draw(canvas, "RGBA")

    # ── Subtle grain overlay (8% noise) so the gradient doesn't look flat ──
    import random
    grain = Image.new("L", (W // 4, H // 4))
    gp = grain.load()
    random.seed(42)
    for y in range(H // 4):
        for x in range(W // 4):
            gp[x, y] = random.randint(110, 145)
    grain = grain.resize((W, H), Image.BILINEAR).filter(ImageFilter.GaussianBlur(0.6))
    noise_layer = Image.new("RGB", (W, H), (255, 255, 255))
    canvas = Image.composite(noise_layer, canvas, grain.point(lambda v: 18 if v < 128 else 0))
    draw = ImageDraw.Draw(canvas, "RGBA")

    # ── Right-side decorative route polyline (faux GPS trace) ──
    poly_points = [
        (640, 380), (680, 340), (720, 360), (770, 300), (820, 320),
        (860, 260), (910, 280), (950, 220), (980, 240),
    ]
    # Glow halo
    for w_outer in (18, 12, 6):
        draw.line(poly_points, fill=(255, 255, 255, 40), width=w_outer)
    # Solid stroke
    draw.line(poly_points, fill=WHITE, width=4)
    # Pin dots
    for i, (x, y) in enumerate(poly_points):
        r = 8 if i in (0, len(poly_points) - 1) else 5
        color = (14, 165, 233, 255) if i == len(poly_points) - 1 else (255, 255, 255, 230)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color, outline=NAVY, width=2)

    # ── Brand icon (left side) ──
    icon = Image.open(SRC_ICON).convert("RGBA").resize((140, 140), Image.LANCZOS)
    canvas.paste(icon, (60, 60), icon)

    # ── Headline + sub-headline ──
    font_brand = _load_font(46, bold=True)
    font_head = _load_font(64, bold=True)
    font_sub = _load_font(28, bold=False)

    draw.text((220, 80), "RouTeD", fill=WHITE, font=font_brand)
    draw.text((220, 140), "Delivery routing,", fill=WHITE, font=font_head)
    draw.text((220, 220), "driver-first.", fill=(186, 230, 253), font=font_head)
    draw.text(
        (60, 360),
        "VROOM · OR-Tools · LKH-3 · per-driver ML",
        fill=SOFT_WHITE,
        font=font_sub,
    )
    draw.text(
        (60, 408),
        "Optimize 200 stops in seconds",
        fill=SOFT_WHITE,
        font=font_sub,
    )

    out = OUT / "feature-graphic-1024x500.png"
    canvas.save(out, "PNG", optimize=True)
    return out


# ── 3. 1024×500 Promo banner variant (for X / LinkedIn) ────────────────
def build_social_banner() -> Path:
    """Same proportions as feature graphic but with a cleaner social-share
    layout — easier to crop on X (1500×500) and LinkedIn (1200×627)."""
    W, H = 1500, 500
    canvas = _diagonal_gradient((W, H), NAVY, SKY)
    draw = ImageDraw.Draw(canvas, "RGBA")

    icon = Image.open(SRC_ICON).convert("RGBA").resize((180, 180), Image.LANCZOS)
    canvas.paste(icon, (80, 160), icon)

    font_brand = _load_font(58, bold=True)
    font_head = _load_font(80, bold=True)
    font_sub = _load_font(32, bold=False)

    draw.text((300, 130), "RouTeD", fill=WHITE, font=font_brand)
    draw.text((300, 210), "Delivery routing,", fill=WHITE, font=font_head)
    draw.text((300, 310), "driver-first.", fill=(186, 230, 253), font=font_head)
    draw.text(
        (300, 410),
        "Now on Google Play.",
        fill=SOFT_WHITE,
        font=font_sub,
    )

    out = OUT / "social-banner-1500x500.png"
    canvas.save(out, "PNG", optimize=True)
    return out


if __name__ == "__main__":
    paths = [
        build_icon_512(),
        build_feature_graphic(),
        build_social_banner(),
    ]
    print("Generated assets:")
    for p in paths:
        size = p.stat().st_size
        print(f"  {p}  ({size // 1024} KB)")
