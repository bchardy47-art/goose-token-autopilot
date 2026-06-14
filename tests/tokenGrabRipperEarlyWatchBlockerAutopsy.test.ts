import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  runRipperEarlyWatchBlockerAutopsy,
  renderRipperEarlyWatchBlockerAutopsy,
  type BlockerLabel,
} from '../src/token-grab/ripperEarlyWatchBlockerAutopsy';

// ── Fixture constants ─────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Fixture builders ──────────────────────────────────────────────────────────

interface ObsOpts {
  contract?:        string;
  capturedAt?:      string;
  priceChangePct?:  number | null;
  liquidityUsd?:    number | null;
  volumeUsd?:       number | null;
  symbol?:          string;
  buyGateDecision?: string;
  blockers?:        string[];
  ripperScore?:     number;
  holderRiskHint?:  string | null;
  clusterRiskHint?: string | null;
  rawClusterRisk?:  string | null;
  rawHolderRisk?:   string | null;
  slippageBps?:     number | null;
  quote?:           unknown;
}

function makeObs(opts: ObsOpts = {}) {
  const raw: Record<string, unknown> = {};
  if (opts.rawClusterRisk !== undefined) raw['clusterRisk'] = opts.rawClusterRisk;
  if (opts.rawHolderRisk  !== undefined) raw['holderRisk']  = opts.rawHolderRisk;

  const sig: Record<string, unknown> = {
    id:            `id:${opts.contract ?? CONTRACT_A}`,
    source:        'test',
    sourceKind:    'DEX_NEW_POOL',
    contract:      opts.contract ?? CONTRACT_A,
    symbol:        opts.symbol,
    discoveredAt:  opts.capturedAt ?? BASE_ISO,
    observedAt:    opts.capturedAt ?? BASE_ISO,
    confidence:    'LOW',
    signalReasons: [],
    warnings:      [],
    priceChangePct: opts.priceChangePct !== undefined ? opts.priceChangePct : 0.1,
    liquidityUsd:   opts.liquidityUsd  !== undefined ? opts.liquidityUsd : 35_000,
    volumeUsd:      opts.volumeUsd     !== undefined ? opts.volumeUsd : 25_000,
    holderRiskHint:  opts.holderRiskHint  ?? null,
    clusterRiskHint: opts.clusterRiskHint ?? null,
  };
  if (opts.slippageBps !== undefined) sig['slippageBps'] = opts.slippageBps;
  if (opts.quote       !== undefined) sig['quote']       = opts.quote;

  return {
    capturedAt:       opts.capturedAt ?? BASE_ISO,
    buyGateDecision:  opts.buyGateDecision ?? 'WATCH',
    blockers:         opts.blockers ?? [],
    ripperScore:      opts.ripperScore,
    raw,
    normalizedSignal: sig,
  };
}

