'use client'

import {
  useState, useRef, useEffect, useCallback, useMemo
} from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Camera, CameraOff, Pause, Play,
  CheckCircle2, AlertTriangle, XCircle, Loader2,
  PenLine, CheckCheck, Info, ChevronDown, ChevronUp
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { completeDN, detectFrame, fetchDN, getMockDN, recordScan } from '@/lib/api'
import type {
  DNDetail, DetectionResult, ScanCount, ScanLogEntry
} from '@/lib/types'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const USE_MOCK       = process.env.NEXT_PUBLIC_USE_MOCK === 'true'
const AUTO_CONF      = 0.85   // auto-count threshold
const COOLDOWN_MS    = 2500   // per-PN cooldown after count
const DETECT_INTERVAL= 600    // ms between inference calls

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function shortPN(pn: string) {
  return pn.length > 28 ? `${pn.slice(0, 26)}…` : pn
}

function statusColor(s: ScanCount['status']) {
  return {
    pending:   'bg-slate-700 text-slate-300',
    partial:   'bg-amber-900/60 text-amber-300',
    fulfilled: 'bg-emerald-900/60 text-emerald-300',
    excess:    'bg-red-900/60 text-red-300',
  }[s]
}

function statusLabel(s: ScanCount['status']) {
  return {
    pending:   'Belum',
    partial:   'Sebagian',
    fulfilled: 'Terpenuhi',
    excess:    'Berlebih',
  }[s]
}

// ─────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────

