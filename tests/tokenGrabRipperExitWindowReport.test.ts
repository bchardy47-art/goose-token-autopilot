import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperExitWindowReport,
  renderRipperExitWindowReport,
  EXIT_WINDOWS,
  FULL_COMBO_WINDOW_POLICY_ID,
} from '../src/token-grab/ripperExitWindowReport';

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

// Observation fixture: just needs capturedAt + normalizedSignal.priceChangePct
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
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

// Helper: ISO timestamp at BASE_MS + offsetMs
function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Meta tests ────────────────────────────────────────────────────────────────

describe('EXIT_WINDOWS and constants', () => {
  it('EXIT_WINDOWS contains exactly [5, 10, 15, 30, 60]', () => {
    expect(EXIT_WINDOWS).toEqual([5, 10, 15, 30, 60]);
  });

  it('FULL_COMBO_WINDOW_POLICY_ID is price_gt_0_25_and_liq_30k_and_vol_20k', () => {
    expect(FULL_COMBO_WINDOW_POLICY_ID).toBe('price_gt_0_25_and_liq_30k_and_vol_20k');
  });
});

// ── Data loading tests ────────────────────────────────────────────────────────

describe('runRipperExitWindowReport — data loading', () => {
  it('loads only BUY_APPROVED_PAPER approval fixtures', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(1);
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(1);
  });

  it('skips exact duplicate approvals (same contractKey + capturedAt)', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),  // exact dup
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(1);
  });

  it('keeps two instances of same contract with different capturedAt', () => {
    const earlier = at(-60_000);
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.approvalsLoaded).toBe(2);
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(2);
  });

  it('reports missing approval files gracefully', () => {
    const result = runRipperExitWindowReport({ approvalPaths: ['/no/such.jsonl'], observationPaths: [] });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.approvalsLoaded).toBe(0);
  });

  it('loads observations from JSONL files', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, priceChangePct: 2.5 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(result.observationsLoaded).toBe(1);
  });

  it('reports missing observation files gracefully', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: ['/no/obs.jsonl'] });
    expect(result.observationFilesMissing).toBe(1);
    expect(result.observationsLoaded).toBe(0);
  });

  it('extracts approvalPriceChangePct, liquidityUsd, volumeUsd from approval signal', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 3.5, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.approvalPriceChangePct).toBe(3.5);
    expect(cand.liquidityUsd).toBe(50_000);
    expect(cand.volumeUsd).toBe(25_000);
  });
});

// ── Window matching tests ─────────────────────────────────────────────────────

