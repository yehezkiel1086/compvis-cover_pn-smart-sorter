import type { CompletionPayload, DetectionResult, DNDetail } from '@/lib/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const INFERENCE_URL = process.env.NEXT_PUBLIC_INFERENCE_URL ?? 'http://localhost:8000'

// ─────────────────────────────────────────────
// DN Endpoints  (Go backend)
// ─────────────────────────────────────────────

export async function fetchDN(dnNumber: string): Promise<DNDetail> {
  const res = await fetch(
    `${API_URL}/api/dn/${encodeURIComponent(dnNumber)}`,
    { cache: 'no-store' }
  )
  if (res.status === 404) throw new Error('Nomor DN tidak ditemukan.')
  if (!res.ok) throw new Error('Gagal mengambil data DN dari server.')
  return res.json()
}

export async function recordScan(
  dnNumber: string,
  payload: {
    partNumber: string
    method: 'auto' | 'manual'
    confidence: number | null
    note?: string
  }
): Promise<void> {
  const res = await fetch(
    `${API_URL}/api/dn/${encodeURIComponent(dnNumber)}/scan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
  if (!res.ok) throw new Error('Gagal menyimpan data scan.')
}

export async function completeDN(payload: CompletionPayload): Promise<void> {
  const res = await fetch(
    `${API_URL}/api/dn/${encodeURIComponent(payload.dnNumber)}/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
  if (!res.ok) throw new Error('Gagal menyimpan hasil verifikasi.')
}

// ─────────────────────────────────────────────
// Inference Endpoint  (Python FastAPI server)
// ─────────────────────────────────────────────

export async function detectFrame(
  frameBase64: string
): Promise<DetectionResult> {
  const res = await fetch(`${INFERENCE_URL}/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame: frameBase64 }),
  })
  if (!res.ok) throw new Error('Inference request failed.')
  return res.json()
}

// ─────────────────────────────────────────────
// Mock data helpers (for local dev without Go backend)
// ─────────────────────────────────────────────

export function getMockDN(dnNumber: string): DNDetail {
  return {
    dnNumber,
    packingSlip: '024/CBI/JUL/25',
    supplier: 'PT Supplier Example',
    date: new Date().toISOString(),
    overallStatus: 'pending',
    items: [
      {
        id: '1',
        partNumber: 'W_CV01_D26RXXX_C03N_NL_DG00',
        poNumber: 'SUB250432',
        line: 1,
        woNumber: 'PKSC11156',
        qtyDN: 135,
        qtyLabel: 0,
        status: 'pending',
        cameraValidation: null,
      },
      {
        id: '2',
        partNumber: 'Z-CV02-B20LXXX-B02N-NL-DG00',
        poNumber: 'SUB250433',
        line: 2,
        woNumber: 'PKSC11157',
        qtyDN: 50,
        qtyLabel: 0,
        status: 'pending',
        cameraValidation: null,
      },
    ],
  }
}