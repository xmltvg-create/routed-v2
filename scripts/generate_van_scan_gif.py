"""
Generate a promotional GIF for the RouTeD Van Scan feature.

The hero promise: "1 barcode = 1 tap = 1 auto-assigned stop number."

Animation script (60 frames @ 12 fps ≈ 5 seconds, then loops):
  ── Scene 1 (frames 0-9):    Idle viewfinder
  ── Scene 2 (frames 10-19):  Scan #1 → BIG "47" pops in, counter 12→13
  ── Scene 3 (frames 20-29):  Scan #2 → BIG "23" pops in, counter 13→14
  ── Scene 4 (frames 30-39):  Scan #3 → BIG "61 + 62" (sibling parcels), counter 14→16
  ── Scene 5 (frames 40-49):  Bad barcode → red "NOT IN ROUTE" flash
  ── Scene 6 (frames 50-59):  Scan #4 → BIG "08", counter 16→17, settles

Output:
  /app/frontend/assets/playstore/van-scan-promo.gif       (loop, web/social)
  /app/frontend/assets/playstore/van-scan-promo-thumb.png (single hero frame
    for Play Store "promo video" thumbnail if you upload an MP4 to YouTube)
"""
from __future__ import annotations

import math
import os
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = Path("/app/frontend/assets/playstore")
OUT.mkdir(exist_ok=True, parents=True)

W, H = 540, 1080
TOTAL_STOPS = 180

# Brand palette
BG = (8, 12, 22)           # near-black viewfinder background
PANEL = (15, 23, 42)       # #0f172a
ACCENT = (16, 185, 129)    # #10b981 success green
SKY = (14, 165, 233)       # #0ea5e9 brand
AMBER = (245, 158, 11)
RED = (239, 68, 68)
WHITE = (255, 255, 255)
DIM = (148, 163, 184)


def _font(size: int, bold: bool = True):
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


# ── Helpers ─────────────────────────────────────────────────────────────


def _bg_layer():
    """Static dark camera-feed look. Faint diagonal stripes simulate a
    blurred van interior so the viewfinder doesn't read as 'broken'."""
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    random.seed(7)
    # Soft warm light spill from top-right (the open van roller door)
    spill = Image.new("RGB", (W, H), BG)
    sd = ImageDraw.Draw(spill)
    for r in range(900, 0, -30):
        alpha = int(8 * (1 - r / 900))
        c = (BG[0] + alpha, BG[1] + alpha, BG[2] + max(0, alpha - 4))
        sd.ellipse([W - 200 - r, -300 - r, W - 200 + r, -300 + r], fill=c)
    img = Image.blend(img, spill, 0.7)
    draw = ImageDraw.Draw(img)
    # Faint grid lines (van shelving)
    for y in range(0, H, 80):
        draw.line([(0, y), (W, y)], fill=(BG[0] + 6, BG[1] + 6, BG[2] + 6), width=1)
    return img


def _top_bar(progress: int, total: int = TOTAL_STOPS):
    """Translucent black bar with progress + counter, sits at the top."""
    bar = Image.new("RGBA", (W, 140), (0, 0, 0, 180))
    draw = ImageDraw.Draw(bar)
    # Counter (left)
    f_big = _font(46)
    f_small = _font(20, bold=False)
    draw.text((28, 30), f"{progress}", fill=WHITE, font=f_big)
    cw = draw.textlength(f"{progress}", font=f_big)
    draw.text((28 + cw + 8, 50), f"/ {total}", fill=DIM, font=_font(28))
    draw.text((28, 92), "PARCELS LOADED", fill=DIM, font=f_small)
    # Mini progress bar (right side)
    bx, by, bw, bh = 240, 60, 270, 14
    draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=7, fill=(255, 255, 255, 30))
    fill_w = int(bw * (progress / total))
    if fill_w > 0:
        draw.rounded_rectangle(
            [bx, by, bx + fill_w, by + bh],
            radius=7,
            fill=ACCENT + (255,),
        )
    # Percent label
    pct = int(100 * progress / total)
    draw.text((bx + bw - 60, 90), f"{pct}%", fill=ACCENT, font=_font(22))
    return bar


