// LIVE-SHADOW REJECT DIAGNOSTIC REPORT
//
// REPORT ONLY  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true  DO_NOT_ENABLE_REAL_TRADING  UNKNOWN ≠ CLEAN
//
// Summarizes the last N live-shadow cycles from the append-only diagnostics jsonl and shows,
// across the window, why candidates were IGNORED / WATCHed / BLOCKED / made it to READY, using
// NORMALIZED reject-reason buckets (no per-minute strings). It also surfaces source freshness
// (age, stale cycles) and how many candidates matched each internal shadow lane. It never trades,
// never touches a wallet/keys, never signs, never swaps, and never loosens gates. UNKNOWN cluster
// risk is carried verbatim and is NEVER treated as CLEAN.

import * as fs from 'fs';

import {
  DEFAULT_LIVE_SHADOW_DIAGNOSTICS_PATH,
  type LiveShadowDiagnosticRecord, type LiveShadowDecision, type ShadowLane,
} from './liveShadow';

export interface LiveShadowDiagnosticReportResult {
  generatedAt:            string;
  diagnosticsPath:        string;
  cyclesSummarized:       number;
  firstCycleTs:           string | null;
  lastCycleTs:            string | null;
  lastSourceFile:         string | null;
  lastSourceCycle:        string | null;
  lastSourceAgeMinutes:   number | null;
  staleCycles:            number;
  totalCandidates:        number;
  decisionCounts:         Record<LiveShadowDecision, number>;
  ignoredByReason:        Record<string, number>;
  blockedByReason:        Record<string, number>;
  missingConditionTally:  Record<string, number>;
  readyCount:             number;
  wouldBuyCount:          number;
  productionGateApprovedTotal: number;
  laneMatchCounts:        Record<ShadowLane, number>;
  topMissingCondition:    string | null;
  READY_FOR_REAL_TRADING: false;
  LIVE_SHADOW_ONLY:       true;
  REAL_TRADING:           false;
  NO_WALLET:              true;
  NO_SWAP:                true;
  NO_SIGNING:             true;
  UNKNOWN_NEVER_CLEAN:    true;
}

