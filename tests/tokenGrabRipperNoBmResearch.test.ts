// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  enrollCohortFamily, runFamilyReport, renderFamilyReport, renderFamilyEnroll,
  deriveResearchCandidate, researchLaneMatches, researchLaneFilePath, laneFilePath,
  NO_BM_RESEARCH_MIN_SCORE,
  type ResearchCohortRow, type FamilyReportResult,
} from '../src/token-grab/ripperWatchCohortFamily';
import type { SimulatedTrade } from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── Fixtures ──────────────────────────────────────────────────────────────────────

let dir: string, cyclesDir: string, dataDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nobm-'));
  cyclesDir = path.join(dir, 'cycles'); dataDir = path.join(dir, 'data');
  fs.mkdirSync(cyclesDir); fs.mkdirSync(dataDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let cc = 0;
/** Raw cycle row. Default = a REJECTED row (BubbleMaps UNKNOWN) with strong internal signals. */
function cycleRow(o: Record<string, any> = {}): Record<string, unknown> {
  cc++;
  return {
    capturedAt:       o.capturedAt ?? '2026-06-27T08:00:00.000Z',
    buyGateDecision:  o.buyGateDecision ?? 'BUY_REJECTED',     // rejected (e.g. BM rate-limited → UNKNOWN)
    entryDecision:    o.entryDecision ?? 'PAPER_BUY_BLOCKED',
    entryMomentumPct: 'entryMomentumPct' in o ? o.entryMomentumPct : -10,  // → m5Band -20 to -5
    ripperScore:      o.ripperScore ?? 90,
    launchAgeBucket:  o.launchAgeBucket ?? 'PRIME_WINDOW',
    normalizedSignal: {
      contract:             o.contract ?? `K${cc}`,
      symbol:               o.symbol ?? `S${cc}`,
      liquidityUsd:         o.liquidityUsd ?? 20_000,          // → LIQ_10K_30K
      volumeLiquidityRatio: o.vlr ?? 1.0,
    },
    ripperInput: { contract: o.contract ?? `K${cc}`, clusterRisk: o.clusterRisk ?? 'UNKNOWN' },
  };
}
function writeCycle(name: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(cyclesDir, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
function readResearch(): ResearchCohortRow[] {
  const p = researchLaneFilePath(dataDir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ResearchCohortRow);
}

// ── Classifier (internal signals only) ───────────────────────────────────────────────

describe('research lane classifier (BubbleMaps ignored)', () => {
  function cand(o: Record<string, any> = {}) { return deriveResearchCandidate(cycleRow(o))!; }

  it('matches on m5 family + liquidity near + ripperScore floor — regardless of buy gate / cluster', () => {
    expect(researchLaneMatches(cand({ buyGateDecision: 'BUY_REJECTED', clusterRisk: 'UNKNOWN' }))).toBe(true);
    expect(researchLaneMatches(cand({ buyGateDecision: 'BUY_APPROVED_PAPER', clusterRisk: 'CLEAN' }))).toBe(true);
  });

  it('does NOT match below the ripperScore floor', () => {
    expect(researchLaneMatches(cand({ ripperScore: NO_BM_RESEARCH_MIN_SCORE - 1 }))).toBe(false);
  });

  it('does NOT match outside the momentum family or liquidity-near buckets', () => {
    expect(researchLaneMatches(cand({ entryMomentumPct: 30 }))).toBe(false);   // +20 to +50
    expect(researchLaneMatches(cand({ liquidityUsd: 5_000 }))).toBe(false);    // LIQ_LT_10K
  });

  it('candidate entryTiming is BM-free ENTER_NOW and never derives WAIT_10M from CLEAN', () => {
    // Even a CLEAN, score-100, prime, ready row → research timing stays ENTER_NOW (BM ignored).
    const c = cand({ clusterRisk: 'CLEAN', ripperScore: 100, entryDecision: 'READY_TO_SNIPE_PAPER', buyGateDecision: 'BUY_APPROVED_PAPER' });
    expect(c.entryTiming).toBe('ENTER_NOW');
  });

  it('membership never reads clusterRisk (UNKNOWN and CLEAN behave identically)', () => {
    expect(researchLaneMatches(cand({ clusterRisk: 'UNKNOWN' }))).toBe(
      researchLaneMatches(cand({ clusterRisk: 'CLEAN' })));
  });
});

// ── Enrollment: separate file, labels, append-only, paper-only ─────────────────────────

describe('research lane enrollment', () => {
  it('enrolls rejected (BM-UNKNOWN) rows into its own file with required labels; clusterRisk verbatim', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'R1', clusterRisk: 'UNKNOWN' })]);
    const r = enrollCohortFamily({ cyclesDir, dataDir });

    expect(r.researchLane).toBeDefined();
    expect(r.researchLane!.rowsAppended).toBe(1);
    // Strict lanes saw nothing (row was rejected → no paper timing → no strict-lane hit).
    for (const lane of r.lanes) expect(lane.rowsAppended).toBe(0);

    const rows = readResearch();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lane).toBe('NO_BM_RESEARCH');
    expect(row.bmIgnoredForResearch).toBe(true);
    expect(row.paperOnly).toBe(true);
    expect(row.notBuySignal).toBe(true);
    expect(row.unknownNotClean).toBe(true);
    expect(row.clusterRisk).toBe('UNKNOWN');     // UNKNOWN preserved
    expect(row.clusterRisk).not.toBe('CLEAN');   // never relabelled
    expect(row.buyGateDecision).toBe('BUY_REJECTED');
  });

  it('writes to watch-cohort-no-bm-research.jsonl (separate from strict-lane files)', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'R1' })]);
    enrollCohortFamily({ cyclesDir, dataDir });
    expect(fs.existsSync(researchLaneFilePath(dataDir))).toBe(true);
    expect(researchLaneFilePath(dataDir)).toContain('watch-cohort-no-bm-research.jsonl');
    // The EXACT strict lane file should NOT exist (no approved strict hits here).
    expect(fs.existsSync(laneFilePath(dataDir, 'EXACT_WATCH'))).toBe(false);
  });

  it('is append-only and dedupes; re-run appends 0', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'A' }), cycleRow({ contract: 'B' })]);
    const r1 = enrollCohortFamily({ cyclesDir, dataDir });
    expect(r1.researchLane!.rowsAppended).toBe(2);
    const r2 = enrollCohortFamily({ cyclesDir, dataDir });
    expect(r2.researchLane!.rowsAppended).toBe(0);
    expect(r2.researchLane!.duplicatesSkipped).toBe(2);
    expect(readResearch()).toHaveLength(2);
  });

  it('dry-run writes nothing', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'DRY' })]);
    const r = enrollCohortFamily({ cyclesDir, dataDir, dryRun: true });
    expect(r.researchLane!.rowsAppended).toBe(1); // would append
    expect(fs.existsSync(researchLaneFilePath(dataDir))).toBe(false);
  });

  it('enrollment result keeps production-safety invariants', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'R1' })]);
    const r = enrollCohortFamily({ cyclesDir, dataDir });
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.paperOnly).toBe(true);
    expect(r.noGateChanges).toBe(true);
    expect(r.noBuySignal).toBe(true);
    expect(r.unknownNeverClean).toBe(true);
  });

  it('does NOT change strict-lane behavior: an approved EXACT row still enrolls strictly', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [
      cycleRow({ contract: 'APP', buyGateDecision: 'BUY_APPROVED_PAPER', entryDecision: 'READY_TO_SNIPE_PAPER', clusterRisk: 'UNKNOWN', entryMomentumPct: -10, liquidityUsd: 20_000 }),
    ]);
    const r = enrollCohortFamily({ cyclesDir, dataDir });
    const exact = r.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.rowsAppended).toBe(1);             // strict lane unchanged
    expect(r.researchLane!.rowsAppended).toBe(1);   // research lane also captured it
  });
});

