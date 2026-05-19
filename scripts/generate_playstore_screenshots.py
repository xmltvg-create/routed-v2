"""
Generate all 8 Google Play Store screenshots for RouTeD.

Output: /app/frontend/assets/playstore/screens/screen-N-{name}.png at
1080×2400 (Pixel 7 native portrait). No device frames — Play Console
accepts bare screenshots, and they convert better in store search.

Each frame has the same skeleton:
  ── Top caption ribbon (24% of height) — the conversion driver
  ── App UI mock (76% of height) — the proof

Screens are deliberately stylised (not pixel-perfect re-renders) so
the listing reads as a polished marketing card rather than a screen-grab
"""
from __future__ import annotations

import math
import os
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path("/app/frontend/assets/playstore/screens")
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1080, 2400
CAP_H = int(H * 0.24)
UI_H = H - CAP_H

# Brand palette
NAVY = (11, 18, 32)
INK = (15, 23, 42)
SLATE = (51, 65, 85)
DIM = (148, 163, 184)
WHITE = (255, 255, 255)
SOFT = (226, 232, 240)
ACCENT = (14, 165, 233)
GREEN = (16, 185, 129)
AMBER = (245, 158, 11)
RED = (239, 68, 68)
PURPLE = (168, 85, 247)
MAP_BG = (240, 245, 235)
ROAD = (215, 220, 210)


def _font(size: int, bold: bool = True):
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def _caption_panel(headline: str, sub: str | None = None, bg=NAVY, accent=ACCENT):
    """Top ribbon: dark gradient, headline left-aligned, accent dot."""
    panel = Image.new("RGB", (W, CAP_H), bg)
    draw = ImageDraw.Draw(panel)
    # Subtle radial highlight top-right
    for r in range(800, 0, -40):
        c = (bg[0] + int(8 * (1 - r / 800)), bg[1] + int(10 * (1 - r / 800)), bg[2] + int(14 * (1 - r / 800)))
        draw.ellipse([W - 300 - r, -200 - r, W - 300 + r, -200 + r], fill=c)
    # Accent dot
    draw.ellipse([72, 110, 112, 150], fill=accent)
    # Headline
    f_head = _font(72)
    draw.text((150, 92), headline, fill=WHITE, font=f_head)
    if sub:
        f_sub = _font(34, bold=False)
        draw.text((150, 200), sub, fill=DIM, font=f_sub)
    # Brand chip top-right
    f_brand = _font(28)
    draw.text((W - 220, 92), "RouTeD", fill=accent, font=f_brand)
    f_pro = _font(22, bold=False)
    draw.text((W - 220, 134), "Pro · Play Store", fill=DIM, font=f_pro)
    return panel


def _phone_status_bar(draw, y=0, dark=True):
    """Fake Android status bar."""
    color = WHITE if not dark else (15, 23, 42)
    bg = (15, 23, 42, 255) if dark else (255, 255, 255, 255)
    draw.rectangle([0, y, W, y + 60], fill=bg)
    f = _font(22)
    draw.text((40, y + 18), "9:41", fill=WHITE if dark else (15, 23, 42), font=f)
    # Right side icons (5G · battery)
    draw.text((W - 180, y + 18), "5G  100%", fill=WHITE if dark else (15, 23, 42), font=f)


# ── Map painter (used by 4 screens) ─────────────────────────────────────


def _draw_map_bg(layer: Image.Image, sepia: bool = False):
    """Paint a faux-OSM map: blocks, roads, a couple of green park polygons."""
    draw = ImageDraw.Draw(layer)
    bg = (228, 224, 195) if sepia else MAP_BG
    draw.rectangle([0, 0, W, UI_H], fill=bg)
    # Roads (a grid with one diagonal)
    rng = random.Random(11)
    road_color = (205, 198, 178) if sepia else ROAD
    for x in range(120, W, 220):
        draw.line([(x + rng.randint(-20, 20), 0), (x + rng.randint(-20, 20), UI_H)], fill=road_color, width=18)
    for y in range(180, UI_H, 260):
        draw.line([(0, y), (W, y + rng.randint(-30, 30))], fill=road_color, width=18)
    # Diagonal highway
    draw.line([(0, UI_H - 200), (W, 200)], fill=(180, 175, 155) if sepia else (200, 205, 195), width=32)
    # A park polygon
    park = [(140, 480), (340, 460), (380, 660), (180, 700)]
    draw.polygon(park, fill=(180, 210, 165) if sepia else (200, 230, 190))
    # A second park
    park2 = [(720, 980), (960, 940), (980, 1140), (740, 1180)]
    draw.polygon(park2, fill=(180, 210, 165) if sepia else (200, 230, 190))


