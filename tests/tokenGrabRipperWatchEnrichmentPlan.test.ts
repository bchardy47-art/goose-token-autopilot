import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWatchEnrichmentPlan,
  renderWatchEnrichmentPlan,
  classifyWatchGroup,
  WatchGroupKey,
} from '../src/token-grab/ripperWatchEnrichmentPlan';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchPlan-'));
}

function writeLines(p: string, rows: object[]): void {
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(o: Record<string, unknown> = {}): object {
  return {
    contract:              'C_DEFAULT',
    outcomeLabel:          'FLAT_JUNK',
    priceChangePct:        0,
    liquidityBucket:       'LIQ_10K_30K',
    liquidityUsd:          15000,
    vlrBucket:             'VLR_0_5_TO_2',
    clusterRisk:           'WATCH',
    ripperScore:           70,
    ageMinutes:            4.0,
    timingPath:            'ENTER_NOW',
    gateDecision:          'BUY_REJECTED',
    wouldRejectByLiqOrAge: false,
    ...o,
  };
}

// ── classifyWatchGroup ────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — classifyWatchGroup', () => {
  it('KNOWN_LIQ_KNOWN_VLR when both known', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' }))
      .toBe<WatchGroupKey>('KNOWN_LIQ_KNOWN_VLR');
  });

  it('KNOWN_LIQ_VLR_UNKNOWN when liq known vlr unknown', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_UNKNOWN' }))
      .toBe<WatchGroupKey>('KNOWN_LIQ_VLR_UNKNOWN');
  });

  it('LIQ_UNKNOWN_KNOWN_VLR when liq unknown vlr known', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_GTE_2' }))
      .toBe<WatchGroupKey>('LIQ_UNKNOWN_KNOWN_VLR');
  });

  it('LIQ_UNKNOWN_VLR_UNKNOWN when both unknown', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN' }))
      .toBe<WatchGroupKey>('LIQ_UNKNOWN_VLR_UNKNOWN');
  });

  it('null liquidityBucket treated as LIQ_UNKNOWN', () => {
    expect(classifyWatchGroup({ liquidityBucket: null, vlrBucket: 'VLR_GTE_2' }))
      .toBe<WatchGroupKey>('LIQ_UNKNOWN_KNOWN_VLR');
  });

  it('null vlrBucket treated as VLR_UNKNOWN', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_10K_30K', vlrBucket: null }))
      .toBe<WatchGroupKey>('KNOWN_LIQ_VLR_UNKNOWN');
  });

  it('both null → LIQ_UNKNOWN_VLR_UNKNOWN', () => {
    expect(classifyWatchGroup({ liquidityBucket: null, vlrBucket: null }))
      .toBe<WatchGroupKey>('LIQ_UNKNOWN_VLR_UNKNOWN');
  });

  it('LIQ_LT_10K is treated as known liq', () => {
    expect(classifyWatchGroup({ liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5' }))
      .toBe<WatchGroupKey>('KNOWN_LIQ_KNOWN_VLR');
  });
});

// ── WATCH grouping ────────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — WATCH grouping', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('only WATCH rows are processed; non-WATCH rows ignored', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'W1', clusterRisk: 'WATCH',   outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'C1', clusterRisk: 'CLEAN',   outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'U1', clusterRisk: 'UNKNOWN', outcomeLabel: 'DUMP' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    expect(result.totalWatchRows).toBe(1);
    const known = result.subgroups.find(g => g.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(known.total).toBe(1);
  });

  it('rows routed to correct subgroups', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_GTE_2',    outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_UNKNOWN',   outcomeLabel: 'DUMP' }),
      makeRow({ contract: 'C', liquidityBucket: 'LIQ_UNKNOWN',  vlrBucket: 'VLR_GTE_2',     outcomeLabel: 'FLAT_JUNK' }),
      makeRow({ contract: 'D', liquidityBucket: 'LIQ_UNKNOWN',  vlrBucket: 'VLR_UNKNOWN',   outcomeLabel: 'BIG_WINNER', liquidityUsd: null }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    expect(result.subgroups.find(g => g.key === 'KNOWN_LIQ_KNOWN_VLR')!.total).toBe(1);
    expect(result.subgroups.find(g => g.key === 'KNOWN_LIQ_VLR_UNKNOWN')!.total).toBe(1);
    expect(result.subgroups.find(g => g.key === 'LIQ_UNKNOWN_KNOWN_VLR')!.total).toBe(1);
    expect(result.subgroups.find(g => g.key === 'LIQ_UNKNOWN_VLR_UNKNOWN')!.total).toBe(1);
  });

  it('result always contains all four subgroups even when empty', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow({ contract: 'X', outcomeLabel: 'BIG_WINNER' })]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const keys = result.subgroups.map(g => g.key);
    expect(keys).toContain('KNOWN_LIQ_KNOWN_VLR');
    expect(keys).toContain('KNOWN_LIQ_VLR_UNKNOWN');
    expect(keys).toContain('LIQ_UNKNOWN_KNOWN_VLR');
    expect(keys).toContain('LIQ_UNKNOWN_VLR_UNKNOWN');
    expect(result.subgroups.length).toBe(4);
  });
});

