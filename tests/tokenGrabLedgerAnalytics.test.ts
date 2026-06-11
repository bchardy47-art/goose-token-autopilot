import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadLedgerRows,
  runLedgerAnalytics,
  renderLedgerAnalyticsReport,
  type LedgerRow,
} from '../src/token-grab/ledgerAnalytics';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeLedgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    firstSeenAt:               '2026-06-10T00:00:00.000Z',
    lastUpdatedAt:             '2026-06-11T00:00:00.000Z',
    symbol:                    'TEST',
    contract:                  '0xtest',
    pairUrl:                   'https://dexscreener.com/solana/test',
    chainId:                   'solana',
    entryPriceUsd:             0.001,
    latestPriceUsd:            0.0012,
    latestReturnPct:           20,
    maxKnownReturnPct:         25,
    minKnownReturnPct:         -5,
    checkpointStatus:          'HIT_25',
    outcomeStatus:             'MOVED',
    resolved:                  true,
    snapshotCount:             10,
    hit25:                     true,
    hit50:                     false,
    hit100:                    false,
    hitSL15:                   false,
    bestSimulatedExit:         'tp25',
    bestSimulatedExitPct:      25,
    holdLatestPct:             20,
    tp25Pct:                   25,
    tp50Pct:                   20,
    sl15Pct:                   20,
    sl25Pct:                   20,
    trail20Pct:                20,
    holderConcentrationStatus: 'CLEAN',
    topHolderPercent:          10,
    clusterRisk:               'CLEAN',
    bubbleMapsScore:           70,
    entryLiquidityUsd:         50000,
    entryVolumeUsd:            5000,
    volumeToLiquidityRatio:    0.1,
    liquidityChangePct:        0,
    priceChangePct:            0,
    estimatedSlippagePct:      0.01,
    source:                    'resolved-ledger-v1',
    ...overrides,
  };
}

function writeLedger(rows: LedgerRow[]): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-analytics-'));
  const file = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

// ── Rows representative of real data ──────────────────────────────────────────

const WINNER_ROW = makeLedgerRow({
  symbol: 'MAITIU', contract: '0xmaitiu',
  outcomeStatus: 'RIPPED', latestReturnPct: 80.8,
  maxKnownReturnPct: 109.3, minKnownReturnPct: -3,
  hit25: true, hit50: true, hit100: true,
  bubbleMapsScore: 84.28, topHolderPercent: 9.13,
  volumeToLiquidityRatio: 0.561, entryLiquidityUsd: 45000,
  bestSimulatedExit: 'tp50', bestSimulatedExitPct: 50,
  hitSL15: false,
});

const WINNER_ROW2 = makeLedgerRow({
  symbol: 'XRPS', contract: '0xxrps',
  outcomeStatus: 'MOVED', latestReturnPct: 30.6,
  maxKnownReturnPct: 36.5, minKnownReturnPct: 0,
  hit25: true, hit50: false, hit100: false,
  bubbleMapsScore: 61.56, topHolderPercent: 9.45,
  volumeToLiquidityRatio: 0.094, entryLiquidityUsd: 79735,
  bestSimulatedExit: 'tp25', bestSimulatedExitPct: 25,
  hitSL15: false,
});

const FLAT_ROW = makeLedgerRow({
  symbol: 'CLAWVILLE', contract: '0xclawville',
  outcomeStatus: 'FLAT', latestReturnPct: 5.8,
  maxKnownReturnPct: 10, minKnownReturnPct: -5,
  hit25: false, hit50: false, hit100: false,
  bubbleMapsScore: 84.7, topHolderPercent: 8.4,
  volumeToLiquidityRatio: 0.110, entryLiquidityUsd: 30000,
  bestSimulatedExit: 'hold', bestSimulatedExitPct: 5.8,
  hitSL15: false,
});

const DUMPER_ROW = makeLedgerRow({
  symbol: '清正', contract: '0xqingzheng',
  outcomeStatus: 'DUMPED', latestReturnPct: -70,
  maxKnownReturnPct: 0.5, minKnownReturnPct: -73.8,
  hit25: false, hit50: false, hit100: false, hitSL15: true,
  bubbleMapsScore: 80.94, topHolderPercent: 6.49,
  volumeToLiquidityRatio: 1.462, entryLiquidityUsd: 81778,
  bestSimulatedExit: 'sl15', bestSimulatedExitPct: -15,
});

// VSTR: low vol/liq dumper — the key edge case
const VSTR_ROW = makeLedgerRow({
  symbol: 'VSTR', contract: '0xvstr',
  outcomeStatus: 'DUMPED', latestReturnPct: -29.2,
  maxKnownReturnPct: 0, minKnownReturnPct: -32,
  hit25: false, hit50: false, hit100: false, hitSL15: true,
  bubbleMapsScore: 67.03, topHolderPercent: 11.96,
  volumeToLiquidityRatio: 0.038,  // below winner avg of ~0.328
  entryLiquidityUsd: 20000,
  bestSimulatedExit: 'sl15', bestSimulatedExitPct: -15,
});

