// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Watch-profile outcome report — reads watch-profile-enrollments.jsonl and
// learning-memory.jsonl and reports per-profile win rates, lift vs enrolled
// baseline, and a recommendation.
// DOES NOT change any gate, policy, or trading decision.

import * as fs from 'fs';

// ── Shared types ──────────────────────────────────────────────────────────────

interface EnrollmentRow {
  contract:     string;
  profileName:  string;
  profileLabel: string;
  capturedAt?:  string;
  enrolledAt?:  string;
}

interface MemoryRow {
  contract?:         string;
  outcomeLabel?:     string | null;
  priceChangePct?:   number | null;
  memoryUniverse?:   string | null;
  gateDecision?:     string | null;
  [k: string]: unknown;
}

// ── Outcome classification ────────────────────────────────────────────────────

// win5  : BIG_WINNER or WINNER  (≥+5% or ≥+3% with ≥+5% peak — use outcomeLabel)
// win3  : BIG_WINNER or WINNER or SMALL_WINNER
// win1  : any winner
// flatDump: FLAT_JUNK or DUMP

function classify(outcomeLabel: string | null | undefined): {
  win5: boolean; win3: boolean; win1: boolean; flatDump: boolean;
} {
  const lbl = outcomeLabel ?? '';
  return {
    win5:     lbl === 'BIG_WINNER' || lbl === 'WINNER',
    win3:     lbl === 'BIG_WINNER' || lbl === 'WINNER' || lbl === 'SMALL_WINNER',
    win1:     lbl === 'BIG_WINNER' || lbl === 'WINNER' || lbl === 'SMALL_WINNER',
    flatDump: lbl === 'FLAT_JUNK'  || lbl === 'DUMP',
  };
}

// ── Recommendation logic ──────────────────────────────────────────────────────

export type WatchProfileRecommendation =
  | 'NEEDS_MORE_DATA'
  | 'WATCH_PROFILE_PROMISING'
  | 'WATCH_PROFILE_HOLD'
  | 'WATCH_PROFILE_REJECT';

