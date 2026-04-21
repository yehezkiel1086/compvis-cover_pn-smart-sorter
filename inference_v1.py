"""
========================================================
  PT. Century Batteries Indonesia
  Battery Cover Part Number Detection — Live Inference
  GPU: NVIDIA GeForce GTX 1650 Max-Q (4 GB VRAM)
========================================================
  Controls:
    Q / ESC  → Quit
    S        → Manually save current frame
    +  / =   → Raise confidence threshold (live preview)
    -  / _   → Lower confidence threshold (live preview)
    P        → Pause / resume camera
    SPACE    → Start detection scan (same as clicking button)
========================================================
"""

import cv2
import torch
import time
import os
import math
import numpy as np
from datetime import datetime
from ultralytics import YOLO


# ══════════════════════════════════════════════════════
#  CONFIGURATION  ← edit these values
# ══════════════════════════════════════════════════════
WEIGHTS_PATH = r"C:\Users\KAKA\repos\companies\cbi\yolo-compvis-project\pn_cover_smart_sorter\run1\weights\best.pt"
CAMERA_INDEX      = 0       # 0 = default webcam, 1 = external
CONF_THRESH       = 0.50    # live-preview min confidence (adjustable at runtime)
AUTO_CAPTURE_CONF = 0.85    # scan stops & saves the moment confidence ≥ this
COUNTDOWN_SECS    = 10      # seconds per scan session
SAVE_DIR = r"C:\Users\KAKA\repos\companies\cbi\yolo-compvis-project\inference_saves"

# ── Window / layout ──────────────────────────────────
CAM_W, CAM_H = 960, 540    # camera feed display size (source is scaled to this)
PANEL_W       = 400         # right-hand info panel width
WIN_W         = CAM_W + PANEL_W
WIN_H         = CAM_H
WIN_TITLE     = "CBI — Battery Cover PN Detector"

# ── Color palette (BGR) ──────────────────────────────
_BG        = (22,  24,  30 )   # main background
_PANEL     = (32,  34,  42 )   # side panel
_BORDER    = (55,  58,  72 )   # dividers / box borders
_ACCENT    = (20,  185, 255)   # cyan-blue accent
_GREEN     = (40,  200, 90 )   # success / detected
_AMBER     = (20,  155, 255)   # scanning / in-progress  (warm orange in BGR)
_RED       = (50,  60,  215)   # failed / alert
_WHITE     = (235, 238, 245)   # primary text
_LGRAY     = (155, 158, 170)   # secondary text
_DGRAY     = (70,  73,  88 )   # disabled / muted
_HDRBG     = (16,  17,  22 )   # header strip

BOX_COLOR  = (0,   200, 255)   # detection bounding-box (camera view)
FONT       = cv2.FONT_HERSHEY_SIMPLEX
FONTD      = cv2.FONT_HERSHEY_DUPLEX   # slightly bolder


# ══════════════════════════════════════════════════════
#  STATE MACHINE
# ══════════════════════════════════════════════════════
class S:
    IDLE     = "IDLE"
    COUNTING = "COUNTING"
    SUCCESS  = "SUCCESS"
    FAILED   = "FAILED"

# Shared mutable application state
_app = {
    "state":          S.IDLE,
    "conf_thresh":    CONF_THRESH,
    "paused":         False,
    # countdown
    "cd_start":       None,
    # best detection recorded during scan
    "best_conf":      0.0,
    "best_label":     None,
    "best_frame":     None,   # full raw frame at moment of best detection
    "best_box":       None,   # (x1,y1,x2,y2) in original camera coords
    # runtime helpers
    "fps":            0.0,
    "fc":             0,
    "fps_t":          time.time(),
    "last_frame":     None,
    "mouse":          (0, 0),
}

# ── Button geometry (panel-relative, full-window coords) ──
_BTN_MARGIN  = 18
_BTN_H       = 52
_BTN_Y       = WIN_H - _BTN_H - _BTN_MARGIN
_BTN_X       = CAM_W + _BTN_MARGIN
_BTN_W       = PANEL_W - _BTN_MARGIN * 2
_BTN_RECT    = (_BTN_X, _BTN_Y, _BTN_W, _BTN_H)


def _btn_hit(mx, my):
    x, y, w, h = _BTN_RECT
    return x <= mx <= x + w and y <= my <= y + h


