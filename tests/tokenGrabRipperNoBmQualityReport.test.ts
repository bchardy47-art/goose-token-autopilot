// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runNoBmQualityReport, renderNoBmQualityReport, ripperScoreBand,
} from '../src/token-grab/ripperNoBmQualityReport';
import type { ResearchCohortRow } from '../src/token-grab/ripperWatchCohortFamily';
import type { SimulatedTrade } from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── Factories ──────────────────────────────────────────────────────────────────────

let rc = 0;
function mkRow(o: Partial<ResearchCohortRow> = {}): ResearchCohortRow {
  rc++;
  return {
    schemaVersion: 1, lane: 'NO_BM_RESEARCH', cohortName: 'NO_BM_INTERNAL_RISK_RESEARCH',
    label: 'SUBGROUP_WATCH_PAPER_ONLY', enrolledAt: 't', cycleId: 'c', cycleFile: 'c.jsonl',
    capturedAt: '2026-06-30T08:00:00.000Z', dedupeKey: `k${rc}`, contract: `C${rc}`, symbol: `S${rc}`,
    buyGateDecision: 'BUY_REJECTED', entryTiming: 'ENTER_NOW', entryMomentumPct: -10,
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    launchAgeBucket: 'PRIME_WINDOW', ripperScore: 90, clusterRisk: 'UNKNOWN',
    reason: 'r', safety: 'PAPER_ONLY_WATCH_NOT_BUY',
    bmIgnoredForResearch: true, paperOnly: true, notBuySignal: true, unknownNotClean: true,
    DO_NOT_ENABLE_REAL_TRADING: true, DO_NOT_PROMOTE_TO_REAL_TRADING: true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true, ...o,
  };
}
let tc = 0;
function mkTrade(o: Partial<SimulatedTrade> = {}): SimulatedTrade {
  tc++;
  return {
    intentId: `it${tc}`, symbol: `S${tc}`, contract: `T${tc}`,
    paperEntryTiming: 'ENTER_NOW', reason: '', sourceCycle: 'cycle-x',
    clusterRisk: 'UNKNOWN', ripperScore: 90, launchAgeBucket: 'PRIME_WINDOW',
    entryDecision: 'READY_TO_SNIPE_PAPER', targetEntryAt: '2026-06-30T08:00:00.000Z',
    observedAt: '2026-06-30T08:10:00.000Z', priceChangePct: 0, simulatedPnlPct: 0,
    entryMomentumPct: -10, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5',
    liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', timingPath: 'ENTER_NOW',
    m5Band: '-20 to -5', ...o,
  };
}
/** Build paired research rows + observed trades with the given pnls (contract Wi). */
function paired(pnls: number[], rowOver: (i: number) => Partial<ResearchCohortRow> = () => ({})): { rows: ResearchCohortRow[]; trades: SimulatedTrade[] } {
  const rows: ResearchCohortRow[] = [];
  const trades: SimulatedTrade[] = [];
  pnls.forEach((p, i) => {
    rows.push(mkRow({ contract: `W${i}`, dedupeKey: `wk${i}`, ...rowOver(i) }));
    trades.push(mkTrade({ contract: `W${i}`, simulatedPnlPct: p }));
  });
  return { rows, trades };
}

// ── ripperScoreBand ─────────────────────────────────────────────────────────────────

describe('ripperScoreBand', () => {
  it('bands scores and keeps null as UNKNOWN', () => {
    expect(ripperScoreBand(100)).toBe('SCORE_100');
    expect(ripperScoreBand(95)).toBe('SCORE_90_99');
    expect(ripperScoreBand(85)).toBe('SCORE_80_89');
    expect(ripperScoreBand(70)).toBe('SCORE_60_79');
    expect(ripperScoreBand(null)).toBe('SCORE_UNKNOWN');
  });
});

// ── Breakdowns + metrics ─────────────────────────────────────────────────────────────

