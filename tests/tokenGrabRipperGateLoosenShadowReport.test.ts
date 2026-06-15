import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperGateLoosenShadowReport,
  renderRipperGateLoosenShadowReport,
} from '../src/token-grab/ripperGateLoosenShadowReport';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rglsr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeFixture(opts: {
  contract?:        string;
  capturedAt?:      string;
  pct?:             number | null;
  symbol?:          string;
  ripperScore?:     number;
  entryDecision?:   string;
  buyGateDecision?: string;
  launchAgeBucket?: string;
  clusterRisk?:     string;
  blockers?:        string[];
  warnings?:        string[];
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.pct    != null) sig['priceChangePct'] = opts.pct;
  if (opts.symbol != null) sig['symbol']         = opts.symbol;
  const raw: Record<string, unknown> = {};
  if (opts.clusterRisk != null) raw['clusterRisk'] = opts.clusterRisk;
  return {
    id:                `f-${Math.random()}`,
    capturedAt:        opts.capturedAt      ?? '2025-01-01T00:00:00.000Z',
    source:            'test',
    sourceKind:        'test',
    normalizedSignal:  sig,
    ripperInput:       null,
    ripperScore:       opts.ripperScore,
    entryDecision:     opts.entryDecision,
    buyGateDecision:   opts.buyGateDecision ?? 'BUY_REJECTED',
    launchAgeBucket:   opts.launchAgeBucket,
    blockers:          opts.blockers         ?? [],
    topReasons:        [],
    warnings:          opts.warnings         ?? [],
    raw,
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

const T0   = '2025-01-01T00:00:00.000Z';
const T0MS = Date.parse(T0);
function at(ms: number): string { return new Date(T0MS + ms).toISOString(); }

// Fixture that passes LOOSE_60_WATCH
function loose60(contract: string, capturedAt = T0, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({
    contract, capturedAt,
    ripperScore:     65,
    entryDecision:   'WATCH',
    launchAgeBucket: 'PRIME_WINDOW',
    clusterRisk:     'CLEAN',
    ...extra,
  });
}

// Fixture that passes AGGRESSIVE_55_WATCH
function agg55(contract: string, capturedAt = T0, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({
    contract, capturedAt,
    ripperScore:     57,
    entryDecision:   'WATCH',
    launchAgeBucket: 'LATE',
    clusterRisk:     'CLEAN',
    ...extra,
  });
}

// Observation fixture (price update)
function obs(contract: string, capturedAt: string, pct: number): object {
  return makeFixture({ contract, capturedAt, pct });
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('has all required safety fields', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('has generatedAt', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    expect(typeof r.generatedAt).toBe('string');
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns zero counts for all policies', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    expect(r.current.totalCandidates).toBe(0);
    expect(r.loose60.totalCandidates).toBe(0);
    expect(r.aggressive55.totalCandidates).toBe(0);
  });

  it('handles missing files gracefully', () => {
    const r = runRipperGateLoosenShadowReport({
      approvalPaths:    ['/no/such/cycle.jsonl'],
      observationPaths: ['/no/such/obs.jsonl'],
    });
    expect(r.current.totalCandidates).toBe(0);
  });
});

// ── CURRENT_APPROVAL policy ───────────────────────────────────────────────────

describe('CURRENT_APPROVAL policy', () => {
  it('counts BUY_APPROVED_PAPER fixtures', () => {
    const p = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'BBBB', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'CCCC', buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [p], observationPaths: [] });
    expect(r.current.totalCandidates).toBe(2);
  });

  it('deduplicates by contract key (first seen wins)', () => {
    const p = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', capturedAt: T0,          buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'AAAA', capturedAt: at(60_000),  buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [p], observationPaths: [] });
    expect(r.current.totalCandidates).toBe(1);
  });

  it('overlap with current is totalCandidates for current policy itself', () => {
    const p = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [p], observationPaths: [] });
    expect(r.current.overlapWithCurrent).toBe(1);
    expect(r.current.extraBeyondCurrent).toBe(0);
  });
});

// ── LOOSE_60_WATCH policy ─────────────────────────────────────────────────────

