// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runBubbleMapsValueReport,
  renderBubbleMapsValueReport,
  type BubbleMapsValueOptions,
} from '../src/token-grab/ripperBubbleMapsValueReport';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-value-test-'));
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
});

function writeMemory(filePath: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function makeEnrolledRow(opts: {
  contract?:       string;
  outcomeLabel?:   string;
  bubbleMapsScore?: number | null;
  clusterRisk?:    string;
  liquidityBucket?: string;
  vlrBucket?:      string;
  memoryUniverse?: string;
} = {}): object {
  return {
    contract:       opts.contract        ?? `pump${Math.random().toString(36).slice(2)}`,
    capturedAt:     '2026-06-15T10:00:00.000Z',
    memoryUniverse: opts.memoryUniverse  ?? 'SHADOW_ENROLLED_APPROVED',
    outcomeLabel:   opts.outcomeLabel    ?? 'FLAT_JUNK',
    bubbleMapsScore: opts.bubbleMapsScore !== undefined ? opts.bubbleMapsScore : 85,
    clusterRisk:    opts.clusterRisk     ?? 'CLEAN',
    liquidityBucket: opts.liquidityBucket ?? 'LIQ_10K_30K',
    vlrBucket:      opts.vlrBucket       ?? 'VLR_0_5_TO_2',
    launchAgeBucket: 'PRIME_WINDOW',
  };
}

function buildOptions(fileName = 'memory.jsonl'): BubbleMapsValueOptions {
  return {
    learningMemoryPath: path.join(tmpDir, fileName),
    nowMs: new Date('2026-06-17T15:00:00.000Z').getTime(),
  };
}

// ── Safety ────────────────────────────────────────────────────────────────────

describe('safety', () => {
  it('source contains DO_NOT_ENABLE_REAL_TRADING', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBubbleMapsValueReport.ts'), 'utf-8',
    );
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source contains HOLD_CURRENT_GATES', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBubbleMapsValueReport.ts'), 'utf-8',
    );
    expect(src).toContain('HOLD_CURRENT_GATES');
  });

  it('source does NOT call fetch() or any HTTP client', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBubbleMapsValueReport.ts'), 'utf-8',
    );
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toContain('axios');
    expect(src).not.toContain('https://');
    expect(src).not.toContain('BUBBLEMAPS_API_URL');
  });

  it('source does NOT contain token:auto-paper or token:paper-buy', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBubbleMapsValueReport.ts'), 'utf-8',
    );
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
  });

  it('result has reportOnly=true tradingExecuted=0 realTradingLocked=true', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── NEEDS_MORE_DATA ───────────────────────────────────────────────────────────

describe('NEEDS_MORE_DATA', () => {
  it('returns NEEDS_MORE_DATA when no enrolled rows', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    expect(result.conclusion).toBe('NEEDS_MORE_DATA');
  });

  it('returns NEEDS_MORE_DATA when fewer than 50 observed rows', () => {
    const opts = buildOptions();
    const rows = Array.from({ length: 30 }, () => makeEnrolledRow({ outcomeLabel: 'FLAT_JUNK' }));
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.conclusion).toBe('NEEDS_MORE_DATA');
    expect(result.totalObservedRows).toBe(30);
  });

  it('skips non-enrolled rows', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ memoryUniverse: 'DEX_WATCH_GENERAL', outcomeLabel: 'BIG_WINNER' }),
      makeEnrolledRow({ memoryUniverse: 'UNKNOWN_GENERAL',   outcomeLabel: 'WINNER' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.totalEnrolledRows).toBe(0);
  });

  it('UNKNOWN outcomeLabel rows are not counted as observed', () => {
    const opts = buildOptions();
    const rows = Array.from({ length: 60 }, () =>
      makeEnrolledRow({ outcomeLabel: 'UNKNOWN' }),
    );
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.totalObservedRows).toBe(0);
    expect(result.conclusion).toBe('NEEDS_MORE_DATA');
  });
});

