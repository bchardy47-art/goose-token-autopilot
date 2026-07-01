// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  assessWindow,
  runOperator,
  renderOperatorDecision,
  readOperatorCooldown,
  type OperatorDeps, type OperatorProofState,
} from '../src/token-grab/ripperOperator';
import type { ProofStatus, ProofCycleInfo } from '../src/token-grab/ripperProof';
import type { FamilyReportResult, LaneReport, LaneOutcomeStats, LaneKey } from '../src/token-grab/ripperWatchCohortFamily';

// ── Factories ──────────────────────────────────────────────────────────────────────

function stats(o: Partial<LaneOutcomeStats> = {}): LaneOutcomeStats {
  return {
    n: 0, winRate: 0, redLossRate: 0, flatRate: 0, avgPnlRaw: 0, avgPnlCapped: 0,
    medianPnl: 0, worstPnl: 0, bestPnl: 0, outlierDependence: 0,
    clusterBreakdown: {}, m5BandBreakdown: {}, ...o,
  };
}
function lane(key: LaneKey, o: { observed?: number; stats?: Partial<LaneOutcomeStats> } = {}): LaneReport {
  return {
    lane: key, cohortName: key, cohortPath: '', describe: '',
    enrolledCount: o.observed ?? 0, observedCount: o.observed ?? 0, pendingCount: 0, unmatchedCount: 0,
    stats: stats({ n: o.observed ?? 0, ...o.stats }),
    recommendation: 'FORWARD_SAMPLE_TOO_SMALL', recommendationReason: '',
  };
}
const ALL: LaneKey[] = ['EXACT_WATCH', 'LIQUIDITY_NEAR', 'MOMENTUM_FAMILY', 'WAIT10_QUALITY'];
function report(lanes: LaneReport[], baseline: Partial<LaneOutcomeStats> = {}): FamilyReportResult {
  const keys = lanes.map(l => l.lane);
  return {
    generatedAt: 't', dataDir: 'd', baseline: stats(baseline), lanes,
    ranking: { byObservedN: keys, byWinRate: keys, byMedian: keys, byCappedAvg: keys, byRedLossAsc: keys, byOutlierDepAsc: keys },
    familyRecommendation: 'FORWARD_SAMPLE_TOO_SMALL', config: { minForwardN: 50, pnlCapPct: 500 },
    safetyLabel: 'PAPER_ONLY_WATCH_NOT_BUY',
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    noGateChanges: true, noBuySignal: true, noPaperIntentMutation: true, unknownNeverClean: true,
  };
}
const FRESH: ProofCycleInfo = { id: 'cycle-2026-06-27-000000', time: '2026-06-27T00:00:00Z', fresh: true, status: 'FRESH' };
const STALE: ProofCycleInfo = { id: 'cycle-old', time: '2026-06-26T00:00:00Z', fresh: false, status: 'STALE' };

interface DepsOverrides {
  proofStates?: OperatorProofState[];   // returned in sequence per readProofState call
  cooldownActive?: boolean;
  approved?: number;
  rejected?: number;
}
function makeDeps(over: DepsOverrides = {}): { deps: OperatorDeps; calls: Record<string, number> } {
  const calls = { readProofState: 0, readCooldown: 0, autopilot: 0, runCollection: 0, appendSkippedProof: 0 };
  const states = over.proofStates ?? [{ report: report(ALL.map(k => lane(k))), cycle: FRESH, runsObserved: 0 }];
  const deps: OperatorDeps = {
    readProofState: () => { const i = Math.min(calls.readProofState, states.length - 1); calls.readProofState++; return states[i]!; },
    readCooldown:   () => { calls.readCooldown++; return { active: over.cooldownActive ?? false, expiresAt: over.cooldownActive ? '2099-01-01T00:00:00Z' : null, minutesRemaining: over.cooldownActive ? 60 : null }; },
    autopilot:      () => { calls.autopilot++; return { approvedCount: over.approved ?? 5, rejectedCount: over.rejected ?? 3, realTradingLocked: true, tradingExecuted: 0 }; },
    runCollection:  () => { calls.runCollection++; },
    appendSkippedProof: () => { calls.appendSkippedProof++; },
    now: () => Date.parse('2026-06-27T01:00:00Z'),
  };
  return { deps, calls };
}

// ── assessWindow (pure) ──────────────────────────────────────────────────────────────