describe('LOOSE_60_WATCH policy', () => {
  it('passes fixture with score>=60, WATCH entry, PRIME_WINDOW launch, CLEAN cluster', () => {
    const p = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(1);
  });

  it('passes TOO_EARLY launch age bucket', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { launchAgeBucket: 'TOO_EARLY' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(1);
  });

  it('rejects score < 60', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { ripperScore: 59 }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('rejects LATE launch age bucket (not allowed in loose60)', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { launchAgeBucket: 'LATE' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('rejects non-WATCH/READY_TO_SNIPE_PAPER entryDecision', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { entryDecision: 'TOO_EARLY' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('passes READY_TO_SNIPE_PAPER entryDecision', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { entryDecision: 'READY_TO_SNIPE_PAPER' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(1);
  });

  it('rejects RISKY cluster risk', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { clusterRisk: 'RISKY' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('passes WATCH cluster risk', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { clusterRisk: 'WATCH' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(1);
  });

  it('rejects when blockers contain danger term', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { blockers: ['honeypot detected on chain'] }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('rejects when warnings contain danger term', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { warnings: ['possible rug pattern'] }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });

  it('rejects blacklist in blockers', () => {
    const p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0, { blockers: ['address on blacklist'] }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.loose60.totalCandidates).toBe(0);
  });
});

// ── AGGRESSIVE_55_WATCH policy ────────────────────────────────────────────────

describe('AGGRESSIVE_55_WATCH policy', () => {
  it('passes LATE launch age bucket (allowed in aggressive)', () => {
    const p = writeJsonl('obs.jsonl', [agg55('AAAA')]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.aggressive55.totalCandidates).toBe(1);
  });

  it('passes score=55 exactly', () => {
    const p = writeJsonl('obs.jsonl', [
      agg55('AAAA', T0, { ripperScore: 55, launchAgeBucket: 'PRIME_WINDOW' }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.aggressive55.totalCandidates).toBe(1);
  });

  it('rejects score < 55', () => {
    const p = writeJsonl('obs.jsonl', [agg55('AAAA', T0, { ripperScore: 54 })]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.aggressive55.totalCandidates).toBe(0);
  });

  it('rejects danger warnings', () => {
    const p = writeJsonl('obs.jsonl', [agg55('AAAA', T0, { warnings: ['freeze authority enabled'] })]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.aggressive55.totalCandidates).toBe(0);
  });

  it('rejects mint authority in blockers', () => {
    const p = writeJsonl('obs.jsonl', [agg55('AAAA', T0, { blockers: ['mint authority not renounced'] })]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [p] });
    expect(r.aggressive55.totalCandidates).toBe(0);
  });
});

// ── Overlap and extra counts ──────────────────────────────────────────────────

describe('overlap and extra counts', () => {
  it('overlap counts contracts in both current and loose60', () => {
    const cycles = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA'), // same contract → overlap
      loose60('BBBB'), // new contract → extra
    ]);
    const r = runRipperGateLoosenShadowReport({
      approvalPaths:    [cycles],
      observationPaths: [obs_p],
    });
    expect(r.loose60.overlapWithCurrent).toBe(1);
    expect(r.loose60.extraBeyondCurrent).toBe(1);
  });

  it('extra candidates exclude contracts already in current', () => {
    const cycles = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA'),
      loose60('BBBB'),
    ]);
    const r = runRipperGateLoosenShadowReport({
      approvalPaths:    [cycles],
      observationPaths: [obs_p],
    });
    // topExtras should only contain BBBB, not AAAA
    const keys = r.loose60.topExtras.map(e => e.contractKey);
    expect(keys).not.toContain('AAAA');
    expect(keys).toContain('BBBB');
  });
});

// ── Later move stats ──────────────────────────────────────────────────────────

describe('later move stats', () => {
  it('movedPlus1 counts contracts with best later pct >= 1', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0),
      obs('AAAA', at(60_000), 2.0),
      loose60('BBBB', T0),
      obs('BBBB', at(60_000), 0.5),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.movedPlus1).toBe(1);
  });

  it('movedPlus3 counts contracts with best later pct >= 3', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0),
      obs('AAAA', at(60_000), 4.0),
      loose60('BBBB', T0),
      obs('BBBB', at(60_000), 2.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.movedPlus3).toBe(1);
  });

  it('movedPlus5 counts contracts with best later pct >= 5', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0),
      obs('AAAA', at(60_000), 6.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.movedPlus5).toBe(1);
  });

  it('dumpedMinus3 counts contracts with worst later pct <= -3', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0),
      obs('AAAA', at(60_000), -4.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.dumpedMinus3).toBe(1);
  });

  it('noLaterData counts contracts with no later observations', () => {
    const obs_p = writeJsonl('obs.jsonl', [loose60('AAAA', T0)]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.noLaterData).toBe(1);
  });

  it('avgBestLaterMove averages across contracts with later data', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0), obs('AAAA', at(60_000), 2.0),
      loose60('BBBB', T0), obs('BBBB', at(60_000), 4.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.avgBestLaterMove).toBeCloseTo(3.0);
  });

  it('medianBestLaterMove is median of best later moves', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0), obs('AAAA', at(60_000), 1.0),
      loose60('BBBB', T0), obs('BBBB', at(60_000), 3.0),
      loose60('CCCC', T0), obs('CCCC', at(60_000), 5.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.medianBestLaterMove).toBeCloseTo(3.0);
  });

  it('worstLaterMove is the minimum of all best-later moves', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0), obs('AAAA', at(60_000), 1.0),
      loose60('BBBB', T0), obs('BBBB', at(60_000), -1.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.worstLaterMove).toBeCloseTo(-1.0);
  });

  it('null stats when no later data exists', () => {
    const obs_p = writeJsonl('obs.jsonl', [loose60('AAAA', T0)]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.avgBestLaterMove).toBeNull();
    expect(r.loose60.medianBestLaterMove).toBeNull();
    expect(r.loose60.worstLaterMove).toBeNull();
  });

  it('only counts obs strictly after first seen time', () => {
    // Same capturedAt for fixture and obs — should not count as "later"
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('AAAA', T0),
      obs('AAAA', T0, 5.0),        // same time — not later
      obs('AAAA', at(1_000), 2.0), // 1s later — counts
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.movedPlus5).toBe(0); // best later is 2.0, not 5.0
    expect(r.loose60.movedPlus1).toBe(1);
  });
});