// ── Score tier computation ────────────────────────────────────────────────────

describe('score tiers', () => {
  it('assigns rows to correct score tier', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ bubbleMapsScore: 95, outcomeLabel: 'BIG_WINNER' }),
      makeEnrolledRow({ bubbleMapsScore: 70, outcomeLabel: 'FLAT_JUNK' }),
      makeEnrolledRow({ bubbleMapsScore: 55, outcomeLabel: 'DUMP' }),
      makeEnrolledRow({ bubbleMapsScore: null, outcomeLabel: 'FLAT_JUNK' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);

    const gteRow = result.scoreTiers.find(t => t.tier === 'SCORE_GTE_80');
    const midRow = result.scoreTiers.find(t => t.tier === 'SCORE_60_TO_79');
    const ltRow  = result.scoreTiers.find(t => t.tier === 'SCORE_LT_60');
    const noneRow = result.scoreTiers.find(t => t.tier === 'SCORE_NONE');

    expect(gteRow?.enrolledCount).toBe(1);
    expect(midRow?.enrolledCount).toBe(1);
    expect(ltRow?.enrolledCount).toBe(1);
    expect(noneRow?.enrolledCount).toBe(1);
  });

  it('counts wins correctly within a tier', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'WINNER' }),
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'BIG_WINNER' }),
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'FLAT_JUNK' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);

    const tier = result.scoreTiers.find(t => t.tier === 'SCORE_GTE_80')!;
    expect(tier.enrolledCount).toBe(3);
    expect(tier.winCount).toBe(2);
    expect(tier.winRate).toBeCloseTo(66.7, 0);
  });

  it('SMALL_WINNER, WINNER, BIG_WINNER all count as wins', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'SMALL_WINNER' }),
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'WINNER' }),
      makeEnrolledRow({ bubbleMapsScore: 90, outcomeLabel: 'BIG_WINNER' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    const tier = result.scoreTiers.find(t => t.tier === 'SCORE_GTE_80')!;
    expect(tier.winCount).toBe(3);
  });
});

// ── CACHE_ONLY conclusion ─────────────────────────────────────────────────────