// ── Known vs unknown liq/VLR classification ───────────────────────────────────

describe('ripperWatchEnrichmentPlan — liq/VLR unknown detection', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('liqUsdAllNull=true when all matched rows have null liquidityUsd', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'LIQ_UNKNOWN_VLR_UNKNOWN')!;
    expect(g.liqUsdAllNull).toBe(true);
  });

  it('liqUsdAllNull=false when at least one row has known liquidityUsd', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.liqUsdAllNull).toBe(false);
  });
});

// ── Labeled coverage ──────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — labeled coverage', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('labeled = rows with non-null non-UNKNOWN outcome', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK' }),
      makeRow({ contract: 'C', outcomeLabel: 'UNKNOWN' }),  // not labeled
      makeRow({ contract: 'D', outcomeLabel: null }),         // not labeled
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.labeled).toBe(2);
    expect(g.unlabeled).toBe(2);
    expect(g.total).toBe(4);
  });

  it('labeledCoveragePct = labeled / total', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'C', outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'D', outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.labeledCoveragePct).toBeCloseTo(0.25);
  });

  it('uniqueContracts deduplicates', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'SAME', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'SAME', outcomeLabel: 'DUMP' }),
      makeRow({ contract: 'DIFF', outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.uniqueContracts).toBe(2);
  });
});

// ── Observed win5 ─────────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — observed win5', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('observedWin5Rate = (BIG_WINNER+WINNER) / labeled', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'WINNER' }),
      makeRow({ contract: 'C', outcomeLabel: 'FLAT_JUNK' }),
      makeRow({ contract: 'D', outcomeLabel: 'DUMP' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.observedWin5Rate).toBeCloseTo(0.5);   // 2/4
    expect(g.win5Rate).toBeCloseTo(0.5);
  });

  it('SMALL_WINNER not counted in win5', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'SMALL_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.observedWin5Rate).toBeCloseTo(0);
    expect(g.smallWinner).toBe(1);
  });
});

// ── Pessimistic win5 ──────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — pessimistic win5', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('pessimisticWin5Rate = win5 / total (unlabeled treated as losses)', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),  // win5
      makeRow({ contract: 'B', outcomeLabel: 'UNKNOWN' }),      // unlabeled
      makeRow({ contract: 'C', outcomeLabel: 'UNKNOWN' }),      // unlabeled
      makeRow({ contract: 'D', outcomeLabel: 'UNKNOWN' }),      // unlabeled
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.pessimisticWin5Rate).toBeCloseTo(0.25);  // 1/4
    expect(g.observedWin5Rate).toBeCloseTo(1.0);      // 1/1 labeled
  });

  it('pessimistic < observed when there are unlabeled rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.pessimisticWin5Rate!).toBeLessThan(g.observedWin5Rate!);
  });

  it('pessimistic = observed when no unlabeled rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.pessimisticWin5Rate).toBeCloseTo(g.observedWin5Rate!);
  });
});

