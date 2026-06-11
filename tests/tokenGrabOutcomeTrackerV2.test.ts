import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import * as OTV2 from '../src/token-grab/outcomeTrackerV2';
import {
  buildCandidateSnapshots,
  classifyCheckpointStatus,
  simulateExits,
  loadWatchSnapshots,
  runOutcomeTrackerV2,
  renderOutcomeTrackerV2Report,
  type PriceSnapshot,
  type OutcomeTrackerV2Options,
} from '../src/token-grab/outcomeTrackerV2';
import { type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import { type DexPairSnapshot } from '../src/token-grab/dexWatch';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLiveFixture(opts: {
  contract:       string;
  symbol:         string;
  entryPrice:     number;
  finalPrice?:    number;
  entryAt?:       string;
  finalAt?:       string;
  capturedAt?:    string;
}): LiveRipperFixture {
  const contract   = opts.contract;
  const entryPrice = opts.entryPrice;
  const finalPrice = opts.finalPrice ?? entryPrice;
  const entryAt    = opts.entryAt    ?? '2026-06-10T08:43:13.000Z';
  const finalAt    = opts.finalAt    ?? '2026-06-10T08:44:15.000Z';

  return {
    id:           `fix-${contract}`,
    capturedAt:   opts.capturedAt ?? '2026-06-10T08:46:49.889Z',
    source:       'test',
    sourceKind:   'FRESH_POOL',
    raw: {
      contract,
      chainId:                   'solana',
      pairUrl:                   `https://dexscreener.com/solana/PAIR_${contract}`,
      clusterRisk:               'CLEAN',
      slippageRisk:              'CLEAN',
      routeFound:                true,
      quoteCheckedAt:            '2026-06-10T08:43:00.000Z',
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent:          9.5,
      liquidityTradable:         'GOOD',
      estimatedSlippagePct:      0,
      entry: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd: entryPrice, liquidityUsd: 80000, volumeUsd: 8000,
        observedAt: entryAt,
      },
      final: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd: finalPrice, liquidityUsd: 80000,
        observedAt: finalAt,
      },
    },
    normalizedSignal: {
      id: `sig-${contract}`, contract, symbol: opts.symbol, chainId: 'solana',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
    entryDecision:   'BUY_APPROVED_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: [], topReasons: [], warnings: [],
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

const nullFetch = async (): Promise<DexPairSnapshot | null> => null;

function makeFetch(prices: Record<string, number | null>) {
  return async (contract: string, _chain: string, observedAt: string): Promise<DexPairSnapshot | null> => {
    if (!(contract in prices)) return null;
    const price = prices[contract];
    if (price === null) return null;
    return { contract, chainId: 'solana', priceUsd: price, observedAt };
  };
}

let counter = 0;
// Default watchInputPath points to a nonexistent file so existing tests are unaffected.
function makeOptions(
  fixtures:      LiveRipperFixture[],
  fetchImpl      = nullFetch,
  watchInputPath = '/tmp/nonexistent-watch-default.jsonl',
): OutcomeTrackerV2Options {
  const tmpFile = `/tmp/test-v2-fixtures-${++counter}.jsonl`;
  writeFileSync(tmpFile, fixtures.map(f => JSON.stringify(f)).join('\n'));
  return { inputPath: tmpFile, generatedAt: '2026-06-10T10:00:00.000Z', fetch: fetchImpl, watchInputPath };
}

// Writes a watch-session JSONL file and returns its path.
let watchCounter = 0;
interface WatchSnapSpec {
  contract:   string;
  price:      number;
  observedAt: string;
}
function makeWatchFile(specs: WatchSnapSpec[]): string {
  const tmpFile = `/tmp/test-v2-watch-${++watchCounter}.jsonl`;
  const lines = specs.map(s => JSON.stringify({
    observedAt:               s.observedAt,
    symbol:                   'TST',
    contract:                 s.contract,
    pairAddress:              null,
    pairUrl:                  null,
    chainId:                  'solana',
    entryObservedAt:          null,
    entryPriceUsd:            null,
    latestPriceUsd:           s.price,
    latestLiquidityUsd:       50000,
    latestVolumeUsd:          3000,
    returnPctFromEntry:       null,
    holderConcentrationStatus: 'CLEAN',
    topHolderPercent:         9.5,
    clusterRisk:              'CLEAN',
    bubbleMapsScore:          null,
    slippageRisk:             'CLEAN',
    estimatedSlippagePct:     null,
    source:                   'outcome-watch-session',
  }));
  writeFileSync(tmpFile, lines.join('\n'));
  return tmpFile;
}

// helper: 3-snapshot array
function snaps(entry: number, final: number, latest: number): PriceSnapshot[] {
  return [
    { priceUsd: entry,  observedAt: '2026-06-10T08:43:13.000Z', label: 'entry'  },
    { priceUsd: final,  observedAt: '2026-06-10T08:44:15.000Z', label: 'final'  },
    { priceUsd: latest, observedAt: '2026-06-10T10:00:00.000Z', label: 'latest' },
  ];
}

// ── buildCandidateSnapshots ───────────────────────────────────────────────────

describe('buildCandidateSnapshots', () => {
  it('returns entry snapshot from raw.entry', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: '2026-06-10T08:43:13.000Z' },
    };
    const snaps = buildCandidateSnapshots(raw, null);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.label).toBe('entry');
    expect(snaps[0]!.priceUsd).toBe(0.01);
  });

  it('returns both entry and final when times differ', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: '2026-06-10T08:43:00.000Z' },
      final: { priceUsd: 0.012, observedAt: '2026-06-10T08:44:00.000Z' },
    };
    const snaps = buildCandidateSnapshots(raw, null);
    expect(snaps).toHaveLength(2);
    expect(snaps.map(s => s.label)).toContain('entry');
    expect(snaps.map(s => s.label)).toContain('final');
  });

  it('deduplicates when entry and final share the same observedAt', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: '2026-06-10T08:43:00.000Z' },
      final: { priceUsd: 0.012, observedAt: '2026-06-10T08:43:00.000Z' }, // same time
    };
    const snaps = buildCandidateSnapshots(raw, null);
    expect(snaps).toHaveLength(1);
  });

  it('appends latest snapshot', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: '2026-06-10T08:43:00.000Z' },
    };
    const latest: DexPairSnapshot = { contract: 'X', chainId: 'solana', priceUsd: 0.015, observedAt: '2026-06-10T10:00:00.000Z' };
    const snaps = buildCandidateSnapshots(raw, latest);
    expect(snaps).toHaveLength(2);
    expect(snaps[snaps.length - 1]!.label).toBe('latest');
  });

  it('returns empty array when raw has no entry', () => {
    expect(buildCandidateSnapshots({}, null)).toHaveLength(0);
  });

  it('returns snapshots sorted chronologically', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01,  observedAt: '2026-06-10T08:43:00.000Z' },
      final: { priceUsd: 0.012, observedAt: '2026-06-10T08:44:00.000Z' },
    };
    const latest: DexPairSnapshot = { contract: 'X', chainId: 'solana', priceUsd: 0.015, observedAt: '2026-06-10T10:00:00.000Z' };
    const snaps = buildCandidateSnapshots(raw, latest);
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i]!.observedAt >= snaps[i - 1]!.observedAt).toBe(true);
    }
  });
});

