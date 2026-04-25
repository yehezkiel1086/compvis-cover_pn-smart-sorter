'use client'

/**
 * /scan/[dn]  — Battery Cover Detection Page
 *
 * Shows the live camera feed with YOLO bounding-box overlay and a right-hand
 * panel listing every part number in the DN.  When a cover is detected with
 * confidence ≥ AUTO_CONF the page redirects to /receipt automatically.
 *
 * Key implementation notes
 * ────────────────────────
 * • React 18 Strict Mode (active in Next.js dev) double-invokes effects.
 *   We use `mountedRef` (set at component level) and local `let active`
 *   variables inside async operations instead of module-level flags so the
 *   detection loop survives the first cleanup→remount cycle.
 *
 * • The camera stream is kept in a ref so cleanup can stop tracks reliably
 *   across the double-invoke.
 *
 * • Canvas sizing: a ResizeObserver + an immediate getBoundingClientRect()
 *   call keep the overlay canvas in sync with the wrapper element.
 *
 * • Coordinate mapping: YOLO returns box coords normalised to the original
 *   captured frame.  `object-contain` on the <video> letterboxes the frame.
 *   getContainRect() maps normalised coords → canvas pixel coords correctly.
 *
 * • ctx.roundRect is Chrome 99+ only; we use ctx.fillRect everywhere.
 */

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { detectFrame, fetchDNItems } from '@/lib/api'
import { findBestMatch, scoreAllCandidates } from '@/lib/normalize'
import type { DetectionResult, ExternalDNRow } from '@/lib/types'
import {
  AlertTriangle,
  ArrowLeft,
  CameraOff,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  ScanLine,
  WifiOff,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Minimum YOLO confidence to AUTO-ACCEPT and redirect to receipt. */
const AUTO_CONF = 0.85
/** How often to call the inference server (ms). */
const DETECT_INTERVAL = 600
/** How long to show the success overlay before redirecting (ms). */
const REDIRECT_DELAY = 1200

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface ResolvedDetection {
  raw:        DetectionResult  // raw response from YOLO server
  realPN:     string           // matched DB part number (or raw className)
  matchScore: number           // similarity score from normalize.ts
  normalized: string           // intermediate label after W→Z, _→-
  inDN:       boolean          // whether realPN is in this DN's item list
}

// ─────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────

function confColor(c: number) {
  if (c >= AUTO_CONF) return 'text-emerald-400'
  if (c >= 0.60)      return 'text-amber-400'
  return 'text-slate-500'
}

function confBgClass(c: number) {
  if (c >= AUTO_CONF) return 'bg-emerald-500'
  if (c >= 0.60)      return 'bg-amber-500'
  return 'bg-slate-600'
}

/**
 * Map normalised YOLO box coords → canvas pixel rect, accounting for the
 * letterboxing produced by CSS `object-contain` on the <video> element.
 *
 * @param videoW  video.videoWidth  (actual captured frame width)
 * @param videoH  video.videoHeight
 * @param canvasW canvas.width      (overlay canvas pixel buffer width)
 * @param canvasH canvas.height
 */
function getContainRect(
  videoW: number, videoH: number,
  canvasW: number, canvasH: number,
): { x: number; y: number; w: number; h: number } | null {
  // All four must be positive; otherwise we can't draw anything meaningful.
  if (videoW <= 0 || videoH <= 0 || canvasW <= 0 || canvasH <= 0) return null
  const scale = Math.min(canvasW / videoW, canvasH / videoH)
  const w = videoW * scale
  const h = videoH * scale
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h }
}

// ═════════════════════════════════════════════
// Page component
// ═════════════════════════════════════════════