def _draw_route_polyline(draw, color=ACCENT, sx=120, sy=300, ex=940, ey=1700, stops=18):
    """A wandering polyline with `stops` numbered pin dots along it."""
    rng = random.Random(7)
    pts = [(sx, sy)]
    cx, cy = sx, sy
    for i in range(stops):
        # Step toward end with some jitter
        dx = (ex - cx) / max(1, stops - i)
        dy = (ey - cy) / max(1, stops - i)
        cx += dx + rng.randint(-40, 40)
        cy += dy + rng.randint(-30, 30)
        pts.append((cx, cy))
    # Glow halo
    for w_outer, alpha in [(28, 60), (18, 110), (10, 200)]:
        for i in range(len(pts) - 1):
            draw.line([pts[i], pts[i + 1]], fill=color + (alpha,) if len(color) == 3 else color, width=w_outer)
    # Solid stroke
    draw.line(pts, fill=color, width=6)
    return pts


def _pin(draw, x, y, n: int | str, color=RED, r=44):
    """Sharpie-style numbered pin."""
    # Drop shadow
    draw.ellipse([x - r - 2, y - r + 4, x + r + 2, y + r + 8], fill=(0, 0, 0, 80) if False else (140, 140, 140))
    # Body
    draw.ellipse([x - r, y - r, x + r, y + r], fill=color, outline=WHITE, width=4)
    # Number
    f = _font(int(r * 0.95))
    s = str(n)
    bbox = draw.textbbox((0, 0), s, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x - tw // 2, y - th // 2 - r * 0.15), s, fill=WHITE, font=f)


def _save(canvas: Image.Image, name: str):
    p = OUT / f"{name}.png"
    canvas.save(p, "PNG", optimize=True)
    kb = p.stat().st_size // 1024
    print(f"  ✓ {p.name}  ({kb} KB)")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 1 — The Hero (map with optimized 200-stop route)
# ═════════════════════════════════════════════════════════════════════════
def screen_1_hero():
    canvas = Image.new("RGB", (W, H), WHITE)
    canvas.paste(_caption_panel("Optimize 200 stops in", "Smarter than the route app your boss handed you."), (0, 0))
    f_two = _font(72)
    ImageDraw.Draw(canvas).text((150, 200 - 100 + 60), "12 seconds.", fill=ACCENT, font=f_two)
    # UI
    ui = Image.new("RGB", (W, UI_H), MAP_BG)
    _draw_map_bg(ui)
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)
    pts = _draw_route_polyline(draw, color=ACCENT, sx=140, sy=200, ex=920, ey=1620, stops=22)
    # Number pins on every 3rd point
    for i, (x, y) in enumerate(pts[::2][:18], start=1):
        _pin(draw, int(x), int(y), i, color=RED if i not in (5, 11) else AMBER, r=38)
    # Bottom summary panel
    panel_y = UI_H - 240
    draw.rounded_rectangle([40, panel_y, W - 40, UI_H - 40], radius=24, fill=WHITE, outline=(220, 220, 220), width=2)
    f_stat = _font(54)
    f_lab = _font(30, bold=False)
    f_check = _font(40)
    draw.text((68, panel_y + 28), "✓", fill=GREEN, font=f_check)
    draw.text((130, panel_y + 30), "Optimized", fill=INK, font=_font(36))
    # 3 stats
    cols = [("STOPS", "200"), ("DRIVE", "7h 12m"), ("DISTANCE", "187 km")]
    cw = (W - 200) // 3
    for i, (lab, val) in enumerate(cols):
        x = 80 + i * cw
        draw.text((x, panel_y + 90), val, fill=INK, font=f_stat)
        draw.text((x, panel_y + 156), lab, fill=DIM, font=f_lab)
    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-1-hero")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 2 — The Learning (Profile cards stack)