// ── loadLedgerRows ─────────────────────────────────────────────────────────────

describe('loadLedgerRows', () => {
  it('returns empty array when file does not exist', () => {
    const rows = loadLedgerRows('/tmp/nonexistent-ledger-analytics-xyz.jsonl');
    expect(rows).toEqual([]);
  });

  it('reads valid JSONL rows', () => {
    const file = writeLedger([WINNER_ROW, FLAT_ROW]);
    const rows = loadLedgerRows(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.symbol).toBe('MAITIU');
    expect(rows[1]!.symbol).toBe('CLAWVILLE');
  });

  it('ignores malformed lines safely', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-analytics-'));
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify(WINNER_ROW),
      'not-json-at-all{{{',
      '',
      JSON.stringify(FLAT_ROW),
      '{"no_contract_field": true}',
    ].join('\n') + '\n', 'utf-8');
    const rows = loadLedgerRows(file);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.symbol)).toEqual(['MAITIU', 'CLAWVILLE']);
  });

  it('skips lines missing contract field', () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-analytics-'));
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, '{"symbol":"NO_CONTRACT","outcomeStatus":"MOVED"}\n', 'utf-8');
    const rows = loadLedgerRows(file);
    expect(rows).toHaveLength(0);
  });
});

// ── runLedgerAnalytics — basic ─────────────────────────────────────────────────

describe('runLedgerAnalytics — basic', () => {
  it('returns ledgerMissing=true when file not found', () => {
    const r = runLedgerAnalytics({ ledgerPath: '/tmp/no-such-ledger-xyz.jsonl' });
    expect(r.ledgerMissing).toBe(true);
    expect(r.totalRows).toBe(0);
  });

  it('reads ledger JSONL and counts rows', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, FLAT_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.ledgerMissing).toBe(false);
    expect(r.totalRows).toBe(4);
  });

  it('always sets safety flags', () => {
    const file = writeLedger([WINNER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.tradingExecuted).toBe(0);
    expect(r.noRealTradeSent).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.readOnly).toBe(true);
  });
});

// ── runLedgerAnalytics — grouping ─────────────────────────────────────────────

describe('runLedgerAnalytics — groups winners/flats/dumpers', () => {
  it('groups RIPPED and MOVED as winners', () => {
    const ripped = makeLedgerRow({ symbol: 'R1', contract: '0xr1', outcomeStatus: 'RIPPED' });
    const moved  = makeLedgerRow({ symbol: 'M1', contract: '0xm1', outcomeStatus: 'MOVED' });
    const file = writeLedger([ripped, moved]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.winnerCount).toBe(2);
    expect(r.winnerRows.map(x => x.symbol)).toContain('R1');
    expect(r.winnerRows.map(x => x.symbol)).toContain('M1');
  });

  it('groups FLAT rows', () => {
    const file = writeLedger([FLAT_ROW, WINNER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.flatCount).toBe(1);
    expect(r.flatRows[0]!.symbol).toBe('CLAWVILLE');
  });

  it('groups DUMPED rows', () => {
    const file = writeLedger([DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.dumperCount).toBe(2);
    expect(r.dumperRows.map(x => x.symbol)).toContain('清正');
    expect(r.dumperRows.map(x => x.symbol)).toContain('VSTR');
  });

  it('counts hit25 / hit50 / hit100 / hitSL15', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hit25Count).toBe(2);   // MAITIU + XRPS
    expect(r.hit50Count).toBe(1);   // MAITIU
    expect(r.hit100Count).toBe(1);  // MAITIU
    expect(r.hitSL15Count).toBe(2); // 清正 + VSTR
  });
});

// ── runLedgerAnalytics — group averages ───────────────────────────────────────

describe('runLedgerAnalytics — computes group averages', () => {
  it('computes winner latestReturnPct average', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    // (80.8 + 30.6) / 2 = 55.7
    expect(r.winnerAverages.latestReturnPct).toBeCloseTo(55.7, 0);
  });

  it('computes dumper bubbleMapsScore average', () => {
    const file = writeLedger([DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    // (80.94 + 67.03) / 2 = 73.985
    expect(r.dumperAverages.bubbleMapsScore).toBeCloseTo(73.985, 1);
  });

  it('computes overall avgMaxReturn', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    // (109.3 + 0.5) / 2 = 54.9
    expect(r.avgMaxReturn).toBeCloseTo(54.9, 0);
  });

  it('computes overall avgBestSimExit', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    // MAITIU bestSimExit=50, 清正 bestSimExit=-15 → avg=17.5
    expect(r.avgBestSimExit).toBeCloseTo(17.5, 0);
  });

  it('group averages count reflects group size', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, FLAT_ROW, DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.winnerAverages.count).toBe(2);
    expect(r.flatAverages.count).toBe(1);
    expect(r.dumperAverages.count).toBe(2);
  });
});

