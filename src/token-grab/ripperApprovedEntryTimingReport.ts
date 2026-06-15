import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntryTimingWindow = 'ENTER_NOW' | 'WAIT_1M' | 'WAIT_3M' | 'WAIT_5M' | 'WAIT_10M';

export interface EntryTimingRow {
  contract:        string;
  symbol:          string | null;
  approvedAt:      string;
  window:          EntryTimingWindow;
  offsetMs:        number;
  targetAt:        string;
  observedAt:      string | null;
  priceChangePct:  number | null;
  status:          'COVERED' | 'MISSING';
  clusterRisk:     string;
  scoreBand:       string;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
}

export interface WindowStats {
  window:              EntryTimingWindow;
  candidatesWithData:  number;
  totalCandidates:     number;
  coveragePct:         number;
  avgMove:             number | null;
  medianMove:          number | null;
  winRatePlus1Pct:     number | null;
  winRatePlus3Pct:     number | null;
  dumpRateMinus3Pct:   number | null;
}

export interface SubgroupAnalysis {
  key:                        string;
  dimension:                  string;
  value:                      string;
  totalCandidatesInGroup:     number;
  windowStats:                WindowStats[];
  wait10mBeatsEnterNowByAvg:  boolean;
  wait10mBeatsEnterNowByWin1: boolean;
  wait10mBeatsEnterNow:       boolean;
}

export interface RipperApprovedEntryTimingReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
  minObserved?:     number;
}

export interface RipperApprovedEntryTimingReportResult {
  generatedAt:              string;
  candidatesAnalyzed:       number;
  approvalFilesRead:        number;
  approvalFilesMissing:     number;
  observationFilesRead:     number;
  observationFilesMissing:  number;
  rowsWritten:              number;
  windowStats:              WindowStats[];
  bestByAvgMove:            EntryTimingWindow | null;
  bestByMedianMove:         EntryTimingWindow | null;
  minObserved:              number;
  subgroupAnalysis:         SubgroupAnalysis[];
  subgroupEdgesFound:       number;
  outPath:                  string;
  reportOnly:               true;
  readOnly:                 true;
  tradingExecuted:          0;
  realTradingLocked:        true;
  paperOnly:                true;
}

// ── Window definitions ────────────────────────────────────────────────────────

const TIMING_WINDOWS: Array<{ name: EntryTimingWindow; offsetMs: number }> = [
  { name: 'ENTER_NOW', offsetMs:           0 },
  { name: 'WAIT_1M',   offsetMs:      60_000 },
  { name: 'WAIT_3M',   offsetMs:  3 * 60_000 },
  { name: 'WAIT_5M',   offsetMs:  5 * 60_000 },
  { name: 'WAIT_10M',  offsetMs: 10 * 60_000 },
];

const SCORE_BANDS = ['100', '90-99', '80-89', '70-79', '60-69', 'below60', 'unknown'] as const;

// ── Internal types ────────────────────────────────────────────────────────────

interface ApprovalCandidate {
  contract:        string;
  symbol:          string | null;
  approvedAt:      string;
  clusterRisk:     string;
  ripperScore:     number | null;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
}

interface ObsRow {
  contract:       string;
  capturedAt:     string;
  priceChangePct: number | null;
}

// ── Field extractors ──────────────────────────────────────────────────────────

function extractContract(f: Record<string, unknown>): string | null {
  const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
  const raw = f['raw']             as Record<string, unknown> | undefined;
  const c   = ns?.['contract'] ?? raw?.['contract'];
  return typeof c === 'string' ? c : null;
}

function extractSymbol(f: Record<string, unknown>): string | null {
  const ns = f['normalizedSignal'] as Record<string, unknown> | undefined;
  const s  = ns?.['symbol'];
  return typeof s === 'string' ? s : null;
}

