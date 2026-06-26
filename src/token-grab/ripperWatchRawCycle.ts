// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
//
// Shared raw-cycle row reading and enrollment-match classification for subgroup watch.
// No imports from ripperSubgroupWatch or ripperWatchCohort → no circular deps.
// Used by ripperSubgroupWatch to compute latestRawEnrollableHitCount (the count that
// matches what token:ripper-watch-cohort-enroll --dry-run reports as "Watch hits found").
// ripperWatchCohort defines its own equivalent logic locally so its behavior is unchanged.

import * as fs from 'fs';

import { bucketLiquidity } from './ripperLearningMemory';

// ── Minimal raw cycle row shape ───────────────────────────────────────────────────────
// Mirrors CycleRow in ripperWatchCohort.ts — keep the field set in sync if enrollment
// logic changes.

export interface RawCycleRow {
  capturedAt?:       string;
  buyGateDecision?:  string;
  entryDecision?:    string | null;
  entryMomentumPct?: number | null;
  ripperScore?:      number | null;
  launchAgeBucket?:  string | null;
  normalizedSignal?: {
    contract?:     string;
    symbol?:       string;
    liquidityUsd?: number | null;
  } & Record<string, unknown>;
  ripperInput?: { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
  raw?:         { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
}

// ── File helpers ──────────────────────────────────────────────────────────────────────

export function findLatestRawCycleFile(cyclesDir: string): string | null {
  if (!fs.existsSync(cyclesDir)) return null;
  let files: string[];
  try { files = fs.readdirSync(cyclesDir); } catch { return null; }
  const cycles = files
    .filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f))
    .sort();
  return cycles.at(-1) ?? null;
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

// ── Enrollment classification helpers ─────────────────────────────────────────────────

// Target criteria — must stay in sync with TARGET_* in ripperSubgroupWatch.ts.
const TARGET_LIQUIDITY_BUCKET = 'LIQ_10K_30K';

/** Is the raw M5 value in the '-20 to -5' band? Mirrors M5_BANDS entry in ripperSubgroupWatch. */
function rawM5InTargetBand(pct: number | null | undefined): boolean {
  if (pct == null || !Number.isFinite(pct)) return false;
  return pct > -20 && pct <= -5;
}

/**
 * Is this row the high-quality WAIT_10M subgroup? Mirrors isHighQualitySubgroup in
 * ripperPaperDecisionPolicy.ts exactly. ENTER_NOW = !isHQSubgroup.
 */
function isHQSubgroup(
  clusterRisk:      string | null,
  ripperScore:      number | null,
  launchAgeBucket:  string | null,
  entryDecision:    string | null,
): boolean {
  return (
    clusterRisk     === 'CLEAN' &&
    typeof ripperScore === 'number' &&
    ripperScore     >= 100 &&
    launchAgeBucket === 'PRIME_WINDOW' &&
    entryDecision   === 'READY_TO_SNIPE_PAPER'
  );
}

// ── Raw enrollable count ──────────────────────────────────────────────────────────────

/**
 * Count raw cycle rows that would match forward cohort enrollment — uses the same criteria
 * as cycleRowToCandidate + classifySubgroupWatch in ripperWatchCohort.ts. The count returned
 * here must equal what token:ripper-watch-cohort-enroll --dry-run reports as "Watch hits found"
 * for the same cycle file.
 *
 * Enrollment criteria:
 *   1. buyGateDecision === 'BUY_APPROVED_PAPER'
 *   2. raw entryMomentumPct is in (-20, -5] → m5Band '-20 to -5'
 *   3. liquidityUsd bands to 'LIQ_10K_30K'
 *   4. paperEntryTiming would be 'ENTER_NOW' (i.e. NOT the HQ WAIT_10M subgroup)
 */
export function countRawEnrollableHits(cycleFileAbs: string): number {
  const rows = readJsonl<RawCycleRow>(cycleFileAbs);
  let hits = 0;
  for (const row of rows) {
    const contract = row.normalizedSignal?.contract ?? row.ripperInput?.contract ?? row.raw?.contract;
    if (!contract) continue;

    // Only approved rows receive a paperEntryTiming
    if (row.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;

    // Raw M5 must be in the target band — null/UNAVAILABLE cannot match
    const entryMomentumPct =
      typeof row.entryMomentumPct === 'number' && Number.isFinite(row.entryMomentumPct)
        ? row.entryMomentumPct : null;
    if (!rawM5InTargetBand(entryMomentumPct)) continue;

    // Liquidity must band to LIQ_10K_30K
    const liquidityBucket = bucketLiquidity(row.normalizedSignal?.liquidityUsd ?? null);
    if (liquidityBucket !== TARGET_LIQUIDITY_BUCKET) continue;

    // Entry timing must be ENTER_NOW (= NOT the HQ WAIT_10M subgroup)
    const clusterRisk    = row.ripperInput?.clusterRisk ?? row.raw?.clusterRisk ?? null;
    const ripperScore    = typeof row.ripperScore === 'number' ? row.ripperScore : null;
    const launchAgeBucket = row.launchAgeBucket ?? null;
    const entryDecision  = row.entryDecision ?? null;
    if (isHQSubgroup(clusterRisk, ripperScore, launchAgeBucket, entryDecision)) continue;

    hits++;
  }
  return hits;
}