def _start_scan():
    _app["state"]      = S.COUNTING
    _app["cd_start"]   = time.time()
    _app["best_conf"]  = 0.0
    _app["best_label"] = None
    _app["best_frame"] = None
    _app["best_box"]   = None
    print("[SCAN] Countdown started …")


def _reset():
    _app["state"]      = S.IDLE
    _app["cd_start"]   = None
    _app["best_conf"]  = 0.0
    _app["best_label"] = None
    _app["best_frame"] = None
    _app["best_box"]   = None


def _mouse_cb(event, mx, my, flags, _param):
    _app["mouse"] = (mx, my)
    if event == cv2.EVENT_LBUTTONDOWN and _btn_hit(mx, my):
        if _app["state"] in (S.IDLE, S.SUCCESS, S.FAILED):
            _start_scan()
        elif _app["state"] == S.COUNTING:
            _reset()


# ══════════════════════════════════════════════════════
#  DRAWING HELPERS
# ══════════════════════════════════════════════════════

def _rect(canvas, x, y, w, h, color, radius=0, fill=True):
    """Draw a (optionally rounded) rectangle."""
    if radius <= 0 or fill:
        cv2.rectangle(canvas, (x, y), (x + w, y + h), color, -1 if fill else 2)
        return
    # Simple rounded corners via filled rects + circles
    cv2.rectangle(canvas, (x + radius, y), (x + w - radius, y + h), color, -1)
    cv2.rectangle(canvas, (x, y + radius), (x + w, y + h - radius), color, -1)
    for cx, cy in [(x+radius, y+radius), (x+w-radius, y+radius),
                   (x+radius, y+h-radius), (x+w-radius, y+h-radius)]:
        cv2.circle(canvas, (cx, cy), radius, color, -1)


def _text(canvas, txt, x, y, font=FONT, scale=0.55, color=_WHITE, thick=1):
    cv2.putText(canvas, txt, (x, y), font, scale, color, thick, cv2.LINE_AA)