function makeApproval(opts: { contract?: string; capturedAt?: string } = {}) {
  return {
    capturedAt:       opts.capturedAt ?? BASE_ISO,
    buyGateDecision:  'BUY_APPROVED_PAPER',
    blockers:         [],
    normalizedSignal: {
      id:            `id:${opts.contract ?? CONTRACT_A}`,
      source:        'test',
      sourceKind:    'DEX_NEW_POOL',
      contract:      opts.contract ?? CONTRACT_A,
      discoveredAt:  opts.capturedAt ?? BASE_ISO,
      observedAt:    opts.capturedAt ?? BASE_ISO,
      confidence:    'LOW',
      signalReasons: [],
      warnings:      [],
      priceChangePct: 0.5,
      liquidityUsd:   40_000,
      volumeUsd:      25_000,
    },
  };
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewba-')); });
afterEach(()  => { fs.rmSync(tmpDir, { recursive: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return p;
}

// ── Candidate filtering ───────────────────────────────────────────────────────

describe('candidate filtering', () => {
  it('includes contract where best later pct > 0.25 and no approval', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
    expect(r.totalPriceMovedCount).toBe(1);
    expect(r.totalPriceMovedCandidates).toBe(1);
    expect(r.excludedObsApproved).toBe(0);
    expect(r.excludedFileApproved).toBe(0);
  });

  it('excludes contract that got BUY_APPROVED_PAPER in approval file', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const ap = writeJsonl('a.jsonl', [makeApproval({ capturedAt: at(60_000) })]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.rows.length).toBe(0);
    expect(r.totalPriceMovedCandidates).toBe(1);
    expect(r.excludedFileApproved).toBe(1);
    expect(r.excludedObsApproved).toBe(0);
  });

  it('excludes contract whose observation fixture has buyGateDecision BUY_APPROVED_PAPER', () => {
    // The best-move observation itself carries gateDecision BUY_APPROVED_PAPER —
    // this was the live bug: candidates like $SPCX were mis-classified as non-approved.
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
                buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(0);
    expect(r.totalPriceMovedCandidates).toBe(1);
    expect(r.excludedObsApproved).toBe(1);
    expect(r.excludedFileApproved).toBe(0);
  });

  it('excludes via obs gate even when approval file is absent', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(5_000),  priceChangePct: 0.3, liquidityUsd: 35_000, volumeUsd: 25_000,
                buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.8, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(0);
    expect(r.excludedObsApproved).toBe(1);
  });

  it('obs-gate approval before firstWatchAt does not exclude candidate', () => {
    // Approval in obs file that is BEFORE the first watch hit should not count.
    const op = writeJsonl('o.jsonl', [
      // obs with BUY_APPROVED_PAPER before the WATCH_EARLY_RIP hit
      makeObs({ capturedAt: at(0), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
                buyGateDecision: 'BUY_APPROVED_PAPER' }),
      // first WATCH_EARLY_RIP hit (comes later in time)
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      // later obs that pushes pct above 0.25
      makeObs({ capturedAt: at(20_000), priceChangePct: 0.4, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    // The BUY_APPROVED_PAPER was BEFORE firstWatchAt (at 10_000), so should not exclude
    expect(r.rows.length).toBe(1);
    expect(r.excludedObsApproved).toBe(0);
  });

  it('two candidates: one obs-approved excluded, one true miss included', () => {
    const op = writeJsonl('o.jsonl', [
      // CONTRACT_A: obs approved
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A, priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_A, priceChangePct: 0.5,
                liquidityUsd: 35_000, volumeUsd: 25_000, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      // CONTRACT_B: true miss
      makeObs({ capturedAt: at(0),      contract: CONTRACT_B, priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_B, priceChangePct: 0.4,
                liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.totalPriceMovedCandidates).toBe(2);
    expect(r.excludedObsApproved).toBe(1);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].contractKey).toBe(CONTRACT_B);
  });

  it('excludes contract whose best later pct does not exceed 0.25', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.2, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(0);
  });

  it('excludes contract that never matched WATCH_EARLY_RIP policy', () => {
    const op = writeJsonl('o.jsonl', [
      // liquidityUsd too low to match WATCH_EARLY_RIP at first obs
      makeObs({ capturedAt: at(0), priceChangePct: 0.1, liquidityUsd: 5_000 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 5_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(0);
  });

  it('only counts later obs (strictly after firstWatchAt) for best move', () => {
    // The first watch hit itself has pct = 0.1 — only obs after it can trigger PRICE_MOVED
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0), priceChangePct: 0.1 }),
      // obs at same ms should not count as "later"
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(0);
  });
});

// ── Row fields ────────────────────────────────────────────────────────────────

describe('row fields', () => {
  it('firstWatchAt is earliest WATCH_EARLY_RIP hit', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(5_000), priceChangePct: 0.2 }),
      makeObs({ capturedAt: at(0),     priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].firstWatchAt).toBe(at(0));
    expect(r.rows[0].watchPriceChangePct).toBeCloseTo(0.1, 5);
  });

  it('bestMoveAt is timestamp of obs with max priceChangePct after firstWatchAt', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(5_000),  priceChangePct: 0.3, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.8, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(15_000), priceChangePct: 0.4, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].bestMoveAt).toBe(at(10_000));
    expect(r.rows[0].bestPriceChangePct).toBeCloseTo(0.8, 5);
  });

  it('bestLiquidityUsd and bestVolumeUsd come from best-move obs', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, liquidityUsd: 42_000, volumeUsd: 31_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].bestLiquidityUsd).toBe(42_000);
    expect(r.rows[0].bestVolumeUsd).toBe(31_000);
  });

  it('latestPriceChangePct is from most recent obs regardless of value', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(20_000), priceChangePct: 0.05, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].latestPriceChangePct).toBeCloseTo(0.05, 5);
  });

  it('bestMoveGateDecision comes from best-move fixture', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, buyGateDecision: 'BUY_REJECTED',
                liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].bestMoveGateDecision).toBe('BUY_REJECTED');
  });

  it('bestMoveRipperScore comes from best-move fixture', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, ripperScore: 77,
                liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].bestMoveRipperScore).toBe(77);
  });

  it('engineBlockers come from best-move fixture blockers array', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000,
                blockers: ['score 55 below buy threshold 65'] }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].engineBlockers).toContain('score 55 below buy threshold 65');
  });

  it('symbol comes from first-hit normalizedSignal', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1, symbol: 'TKNA' }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].symbol).toBe('TKNA');
  });
});

