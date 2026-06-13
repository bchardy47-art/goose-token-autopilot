import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExitRuleId =
  | 'hold-to-checkpoint'
  | 'tp5-sl10'
  | 'tp10-sl10'
  | 'tp20-sl15'
  | 'tp30-sl20'
  | 'score-exit-75'
  | 'score-exit-60'
  | 'force-exit-5m'
  | 'force-exit-8m'
  | 'hybrid-tp10-sl10-score75';

export type ExitSimClassification =
  | 'WIN'
  | 'LOSS'
  | 'BREAKEVEN'
  | 'PENDING_PRICE'
  | 'NO_EXIT_SIGNAL';

export interface ExitSimCandidateResult {
  contractKey:             string;
  symbol?:                 string;
  approvalScore:           number | null;
  approvalAgeMinutes:      number | null;
  approvalPriceChangePct:  number | null;
  entryPriceUsd:           number | null;
  latestObsAgeMinutes:     number | null;
  latestObsScore:          number | null;
  latestObsPriceChangePct: number | null;
  outcomePctChange:        number | null;
  exitReason:              string;
  simulatedPctResult:      number | null;
  classification:          ExitSimClassification;
}

export interface ExitRuleSummary {
  ruleId:              ExitRuleId;
  ruleLabel:           string;
  candidatesEvaluated: number;
  pricedCandidates:    number;
  pendingPrice:        number;
  wins:                number;
  losses:              number;
  breakeven:           number;
  noExitSignal:        number;
  winRate:             number | null;
  avgPctResult:        number | null;
  medianPctResult:     number | null;
  bestCandidate:       ExitSimCandidateResult | null;
  worstCandidate:      ExitSimCandidateResult | null;
  avoidedCrushed:      number;
  capturedEarlyWinner: number;
  candidates:          ExitSimCandidateResult[];
}

export interface RipperExitSimOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outcomePaths:     string[];
  nowMs?:           number;
}