// ── runLedgerAnalytics — dumper inspection notes ──────────────────────────────

describe('runLedgerAnalytics — detects low-vol-liq dumper', () => {
  it('flags VSTR as low vol/liq but dumped', () => {
    // Winners avg vol/liq: (0.561 + 0.094) / 2 = 0.3275
    // VSTR vol/liq = 0.038 < 0.3275 → should get "low vol/liq but dumped"
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const vstrEntry = r.dumperInspection.find(d => d.row.symbol === 'VSTR');
    expect(vstrEntry).toBeDefined();
    expect(vstrEntry!.notes).toContain('low vol/liq but dumped');
  });

  it('does not flag high-vol-liq dumper as low vol/liq', () => {
    // 清正 vol/liq = 1.462 > winner avg 0.3275
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const qingEntry = r.dumperInspection.find(d => d.row.symbol === '清正');
    expect(qingEntry).toBeDefined();
    expect(qingEntry!.notes).not.toContain('low vol/liq but dumped');
  });
});

describe('runLedgerAnalytics — detects high-BubbleMaps dumper', () => {
  it('flags dumper whose BubbleMaps exceeds winner avg as high BubbleMaps', () => {
    // Winner avg bubble: (84.28 + 61.56) / 2 = 72.92
    // 清正 bubble = 80.94 > 72.92 → "high BubbleMaps but dumped"
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const qingEntry = r.dumperInspection.find(d => d.row.symbol === '清正');
    expect(qingEntry!.notes).toContain('high BubbleMaps but dumped');
  });

  it('does not flag dumper with bubble below winner avg as high BubbleMaps', () => {
    // VSTR bubble = 67.03 < winner avg 72.92 → no high-bubble note
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const vstrEntry = r.dumperInspection.find(d => d.row.symbol === 'VSTR');
    expect(vstrEntry!.notes).not.toContain('high BubbleMaps but dumped');
  });

  it('flags SL15 would have saved for hitSL15 dumpers', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const qingEntry = r.dumperInspection.find(d => d.row.symbol === '清正');
    expect(qingEntry!.notes).toContain('SL15 would have saved');
  });
});

// ── runLedgerAnalytics — BubbleMaps hypothesis ────────────────────────────────

describe('runLedgerAnalytics — detects BubbleMaps not profit predictor', () => {
  it('includes hypothesis when winner avg bubble <= dumper avg bubble', () => {
    // Winners avg: 72.92, Dumpers avg: (80.94 + 67.03)/2 = 73.99
    // 72.92 <= 73.99 → hypothesis fires
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hypotheses).toContain('BubbleMaps score is not profit predictor');
  });

  it('does not include hypothesis when winner avg bubble > dumper avg bubble', () => {
    // Artificially make winner bubble very high
    const highBubbleWinner = makeLedgerRow({
      symbol: 'HIGHBUB', contract: '0xhb', outcomeStatus: 'RIPPED',
      bubbleMapsScore: 99, volumeToLiquidityRatio: 0.5,
    });
    const lowBubbleDumper = makeLedgerRow({
      symbol: 'LOWBUB', contract: '0xlb', outcomeStatus: 'DUMPED',
      bubbleMapsScore: 30, volumeToLiquidityRatio: 0.5,
    });
    const file = writeLedger([highBubbleWinner, lowBubbleDumper]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hypotheses).not.toContain('BubbleMaps score is not profit predictor');
  });
});

// ── runLedgerAnalytics — vol/liq hypothesis ───────────────────────────────────

describe('runLedgerAnalytics — Vol/Liq alone is insufficient', () => {
  it('fires when any dumper vol/liq is below winner avg', () => {
    // VSTR vol/liq = 0.038 < winner avg ~0.328
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hypotheses).toContain('Vol/Liq alone is insufficient');
  });

  it('does not fire when all dumpers are above winner avg vol/liq', () => {
    const highVLWinner = makeLedgerRow({
      symbol: 'HVW', contract: '0xhvw', outcomeStatus: 'MOVED',
      volumeToLiquidityRatio: 0.01,  // very low winner avg
    });
    const highVLDumper = makeLedgerRow({
      symbol: 'HVD', contract: '0xhvd', outcomeStatus: 'DUMPED',
      volumeToLiquidityRatio: 2.0,   // above winner avg
    });
    const file = writeLedger([highVLWinner, highVLDumper]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hypotheses).not.toContain('Vol/Liq alone is insufficient');
  });
});