describe('assessWindow', () => {
  it('GOOD_WINDOW when fresh, no cooldown, approvals present', () => {
    const a = assessWindow({ cooldownActive: false, freshness: 'FRESH', approvedLatest: 5, force: false });
    expect(a.window).toBe('GOOD_WINDOW');
    expect(a.badReasons).toEqual([]);
    expect(a.shouldCollect).toBe(true);
  });
  it('BAD_WINDOW + COOLDOWN_ACTIVE; no collect without force', () => {
    const a = assessWindow({ cooldownActive: true, freshness: 'FRESH', approvedLatest: 5, force: false });
    expect(a.window).toBe('BAD_WINDOW');
    expect(a.badReasons).toContain('COOLDOWN_ACTIVE');
    expect(a.shouldCollect).toBe(false);
  });
  it('force makes a bad window collect', () => {
    const a = assessWindow({ cooldownActive: true, freshness: 'STALE', approvedLatest: 0, force: true });
    expect(a.window).toBe('BAD_WINDOW');
    expect(a.shouldCollect).toBe(true);
  });
  it('STALE_FEED for non-fresh; NO_FRESH_CANDIDATES for 0 approvals', () => {
    const a = assessWindow({ cooldownActive: false, freshness: 'STALE', approvedLatest: 0, force: false });
    expect(a.badReasons).toContain('STALE_FEED');
    expect(a.badReasons).toContain('NO_FRESH_CANDIDATES');
  });
});

// ── runOperator orchestration ─────────────────────────────────────────────────────────

