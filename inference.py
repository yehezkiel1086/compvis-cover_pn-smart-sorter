"""
========================================================
  PT. Century Batteries Indonesia
  Battery Type Detection — Live Camera Inference
  GPU: NVIDIA GeForce GTX 1650 Max-Q (4GB VRAM)
========================================================
  Controls:
    Q        → Quit
    S        → Save current frame as image
    +/-      → Increase / decrease confidence threshold
    P        → Pause / resume
========================================================
"""

import cv2
import torch
import time
import os
from pathlib import Path
from datetime import datetime
from ultralytics import YOLO


# ──────────────────────────────────────────────
# CONFIGURATION  ← Edit these values
# ──────────────────────────────────────────────
WEIGHTS_PATH = r"C:\Users\KAKA\repos\companies\cbi\yolo-compvis-project\battery_detection\run1\weights\best.pt"
CAMERA_INDEX = 0          # 0 = default webcam, 1 = external camera
CONF_THRESH  = 0.5        # Initial confidence threshold (0.0 - 1.0)
SAVE_DIR     = r"C:\Users\KAKA\repos\companies\cbi\yolo-compvis-project\inference_saves"

# Display settings
SHOW_FPS     = True
SHOW_CONF    = True
BOX_COLOR    = (0, 200, 255)   # BGR: orange-yellow
TEXT_COLOR   = (255, 255, 255) # white
FONT         = cv2.FONT_HERSHEY_SIMPLEX


# ──────────────────────────────────────────────
# SETUP
# ──────────────────────────────────────────────
os.makedirs(SAVE_DIR, exist_ok=True)

print("=" * 50)
print("SYSTEM CHECK")
print("=" * 50)
print(f"PyTorch : {torch.__version__}")
print(f"CUDA    : {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU     : {torch.cuda.get_device_name(0)}")
print()

# Load model
print(f"Loading model from:\n  {WEIGHTS_PATH}\n")
model  = YOLO(WEIGHTS_PATH)
device = 0 if torch.cuda.is_available() else "cpu"
print(f"Model loaded! Classes: {model.names}")
print()


# ──────────────────────────────────────────────
# OPEN CAMERA
# ──────────────────────────────────────────────
cap = cv2.VideoCapture(CAMERA_INDEX)

if not cap.isOpened():
    print(f"ERROR: Could not open camera index {CAMERA_INDEX}.")
    print("Try changing CAMERA_INDEX to 1 or 2.")
    exit()

# Set camera resolution
cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
print(f"Camera opened: {actual_w}x{actual_h}")
print()
print("Controls: Q=Quit | S=Save frame | +/-=Confidence | P=Pause")
print("=" * 50)


# ──────────────────────────────────────────────
# INFERENCE LOOP
# ──────────────────────────────────────────────
conf_thresh = CONF_THRESH
paused      = False
frame_count = 0
fps         = 0
fps_timer   = time.time()

while True:
    if not paused:
        ret, frame = cap.read()
        if not ret:
            print("ERROR: Failed to grab frame. Camera disconnected?")
            break

        frame_count += 1

        # ── Run YOLO inference ──
        results = model.predict(
            source  = frame,
            conf    = conf_thresh,
            device  = device,
            verbose = False,       # suppress per-frame console output
        )

        # ── Draw detections ──
        detections = []
        for r in results:
            for box in r.boxes:
                cls_id   = int(box.cls[0])
                cls_name = model.names[cls_id]
                conf     = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])

                detections.append({
                    "class": cls_name,
                    "conf": conf,
                    "box": (x1, y1, x2, y2)
                })

                # Bounding box
                cv2.rectangle(frame, (x1, y1), (x2, y2), BOX_COLOR, 2)

                # Label background
                label = f"{cls_name} {conf:.0%}" if SHOW_CONF else cls_name
                (lw, lh), _ = cv2.getTextSize(label, FONT, 0.55, 1)
                cv2.rectangle(frame, (x1, y1 - lh - 8), (x1 + lw + 4, y1), BOX_COLOR, -1)

                # Label text
                cv2.putText(frame, label, (x1 + 2, y1 - 4),
                            FONT, 0.55, TEXT_COLOR, 1, cv2.LINE_AA)

        # ── FPS counter ──
        if SHOW_FPS:
            elapsed = time.time() - fps_timer
            if elapsed >= 0.5:
                fps = frame_count / elapsed
                frame_count = 0
                fps_timer   = time.time()
            cv2.putText(frame, f"FPS: {fps:.1f}", (10, 30),
                        FONT, 0.7, (0, 255, 0), 2, cv2.LINE_AA)

        # ── Confidence threshold display ──
        cv2.putText(frame, f"Conf: {conf_thresh:.2f}  (+/-  to adjust)",
                    (10, actual_h - 40), FONT, 0.6, (200, 200, 200), 1, cv2.LINE_AA)

        # ── Detection count ──
        cv2.putText(frame, f"Detected: {len(detections)} battery(s)",
                    (10, actual_h - 15), FONT, 0.6, (200, 200, 200), 1, cv2.LINE_AA)

    else:
        # Paused — draw overlay on existing frame
        cv2.putText(frame, "PAUSED  (P to resume)", (10, 60),
                    FONT, 0.8, (0, 100, 255), 2, cv2.LINE_AA)

    # ── Show frame ──
    cv2.imshow("Battery Type Detection — PT. Century Batteries", frame)

    # ── Key controls ──
    key = cv2.waitKey(1) & 0xFF

    if key == ord('q') or key == ord('Q'):
        print("Quitting...")
        break

    elif key == ord('s') or key == ord('S'):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        save_path = os.path.join(SAVE_DIR, f"capture_{timestamp}.jpg")
        cv2.imwrite(save_path, frame)
        print(f"Frame saved: {save_path}")

    elif key == ord('+') or key == ord('='):
        conf_thresh = min(0.95, round(conf_thresh + 0.05, 2))
        print(f"Confidence threshold: {conf_thresh:.2f}")

    elif key == ord('-') or key == ord('_'):
        conf_thresh = max(0.05, round(conf_thresh - 0.05, 2))
        print(f"Confidence threshold: {conf_thresh:.2f}")

    elif key == ord('p') or key == ord('P'):
        paused = not paused
        print("Paused" if paused else "Resumed")


# ──────────────────────────────────────────────
# CLEANUP
# ──────────────────────────────────────────────
cap.release()
cv2.destroyAllWindows()
print("Camera released. Done.")