// ── Report: comparison + metrics ───────────────────────────────────────────────────────

let tc = 0;
function mkTrade(o: Partial<SimulatedTrade> = {}): SimulatedTrade {
  tc++;
  return {
    intentId: `it${tc}`, symbol: `S${tc}`, contract: `T${tc}`,
    paperEntryTiming: 'ENTER_NOW', reason: '', sourceCycle: 'cycle-x',
    clusterRisk: 'UNKNOWN', ripperScore: 90, launchAgeBucket: 'PRIME_WINDOW',
    entryDecision: 'READY_TO_SNIPE_PAPER', targetEntryAt: '2026-06-27T08:00:00.000Z',
    observedAt: '2026-06-27T08:10:00.000Z', priceChangePct: 0, simulatedPnlPct: 0,
    entryMomentumPct: -10, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5',
    liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', timingPath: 'ENTER_NOW',
    m5Band: '-20 to -5', ...o,
  };
}
function mkResearchRow(o: Partial<ResearchCohortRow> = {}): ResearchCohortRow {
  return {
    schemaVersion: 1, lane: 'NO_BM_RESEARCH', cohortName: 'NO_BM_INTERNAL_RISK_RESEARCH',
    label: 'SUBGROUP_WATCH_PAPER_ONLY', enrolledAt: 't', cycleId: 'c', cycleFile: 'c.jsonl',
    capturedAt: '2026-06-27T08:00:00.000Z', dedupeKey: 'k', contract: 'C', symbol: 'C',
    buyGateDecision: 'BUY_REJECTED', entryTiming: 'ENTER_NOW', entryMomentumPct: -10,
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    launchAgeBucket: 'PRIME_WINDOW', ripperScore: 90, clusterRisk: 'UNKNOWN',
    reason: 'r', safety: 'PAPER_ONLY_WATCH_NOT_BUY',
    bmIgnoredForResearch: true, paperOnly: true, notBuySignal: true, unknownNotClean: true,
    DO_NOT_ENABLE_REAL_TRADING: true, DO_NOT_PROMOTE_TO_REAL_TRADING: true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true, ...o,
  };
}

