import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperShadowPolicyReport,
  renderRipperShadowPolicyReport,
  type ShadowPolicyGroup,
} from '../src/token-grab/ripperShadowPolicyReport';
import {
  computeShadowPolicy,
  buildFixture,
  SHADOW_POLICY_PRICE_GT_0_25,
} from '../src/token-grab/liveFixtureCapture';
import { DEFAULT_RIPPER_CONFIG } from '../src/token-grab/dexRipperEngine';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Contract keys ─────────────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeSignal(opts: {
  contract?:       string;
  symbol?:         string;
  priceChangePct?: number;
  liquidityUsd?:   number;
  volumeUsd?:      number;
  ageMinutes?:     number;
} = {}) {
  return {
    id:            'sig-id',
    source:        'test',
    sourceKind:    'dex' as const,
    discoveredAt:  BASE_ISO,
    contract:      opts.contract ?? CONTRACT_A,
    symbol:        opts.symbol,
    priceChangePct: opts.priceChangePct,
    liquidityUsd:  opts.liquidityUsd ?? 100_000,
    volumeUsd:     opts.volumeUsd    ?? 50_000,
    txnCount:      200,
    buys:          120,
    sells:         80,
    warnings:      [],
  };
}

function makeApprovalFixture(opts: {
  contract?:       string;
  symbol?:         string;
  priceChangePct?: number;
  capturedAt?:     string;
  buyGateDecision?: string;
  shadowPolicyPass?:   boolean;
  shadowPolicyId?:     string;
  shadowPolicyReason?: string;
  shadowPolicyValue?:  number | null;
  shadowPolicyMode?:   'shadow_only';
} = {}) {
  const base: Record<string, unknown> = {
    id:              'fix-id',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    source:          'test',
    sourceKind:      'dex',
    normalizedSignal: makeSignal({
      contract:       opts.contract,
      symbol:         opts.symbol,
      priceChangePct: opts.priceChangePct,
    }),
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

  // If shadow policy fields are explicitly provided, add them
  if (opts.shadowPolicyId !== undefined)     base.shadowPolicyId     = opts.shadowPolicyId;
  if (opts.shadowPolicyPass !== undefined)   base.shadowPolicyPass   = opts.shadowPolicyPass;
  if (opts.shadowPolicyReason !== undefined) base.shadowPolicyReason = opts.shadowPolicyReason;
  if (opts.shadowPolicyValue !== undefined)  base.shadowPolicyValue  = opts.shadowPolicyValue;
  if (opts.shadowPolicyMode !== undefined)   base.shadowPolicyMode   = opts.shadowPolicyMode;

  return base;
}

function makeOutcomeFile(candidates: Array<{
  contractKey:        string;
  pctChangeFromEntry?: number | null;
  checkpointAt?:       string;
}>) {
  return {
    generatedAt: BASE_ISO,
    candidates:  candidates.map(c => ({
      contractKey:        c.contractKey,
      pctChangeFromEntry: c.pctChangeFromEntry ?? null,
      checkpointAt:       c.checkpointAt ?? BASE_ISO,
    })),
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeApprovalJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeOutcomeJson(name: string, content: object): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(content), 'utf-8');
  return p;
}

function findCand(result: ReturnType<typeof runRipperShadowPolicyReport>, contractKey: string) {
  return result.candidates.find(c => c.contractKey === contractKey) ?? null;
}

function findGroup(result: ReturnType<typeof runRipperShadowPolicyReport>, group: ShadowPolicyGroup) {
  return result.groupSummaries.find(s => s.group === group) ?? null;
}

// ── computeShadowPolicy unit tests ────────────────────────────────────────────

describe('computeShadowPolicy', () => {
  it('passes when priceChangePct > 0.25', () => {
    const sp = computeShadowPolicy(0.26);
    expect(sp.shadowPolicyId).toBe(SHADOW_POLICY_PRICE_GT_0_25);
    expect(sp.shadowPolicyPass).toBe(true);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct > 0.25');
    expect(sp.shadowPolicyValue).toBe(0.26);
    expect(sp.shadowPolicyMode).toBe('shadow_only');
  });

  it('passes with a large positive value', () => {
    const sp = computeShadowPolicy(5.0);
    expect(sp.shadowPolicyPass).toBe(true);
    expect(sp.shadowPolicyValue).toBe(5.0);
  });

  it('fails when priceChangePct === 0.25 (not strictly greater)', () => {
    const sp = computeShadowPolicy(0.25);
    expect(sp.shadowPolicyPass).toBe(false);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct <= 0.25');
    expect(sp.shadowPolicyValue).toBe(0.25);
  });

  it('fails when priceChangePct < 0.25', () => {
    const sp = computeShadowPolicy(0.10);
    expect(sp.shadowPolicyPass).toBe(false);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct <= 0.25');
  });

  it('fails when priceChangePct is 0', () => {
    const sp = computeShadowPolicy(0);
    expect(sp.shadowPolicyPass).toBe(false);
  });

  it('fails when priceChangePct is negative', () => {
    const sp = computeShadowPolicy(-1.0);
    expect(sp.shadowPolicyPass).toBe(false);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct <= 0.25');
    expect(sp.shadowPolicyValue).toBe(-1.0);
  });

  it('returns missing when priceChangePct is null', () => {
    const sp = computeShadowPolicy(null);
    expect(sp.shadowPolicyPass).toBe(false);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct missing');
    expect(sp.shadowPolicyValue).toBeNull();
  });

  it('returns missing when priceChangePct is undefined', () => {
    const sp = computeShadowPolicy(undefined);
    expect(sp.shadowPolicyPass).toBe(false);
    expect(sp.shadowPolicyReason).toBe('approvalPriceChangePct missing');
    expect(sp.shadowPolicyValue).toBeNull();
  });

  it('always sets shadowPolicyMode to shadow_only', () => {
    expect(computeShadowPolicy(1.0).shadowPolicyMode).toBe('shadow_only');
    expect(computeShadowPolicy(0.0).shadowPolicyMode).toBe('shadow_only');
    expect(computeShadowPolicy(null).shadowPolicyMode).toBe('shadow_only');
  });
});

// ── buildFixture shadow policy integration tests ──────────────────────────────

describe('buildFixture — shadow policy attachment', () => {
  it('attaches shadow policy fields to approved fixture when priceChangePct > 0.25', () => {
    const signal = makeSignal({ contract: CONTRACT_A, priceChangePct: 5.0, liquidityUsd: 100_000, volumeUsd: 50_000 });
    const fixture = buildFixture(signal as any, DEFAULT_RIPPER_CONFIG, BASE_MS);
    if (fixture.buyGateDecision === 'BUY_APPROVED_PAPER') {
      expect(fixture.shadowPolicyId).toBe(SHADOW_POLICY_PRICE_GT_0_25);
      expect(fixture.shadowPolicyPass).toBe(true);
      expect(fixture.shadowPolicyMode).toBe('shadow_only');
      expect(typeof fixture.shadowPolicyValue).toBe('number');
    }
  });

  it('does NOT attach shadow policy to rejected fixtures', () => {
    // A signal that will be rejected (e.g., missing contract address triggers rejection)
    const signal = {
      id:            'no-contract',
      source:        'test',
      sourceKind:    'dex' as const,
      discoveredAt:  BASE_ISO,
      contract:      undefined,
      tokenAddress:  undefined,
      poolAddress:   undefined,
      priceChangePct: 5.0,
      liquidityUsd:  100_000,
      volumeUsd:     50_000,
      warnings:      [],
    };
    const fixture = buildFixture(signal as any, DEFAULT_RIPPER_CONFIG, BASE_MS);
    expect(fixture.buyGateDecision).toBe('BUY_REJECTED');
    expect(fixture.shadowPolicyId).toBeUndefined();
    expect(fixture.shadowPolicyPass).toBeUndefined();
  });

  it('shadow policy fields do NOT affect buyGateDecision outcome', () => {
    // Even with price > 0.25, approval still requires the full gate to pass
    // We test that the shadow policy is purely additive: buildFixture returns
    // the same buyGateDecision it would have without shadow policy
    const signalPass = makeSignal({ contract: CONTRACT_A, priceChangePct: 5.0, liquidityUsd: 100_000, volumeUsd: 50_000 });
    const signalFail = makeSignal({ contract: CONTRACT_A, priceChangePct: 0.1, liquidityUsd: 100_000, volumeUsd: 50_000 });
    const fp = buildFixture(signalPass as any, DEFAULT_RIPPER_CONFIG, BASE_MS);
    const ff = buildFixture(signalFail as any, DEFAULT_RIPPER_CONFIG, BASE_MS);
    // Both share the same contract/score; only shadow policy differs
    expect(fp.buyGateDecision).toBe(ff.buyGateDecision);
  });
});

// ── Report loading tests ──────────────────────────────────────────────────────

describe('runRipperShadowPolicyReport — data loading', () => {
  it('loads only BUY_APPROVED_PAPER fixtures', () => {
    const p = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [p], outcomePaths: [] });
    expect(result.totalCandidates).toBe(1);
    expect(findCand(result, CONTRACT_A)).not.toBeNull();
    expect(findCand(result, CONTRACT_B)).toBeNull();
  });

  it('deduplicates by contractKey keeping earliest capturedAt', () => {
    const earlier = new Date(BASE_MS - 60_000).toISOString();
    const p = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO,  shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [p], outcomePaths: [] });
    expect(result.totalCandidates).toBe(1);
    // earliest → shadowPolicyPass = false
    expect(findCand(result, CONTRACT_A)?.shadowPolicyGroup).toBe('FAIL');
  });

  it('reports missing approval files without crashing', () => {
    const result = runRipperShadowPolicyReport({
      approvalPaths: ['/no/such/file.jsonl'],
      outcomePaths:  [],
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(0);
  });

  it('reports missing outcome files without crashing', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPolicyReport({
      approvalPaths: [ap],
      outcomePaths:  ['/no/such/out.json'],
    });
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(1);
  });

  it('joins outcomes by contractKey', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });
});

