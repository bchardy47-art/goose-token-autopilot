import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovalFollowPaperPlan,
  renderRipperApprovalFollowPaperPlan,
  type EntryPlanRow,
  type RipperApprovalFollowPaperPlanResult,
} from '../src/token-grab/ripperApprovalFollowPaperPlan';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffpp-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeObs(opts: {
  contract?:       string;
  capturedAt?:     string;
  pct?:            number | null;
  liq?:            number | null;
  vol?:            number | null;
  symbol?:         string;
  approved?:       boolean;
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.pct    != null) sig['priceChangePct'] = opts.pct;
  if (opts.liq    != null) sig['liquidityUsd']   = opts.liq;
  if (opts.vol    != null) sig['volumeUsd']       = opts.vol;
  if (opts.symbol != null) sig['symbol']          = opts.symbol;
  return {
    id:                `obs-${Math.random()}`,
    capturedAt:        opts.capturedAt ?? '2025-01-01T00:00:00.000Z',
    source:            'test',
    sourceKind:        'test',
    normalizedSignal:  sig,
    ripperInput:       {},
    blockers:          [],
    topReasons:        [],
    warnings:          [],
    buyGateDecision:   opts.approved ? 'BUY_APPROVED_PAPER' : 'NOT_APPROVED',
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

const T0 = '2025-01-01T00:00:00.000Z';  // approval time
const T0MS = Date.parse(T0);

function atOffset(ms: number): string {
  return new Date(T0MS + ms).toISOString();
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const result = runRipperApprovalFollowPaperPlan({
      observationPaths: [],
      approvalPaths:    [],
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });

  it('result has generatedAt', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    expect(typeof result.generatedAt).toBe('string');
    expect(result.generatedAt.length).toBeGreaterThan(0);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns empty rows for empty paths', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    expect(result.rows).toHaveLength(0);
    expect(result.summary.totalApproved).toBe(0);
  });

  it('skips missing files gracefully', () => {
    const result = runRipperApprovalFollowPaperPlan({
      observationPaths: ['/no/such/path.jsonl'],
      approvalPaths:    ['/no/such/approval.jsonl'],
    });
    expect(result.rows).toHaveLength(0);
  });

  it('no-approval-data obs generates no rows', () => {
    const p = writeJsonl('obs.jsonl', [makeObs({ contract: 'BBBB', pct: 5.0 })]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.rows).toHaveLength(0);
  });
});

// ── Dual-source approval detection ───────────────────────────────────────────

describe('dual-source approval detection', () => {
  it('detects obs-only approval', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].approvalSource).toBe('obs');
  });

  it('detects file-only approval', () => {
    const obsP = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({
      observationPaths: [obsP],
      approvalPaths:    [apprP],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].approvalSource).toBe('file');
  });

  it('detects both-source approval', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({
      observationPaths: [p],
      approvalPaths:    [apprP],
    });
    expect(result.rows[0].approvalSource).toBe('both');
  });

  it('uses earliest approval timestamp from either source', () => {
    // obs has later approval, file has earlier
    const obsP = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000), pct: 2.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({
      observationPaths: [obsP],
      approvalPaths:    [apprP],
    });
    expect(result.rows[0].approvedAt).toBe(T0);
  });
});

// ── Entry pct fields ──────────────────────────────────────────────────────────

describe('entry pct fields', () => {
  function makeScenario() {
    // Approval at T0, then obs at +1m/+3m/+5m/+15m
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000), pct: 3.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000), pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(900_000), pct: 5.0 }),
    ]);
    return runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
  }

  it('entryNowPct equals closest obs to approval time', () => {
    const r = makeScenario().rows[0];
    expect(r.entryNowPct).toBe(1.0);
  });

  it('entry1mPct equals first obs at or after +1m', () => {
    const r = makeScenario().rows[0];
    expect(r.entry1mPct).toBe(2.0);
  });

  it('entry3mPct equals first obs at or after +3m', () => {
    const r = makeScenario().rows[0];
    expect(r.entry3mPct).toBe(3.0);
  });

  it('entry5mPct equals first obs at or after +5m', () => {
    const r = makeScenario().rows[0];
    expect(r.entry5mPct).toBe(4.0);
  });

  it('entry15mPct equals first obs at or after +15m', () => {
    const r = makeScenario().rows[0];
    expect(r.entry15mPct).toBe(5.0);
  });

  it('entry pct is null if no obs at that delay', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
      // only one after-obs at +30s — will land as now but nothing later
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000), pct: 2.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.entry1mPct).toBeNull();
    expect(r.entry3mPct).toBeNull();
  });

  it('bestAfterPct is max pct strictly after approval', () => {
    const r = makeScenario().rows[0];
    expect(r.bestAfterPct).toBe(5.0);
  });

  it('maxDrawdownAfterPct = approvalPct - minAfterPct', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 3.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 5.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    // approvalPct ≈ 3.0 (closest to T0), minAfterPct = 1.0 → drawdown = 2.0
    expect(r.maxDrawdownAfterPct).toBeCloseTo(2.0);
  });
});

