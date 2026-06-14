import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  WATCH_EARLY_RIP_POLICY_ID,
  WATCH_EARLY_RIP_LIQ_MIN,
  WATCH_EARLY_RIP_VOL_MIN,
  WATCH_EARLY_RIP_PCT_MIN,
  WATCH_EARLY_RIP_PCT_MAX,
  runRipperEarlyWatchPolicyReport,
  renderRipperEarlyWatchPolicyReport,
  type RipperEarlyWatchPolicyResult,
} from '../src/token-grab/ripperEarlyWatchPolicyReport';

// ── Fixture constants ─────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Fixture builders ──────────────────────────────────────────────────────────

interface ObsOpts {
  contract?:      string;
  capturedAt?:    string;
  priceChangePct?: number | null;
  liquidityUsd?:  number | null;
  volumeUsd?:     number | null;
  symbol?:        string;
}

function makeObsFixture(opts: ObsOpts = {}) {
  return {
    buyGateDecision: 'WATCH',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct !== undefined ? opts.priceChangePct : 0.1,
      liquidityUsd:   opts.liquidityUsd  !== undefined ? opts.liquidityUsd : 35_000,
      volumeUsd:      opts.volumeUsd     !== undefined ? opts.volumeUsd : 25_000,
      symbol:         opts.symbol,
    },
  };
}

interface ApprovalOpts {
  contract?:       string;
  capturedAt?:     string;
  priceChangePct?: number;
  liquidityUsd?:   number;
  volumeUsd?:      number;
  gate?:           string;
}

function makeApprovalFixture(opts: ApprovalOpts = {}) {
  return {
    buyGateDecision: opts.gate ?? 'BUY_APPROVED_PAPER',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? 0.5,
      liquidityUsd:   opts.liquidityUsd  ?? 40_000,
      volumeUsd:      opts.volumeUsd     ?? 25_000,
    },
  };
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewpr-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return p;
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('WATCH_EARLY_RIP_POLICY_ID is correct', () => {
    expect(WATCH_EARLY_RIP_POLICY_ID).toBe('WATCH_EARLY_RIP');
  });

  it('WATCH_EARLY_RIP_LIQ_MIN is 30000', () => {
    expect(WATCH_EARLY_RIP_LIQ_MIN).toBe(30_000);
  });

  it('WATCH_EARLY_RIP_VOL_MIN is 20000', () => {
    expect(WATCH_EARLY_RIP_VOL_MIN).toBe(20_000);
  });

  it('WATCH_EARLY_RIP_PCT_MIN is -1', () => {
    expect(WATCH_EARLY_RIP_PCT_MIN).toBe(-1);
  });

  it('WATCH_EARLY_RIP_PCT_MAX is 0.25', () => {
    expect(WATCH_EARLY_RIP_PCT_MAX).toBe(0.25);
  });
});

// ── Policy classification ─────────────────────────────────────────────────────

describe('WATCH_EARLY_RIP policy classification', () => {
  it('classifies a passing observation as a WATCH_EARLY_RIP hit', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 30_000, volumeUsd: 20_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
    expect(r.candidates.length).toBe(1);
  });

  it('rejects priceChangePct > 0.25', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.26, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
    expect(r.candidates.length).toBe(0);
  });

  it('accepts priceChangePct exactly 0.25 (inclusive)', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.25, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });

  it('rejects priceChangePct < -1', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: -1.01, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('accepts priceChangePct exactly -1 (inclusive)', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: -1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });

  it('rejects liquidityUsd < 30000', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 29_999, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('accepts liquidityUsd exactly 30000', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 30_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });

  it('rejects volumeUsd < 20000', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 19_999 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('accepts volumeUsd exactly 20000', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 20_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });

  it('rejects observation with null priceChangePct', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: null, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('rejects observation with null liquidityUsd', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: null, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('rejects observation with null volumeUsd', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: null }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(0);
  });

  it('applies policy regardless of obs buyGateDecision', () => {
    const op = writeJsonl('o.jsonl', [
      { buyGateDecision: 'BUY_REJECTED', capturedAt: BASE_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 } },
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });
});