// ── Artifact risk ─────────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — artifact risk', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('HIGH when liqUsdAllNull=true', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'LIQ_UNKNOWN_VLR_UNKNOWN')!;
    expect(g.artifactRisk).toBe('HIGH');
  });

  it('HIGH when >50% unlabeled', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'C', outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.artifactRisk).toBe('HIGH');
  });

  it('MEDIUM when 30-50% unlabeled and liqUsd known', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER',   liquidityUsd: 15000 }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK',    liquidityUsd: 15000 }),
      makeRow({ contract: 'C', outcomeLabel: 'DUMP',         liquidityUsd: 15000 }),
      makeRow({ contract: 'D', outcomeLabel: 'UNKNOWN',      liquidityUsd: 15000 }),  // 25% unlabeled → LOW
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.artifactRisk).toBe('LOW');  // 25% < 30%
  });

  it('LOW when <30% unlabeled and liqUsd known', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER',  liquidityUsd: 15000 }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK',   liquidityUsd: 15000 }),
      makeRow({ contract: 'C', outcomeLabel: 'BIG_WINNER',  liquidityUsd: 15000 }),
      makeRow({ contract: 'D', outcomeLabel: 'FLAT_JUNK',   liquidityUsd: 15000 }),
      makeRow({ contract: 'E', outcomeLabel: 'DUMP',        liquidityUsd: 15000 }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.artifactRisk).toBe('LOW');
    expect(g.labeledCoveragePct).toBe(1);
  });
});

// ── Recommendation labels ─────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — recommendation labels', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('WATCH_TOO_ARTIFACT_RISKY when liqUsd all null', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'C', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'LIQ_UNKNOWN_VLR_UNKNOWN')!;
    expect(g.recommendation).toBe('WATCH_TOO_ARTIFACT_RISKY');
  });

  it('WATCH_NEEDS_RECHECK when labeled < 20', () => {
    const mp = path.join(dir, 'mem.jsonl');
    // 5 labeled rows, known liq — small sample
    writeLines(mp, Array.from({ length: 5 }, (_, i) =>
      makeRow({ contract: `C${i}`, liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' })));
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.recommendation).toBe('WATCH_NEEDS_RECHECK');
  });

  it('WATCH_JUNK_HEAVY when flatDump > 70%', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...Array.from({ length: 25 }, (_, i) =>
        makeRow({ contract: `W${i}`, liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 75 }, (_, i) =>
        makeRow({ contract: `D${i}`, liquidityUsd: 15000, outcomeLabel: 'DUMP' })),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.recommendation).toBe('WATCH_JUNK_HEAVY');
    expect(g.flatDumpRate).toBeCloseTo(0.75);
  });

  it('WATCH_READY_FOR_PAPER_OBSERVATION when win5≥30% and lift ok and n≥20', () => {
    const mp = path.join(dir, 'mem.jsonl');
    // WATCH group: 20 BIG_WINNER + 30 FLAT_JUNK = 40% win5 (n=50, all labeled, LOW artifact risk)
    // Non-WATCH rows bring global baseline to 30/100 = 30%, giving lift 0.40/0.30 ≈ 1.33x ≥ 1.3
    writeLines(mp, [
      ...Array.from({ length: 20 }, (_, i) =>
        makeRow({ contract: `W${i}`, liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER', clusterRisk: 'WATCH' })),
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow({ contract: `F${i}`, liquidityUsd: 15000, outcomeLabel: 'FLAT_JUNK', clusterRisk: 'WATCH' })),
      ...Array.from({ length: 10 }, (_, i) =>
        makeRow({ contract: `NW${i}`, liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER', clusterRisk: 'CLEAN' })),
      ...Array.from({ length: 40 }, (_, i) =>
        makeRow({ contract: `NF${i}`, liquidityUsd: 15000, outcomeLabel: 'FLAT_JUNK', clusterRisk: 'CLEAN' })),
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.recommendation).toBe('WATCH_READY_FOR_PAPER_OBSERVATION');
    expect(g.win5Rate).toBeCloseTo(0.4);
    expect(result.baselineWin5Rate).toBeCloseTo(0.3);
  });
});

// ── Avg/median price movement ─────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — price movement', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('avgMove and medianMove computed from labeled rows only', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER', priceChangePct: 20  }),
      makeRow({ contract: 'B', outcomeLabel: 'FLAT_JUNK',  priceChangePct: 0   }),
      makeRow({ contract: 'C', outcomeLabel: 'DUMP',       priceChangePct: -10 }),
      makeRow({ contract: 'D', outcomeLabel: 'UNKNOWN',    priceChangePct: 999 }),  // excluded
    ]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'KNOWN_LIQ_KNOWN_VLR')!;
    expect(g.avgMove).toBeCloseTo((20 + 0 + -10) / 3);
    expect(g.medianMove).toBeCloseTo(0);  // sorted: -10, 0, 20 → 0
  });
});