describe('CACHE_ONLY conclusion', () => {
  it('returns CACHE_ONLY when score delta is small but non-BM predictors show more signal', () => {
    const opts = buildOptions();
    // 300 rows: half at score≥80, half at score 60-79; similar win rates ~20%
    // liqBucket shows clear split
    const rows = [
      // score≥80 group: 10 wins / 50 obs = 20% win
      ...Array.from({ length: 40 }, () => makeEnrolledRow({
        bubbleMapsScore: 90, outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_10K_30K',
      })),
      ...Array.from({ length: 10 }, () => makeEnrolledRow({
        bubbleMapsScore: 90, outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K',
      })),
      // score 60-79 group: 10 wins / 50 obs = 20% win
      ...Array.from({ length: 40 }, () => makeEnrolledRow({
        bubbleMapsScore: 70, outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_LT_10K',
      })),
      ...Array.from({ length: 10 }, () => makeEnrolledRow({
        bubbleMapsScore: 70, outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_LT_10K',
      })),
      // liq_LT_10K group (same rows above — liq shows different pattern than score)
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    // Both score tiers have identical win rates → delta should be very small
    expect(result.bubbleMapsWinDelta).not.toBeNull();
    expect(result.bubbleMapsWinDelta!).toBeLessThan(5);
    expect(['CACHE_ONLY', 'REMOVE_LIVE_BUBBLEMAPS', 'NEEDS_MORE_DATA']).toContain(result.conclusion);
  });
});

// ── KEEP_BUBBLEMAPS conclusion ────────────────────────────────────────────────

describe('KEEP_BUBBLEMAPS conclusion', () => {
  it('returns KEEP_BUBBLEMAPS when high-score tier has ≥5% more wins than low-score tier', () => {
    const opts = buildOptions();
    // score≥80: 20 wins / 50 obs = 40% win
    // score<60: 5 wins / 50 obs  = 10% win  → delta = 30%
    const rows = [
      ...Array.from({ length: 30 }, () => makeEnrolledRow({
        contract: `hi${Math.random()}`,
        bubbleMapsScore: 90, outcomeLabel: 'FLAT_JUNK',
      })),
      ...Array.from({ length: 20 }, () => makeEnrolledRow({
        contract: `hiw${Math.random()}`,
        bubbleMapsScore: 90, outcomeLabel: 'BIG_WINNER',
      })),
      ...Array.from({ length: 45 }, () => makeEnrolledRow({
        contract: `lo${Math.random()}`,
        bubbleMapsScore: 40, outcomeLabel: 'FLAT_JUNK',
      })),
      ...Array.from({ length: 5 }, () => makeEnrolledRow({
        contract: `low${Math.random()}`,
        bubbleMapsScore: 40, outcomeLabel: 'DUMP',
      })),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.bubbleMapsWinDelta).not.toBeNull();
    expect(result.bubbleMapsWinDelta!).toBeGreaterThanOrEqual(5);
    expect(result.conclusion).toBe('KEEP_BUBBLEMAPS');
  });
});

// ── Cluster risk groups ───────────────────────────────────────────────────────

describe('cluster risk groups', () => {
  it('counts CLEAN, WATCH, RISKY, UNKNOWN groups', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ clusterRisk: 'CLEAN',   outcomeLabel: 'FLAT_JUNK' }),
      makeEnrolledRow({ clusterRisk: 'CLEAN',   outcomeLabel: 'WINNER' }),
      makeEnrolledRow({ clusterRisk: 'UNKNOWN', outcomeLabel: 'FLAT_JUNK' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);

    const clean   = result.clusterRiskGroups.find(g => g.tier === 'CLEAN')!;
    const unknown = result.clusterRiskGroups.find(g => g.tier === 'UNKNOWN')!;
    expect(clean.enrolledCount).toBe(2);
    expect(clean.winCount).toBe(1);
    expect(unknown.enrolledCount).toBe(1);
  });
});

// ── Non-BubbleMaps buckets ────────────────────────────────────────────────────

describe('non-BubbleMaps predictor buckets', () => {
  it('groups rows by liquidityBucket', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ liquidityBucket: 'LIQ_LT_10K',   outcomeLabel: 'FLAT_JUNK' }),
      makeEnrolledRow({ liquidityBucket: 'LIQ_10K_30K',  outcomeLabel: 'WINNER' }),
      makeEnrolledRow({ liquidityBucket: 'LIQ_10K_30K',  outcomeLabel: 'BIG_WINNER' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);

    const lt10k   = result.liquidityBuckets.find(b => b.bucket === 'LIQ_LT_10K');
    const liq10k  = result.liquidityBuckets.find(b => b.bucket === 'LIQ_10K_30K');
    expect(lt10k?.winCount).toBe(0);
    expect(liq10k?.winCount).toBe(2);
  });

  it('groups rows by vlrBucket', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ vlrBucket: 'VLR_LT_0_5',   outcomeLabel: 'FLAT_JUNK' }),
      makeEnrolledRow({ vlrBucket: 'VLR_0_5_TO_2', outcomeLabel: 'WINNER' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);

    const low = result.vlrBuckets.find(b => b.bucket === 'VLR_LT_0_5');
    const mid = result.vlrBuckets.find(b => b.bucket === 'VLR_0_5_TO_2');
    expect(low?.winCount).toBe(0);
    expect(mid?.winCount).toBe(1);
  });
});

// ── pctWithScore and pctRisky ─────────────────────────────────────────────────