def _reticle(frame_in_loop: int, color=ACCENT):
    """Pulsing scan reticle in the middle of the viewfinder. Square corner
    brackets that breathe between scans."""
    rect = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rect)
    cx, cy = W // 2, int(H * 0.42)
    base = 220
    pulse = int(8 * math.sin(frame_in_loop / 2))
    half = base // 2 + pulse
    L = 50
    th = 6
    pts = [
        ((cx - half, cy - half), (cx - half + L, cy - half), (cx - half, cy - half + L)),  # TL
        ((cx + half, cy - half), (cx + half - L, cy - half), (cx + half, cy - half + L)),  # TR
        ((cx - half, cy + half), (cx - half + L, cy + half), (cx - half, cy + half - L)),  # BL
        ((cx + half, cy + half), (cx + half - L, cy + half), (cx + half, cy + half - L)),  # BR
    ]
    for (corner, h, v) in pts:
        draw.line([corner, h], fill=color + (255,), width=th)
        draw.line([corner, v], fill=color + (255,), width=th)
    return rect


def _barcode(x, y, w, h, seed: int):
    """Draw a fake barcode at (x,y) with bars of pseudo-random width.
    Returns the layer so callers can compose with alpha."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle([x - 12, y - 12, x + w + 12, y + h + 12], radius=8, fill=(245, 245, 245, 240))
    rng = random.Random(seed)
    cx = x
    while cx < x + w:
        bw = rng.choice([3, 3, 5, 7, 4, 6])
        gap = rng.choice([2, 3, 4, 5])
        draw.rectangle([cx, y, cx + bw, y + h], fill=(20, 20, 20, 255))
        cx += bw + gap
    # tracking number underneath
    f = _font(16, bold=False)
    draw.text((x, y + h + 6), f"AU-RUN-{12000 + seed}", fill=(40, 40, 40, 255), font=f)
    return layer


def _scan_beam(x, y, w, h, progress: float):
    """A green horizontal beam sweeping across the barcode."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    if progress <= 0 or progress >= 1:
        return layer
    by = int(y + h * progress)
    # Glow halo
    for thick, alpha in [(28, 30), (16, 70), (8, 140), (3, 240)]:
        draw.line([(x - 18, by), (x + w + 18, by)], fill=ACCENT + (alpha,), width=thick)
    return layer