export interface RipperExitSimResult {
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
  rules:                    ExitRuleSummary[];
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

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Price change of observation relative to approval entry.
// Both pcts are from pool creation. Entry → obs gain =
//   ((1 + obsPct/100) / (1 + approvalPct/100) - 1) * 100
function relGainFromApproval(approvalPct: number, obsPct: number): number {
  return ((1 + obsPct / 100) / (1 + approvalPct / 100) - 1) * 100;
}

function classifyExit(result: number | null): ExitSimClassification {
  if (result == null) return 'PENDING_PRICE';
  if (result > 0)     return 'WIN';
  if (result < 0)     return 'LOSS';
  return 'BREAKEVEN';
}

// ── Internal observation entry (for simulation) ────────────────────────────────

interface ObsEntry {
  ageMinutes:     number | null;
  score:          number | null;
  priceChangePct: number | null;
  capturedAt:     string;
}

// ── Simulation context per candidate ──────────────────────────────────────────

interface SimContext {
  approvalPriceChangePct: number | null;
  observations:           ObsEntry[];  // sorted ageMinutes asc, nulls last
  outcomePct:             number | null;
}

interface SimResult {
  reason: string;
  result: number | null;
}

// ── Rule simulation functions ─────────────────────────────────────────────────

function simHoldToCheckpoint(ctx: SimContext): SimResult {
  if (ctx.outcomePct == null) return { reason: 'no-outcome', result: null };
  return { reason: 'held-to-checkpoint', result: ctx.outcomePct };
}

function simTpSl(ctx: SimContext, tpPct: number, slPct: number): SimResult {
  const ap = ctx.approvalPriceChangePct;
  for (const obs of ctx.observations) {
    if (obs.priceChangePct == null || ap == null) continue;
    const rel = relGainFromApproval(ap, obs.priceChangePct);
    if (rel >= tpPct)  return { reason: `tp${tpPct}-hit-at-${obs.ageMinutes}m`, result: tpPct };
    if (rel <= -slPct) return { reason: `sl${slPct}-hit-at-${obs.ageMinutes}m`, result: -slPct };
  }
  if (ctx.outcomePct != null) return { reason: 'no-trigger-held-to-checkpoint', result: ctx.outcomePct };
  return { reason: 'no-trigger-no-outcome', result: null };
}

function simScoreExit(ctx: SimContext, scoreThreshold: number): SimResult {
  const ap = ctx.approvalPriceChangePct;
  for (const obs of ctx.observations) {
    if (obs.score == null) continue;
    if (obs.score < scoreThreshold) {
      if (obs.priceChangePct == null || ap == null) {
        return { reason: `score-exit-${scoreThreshold}-no-price-at-${obs.ageMinutes}m`, result: null };
      }
      const rel = relGainFromApproval(ap, obs.priceChangePct);
      return { reason: `score-below-${scoreThreshold}-at-${obs.ageMinutes}m`, result: rel };
    }
  }
  if (ctx.outcomePct != null) return { reason: `score-held-strong-to-checkpoint`, result: ctx.outcomePct };
  return { reason: 'score-held-strong-no-outcome', result: null };
}

function simForceExitAtAge(ctx: SimContext, targetAge: number): SimResult {
  const ap        = ctx.approvalPriceChangePct;
  const withAge   = ctx.observations.filter(o => o.ageMinutes != null);
  if (withAge.length === 0) return { reason: `no-obs-for-force-exit-${targetAge}m`, result: null };

  withAge.sort((a, b) =>
    Math.abs(a.ageMinutes! - targetAge) - Math.abs(b.ageMinutes! - targetAge),
  );
  const closest = withAge[0];
  if (closest.priceChangePct == null || ap == null) {
    return { reason: `force-exit-${targetAge}m-no-price`, result: null };
  }
  const rel = relGainFromApproval(ap, closest.priceChangePct);
  return { reason: `force-exit-at-${closest.ageMinutes}m`, result: rel };
}

function simHybrid(
  ctx: SimContext,
  tpPct: number,
  slPct: number,
  scoreThreshold: number,
): SimResult {
  const ap = ctx.approvalPriceChangePct;
  for (const obs of ctx.observations) {
    // Score-drop check first — signal quality gate
    if (obs.score != null && obs.score < scoreThreshold) {
      if (obs.priceChangePct == null || ap == null) {
        return { reason: `hybrid-score-exit-${scoreThreshold}-no-price-at-${obs.ageMinutes}m`, result: null };
      }
      const rel = relGainFromApproval(ap, obs.priceChangePct);
      return { reason: `hybrid-score-below-${scoreThreshold}-at-${obs.ageMinutes}m`, result: rel };
    }
    // Then TP/SL
    if (obs.priceChangePct != null && ap != null) {
      const rel = relGainFromApproval(ap, obs.priceChangePct);
      if (rel >= tpPct)  return { reason: `hybrid-tp${tpPct}-hit-at-${obs.ageMinutes}m`, result: tpPct };
      if (rel <= -slPct) return { reason: `hybrid-sl${slPct}-hit-at-${obs.ageMinutes}m`, result: -slPct };
    }
  }
  if (ctx.outcomePct != null) return { reason: 'hybrid-no-trigger-to-checkpoint', result: ctx.outcomePct };
  return { reason: 'hybrid-no-trigger-no-outcome', result: null };
}

// ── Rule registry ──────────────────────────────────────────────────────────────

interface ExitRuleConfig {
  id:       ExitRuleId;
  label:    string;
  simulate: (ctx: SimContext) => SimResult;
}

const EXIT_RULES: ExitRuleConfig[] = [
  { id: 'hold-to-checkpoint',       label: 'Hold to checkpoint',              simulate: simHoldToCheckpoint },
  { id: 'tp5-sl10',                 label: 'TP +5% / SL -10%',               simulate: ctx => simTpSl(ctx, 5, 10) },
  { id: 'tp10-sl10',                label: 'TP +10% / SL -10%',              simulate: ctx => simTpSl(ctx, 10, 10) },
  { id: 'tp20-sl15',                label: 'TP +20% / SL -15%',              simulate: ctx => simTpSl(ctx, 20, 15) },
  { id: 'tp30-sl20',                label: 'TP +30% / SL -20%',              simulate: ctx => simTpSl(ctx, 30, 20) },
  { id: 'score-exit-75',            label: 'Exit when score < 75',           simulate: ctx => simScoreExit(ctx, 75) },
  { id: 'score-exit-60',            label: 'Exit when score < 60',           simulate: ctx => simScoreExit(ctx, 60) },
  { id: 'force-exit-5m',            label: 'Force exit at 5m',               simulate: ctx => simForceExitAtAge(ctx, 5) },
  { id: 'force-exit-8m',            label: 'Force exit at 8m',               simulate: ctx => simForceExitAtAge(ctx, 8) },
  { id: 'hybrid-tp10-sl10-score75', label: 'Hybrid TP +10% / SL -10% / score<75', simulate: ctx => simHybrid(ctx, 10, 10, 75) },
];

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperExitSim(options: RipperExitSimOptions): RipperExitSimResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures ─────────────────────────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  const approvalMap        = new Map<string, LiveRipperFixture>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const key = signalKey(f.normalizedSignal);
      const existing = approvalMap.get(key);
      if (!existing || f.capturedAt < existing.capturedAt) approvalMap.set(key, f);
    }
  }

  // ── Step 2: Read observation fixtures ──────────────────────────────────────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsRead        = 0;
  const obsListMap            = new Map<string, ObsEntry[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      observationsRead++;
      const key: string   = signalKey(f.normalizedSignal);
      const entry: ObsEntry = {
        ageMinutes:     typeof f.ageMinutes  === 'number' ? f.ageMinutes  : null,
        score:          typeof f.ripperScore  === 'number' ? f.ripperScore  : null,
        priceChangePct: toFiniteNum(f.normalizedSignal.priceChangePct),
        capturedAt:     f.capturedAt,
      };
      const list = obsListMap.get(key);
      if (list) list.push(entry); else obsListMap.set(key, [entry]);
    }
  }

  // Sort each list: ageMinutes asc (nulls last), capturedAt asc as tiebreak
  for (const list of obsListMap.values()) {
    list.sort((a, b) => {
      if (a.ageMinutes != null && b.ageMinutes != null) return a.ageMinutes - b.ageMinutes;
      if (a.ageMinutes != null) return -1;
      if (b.ageMinutes != null) return  1;
      return a.capturedAt.localeCompare(b.capturedAt);
    });
  }

  // Latest obs per key (for display — highest ageMinutes or latest capturedAt)
  const latestObsMap = new Map<string, ObsEntry>();
  for (const [key, list] of obsListMap) {
    const desc = [...list].sort((a, b) => {
      if (a.ageMinutes != null && b.ageMinutes != null) return b.ageMinutes - a.ageMinutes;
      if (a.ageMinutes != null) return -1;
      if (b.ageMinutes != null) return  1;
      return b.capturedAt.localeCompare(a.capturedAt);
    });
    latestObsMap.set(key, desc[0]);
  }

  // ── Step 3: Read outcome data ───────────────────────────────────────────────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;
  let outcomesRead        = 0;

  interface OutcomeEntry { pctChangeFromEntry: number | null; checkpointAt: string }
  const outcomeMap = new Map<string, OutcomeEntry>();

  for (const p of options.outcomePaths) {
    if (!fs.existsSync(p)) { outcomeFilesMissing++; continue; }
    outcomeFilesRead++;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }

    const rec = parsed as Record<string, unknown>;
    const fileCheckpointAt =
      typeof rec?.['checkpointAt'] === 'string' ? rec['checkpointAt'] as string
      : typeof rec?.['generatedAt'] === 'string' ? rec['generatedAt'] as string
      : '';

    const cands = Array.isArray(rec?.['candidates'])
      ? rec['candidates'] as Record<string, unknown>[]
      : [];

    for (const c of cands) {
      const key = typeof c['contractKey'] === 'string' ? c['contractKey'] : null;
      if (!key) continue;
      outcomesRead++;
      const ckAt = typeof c['checkpointAt'] === 'string' ? c['checkpointAt'] : fileCheckpointAt;
      const existing = outcomeMap.get(key);
      if (!existing || ckAt >= existing.checkpointAt) {
        outcomeMap.set(key, { pctChangeFromEntry: toFiniteNum(c['pctChangeFromEntry']), checkpointAt: ckAt });
      }
    }
  }

  // ── Step 4: Simulate each rule for each candidate ──────────────────────────
  const rules: ExitRuleSummary[] = EXIT_RULES.map(rule => {
    const candidates: ExitSimCandidateResult[] = [];

    for (const [key, approval] of approvalMap) {
      const approvalScore          = typeof approval.ripperScore === 'number' ? approval.ripperScore : null;
      const approvalAgeMinutes     = typeof approval.ageMinutes  === 'number' ? approval.ageMinutes  : null;
      const approvalPriceChangePct = toFiniteNum(approval.normalizedSignal.priceChangePct);
      const raw                    = approval.raw as Record<string, unknown> | undefined;
      const entryPriceUsd          = toFiniteNum(raw?.['priceUsd'] ?? null);

      const obsList    = obsListMap.get(key) ?? [];
      const latestObs  = latestObsMap.get(key);
      const outcome    = outcomeMap.get(key);
      const outcomePct = outcome?.pctChangeFromEntry ?? null;

      const ctx: SimContext = {
        approvalPriceChangePct,
        observations: obsList,
        outcomePct,
      };

      const { reason, result } = rule.simulate(ctx);

      const classification: ExitSimClassification =
        result == null && obsList.length === 0 && outcomePct == null ? 'PENDING_PRICE'
        : result == null && obsList.length >  0 && outcomePct == null ? 'NO_EXIT_SIGNAL'
        : classifyExit(result);

      candidates.push({
        contractKey:             key,
        symbol:                  approval.normalizedSignal.symbol,
        approvalScore,
        approvalAgeMinutes,
        approvalPriceChangePct,
        entryPriceUsd,
        latestObsAgeMinutes:     latestObs?.ageMinutes     ?? null,
        latestObsScore:          latestObs?.score          ?? null,
        latestObsPriceChangePct: latestObs?.priceChangePct ?? null,
        outcomePctChange:        outcomePct,
        exitReason:              reason,
        simulatedPctResult:      result,
        classification,
      });
    }

    candidates.sort((a, b) => {
      if (a.simulatedPctResult != null && b.simulatedPctResult != null) {
        return b.simulatedPctResult - a.simulatedPctResult;
      }
      if (a.simulatedPctResult != null) return -1;
      if (b.simulatedPctResult != null) return  1;
      return 0;
    });

    const priced    = candidates.filter(c => c.simulatedPctResult != null);
    const wins      = priced.filter(c => c.classification === 'WIN');
    const losses    = priced.filter(c => c.classification === 'LOSS');
    const breakeven = priced.filter(c => c.classification === 'BREAKEVEN');
    const pending   = candidates.filter(c => c.classification === 'PENDING_PRICE');
    const noExit    = candidates.filter(c => c.classification === 'NO_EXIT_SIGNAL');

    const avoidedCrushed = candidates.filter(
      c => c.outcomePctChange != null && c.outcomePctChange <= -25
        && c.simulatedPctResult != null && c.simulatedPctResult > c.outcomePctChange,
    ).length;

    const capturedEarlyWinner = candidates.filter(
      c => c.outcomePctChange != null && c.outcomePctChange > 0
        && c.simulatedPctResult != null && c.simulatedPctResult > 0,
    ).length;

    const pctResults = priced.map(c => c.simulatedPctResult!);

    return {
      ruleId:              rule.id,
      ruleLabel:           rule.label,
      candidatesEvaluated: candidates.length,
      pricedCandidates:    priced.length,
      pendingPrice:        pending.length,
      wins:                wins.length,
      losses:              losses.length,
      breakeven:           breakeven.length,
      noExitSignal:        noExit.length,
      winRate:             priced.length > 0 ? (wins.length / priced.length) * 100 : null,
      avgPctResult:        avgOf(pctResults.map(x => x)),
      medianPctResult:     medianOf(pctResults),
      bestCandidate:       priced.length > 0 ? priced[0] : null,
      worstCandidate:      priced.length > 0 ? priced[priced.length - 1] : null,
      avoidedCrushed,
      capturedEarlyWinner,
      candidates,
    };
  });

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
    matchedCandidates: approvalMap.size,
    rules,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '  n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtScore(n: number | null | undefined): string {
  return n != null ? String(Math.round(n)).padStart(3) : '  ?';
}