// ── classifyCheckpointStatus ─────────────────────────────────────────────────

describe('classifyCheckpointStatus', () => {
  it('null → UNKNOWN',      () => expect(classifyCheckpointStatus(null)).toBe('UNKNOWN'));
  it('+100% → HIT_100',     () => expect(classifyCheckpointStatus(100)).toBe('HIT_100'));
  it('+150% → HIT_100',     () => expect(classifyCheckpointStatus(150)).toBe('HIT_100'));
  it('+50% → HIT_50',       () => expect(classifyCheckpointStatus(50)).toBe('HIT_50'));
  it('+99% → HIT_50',       () => expect(classifyCheckpointStatus(99)).toBe('HIT_50'));
  it('+25% → HIT_25',       () => expect(classifyCheckpointStatus(25)).toBe('HIT_25'));
  it('+49.9% → HIT_25',     () => expect(classifyCheckpointStatus(49.9)).toBe('HIT_25'));
  it('+24.9% → NEVER_RIPPED', () => expect(classifyCheckpointStatus(24.9)).toBe('NEVER_RIPPED'));
  it('0% → NEVER_RIPPED',   () => expect(classifyCheckpointStatus(0)).toBe('NEVER_RIPPED'));
  it('-50% → NEVER_RIPPED', () => expect(classifyCheckpointStatus(-50)).toBe('NEVER_RIPPED'));
});

// ── simulateExits ─────────────────────────────────────────────────────────────

describe('simulateExits — basic hold', () => {
  it('hold_to_latest equals latest return', () => {
    const s = simulateExits(snaps(0.01, 0.01, 0.015), 0.01);
    expect(s.hold_to_latest).toBeCloseTo(50, 3);
  });

  it('returns null when no snapshots', () => {
    const s = simulateExits([], 0.01);
    expect(s.hold_to_latest).toBeNull();
    expect(s.isSparse).toBe(true);
  });
});

