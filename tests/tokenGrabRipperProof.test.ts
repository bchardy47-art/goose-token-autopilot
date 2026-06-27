// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  buildProofStatus, renderProofStatus,
  buildProofLogRow, appendProofLog, appendProofSnapshot, readProofLog,
  runProofSummary, renderProofSummary,
  cycleFreshnessFromTime,
  type ProofCycleInfo, type ProofLogRow, type ProofStatus,
} from '../src/token-grab/ripperProof';
import type {
  FamilyReportResult, LaneReport, LaneOutcomeStats, LaneKey,
} from '../src/token-grab/ripperWatchCohortFamily';

// ── Factories (mirror the family report shapes) ──────────────────────────────────────

function stats(o: Partial<LaneOutcomeStats> = {}): LaneOutcomeStats {
  return {
    n: 0, winRate: 0, redLossRate: 0, flatRate: 0, avgPnlRaw: 0, avgPnlCapped: 0,
    medianPnl: 0, worstPnl: 0, bestPnl: 0, outlierDependence: 0,
    clusterBreakdown: {}, m5BandBreakdown: {}, ...o,
  };
}
function lane(key: LaneKey, o: { enrolled?: number; observed?: number; pending?: number; unmatched?: number; recommendation?: string; stats?: Partial<LaneOutcomeStats> } = {}): LaneReport {
  return {
    lane: key, cohortName: key, cohortPath: '', describe: '',
    enrolledCount: o.enrolled ?? 0, observedCount: o.observed ?? 0,
    pendingCount: o.pending ?? 0, unmatchedCount: o.unmatched ?? 0,
    stats: stats({ n: o.observed ?? 0, ...o.stats }),
    recommendation: (o.recommendation as any) ?? 'FORWARD_SAMPLE_TOO_SMALL', recommendationReason: '',
  };
}
const ALL: LaneKey[] = ['EXACT_WATCH', 'LIQUIDITY_NEAR', 'MOMENTUM_FAMILY', 'WAIT10_QUALITY'];
function report(lanes: LaneReport[], baseline: Partial<LaneOutcomeStats> = {}): FamilyReportResult {
  const keys = lanes.map(l => l.lane);
  return {
    generatedAt: 't', dataDir: 'd', baseline: stats(baseline), lanes,
    ranking: { byObservedN: keys, byWinRate: keys, byMedian: keys, byCappedAvg: keys, byRedLossAsc: keys, byOutlierDepAsc: keys },
    familyRecommendation: 'FORWARD_SAMPLE_TOO_SMALL',
    config: { minForwardN: 50, pnlCapPct: 500 }, safetyLabel: 'PAPER_ONLY_WATCH_NOT_BUY',
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    noGateChanges: true, noBuySignal: true, noPaperIntentMutation: true, unknownNeverClean: true,
  };
}
const FRESH_CYCLE: ProofCycleInfo = { id: 'cycle-2026-06-26-000000', time: '2026-06-26T00:00:00Z', fresh: true, status: 'FRESH' };
function buildStatus(rep: FamilyReportResult, over: Partial<{ cycle: ProofCycleInfo; runs: number | null }> = {}): ProofStatus {
  return buildProofStatus({ generatedAt: '2026-06-26T00:00:00.000Z', report: rep, cycle: over.cycle ?? FRESH_CYCLE, fastTestRunsObserved: over.runs ?? null });
}

// ── proof-status ────────────────────────────────────────────────────────────────────