export interface LiveShadowDiagnosticReportOptions {
  diagnosticsPath?: string;
  lastN?:           number;
  generatedAt?:     string;
  nowMs?:           number;
  /** Test-only injection. */
  _records?:        LiveShadowDiagnosticRecord[];
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

const EMPTY_LANES = (): Record<ShadowLane, number> => ({
  NO_BM_INTERNAL_BROAD: 0, NO_BM_BEST_VLR: 0, NO_BM_PULLBACK: 0,
});

export function runLiveShadowDiagnostic(opts: LiveShadowDiagnosticReportOptions = {}): LiveShadowDiagnosticReportResult {
  const diagnosticsPath = opts.diagnosticsPath ?? DEFAULT_LIVE_SHADOW_DIAGNOSTICS_PATH;
  const lastN = opts.lastN ?? 20;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  const all = opts._records ?? readJsonl<LiveShadowDiagnosticRecord>(diagnosticsPath);
  const records = all.slice(-lastN);

  const decisionCounts: Record<LiveShadowDecision, number> = { IGNORED: 0, WATCH: 0, BLOCKED: 0, READY: 0 };
  const ignoredByReason: Record<string, number> = {};
  const blockedByReason: Record<string, number> = {};
  const missingConditionTally: Record<string, number> = {};
  const laneMatchCounts = EMPTY_LANES();
  let totalCandidates = 0, wouldBuyCount = 0, productionGateApprovedTotal = 0, staleCycles = 0;

  const add = (dst: Record<string, number>, src: Record<string, number> | undefined): void => {
    for (const [k, v] of Object.entries(src ?? {})) dst[k] = (dst[k] ?? 0) + v;
  };

  for (const rec of records) {
    totalCandidates += rec.totalCandidates ?? 0;
    wouldBuyCount += rec.wouldBuyCount ?? 0;
    productionGateApprovedTotal += rec.productionGateApprovedCount ?? 0;
    if (rec.staleSource) staleCycles += 1;
    for (const k of ['IGNORED', 'WATCH', 'BLOCKED', 'READY'] as LiveShadowDecision[]) {
      decisionCounts[k] += rec.decisionCounts?.[k] ?? 0;
    }
    for (const lane of ['NO_BM_INTERNAL_BROAD', 'NO_BM_BEST_VLR', 'NO_BM_PULLBACK'] as ShadowLane[]) {
      laneMatchCounts[lane] += rec.laneMatchCounts?.[lane] ?? 0;
    }
    add(ignoredByReason, rec.ignoredByReason);
    add(blockedByReason, rec.blockedByReason);
    add(missingConditionTally, rec.missingConditionTally);
  }
  const topMissingCondition = Object.entries(missingConditionTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const last = records[records.length - 1];

  return {
    generatedAt, diagnosticsPath, cyclesSummarized: records.length,
    firstCycleTs: records[0]?.ts ?? null, lastCycleTs: last?.ts ?? null,
    lastSourceFile: last?.sourceFile ?? null, lastSourceCycle: last?.sourceCycle ?? null,
    lastSourceAgeMinutes: last?.sourceAgeMinutes ?? null, staleCycles,
    totalCandidates, decisionCounts, ignoredByReason, blockedByReason, missingConditionTally,
    readyCount: decisionCounts.READY, wouldBuyCount, productionGateApprovedTotal, laneMatchCounts,
    topMissingCondition,
    READY_FOR_REAL_TRADING: false,
    LIVE_SHADOW_ONLY: true, REAL_TRADING: false, NO_WALLET: true, NO_SWAP: true, NO_SIGNING: true,
    UNKNOWN_NEVER_CLEAN: true,
  };
}

export function renderLiveShadowDiagnostic(r: LiveShadowDiagnosticReportResult): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const bd = (m: Record<string, number>): string => {
    const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
    return e.length ? e.map(([k, v]) => `${k}=${v}`).join('   ') : '(none)';
  };
  const L: string[] = [];
  L.push(WIDE);
  L.push('  TOKEN GRAB — LIVE-SHADOW DIAGNOSTIC (why candidates are ignored / blocked)');
  L.push('  REPORT ONLY  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  UNKNOWN ≠ CLEAN');
  L.push(WIDE, '');
  L.push(`  Generated at      : ${r.generatedAt}`);
  L.push(`  Diagnostics file  : ${r.diagnosticsPath}`);
  L.push(`  Cycles summarized : ${r.cyclesSummarized}   (${r.firstCycleTs ?? '(none)'} → ${r.lastCycleTs ?? '(none)'})`);
  L.push(`  Latest source     : ${r.lastSourceCycle ?? '(none)'}`);
  L.push(`  Latest source age : ${r.lastSourceAgeMinutes ?? '(unknown)'} min   stale cycles=${r.staleCycles}`);
  L.push(`  Total candidates  : ${r.totalCandidates}`);
  L.push('');
  L.push(THIN);
  L.push('  DECISIONS (across window)');
  L.push(THIN);
  L.push(`    IGNORED=${r.decisionCounts.IGNORED}   WATCH=${r.decisionCounts.WATCH}   ` +
    `BLOCKED=${r.decisionCounts.BLOCKED}   READY=${r.readyCount}   would-buy=${r.wouldBuyCount}`);
  L.push('');
  L.push(THIN);
  L.push('  INTERNAL SHADOW LANE MATCHES (paper-only research — NOT a buy signal)');
  L.push(THIN);
  L.push(`    NO_BM_INTERNAL_BROAD : ${r.laneMatchCounts.NO_BM_INTERNAL_BROAD}`);
  L.push(`    NO_BM_BEST_VLR       : ${r.laneMatchCounts.NO_BM_BEST_VLR}   (VLR_0_5_TO_2)`);
  L.push(`    NO_BM_PULLBACK       : ${r.laneMatchCounts.NO_BM_PULLBACK}   (m5 -20 to -5)`);
  L.push(`    Production gate approved (reported, NOT blocking) : ${r.productionGateApprovedTotal}`);
  L.push('');
  L.push(THIN);
  L.push('  IGNORED BY REASON (normalized buckets)');
  L.push(THIN);
  L.push(`    ${bd(r.ignoredByReason)}`);
  L.push('');
  L.push(THIN);
  L.push('  BLOCKED BY REASON (normalized buckets)');
  L.push(THIN);
  L.push(`    ${bd(r.blockedByReason)}`);
  L.push('');
  L.push(THIN);
  L.push('  TOP MISSING CONDITION');
  L.push(THIN);
  L.push(`    ${r.topMissingCondition ?? '(none)'}`);
  L.push(`    full tally: ${bd(r.missingConditionTally)}`);
  L.push('');
  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  REPORT_ONLY=true  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false');
  L.push('  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true  UNKNOWN_NEVER_CLEAN=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE, '');
  return L.join('\n');
}
