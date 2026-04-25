import type {
  DetectionResult,
  DNDetail,
  ExternalDNResponse,
  LabelLookupResult,
  LabelSummaryItem,
  SavePackingPayload,
} from './types';

const API_URL       = process.env.NEXT_PUBLIC_API_URL       ?? 'http://localhost:8080'
const INFERENCE_URL = process.env.NEXT_PUBLIC_INFERENCE_URL ?? 'http://localhost:8000'

// ─────────────────────────────────────────────
// DN endpoints
// ─────────────────────────────────────────────

/** Check if DN already exists in the packing table */
export async function checkDnInPacking(
  dn: string
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_URL}/api/dn/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dn }),
  })
  if (!res.ok) throw new Error('Gagal memeriksa status DN.')
  return res.json()
}

/**
 * Fetch DN items from the external Astra API
 * (proxied through the Go backend to avoid CORS).
 */
export async function fetchDNItems(dn: string): Promise<ExternalDNResponse> {
  const res = await fetch(`${API_URL}/api/dn/items/${encodeURIComponent(dn)}`)
  if (res.status === 404) throw new Error('Nomor DN tidak terdaftar.')
  if (!res.ok) throw new Error('Gagal mengambil data DN dari server.')
  return res.json()
}

/**
 * Fetch the qty-label summary already saved to detail_label_packing for this DN.
 * Used to pre-populate the packing table when revisiting a DN.
 */
export async function fetchLabelSummary(
  dn: string
): Promise<{ success: boolean; data: LabelSummaryItem[] }> {
  const res = await fetch(`${API_URL}/api/dn/label-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dn }),
  })
  if (!res.ok) throw new Error('Gagal mengambil ringkasan qty label.')
  return res.json()
}

// ─────────────────────────────────────────────
// Label endpoints
// ─────────────────────────────────────────────

/** Look up a label barcode in the labels master table */
export async function lookupLabel(label: string): Promise<LabelLookupResult> {
  const res = await fetch(`${API_URL}/api/label/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error('Gagal mencari data label.')
  return res.json()
}

/** Delete a label from detail_label_packing */
export async function deleteLabel(payload: {
  id:          string
  dn:          string
  qty:         number
  partNumber:  string
}): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/label/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('Gagal menghapus label.')
  return res.json()
}

// ─────────────────────────────────────────────
// Packing save
// ─────────────────────────────────────────────

export async function savePacking(
  payload: SavePackingPayload
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_URL}/api/packing/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('Gagal menyimpan packing.')
  return res.json()
}

// ─────────────────────────────────────────────
// Computer Vision inference
// ─────────────────────────────────────────────

export async function detectFrame(frameBase64: string): Promise<DetectionResult> {
  const res = await fetch(`${INFERENCE_URL}/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame: frameBase64 }),
  })
  if (!res.ok) throw new Error('Inference request failed.')
  return res.json()
}

// ─────────────────────────────────────────────
// Legacy helpers (kept for backward compat)
// ─────────────────────────────────────────────

export async function fetchDN(dnNumber: string): Promise<DNDetail> {
  const items = await fetchDNItems(dnNumber)
  return {
    dnNumber,
    packingSlip: '',
    supplier: '',
    date: new Date().toISOString(),
    overallStatus: 'pending',
    items: items.results.map((r, i) => ({
      id: String(i),
      partNumber: r.ITEM,
      poNumber: r.PO,
      line: i + 1,
      woNumber: '',
      qtyDN: r.QTY,
      qtyLabel: 0,
      status: 'pending',
      cameraValidation: null,
    })),
  }
}

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
    ],
  }
}