// ── Upside fields ─────────────────────────────────────────────────────────────

describe('upside fields', () => {
  it('upsideNow = bestAfterPct - entryNowPct', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.upsideNow).toBeCloseTo(3.0);
  });

  it('upside1m = bestAfterPct - entry1mPct', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 5.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    // bestAfterPct=5, entry1mPct=2 → upside1m=3
    expect(r.upside1m).toBeCloseTo(3.0);
  });

  it('upside is null when entry pct is null', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,               pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000), pct: 4.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.entry1mPct).toBeNull();
    expect(r.upside1m).toBeNull();
  });
});

// ── Best entry label selection ────────────────────────────────────────────────

describe('best entry label selection', () => {
  it('NO_AFTER_DATA when no obs after approval', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('NO_AFTER_DATA');
  });

  it('SKIP_NO_EDGE when no entry has upside >= 1.0', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 5.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 5.5 }),
    ]);
    // upsideNow = 5.5-5.0 = 0.5 < 1.0 → SKIP_NO_EDGE
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('SKIP_NO_EDGE');
  });

  it('ENTER_NOW when now has upside >= 1.0 and lowest pct', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    // entryNow=1.0 best=4.0 upsideNow=3.0 >=1.0, entry1m=2.0 upside1m=2.0 >=1.0; lowest=1.0 → ENTER_NOW
    expect(r.bestEntryDelay).toBe('ENTER_NOW');
  });

  it('WAIT_1M when 1m entry is lower than now and has upside >= 1.0', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 3.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000), pct: 5.0 }),
    ]);
    // bestAfter=5, entryNow=3 upsideNow=2 >=1 (qualifying), entry1m=1 upside1m=4 >=1 (qualifying)
    // lowest pct among qualifying: 1.0 → WAIT_1M
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('WAIT_1M');
  });

  it('WAIT_3M', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 5.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000), pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(600_000), pct: 5.0 }),
    ]);
    // best=5, entryNow=5 upside=0 <1 (skip), 1m=4 upside=1 >=1, 3m=1 upside=4 >=1; lowest=1 → WAIT_3M
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('WAIT_3M');
  });

  it('WAIT_5M', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 5.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 4.5 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000), pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000), pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(600_000), pct: 5.0 }),
    ]);
    // best=5, entryNow=5 upside=0 skip, 1m=4.5 upside=0.5 skip, 3m=4 upside=1 >=1, 5m=1 upside=4 >=1
    // lowest qualifying: 1.0 → WAIT_5M
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('WAIT_5M');
  });

  it('WAIT_15M', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                  pct: 5.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),    pct: 4.5 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000),   pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000),   pct: 3.5 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(900_000),   pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(1_800_000), pct: 5.0 }),
    ]);
    // best=5, all earlier entries have upside <1 because pcts are close; 15m=1 upside=4 >=1 → WAIT_15M
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('WAIT_15M');
  });

  it('tie-break: prefer ENTER_NOW over WAIT_1M when same lowest pct', () => {
    // both now and 1m at pct=1.0 with equal upside → pick ENTER_NOW (earlier)
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const r = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] }).rows[0];
    expect(r.bestEntryDelay).toBe('ENTER_NOW');
  });
});

// ── Summary counts and avg/median ─────────────────────────────────────────────

describe('summary counts', () => {
  it('totalApproved matches row count', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
      makeObs({ contract: 'BBBB', capturedAt: T0, pct: 2.0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.summary.totalApproved).toBe(2);
  });

  it('enterNowCount increments for ENTER_NOW rows', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
      makeObs({ contract: 'BBBB', capturedAt: T0,                pct: 1.5, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.summary.enterNowCount).toBe(2);
  });

  it('noAfterDataCount increments for NO_AFTER_DATA rows', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.summary.noAfterDataCount).toBe(1);
    expect(result.summary.totalApproved).toBe(1);
  });

  it('avgUpsideNow is average over rows that have upsideNow', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 3.0 }),
      makeObs({ contract: 'BBBB', capturedAt: T0,                pct: 2.0, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // upsideNow: AAAA=2.0, BBBB=2.0 → avg=2.0
    expect(result.summary.avgUpsideNow).toBeCloseTo(2.0);
  });

  it('medianUpsideNow is median over rows that have upsideNow', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 2.0 }),
      makeObs({ contract: 'BBBB', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(120_000), pct: 4.0 }),
      makeObs({ contract: 'CCCC', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'CCCC', capturedAt: atOffset(120_000), pct: 6.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // upsideNow: 1, 3, 5 → median=3
    expect(result.summary.medianUpsideNow).toBeCloseTo(3.0);
  });

  it('avg/median is null when no rows have upside', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.summary.avgUpsideNow).toBeNull();
    expect(result.summary.medianUpsideNow).toBeNull();
  });
});

// ── Recommendation ────────────────────────────────────────────────────────────