// ── Hit deduplication ─────────────────────────────────────────────────────────

describe('deduplication and hit counting', () => {
  it('counts total hits separately from unique contracts', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0),     contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(1_000), contract: CONTRACT_A }),  // 2nd hit for same contract
      makeObsFixture({ capturedAt: at(2_000), contract: CONTRACT_B }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(3);
    expect(r.summary.uniqueWatchContracts).toBe(2);
    expect(r.candidates.length).toBe(2);
  });

  it('dedupes to earliest hit per contract', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(5_000), contract: CONTRACT_A, priceChangePct: 0.2 }),  // later
      makeObsFixture({ capturedAt: at(0),     contract: CONTRACT_A, priceChangePct: 0.05 }), // earliest
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].watchPriceChangePct).toBeCloseTo(0.05, 5);
    expect(r.candidates[0].firstWatchAt).toBe(at(0));
  });

  it('uses symbol from first (earliest) hit', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(10_000), contract: CONTRACT_A, symbol: 'LATE' }),
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_A, symbol: 'EARLY' }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates[0].symbol).toBe('EARLY');
  });

  it('trackss uniqueObservedContracts including non-hitting contracts', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ contract: CONTRACT_A }),                                           // hits
      makeObsFixture({ contract: CONTRACT_B, liquidityUsd: 1_000 }),                     // no hit (low liq)
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.uniqueObservedContracts).toBe(2);
    expect(r.summary.watchEarlyRipHits).toBe(1);
  });

  it('accumulates hits across multiple observation files', () => {
    const o1 = writeJsonl('o1.jsonl', [makeObsFixture({ capturedAt: at(0), contract: CONTRACT_A })]);
    const o2 = writeJsonl('o2.jsonl', [makeObsFixture({ capturedAt: at(0), contract: CONTRACT_B })]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [o1, o2], approvalPaths: [] });
    expect(r.summary.watchEarlyRipHits).toBe(2);
    expect(r.candidates.length).toBe(2);
  });

  it('counts missing observation files', () => {
    const r = runRipperEarlyWatchPolicyReport({
      observationPaths: ['/does/not/exist.jsonl'],
      approvalPaths:    [],
    });
    expect(r.summary.observationFilesMissing).toBe(1);
    expect(r.summary.observationFilesRead).toBe(0);
  });

  it('counts missing approval files', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture()]);
    const r = runRipperEarlyWatchPolicyReport({
      observationPaths: [op],
      approvalPaths:    ['/does/not/exist.jsonl'],
    });
    expect(r.summary.approvalFilesMissing).toBe(1);
    expect(r.summary.approvalFilesRead).toBe(0);
  });
});

// ── Approval matching ─────────────────────────────────────────────────────────

describe('approval matching', () => {
  it('matches approval at same time as first watch hit (approvedAt >= firstWatchAt)', () => {
    const watchAt    = at(0);
    const approvedAt = at(0);  // same ms — counts as later
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: watchAt })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: approvedAt })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterApproved).toBe(true);
    expect(r.candidates[0].approvedAt).toBe(approvedAt);
  });

  it('matches approval strictly after first watch hit', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(60_000) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterApproved).toBe(true);
  });

  it('does not count approval before first watch hit', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(60_000) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(0) })]);  // before watch
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterApproved).toBe(false);
    expect(r.candidates[0].approvedAt).toBeNull();
  });

  it('takes earliest later approval when multiple exist for contract', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(120_000) }),  // 2m later
      makeApprovalFixture({ capturedAt: at(60_000) }),   // 1m later — earliest
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].approvedAt).toBe(at(60_000));
  });

  it('ignores non-BUY_APPROVED_PAPER fixtures in approval files', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(60_000), gate: 'WATCH' })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterApproved).toBe(false);
  });

  it('does not match approval for a different contract', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0), contract: CONTRACT_A })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_B })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterApproved).toBe(false);
  });

  it('deduplicates identical contract+capturedAt approval fixtures', () => {
    const iso = at(60_000);
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: iso }),
      makeApprovalFixture({ capturedAt: iso }),  // duplicate
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.approvalsLoaded).toBe(1);
  });

  it('computes minutesToApproval correctly', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(120_000) })]);  // 2m
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].minutesToApproval).toBeCloseTo(2.0, 5);
  });

  it('minutesToApproval is 0 when approval at same ms as watch hit', () => {
    const iso = at(0);
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: iso })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: iso })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].minutesToApproval).toBe(0);
  });

  it('minutesToApproval is null when not approved', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates[0].minutesToApproval).toBeNull();
  });
});