// ── Safety flags ──────────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — safety flags', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('result has all required safety fields', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  it('rendered output contains REPORT_ONLY and DO_NOT_ENABLE_REAL_TRADING', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const out = renderWatchEnrichmentPlan(result);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('NO_POLICY_CHANGE=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
  });

  it('rendered output contains observation strategy section', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const out = renderWatchEnrichmentPlan(result);
    expect(out).toContain('PROPOSED PAPER-ONLY OBSERVATION STRATEGY');
    expect(out).toContain('RE-CHECK AT 2 MINUTES');
    expect(out).toContain('RE-CHECK AT 5 MINUTES');
    expect(out).toContain('UPGRADE CONDITIONS');
    expect(out).toContain('DOWNGRADE CONDITIONS');
  });

  it('rendered output contains all four subgroup keys', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const out = renderWatchEnrichmentPlan(result);
    expect(out).toContain('KNOWN_LIQ_KNOWN_VLR');
    expect(out).toContain('KNOWN_LIQ_VLR_UNKNOWN');
    expect(out).toContain('LIQ_UNKNOWN_KNOWN_VLR');
    expect(out).toContain('LIQ_UNKNOWN_VLR_UNKNOWN');
  });

  it('rendered output has disclaimer about not wired into gates', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const out = renderWatchEnrichmentPlan(result);
    expect(out).toContain('No gate, autopilot, or policy logic modified');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('ripperWatchEnrichmentPlan — edge cases', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('missing file returns zero rows', () => {
    const result = runWatchEnrichmentPlan({
      learningMemoryPath: path.join(dir, 'missing.jsonl'),
    });
    expect(result.totalWatchRows).toBe(0);
    expect(result.subgroups.every(g => g.total === 0)).toBe(true);
  });

  it('invalid JSON lines are skipped', () => {
    const mp = path.join(dir, 'mem.jsonl');
    fs.writeFileSync(mp, `{bad json}\n${JSON.stringify(makeRow({ outcomeLabel: 'BIG_WINNER' }))}\n`);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    expect(result.totalWatchRows).toBe(1);
  });

  it('empty subgroup has null rates', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow({ contract: 'A', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' })]);
    const result = runWatchEnrichmentPlan({ learningMemoryPath: mp });
    const g = result.subgroups.find(x => x.key === 'LIQ_UNKNOWN_VLR_UNKNOWN')!;
    expect(g.total).toBe(0);
    expect(g.win5Rate).toBeNull();
    expect(g.observedWin5Rate).toBeNull();
    expect(g.pessimisticWin5Rate).toBeNull();
    expect(g.avgMove).toBeNull();
  });
});