export default function ScanPage() {
  const { dn: rawDn } = useParams<{ dn: string }>()
  const dnNumber = decodeURIComponent(rawDn)
  const router = useRouter()

  // ── Data ──────────────────────────────────
  const [dnData, setDnData]     = useState<DNDetail | null>(null)
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState<string | null>(null)

  // ── Camera ────────────────────────────────
  const videoRef   = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const captureRef = useRef<HTMLCanvasElement>(null)   // hidden, for frame capture
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  // ── Detection ─────────────────────────────
  const [isDetecting, setIsDetecting]       = useState(true)
  const isDetectingRef                       = useRef(true)
  const lastDetectedRef                      = useRef<Map<string, number>>(new Map())
  const [currentDetection, setCurrentDetection] = useState<DetectionResult | null>(null)
  const [detectStatus, setDetectStatus]     = useState<'idle'|'ok'|'match'|'nomatch'>('idle')

  // ── Scan Counts ───────────────────────────
  const [scanCounts, setScanCounts]   = useState<Map<string, number>>(new Map())
  const [scanLog, setScanLog]         = useState<ScanLogEntry[]>([])

  // ── UI State ──────────────────────────────
  const [showManualModal, setShowManualModal]     = useState(false)
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [dnPanelOpen, setDnPanelOpen]             = useState(true)

  // Manual form
  const [manualPN, setManualPN]       = useState('')
  const [manualQty, setManualQty]     = useState(1)
  const [manualNote, setManualNote]   = useState('')
  const [manualSaving, setManualSaving] = useState(false)

  // Completion form
  const [completeNote, setCompleteNote] = useState('')
  const [completing, setCompleting]     = useState(false)

  // ── Derived: scanCounts as array ──────────
  const scanItems = useMemo<ScanCount[]>(() => {
    if (!dnData) return []
    return dnData.items.map(item => {
      const scanned = scanCounts.get(item.partNumber) ?? 0
      const status: ScanCount['status'] =
        scanned === 0 ? 'pending'
        : scanned < item.qtyDN ? 'partial'
        : scanned === item.qtyDN ? 'fulfilled'
        : 'excess'
      const last = scanLog.filter(l => l.partNumber === item.partNumber).at(-1)
      return {
        partNumber: item.partNumber,
        required: item.qtyDN,
        scanned,
        status,
        lastMethod: last?.method ?? null,
        lastConfidence: last?.confidence ?? null,
      }
    })
  }, [dnData, scanCounts, scanLog])

  const allFulfilled = scanItems.length > 0 && scanItems.every(i => i.status === 'fulfilled')
  const fulfilledCount = scanItems.filter(i => i.status === 'fulfilled').length
  const progressPct = scanItems.length
    ? Math.round((fulfilledCount / scanItems.length) * 100)
    : 0

  const currentMatchInDN = useMemo(() => {
    if (!currentDetection?.className || !dnData) return null
    return dnData.items.find(i => i.partNumber === currentDetection.className) ?? null
  }, [currentDetection, dnData])

  // ─────────────────────────────────────────
  // Load DN data
  // ─────────────────────────────────────────

  useEffect(() => {
    async function load() {
      try {
        const data = USE_MOCK ? getMockDN(dnNumber) : await fetchDN(dnNumber)
        setDnData(data)
        const initial = new Map<string, number>()
        data.items.forEach(i => initial.set(i.partNumber, 0))
        setScanCounts(initial)
      } catch (err: unknown) {
        setDataError(err instanceof Error ? err.message : 'Gagal memuat data.')
      } finally {
        setDataLoading(false)
      }
    }
    load()
  }, [dnNumber])

  // ─────────────────────────────────────────
  // Camera setup
  // ─────────────────────────────────────────

  useEffect(() => {
    let stream: MediaStream | null = null

    async function init() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 }, height: { ideal: 720 },
            facingMode: 'environment',
          }
        })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.onloadedmetadata = () => setCameraReady(true)
        }
      } catch {
        setCameraError('Tidak dapat mengakses kamera. Pastikan izin kamera diberikan.')
      }
    }
    init()

    return () => {
      stream?.getTracks().forEach(t => t.stop())
      setCameraReady(false)
    }
  }, [])

  // Keep isDetectingRef in sync
  useEffect(() => { isDetectingRef.current = isDetecting }, [isDetecting])

  // ─────────────────────────────────────────
  // Bounding box overlay
  // ─────────────────────────────────────────

  const drawOverlay = useCallback((det: DetectionResult | null) => {
    const canvas = overlayRef.current
    const video  = videoRef.current
    if (!canvas || !video) return

    canvas.width  = video.offsetWidth
    canvas.height = video.offsetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!det?.detected || !det.box) return

    const [x1n, y1n, x2n, y2n] = det.box
    const x = x1n * canvas.width
    const y = y1n * canvas.height
    const w = (x2n - x1n) * canvas.width
    const h = (y2n - y1n) * canvas.height

    const isMatch = det.confidence >= AUTO_CONF && !!currentMatchInDN
    const color = isMatch ? '#10b981' : det.confidence >= AUTO_CONF ? '#f59e0b' : '#64748b'

    // Box
    ctx.strokeStyle = color
    ctx.lineWidth   = 3
    ctx.shadowColor = color
    ctx.shadowBlur  = 8
    ctx.strokeRect(x, y, w, h)

    // Corner accents
    const cs = 18
    ctx.lineWidth = 4
    ctx.shadowBlur = 0
    ;[[x, y, 1, 1], [x+w, y, -1, 1], [x, y+h, 1, -1], [x+w, y+h, -1, -1]].forEach(
      ([cx, cy, dx, dy]) => {
        ctx.beginPath()
        ctx.moveTo(cx as number, (cy as number) + (dy as number) * cs)
        ctx.lineTo(cx as number, cy as number)
        ctx.lineTo((cx as number) + (dx as number) * cs, cy as number)
        ctx.stroke()
      }
    )

    // Label
    const label = `${det.className}  ${(det.confidence * 100).toFixed(1)}%`
    ctx.font = 'bold 13px monospace'
    const tw   = ctx.measureText(label).width
    ctx.fillStyle = color
    ctx.fillRect(x, y - 26, tw + 16, 26)
    ctx.fillStyle = '#fff'
    ctx.font = '600 13px monospace'
    ctx.fillText(label, x + 8, y - 9)
  }, [currentMatchInDN])

  // ─────────────────────────────────────────
  // Count helper
  // ─────────────────────────────────────────

  const addCount = useCallback(async (
    pn: string,
    qty: number,
    method: 'auto' | 'manual',
    confidence: number | null,
    note?: string
  ) => {
    setScanCounts(prev => {
      const next = new Map(prev)
      next.set(pn, (next.get(pn) ?? 0) + qty)
      return next
    })

    const entry: ScanLogEntry = {
      id: `${pn}-${Date.now()}`,
      partNumber: pn,
      method,
      confidence,
      timestamp: new Date(),
      note,
    }
    setScanLog(prev => [entry, ...prev])

    // Fire-and-forget to backend
    try {
      await recordScan(dnNumber, { partNumber: pn, method, confidence, note })
    } catch { /* non-fatal */ }
  }, [dnNumber])

  // ─────────────────────────────────────────
  // Detection loop
  // ─────────────────────────────────────────

  const runDetection = useCallback(async () => {
    if (!isDetectingRef.current) return
    const video   = videoRef.current
    const capture = captureRef.current
    if (!video || !capture || video.readyState < 2) return

    capture.width  = video.videoWidth
    capture.height = video.videoHeight
    const ctx = capture.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    const base64 = capture.toDataURL('image/jpeg', 0.75).split(',')[1]

    try {
      const det = await detectFrame(base64)
      setCurrentDetection(det)
      drawOverlay(det)

      if (!det.detected || !det.className) {
        setDetectStatus('idle')
        return
      }

      const inDN = dnData?.items.some(i => i.partNumber === det.className)
      if (det.confidence >= AUTO_CONF) {
        setDetectStatus(inDN ? 'match' : 'nomatch')
      } else {
        setDetectStatus('ok')
      }

      if (det.confidence >= AUTO_CONF && inDN) {
        const pn  = det.className
        const now = Date.now()
        const last = lastDetectedRef.current.get(pn) ?? 0
        if (now - last > COOLDOWN_MS) {
          lastDetectedRef.current.set(pn, now)
          await addCount(pn, 1, 'auto', det.confidence)
        }
      }
    } catch {
      // Inference server down or network error — degrade silently
    }
  }, [dnData, drawOverlay, addCount])

  useEffect(() => {
    const id = setInterval(runDetection, DETECT_INTERVAL)
    return () => clearInterval(id)
  }, [runDetection])

  // Auto-show completion modal
  useEffect(() => {
    if (allFulfilled && !showCompleteModal) {
      setTimeout(() => {
        setIsDetecting(false)
        setShowCompleteModal(true)
      }, 500)
    }
  }, [allFulfilled]) // eslint-disable-line

  // ─────────────────────────────────────────
  // Manual submit
  // ─────────────────────────────────────────

  const handleManualSubmit = async () => {
    if (!manualPN || manualQty < 1) return
    setManualSaving(true)
    await addCount(manualPN, manualQty, 'manual', null, manualNote || undefined)
    setManualSaving(false)
    setShowManualModal(false)
    setManualPN('')
    setManualQty(1)
    setManualNote('')
  }

  // ─────────────────────────────────────────
  // Complete DN
  // ─────────────────────────────────────────

  const handleComplete = async (status: 'fulfilled' | 'discrepancy') => {
    setCompleting(true)
    try {
      await completeDN({
        dnNumber,
        status,
        note: completeNote || undefined,
        items: scanItems.map(i => ({
          partNumber: i.partNumber,
          qtyRequired: i.required,
          qtyScanned: i.scanned,
        })),
      })
      router.push('/')
    } catch {
      setCompleting(false)
    }
  }

  // ─────────────────────────────────────────
  // Loading / error states
  // ─────────────────────────────────────────

  if (dataLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-sky-400 animate-spin mx-auto" />
          <p className="text-slate-400 text-sm">Memuat data DN {dnNumber}…</p>
        </div>
      </div>
    )
  }

  if (dataError) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-red-900 rounded-2xl p-8 max-w-sm text-center space-y-4">
          <XCircle className="w-10 h-10 text-red-400 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-100">Gagal Memuat DN</h2>
          <p className="text-slate-400 text-sm">{dataError}</p>
          <Link href="/">
            <Button variant="outline" className="border-slate-700 text-slate-300">
              ← Kembali ke Scanner
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col text-slate-100">

      {/* ── TOP BAR ──────────────────────────── */}
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center
                         px-4 gap-3 shrink-0 z-10">
        <Link href="/" className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200
                                   transition-colors text-sm font-medium">
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Kembali</span>
        </Link>

        <span className="w-px h-5 bg-slate-700" />

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-slate-500 shrink-0">DN</span>
          <span className="font-mono font-bold text-sky-400 text-sm tracking-wider truncate">
            {dnNumber}
          </span>
        </div>

        {dnData && (
          <span className="text-xs text-slate-500 truncate hidden md:block">
            {dnData.supplier} · {dnData.packingSlip}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Detection toggle */}
          <button
            onClick={() => setIsDetecting(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                        border transition-colors
                        ${isDetecting
                          ? 'bg-emerald-950 border-emerald-700 text-emerald-400'
                          : 'bg-slate-800 border-slate-700 text-slate-400'
                        }`}
          >
            {isDetecting
              ? <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Aktif</>
              : <><Pause className="w-3 h-3" />Dijeda</>
            }
          </button>

          {/* Progress badge */}
          <span className="text-xs text-slate-500">
            {fulfilledCount}/{scanItems.length} PN
          </span>
        </div>
      </header>

      {/* ── MAIN CONTENT ─────────────────────── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

        {/* ────────── LEFT: Camera ────────── */}
        <div className="flex-1 flex flex-col min-h-0 bg-black">

          {/* Camera viewport */}
          <div className="relative flex-1 bg-black min-h-[260px]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {/* Bounding box overlay */}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {/* Hidden capture canvas */}
            <canvas ref={captureRef} className="hidden" />

            {/* Camera not ready state */}
            {!cameraReady && !cameraError && (
              <div className="absolute inset-0 flex items-center justify-center
                              bg-slate-950 gap-3">
                <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                <span className="text-slate-400 text-sm">Menghubungkan kamera…</span>
              </div>
            )}

            {cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center
                              bg-slate-950 gap-3">
                <CameraOff className="w-10 h-10 text-slate-600" />
                <p className="text-slate-400 text-sm text-center px-8">{cameraError}</p>
              </div>
            )}

            {/* Paused overlay */}
            {!isDetecting && cameraReady && (
              <div className="absolute inset-0 bg-slate-950/70 flex items-center justify-center">
                <div className="flex items-center gap-2 px-4 py-2 rounded-full
                                bg-slate-800 border border-slate-700 text-slate-300 text-sm">
                  <Pause className="w-4 h-4" />
                  Deteksi dijeda
                </div>
              </div>
            )}

            {/* Scanning corner guide */}
            {isDetecting && cameraReady && (
              <div className="absolute inset-8 pointer-events-none">
                {[
                  'top-0 left-0 border-t-2 border-l-2',
                  'top-0 right-0 border-t-2 border-r-2',
                  'bottom-0 left-0 border-b-2 border-l-2',
                  'bottom-0 right-0 border-b-2 border-r-2',
                ].map((cls, i) => (
                  <div key={i} className={`absolute w-6 h-6 border-sky-500/40 ${cls}`} />
                ))}
              </div>
            )}
          </div>

          {/* Camera status bar */}
          <div className="h-10 bg-slate-900 border-t border-slate-800 flex items-center px-4
                          gap-3 shrink-0">
            {detectStatus === 'idle' && (
              <span className="text-slate-500 text-xs flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                Menunggu deteksi…
              </span>
            )}
            {detectStatus === 'ok' && currentDetection?.className && (
              <span className="text-amber-400 text-xs flex items-center gap-1.5 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                {currentDetection.className} — {(currentDetection.confidence * 100).toFixed(1)}%
                (min {AUTO_CONF * 100}%)
              </span>
            )}
            {detectStatus === 'match' && currentDetection?.className && (
              <span className="text-emerald-400 text-xs flex items-center gap-1.5 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {currentDetection.className} — {(currentDetection.confidence * 100).toFixed(1)}% ✓
              </span>
            )}
            {detectStatus === 'nomatch' && currentDetection?.className && (
              <span className="text-red-400 text-xs flex items-center gap-1.5 font-mono">
                <AlertTriangle className="w-3.5 h-3.5" />
                {currentDetection.className} — tidak ada dalam DN ini
              </span>
            )}
            <span className="ml-auto text-slate-600 text-xs">
              {isDetecting ? '● Aktif' : '⏸ Dijeda'}
            </span>
          </div>
        </div>

        {/* ────────── RIGHT: Info Panel ─────── */}
        <div className="w-full md:w-80 lg:w-96 bg-slate-900 border-l border-slate-800
                        flex flex-col overflow-y-auto shrink-0">

          {/* ── Detection live card ─────────── */}
          <div className="p-4 border-b border-slate-800 space-y-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              Deteksi Terkini
            </p>
            {currentDetection?.detected && currentDetection.className ? (
              <>
                <p className="font-mono text-sm text-sky-300 break-all leading-snug">
                  {currentDetection.className}
                </p>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Kepercayaan</span>
                    <span className={
                      currentDetection.confidence >= AUTO_CONF
                        ? 'text-emerald-400' : 'text-amber-400'
                    }>
                      {(currentDetection.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300
                        ${currentDetection.confidence >= AUTO_CONF
                          ? 'bg-emerald-500' : 'bg-amber-500'}`}
                      style={{ width: `${currentDetection.confidence * 100}%` }}
                    />
                  </div>
                </div>
                {currentMatchInDN ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Ada dalam DN ini
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-red-400">
                    <XCircle className="w-3.5 h-3.5" />
                    Tidak ada dalam DN ini
                  </div>
                )}
              </>
            ) : (
              <p className="text-slate-600 text-xs italic">
                Arahkan kamera ke battery cover…
              </p>
            )}
          </div>

          {/* ── DN Progress ──────────────────── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <button
              onClick={() => setDnPanelOpen(v => !v)}
              className="flex items-center justify-between px-4 py-3 border-b
                         border-slate-800 hover:bg-slate-800/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Progres DN
                </p>
                <span className="text-xs text-slate-500">
                  {fulfilledCount}/{scanItems.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-20 h-1 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-sky-500 rounded-full transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                {dnPanelOpen
                  ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                  : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
              </div>
            </button>

            {dnPanelOpen && (
              <ScrollArea className="flex-1 min-h-0">
                <div className="divide-y divide-slate-800/60">
                  {scanItems.map(item => (
                    <div key={item.partNumber}
                         className="px-4 py-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-mono text-xs text-slate-300 break-all leading-snug flex-1">
                          {item.partNumber}
                        </p>
                        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium
                                         ${statusColor(item.status)}`}>
                          {statusLabel(item.status)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500
                              ${item.status === 'fulfilled' ? 'bg-emerald-500'
                                : item.status === 'excess' ? 'bg-red-500'
                                : 'bg-sky-500'}`}
                            style={{
                              width: `${Math.min(100, (item.scanned / item.required) * 100)}%`
                            }}
                          />
                        </div>
                        <span className="text-xs text-slate-400 shrink-0">
                          {item.scanned}/{item.required}
                        </span>
                      </div>
                      {item.lastMethod && (
                        <p className="text-xs text-slate-600">
                          via {item.lastMethod === 'auto' ? 'kamera' : 'manual'}
                          {item.lastConfidence
                            ? ` · ${(item.lastConfidence * 100).toFixed(0)}%` : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>

          {/* ── Actions ──────────────────────── */}
          <div className="p-4 border-t border-slate-800 space-y-2 shrink-0">
            <Button
              onClick={() => setShowManualModal(true)}
              variant="outline"
              className="w-full border-slate-700 bg-slate-800 text-slate-200
                         hover:bg-slate-700 text-sm"
            >
              <PenLine className="w-4 h-4 mr-2" />
              Input Manual
            </Button>
            <Button
              onClick={() => { setIsDetecting(false); setShowCompleteModal(true) }}
              variant="outline"
              className="w-full border-amber-800 bg-amber-950/40 text-amber-300
                         hover:bg-amber-900/50 text-sm"
            >
              <CheckCheck className="w-4 h-4 mr-2" />
              Selesai / Submit
            </Button>
            <Button
              onClick={() => setIsDetecting(v => !v)}
              variant="ghost"
              className="w-full text-slate-400 hover:text-slate-200 text-sm"
            >
              {isDetecting
                ? <><Pause className="w-4 h-4 mr-2" />Jeda Deteksi</>
                : <><Play className="w-4 h-4 mr-2" />Lanjut Deteksi</>}
            </Button>
          </div>

          {/* ── Info footer ──────────────────── */}
          <div className="px-4 pb-4">
            <div className="rounded-lg bg-slate-800/50 border border-slate-700/50 p-3 space-y-1">
              <p className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Info className="w-3 h-3" />
                Panduan
              </p>
              <ul className="text-xs text-slate-500 space-y-0.5">
                <li>• Arahkan kamera ke battery cover</li>
                <li>• Deteksi otomatis saat kepercayaan ≥ {AUTO_CONF * 100}%</li>
                <li>• Tahan steady 2–3 detik per item</li>
                <li>• Gunakan Input Manual jika kamera gagal</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════
          MODAL: Manual Input
      ═══════════════════════════════════════ */}
      <Dialog open={showManualModal} onOpenChange={setShowManualModal}>
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Input Manual Battery Cover</DialogTitle>
            <DialogDescription className="text-slate-400">
              Gunakan ini jika kamera tidak dapat mendeteksi battery cover secara otomatis.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-slate-300">Part Number</Label>
              <Select value={manualPN} onValueChange={(value) => setManualPN(value || '')}>
                <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-100">
                  <SelectValue placeholder="Pilih Part Number dari DN…" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {dnData?.items.map(item => (
                    <SelectItem
                      key={item.id}
                      value={item.partNumber}
                      className="text-slate-200 font-mono text-xs focus:bg-slate-700"
                    >
                      {shortPN(item.partNumber)}
                      <span className="text-slate-500 ml-2">
                        ({scanCounts.get(item.partNumber) ?? 0}/{item.qtyDN})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">Jumlah</Label>
              <Input
                type="number"
                min={1}
                max={999}
                value={manualQty}
                onChange={e => setManualQty(Math.max(1, parseInt(e.target.value) || 1))}
                className="bg-slate-800 border-slate-700 text-slate-100"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">
                Catatan <span className="text-slate-500">(opsional)</span>
              </Label>
              <Textarea
                value={manualNote}
                onChange={e => setManualNote(e.target.value)}
                placeholder="Alasan input manual, kondisi fisik, dll…"
                rows={3}
                className="bg-slate-800 border-slate-700 text-slate-100 resize-none"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowManualModal(false)}
              className="text-slate-400 hover:text-slate-200"
            >
              Batal
            </Button>
            <Button
              onClick={handleManualSubmit}
              disabled={!manualPN || manualSaving}
              className="bg-sky-600 hover:bg-sky-700"
            >
              {manualSaving ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Menyimpan…</>
              ) : (
                'Simpan'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══════════════════════════════════════
          MODAL: Completion
      ═══════════════════════════════════════ */}
      <Dialog
        open={showCompleteModal}
        onOpenChange={v => { if (!completing) setShowCompleteModal(v) }}
      >
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-100
                                   sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              {allFulfilled
                ? <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                : <AlertTriangle className="w-7 h-7 text-amber-400 shrink-0" />}
              <DialogTitle className="text-lg">
                {allFulfilled
                  ? 'Semua Item Terpenuhi!'
                  : 'Ada Item Belum Terpenuhi'}
              </DialogTitle>
            </div>
            <DialogDescription className="text-slate-400">
              {allFulfilled
                ? 'Seluruh part number dalam DN ini telah terverifikasi. Klik submit untuk menyelesaikan.'
                : 'Beberapa item belum mencapai jumlah yang diperlukan. Anda tetap dapat submit dengan ketidaksesuaian.'}
            </DialogDescription>
          </DialogHeader>

          {/* Summary table */}
          <div className="rounded-lg overflow-hidden border border-slate-700 my-2">
            <table className="w-full text-xs">
              <thead className="bg-slate-800">
                <tr>
                  <th className="text-left px-3 py-2 text-slate-400">Part Number</th>
                  <th className="text-right px-3 py-2 text-slate-400">Perlu</th>
                  <th className="text-right px-3 py-2 text-slate-400">Scan</th>
                  <th className="text-right px-3 py-2 text-slate-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {scanItems.map(item => (
                  <tr key={item.partNumber}
                      className={item.status !== 'fulfilled' ? 'bg-amber-950/20' : ''}>
                    <td className="px-3 py-2 font-mono text-slate-300 break-all">
                      {shortPN(item.partNumber)}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-400">{item.required}</td>
                    <td className={`px-3 py-2 text-right font-semibold
                                   ${item.status === 'fulfilled' ? 'text-emerald-400'
                                     : item.status === 'excess' ? 'text-red-400'
                                     : 'text-amber-400'}`}>
                      {item.scanned}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${statusColor(item.status)}`}>
                        {statusLabel(item.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!allFulfilled && (
            <div className="space-y-2">
              <Label className="text-slate-300">
                Alasan Ketidaksesuaian <span className="text-slate-500">(opsional)</span>
              </Label>
              <Textarea
                value={completeNote}
                onChange={e => setCompleteNote(e.target.value)}
                placeholder="Jelaskan alasan ketidaksesuaian…"
                rows={2}
                className="bg-slate-800 border-slate-700 text-slate-100 resize-none"
              />
            </div>
          )}

          <DialogFooter className="gap-2 flex-col sm:flex-row">
            {!completing && (
              <Button
                variant="ghost"
                onClick={() => { setShowCompleteModal(false); setIsDetecting(true) }}
                className="text-slate-400 hover:text-slate-200"
              >
                Lanjut Scan
              </Button>
            )}
            {!allFulfilled && (
              <Button
                onClick={() => handleComplete('discrepancy')}
                disabled={completing}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {completing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Submit dengan Ketidaksesuaian
              </Button>
            )}
            <Button
              onClick={() => handleComplete('fulfilled')}
              disabled={completing}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {completing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {allFulfilled ? 'Submit & Selesai' : 'Paksa Submit Selesai'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}