// ── Shadow policy group classification tests ──────────────────────────────────

describe('runRipperShadowPolicyReport — shadow policy grouping', () => {
  it('groups candidate as PASS when shadowPolicyPass=true', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.shadowPolicyGroup).toBe('PASS');
    expect(result.totalPass).toBe(1);
  });

  it('groups candidate as FAIL when shadowPolicyPass=false', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.shadowPolicyGroup).toBe('FAIL');
    expect(result.totalFail).toBe(1);
  });

  it('groups candidate as MISSING when no shadowPolicyPass field (old artifact)', () => {
    // Simulate an old artifact without shadow policy fields
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      // Note: no shadowPolicyPass in this fixture
    ]);
    // Remove shadow policy fields from the written fixture manually by reading and rewriting
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'c.jsonl'), 'utf-8').trim());
    delete raw.shadowPolicyPass;
    delete raw.shadowPolicyId;
    delete raw.shadowPolicyReason;
    delete raw.shadowPolicyValue;
    delete raw.shadowPolicyMode;
    fs.writeFileSync(path.join(tmpDir, 'c.jsonl'), JSON.stringify(raw) + '\n', 'utf-8');

    const result = runRipperShadowPolicyReport({ approvalPaths: [path.join(tmpDir, 'c.jsonl')], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.shadowPolicyGroup).toBe('MISSING');
    expect(result.totalMissing).toBe(1);
  });

  it('correctly counts pass/fail/missing across multiple candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.totalPass).toBe(1);
    expect(result.totalFail).toBe(2);
    expect(result.totalMissing).toBe(0);
  });
});

