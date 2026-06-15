import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runShadowRejectFilterReport,
  renderShadowRejectFilterReport,
} from '../src/token-grab/ripperShadowRejectFilterReport';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CONTRACT_D = 'ContractDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srfr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeCycle(rows: object[], name = 'cycle-test.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObs(rows: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

function outPath(): string { return path.join(tmpDir, 'report.jsonl'); }

function makeApproved(opts: {
  contract?:            string;
  capturedAt?:          string;
  bubbleMapsScore?:     number | null;
  liquidityUsd?:        number | null;
  volumeLiquidityRatio?: number | null;
  ageMinutes?:          number | null;
} = {}) {
  const contract = opts.contract ?? CONTRACT_A;
  const bm       = opts.bubbleMapsScore;
  return {
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    ripperScore:     100,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      opts.ageMinutes !== undefined ? opts.ageMinutes : 3,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    warnings:        [],
    blockers:        [],
    normalizedSignal: {
      contract,
      symbol:              'TOK',
      sourceKind:          'DEX_NEW_POOL',
      id: 's', source: 'test', discoveredAt: BASE_ISO, warnings: [],
      liquidityUsd:        opts.liquidityUsd !== undefined ? opts.liquidityUsd : 20_000,
      volumeLiquidityRatio: opts.volumeLiquidityRatio !== undefined ? opts.volumeLiquidityRatio : 0.5,
    },
    raw: {
      clusterRisk:       'CLEAN',
      clusterProvider:   'bubblemaps',
      clusterConfidence: 'HIGH',
      clusterNotes:      bm != null ? [`bubbleMapsScore ${bm}`] : [],
    },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeRejectedRow(contract = CONTRACT_B) {
  return {
    capturedAt:      BASE_ISO,
    buyGateDecision: 'BUY_REJECTED',
    ripperScore:     80,
    normalizedSignal: { contract, id: 'r', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [] },
    raw:             { clusterRisk: 'WATCH' },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number | null } = {}) {
  return {
    capturedAt: opts.capturedAt ?? at(10_000),
    normalizedSignal: {
      contract:       opts.contract ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? null,
      id: 'o', source: 'test', sourceKind: 'x', discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets all safety flags', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns zero counts with no cycle files', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(0);
    expect(result.observedCandidates).toBe(0);
    expect(result.totalFlatJunk).toBe(0);
    expect(result.totalWinners1).toBe(0);
  });

  it('all filters show zero rejections with no candidates', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    for (const f of [...result.individualFilters, ...result.comboFilters]) {
      expect(f.candidatesRejected).toBe(0);
    }
  });
});

// ── Gate filtering ────────────────────────────────────────────────────────────

describe('gate filtering', () => {
  it('only analyzes BUY_APPROVED_PAPER candidates', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A }),
      makeRejectedRow(CONTRACT_B),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.candidatesAnalyzed).toBe(1);
  });
});

// ── Individual filter: bubbleMapsScore < 70 ───────────────────────────────────

describe('filter: bubbleMapsScore < 70', () => {
  it('rejects candidate with score 60 but not 80', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, bubbleMapsScore: 60 }),
      makeApproved({ contract: CONTRACT_B, bubbleMapsScore: 80 }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'bubble_lt70')!;
    expect(f.candidatesRejected).toBe(1);
  });

  it('does not reject candidate with null bubbleMapsScore', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, bubbleMapsScore: null }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'bubble_lt70')!;
    expect(f.candidatesRejected).toBe(0);
  });
});

// ── Individual filter: liquidityUsd < $10k ────────────────────────────────────

describe('filter: liquidityUsd < $10k', () => {
  it('rejects candidate with liquidity 5000 but not 15000', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, liquidityUsd: 5_000 }),
      makeApproved({ contract: CONTRACT_B, liquidityUsd: 15_000 }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    expect(f.candidatesRejected).toBe(1);
  });

  it('does not reject candidate with null liquidityUsd', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, liquidityUsd: null }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    expect(f.candidatesRejected).toBe(0);
  });
});

// ── Individual filter: vlr unknown ───────────────────────────────────────────

describe('filter: volumeLiquidityRatio unknown', () => {
  it('rejects candidate with null vlr but not 0.5', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, volumeLiquidityRatio: null }),
      makeApproved({ contract: CONTRACT_B, volumeLiquidityRatio: 0.5 }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'vlr_unknown')!;
    expect(f.candidatesRejected).toBe(1);
  });
});

