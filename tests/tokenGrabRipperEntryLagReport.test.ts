import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperEntryLagReport,
  renderRipperEntryLagReport,
  FULL_COMBO_LAG_POLICY_ID,
} from '../src/token-grab/ripperEntryLagReport';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Contract keys ─────────────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeApprovalFixture(opts: {
  contract?:      string;
  symbol?:        string;
  capturedAt?:    string;
  priceChangePct?: number | null;
  liquidityUsd?:  number | null;
  volumeUsd?:     number | null;
  buyGateDecision?: string;
} = {}) {
  const sig: Record<string, unknown> = {
    id:           'sig-id',
    source:       'test',
    sourceKind:   'dex',
    discoveredAt: BASE_ISO,
    contract:     opts.contract ?? CONTRACT_A,
    symbol:       opts.symbol,
    warnings:     [],
  };
  if (opts.priceChangePct !== undefined) sig['priceChangePct'] = opts.priceChangePct;
  if (opts.liquidityUsd  !== undefined) sig['liquidityUsd']   = opts.liquidityUsd;
  if (opts.volumeUsd     !== undefined) sig['volumeUsd']      = opts.volumeUsd;
  return {
    id:               'fix-id',
    capturedAt:       opts.capturedAt ?? BASE_ISO,
    source:           'test',
    sourceKind:       'dex',
    normalizedSignal: sig,
    ripperInput:      null,
    ripperScore:      85,
    ageMinutes:       6,
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    raw:              { clusterRisk: 'CLEAN' },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function makeObsFixture(opts: {
  contract?:      string;
  capturedAt?:    string;
  priceChangePct?: number | null;
} = {}) {
  const sig: Record<string, unknown> = {
    id:           'obs-id',
    source:       'test',
    sourceKind:   'dex',
    discoveredAt: BASE_ISO,
    contract:     opts.contract ?? CONTRACT_A,
    warnings:     [],
  };
  if (opts.priceChangePct !== undefined) sig['priceChangePct'] = opts.priceChangePct;
  return {
    id:               'obs-fix-id',
    capturedAt:       opts.capturedAt ?? BASE_ISO,
    source:           'test',
    sourceKind:       'dex',
    normalizedSignal: sig,
    ripperInput:      null,
    ripperScore:      75,
    ageMinutes:       10,
    buyGateDecision:  'WATCH',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('FULL_COMBO_LAG_POLICY_ID', () => {
  it('equals price_gt_0_25_and_liq_30k_and_vol_20k', () => {
    expect(FULL_COMBO_LAG_POLICY_ID).toBe('price_gt_0_25_and_liq_30k_and_vol_20k');
  });
});

// ── Data loading ──────────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — data loading', () => {
  it('loads only BUY_APPROVED_PAPER fixtures', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(1);
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(1);
  });

  it('skips exact duplicate approvals (same contractKey + capturedAt)', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(1);
  });

  it('keeps two instances of same contract at different capturedAt', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: at(-60_000) }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(2);
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(2);
  });

  it('reports missing approval files gracefully', () => {
    const result = runRipperEntryLagReport({ approvalPaths: ['/no/such.jsonl'], observationPaths: [] });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.approvalsLoaded).toBe(0);
  });

  it('loads observations from JSONL', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, priceChangePct: 2.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.observationsLoaded).toBe(1);
  });

  it('reports missing observation files gracefully', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: ['/no/obs.jsonl'] });
    expect(result.observationFilesMissing).toBe(1);
    expect(result.observationsLoaded).toBe(0);
  });

  it('extracts approvalPriceChangePct, liquidityUsd, volumeUsd from approval signal', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 3.5, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.approvalPriceChangePct).toBe(3.5);
    expect(cand.liquidityUsd).toBe(50_000);
    expect(cand.volumeUsd).toBe(25_000);
  });
});

// ── firstSeenAt / lagMinutes ──────────────────────────────────────────────────

