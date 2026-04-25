/**
 * lib/normalize.ts
 *
 * Maps a raw YOLO model class label to the closest real DB part number.
 *
 * Known systematic differences
 * ─────────────────────────────
 *  Model label        DB part number
 *  W_CV01_D26RXXX_…   Z-CV02-D26LXXX-…
 *  ↑ W → Z            ↑ _ → -   (separators)
 *                      ↑ per-segment drift (CV01↔CV02, D26RXXX↔D26LXXX)
 *
 * Pipeline
 * ────────
 *  1. normalizeModelLabel()  — W→Z, _→-
 *  2. partNumberSimilarity() — segment-level Dice similarity
 *  3. findBestMatch()        — pick best candidate above threshold
 */

// ─────────────────────────────────────────────
// Step 1 — Canonical substitution
// ─────────────────────────────────────────────

export function normalizeModelLabel(raw: string): string {
  let s = raw.trim()
  // W → Z  (first character only)
  if (/^[Ww]/.test(s)) s = 'Z' + s.slice(1)
  // All underscores → hyphens
  s = s.replace(/_/g, '-')
  return s.toUpperCase()
}

// ─────────────────────────────────────────────
// Step 2 — Segment-level similarity
// ─────────────────────────────────────────────

/** Sørensen–Dice coefficient on character bigrams. Returns [0, 1]. */
function dice(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const bg = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2)
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }

  const mA = bg(a)
  const mB = bg(b)
  let hits = 0
  mA.forEach((n, k) => { hits += Math.min(n, mB.get(k) ?? 0) })
  return (2 * hits) / (a.length - 1 + b.length - 1)
}

/** Score two part-number segments [0, 1]. */
function segScore(a: string, b: string): number {
  if (a === b) return 1.0

  // Shared 3-char prefix gets strong base credit.
  // Handles: CV01↔CV02, D26RXXX↔D26LXXX, NL↔NL, DG00↔DG00, etc.
  const pfxLen = Math.min(3, a.length, b.length)
  if (pfxLen >= 2 && a.slice(0, pfxLen) === b.slice(0, pfxLen)) {
    return 0.65 + 0.35 * dice(a, b)
  }
  return dice(a, b)
}

/**
 * Compute overall similarity between a normalised model label and a DB PN.
 * Splits on '-', scores each segment pair, takes a position-weighted average
 * (earlier segments matter more because they carry the product family).
 */
export function partNumberSimilarity(normalised: string, dbPN: string): number {
  const segsA = normalised.toUpperCase().split('-')
  const segsB = dbPN.toUpperCase().split('-')
  const len   = Math.max(segsA.length, segsB.length)
  if (len === 0) return 1

  let total  = 0
  let weight = 0

  for (let i = 0; i < len; i++) {
    const a = segsA[i] ?? ''
    const b = segsB[i] ?? ''
    // Earlier segments get higher weight (position i=0 → weight len, last → weight 1)
    const w = len - i
    weight += w
    if (!a || !b) {
      total += w * 0.05    // heavy penalty for missing segment
    } else {
      total += w * segScore(a, b)
    }
  }

  return weight > 0 ? total / weight : 0
}

// ─────────────────────────────────────────────
// Step 3 — Match against candidate list
// ─────────────────────────────────────────────

// Lowered from 0.70 → 0.65 to tolerate more segment variation
// while still rejecting clearly wrong classes.
const MATCH_THRESHOLD = 0.65

export interface MatchResult {
  partNumber:  string   // real DB part number
  score:       number   // similarity score [0, 1]
  normalized:  string   // intermediate normalised label
}

/**
 * Find the best-matching DB part number for a raw YOLO class label.
 *
 * @param modelLabel  Raw YOLO class name, e.g. "W_CV01_D26RXXX_C03N_NL_DG00"
 * @param candidates  Real part numbers from the DN / DB
 * @param threshold   Minimum score to accept (default 0.65)
 * @returns           Best match or null if nothing is close enough
 */
export function findBestMatch(
  modelLabel: string,
  candidates: string[],
  threshold = MATCH_THRESHOLD,
): MatchResult | null {
  if (!modelLabel || candidates.length === 0) return null

  const normalized = normalizeModelLabel(modelLabel)
  let best: MatchResult | null = null

  for (const pn of candidates) {
    const score = partNumberSimilarity(normalized, pn)
    if (score > (best?.score ?? -1)) {
      best = { partNumber: pn, score, normalized }
    }
  }

  if (!best || best.score < threshold) return null
  return best
}

/**
 * Diagnostic helper — returns scored candidates sorted best-first.
 * Useful during development / console debugging.
 */
export function scoreAllCandidates(
  modelLabel: string,
  candidates: string[],
): Array<MatchResult & { label: string }> {
  const normalized = normalizeModelLabel(modelLabel)
  return candidates
    .map(pn => ({
      label:      modelLabel,
      partNumber: pn,
      score:      partNumberSimilarity(normalized, pn),
      normalized,
    }))
    .sort((a, b) => b.score - a.score)
}