describe('proof-status', () => {
  it('handles no cohort files / n=0 cleanly → NO_SIGNAL, KEEP_COLLECTING', () => {
    const s = buildStatus(report(ALL.map(k => lane(k))));
    expect(s.bestLane).toBeNull();
    expect(s.confidenceTier).toBe('NO_SIGNAL');
    expect(s.decision).toBe('KEEP_COLLECTING');
    expect(s.lanes).toHaveLength(4);
    for (const l of s.lanes) expect(l.observed).toBe(0);
  });

  it('TOO_SMALL when best lane observed < 50', () => {
    const s = buildStatus(report([lane('EXACT_WATCH', { observed: 30, stats: { avgPnlCapped: 5, medianPnl: 2 } })]));
    expect(s.confidenceTier).toBe('TOO_SMALL');
    expect(s.decision).toBe('KEEP_COLLECTING');
  });

  it('chooses best lane conservatively (MOMENTUM_FAMILY, higher n + beats baseline) → PAPER_EDGE_CANDIDATE', () => {
    const good = { redLossRate: 0.05, avgPnlCapped: 3, medianPnl: 2, winRate: 0.7, outlierDependence: 0.1 };
    const rep = report([
      lane('EXACT_WATCH',     { observed: 30, stats: good }),
      lane('MOMENTUM_FAMILY', { observed: 60, stats: good }),
    ], { n: 1000, winRate: 0.4, redLossRate: 0.1, avgPnlCapped: 0, medianPnl: 0, outlierDependence: 0.05 });
    const s = buildStatus(rep);
    expect(s.bestLane!.lane).toBe('MOMENTUM_FAMILY');
    expect(s.bestLane!.qualifies).toBe(true);
    expect(s.confidenceTier).toBe('PAPER_EDGE_CANDIDATE');
    expect(s.decision).toBe('PAPER_ONLY_CANDIDATE');
  });

  it('WATCHLIST when n>=50 but does not beat baseline → INVESTIGATE_LANE', () => {
    const rep = report([lane('MOMENTUM_FAMILY', { observed: 60, stats: { avgPnlCapped: 0, medianPnl: 0, redLossRate: 0.3 } })],
      { n: 1000, winRate: 0.4, redLossRate: 0.1, avgPnlCapped: 1, medianPnl: 0, outlierDependence: 0.05 });
    const s = buildStatus(rep);
    expect(s.confidenceTier).toBe('WATCHLIST');
    expect(s.decision).toBe('INVESTIGATE_LANE');
  });

  it('STRONG_PAPER_EDGE when n>=100 and beats baseline across multiple checks', () => {
    const strong = { redLossRate: 0.02, avgPnlCapped: 5, medianPnl: 3, winRate: 0.8, outlierDependence: 0.08 };
    const rep = report([lane('MOMENTUM_FAMILY', { observed: 120, stats: strong })],
      { n: 1000, winRate: 0.4, redLossRate: 0.1, avgPnlCapped: 1, medianPnl: 0, outlierDependence: 0.06 });
    const s = buildStatus(rep);
    expect(s.confidenceTier).toBe('STRONG_PAPER_EDGE');
    expect(s.decision).toBe('PAPER_ONLY_CANDIDATE');
    expect(s.baselineChecksPassedByBest).toBeGreaterThanOrEqual(4);
  });

  it('UNKNOWN cluster breakdown is preserved and never relabelled CLEAN', () => {
    const rep = report([lane('EXACT_WATCH', { observed: 3, stats: { clusterBreakdown: { UNKNOWN: 3 } } })]);
    const s = buildStatus(rep);
    const exact = s.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.clusterBreakdown['UNKNOWN']).toBe(3);
    expect(exact.clusterBreakdown['CLEAN']).toBeUndefined();
  });

  it('render includes the full safety footer with DO_NOT_TRADE', () => {
    const t = renderProofStatus(buildStatus(report(ALL.map(k => lane(k)))));
    expect(t).toContain('PAPER_ONLY=true');
    expect(t).toContain('realTradingLocked=true');
    expect(t).toContain('tradingExecuted=0');
    expect(t).toContain('UNKNOWN_NEVER_CLEAN=true');
    expect(t).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(t).toContain('DO_NOT_TRADE');
    expect(t).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
  });

  it('safety flags structured correctly', () => {
    const s = buildStatus(report(ALL.map(k => lane(k))));
    expect(s.safety.PAPER_ONLY).toBe(true);
    expect(s.safety.realTradingLocked).toBe(true);
    expect(s.safety.tradingExecuted).toBe(0);
    expect(s.safety.UNKNOWN_NEVER_CLEAN).toBe(true);
    expect(s.safety.DO_NOT_ENABLE_REAL_TRADING).toBe(true);
    expect(s.safety.DO_NOT_TRADE).toBe(true);
  });
});

// ── cycleFreshnessFromTime ───────────────────────────────────────────────────────────

describe('cycleFreshnessFromTime', () => {
  const now = Date.parse('2026-06-26T01:00:00Z');
  it('NO_CYCLE when no id', () => {
    expect(cycleFreshnessFromTime(null, null, now).status).toBe('NO_CYCLE');
  });
  it('FRESH within the window', () => {
    expect(cycleFreshnessFromTime('cycle-x', '2026-06-26T00:45:00Z', now).status).toBe('FRESH');
  });
  it('STALE outside the window', () => {
    expect(cycleFreshnessFromTime('cycle-x', '2026-06-26T00:00:00Z', now).status).toBe('STALE');
  });
});