describe('runRipperEntryLagReport — firstSeenAt and lagMinutes', () => {
  it('hasObservation=false when no observations exist for contract', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(false);
    expect(cand.firstSeenAt).toBeNull();
    expect(cand.lagMinutes).toBeNull();
  });

  it('hasObservation=true when observations exist', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(true);
  });

  it('firstSeenAt is earliest observation capturedAt', () => {
    const early = at(-20 * 60_000);
    const later = at(-10 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: later }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: early }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.firstSeenAt).toBe(early);
  });

  it('lagMinutes = (approvedAt - firstSeenAt) in minutes', () => {
    // firstSeen is 10 minutes before approval
    const firstSeenAt = at(-10 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: firstSeenAt })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.lagMinutes).toBeCloseTo(10.0, 3);
  });

  it('hasObservation=false and lagMinutes=null when only post-approval obs exist', () => {
    // Only observation is 5 minutes AFTER approval — must be ignored
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000) })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(false);
    expect(cand.lagMinutes).toBeNull();
    expect(cand.firstSeenAt).toBeNull();
  });

  it('lagMinutes is null when no observation', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].lagMinutes).toBeNull();
  });
});

// ── preApprovalMovePct ────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — preApprovalMovePct', () => {
  it('preApprovalMovePct = approvalPct - firstSeenPct', () => {
    // firstSeen priceChangePct = 1.0, approval priceChangePct = 4.5 → move = 3.5
    const firstSeenAt = at(-10 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 4.5 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: firstSeenAt, priceChangePct: 1.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.preApprovalMovePct).toBeCloseTo(3.5, 5);
  });

  it('preApprovalMovePct is negative when price fell from firstSeen to approval', () => {
    const firstSeenAt = at(-5 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 2.0 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: firstSeenAt, priceChangePct: 5.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.preApprovalMovePct).toBeCloseTo(-3.0, 5);
  });

  it('preApprovalMovePct is null when approvalPriceChangePct is null', () => {
    const firstSeenAt = at(-5 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: firstSeenAt, priceChangePct: 2.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].preApprovalMovePct).toBeNull();
  });

  it('preApprovalMovePct is null when firstSeen priceChangePct is null', () => {
    const firstSeenAt = at(-5 * 60_000);
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 3.0 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: firstSeenAt })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].preApprovalMovePct).toBeNull();
  });

  it('preApprovalMovePct is null when no observations', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 3.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].preApprovalMovePct).toBeNull();
  });

  it('firstSeenPriceChangePct comes from earliest observation, not any observation', () => {
    // Two obs: early at -15m with pct=1.0, late at -5m with pct=4.0
    // firstSeenPriceChangePct should be 1.0 (from earliest)
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 6.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000),  priceChangePct: 4.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-15 * 60_000), priceChangePct: 1.0 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.firstSeenPriceChangePct).toBeCloseTo(1.0, 5);
    expect(cand.preApprovalMovePct).toBeCloseTo(5.0, 5);  // 6.0 - 1.0
  });
});

// ── bestPreApprovalPct ────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — bestPreApprovalPct', () => {
  it('bestPreApprovalPct is max pct among observations strictly before approvedAt', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 5.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-10 * 60_000), priceChangePct: 3.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000),  priceChangePct: 8.0 }),  // peak
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-2 * 60_000),  priceChangePct: 5.0 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].bestPreApprovalPct).toBeCloseTo(8.0, 5);
  });

  it('bestPreApprovalPct includes obs at approvedAt and excludes obs strictly after', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 2.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 3.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO,         priceChangePct: 7.0 }),  // AT approvedAt — included
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000),   priceChangePct: 99.0 }), // strictly after — excluded
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    // max of 3.0 and 7.0 = 7.0 (99.0 is excluded)
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].bestPreApprovalPct).toBeCloseTo(7.0, 5);
  });

  it('bestPreApprovalPct is null when no observations before approvedAt', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct: 3.0 }),  // only post-approval
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].bestPreApprovalPct).toBeNull();
  });

  it('bestPreApprovalPct is null when all pre-approval obs have null priceChangePct', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000) }),  // no priceChangePct
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].bestPreApprovalPct).toBeNull();
  });
});

