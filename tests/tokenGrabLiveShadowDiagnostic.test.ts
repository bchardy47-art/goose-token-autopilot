// LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET  NO_SWAP  NO_SIGNING  DO_NOT_ENABLE_REAL_TRADING

import { describe, it, expect, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runLiveShadowCycle, renderLiveShadowCycleSummary,
  buildLiveShadowDiagnosticRecord,
  type LiveShadowDiagnosticRecord, type LiveShadowCandidateDiagnostic, type LiveShadowSourceInfo,
} from '../src/token-grab/liveShadow';
import { runLiveShadowDiagnostic, renderLiveShadowDiagnostic } from '../src/token-grab/liveShadowDiagnostic';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();
const nowIso = new Date(NOW_MS).toISOString();

// ── Cycle fixtures ──────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-diag-')); dirs.push(d); return d; }
function cyclesDirIn(base: string): string { const d = path.join(base, 'cycles'); fs.mkdirSync(d, { recursive: true }); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Pre-scored ripper cycle row that (defaults) matches NO_BM_INTERNAL_BROAD + best-VLR. */
function cycleRow(contract: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  const m5 = (o.entryMomentumPct as number) ?? -10;
  return {
    capturedAt: (o.capturedAt as string) ?? nowIso,
    ripperScore: (o.ripperScore as number) ?? 70,
    launchAgeBucket: (o.launchAgeBucket as string) ?? 'PRIME_WINDOW',
    buyGateDecision: (o.buyGateDecision as string) ?? 'BUY_REJECTED',
    entryDecision: (o.entryDecision as string) ?? 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: m5,
    topReasons: [],
    ripperInput: { contract, clusterRisk: (o.clusterRisk as string) ?? 'UNKNOWN' },
    normalizedSignal: {
      contract, symbol: contract.slice(0, 4),
      liquidityUsd: (o.liquidityUsd as number) ?? 20_000,
      volumeLiquidityRatio: (o.volumeLiquidityRatio as number) ?? 0.6,
      priceChangePct: (o.priceChangePct as number) ?? 35,
      liquidityChangePct: 10,
      entryPriceChangeM5: m5,
      observedAt: nowIso,
    },
  };
}
function writeCycle(cyclesDir: string, slug: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(cyclesDir, `cycle-${slug}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

// ── Per-candidate reject diagnostics on the cycle result ────────────────────────────────────

describe('runLiveShadowCycle per-candidate reject diagnostics', () => {
  it('produces a diagnostic per candidate with the required fields; UNKNOWN cluster stays UNKNOWN', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('GoodToken1111111111111111111111111111111111')]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });

    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    for (const k of ['symbol', 'contract', 'decision', 'rejectReasons', 'm5Band', 'liquidityBucket', 'vlrBucket', 'ripperScoreBand', 'clusterRisk', 'productionGateApproved', 'matchesNoBmResearch', 'matchesBestSubgroup', 'matchesPullback', 'primaryLane'] as const) {
      expect(d).toHaveProperty(k);
    }
    expect(d.clusterRisk).toBe('UNKNOWN');
    expect(JSON.stringify(r.diagnostics)).not.toContain('"CLEAN"');
    expect(d.vlrBucket).toBe('VLR_0_5_TO_2');
    expect(d.matchesBestSubgroup).toBe(true);
  });

  it('a lane-matching candidate is READY; render shows candidate diagnostics + lane summary', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('GoodToken1111111111111111111111111111111111')]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(r.readyCount).toBe(1);
    expect(r.diagnostics[0]!.decision).toBe('READY');
    const txt = renderLiveShadowCycleSummary(r);
    expect(txt).toContain('CANDIDATE DIAGNOSTICS');
    expect(txt).toContain('[READY');
    expect(txt).toContain('bestVlr(VLR_0_5_TO_2)=YES');
    expect(txt).toMatch(/Production buy gate approved/);
  });

  it('normalizes reject reasons into buckets (no per-minute strings)', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('DeadToken1111111111111111111111111111111111', { launchAgeBucket: 'DEAD_WINDOW', ripperScore: 20, entryMomentumPct: 200 }),
    ]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    const reasons = r.diagnostics[0]!.rejectReasons;
    expect(reasons).toContain('DEAD_WINDOW_TOO_OLD');
    expect(reasons).toContain('SCORE_BELOW_FLOOR');
    // No per-minute noise like "dead window (31922m)".
    expect(reasons.join(' ')).not.toMatch(/\d+m\)/);
    expect(reasons.join(' ')).not.toMatch(/\d{3,}/);
  });

  it('enforces risk limits — the 3rd concurrent candidate is BLOCKED by the $20 open-position cap', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('AToken111111111111111111111111111111111111A'),
      cycleRow('BToken222222222222222222222222222222222222B'),
      cycleRow('CToken333333333333333333333333333333333333C'),
    ]);
    const r = runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    const blocked = r.diagnostics.filter(d => d.decision === 'BLOCKED');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.some(d => d.rejectReasons.some(x => /RISK_LIMIT/.test(x) && /open position cap/.test(x)))).toBe(true);
    expect(r.bankrollSummaries.find(b => b.bankroll === 20)!.skippedByRiskLimit).toBeGreaterThanOrEqual(1);
  });

  it('writes ONLY live-shadow files (state, events, diagnostics) when diagnosticsPath is set', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('GoodToken1111111111111111111111111111111111')]);
    runLiveShadowCycle({
      cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'),
      diagnosticsPath: path.join(dir, 'diagnostics.jsonl'), nowMs: NOW_MS,
    });
    expect(fs.readdirSync(dir).sort()).toEqual(['cycles', 'diagnostics.jsonl', 'events.jsonl', 'state.json'].sort());
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics.jsonl'), 'utf-8').trim()) as LiveShadowDiagnosticRecord;
    expect(rec.realTrading).toBe(false);
    expect(rec.liveShadowOnly).toBe(true);
    expect(rec.unknownNeverClean).toBe(true);
    expect(rec.readyForRealTrading).toBe(false);
    expect(rec.staleSource).toBe(false);
  });

  it('does NOT write a diagnostics file when diagnosticsPath is omitted', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow('GoodToken1111111111111111111111111111111111')]);
    runLiveShadowCycle({ cyclesDir, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(fs.readdirSync(dir).sort()).toEqual(['cycles', 'events.jsonl', 'state.json'].sort());
  });
});

// ── Diagnostic record builder ───────────────────────────────────────────────────────────────

describe('buildLiveShadowDiagnosticRecord', () => {
  function source(o: Partial<LiveShadowSourceInfo> = {}): LiveShadowSourceInfo {
    return {
      sourceMode: 'FRESH_CYCLE', sourceFile: 'cycles/cycle-x.jsonl', sourceTimestamp: nowIso,
      sourceAgeMinutes: 2, candidateCount: 4, staleSource: false, maxSourceAgeMinutes: 15, ...o,
    };
  }
  function diag(o: Partial<LiveShadowCandidateDiagnostic>): LiveShadowCandidateDiagnostic {
    return {
      symbol: 'S', contract: 'C', decision: 'IGNORED', rejectReasons: [],
      m5Band: '-5 to +5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', ripperScoreBand: 'SCORE_80_89',
      ripperScore: 85, clusterRisk: 'UNKNOWN', productionGateApproved: false,
      matchesNoBmResearch: true, matchesBestSubgroup: true, matchesPullback: false,
      matchedLanes: ['NO_BM_BEST_VLR', 'NO_BM_INTERNAL_BROAD'], primaryLane: 'NO_BM_BEST_VLR', ...o,
    };
  }
  it('tallies decisions, normalized reasons, lane counts, and top missing condition', () => {
    const diagnostics = [
      diag({ decision: 'IGNORED', rejectReasons: ['M5_OUTSIDE_LANE'], matchesNoBmResearch: false, matchesBestSubgroup: false }),
      diag({ decision: 'IGNORED', rejectReasons: ['M5_OUTSIDE_LANE'], matchesNoBmResearch: false, matchesBestSubgroup: false }),
      diag({ decision: 'BLOCKED', rejectReasons: ['RISK_LIMIT: open position cap reached (2/2)'] }),
      diag({ decision: 'READY',   rejectReasons: [] }),
    ];
    const rec = buildLiveShadowDiagnosticRecord({
      ts: 't', source: source(), sourceCycle: 'cycle-x', skipped: false, skipReason: null,
      diagnostics, productionGateApprovedCount: 1,
    });
    expect(rec.decisionCounts).toEqual({ IGNORED: 2, WATCH: 0, BLOCKED: 1, READY: 1 });
    expect(rec.ignoredByReason['M5_OUTSIDE_LANE']).toBe(2);
    expect(rec.blockedByReason['RISK_LIMIT: open position cap reached (2/2)']).toBe(1);
    expect(rec.topMissingCondition).toBe('M5_OUTSIDE_LANE');
    expect(rec.readyCount).toBe(1);
    expect(rec.wouldBuyCount).toBe(1);
    expect(rec.laneMatchCounts.NO_BM_BEST_VLR).toBe(2);
    expect(rec.productionGateApprovedCount).toBe(1);
    expect(rec.realTrading).toBe(false);
  });

  it('a stale-skipped cycle records STALE_SOURCE as the single reason', () => {
    const rec = buildLiveShadowDiagnosticRecord({
      ts: 't', source: source({ staleSource: true, candidateCount: 5 }), sourceCycle: 'cycle-x',
      skipped: true, skipReason: 'STALE_SOURCE', diagnostics: [], productionGateApprovedCount: 0,
    });
    expect(rec.staleSource).toBe(true);
    expect(rec.ignoredByReason.STALE_SOURCE).toBe(5);
    expect(rec.topMissingCondition).toBe('STALE_SOURCE');
    expect(rec.totalCandidates).toBe(5);
  });
});

// ── Diagnostic report (last N cycles) ───────────────────────────────────────────────────────

describe('runLiveShadowDiagnostic report', () => {
  function record(o: Partial<LiveShadowDiagnosticRecord>): LiveShadowDiagnosticRecord {
    return {
      schemaVersion: 2, ts: 't', sourceMode: 'FRESH_CYCLE', sourceFile: 'cycles/cycle-x.jsonl', sourceCycle: 'cycle-x',
      sourceTimestamp: nowIso, sourceAgeMinutes: 2, staleSource: false, maxSourceAgeMinutes: 15,
      skipped: false, skipReason: null, totalCandidates: 0,
      decisionCounts: { IGNORED: 0, WATCH: 0, BLOCKED: 0, READY: 0 },
      ignoredByReason: {}, blockedByReason: {}, missingConditionTally: {},
      readyCount: 0, wouldBuyCount: 0, productionGateApprovedCount: 0,
      laneMatchCounts: { NO_BM_INTERNAL_BROAD: 0, NO_BM_BEST_VLR: 0, NO_BM_PULLBACK: 0 },
      matchesNoBmResearchCount: 0, matchesBestSubgroupCount: 0, matchesPullbackCount: 0, topMissingCondition: null,
      liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
      unknownNeverClean: true, readyForRealTrading: false, ...o,
    };
  }

  it('handles an empty diagnostics log cleanly, REAL_TRADING=false', () => {
    const r = runLiveShadowDiagnostic({ _records: [] });
    expect(r.cyclesSummarized).toBe(0);
    expect(r.totalCandidates).toBe(0);
    expect(r.READY_FOR_REAL_TRADING).toBe(false);
    expect(r.REAL_TRADING).toBe(false);
    expect(() => renderLiveShadowDiagnostic(r)).not.toThrow();
  });

  it('summarizes last N cycles: candidates, normalized reasons, lanes, ready/would-buy, top missing, stale count', () => {
    const recs = [
      record({ ts: 'c1', totalCandidates: 5, decisionCounts: { IGNORED: 3, WATCH: 1, BLOCKED: 0, READY: 1 }, readyCount: 1, wouldBuyCount: 1, ignoredByReason: { M5_OUTSIDE_LANE: 3 }, missingConditionTally: { M5_OUTSIDE_LANE: 3 }, laneMatchCounts: { NO_BM_INTERNAL_BROAD: 2, NO_BM_BEST_VLR: 1, NO_BM_PULLBACK: 1 }, productionGateApprovedCount: 1 }),
      record({ ts: 'c2', staleSource: true, totalCandidates: 4, decisionCounts: { IGNORED: 4, WATCH: 0, BLOCKED: 0, READY: 0 }, ignoredByReason: { STALE_SOURCE: 4 }, missingConditionTally: { STALE_SOURCE: 4 } }),
    ];
    const r = runLiveShadowDiagnostic({ _records: recs, lastN: 20 });
    expect(r.cyclesSummarized).toBe(2);
    expect(r.totalCandidates).toBe(9);
    expect(r.decisionCounts).toEqual({ IGNORED: 7, WATCH: 1, BLOCKED: 0, READY: 1 });
    expect(r.readyCount).toBe(1);
    expect(r.wouldBuyCount).toBe(1);
    expect(r.ignoredByReason['M5_OUTSIDE_LANE']).toBe(3);
    expect(r.ignoredByReason['STALE_SOURCE']).toBe(4);
    expect(r.laneMatchCounts.NO_BM_INTERNAL_BROAD).toBe(2);
    expect(r.productionGateApprovedTotal).toBe(1);
    expect(r.staleCycles).toBe(1);
    expect(r.topMissingCondition).toBe('STALE_SOURCE');
  });

  it('respects lastN (only summarizes the most recent N records)', () => {
    const recs = [record({ ts: 'old', totalCandidates: 100 }), record({ ts: 'new', totalCandidates: 3 })];
    const r = runLiveShadowDiagnostic({ _records: recs, lastN: 1 });
    expect(r.cyclesSummarized).toBe(1);
    expect(r.totalCandidates).toBe(3);
    expect(r.lastCycleTs).toBe('new');
  });

  it('render includes REPORT-ONLY safety and REAL_TRADING=false, only DO_NOT_ real-trading forms', () => {
    const txt = renderLiveShadowDiagnostic(runLiveShadowDiagnostic({ _records: [record({})] }));
    expect(txt).toContain('REPORT_ONLY=true');
    expect(txt).toContain('REAL_TRADING=false');
    expect(txt).toContain('READY_FOR_REAL_TRADING=false');
    expect(txt).toContain('NO_WALLET=true');
    expect(txt).toContain('UNKNOWN_NEVER_CLEAN=true');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
  });
});

// ── Static safety guard ─────────────────────────────────────────────────────────────────────

describe('live-shadow diagnostic introduces no unsafe behavior', () => {
  const files = [
    path.resolve(__dirname, '../src/token-grab/liveShadowDiagnostic.ts'),
    path.resolve(__dirname, '../src/token-grab/liveShadow.ts'),
  ];
  it('no wallet / signing / swap-execution / private-key code', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction/i);
    }
  });
  it('the diagnostic module never references token:auto-paper / token:paper-buy / --live', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadowDiagnostic.ts'), 'utf-8');
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
  });
  it('neither module can spawn a subprocess (no child_process import)', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/from ['"](node:)?child_process['"]/);
      expect(src).not.toMatch(/require\(['"](node:)?child_process['"]\)/);
    }
  });
  it('no code path relabels UNKNOWN to CLEAN', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
    }
  });
});
