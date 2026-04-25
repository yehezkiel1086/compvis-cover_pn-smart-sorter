'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchDN, getMockDN } from '@/lib/api'
import { AlertCircle, Barcode, ChevronRight, Clock, Loader2, Package, Scan } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true'
const MAX_RECENT = 5

interface RecentEntry {
  dn: string
  supplier: string
  date: string
  itemCount: number
}

export default function HomePage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [dnInput, setDnInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentEntry[]>([])

  // Auto-focus input on mount (for barcode scanner)
  useEffect(() => {
    inputRef.current?.focus()
    const saved = localStorage.getItem('smart-sorter-recent')
    if (saved) setRecent(JSON.parse(saved))
  }, [])

  const saveRecent = (entry: RecentEntry) => {
    const updated = [entry, ...recent.filter(r => r.dn !== entry.dn)].slice(0, MAX_RECENT)
    setRecent(updated)
    localStorage.setItem('smart-sorter-recent', JSON.stringify(updated))
  }

  const handleSubmit = async (dn: string) => {
    const value = dn.trim().toUpperCase()
    if (!value) return

    setError(null)
    setLoading(true)

    try {
      const data = USE_MOCK ? getMockDN(value) : await fetchDN(value)
      saveRecent({
        dn: data.dnNumber,
        supplier: data.supplier,
        date: data.date,
        itemCount: data.items.length,
      })
      router.push(`/scan/${encodeURIComponent(data.dnNumber)}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan.')
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit(dnInput)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-blue-700 flex items-center justify-center">
            <Scan className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-slate-800">Smart Sorter</span>
          <span className="text-slate-300">|</span>
          <span className="text-sm text-slate-500">PT. Century Batteries Indonesia</span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg space-y-6">

          {/* Title */}
          <div className="text-center space-y-1">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-700 mb-3 shadow-lg shadow-blue-200">
              <Package className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900">Scan DN Supplier</h1>
            <p className="text-slate-500 text-sm">
              Scan barcode atau masukkan nomor Delivery Note untuk memulai verifikasi
            </p>
          </div>

          {/* Scanner Card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
            <form onSubmit={onFormSubmit} className="space-y-3">
              <label className="text-sm font-medium text-slate-700 block">
                Nomor DN
              </label>
              <div className="relative">
                <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  ref={inputRef}
                  type="text"
                  placeholder="Scan barcode atau ketik nomor DN…"
                  value={dnInput}
                  onChange={e => {
                    setDnInput(e.target.value)
                    setError(null)
                  }}
                  className="pl-10 h-12 text-base font-mono tracking-wider uppercase
                             border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                  disabled={loading}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50
                               border border-red-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full h-12 text-base font-semibold bg-blue-700 hover:bg-blue-800"
                disabled={loading || !dnInput.trim()}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Memuat data DN…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Scan className="w-4 h-4" />
                    Mulai Verifikasi
                  </span>
                )}
              </Button>
            </form>

            {/* Status indicator */}
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Siap menerima scan
              </span>
              <span>Arahkan scanner ke barcode DN</span>
            </div>
          </div>

          {/* Recent history */}
          {recent.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <Clock className="w-4 h-4" />
                Riwayat Terakhir
              </div>
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {recent.map(entry => (
                  <button
                    key={entry.dn}
                    onClick={() => handleSubmit(entry.dn)}
                    disabled={loading}
                    className="w-full flex items-center justify-between px-4 py-3
                               hover:bg-slate-50 transition-colors text-left group"
                  >
                    <div className="space-y-0.5">
                      <div className="font-mono font-semibold text-sm text-slate-800 tracking-wide">
                        {entry.dn}
                      </div>
                      <div className="text-xs text-slate-400">
                        {entry.supplier} · {entry.itemCount} item ·{' '}
                        {new Date(entry.date).toLocaleDateString('id-ID')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {entry.itemCount} PN
                      </Badge>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Footer note */}
          <p className="text-center text-xs text-slate-400">
            Letakkan barcode di area scanner atau ketik nomor DN secara manual
          </p>
        </div>
      </main>

      <footer className="text-center text-xs text-slate-400 py-4 border-t bg-white/50">
        © {new Date().getFullYear()} PT Century Batteries Indonesia. All Rights Reserved.
      </footer>
    </div>
  )
}