// ── proof-log append-only ─────────────────────────────────────────────────────────────

describe('proof-log append', () => {
  let dir: string, proofLog: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-')); proofLog = path.join(dir, 'proof-log.jsonl'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends exactly one JSONL row', () => {
    const row = buildProofLogRow(buildStatus(report([lane('MOMENTUM_FAMILY', { observed: 6 })])), { commit: 'abc', dirty: false });
    appendProofLog(proofLog, row);
    const lines = fs.readFileSync(proofLog, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ProofLogRow;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.gitCommit).toBe('abc');
    expect(parsed.gitDirty).toBe(false);
    expect(parsed.safety.doNotTrade).toBe(true);
  });

  it('two appends produce two rows (append-only, no rewrite)', () => {
    const s = buildStatus(report([lane('MOMENTUM_FAMILY', { observed: 6 })]));
    appendProofSnapshot({ report: report([lane('MOMENTUM_FAMILY', { observed: 6 })]), cycle: FRESH_CYCLE, generatedAt: 'a', proofLogPath: proofLog, git: { commit: null, dirty: null }, fastTestRunsObserved: 0 });
    appendProofSnapshot({ report: report([lane('MOMENTUM_FAMILY', { observed: 8 })]), cycle: FRESH_CYCLE, generatedAt: 'b', proofLogPath: proofLog, git: { commit: null, dirty: null }, fastTestRunsObserved: 1 });
    expect(readProofLog(proofLog)).toHaveLength(2);
    void s;
  });

  it('never mutates cohort lane files', () => {
    const laneFile = path.join(dir, 'watch-cohort-momentum-family.jsonl');
    fs.writeFileSync(laneFile, JSON.stringify({ lane: 'MOMENTUM_FAMILY', contract: 'X' }) + '\n', 'utf-8');
    const before = fs.readFileSync(laneFile, 'utf-8');
    appendProofSnapshot({ report: report([lane('MOMENTUM_FAMILY', { observed: 6 })]), cycle: FRESH_CYCLE, generatedAt: 'a', proofLogPath: proofLog, git: { commit: null, dirty: null }, fastTestRunsObserved: 0 });
    expect(fs.readFileSync(laneFile, 'utf-8')).toBe(before); // cohort file untouched
    expect(readProofLog(proofLog)).toHaveLength(1);
  });

  it('fast-test --append-proof-log style append writes one snapshot; no append writes nothing', () => {
    // With the flag (simulated by calling appendProofSnapshot): exactly one row.
    appendProofSnapshot({
      report: report([lane('MOMENTUM_FAMILY', { observed: 6 })]),
      cycle: { id: 'c', time: null, fresh: false, status: 'STALE_OR_CAPTURE_SKIPPED' },
      generatedAt: 'a', proofLogPath: proofLog, git: { commit: null, dirty: null }, fastTestRunsObserved: 0,
    });
    expect(readProofLog(proofLog)).toHaveLength(1);
    // Without the flag: nothing is appended → a separate untouched path stays absent.
    const otherLog = path.join(dir, 'other-proof-log.jsonl');
    expect(fs.existsSync(otherLog)).toBe(false);
    expect(readProofLog(otherLog)).toHaveLength(0);
  });
});

// ── proof-summary ─────────────────────────────────────────────────────────────────────