describe('runOperator', () => {
  it('skips collection when cooldown active and --force absent → BAD_WINDOW_SKIP (BM enabled)', () => {
    const { deps, calls } = makeDeps({ cooldownActive: true });
    const d = runOperator({ bmEnabled: true }, deps);   // cooldown only matters when BM is enabled
    expect(calls.runCollection).toBe(0);
    expect(d.collected).toBe(false);
    expect(d.window).toBe('BAD_WINDOW');
    expect(d.finalDecision).toBe('BAD_WINDOW_SKIP');
    expect(d.reasons).toContain('COOLDOWN_ACTIVE');
    expect(d.cooldownActive).toBe(true);
    expect(d.cooldownExpiresAt).toBe('2099-01-01T00:00:00Z');
  });

  it('runs collection when --force is present despite cooldown (BM enabled)', () => {
    const { deps, calls } = makeDeps({ cooldownActive: true });
    const d = runOperator({ force: true, bmEnabled: true }, deps);
    expect(calls.runCollection).toBe(1);
    expect(d.collected).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.finalDecision).toBe('GOOD_WINDOW_COLLECT');
  });

  it('skips a stale feed (no force) → BAD_WINDOW_SKIP with STALE_FEED', () => {
    const { deps, calls } = makeDeps({ proofStates: [{ report: report(ALL.map(k => lane(k))), cycle: STALE, runsObserved: 0 }] });
    const d = runOperator({}, deps);
    expect(calls.runCollection).toBe(0);
    expect(d.finalDecision).toBe('BAD_WINDOW_SKIP');
    expect(d.reasons).toContain('STALE_FEED');
    expect(d.cycleFreshness).toBe('STALE');
  });

  it('prints GOOD_WINDOW_COLLECT when collection should run', () => {
    const before: OperatorProofState = { report: report([lane('MOMENTUM_FAMILY', { observed: 6 })]), cycle: FRESH, runsObserved: 0 };
    const after:  OperatorProofState = { report: report([lane('MOMENTUM_FAMILY', { observed: 12 })]), cycle: FRESH, runsObserved: 1 };
    const { deps, calls } = makeDeps({ proofStates: [before, after] });
    const d = runOperator({}, deps);
    expect(calls.runCollection).toBe(1);
    expect(d.window).toBe('GOOD_WINDOW');
    expect(d.finalDecision).toBe('GOOD_WINDOW_COLLECT');
    expect(d.reasons).not.toContain('NO_NEW_EVIDENCE'); // observed grew 6 → 12
  });

  it('detects NO_NEW_EVIDENCE when observed counts do not change after collection', () => {
    const same: OperatorProofState = { report: report([lane('MOMENTUM_FAMILY', { observed: 6 })]), cycle: FRESH, runsObserved: 0 };
    const { deps } = makeDeps({ proofStates: [same, same] });
    const d = runOperator({}, deps);
    expect(d.collected).toBe(true);
    expect(d.reasons).toContain('NO_NEW_EVIDENCE');
    expect(d.finalDecision).toBe('GOOD_WINDOW_COLLECT'); // collection still ran
  });

  it('--append-skipped-proof-log only appends a skipped snapshot when explicitly passed', () => {
    const cd: DepsOverrides = { cooldownActive: true };
    const without = makeDeps(cd);
    runOperator({ bmEnabled: true }, without.deps);
    expect(without.calls.appendSkippedProof).toBe(0);

    const withFlag = makeDeps(cd);
    const d = runOperator({ appendSkippedProofLog: true, bmEnabled: true }, withFlag.deps);
    expect(withFlag.calls.appendSkippedProof).toBe(1);
    expect(d.appendedSkippedProofLog).toBe(true);
    expect(d.collected).toBe(false); // still skipped
  });

  it('does not append skipped snapshot when collection runs', () => {
    const { deps, calls } = makeDeps();
    runOperator({ appendSkippedProofLog: true }, deps); // good window → collects, not skipped
    expect(calls.runCollection).toBe(1);
    expect(calls.appendSkippedProof).toBe(0);
  });

  it('--dry-run-enroll and --skip-day-watch forward into runCollection', () => {
    let received: { dryRunEnroll: boolean; skipDayWatch: boolean } | null = null;
    const { deps } = makeDeps();
    deps.runCollection = (o) => { received = o; };
    runOperator({ dryRunEnroll: true, skipDayWatch: true }, deps);
    expect(received).toEqual({ dryRunEnroll: true, skipDayWatch: true });
  });

  // ── BubbleMaps disabled (default) — cooldown must NOT block collection ─────────────
  it('BM disabled (default): active cooldown does NOT block — still collects', () => {
    const { deps, calls } = makeDeps({ cooldownActive: true });   // an old cooldown file exists
    const d = runOperator({}, deps);                              // bmEnabled defaults to false
    expect(d.bmEnabled).toBe(false);
    expect(calls.runCollection).toBe(1);                          // collection ran despite cooldown
    expect(d.collected).toBe(true);
    expect(d.cooldownActive).toBe(false);                        // effective cooldown is inactive
    expect(d.reasons).not.toContain('COOLDOWN_ACTIVE');
    expect(d.finalDecision).toBe('GOOD_WINDOW_COLLECT');
  });

  it('BM disabled: does not even read the cooldown marker', () => {
    const { deps, calls } = makeDeps({ cooldownActive: true });
    runOperator({}, deps);
    expect(calls.readCooldown).toBe(0);                           // cooldown never consulted when BM off
  });

  it('BM disabled: still skips on STALE_FEED and NO_FRESH_CANDIDATES', () => {
    const stale = makeDeps({ proofStates: [{ report: report(ALL.map(k => lane(k))), cycle: STALE, runsObserved: 0 }] });
    const ds = runOperator({}, stale.deps);
    expect(ds.finalDecision).toBe('BAD_WINDOW_SKIP');
    expect(ds.reasons).toContain('STALE_FEED');

    const noCand = makeDeps({ approved: 0 });
    const dn = runOperator({}, noCand.deps);
    expect(dn.reasons).toContain('NO_FRESH_CANDIDATES');
    expect(dn.finalDecision).toBe('BAD_WINDOW_SKIP');
  });

  it('render shows BubbleMaps DISABLED and cooldown-ignored note', () => {
    const { deps } = makeDeps({ cooldownActive: true });
    const txt = renderOperatorDecision(runOperator({}, deps));
    expect(txt).toContain('BubbleMaps        : DISABLED');
    expect(txt).toContain('cooldown ignored');
  });

  it('surfaces best-lane metrics and tier', () => {
    const good = { observed: 60, stats: { medianPnl: 2, avgPnlCapped: 3, redLossRate: 0.05, winRate: 0.7, outlierDependence: 0.1 } };
    const rep = report([lane('MOMENTUM_FAMILY', good)], { n: 1000, winRate: 0.4, redLossRate: 0.1, avgPnlCapped: 0, medianPnl: 0, outlierDependence: 0.05 });
    const { deps } = makeDeps({ proofStates: [{ report: rep, cycle: FRESH, runsObserved: 0 }, { report: rep, cycle: FRESH, runsObserved: 1 }] });
    const d = runOperator({}, deps);
    expect(d.bestLane).toBe('MOMENTUM_FAMILY');
    expect(d.bestLaneObserved).toBe(60);
    expect(d.bestLaneMedian).toBe(2);
    expect(d.bestLaneCappedAvg).toBe(3);
    expect(d.bestLaneRedLoss).toBe(0.05);
    expect(d.confidenceTier).toBe('PAPER_EDGE_CANDIDATE');
    expect(d.proofRecommendation).toBe('PAPER_ONLY_CANDIDATE');
  });
});

