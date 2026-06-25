// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runSubgroupConvictionReport,
  renderSubgroupConvictionReport,
  ripperScoreBucket,
  type SubgroupConvictionResult,
} from '../src/token-grab/ripperSubgroupConvictionReport';

// ── Fixture helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let intentsPath: string;
let memoryPath: string;
let cyclesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subgroup-'));
  intentsPath = path.join(tmpDir, 'paper-intents.jsonl');
  memoryPath  = path.join(tmpDir, 'learning-memory.jsonl');
  cyclesDir   = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

let counter = 0;
function makeIntent(o: Record<string, unknown> = {}): Record<string, unknown> {
  counter++;
  return {
    intentId:         `intent-${counter}`,
    contract:         `CONTRACT_${counter}`,
    symbol:           'TKN',
    status:           'OBSERVED',
    approvedAt:       '2026-06-18T10:00:00.000Z',
    targetEntryAt:    '2026-06-18T10:10:00.000Z',
    paperEntryTiming: 'ENTER_NOW',
    reason:           'TEST',
    sourceCycle:      'cycle-2026-06-18-100000',
    clusterRisk:      'UNKNOWN',
    ripperScore:      100,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    observedAt:       '2026-06-18T10:11:00.000Z',
    priceChangePct:   0,
    realTradingLocked: true,
    paperOnly:        true,
    tradingExecuted:  0,
    ...o,
  };
}

/** Build n intents that share the given overrides, with the given list of P/L values. */
function group(pnls: number[], shared: Record<string, unknown>): Record<string, unknown>[] {
  return pnls.map(p => makeIntent({ ...shared, priceChangePct: p }));
}

/** memory rows so liquidity/vlr dimensions resolve for each contract written. */
function memForAll(rows: Record<string, unknown>[], mem: Record<string, unknown>): Record<string, unknown>[] {
  return rows.map(r => ({ contract: r['contract'], ...mem }));
}

beforeEach(() => { counter = 0; });

// ── ripperScoreBucket ────────────────────────────────────────────────────────────

describe('ripperScoreBucket', () => {
  it('buckets scores and keeps null as UNKNOWN (never inferred)', () => {
    expect(ripperScoreBucket(100)).toBe('SCORE_100');
    expect(ripperScoreBucket(97)).toBe('SCORE_95_99');
    expect(ripperScoreBucket(92)).toBe('SCORE_90_94');
    expect(ripperScoreBucket(83)).toBe('SCORE_80_89');
    expect(ripperScoreBucket(50)).toBe('SCORE_LT_80');
    expect(ripperScoreBucket(null)).toBe('SCORE_UNKNOWN');
    expect(ripperScoreBucket(undefined)).toBe('SCORE_UNKNOWN');
  });
});

// ── Safety ────────────────────────────────────────────────────────────────────────

describe('subgroup conviction report — safety', () => {
  it('always sets all safety flags, even with empty data', () => {
    writeJsonl(intentsPath, []);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noFakeTradeMutation).toBe(true);
    expect(r.noPaperIntentMutation).toBe(true);
    expect(r.noRealTrading).toBe(true);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
    expect(r.unknownNeverClean).toBe(true);
  });

  it('renders the safety banner and the do-not-promote lines', () => {
    writeJsonl(intentsPath, []);
    const txt = renderSubgroupConvictionReport(
      runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir }),
    );
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
    expect(txt).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
    expect(txt).toContain('UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('does not mutate the input intents / memory files (read-only)', () => {
    const intents = group(new Array(40).fill(5), { clusterRisk: 'CLEAN' });
    writeJsonl(intentsPath, intents);
    writeJsonl(memoryPath, memForAll(intents, { liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' }));
    const beforeIntents = fs.readFileSync(intentsPath, 'utf-8');
    const beforeMem     = fs.readFileSync(memoryPath, 'utf-8');
    runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    expect(fs.readFileSync(intentsPath, 'utf-8')).toBe(beforeIntents);
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe(beforeMem);
  });
});

// ── Minimum n filtering ─────────────────────────────────────────────────────────

describe('minimum sample size', () => {
  it('ignores subgroups with n < minN (default 30)', () => {
    // 20 strong trades — below the 30 default; should not become eligible.
    writeJsonl(intentsPath, group(new Array(20).fill(10), { paperEntryTiming: 'WAIT_10M' }));
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.eligibleGroupCount).toBe(0);
    expect(r.topCandidates).toHaveLength(0);
    expect(r.recommendation).toBe('KEEP_COLLECTING');
  });

  it('counts a subgroup once it reaches minN', () => {
    writeJsonl(intentsPath, group(new Array(30).fill(10), { paperEntryTiming: 'WAIT_10M' }));
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.eligibleGroupCount).toBeGreaterThan(0);
  });
});