// ── Outcome classification tests ──────────────────────────────────────────────

describe('runRipperShadowPolicyReport — outcome classification', () => {
  it('classifies WINNER when outcomePctChange > 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('WINNER');
  });

  it('classifies LOSER when outcomePctChange <= 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 0 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('LOSER');
  });

  it('classifies PENDING_PRICE when no outcome', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('PENDING_PRICE');
  });
});

// ── Group summary tests ───────────────────────────────────────────────────────

describe('runRipperShadowPolicyReport — group summaries', () => {
  it('always produces 3 group summaries (PASS, FAIL, MISSING)', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.groupSummaries).toHaveLength(3);
    const groups = result.groupSummaries.map(g => g.group);
    expect(groups).toContain('PASS');
    expect(groups).toContain('FAIL');
    expect(groups).toContain('MISSING');
  });

  it('PASS group correctly counts winners and losers', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 }, // WINNER
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10.0 }, // LOSER
      { contractKey: CONTRACT_C, pctChangeFromEntry: -38.5 }, // LOSER in FAIL group
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });

    const passGroup = findGroup(result, 'PASS')!;
    expect(passGroup.count).toBe(2);
    expect(passGroup.pricedCount).toBe(2);
    expect(passGroup.winners).toBe(1);
    expect(passGroup.losers).toBe(1);

    const failGroup = findGroup(result, 'FAIL')!;
    expect(failGroup.count).toBe(1);
    expect(failGroup.losers).toBe(1);
  });

  it('computes avgOutcomePct for priced candidates in a group', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 40 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 20 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });
    const passGroup = findGroup(result, 'PASS')!;
    expect(passGroup.avgOutcomePct).toBeCloseTo(30, 3); // (40 + 20) / 2
  });

  it('computes medianOutcomePct for odd-count priced group', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 30 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: 20 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });
    const passGroup = findGroup(result, 'PASS')!;
    expect(passGroup.medianOutcomePct).toBeCloseTo(20, 3); // sorted: [10, 20, 30] → middle = 20
  });

  it('identifies best and worst candidates in each group', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, symbol: 'Trilly',   shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [oc] });

    const passGroup = findGroup(result, 'PASS')!;
    expect(passGroup.bestCandidate?.symbol).toBe('GUARDIAN');
    expect(passGroup.bestCandidate?.outcomePctChange).toBe(49.9);

    const failGroup = findGroup(result, 'FAIL')!;
    expect(failGroup.worstCandidate?.symbol).toBe('Trilly');
    expect(failGroup.worstCandidate?.outcomePctChange).toBe(-42.7);
  });

  it('avgOutcomePct is null when a group has no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    // No outcomes → pending
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    const passGroup = findGroup(result, 'PASS')!;
    expect(passGroup.avgOutcomePct).toBeNull();
    expect(passGroup.medianOutcomePct).toBeNull();
    expect(passGroup.pendingPrice).toBe(1);
  });

  it('handles old artifact without shadow policy fields as MISSING', () => {
    // Fixture written without any shadow policy fields
    const fixture = {
      id:              'old-fix',
      capturedAt:      BASE_ISO,
      source:          'test',
      sourceKind:      'dex',
      normalizedSignal: makeSignal({ contract: CONTRACT_A }),
      ripperInput:     null,
      ripperScore:     85,
      ageMinutes:      6,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      blockers:        [],
      topReasons:      [],
      warnings:        [],
      raw:             { clusterRisk: 'CLEAN' },
      realTradingLocked: true,
      paperOnly:       true,
      readOnly:        true,
      // No shadowPolicyId, shadowPolicyPass, etc.
    };
    const ap = writeApprovalJsonl('old.jsonl', [fixture]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.totalMissing).toBe(1);
    expect(findCand(result, CONTRACT_A)?.shadowPolicyGroup).toBe('MISSING');
  });

  it('shadowPolicyId on candidate defaults to SHADOW_POLICY_PRICE_GT_0_25 for MISSING group', () => {
    const fixture = {
      id: 'old-fix', capturedAt: BASE_ISO, source: 'test', sourceKind: 'dex',
      normalizedSignal: makeSignal({ contract: CONTRACT_A }),
      ripperInput: null, ripperScore: 85, ageMinutes: 6,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      blockers: [], topReasons: [], warnings: [],
      raw: { clusterRisk: 'CLEAN' },
      realTradingLocked: true, paperOnly: true, readOnly: true,
    };
    const ap = writeApprovalJsonl('old.jsonl', [fixture]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.shadowPolicyId).toBe(SHADOW_POLICY_PRICE_GT_0_25);
  });
});