// ── preRip flags ──────────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — preRip flags', () => {
  it('all preRip flags false when no observation', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 5.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.preRip_1pct).toBe(false);
    expect(cand.preRip_3pct).toBe(false);
    expect(cand.preRip_5pct).toBe(false);
  });

  it('all preRip flags false when preApprovalMovePct is null', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000) })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.preRip_1pct).toBe(false);
    expect(cand.preRip_3pct).toBe(false);
    expect(cand.preRip_5pct).toBe(false);
  });

  it('preRip_1pct true when preApprovalMovePct >= 1', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 2.0 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 0.5 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    // preApprovalMovePct = 2.0 - 0.5 = 1.5 → ≥1%
    expect(cand.preRip_1pct).toBe(true);
    expect(cand.preRip_3pct).toBe(false);
    expect(cand.preRip_5pct).toBe(false);
  });

  it('preRip_3pct true when preApprovalMovePct >= 3', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 5.0 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 1.5 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    // preApprovalMovePct = 5.0 - 1.5 = 3.5 → ≥3%
    expect(cand.preRip_1pct).toBe(true);
    expect(cand.preRip_3pct).toBe(true);
    expect(cand.preRip_5pct).toBe(false);
  });

  it('preRip_5pct true when preApprovalMovePct >= 5', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 7.0 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 1.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    // preApprovalMovePct = 7.0 - 1.0 = 6.0 → ≥5%
    expect(cand.preRip_1pct).toBe(true);
    expect(cand.preRip_3pct).toBe(true);
    expect(cand.preRip_5pct).toBe(true);
  });

  it('preRip flags false when preApprovalMovePct < 1', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.5 })]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 1.0 })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    // preApprovalMovePct = 0.5 → no flag
    expect(cand.preRip_1pct).toBe(false);
  });
});

// ── Summary stats ─────────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — summary', () => {
  it('totalApprovals counts all BUY_APPROVED_PAPER candidates', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.summary.totalApprovals).toBe(3);
  });

  it('approvalWithObs is count of candidates that matched an observation', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A }),
      // CONTRACT_B has no obs
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.approvalWithObs).toBe(1);
  });

  it('avgLagMinutes is average of lagMinutes across matched candidates', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-10 * 60_000) }),  // 10m lag
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-20 * 60_000) }),  // 20m lag
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.avgLagMinutes).toBeCloseTo(15.0, 3);
  });

  it('medianLagMinutes is median of lagMinutes', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_C, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000) }),
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-15 * 60_000) }),
      makeObsFixture({ contract: CONTRACT_C, capturedAt: at(-25 * 60_000) }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    // sorted lags: 5, 15, 25 → median = 15
    expect(result.summary.medianLagMinutes).toBeCloseTo(15.0, 3);
  });

  it('preRip counts in summary reflect all candidates', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 6.0 }),  // preRip_5pct
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 2.5 }),  // preRip_1pct only
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 0.0 }),  // move=6.0
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-5 * 60_000), priceChangePct: 1.0 }),  // move=1.5
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.preRip_1pct_count).toBe(2);
    expect(result.summary.preRip_3pct_count).toBe(1);
    expect(result.summary.preRip_5pct_count).toBe(1);
  });

  it('preRip pcts are based on approvalWithObs count', () => {
    // 2 matched, 1 preRip_1pct → 50%
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 3.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.5 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 0.0 }),  // move=3.0 → ≥1%
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-5 * 60_000), priceChangePct: 0.0 }),  // move=0.5 → no flag
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.preRip_1pct_pct).toBeCloseTo(50.0, 1);
  });

  it('avgLagMinutes and medianLagMinutes are null when no observations', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.summary.avgLagMinutes).toBeNull();
    expect(result.summary.medianLagMinutes).toBeNull();
  });
});