// ── Outcome classification ────────────────────────────────────────────────────

describe('outcome classification', () => {
  it('laterPriceGt025 true when approvalPriceChangePct > 0.25', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 0.3 })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterPriceGt025).toBe(true);
  });

  it('laterPriceGt025 false when approvalPriceChangePct = 0.25 (not strictly greater)', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 0.25 })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterPriceGt025).toBe(false);
  });

  it('laterPriceGt025 false when not approved', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates[0].laterPriceGt025).toBe(false);
  });

  it('laterFullCombo true when price > 0.25, liq >= 30k, vol >= 20k at approval', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 0.5, liquidityUsd: 30_000, volumeUsd: 20_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterFullCombo).toBe(true);
  });

  it('laterFullCombo false when approval liq below 30k', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 0.5, liquidityUsd: 29_999, volumeUsd: 20_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterFullCombo).toBe(false);
  });

  it('laterFullCombo false when approval vol below 20k', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 0.5, liquidityUsd: 40_000, volumeUsd: 19_999 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.candidates[0].laterFullCombo).toBe(false);
  });

  it('laterFullCombo false when not approved', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates[0].laterFullCombo).toBe(false);
  });

  it('extracts approvalPriceChangePct, approvalLiquidityUsd, approvalVolumeUsd', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), priceChangePct: 1.23, liquidityUsd: 55_000, volumeUsd: 31_000 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    const c = r.candidates[0];
    expect(c.approvalPriceChangePct).toBe(1.23);
    expect(c.approvalLiquidityUsd).toBe(55_000);
    expect(c.approvalVolumeUsd).toBe(31_000);
  });

  it('approval fields are null when not approved', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    const c  = r.candidates[0];
    expect(c.approvalPriceChangePct).toBeNull();
    expect(c.approvalLiquidityUsd).toBeNull();
    expect(c.approvalVolumeUsd).toBeNull();
    expect(c.approvedAt).toBeNull();
  });
});

// ── Summary and funnel ────────────────────────────────────────────────────────

