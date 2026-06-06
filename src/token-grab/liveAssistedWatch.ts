import type { TokenGrabAutopsyCandidate, TokenGrabAutopsyResult, TokenGrabAutopsySnapshot } from './autopsy';
import type { TokenGrabLane } from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_BUY_ELIGIBLE_LANES: ReadonlySet<TokenGrabLane> = new Set([
  'EARLY_VELOCITY_WATCH',
  'FRESH_LAUNCH_CANDIDATE',
]);

const CANDIDATE_LANE_PRIORITY: Record<string, number> = {
  EARLY_VELOCITY_WATCH: 0,
  FRESH_LAUNCH_CANDIDATE: 1,
  PRE_LAUNCH_WATCH: 2,
  MEME_EVENT_CANDIDATE: 3,
};

const MIN_ENTRY_LIQUIDITY_USD = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveAssistedDecision = 'FAKE_BUY' | 'NO_BUY';
export type LiveAssistedPnLOutcome = 'GAIN' | 'LOSS' | 'FLAT' | 'UNKNOWN';

export interface FakeBuyRecord {
  candidateId: string;
  tokenName: string;
  ticker: string;
  lane: TokenGrabLane;
  fakePositionSize: number;
  fakeEntryPrice: number;
  fakeLiquidityAtEntry: number;
  fakeTokensHeld: number;
  paperStopNote: string;
  fakeExitRule: string;
}

export interface LiveAssistedPnL {
  outcome: LiveAssistedPnLOutcome;
  fakePositionSize: number;
  fakeEntryPrice: number;
  fakeExitPrice?: number;
  fakeTokensHeld: number;
  fakeEndingValue: number;
  pnlDollars: number;
  pnlPct: number;
  endingBankroll: number;
}

export interface LiveAssistedSummary {
  ts: string;
  sessionPath: string;
  entrySnapshotPath: string;
  exitSnapshotPath: string;
  fakeBankroll: number;
  maxFakePosition: number;
  watchMinutes: number;
  candidatesDetected: number;
  laneSummary: Record<string, number>;
  watchWorthyCount: number;
  decision: LiveAssistedDecision;
  noBuyReason?: string;
  selectedTicker?: string;
  selectedLane?: string;
  fakeBuy?: FakeBuyRecord;
  fakePnL?: LiveAssistedPnL;
  endingBankroll: number;
  autopsyVerdict?: string;
  autopsyOutcome?: string;
  lessons: string[];
  skipSleepMode: boolean;
  noRealTradingExecuted: true;
  autoPaperNotRun: true;
  noWalletOrSwapUsed: true;
}

// ── Input for buildLiveAssistedSummary ────────────────────────────────────────

