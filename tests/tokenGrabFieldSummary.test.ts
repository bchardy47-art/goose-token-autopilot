import { describe, expect, it } from 'vitest';
import {
  parseSessionTimestamp,
  classifyRejectionPattern,
  aggregateFieldRuns,
  deriveRecommendation,
  buildFieldRunSummary,
  renderFieldRunSummary,
  loadFieldRunRow,
  type FieldRunRow,
  type FieldRunAggregate,
  type FieldRunSummary,
} from '../src/token-grab/fieldSummary';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<FieldRunRow> = {}): FieldRunRow {
  return {
    ts: '20260607-0100',
    hasPlan: false,
    paperExitGuardRan: false,
    ...overrides,
  };
}

function makeAggregate(overrides: Partial<FieldRunAggregate> = {}): FieldRunAggregate {
  return {
    totalRuns: 0,
    rejectedCount: 0,
    planOnlyCount: 0,
    missingConfirmationCount: 0,
    rejectedPriceWeakCount: 0,
    rejectedLiquidityLowCount: 0,
    rejectedLiquidityWeakCount: 0,
    rejectedDrawdownCount: 0,
    paperExitGuardRuns: 0,
    exitReasonCounts: {},
    winnersCount: 0,
    losersCount: 0,
    flatCount: 0,
    rejectionPatternCounts: {
      FLAT_NO_MOMENTUM: 0,
      LIQUIDITY_DRAIN_CHURN: 0,
      LOW_LIQUIDITY: 0,
      WEAK_MOMENTUM: 0,
      MISSING_CONFIRMATION: 0,
      OTHER: 0,
    },
    ...overrides,
  };
}

function makeSummary(overrides: Partial<FieldRunSummary> = {}): FieldRunSummary {
  return {
    directory: 'data/token-grab/live-harness',
    runCount: 0,
    tsRange: null,
    generatedAt: '2026-06-07T03:00:00.000Z',
    readOnly: true,
    tradingExecuted: 0,
    rows: [],
    aggregate: makeAggregate(),
    recommendation: 'No confirmed entries in this batch. Do not loosen thresholds from this alone; collect later-window data or expand sources.',
    ...overrides,
  };
}

/** Write a temp dir with fixture files for a given session timestamp. */
function makeTempDir(fixtures: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-summary-test-'));
  for (const [name, data] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data), 'utf-8');
  }
  return dir;
}

// ── Test 1: Parses session timestamp from filename ────────────────────────────

describe('parseSessionTimestamp', () => {
  it('parses a valid session filename', () => {
    expect(parseSessionTimestamp('session-20260607-0148.json')).toBe('20260607-0148');
  });

  it('returns null for an entry filename', () => {
    expect(parseSessionTimestamp('session-20260607-0148-entry.json')).toBeNull();
  });

  it('returns null for a confirm filename', () => {
    expect(parseSessionTimestamp('session-20260607-0148-confirm.json')).toBeNull();
  });

  it('returns null for a plan filename', () => {
    expect(parseSessionTimestamp('plan-20260607-0148.json')).toBeNull();
  });

  it('returns null for an exit filename', () => {
    expect(parseSessionTimestamp('session-20260607-0148-exit.json')).toBeNull();
  });

  it('returns null for an unrelated filename', () => {
    expect(parseSessionTimestamp('README.md')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSessionTimestamp('')).toBeNull();
  });
});

// ── Test 2: Handles missing confirm/plan/exit files ───────────────────────────

