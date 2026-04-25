// ─────────────────────────────────────────────
// External DN API  (appext.incoe.astra.co.id)
// ─────────────────────────────────────────────

/** One row returned by the external Astra DN API */
export interface ExternalDNRow {
  NODN:  string
  ITEM:  string   // part number
  QTY:   number
  PO:    string
}

export interface ExternalDNResponse {
  results: ExternalDNRow[]
}

// ─────────────────────────────────────────────
// Input Receipt / Packing types
// ─────────────────────────────────────────────

export interface PackingItem {
  uniqueKey:   string   // ITEM + "_" + NODN
  partNumber:  string
  noDn:        string
  po:          string
  qtyDN:       number
  qtyLabel:    number
  status:      'Terpenuhi' | 'Belum Terpenuhi'
}

export interface InputtedLabel {
  label:       string
  partNumber:  string
  qty:         number
  noDn:        string
}

export interface LabelLookupResult {
  success:     boolean
  message?:    string
  partNumber?: string
  qty?:        number
  label?:      string
}

export interface LabelSummaryItem {
  partNumberLabel: string
  noDn:            string
  label:           string
  qtyLabel:        number
}

export interface SavePackingPayload {
  mainDn:         string
  po:             string
  details:        PackingDetail[]
  inputtedLabels: InputtedLabel[]
}

export interface PackingDetail {
  partNumberDn:   string
  noDnItem:       string
  poItem:         string
  qtyDnItem:      number
  totalQtyDn:     number
  totalQtyLabel:  number
  status:         'Terpenuhi' | 'Belum Terpenuhi'
}

// ─────────────────────────────────────────────
// Computer Vision
// ─────────────────────────────────────────────

export interface DetectionResult {
  detected:   boolean
  className:  string | null
  confidence: number
  box:        [number, number, number, number] | null
}

// ─────────────────────────────────────────────
// Legacy types kept for backward compat
// ─────────────────────────────────────────────

export interface DNItem {
  id:               string
  partNumber:       string
  poNumber:         string
  line:             number
  woNumber:         string
  qtyDN:            number
  qtyLabel:         number
  status:           'pending' | 'partial' | 'fulfilled'
  cameraValidation: string | null
}

export interface DNDetail {
  dnNumber:      string
  packingSlip:   string
  supplier:      string
  date:          string
  items:         DNItem[]
  overallStatus: 'pending' | 'in_progress' | 'complete' | 'discrepancy'
}