import type { TokenGrabLane, TokenGrabDecision } from './types';

// ── Thresholds ────────────────────────────────────────────────────────────────

export const RUN_GAIN_PCT = 100;
export const DIED_DRAWDOWN_PCT = -70;
export const LIQUIDITY_DROP_PCT = -60;
export const MIN_SNAPSHOTS_FOR_PRICE_OUTCOME = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

export type TokenGrabAutopsyOutcome =
  | 'RAN'
  | 'DIED'
  | 'FLAT'
  | 'TOO_EARLY'
  | 'INSUFFICIENT_DATA';

export type TokenGrabAutopsyVerdict =
  | 'GOOD_WATCH'
  | 'MISSED_RUN'
  | 'GOOD_REJECT'
  | 'BAD_REJECT'
  | 'NO_SIGNAL'
  | 'NEEDS_MORE_DATA';

export interface TokenGrabAutopsyCandidate {
  id: string;
  tokenName: string;
  ticker: string;
  contractAddress?: string;
  poolAddress?: string;
  lane: TokenGrabLane;
  decision: TokenGrabDecision;
  scoreAtDetection: number;
  detectedAt: string;
  poolCreatedAt?: string;
  reasons: string[];
  redFlags: string[];
}

export interface TokenGrabAutopsySnapshot {
  candidateId: string;
  observedAt: string;
  minutesAfterDetection: number;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  marketCapUsd?: number;
  holders?: number;
  source: string;
}

export interface TokenGrabAutopsyResult {
  candidateId: string;
  tokenName: string;
  ticker: string;
  lane: TokenGrabLane;
  decision: TokenGrabDecision;
  scoreAtDetection: number;
  outcome: TokenGrabAutopsyOutcome;
  maxGainPct?: number;
  maxDrawdownPct?: number;
  liquidityChangePct?: number;
  volumePeakUsd?: number;
  firstRunAtMinutes?: number;
  verdict: TokenGrabAutopsyVerdict;
  lessons: string[];
  noTradingExecuted: true;
}