describe('quality report breakdowns', () => {
  it('produces all six entry-time dimensions with full metrics', () => {
    const { rows, trades } = paired([5, -3, 0, 8]);
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    const dims = r.breakdowns.map(b => b.dimension);
    expect(dims).toEqual(['m5Band', 'liquidityBucket', 'vlrBucket', 'entryTiming', 'ripperScoreBand', 'clusterRisk']);
    for (const g of r.breakdowns.flatMap(b => b.groups)) {
      for (const k of ['observed', 'pending', 'winRate', 'redLossRate', 'flatRate', 'medianPnl', 'avgPnlCapped', 'worstPnl', 'bestPnl', 'outlierDependence'] as const) {
        expect(typeof g[k]).toBe('number');
      }
    }
  });

  it('overall observed matches the sum across each dimension breakdown', () => {
    const { rows, trades } = paired([5, -3, 0, 8, 2, -1]);
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    for (const b of r.breakdowns) {
      const sumObs = b.groups.reduce((s, g) => s + g.observed, 0);
      expect(sumObs).toBe(r.overall.observed);
    }
  });

  it('self-computed overall matches the family-report research lane (consistency)', () => {
    const { rows, trades } = paired([5, -3, 8, 2]);
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    expect(r.overall.observed).toBe(r.comparison.research.n);
    expect(r.overall.winRate).toBeCloseTo(r.comparison.research.winRate, 10);
    expect(r.overall.avgPnlCapped).toBeCloseTo(r.comparison.research.avgPnlCapped, 10);
    expect(r.overall.medianPnl).toBeCloseTo(r.comparison.research.medianPnl, 10);
  });

  it('marks rows with no matching trade as pending', () => {
    const rows = [mkRow({ contract: 'NOPE', dedupeKey: 'k1' })];
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: [] });
    expect(r.overall.enrolled).toBe(1);
    expect(r.overall.observed).toBe(0);
    expect(r.overall.pending).toBe(1);
  });
});

// ── UNKNOWN never CLEAN ──────────────────────────────────────────────────────────────

describe('UNKNOWN cluster risk', () => {
  it('keeps UNKNOWN as UNKNOWN and never emits CLEAN for UNKNOWN rows', () => {
    const { rows, trades } = paired([5, 5, 5], () => ({ clusterRisk: 'UNKNOWN' }));
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    const cluster = r.breakdowns.find(b => b.dimension === 'clusterRisk')!;
    expect(cluster.groups.map(g => g.key)).toContain('UNKNOWN');
    expect(cluster.groups.map(g => g.key)).not.toContain('CLEAN');
    expect(r.unknownNeverClean).toBe(true);
    expect(JSON.stringify(r)).not.toContain('"CLEAN"');
  });

  it('null clusterRisk maps to UNKNOWN, not CLEAN', () => {
    const { rows, trades } = paired([5], () => ({ clusterRisk: null }));
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    const cluster = r.breakdowns.find(b => b.dimension === 'clusterRisk')!;
    expect(cluster.groups[0]!.key).toBe('UNKNOWN');
  });
});

// ── Entry-time only (never uses P&L to select/predict) ────────────────────────────────

describe('grouping uses entry-time fields only', () => {
  it('a row lands in the same dimension group regardless of its outcome P&L', () => {
    // Same entry-time fields, opposite outcomes → identical group membership.
    const rows = [mkRow({ contract: 'X', dedupeKey: 'x', m5Band: '-20 to -5' })];
    const win = runNoBmQualityReport({ _researchRows: rows, _trades: [mkTrade({ contract: 'X', simulatedPnlPct: 50 })] });
    const loss = runNoBmQualityReport({ _researchRows: rows, _trades: [mkTrade({ contract: 'X', simulatedPnlPct: -50 })] });
    const grpKey = (r: typeof win) => r.breakdowns.find(b => b.dimension === 'm5Band')!.groups.map(g => g.key);
    expect(grpKey(win)).toEqual(grpKey(loss));   // outcome does not move the row between groups
    expect(grpKey(win)).toEqual(['-20 to -5']);
  });
});