// ── Derived blocker detection ─────────────────────────────────────────────────

describe('derived blocker detection', () => {
  function derivedBlockersFor(bestMoveOpts: ObsOpts): BlockerLabel[] {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0), priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), ...bestMoveOpts }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    if (r.rows.length === 0) throw new Error('No rows — best pct may not exceed 0.25');
    return r.rows[0].derivedBlockers;
  }

  it('LOW_LIQUIDITY_AT_BEST when liquidityUsd < 30000 at best move', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 15_000, volumeUsd: 25_000,
    });
    expect(blockers).toContain('LOW_LIQUIDITY_AT_BEST');
  });

  it('LOW_VOLUME_AT_BEST when volumeUsd < 20000 at best move', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 5_000,
    });
    expect(blockers).toContain('LOW_VOLUME_AT_BEST');
  });

  it('PRICE_ALREADY_MOVED_TOO_FAR when priceChangePct > 1.0', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 1.5, liquidityUsd: 35_000, volumeUsd: 25_000,
    });
    expect(blockers).toContain('PRICE_ALREADY_MOVED_TOO_FAR');
  });

  it('does not flag PRICE_ALREADY_MOVED_TOO_FAR when pct exactly 1.0', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 1.0, liquidityUsd: 35_000, volumeUsd: 25_000,
    });
    expect(blockers).not.toContain('PRICE_ALREADY_MOVED_TOO_FAR');
  });

  it('HOLDER_RISK when holderRiskHint = RISKY', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      holderRiskHint: 'RISKY',
    });
    expect(blockers).toContain('HOLDER_RISK');
  });

  it('no HOLDER_RISK when holderRiskHint = CLEAN', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      holderRiskHint: 'CLEAN',
    });
    expect(blockers).not.toContain('HOLDER_RISK');
  });

  it('CLUSTER_RISK when clusterRiskHint contains RISK', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      holderRiskHint: null, clusterRiskHint: 'CLUSTER_RISK_HIGH',
    });
    expect(blockers).toContain('CLUSTER_RISK');
  });

  it('SAFETY_NOT_ENRICHED when both holderRiskHint and clusterRiskHint are null', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      holderRiskHint: null, clusterRiskHint: null,
    });
    expect(blockers).toContain('SAFETY_NOT_ENRICHED');
  });

  it('UNKNOWN_BLOCKER is absent when another derived blocker fires', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 5_000, volumeUsd: 25_000,
    });
    expect(blockers).toContain('LOW_LIQUIDITY_AT_BEST');
    expect(blockers).not.toContain('UNKNOWN_BLOCKER');
  });

  it('UNKNOWN_BLOCKER when no field-based blocker applies and enrichment is present', () => {
    // holderRiskHint = CLEAN means no enrichment concern, no low liq/vol, no big move
    // This is a well-behaved candidate that still didn't graduate — UNKNOWN_BLOCKER
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      holderRiskHint: 'CLEAN',
    });
    expect(blockers).toContain('UNKNOWN_BLOCKER');
  });

  it('CLUSTER_RISK when raw.clusterRisk = WATCH (production field path)', () => {
    // Production fixtures put clusterRisk on raw, not on normalizedSignal.
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      rawClusterRisk: 'WATCH',
    });
    expect(blockers).toContain('CLUSTER_RISK');
    expect(blockers).not.toContain('SAFETY_NOT_ENRICHED');
  });

  it('HOLDER_RISK when raw.holderRisk = RISKY (production field path)', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      rawHolderRisk: 'RISKY',
    });
    expect(blockers).toContain('HOLDER_RISK');
    expect(blockers).not.toContain('SAFETY_NOT_ENRICHED');
  });

  it('SLIPPAGE_MISSING when slippageBps field is present but null', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      slippageBps: null,
    });
    expect(blockers).toContain('SLIPPAGE_MISSING');
  });

  it('SLIPPAGE_TOO_HIGH when slippageBps > 500', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      slippageBps: 750,
    });
    expect(blockers).toContain('SLIPPAGE_TOO_HIGH');
  });

  it('no SLIPPAGE_* when slippageBps field is absent (conservative)', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
    });
    expect(blockers).not.toContain('SLIPPAGE_MISSING');
    expect(blockers).not.toContain('SLIPPAGE_TOO_HIGH');
  });

  it('QUOTE_MISSING when quote field is present but null', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      quote: null,
    });
    expect(blockers).toContain('QUOTE_MISSING');
  });

  it('no QUOTE_MISSING when quote field is absent (conservative)', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
    });
    expect(blockers).not.toContain('QUOTE_MISSING');
  });

  it('no QUOTE_MISSING when quote field is a truthy object', () => {
    const blockers = derivedBlockersFor({
      capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
      quote: { priceUsd: 1.0 },
    });
    expect(blockers).not.toContain('QUOTE_MISSING');
  });
});