// ── Individual filter: ageMinutes >= 10 ──────────────────────────────────────

describe('filter: ageMinutes >= 10', () => {
  it('rejects candidate with age 12 but not 5', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, ageMinutes: 12 }),
      makeApproved({ contract: CONTRACT_B, ageMinutes: 5 }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'age_gte10m')!;
    expect(f.candidatesRejected).toBe(1);
  });

  it('does not reject candidate with null ageMinutes', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, ageMinutes: null }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'age_gte10m')!;
    expect(f.candidatesRejected).toBe(0);
  });
});

// ── Combo filter ──────────────────────────────────────────────────────────────

describe('combo OR filter', () => {
  it('rejects if either condition matches', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, bubbleMapsScore: 60, liquidityUsd: 20_000 }), // only bubble match
      makeApproved({ contract: CONTRACT_B, bubbleMapsScore: 90, liquidityUsd: 5_000 }),  // only liq match
      makeApproved({ contract: CONTRACT_C, bubbleMapsScore: 90, liquidityUsd: 20_000 }), // no match
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.comboFilters.find(x => x.filterName === 'bubble_OR_liq')!;
    expect(f.candidatesRejected).toBe(2);
  });

  it('all_four_OR rejects if any condition matches', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, ageMinutes: 15, bubbleMapsScore: 90, liquidityUsd: 20_000, volumeLiquidityRatio: 0.5 }),
      makeApproved({ contract: CONTRACT_B, ageMinutes: 3,  bubbleMapsScore: 90, liquidityUsd: 20_000, volumeLiquidityRatio: 0.5 }),
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.comboFilters.find(x => x.filterName === 'all_four_OR')!;
    expect(f.candidatesRejected).toBe(1);
  });
});

// ── Rate calculations ─────────────────────────────────────────────────────────

describe('rate calculations', () => {
  it('flat junk removal rate = flatJunkRejected / totalFlatJunk', () => {
    // 3 flat junk candidates: 2 with low liquidity (rejected), 1 not
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, liquidityUsd: 5_000 }),
      makeApproved({ contract: CONTRACT_B, liquidityUsd: 5_000 }),
      makeApproved({ contract: CONTRACT_C, liquidityUsd: 20_000 }),
    ]);
    const obs = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 0.3 }),   // FLAT
      makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct: 0.2 }),   // FLAT
      makeObs({ contract: CONTRACT_C, capturedAt: at(5_000), priceChangePct: 0.5 }),   // FLAT
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    expect(f.flatJunkRejected).toBe(2);
    expect(f.totalFlatJunk).toBe(3);
    expect(f.junkRemovalRate).toBeCloseTo(66.7, 0);
  });

  it('winner1KillRate = winners killed / total winners', () => {
    const cycle = writeCycle([
      makeApproved({ contract: CONTRACT_A, liquidityUsd: 5_000 }),  // filtered
      makeApproved({ contract: CONTRACT_B, liquidityUsd: 20_000 }), // not filtered
    ]);
    const obs = writeObs([
      makeObs({ contract: CONTRACT_A, capturedAt: at(5_000), priceChangePct: 3 }), // winner in filtered set
      makeObs({ contract: CONTRACT_B, capturedAt: at(5_000), priceChangePct: 5 }), // winner in kept set
    ]);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    expect(f.winners1Killed).toBe(1);
    expect(f.totalWinners1).toBe(2);
    expect(f.winner1KillRate).toBeCloseTo(50, 0);
  });
});

// ── Recommendation logic ──────────────────────────────────────────────────────