def _success_overlay(scale: float, number: str, zone: str, siblings=None):
    """Pop-in success card with the auto-assigned STOP NUMBER. Scale grows
    from 0.0 → 1.0 with a slight overshoot."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if scale <= 0:
        return layer
    draw = ImageDraw.Draw(layer)
    # Sharper overshoot easing: 0 -> 1.05 -> 1.0
    s = scale if scale <= 1 else 2 - scale
    box_w = int(440 * s)
    box_h = int(360 * s)
    cx, cy = W // 2, int(H * 0.46)
    x0, y0 = cx - box_w // 2, cy - box_h // 2
    # Card
    draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=24, fill=ACCENT + (255,))
    if s < 0.6:
        return layer
    # Tick icon
    f_tick = _font(int(40 * s))
    draw.text((x0 + 24, y0 + 20), "✓", fill=WHITE, font=f_tick)
    # "STOP" label
    f_label = _font(int(22 * s), bold=False)
    draw.text((x0 + 80, y0 + 36), "STOP", fill=(220, 252, 231, 255), font=f_label)
    # BIG number
    f_big = _font(int(180 * s))
    bbox = draw.textbbox((0, 0), number, font=f_big)
    nw = bbox[2] - bbox[0]
    draw.text((cx - nw // 2, y0 + 80), number, fill=WHITE, font=f_big)
    # Sub-line: zone + siblings
    f_sub = _font(int(20 * s), bold=False)
    sub = f"VAN ZONE {zone}"
    if siblings:
        sub += f"  · also: {' + '.join(siblings)}"
    sw = draw.textlength(sub, font=f_sub)
    draw.text((cx - sw // 2, y0 + box_h - 60), sub, fill=(220, 252, 231, 255), font=f_sub)
    return layer


def _rejection_overlay(intensity: float, code: str):
    """Red 'NOT IN ROUTE' flash across the whole screen."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if intensity <= 0:
        return layer
    # Full-screen red tint (gentle)
    layer.paste(Image.new("RGBA", (W, H), RED + (int(80 * intensity),)), (0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = W // 2, int(H * 0.46)
    box_w, box_h = 460, 220
    x0, y0 = cx - box_w // 2, cy - box_h // 2
    draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=18, fill=RED + (int(255 * intensity),))
    f_x = _font(56)
    draw.text((x0 + 24, y0 + 40), "✕", fill=WHITE, font=f_x)
    f_title = _font(36)
    draw.text((x0 + 80, y0 + 50), "NOT IN ROUTE", fill=WHITE, font=f_title)
    f_sub = _font(20, bold=False)
    draw.text((x0 + 24, y0 + 130), f"{code} not on today's manifest.", fill=(255, 226, 226), font=f_sub)
    draw.text((x0 + 24, y0 + 162), "Put it aside — won't be loaded.", fill=(255, 226, 226), font=f_sub)
    return layer


def _caption(text: str, sub: str = ""):
    """Big white caption at the bottom of the frame — the promo hook."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    # Gradient backdrop
    grad = Image.new("RGBA", (W, 280), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(280):
        a = int(220 * (y / 280))
        gd.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    layer.paste(grad, (0, H - 280), grad)
    f_title = _font(46)
    f_sub = _font(22, bold=False)
    tw = draw.textlength(text, font=f_title)
    draw.text((W // 2 - tw // 2, H - 180), text, fill=WHITE, font=f_title)
    if sub:
        sw = draw.textlength(sub, font=f_sub)
        draw.text((W // 2 - sw // 2, H - 110), sub, fill=DIM, font=f_sub)
    return layer


# ── Scene compositor ────────────────────────────────────────────────────


def compose_frame(frame_idx: int):
    """Build a single frame based on its index in the loop."""
    img = _bg_layer().convert("RGBA")

    # Default state
    progress = 12
    caption_main = "Scan the parcel."
    caption_sub = "RouTeD auto-numbers it for you."

    # Reticle + viewfinder visible by default
    img = Image.alpha_composite(img, _reticle(frame_idx))

    # ── Timeline ────────────────────────────────────────────────────────
    f = frame_idx
    # Scene 1: idle 0-9
    if f < 10:
        pass
    # Scene 2: scan #1 → stop "47", zone B (frames 10-19)
    elif 10 <= f < 20:
        local = f - 10
        bc = _barcode(120, int(H * 0.36), 300, 90, seed=47)
        img = Image.alpha_composite(img, bc)
        beam_progress = (local - 1) / 4 if local >= 1 else 0
        img = Image.alpha_composite(img, _scan_beam(120, int(H * 0.36), 300, 90, max(0, min(1, beam_progress))))
        if local >= 5:
            pop_scale = min(1.1, (local - 4) * 0.4)
            img = Image.alpha_composite(img, _success_overlay(pop_scale, "47", "B"))
            progress = 13
            caption_main = "One barcode."
            caption_sub = "One auto-assigned stop number."
    # Scene 3: scan #2 → "23", zone A (frames 20-29)
    elif 20 <= f < 30:
        local = f - 20
        bc = _barcode(140, int(H * 0.36), 280, 90, seed=23)
        img = Image.alpha_composite(img, bc)
        beam_progress = (local - 1) / 4 if local >= 1 else 0
        img = Image.alpha_composite(img, _scan_beam(140, int(H * 0.36), 280, 90, max(0, min(1, beam_progress))))
        progress = 13
        if local >= 5:
            pop_scale = min(1.1, (local - 4) * 0.4)
            img = Image.alpha_composite(img, _success_overlay(pop_scale, "23", "A"))
            progress = 14
            caption_main = "No clipboards."
            caption_sub = "No spreadsheets. No labels to write."
    # Scene 4: scan #3 → siblings "61 + 62", zone C (frames 30-39)
    elif 30 <= f < 40:
        local = f - 30
        bc = _barcode(110, int(H * 0.36), 320, 90, seed=61)
        img = Image.alpha_composite(img, bc)
        beam_progress = (local - 1) / 4 if local >= 1 else 0
        img = Image.alpha_composite(img, _scan_beam(110, int(H * 0.36), 320, 90, max(0, min(1, beam_progress))))
        progress = 14
        if local >= 5:
            pop_scale = min(1.1, (local - 4) * 0.4)
            img = Image.alpha_composite(img, _success_overlay(pop_scale, "61", "C", siblings=["62"]))
            progress = 16
            caption_main = "Same address?"
            caption_sub = "Sibling parcels paired automatically."
    # Scene 5: rejection (frames 40-49)
    elif 40 <= f < 50:
        local = f - 40
        bc = _barcode(135, int(H * 0.36), 290, 90, seed=999)
        img = Image.alpha_composite(img, bc)
        beam_progress = (local - 1) / 4 if local >= 1 else 0
        img = Image.alpha_composite(img, _scan_beam(135, int(H * 0.36), 290, 90, max(0, min(1, beam_progress))))
        progress = 16
        if local >= 5:
            # Pulse intensity: 0.4 → 1.0 → 0.6
            ramp = (local - 4) / 5
            intensity = 0.5 + 0.5 * math.sin(ramp * math.pi)
            img = Image.alpha_composite(img, _rejection_overlay(intensity, "AU-RUN-12999"))
            caption_main = "Wrong parcel?"
            caption_sub = "Rejected before it touches the van."
    # Scene 6: scan #4 → "08" + settle (frames 50-59)
    elif 50 <= f < 60:
        local = f - 50
        bc = _barcode(140, int(H * 0.36), 280, 90, seed=8)
        img = Image.alpha_composite(img, bc)
        beam_progress = (local - 1) / 4 if local >= 1 else 0
        img = Image.alpha_composite(img, _scan_beam(140, int(H * 0.36), 280, 90, max(0, min(1, beam_progress))))
        progress = 16
        if local >= 5:
            pop_scale = min(1.1, (local - 4) * 0.4)
            img = Image.alpha_composite(img, _success_overlay(pop_scale, "08", "D"))
            progress = 17
            caption_main = "Loading the van,"
            caption_sub = "done by the time the engine's warm."

    # Top bar (always visible)
    img.paste(_top_bar(progress), (0, 0), _top_bar(progress))
    # Caption (always visible)
    img = Image.alpha_composite(img, _caption(caption_main, caption_sub))

    return img.convert("RGB")


# ── Render ──────────────────────────────────────────────────────────────


def main():
    frames = []
    total_frames = 60
    print(f"Rendering {total_frames} frames at {W}×{H}…")
    for i in range(total_frames):
        frames.append(compose_frame(i))
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{total_frames}")

    # Save GIF — 12 fps → 83 ms per frame
    gif_path = OUT / "van-scan-promo.gif"
    # Optimize: reduce palette to 128 colors, dither for smoothness
    frames_pal = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    frames_pal[0].save(
        gif_path,
        save_all=True,
        append_images=frames_pal[1:],
        duration=83,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"✓ GIF saved: {gif_path}  ({gif_path.stat().st_size // 1024} KB)")

    # Hero thumbnail (use the success-pop frame for max contrast)
    thumb_path = OUT / "van-scan-promo-thumb.png"
    frames[14].save(thumb_path, "PNG", optimize=True)
    print(f"✓ Thumbnail saved: {thumb_path}")

    # Also save individual frames for any MP4 conversion later
    frames_dir = OUT / "van-scan-frames"
    frames_dir.mkdir(exist_ok=True)
    for i, fr in enumerate(frames):
        fr.save(frames_dir / f"frame_{i:03d}.png", "PNG", optimize=True)
    print(f"✓ {total_frames} PNG frames saved: {frames_dir}/  (for MP4 conversion)")


if __name__ == "__main__":
    main()
