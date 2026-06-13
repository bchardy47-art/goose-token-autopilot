import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ObservationClassification =
  | 'EARLY_WINNER'
  | 'STILL_STRONG'
  | 'FADED'
  | 'CRUSHED'
  | 'PENDING_PRICE'
  | 'UNKNOWN';

export interface ObservationAutopsyCandidate {
  contractKey:             string;
  symbol?:                 string;
  approvalAgeMinutes:      number | null;
  approvalScore:           number | null;
  approvalPriceChangePct:  number | null;
  approvalClusterRisk:     string;
  approvedAt:              string;
  latestObsAgeMinutes:     number | null;
  latestObsScore:          number | null;
  latestObsPriceChangePct: number | null;
  latestObsCapturedAt:     string | null;
  scoreDelta:              number | null;
  obsCount:                number;
  outcomePctChange:        number | null;
  outcomeMultiple:         number | null;
  classification:          ObservationClassification;
}

export interface RipperApprovedObservationAutopsyOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outcomePaths:     string[];
  nowMs?:           number;
}

export interface RipperApprovedObservationAutopsyResult {
  generatedAt:              string;
  approvalFilesRead:        number;
  approvalFilesMissing:     number;
  observationFilesRead:     number;
  observationFilesMissing:  number;
  outcomeFilesRead:         number;
  outcomeFilesMissing:      number;
  approvalsRead:            number;
  observationsRead:         number;
  outcomesRead:             number;
  matchedCandidates:        number;
  pricedCandidates:         number;
  winners:                  number;
  losers:                   number;
  pendingPrice:             number;
  avgApprovalScore:         number | null;
  avgLatestObsScore:        number | null;
  avgScoreDelta:            number | null;
  avgOutcomePctChange:      number | null;
  classificationCounts:     Record<ObservationClassification, number>;
  topWinners:               ObservationAutopsyCandidate[];
  worstLosers:              ObservationAutopsyCandidate[];
  fadedFromStrong:          ObservationAutopsyCandidate[];
  candidates:               ObservationAutopsyCandidate[];
  realTradingLocked:        true;
  tradingExecuted:          0;
  noRealTradeSent:          true;
  paperOnly:                true;
  readOnly:                 true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = f.raw as Record<string, unknown> | undefined;
  const v   = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

/**
 * Priority order:
 * 1. PENDING_PRICE — no outcome price available yet
 * 2. CRUSHED        — outcome <= -25% (regardless of obs score)
 * 3. STILL_STRONG   — positive outcome AND obs score >= 75
 * 4. EARLY_WINNER   — positive outcome AND obs score < 75 (peaked, then faded)
 * 5. FADED          — slight-negative outcome (-25, 0] AND obs score < 75
 * 6. UNKNOWN        — insufficient data to classify
 */
function classify(
  latestObsScore:   number | null,
  outcomePctChange: number | null,
): ObservationClassification {
  if (outcomePctChange == null) return 'PENDING_PRICE';
  if (outcomePctChange <= -25)  return 'CRUSHED';
  if (outcomePctChange > 0) {
    if (latestObsScore == null) return 'UNKNOWN';
    return latestObsScore >= 75 ? 'STILL_STRONG' : 'EARLY_WINNER';
  }
  // outcome in (-25, 0]
  if (latestObsScore != null && latestObsScore < 75) return 'FADED';
  return 'UNKNOWN';
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovedObservationAutopsy(
  options: RipperApprovedObservationAutopsyOptions,
): RipperApprovedObservationAutopsyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures ─────────────────────────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;

  const approvalMap = new Map<string, LiveRipperFixture>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    const fixtures = readFixturesFromJsonl(p);
    for (const f of fixtures) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const key      = signalKey(f.normalizedSignal);
      const existing = approvalMap.get(key);
      // Keep earliest approval (first time this contract was approved this session)
      if (!existing || f.capturedAt < existing.capturedAt) {
        approvalMap.set(key, f);
      }
    }
  }

  // ── Step 2: Read observation fixtures ──────────────────────────────────────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsRead        = 0;

  const obsListMap = new Map<string, LiveRipperFixture[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    const fixtures = readFixturesFromJsonl(p);
    for (const f of fixtures) {
      observationsRead++;
      const key = signalKey(f.normalizedSignal);
      const list = obsListMap.get(key);
      if (list) { list.push(f); } else { obsListMap.set(key, [f]); }
    }
  }

  // Select latest observation per contractKey (highest ageMinutes, then capturedAt desc)
  const latestObsMap = new Map<string, LiveRipperFixture>();
  for (const [key, list] of obsListMap) {
    list.sort((a, b) => {
      if (a.ageMinutes != null && b.ageMinutes != null) return b.ageMinutes - a.ageMinutes;
      if (a.ageMinutes != null) return -1;
      if (b.ageMinutes != null) return  1;
      return b.capturedAt.localeCompare(a.capturedAt);
    });
    latestObsMap.set(key, list[0]);
  }

  // ── Step 3: Read outcome data ───────────────────────────────────────────────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;
  let outcomesRead        = 0;

  interface OutcomeEntry {
    pctChangeFromEntry: number | null;
    multipleFromEntry:  number | null;
    checkpointAt:       string;
  }

  const outcomeMap = new Map<string, OutcomeEntry>();

  for (const p of options.outcomePaths) {
    if (!fs.existsSync(p)) { outcomeFilesMissing++; continue; }
    outcomeFilesRead++;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }

    const fileCheckpointAt =
      typeof (parsed as Record<string, unknown>)?.['checkpointAt'] === 'string'
        ? String((parsed as Record<string, unknown>)['checkpointAt'])
        : typeof (parsed as Record<string, unknown>)?.['generatedAt'] === 'string'
          ? String((parsed as Record<string, unknown>)['generatedAt'])
          : '';

    const cands = Array.isArray((parsed as Record<string, unknown>)?.['candidates'])
      ? (parsed as Record<string, unknown>)['candidates'] as Record<string, unknown>[]
      : [];

    for (const c of cands) {
      const key = typeof c['contractKey'] === 'string' ? c['contractKey'] : null;
      if (!key) continue;
      outcomesRead++;

      const candidateCheckpointAt = typeof c['checkpointAt'] === 'string'
        ? c['checkpointAt']
        : fileCheckpointAt;

      const existing = outcomeMap.get(key);
      if (!existing || candidateCheckpointAt >= existing.checkpointAt) {
        outcomeMap.set(key, {
          pctChangeFromEntry: toFiniteNum(c['pctChangeFromEntry']),
          multipleFromEntry:  toFiniteNum(c['multipleFromEntry']),
          checkpointAt:       candidateCheckpointAt,
        });
      }
    }
  }

  // ── Step 4: Build per-candidate records ────────────────────────────────────
  const candidates: ObservationAutopsyCandidate[] = [];

  for (const [key, approval] of approvalMap) {
    const latestObs = latestObsMap.get(key);
    const outcome   = outcomeMap.get(key);

    const approvalScore          = typeof approval.ripperScore === 'number' ? approval.ripperScore : null;
    const approvalAgeMinutes     = typeof approval.ageMinutes  === 'number' ? approval.ageMinutes  : null;
    const approvalPriceChangePct = typeof approval.normalizedSignal.priceChangePct === 'number'
      ? approval.normalizedSignal.priceChangePct
      : null;
    const approvalClusterRisk    = getClusterRisk(approval);

    const latestObsScore          = latestObs && typeof latestObs.ripperScore === 'number' ? latestObs.ripperScore : null;
    const latestObsAgeMinutes     = latestObs && typeof latestObs.ageMinutes  === 'number' ? latestObs.ageMinutes  : null;
    const latestObsPriceChangePct = latestObs && typeof latestObs.normalizedSignal.priceChangePct === 'number'
      ? latestObs.normalizedSignal.priceChangePct
      : null;
    const latestObsCapturedAt     = latestObs ? latestObs.capturedAt : null;
    const scoreDelta              = approvalScore != null && latestObsScore != null
      ? latestObsScore - approvalScore
      : null;

    const outcomePctChange = outcome?.pctChangeFromEntry ?? null;
    const outcomeMultiple  = outcome?.multipleFromEntry  ?? null;

    candidates.push({
      contractKey:            key,
      symbol:                 approval.normalizedSignal.symbol,
      approvalAgeMinutes,
      approvalScore,
      approvalPriceChangePct,
      approvalClusterRisk,
      approvedAt:             approval.capturedAt,
      latestObsAgeMinutes,
      latestObsScore,
      latestObsPriceChangePct,
      latestObsCapturedAt,
      scoreDelta,
      obsCount:               (obsListMap.get(key) ?? []).length,
      outcomePctChange,
      outcomeMultiple,
      classification:         classify(latestObsScore, outcomePctChange),
    });
  }

  // Sort: priced first (desc by outcomePctChange), then pending
  candidates.sort((a, b) => {
    if (a.outcomePctChange == null && b.outcomePctChange == null) return 0;
    if (a.outcomePctChange == null) return  1;
    if (b.outcomePctChange == null) return -1;
    return b.outcomePctChange - a.outcomePctChange;
  });

  // ── Step 5: Aggregates ──────────────────────────────────────────────────────
  const priced  = candidates.filter(c => c.outcomePctChange != null);
  const pending = candidates.filter(c => c.outcomePctChange == null);
  const winners = priced.filter(c => c.outcomePctChange! > 0);
  const losers  = priced.filter(c => c.outcomePctChange! <= 0);

  const classificationCounts: Record<ObservationClassification, number> = {
    EARLY_WINNER: 0, STILL_STRONG: 0, FADED: 0, CRUSHED: 0, PENDING_PRICE: 0, UNKNOWN: 0,
  };
  for (const c of candidates) classificationCounts[c.classification]++;

  const topWinners = [...winners]
    .sort((a, b) => b.outcomePctChange! - a.outcomePctChange!)
    .slice(0, 5);

  const worstLosers = [...losers]
    .sort((a, b) => a.outcomePctChange! - b.outcomePctChange!)
    .slice(0, 5);

  const fadedFromStrong = candidates.filter(
    c => c.approvalScore != null && c.approvalScore >= 75
      && c.latestObsScore != null && c.latestObsScore < 75,
  );

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalsRead,
    observationsRead,
    outcomesRead,
    matchedCandidates:   candidates.length,
    pricedCandidates:    priced.length,
    winners:             winners.length,
    losers:              losers.length,
    pendingPrice:        pending.length,
    avgApprovalScore:    avgOf(candidates.map(c => c.approvalScore)),
    avgLatestObsScore:   avgOf(candidates.map(c => c.latestObsScore)),
    avgScoreDelta:       avgOf(candidates.map(c => c.scoreDelta)),
    avgOutcomePctChange: avgOf(priced.map(c => c.outcomePctChange)),
    classificationCounts,
    topWinners,
    worstLosers,
    fadedFromStrong,
    candidates,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtScore(n: number | null | undefined): string {
  return n != null ? String(Math.round(n)).padStart(3) : '  ?';
}

