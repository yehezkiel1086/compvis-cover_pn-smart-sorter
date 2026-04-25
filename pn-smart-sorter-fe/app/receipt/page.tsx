'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent,
  DialogDescription, DialogFooter,
  DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  checkDnInPacking, fetchDNItems, fetchLabelSummary,
  lookupLabel, savePacking
} from '@/lib/api'
import type {
  ExternalDNRow, InputtedLabel, PackingItem, SavePackingPayload
} from '@/lib/types'
import {
  AlertTriangle,
  ArrowLeft,
  Barcode,
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCw,
  Send,
  Trash2
} from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeUniqueKey(item: string, noDn: string) { return `${item}_${noDn}` }

function statusBadge(status: PackingItem['status']) {
  return status === 'Terpenuhi'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
    : 'bg-red-100 text-red-700 border-red-300'
}

// ─────────────────────────────────────────────
// Toast (lightweight inline notification)
// ─────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'warning' | 'info'
interface Toast { id: number; type: ToastType; title: string; message?: string }

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const add = useCallback((type: ToastType, title: string, message?: string) => {
    const id = ++counter.current
    setToasts(t => [...t, { id, type, title, message }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500)
  }, [])
  return { toasts, add }
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export default function ReceiptPage() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { toasts, add: toast } = useToasts()

  // Query params from CV scan redirect
  const qDn = searchParams.get('dn') ?? ''
  const qPn = searchParams.get('pn') ?? ''   // pre-detected part number (informational)

  // ── DN state ──────────────────────────────
  const [dnInput, setDnInput]       = useState(qDn)
  const [dnLocked, setDnLocked]     = useState(false)
  const [dnLoading, setDnLoading]   = useState(false)
  const [po, setPo]                 = useState('')

  // ── Packing table state ───────────────────
  const [partData, setPartData]     = useState<Record<string, ExternalDNRow>>({}) // uniqueKey → row
  const [inputtedLabels, setInputtedLabels] = useState<InputtedLabel[]>([])
  const [totalLabelQty, setTotalLabelQty]   = useState<Record<string, number>>({}) // uniqueKey → qty

  // ── Label input ───────────────────────────
  const [labelInput, setLabelInput]   = useState('')
  const [labelLoading, setLabelLoading] = useState(false)
  const labelRef = useRef<HTMLInputElement>(null)

  // ── UI state ──────────────────────────────
  const [tableVisible, setTableVisible] = useState(false)
  const [detailModal, setDetailModal]   = useState<{
    open: boolean; uniqueKey: string
  }>({ open: false, uniqueKey: '' })
  const [submitConfirm, setSubmitConfirm] = useState(false)
  const [submitting, setSubmitting]       = useState(false)

  // ── Derived packing items ─────────────────
  const packingItems = useMemo<PackingItem[]>(() => {
    return Object.entries(partData)
      .sort(([, a], [, b]) => {
        if (a.ITEM === b.ITEM) return a.NODN.localeCompare(b.NODN)
        return a.ITEM.localeCompare(b.ITEM)
      })
      .map(([uk, row]) => {
        const qty = totalLabelQty[uk] ?? 0
        return {
          uniqueKey: uk,
          partNumber: row.ITEM,
          noDn: row.NODN,
          po: row.PO,
          qtyDN: row.QTY,
          qtyLabel: qty,
          status: qty >= row.QTY ? 'Terpenuhi' : 'Belum Terpenuhi',
        } satisfies PackingItem
      })
  }, [partData, totalLabelQty])

  const allFulfilled = packingItems.length > 0
    && packingItems.every(i => i.status === 'Terpenuhi')

  const unfulfilledParts = packingItems.filter(i => i.status === 'Belum Terpenuhi')

  // ── Auto-submit DN from query param ───────
  useEffect(() => {
    if (qDn) submitDn(qDn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─────────────────────────────────────────
  // DN Submit
  // ─────────────────────────────────────────

  async function submitDn(dn: string) {
    const value = dn.trim().toUpperCase()
    if (!value) return

    setDnLoading(true)
    try {
      // 1. Check if already in packing table
      const check = await checkDnInPacking(value)
      if (!check.success) {
        toast('error', 'DN Sudah Terdaftar',
          check.message ?? 'Silakan edit jika menginginkan perubahan.')
        setDnLoading(false)
        return
      }

      // 2. Fetch items from external Astra API (via Go proxy)
      const apiData = await fetchDNItems(value)
      if (!apiData.results?.length) {
        toast('error', 'DN Tidak Ditemukan', 'Silakan periksa kembali nomor DN.')
        setDnLoading(false)
        return
      }

      // Filter rows that belong to this DN
      const relevantRows = apiData.results.filter(r => r.NODN.startsWith(value))
      if (!relevantRows.length) {
        toast('error', 'Data Part Tidak Ditemukan',
          'DN ditemukan, tetapi tidak ada part number yang sesuai.')
        setDnLoading(false)
        return
      }

      // Build partData
      const newParts: Record<string, ExternalDNRow> = {}
      const newQty: Record<string, number> = {}
      relevantRows.forEach(row => {
        const uk = makeUniqueKey(row.ITEM, row.NODN)
        newParts[uk] = { ...row, QTY: parseFloat(String(row.QTY)) }
        newQty[uk] = 0
      })

      setPo(apiData.results[0].PO)
      setPartData(newParts)
      setTotalLabelQty(newQty)
      setInputtedLabels([])

      // 3. Fetch existing label summary from DB
      const summary = await fetchLabelSummary(value)
      if (summary.success && summary.data?.length) {
        const updatedQty = { ...newQty }
        const preLabels: InputtedLabel[] = []

        summary.data.forEach(item => {
          const uk = makeUniqueKey(item.partNumberLabel, item.noDn)
          if (newParts[uk] !== undefined) {
            updatedQty[uk] = item.qtyLabel
            if (item.label) {
              preLabels.push({
                label: item.label,
                partNumber: item.partNumberLabel,
                qty: item.qtyLabel,
                noDn: item.noDn,
              })
            }
          }
        })
        setTotalLabelQty(updatedQty)
        setInputtedLabels(preLabels)
      }

      setDnLocked(true)
      setTableVisible(true)
      setTimeout(() => labelRef.current?.focus(), 100)

      if (qPn) {
        toast('info', 'Battery Cover Terdeteksi',
          `Part number ${qPn} telah dideteksi oleh kamera.`)
      }

    } catch (err: unknown) {
      toast('error', 'Error', err instanceof Error ? err.message : 'Terjadi kesalahan.')
    } finally {
      setDnLoading(false)
    }
  }

  function handleDnKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter') submitDn(dnInput)
  }

  function resetDn() {
    setDnInput('')
    setDnLocked(false)
    setPo('')
    setPartData({})
    setTotalLabelQty({})
    setInputtedLabels([])
    setTableVisible(false)
  }

  // ─────────────────────────────────────────
  // Label Submit
  // ─────────────────────────────────────────

  const handleLabelSubmit = useCallback(async () => {
    const value = labelInput.trim()
    if (!value) return

    // Client-side duplicate check
    if (inputtedLabels.some(l => l.label === value)) {
      toast('warning', 'Label Sudah Digunakan',
        'Label ini sudah diinput sebelumnya. Silakan input label yang berbeda.')
      setLabelInput('')
      labelRef.current?.focus()
      return
    }

    setLabelLoading(true)
    try {
      const result = await lookupLabel(value)

      if (!result.success || !result.partNumber) {
        toast('error', 'Label Tidak Ditemukan',
          result.message ?? 'Label tidak ditemukan atau tidak aktif.')
        setLabelInput('')
        labelRef.current?.focus()
        return
      }

      const pn  = result.partNumber
      const qty = result.qty ?? 0

      // Find which packing row this label belongs to
      const matchingKey = Object.keys(partData).find(
        uk => partData[uk].ITEM === pn && partData[uk].NODN.startsWith(dnInput.trim().toUpperCase())
      )

      if (!matchingKey) {
        toast('error', 'Part Number Tidak Sesuai',
          `Part number ${pn} tidak ditemukan dalam DN ini.`)
        setLabelInput('')
        labelRef.current?.focus()
        return
      }

      const currentQty  = totalLabelQty[matchingKey] ?? 0
      const newQty      = currentQty + qty
      const qtyDN       = partData[matchingKey].QTY

      if (newQty > qtyDN) {
        toast('error', 'QTY Label Melebihi QTY DN',
          `Qty label (${newQty}) melebihi qty DN (${qtyDN}) untuk part ${pn}.`)
        setLabelInput('')
        labelRef.current?.focus()
        return
      }

      // Update state
      const noDn = partData[matchingKey].NODN
      setTotalLabelQty(prev => ({ ...prev, [matchingKey]: newQty }))
      setInputtedLabels(prev => [
        ...prev,
        { label: value, partNumber: pn, qty, noDn }
      ])

      toast('success', 'Label Berhasil Ditambahkan',
        `${pn} +${qty} (total: ${newQty}/${qtyDN})`)

    } catch (err: unknown) {
      toast('error', 'Error', err instanceof Error ? err.message : 'Terjadi kesalahan.')
    } finally {
      setLabelLoading(false)
      setLabelInput('')
      labelRef.current?.focus()
    }
  }, [labelInput, inputtedLabels, partData, totalLabelQty, dnInput, toast])

  function handleLabelKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleLabelSubmit()
  }

  // ─────────────────────────────────────────
  // Delete label (client-side only before submit)
  // ─────────────────────────────────────────

  function deleteLabel(label: InputtedLabel) {
    setInputtedLabels(prev => prev.filter(l => l.label !== label.label))
    const uk = makeUniqueKey(label.partNumber, label.noDn)
    setTotalLabelQty(prev => ({
      ...prev,
      [uk]: Math.max(0, (prev[uk] ?? 0) - label.qty),
    }))
    toast('success', 'Label Dihapus', `${label.label} telah dihapus.`)
  }

  // ─────────────────────────────────────────
  // Save packing
  // ─────────────────────────────────────────

  async function handleSavePacking() {
    const totalScanned = Object.values(totalLabelQty).reduce((a, b) => a + b, 0)
    if (totalScanned === 0) {
      toast('error', 'Gagal Menyimpan', 'Tolong input label terlebih dahulu!')
      return
    }
    setSubmitConfirm(true)
  }

  async function confirmSave() {
    setSubmitting(true)
    const dn = dnInput.trim().toUpperCase()

    const details = packingItems.map(item => ({
      partNumberDn:   item.partNumber,
      noDnItem:       item.noDn,
      poItem:         item.po,
      qtyDnItem:      item.qtyDN,
      totalQtyDn:     item.qtyDN,
      totalQtyLabel:  item.qtyLabel,
      status:         item.status,
    })) satisfies SavePackingPayload['details']

    try {
      const result = await savePacking({
        mainDn: dn, po, details, inputtedLabels,
      })
      if (result.success) {
        toast('success', 'Packing Berhasil Disimpan!')
        setSubmitConfirm(false)
        setTimeout(() => router.push('/'), 1500)
      } else {
        toast('error', 'Gagal Menyimpan', result.message)
        setSubmitting(false)
      }
    } catch (err: unknown) {
      toast('error', 'Error', err instanceof Error ? err.message : 'Terjadi kesalahan.')
      setSubmitting(false)
    }
  }

  // ─────────────────────────────────────────
  // Detail modal labels for one row
  // ─────────────────────────────────────────

  const detailLabels = useMemo(() => {
    const uk = detailModal.uniqueKey
    if (!uk) return []
    const row = partData[uk]
    if (!row) return []
    return inputtedLabels.filter(
      l => l.partNumber === row.ITEM && l.noDn === row.NODN
    )
  }, [detailModal.uniqueKey, inputtedLabels, partData])

  // ═════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── Toast container ──────────────── */}
      <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm w-full pointer-events-none">
        {toasts.map(t => (
          <div key={t.id}
            className={`pointer-events-auto rounded-xl border shadow-lg p-4 text-sm
              animate-in slide-in-from-right duration-300
              ${t.type === 'success' ? 'bg-white border-emerald-200'
                : t.type === 'error'   ? 'bg-white border-red-200'
                : t.type === 'warning' ? 'bg-white border-amber-200'
                : 'bg-white border-sky-200'}`}
          >
            <div className={`font-semibold
              ${t.type === 'success' ? 'text-emerald-700'
                : t.type === 'error'   ? 'text-red-700'
                : t.type === 'warning' ? 'text-amber-700'
                : 'text-sky-700'}`}>
              {t.title}
            </div>
            {t.message && (
              <div className="text-slate-500 text-xs mt-0.5">{t.message}</div>
            )}
          </div>
        ))}
      </div>

      {/* ── Header ───────────────────────── */}
      <header className="border-b bg-white sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/"
            className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800
                       transition-colors text-sm font-medium">
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Kembali</span>
          </Link>
          <span className="w-px h-5 bg-slate-200" />
          <span className="font-semibold text-slate-800">Input Receipt</span>
          {dnLocked && (
            <>
              <span className="w-px h-5 bg-slate-200" />
              <span className="font-mono text-sm text-sky-700 font-bold">{dnInput}</span>
              {qPn && (
                <Badge variant="outline" className="text-xs border-sky-300 text-sky-700">
                  CV: {qPn}
                </Badge>
              )}
            </>
          )}
          <div className="ml-auto text-xs text-slate-400">
            PT. Century Batteries Indonesia
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 space-y-5">

        {/* ── 1. DN Input card ─────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            No. DN
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-sm">
              <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                value={dnInput}
                onChange={e => setDnInput(e.target.value.toUpperCase())}
                onKeyDown={handleDnKeyPress}
                placeholder="Scan barcode atau ketik No. DN…"
                className="pl-10 font-mono tracking-wider uppercase"
                disabled={dnLocked || dnLoading}
                autoComplete="off"
              />
            </div>
            {!dnLocked ? (
              <Button
                onClick={() => submitDn(dnInput)}
                disabled={!dnInput.trim() || dnLoading}
                className="bg-blue-700 hover:bg-blue-800"
              >
                {dnLoading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : 'Submit'}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={resetDn}
                className="border-amber-400 text-amber-600 hover:bg-amber-50"
              >
                <RefreshCw className="w-4 h-4 mr-1.5" />
                Reset
              </Button>
            )}
          </div>
          {po && (
            <p className="text-xs text-slate-400 mt-2">PO: <span className="font-mono">{po}</span></p>
          )}
        </div>

        {/* ── 2. Label Input card ───────────── */}
        {dnLocked && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Label
            </label>
            <div className="flex gap-2 max-w-sm">
              <div className="relative flex-1">
                <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  ref={labelRef}
                  value={labelInput}
                  onChange={e => setLabelInput(e.target.value)}
                  onKeyDown={handleLabelKeyPress}
                  placeholder="Scan label barcode…"
                  className="pl-10 font-mono"
                  disabled={labelLoading}
                  autoComplete="off"
                />
              </div>
              <Button
                onClick={handleLabelSubmit}
                disabled={!labelInput.trim() || labelLoading}
                className="bg-blue-700 hover:bg-blue-800"
              >
                {labelLoading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : 'Submit'}
              </Button>
            </div>
          </div>
        )}

        {/* ── 3. Packing table ─────────────── */}
        {tableVisible && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3 flex items-center justify-between">
              <h2 className="font-semibold text-slate-800">Tabel Packing</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {packingItems.filter(i => i.status === 'Terpenuhi').length}/{packingItems.length} terpenuhi
                </span>
                {allFulfilled && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {['No.', 'Part Number', 'Qty DN', 'Qty Label', 'Status', 'Action']
                      .map(h => (
                        <th key={h}
                          className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                          {h}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {packingItems.map((item, idx) => (
                    <tr key={item.uniqueKey}
                      className={item.partNumber === qPn ? 'bg-sky-50' : 'hover:bg-slate-50'}
                    >
                      <td className="px-4 py-3 text-slate-500 text-xs">{idx + 1}.</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-sm text-slate-800 font-medium">
                          {item.partNumber}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">DN: {item.noDn}</div>
                        {item.partNumber === qPn && (
                          <div className="text-xs text-sky-600 mt-0.5 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Terdeteksi oleh kamera
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums font-medium text-slate-700">
                        {item.qtyDN}
                      </td>
                      <td className="px-4 py-3 tabular-nums font-semibold">
                        <span className={item.qtyLabel > 0 ? 'text-slate-800' : 'text-slate-400'}>
                          {item.qtyLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full
                          text-xs font-medium border ${statusBadge(item.status)}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDetailModal({ open: true, uniqueKey: item.uniqueKey })}
                          className="border-slate-300 text-slate-600 hover:bg-slate-100 text-xs h-7"
                        >
                          <Eye className="w-3 h-3 mr-1" />
                          Detail
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Progress bar */}
            <div className="px-5 py-3 bg-slate-50 border-t border-slate-100">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{
                      width: packingItems.length
                        ? `${(packingItems.filter(i => i.status === 'Terpenuhi').length / packingItems.length) * 100}%`
                        : '0%'
                    }}
                  />
                </div>
                <Button
                  onClick={handleSavePacking}
                  disabled={submitting}
                  className="bg-blue-700 hover:bg-blue-800"
                >
                  <Send className="w-4 h-4 mr-2" />
                  Submit Packing
                </Button>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* ═════════════════════════════════════════
          MODAL: Label Detail
      ═════════════════════════════════════════ */}
      <Dialog
        open={detailModal.open}
        onOpenChange={v => setDetailModal(d => ({ ...d, open: v }))}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Detail Label</DialogTitle>
            <DialogDescription>
              {partData[detailModal.uniqueKey]?.ITEM}
              <span className="text-slate-400 ml-2">
                DN: {partData[detailModal.uniqueKey]?.NODN}
              </span>
            </DialogDescription>
          </DialogHeader>

          {detailLabels.length === 0 ? (
            <p className="text-slate-400 text-sm py-4 text-center">
              Belum ada label yang diinput untuk part ini.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b">
                  <tr>
                    {['No.', 'Label', 'Qty', 'Action'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold
                                             text-slate-500 uppercase tracking-wider">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detailLabels.map((lbl, i) => (
                    <tr key={lbl.label} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-400 text-xs">{i + 1}.</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700">{lbl.label}</td>
                      <td className="px-3 py-2 tabular-nums">{lbl.qty}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            deleteLabel(lbl)
                            if (detailLabels.length <= 1)
                              setDetailModal(d => ({ ...d, open: false }))
                          }}
                          className="text-red-500 hover:text-red-700 transition-colors"
                          title="Hapus label"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline"
              onClick={() => setDetailModal(d => ({ ...d, open: false }))}>
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═════════════════════════════════════════
          MODAL: Submit Confirm
      ═════════════════════════════════════════ */}
      <Dialog open={submitConfirm} onOpenChange={v => !submitting && setSubmitConfirm(v)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              {allFulfilled
                ? <CheckCircle2 className="w-6 h-6 text-emerald-500 shrink-0" />
                : <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0" />}
              <DialogTitle>
                {allFulfilled ? 'Semua Part Terpenuhi' : 'Ada Part Belum Terpenuhi'}
              </DialogTitle>
            </div>
            <DialogDescription>
              {allFulfilled
                ? 'Seluruh part number dalam DN ini telah terpenuhi. Lanjutkan submit?'
                : `Part berikut tidak memenuhi total DN: ${unfulfilledParts.map(p => p.partNumber).join(', ')}. Apakah Anda yakin ingin melanjutkan?`}
            </DialogDescription>
          </DialogHeader>

          {/* Summary */}
          <div className="rounded-lg overflow-hidden border border-slate-200 my-1">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b">
                <tr>
                  {['Part Number', 'DN', 'Label', 'Status'].map(h => (
                    <th key={h}
                      className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {packingItems.map(item => (
                  <tr key={item.uniqueKey}
                    className={item.status !== 'Terpenuhi' ? 'bg-amber-50' : ''}>
                    <td className="px-3 py-2 font-mono text-slate-700 break-all">
                      {item.partNumber}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-500 text-xs">
                      {item.qtyDN}
                    </td>
                    <td className={`px-3 py-2 font-semibold tabular-nums
                      ${item.status === 'Terpenuhi' ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {item.qtyLabel}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border
                        ${statusBadge(item.status)}`}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSubmitConfirm(false)}
              disabled={submitting}>
              Batal
            </Button>
            <Button
              onClick={confirmSave}
              disabled={submitting}
              className={allFulfilled
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-amber-600 hover:bg-amber-700'}
            >
              {submitting
                ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
                : null}
              {allFulfilled ? 'Ya, Submit' : 'Ya, Submit dengan Ketidaksesuaian'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <footer className="text-center text-xs text-slate-400 py-4 border-t bg-white">
        © {new Date().getFullYear()} PT Century Batteries Indonesia. All Rights Reserved.
      </footer>
    </div>
  )
}