export interface BuildLiveAssistedSummaryInput {
  ts: string;
  sessionPath: string;
  entrySnapshotPath: string;
  exitSnapshotPath: string;
  fakeBankroll: number;
  maxFakePosition: number;
  watchMinutes: number;
  candidatesDetected: number;
  laneSummary: Record<string, number>;
  watchWorthyCount: number;
  decision: LiveAssistedDecision;
  noBuyReason?: string;
  fakeBuy?: FakeBuyRecord;
  fakePnL?: LiveAssistedPnL;
  autopsyResult?: TokenGrabAutopsyResult;
  skipSleepMode: boolean;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Picks the best candidate from the watch list for a fake buy consideration.
 * Prefers EARLY_VELOCITY_WATCH, then FRESH_LAUNCH_CANDIDATE, then others.
 * Within each tier, prefers candidates with a valid price snapshot.
 * Returns undefined only if watchCandidates is empty.
 */
export function chooseLiveAssistedCandidate(
  watchCandidates: TokenGrabAutopsyCandidate[],
  entrySnapshots: TokenGrabAutopsySnapshot[],
): { candidate: TokenGrabAutopsyCandidate; snapshot: TokenGrabAutopsySnapshot | undefined } | undefined {
  if (watchCandidates.length === 0) return undefined;

  const sorted = [...watchCandidates].sort((a, b) => {
    const pa = CANDIDATE_LANE_PRIORITY[a.lane] ?? 99;
    const pb = CANDIDATE_LANE_PRIORITY[b.lane] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.scoreAtDetection - a.scoreAtDetection;
  });

  const snapshotMap = new Map(entrySnapshots.map(s => [s.candidateId, s]));

  // Prefer a candidate that has a valid priced snapshot
  for (const c of sorted) {
    const snap = snapshotMap.get(c.id);
    if (snap && snap.priceUsd != null && snap.priceUsd > 0) {
      return { candidate: c, snapshot: snap };
    }
  }

  // Fall back to first sorted candidate even without a valid snapshot
  return { candidate: sorted[0]!, snapshot: snapshotMap.get(sorted[0]!.id) };
}

/**
 * Returns true only when all conservative fake-buy criteria are satisfied.
 * Pure — no I/O, no network, no trading execution.
 */
export function isFakeBuyEligible(
  candidate: TokenGrabAutopsyCandidate,
  snapshot: TokenGrabAutopsySnapshot | undefined,
  maxPosition: number,
  bankroll: number,
): boolean {
  if (!FAKE_BUY_ELIGIBLE_LANES.has(candidate.lane)) return false;
  if (!snapshot) return false;
  if (!snapshot.priceUsd || snapshot.priceUsd <= 0) return false;
  if (!snapshot.liquidityUsd || snapshot.liquidityUsd < MIN_ENTRY_LIQUIDITY_USD) return false;
  if (maxPosition > bankroll) return false;
  return true;
}

/**
 * Returns the actual fake position size: min(maxPosition, bankroll).
 * Ensures we never paper-risk more than the bankroll.
 */
export function calculateFakePosition(bankroll: number, maxPosition: number): number {
  return Math.min(maxPosition, bankroll);
}

/**
 * Calculates fake P/L from entry to exit.
 * Returns outcome UNKNOWN when exitPrice is missing or zero.
 * Pure — no I/O, no trading execution.
 */
export function calculateFakePnL(
  positionSize: number,
  entryPrice: number,
  fakeTokensHeld: number,
  exitPrice: number | undefined,
  bankroll: number,
): LiveAssistedPnL {
  if (!exitPrice || exitPrice <= 0) {
    return {
      outcome: 'UNKNOWN',
      fakePositionSize: positionSize,
      fakeEntryPrice: entryPrice,
      fakeTokensHeld,
      fakeEndingValue: positionSize,
      pnlDollars: 0,
      pnlPct: 0,
      endingBankroll: bankroll,
    };
  }

  const fakeEndingValue = fakeTokensHeld * exitPrice;
  const pnlDollars = fakeEndingValue - positionSize;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  const endingBankroll = bankroll - positionSize + fakeEndingValue;

  let outcome: LiveAssistedPnLOutcome;
  if (pnlPct >= 10) outcome = 'GAIN';
  else if (pnlPct <= -10) outcome = 'LOSS';
  else outcome = 'FLAT';

  return {
    outcome,
    fakePositionSize: positionSize,
    fakeEntryPrice: entryPrice,
    fakeExitPrice: exitPrice,
    fakeTokensHeld,
    fakeEndingValue,
    pnlDollars,
    pnlPct,
    endingBankroll,
  };
}

/**
 * Assembles the complete live-assisted summary from all computed pieces.
 * Pure — no I/O, no network calls.
 */
export function buildLiveAssistedSummary(input: BuildLiveAssistedSummaryInput): LiveAssistedSummary {
  const endingBankroll = input.fakePnL != null
    ? input.fakePnL.endingBankroll
    : input.fakeBankroll;

  return {
    ts: input.ts,
    sessionPath: input.sessionPath,
    entrySnapshotPath: input.entrySnapshotPath,
    exitSnapshotPath: input.exitSnapshotPath,
    fakeBankroll: input.fakeBankroll,
    maxFakePosition: input.maxFakePosition,
    watchMinutes: input.watchMinutes,
    candidatesDetected: input.candidatesDetected,
    laneSummary: input.laneSummary,
    watchWorthyCount: input.watchWorthyCount,
    decision: input.decision,
    noBuyReason: input.noBuyReason,
    selectedTicker: input.fakeBuy?.ticker,
    selectedLane: input.fakeBuy?.lane,
    fakeBuy: input.fakeBuy,
    fakePnL: input.fakePnL,
    endingBankroll,
    autopsyVerdict: input.autopsyResult?.verdict,
    autopsyOutcome: input.autopsyResult?.outcome,
    lessons: input.autopsyResult?.lessons ?? [],
    skipSleepMode: input.skipSleepMode,
    noRealTradingExecuted: true,
    autoPaperNotRun: true,
    noWalletOrSwapUsed: true,
  };
}

/**
 * Renders the live-assisted summary as a readable terminal report.
 * Always includes safety confirmation lines. No trading instructions.
 */
export function renderLiveAssistedReport(s: LiveAssistedSummary): string {
  const WIDE = '═'.repeat(62);
  const THIN = '─'.repeat(62);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  LIVE-ASSISTED PAPER WATCH — Final Report');
  lines.push(`  TS              : ${s.ts}`);
  lines.push(`  Fake bankroll   : $${s.fakeBankroll}`);
  lines.push(`  Max position    : $${s.maxFakePosition}`);
  lines.push(`  Watch minutes   : ${s.watchMinutes}`);
  if (s.skipSleepMode) lines.push('  [skip-sleep mode was active]');
  lines.push(WIDE);
  lines.push('');

  lines.push(THIN);
  lines.push('Detection');
  lines.push(THIN);
  lines.push(`  Session         : ${s.sessionPath}`);
  lines.push(`  Candidates      : ${s.candidatesDetected}`);
  lines.push(`  Watch-worthy    : ${s.watchWorthyCount}`);
  for (const [lane, count] of Object.entries(s.laneSummary)) {
    lines.push(`    ${lane}: ${count}`);
  }
  lines.push('');

  lines.push(THIN);
  lines.push('Snapshots');
  lines.push(THIN);
  lines.push(`  Entry           : ${s.entrySnapshotPath}`);
  lines.push(`  Exit            : ${s.exitSnapshotPath}`);
  lines.push('');

  lines.push(THIN);
  lines.push(`Paper Decision    : ${s.decision}`);
  lines.push(THIN);

  if (s.decision === 'NO_BUY') {
    lines.push(`  Reason          : ${s.noBuyReason ?? 'Criteria not met.'}`);
    lines.push(`  Ending bankroll : $${s.fakeBankroll.toFixed(2)} (unchanged)`);
    lines.push(`  Fake P/L        : $0.00 / 0.00%`);
  } else if (s.fakeBuy) {
    lines.push(`  Token           : $${s.fakeBuy.ticker} (${s.fakeBuy.lane})`);
    lines.push(`  Position size   : $${s.fakeBuy.fakePositionSize.toFixed(2)}`);
    lines.push(`  Entry price     : $${s.fakeBuy.fakeEntryPrice.toExponential(4)}`);
    lines.push(`  Tokens held     : ${s.fakeBuy.fakeTokensHeld.toFixed(6)}`);
    lines.push(`  Liquidity entry : $${s.fakeBuy.fakeLiquidityAtEntry.toFixed(0)}`);
    lines.push(`  Stop note       : ${s.fakeBuy.paperStopNote}`);
    lines.push(`  Exit rule       : ${s.fakeBuy.fakeExitRule}`);

    if (s.fakePnL) {
      lines.push('');
      lines.push(`  Exit price      : ${s.fakePnL.fakeExitPrice != null ? `$${s.fakePnL.fakeExitPrice.toExponential(4)}` : '(unavailable)'}`);
      lines.push(`  Ending value    : $${s.fakePnL.fakeEndingValue.toFixed(4)}`);
      const sign = s.fakePnL.pnlDollars >= 0 ? '+' : '';
      lines.push(`  Fake P/L        : ${sign}$${s.fakePnL.pnlDollars.toFixed(4)} / ${sign}${s.fakePnL.pnlPct.toFixed(2)}%`);
      lines.push(`  Outcome         : ${s.fakePnL.outcome}`);
      lines.push(`  Ending bankroll : $${s.fakePnL.endingBankroll.toFixed(4)}`);
    }
  }
  lines.push('');

  if (s.autopsyVerdict || s.autopsyOutcome) {
    lines.push(THIN);
    lines.push('Autopsy');
    lines.push(THIN);
    if (s.autopsyVerdict) lines.push(`  Verdict         : ${s.autopsyVerdict}`);
    if (s.autopsyOutcome) lines.push(`  Outcome         : ${s.autopsyOutcome}`);
    if (s.lessons.length > 0) {
      lines.push('  Lessons:');
      for (const l of s.lessons) lines.push(`    - ${l}`);
    }
    lines.push('');
  }

  lines.push(WIDE);
  lines.push('  NO REAL TRADING EXECUTED');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  No wallet, private key, or swap used');
  lines.push('  Paper simulation only — no positions opened');
  lines.push(WIDE);

  return lines.join('\n');
}