// ── Policies ──────────────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — policies', () => {
  it('result.policies has ALL, price_gt_0_25, and full combo', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    const ids = result.policies.map(p => p.policyId);
    expect(ids).toContain('ALL');
    expect(ids).toContain('price_gt_0_25');
    expect(ids).toContain(FULL_COMBO_LAG_POLICY_ID);
    expect(result.policies).toHaveLength(3);
  });

  it('ALL policy includes all approved candidates', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 0.1, liquidityUsd: 500, volumeUsd: 200 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 5.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(2);
  });

  it('price_gt_0_25 includes only candidates with approvalPriceChangePct > 0.25', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.0 }),  // passes
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.1 }),  // fails
      makeApprovalFixture({ contract: CONTRACT_C }),                        // null → fails
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const pol = result.policies.find(p => p.policyId === 'price_gt_0_25')!;
    expect(pol.candidates).toHaveLength(1);
    expect(pol.candidates[0].contractKey).toBe(CONTRACT_A);
  });

  it('full combo policy requires price > 0.25, liq >= 30k, vol >= 20k', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),  // passes
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 1.0, liquidityUsd: 5_000,  volumeUsd: 25_000 }),  // liq too low
      makeApprovalFixture({ contract: CONTRACT_C, priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd:  5_000 }),  // vol too low
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const pol = result.policies.find(p => p.policyId === FULL_COMBO_LAG_POLICY_ID)!;
    expect(pol.candidates).toHaveLength(1);
    expect(pol.candidates[0].contractKey).toBe(CONTRACT_A);
  });

  it('policy matchedWithObs counts only candidates with observations', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const obs = writeJsonl('obs.jsonl', [makeObsFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.matchedWithObs).toBe(1);
  });

  it('policy avgLagMinutes computed only over matched candidates', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_B }),  // no obs
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-12 * 60_000) }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.avgLagMinutes).toBeCloseTo(12.0, 3);
  });

  it('policy avgPreApprovalMovePct and medianPreApprovalMovePct computed over matched with non-null movePct', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 4.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 6.0 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 2.0 }),  // move=2.0
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-5 * 60_000), priceChangePct: 2.0 }),  // move=4.0
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const pol = result.policies.find(p => p.policyId === 'ALL')!;
    expect(pol.avgPreApprovalMovePct).toBeCloseTo(3.0, 3);   // (2+4)/2
    expect(pol.medianPreApprovalMovePct).toBeCloseTo(3.0, 3); // median of [2, 4]
  });

  it('policy preRip pct counts are based on matchedWithObs', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 3.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.5 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 0.0 }),  // move=3.0 → preRip_1pct
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(-5 * 60_000), priceChangePct: 0.0 }),  // move=0.5 → no flag
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const pol = result.policies.find(p => p.policyId === 'ALL')!;
    expect(pol.preRip_1pct_count).toBe(1);
    expect(pol.preRip_1pct_pct).toBeCloseTo(50.0, 1);  // 1 of 2 matched
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('runRipperEntryLagReport — safety fields', () => {
  it('always sets realTradingLocked=true, tradingExecuted=0, paperOnly=true, readOnly=true', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.noRealTradeSent).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperEntryLagReport', () => {
  it('includes REAL TRADING LOCKED safety notice', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('REAL TRADING LOCKED');
  });

  it('includes safety footer with realTradingLocked=true and tradingExecuted=0', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    const text = renderRipperEntryLagReport(result);
    expect(text).toContain('realTradingLocked=true');
    expect(text).toContain('tradingExecuted=0');
    expect(text).toContain('paperOnly=true');
    expect(text).toContain('readOnly=true');
  });

  it('includes ENTRY LAG SUMMARY section', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('ENTRY LAG SUMMARY');
  });

  it('includes POLICY ENTRY LAG COMPARISON section', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('POLICY ENTRY LAG COMPARISON');
  });

  it('includes FULL COMBO ENTRY LAG DETAILS section', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('FULL COMBO ENTRY LAG DETAILS');
  });

  it('includes DO NOT APPLY YET section', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('DO NOT APPLY YET');
  });

  it('shows totalApprovals in summary output', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('2');
  });

  it('includes all three policy IDs in output', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [] });
    const text = renderRipperEntryLagReport(result);
    expect(text).toContain('ALL');
    expect(text).toContain('price_gt_0_25');
    expect(text).toContain(FULL_COMBO_LAG_POLICY_ID);
  });

  it('renders full combo candidate with symbol', () => {
    const ap  = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'RIPSYM', priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 0.2 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(renderRipperEntryLagReport(result)).toContain('$RIPSYM');
  });

  it('shows preRip flag in full combo details', () => {
    const ap  = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'RIPPER', priceChangePct: 6.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-10 * 60_000), priceChangePct: 0.5 }),
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    // preApprovalMovePct = 6.0 - 0.5 = 5.5 → ≥5%
    expect(renderRipperEntryLagReport(result)).toContain('≥5%');
  });

  it('returns a non-empty string', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result).trim().length).toBeGreaterThan(0);
  });

  it('shows "missing" instead of "n/a" in full combo details when no pre-approval obs', () => {
    const ap = writeJsonl('c.jsonl', [
      // full combo candidate with only post-approval observations
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'NOMATCH', priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(10 * 60_000), priceChangePct: 5.0 }),  // only post-approval
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(renderRipperEntryLagReport(result)).toContain('missing');
  });

  it('shows "With pre-approval observation" label in summary section', () => {
    const result = runRipperEntryLagReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperEntryLagReport(result)).toContain('With pre-approval observation');
  });

  it('shows "Missing pre-approval obs" count in summary section', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),  // has pre-approval obs
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO }),  // only post-approval obs
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000) }),  // pre-approval
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000) }),   // post-approval only
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.missingPreApprovalObs).toBe(1);
    expect(renderRipperEntryLagReport(result)).toContain('Missing pre-approval obs');
  });
});