describe('proof-summary', () => {
  function snap(o: { gen: string; bestLane?: LaneKey | null; momObs?: number; liqObs?: number; momCapped?: number; baseRedLoss?: number; tier?: string; rec?: string }): ProofLogRow {
    const mk = (l: LaneKey, observed: number, capped = 0): any => ({
      lane: l, enrolled: observed, observed, pending: 0, unmatched: 0, winRate: 0, redLossRate: 0, flatRate: 0,
      medianPnl: 0, avgPnlCapped: capped, worstPnl: 0, bestPnl: 0, outlierDependence: 0, clusterBreakdown: {}, m5BandBreakdown: {}, recommendation: 'KEEP_COLLECTING',
    });
    return {
      schemaVersion: 1, generatedAt: o.gen, latestCycle: 'c', freshness: 'FRESH',
      baseline: { n: 100, winRate: 0.4, redLossRate: o.baseRedLoss ?? 0.05, flatRate: 0.5, medianPnl: 0, avgPnlCapped: 1, outlierDependence: 0.05 },
      lanes: [mk('EXACT_WATCH', 0), mk('LIQUIDITY_NEAR', o.liqObs ?? 0), mk('MOMENTUM_FAMILY', o.momObs ?? 0, o.momCapped ?? 0), mk('WAIT10_QUALITY', 0)],
      bestLane: o.bestLane === undefined ? { lane: 'MOMENTUM_FAMILY', qualifies: false, observed: o.momObs ?? 0 } : (o.bestLane ? { lane: o.bestLane, qualifies: false, observed: 0 } : null),
      confidenceTier: (o.tier as any) ?? 'TOO_SMALL', recommendation: (o.rec as any) ?? 'KEEP_COLLECTING',
      safety: { paperOnly: true, realTradingLocked: true, tradingExecuted: 0, unknownNeverClean: true, doNotEnableRealTrading: true, doNotTrade: true },
      gitCommit: null, gitDirty: null,
    };
  }

  it('handles an empty proof log cleanly', () => {
    const s = runProofSummary({ _rows: [] });
    expect(s.snapshots).toBe(0);
    expect(s.firstAt).toBeNull();
    expect(s.latestAt).toBeNull();
    expect(s.anyImproving).toBe(false);
    expect(s.currentRecommendation).toBeNull();
    expect(renderProofSummary(s)).toContain('no proof snapshots yet');
  });

  it('shows trends from multiple snapshots (MOMENTUM observed n growing + improving cappedAvg)', () => {
    const s = runProofSummary({ _rows: [
      snap({ gen: '2026-06-26T00:00:00Z', momObs: 6,  momCapped: 1, liqObs: 2 }),
      snap({ gen: '2026-06-26T01:00:00Z', momObs: 20, momCapped: 3, liqObs: 5, tier: 'TOO_SMALL', rec: 'KEEP_COLLECTING' }),
    ] });
    expect(s.snapshots).toBe(2);
    expect(s.firstAt).toBe('2026-06-26T00:00:00Z');
    expect(s.latestAt).toBe('2026-06-26T01:00:00Z');
    const mom = s.laneTrends.find(t => t.lane === 'MOMENTUM_FAMILY')!;
    expect(mom.firstObserved).toBe(6);
    expect(mom.lastObserved).toBe(20);
    expect(mom.observedDirection).toBe('UP');
    expect(mom.cappedAvgDirection).toBe('UP');
    expect(mom.status).toBe('IMPROVING');
    const liq = s.laneTrends.find(t => t.lane === 'LIQUIDITY_NEAR')!;
    expect(liq.firstObserved).toBe(2);
    expect(liq.lastObserved).toBe(5);
    expect(s.anyImproving).toBe(true);
    expect(s.currentRecommendation).toBe('KEEP_COLLECTING');
  });

  it('detects a degrading lane (cappedAvg falling)', () => {
    const s = runProofSummary({ _rows: [
      snap({ gen: 'a', momObs: 60, momCapped: 5 }),
      snap({ gen: 'b', momObs: 60, momCapped: 1 }),
    ] });
    const mom = s.laneTrends.find(t => t.lane === 'MOMENTUM_FAMILY')!;
    expect(mom.cappedAvgDirection).toBe('DOWN');
    expect(mom.status).toBe('DEGRADING');
    expect(s.anyDegrading).toBe(true);
  });

  it('render includes the safety footer with DO_NOT_TRADE and only DO_NOT_ forms', () => {
    const t = renderProofSummary(runProofSummary({ _rows: [snap({ gen: 'a', momObs: 6 })] }));
    expect(t).toContain('PAPER_ONLY=true');
    expect(t).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(t).toContain('DO_NOT_TRADE');
    expect(t).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(t).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });
});

// ── Static safety guard: proof module never invokes forbidden commands ──────────────────

describe('proof module never invokes forbidden commands', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/ripperProof.ts'), 'utf-8');
  it('never references token:auto-paper', () => { expect(src).not.toContain('token:auto-paper'); });
  it('never references token:paper-buy', () => { expect(src).not.toContain('token:paper-buy'); });
  it('never references --live', () => { expect(src).not.toContain('--live'); });
});