describe('summary and funnel', () => {
  it('hitsLaterApproved counts unique candidates that were approved', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(10_000), contract: CONTRACT_B }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_A }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.hitsLaterApproved).toBe(1);
    expect(r.summary.hitsLaterPriceGt025).toBe(1);  // default approvalPriceChangePct = 0.5
  });

  it('hitsLaterPriceGt025 counts candidates where approval pct > 0.25', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(10_000), contract: CONTRACT_B }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_A, priceChangePct: 0.5 }),
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_B, priceChangePct: 0.1 }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.hitsLaterPriceGt025).toBe(1);
  });

  it('hitsLaterFullCombo counts full combo approvals', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_B }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_A, priceChangePct: 0.5, liquidityUsd: 30_000, volumeUsd: 20_000 }),
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_B, priceChangePct: 0.5, liquidityUsd: 10_000, volumeUsd: 20_000 }), // low liq
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.hitsLaterFullCombo).toBe(1);
  });

  it('avgMinutesToApproval is null when no approvals', () => {
    const op = writeJsonl('o.jsonl', [makeObsFixture({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.summary.avgMinutesToApproval).toBeNull();
    expect(r.summary.medianMinutesToApproval).toBeNull();
  });

  it('avgMinutesToApproval averaged over approved candidates', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_B }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000),  contract: CONTRACT_A }),  // 1m
      makeApprovalFixture({ capturedAt: at(180_000), contract: CONTRACT_B }),  // 3m
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.avgMinutesToApproval).toBeCloseTo(2.0, 3);
    expect(r.summary.medianMinutesToApproval).toBeCloseTo(2.0, 3);
  });

  it('medianMinutesToApproval with odd count picks middle', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_B }),
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_C }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000),  contract: CONTRACT_A }),   // 1m
      makeApprovalFixture({ capturedAt: at(120_000), contract: CONTRACT_B }),   // 2m
      makeApprovalFixture({ capturedAt: at(300_000), contract: CONTRACT_C }),   // 5m
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.summary.medianMinutesToApproval).toBeCloseTo(2.0, 3);
  });

  it('funnel totalUniqueCandidates matches candidates.length', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ contract: CONTRACT_A }),
      makeObsFixture({ contract: CONTRACT_B }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.funnel.totalUniqueCandidates).toBe(r.candidates.length);
    expect(r.funnel.totalUniqueCandidates).toBe(2);
  });

  it('funnel laterApprovedPct is correct', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_A }),
      makeObsFixture({ capturedAt: at(0), contract: CONTRACT_B }),
    ]);
    const ap = writeJsonl('a.jsonl', [
      makeApprovalFixture({ capturedAt: at(60_000), contract: CONTRACT_A }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [ap] });
    expect(r.funnel.laterApprovedCount).toBe(1);
    expect(r.funnel.laterApprovedPct).toBeCloseTo(50, 5);
    expect(r.funnel.neverApprovedCount).toBe(1);
    expect(r.funnel.neverApprovedPct).toBeCloseTo(50, 5);
  });

  it('funnel Pcts are null when no candidates', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.funnel.totalUniqueCandidates).toBe(0);
    expect(r.funnel.laterApprovedPct).toBeNull();
    expect(r.funnel.laterPriceGt025Pct).toBeNull();
    expect(r.funnel.laterFullComboPct).toBeNull();
    expect(r.funnel.neverApprovedPct).toBeNull();
  });

  it('candidates sorted by firstWatchAt ascending', () => {
    const op = writeJsonl('o.jsonl', [
      makeObsFixture({ capturedAt: at(10_000), contract: CONTRACT_B }),
      makeObsFixture({ capturedAt: at(0),      contract: CONTRACT_A }),
    ]);
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [op], approvalPaths: [] });
    expect(r.candidates[0].contractKey).toBe(CONTRACT_A);
    expect(r.candidates[1].contractKey).toBe(CONTRACT_B);
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('realTradingLocked is true', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.realTradingLocked).toBe(true);
  });

  it('tradingExecuted is 0', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.tradingExecuted).toBe(0);
  });

  it('noRealTradeSent is true', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.noRealTradeSent).toBe(true);
  });

  it('paperOnly is true', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.paperOnly).toBe(true);
  });

  it('readOnly is true', () => {
    const r = runRipperEarlyWatchPolicyReport({ observationPaths: [], approvalPaths: [] });
    expect(r.readOnly).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  function makeResult(overrides: Partial<RipperEarlyWatchPolicyResult> = {}): RipperEarlyWatchPolicyResult {
    return {
      generatedAt: BASE_ISO,
      summary: {
        observationFilesRead:    2,
        observationFilesMissing: 0,
        approvalFilesRead:       1,
        approvalFilesMissing:    0,
        observationsLoaded:      10,
        approvalsLoaded:         3,
        uniqueObservedContracts: 5,
        watchEarlyRipHits:       4,
        uniqueWatchContracts:    3,
        hitsLaterApproved:       2,
        hitsLaterPriceGt025:     2,
        hitsLaterFullCombo:      1,
        avgMinutesToApproval:    30,
        medianMinutesToApproval: 28,
      },
      funnel: {
        totalUniqueCandidates: 3,
        laterApprovedCount:    2,
        laterApprovedPct:      66.7,
        laterPriceGt025Count:  2,
        laterPriceGt025Pct:    66.7,
        laterFullComboCount:   1,
        laterFullComboPct:     33.3,
        neverApprovedCount:    1,
        neverApprovedPct:      33.3,
      },
      candidates: [],
      realTradingLocked: true,
      tradingExecuted:   0,
      noRealTradeSent:   true,
      paperOnly:         true,
      readOnly:          true,
      ...overrides,
    };
  }

  it('contains REPORT ONLY header', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('REPORT ONLY');
  });

  it('contains EARLY WATCH POLICY SUMMARY section', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('EARLY WATCH POLICY SUMMARY');
  });

  it('contains WATCH_EARLY_RIP OUTCOME FUNNEL section', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('WATCH_EARLY_RIP OUTCOME FUNNEL');
  });

  it('contains WATCH_EARLY_RIP DETAILS section', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('WATCH_EARLY_RIP DETAILS');
  });

  it('shows (no WATCH_EARLY_RIP candidates) when empty', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult({ candidates: [] }));
    expect(out).toContain('no WATCH_EARLY_RIP candidates');
  });

  it('renders candidate row with symbol', () => {
    const c = {
      contractKey:            CONTRACT_A,
      contractKeyShort:       'ContractAAAAAAAA…',
      symbol:                 'WATCH1',
      firstWatchAt:           BASE_ISO,
      watchPriceChangePct:    0.1,
      watchLiquidityUsd:      35_000,
      watchVolumeUsd:         22_000,
      laterApproved:          true,
      approvedAt:             at(60_000),
      minutesToApproval:      1.0,
      approvalPriceChangePct: 0.5,
      approvalLiquidityUsd:   40_000,
      approvalVolumeUsd:      25_000,
      laterPriceGt025:        true,
      laterFullCombo:         true,
    };
    const out = renderRipperEarlyWatchPolicyReport(makeResult({ candidates: [c] }));
    expect(out).toContain('$WATCH1');
    expect(out).toContain('yes');
  });

  it('renders candidate row with "missing" for unapproved candidate', () => {
    const c = {
      contractKey:            CONTRACT_B,
      contractKeyShort:       'ContractBBBBBBBB…',
      firstWatchAt:           BASE_ISO,
      watchPriceChangePct:    0.05,
      watchLiquidityUsd:      32_000,
      watchVolumeUsd:         21_000,
      laterApproved:          false,
      approvedAt:             null,
      minutesToApproval:      null,
      approvalPriceChangePct: null,
      approvalLiquidityUsd:   null,
      approvalVolumeUsd:      null,
      laterPriceGt025:        false,
      laterFullCombo:         false,
    };
    const out = renderRipperEarlyWatchPolicyReport(makeResult({ candidates: [c] }));
    expect(out).toContain('missing');
    expect(out).toContain('no');
  });

  it('contains DO NOT APPLY YET section', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('DO NOT APPLY YET');
  });

  it('contains safety footer with realTradingLocked and reportOnly', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('reportOnly=true');
  });

  it('shows policy thresholds in header', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('WATCH_EARLY_RIP');
    expect(out).toContain('30,000');
    expect(out).toContain('20,000');
  });

  it('shows funnel counts', () => {
    const out = renderRipperEarlyWatchPolicyReport(makeResult());
    expect(out).toContain('Total unique candidates');
    expect(out).toContain('Later approved');
    expect(out).toContain('Never approved');
  });
});