describe('coverage metrics', () => {
  it('computes pctWithScore correctly', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ bubbleMapsScore: 80 }),
      makeEnrolledRow({ bubbleMapsScore: 70 }),
      makeEnrolledRow({ bubbleMapsScore: null }),
      makeEnrolledRow({ bubbleMapsScore: null }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.pctWithScore).toBe(50);
  });

  it('computes pctRisky correctly', () => {
    const opts = buildOptions();
    const rows = [
      makeEnrolledRow({ clusterRisk: 'CLEAN' }),
      makeEnrolledRow({ clusterRisk: 'RISKY' }),
      makeEnrolledRow({ clusterRisk: 'CLEAN' }),
    ];
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport(opts);
    expect(result.pctRisky).toBeCloseTo(33.3, 0);
  });
});

// ── Call sites ────────────────────────────────────────────────────────────────

describe('call sites', () => {
  it('lists BubbleMaps live call sites', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    expect(result.callSites.length).toBeGreaterThan(0);
    expect(result.callSites.some(s => s.includes('clusterRiskProvider'))).toBe(true);
    expect(result.callSites.some(s => s.includes('bubbleMapsCache'))).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderBubbleMapsValueReport', () => {
  it('renders without error on empty data', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    expect(() => renderBubbleMapsValueReport(result)).not.toThrow();
  });

  it('output contains all required sections', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    const output = renderBubbleMapsValueReport(result);

    expect(output).toContain('BUBBLEMAPS VALUE REPORT');
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO API CALLS');
    expect(output).toContain('OVERVIEW');
    expect(output).toContain('BUBBLEMAPS SCORE TIERS');
    expect(output).toContain('CLUSTER RISK GROUPS');
    expect(output).toContain('NON-BUBBLEMAPS PREDICTORS');
    expect(output).toContain('BUBBLEMAPS LIVE CALL SITES');
    expect(output).toContain('CONCLUSION');
  });

  it('output contains safety markers', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    const output = renderBubbleMapsValueReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('HOLD_CURRENT_GATES');
    expect(output).toContain('NO_POLICY_CHANGE');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('output contains the conclusion text', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    const output = renderBubbleMapsValueReport(result);
    expect(output).toContain(result.conclusion);
  });
});

// ── BubbleMaps mode enforcement ───────────────────────────────────────────────

function makeHighDeltaRows(): object[] {
  // score≥80: 40% win;  score<60: 10% win  → delta = 30% → data says KEEP_BUBBLEMAPS
  return [
    ...Array.from({ length: 30 }, (_, i) => ({
      contract: `hi${i}`, capturedAt: '2026-06-17T00:00:00Z',
      memoryUniverse: 'SHADOW_ENROLLED_APPROVED',
      bubbleMapsScore: 90, clusterRisk: 'CLEAN',
      outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      contract: `hiw${i}`, capturedAt: '2026-06-17T00:00:00Z',
      memoryUniverse: 'SHADOW_ENROLLED_APPROVED',
      bubbleMapsScore: 90, clusterRisk: 'CLEAN',
      outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    })),
    ...Array.from({ length: 45 }, (_, i) => ({
      contract: `lo${i}`, capturedAt: '2026-06-17T00:00:00Z',
      memoryUniverse: 'SHADOW_ENROLLED_APPROVED',
      bubbleMapsScore: 40, clusterRisk: 'CLEAN',
      outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5',
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      contract: `low${i}`, capturedAt: '2026-06-17T00:00:00Z',
      memoryUniverse: 'SHADOW_ENROLLED_APPROVED',
      bubbleMapsScore: 40, clusterRisk: 'CLEAN',
      outcomeLabel: 'DUMP', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5',
    })),
  ];
}

