"""
CBI Smart Sorter — YOLO Inference API
FastAPI server that wraps the YOLO battery cover detection model.

Run with:
    pip install fastapi uvicorn ultralytics torch opencv-python python-multipart
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload

The frontend (Next.js) sends a base64-encoded JPEG frame and
receives detection results as JSON.
"""

import base64
import io
import os
import time
import numpy as np
import cv2
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
CONF_THRESH  = float(os.getenv("CONF_THRESH", "0.50"))   # minimum to return
DEVICE       = 0 if torch.cuda.is_available() else "cpu"

# ─────────────────────────────────────────────
# Model load (once at startup)
# ─────────────────────────────────────────────

print("=" * 52)
print("  CBI Smart Sorter — Inference Server")
print("=" * 52)
print(f"  PyTorch : {torch.__version__}")
print(f"  CUDA    : {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"  GPU     : {torch.cuda.get_device_name(0)}")
print(f"  Weights : {WEIGHTS_PATH}")
print()

model = YOLO(WEIGHTS_PATH)
print(f"  Classes : {model.names}")
print("=" * 52)

# ─────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────

app = FastAPI(
    title="CBI Smart Sorter Inference API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "*"],   # restrict in production
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────

class DetectRequest(BaseModel):
    frame: str   # base64-encoded JPEG

class DetectionResult(BaseModel):
    detected: bool
    class_name: str | None = None     # serialised as className by alias
    confidence: float = 0.0
    box: list[float] | None = None    # [x1n, y1n, x2n, y2n] normalised 0–1

    class Config:
        populate_by_name = True

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def base64_to_frame(b64: str) -> np.ndarray:
    """Decode a base64 JPEG string to an OpenCV BGR frame."""
    raw = base64.b64decode(b64)
    buf = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode image")
    return frame

def best_detection(results, min_conf: float = 0.0):
    """Return the highest-confidence detection across all result boxes."""
    best = None
    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf < min_conf:
                continue
            if best is None or conf > best["confidence"]:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                h, w = r.orig_shape
                best = {
                    "class_name": r.names[int(box.cls[0])],
                    "confidence": conf,
                    "box": [x1 / w, y1 / h, x2 / w, y2 / h],   # normalised
                }
    return best

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "cuda": torch.cuda.is_available(),
        "model_classes": list(model.names.values()),
    }


@app.post("/detect", response_model=DetectionResult)
def detect(req: DetectRequest):
    try:
        frame = base64_to_frame(req.frame)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid frame: {e}")

    t0      = time.perf_counter()
    results = model.predict(
        source=frame,
        conf=CONF_THRESH,
        device=DEVICE,
        verbose=False,
    )
    inference_ms = (time.perf_counter() - t0) * 1000

    det = best_detection(results, min_conf=CONF_THRESH)

    if det is None:
        return DetectionResult(detected=False)

    print(
        f"[DETECT] {det['class_name']}  {det['confidence']:.1%}  "
        f"({inference_ms:.0f} ms)"
    )

    return DetectionResult(
        detected=True,
        class_name=det["class_name"],
        confidence=det["confidence"],
        box=det["box"],
    )


# ─────────────────────────────────────────────
# Dev entrypoint
# ─────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)