// ── Recommendation (conservative, never trading) ──────────────────────────────────────

describe('research verdict', () => {
  it('FORWARD_SAMPLE_TOO_SMALL when observed < minForwardN', () => {
    const { rows, trades } = paired(new Array(30).fill(8));
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    expect(r.overall.observed).toBe(30);
    expect(r.recommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
  });

  it('PAPER_ONLY_RESEARCH_SIGNAL when n>=50 and beats baseline', () => {
    const { rows, trades } = paired(new Array(60).fill(8));  // strong research lane
    // Dilute baseline with weak non-research trades.
    for (let i = 0; i < 200; i++) trades.push(mkTrade({ contract: `B${i}`, simulatedPnlPct: i < 80 ? 1 : -2 }));
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    expect(r.overall.observed).toBe(60);
    expect(r.beatsBaseline).toBe(true);
    expect(r.recommendation).toBe('PAPER_ONLY_RESEARCH_SIGNAL');
  });

  it('KEEP_COLLECTING when n>=50 but does not beat baseline', () => {
    // Research mirrors baseline (no edge).
    const pnls = [...new Array(30).fill(1), ...new Array(30).fill(-2)];
    const { rows, trades } = paired(pnls);
    const r = runNoBmQualityReport({ _researchRows: rows, _trades: trades });
    expect(r.overall.observed).toBe(60);
    expect(r.recommendation).toBe('KEEP_COLLECTING');
  });
});

// ── Safety + rendering ────────────────────────────────────────────────────────────────

describe('safety + render', () => {
  it('sets all safety flags', () => {
    const r = runNoBmQualityReport({ _researchRows: [], _trades: [] });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noBuySignal).toBe(true);
    expect(r.noPaperIntentMutation).toBe(true);
    expect(r.unknownNeverClean).toBe(true);
  });

  it('renders the safety footer and only DO_NOT_ real-trading forms', () => {
    const { rows, trades } = paired([5, -3]);
    const txt = renderNoBmQualityReport(runNoBmQualityReport({ _researchRows: rows, _trades: trades }));
    expect(txt).toContain('PAPER_ONLY=true');
    expect(txt).toContain('realTradingLocked=true');
    expect(txt).toContain('tradingExecuted=0');
    expect(txt).toContain('UNKNOWN_NEVER_CLEAN=true');
    expect(txt).toContain('DO_NOT_TRADE');
    expect(txt).toContain('NEVER to select cohort membership or predict');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });

  it('handles an empty cohort cleanly', () => {
    const r = runNoBmQualityReport({ _researchRows: [], _trades: [] });
    expect(r.overall.enrolled).toBe(0);
    expect(r.overall.observed).toBe(0);
    expect(r.recommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
    expect(() => renderNoBmQualityReport(r)).not.toThrow();
  });
});

// ── Read-only: no file mutation ───────────────────────────────────────────────────────

describe('read-only', () => {
  let dir: string, dataDir: string, cohortPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbq-'));
    dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir);
    cohortPath = path.join(dataDir, 'watch-cohort-no-bm-research.jsonl');
    fs.writeFileSync(cohortPath, [mkRow({ contract: 'A', dedupeKey: 'a' }), mkRow({ contract: 'B', dedupeKey: 'b' })].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the cohort file and mutates nothing', () => {
    const before = fs.readFileSync(cohortPath, 'utf-8');
    const r = runNoBmQualityReport({ dataDir, _trades: [] });
    expect(r.overall.enrolled).toBe(2);
    expect(r.cohortPath).toBe(cohortPath);
    expect(fs.readFileSync(cohortPath, 'utf-8')).toBe(before);
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────

describe('module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/ripperNoBmQualityReport.ts'), 'utf-8');
  it('no token:auto-paper / token:paper-buy / --live', () => {
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
  });
  it('no wallet / signing / swap / private-key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap/i);
  });
  it('no code path relabels UNKNOWN to CLEAN', () => {
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
  });
});
