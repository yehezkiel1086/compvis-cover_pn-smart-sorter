// ─────────────────────────────────────────────
// DN (Delivery Note) Types
// ─────────────────────────────────────────────

export interface DNItem {
  id: string
  partNumber: string   // e.g. "Z-CV02-B20LXXX-B02N-NL-DG00"
  poNumber: string     // e.g. "SUB250432"
  line: number
  woNumber: string     // e.g. "PKSC11156"
  qtyDN: number        // quantity required per DN
  qtyLabel: number     // quantity already labelled in existing system
  status: 'pending' | 'partial' | 'fulfilled'
  cameraValidation: string | null
}

export interface DNDetail {
  dnNumber: string     // e.g. "KSS007317A"
  packingSlip: string  // e.g. "024/CBI/JUL/25"
  supplier: string
  date: string         // ISO string
  items: DNItem[]
  overallStatus: 'pending' | 'in_progress' | 'complete' | 'discrepancy'
}

// ─────────────────────────────────────────────
// Computer Vision / Detection Types
// ─────────────────────────────────────────────

export interface DetectionResult {
  detected: boolean
  className: string | null     // YOLO class name = PN code
  confidence: number           // 0.0 – 1.0
  // Normalised bounding box coords (0–1 relative to frame size)
  box: [number, number, number, number] | null  // x1, y1, x2, y2
}

// ─────────────────────────────────────────────
// Scan Session State
// ─────────────────────────────────────────────

export interface ScanCount {
  partNumber: string
  required: number
  scanned: number
  status: 'pending' | 'partial' | 'fulfilled' | 'excess'
  lastMethod: 'auto' | 'manual' | null
  lastConfidence: number | null
}

export interface ScanLogEntry {
  id: string
  partNumber: string
  method: 'auto' | 'manual'
  confidence: number | null
  timestamp: Date
  note?: string
}

// ─────────────────────────────────────────────
// Submission / Completion
// ─────────────────────────────────────────────

export type CompletionStatus = 'fulfilled' | 'discrepancy'

export interface CompletionPayload {
  dnNumber: string
  status: CompletionStatus
  note?: string
  items: {
    partNumber: string
    qtyRequired: number
    qtyScanned: number
  }[]
}