describe('runRipperExitWindowReport — window matching', () => {
  it('produces 5 window slots per candidate (one per EXIT_WINDOWS entry)', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.windows).toHaveLength(5);
    expect(cand.windows.map(w => w.windowMinutes)).toEqual([5, 10, 15, 30, 60]);
  });

  it('marks window missing when no observation within tolerance', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.0 })]);
    // Observation at +27m — within ±5m of +30m (|27-30|=3m), outside all other windows
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(27 * 60_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.windows.find(w => w.windowMinutes === 5)!.missing).toBe(true);
    expect(cand.windows.find(w => w.windowMinutes === 10)!.missing).toBe(true);
    expect(cand.windows.find(w => w.windowMinutes === 15)!.missing).toBe(true);
    expect(cand.windows.find(w => w.windowMinutes === 30)!.missing).toBe(false);
    expect(cand.windows.find(w => w.windowMinutes === 60)!.missing).toBe(true);
  });

  it('matches observation within ±2m tolerance for 5/10/15m windows', () => {
    // Approval at BASE_MS, obs at +5m+90s (within ±2m of +5m target)
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000 + 90_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.missing).toBe(false);
    expect(win5.pctChange).not.toBeNull();
  });

  it('rejects observation just outside ±2m tolerance for 5m window', () => {
    // +5m + 2m1s = just outside ±2m
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000 + 2 * 60_000 + 1_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.missing).toBe(true);
  });

  it('matches observation within ±5m tolerance for 30/60m windows', () => {
    // Obs at +30m+4m (within ±5m of +30m)
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(30 * 60_000 + 4 * 60_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win30 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 30)!;
    expect(win30.missing).toBe(false);
  });

  it('chooses nearest observation when multiple within tolerance', () => {
    // Two obs for +5m window: one at +4m30s (30s before), one at +5m20s (20s after) → closer = +5m20s
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(4 * 60_000 + 30_000), priceChangePct: 10.0 }),   // 30s before target
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000 + 20_000), priceChangePct: 30.0 }),   // 20s after target → closer
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    // 30.0% from pool creation → relGain from 0.0% approval = 30.0%
    expect(win5.pctChange).toBeCloseTo(30.0, 1);
  });

  it('prefers at/after target when two observations are equidistant', () => {
    // Both exactly 60s from the +5m target: one 60s before, one 60s after
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(4 * 60_000), priceChangePct: 10.0 }),   // 60s before +5m
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(6 * 60_000), priceChangePct: 20.0 }),   // 60s after +5m → preferred
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.pctChange).toBeCloseTo(20.0, 1);
  });

  it('computes pctChange as relative gain from approval entry (not absolute)', () => {
    // approvalPct = 2.0, obsPct = 6.0 (both from pool creation)
    // relGain = ((1 + 6/100) / (1 + 2/100) - 1) * 100 = (1.06/1.02 - 1) * 100 ≈ 3.92%
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 2.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct: 6.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.pctChange).toBeCloseTo(3.92, 1);
  });

  it('pctChange is null when approvalPriceChangePct is null', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.missing).toBe(false);
    expect(win5.pctChange).toBeNull();
  });

  it('obsOffsetMs records elapsed ms from approvedAt to matched observation', () => {
    const ap  = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 1.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000 + 30_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const win5 = result.policies.find(p => p.policyId === 'ALL')!.candidates[0].windows.find(w => w.windowMinutes === 5)!;
    expect(win5.obsOffsetMs).toBe(5 * 60_000 + 30_000);
  });

  it('all windows are missing when no observations exist for contract', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.windows.every(w => w.missing)).toBe(true);
  });
});

// ── Best/worst window per candidate tests ─────────────────────────────────────

describe('runRipperExitWindowReport — best/worst window per candidate', () => {
  it('bestWindowMinutes is the window with highest pctChange', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000),  priceChangePct: 10.0 }),  // +10% at +5m
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(10 * 60_000), priceChangePct:  5.0 }),  // +5% at +10m
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.bestWindowMinutes).toBe(5);
  });

  it('worstWindowMinutes is the window with lowest pctChange', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000),  priceChangePct: 10.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(60 * 60_000), priceChangePct: -5.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.worstWindowMinutes).toBe(60);
  });

  it('bestWindowMinutes and worstWindowMinutes are null when all windows missing', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.bestWindowMinutes).toBeNull();
    expect(cand.worstWindowMinutes).toBeNull();
  });

  it('when only one window is priced, best and worst are both that window', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 })]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(10 * 60_000), priceChangePct: 7.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const cand = result.policies.find(p => p.policyId === 'ALL')!.candidates[0];
    expect(cand.bestWindowMinutes).toBe(10);
    expect(cand.worstWindowMinutes).toBe(10);
  });
});

// ── Per-window stats tests ─────────────────────────────────────────────────────

