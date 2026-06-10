import type { HolderClusterResult } from './holderClusterAdapter';

// ── Classification thresholds (conservative — aligned with scoreHolderCluster) ────────────

const RISKY_TOP1_PCT  = 30;   // single holder ≥ 30% → RISKY
const WATCH_TOP1_PCT  = 15;   // single holder ≥ 15% → WATCH
const RISKY_TOP10_PCT = 70;   // top-10 ≥ 70% → RISKY
const WATCH_TOP10_PCT = 50;   // top-10 ≥ 50% → WATCH

// ── Input shape ───────────────────────────────────────────────────────────────

export interface HolderRiskRawInput {
  holderConcentrationStatus?: string;  // 'CLEAN' | 'WARNING' | 'DANGER' | 'UNKNOWN'
  topHolderPercent?: number;
  top10HolderPercent?: number;
  holderFetchError?: string;
  checkedAt?: string;
  provider?: string;
}

// ── Core classifier (pure, sync, offline-safe) ────────────────────────────────

export function classifyHolderRisk(
  input: HolderRiskRawInput,
  nowIso?: string,
): HolderClusterResult {
  const status = input.holderConcentrationStatus;
  const top1   = input.topHolderPercent;
  const top10  = input.top10HolderPercent;
  const checkedAt = input.checkedAt ?? nowIso ?? new Date().toISOString();
  const provider  = input.provider ?? 'local-enrichment';
  const notes: string[] = [];

  // No holder data at all → UNKNOWN (not CLEAN)
  const hasAnyData = status != null || top1 != null || top10 != null;
  if (!hasAnyData) {
    return {
      holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN',
      concentrationNotes: ['no holder data available'],
      provider, checkedAt, confidence: 'UNKNOWN',
    };
  }

  // Data was fetched but status is still UNKNOWN (e.g., RPC rate limit) → UNKNOWN
  if (status === 'UNKNOWN' && top1 == null && top10 == null) {
    const errNote = input.holderFetchError
      ? `holder fetch failed: ${input.holderFetchError.slice(0, 100)}`
      : 'holder data unavailable at fetch time';
    return {
      holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN',
      concentrationNotes: [errNote],
      provider, checkedAt, confidence: 'UNKNOWN',
    };
  }

  // ── RISKY ──
  const isRisky =
    status === 'DANGER' ||
    (top1  != null && top1  >= RISKY_TOP1_PCT) ||
    (top10 != null && top10 >= RISKY_TOP10_PCT);

  if (isRisky) {
    if (status === 'DANGER') notes.push('holder concentration DANGER');
    if (top1  != null && top1  >= RISKY_TOP1_PCT)  notes.push(`top holder ${top1.toFixed(1)}% ≥ ${RISKY_TOP1_PCT}%`);
    if (top10 != null && top10 >= RISKY_TOP10_PCT) notes.push(`top-10 holders ${top10.toFixed(1)}% ≥ ${RISKY_TOP10_PCT}%`);
    const confidence = (status != null && (top1 != null || top10 != null)) ? 'HIGH'
      : status != null ? 'MEDIUM' : 'LOW';
    return {
      holderRisk: 'RISKY', clusterRisk: 'UNKNOWN',
      concentrationNotes: notes, provider, checkedAt, confidence,
      topHolderPercent: top1,
    };
  }

  // ── WATCH ──
  const isWatch =
    status === 'WARNING' ||
    (top1  != null && top1  >= WATCH_TOP1_PCT) ||
    (top10 != null && top10 >= WATCH_TOP10_PCT);

  if (isWatch) {
    if (status === 'WARNING') notes.push('holder concentration WARNING');
    if (top1  != null && top1  >= WATCH_TOP1_PCT)  notes.push(`top holder ${top1.toFixed(1)}% ≥ ${WATCH_TOP1_PCT}%`);
    if (top10 != null && top10 >= WATCH_TOP10_PCT) notes.push(`top-10 holders ${top10.toFixed(1)}% ≥ ${WATCH_TOP10_PCT}%`);
    const confidence = (status != null && (top1 != null || top10 != null)) ? 'HIGH'
      : status != null ? 'MEDIUM' : 'LOW';
    return {
      holderRisk: 'WATCH', clusterRisk: 'UNKNOWN',
      concentrationNotes: notes, provider, checkedAt, confidence,
      topHolderPercent: top1,
    };
  }

  // ── CLEAN — requires explicit status='CLEAN'; numeric data alone is not enough ──
  if (status === 'CLEAN') {
    if (top1  != null) notes.push(`top holder ${top1.toFixed(1)}%`);
    if (top10 != null) notes.push(`top-10 holders ${top10.toFixed(1)}%`);
    const confidence = (top1 != null || top10 != null) ? 'HIGH' : 'MEDIUM';
    return {
      holderRisk: 'CLEAN', clusterRisk: 'UNKNOWN',
      concentrationNotes: notes.length ? notes : ['holder concentration CLEAN'],
      provider, checkedAt, confidence,
      topHolderPercent: top1,
    };
  }

  // Has numeric data but no conclusive status → UNKNOWN (conservative)
  if (top1  != null) notes.push(`top holder ${top1.toFixed(1)}%`);
  if (top10 != null) notes.push(`top-10 holders ${top10.toFixed(1)}%`);
  return {
    holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN',
    concentrationNotes: ['holder data present but status inconclusive', ...notes],
    provider, checkedAt, confidence: 'LOW',
  };
}

// ── Extract from enriched candidate raw object ────────────────────────────────

/**
 * Reads holder fields from an enriched candidate's raw object.
 * Returns null if no holder-related fields are present at all.
 */
export function extractHolderRiskFromCandidate(
  raw: Record<string, unknown>,
): HolderClusterResult | null {
  const status = raw.holderConcentrationStatus as string | undefined;
  const top1   = typeof raw.topHolderPercent === 'number' ? raw.topHolderPercent : undefined;
  const top10  = typeof raw.top10HolderPercent === 'number' ? raw.top10HolderPercent : undefined;
  const err    = raw.holderFetchError as string | undefined;
  const provider = raw.provider as string | undefined;

  // Nothing holder-related present
  if (status == null && top1 == null && top10 == null) return null;

  return classifyHolderRisk({ holderConcentrationStatus: status, topHolderPercent: top1, top10HolderPercent: top10, holderFetchError: err, provider: provider ?? 'local-enrichment' });
}

// ── Extract from live fixture ─────────────────────────────────────────────────

/**
 * Tries to extract holder risk from a LiveRipperFixture's raw field.
 * Returns null if the fixture has no holder data at all.
 */
export function maybeHolderRiskFromFixture(fixture: unknown): HolderClusterResult | null {
  if (!fixture || typeof fixture !== 'object') return null;
  const f = fixture as Record<string, unknown>;
  const raw = f.raw;
  if (!raw || typeof raw !== 'object') return null;
  return extractHolderRiskFromCandidate(raw as Record<string, unknown>);
}

// ── Thresholds (exported for tests/docs) ─────────────────────────────────────

export const HOLDER_RISK_THRESHOLDS = {
  RISKY_TOP1_PCT,
  WATCH_TOP1_PCT,
  RISKY_TOP10_PCT,
  WATCH_TOP10_PCT,
} as const;