// ── Ranking ──────────────────────────────────────────────────────────────────────

describe('ranking by conviction', () => {
  it('ranks a stronger subgroup above a weaker subgroup', () => {
    // Strong group: 60 trades, ~80% winners at +10%, rest small losses. Distinct dimensions.
    const strong = group(
      [...new Array(48).fill(10), ...new Array(12).fill(-5)],
      { paperEntryTiming: 'WAIT_10M', clusterRisk: 'CLEAN', ripperScore: 100 },
    );
    // Weak group: 60 trades, ~40% winners, mostly flat/negative. Different dimensions.
    const weak = group(
      [...new Array(24).fill(3), ...new Array(36).fill(-2)],
      { paperEntryTiming: 'ENTER_NOW', clusterRisk: 'UNKNOWN', ripperScore: 83 },
    );
    const all = [...strong, ...weak];
    writeJsonl(intentsPath, all);
    writeJsonl(memoryPath, memForAll(all, { liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' }));

    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    // The single-dimension WAIT_10M group should be the strongest candidate.
    const strongIdx = r.topCandidates.findIndex(s => s.key.includes('entryTiming=WAIT_10M'));
    const weakIdx   = r.topCandidates.findIndex(s => s.key === 'entryTiming=ENTER_NOW');
    expect(strongIdx).toBeGreaterThanOrEqual(0);
    // weak group should not be a candidate at all, or should rank strictly below the strong one
    if (weakIdx >= 0) expect(strongIdx).toBeLessThan(weakIdx);
    expect(r.topCandidates[0]!.convictionTier).not.toBe('NO_EDGE');
  });
});

// ── Outlier dependence ──────────────────────────────────────────────────────────

describe('outlier dependence detection', () => {
  it('flags a group whose gains come from one giant winner', () => {
    // 49 flat/tiny trades + 1 enormous winner → almost all gains from one trade.
    const pnls = [...new Array(49).fill(0), 2000];
    const rows = group(pnls, { paperEntryTiming: 'WAIT_10M', clusterRisk: 'CLEAN' });
    writeJsonl(intentsPath, rows);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });

    const od = r.outlierDependentGroups.find(s => s.key.includes('entryTiming=WAIT_10M'));
    expect(od).toBeDefined();
    expect(od!.outlierExtreme).toBe(true);
    expect(od!.outlierDependence).toBeGreaterThan(0.6);
    // An outlier-driven group must NOT be promoted to a real candidate.
    expect(od!.convictionTier).toBe('NO_EDGE');
  });

  it('does not flag a group with evenly spread gains', () => {
    const rows = group(new Array(60).fill(5), { paperEntryTiming: 'WAIT_10M', clusterRisk: 'CLEAN' });
    writeJsonl(intentsPath, rows);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    const stable = r.stableGroups.find(s => s.key.includes('entryTiming=WAIT_10M'));
    expect(stable).toBeDefined();
    expect(stable!.outlierExtreme).toBe(false);
    expect(stable!.outlierDependence).toBeLessThan(0.25);
  });
});

// ── UNKNOWN is never treated as CLEAN ─────────────────────────────────────────────

describe('UNKNOWN cluster risk is never treated as CLEAN', () => {
  it('keeps UNKNOWN labeled UNKNOWN and never relabels it CLEAN', () => {
    const unknownRows = group(new Array(40).fill(8), { clusterRisk: 'UNKNOWN', paperEntryTiming: 'ENTER_NOW' });
    writeJsonl(intentsPath, unknownRows);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });

    const clusterGroups = [
      ...r.topCandidates, ...r.disqualifiedGroups, ...r.outlierDependentGroups, ...r.stableGroups,
    ].filter(s => s.dimensions.includes('clusterRisk'));

    // There is at least one clusterRisk-keyed group, and every one is UNKNOWN (none CLEAN).
    expect(clusterGroups.length).toBeGreaterThan(0);
    for (const g of clusterGroups) {
      expect(g.values['clusterRisk']).toBe('UNKNOWN');
      expect(g.values['clusterRisk']).not.toBe('CLEAN');
    }
    expect(r.unknownNeverClean).toBe(true);
  });

  it('null clusterRisk maps to UNKNOWN, not CLEAN', () => {
    const rows = group(new Array(35).fill(4), { clusterRisk: null, paperEntryTiming: 'ENTER_NOW' });
    writeJsonl(intentsPath, rows);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    const clusterGroups = [
      ...r.topCandidates, ...r.disqualifiedGroups, ...r.outlierDependentGroups, ...r.stableGroups,
    ].filter(s => s.dimensions.includes('clusterRisk'));
    for (const g of clusterGroups) {
      expect(g.values['clusterRisk']).toBe('UNKNOWN');
    }
  });
});

