import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntryTimingWindow = 'ENTER_NOW' | 'WAIT_1M' | 'WAIT_3M' | 'WAIT_5M' | 'WAIT_10M';

export interface EntryTimingRow {
  contract:       string;
  symbol:         string | null;
  approvedAt:     string;
  window:         EntryTimingWindow;
  offsetMs:       number;
  targetAt:       string;
  observedAt:     string | null;
  priceChangePct: number | null;
  status:         'COVERED' | 'MISSING';
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

export interface RipperApprovedEntryTimingReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
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

// ── Internal types ────────────────────────────────────────────────────────────

interface ApprovalCandidate {
  contract:   string;
  symbol:     string | null;
  approvedAt: string;
}

interface ObsRow {
  contract:       string;
  capturedAt:     string;
  priceChangePct: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        candidates.push({ contract, symbol: extractSymbol(f), approvedAt: capturedAt });
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
        if (typeof ns?.['priceChangePct'] === 'number')  priceChangePct = ns['priceChangePct']  as number;
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

function computeWindowStats(window: EntryTimingWindow, rows: EntryTimingRow[]): WindowStats {
  const windowRows        = rows.filter(r => r.window === window);
  const totalCandidates   = windowRows.length;
  const covered           = windowRows.filter(r => r.status === 'COVERED' && r.priceChangePct != null);
  const candidatesWithData = covered.length;
  const coveragePct       = totalCandidates > 0
    ? Math.round((candidatesWithData / totalCandidates) * 100)
    : 0;

  if (candidatesWithData === 0) {
    return {
      window, candidatesWithData, totalCandidates, coveragePct,
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
    window,
    candidatesWithData,
    totalCandidates,
    coveragePct,
    avgMove:            Math.round(avg    * 100) / 100,
    medianMove:         Math.round(median * 100) / 100,
    winRatePlus1Pct:    Math.round(winRatePlus1Pct   * 10) / 10,
    winRatePlus3Pct:    Math.round(winRatePlus3Pct   * 10) / 10,
    dumpRateMinus3Pct:  Math.round(dumpRateMinus3Pct * 10) / 10,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperApprovedEntryTimingReport(
  options: RipperApprovedEntryTimingReportOptions,
): RipperApprovedEntryTimingReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

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

    for (const { name, offsetMs } of TIMING_WINDOWS) {
      const targetAt = new Date(approvedMs + offsetMs).toISOString();
      const obs      = obsForContract.find(o => o.capturedAt >= targetAt);

      if (obs) {
        rows.push({
          contract:       candidate.contract,
          symbol:         candidate.symbol,
          approvedAt:     candidate.approvedAt,
          window:         name,
          offsetMs,
          targetAt,
          observedAt:     obs.capturedAt,
          priceChangePct: obs.priceChangePct,
          status:         'COVERED',
        });
      } else {
        rows.push({
          contract:       candidate.contract,
          symbol:         candidate.symbol,
          approvedAt:     candidate.approvedAt,
          window:         name,
          offsetMs,
          targetAt,
          observedAt:     null,
          priceChangePct: null,
          status:         'MISSING',
        });
      }
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const jsonlContent = rows.length > 0
    ? rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, jsonlContent, 'utf-8');

  const windowStats = TIMING_WINDOWS.map(({ name }) => computeWindowStats(name, rows));

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
    outPath:                 options.outPath,
    reportOnly:              true,
    readOnly:                true,
    tradingExecuted:         0,
    realTradingLocked:       true,
    paperOnly:               true,
  };
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

  lines.push(`  ${SEP2}`);
  lines.push('  TIMING WINDOW COMPARISON');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push(
    '  Window      Coverage  AvgMove  Median  Win≥1%  Win≥3%  Dump≤-3%',
  );
  lines.push(`  ${SEP2}`);

  for (const s of result.windowStats) {
    const cov     = `${s.coveragePct}%`.padEnd(9);
    const avg     = s.avgMove    != null ? `${s.avgMove >= 0 ? '+' : ''}${s.avgMove.toFixed(1)}%` : 'n/a';
    const median  = s.medianMove != null ? `${s.medianMove >= 0 ? '+' : ''}${s.medianMove.toFixed(1)}%` : 'n/a';
    const win1    = s.winRatePlus1Pct   != null ? `${s.winRatePlus1Pct.toFixed(0)}%`   : 'n/a';
    const win3    = s.winRatePlus3Pct   != null ? `${s.winRatePlus3Pct.toFixed(0)}%`   : 'n/a';
    const dump    = s.dumpRateMinus3Pct != null ? `${s.dumpRateMinus3Pct.toFixed(0)}%` : 'n/a';
    lines.push(
      `  ${s.window.padEnd(11)} ${cov} ${avg.padEnd(8)} ${median.padEnd(7)} ${win1.padEnd(7)} ${win3.padEnd(7)} ${dump}`,
    );
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