describe('simulateExits — take_profit_25', () => {
  it('fires at +25% when final snapshot crosses threshold', () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%) → TP25 fires at final
    const s = simulateExits(snaps(0.01, 0.014, 0.005), 0.01);
    expect(s.take_profit_25).toBeCloseTo(25, 3);
  });

  it('falls back to hold when price never reaches +25%', () => {
    // entry=0.01, final=0.011 (+10%), latest=0.012 (+20%) → TP25 never fires
    const s = simulateExits(snaps(0.01, 0.011, 0.012), 0.01);
    // hold_to_latest = +20%, TP25 should also = +20% (hold)
    expect(s.take_profit_25).toBeCloseTo(20, 3);
    expect(s.take_profit_25).toEqual(s.hold_to_latest);
  });
});

describe('simulateExits — take_profit_50', () => {
  it('fires at +50% when snapshot crosses threshold', () => {
    const s = simulateExits(snaps(0.01, 0.02, 0.005), 0.01); // final = +100%
    expect(s.take_profit_50).toBeCloseTo(50, 3);
  });

  it('holds when price never reaches +50%', () => {
    // max return is +40%
    const s = simulateExits(snaps(0.01, 0.014, 0.012), 0.01);
    expect(s.take_profit_50).toBeCloseTo(20, 3); // hold to latest (+20%)
  });
});

describe('simulateExits — stop_loss_15', () => {
  it('fires at -15% when price drops below threshold', () => {
    // entry=0.01, final=0.01 (0%), latest=0.005 (-50%) → SL15 fires at latest
    const s = simulateExits(snaps(0.01, 0.01, 0.005), 0.01);
    expect(s.stop_loss_15).toBeCloseTo(-15, 3);
  });

  it('holds when price never drops -15%', () => {
    // min return is -10%
    const s = simulateExits(snaps(0.01, 0.01, 0.009), 0.01);
    expect(s.stop_loss_15).toBeCloseTo(-10, 3); // hold to latest
  });
});

describe('simulateExits — stop_loss_25', () => {
  it('fires at -25% when price drops below threshold', () => {
    const s = simulateExits(snaps(0.01, 0.01, 0.004), 0.01); // latest = -60%
    expect(s.stop_loss_25).toBeCloseTo(-25, 3);
  });

  it('SL15 fires but not SL25 when drop is between -15% and -25%', () => {
    const s = simulateExits(snaps(0.01, 0.01, 0.008), 0.01); // latest = -20%
    expect(s.stop_loss_15).toBeCloseTo(-15, 3);
    expect(s.stop_loss_25).toBeCloseTo(-20, 3); // hold (never hits -25%)
  });
});

describe('simulateExits — trailing_stop_20 after +25%', () => {
  it('does not activate when price never hits +25%', () => {
    // max return = +20%, trail never activates → hold to latest
    const s = simulateExits(snaps(0.01, 0.012, 0.009), 0.01);
    expect(s.trailing_stop_20).toBeCloseTo(-10, 3); // hold to latest
  });

  it('activates at +25% and fires when price drops 20% from peak', () => {
    // entry=0.01, final=0.014 (+40%), latest=0.01 (0%)
    // Activation: final at +40%. Peak = 0.014. Trailing threshold = 0.014 * 0.80 = 0.0112
    // latest = 0.01 < 0.0112 → trailing fires at latest
    const s = simulateExits(snaps(0.01, 0.014, 0.01), 0.01);
    expect(s.trailing_stop_20).toBeCloseTo(0, 3); // exit at 0.01 = 0% return
  });

  it('holds when activated but trailing never breached', () => {
    // entry=0.01, final=0.013 (+30%), latest=0.012 (+20%)
    // Activation at final (+30%). Peak = 0.013. Threshold = 0.013 * 0.80 = 0.0104
    // latest = 0.012 > 0.0104 → trailing never fires → hold to latest
    const s = simulateExits(snaps(0.01, 0.013, 0.012), 0.01);
    expect(s.trailing_stop_20).toBeCloseTo(20, 3); // hold to latest (+20%)
  });
});

describe('simulateExits — sparse flag', () => {
  it('isSparse = true when fewer than 4 snapshots', () => {
    expect(simulateExits(snaps(0.01, 0.01, 0.015), 0.01).isSparse).toBe(true); // 3 snaps
  });

  it('isSparse = false with 4+ snapshots', () => {
    const fourSnaps: PriceSnapshot[] = [
      { priceUsd: 0.01,  observedAt: '2026-06-10T08:43:00.000Z', label: 'entry'  },
      { priceUsd: 0.011, observedAt: '2026-06-10T08:44:00.000Z', label: 'final'  },
      { priceUsd: 0.012, observedAt: '2026-06-10T09:00:00.000Z', label: 'latest' },
      { priceUsd: 0.013, observedAt: '2026-06-10T10:00:00.000Z', label: 'latest' },
    ];
    expect(simulateExits(fourSnaps, 0.01).isSparse).toBe(false);
  });
});