def _text_centered(canvas, txt, cx, y, font=FONT, scale=0.55, color=_WHITE, thick=1):
    (tw, _), _ = cv2.getTextSize(txt, font, scale, thick)
    _text(canvas, txt, cx - tw // 2, y, font, scale, color, thick)


def _hbar(canvas, x, y, total_w, h, fraction, fg_color, bg_color=_DGRAY):
    cv2.rectangle(canvas, (x, y), (x + total_w, y + h), bg_color, -1)
    filled = max(0, int(total_w * min(fraction, 1.0)))
    if filled:
        cv2.rectangle(canvas, (x, y), (x + filled, y + h), fg_color, -1)


# ══════════════════════════════════════════════════════
#  PANEL SECTIONS
# ══════════════════════════════════════════════════════

def _draw_header(canvas, px):
    """Company header strip."""
    _rect(canvas, px, 0, PANEL_W, 60, _HDRBG)
    cv2.line(canvas, (px, 60), (WIN_W, 60), _BORDER, 1)
    _text(canvas, "PT. CENTURY BATTERIES INDONESIA", px + 14, 22,
          scale=0.42, color=_LGRAY)
    _text(canvas, "Cover PN Detector", px + 14, 48,
          font=FONTD, scale=0.70, color=_WHITE, thick=1)
    # Accent dot
    cv2.circle(canvas, (WIN_W - 16, 30), 6, _ACCENT, -1)


def _draw_status_badge(canvas, px):
    """Coloured state badge just below header."""
    labels = {
        S.IDLE:     ("●  READY",      _GREEN),
        S.COUNTING: ("●  SCANNING",   _AMBER),
        S.SUCCESS:  ("●  DETECTED",   _GREEN),
        S.FAILED:   ("●  NOT FOUND",  _RED),
    }
    txt, col = labels[_app["state"]]
    by = 70
    _rect(canvas, px + 14, by, 140, 24, _HDRBG, radius=4)
    cv2.rectangle(canvas, (px + 14, by), (px + 14 + 140, by + 24), _BORDER, 1)
    _text(canvas, txt, px + 22, by + 17, scale=0.48, color=col)

    # Confidence threshold info (top-right of badge row)
    _text(canvas, f"min conf: {_app['conf_thresh']:.0%}", WIN_W - 110, by + 17,
          scale=0.44, color=_DGRAY)


def _draw_scan_area(canvas, px):
    """Countdown, progress bar, and live best-detection hint."""
    top = 104

    if _app["state"] == S.COUNTING:
        elapsed   = time.time() - _app["cd_start"]
        remaining = max(0.0, COUNTDOWN_SECS - elapsed)
        frac      = remaining / COUNTDOWN_SECS

        # Circular timer arc
        cx_arc = px + PANEL_W // 2
        cy_arc = top + 68
        r_arc  = 52

        # Background circle
        cv2.circle(canvas, (cx_arc, cy_arc), r_arc, _DGRAY, 4)

        # Foreground arc (remaining time)
        start_angle = -90
        sweep = int(360 * frac)
        if sweep > 0:
            col_arc = _GREEN if frac > 0.5 else _AMBER if frac > 0.2 else _RED
            cv2.ellipse(canvas, (cx_arc, cy_arc), (r_arc, r_arc),
                        0, start_angle, start_angle + sweep, col_arc, 4)

        # Time text inside arc
        _text_centered(canvas, f"{remaining:.1f}", cx_arc, cy_arc + 6,
                       font=FONTD, scale=0.85, color=_WHITE, thick=1)
        _text_centered(canvas, "sec", cx_arc, cy_arc + 22,
                       scale=0.40, color=_LGRAY)

        # Label
        _text_centered(canvas, "Scanning battery cover …", cx_arc, top + 138,
                       scale=0.48, color=_LGRAY)

        # Thin progress bar underneath arc label
        bw = PANEL_W - 36
        _hbar(canvas, px + 18, top + 150, bw, 5, frac, _ACCENT)

        # Best-so-far hint
        if _app["best_conf"] > 0:
            hint = f"Best so far: {_app['best_label']}  {_app['best_conf']:.1%}"
            _text_centered(canvas, hint, cx_arc, top + 170,
                           scale=0.46, color=_GREEN)

    elif _app["state"] == S.IDLE:
        _text(canvas, "Press the button below to begin",
              px + 14, top + 24, scale=0.49, color=_LGRAY)
        _text(canvas, "a 10-second part number scan.",
              px + 14, top + 44, scale=0.49, color=_LGRAY)

    # ── Divider above result area ──
    div_y = top + 185
    cv2.line(canvas, (px + 14, div_y), (WIN_W - 14, div_y), _BORDER, 1)
    _text(canvas, "LAST RESULT",
          px + 14, div_y + 16, scale=0.40, color=_DGRAY)


def _draw_result(canvas, px):
    """Thumbnail + PN + confidence (or failure message)."""
    result_y = 310          # top of result content block
    result_h = _BTN_Y - result_y - 10   # available height above button

    if _app["state"] == S.SUCCESS and _app["best_frame"] is not None:
        # ── Cropped thumbnail ──────────────────────────
        thumb_h = min(145, result_h - 100)
        thumb_w = PANEL_W - 32
        tx, ty  = px + 16, result_y

        frame = _app["best_frame"]
        box   = _app["best_box"]
        crop  = frame   # fallback: whole frame
        if box:
            x1, y1, x2, y2 = box
            bw, bh = max(1, x2 - x1), max(1, y2 - y1)
            pad_x  = int(bw * 0.25)
            pad_y  = int(bh * 0.25)
            fh, fw = frame.shape[:2]
            x1c    = max(0, x1 - pad_x)
            y1c    = max(0, y1 - pad_y)
            x2c    = min(fw, x2 + pad_x)
            y2c    = min(fh, y2 + pad_y)
            crop   = frame[y1c:y2c, x1c:x2c]
            if crop.size == 0:
                crop = frame

        thumb = cv2.resize(crop, (thumb_w, thumb_h))
        canvas[ty:ty + thumb_h, tx:tx + thumb_w] = thumb
        cv2.rectangle(canvas, (tx, ty), (tx + thumb_w, ty + thumb_h), _GREEN, 2)

        # Timestamp watermark on thumbnail
        ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _text(canvas, ts_str, tx + 4, ty + thumb_h - 6,
              scale=0.38, color=(200, 200, 200), thick=1)

        # ── Part Number label ──────────────────────────
        info_y = ty + thumb_h + 16
        _text(canvas, "Part Number", px + 16, info_y, scale=0.44, color=_LGRAY)
        _text(canvas, _app["best_label"] or "—", px + 16, info_y + 24,
              font=FONTD, scale=0.80, color=_WHITE, thick=1)

        # ── Confidence bar ────────────────────────────
        conf_y = info_y + 46
        conf   = _app["best_conf"]
        bar_w  = PANEL_W - 32
        bar_col = _GREEN if conf >= 0.92 else _AMBER if conf >= 0.85 else _RED
        _text(canvas, f"Confidence: {conf:.1%}", px + 16, conf_y,
              scale=0.46, color=_LGRAY)
        _hbar(canvas, px + 16, conf_y + 8, bar_w, 9, conf, bar_col)

    elif _app["state"] == S.FAILED:
        bx, by = px + 16, result_y
        bw_f   = PANEL_W - 32
        bh_f   = result_h - 4
        _rect(canvas, bx, by, bw_f, bh_f, (22, 26, 50))
        cv2.rectangle(canvas, (bx, by), (bx + bw_f, by + bh_f), _RED, 2)

        # Icon (simple X)
        mid = bx + bw_f // 2
        _text_centered(canvas, "✕", mid, by + 36, font=FONTD,
                       scale=1.0, color=_RED, thick=2)

        msg_lines = [
            "Detection timed out.",
            "",
            "No battery cover was identified",
            "within the 10-second window.",
            "",
            "Possible reasons:",
            "  · Model not trained on this cover",
            "  · Poor lighting / angle",
            "",
            "Please identify the part number",
            "manually and enter it in the",
            "portal — or press Scan Again.",
        ]
        for i, ln in enumerate(msg_lines):
            col   = _WHITE if i == 0 else _LGRAY
            scale = 0.50 if i == 0 else 0.43
            _text(canvas, ln, bx + 12, by + 62 + i * 18,
                  scale=scale, color=col)

    else:
        # Placeholder while IDLE or COUNTING (no previous result yet)
        px_, py_ = px + 16, result_y
        pw_, ph_ = PANEL_W - 32, result_h - 4
        _rect(canvas, px_, py_, pw_, ph_, (28, 30, 38))
        cv2.rectangle(canvas, (px_, py_), (px_ + pw_, py_ + ph_), _BORDER, 1)
        _text_centered(canvas, "— no scan yet —", px_ + pw_ // 2, py_ + ph_ // 2 + 5,
                       scale=0.48, color=_DGRAY)


def _draw_button(canvas, px):
    bx, by, bw, bh = _BTN_RECT
    mx, my = _app["mouse"]
    hover  = _btn_hit(mx, my)

    state = _app["state"]
    if state == S.COUNTING:
        label = "Cancel Scan"
        base  = (45, 55, 145)
        hi    = (55, 70, 170)
    elif state in (S.SUCCESS, S.FAILED):
        label = "Scan Again"
        base  = (28, 100, 42)
        hi    = (35, 130, 55)
    else:
        label = "Start Detection Scan"
        base  = (25, 130, 50)
        hi    = (32, 160, 65)

    col = hi if hover else base
    _rect(canvas, bx, by, bw, bh, col, radius=6)
    if hover:
        cv2.rectangle(canvas, (bx, by), (bx + bw, by + bh), _ACCENT, 1)

    (tw, th), _ = cv2.getTextSize(label, FONTD, 0.62, 1)
    _text(canvas, label, bx + (bw - tw) // 2, by + (bh + th) // 2,
          font=FONTD, scale=0.62, color=_WHITE)


def _draw_panel(canvas):
    px = CAM_W
    _rect(canvas, px, 0, PANEL_W, WIN_H, _PANEL)
    cv2.line(canvas, (px, 0), (px, WIN_H), _BORDER, 2)

    _draw_header(canvas, px)
    _draw_status_badge(canvas, px)
    _draw_scan_area(canvas, px)
    _draw_result(canvas, px)
    _draw_button(canvas, px)


# ══════════════════════════════════════════════════════
#  CAMERA FRAME DRAW
# ══════════════════════════════════════════════════════

def _draw_camera(canvas, frame, detections):
    """Draw the (scaled) camera feed with bounding boxes."""
    disp = cv2.resize(frame, (CAM_W, CAM_H))
    scale_x = CAM_W / frame.shape[1]
    scale_y = CAM_H / frame.shape[0]

    for det in detections:
        x1, y1, x2, y2 = det["box"]
        sx1 = int(x1 * scale_x); sy1 = int(y1 * scale_y)
        sx2 = int(x2 * scale_x); sy2 = int(y2 * scale_y)

        cv2.rectangle(disp, (sx1, sy1), (sx2, sy2), BOX_COLOR, 2)
        label = f"{det['cls']}  {det['conf']:.1%}"
        (lw, lh), _ = cv2.getTextSize(label, FONT, 0.54, 1)
        _rect(disp, sx1, sy1 - lh - 10, lw + 8, lh + 10, BOX_COLOR)
        _text(disp, label, sx1 + 4, sy1 - 4, scale=0.54, color=(255, 255, 255))

    # ── Scanning border pulse ──
    if _app["state"] == S.COUNTING:
        t   = time.time()
        pulse   = (math.sin(t * 4) + 1) / 2          # 0‥1
        thick   = 3
        r = int(20 + 215 * pulse)
        g = int(185 * (1 - pulse * 0.4))
        b = int(255 - 50 * pulse)
        cv2.rectangle(disp, (0, 0), (CAM_W - 1, CAM_H - 1), (b, g, r), thick)

        # Bottom-center countdown text overlay on camera
        elapsed   = time.time() - _app["cd_start"]
        remaining = max(0.0, COUNTDOWN_SECS - elapsed)
        overlay_txt = f"SCANNING  {remaining:.1f}s"
        (tw, _), _ = cv2.getTextSize(overlay_txt, FONTD, 0.70, 2)
        ox = (CAM_W - tw) // 2
        # Shadow
        _text(disp, overlay_txt, ox + 1, CAM_H - 13, font=FONTD,
              scale=0.70, color=(0, 0, 0), thick=3)
        _text(disp, overlay_txt, ox, CAM_H - 14, font=FONTD,
              scale=0.70, color=_ACCENT, thick=2)

    # ── FPS ──
    if _app["fps"] > 0:
        _text(disp, f"FPS {_app['fps']:.1f}", 10, 28,
              scale=0.60, color=_GREEN, thick=2)

    canvas[0:CAM_H, 0:CAM_W] = disp


# ══════════════════════════════════════════════════════
#  AUTO-SAVE HELPER
# ══════════════════════════════════════════════════════

def _auto_save(frame, label, conf, box):
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"detected_{label}_{conf:.0%}_{ts}.jpg"
    path = os.path.join(SAVE_DIR, name)

    save = frame.copy()
    if box:
        x1, y1, x2, y2 = box
        cv2.rectangle(save, (x1, y1), (x2, y2), BOX_COLOR, 2)
        lbl = f"{label}  {conf:.1%}"
        (lw, lh), _ = cv2.getTextSize(lbl, FONT, 0.55, 1)
        _rect(save, x1, y1 - lh - 10, lw + 8, lh + 10, BOX_COLOR)
        _text(save, lbl, x1 + 4, y1 - 4, scale=0.55, color=(255, 255, 255))

    cv2.imwrite(path, save)
    print(f"[AUTO-SAVE] {label} ({conf:.1%}) → {path}")


# ══════════════════════════════════════════════════════
#  STARTUP
# ══════════════════════════════════════════════════════
os.makedirs(SAVE_DIR, exist_ok=True)

print("=" * 56)
print("  PT. Century Batteries Indonesia — PN Cover Detector")
print("=" * 56)
print(f"  PyTorch : {torch.__version__}")
print(f"  CUDA    : {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"  GPU     : {torch.cuda.get_device_name(0)}")
print()
print(f"  Loading model:\n  {WEIGHTS_PATH}")
model  = YOLO(WEIGHTS_PATH)
device = 0 if torch.cuda.is_available() else "cpu"
print(f"  Classes : {model.names}")
print()

cap = cv2.VideoCapture(CAMERA_INDEX)
if not cap.isOpened():
    print(f"ERROR: Cannot open camera index {CAMERA_INDEX}.")
    exit(1)

cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
print(f"  Camera  : {actual_w}×{actual_h}")
print()
print("  Controls: Q=Quit | S=Save | +/-=Conf | P=Pause | SPACE=Scan")
print("=" * 56)

cv2.namedWindow(WIN_TITLE, cv2.WINDOW_NORMAL)
cv2.resizeWindow(WIN_TITLE, WIN_W, WIN_H)
cv2.setMouseCallback(WIN_TITLE, _mouse_cb)


# ══════════════════════════════════════════════════════
#  MAIN LOOP
# ══════════════════════════════════════════════════════
while True:
    # ── Grab frame ──────────────────────────────────
    if not _app["paused"]:
        ret, raw = cap.read()
        if not ret:
            print("ERROR: Frame grab failed — camera disconnected?")
            break
        _app["last_frame"] = raw.copy()

        # FPS counter
        _app["fc"] += 1
        dt = time.time() - _app["fps_t"]
        if dt >= 0.5:
            _app["fps"]   = _app["fc"] / dt
            _app["fc"]    = 0
            _app["fps_t"] = time.time()
    else:
        raw = _app["last_frame"] if _app["last_frame"] is not None \
              else np.zeros((720, 1280, 3), np.uint8)

    # ── YOLO inference ──────────────────────────────
    results    = model.predict(source=raw, conf=_app["conf_thresh"],
                               device=device, verbose=False)
    detections = []
    best_this_frame = None

    for r in results:
        for box in r.boxes:
            cls_id   = int(box.cls[0])
            cls_name = model.names[cls_id]
            conf     = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])

            detections.append({"cls": cls_name, "conf": conf,
                                "box": (x1, y1, x2, y2)})

            if best_this_frame is None or conf > best_this_frame["conf"]:
                best_this_frame = {"cls": cls_name, "conf": conf,
                                   "box": (x1, y1, x2, y2)}

    # ── State transitions ────────────────────────────
    if _app["state"] == S.COUNTING:
        elapsed = time.time() - _app["cd_start"]

        # Track best detection seen during scan (even below threshold)
        if best_this_frame and best_this_frame["conf"] >= AUTO_CAPTURE_CONF:
            # Update best if this frame is better
            if best_this_frame["conf"] > _app["best_conf"]:
                _app["best_conf"]  = best_this_frame["conf"]
                _app["best_label"] = best_this_frame["cls"]
                _app["best_frame"] = raw.copy()
                _app["best_box"]   = best_this_frame["box"]

            # SUCCESS — stop immediately (confidence met)
            _auto_save(_app["best_frame"], _app["best_label"],
                       _app["best_conf"], _app["best_box"])
            _app["state"] = S.SUCCESS
            print(f"[DETECTED] {_app['best_label']} — confidence {_app['best_conf']:.1%}")

        elif elapsed >= COUNTDOWN_SECS:
            # FAILED — countdown expired
            _app["state"] = S.FAILED
            print("[SCAN] No qualifying detection. Timed out.")

        # Keep updating "best so far" hint for sub-threshold detections
        elif best_this_frame:
            if best_this_frame["conf"] > _app["best_conf"]:
                _app["best_conf"]  = best_this_frame["conf"]
                _app["best_label"] = best_this_frame["cls"]

    # ── Build and display composite frame ───────────
    canvas = np.full((WIN_H, WIN_W, 3), _BG, dtype=np.uint8)
    _draw_camera(canvas, raw, detections)
    _draw_panel(canvas)

    cv2.imshow(WIN_TITLE, canvas)

    # ── Key handling ─────────────────────────────────
    key = cv2.waitKey(1) & 0xFF

    if key in (ord('q'), ord('Q'), 27):          # Q or ESC
        print("Quitting …")
        break

    elif key in (ord('s'), ord('S')):             # manual save
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(SAVE_DIR, f"manual_{ts}.jpg")
        cv2.imwrite(path, raw)
        print(f"[MANUAL SAVE] {path}")

    elif key in (ord('+'), ord('=')):
        _app["conf_thresh"] = min(0.95, round(_app["conf_thresh"] + 0.05, 2))
        print(f"Confidence threshold → {_app['conf_thresh']:.2f}")

    elif key in (ord('-'), ord('_')):
        _app["conf_thresh"] = max(0.05, round(_app["conf_thresh"] - 0.05, 2))
        print(f"Confidence threshold → {_app['conf_thresh']:.2f}")

    elif key in (ord('p'), ord('P')):
        _app["paused"] = not _app["paused"]
        print("Paused" if _app["paused"] else "Resumed")

    elif key == ord(' '):                         # spacebar = button click
        if _app["state"] in (S.IDLE, S.SUCCESS, S.FAILED):
            _start_scan()
        elif _app["state"] == S.COUNTING:
            _reset()


# ══════════════════════════════════════════════════════
#  CLEANUP
# ══════════════════════════════════════════════════════
cap.release()
cv2.destroyAllWindows()
print("Camera released. Goodbye.")