// ── Safety + rendering ────────────────────────────────────────────────────────────────

describe('operator safety + render', () => {
  it('safety footer always present with DO_NOT_TRADE; only DO_NOT_ real-trading forms', () => {
    const { deps } = makeDeps({ cooldownActive: true });
    const d = runOperator({ bmEnabled: true }, deps);   // BM on so the cooldown drives BAD_WINDOW_SKIP
    expect(d.safety.PAPER_ONLY).toBe(true);
    expect(d.safety.realTradingLocked).toBe(true);
    expect(d.safety.tradingExecuted).toBe(0);
    expect(d.safety.UNKNOWN_NEVER_CLEAN).toBe(true);
    expect(d.safety.DO_NOT_TRADE).toBe(true);
    const txt = renderOperatorDecision(d);
    expect(txt).toContain('PAPER_ONLY=true');
    expect(txt).toContain('realTradingLocked=true');
    expect(txt).toContain('tradingExecuted=0');
    expect(txt).toContain('UNKNOWN_NEVER_CLEAN=true');
    expect(txt).toContain('DO_NOT_TRADE');
    expect(txt).toContain('BAD_WINDOW_SKIP');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });

  it('json-serialisable structured decision', () => {
    const { deps } = makeDeps();
    const parsed = JSON.parse(JSON.stringify(runOperator({}, deps)));
    expect(parsed.finalDecision).toBeDefined();
    expect(parsed.safety.DO_NOT_TRADE).toBe(true);
    expect(parsed.window).toBeDefined();
  });

  it('renders UNKNOWN cluster context, never the word CLEAN for unknown lanes', () => {
    // A lane with UNKNOWN cluster must never be rendered as CLEAN.
    const rep = report([lane('EXACT_WATCH', { observed: 3, stats: { clusterBreakdown: { UNKNOWN: 3 } } })]);
    const { deps } = makeDeps({ proofStates: [{ report: rep, cycle: FRESH, runsObserved: 0 }, { report: rep, cycle: FRESH, runsObserved: 1 }] });
    const d = runOperator({}, deps);
    expect(JSON.stringify(d)).not.toContain('"CLEAN"');
  });
});

// ── readOperatorCooldown ──────────────────────────────────────────────────────────────

describe('readOperatorCooldown', () => {
  let dir: string, cdPath: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-cd-')); cdPath = path.join(dir, 'cd.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const now = Date.parse('2026-06-27T01:00:00Z');
  it('inactive when file missing', () => {
    expect(readOperatorCooldown(cdPath, now).active).toBe(false);
  });
  it('active when expiresAt in the future', () => {
    fs.writeFileSync(cdPath, JSON.stringify({ expiresAt: '2026-06-27T01:30:00Z', reason: 'RATE_LIMITED' }));
    const c = readOperatorCooldown(cdPath, now);
    expect(c.active).toBe(true);
    expect(c.minutesRemaining).toBe(30);
    expect(c.expiresAt).toBe('2026-06-27T01:30:00Z');
  });
  it('inactive when expired', () => {
    fs.writeFileSync(cdPath, JSON.stringify({ expiresAt: '2026-06-27T00:30:00Z' }));
    expect(readOperatorCooldown(cdPath, now).active).toBe(false);
  });
  it('inactive when malformed', () => {
    fs.writeFileSync(cdPath, 'not json');
    expect(readOperatorCooldown(cdPath, now).active).toBe(false);
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────

describe('operator module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/ripperOperator.ts'), 'utf-8');
  it('no token:auto-paper', () => { expect(src).not.toContain('token:auto-paper'); });
  it('no token:paper-buy', () => { expect(src).not.toContain('token:paper-buy'); });
  it('no --live', () => { expect(src).not.toContain('--live'); });
  it('no wallet signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|swapExecute|executeSwap/i);
  });
});