// ── runLedgerAnalytics — always needs 20 rows hypothesis ─────────────────────

describe('runLedgerAnalytics — always includes 20-row gate hypothesis', () => {
  it('always includes "Need >=20 resolved rows before rule changes"', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    expect(r.hypotheses).toContain('Need >=20 resolved rows before rule changes');
  });
});

// ── runLedgerAnalytics — winner inspection notes ──────────────────────────────

describe('runLedgerAnalytics — winner inspection notes', () => {
  it('flags hit TP25 / hit TP50 / hit TP100 for MAITIU', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const mEntry = r.winnerInspection.find(w => w.row.symbol === 'MAITIU');
    expect(mEntry!.notes).toContain('hit TP25');
    expect(mEntry!.notes).toContain('hit TP50');
    expect(mEntry!.notes).toContain('hit TP100');
  });

  it('flags low BubbleMaps but won for XRPS (bubble below dumper avg)', () => {
    // XRPS bubble=61.56, dumpers avg=(80.94+67.03)/2=73.99 → 61.56 < 73.99
    const file = writeLedger([WINNER_ROW2, DUMPER_ROW, VSTR_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const xrpsEntry = r.winnerInspection.find(w => w.row.symbol === 'XRPS');
    expect(xrpsEntry!.notes).toContain('low BubbleMaps but won');
  });

  it('flags MAITIU hit TP25 in winner inspection notes', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r = runLedgerAnalytics({ ledgerPath: file });
    const mEntry = r.winnerInspection.find(w => w.row.symbol === 'MAITIU');
    expect(mEntry).toBeDefined();
    expect(mEntry!.notes).toContain('hit TP25');
  });
});

// ── renderLedgerAnalyticsReport ───────────────────────────────────────────────

describe('renderLedgerAnalyticsReport', () => {
  it('includes REAL TRADING LOCKED banner', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('REAL TRADING LOCKED');
  });

  it('includes safety footer line', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('noRealTradeSent=true');
  });

  it('includes "do not change gates" when under 20 resolved rows', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toMatch(/[Dd]o not change gates/);
    expect(out).toContain('>=20 resolved rows');
  });

  it('does not include "do not change gates" warning when 20+ resolved rows', () => {
    const rows: LedgerRow[] = Array.from({ length: 20 }, (_, i) =>
      makeLedgerRow({ symbol: `T${i}`, contract: `0x${i}`, resolved: true }),
    );
    const file = writeLedger(rows);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    // The in-report warning line is only present when resolvedRows < 20
    expect(out).not.toMatch(/⚠.*[Dd]o not change gates/);
  });

  it('renders VSTR in dumper inspection section', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, VSTR_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('VSTR');
    expect(out).toContain('3. DUMPER INSPECTION');
  });

  it('renders MAITIU in winner inspection section', () => {
    const file = writeLedger([WINNER_ROW, DUMPER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('MAITIU');
    expect(out).toContain('4. WINNER INSPECTION');
  });

  it('renders all 5 sections', () => {
    const file = writeLedger([WINNER_ROW, FLAT_ROW, DUMPER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('1. SUMMARY');
    expect(out).toContain('2. OUTCOME GROUPS');
    expect(out).toContain('3. DUMPER INSPECTION');
    expect(out).toContain('4. WINNER INSPECTION');
    expect(out).toContain('5. GATE HYPOTHESES');
  });

  it('shows missing ledger message when ledgerMissing is true', () => {
    const r   = runLedgerAnalytics({ ledgerPath: '/tmp/no-such-xyz.jsonl' });
    const out = renderLedgerAnalyticsReport(r);
    expect(out).toContain('No ledger found');
    expect(out).toContain('REAL TRADING LOCKED');
  });

  it('renders hypotheses in section 5', () => {
    const file = writeLedger([WINNER_ROW, WINNER_ROW2, DUMPER_ROW, VSTR_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    const out  = renderLedgerAnalyticsReport(r);
    expect(out).toContain('SL15 remains protective');
    expect(out).toContain('Need >=20 resolved rows before rule changes');
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('safety invariants', () => {
  it('result object never has trading-enabled flags', () => {
    const file = writeLedger([WINNER_ROW]);
    const r    = runLedgerAnalytics({ ledgerPath: file });
    expect(r.tradingExecuted).toBe(0);
    expect(r.noRealTradeSent).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.readOnly).toBe(true);
  });

  it('no trade/swap/signing exports in ledgerAnalytics module', async () => {
    const mod = await import('../src/token-grab/ledgerAnalytics');
    const keys = Object.keys(mod);
    const forbidden = ['sendTransaction', 'signTransaction', 'swap', 'buy', 'sell', 'privateKey'];
    for (const f of forbidden) {
      expect(keys.some(k => k.toLowerCase().includes(f.toLowerCase()))).toBe(false);
    }
  });
});
