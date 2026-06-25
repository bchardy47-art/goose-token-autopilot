// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect } from 'vitest';
import {
  classifySubgroupWatch,
  runSubgroupWatch,
  renderSubgroupWatchSummary,
  m5BandLabel,
  TARGET_ENTRY_TIMING,
  TARGET_M5_BAND,
  TARGET_LIQUIDITY_BUCKET,
  WATCH_LABEL,
  WATCH_REASON,
  WATCH_SAFETY_LABEL,
  type SubgroupWatchRow,
} from '../src/token-grab/ripperSubgroupWatch';
import {
  runRipperLearningLoop,
  renderRipperLearningLoopSummary,
} from '../src/token-grab/ripperLearningLoop';

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** A row that matches the target subgroup exactly. */
function matchingRow(o: Partial<SubgroupWatchRow> = {}): SubgroupWatchRow {
  return {
    symbol:          'TKN',
    contract:        'CONTRACT_MATCH',
    entryTiming:     'ENTER_NOW',
    m5Band:          '-20 to -5',
    liquidityBucket: 'LIQ_10K_30K',
    entryMomentumPct: -13.4,
    ripperScore:     100,
    clusterRisk:     'UNKNOWN',
    ...o,
  };
}

// ── Target constants ───────────────────────────────────────────────────────────────

describe('target subgroup constants', () => {
  it('targets the conviction report top subgroup', () => {
    expect(TARGET_ENTRY_TIMING).toBe('ENTER_NOW');
    expect(TARGET_M5_BAND).toBe('-20 to -5');
    expect(TARGET_LIQUIDITY_BUCKET).toBe('LIQ_10K_30K');
  });

  it('m5BandLabel matches the simulation report banding', () => {
    expect(m5BandLabel(-13.4)).toBe('-20 to -5');
    expect(m5BandLabel(-5)).toBe('-20 to -5');   // boundary: m > -20 && m <= -5
    expect(m5BandLabel(-4.9)).toBe('-5 to +5');
    expect(m5BandLabel(-20)).toBe('M5 <= -20');
    expect(m5BandLabel(null)).toBe('UNAVAILABLE');
    expect(m5BandLabel(undefined)).toBe('UNAVAILABLE');
  });
});

// ── Classification ─────────────────────────────────────────────────────────────────

describe('classifySubgroupWatch', () => {
  it('flags a matching row with the watch label and reason', () => {
    const c = classifySubgroupWatch(matchingRow());
    expect(c.matched).toBe(true);
    expect(c.label).toBe(WATCH_LABEL);
    expect(c.label).toBe('SUBGROUP_WATCH_PAPER_ONLY');
    expect(c.reason).toBe(WATCH_REASON);
    expect(c.reason).toContain('high-conviction paper-only subgroup');
  });

  it('does NOT flag when M5 band is wrong', () => {
    const c = classifySubgroupWatch(matchingRow({ m5Band: '-5 to +5', entryMomentumPct: 0 }));
    expect(c.matched).toBe(false);
    expect(c.m5Match).toBe(false);
    expect(c.label).toBeNull();
  });

  it('does NOT flag when liquidity bucket is wrong', () => {
    const c = classifySubgroupWatch(matchingRow({ liquidityBucket: 'LIQ_30K_100K' }));
    expect(c.matched).toBe(false);
    expect(c.liquidityMatch).toBe(false);
    expect(c.label).toBeNull();
  });

  it('does NOT flag when entry timing is not ENTER_NOW', () => {
    const c = classifySubgroupWatch(matchingRow({ entryTiming: 'WAIT_10M' }));
    expect(c.matched).toBe(false);
    expect(c.entryTimingMatch).toBe(false);
  });

  it('derives m5Band from raw entryMomentumPct when band is absent', () => {
    const c = classifySubgroupWatch(matchingRow({ m5Band: null, entryMomentumPct: -10 }));
    expect(c.m5Band).toBe('-20 to -5');
    expect(c.matched).toBe(true);
  });

  it('derives liquidity bucket from raw liquidityUsd when bucket is absent', () => {
    const c = classifySubgroupWatch(matchingRow({ liquidityBucket: null, liquidityUsd: 20_000 }));
    expect(c.liquidityBucket).toBe('LIQ_10K_30K');
    expect(c.matched).toBe(true);
  });

  it('UNKNOWN cluster can be a watch hit but is never treated as CLEAN', () => {
    const c = classifySubgroupWatch(matchingRow({ clusterRisk: 'UNKNOWN' }));
    expect(c.matched).toBe(true);                 // UNKNOWN cluster is allowed to be watched
    expect(c.clusterRisk).toBe('UNKNOWN');         // preserved verbatim
    expect(c.clusterRisk).not.toBe('CLEAN');       // never reclassified
  });
});

// ── Summary ─────────────────────────────────────────────────────────────────────────