describe('simulateExits — bestSimulatedReturn', () => {
  it('best is max across all strategies', () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%)
    // TP25=+25, TP50=hold=-50, SL15=-15, SL25=-25, trail...
    // Trail: activates at final (+40%), latest drops to 0.005 < 0.014*0.8=0.0112 → fires at -50%
    // Best = +25% (TP25)
    const s = simulateExits(snaps(0.01, 0.014, 0.005), 0.01);
    expect(s.bestSimulatedReturn).toBeCloseTo(25, 3);
  });
});

// ── runOutcomeTrackerV2: candidate identification ─────────────────────────────

describe('runOutcomeTrackerV2 — candidate identification', () => {
  it('returns inputMissing=true for nonexistent file', async () => {
    const r = await runOutcomeTrackerV2({ inputPath: '/tmp/nonexistent-v2.jsonl' });
    expect(r.inputMissing).toBe(true);
    expect(r.totalCandidates).toBe(0);
  });

  it('identifies FUTURE_AUTONOMY_CANDIDATE via existing logic', async () => {
    const f = makeLiveFixture({ contract: 'MINT_C', symbol: 'C', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    expect(r.totalCandidates).toBe(1);
  });

  it('builds snapshots from raw.entry and raw.final', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SN', symbol: 'SN', entryPrice: 0.01, finalPrice: 0.011 });
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    const rec = r.records[0]!;
    expect(rec.snapshotCount).toBeGreaterThanOrEqual(2); // entry + final
    expect(rec.snapshots.some(s => s.label === 'entry')).toBe(true);
    expect(rec.snapshots.some(s => s.label === 'final')).toBe(true);
  });

  it('appends latest snapshot when fetch returns a price', async () => {
    const f = makeLiveFixture({ contract: 'MINT_L', symbol: 'L', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_L: 0.015 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    const rec = r.records[0]!;
    expect(rec.snapshots.some(s => s.label === 'latest')).toBe(true);
    expect(rec.latestPriceUsd).toBeCloseTo(0.015, 6);
  });
});

// ── runOutcomeTrackerV2: return computation ───────────────────────────────────

describe('runOutcomeTrackerV2 — return computation', () => {
  it('computes finalReturnPct from entry→final', async () => {
    const f = makeLiveFixture({ contract: 'MINT_FR', symbol: 'FR', entryPrice: 0.01, finalPrice: 0.012 });
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    expect(r.records[0]!.finalReturnPct).toBeCloseTo(20, 3);
  });

  it('computes latestReturnPct from entry→latest', async () => {
    const f = makeLiveFixture({ contract: 'MINT_LR', symbol: 'LR', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_LR: 0.02 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.latestReturnPct).toBeCloseTo(100, 3);
  });

  it('computes maxKnownReturnPct as max across all snapshots', async () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%) → max = +40%
    const f = makeLiveFixture({ contract: 'MINT_MX', symbol: 'MX', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_MX: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.maxKnownReturnPct).toBeCloseTo(40, 3);
  });

  it('computes minKnownReturnPct as min across all snapshots', async () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%) → min = -50%
    const f = makeLiveFixture({ contract: 'MINT_MN', symbol: 'MN', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_MN: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.minKnownReturnPct).toBeCloseTo(-50, 3);
  });

  it('timeToBestKnown is the observedAt of the highest-price snapshot', async () => {
    const f = makeLiveFixture({ contract: 'MINT_TB', symbol: 'TB', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_TB: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    // Best is final at 0.014
    expect(r.records[0]!.timeToBestKnown).toBe('2026-06-10T08:44:15.000Z');
  });
});

// ── runOutcomeTrackerV2: checkpoint classification ────────────────────────────

describe('runOutcomeTrackerV2 — checkpoint status', () => {
  it('HIT_25 when max known return >= 25%', async () => {
    // final = +30% (max), latest = -50%
    const f = makeLiveFixture({ contract: 'MINT_H25', symbol: 'H25', entryPrice: 0.01, finalPrice: 0.013 });
    const fetch = makeFetch({ MINT_H25: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.checkpointStatus).toBe('HIT_25');
    expect(r.hit25Count).toBe(1);
  });

  it('HIT_50 when max known return >= 50%', async () => {
    const f = makeLiveFixture({ contract: 'MINT_H50', symbol: 'H50', entryPrice: 0.01, finalPrice: 0.016 });
    const fetch = makeFetch({ MINT_H50: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.checkpointStatus).toBe('HIT_50');
  });

  it('HIT_100 when max known return >= 100%', async () => {
    const f = makeLiveFixture({ contract: 'MINT_H100', symbol: 'H100', entryPrice: 0.01, finalPrice: 0.025 });
    const fetch = makeFetch({ MINT_H100: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.checkpointStatus).toBe('HIT_100');
  });

  it('NEVER_RIPPED when max known return < 25%', async () => {
    // entry=0.01, final=0.011 (+10%), latest=0.008 (-20%) → max = +10%
    const f = makeLiveFixture({ contract: 'MINT_NR', symbol: 'NR', entryPrice: 0.01, finalPrice: 0.011 });
    const fetch = makeFetch({ MINT_NR: 0.008 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.checkpointStatus).toBe('NEVER_RIPPED');
  });

  it('UNKNOWN when no entry price available', async () => {
    // Make a fixture with no entry price in raw
    const f = makeLiveFixture({ contract: 'MINT_UNK', symbol: 'UNK', entryPrice: 0 });
    // override raw.entry to have no valid price
    (f.raw as Record<string, unknown>)['entry'] = { contract: 'MINT_UNK', observedAt: '2026-06-10T08:43:00.000Z' };
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    // maxKnownReturnPct should be null
    const rec = r.records[0];
    if (rec) {
      expect(rec.checkpointStatus).toBe('UNKNOWN');
    }
  });
});

// ── runOutcomeTrackerV2: exit simulations ─────────────────────────────────────

describe('runOutcomeTrackerV2 — exit simulations', () => {
  it('take_profit_25 fires when final price hits +25%+', async () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%)
    const f = makeLiveFixture({ contract: 'MINT_TP25', symbol: 'TP25', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_TP25: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.exitSimulations.take_profit_25).toBeCloseTo(25, 3);
  });

  it('take_profit_50 fires when a snapshot hits +50%+', async () => {
    // entry=0.01, final=0.02 (+100%), latest=0.005 (-50%)
    const f = makeLiveFixture({ contract: 'MINT_TP50', symbol: 'TP50', entryPrice: 0.01, finalPrice: 0.02 });
    const fetch = makeFetch({ MINT_TP50: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.exitSimulations.take_profit_50).toBeCloseTo(50, 3);
  });

  it('stop_loss_15 fires when a snapshot drops -15%+', async () => {
    // entry=0.01, final=0.01 (0%), latest=0.005 (-50%)
    const f = makeLiveFixture({ contract: 'MINT_SL15', symbol: 'SL15', entryPrice: 0.01, finalPrice: 0.01 });
    const fetch = makeFetch({ MINT_SL15: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.exitSimulations.stop_loss_15).toBeCloseTo(-15, 3);
  });

  it('stop_loss_25 fires when a snapshot drops -25%+', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SL25', symbol: 'SL25', entryPrice: 0.01, finalPrice: 0.01 });
    const fetch = makeFetch({ MINT_SL25: 0.004 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.exitSimulations.stop_loss_25).toBeCloseTo(-25, 3);
  });

  it('trailing_stop_20 activates at +25% and fires on subsequent drop', async () => {
    // entry=0.01, final=0.014 (+40% → activates), latest=0.01 (0%)
    // peak=0.014, threshold=0.0112, latest=0.01 < threshold → fires at 0%
    const f = makeLiveFixture({ contract: 'MINT_TR', symbol: 'TR', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_TR: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    expect(r.records[0]!.exitSimulations.trailing_stop_20).toBeCloseTo(0, 3);
  });
});

// ── runOutcomeTrackerV2: sparse warning ───────────────────────────────────────

describe('runOutcomeTrackerV2 — sparse snapshots', () => {
  it('isSparse=true when fewer than 4 snapshots', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SP', symbol: 'SP', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    expect(r.records[0]!.isSparse).toBe(true);
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('runOutcomeTrackerV2 — safety invariants', () => {
  it('tradingExecuted is always 0', async () => {
    const r = await runOutcomeTrackerV2(makeOptions([], nullFetch));
    expect(r.tradingExecuted).toBe(0);
  });

  it('noRealTradeSent is always true', async () => {
    const r = await runOutcomeTrackerV2(makeOptions([], nullFetch));
    expect(r.noRealTradeSent).toBe(true);
  });

  it('paperOnly is always true', async () => {
    const r = await runOutcomeTrackerV2(makeOptions([], nullFetch));
    expect(r.paperOnly).toBe(true);
  });

  it('readOnly is always true', async () => {
    const r = await runOutcomeTrackerV2(makeOptions([], nullFetch));
    expect(r.readOnly).toBe(true);
  });
});

// ── renderOutcomeTrackerV2Report ─────────────────────────────────────────────

describe('renderOutcomeTrackerV2Report', () => {
  it('includes REAL TRADING LOCKED', async () => {
    const f = makeLiveFixture({ contract: 'MINT_RT', symbol: 'RT', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    expect(renderOutcomeTrackerV2Report(r)).toContain('REAL TRADING LOCKED');
  });

  it('includes REAL TRADING LOCKED on missing-file report', () => {
    const r: Parameters<typeof renderOutcomeTrackerV2Report>[0] = {
      inputPath: '/tmp/none.jsonl', inputMissing: true, generatedAt: '2026-06-10T10:00:00.000Z',
      totalCandidates: 0, hit25Count: 0, hit50Count: 0, hit100Count: 0,
      neverRippedCount: 0, unknownCount: 0, avgLatestReturn: null, avgMaxKnownReturn: null,
      bestCandidate: null, worstCandidate: null, records: [],
      tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
    };
    expect(renderOutcomeTrackerV2Report(r)).toContain('REAL TRADING LOCKED');
  });

  it('warns "Do not go live from this sample size" when < 20 candidates', async () => {
    const f = makeLiveFixture({ contract: 'MINT_WRN', symbol: 'WRN', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    expect(renderOutcomeTrackerV2Report(r)).toContain('Do not go live from this sample size');
  });

  it('warns about sparse path when fewer than 4 snapshots', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SP2', symbol: 'SP2', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    const report = renderOutcomeTrackerV2Report(r);
    expect(report).toContain('sparse');
    expect(report).toContain('directional, not proof');
  });

  it('shows checkpoint status in report', async () => {
    const f = makeLiveFixture({ contract: 'MINT_CS', symbol: 'CS', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_CS: 0.005 });
    const r = await runOutcomeTrackerV2(makeOptions([f], fetch));
    const report = renderOutcomeTrackerV2Report(r);
    expect(report).toContain('HIT_25');
  });

  it('shows exit simulation table', async () => {
    const f = makeLiveFixture({ contract: 'MINT_ES', symbol: 'ES', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    const report = renderOutcomeTrackerV2Report(r);
    expect(report).toContain('EXIT SIMULATION');
    expect(report).toContain('TP25');
    expect(report).toContain('TP50');
  });

  it('does not contain sendTransaction or signTransaction', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NS', symbol: 'NS', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    const report = renderOutcomeTrackerV2Report(r);
    expect(report).not.toContain('sendTransaction');
    expect(report).not.toContain('signTransaction');
    expect(report).not.toContain('swap');
  });

  it('shows tradingExecuted=0 in footer', async () => {
    const f = makeLiveFixture({ contract: 'MINT_FT', symbol: 'FT', entryPrice: 0.01 });
    const r = await runOutcomeTrackerV2(makeOptions([f]));
    expect(renderOutcomeTrackerV2Report(r)).toContain('tradingExecuted=0');
  });
});

// ── loadWatchSnapshots ────────────────────────────────────────────────────────

describe('loadWatchSnapshots', () => {
  it('returns empty map for nonexistent file', () => {
    expect(loadWatchSnapshots('/tmp/nonexistent-watch.jsonl').size).toBe(0);
  });

  it('parses valid watch snapshot lines', () => {
    const path = makeWatchFile([
      { contract: 'MINT_WA', price: 0.015, observedAt: '2026-06-11T08:00:00.000Z' },
    ]);
    const map = loadWatchSnapshots(path);
    expect(map.has('MINT_WA')).toBe(true);
    expect(map.get('MINT_WA')![0]!.priceUsd).toBeCloseTo(0.015, 6);
    expect(map.get('MINT_WA')![0]!.label).toBe('watch');
  });

  it('groups multiple snaps for the same contract', () => {
    const path = makeWatchFile([
      { contract: 'MINT_WB', price: 0.011, observedAt: '2026-06-11T08:00:00.000Z' },
      { contract: 'MINT_WB', price: 0.012, observedAt: '2026-06-11T08:01:00.000Z' },
      { contract: 'MINT_WB', price: 0.013, observedAt: '2026-06-11T08:02:00.000Z' },
    ]);
    const map = loadWatchSnapshots(path);
    expect(map.get('MINT_WB')).toHaveLength(3);
  });

  it('ignores malformed JSON lines without throwing', () => {
    const tmpFile = `/tmp/test-v2-watch-malformed-${++watchCounter}.jsonl`;
    writeFileSync(tmpFile, [
      'not-json',
      JSON.stringify({ contract: 'MINT_WC', latestPriceUsd: 0.01, observedAt: '2026-06-11T08:00:00.000Z' }),
      '{broken}',
      JSON.stringify({ latestPriceUsd: 0.01, observedAt: '2026-06-11T08:01:00.000Z' }), // missing contract
    ].join('\n'));
    const map = loadWatchSnapshots(tmpFile);
    expect(map.has('MINT_WC')).toBe(true);
    expect(map.size).toBe(1);
  });

  it('skips lines with null or zero latestPriceUsd', () => {
    const tmpFile = `/tmp/test-v2-watch-null-price-${++watchCounter}.jsonl`;
    writeFileSync(tmpFile, [
      JSON.stringify({ contract: 'MINT_WD', latestPriceUsd: null,  observedAt: '2026-06-11T08:00:00.000Z' }),
      JSON.stringify({ contract: 'MINT_WD', latestPriceUsd: 0,     observedAt: '2026-06-11T08:01:00.000Z' }),
      JSON.stringify({ contract: 'MINT_WD', latestPriceUsd: -0.01, observedAt: '2026-06-11T08:02:00.000Z' }),
    ].join('\n'));
    expect(loadWatchSnapshots(tmpFile).size).toBe(0);
  });

  it('separates snaps by contract', () => {
    const path = makeWatchFile([
      { contract: 'MINT_X', price: 0.01, observedAt: '2026-06-11T08:00:00.000Z' },
      { contract: 'MINT_Y', price: 0.02, observedAt: '2026-06-11T08:00:00.000Z' },
    ]);
    const map = loadWatchSnapshots(path);
    expect(map.has('MINT_X')).toBe(true);
    expect(map.has('MINT_Y')).toBe(true);
    expect(map.get('MINT_X')).toHaveLength(1);
    expect(map.get('MINT_Y')).toHaveLength(1);
  });
});

// ── buildCandidateSnapshots — watch snapshot merging ─────────────────────────

describe('buildCandidateSnapshots — watch snapshot merging', () => {
  it('merges watch snaps between entry and latest', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: '2026-06-10T08:43:00.000Z' },
    };
    const watchSnaps: PriceSnapshot[] = [
      { priceUsd: 0.012, observedAt: '2026-06-10T09:00:00.000Z', label: 'watch' },
      { priceUsd: 0.013, observedAt: '2026-06-10T09:30:00.000Z', label: 'watch' },
    ];
    const latest: DexPairSnapshot = { contract: 'X', chainId: 'solana', priceUsd: 0.011, observedAt: '2026-06-10T10:00:00.000Z' };
    const result = buildCandidateSnapshots(raw, latest, watchSnaps);
    expect(result).toHaveLength(4); // entry + 2 watch + latest
    expect(result.some(s => s.label === 'watch')).toBe(true);
  });

  it('deduplicates watch snap with same observedAt as entry', () => {
    const sharedAt = '2026-06-10T08:43:00.000Z';
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01, observedAt: sharedAt },
    };
    const watchSnaps: PriceSnapshot[] = [
      { priceUsd: 0.015, observedAt: sharedAt, label: 'watch' }, // duplicate timestamp
    ];
    const result = buildCandidateSnapshots(raw, null, watchSnaps);
    expect(result).toHaveLength(1); // only entry survives
    expect(result[0]!.label).toBe('entry');
  });

  it('remains sorted chronologically with watch snaps inserted', () => {
    const raw: Record<string, unknown> = {
      entry: { priceUsd: 0.01,  observedAt: '2026-06-10T08:43:00.000Z' },
      final: { priceUsd: 0.011, observedAt: '2026-06-10T08:44:00.000Z' },
    };
    const watchSnaps: PriceSnapshot[] = [
      { priceUsd: 0.013, observedAt: '2026-06-10T09:30:00.000Z', label: 'watch' },
      { priceUsd: 0.012, observedAt: '2026-06-10T09:00:00.000Z', label: 'watch' },
    ];
    const result = buildCandidateSnapshots(raw, null, watchSnaps);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.observedAt >= result[i - 1]!.observedAt).toBe(true);
    }
  });
});

// ── runOutcomeTrackerV2 — watch snapshot ingestion ────────────────────────────

describe('runOutcomeTrackerV2 — watch snapshot ingestion', () => {
  it('loads watch snapshots from JSONL and merges them', async () => {
    const contract = 'MINT_WI1';
    const f = makeLiveFixture({ contract, symbol: 'WI1', entryPrice: 0.01 });
    // Without watch snaps: entry + final = 2 snaps
    // With 3 watch snaps: 2 + 3 = 5 snaps
    const watchPath = makeWatchFile([
      { contract, price: 0.011, observedAt: '2026-06-10T09:00:00.000Z' },
      { contract, price: 0.012, observedAt: '2026-06-10T09:30:00.000Z' },
      { contract, price: 0.013, observedAt: '2026-06-10T09:45:00.000Z' },
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(r.records[0]!.snapshotCount).toBe(5); // entry + final + 3 watch
  });

  it('only matches watch snapshots by contract', async () => {
    const contract = 'MINT_WI2';
    const f = makeLiveFixture({ contract, symbol: 'WI2', entryPrice: 0.01 });
    // Watch file has snaps for a DIFFERENT contract
    const watchPath = makeWatchFile([
      { contract: 'MINT_OTHER', price: 0.05, observedAt: '2026-06-10T09:00:00.000Z' },
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    // Still only entry + final (no match for MINT_WI2)
    expect(r.records[0]!.snapshotCount).toBe(2);
  });

  it('ignores malformed JSONL lines in watch file safely', async () => {
    const contract = 'MINT_WI3';
    const f = makeLiveFixture({ contract, symbol: 'WI3', entryPrice: 0.01 });
    const tmpFile = `/tmp/test-v2-watch-bad-${++watchCounter}.jsonl`;
    writeFileSync(tmpFile, [
      'not-json',
      JSON.stringify({ contract, latestPriceUsd: 0.012, observedAt: '2026-06-10T09:00:00.000Z' }),
      '{bad}',
      JSON.stringify({ contract, latestPriceUsd: 0.013, observedAt: '2026-06-10T09:30:00.000Z' }),
    ].join('\n'));
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, tmpFile));
    // 2 valid watch snaps added despite malformed lines
    expect(r.records[0]!.snapshotCount).toBe(4); // entry + final + 2 watch
  });

  it('snapshot count increases with watch snapshots present', async () => {
    const contract = 'MINT_WI4';
    const f = makeLiveFixture({ contract, symbol: 'WI4', entryPrice: 0.01 });
    // Without watch — 2 snaps
    const withoutWatch = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    expect(withoutWatch.records[0]!.snapshotCount).toBe(2);

    // With 2 watch snaps — 4 snaps
    const watchPath = makeWatchFile([
      { contract, price: 0.011, observedAt: '2026-06-10T09:00:00.000Z' },
      { contract, price: 0.012, observedAt: '2026-06-10T09:30:00.000Z' },
    ]);
    const withWatch = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(withWatch.records[0]!.snapshotCount).toBe(4);
  });

  it('sparse warning disappears when watch snapshots bring count to 4+', async () => {
    const contract = 'MINT_WI5';
    const f = makeLiveFixture({ contract, symbol: 'WI5', entryPrice: 0.01 });
    // Without watch: 2 snaps → sparse
    const withoutWatch = await runOutcomeTrackerV2(makeOptions([f], nullFetch));
    expect(withoutWatch.records[0]!.isSparse).toBe(true);

    // With 2 watch snaps: 4 snaps → not sparse
    const watchPath = makeWatchFile([
      { contract, price: 0.011, observedAt: '2026-06-10T09:00:00.000Z' },
      { contract, price: 0.012, observedAt: '2026-06-10T09:30:00.000Z' },
    ]);
    const withWatch = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(withWatch.records[0]!.isSparse).toBe(false);
  });

  it('maxKnownReturnPct uses watch snapshot prices', async () => {
    const contract = 'MINT_WI6';
    // entry=0.01, final=0.01 (0%), watch at 0.015 (+50%)
    const f = makeLiveFixture({ contract, symbol: 'WI6', entryPrice: 0.01, finalPrice: 0.01 });
    const watchPath = makeWatchFile([
      { contract, price: 0.015, observedAt: '2026-06-10T09:00:00.000Z' },
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(r.records[0]!.maxKnownReturnPct).toBeCloseTo(50, 3);
  });

  it('minKnownReturnPct uses watch snapshot prices', async () => {
    const contract = 'MINT_WI7';
    // entry=0.01, final=0.01 (0%), watch at 0.007 (-30%)
    const f = makeLiveFixture({ contract, symbol: 'WI7', entryPrice: 0.01, finalPrice: 0.01 });
    const watchPath = makeWatchFile([
      { contract, price: 0.007, observedAt: '2026-06-10T09:00:00.000Z' },
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(r.records[0]!.minKnownReturnPct).toBeCloseTo(-30, 3);
  });

  it('TP25 fires from watch snapshot price', async () => {
    const contract = 'MINT_WI8';
    // entry=0.01, final=0.01 (0%), watch snapshot at +40% → TP25 should lock in +25%
    const f = makeLiveFixture({ contract, symbol: 'WI8', entryPrice: 0.01, finalPrice: 0.01 });
    const watchPath = makeWatchFile([
      { contract, price: 0.014, observedAt: '2026-06-10T09:00:00.000Z' }, // +40%
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(r.records[0]!.exitSimulations.take_profit_25).toBeCloseTo(25, 3);
  });

  it('SL15 fires from watch snapshot price', async () => {
    const contract = 'MINT_WI9';
    // entry=0.01, final=0.01 (0%), watch snapshot at -20% → SL15 should lock in -15%
    const f = makeLiveFixture({ contract, symbol: 'WI9', entryPrice: 0.01, finalPrice: 0.01 });
    const watchPath = makeWatchFile([
      { contract, price: 0.008, observedAt: '2026-06-10T09:00:00.000Z' }, // -20%
    ]);
    const r = await runOutcomeTrackerV2(makeOptions([f], nullFetch, watchPath));
    expect(r.records[0]!.exitSimulations.stop_loss_15).toBeCloseTo(-15, 3);
  });

  it('does not export sendTransaction, signTransaction, or swap', () => {
    expect(Object.keys(OTV2)).not.toContain('sendTransaction');
    expect(Object.keys(OTV2)).not.toContain('signTransaction');
    expect(Object.keys(OTV2)).not.toContain('swap');
    expect(Object.keys(OTV2)).not.toContain('privateKey');
  });
});