# ═════════════════════════════════════════════════════════════════════════
def screen_2_learning():
    canvas = Image.new("RGB", (W, H), (248, 250, 252))
    canvas.paste(_caption_panel("Learns how YOU deliver.", "Smarter every shift. Numbers, not promises."), (0, 0))
    ui = Image.new("RGB", (W, UI_H), (248, 250, 252))
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)
    # Card 1 — TelemetryCard
    def card(y, title, icon_color, rows, accent_label, accent_value):
        draw.rounded_rectangle([40, y, W - 40, y + 380], radius=24, fill=WHITE, outline=(226, 232, 240), width=2)
        # Icon dot
        draw.ellipse([72, y + 32, 132, y + 92], fill=icon_color)
        f_t = _font(36)
        draw.text((160, y + 40), title, fill=INK, font=f_t)
        # 3-column stat row
        gx = 70
        gy = y + 130
        cw = (W - 220) // 3
        f_v = _font(58)
        f_l = _font(20, bold=False)
        for i, (lab, val) in enumerate(rows):
            x = gx + i * cw
            draw.rounded_rectangle([x, gy, x + cw - 20, gy + 130], radius=14, fill=(248, 250, 252))
            bbox = draw.textbbox((0, 0), val, font=f_v)
            vw = bbox[2] - bbox[0]
            draw.text((x + (cw - 20) // 2 - vw // 2, gy + 18), val, fill=INK, font=f_v)
            lw = draw.textlength(lab, font=f_l)
            draw.text((x + (cw - 20) // 2 - lw // 2, gy + 90), lab, fill=DIM, font=f_l)
        # Accent badge
        draw.rounded_rectangle([70, y + 290, W - 70, y + 350], radius=12, fill=(236, 253, 245))
        f_acc = _font(24)
        draw.text((90, y + 305), f"{accent_label}", fill=(6, 95, 70), font=f_acc)
        tw2 = draw.textlength(accent_value, font=f_acc)
        draw.text((W - 90 - tw2, y + 305), accent_value, fill=(6, 95, 70), font=f_acc)

    card(120, "Telemetry · last route",
         GREEN,
         [("178", "stops"), ("82%", "geofence"), ("145", "samples")],
         "ML threshold", "✓ ready")
    card(540, "Service-time learner",
         PURPLE,
         [("12", "suburbs"), ("85s", "median"), ("3h", "since train")],
         "Used in optimize", "✓ live")
    card(960, "Building-side corrector",
         ACCENT,
         [("8", "suburbs"), ("47m", "offset"), ("130m", "largest")],
         "Pins snapped to kerb", "✓ on")

    # Footnote
    draw.text((W // 2 - 280, 1410), "Trained per-driver. Never shared.", fill=DIM, font=_font(28, bold=False))
    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-2-learning")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 3 — The Cockpit (immersive navigation)
# ═════════════════════════════════════════════════════════════════════════
def screen_3_cockpit():
    canvas = Image.new("RGB", (W, H), (15, 23, 42))
    canvas.paste(_caption_panel("Drive heads-up.", "Big buttons. Sunlight-readable. No squinting.",
                                bg=(15, 23, 42), accent=ACCENT), (0, 0))
    ui = Image.new("RGB", (W, UI_H), (60, 80, 96))
    draw = ImageDraw.Draw(ui)
    # 3D-ish road perspective
    # Sky
    for y in range(0, 480):
        t = y / 480
        r = int(40 + 50 * t)
        g = int(60 + 70 * t)
        b = int(96 + 90 * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    # Ground
    for y in range(480, UI_H):
        t = (y - 480) / (UI_H - 480)
        r = int(50 + 80 * t)
        g = int(70 + 60 * t)
        b = int(55 + 40 * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    # Road wedge (perspective)
    draw.polygon([(W // 2 - 30, 480), (W // 2 + 30, 480), (W + 200, UI_H), (-200, UI_H)], fill=(64, 64, 64))
    # Lane lines
    for k in range(0, 12):
        y0 = 480 + k * 130
        y1 = y0 + 60
        t = k / 12
        x0 = W // 2 - 6 - int(t * 60)
        x1 = W // 2 + 6 + int(t * 60)
        draw.polygon([(x0, y0), (x1, y0), (x1 + 12, y1), (x0 - 12, y1)], fill=(245, 245, 200))
    # 3D buildings on the sides
    for x_left, h in [(60, 380), (140, 460), (260, 420)]:
        draw.polygon([(x_left, UI_H - h), (x_left + 100, UI_H - h - 30), (x_left + 100, UI_H), (x_left, UI_H)], fill=(96, 110, 130))
    for x_right, h in [(W - 160, 410), (W - 280, 470), (W - 380, 430)]:
        draw.polygon([(x_right, UI_H - h), (x_right - 100, UI_H - h - 30), (x_right - 100, UI_H), (x_right, UI_H)], fill=(96, 110, 130))

    # Status bar
    _phone_status_bar(draw, dark=True)

    # Turn card top
    draw.rounded_rectangle([40, 80, W - 40, 280], radius=24, fill=(15, 23, 42))
    # Arrow icon
    draw.polygon([(120, 180), (220, 100), (220, 150), (300, 150), (300, 210), (220, 210), (220, 260)], fill=ACCENT)
    f_dist = _font(78)
    f_inst = _font(34, bold=False)
    draw.text((360, 110), "120 m", fill=WHITE, font=f_dist)
    draw.text((360, 200), "Turn right onto Cooke St", fill=SOFT, font=f_inst)

    # Last-Mile Precision chip (mid)
    chip_y = 1380
    draw.rounded_rectangle([90, chip_y, W - 90, chip_y + 130], radius=64, fill=(15, 23, 42), outline=ACCENT, width=4)
    draw.text((140, chip_y + 38), "🎯", fill=ACCENT, font=_font(54))
    draw.text((230, chip_y + 30), "47 m to driveway", fill=WHITE, font=_font(42))
    draw.text((230, chip_y + 80), "STOP 23 · 14 Cooke St", fill=DIM, font=_font(24, bold=False))

    # Speedometer + ETA card bottom
    pan_y = UI_H - 320
    draw.rounded_rectangle([40, pan_y, W - 40, UI_H - 40], radius=24, fill=(15, 23, 42))
    # Speed
    draw.ellipse([70, pan_y + 40, 290, pan_y + 260], fill=(31, 41, 55), outline=GREEN, width=8)
    f_sp = _font(74)
    bbox = draw.textbbox((0, 0), "48", font=f_sp)
    draw.text((180 - (bbox[2] - bbox[0]) // 2, pan_y + 90), "48", fill=WHITE, font=f_sp)
    draw.text((180 - 30, pan_y + 180), "km/h", fill=DIM, font=_font(24, bold=False))
    # ETA
    draw.text((340, pan_y + 60), "Next stop", fill=DIM, font=_font(26, bold=False))
    draw.text((340, pan_y + 100), "STOP 23", fill=WHITE, font=_font(46))
    draw.text((340, pan_y + 170), "ETA 9:47", fill=GREEN, font=_font(36))
    draw.text((340, pan_y + 220), "2 km · 5 min", fill=SOFT, font=_font(28, bold=False))

    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-3-cockpit")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 4 — Pin Painter
# ═════════════════════════════════════════════════════════════════════════
def screen_4_pins():
    canvas = Image.new("RGB", (W, H), WHITE)
    canvas.paste(_caption_panel("Spot late freight instantly.", "Sharpie red. Late-freight amber. Pre-flight blue."), (0, 0))
    ui = Image.new("RGB", (W, UI_H), MAP_BG)
    _draw_map_bg(ui)
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)
    # Cluster pins of various colors
    placements = [
        (250, 320, "1", RED), (380, 280, "2", RED), (520, 360, "3", RED),
        (640, 460, "4", AMBER, True),  # late-freight star
        (740, 380, "5", AMBER, True),
        (320, 540, "6", RED), (490, 600, "7", RED), (650, 700, "8", RED),
        (820, 820, "9", RED), (240, 800, "10", AMBER),
        (430, 920, "11", (96, 165, 250)), (590, 1020, "12", (96, 165, 250)),  # planning blue
        (770, 1080, "13", PURPLE, True),
        (340, 1180, "14", RED), (520, 1260, "15", RED),
        (700, 1340, "16", RED), (440, 1440, "17", AMBER),
        (600, 1540, "18", (96, 165, 250)), (310, 1600, "19", (96, 165, 250)),
    ]
    # Polyline through red+amber stops
    rt = [(x, y) for (x, y, *_) in placements if _[1] in (RED, AMBER)]
    if len(rt) > 1:
        for w_outer, alpha in [(22, 80), (12, 160)]:
            draw.line(rt, fill=ACCENT + (alpha,), width=w_outer)
        draw.line(rt, fill=ACCENT, width=5)
    for p in placements:
        if len(p) == 5:
            x, y, n, col, star = p
        else:
            x, y, n, col = p
            star = False
        _pin(draw, x, y, n, color=col, r=42)
        if star:
            # Star burst (late freight)
            for ang in range(0, 360, 45):
                rad = math.radians(ang)
                x2 = x + 60 * math.cos(rad)
                y2 = y + 60 * math.sin(rad)
                draw.line([(x, y), (x2, y2)], fill=col, width=3)
    # Legend chips
    legend_y = UI_H - 200
    chips = [("Sharpie", RED), ("Late freight", AMBER), ("Pre-flight", (96, 165, 250)), ("Re-scheduled", PURPLE)]
    cx = 60
    for label, col in chips:
        cw = 220
        draw.rounded_rectangle([cx, legend_y, cx + cw, legend_y + 80], radius=40, fill=WHITE, outline=(220, 220, 220), width=2)
        draw.ellipse([cx + 16, legend_y + 22, cx + 56, legend_y + 62], fill=col)
        draw.text((cx + 72, legend_y + 26), label, fill=INK, font=_font(26))
        cx += cw + 20
    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-4-pins")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 5 — Outlier Guardrail
# ═════════════════════════════════════════════════════════════════════════
def screen_5_outlier():
    canvas = Image.new("RGB", (W, H), WHITE)
    canvas.paste(_caption_panel("Catches the bad geocode", "before it costs you the day.",
                                bg=(127, 29, 29), accent=AMBER), (0, 0))
    ui = Image.new("RGB", (W, UI_H), MAP_BG)
    _draw_map_bg(ui)
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)

    # Cluster of good stops
    good = [(180, 400), (260, 460), (340, 520), (240, 580), (340, 620),
            (180, 660), (300, 720), (220, 780), (320, 840)]
    for w_outer, alpha in [(24, 70), (14, 140)]:
        draw.line(good, fill=ACCENT + (alpha,), width=w_outer)
    draw.line(good, fill=ACCENT, width=5)
    for i, (x, y) in enumerate(good, start=1):
        _pin(draw, x, y, i, color=RED, r=38)

    # The rogue outlier (top right corner) with pulse halo
    rx, ry = 940, 240
    for r_halo, alpha in [(180, 30), (130, 60), (90, 110)]:
        draw.ellipse([rx - r_halo, ry - r_halo, rx + r_halo, ry + r_halo], fill=(254, 226, 226))
    _pin(draw, rx, ry, "!", color=RED, r=58)
    # Dashed line from outlier toward map (visual association)
    draw.line([(rx, ry), (340, 540)], fill=RED, width=4)

    # Warning banner
    by = UI_H - 360
    draw.rounded_rectangle([40, by, W - 40, by + 280], radius=24, fill=(254, 242, 242), outline=RED, width=4)
    draw.text((68, by + 32), "⚠", fill=RED, font=_font(64))
    draw.text((160, by + 42), "Outlier detected", fill=(127, 29, 29), font=_font(40))
    draw.text((68, by + 110), "Stop #15 · 5 Heritage Lane, Mount Isa", fill=INK, font=_font(28, bold=False))
    draw.text((68, by + 150), "1,537 km from your route centroid.", fill=SLATE, font=_font(28, bold=False))
    draw.text((68, by + 190), "Probably a bad geocode — confirm before optimising.", fill=SLATE, font=_font(26, bold=False))
    # Action buttons
    bx = 68
    bw = (W - 200) // 2
    draw.rounded_rectangle([bx, by + 230, bx + bw, by + 280], radius=12, fill=RED)
    draw.text((bx + 60, by + 240), "Re-geocode", fill=WHITE, font=_font(26))
    draw.rounded_rectangle([bx + bw + 20, by + 230, bx + bw * 2 + 20, by + 280], radius=12, fill=WHITE, outline=(150, 150, 150), width=2)
    draw.text((bx + bw + 100, by + 240), "Remove stop", fill=INK, font=_font(26))

    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-5-outlier")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 6 — Tighten All (before/after)
# ═════════════════════════════════════════════════════════════════════════
def screen_6_tighten():
    canvas = Image.new("RGB", (W, H), WHITE)
    canvas.paste(_caption_panel("One tap, kilometres saved.", "Cluster-tightener with 2-opt edge swaps."), (0, 0))
    ui = Image.new("RGB", (W, UI_H), MAP_BG)
    draw = ImageDraw.Draw(ui)
    # Split bg: both halves
    half_w = W // 2
    # Left = BEFORE
    draw.rectangle([0, 0, half_w, UI_H - 240], fill=(248, 240, 220))
    # Right = AFTER
    draw.rectangle([half_w, 0, W, UI_H - 240], fill=(220, 245, 230))
    _phone_status_bar(draw, dark=False)
    # Label badges
    draw.rounded_rectangle([30, 80, 240, 140], radius=14, fill=(127, 29, 29))
    draw.text((60, 92), "BEFORE", fill=WHITE, font=_font(28))
    draw.rounded_rectangle([half_w + 30, 80, half_w + 240, 140], radius=14, fill=(6, 95, 70))
    draw.text((half_w + 60, 92), "AFTER", fill=WHITE, font=_font(28))

    # BEFORE polyline — zigzag chaos
    rng = random.Random(33)
    before_pts = []
    cy = 220
    for k in range(20):
        x = 60 + (half_w - 120) * (k / 19) + rng.randint(-60, 60)
        y = cy + rng.randint(-180, 180)
        before_pts.append((x, y))
        cy = max(220, min(UI_H - 380, y + rng.randint(-40, 40)))
    for w_outer, alpha in [(20, 70), (12, 130)]:
        draw.line(before_pts, fill=RED + (alpha,), width=w_outer)
    draw.line(before_pts, fill=RED, width=4)
    for i, (x, y) in enumerate(before_pts[:14], start=1):
        _pin(draw, int(x), int(y), i, color=RED, r=28)

    # AFTER polyline — smooth snake
    after_pts = []
    for k in range(20):
        x = half_w + 60 + (half_w - 120) * (k / 19)
        y = 240 + 1100 * (k / 19) + 40 * math.sin(k * 0.6)
        after_pts.append((x, y))
    for w_outer, alpha in [(20, 70), (12, 130)]:
        draw.line(after_pts, fill=GREEN + (alpha,), width=w_outer)
    draw.line(after_pts, fill=GREEN, width=4)
    for i, (x, y) in enumerate(after_pts[:14], start=1):
        _pin(draw, int(x), int(y), i, color=GREEN, r=28)

    # Stats toast
    ty = UI_H - 200
    draw.rounded_rectangle([60, ty, W - 60, UI_H - 60], radius=24, fill=(15, 23, 42))
    f_lab = _font(24, bold=False)
    f_v = _font(58)
    # 3 cols
    items = [("DISTANCE", "− 2.4 km", GREEN), ("TIME", "− 3 min", GREEN), ("CROSSINGS", "− 7", GREEN)]
    cw = (W - 200) // 3
    for i, (lab, val, col) in enumerate(items):
        x = 90 + i * cw
        draw.text((x, ty + 22), lab, fill=DIM, font=f_lab)
        draw.text((x, ty + 56), val, fill=col, font=f_v)

    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-6-tighten")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 7 — Block the road
# ═════════════════════════════════════════════════════════════════════════
def screen_7_blockroad():
    canvas = Image.new("RGB", (W, H), WHITE)
    canvas.paste(_caption_panel("Tap a closed road.", "Reroute instantly. Even mid-shift.",
                                bg=(120, 53, 15), accent=AMBER), (0, 0))
    ui = Image.new("RGB", (W, UI_H), (228, 224, 195))
    _draw_map_bg(ui, sepia=True)
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)
    # Mode banner
    draw.rectangle([0, 60, W, 160], fill=(120, 53, 15))
    draw.text((60, 88), "✕  BLOCK-ROAD MODE  ·  tap any segment to close", fill=WHITE, font=_font(28))

    # No-go polygon over a road
    no_go = [(440, 540), (740, 480), (820, 760), (560, 820), (380, 760)]
    # Solid red translucent
    overlay = Image.new("RGBA", (W, UI_H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.polygon(no_go, fill=(239, 68, 68, 170), outline=(127, 29, 29, 255))
    # Striped hatch
    for k in range(-1000, 1000, 30):
        od.line([(k, 0), (k + 1500, 1500)], fill=(127, 29, 29, 90), width=4)
    # Mask hatch to polygon shape
    mask = Image.new("L", (W, UI_H), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(no_go, fill=255)
    hatched = Image.new("RGBA", (W, UI_H), (0, 0, 0, 0))
    for k in range(-1000, W + 1000, 26):
        ImageDraw.Draw(hatched).line([(k, 0), (k + 1500, 1500)], fill=(127, 29, 29, 140), width=3)
    overlay.paste(hatched, (0, 0), mask)
    # Outline
    od2 = ImageDraw.Draw(overlay)
    od2.polygon(no_go, outline=(127, 29, 29, 255))
    ui.paste(overlay, (0, 0), overlay)
    draw = ImageDraw.Draw(ui)

    # X icon in middle of polygon
    cx, cy = sum(p[0] for p in no_go) // 5, sum(p[1] for p in no_go) // 5
    draw.text((cx - 30, cy - 50), "✕", fill=(127, 29, 29), font=_font(120))

    # Original route (red dashed thru)
    orig = [(120, 320), (340, 520), (560, 700), (760, 900), (940, 1100)]
    for i in range(len(orig) - 1):
        # Dashed
        for t in range(0, 100, 20):
            x0 = orig[i][0] + (orig[i + 1][0] - orig[i][0]) * t / 100
            y0 = orig[i][1] + (orig[i + 1][1] - orig[i][1]) * t / 100
            x1 = orig[i][0] + (orig[i + 1][0] - orig[i][0]) * (t + 12) / 100
            y1 = orig[i][1] + (orig[i + 1][1] - orig[i][1]) * (t + 12) / 100
            draw.line([(x0, y0), (x1, y1)], fill=(127, 29, 29), width=4)

    # New rerouted polyline (green)
    new_pts = [(120, 320), (240, 420), (220, 620), (180, 820), (320, 980), (560, 1080), (760, 1100), (940, 1140)]
    for w_outer, alpha in [(22, 80), (12, 160)]:
        draw.line(new_pts, fill=GREEN + (alpha,), width=w_outer)
    draw.line(new_pts, fill=GREEN, width=5)
    for i, (x, y) in enumerate(new_pts):
        _pin(draw, x, y, i + 1, color=GREEN, r=30)

    # Bottom toast
    ty = UI_H - 200
    draw.rounded_rectangle([40, ty, W - 40, UI_H - 60], radius=20, fill=WHITE, outline=(150, 150, 150), width=2)
    draw.text((68, ty + 22), "✓ Rerouted around closure", fill=INK, font=_font(36))
    draw.text((68, ty + 80), "+ 1.2 km · + 90 s · 0 stops affected", fill=SLATE, font=_font(26, bold=False))

    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-7-blockroad")


# ═════════════════════════════════════════════════════════════════════════
# SCREEN 8 — Honest Dashboard
# ═════════════════════════════════════════════════════════════════════════
def screen_8_dashboard():
    canvas = Image.new("RGB", (W, H), (248, 250, 252))
    canvas.paste(_caption_panel("The only honest dashboard", "in routing. Real numbers. Zero spin.",
                                bg=(15, 23, 42), accent=GREEN), (0, 0))
    ui = Image.new("RGB", (W, UI_H), (248, 250, 252))
    draw = ImageDraw.Draw(ui)
    _phone_status_bar(draw, dark=False)

    # Big single tile
    tx, ty = 60, 100
    tw, th = W - 120, 1000
    draw.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=28, fill=WHITE, outline=(226, 232, 240), width=2)
    # Header
    draw.text((tx + 36, ty + 32), "Telemetry · last 7 days", fill=INK, font=_font(40))
    draw.ellipse([tx + tw - 100, ty + 36, tx + tw - 50, ty + 86], fill=GREEN)
    draw.text((tx + tw - 90, ty + 52), "ok", fill=WHITE, font=_font(20))

    # Hero metric
    draw.text((tx + 36, ty + 130), "GEOFENCE RATE", fill=DIM, font=_font(22, bold=False))
    draw.text((tx + 36, ty + 168), "82%", fill=GREEN, font=_font(190))
    draw.text((tx + 36, ty + 380), "12,540 m avg distance from centroid at completion", fill=SLATE, font=_font(26, bold=False))

    # Sparkline (7-day rolling)
    spark = [(tx + 36 + k * 130, ty + 540 - random.Random(k).randint(20, 110)) for k in range(7)]
    for w_outer, alpha in [(14, 50), (6, 140)]:
        draw.line(spark, fill=GREEN + (alpha,), width=w_outer)
    draw.line(spark, fill=GREEN, width=4)
    for (x, y) in spark:
        draw.ellipse([x - 8, y - 8, x + 8, y + 8], fill=GREEN, outline=WHITE, width=2)
    draw.text((tx + 36, ty + 580), "Rolling 7-day rate (target ≥ 75%)", fill=DIM, font=_font(22, bold=False))

    # Stats row
    rows = [
        ("178", "stops · last shift", GREEN),
        ("145", "ML training samples", PURPLE),
        ("31s", "median backstop delay", AMBER),
    ]
    rx = tx + 36
    ry = ty + 680
    rw = (tw - 100) // 3
    for i, (val, lab, col) in enumerate(rows):
        x = rx + i * rw
        draw.rounded_rectangle([x, ry, x + rw - 20, ry + 220], radius=18, fill=(248, 250, 252))
        bbox = draw.textbbox((0, 0), val, font=_font(86))
        vw = bbox[2] - bbox[0]
        draw.text((x + (rw - 20) // 2 - vw // 2, ry + 30), val, fill=col, font=_font(86))
        lw = draw.textlength(lab, font=_font(22, bold=False))
        draw.text((x + (rw - 20) // 2 - lw // 2, ry + 140), lab, fill=DIM, font=_font(22, bold=False))

    # Quote
    draw.text((tx + 36, ty + th - 80), '"This is the metric every dispatcher pretended not to track."', fill=SLATE, font=_font(24, bold=False))

    # Bottom hint
    draw.text((W // 2 - 280, ty + th + 80), "Tap to drill into any metric. Export as CSV anytime.", fill=DIM, font=_font(28, bold=False))

    canvas.paste(ui, (0, CAP_H))
    _save(canvas, "screen-8-dashboard")


# ── Runner ──────────────────────────────────────────────────────────────


def main():
    print("Rendering 8 Play Store screenshots at 1080×2400…")
    screen_1_hero()
    screen_2_learning()
    screen_3_cockpit()
    screen_4_pins()
    screen_5_outlier()
    screen_6_tighten()
    screen_7_blockroad()
    screen_8_dashboard()
    print(f"\nAll saved to {OUT}/")


if __name__ == "__main__":
    main()