describe('runRipperExitWindowReport — per-window stats', () => {
  it('each policy report has one WindowStats entry per EXIT_WINDOW', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    for (const pol of result.policies) {
      expect(pol.windows).toHaveLength(5);
      expect(pol.windows.map(w => w.windowMinutes)).toEqual([5, 10, 15, 30, 60]);
    }
  });

  it('computes correct pricedCount, missingCount, winners, losers for a window', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_C, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct:  20.0 }),  // WINNER
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000), priceChangePct: -10.0 }),  // LOSER
      // CONTRACT_C has no obs → missing
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const ws = result.policies.find(p => p.policyId === 'ALL')!.windows.find(w => w.windowMinutes === 5)!;
    expect(ws.pricedCount).toBe(2);
    expect(ws.missingCount).toBe(1);
    expect(ws.winners).toBe(1);
    expect(ws.losers).toBe(1);
    expect(ws.winRate).toBeCloseTo(50.0, 1);
  });

  it('computes avgPct and medianPct for a window', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_C, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct:  30.0 }),
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000), priceChangePct: -10.0 }),
      makeObsFixture({ contract: CONTRACT_C, capturedAt: at(5 * 60_000), priceChangePct:  50.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const ws = result.policies.find(p => p.policyId === 'ALL')!.windows.find(w => w.windowMinutes === 5)!;
    // relGain from 0% approval: each is the raw pct
    expect(ws.avgPct).toBeCloseTo((30 - 10 + 50) / 3, 1);
    // sorted: -10, 30, 50 → median = 30
    expect(ws.medianPct).toBeCloseTo(30.0, 1);
  });

  it('worstLoss is the minimum pctChange in a window', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct:  20.0 }),
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000), priceChangePct: -35.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const ws = result.policies.find(p => p.policyId === 'ALL')!.windows.find(w => w.windowMinutes === 5)!;
    expect(ws.worstLoss).toBeCloseTo(-35.0, 1);
    expect(ws.worstLossKey).toBe(CONTRACT_B);
  });

  it('bestGain is the maximum pctChange in a window', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
      makeApprovalFixture({ contract: CONTRACT_B, capturedAt: BASE_ISO, priceChangePct: 0.0 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct:  75.0 }),
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000), priceChangePct:  10.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const ws = result.policies.find(p => p.policyId === 'ALL')!.windows.find(w => w.windowMinutes === 5)!;
    expect(ws.bestGain).toBeCloseTo(75.0, 1);
    expect(ws.bestGainKey).toBe(CONTRACT_A);
  });

  it('winRate is null when no priced observations in a window', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const ws = result.policies.find(p => p.policyId === 'ALL')!.windows.find(w => w.windowMinutes === 5)!;
    expect(ws.winRate).toBeNull();
    expect(ws.avgPct).toBeNull();
    expect(ws.medianPct).toBeNull();
  });
});

// ── Policy filter tests ───────────────────────────────────────────────────────

describe('runRipperExitWindowReport — policies', () => {
  it('result.policies contains ALL, price_gt_0_25, and full combo', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    const ids = result.policies.map(p => p.policyId);
    expect(ids).toContain('ALL');
    expect(ids).toContain('price_gt_0_25');
    expect(ids).toContain(FULL_COMBO_WINDOW_POLICY_ID);
    expect(result.policies).toHaveLength(3);
  });

  it('ALL policy includes every approved candidate', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 5.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.1, liquidityUsd:  5_000, volumeUsd:  2_000 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(result.policies.find(p => p.policyId === 'ALL')!.candidates).toHaveLength(2);
  });

  it('price_gt_0_25 includes only candidates with approvalPriceChangePct > 0.25', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.0 }),  // passes
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.1 }),  // fails
      makeApprovalFixture({ contract: CONTRACT_C }),                        // null → fails
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const pol = result.policies.find(p => p.policyId === 'price_gt_0_25')!;
    expect(pol.candidates).toHaveLength(1);
    expect(pol.candidates[0].contractKey).toBe(CONTRACT_A);
  });

  it('full combo policy requires price > 0.25, liq >= 30k, vol >= 20k', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),  // passes
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 1.0, liquidityUsd:  5_000, volumeUsd: 25_000 }),  // liq too low
      makeApprovalFixture({ contract: CONTRACT_C, priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd:  5_000 }),  // vol too low
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const pol = result.policies.find(p => p.policyId === FULL_COMBO_WINDOW_POLICY_ID)!;
    expect(pol.candidates).toHaveLength(1);
    expect(pol.candidates[0].contractKey).toBe(CONTRACT_A);
  });

  it('each policy computes independent window stats', () => {
    // CONTRACT_A passes full combo, CONTRACT_B only passes price_gt_0_25
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.5, liquidityUsd:  5_000, volumeUsd:  3_000 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct: 3.0 }),
      makeObsFixture({ contract: CONTRACT_B, capturedAt: at(5 * 60_000), priceChangePct: 2.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const all      = result.policies.find(p => p.policyId === 'ALL')!;
    const fullCombo = result.policies.find(p => p.policyId === FULL_COMBO_WINDOW_POLICY_ID)!;

    expect(all.windows.find(w => w.windowMinutes === 5)!.candidateCount).toBe(2);
    expect(fullCombo.windows.find(w => w.windowMinutes === 5)!.candidateCount).toBe(1);
  });
});