describe('loadFieldRunRow — tolerant of missing files', () => {
  it('returns a valid row when all files are missing', () => {
    const dir = makeTempDir({});
    try {
      const row = loadFieldRunRow(dir, '20260607-0100');
      expect(row.ts).toBe('20260607-0100');
      expect(row.hasPlan).toBe(false);
      expect(row.paperExitGuardRan).toBe(false);
      expect(row.priceChangePct).toBeUndefined();
      expect(row.verdict).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns hasPlan false when plan file is missing', () => {
    const dir = makeTempDir({
      'session-20260607-0100.json': { schema: 'token-grab-session-v1', candidates: [], summary: {} },
      'session-20260607-0100-entry.json': [{ candidateId: 'c1', priceUsd: 0.001, liquidityUsd: 5000, volumeUsd: 3000 }],
      'session-20260607-0100-confirm.json': [{ candidateId: 'c1', priceUsd: 0.0013, liquidityUsd: 5500, volumeUsd: 3200 }],
    });
    try {
      const row = loadFieldRunRow(dir, '20260607-0100');
      expect(row.hasPlan).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns fakePnLPct undefined when exit file is missing', () => {
    const dir = makeTempDir({
      'session-20260607-0100.json': { schema: 'token-grab-session-v1', candidates: [], summary: {} },
      'plan-20260607-0100.json': { status: 'PLAN_ONLY', entryPrice: 0.001, ticker: 'TEST' },
    });
    try {
      const row = loadFieldRunRow(dir, '20260607-0100');
      expect(row.hasPlan).toBe(true);
      expect(row.fakePnLPct).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns REJECTED_MISSING_SNAPSHOT verdict when confirm file is present but has no price', () => {
    const dir = makeTempDir({
      'session-20260607-0100-entry.json': [{ candidateId: 'c1', priceUsd: 0.001, liquidityUsd: 5000 }],
      'session-20260607-0100-confirm.json': [{ candidateId: 'c1' }],
    });
    try {
      const row = loadFieldRunRow(dir, '20260607-0100');
      expect(row.verdict).toBe('REJECTED_MISSING_SNAPSHOT');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ── Test 3: Counts PLAN_ONLY from plan file presence ─────────────────────────

describe('loadFieldRunRow — PLAN_ONLY detection', () => {
  it('hasPlan is true when plan file with PLAN_ONLY status exists', () => {
    const dir = makeTempDir({
      'plan-20260607-0200.json': {
        status: 'PLAN_ONLY',
        entryPrice: 0.001,
        ticker: 'WORLDS',
        tokenName: 'WORLDS',
      },
    });
    try {
      const row = loadFieldRunRow(dir, '20260607-0200');
      expect(row.hasPlan).toBe(true);
      expect(row.tokenSelected).toBe('WORLDS');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('aggregateFieldRuns counts planOnlyCount correctly', () => {
    const rows = [
      makeRow({ hasPlan: true }),
      makeRow({ hasPlan: false }),
      makeRow({ hasPlan: true }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.planOnlyCount).toBe(2);
    expect(agg.rejectedCount).toBe(1);
    expect(agg.totalRuns).toBe(3);
  });
});

// ── Test 4: Counts rejection verdicts ─────────────────────────────────────────

describe('aggregateFieldRuns — rejection verdict counts', () => {
  it('counts REJECTED_PRICE_WEAK', () => {
    const rows = [
      makeRow({ verdict: 'REJECTED_PRICE_WEAK' }),
      makeRow({ verdict: 'REJECTED_PRICE_WEAK' }),
      makeRow({ verdict: 'CONFIRMED', hasPlan: true }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.rejectedPriceWeakCount).toBe(2);
  });

  it('counts REJECTED_CONFIRMED_LIQUIDITY_LOW', () => {
    const rows = [
      makeRow({ verdict: 'REJECTED_CONFIRMED_LIQUIDITY_LOW' }),
      makeRow({ verdict: 'REJECTED_CONFIRMED_LIQUIDITY_LOW' }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.rejectedLiquidityLowCount).toBe(2);
  });

  it('counts REJECTED_LIQUIDITY_FADE and REJECTED_CONFIRMED_LIQUIDITY_WEAK together', () => {
    const rows = [
      makeRow({ verdict: 'REJECTED_LIQUIDITY_FADE' }),
      makeRow({ verdict: 'REJECTED_CONFIRMED_LIQUIDITY_WEAK' }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.rejectedLiquidityWeakCount).toBe(2);
  });

  it('counts REJECTED_MISSING_SNAPSHOT in missingConfirmationCount', () => {
    const rows = [
      makeRow({ verdict: 'REJECTED_MISSING_SNAPSHOT' }),
      makeRow({ verdict: undefined }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.missingConfirmationCount).toBe(2);
  });

  it('counts winners, losers, and flat from fakePnLPct', () => {
    const rows = [
      makeRow({ fakePnLPct: 25.5 }),
      makeRow({ fakePnLPct: -30.1 }),
      makeRow({ fakePnLPct: 0.5 }),
      makeRow({ fakePnLPct: -52 }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.winnersCount).toBe(1);
    expect(agg.losersCount).toBe(2);
    expect(agg.flatCount).toBe(1);
  });
});

// ── Test 5: Detects FLAT_NO_MOMENTUM ─────────────────────────────────────────

describe('classifyRejectionPattern — FLAT_NO_MOMENTUM', () => {
  it('classifies 0% price and 0% liquidity as FLAT_NO_MOMENTUM', () => {
    const result = classifyRejectionPattern('REJECTED_PRICE_WEAK', 0, 0, 3000, undefined, undefined);
    expect(result).toBe('FLAT_NO_MOMENTUM');
  });

  it('classifies near-zero price change as FLAT_NO_MOMENTUM', () => {
    const result = classifyRejectionPattern('REJECTED_PRICE_WEAK', 0.5, 0.8, 3000, undefined, undefined);
    expect(result).toBe('FLAT_NO_MOMENTUM');
  });

  it('does not classify positive price momentum as FLAT_NO_MOMENTUM', () => {
    const result = classifyRejectionPattern('REJECTED_PRICE_WEAK', 12, 5, 3000, undefined, undefined);
    expect(result).not.toBe('FLAT_NO_MOMENTUM');
  });
});

// ── Test 6: Detects LIQUIDITY_DRAIN_CHURN ─────────────────────────────────────

describe('classifyRejectionPattern — LIQUIDITY_DRAIN_CHURN', () => {
  it('classifies liquidity <= -25% with rising vol/liq ratio as LIQUIDITY_DRAIN_CHURN', () => {
    const result = classifyRejectionPattern(
      'REJECTED_LIQUIDITY_FADE',
      5,
      -30,
      3500, // above 2500 threshold so LOW_LIQUIDITY doesn't fire first
      1.2,  // entry VLR
      2.5,  // confirm VLR — higher, more churn
    );
    expect(result).toBe('LIQUIDITY_DRAIN_CHURN');
  });

  it('does not classify as LIQUIDITY_DRAIN_CHURN when liquidity drop is mild', () => {
    const result = classifyRejectionPattern('REJECTED_CONFIRMED_LIQUIDITY_WEAK', 5, -10, 3000, 1.2, 1.5);
    expect(result).not.toBe('LIQUIDITY_DRAIN_CHURN');
  });

  it('does not classify as LIQUIDITY_DRAIN_CHURN when vol/liq ratio does not increase', () => {
    const result = classifyRejectionPattern('REJECTED_LIQUIDITY_FADE', 5, -30, 2000, 2.0, 1.5);
    expect(result).not.toBe('LIQUIDITY_DRAIN_CHURN');
  });
});

// ── Test 7: Detects LOW_LIQUIDITY ─────────────────────────────────────────────

describe('classifyRejectionPattern — LOW_LIQUIDITY', () => {
  it('classifies confirmedLiquidityUsd < 2500 as LOW_LIQUIDITY', () => {
    const result = classifyRejectionPattern('REJECTED_CONFIRMED_LIQUIDITY_LOW', 15, 5, 1200, undefined, undefined);
    expect(result).toBe('LOW_LIQUIDITY');
  });

  it('does not classify as LOW_LIQUIDITY when liq >= 2500', () => {
    const result = classifyRejectionPattern('REJECTED_PRICE_WEAK', 8, 5, 3000, undefined, undefined);
    expect(result).not.toBe('LOW_LIQUIDITY');
  });

  it('does not classify MISSING_CONFIRMATION as LOW_LIQUIDITY', () => {
    const result = classifyRejectionPattern('REJECTED_MISSING_SNAPSHOT', undefined, undefined, undefined, undefined, undefined);
    expect(result).toBe('MISSING_CONFIRMATION');
  });
});

// ── Test 8: Produces aggregate counts ────────────────────────────────────────

describe('aggregateFieldRuns — full aggregate', () => {
  it('produces zero aggregate for empty rows', () => {
    const agg = aggregateFieldRuns([]);
    expect(agg.totalRuns).toBe(0);
    expect(agg.planOnlyCount).toBe(0);
    expect(agg.rejectedCount).toBe(0);
  });

  it('counts paperExitGuardRuns correctly', () => {
    const rows = [
      makeRow({ hasPlan: true, paperExitGuardRan: true, exitReason: 'HARD_STOP' }),
      makeRow({ hasPlan: true, paperExitGuardRan: true, exitReason: 'MAX_HOLD' }),
      makeRow({ hasPlan: false, paperExitGuardRan: false }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.paperExitGuardRuns).toBe(2);
    expect(agg.exitReasonCounts['HARD_STOP']).toBe(1);
    expect(agg.exitReasonCounts['MAX_HOLD']).toBe(1);
  });

  it('counts rejection patterns in rejectionPatternCounts', () => {
    const rows = [
      makeRow({ rejectionPattern: 'FLAT_NO_MOMENTUM' }),
      makeRow({ rejectionPattern: 'FLAT_NO_MOMENTUM' }),
      makeRow({ rejectionPattern: 'LOW_LIQUIDITY' }),
      makeRow({ hasPlan: true }),
    ];
    const agg = aggregateFieldRuns(rows);
    expect(agg.rejectionPatternCounts.FLAT_NO_MOMENTUM).toBe(2);
    expect(agg.rejectionPatternCounts.LOW_LIQUIDITY).toBe(1);
  });
});

// ── Test 9: JSON output shape includes readOnly true and tradingExecuted 0 ────

describe('buildFieldRunSummary / FieldRunSummary JSON shape', () => {
  it('summary has readOnly: true and tradingExecuted: 0', () => {
    const dir = makeTempDir({});
    try {
      const summary = buildFieldRunSummary({ dir, limit: 10, generatedAt: '2026-06-07T00:00:00Z' });
      expect(summary.readOnly).toBe(true);
      expect(summary.tradingExecuted).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('JSON serialization preserves readOnly and tradingExecuted', () => {
    const summary = makeSummary();
    const json = JSON.parse(JSON.stringify(summary));
    expect(json.readOnly).toBe(true);
    expect(json.tradingExecuted).toBe(0);
  });

  it('buildFieldRunSummary returns empty rows for empty dir', () => {
    const dir = makeTempDir({});
    try {
      const summary = buildFieldRunSummary({ dir, limit: 20, generatedAt: '2026-06-07T00:00:00Z' });
      expect(summary.rows).toHaveLength(0);
      expect(summary.runCount).toBe(0);
      expect(summary.tsRange).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('buildFieldRunSummary respects --limit', () => {
    const fixtures: Record<string, unknown> = {};
    for (let i = 1; i <= 5; i++) {
      const ts = `202606070${String(i).padStart(2, '0')}00`;
      fixtures[`session-${ts}.json`] = { schema: 'token-grab-session-v1', candidates: [], summary: {} };
    }
    const dir = makeTempDir(fixtures);
    try {
      const summary = buildFieldRunSummary({ dir, limit: 3, generatedAt: '2026-06-07T00:00:00Z' });
      expect(summary.rows.length).toBeLessThanOrEqual(3);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('buildFieldRunSummary respects --since filter', () => {
    const dir = makeTempDir({
      'session-20260606-1000.json': { schema: 'token-grab-session-v1', candidates: [], summary: {} },
      'session-20260607-0100.json': { schema: 'token-grab-session-v1', candidates: [], summary: {} },
      'session-20260607-0200.json': { schema: 'token-grab-session-v1', candidates: [], summary: {} },
    });
    try {
      const summary = buildFieldRunSummary({
        dir,
        limit: 20,
        since: '20260607-0000',
        generatedAt: '2026-06-07T00:00:00Z',
      });
      expect(summary.rows.every((r) => r.ts >= '20260607-0000')).toBe(true);
      expect(summary.rows.length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ── Test 10: Text report includes recommendation ───────────────────────────────

describe('renderFieldRunSummary — recommendation text', () => {
  it('recommendation present in rendered text when planOnlyCount is 0', () => {
    const summary = makeSummary();
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('No confirmed entries in this batch');
  });

  it('recommendation is losses-focused when losers > winners', () => {
    const agg = makeAggregate({ planOnlyCount: 3, winnersCount: 1, losersCount: 3 });
    const rec = deriveRecommendation(agg);
    expect(rec).toContain('Review exit guard');
  });

  it('recommendation is continue dry-run when winners >= losers and plan exists', () => {
    const agg = makeAggregate({ planOnlyCount: 2, winnersCount: 2, losersCount: 0 });
    const rec = deriveRecommendation(agg);
    expect(rec).toContain('Continue dry-run evidence collection');
  });

  it('rendered report contains Recommendation section header', () => {
    const summary = makeSummary();
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('Recommendation');
  });

  it('rendered report contains Run Table section', () => {
    const summary = makeSummary({ rows: [makeRow({ ts: '20260607-0100', verdict: 'REJECTED_PRICE_WEAK' })] });
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('Run Table');
  });

  it('rendered report contains Aggregate Counts section', () => {
    const summary = makeSummary();
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('Aggregate Counts');
  });

  it('rendered report contains Rejection Patterns section', () => {
    const summary = makeSummary();
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('Rejection Patterns');
  });
});

// ── Test 11: No LIVE_EXECUTED ─────────────────────────────────────────────────

describe('fieldSummary — no LIVE_EXECUTED', () => {
  it('renderFieldRunSummary output never contains LIVE_EXECUTED', () => {
    const summary = makeSummary({
      rows: [makeRow({ hasPlan: true, paperExitGuardRan: true, exitReason: 'MAX_HOLD' })],
    });
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('FieldRunSummary JSON serialization never contains LIVE_EXECUTED', () => {
    const summary = makeSummary();
    const json = JSON.stringify(summary);
    expect(json).not.toMatch(/LIVE_EXECUTED/);
  });

  it('aggregate exitReasonCounts does not contain LIVE_EXECUTED', () => {
    const rows = [makeRow({ exitReason: 'MAX_HOLD' }), makeRow({ exitReason: 'HARD_STOP' })];
    const agg = aggregateFieldRuns(rows);
    expect('LIVE_EXECUTED' in agg.exitReasonCounts).toBe(false);
  });
});

// ── Test 12: No wallet/private key/swap/signing ────────────────────────────────

describe('fieldSummary — no wallet/private key/swap/signing', () => {
  it('renderFieldRunSummary output contains no signing/swap/key patterns', () => {
    const summary = makeSummary({ rows: [makeRow({ hasPlan: true, exitReason: 'TAKE_PROFIT', fakePnLPct: 55 })] });
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('renderFieldRunSummary contains READ-ONLY and tradingExecuted: 0 safety text', () => {
    const summary = makeSummary();
    const rendered = renderFieldRunSummary(summary);
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('FieldRunSummary has noRealTrade sentinel fields', () => {
    const summary = makeSummary();
    expect(summary.readOnly).toBe(true);
    expect(summary.tradingExecuted).toBe(0);
  });
});