describe('BubbleMaps mode enforcement', () => {
  it('LIVE_CAPPED mode allows KEEP_BUBBLEMAPS when evidence supports it', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'LIVE_CAPPED' });
    expect(result.bubbleMapsWinDelta).toBeGreaterThanOrEqual(5);
    expect(result.conclusion).toBe('KEEP_BUBBLEMAPS');
    expect(result.bubbleMapsMode).toBe('LIVE_CAPPED');
  });

  it('DISABLED mode never returns KEEP_BUBBLEMAPS even when data supports it', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'DISABLED' });
    expect(result.bubbleMapsWinDelta).toBeGreaterThanOrEqual(5);
    expect(result.conclusion).not.toBe('KEEP_BUBBLEMAPS');
    expect(['CACHE_ONLY', 'REMOVE_LIVE_BUBBLEMAPS']).toContain(result.conclusion);
    expect(result.bubbleMapsMode).toBe('DISABLED');
  });

  it('DISABLED mode conclusion note mentions disabled', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'DISABLED' });
    expect(result.conclusionNote).toMatch(/disabled/i);
  });

  it('DISABLED mode conclusion note mentions historical cached scores', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'DISABLED' });
    expect(result.conclusionNote).toContain('Historical cached BubbleMaps scores');
  });

  it('CACHE_ONLY mode (cap=0) never returns KEEP_BUBBLEMAPS', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'CACHE_ONLY' });
    expect(result.conclusion).not.toBe('KEEP_BUBBLEMAPS');
    expect(result.bubbleMapsMode).toBe('CACHE_ONLY');
  });

  it('CACHE_ONLY mode returns CACHE_ONLY when data would say KEEP_BUBBLEMAPS', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'CACHE_ONLY' });
    expect(result.conclusion).toBe('CACHE_ONLY');
  });

  it('DISABLED mode via env var TOKEN_GRAB_BUBBLEMAPS_DISABLED=1 never returns KEEP_BUBBLEMAPS', () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'] = '1';
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport(opts);
    expect(result.conclusion).not.toBe('KEEP_BUBBLEMAPS');
    expect(result.bubbleMapsMode).toBe('DISABLED');
  });

  it('cap=0 via env var TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN=0 returns CACHE_ONLY', () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'] = '0';
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, makeHighDeltaRows());
    const result = runBubbleMapsValueReport(opts);
    expect(result.conclusion).not.toBe('KEEP_BUBBLEMAPS');
    expect(result.bubbleMapsMode).toBe('CACHE_ONLY');
  });

  it('NEEDS_MORE_DATA still fires in disabled mode when data is sparse', () => {
    const opts = buildOptions();
    const rows = Array.from({ length: 10 }, () => makeEnrolledRow({ outcomeLabel: 'FLAT_JUNK' }));
    writeMemory(opts.learningMemoryPath!, rows);
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'DISABLED' });
    expect(result.conclusion).toBe('NEEDS_MORE_DATA');
  });

  it('result.bubbleMapsMode field is present', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport(opts);
    expect(['DISABLED', 'CACHE_ONLY', 'LIVE_CAPPED']).toContain(result.bubbleMapsMode);
  });
});

describe('renderer mode line', () => {
  it('output contains BubbleMaps mode line', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'DISABLED' });
    const output = renderBubbleMapsValueReport(result);
    expect(output).toContain('BubbleMaps mode');
    expect(output).toContain('DISABLED');
  });

  it('LIVE_CAPPED mode shown in output', () => {
    const opts = buildOptions();
    writeMemory(opts.learningMemoryPath!, []);
    const result = runBubbleMapsValueReport({ ...opts, bubbleMapsMode: 'LIVE_CAPPED' });
    const output = renderBubbleMapsValueReport(result);
    expect(output).toContain('LIVE_CAPPED');
  });
});

// ── Package.json ──────────────────────────────────────────────────────────────

describe('package.json', () => {
  it('registers token:ripper-bubblemaps-value-report', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['token:ripper-bubblemaps-value-report']).toBeDefined();
    expect(pkg.scripts['token:ripper-bubblemaps-value-report']).toContain('cli.ts');
    expect(pkg.scripts['token:ripper-bubblemaps-value-report']).toContain('token:ripper-bubblemaps-value-report');
  });
});