function fmtAge(m: number | null | undefined): string {
  if (m == null) return 'n/a';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

export function renderRipperExitSim(result: RipperExitSimResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EXIT SIMULATOR');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — RESEARCH USE ONLY]');
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
  lines.push(`    Matched candidates: ${result.matchedCandidates}`);
  lines.push('');
  lines.push('  Note: observation priceChangePct = pct from pool creation; exit prices');
  lines.push('  are relative gains computed from approval priceChangePct. Research use only.');
  lines.push('');

  if (result.matchedCandidates === 0) {
    lines.push('  (no candidates — check --approvals paths)');
    lines.push('');
    lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
    lines.push(SEP);
    lines.push('');
    return lines.join('\n');
  }

  // ── Per-rule summary table ──────────────────────────────────────────────────
  lines.push('  — RULE COMPARISON ────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(
    '  Rule                              W  L  pending winRate avgPct median  avdCrush capEW',
  );
  lines.push(`  ${SEP2}`);

  for (const r of result.rules) {
    const label    = r.ruleLabel.padEnd(32).slice(0, 32);
    const winRate  = r.winRate != null ? `${r.winRate.toFixed(0)}%`.padStart(5) : '  n/a';
    const avgPct   = r.avgPctResult   != null ? fmtPct(r.avgPctResult).padStart(6)   : '   n/a';
    const medPct   = r.medianPctResult != null ? fmtPct(r.medianPctResult).padStart(6) : '   n/a';
    lines.push(
      `  ${label} ${String(r.wins).padStart(2)} ${String(r.losses).padStart(2)}` +
      `  ${String(r.pendingPrice).padStart(7)} ${winRate}` +
      `  ${avgPct} ${medPct}` +
      `  ${String(r.avoidedCrushed).padStart(8)} ${String(r.capturedEarlyWinner).padStart(5)}`,
    );
  }
  lines.push('');

  // ── Per-rule detail ─────────────────────────────────────────────────────────
  for (const r of result.rules) {
    lines.push(`  — [${r.ruleId}] ${r.ruleLabel} ${'─'.repeat(Math.max(0, 46 - r.ruleLabel.length))}`);
    lines.push(
      `    Evaluated: ${r.candidatesEvaluated}  priced: ${r.pricedCandidates}` +
      `  wins: ${r.wins}  losses: ${r.losses}  pending: ${r.pendingPrice}` +
      (r.noExitSignal > 0 ? `  no-exit-signal: ${r.noExitSignal}` : ''),
    );
    if (r.bestCandidate) {
      const b = r.bestCandidate;
      const sym = b.symbol ? `$${b.symbol}` : shortKey(b.contractKey);
      lines.push(`    Best : ${sym} → ${fmtPct(b.simulatedPctResult)} (outcome: ${fmtPct(b.outcomePctChange)}) [${b.exitReason}]`);
    }
    if (r.worstCandidate) {
      const w = r.worstCandidate;
      const sym = w.symbol ? `$${w.symbol}` : shortKey(w.contractKey);
      lines.push(`    Worst: ${sym} → ${fmtPct(w.simulatedPctResult)} (outcome: ${fmtPct(w.outcomePctChange)}) [${w.exitReason}]`);
    }
    lines.push('');
    lines.push(
      '    sym/addr         aprvScr aprvAge obsScr  obsAge  aprvPct simResult outcome         classification    exitReason',
    );
    for (const c of r.candidates) {
      const sym = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push(
        `    ${sym.padEnd(16)} ${fmtScore(c.approvalScore).padEnd(7)} ${fmtAge(c.approvalAgeMinutes).padEnd(7)}` +
        ` ${fmtScore(c.latestObsScore).padEnd(7)} ${fmtAge(c.latestObsAgeMinutes).padEnd(7)}` +
        ` ${fmtPct(c.approvalPriceChangePct).padEnd(8)} ${fmtPct(c.simulatedPctResult).padEnd(8)}` +
        ` ${fmtPct(c.outcomePctChange).padEnd(8)}` +
        ` ${c.classification.padEnd(17)} ${c.exitReason}`,
      );
    }
    lines.push('');
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperExitSimUsage(): string {
  return `
token:ripper-exit-sim — simulate paper exits for approved candidates

Usage:
  npm run token:ripper-exit-sim -- \\
    --approvals    <cycle-jsonl...>   \\
    --observations <obs-jsonl...>     \\
    --outcomes     <outcome-json...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (from data/token-grab/ripper/observations/)
  --outcomes     <paths>   approved outcome JSON checkpoint files
  --help                   show this message

Exit rules simulated:
  1. hold-to-checkpoint      — use outcome pctChange directly
  2. tp5-sl10                — TP +5%, SL -10%
  3. tp10-sl10               — TP +10%, SL -10%
  4. tp20-sl15               — TP +20%, SL -15%
  5. tp30-sl20               — TP +30%, SL -20%
  6. score-exit-75           — exit when obs score drops below 75
  7. score-exit-60           — exit when obs score drops below 60
  8. force-exit-5m           — exit at observation closest to 5 minutes old
  9. force-exit-8m           — exit at observation closest to 8 minutes old
 10. hybrid-tp10-sl10-score75 — TP +10% / SL -10% or score < 75, whichever first

Note: Observation priceChangePct values are pct-from-pool-creation.
Exit prices are computed as relative gain from approval entry. Research simulator only.

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
