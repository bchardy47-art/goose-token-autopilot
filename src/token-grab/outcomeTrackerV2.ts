import * as fs from 'fs';
import {
  runOutcomeTracker,
  type OutcomeTrackerOptions,
  type OutcomeCandidate,
} from './outcomeTracker';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { extractReadinessFields, classifyReadinessLevel } from './autonomyReadinessAudit';
import { fetchPairSnapshot, type DexPairSnapshot } from './dexWatch';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPositiveNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function avgOf(values: (number | null)[]): number | null {
  const ns = values.filter((v): v is number => v !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckpointStatus = 'HIT_100' | 'HIT_50' | 'HIT_25' | 'NEVER_RIPPED' | 'UNKNOWN';

export interface PriceSnapshot {
  priceUsd:   number;
  observedAt: string;
  label:      'entry' | 'final' | 'latest';
}

export interface ExitSimulations {
  hold_to_latest:      number | null;
  take_profit_25:      number | null;
  take_profit_50:      number | null;
  stop_loss_15:        number | null;
  stop_loss_25:        number | null;
  trailing_stop_20:    number | null;
  bestSimulatedReturn: number | null;
  isSparse:            boolean;
}

export interface CandidateCheckpointRecord extends OutcomeCandidate {
  finalCapturePriceUsd: number | null;
  finalCaptureAt:       string | null;
  finalReturnPct:       number | null;
  latestReturnPct:      number | null;
  maxKnownReturnPct:    number | null;
  minKnownReturnPct:    number | null;
  bestKnownPrice:       number | null;
  worstKnownPrice:      number | null;
  timeToBestKnown:      string | null;
  timeToWorstKnown:     string | null;
  snapshots:            PriceSnapshot[];
  snapshotCount:        number;
  isSparse:             boolean;
  checkpointStatus:     CheckpointStatus;
  exitSimulations:      ExitSimulations;
}

export interface OutcomeTrackerV2Options extends OutcomeTrackerOptions {}

export interface OutcomeTrackerV2Result {
  inputPath:         string;
  inputMissing:      boolean;
  generatedAt:       string;
  totalCandidates:   number;
  hit25Count:        number;
  hit50Count:        number;
  hit100Count:       number;
  neverRippedCount:  number;
  unknownCount:      number;
  avgLatestReturn:   number | null;
  avgMaxKnownReturn: number | null;
  bestCandidate:     CandidateCheckpointRecord | null;
  worstCandidate:    CandidateCheckpointRecord | null;
  records:           CandidateCheckpointRecord[];
  tradingExecuted:   0;
  noRealTradeSent:   true;
  paperOnly:         true;
  readOnly:          true;
}

// ── Pure: snapshot builder ────────────────────────────────────────────────────

export function buildCandidateSnapshots(
  raw: Record<string, unknown> | undefined,
  latestSnap: DexPairSnapshot | null,
): PriceSnapshot[] {
  const snapshots: PriceSnapshot[] = [];
  const seen = new Set<string>(); // dedup by observedAt

  const rawEntry = raw?.['entry'] as Record<string, unknown> | undefined;
  const rawFinal = raw?.['final'] as Record<string, unknown> | undefined;

  const entryPrice = toPositiveNum(rawEntry?.['priceUsd']);
  const entryAt    = rawEntry?.['observedAt'] as string | undefined;
  if (entryPrice !== null && entryAt) {
    snapshots.push({ priceUsd: entryPrice, observedAt: entryAt, label: 'entry' });
    seen.add(entryAt);
  }

  const finalPrice = toPositiveNum(rawFinal?.['priceUsd']);
  const finalAt    = rawFinal?.['observedAt'] as string | undefined;
  if (finalPrice !== null && finalAt && !seen.has(finalAt)) {
    snapshots.push({ priceUsd: finalPrice, observedAt: finalAt, label: 'final' });
    seen.add(finalAt);
  }

  const latestPrice = toPositiveNum(latestSnap?.priceUsd ?? null);
  const latestAt    = latestSnap?.observedAt;
  if (latestPrice !== null && latestAt && !seen.has(latestAt)) {
    snapshots.push({ priceUsd: latestPrice, observedAt: latestAt, label: 'latest' });
  }

  return snapshots.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

// ── Pure: checkpoint status ───────────────────────────────────────────────────

export function classifyCheckpointStatus(maxKnownReturnPct: number | null): CheckpointStatus {
  if (maxKnownReturnPct === null) return 'UNKNOWN';
  if (maxKnownReturnPct >= 100)  return 'HIT_100';
  if (maxKnownReturnPct >= 50)   return 'HIT_50';
  if (maxKnownReturnPct >= 25)   return 'HIT_25';
  return 'NEVER_RIPPED';
}

// ── Pure: exit simulation ─────────────────────────────────────────────────────

export function simulateExits(
  snapshots: PriceSnapshot[],
  entryPrice: number,
): ExitSimulations {
  const empty: ExitSimulations = {
    hold_to_latest: null, take_profit_25: null, take_profit_50: null,
    stop_loss_15: null, stop_loss_25: null, trailing_stop_20: null,
    bestSimulatedReturn: null, isSparse: true,
  };
  if (snapshots.length === 0 || entryPrice <= 0) return empty;

  const sorted = [...snapshots].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const last   = sorted[sorted.length - 1]!;
  const holdReturn = (last.priceUsd - entryPrice) / entryPrice * 100;
  const isSparse   = sorted.length < 4;

  function retPct(price: number): number {
    return (price - entryPrice) / entryPrice * 100;
  }

  // TP25: exit at first snapshot where return >= 25%, locking in +25%
  let tp25 = holdReturn;
  for (const s of sorted) {
    if (retPct(s.priceUsd) >= 25) { tp25 = 25; break; }
  }

  // TP50: exit at first snapshot where return >= 50%, locking in +50%
  let tp50 = holdReturn;
  for (const s of sorted) {
    if (retPct(s.priceUsd) >= 50) { tp50 = 50; break; }
  }

  // SL15: exit at first snapshot where return <= -15%, locking in -15%
  let sl15 = holdReturn;
  for (const s of sorted) {
    if (retPct(s.priceUsd) <= -15) { sl15 = -15; break; }
  }

  // SL25: exit at first snapshot where return <= -25%, locking in -25%
  let sl25 = holdReturn;
  for (const s of sorted) {
    if (retPct(s.priceUsd) <= -25) { sl25 = -25; break; }
  }

  // Trailing stop 20% after activation at +25%
  // Once price >= +25%, track peak; exit when price drops 20% below peak.
  let trailing20 = holdReturn;
  let trailActivated = false;
  let peakPrice = entryPrice;
  let trailFired = false;
  for (const s of sorted) {
    const ret = retPct(s.priceUsd);
    if (!trailActivated) {
      if (ret >= 25) { trailActivated = true; peakPrice = s.priceUsd; }
    } else {
      if (s.priceUsd > peakPrice) peakPrice = s.priceUsd;
      if (s.priceUsd <= peakPrice * 0.80) {
        trailing20 = ret;
        trailFired = true;
        break;
      }
    }
  }
  if (!trailFired) trailing20 = holdReturn;

  const allReturns = [holdReturn, tp25, tp50, sl15, sl25, trailing20];
  const best = Math.max(...allReturns);

  return {
    hold_to_latest:      holdReturn,
    take_profit_25:      tp25,
    take_profit_50:      tp50,
    stop_loss_15:        sl15,
    stop_loss_25:        sl25,
    trailing_stop_20:    trailing20,
    bestSimulatedReturn: best,
    isSparse,
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

const DEFAULT_FETCH = (contract: string, chain: string, observedAt: string) =>
  fetchPairSnapshot(contract, { chain, observedAt });

export async function runOutcomeTrackerV2(
  options: OutcomeTrackerV2Options = {},
): Promise<OutcomeTrackerV2Result> {
  const inputPath   = options.inputPath   ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const doFetch     = options.fetch ?? DEFAULT_FETCH;

  const emptyResult: OutcomeTrackerV2Result = {
    inputPath, inputMissing: true, generatedAt,
    totalCandidates: 0, hit25Count: 0, hit50Count: 0, hit100Count: 0,
    neverRippedCount: 0, unknownCount: 0,
    avgLatestReturn: null, avgMaxKnownReturn: null,
    bestCandidate: null, worstCandidate: null, records: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  // 1. Reuse V1 tracker for candidate identification + latest price fetch
  const v1Result = await runOutcomeTracker({ inputPath, generatedAt, fetch: doFetch });
  if (v1Result.inputMissing) return emptyResult;

  // 2. Re-read fixtures for raw.entry/raw.final checkpoint data
  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return emptyResult;
  }

  const fixtureByContract = new Map<string, LiveRipperFixture>();
  for (const fixture of fixtures) {
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    if (level !== 'FUTURE_AUTONOMY_CANDIDATE') continue;
    const raw = fixture.raw as Record<string, unknown> | undefined;
    const ri  = fixture.ripperInput as Record<string, unknown> | null;
    const entry = raw?.['entry'] as Record<string, unknown> | undefined;
    const contract =
      (entry?.['contract'] as string | undefined) ??
      (raw?.['contract']   as string | undefined) ??
      (ri?.['contract']    as string | undefined) ??
      null;
    if (!contract) continue;
    const existing = fixtureByContract.get(contract);
    if (!existing || fixture.capturedAt < existing.capturedAt) {
      fixtureByContract.set(contract, fixture);
    }
  }

  // 3. Build checkpoint records
  const records: CandidateCheckpointRecord[] = v1Result.candidates.map(
    (candidate: OutcomeCandidate): CandidateCheckpointRecord => {
      const fixture  = fixtureByContract.get(candidate.contract);
      const raw      = (fixture?.raw as Record<string, unknown> | undefined) ?? {};
      const rawFinal = raw['final'] as Record<string, unknown> | undefined;

      // Latest price as a fake snapshot
      const latestSnap: DexPairSnapshot | null =
        candidate.latestPriceUsd !== null
          ? { contract: candidate.contract, chainId: candidate.chainId,
              priceUsd: candidate.latestPriceUsd, observedAt: generatedAt }
          : null;

      const snapshots = buildCandidateSnapshots(raw as Record<string, unknown>, latestSnap);

      const finalCapturePriceUsd = toPositiveNum(rawFinal?.['priceUsd']);
      const finalCaptureAt       = (rawFinal?.['observedAt'] as string | undefined) ?? null;

      const finalReturnPct =
        candidate.detectedPriceUsd !== null && finalCapturePriceUsd !== null
          ? ((finalCapturePriceUsd - candidate.detectedPriceUsd) / candidate.detectedPriceUsd) * 100
          : null;

      // Max/min across all known snapshots
      let maxKnownReturnPct: number | null = null;
      let minKnownReturnPct: number | null = null;
      let bestKnownPrice:    number | null = null;
      let worstKnownPrice:   number | null = null;
      let timeToBestKnown:   string | null = null;
      let timeToWorstKnown:  string | null = null;

      if (candidate.detectedPriceUsd !== null) {
        for (const snap of snapshots) {
          const ret = (snap.priceUsd - candidate.detectedPriceUsd) / candidate.detectedPriceUsd * 100;
          if (maxKnownReturnPct === null || ret > maxKnownReturnPct) {
            maxKnownReturnPct = ret;
            bestKnownPrice    = snap.priceUsd;
            timeToBestKnown   = snap.observedAt;
          }
          if (minKnownReturnPct === null || ret < minKnownReturnPct) {
            minKnownReturnPct = ret;
            worstKnownPrice   = snap.priceUsd;
            timeToWorstKnown  = snap.observedAt;
          }
        }
      }

      const checkpointStatus = classifyCheckpointStatus(maxKnownReturnPct);

      const exitSimulations =
        candidate.detectedPriceUsd !== null && snapshots.length > 0
          ? simulateExits(snapshots, candidate.detectedPriceUsd)
          : { hold_to_latest: null, take_profit_25: null, take_profit_50: null,
              stop_loss_15: null, stop_loss_25: null, trailing_stop_20: null,
              bestSimulatedReturn: null, isSparse: true };

      return {
        ...candidate,
        finalCapturePriceUsd,
        finalCaptureAt,
        finalReturnPct,
        latestReturnPct: candidate.currentReturnPct,
        maxKnownReturnPct,
        minKnownReturnPct,
        bestKnownPrice,
        worstKnownPrice,
        timeToBestKnown,
        timeToWorstKnown,
        snapshots,
        snapshotCount: snapshots.length,
        isSparse: snapshots.length < 4,
        checkpointStatus,
        exitSimulations,
      };
    },
  );

  // 4. Aggregate
  let hit25Count = 0, hit50Count = 0, hit100Count = 0, neverRippedCount = 0, unknownCount = 0;
  let bestCandidate: CandidateCheckpointRecord | null = null;
  let worstCandidate: CandidateCheckpointRecord | null = null;

  for (const r of records) {
    const m = r.maxKnownReturnPct;
    if (m !== null && m >= 100) hit100Count++;
    if (m !== null && m >= 50)  hit50Count++;
    if (m !== null && m >= 25)  hit25Count++;
    if (r.checkpointStatus === 'NEVER_RIPPED') neverRippedCount++;
    if (r.checkpointStatus === 'UNKNOWN')      unknownCount++;

    const ret = r.latestReturnPct;
    if (ret !== null) {
      if (bestCandidate === null || ret > (bestCandidate.latestReturnPct ?? -Infinity)) bestCandidate = r;
      if (worstCandidate === null || ret < (worstCandidate.latestReturnPct ?? Infinity)) worstCandidate = r;
    }
  }

  return {
    inputPath, inputMissing: false, generatedAt,
    totalCandidates: records.length,
    hit25Count, hit50Count, hit100Count, neverRippedCount, unknownCount,
    avgLatestReturn:   avgOf(records.map(r => r.latestReturnPct)),
    avgMaxKnownReturn: avgOf(records.map(r => r.maxKnownReturnPct)),
    bestCandidate, worstCandidate, records,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fp(n: number | null, d = 1, sign = false): string {
  if (n === null) return '—';
  const s = sign && n >= 0 ? '+' : '';
  return `${s}${n.toFixed(d)}%`;
}

function fd(n: number | null, d = 8): string {
  if (n === null) return '—';
  return n.toFixed(d);
}

function ageFrom(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderOutcomeTrackerV2Report(result: OutcomeTrackerV2Result): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — OUTCOME TRACKER V2');
  lines.push('  [REAL TRADING LOCKED — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const {
    totalCandidates, hit25Count, hit50Count, hit100Count, neverRippedCount, unknownCount,
    avgLatestReturn, avgMaxKnownReturn, bestCandidate, worstCandidate, records, generatedAt,
  } = result;

  // ── Section 1: Summary ────────────────────────────────────────────────────
  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Generated              : ${generatedAt}`);
  lines.push(`     Candidates             : ${totalCandidates}`);
  lines.push(`     Ever hit 25%+          : ${hit25Count}`);
  lines.push(`     Ever hit 50%+          : ${hit50Count}`);
  lines.push(`     Ever hit 100%+         : ${hit100Count}`);
  lines.push(`     Never ripped           : ${neverRippedCount}`);
  if (unknownCount > 0) lines.push(`     Unknown (no price)     : ${unknownCount}`);
  lines.push(`     Avg latest return      : ${fp(avgLatestReturn, 1, true)}`);
  lines.push(`     Avg max known return   : ${fp(avgMaxKnownReturn, 1, true)}`);
  if (bestCandidate)  lines.push(`     Best                   : $${bestCandidate.symbol} (${fp(bestCandidate.latestReturnPct, 1, true)})`);
  if (worstCandidate) lines.push(`     Worst                  : $${worstCandidate.symbol} (${fp(worstCandidate.latestReturnPct, 1, true)})`);
  lines.push('');

  if (totalCandidates === 0) {
    lines.push('  No FUTURE_AUTONOMY_CANDIDATE fixtures found.');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  // ── Section 2: Checkpoint Table ───────────────────────────────────────────
  lines.push('  2. CANDIDATE CHECKPOINTS');
  lines.push('     Symbol          Entry $       Final $       Latest $     Final%    Latest%   MaxKnown%  MinKnown%  Status');
  lines.push('     ' + '─'.repeat(103));
  for (const r of records) {
    const sym   = `$${r.symbol}`.padEnd(15);
    const entry = fd(r.detectedPriceUsd).padStart(12);
    const fin   = fd(r.finalCapturePriceUsd).padStart(12);
    const lat   = fd(r.latestPriceUsd, 8).padStart(12);
    const fpct  = fp(r.finalReturnPct,  1, true).padStart(8);
    const lpct  = fp(r.latestReturnPct, 1, true).padStart(8);
    const maxp  = fp(r.maxKnownReturnPct, 1, true).padStart(9);
    const minp  = fp(r.minKnownReturnPct, 1, true).padStart(9);
    const cs    = r.checkpointStatus;
    lines.push(`     ${sym}${entry}  ${fin}  ${lat}  ${fpct}  ${lpct}  ${maxp}  ${minp}  ${cs}`);
    if (r.pairUrl) lines.push(`       ↳ ${r.pairUrl}`);
    const age = ageFrom(r.detectedAt, generatedAt);
    lines.push(`       ↳ age: ${age}  snapshots: ${r.snapshotCount}${r.isSparse ? '  ⚠ sparse' : ''}`);
  }
  lines.push('');

  // ── Section 3: Exit Simulation Table ─────────────────────────────────────
  lines.push('  3. EXIT SIMULATION (paper-only — directional, not proof)');
  lines.push('     Symbol          Hold Latest  TP25%   TP50%   SL15%   SL25%   Trail20%  Best Exit');
  lines.push('     ' + '─'.repeat(85));
  for (const r of records) {
    const e   = r.exitSimulations;
    const sym = `$${r.symbol}`.padEnd(15);
    const hl  = fp(e.hold_to_latest,   1, true).padStart(11);
    const t25 = fp(e.take_profit_25,   1, true).padStart(7);
    const t50 = fp(e.take_profit_50,   1, true).padStart(7);
    const s15 = fp(e.stop_loss_15,     1, true).padStart(7);
    const s25 = fp(e.stop_loss_25,     1, true).padStart(7);
    const tr  = fp(e.trailing_stop_20, 1, true).padStart(8);
    const bst = fp(e.bestSimulatedReturn, 1, true).padStart(9);
    lines.push(`     ${sym}  ${hl}  ${t25}  ${t50}  ${s15}  ${s25}  ${tr}  ${bst}`);
  }
  lines.push('');

  // ── Section 4: Warnings ───────────────────────────────────────────────────
  lines.push('  4. WARNINGS');
  if (totalCandidates < 20) {
    lines.push(`  ⚠  Do not go live from this sample size (${totalCandidates} candidate${totalCandidates === 1 ? '' : 's'}).`);
  }
  const sparseCount = records.filter(r => r.isSparse).length;
  if (sparseCount > 0) {
    lines.push(`  ⚠  ${sparseCount} candidate${sparseCount > 1 ? 's' : ''} ha${sparseCount > 1 ? 've' : 's'} fewer than 4 snapshots.`);
    lines.push('     Path is sparse. Exit simulations are directional, not proof.');
  }
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  Real trading remains locked. These are read-only simulations.');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