describe('recommendation', () => {
  it('empty → insufficient data', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    expect(result.summary.recommendation).toContain('insufficient data');
  });

  it('immediate when >50% ENTER_NOW', () => {
    const lines: object[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(makeObs({ contract: `C${i}`, capturedAt: T0, pct: 1.0, approved: true }));
      lines.push(makeObs({ contract: `C${i}`, capturedAt: atOffset(120_000), pct: 4.0 }));
    }
    // 1 no-after-data contract
    lines.push(makeObs({ contract: 'D0', capturedAt: T0, approved: true }));
    const p = writeJsonl('obs.jsonl', lines);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // 3 ENTER_NOW, 1 NO_AFTER_DATA → 3/4 > 0.5 → immediate
    expect(result.summary.recommendation).toContain('Immediate');
  });

  it('delayed confirm when >50% WAIT_1M/WAIT_3M/WAIT_5M', () => {
    const lines: object[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(makeObs({ contract: `C${i}`, capturedAt: T0,                pct: 5.0, approved: true }));
      lines.push(makeObs({ contract: `C${i}`, capturedAt: atOffset(60_000),  pct: 1.0 }));
      lines.push(makeObs({ contract: `C${i}`, capturedAt: atOffset(120_000), pct: 5.0 }));
    }
    lines.push(makeObs({ contract: 'D0', capturedAt: T0, approved: true }));
    const p = writeJsonl('obs.jsonl', lines);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // 3 WAIT_1M (entry=1 vs apprPct=5, best=5), 1 NO_AFTER_DATA → 3/4 > 0.5 → delayed confirm
    expect(result.summary.recommendation).toContain('Delayed');
  });

  it('approval not reliable when >50% SKIP_NO_EDGE / NO_AFTER_DATA', () => {
    const lines: object[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(makeObs({ contract: `C${i}`, capturedAt: T0, approved: true }));
    }
    const p = writeJsonl('obs.jsonl', lines);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // 4 NO_AFTER_DATA → 4/4 > 0.5 → not reliable
    expect(result.summary.recommendation).toContain('not a reliable');
  });

  it('mixed signal as fallback', () => {
    // Craft 4 rows: 1 ENTER_NOW, 1 WAIT_1M, 1 SKIP_NO_EDGE, 1 NO_AFTER_DATA
    const lines: object[] = [
      // ENTER_NOW
      makeObs({ contract: 'A0', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'A0', capturedAt: atOffset(120_000), pct: 4.0 }),
      // WAIT_1M: appr at high pct, dip at 1m, recovers
      makeObs({ contract: 'B0', capturedAt: T0,                pct: 5.0, approved: true }),
      makeObs({ contract: 'B0', capturedAt: atOffset(60_000),  pct: 1.0 }),
      makeObs({ contract: 'B0', capturedAt: atOffset(120_000), pct: 5.0 }),
      // SKIP_NO_EDGE: no entry with upside >=1
      makeObs({ contract: 'C0', capturedAt: T0,                pct: 5.0, approved: true }),
      makeObs({ contract: 'C0', capturedAt: atOffset(60_000),  pct: 5.5 }),
      // NO_AFTER_DATA
      makeObs({ contract: 'D0', capturedAt: T0, approved: true }),
    ];
    const p = writeJsonl('obs.jsonl', lines);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    // 1 ENTER_NOW (25%), 1 WAIT_1M (25%), 1 SKIP (25%), 1 NO_AFTER (25%) → mixed
    expect(result.summary.recommendation).toContain('Mixed');
  });
});

// ── Row ordering ──────────────────────────────────────────────────────────────

describe('row ordering', () => {
  it('rows sorted by approvedAt ascending', () => {
    const t1 = '2025-01-01T00:10:00.000Z';
    const t2 = '2025-01-01T00:20:00.000Z';
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'BBBB', capturedAt: t2, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: t1, approved: true }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    expect(result.rows[0].contractKey).toBe('AAAA');
    expect(result.rows[1].contractKey).toBe('BBBB');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and safety header', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('RIPPER APPROVAL FOLLOW PAPER PLAN');
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
  });

  it('includes safety footer', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('DO NOT CALL AUTO-PAPER');
    expect(output).toContain('DO NOT CALL PAPER-BUY');
  });

  it('includes label key', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('ENTER_NOW');
    expect(output).toContain('WAIT_1M');
    expect(output).toContain('SKIP_NO_EDGE');
    expect(output).toContain('NO_AFTER_DATA');
  });

  it('shows recommendation in output', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('Recommendation:');
  });

  it('shows "no approved contracts found" for empty rows', () => {
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('no approved contracts found');
  });

  it('renders row data in table when rows present', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, symbol: 'TOKEN', approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('$TOKEN');
    expect(output).toContain('ENTER_NOW');
  });

  it('includes summary section with counts', () => {
    const p = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperPlan({ observationPaths: [p], approvalPaths: [] });
    const output = renderRipperApprovalFollowPaperPlan(result);
    expect(output).toContain('SUMMARY');
    expect(output).toContain('Total approved');
  });
});