function recommend(
  observed:  number,
  win5Rate:  number,   // 0–1
  win1Rate:  number,   // 0–1
  flatDump:  number,   // 0–1
  win5Lift:  number | null,
): WatchProfileRecommendation {
  if (observed < 75) return 'NEEDS_MORE_DATA';
  if (flatDump > 0.80) return 'WATCH_PROFILE_REJECT';
  if (
    win5Lift != null && win5Lift >= 1.5 &&
    win1Rate >= 0.35 &&
    flatDump <= 0.65
  ) return 'WATCH_PROFILE_PROMISING';
  return 'WATCH_PROFILE_HOLD';
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface WatchProfileOutcomeEntry {
  profileName:    string;
  profileLabel:   string;
  enrolled:       number;
  observed:       number;
  unobserved:     number;
  win5Count:      number;
  win3Count:      number;
  win1Count:      number;
  flatDumpCount:  number;
  win5Rate:       number | null;  // 0–1, null if observed=0
  win3Rate:       number | null;
  win1Rate:       number | null;
  flatDumpRate:   number | null;
  avgMove:        number | null;
  medianMove:     number | null;
  win5Lift:       number | null;  // vs enrolled-universe baseline
  recommendation: WatchProfileRecommendation;
}

export interface WatchProfileOutcomeResult {
  enrollmentsRead:   number;
  memoryRowsRead:    number;
  baselineWin5Rate:  number | null;
  profiles:          WatchProfileOutcomeEntry[];
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

export interface WatchProfileOutcomeOptions {
  enrollmentsPath?:    string;
  learningMemoryPath?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runWatchProfileOutcomeReport(
  options: WatchProfileOutcomeOptions = {},
): WatchProfileOutcomeResult {
  const enrollmentsPath = options.enrollmentsPath
    ?? 'data/token-grab/ripper/watch-profile-enrollments.jsonl';
  const memoryPath = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';

  // ── 1. Load enrollments ───────────────────────────────────────────────────

  const enrollmentLines = readLines(enrollmentsPath);
  let enrollmentsRead = 0;

  // Per-profile: set of enrolled contracts
  const profileContracts = new Map<string, Set<string>>();   // profileName → Set<contract>
  const profileLabels    = new Map<string, string>();         // profileName → label

  for (const line of enrollmentLines) {
    let row: Partial<EnrollmentRow>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.contract || !row.profileName) continue;
    enrollmentsRead++;
    if (!profileContracts.has(row.profileName)) {
      profileContracts.set(row.profileName, new Set());
    }
    profileContracts.get(row.profileName)!.add(row.contract);
    if (row.profileLabel) profileLabels.set(row.profileName, row.profileLabel);
  }

  // ── 2. Load learning memory ───────────────────────────────────────────────

  const memoryLines = readLines(memoryPath);
  let memoryRowsRead = 0;

  // outcome lookup by contract (last observed wins for dedup)
  const outcomeByContract = new Map<string, {
    outcomeLabel: string | null;
    priceChangePct: number | null;
  }>();

  let baselineWin5Count = 0;
  let baselineTotal     = 0;

  for (const line of memoryLines) {
    let row: MemoryRow;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.contract !== 'string' || !row.contract) continue;
    memoryRowsRead++;
    const lbl = (row.outcomeLabel ?? null) as string | null;
    outcomeByContract.set(row.contract, {
      outcomeLabel:   lbl,
      priceChangePct: typeof row.priceChangePct === 'number' ? row.priceChangePct : null,
    });
    if (lbl != null) {
      baselineTotal++;
      if (lbl === 'BIG_WINNER' || lbl === 'WINNER') baselineWin5Count++;
    }
  }

  const baselineWin5Rate = baselineTotal > 0
    ? baselineWin5Count / baselineTotal
    : null;

  // ── 3. Per-profile stats ──────────────────────────────────────────────────

  const profileNames = [...profileContracts.keys()].sort();
  const profiles: WatchProfileOutcomeEntry[] = [];

  for (const profileName of profileNames) {
    const contracts = profileContracts.get(profileName)!;
    const enrolled  = contracts.size;
    const label     = profileLabels.get(profileName) ?? profileName;

    let observed    = 0;
    let win5Count   = 0;
    let win3Count   = 0;
    let win1Count   = 0;
    let flatDumpCount = 0;
    const moves: number[] = [];

    for (const contract of contracts) {
      const outcome = outcomeByContract.get(contract);
      if (!outcome || outcome.outcomeLabel == null) continue;
      observed++;
      const c = classify(outcome.outcomeLabel);
      if (c.win5) win5Count++;
      if (c.win3) win3Count++;
      if (c.win1) win1Count++;
      if (c.flatDump) flatDumpCount++;
      if (outcome.priceChangePct != null) moves.push(outcome.priceChangePct);
    }

    const win5Rate     = observed > 0 ? win5Count  / observed : null;
    const win3Rate     = observed > 0 ? win3Count  / observed : null;
    const win1Rate     = observed > 0 ? win1Count  / observed : null;
    const flatDumpRate = observed > 0 ? flatDumpCount / observed : null;
    const avgMove      = moves.length > 0
      ? moves.reduce((a, b) => a + b, 0) / moves.length
      : null;
    const medianMoveVal = median(moves);

    const win5Lift =
      win5Rate != null && baselineWin5Rate != null && baselineWin5Rate > 0
        ? win5Rate / baselineWin5Rate
        : null;

    profiles.push({
      profileName,
      profileLabel:  label,
      enrolled,
      observed,
      unobserved:    enrolled - observed,
      win5Count,
      win3Count,
      win1Count,
      flatDumpCount,
      win5Rate,
      win3Rate,
      win1Rate,
      flatDumpRate,
      avgMove,
      medianMove:    medianMoveVal,
      win5Lift,
      recommendation: recommend(
        observed,
        win5Rate   ?? 0,
        win1Rate   ?? 0,
        flatDumpRate ?? 0,
        win5Lift,
      ),
    });
  }

  return {
    enrollmentsRead,
    memoryRowsRead,
    baselineWin5Rate,
    profiles,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(v: number | null, digits = 1): string {
  return v == null ? 'n/a' : `${(v * 100).toFixed(digits)}%`;
}

function numStr(v: number | null, digits = 1): string {
  return v == null ? 'n/a' : v.toFixed(digits);
}

export function renderWatchProfileOutcomeReport(
  result: WatchProfileOutcomeResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — WATCH PROFILE OUTCOME REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  DATA SOURCES');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrollments read   : ${result.enrollmentsRead}`);
  lines.push(`  Memory rows read   : ${result.memoryRowsRead}`);
  lines.push(`  Baseline win5 rate : ${pct(result.baselineWin5Rate)}`);
  lines.push(`                       (enrolled-universe: BIG_WINNER | WINNER)`);
  lines.push('');

  if (result.profiles.length === 0) {
    lines.push('  No enrolled profiles found.');
    lines.push('  Run: npm run token:ripper-watch-profile-enroll');
    lines.push('');
  }

  for (const p of result.profiles) {
    lines.push(`  ${SEP2}`);
    lines.push(`  PROFILE: ${p.profileName}`);
    lines.push(`  ${SEP2}`, '');
    lines.push(`  Label          : ${p.profileLabel}`);
    lines.push(`  Enrolled       : ${p.enrolled}`);
    lines.push(`  Observed       : ${p.observed}  (unobserved: ${p.unobserved})`);
    lines.push('');
    lines.push(`  win5 count/rate: ${p.win5Count} / ${pct(p.win5Rate)}   (BIG_WINNER | WINNER)`);
    lines.push(`  win3 count/rate: ${p.win3Count} / ${pct(p.win3Rate)}   (+ SMALL_WINNER)`);
    lines.push(`  flatDump count : ${p.flatDumpCount} / ${pct(p.flatDumpRate)}`);
    lines.push('');
    lines.push(`  avg move       : ${numStr(p.avgMove)}%`);
    lines.push(`  median move    : ${numStr(p.medianMove)}%`);
    lines.push('');
    lines.push(`  win5 lift      : ${p.win5Lift != null ? p.win5Lift.toFixed(2) + 'x' : 'n/a'}   (vs enrolled-universe baseline)`);
    lines.push('');

    const recTag = `[${p.recommendation}]`;
    lines.push(`  Recommendation : ${recTag}`);
    if (p.recommendation === 'NEEDS_MORE_DATA') {
      lines.push(`    Need ≥75 observed outcomes (have ${p.observed}). Keep collecting.`);
    } else if (p.recommendation === 'WATCH_PROFILE_PROMISING') {
      lines.push('    Criteria met: obs≥75, win5Lift≥1.5x, win1≥35%, flatDump≤65%.');
      lines.push('    Profile shows out-of-sample edge. Reassess after more data.');
    } else if (p.recommendation === 'WATCH_PROFILE_REJECT') {
      lines.push('    flatDump rate >80%. This profile skews toward junk/dumps.');
      lines.push('    Consider removing or blacklisting this profile combination.');
    } else {
      lines.push('    Criteria not met for PROMISING. Continue watching.');
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0');
  lines.push('  realTradingLocked=true  paperOnly=true');
  lines.push('  HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('  This report is observational only. No gates, decisions, or');
  lines.push('  autopilot logic has been modified.');
  lines.push(SEP, '');
  return lines.join('\n');
}
