import * as fs from 'fs';
import type { LedgerRow } from './resolvedCandidateLedger';

export type { LedgerRow };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GroupAverages {
  count:                  number;
  latestReturnPct:        number | null;
  maxKnownReturnPct:      number | null;
  minKnownReturnPct:      number | null;
  bestSimulatedExitPct:   number | null;
  volumeToLiquidityRatio: number | null;
  bubbleMapsScore:        number | null;
  topHolderPercent:       number | null;
  entryLiquidityUsd:      number | null;
  entryVolumeUsd:         number | null;
  estimatedSlippagePct:   number | null;
  snapshotCount:          number | null;
}

export interface RowWithNotes {
  row:   LedgerRow;
  notes: string[];
}

export interface LedgerAnalyticsOptions {
  ledgerPath?:  string;
  generatedAt?: string;
}

export interface LedgerAnalyticsResult {
  ledgerPath:       string;
  generatedAt:      string;
  ledgerMissing:    boolean;
  totalRows:        number;
  resolvedRows:     number;
  winnerCount:      number;
  flatCount:        number;
  dumperCount:      number;
  hit25Count:       number;
  hit50Count:       number;
  hit100Count:      number;
  hitSL15Count:     number;
  avgLatestReturn:  number | null;
  avgMaxReturn:     number | null;
  avgBestSimExit:   number | null;
  winnerRows:       LedgerRow[];
  flatRows:         LedgerRow[];
  dumperRows:       LedgerRow[];
  winnerAverages:   GroupAverages;
  flatAverages:     GroupAverages;
  dumperAverages:   GroupAverages;
  dumperInspection: RowWithNotes[];
  winnerInspection: RowWithNotes[];
  hypotheses:       string[];
  tradingExecuted:  0;
  noRealTradeSent:  true;
  paperOnly:        true;
  readOnly:         true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LEDGER = 'data/token-grab/outcomes/resolved-candidate-ledger.jsonl';

// ── Helpers ───────────────────────────────────────────────────────────────────

function avgOf(values: (number | null)[]): number | null {
  const ns = values.filter((v): v is number => v !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

function computeGroupAverages(rows: LedgerRow[]): GroupAverages {
  return {
    count:                  rows.length,
    latestReturnPct:        avgOf(rows.map(r => r.latestReturnPct)),
    maxKnownReturnPct:      avgOf(rows.map(r => r.maxKnownReturnPct)),
    minKnownReturnPct:      avgOf(rows.map(r => r.minKnownReturnPct)),
    bestSimulatedExitPct:   avgOf(rows.map(r => r.bestSimulatedExitPct)),
    volumeToLiquidityRatio: avgOf(rows.map(r => r.volumeToLiquidityRatio)),
    bubbleMapsScore:        avgOf(rows.map(r => r.bubbleMapsScore)),
    topHolderPercent:       avgOf(rows.map(r => r.topHolderPercent)),
    entryLiquidityUsd:      avgOf(rows.map(r => r.entryLiquidityUsd)),
    entryVolumeUsd:         avgOf(rows.map(r => r.entryVolumeUsd)),
    estimatedSlippagePct:   avgOf(rows.map(r => r.estimatedSlippagePct)),
    snapshotCount:          avgOf(rows.map(r => r.snapshotCount)),
  };
}

function buildDumperNotes(
  row:             LedgerRow,
  winnerAvgVL:     number | null,
  winnerAvgBubble: number | null,
  winnerAvgHolder: number | null,
): string[] {
  const notes: string[] = [];
  if (winnerAvgVL !== null && row.volumeToLiquidityRatio !== null && row.volumeToLiquidityRatio < winnerAvgVL) {
    notes.push('low vol/liq but dumped');
  }
  if (winnerAvgBubble !== null && row.bubbleMapsScore !== null && row.bubbleMapsScore > winnerAvgBubble) {
    notes.push('high BubbleMaps but dumped');
  }
  if (winnerAvgHolder !== null && row.topHolderPercent !== null && row.topHolderPercent < winnerAvgHolder) {
    notes.push('low holder% but dumped');
  }
  if (row.hitSL15) {
    notes.push('SL15 would have saved');
  }
  return notes;
}

function buildWinnerNotes(
  row:             LedgerRow,
  dumperAvgVL:     number | null,
  dumperAvgBubble: number | null,
): string[] {
  const notes: string[] = [];
  if (row.hit25)  notes.push('hit TP25');
  if (row.hit50)  notes.push('hit TP50');
  if (row.hit100) notes.push('hit TP100');
  if (dumperAvgVL !== null && row.volumeToLiquidityRatio !== null && row.volumeToLiquidityRatio > dumperAvgVL) {
    notes.push('high vol/liq but won');
  }
  if (dumperAvgBubble !== null && row.bubbleMapsScore !== null && row.bubbleMapsScore < dumperAvgBubble) {
    notes.push('low BubbleMaps but won');
  }
  return notes;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadLedgerRows(ledgerPath: string): LedgerRow[] {
  if (!fs.existsSync(ledgerPath)) return [];
  let content: string;
  try { content = fs.readFileSync(ledgerPath, 'utf-8'); } catch { return []; }
  const rows: LedgerRow[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as LedgerRow;
      if (typeof row.contract === 'string') rows.push(row);
    } catch { /* skip malformed */ }
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function runLedgerAnalytics(options: LedgerAnalyticsOptions = {}): LedgerAnalyticsResult {
  const ledgerPath  = options.ledgerPath  ?? DEFAULT_LEDGER;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const emptyResult = (missing: boolean): LedgerAnalyticsResult => ({
    ledgerPath, generatedAt, ledgerMissing: missing,
    totalRows: 0, resolvedRows: 0,
    winnerCount: 0, flatCount: 0, dumperCount: 0,
    hit25Count: 0, hit50Count: 0, hit100Count: 0, hitSL15Count: 0,
    avgLatestReturn: null, avgMaxReturn: null, avgBestSimExit: null,
    winnerRows: [], flatRows: [], dumperRows: [],
    winnerAverages: computeGroupAverages([]),
    flatAverages:   computeGroupAverages([]),
    dumperAverages: computeGroupAverages([]),
    dumperInspection: [], winnerInspection: [], hypotheses: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  });

  if (!fs.existsSync(ledgerPath)) return emptyResult(true);

  const allRows = loadLedgerRows(ledgerPath);
  if (allRows.length === 0) return emptyResult(false);

  const winnerRows = allRows.filter(r => r.outcomeStatus === 'RIPPED' || r.outcomeStatus === 'MOVED');
  const flatRows   = allRows.filter(r => r.outcomeStatus === 'FLAT');
  const dumperRows = allRows.filter(r => r.outcomeStatus === 'DUMPED');

  const winnerAverages = computeGroupAverages(winnerRows);
  const flatAverages   = computeGroupAverages(flatRows);
  const dumperAverages = computeGroupAverages(dumperRows);

  const resolvedRows = allRows.filter(r => r.resolved).length;

  let hit25Count = 0, hit50Count = 0, hit100Count = 0, hitSL15Count = 0;
  for (const row of allRows) {
    if (row.hit25)   hit25Count++;
    if (row.hit50)   hit50Count++;
    if (row.hit100)  hit100Count++;
    if (row.hitSL15) hitSL15Count++;
  }

  const dumperInspection: RowWithNotes[] = dumperRows.map(row => ({
    row,
    notes: buildDumperNotes(
      row,
      winnerAverages.volumeToLiquidityRatio,
      winnerAverages.bubbleMapsScore,
      winnerAverages.topHolderPercent,
    ),
  }));

  const winnerInspection: RowWithNotes[] = winnerRows.map(row => ({
    row,
    notes: buildWinnerNotes(
      row,
      dumperAverages.volumeToLiquidityRatio,
      dumperAverages.bubbleMapsScore,
    ),
  }));

  const hypotheses: string[] = [];
  if (hitSL15Count > 0) {
    hypotheses.push('SL15 remains protective');
  }
  if (
    winnerAverages.bubbleMapsScore !== null &&
    dumperAverages.bubbleMapsScore !== null &&
    winnerAverages.bubbleMapsScore <= dumperAverages.bubbleMapsScore
  ) {
    hypotheses.push('BubbleMaps score is not profit predictor');
  }
  if (
    winnerAverages.volumeToLiquidityRatio !== null &&
    dumperRows.some(
      r => r.volumeToLiquidityRatio !== null &&
           r.volumeToLiquidityRatio < winnerAverages.volumeToLiquidityRatio!,
    )
  ) {
    hypotheses.push('Vol/Liq alone is insufficient');
  }
  hypotheses.push('Need >=20 resolved rows before rule changes');

  return {
    ledgerPath, generatedAt, ledgerMissing: false,
    totalRows: allRows.length, resolvedRows,
    winnerCount:  winnerRows.length,
    flatCount:    flatRows.length,
    dumperCount:  dumperRows.length,
    hit25Count, hit50Count, hit100Count, hitSL15Count,
    avgLatestReturn: avgOf(allRows.map(r => r.latestReturnPct)),
    avgMaxReturn:    avgOf(allRows.map(r => r.maxKnownReturnPct)),
    avgBestSimExit:  avgOf(allRows.map(r => r.bestSimulatedExitPct)),
    winnerRows, flatRows, dumperRows,
    winnerAverages, flatAverages, dumperAverages,
    dumperInspection, winnerInspection, hypotheses,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fp(n: number | null, d = 1, sign = false): string {
  if (n === null) return '—';
  const s = sign && n >= 0 ? '+' : '';
  return `${s}${n.toFixed(d)}%`;
}

function fn(n: number | null, d = 2): string {
  if (n === null) return '—';
  return n.toFixed(d);
}

function fk(n: number | null): string {
  if (n === null) return '—';
  return `$${(n / 1000).toFixed(1)}k`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function rpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderLedgerAnalyticsReport(result: LedgerAnalyticsResult): string {
  const L: string[] = [];

  L.push('');
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push('  TOKEN GRAB — LEDGER ANALYTICS V1');
  L.push('  [REAL TRADING LOCKED — READ ONLY]');
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.ledgerMissing) {
    L.push('');
    L.push(`  No ledger found at: ${result.ledgerPath}`);
    L.push('  Run token:resolved-ledger first.');
    L.push('');
    L.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    L.push('');
    return L.join('\n');
  }

  const { totalRows, resolvedRows, winnerCount, flatCount, dumperCount,
          hit25Count, hit50Count, hit100Count, hitSL15Count,
          avgLatestReturn, avgMaxReturn, avgBestSimExit,
          winnerAverages, flatAverages, dumperAverages,
          dumperInspection, winnerInspection, hypotheses,
          generatedAt, ledgerPath } = result;

  // ── 1. Summary ──────────────────────────────────────────────────────────────
  L.push('');
  L.push('  1. SUMMARY');
  L.push(`     Generated        : ${generatedAt}`);
  L.push(`     Ledger path      : ${ledgerPath}`);
  L.push(`     Total rows       : ${totalRows}`);
  L.push(`     Resolved         : ${resolvedRows}`);
  L.push(`     Winners (RIPPED/MOVED): ${winnerCount}`);
  L.push(`     Flats            : ${flatCount}`);
  L.push(`     Dumpers          : ${dumperCount}`);
  L.push(`     Hit >=25%        : ${hit25Count}`);
  L.push(`     Hit >=50%        : ${hit50Count}`);
  L.push(`     Hit >=100%       : ${hit100Count}`);
  L.push(`     Hit SL15         : ${hitSL15Count}`);
  L.push(`     Avg latest rtn   : ${fp(avgLatestReturn, 1, true)}`);
  L.push(`     Avg max return   : ${fp(avgMaxReturn, 1, true)}`);
  L.push(`     Avg best sim exit: ${fp(avgBestSimExit, 1, true)}`);
  L.push('');

  if (totalRows === 0) {
    L.push('  No rows in ledger.');
    L.push('  Run token:resolved-ledger to populate.');
    L.push('');
    L.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    L.push('');
    return L.join('\n');
  }

  // ── 2. Outcome Groups ───────────────────────────────────────────────────────
  L.push('  2. OUTCOME GROUPS');
  const COL = 16;
  const W   = 13;

  const gHdr = [
    pad('Metric', 28),
    rpad(`Winners (N=${winnerAverages.count})`, W),
    rpad(`Flats (N=${flatAverages.count})`, W),
    rpad(`Dumpers (N=${dumperAverages.count})`, W),
  ].join('  ');
  L.push(`     ${gHdr}`);
  L.push(`     ${'─'.repeat(gHdr.length)}`);

  const gRow = (label: string, wv: string, fv: string, dv: string) =>
    L.push(`     ${pad(label, 28)}  ${rpad(wv, W)}  ${rpad(fv, W)}  ${rpad(dv, W)}`);

  gRow('Avg latest rtn%',
    fp(winnerAverages.latestReturnPct, 1, true),
    fp(flatAverages.latestReturnPct, 1, true),
    fp(dumperAverages.latestReturnPct, 1, true));
  gRow('Avg max rtn%',
    fp(winnerAverages.maxKnownReturnPct, 1, true),
    fp(flatAverages.maxKnownReturnPct, 1, true),
    fp(dumperAverages.maxKnownReturnPct, 1, true));
  gRow('Avg min rtn%',
    fp(winnerAverages.minKnownReturnPct, 1, true),
    fp(flatAverages.minKnownReturnPct, 1, true),
    fp(dumperAverages.minKnownReturnPct, 1, true));
  gRow('Avg best sim exit%',
    fp(winnerAverages.bestSimulatedExitPct, 1, true),
    fp(flatAverages.bestSimulatedExitPct, 1, true),
    fp(dumperAverages.bestSimulatedExitPct, 1, true));
  gRow('Avg vol/liq',
    fn(winnerAverages.volumeToLiquidityRatio, 3),
    fn(flatAverages.volumeToLiquidityRatio, 3),
    fn(dumperAverages.volumeToLiquidityRatio, 3));
  gRow('Avg BubbleMaps score',
    fn(winnerAverages.bubbleMapsScore, 1),
    fn(flatAverages.bubbleMapsScore, 1),
    fn(dumperAverages.bubbleMapsScore, 1));
  gRow('Avg top holder%',
    fp(winnerAverages.topHolderPercent, 1),
    fp(flatAverages.topHolderPercent, 1),
    fp(dumperAverages.topHolderPercent, 1));
  gRow('Avg entry liq',
    fk(winnerAverages.entryLiquidityUsd),
    fk(flatAverages.entryLiquidityUsd),
    fk(dumperAverages.entryLiquidityUsd));
  gRow('Avg entry vol',
    fk(winnerAverages.entryVolumeUsd),
    fk(flatAverages.entryVolumeUsd),
    fk(dumperAverages.entryVolumeUsd));
  gRow('Avg slippage%',
    fp(winnerAverages.estimatedSlippagePct, 3),
    fp(flatAverages.estimatedSlippagePct, 3),
    fp(dumperAverages.estimatedSlippagePct, 3));
  gRow('Avg snapshot count',
    fn(winnerAverages.snapshotCount, 0),
    fn(flatAverages.snapshotCount, 0),
    fn(dumperAverages.snapshotCount, 0));
  L.push('');

  // ── 3. Dumper Inspection ────────────────────────────────────────────────────
  L.push('  3. DUMPER INSPECTION');
  if (dumperInspection.length === 0) {
    L.push('     No dumpers yet.');
  } else {
    const dHdr = [
      pad('Symbol',   10),
      rpad('Latest%', 8),
      rpad('Min%',    8),
      rpad('Vol/Liq', 8),
      rpad('Bubble',  7),
      rpad('Holder%', 8),
      rpad('EntryLiq', 9),
      pad('BestExit',  9),
      'Notes',
    ].join('  ');
    L.push(`     ${dHdr}`);
    L.push(`     ${'─'.repeat(Math.min(dHdr.length, 100))}`);
    for (const { row, notes } of dumperInspection) {
      const cols = [
        pad(`$${row.symbol}`,              10),
        rpad(fp(row.latestReturnPct, 1, true),  8),
        rpad(fp(row.minKnownReturnPct, 1, true), 8),
        rpad(fn(row.volumeToLiquidityRatio, 3), 8),
        rpad(fn(row.bubbleMapsScore, 1),         7),
        rpad(fp(row.topHolderPercent, 1),        8),
        rpad(fk(row.entryLiquidityUsd),          9),
        pad(row.bestSimulatedExit,               9),
        notes.join('; ') || '—',
      ].join('  ');
      L.push(`     ${cols}`);
    }
  }
  L.push('');

  // ── 4. Winner Inspection ────────────────────────────────────────────────────
  L.push('  4. WINNER INSPECTION');
  if (winnerInspection.length === 0) {
    L.push('     No winners yet.');
  } else {
    const wHdr = [
      pad('Symbol',   10),
      rpad('Latest%', 8),
      rpad('Max%',    8),
      rpad('Vol/Liq', 8),
      rpad('Bubble',  7),
      rpad('Holder%', 8),
      rpad('EntryLiq', 9),
      pad('BestExit',  9),
      'Notes',
    ].join('  ');
    L.push(`     ${wHdr}`);
    L.push(`     ${'─'.repeat(Math.min(wHdr.length, 100))}`);
    for (const { row, notes } of winnerInspection) {
      const cols = [
        pad(`$${row.symbol}`,              10),
        rpad(fp(row.latestReturnPct, 1, true),  8),
        rpad(fp(row.maxKnownReturnPct, 1, true), 8),
        rpad(fn(row.volumeToLiquidityRatio, 3), 8),
        rpad(fn(row.bubbleMapsScore, 1),         7),
        rpad(fp(row.topHolderPercent, 1),        8),
        rpad(fk(row.entryLiquidityUsd),          9),
        pad(row.bestSimulatedExit,               9),
        notes.join('; ') || '—',
      ].join('  ');
      L.push(`     ${cols}`);
    }
  }
  L.push('');

  // ── 5. Gate Hypotheses ──────────────────────────────────────────────────────
  L.push('  5. GATE HYPOTHESES  (do not change gates — observational only)');
  L.push('  ─────────────────────────────────────────────────────────────────');
  if (hypotheses.length === 0) {
    L.push('     No hypotheses generated yet — need at least winners AND dumpers.');
  } else {
    for (const h of hypotheses) {
      L.push(`     • ${h}`);
    }
  }
  L.push('');
  if (resolvedRows < 20) {
    L.push(`  ⚠  Do not change gates until >=20 resolved rows  (currently ${resolvedRows})`);
  }
  L.push('  ─────────────────────────────────────────────────────────────────');
  L.push('  Gate changes require >=20 resolved candidates with consistent signal.');
  L.push('  Real trading remains locked. This is a read-only reporting tool.');
  L.push('  ─────────────────────────────────────────────────────────────────');
  L.push('');
  L.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push('');
  return L.join('\n');
}
