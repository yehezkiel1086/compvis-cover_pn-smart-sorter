"""
CBI Smart Sorter — YOLO Inference API

Run:
    pip install fastapi uvicorn ultralytics torch opencv-python
    uvicorn server:app --host 0.0.0.0 --port 8000

The browser sends a base64-encoded JPEG frame every ~600 ms and receives:
    { detected, className, confidence, box: [x1n,y1n,x2n,y2n] }

CONF_THRESH controls the minimum confidence the *server* returns.
Keep this LOW (0.25) so the frontend can show bounding boxes even for
uncertain detections — the frontend gates auto-acceptance at 0.85 separately.
"""

import base64
import logging
import os
import time
from threading import Lock

import cv2
import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────

WEIGHTS_PATH = os.getenv(
    "WEIGHTS_PATH",
    r"C:\Users\KAKA\repos\companies\cbi\yolo-compvis-project\pn_cover_smart_sorter\run1\weights\best.pt",
)

# IMPORTANT: keep this LOW so the frontend can display boxes for uncertain
# detections. The frontend independently gates acceptance at AUTO_CONF=0.85.
CONF_THRESH = float(os.getenv("CONF_THRESH", "0.25"))

DEVICE = 0 if torch.cuda.is_available() else "cpu"

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# Model — loaded once at startup, behind a lock
# (FastAPI runs sync handlers in a thread pool;
#  the lock prevents concurrent YOLO calls)
# ─────────────────────────────────────────────

log.info("=" * 52)
log.info("  CBI Smart Sorter — Inference Server")
log.info("=" * 52)
log.info("  PyTorch : %s", torch.__version__)
log.info("  CUDA    : %s", torch.cuda.is_available())
if torch.cuda.is_available():
    log.info("  GPU     : %s", torch.cuda.get_device_name(0))
log.info("  Weights : %s", WEIGHTS_PATH)
log.info("  MinConf : %.0f%%", CONF_THRESH * 100)

model      = YOLO(WEIGHTS_PATH)
model_lock = Lock()

log.info("  Classes : %s", list(model.names.values()))
log.info("=" * 52)

# ─────────────────────────────────────────────
# FastAPI
# ─────────────────────────────────────────────

app = FastAPI(title="CBI Smart Sorter Inference API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # restrict in production
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────

class DetectRequest(BaseModel):
    frame: str   # base64-encoded JPEG or PNG

class DetectionResult(BaseModel):
    detected:   bool
    className:  str | None  = None
    confidence: float       = 0.0
    # Normalised bounding box: [x1, y1, x2, y2] each in [0, 1]
    box:        list[float] | None = None

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def decode_frame(b64: str) -> np.ndarray:
    """base64 → OpenCV BGR array."""
    try:
        raw   = base64.b64decode(b64)
        buf   = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("cv2.imdecode returned None")
        return frame
    except Exception as exc:
        raise ValueError(f"Frame decode error: {exc}") from exc


def run_inference(frame: np.ndarray) -> DetectionResult:
    """Run YOLO on frame, return the highest-confidence box."""
    with model_lock:
        t0      = time.perf_counter()
        results = model.predict(
            source  = frame,
            conf    = CONF_THRESH,
            device  = DEVICE,
            verbose = False,
        )
        ms = (time.perf_counter() - t0) * 1000

    best      = None
    best_conf = -1.0

    for r in results:
        if r.boxes is None:
            continue
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf > best_conf:
                best_conf = conf
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                h, w = r.orig_shape          # original frame dimensions
                best = {
                    "className":  r.names[int(box.cls[0])],
                    "confidence": conf,
                    # Normalise to [0, 1] relative to original frame size
                    "box": [
                        max(0.0, x1 / w),
                        max(0.0, y1 / h),
                        min(1.0, x2 / w),
                        min(1.0, y2 / h),
                    ],
                }

    if best is None:
        log.debug("No detection above %.0f%%  (%.0f ms)", CONF_THRESH * 100, ms)
        return DetectionResult(detected=False)

    log.info(
        "[DETECT] %-40s  conf=%.1f%%  box=%s  (%.0f ms)",
        best["className"], best["confidence"] * 100,
        [f"{v:.3f}" for v in best["box"]], ms,
    )
    return DetectionResult(
        detected   = True,
        className  = best["className"],
        confidence = best["confidence"],
        box        = best["box"],
    )

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status":        "ok",
        "cuda":          torch.cuda.is_available(),
        "device":        str(DEVICE),
        "conf_thresh":   CONF_THRESH,
        "model_classes": list(model.names.values()),
    }


@app.post("/detect", response_model=DetectionResult)
def detect(req: DetectRequest):
    if not req.frame:
        raise HTTPException(status_code=400, detail="frame is required")
    try:
        frame = decode_frame(req.frame)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return run_inference(frame)


# Debug endpoint — returns a synthetic 50 % confidence detection
# useful for verifying the frontend pipeline without a trained model.
# Remove or gate behind an env flag in production.
@app.post("/detect/test", response_model=DetectionResult)
def detect_test():
    return DetectionResult(
        detected   = True,
        className  = "W_CV01_D26RXXX_C03N_NL_DG00",
        confidence = 0.50,
        box        = [0.20, 0.25, 0.80, 0.75],
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)