// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FilterRecommendation =
  | 'PROMOTE_REVIEW'
  | 'KEEP_COLLECTING'
  | 'NEEDS_MORE_DATA'
  | 'REJECT'
  | 'NO_CLEAR_EDGE';

export type TimingRecommendation =
  | 'WAIT_10M_FAVORED'
  | 'ENTER_NOW_FAVORED'
  | 'NO_CLEAR_EDGE'
  | 'INSUFFICIENT_DATA';

export interface FilterCandidateSummary {
  name:                     string;
  enrolledCount:            number;
  observedCount:            number;
  unobservedCount:          number;
  flatDumpCount:            number;
  flatDumpRate:             number | null;
  win1Count:                number;
  win1Rate:                 number | null;
  win3Count:                number;
  win3Rate:                 number | null;
  win5Count:                number;
  win5Rate:                 number | null;
  controlObservedCount:     number;
  controlWin1Count:         number;
  controlWin1Rate:          number | null;
  controlVsBlockedMultiple: number | null;
  recommendation:           FilterRecommendation;
}

export interface BrainStatus {
  totalRows:            number;
  observedRows:         number;
  policyEvidenceRows:   number;
  unknownRows:          number;
  latestCycleTimestamp: string | null;
  latestCycleApproved:  number | null;
  latestCycleRejected:  number | null;
}

export interface TimingEdge {
  wait10mEnrolledCount:   number;
  wait10mObservedCount:   number;
  wait10mWin1Count:       number;
  wait10mWin1Rate:        number | null;
  enterNowEnrolledCount:  number;
  enterNowObservedCount:  number;
  enterNowWin1Count:      number;
  enterNowWin1Rate:       number | null;
  recommendation:         TimingRecommendation;
}

export interface OpenIntents {
  openCount:       number;
  dueCount:        number;
  expiredCount:    number;
  totalCount:      number;
  latestRunStatus: string | null;
  latestRunLog:    string | null;
  warnHighOpen:    boolean;
  warnTimedOut:    boolean;
}

export interface BrainDashboardResult {
  generatedAt:        string;
  brainStatus:        BrainStatus;
  candidates:         FilterCandidateSummary[];
  topCandidate:       FilterCandidateSummary | null;
  rejectedCandidates: FilterCandidateSummary[];
  timingEdge:         TimingEdge;
  openIntents:        OpenIntents;
  overallCall:        string;
  reportOnly:         true;
  readOnly:           true;
  tradingExecuted:    0;
  realTradingLocked:  true;
  paperOnly:          true;
}