// ── Patch-specific regression tests ──────────────────────────────────────────

describe('runRipperEntryLagReport — pre-approval-only patch', () => {
  it('lagMinutes is always null or >= 0 (never negative)', () => {
    // Mix: pre-approval obs, post-approval obs, no obs
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-10 * 60_000) }),  // pre-approval
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(10 * 60_000) }),   // post-approval → ignored
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cands = result.policies.find(p => p.policyId === 'ALL')!.candidates;
    for (const c of cands) {
      if (c.lagMinutes !== null) {
        expect(c.lagMinutes).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('observation strictly after approvedAt is ignored for firstSeen', () => {
    // Post-approval obs should not become firstSeen
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(3 * 60_000) }),  // 3m after approval
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(false);
    expect(cand.firstSeenAt).toBeNull();
    expect(cand.lagMinutes).toBeNull();
    expect(cand.preApprovalMovePct).toBeNull();
    expect(cand.bestPreApprovalPct).toBeNull();
  });

  it('observation AT approvedAt is included as pre-approval (lag = 0)', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 5.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 3.0 }),  // AT approval
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(true);
    expect(cand.firstSeenAt).toBe(BASE_ISO);
    expect(cand.lagMinutes).toBeCloseTo(0, 5);
    expect(cand.firstSeenPriceChangePct).toBeCloseTo(3.0, 5);
    expect(cand.preApprovalMovePct).toBeCloseTo(2.0, 5);  // 5.0 - 3.0
  });

  it('bestPreApprovalPct only considers obs at or before approvedAt', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 4.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000),  priceChangePct: 99.0 }),  // excluded
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates[0].bestPreApprovalPct).toBeCloseTo(4.0, 5);
  });

  it('summary.approvalWithObs counts pre-approval matches only', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),  // has pre-approval obs
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO }),  // only post-approval obs
      makeApprovalFixture({ contract: CONTRACT_C, capturedAt: BASE_ISO }),  // no obs at all
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000) }),  // pre-approval
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000) }),   // post-approval only
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.summary.approvalWithObs).toBe(1);
    expect(result.summary.missingPreApprovalObs).toBe(2);
  });

  it('pre-approval and post-approval obs for same contract: only pre used for firstSeen', () => {
    // Contract has obs at -5m and +10m; firstSeen should be -5m, not +10m
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 5.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), priceChangePct: 2.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(10 * 60_000), priceChangePct: 0.0 }),  // post-approval — ignored
    ]);
    const result = runRipperEntryLagReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.hasObservation).toBe(true);
    expect(cand.firstSeenAt).toBe(at(-5 * 60_000));
    expect(cand.lagMinutes).toBeCloseTo(5.0, 3);
    expect(cand.firstSeenPriceChangePct).toBeCloseTo(2.0, 5);
    expect(cand.preApprovalMovePct).toBeCloseTo(3.0, 5);  // 5.0 - 2.0
    // bestPreApprovalPct = max of pre-approval only = 2.0 (not 0.0 from post-approval)
    expect(cand.bestPreApprovalPct).toBeCloseTo(2.0, 5);
  });
});
