import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntryMomentumSampleRow {
  contract:             string | null;
  symbol:               string | null;
  capturedAt:           string | null;
  entryMomentumPct:     number | null;
  entryMomentumSource:  string | null;
  entryMomentumWindowLabel: string | null;
}

export interface EntryMomentumAuditResult {
  cycleFilesRead:       number;
  totalRows:            number;
  rowsWithField:        number;
  rowsWithNonNull:      number;
  rowsMissing:          number;
  sourcesSeen:          Record<string, number>;
  windowLabelsSeen:     Record<string, number>;
  sampleRows:           EntryMomentumSampleRow[];
  warnings:             string[];
  reportOnly:           true;
  readOnly:             true;
  paperOnly:            true;
  realTradingLocked:    true;
  tradingExecuted:      0;
}

export interface EntryMomentumAuditOptions {
  cyclesDir?: string;
  allCycles?: boolean;
  maxSamples?: number;
  nowMs?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CYCLES_DIR = 'data/token-grab/ripper/cycles';
const DEFAULT_MAX_SAMPLES = 5;

const SAFETY = {
  reportOnly:        true as const,
  readOnly:          true as const,
  paperOnly:         true as const,
  realTradingLocked: true as const,
  tradingExecuted:   0   as const,
};

// ── File helpers ──────────────────────────────────────────────────────────────

function findCycleJsonlFiles(cyclesDir: string, allCycles: boolean): string[] {
  if (!fs.existsSync(cyclesDir)) return [];
  const files = fs.readdirSync(cyclesDir)
    .filter(f => f.match(/^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/))
    .sort();
  if (files.length === 0) return [];
  if (!allCycles) return [path.join(cyclesDir, files[files.length - 1])];
  return files.map(f => path.join(cyclesDir, f));
}

function readJsonlRows(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())) {
    try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
  }
  return rows;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runEntryMomentumAudit(
  options: EntryMomentumAuditOptions = {},
): EntryMomentumAuditResult {
  const cyclesDir  = options.cyclesDir  ?? DEFAULT_CYCLES_DIR;
  const allCycles  = options.allCycles  ?? false;
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;

  const warnings: string[] = [];
  const cycleFiles = findCycleJsonlFiles(cyclesDir, allCycles);

  if (cycleFiles.length === 0) {
    warnings.push(`No cycle JSONL files found in ${cyclesDir}`);
  }

  const allRows: Record<string, unknown>[] = [];
  for (const f of cycleFiles) {
    allRows.push(...readJsonlRows(f));
  }

  const totalRows        = allRows.length;
  let   rowsWithField    = 0;
  let   rowsWithNonNull  = 0;
  const sourcesSeen:      Record<string, number> = {};
  const windowLabelsSeen: Record<string, number> = {};
  const sampleRows: EntryMomentumSampleRow[] = [];

  for (const row of allRows) {
    const hasField = 'entryMomentumPct' in row;
    if (hasField) rowsWithField++;

    const pct    = row['entryMomentumPct'];
    const src    = typeof row['entryMomentumSource']      === 'string' ? row['entryMomentumSource']      : null;
    const window = typeof row['entryMomentumWindowLabel'] === 'string' ? row['entryMomentumWindowLabel'] : null;

    if (pct != null && typeof pct === 'number' && Number.isFinite(pct)) rowsWithNonNull++;

    if (src)    sourcesSeen[src]    = (sourcesSeen[src]    ?? 0) + 1;
    if (window) windowLabelsSeen[window] = (windowLabelsSeen[window] ?? 0) + 1;

    if (sampleRows.length < maxSamples) {
      const ns = row['normalizedSignal'] as Record<string, unknown> | undefined;
      sampleRows.push({
        contract:             (typeof ns?.['contract'] === 'string' ? ns['contract'] : typeof row['contract'] === 'string' ? row['contract'] : null),
        symbol:               (typeof ns?.['symbol']   === 'string' ? ns['symbol']   : typeof row['symbol']   === 'string' ? row['symbol']   : null),
        capturedAt:           typeof row['capturedAt'] === 'string' ? row['capturedAt'] : null,
        entryMomentumPct:     (typeof pct === 'number' && Number.isFinite(pct)) ? pct : null,
        entryMomentumSource:  src,
        entryMomentumWindowLabel: window,
      });
    }
  }

  const rowsMissing = totalRows - rowsWithField;

  // Warnings
  if (rowsWithNonNull === 0 && totalRows > 0) {
    warnings.push(
      'entryMomentumPct is null/missing on ALL rows — no independent capture-time price field is ' +
      'available in the current dex-watch pipeline. The existing priceChangePct is the 1-minute ' +
      'observation window that directly determines outcomeLabel and MUST NOT be reused as ' +
      'entryMomentumPct.',
    );
  }
  if (sourcesSeen['UNAVAILABLE'] != null) {
    warnings.push(
      `entryMomentumSource=UNAVAILABLE on ${sourcesSeen['UNAVAILABLE']} rows. ` +
      'To fix: capture priceChange.m5 from the DexScreener API inside dexWatch.ts fetchSnapshot() ' +
      'and forward it as entryMomentumPct with source=DEX_SCREENER_M5, windowLabel=M5.',
    );
  }

  return {
    cycleFilesRead:   cycleFiles.length,
    totalRows,
    rowsWithField,
    rowsWithNonNull,
    rowsMissing,
    sourcesSeen,
    windowLabelsSeen,
    sampleRows,
    warnings,
    ...SAFETY,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderEntryMomentumAudit(result: EntryMomentumAuditResult): string {
  const L: string[] = [];
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';

  L.push('');
  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER ENTRY-MOMENTUM AUDIT');
  L.push('  [REPORT ONLY — NO TRADES — NO GATE CHANGES — READ ONLY]');
  L.push(SEP, '');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — COVERAGE SUMMARY');
  L.push(`  ${SEP2}`, '');
  L.push(`  Cycle files read          : ${result.cycleFilesRead}`);
  L.push(`  Total rows                : ${result.totalRows}`);
  L.push(`  Rows with field present   : ${result.rowsWithField}`);
  L.push(`  Rows with non-null value  : ${result.rowsWithNonNull}`);
  L.push(`  Rows missing field        : ${result.rowsMissing}`);
  const pct = result.totalRows > 0
    ? ((result.rowsWithNonNull / result.totalRows) * 100).toFixed(1)
    : 'n/a';
  L.push(`  Non-null coverage         : ${pct}%`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — SOURCES SEEN');
  L.push(`  ${SEP2}`, '');
  const srcs = Object.entries(result.sourcesSeen);
  if (srcs.length === 0) {
    L.push('  (none)');
  } else {
    for (const [src, count] of srcs) {
      L.push(`  ${src.padEnd(30)} : ${count}`);
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — WINDOW LABELS SEEN');
  L.push(`  ${SEP2}`, '');
  const windows = Object.entries(result.windowLabelsSeen);
  if (windows.length === 0) {
    L.push('  (none)');
  } else {
    for (const [w, count] of windows) {
      L.push(`  ${w.padEnd(30)} : ${count}`);
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — SAMPLE ROWS');
  L.push(`  ${SEP2}`, '');
  if (result.sampleRows.length === 0) {
    L.push('  (no rows)');
  } else {
    for (const r of result.sampleRows) {
      const sym = r.symbol ?? r.contract?.slice(0, 12) ?? 'unknown';
      L.push(`  ${sym}`);
      L.push(`    capturedAt           : ${r.capturedAt ?? 'n/a'}`);
      L.push(`    entryMomentumPct     : ${r.entryMomentumPct ?? 'null'}`);
      L.push(`    entryMomentumSource  : ${r.entryMomentumSource ?? 'n/a'}`);
      L.push(`    entryMomentumWindow  : ${r.entryMomentumWindowLabel ?? 'n/a'}`);
      L.push('');
    }
  }

  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — WARNINGS');
  L.push(`  ${SEP2}`, '');
  if (result.warnings.length === 0) {
    L.push('  (none)');
  } else {
    for (const w of result.warnings) {
      L.push(`  ⚠ ${w}`);
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    NO_GATE_CHANGES=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  paperOnly=true    entryMomentumPct MUST NOT be used to approve buys.');
  L.push('  Do not call token:auto-paper or token:paper-buy from this audit.');
  L.push(SEP, '');

  return L.join('\n');
}