export interface BrainDashboardOptions {
  learningMemoryPath?:    string;
  enrollmentsPath?:       string;
  outcomeReportPath?:     string;
  paperIntentsPath?:      string;
  cyclesDir?:             string;
  logsDir?:               string;
  nowMs?:                 number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface OutcomeRow {
  contract:    string;
  capturedAt:  string;
  ageGte10m:   boolean;
  liqLt10k:    boolean;
  liqOrAge:    boolean;
  isCSP:       boolean;
  isScore100:  boolean;
  isObserved:  boolean;
  isWin1:      boolean;
  isWin3:      boolean;
  isWin5:      boolean;
  isFlatDump:  boolean;
}

interface MemoryRow {
  timingPath:      string | null;
  memoryUniverse:  string | null;
  outcomeLabel:    string | null;
}

interface FilterDef {
  name: string;
  fn:   (r: OutcomeRow) => boolean;
}

// ── Filter candidate definitions ──────────────────────────────────────────────

const FILTER_DEFS: FilterDef[] = [
  { name: 'age_gte10m',                            fn: r => r.ageGte10m },
  { name: 'liq_lt10k',                             fn: r => r.liqLt10k },
  { name: 'liq_OR_age',                            fn: r => r.liqOrAge },
  { name: 'liq_OR_age_BUT_keep_clean_score100_prime', fn: r => r.liqOrAge && !r.isCSP },
  { name: 'liq_OR_age_BUT_keep_score100',          fn: r => r.liqOrAge && !r.isScore100 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function pct(n: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((n / total) * 1000) / 10;
}

function fmtRate(v: number | null): string {
  return v != null ? `${v}%` : 'n/a';
}

function fmtMultiple(v: number | null): string {
  return v != null ? `${v}x` : 'n/a';
}

function filterRecommendation(c: {
  observedCount:            number;
  win1Count:                number;
  win1Rate:                 number | null;
  win3Rate:                 number | null;
  win5Rate:                 number | null;
  flatDumpRate:             number | null;
  controlVsBlockedMultiple: number | null;
}): FilterRecommendation {
  if (c.observedCount < 20) return 'NEEDS_MORE_DATA';
  if (
    (c.win1Rate != null && c.win1Rate > 5) ||
    (c.win3Rate != null && c.win3Rate > 3) ||
    (c.win5Rate != null && c.win5Rate > 2)
  ) return 'REJECT';
  const multipleOk =
    c.win1Count === 0 ||
    (c.controlVsBlockedMultiple != null && c.controlVsBlockedMultiple >= 3);
  if (
    c.observedCount >= 50 &&
    c.flatDumpRate != null && c.flatDumpRate >= 90 &&
    multipleOk
  ) return 'PROMOTE_REVIEW';
  // Promising but insufficient data, or threshold not fully met
  if (
    c.observedCount < 50 &&
    c.flatDumpRate != null && c.flatDumpRate >= 80
  ) return 'KEEP_COLLECTING';
  return 'NO_CLEAR_EDGE';
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadOutcomeRows(
  outcomeReportPath: string,
  enrollmentsPath:   string,
): OutcomeRow[] {
  // Build CSP / score-100 index from enrollment file
  const cspIndex     = new Set<string>();
  const score100Index = new Set<string>();
  for (const line of readLines(enrollmentsPath)) {
    try {
      const r          = JSON.parse(line) as Record<string, unknown>;
      const contract   = typeof r['contract']   === 'string' ? r['contract']   : null;
      const capturedAt = typeof r['capturedAt'] === 'string' ? r['capturedAt'] : null;
      if (!contract || !capturedAt) continue;
      const key          = `${contract}::${capturedAt}`;
      const clusterRisk  = typeof r['clusterRisk']     === 'string' ? r['clusterRisk']     : null;
      const ripperScore  = typeof r['ripperScore']     === 'number' ? r['ripperScore']     : null;
      const launchAge    = typeof r['launchAgeBucket'] === 'string' ? r['launchAgeBucket'] : null;
      if (clusterRisk === 'CLEAN' && ripperScore === 100 && launchAge === 'PRIME_WINDOW') {
        cspIndex.add(key);
      }
      if (ripperScore === 100) score100Index.add(key);
    } catch { /* skip */ }
  }

  const rows: OutcomeRow[] = [];
  const seen = new Set<string>();
  for (const line of readLines(outcomeReportPath)) {
    try {
      const r          = JSON.parse(line) as Record<string, unknown>;
      const contract   = typeof r['contract']   === 'string' ? r['contract']   : null;
      const capturedAt = typeof r['capturedAt'] === 'string' ? r['capturedAt'] : null;
      if (!contract || !capturedAt) continue;
      const key = `${contract}::${capturedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outcome = typeof r['outcome'] === 'string' ? r['outcome'] : null;
      const isObs   = outcome !== 'UNOBSERVED' && outcome != null;
      const isWin1  = outcome === 'WIN_1PCT' || outcome === 'WIN_3PCT' || outcome === 'WIN_5PCT';
      const isWin3  = outcome === 'WIN_3PCT' || outcome === 'WIN_5PCT';
      const isWin5  = outcome === 'WIN_5PCT';
      const isFD    = outcome === 'FLAT_JUNK' || outcome === 'DUMP';

      rows.push({
        contract,
        capturedAt,
        ageGte10m:  r['ageGte10m']  === true,
        liqLt10k:   r['liqLt10k']   === true,
        liqOrAge:   r['liqOrAge']   === true,
        isCSP:      cspIndex.has(key),
        isScore100: score100Index.has(key),
        isObserved: isObs,
        isWin1,
        isWin3,
        isWin5,
        isFlatDump: isFD,
      });
    } catch { /* skip */ }
  }
  return rows;
}

function buildCandidate(
  def:      FilterDef,
  allRows:  OutcomeRow[],
): FilterCandidateSummary {
  const blocked = allRows.filter(r => def.fn(r));
  const control = allRows.filter(r => !def.fn(r));

  const blockedObs = blocked.filter(r => r.isObserved);
  const controlObs = control.filter(r => r.isObserved);

  const win1Count  = blockedObs.filter(r => r.isWin1).length;
  const win3Count  = blockedObs.filter(r => r.isWin3).length;
  const win5Count  = blockedObs.filter(r => r.isWin5).length;
  const fdCount    = blockedObs.filter(r => r.isFlatDump).length;

  const win1Rate    = pct(win1Count, blockedObs.length);
  const win3Rate    = pct(win3Count, blockedObs.length);
  const win5Rate    = pct(win5Count, blockedObs.length);
  const flatDumpRate = pct(fdCount, blockedObs.length);

  const ctrlWin1Count = controlObs.filter(r => r.isWin1).length;
  const ctrlWin1Rate  = pct(ctrlWin1Count, controlObs.length);

  const controlVsBlockedMultiple =
    win1Rate != null && win1Rate > 0 && ctrlWin1Rate != null
      ? Math.round((ctrlWin1Rate / win1Rate) * 10) / 10
      : null;

  const rec = filterRecommendation({
    observedCount:            blockedObs.length,
    win1Count,
    win1Rate,
    win3Rate,
    win5Rate,
    flatDumpRate,
    controlVsBlockedMultiple,
  });

  return {
    name:                     def.name,
    enrolledCount:            blocked.length,
    observedCount:            blockedObs.length,
    unobservedCount:          blocked.length - blockedObs.length,
    flatDumpCount:            fdCount,
    flatDumpRate,
    win1Count,
    win1Rate,
    win3Count,
    win3Rate,
    win5Count,
    win5Rate,
    controlObservedCount:     controlObs.length,
    controlWin1Count:         ctrlWin1Count,
    controlWin1Rate:          ctrlWin1Rate,
    controlVsBlockedMultiple,
    recommendation:           rec,
  };
}

function loadMemoryRows(memoryPath: string): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const line of readLines(memoryPath)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      rows.push({
        timingPath:     typeof r['timingPath']    === 'string' ? r['timingPath']    : null,
        memoryUniverse: typeof r['memoryUniverse'] === 'string' ? r['memoryUniverse'] : null,
        outcomeLabel:   typeof r['outcomeLabel']  === 'string' ? r['outcomeLabel']  : null,
      });
    } catch { /* skip */ }
  }
  return rows;
}

function buildTimingEdge(memoryRows: MemoryRow[]): TimingEdge {
  const enrolled = memoryRows.filter(r => r.memoryUniverse === 'SHADOW_ENROLLED_APPROVED');
  const isObs    = (r: MemoryRow) => r.outcomeLabel !== 'UNKNOWN' && r.outcomeLabel != null;
  const isWin1   = (r: MemoryRow) =>
    r.outcomeLabel === 'SMALL_WINNER' || r.outcomeLabel === 'WINNER' || r.outcomeLabel === 'BIG_WINNER';

  const w10Enr = enrolled.filter(r => r.timingPath === 'WAIT_10M');
  const w10Obs = w10Enr.filter(isObs);
  const w10W1  = w10Obs.filter(isWin1);
  const enrEnr = enrolled.filter(r => r.timingPath === 'ENTER_NOW');
  const enrObs = enrEnr.filter(isObs);
  const enrW1  = enrObs.filter(isWin1);

  const w10Rate  = pct(w10W1.length, w10Obs.length);
  const enrRate  = pct(enrW1.length, enrObs.length);

  let rec: TimingRecommendation = 'INSUFFICIENT_DATA';
  if (w10Obs.length >= 20 && enrObs.length >= 20) {
    if (w10Rate != null && enrRate != null) {
      if (enrRate < w10Rate - 3)       rec = 'WAIT_10M_FAVORED';
      else if (w10Rate < enrRate - 3)  rec = 'ENTER_NOW_FAVORED';
      else                             rec = 'NO_CLEAR_EDGE';
    }
  }

  return {
    wait10mEnrolledCount:  w10Enr.length,
    wait10mObservedCount:  w10Obs.length,
    wait10mWin1Count:      w10W1.length,
    wait10mWin1Rate:       w10Rate,
    enterNowEnrolledCount: enrEnr.length,
    enterNowObservedCount: enrObs.length,
    enterNowWin1Count:     enrW1.length,
    enterNowWin1Rate:      enrRate,
    recommendation:        rec,
  };
}

function loadBrainStatus(
  memoryRows:   MemoryRow[],
  cyclesDir:    string,
  nowMs:        number,
): BrainStatus {
  const totalRows         = memoryRows.length;
  const observedRows      = memoryRows.filter(r => r.outcomeLabel !== 'UNKNOWN' && r.outcomeLabel != null).length;
  const policyEvidenceRows = memoryRows.filter(r => r.memoryUniverse === 'SHADOW_ENROLLED_APPROVED').length;
  const unknownRows       = memoryRows.filter(r => r.outcomeLabel === 'UNKNOWN' || r.outcomeLabel == null).length;

  let latestCycleTimestamp: string | null = null;
  let latestCycleApproved:  number | null = null;
  let latestCycleRejected:  number | null = null;

  if (fs.existsSync(cyclesDir)) {
    const cycleFiles = fs.readdirSync(cyclesDir)
      .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl'))
      .sort();
    if (cycleFiles.length > 0) {
      const latest = path.join(cyclesDir, cycleFiles[cycleFiles.length - 1]!);
      const cycleRows: Record<string, unknown>[] = [];
      for (const line of readLines(latest)) {
        try { cycleRows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
      }
      if (cycleRows.length > 0) {
        const firstCap = typeof cycleRows[0]!['capturedAt'] === 'string'
          ? (cycleRows[0]!['capturedAt'] as string)
          : null;
        latestCycleTimestamp = firstCap;
        latestCycleApproved  = cycleRows.filter(r => r['buyGateDecision'] === 'BUY_APPROVED_PAPER').length;
        latestCycleRejected  = cycleRows.filter(r => r['buyGateDecision'] === 'BUY_REJECTED').length;
      }
    }
  }

  void nowMs;
  return { totalRows, observedRows, policyEvidenceRows, unknownRows,
           latestCycleTimestamp, latestCycleApproved, latestCycleRejected };
}

function loadOpenIntents(paperIntentsPath: string, logsDir: string): OpenIntents {
  let openCount = 0, dueCount = 0, expiredCount = 0, totalCount = 0;

  for (const line of readLines(paperIntentsPath)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      totalCount++;
      const status = typeof r['status'] === 'string' ? r['status'] : null;
      if (status === 'ENTRY_DUE')        { dueCount++;  openCount++; }
      else if (status === 'OBSERVED')    { /* done */ }
      else if (status === 'EXPIRED_NO_DATA') { expiredCount++; }
      else if (status === 'PENDING' || status === 'OPEN') { openCount++; }
    } catch { /* skip */ }
  }

  let latestRunStatus: string | null = null;
  let latestRunLog:    string | null = null;

  if (fs.existsSync(logsDir)) {
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('run-') && f.endsWith('.log'))
      .sort();
    if (logFiles.length > 0) {
      const latestLog = path.join(logsDir, logFiles[logFiles.length - 1]!);
      latestRunLog = latestLog;
      const logContent = fs.readFileSync(latestLog, 'utf-8');
      const statusMatch = logContent.match(/Status\s*:\s*([^\n]+)/);
      if (statusMatch) latestRunStatus = statusMatch[1]!.trim();
    }
  }

  return {
    openCount,
    dueCount,
    expiredCount,
    totalCount,
    latestRunStatus,
    latestRunLog,
    warnHighOpen: openCount > 5,
    warnTimedOut: latestRunStatus != null && latestRunStatus.includes('TIMED_OUT'),
  };
}

function buildOverallCall(
  topCandidate:       FilterCandidateSummary | null,
  rejectedCandidates: FilterCandidateSummary[],
): string {
  const rejectedNames = rejectedCandidates.map(c => c.name).join(', ');

  if (topCandidate == null) {
    return 'Current call: NEEDS_MORE_DATA. No filter candidate meets observation threshold. Keep running learning loop. No gate or policy changes.';
  }

  const topRec = topCandidate.recommendation;

  if (topRec === 'PROMOTE_REVIEW') {
    return `Current call: READY FOR REVIEW. Best candidate: ${topCandidate.name} (${topCandidate.observedCount} obs, ${fmtRate(topCandidate.win1Rate)} win1, ${fmtRate(topCandidate.flatDumpRate)} flat+dump). Do NOT change gates — human review required first.${rejectedNames ? ` Reject: ${rejectedNames}.` : ''}`;
  }
  if (topRec === 'KEEP_COLLECTING') {
    const liqBad = rejectedNames.includes('liq');
    const liqMsg = liqBad ? ' Do not use liquidity filters.' : '';
    return `Current call: KEEP COLLECTING. Best watch: ${topCandidate.name} (${topCandidate.observedCount} obs, ${fmtRate(topCandidate.win1Rate)} win1).${liqMsg} No gate or policy changes.`;
  }
  if (topRec === 'NEEDS_MORE_DATA') {
    return `Current call: NEEDS_MORE_DATA. Best watch: ${topCandidate.name} (${topCandidate.observedCount} obs). Keep running learning loop. No gate or policy changes.`;
  }
  return `Current call: NO_CLEAR_EDGE. Best watch: ${topCandidate.name}. Keep collecting.${rejectedNames ? ` Reject: ${rejectedNames}.` : ''} No gate or policy changes.`;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runBrainDashboard(
  options: BrainDashboardOptions = {},
): BrainDashboardResult {
  const _reportOnly:        true = true;
  const _readOnly:          true = true;
  const _tradingExecuted:   0    = 0;
  const _realTradingLocked: true = true;
  const _paperOnly:         true = true;

  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const learningMemoryPath = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';
  const enrollmentsPath = options.enrollmentsPath
    ?? 'data/token-grab/ripper/shadow-reject-filter-enrollments.jsonl';
  const outcomeReportPath = options.outcomeReportPath
    ?? 'data/token-grab/ripper/shadow-enrolled-outcome-report.jsonl';
  const paperIntentsPath = options.paperIntentsPath
    ?? 'data/token-grab/ripper/paper-intents.jsonl';
  const cyclesDir = options.cyclesDir
    ?? 'data/token-grab/ripper/cycles';
  const logsDir = options.logsDir
    ?? 'logs/token-grab-learning';

  const outcomeRows  = loadOutcomeRows(outcomeReportPath, enrollmentsPath);
  const memoryRows   = loadMemoryRows(learningMemoryPath);

  const candidates   = FILTER_DEFS.map(def => buildCandidate(def, outcomeRows));

  // Top candidate: PROMOTE_REVIEW first, then highest observed among KEEP_COLLECTING, then NEEDS_MORE_DATA
  const rankOrder: FilterRecommendation[] = ['PROMOTE_REVIEW', 'KEEP_COLLECTING', 'NEEDS_MORE_DATA', 'NO_CLEAR_EDGE', 'REJECT'];
  const sortedCandidates = [...candidates].sort((a, b) => {
    const ra = rankOrder.indexOf(a.recommendation);
    const rb = rankOrder.indexOf(b.recommendation);
    if (ra !== rb) return ra - rb;
    return b.observedCount - a.observedCount;  // more observed = better within same rank
  });
  const topCandidate       = sortedCandidates[0] ?? null;
  const rejectedCandidates = candidates.filter(
    c => c.recommendation === 'REJECT' || c.recommendation === 'NO_CLEAR_EDGE',
  );

  const timingEdge   = buildTimingEdge(memoryRows);
  const brainStatus  = loadBrainStatus(memoryRows, cyclesDir, nowMs);
  const openIntents  = loadOpenIntents(paperIntentsPath, logsDir);
  const overallCall  = buildOverallCall(topCandidate, rejectedCandidates);

  return {
    generatedAt,
    brainStatus,
    candidates,
    topCandidate,
    rejectedCandidates,
    timingEdge,
    openIntents,
    overallCall,
    reportOnly:        _reportOnly,
    readOnly:          _readOnly,
    tradingExecuted:   _tradingExecuted,
    realTradingLocked: _realTradingLocked,
    paperOnly:         _paperOnly,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function recLabel(r: FilterRecommendation): string {
  switch (r) {
    case 'PROMOTE_REVIEW':  return '★ PROMOTE_REVIEW';
    case 'KEEP_COLLECTING': return '↗ KEEP_COLLECTING';
    case 'NEEDS_MORE_DATA': return '~ NEEDS_MORE_DATA';
    case 'REJECT':          return '✗ REJECT';
    case 'NO_CLEAR_EDGE':   return '- NO_CLEAR_EDGE';
  }
}

function timingRecLabel(r: TimingRecommendation): string {
  switch (r) {
    case 'WAIT_10M_FAVORED':    return 'WAIT_10M_FAVORED (lower kill rate)';
    case 'ENTER_NOW_FAVORED':   return 'ENTER_NOW_FAVORED';
    case 'NO_CLEAR_EDGE':       return 'NO_CLEAR_EDGE';
    case 'INSUFFICIENT_DATA':   return 'INSUFFICIENT_DATA';
  }
}

function renderCandidateRow(c: FilterCandidateSummary): string {
  const name  = c.name.padEnd(42);
  const obs   = String(c.observedCount).padStart(4);
  const fd    = fmtRate(c.flatDumpRate).padStart(7);
  const w1    = fmtRate(c.win1Rate).padStart(6);
  const w3    = fmtRate(c.win3Rate).padStart(6);
  const w5    = fmtRate(c.win5Rate).padStart(6);
  const mult  = fmtMultiple(c.controlVsBlockedMultiple).padStart(6);
  const rec   = recLabel(c.recommendation);
  return `  ${name} | ${obs} | ${fd} | ${w1} | ${w3} | ${w5} | ${mult} | ${rec}`;
}

export function renderBrainDashboard(result: BrainDashboardResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];

  lines.push('  TOKEN GRAB — BRAIN DASHBOARD');
  lines.push('  [REPORT ONLY — NO TRADES — NO GATE CHANGES — READ ONLY]');
  lines.push(`  Generated : ${result.generatedAt}`);
  lines.push(SEP, '');

  // ── 1. BRAIN STATUS ──────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  1. BRAIN STATUS');
  lines.push(`  ${SEP2}`, '');
  const bs = result.brainStatus;
  lines.push(`  Total memory rows        : ${bs.totalRows}`);
  lines.push(`  Observed rows            : ${bs.observedRows}`);
  lines.push(`  Policy evidence rows     : ${bs.policyEvidenceRows}  (SHADOW_ENROLLED_APPROVED)`);
  lines.push(`  Unknown / unobserved     : ${bs.unknownRows}`);
  lines.push('');
  lines.push(`  Latest cycle timestamp   : ${bs.latestCycleTimestamp ?? 'n/a'}`);
  if (bs.latestCycleApproved != null) {
    lines.push(`  Latest cycle approved    : ${bs.latestCycleApproved}`);
    lines.push(`  Latest cycle rejected    : ${bs.latestCycleRejected ?? 'n/a'}`);
  }
  lines.push('');

  // ── 2. TOP FILTER CANDIDATE ───────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  2. TOP FILTER CANDIDATE');
  lines.push(`  ${SEP2}`, '');

  if (result.topCandidate) {
    const tc = result.topCandidate;
    lines.push(`  Name          : ${tc.name}`);
    lines.push(`  Enrolled      : ${tc.enrolledCount}  (observed: ${tc.observedCount}  unobserved: ${tc.unobservedCount})`);
    lines.push(`  Flat+dump     : ${tc.flatDumpCount} / ${tc.observedCount} (${fmtRate(tc.flatDumpRate)})`);
    lines.push(`  Winners >= +1%: ${tc.win1Count} / ${tc.observedCount} (${fmtRate(tc.win1Rate)})`);
    lines.push(`  Winners >= +3%: ${tc.win3Count} / ${tc.observedCount} (${fmtRate(tc.win3Rate)})`);
    lines.push(`  Winners >= +5%: ${tc.win5Count} / ${tc.observedCount} (${fmtRate(tc.win5Rate)})`);
    lines.push(`  Control obs   : ${tc.controlObservedCount}  control win1: ${tc.controlWin1Count} (${fmtRate(tc.controlWin1Rate)})`);
    lines.push(`  Ctrl/blk mult : ${fmtMultiple(tc.controlVsBlockedMultiple)}`);
    lines.push(`  Recommendation: ${recLabel(tc.recommendation)}`);
    lines.push('');
    lines.push('  PROMOTION THRESHOLD: observed>=50, flat+dump>=90%, win1<=5%, win3<=3%, win5<=2%, ctrl>=3x');
  } else {
    lines.push('  No candidates with sufficient data.');
  }
  lines.push('');

  // ── Candidate table ────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  ALL CANDIDATES (SHADOW_ENROLLED_APPROVED universe only)');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Candidate                                  | Obs  |  FD%   | Win1% | Win3% | Win5% |  Mult | Rec');
  lines.push('  -------------------------------------------|------|--------|-------|-------|-------|-------|-------------------');
  for (const c of result.candidates) {
    lines.push(renderCandidateRow(c));
  }
  lines.push('');

  // ── 3. REJECTED / DO NOT TRUST ────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  3. REJECTED / DO NOT TRUST');
  lines.push(`  ${SEP2}`, '');
  if (result.rejectedCandidates.length === 0) {
    lines.push('  None currently — all candidates either collecting or promising.');
  } else {
    for (const c of result.rejectedCandidates) {
      lines.push(`  ${recLabel(c.recommendation)}  ${c.name}  (obs=${c.observedCount}, win1=${fmtRate(c.win1Rate)})`);
    }
  }
  lines.push('');

  // ── 4. TIMING EDGE ────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  4. TIMING EDGE  (enrolled rows only — no behavior change)');
  lines.push(`  ${SEP2}`, '');
  const te = result.timingEdge;
  lines.push(`  WAIT_10M  : enrolled=${te.wait10mEnrolledCount}  observed=${te.wait10mObservedCount}  win1=${te.wait10mWin1Count} (${fmtRate(te.wait10mWin1Rate)})`);
  lines.push(`  ENTER_NOW : enrolled=${te.enterNowEnrolledCount}  observed=${te.enterNowObservedCount}  win1=${te.enterNowWin1Count} (${fmtRate(te.enterNowWin1Rate)})`);
  lines.push(`  Timing rec: ${timingRecLabel(te.recommendation)}`);
  lines.push('');

  // ── 5. OPEN INTENTS / RUN HEALTH ─────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  5. OPEN INTENTS / RUN HEALTH');
  lines.push(`  ${SEP2}`, '');
  const oi = result.openIntents;
  lines.push(`  Total intents : ${oi.totalCount}`);
  lines.push(`  Open / due    : ${oi.openCount}${oi.dueCount > 0 ? `  (${oi.dueCount} ENTRY_DUE)` : ''}`);
  lines.push(`  Expired       : ${oi.expiredCount}`);
  if (oi.warnHighOpen) {
    lines.push('  ⚠ WARNING: open intents > 5 — learning loop may not be draining');
  }
  lines.push('');
  lines.push(`  Latest run status : ${oi.latestRunStatus ?? 'unknown'}`);
  if (oi.latestRunLog) {
    lines.push(`  Latest run log    : ${oi.latestRunLog}`);
  }
  if (oi.warnTimedOut) {
    lines.push('  ⚠ WARNING: last run TIMED_OUT — check logs');
  }
  lines.push('');

  // ── 6. SAFETY STATUS ──────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  6. SAFETY STATUS');
  lines.push(`  ${SEP2}`, '');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0');
  lines.push('  realTradingLocked=true  paperOnly=true');
  lines.push('  HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('');

  // ── Overall call ───────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  CURRENT CALL');
  lines.push(SEP, '');
  lines.push(`  ${result.overallCall}`);
  lines.push('');
  lines.push(SEP, '');

  return lines.join('\n');
}