function extractClusterRisk(f: Record<string, unknown>): string {
  const raw = f['raw'] as Record<string, unknown> | undefined;
  const v   = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function extractRipperScore(f: Record<string, unknown>): number | null {
  const v = f['ripperScore'];
  return typeof v === 'number' ? v : null;
}

function extractLaunchAgeBucket(f: Record<string, unknown>): string | null {
  const v = f['launchAgeBucket'];
  return typeof v === 'string' ? v : null;
}

function extractEntryDecision(f: Record<string, unknown>): string | null {
  const v = f['entryDecision'];
  return typeof v === 'string' ? v : null;
}

function toScoreBand(score: number | null): string {
  if (score == null) return 'unknown';
  if (score >= 100)  return '100';
  if (score >= 90)   return '90-99';
  if (score >= 80)   return '80-89';
  if (score >= 70)   return '70-79';
  if (score >= 60)   return '60-69';
  return 'below60';
}

// ── Data readers ──────────────────────────────────────────────────────────────

function readApprovals(paths: string[]): {
  candidates:   ApprovalCandidate[];
  filesRead:    number;
  filesMissing: number;
} {
  let filesRead    = 0;
  let filesMissing = 0;
  const seen       = new Set<string>();
  const candidates: ApprovalCandidate[] = [];

  for (const p of paths) {
    if (!fs.existsSync(p)) { filesMissing++; continue; }
    filesRead++;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
        const contract   = extractContract(f);
        if (!contract) continue;
        const capturedAt = typeof f['capturedAt'] === 'string' ? f['capturedAt'] : null;
        if (!capturedAt) continue;
        const key = `${contract}::${capturedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          contract,
          symbol:          extractSymbol(f),
          approvedAt:      capturedAt,
          clusterRisk:     extractClusterRisk(f),
          ripperScore:     extractRipperScore(f),
          launchAgeBucket: extractLaunchAgeBucket(f),
          entryDecision:   extractEntryDecision(f),
        });
      } catch {
        // skip malformed lines
      }
    }
  }
  return { candidates, filesRead, filesMissing };
}

function readObservations(paths: string[]): {
  byContract:   Map<string, ObsRow[]>;
  filesRead:    number;
  filesMissing: number;
} {
  let filesRead    = 0;
  let filesMissing = 0;
  const byContract = new Map<string, ObsRow[]>();

  for (const p of paths) {
    if (!fs.existsSync(p)) { filesMissing++; continue; }
    filesRead++;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f   = JSON.parse(line) as Record<string, unknown>;
        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const contract   = (ns?.['contract']  ?? raw?.['contract'])  as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        let priceChangePct: number | null = null;
        if (typeof ns?.['priceChangePct'] === 'number')       priceChangePct = ns['priceChangePct']  as number;
        else if (typeof raw?.['priceChangePct'] === 'number') priceChangePct = raw['priceChangePct'] as number;
        const list = byContract.get(contract) ?? [];
        list.push({ contract, capturedAt, priceChangePct });
        byContract.set(contract, list);
      } catch {
        // skip malformed lines
      }
    }
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return { byContract, filesRead, filesMissing };
}

// ── Stats computation ─────────────────────────────────────────────────────────

function computeStats(windowName: EntryTimingWindow, subsetRows: EntryTimingRow[]): WindowStats {
  const windowRows         = subsetRows.filter(r => r.window === windowName);
  const totalCandidates    = windowRows.length;
  const covered            = windowRows.filter(r => r.status === 'COVERED' && r.priceChangePct != null);
  const candidatesWithData = covered.length;
  const coveragePct        = totalCandidates > 0
    ? Math.round((candidatesWithData / totalCandidates) * 100)
    : 0;

  if (candidatesWithData === 0) {
    return {
      window: windowName, candidatesWithData, totalCandidates, coveragePct,
      avgMove: null, medianMove: null,
      winRatePlus1Pct: null, winRatePlus3Pct: null, dumpRateMinus3Pct: null,
    };
  }

  const prices = covered.map(r => r.priceChangePct as number);
  const avg    = prices.reduce((s, n) => s + n, 0) / prices.length;

  const sorted = [...prices].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  const winRatePlus1Pct   = (prices.filter(p => p >= 1).length  / prices.length) * 100;
  const winRatePlus3Pct   = (prices.filter(p => p >= 3).length  / prices.length) * 100;
  const dumpRateMinus3Pct = (prices.filter(p => p <= -3).length / prices.length) * 100;

  return {
    window:            windowName,
    candidatesWithData,
    totalCandidates,
    coveragePct,
    avgMove:           Math.round(avg    * 100) / 100,
    medianMove:        Math.round(median * 100) / 100,
    winRatePlus1Pct:   Math.round(winRatePlus1Pct   * 10) / 10,
    winRatePlus3Pct:   Math.round(winRatePlus3Pct   * 10) / 10,
    dumpRateMinus3Pct: Math.round(dumpRateMinus3Pct * 10) / 10,
  };
}

function checkWait10mEdge(
  statsArr: WindowStats[],
  minObserved: number,
): { byAvg: boolean; byWin1: boolean } {
  const enterNow = statsArr.find(s => s.window === 'ENTER_NOW');
  const wait10m  = statsArr.find(s => s.window === 'WAIT_10M');
  if (!enterNow || !wait10m || wait10m.candidatesWithData < minObserved) {
    return { byAvg: false, byWin1: false };
  }
  const byAvg = wait10m.avgMove != null && enterNow.avgMove != null
    && wait10m.avgMove > enterNow.avgMove;
  const byWin1 = wait10m.winRatePlus1Pct != null && enterNow.winRatePlus1Pct != null
    && wait10m.winRatePlus1Pct > enterNow.winRatePlus1Pct;
  return { byAvg, byWin1 };
}

// ── Subgroup analysis ─────────────────────────────────────────────────────────

function analyzeSubgroup(
  key: string,
  dimension: string,
  value: string,
  subRows: EntryTimingRow[],
  minObserved: number,
): SubgroupAnalysis {
  const totalCandidatesInGroup = subRows.filter(r => r.window === 'ENTER_NOW').length;
  const windowStats = TIMING_WINDOWS.map(({ name }) => computeStats(name, subRows));
  const edges = checkWait10mEdge(windowStats, minObserved);
  return {
    key,
    dimension,
    value,
    totalCandidatesInGroup,
    windowStats,
    wait10mBeatsEnterNowByAvg:  edges.byAvg,
    wait10mBeatsEnterNowByWin1: edges.byWin1,
    wait10mBeatsEnterNow:       edges.byAvg || edges.byWin1,
  };
}

function buildSubgroupAnalysis(rows: EntryTimingRow[], minObserved: number): SubgroupAnalysis[] {
  const result: SubgroupAnalysis[] = [];

  // clusterRisk (fixed set)
  for (const v of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN']) {
    result.push(analyzeSubgroup(
      `clusterRisk:${v}`, 'clusterRisk', v,
      rows.filter(r => r.clusterRisk === v),
      minObserved,
    ));
  }

  // score bands (fixed set)
  for (const v of SCORE_BANDS) {
    result.push(analyzeSubgroup(
      `score:${v}`, 'score', v,
      rows.filter(r => r.scoreBand === v),
      minObserved,
    ));
  }

  // launchAgeBucket (dynamic)
  const buckets = [...new Set(rows.map(r => r.launchAgeBucket).filter((b): b is string => b != null))].sort();
  for (const b of buckets) {
    result.push(analyzeSubgroup(
      `launchAgeBucket:${b}`, 'launchAgeBucket', b,
      rows.filter(r => r.launchAgeBucket === b),
      minObserved,
    ));
  }

  // entryDecision (dynamic)
  const decisions = [...new Set(rows.map(r => r.entryDecision).filter((d): d is string => d != null))].sort();
  for (const d of decisions) {
    result.push(analyzeSubgroup(
      `entryDecision:${d}`, 'entryDecision', d,
      rows.filter(r => r.entryDecision === d),
      minObserved,
    ));
  }

  return result;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperApprovedEntryTimingReport(
  options: RipperApprovedEntryTimingReportOptions,
): RipperApprovedEntryTimingReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const minObserved = options.minObserved ?? 5;

  const {
    candidates,
    filesRead:    approvalFilesRead,
    filesMissing: approvalFilesMissing,
  } = readApprovals(options.approvalPaths);

  const {
    byContract,
    filesRead:    observationFilesRead,
    filesMissing: observationFilesMissing,
  } = readObservations(options.observationPaths);

  const rows: EntryTimingRow[] = [];

  for (const candidate of candidates) {
    const obsForContract = byContract.get(candidate.contract) ?? [];
    const approvedMs     = Date.parse(candidate.approvedAt);
    const scoreBand      = toScoreBand(candidate.ripperScore);

    for (const { name, offsetMs } of TIMING_WINDOWS) {
      const targetAt = new Date(approvedMs + offsetMs).toISOString();
      const obs      = obsForContract.find(o => o.capturedAt >= targetAt);

      rows.push({
        contract:        candidate.contract,
        symbol:          candidate.symbol,
        approvedAt:      candidate.approvedAt,
        window:          name,
        offsetMs,
        targetAt,
        observedAt:      obs?.capturedAt ?? null,
        priceChangePct:  obs?.priceChangePct ?? null,
        status:          obs ? 'COVERED' : 'MISSING',
        clusterRisk:     candidate.clusterRisk,
        scoreBand,
        launchAgeBucket: candidate.launchAgeBucket,
        entryDecision:   candidate.entryDecision,
      });
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const jsonlContent = rows.length > 0
    ? rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, jsonlContent, 'utf-8');

  const windowStats = TIMING_WINDOWS.map(({ name }) => computeStats(name, rows));

  const windowsWithData = windowStats.filter(s => s.avgMove != null);
  let bestByAvgMove:    EntryTimingWindow | null = null;
  let bestByMedianMove: EntryTimingWindow | null = null;
  if (windowsWithData.length > 0) {
    bestByAvgMove    = windowsWithData.reduce((best, s) =>
      (s.avgMove    as number) > (best.avgMove    as number) ? s : best,
    ).window;
    bestByMedianMove = windowsWithData.reduce((best, s) =>
      (s.medianMove as number) > (best.medianMove as number) ? s : best,
    ).window;
  }

  const subgroupAnalysis  = buildSubgroupAnalysis(rows, minObserved);
  const subgroupEdgesFound = subgroupAnalysis.filter(s => s.wait10mBeatsEnterNow).length;

  return {
    generatedAt,
    candidatesAnalyzed:      candidates.length,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    rowsWritten:             rows.length,
    windowStats,
    bestByAvgMove,
    bestByMedianMove,
    minObserved,
    subgroupAnalysis,
    subgroupEdgesFound,
    outPath:                 options.outPath,
    reportOnly:              true,
    readOnly:                true,
    tradingExecuted:         0,
    realTradingLocked:       true,
    paperOnly:               true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtRate(v: number | null): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(0)}%`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperApprovedEntryTimingReport(
  result: RipperApprovedEntryTimingReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER APPROVED ENTRY TIMING REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  Output path         : ${result.outPath}`);
  lines.push(`  Candidates analyzed : ${result.candidatesAnalyzed}`);
  lines.push(`  Rows written        : ${result.rowsWritten}`);
  lines.push(`  Generated at        : ${result.generatedAt}`);
  lines.push('');

  // ── Overall timing comparison ─────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  TIMING WINDOW COMPARISON');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  Window      Coverage  AvgMove  Median  Win>=1%  Win>=3%  Dump<=-3%');
  lines.push(`  ${SEP2}`);

  for (const s of result.windowStats) {
    const cov    = `${s.coveragePct}%`.padEnd(9);
    const avg    = fmtPct(s.avgMove).padEnd(8);
    const median = fmtPct(s.medianMove).padEnd(7);
    const win1   = fmtRate(s.winRatePlus1Pct).padEnd(8);
    const win3   = fmtRate(s.winRatePlus3Pct).padEnd(8);
    const dump   = fmtRate(s.dumpRateMinus3Pct);
    lines.push(`  ${s.window.padEnd(11)} ${cov} ${avg} ${median} ${win1} ${win3} ${dump}`);
  }
  lines.push('');

  if (result.bestByAvgMove || result.bestByMedianMove) {
    lines.push(`  ${SEP2}`);
    lines.push('  BEST TIMING');
    lines.push(`  ${SEP2}`, '');
    if (result.bestByAvgMove)    lines.push(`  Best by avg move    : ${result.bestByAvgMove}`);
    if (result.bestByMedianMove) lines.push(`  Best by median move : ${result.bestByMedianMove}`);
    lines.push('');
  }

  // ── Subgroup timing edges ─────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push(`  SUBGROUP TIMING EDGES  (WAIT_10M > ENTER_NOW, min observed = ${result.minObserved})`);
  lines.push(`  ${SEP2}`, '');

  const edges = result.subgroupAnalysis.filter(s => s.wait10mBeatsEnterNow);

  if (edges.length === 0) {
    lines.push('  NO_SUBGROUP_EDGE_FOUND');
    lines.push('');
  } else {
    lines.push('  Subgroup                         n    EN-avg   W10-avg  EN-win1%  W10-win1%  Edge');
    lines.push(`  ${SEP2}`);
    for (const sg of edges) {
      const en  = sg.windowStats.find(s => s.window === 'ENTER_NOW')!;
      const w10 = sg.windowStats.find(s => s.window === 'WAIT_10M')!;
      const edgeLabel = sg.wait10mBeatsEnterNowByAvg && sg.wait10mBeatsEnterNowByWin1
        ? 'avg+win1'
        : sg.wait10mBeatsEnterNowByAvg ? 'avg' : 'win1';
      const keyStr   = sg.key.padEnd(32);
      const nStr     = String(w10.candidatesWithData).padEnd(4);
      const enAvg    = fmtPct(en.avgMove).padEnd(8);
      const w10Avg   = fmtPct(w10.avgMove).padEnd(8);
      const enWin1   = fmtRate(en.winRatePlus1Pct).padEnd(9);
      const w10Win1  = fmtRate(w10.winRatePlus1Pct).padEnd(10);
      lines.push(`  ${keyStr} ${nStr} ${enAvg} ${w10Avg} ${enWin1} ${w10Win1} ${edgeLabel}`);
    }
    lines.push('');
  }

  // ── Safety ────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Report only — no trades, no paper positions, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