describe('runSubgroupWatch summary', () => {
  it('counts hits and exposes the PAPER_ONLY_WATCH_NOT_BUY safety label', () => {
    const rows: SubgroupWatchRow[] = [
      matchingRow({ contract: 'A', symbol: 'AAA' }),
      matchingRow({ contract: 'B', symbol: 'BBB' }),
      matchingRow({ contract: 'C', m5Band: '-5 to +5' }), // not a hit
      matchingRow({ contract: 'D', liquidityBucket: 'LIQ_GTE_100K' }), // not a hit
    ];
    const s = runSubgroupWatch(rows);
    expect(s.totalRows).toBe(4);
    expect(s.hitCount).toBe(2);
    expect(s.safetyLabel).toBe('PAPER_ONLY_WATCH_NOT_BUY');
    expect(s.safetyLabel).toBe(WATCH_SAFETY_LABEL);
    expect(s.noBuySignal).toBe(true);
  });

  it('caps topHits at 5', () => {
    const rows = Array.from({ length: 8 }, (_, i) => matchingRow({ contract: `C${i}` }));
    const s = runSubgroupWatch(rows);
    expect(s.hitCount).toBe(8);
    expect(s.topHits).toHaveLength(5);
  });

  it('always sets all safety flags', () => {
    const s = runSubgroupWatch([matchingRow()]);
    expect(s.reportOnly).toBe(true);
    expect(s.readOnly).toBe(true);
    expect(s.paperOnly).toBe(true);
    expect(s.realTradingLocked).toBe(true);
    expect(s.tradingExecuted).toBe(0);
    expect(s.noGateChanges).toBe(true);
    expect(s.noBuySignal).toBe(true);
    expect(s.noFakeTradeMutation).toBe(true);
    expect(s.unknownNeverClean).toBe(true);
  });

  it('renders the watch block with the safety label and not-a-buy language', () => {
    const txt = renderSubgroupWatchSummary(runSubgroupWatch([matchingRow()]));
    expect(txt).toContain('SUBGROUP WATCH (PAPER ONLY — NOT A BUY SIGNAL)');
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('SUBGROUP_WATCH_PAPER_ONLY');
    expect(txt).toContain('UNKNOWN≠CLEAN');
  });

  it('rendered output uses only DO_NOT_ forms of real-trading language', () => {
    const txt = renderSubgroupWatchSummary(runSubgroupWatch([matchingRow()]));
    // No affirmative "enable/promote real trading" — only the DO_NOT_ negated forms.
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });
});

// ── Watch does not change buy decisions ─────────────────────────────────────────────

describe('watch is independent of buy decisions', () => {
  it('classifying a row does not produce or imply a buy decision field', () => {
    const c = classifySubgroupWatch(matchingRow());
    // The classification surface has no buy/approve/intent fields — only watch metadata.
    expect(c).not.toHaveProperty('buyGateDecision');
    expect(c).not.toHaveProperty('buyApproved');
    expect(c).not.toHaveProperty('intent');
    expect(Object.keys(c).sort()).toEqual([
      'clusterRisk', 'entryTimingMatch', 'label', 'liquidityBucket',
      'liquidityMatch', 'm5Band', 'm5Match', 'matched', 'reason',
    ]);
  });

  it('a row that is BUY_REJECTED elsewhere can still be a watch hit (and vice-versa)', () => {
    // The watch module never reads a gate field; a "rejected" row still classifies purely on
    // the three subgroup dimensions. Buy approval counts are computed independently.
    const rejectedButMatches = matchingRow({ contract: 'REJECTED_BUT_MATCHES' });
    const c = classifySubgroupWatch(rejectedButMatches);
    expect(c.matched).toBe(true);
    expect(c.label).toBe('SUBGROUP_WATCH_PAPER_ONLY'); // watch hit != buy signal
  });
});

// ── Learning loop integration ───────────────────────────────────────────────────────

describe('learning loop can include subgroupWatchHits without enabling trading', () => {
  it('threads subgroupWatchHits into the loop summary, real trading stays locked', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      intervalMinutes: 10,
      runPaperCycle: async () => ({
        approved: 3, rejected: 5, bmLiveCalls: 1, bmCacheHits: 2, bmSkipped: 0,
      }),
      runSimulation: () => ({ recommendation: 'KEEP_COLLECTING', winRate: 0.44, simulatedTrades: 100 }),
      runSubgroupWatch: () => ({ hitCount: 4 }),
      _sleep: async () => {},
    });

    expect(result.summaries[0]!.subgroupWatchHits).toBe(4);
    // Watch hits do NOT alter the gate counts.
    expect(result.summaries[0]!.approved).toBe(3);
    expect(result.summaries[0]!.rejected).toBe(5);
    // Real trading remains locked regardless of watch hits.
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.paperOnly).toBe(true);

    const txt = renderRipperLearningLoopSummary(result.summaries[0]!);
    expect(txt).toContain('Subgroup watch : 4 hit(s)');
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('subgroupWatchHits is null when no watch step is supplied (backward compatible)', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      runPaperCycle: async () => ({
        approved: 1, rejected: 1, bmLiveCalls: null, bmCacheHits: null, bmSkipped: null,
      }),
      _sleep: async () => {},
    });
    expect(result.summaries[0]!.subgroupWatchHits).toBeNull();
    expect(result.realTradingLocked).toBe(true);
  });

  it('a failing watch step is recorded as a failed step, not a trade', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      runPaperCycle: async () => ({
        approved: 1, rejected: 1, bmLiveCalls: null, bmCacheHits: null, bmSkipped: null,
      }),
      runSubgroupWatch: () => { throw new Error('watch boom'); },
      _sleep: async () => {},
    });
    expect(result.summaries[0]!.failedStep).toBe('subgroup-watch');
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
  });
});