describe('recommendation', () => {
  it('SHADOW_TEST_NEXT when junk >= 10% removed, winner kill <= 15%, obs >= 10', () => {
    // Build 30 flat junk + 10 winners; filter targets 5 flat junk and 0 winners
    const rows: object[] = [];
    const obsRows: object[] = [];
    // 10 flat junk with low liq (filtered)
    for (let i = 0; i < 10; i++) {
      const c = `CFlat${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at(i * 1000), liquidityUsd: 5_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at(i * 1000 + 5_000), priceChangePct: 0 }));
    }
    // 20 flat junk with ok liq (not filtered)
    for (let i = 0; i < 20; i++) {
      const c = `CFlat2x${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at((i + 10) * 1000), liquidityUsd: 20_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at((i + 10) * 1000 + 5_000), priceChangePct: 0 }));
    }
    // 10 winners with ok liq (not filtered)
    for (let i = 0; i < 10; i++) {
      const c = `CWin${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at((i + 30) * 1000), liquidityUsd: 20_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at((i + 30) * 1000 + 5_000), priceChangePct: 5 }));
    }
    const cycle = writeCycle(rows);
    const obs   = writeObs(obsRows);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    // 10/30 junk removed = 33.3%, 0/10 winners killed = 0%
    expect(f.recommendation).toBe('SHADOW_TEST_NEXT');
    expect(f.junkRemovalRate).toBeGreaterThanOrEqual(10);
    expect(f.winner1KillRate).toBeLessThanOrEqual(15);
  });

  it('REJECT_FILTER_TOO_AGGRESSIVE when winner kill rate > 15%', () => {
    // 10 winners, all with low liq — filter kills 20% of them (> 15% threshold)
    const rows: object[] = [];
    const obsRows: object[] = [];
    for (let i = 0; i < 5; i++) {
      const c = `CWin${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at(i * 1000), liquidityUsd: 5_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at(i * 1000 + 5_000), priceChangePct: 5 }));
    }
    for (let i = 0; i < 20; i++) {
      const c = `CWin2x${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at((i + 5) * 1000), liquidityUsd: 20_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at((i + 5) * 1000 + 5_000), priceChangePct: 5 }));
    }
    // 5 flat junk with low liq
    for (let i = 0; i < 5; i++) {
      const c = `CJunk${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at((i + 25) * 1000), liquidityUsd: 5_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at((i + 25) * 1000 + 5_000), priceChangePct: 0 }));
    }
    const cycle = writeCycle(rows);
    const obs   = writeObs(obsRows);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    const f = result.individualFilters.find(x => x.filterName === 'liq_lt10k')!;
    // 5/25 winners killed = 20% > 15% threshold
    expect(f.recommendation).toBe('REJECT_FILTER_TOO_AGGRESSIVE');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes REPORT ONLY safety header', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('includes individual filter results section', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('INDIVIDUAL FILTER RESULTS');
    expect(output).toContain('bubble_lt70');
    expect(output).toContain('liq_lt10k');
    expect(output).toContain('vlr_unknown');
    expect(output).toContain('age_gte10m');
  });

  it('includes combo filter results section', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('COMBO FILTER RESULTS');
    expect(output).toContain('bubble_OR_liq');
    expect(output).toContain('all_four_OR');
  });

  it('includes HOLD_CURRENT_GATES when no shadow test filters', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.overallDecision).toBe('HOLD_CURRENT_GATES');
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('HOLD_CURRENT_GATES');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING in footer', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes safety fields line', () => {
    const result = runShadowRejectFilterReport({
      cyclePaths: [], observationPaths: [], outPath: outPath(), nowMs: BASE_MS,
    });
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('shows TEST_SHADOW_REJECT_FILTERS_ONLY when shadow test filters found', () => {
    // Enough flat junk (all filtered) to trigger SHADOW_TEST_NEXT
    const rows: object[] = [];
    const obsRows: object[] = [];
    for (let i = 0; i < 20; i++) {
      const c = `FJ${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at(i * 1000), liquidityUsd: 5_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at(i * 1000 + 5_000), priceChangePct: 0 }));
    }
    for (let i = 0; i < 10; i++) {
      const c = `WN${i}`.padEnd(44, '0');
      rows.push(makeApproved({ contract: c, capturedAt: at((i + 20) * 1000), liquidityUsd: 20_000 }));
      obsRows.push(makeObs({ contract: c, capturedAt: at((i + 20) * 1000 + 5_000), priceChangePct: 5 }));
    }
    const cycle = writeCycle(rows);
    const obs   = writeObs(obsRows);
    const result = runShadowRejectFilterReport({
      cyclePaths: [cycle], observationPaths: [obs], outPath: outPath(), nowMs: BASE_MS,
    });
    expect(result.overallDecision).toBe('TEST_SHADOW_REJECT_FILTERS_ONLY');
    const output = renderShadowRejectFilterReport(result);
    expect(output).toContain('TEST_SHADOW_REJECT_FILTERS_ONLY');
  });
});