// ── Multi-contract and sorting ────────────────────────────────────────────────

describe('multi-contract and sorting', () => {
  it('returns one row per PRICE_MOVED contract', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_A, priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(0),      contract: CONTRACT_B }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_B, priceChangePct: 0.4, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows.length).toBe(2);
  });

  it('excludes contract B that got approved while A did not', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_A, priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(0),      contract: CONTRACT_B }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_B, priceChangePct: 0.4, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const ap = writeJsonl('a.jsonl', [makeApproval({ contract: CONTRACT_B, capturedAt: at(60_000) })]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
  });

  it('rows sorted by firstWatchAt ascending', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_B }),
      makeObs({ capturedAt: at(20_000), contract: CONTRACT_B, priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObs({ capturedAt: at(5_000),  contract: CONTRACT_A, priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
    expect(r.rows[1].contractKey).toBe(CONTRACT_B);
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('reportOnly is true', () => {
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    expect(r.reportOnly).toBe(true);
  });

  it('readOnly is true', () => {
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    expect(r.readOnly).toBe(true);
  });

  it('tradingExecuted is 0', () => {
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    expect(r.tradingExecuted).toBe(0);
  });

  it('realTradingLocked is true', () => {
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    expect(r.realTradingLocked).toBe(true);
  });

  it('paperOnly is true', () => {
    const r = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    expect(r.paperOnly).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('contains REPORT ONLY header', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('REPORT ONLY');
  });

  it('shows empty message when no PRICE_MOVED candidates', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('no PRICE_MOVED candidates to autopsy');
  });

  it('shows exclusion summary counts in header', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
                buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('PRICE_MOVED candidates');
    expect(out).toContain('excluded (obs approved)');
    expect(out).toContain('True non-approved');
  });

  it('renders candidate section with symbol when present', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0), priceChangePct: 0.1, symbol: 'FOO' }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.6, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('$FOO');
  });

  it('renders first/best/latest sections for each candidate', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('At first watch');
    expect(out).toContain('At best move');
    expect(out).toContain('Latest observed');
  });

  it('renders engine blockers section', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000,
                blockers: ['score too low'] }),
    ]);
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('Engine blockers');
    expect(out).toContain('score too low');
  });

  it('renders derived blocker labels', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 5_000, volumeUsd: 25_000 }),
    ]);
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [op], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('Derived blocker labels');
    expect(out).toContain('LOW_LIQUIDITY_AT_BEST');
  });

  it('contains safety footer with all required flags', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('readOnly=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('paperOnly=true');
  });

  it('contains DO NOT ENABLE REAL TRADING', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('contains DO NOT CALL AUTO-PAPER', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('DO NOT CALL AUTO-PAPER');
  });

  it('contains BLOCKER LABEL KEY section', () => {
    const r   = runRipperEarlyWatchBlockerAutopsy({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchBlockerAutopsy(r);
    expect(out).toContain('BLOCKER LABEL KEY');
    expect(out).toContain('SAFETY_NOT_ENRICHED');
    expect(out).toContain('UNKNOWN_BLOCKER');
  });
});