// ── Missing optional fields ───────────────────────────────────────────────────────

describe('missing M5 / liquidity / VLR fields', () => {
  it('handles intents with no memory join and no M5 without throwing', () => {
    // No memory file written → liquidity/vlr unresolved; no entryMomentumPct → m5 UNAVAILABLE.
    const rows = group(new Array(40).fill(6), { paperEntryTiming: 'ENTER_NOW' });
    writeJsonl(intentsPath, rows);
    // intentionally do NOT write memoryPath
    expect(() => runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir })).not.toThrow();
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    const liq = [...r.topCandidates, ...r.disqualifiedGroups, ...r.stableGroups]
      .find(s => s.dimensions.includes('liquidity'));
    if (liq) expect(liq.values['liquidity']).toBe('UNKNOWN');
    const m5 = [...r.topCandidates, ...r.disqualifiedGroups, ...r.stableGroups]
      .find(s => s.dimensions.includes('m5Band'));
    if (m5) expect(m5.values['m5Band']).toBe('UNAVAILABLE');
  });
});

// ── Recommendation stays paper-only ───────────────────────────────────────────────

describe('recommendation is always paper-only', () => {
  const PAPER_ONLY = new Set([
    'KEEP_COLLECTING',
    'BUILD_MORE_EVIDENCE_FOR_SUBGROUP',
    'PAPER_ONLY_SUBGROUP_CANDIDATE_FOUND',
    'NO_ACTIONABLE_EDGE_FOUND',
  ]);

  it('never recommends real trading even for a strong candidate', () => {
    // A genuinely strong, stable, large group.
    const rows = group(
      [...new Array(80).fill(12), ...new Array(20).fill(-4)],
      { paperEntryTiming: 'WAIT_10M', clusterRisk: 'CLEAN', ripperScore: 100 },
    );
    writeJsonl(intentsPath, rows);
    writeJsonl(memoryPath, memForAll(rows, { liquidityBucket: 'LIQ_GTE_100K', vlrBucket: 'VLR_GTE_2' }));
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });

    expect(PAPER_ONLY.has(r.recommendation)).toBe(true);
    expect(r.recommendation).toBe('PAPER_ONLY_SUBGROUP_CANDIDATE_FOUND');
    // Even with a HIGH_CONVICTION group present, real trading stays locked.
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    const hasHigh = r.topCandidates.some(s => s.convictionTier === 'HIGH_CONVICTION_PAPER_ONLY');
    expect(hasHigh).toBe(true);

    const txt = renderSubgroupConvictionReport(r);
    // Any mention of ENABLE_REAL_TRADING must be the DO_NOT_ form (no affirmative instruction).
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    // PROMOTE_TO_REAL_TRADING must only ever appear in the DO_NOT_ form.
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
  });

  it('reports NO_ACTIONABLE_EDGE_FOUND when eligible groups exist but none clear criteria', () => {
    // Large but losing group → eligible but not a candidate.
    const rows = group(
      [...new Array(20).fill(2), ...new Array(40).fill(-3)],
      { paperEntryTiming: 'ENTER_NOW', clusterRisk: 'UNKNOWN' },
    );
    writeJsonl(intentsPath, rows);
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.eligibleGroupCount).toBeGreaterThan(0);
    expect(r.recommendation).toBe('NO_ACTIONABLE_EDGE_FOUND');
  });

  it('produces JSON-serialisable output', () => {
    writeJsonl(intentsPath, group(new Array(30).fill(1), {}));
    const r = runSubgroupConvictionReport({ intentsPath, memoryPath, cyclesDir });
    const parsed = JSON.parse(JSON.stringify(r)) as SubgroupConvictionResult;
    expect(parsed.reportOnly).toBe(true);
    expect(PAPER_ONLY.has(parsed.recommendation)).toBe(true);
  });
});