describe('family report — research lane comparison', () => {
  it('reports research-lane metrics joined to outcomes (cluster UNKNOWN, never CLEAN)', () => {
    const cohort = [0, 1, 2].map(i => mkResearchRow({ contract: `W${i}`, dedupeKey: `k${i}`, clusterRisk: 'UNKNOWN' }));
    const trades = [0, 1, 2].map(i => mkTrade({ contract: `W${i}`, simulatedPnlPct: i === 0 ? 5 : -3 }));
    const r = runFamilyReport({ dataDir, _trades: trades, _cohortRowsByLane: {}, _researchCohortRows: cohort });
    expect(r.researchLane).toBeDefined();
    expect(r.researchLane!.observedCount).toBe(3);
    expect(r.researchLane!.stats.clusterBreakdown['UNKNOWN']).toBe(3);
    expect(r.researchLane!.stats.clusterBreakdown['CLEAN']).toBeUndefined();
    expect(r.researchLane!.bmIgnoredForResearch).toBe(true);
    // Metrics present.
    const s = r.researchLane!.stats;
    for (const k of ['winRate', 'redLossRate', 'flatRate', 'medianPnl', 'avgPnlCapped', 'worstPnl', 'bestPnl', 'outlierDependence'] as const) {
      expect(typeof s[k]).toBe('number');
    }
  });

  it('render includes the STRICT_BM vs NO_BM_RESEARCH vs BASELINE comparison + safety; UNKNOWN never CLEAN', () => {
    const cohort = [mkResearchRow({ contract: 'W0', dedupeKey: 'k0' })];
    const txt = renderFamilyReport(runFamilyReport({ dataDir, _trades: [mkTrade({ contract: 'W0', simulatedPnlPct: 4 })], _researchCohortRows: cohort }));
    expect(txt).toContain('STRICT_BM vs NO_BM_RESEARCH vs BASELINE');
    expect(txt).toContain('NO_BM_RESEARCH');
    expect(txt).toContain('bmIgnoredForResearch=true');
    expect(txt).toContain('UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
    expect(txt).toContain('realTradingLocked=true');
    expect(txt).toContain('tradingExecuted=0');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    // Research cluster line must not render CLEAN for UNKNOWN rows.
    expect(txt).not.toMatch(/cluster:\s*CLEAN/);
  });

  it('render enroll shows the research lane block with labels', () => {
    writeCycle('cycle-2026-06-27-080000.jsonl', [cycleRow({ contract: 'R1' })]);
    const txt = renderFamilyEnroll(enrollCohortFamily({ cyclesDir, dataDir, dryRun: true }));
    expect(txt).toContain('NO_BM_RESEARCH');
    expect(txt).toContain('BubbleMaps IGNORED for enrollment');
    expect(txt).toContain('bmIgnoredForResearch=true');
  });
});

// ── Proof wiring (status + summary) ────────────────────────────────────────────────────

describe('proof layer surfaces NO_BM_RESEARCH', () => {
  it('buildProofStatus exposes researchLane; proof-status render shows the shadow lane', async () => {
    const { buildProofStatus, renderProofStatus } = await import('../src/token-grab/ripperProof');
    const cohort = [mkResearchRow({ contract: 'W0', dedupeKey: 'k0', clusterRisk: 'UNKNOWN' })];
    const report = runFamilyReport({ dataDir, _trades: [mkTrade({ contract: 'W0', simulatedPnlPct: 5 })], _researchCohortRows: cohort });
    const status = buildProofStatus({
      generatedAt: 't', report,
      cycle: { id: 'cycle-x', time: null, fresh: true, status: 'FRESH' },
      fastTestRunsObserved: 0,
    });
    expect(status.researchLane).not.toBeNull();
    expect(status.researchLane!.observed).toBe(1);
    expect(status.researchLane!.bmIgnoredForResearch).toBe(true);
    expect(status.researchLane!.clusterBreakdown['CLEAN']).toBeUndefined();
    const txt = renderProofStatus(status);
    expect(txt).toContain('NO_BM_RESEARCH SHADOW LANE');
    expect(txt).toContain('bmIgnoredForResearch=true');
    expect(txt).toContain('NEVER treated as CLEAN');
  });

  it('proof-summary computes a NO_BM_RESEARCH trend across snapshots', async () => {
    const { runProofSummary, renderProofSummary } = await import('../src/token-grab/ripperProof');
    const researchLane = (observed: number, capped: number) => ({
      observed, pending: 0, winRate: 0.5, redLossRate: 0.1, flatRate: 0.1,
      medianPnl: 0.5, avgPnlCapped: capped, worstPnl: -3, bestPnl: 8, outlierDependence: 0.1,
      clusterBreakdown: { UNKNOWN: observed }, recommendation: 'KEEP_COLLECTING' as const, bmIgnoredForResearch: true as const,
    });
    const snap = (gen: string, observed: number, capped: number): any => ({
      schemaVersion: 1, generatedAt: gen, latestCycle: 'c', freshness: 'FRESH',
      baseline: { n: 100, winRate: 0.4, redLossRate: 0.05, flatRate: 0.5, medianPnl: 0, avgPnlCapped: 1, outlierDependence: 0.05 },
      lanes: [], researchLane: researchLane(observed, capped),
      bestLane: null, confidenceTier: 'TOO_SMALL', recommendation: 'KEEP_COLLECTING',
      safety: { paperOnly: true, realTradingLocked: true, tradingExecuted: 0, unknownNeverClean: true, doNotEnableRealTrading: true, doNotTrade: true },
      gitCommit: null, gitDirty: null,
    });
    const s = runProofSummary({ _rows: [snap('a', 6, 1), snap('b', 20, 3)] });
    expect(s.researchLaneTrend).not.toBeNull();
    expect(s.researchLaneTrend!.firstObserved).toBe(6);
    expect(s.researchLaneTrend!.lastObserved).toBe(20);
    expect(s.researchLaneTrend!.observedDirection).toBe('UP');
    expect(s.researchLaneTrend!.status).toBe('IMPROVING');
    expect(renderProofSummary(s)).toContain('NO_BM_RESEARCH');
  });

  it('proof-summary handles old snapshots with no research lane (null trend)', async () => {
    const { runProofSummary } = await import('../src/token-grab/ripperProof');
    const legacy: any = {
      schemaVersion: 1, generatedAt: 'a', latestCycle: 'c', freshness: 'FRESH',
      baseline: { n: 100, winRate: 0.4, redLossRate: 0.05, flatRate: 0.5, medianPnl: 0, avgPnlCapped: 1, outlierDependence: 0.05 },
      lanes: [], bestLane: null, confidenceTier: 'TOO_SMALL', recommendation: 'KEEP_COLLECTING',
      safety: { paperOnly: true, realTradingLocked: true, tradingExecuted: 0, unknownNeverClean: true, doNotEnableRealTrading: true, doNotTrade: true },
      gitCommit: null, gitDirty: null,
    };
    const s = runProofSummary({ _rows: [legacy] });
    expect(s.researchLaneTrend).toBeNull();
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────

describe('no unsafe behavior introduced', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/ripperWatchCohortFamily.ts'), 'utf-8');
  it('no token:auto-paper / token:paper-buy / --live', () => {
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
  });
  it('no wallet signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap/i);
  });
  it('research lane never relabels UNKNOWN as CLEAN (no UNKNOWN→CLEAN mapping in source)', () => {
    // Sanity: there is no code path turning UNKNOWN into CLEAN in the research lane.
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
  });
});