// ── Extra candidate verdicts ──────────────────────────────────────────────────

describe('extra candidate verdicts', () => {
  it('WOULD_HAVE_HELPED when best >= 1 and worst > -3', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('EXTRA', T0),
      obs('EXTRA', at(60_000), 2.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const e = r.loose60.topExtras[0];
    expect(e.verdict).toBe('WOULD_HAVE_HELPED');
  });

  it('DUMP_RISK when worst <= -3', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('EXTRA', T0),
      obs('EXTRA', at(60_000), 1.0),
      obs('EXTRA', at(120_000), -4.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const e = r.loose60.topExtras[0];
    expect(e.verdict).toBe('DUMP_RISK');
  });

  it('NO_EDGE when best < 1 and no dump', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('EXTRA', T0),
      obs('EXTRA', at(60_000), 0.5),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const e = r.loose60.topExtras[0];
    expect(e.verdict).toBe('NO_EDGE');
  });

  it('NO_LATER_DATA when no obs after first seen', () => {
    const obs_p = writeJsonl('obs.jsonl', [loose60('EXTRA', T0)]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const e = r.loose60.topExtras[0];
    expect(e.verdict).toBe('NO_LATER_DATA');
  });

  it('topExtras capped at 15', () => {
    const rows: object[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(loose60(`C${i.toString().padStart(4, '0')}`, T0));
    }
    const obs_p = writeJsonl('obs.jsonl', rows);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.loose60.topExtras.length).toBeLessThanOrEqual(15);
  });

  it('topExtras populate contractKey, score, symbol', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('EXTRATOKEN', T0, { symbol: 'TOKEN', ripperScore: 72 }),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const e = r.loose60.topExtras[0];
    expect(e.contractKey).toBe('EXTRATOKEN');
    expect(e.symbol).toBe('TOKEN');
    expect(e.score).toBe(72);
  });
});

// ── All three policies returned ───────────────────────────────────────────────

describe('all three policies', () => {
  it('result has current, loose60, aggressive55', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    expect(r.current.policy).toBe('CURRENT_APPROVAL');
    expect(r.loose60.policy).toBe('LOOSE_60_WATCH');
    expect(r.aggressive55.policy).toBe('AGGRESSIVE_55_WATCH');
  });

  it('aggressive55 includes contracts rejected by loose60 (score 57, LATE)', () => {
    const obs_p = writeJsonl('obs.jsonl', [agg55('AAAA')]); // score 57, LATE
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    expect(r.aggressive55.totalCandidates).toBe(1);
    expect(r.loose60.totalCandidates).toBe(0); // LATE not allowed
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and safety header', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('RIPPER GATE LOOSEN SHADOW REPORT');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('NO GATE CHANGES');
  });

  it('includes all three policy sections', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('CURRENT_APPROVAL');
    expect(out).toContain('LOOSE_60_WATCH');
    expect(out).toContain('AGGRESSIVE_55_WATCH');
  });

  it('includes safety footer', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('DO NOT CHANGE APPROVAL THRESHOLDS');
    expect(out).toContain('DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  });

  it('renders extra candidate table when extras present', () => {
    const obs_p = writeJsonl('obs.jsonl', [
      loose60('EXTRA', T0, { symbol: 'TOK', ripperScore: 70 }),
      obs('EXTRA', at(60_000), 3.0),
    ]);
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [obs_p] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('$TOK');
    expect(out).toContain('WOULD_HAVE_HELPED');
  });

  it('shows n/a for null numeric stats', () => {
    const r = runRipperGateLoosenShadowReport({ approvalPaths: [], observationPaths: [] });
    const out = renderRipperGateLoosenShadowReport(r);
    expect(out).toContain('n/a');
  });
});