function fmtAge(m: number | null | undefined): string {
  if (m == null) return 'n/a';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(0)}`;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

export function renderRipperApprovedObservationAutopsy(
  result: RipperApprovedObservationAutopsyResult,
): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVED OBSERVATION AUTOPSY');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — NO GATE CHANGES]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated           : ${result.generatedAt}`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files    : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Observation files : ${result.observationFilesRead}${result.observationFilesMissing > 0 ? ` (${result.observationFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files     : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  lines.push(`    Approvals read    : ${result.approvalsRead}`);
  lines.push(`    Observations read : ${result.observationsRead}`);
  lines.push(`    Outcomes read     : ${result.outcomesRead}`);
  lines.push('');
  lines.push('  Summary:');
  lines.push(`    Matched candidates: ${result.matchedCandidates}`);
  lines.push(`    Priced            : ${result.pricedCandidates}`);
  lines.push(`    Winners           : ${result.winners}`);
  lines.push(`    Losers            : ${result.losers}`);
  lines.push(`    Pending price     : ${result.pendingPrice}`);
  if (result.avgApprovalScore != null) {
    lines.push(`    Avg approval score: ${Math.round(result.avgApprovalScore)}`);
  }
  if (result.avgLatestObsScore != null) {
    lines.push(`    Avg latest obs sc : ${Math.round(result.avgLatestObsScore)}`);
  }
  if (result.avgScoreDelta != null) {
    lines.push(`    Avg score delta   : ${fmtDelta(result.avgScoreDelta)}`);
  }
  if (result.avgOutcomePctChange != null) {
    lines.push(`    Avg outcome pct   : ${fmtPct(result.avgOutcomePctChange)}`);
  }
  lines.push('');

  // Classification counts
  const cc = result.classificationCounts;
  lines.push('  Classifications:');
  lines.push(`    STILL_STRONG  : ${cc.STILL_STRONG}`);
  lines.push(`    EARLY_WINNER  : ${cc.EARLY_WINNER}`);
  lines.push(`    FADED         : ${cc.FADED}`);
  lines.push(`    CRUSHED       : ${cc.CRUSHED}`);
  lines.push(`    PENDING_PRICE : ${cc.PENDING_PRICE}`);
  lines.push(`    UNKNOWN       : ${cc.UNKNOWN}`);
  lines.push('');

  // Top winners
  if (result.topWinners.length > 0) {
    lines.push('  — TOP WINNERS ————————————————————————————————————————————————');
    for (const c of result.topWinners) {
      const sym = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push(
        `  ${sym.padEnd(16)} aprvScr=${fmtScore(c.approvalScore)} obsScr=${fmtScore(c.latestObsScore)}` +
        ` Δ=${fmtDelta(c.scoreDelta).padEnd(4)} outcome=${fmtPct(c.outcomePctChange)}` +
        ` [${c.classification}]`,
      );
    }
    lines.push('');
  }

  // Worst losers
  if (result.worstLosers.length > 0) {
    lines.push('  — WORST LOSERS ───────────────────────────────────────────────');
    for (const c of result.worstLosers) {
      const sym = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push(
        `  ${sym.padEnd(16)} aprvScr=${fmtScore(c.approvalScore)} obsScr=${fmtScore(c.latestObsScore)}` +
        ` Δ=${fmtDelta(c.scoreDelta).padEnd(4)} outcome=${fmtPct(c.outcomePctChange)}` +
        ` [${c.classification}]`,
      );
    }
    lines.push('');
  }

  // Faded from strong
  if (result.fadedFromStrong.length > 0) {
    lines.push('  — FADED FROM STRONG (aprvScr≥75 → obsScr<75) ────────────────');
    for (const c of result.fadedFromStrong) {
      const sym = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push(
        `  ${sym.padEnd(16)} aprvScr=${fmtScore(c.approvalScore)}→obsScr=${fmtScore(c.latestObsScore)}` +
        ` Δ=${fmtDelta(c.scoreDelta).padEnd(4)} obsAge=${fmtAge(c.latestObsAgeMinutes)}` +
        ` outcome=${fmtPct(c.outcomePctChange)}`,
      );
    }
    lines.push('');
  }

  // All candidates table
  if (result.candidates.length === 0) {
    lines.push('  (no candidates found — check --approvals paths)');
  } else {
    lines.push('  — ALL CANDIDATES ─────────────────────────────────────────────');
    lines.push('');
    lines.push(
      '  sym/addr         aprvAge aprvScr obsAge  obsScr  Δscr  aprvPct obsPct  outcome classification',
    );
    for (const c of result.candidates) {
      const sym  = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push(
        `  ${sym.padEnd(16)} ${fmtAge(c.approvalAgeMinutes).padEnd(7)} ${fmtScore(c.approvalScore).padEnd(7)}` +
        ` ${fmtAge(c.latestObsAgeMinutes).padEnd(7)} ${fmtScore(c.latestObsScore).padEnd(7)}` +
        ` ${fmtDelta(c.scoreDelta).padEnd(5)} ${fmtPct(c.approvalPriceChangePct).padEnd(7)}` +
        ` ${fmtPct(c.latestObsPriceChangePct).padEnd(7)} ${fmtPct(c.outcomePctChange).padEnd(8)} ${c.classification}`,
      );
    }
  }

  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperApprovedObservationAutopsyUsage(): string {
  return `
token:ripper-approved-observation-autopsy — join approval, observation, and outcome data per candidate

Usage:
  npm run token:ripper-approved-observation-autopsy -- \\
    --approvals  <cycle-jsonl...>       \\
    --observations <obs-jsonl...>       \\
    --outcomes   <outcome-json...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (from data/token-grab/ripper/observations/)
  --outcomes     <paths>   approved outcome JSON checkpoint files
  --help                   show this message

Output:
  Per-candidate: approval age/score/cluster, latest obs age/score/delta, outcome pctChange, classification.
  Summary: winners, losers, avg scores, classification counts, top winners, worst losers, faded-from-strong.

Classifications:
  STILL_STRONG   — positive outcome and obs score still >= 75
  EARLY_WINNER   — positive outcome but obs score dropped below 75
  FADED          — slight-negative outcome and obs score < 75
  CRUSHED        — outcome <= -25%
  PENDING_PRICE  — no outcome price available yet
  UNKNOWN        — insufficient data

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