export default function ScanPage() {
  const { dn: rawDn } = useParams<{ dn: string }>()
  const dnNumber = decodeURIComponent(rawDn)
  const router   = useRouter()

  // ── Component-lifetime mounted flag ──────────────────────────────────────
  // Used to guard async operations from updating state after unmount.
  // This ref is set to false in a cleanup-only effect so it stays true
  // for the full lifetime of the mounted component (including StrictMode
  // double-invoke, where it stays true across the remount).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── DN items ──────────────────────────────────────────────────────────────
  const [dnItems, setDnItems]     = useState<ExternalDNRow[]>([])
  const [dnLoading, setDnLoading] = useState(true)
  const [dnError, setDnError]     = useState<string | null>(null)
  // Kept in a ref so the detection callback always sees the latest list
  // without re-creating itself when items load.
  const dnItemsRef = useRef<ExternalDNRow[]>([])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const data = await fetchDNItems(dnNumber)
        if (!active) return
        const rows = (data.results ?? []).filter(r =>
          r.NODN.toUpperCase().startsWith(dnNumber.trim().toUpperCase())
        )
        dnItemsRef.current = rows
        setDnItems(rows)
      } catch (err: unknown) {
        if (!active) return
        setDnError(err instanceof Error ? err.message : 'Gagal memuat data DN.')
      } finally {
        if (active) setDnLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [dnNumber])

  // ── Camera refs ───────────────────────────────────────────────────────────
  const videoRef   = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const captureRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const streamRef  = useRef<MediaStream | null>(null)

  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  // ── Camera setup ─────────────────────────────────────────────────────────
  useEffect(() => {
    // Local flag for THIS effect invocation (survives StrictMode double-invoke).
    let active = true

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'environment',
          },
        })

        // If this effect was cleaned up while awaiting (StrictMode or fast
        // unmount), stop the stream we just acquired and bail.
        if (!active) {
          stream.getTracks().forEach(t => t.stop())
          return
        }

        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          video.onloadedmetadata = () => {
            if (!active) return
            video.play().catch(() => {/* autoplay blocked — user interaction needed */})
            setCameraReady(true)
          }
        }
      } catch (err) {
        if (!active) return
        const msg = err instanceof Error ? err.message : String(err)
        setCameraError(`Tidak dapat mengakses kamera: ${msg}`)
      }
    }

    startCamera()

    return () => {
      active = false
      // Stop any running tracks and clear the video element.
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      setCameraReady(false)
    }
  }, [])

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  // The overlay canvas pixel buffer must match the wrapper element's
  // rendered size exactly.  We do an immediate read on mount (before the
  // first ResizeObserver callback) so the very first detection frame has
  // a correctly-sized buffer to draw into.
  useEffect(() => {
    const wrapper = wrapperRef.current
    const canvas  = overlayRef.current
    if (!wrapper || !canvas) return

    const setSize = (w: number, h: number) => {
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width  = w
        canvas.height = h
      }
    }

    // Immediate measurement
    const rect = wrapper.getBoundingClientRect()
    setSize(rect.width, rect.height)

    // Keep in sync as the window resizes
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setSize(entry.contentRect.width, entry.contentRect.height)
    })
    ro.observe(wrapper)
    return () => ro.disconnect()
  }, [])

  // ── Detection state ───────────────────────────────────────────────────────
  const [resolved, setResolved]       = useState<ResolvedDetection | null>(null)
  const [accepted, setAccepted]       = useState<ResolvedDetection | null>(null)
  const acceptedRef                   = useRef<ResolvedDetection | null>(null)
  const [inferError, setInferError]   = useState<string | null>(null)
  const [frameCount, setFrameCount]   = useState(0)   // frames successfully processed

  // Keep acceptedRef in sync so the detection callback can read it without
  // being re-created every time `accepted` changes.
  useEffect(() => { acceptedRef.current = accepted }, [accepted])

  // ── Bounding-box overlay ──────────────────────────────────────────────────
  const drawOverlay = useCallback((
    det: DetectionResult | null,
    res: ResolvedDetection | null,
  ) => {
    const canvas = overlayRef.current
    const video  = videoRef.current
    if (!canvas || !video) return

    const cw = canvas.width
    const ch = canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx || cw === 0 || ch === 0) return

    ctx.clearRect(0, 0, cw, ch)

    if (!det?.detected || !det.box) return

    // Map normalised YOLO coords → canvas pixels using contain-rect math.
    const cr = getContainRect(video.videoWidth, video.videoHeight, cw, ch)
    if (!cr) return

    const [x1n, y1n, x2n, y2n] = det.box
    const bx = cr.x + x1n * cr.w
    const by = cr.y + y1n * cr.h
    const bw = (x2n - x1n) * cr.w
    const bh = (y2n - y1n) * cr.h
    if (bw <= 0 || bh <= 0) return

    const ok    = det.confidence >= AUTO_CONF && !!res?.inDN
    const color = ok ? '#10b981' : det.confidence >= 0.6 ? '#f59e0b' : '#94a3b8'

    // ── Box ────────────────────────────────────────────────────────────────
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur  = 12
    ctx.strokeStyle = color
    ctx.lineWidth   = 3
    ctx.strokeRect(bx, by, bw, bh)
    ctx.restore()

    // ── Corner accents ─────────────────────────────────────────────────────
    const cs = Math.min(20, bw * 0.25, bh * 0.25)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth   = 4
    ctx.lineCap     = 'round'
    for (const [cx, cy, dx, dy] of [
      [bx,      by,       1,  1],
      [bx + bw, by,      -1,  1],
      [bx,      by + bh,  1, -1],
      [bx + bw, by + bh, -1, -1],
    ] as [number, number, number, number][]) {
      ctx.beginPath()
      ctx.moveTo(cx, cy + dy * cs)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx + dx * cs, cy)
      ctx.stroke()
    }
    ctx.restore()

    // ── Label chip ─────────────────────────────────────────────────────────
    // Always show the real DB PN if matched, otherwise the raw model label.
    const displayPN = res?.realPN ?? det.className ?? '?'
    const chip      = `${displayPN}  ${(det.confidence * 100).toFixed(1)}%`

    ctx.save()
    ctx.font       = 'bold 13px monospace'
    const chipW    = ctx.measureText(chip).width + 16
    const chipH    = 24
    const chipX    = bx
    const chipY    = Math.max(0, by - chipH - 2)  // clamp above canvas edge

    ctx.fillStyle = color
    ctx.fillRect(chipX, chipY, chipW, chipH)       // fillRect: all browsers
    ctx.fillStyle = '#ffffff'
    ctx.fillText(chip, chipX + 8, chipY + chipH - 6)
    ctx.restore()

    // ── "Mapped from model" annotation ────────────────────────────────────
    // Show when the raw model label was remapped to a different DB PN.
    if (res && res.realPN !== det.className) {
      const note  = `model: ${det.className}`
      ctx.save()
      ctx.font    = '10px monospace'
      const noteW = ctx.measureText(note).width + 10
      const noteY = Math.max(0, chipY - 17)
      ctx.fillStyle = color + 'aa'
      ctx.fillRect(chipX, noteY, noteW, 16)
      ctx.fillStyle = '#ffffffcc'
      ctx.fillText(note, chipX + 5, noteY + 12)
      ctx.restore()
    }
  }, [])   // refs are stable — no deps needed

  // ── Detection loop ────────────────────────────────────────────────────────
  const runDetection = useCallback(async () => {
    // Use the ref (not closure-captured state) for the accepted check so
    // this callback doesn't need to be re-created on every acceptance.
    if (!mountedRef.current || acceptedRef.current) return

    const video   = videoRef.current
    const capture = captureRef.current
    if (!video || !capture) return
    // Video must have frame data and real dimensions
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return

    // Capture current frame into the hidden canvas
    capture.width  = video.videoWidth
    capture.height = video.videoHeight
    const ctx2d = capture.getContext('2d')
    if (!ctx2d) return
    ctx2d.drawImage(video, 0, 0)

    const b64 = capture.toDataURL('image/jpeg', 0.82).split(',')[1]
    if (!b64) return

    try {
      const det = await detectFrame(b64)

      if (!mountedRef.current || acceptedRef.current) return

      // ── Clear any previous inference error ──────────────────────────────
      setInferError(null)
      setFrameCount(n => n + 1)

      // ── Resolve model label → real DB PN ────────────────────────────────
      let res: ResolvedDetection | null = null

      if (det.detected && det.className) {
        const candidates = dnItemsRef.current.map(r => r.ITEM)
        const match      = findBestMatch(det.className, candidates)

        // Debug: log all candidate scores to the browser console
        if (process.env.NODE_ENV === 'development' && candidates.length > 0) {
          const scores = scoreAllCandidates(det.className, candidates)
          console.debug('[CV] label:', det.className, '| scores:', scores)
        }

        res = {
          raw:        det,
          realPN:     match?.partNumber ?? det.className,
          matchScore: match?.score      ?? 0,
          normalized: match?.normalized ?? det.className,
          inDN:       !!match,
        }
      }

      setResolved(res)
      drawOverlay(det, res)

      // ── Auto-accept at ≥ AUTO_CONF AND matched to a DN part ─────────────
      if (res?.inDN && det.confidence >= AUTO_CONF) {
        setAccepted(res)
        acceptedRef.current = res
        drawOverlay(det, res)
        setTimeout(() => {
          if (!mountedRef.current) return
          router.push(
            `/receipt?dn=${encodeURIComponent(dnNumber)}&pn=${encodeURIComponent(res!.realPN)}`
          )
        }, REDIRECT_DELAY)
      }

    } catch (err: unknown) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : 'Inference error'
      setInferError(msg)
      // Clear stale boxes
      const canvas = overlayRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
  }, [dnNumber, drawOverlay, router])
  // NOTE: `accepted` is intentionally NOT in the dep array — we use
  // `acceptedRef` inside the callback instead.  This prevents the interval
  // from being torn down and recreated on every successful detection.

  // ── Interval ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (accepted) return   // stop once we have an accepted detection

    // Local active flag — correctly scoped to this effect invocation so
    // StrictMode's double-invoke doesn't cause double-firing.
    let active = true

    const id = setInterval(() => {
      if (!active) return
      runDetection()
    }, DETECT_INTERVAL)

    return () => {
      active = false
      clearInterval(id)
    }
  }, [accepted, runDetection])

  // ── Navigation helper ────────────────────────────────────────────────────
  const goToReceipt = useCallback(() =>
    router.push(`/receipt?dn=${encodeURIComponent(dnNumber)}`),
    [router, dnNumber]
  )

  // ── Derived UI values ─────────────────────────────────────────────────────
  const showMappingHint =
    !!resolved?.inDN && resolved.realPN !== resolved.raw.className

  // ═══════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col text-slate-100">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="h-14 bg-slate-900 border-b border-slate-800
                         flex items-center px-4 gap-3 shrink-0 z-10">
        <Link href="/"
          className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200
                     transition-colors text-sm font-medium">
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Kembali</span>
        </Link>

        <span className="w-px h-5 bg-slate-700" />

        <span className="text-xs text-slate-500 shrink-0">DN</span>
        <span className="font-mono font-bold text-sky-400 text-sm tracking-wider truncate">
          {dnNumber}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {frameCount > 0 && (
            <span className="text-slate-700 text-xs hidden md:inline">
              {frameCount} frame
            </span>
          )}
          <Button size="sm" variant="outline" onClick={goToReceipt}
            className="border-slate-700 text-slate-300 hover:bg-slate-800 text-xs h-8">
            Input Manual
            <ChevronRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">

        {/* ──────── Camera ────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0 bg-black">

          {/* Wrapper — observed by ResizeObserver for canvas sizing */}
          <div ref={wrapperRef} className="relative flex-1 min-h-[260px] bg-black">

            {/*
              object-contain: keeps the full captured frame visible without
              cropping, so YOLO's normalised box coords map cleanly to the
              rendered image area via getContainRect().
            */}
            <video
              ref={videoRef}
              autoPlay playsInline muted
              className="w-full h-full object-contain"
            />

            {/*
              Overlay canvas — must use inline style for width/height so Tailwind
              doesn't fight with the pixel-buffer dimensions set by ResizeObserver.
              z-20 ensures it renders above the corner guides (z-10).
            */}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 pointer-events-none z-20"
              style={{ width: '100%', height: '100%' }}
            />

            {/* Hidden capture canvas — never rendered */}
            <canvas ref={captureRef} className="hidden" />

            {/* Camera loading */}
            {!cameraReady && !cameraError && (
              <div className="absolute inset-0 flex items-center justify-center
                              bg-slate-950 gap-3 z-10">
                <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                <span className="text-slate-400 text-sm">Menghubungkan kamera…</span>
              </div>
            )}

            {/* Camera error */}
            {cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center
                              bg-slate-950 gap-4 p-8 text-center z-10">
                <CameraOff className="w-10 h-10 text-slate-600" />
                <p className="text-slate-400 text-sm max-w-xs">{cameraError}</p>
                <Button onClick={goToReceipt} className="bg-sky-700 hover:bg-sky-600">
                  Lanjut ke Input Receipt
                </Button>
              </div>
            )}

            {/* Inference server error banner */}
            {inferError && !accepted && (
              <div className="absolute top-3 left-3 right-3 z-30 flex items-start gap-2
                              bg-red-950/90 border border-red-700 rounded-lg
                              px-3 py-2.5 text-xs text-red-300">
                <WifiOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="font-semibold">
                    Inference server tidak terhubung.{' '}
                  </span>
                  <span className="text-red-400/80 break-all">{inferError}</span>
                </div>
              </div>
            )}

            {/* Scanning corner guides — below the canvas (z-10) */}
            {cameraReady && !accepted && (
              <div className="absolute inset-10 pointer-events-none z-10">
                {[
                  'top-0 left-0 border-t-2 border-l-2',
                  'top-0 right-0 border-t-2 border-r-2',
                  'bottom-0 left-0 border-b-2 border-l-2',
                  'bottom-0 right-0 border-b-2 border-r-2',
                ].map((cls, i) => (
                  <div key={i}
                    className={`absolute w-8 h-8 border-sky-500/40 ${cls}`} />
                ))}
              </div>
            )}

            {/* Success overlay */}
            {accepted && (
              <div className="absolute inset-0 bg-slate-950/75 flex items-center
                              justify-center p-4 z-30">
                <div className="bg-slate-900 border border-emerald-700 rounded-2xl
                                p-8 text-center space-y-3 max-w-sm w-full shadow-2xl">
                  <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
                  <p className="text-emerald-300 font-semibold text-lg">
                    Cover Terdeteksi!
                  </p>

                  {/* Real DB PN */}
                  <p className="font-mono text-sm text-sky-300 break-all leading-snug">
                    {accepted.realPN}
                  </p>

                  {/* Show raw model label only when it differs */}
                  {accepted.realPN !== accepted.raw.className && (
                    <div className="rounded-lg bg-slate-800 px-3 py-2 text-left space-y-0.5">
                      <p className="text-xs text-slate-500">Label model:</p>
                      <p className="font-mono text-xs text-slate-400 break-all">
                        {accepted.raw.className}
                      </p>
                    </div>
                  )}

                  <p className="text-slate-400 text-sm">
                    Kepercayaan:{' '}
                    <span className="text-emerald-400 font-semibold">
                      {(accepted.raw.confidence * 100).toFixed(1)}%
                    </span>
                    {accepted.matchScore > 0 && accepted.matchScore < 1 && (
                      <span className="text-slate-500 text-xs ml-2">
                        · kecocokan {(accepted.matchScore * 100).toFixed(0)}%
                      </span>
                    )}
                  </p>

                  <p className="text-slate-500 text-xs flex items-center
                                justify-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Menuju Input Receipt…
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="h-11 bg-slate-900 border-t border-slate-800 shrink-0
                          flex items-center justify-between px-4 gap-3">
            <div className="flex items-center gap-2 min-w-0 text-xs">
              {accepted ? (
                <span className="flex items-center gap-1.5 text-emerald-400 font-mono">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{accepted.realPN}</span>
                </span>

              ) : inferError ? (
                <span className="flex items-center gap-1.5 text-red-400">
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  Inference server error — coba Input Manual
                </span>

              ) : resolved?.raw.detected && resolved.raw.className ? (
                <span className={`flex items-center gap-1.5 font-mono
                                  ${confColor(resolved.raw.confidence)}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0
                                    ${confBgClass(resolved.raw.confidence)}`} />
                  <span className="truncate">
                    {resolved.inDN ? resolved.realPN : resolved.raw.className}
                  </span>
                  <span className="shrink-0">
                    — {(resolved.raw.confidence * 100).toFixed(1)}%
                  </span>
                  {!resolved.inDN && (
                    <span className="text-red-400/70 shrink-0 hidden sm:inline">
                      · tidak ada dalam DN
                    </span>
                  )}
                  {resolved.raw.confidence < AUTO_CONF && (
                    <span className="text-slate-600 shrink-0 hidden sm:inline">
                      (butuh {AUTO_CONF * 100}%)
                    </span>
                  )}
                </span>

              ) : (
                <span className="flex items-center gap-1.5 text-slate-500">
                  <ScanLine className="w-3.5 h-3.5 shrink-0" />
                  Arahkan kamera ke battery cover…
                  {frameCount > 0 && (
                    <span className="text-slate-700">
                      · {frameCount} frame diproses
                    </span>
                  )}
                </span>
              )}
            </div>

            {!accepted && (
              <button
                onClick={() => window.location.reload()}
                title="Restart kamera"
                className="text-slate-600 hover:text-slate-300
                           transition-colors shrink-0">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ──────── Part-number list ──────────────────────────────────── */}
        <div className="w-full md:w-72 lg:w-80 bg-slate-900 border-l border-slate-800
                        flex flex-col shrink-0 overflow-hidden">

          {/* Panel header */}
          <div className="px-4 py-3 border-b border-slate-800 shrink-0">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              Part Number dalam DN
            </p>
            {!dnLoading && dnItems.length > 0 && (
              <p className="text-xs text-slate-600 mt-0.5">
                {dnItems.length} item · deteksi cover lalu lanjut ke receipt
              </p>
            )}
          </div>

          {/* Label-mapping hint */}
          {showMappingHint && (
            <div className="mx-3 mt-3 rounded-lg bg-amber-950/50 border border-amber-800/60
                            px-3 py-2 space-y-1 shrink-0">
              <p className="text-xs font-medium text-amber-400">
                Label dipetakan otomatis
              </p>
              <div className="text-xs font-mono space-y-0.5">
                <div className="text-slate-500">
                  Model:{' '}
                  <span className="text-slate-400">{resolved?.raw.className}</span>
                </div>
                <div className="text-slate-500">
                  DB:{' '}
                  <span className="text-sky-400">{resolved?.realPN}</span>
                </div>
              </div>
            </div>
          )}

          {/* List */}
          <ScrollArea className="flex-1 min-h-0">
            {dnLoading ? (
              <div className="flex items-center justify-center gap-2 py-12
                              text-slate-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Memuat data DN…
              </div>
            ) : dnError ? (
              <div className="px-4 py-6 text-center space-y-2">
                <AlertTriangle className="w-6 h-6 text-red-500 mx-auto" />
                <p className="text-slate-400 text-xs">{dnError}</p>
                <Button size="sm" variant="outline" onClick={goToReceipt}
                  className="border-slate-700 text-slate-300 text-xs">
                  Lanjut ke Input Receipt
                </Button>
              </div>
            ) : dnItems.length === 0 ? (
              <p className="text-slate-600 text-xs text-center py-12 px-4">
                Tidak ada part number ditemukan untuk DN ini.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/60 py-1">
                {dnItems.map((row, idx) => {
                  const isAccepted = accepted?.realPN === row.ITEM
                  const isDetected = !accepted
                    && resolved?.inDN
                    && resolved.realPN === row.ITEM

                  return (
                    <div key={`${row.ITEM}_${row.NODN}`}
                      className={`px-4 py-3 transition-colors duration-200
                        ${isAccepted
                          ? 'bg-emerald-950/60 border-l-2 border-emerald-500'
                          : isDetected
                            ? 'bg-sky-950/60 border-l-2 border-sky-400'
                            : 'border-l-2 border-transparent'
                        }`}>

                      <div className="flex items-start gap-2">
                        <span className="text-xs text-slate-600 shrink-0 mt-0.5 w-5">
                          {idx + 1}.
                        </span>

                        <div className="flex-1 min-w-0 space-y-1">
                          <p className={`font-mono text-xs leading-snug break-all
                            ${isAccepted ? 'text-emerald-300'
                            : isDetected ? 'text-sky-300'
                            : 'text-slate-300'}`}>
                            {row.ITEM}
                          </p>
                          <p className="text-xs text-slate-600">
                            DN: <span className="font-mono">{row.NODN}</span>
                          </p>
                        </div>

                        <div className="shrink-0 mt-0.5">
                          {isAccepted ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : isDetected ? (
                            <span className="w-2 h-2 rounded-full bg-sky-400
                                             animate-pulse block mt-1" />
                          ) : (
                            <span className="w-4 h-4 rounded-full border
                                             border-slate-700 block" />
                          )}
                        </div>
                      </div>

                      {/* Live confidence bar for the detected row */}
                      {isDetected && resolved && (
                        <div className="mt-2 ml-7 space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Kepercayaan</span>
                            <span className={confColor(resolved.raw.confidence)}>
                              {(resolved.raw.confidence * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300
                                ${confBgClass(resolved.raw.confidence)}`}
                              style={{ width: `${resolved.raw.confidence * 100}%` }}
                            />
                          </div>
                          {resolved.raw.confidence < AUTO_CONF && (
                            <p className="text-slate-600 text-xs">
                              Butuh ≥ {AUTO_CONF * 100}% untuk konfirmasi otomatis
                            </p>
                          )}
                          {showMappingHint && (
                            <p className="text-slate-600 text-xs">
                              Kecocokan label:{' '}
                              {(resolved.matchScore * 100).toFixed(0)}%
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-slate-800 shrink-0 space-y-2">
            <div className="rounded-lg bg-slate-800/60 border border-slate-700/40
                            p-3 space-y-1.5">
              <p className="text-xs font-medium text-slate-400">Panduan</p>
              <ul className="text-xs text-slate-500 space-y-1">
                <li>• Arahkan kamera ke battery cover</li>
                <li>• Deteksi muncul saat model menemukan cover</li>
                <li>• Otomatis diterima saat kepercayaan ≥ {AUTO_CONF * 100}%</li>
                <li>• Label model dipetakan ke PN database otomatis</li>
                <li>• Gunakan <em>Input Manual</em> jika kamera gagal</li>
              </ul>
            </div>

            {!accepted && (
              <Button onClick={goToReceipt} variant="outline"
                className="w-full border-slate-700 text-slate-400
                           hover:text-slate-200 hover:bg-slate-800 text-xs h-8">
                Lewati & Input Manual
                <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}