export interface TokenGrabAutopsyReport {
  generatedAt: string;
  mode: 'fixture-only' | 'session-file';
  tradingStatus: 'LOCKED / NO TRADING EXECUTED';
  results: TokenGrabAutopsyResult[];
  summary: {
    candidatesReviewed: number;
    ran: number;
    died: number;
    flat: number;
    tooEarly: number;
    insufficientData: number;
    goodWatches: number;
    missedRuns: number;
    goodRejects: number;
    badRejects: number;
    tradingExecuted: 0;
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function deriveVerdict(
  decision: TokenGrabDecision,
  outcome: TokenGrabAutopsyOutcome,
): TokenGrabAutopsyVerdict {
  if (outcome === 'INSUFFICIENT_DATA' || outcome === 'TOO_EARLY') return 'NEEDS_MORE_DATA';
  if (outcome === 'RAN') {
    if (decision === 'REJECT') return 'BAD_REJECT';
    if (decision === 'ALERT_ONLY') return 'GOOD_WATCH';
    return 'MISSED_RUN';
  }
  if (outcome === 'DIED') {
    if (decision === 'REJECT') return 'GOOD_REJECT';
    return 'NO_SIGNAL';
  }
  // FLAT
  if (decision === 'REJECT') return 'GOOD_REJECT';
  return 'NO_SIGNAL';
}

function deriveLessons(
  outcome: TokenGrabAutopsyOutcome,
  verdict: TokenGrabAutopsyVerdict,
): string[] {
  switch (verdict) {
    case 'GOOD_WATCH':
      return [
        'Social-confirmed fresh launch later ran.',
        'Keep watching similar setup.',
      ];
    case 'BAD_REJECT':
      return ['Rejected candidate later ran; inspect red flags/scoring.'];
    case 'GOOD_REJECT':
      if (outcome === 'DIED') return ['Spam/no-context rejection was correct.'];
      return ['Low-signal pool stayed flat; rejection score held.'];
    case 'MISSED_RUN':
      return ['Pre-launch watch later ran; consider faster lane escalation on similar setups.'];
    case 'NO_SIGNAL':
      return ['Outcome was unclear or contrary to expectation; more context needed.'];
    case 'NEEDS_MORE_DATA':
      if (outcome === 'TOO_EARLY') return ['No pool or snapshots yet; candidate is pre-formation.'];
      return ['Not enough price snapshots to determine outcome.'];
  }
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Computes the autopsy result for one candidate given its price/liquidity snapshots.
 * Pure function — no network calls, no DB writes.
 */
export function buildAutopsyResult(
  candidate: TokenGrabAutopsyCandidate,
  snapshots: TokenGrabAutopsySnapshot[],
): TokenGrabAutopsyResult {
  const sorted = [...snapshots].sort((a, b) => a.minutesAfterDetection - b.minutesAfterDetection);
  const priceSnaps = sorted.filter(s => s.priceUsd != null && s.priceUsd > 0);
  const liqSnaps = sorted.filter(s => s.liquidityUsd != null);
  const volSnaps = sorted.filter(s => s.volumeUsd != null);

  const volumePeakUsd =
    volSnaps.length > 0 ? Math.max(...volSnaps.map(s => s.volumeUsd!)) : undefined;

  if (priceSnaps.length < MIN_SNAPSHOTS_FOR_PRICE_OUTCOME) {
    const isPreFormation =
      candidate.lane === 'PRE_LAUNCH_WATCH' || candidate.lane === 'MEME_EVENT_CANDIDATE';
    const outcome: TokenGrabAutopsyOutcome =
      priceSnaps.length === 0 && isPreFormation ? 'TOO_EARLY' : 'INSUFFICIENT_DATA';
    const verdict = deriveVerdict(candidate.decision, outcome);
    return {
      candidateId: candidate.id,
      tokenName: candidate.tokenName,
      ticker: candidate.ticker,
      lane: candidate.lane,
      decision: candidate.decision,
      scoreAtDetection: candidate.scoreAtDetection,
      outcome,
      volumePeakUsd,
      verdict,
      lessons: deriveLessons(outcome, verdict),
      noTradingExecuted: true,
    };
  }

  const baseline = priceSnaps[0]!.priceUsd!;
  const priceSnapsAfterBaseline = priceSnaps.slice(1);
  const gains = priceSnapsAfterBaseline.map(s => ((s.priceUsd! - baseline) / baseline) * 100);

  const maxGainPct = gains.length > 0 ? Math.max(...gains) : 0;
  const minReturnPct = gains.length > 0 ? Math.min(...gains) : 0;
  const maxDrawdownPct = minReturnPct < 0 ? minReturnPct : undefined;

  let liquidityChangePct: number | undefined;
  if (liqSnaps.length >= 2) {
    const firstLiq = liqSnaps[0]!.liquidityUsd!;
    const lastLiq = liqSnaps[liqSnaps.length - 1]!.liquidityUsd!;
    if (firstLiq > 0) liquidityChangePct = ((lastLiq - firstLiq) / firstLiq) * 100;
  }

  const firstRunAtMinutes = priceSnapsAfterBaseline.find(
    (s, i) => (gains[i] ?? 0) >= RUN_GAIN_PCT,
  )?.minutesAfterDetection;

  let outcome: TokenGrabAutopsyOutcome;
  if (maxGainPct >= RUN_GAIN_PCT) {
    outcome = 'RAN';
  } else if (
    (maxDrawdownPct !== undefined && maxDrawdownPct <= DIED_DRAWDOWN_PCT) ||
    (liquidityChangePct !== undefined && liquidityChangePct <= LIQUIDITY_DROP_PCT)
  ) {
    outcome = 'DIED';
  } else {
    outcome = 'FLAT';
  }

  const verdict = deriveVerdict(candidate.decision, outcome);

  return {
    candidateId: candidate.id,
    tokenName: candidate.tokenName,
    ticker: candidate.ticker,
    lane: candidate.lane,
    decision: candidate.decision,
    scoreAtDetection: candidate.scoreAtDetection,
    outcome,
    maxGainPct: maxGainPct > 0 ? maxGainPct : undefined,
    maxDrawdownPct,
    liquidityChangePct,
    volumePeakUsd,
    firstRunAtMinutes,
    verdict,
    lessons: deriveLessons(outcome, verdict),
    noTradingExecuted: true,
  };
}

export function buildTokenGrabAutopsyReport(
  candidates: TokenGrabAutopsyCandidate[],
  snapshots: TokenGrabAutopsySnapshot[],
  options?: { mode?: TokenGrabAutopsyReport['mode'] },
): TokenGrabAutopsyReport {
  const results = candidates.map(c =>
    buildAutopsyResult(c, snapshots.filter(s => s.candidateId === c.id)),
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: options?.mode ?? 'fixture-only',
    tradingStatus: 'LOCKED / NO TRADING EXECUTED',
    results,
    summary: {
      candidatesReviewed: results.length,
      ran: results.filter(r => r.outcome === 'RAN').length,
      died: results.filter(r => r.outcome === 'DIED').length,
      flat: results.filter(r => r.outcome === 'FLAT').length,
      tooEarly: results.filter(r => r.outcome === 'TOO_EARLY').length,
      insufficientData: results.filter(r => r.outcome === 'INSUFFICIENT_DATA').length,
      goodWatches: results.filter(r => r.verdict === 'GOOD_WATCH').length,
      missedRuns: results.filter(r => r.verdict === 'MISSED_RUN').length,
      goodRejects: results.filter(r => r.verdict === 'GOOD_REJECT').length,
      badRejects: results.filter(r => r.verdict === 'BAD_REJECT').length,
      tradingExecuted: 0,
    },
  };
}

export function renderTokenGrabAutopsyReport(report: TokenGrabAutopsyReport): string {
  const WIDE = '═'.repeat(62);
  const THIN = '─'.repeat(62);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  Token Grab Ears Autopsy');
  lines.push(`  Mode    : ${report.mode}`);
  lines.push(`  Trading : ${report.tradingStatus}`);
  lines.push(`  Time    : ${report.generatedAt}`);
  lines.push(WIDE);
  lines.push('');

  for (const r of report.results) {
    lines.push(THIN);
    lines.push(`Candidate: ${r.ticker}`);
    lines.push(THIN);
    lines.push(`Lane at detection     : ${r.lane}`);
    lines.push(`Decision at detection : ${r.decision}`);
    lines.push(`Score at detection    : ${r.scoreAtDetection}`);
    lines.push(`Outcome               : ${r.outcome}`);
    if (r.maxGainPct != null) {
      lines.push(`Max gain              : +${r.maxGainPct.toFixed(0)}%`);
    }
    if (r.maxDrawdownPct != null) {
      lines.push(`Max drawdown          : ${r.maxDrawdownPct.toFixed(0)}%`);
    }
    if (r.liquidityChangePct != null) {
      const sign = r.liquidityChangePct > 0 ? '+' : '';
      lines.push(`Liquidity change      : ${sign}${r.liquidityChangePct.toFixed(0)}%`);
    }
    if (r.firstRunAtMinutes != null) {
      lines.push(`First run             : ${r.firstRunAtMinutes} minutes after detection`);
    }
    lines.push(`Verdict               : ${r.verdict}`);
    if (r.lessons.length > 0) {
      lines.push('Lessons:');
      for (const l of r.lessons) lines.push(`  - ${l}`);
    }
    lines.push('');
    lines.push('  NO TRADING EXECUTED');
    lines.push('');
  }

  lines.push(WIDE);
  lines.push('Summary');
  lines.push(WIDE);
  lines.push(`  Candidates reviewed : ${report.summary.candidatesReviewed}`);
  lines.push(`  Ran                 : ${report.summary.ran}`);
  lines.push(`  Died                : ${report.summary.died}`);
  lines.push(`  Flat                : ${report.summary.flat}`);
  lines.push(`  Too early           : ${report.summary.tooEarly}`);
  lines.push(`  Insufficient data   : ${report.summary.insufficientData}`);
  lines.push(`  Good watches        : ${report.summary.goodWatches}`);
  lines.push(`  Missed runs         : ${report.summary.missedRuns}`);
  lines.push(`  Good rejects        : ${report.summary.goodRejects}`);
  lines.push(`  Bad rejects         : ${report.summary.badRejects}`);
  lines.push(`  Trading executed    : ${report.summary.tradingExecuted}`);
  lines.push('');
  lines.push('  NO TRADING EXECUTED. Report only. No positions opened.');
  lines.push(WIDE);

  return lines.join('\n');
}