// ── Safety tests ──────────────────────────────────────────────────────────────

describe('runRipperExitWindowReport — safety fields', () => {
  it('always sets realTradingLocked=true, tradingExecuted=0, paperOnly=true, readOnly=true', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.noRealTradeSent).toBe(true);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────

describe('renderRipperExitWindowReport', () => {
  it('includes REAL TRADING LOCKED safety notice', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperExitWindowReport(result)).toContain('REAL TRADING LOCKED');
  });

  it('includes safety footer with realTradingLocked=true and tradingExecuted=0', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    const text = renderRipperExitWindowReport(result);
    expect(text).toContain('realTradingLocked=true');
    expect(text).toContain('tradingExecuted=0');
    expect(text).toContain('paperOnly=true');
    expect(text).toContain('readOnly=true');
  });

  it('includes FULL COMBO EXIT WINDOW DETAILS section', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperExitWindowReport(result)).toContain('FULL COMBO EXIT WINDOW DETAILS');
  });

  it('includes DO NOT APPLY YET section', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperExitWindowReport(result)).toContain('DO NOT APPLY YET');
  });

  it('includes EXIT WINDOW PERFORMANCE section when candidates exist', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(renderRipperExitWindowReport(result)).toContain('EXIT WINDOW PERFORMANCE');
  });

  it('shows +5m, +10m, +15m, +30m, +60m labels in output', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const text = renderRipperExitWindowReport(result);
    expect(text).toContain('+5m');
    expect(text).toContain('+10m');
    expect(text).toContain('+15m');
    expect(text).toContain('+30m');
    expect(text).toContain('+60m');
  });

  it('renders full combo candidate details with symbol', () => {
    const ap  = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'RIPSYM', priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000), priceChangePct: 3.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    expect(renderRipperExitWindowReport(result)).toContain('$RIPSYM');
  });

  it('shows "miss" for missing window observations in full combo details', () => {
    const ap = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'MISS', priceChangePct: 1.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    expect(renderRipperExitWindowReport(result)).toContain('miss');
  });

  it('shows best and worst window columns in full combo details', () => {
    const ap  = writeJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'BW', priceChangePct: 0.0, liquidityUsd: 50_000, volumeUsd: 25_000 }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(5 * 60_000),  priceChangePct:  20.0 }),
      makeObsFixture({ contract: CONTRACT_A, capturedAt: at(60 * 60_000), priceChangePct: -10.0 }),
    ]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [obs] });
    const text = renderRipperExitWindowReport(result);
    // Should show best = +5m and worst = +60m
    expect(text).toContain('+5m');
    expect(text).toContain('+60m');
  });

  it('all three policy IDs appear in the output', () => {
    const ap = writeJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitWindowReport({ approvalPaths: [ap], observationPaths: [] });
    const text = renderRipperExitWindowReport(result);
    expect(text).toContain('ALL');
    expect(text).toContain('price_gt_0_25');
    expect(text).toContain(FULL_COMBO_WINDOW_POLICY_ID);
  });

  it('returns a non-empty string', () => {
    const result = runRipperExitWindowReport({ approvalPaths: [], observationPaths: [] });
    expect(renderRipperExitWindowReport(result).trim().length).toBeGreaterThan(0);
  });
});