// ── Safety field tests ────────────────────────────────────────────────────────

describe('runRipperShadowPolicyReport — safety fields', () => {
  it('result always has realTradingLocked=true', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.realTradingLocked).toBe(true);
  });

  it('result always has tradingExecuted=0', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.tradingExecuted).toBe(0);
  });

  it('result always has noRealTradeSent=true', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.noRealTradeSent).toBe(true);
  });

  it('result always has paperOnly=true and readOnly=true', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── Shadow policy does not change approval count ──────────────────────────────

describe('runRipperShadowPolicyReport — no eligibility/approval changes', () => {
  it('totalCandidates equals number of BUY_APPROVED_PAPER fixtures regardless of shadow result', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    // Only the 2 approved ones are counted — shadow policy pass/fail does not filter
    expect(result.totalCandidates).toBe(2);
    expect(result.totalPass + result.totalFail + result.totalMissing).toBe(2);
  });

  it('FAIL group candidates are still included in totalCandidates (not rejected)', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    // FAIL means shadow policy failed — the candidate WAS approved and is tracked
    expect(result.totalCandidates).toBe(1);
    expect(findCand(result, CONTRACT_A)).not.toBeNull();
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────

describe('renderRipperShadowPolicyReport', () => {
  it('includes REAL TRADING LOCKED safety notice', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text).toContain('REAL TRADING LOCKED');
  });

  it('includes DO NOT APPLY section', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text).toContain('DO NOT APPLY');
  });

  it('includes shadow policy id in output', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text).toContain('price_gt_0_25');
  });

  it('includes safety footer', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text).toContain('realTradingLocked=true');
    expect(text).toContain('tradingExecuted=0');
    expect(text).toContain('paperOnly=true');
  });

  it('includes GROUP SUMMARY section', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', shadowPolicyPass: true, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPolicyReport({ approvalPaths: [ap], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text).toContain('GROUP SUMMARY');
    expect(text).toContain('GUARDIAN');
  });

  it('returns a non-empty string', () => {
    const result = runRipperShadowPolicyReport({ approvalPaths: [], outcomePaths: [] });
    const text = renderRipperShadowPolicyReport(result);
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
