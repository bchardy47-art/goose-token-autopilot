import * as fs from 'fs';
import * as path from 'path';
import { readPaperIntents } from './ripperPaperIntentLedger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AutopilotDecision =
  | 'HOLD_CURRENT_GATES'
  | 'PAPER_ONLY_WAIT10_FOR_HIGH_QUALITY_SUBGROUP'
  | 'DO_NOT_ENABLE_REAL_TRADING';

export interface RipperAutopilotStatusResult {
  mode:                      'PAPER_ONLY';
  realTradingLocked:         true;
  tradingExecuted:           0;
  paperOnly:                 true;
  generatedAt:               string;
  latestFeedTime:            string | null;
  latestCycleTime:           string | null;
  approvedCount:             number;
  rejectedCount:             number;
  openPaperIntents:          number;
  wait10mIntents:            number;
  enterNowIntents:           number;
  dueObservations:           number;
  latestTimingEdge:          string | null;
  latestExitPolicyLeader:    string | null;
  latestRealFakeRuleSuggestion: string | null;
  decision:                  AutopilotDecision;
  reportOnly:                true;
  readOnly:                  true;
}

export interface RipperAutopilotStatusOptions {
  cyclesDir?:           string;
  intentsPath?:         string;
  timingReportPath?:    string;
  exitPolicyPath?:      string;
  realVsFakePath?:      string;
  nowMs?:               number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CYCLES_DIR       = 'data/token-grab/ripper/cycles';
const DEFAULT_INTENTS_PATH     = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_TIMING_REPORT    = 'data/token-grab/ripper/approved-entry-timing-report.jsonl';
const DEFAULT_EXIT_POLICY_PATH = 'data/token-grab/ripper/paper-exit-policy-report.jsonl';
const DEFAULT_REAL_FAKE_PATH   = 'data/token-grab/ripper/real-vs-fake-autopsy.jsonl';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLatestCycleTime(cyclesDir: string): string | null {
  if (!fs.existsSync(cyclesDir)) return null;
  const files = fs.readdirSync(cyclesDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl') && !f.includes('-feed'))
    .sort();
  if (files.length === 0) return null;
  const last = files[files.length - 1];
  // Extract ISO-ish timestamp from filename: cycle-YYYY-MM-DD-HHmmss.jsonl
  const m = last.match(/cycle-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return last;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function readLastJsonlLine(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;
  try { return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>; } catch { return null; }
}

function countCycleApprovals(cyclesDir: string): { approved: number; rejected: number } {
  if (!fs.existsSync(cyclesDir)) return { approved: 0, rejected: 0 };
  const files = fs.readdirSync(cyclesDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl') && !f.includes('-feed'));
  if (files.length === 0) return { approved: 0, rejected: 0 };
  // Read only the latest cycle file for current counts
  const latest = path.join(cyclesDir, files[files.length - 1]);
  if (!fs.existsSync(latest)) return { approved: 0, rejected: 0 };
  const lines = fs.readFileSync(latest, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  let approved = 0;
  let rejected = 0;
  for (const line of lines) {
    try {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f['buyGateDecision'] === 'BUY_APPROVED_PAPER') approved++;
      else rejected++;
    } catch { /* skip */ }
  }
  return { approved, rejected };
}

function extractTimingEdge(timingPath: string): string | null {
  if (!fs.existsSync(timingPath)) return null;
  const lines = fs.readFileSync(timingPath, 'utf-8')
    .split('\n').filter(l => l.trim().length > 0);
  // Look for any row that has wait10mBeatsEnterNow=true in subgroup analysis
  // The timing report JSONL contains EntryTimingRow rows; read the latest row's window
  if (lines.length === 0) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const win = last['window'] as string | undefined;
    return win ? `Latest timing window in report: ${win}` : null;
  } catch { return null; }
}

function extractExitPolicyLeader(exitPath: string): string | null {
  if (!fs.existsSync(exitPath)) return null;
  const lines = fs.readFileSync(exitPath, 'utf-8')
    .split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;

  // Parse all rows and check if any supported policy has real observed coverage
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
  }
  if (rows.length === 0) return null;

  const coveredRows = rows.filter(r => {
    const supported        = r['supported'] as boolean | undefined;
    const candidatesWithData = r['candidatesWithData'] as number | undefined;
    return supported === true && typeof candidatesWithData === 'number' && candidatesWithData > 0;
  });

  if (coveredRows.length === 0) return 'INSUFFICIENT_DATA';

  // Pick best by avgSimulatedPL among covered supported rows
  let best = coveredRows[0];
  for (const r of coveredRows) {
    const rAvg    = r['avgSimulatedPL'] as number | null | undefined;
    const bestAvg = best['avgSimulatedPL'] as number | null | undefined;
    if (typeof rAvg === 'number' && (bestAvg == null || rAvg > bestAvg)) best = r;
  }

  const policy = best['policy'] as string | undefined;
  const avg    = best['avgSimulatedPL'] as number | null | undefined;
  if (!policy) return 'INSUFFICIENT_DATA';
  return typeof avg === 'number'
    ? `${policy} (avg P/L: ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%)`
    : policy;
}

function extractRealFakeRule(realFakePath: string): string | null {
  if (!fs.existsSync(realFakePath)) return null;
  const lines = fs.readFileSync(realFakePath, 'utf-8')
    .split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const clusterRisk = last['clusterRisk'] as string | undefined;
    const pct         = last['priceChangePct'] as number | undefined;
    if (clusterRisk && pct != null) {
      return `Last observed: ${clusterRisk}, move=${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    }
    return null;
  } catch { return null; }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperAutopilotStatus(
  options: RipperAutopilotStatusOptions = {},
): RipperAutopilotStatusResult {
  const nowMs          = options.nowMs ?? Date.now();
  const generatedAt    = new Date(nowMs).toISOString();
  const cyclesDir      = options.cyclesDir      ?? DEFAULT_CYCLES_DIR;
  const intentsPath    = options.intentsPath    ?? DEFAULT_INTENTS_PATH;
  const timingPath     = options.timingReportPath ?? DEFAULT_TIMING_REPORT;
  const exitPath       = options.exitPolicyPath ?? DEFAULT_EXIT_POLICY_PATH;
  const realFakePath   = options.realVsFakePath ?? DEFAULT_REAL_FAKE_PATH;

  const latestCycleTime  = findLatestCycleTime(cyclesDir);
  const { approved, rejected } = countCycleApprovals(cyclesDir);

  const intents        = readPaperIntents(intentsPath);
  const openIntents    = intents.filter(i => i.status === 'PLANNED' || i.status === 'ENTRY_DUE');
  const wait10mIntents = openIntents.filter(i => i.paperEntryTiming === 'WAIT_10M').length;
  const enterNowIntents = openIntents.filter(i => i.paperEntryTiming === 'ENTER_NOW').length;
  const dueObservations = intents.filter(i => i.status === 'ENTRY_DUE').length;

  const latestTimingEdge         = extractTimingEdge(timingPath);
  const latestExitPolicyLeader   = extractExitPolicyLeader(exitPath);
  const latestRealFakeRuleSuggestion = extractRealFakeRule(realFakePath);

  // Decision logic
  const hasWait10mEvidence = intents.some(i => i.paperEntryTiming === 'WAIT_10M');
  const decision: AutopilotDecision = hasWait10mEvidence
    ? 'PAPER_ONLY_WAIT10_FOR_HIGH_QUALITY_SUBGROUP'
    : 'HOLD_CURRENT_GATES';

  return {
    mode:                         'PAPER_ONLY',
    realTradingLocked:            true,
    tradingExecuted:              0,
    paperOnly:                    true,
    generatedAt,
    latestFeedTime:               null, // feed time not tracked separately
    latestCycleTime,
    approvedCount:                approved,
    rejectedCount:                rejected,
    openPaperIntents:             openIntents.length,
    wait10mIntents,
    enterNowIntents,
    dueObservations,
    latestTimingEdge,
    latestExitPolicyLeader,
    latestRealFakeRuleSuggestion,
    decision,
    reportOnly:                   true,
    readOnly:                     true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperAutopilotStatus(
  result: RipperAutopilotStatusResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER AUTOPILOT STATUS DASHBOARD');
  lines.push('  [PAPER ONLY — NO REAL TRADING — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  Mode                  : ${result.mode}`);
  lines.push(`  realTradingLocked     : ${result.realTradingLocked}`);
  lines.push(`  tradingExecuted       : ${result.tradingExecuted}`);
  lines.push(`  Generated at          : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  FEED & CYCLE');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Latest cycle time     : ${result.latestCycleTime ?? 'NONE'}`);
  lines.push(`  Approved (latest)     : ${result.approvedCount}`);
  lines.push(`  Rejected (latest)     : ${result.rejectedCount}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  PAPER INTENTS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Open intents          : ${result.openPaperIntents}`);
  lines.push(`  WAIT_10M intents      : ${result.wait10mIntents}`);
  lines.push(`  ENTER_NOW intents     : ${result.enterNowIntents}`);
  lines.push(`  Due observations      : ${result.dueObservations}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  LATEST EVIDENCE');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Timing edge           : ${result.latestTimingEdge           ?? 'none'}`);
  lines.push(`  Exit policy leader    : ${result.latestExitPolicyLeader     ?? 'none'}`);
  lines.push(`  Real/fake rule        : ${result.latestRealFakeRuleSuggestion ?? 'none'}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  DECISION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  ${result.decision}`);
  lines.push('  HOLD_CURRENT_GATES — do not loosen gates without more evidence.');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT ADD WALLET SIGNING');
  lines.push('  * DO NOT ADD REAL SWAP EXECUTION');
  lines.push('  * DO NOT CALL token:auto-paper');
  lines.push('  * DO NOT CALL token:paper-buy');
  lines.push('  * DO NOT LOOSEN PRODUCTION GATES');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
