import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperShadowPortfolioReport,
  renderRipperShadowPortfolioReport,
  type ShadowPortfolioGroup,
} from '../src/token-grab/ripperShadowPortfolioReport';
import { SHADOW_POLICY_PRICE_GT_0_25 } from '../src/token-grab/liveFixtureCapture';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Contract keys ─────────────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CONTRACT_D = 'ContractDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeSignal(opts: {
  contract?:       string;
  symbol?:         string;
  priceChangePct?: number;
} = {}) {
  return {
    id:            'sig-id',
    source:        'test',
    sourceKind:    'dex',
    discoveredAt:  BASE_ISO,
    contract:      opts.contract ?? CONTRACT_A,
    symbol:        opts.symbol,
    priceChangePct: opts.priceChangePct,
    liquidityUsd:  100_000,
    volumeUsd:     50_000,
    warnings:      [],
  };
}

function makeApprovalFixture(opts: {
  contract?:           string;
  symbol?:             string;
  priceChangePct?:     number;
  capturedAt?:         string;
  buyGateDecision?:    string;
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

  if (opts.shadowPolicyId !== undefined)     base.shadowPolicyId     = opts.shadowPolicyId;
  if (opts.shadowPolicyPass !== undefined)   base.shadowPolicyPass   = opts.shadowPolicyPass;
  if (opts.shadowPolicyReason !== undefined) base.shadowPolicyReason = opts.shadowPolicyReason;
  if (opts.shadowPolicyValue !== undefined)  base.shadowPolicyValue  = opts.shadowPolicyValue;
  if (opts.shadowPolicyMode !== undefined)   base.shadowPolicyMode   = opts.shadowPolicyMode;

  return base;
}

function makeOutcomeFile(
  candidates: Array<{
    contractKey:         string;
    pctChangeFromEntry?: number | null;
    checkpointAt?:       string;
  }>,
  generatedAt?: string,
) {
  return {
    generatedAt: generatedAt ?? BASE_ISO,
    candidates:  candidates.map(c => ({
      contractKey:        c.contractKey,
      pctChangeFromEntry: c.pctChangeFromEntry ?? null,
      checkpointAt:       c.checkpointAt ?? BASE_ISO,
    })),
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspp-test-')); });
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

function findCand(result: ReturnType<typeof runRipperShadowPortfolioReport>, contractKey: string) {
  return result.groups['ALL'].candidates.find(c => c.contractKey === contractKey) ?? null;
}

// ── Standard 4-candidate dataset ─────────────────────────────────────────────
// GUARDIAN (A): PASS,    winner  +49.9%
// Trilly (B):   FAIL,    loser   -42.7%
// SPCX69 (C):   FAIL,    loser   -38.5%
// PEND (D):     PASS,    pending (no outcome)

function buildStandardDataset(dir: string) {
  const approvalPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalPath, [
    makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25, shadowPolicyValue: 5.0  }),
    makeApprovalFixture({ contract: CONTRACT_B, symbol: 'Trilly',   shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25, shadowPolicyValue: -1.0 }),
    makeApprovalFixture({ contract: CONTRACT_C, symbol: 'SPCX69',   shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25, shadowPolicyValue:  0.1 }),
    makeApprovalFixture({ contract: CONTRACT_D, symbol: 'PEND',     shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25, shadowPolicyValue:  0.6 }),
  ].map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');

  const outcomePath = path.join(dir, 'outcomes.json');
  fs.writeFileSync(outcomePath, JSON.stringify(makeOutcomeFile([
    { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
    { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    { contractKey: CONTRACT_C, pctChangeFromEntry: -38.5 },
    // CONTRACT_D has no outcome → PENDING
  ])), 'utf-8');

  return { approvalPath, outcomePath };
}

// ── Data loading tests ────────────────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — data loading', () => {
  it('loads only BUY_APPROVED_PAPER fixtures', () => {
    const p = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [p], outcomePaths: [] });
    expect(result.totalCandidates).toBe(1);
    expect(findCand(result, CONTRACT_A)).not.toBeNull();
    expect(findCand(result, CONTRACT_B)).toBeNull();
  });

  it('deduplicates by contractKey keeping earliest capturedAt', () => {
    const earlier = new Date(BASE_MS - 60_000).toISOString();
    const p = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [p], outcomePaths: [] });
    expect(result.totalCandidates).toBe(1);
    // earlier capturedAt → shadowPolicyPass = false → FAIL group
    expect(findCand(result, CONTRACT_A)?.shadowPolicyPass).toBe(false);
  });

  it('tracks sourceFile on each candidate', () => {
    const ap = writeApprovalJsonl('cycle-001.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.sourceFile).toBe(ap);
  });

  it('loads approvals from multiple files', () => {
    const ap1 = writeApprovalJsonl('batch1.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const ap2 = writeApprovalJsonl('batch2.jsonl', [makeApprovalFixture({ contract: CONTRACT_B })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap1, ap2], outcomePaths: [] });
    expect(result.totalCandidates).toBe(2);
    expect(result.approvalFilesRead).toBe(2);
  });

  it('reports missing approval files gracefully', () => {
    const result = runRipperShadowPortfolioReport({
      approvalPaths: ['/no/such/file.jsonl'],
      outcomePaths:  [],
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(0);
  });

  it('joins outcomes by contractKey', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });

  it('prefers latest checkpointAt when same contractKey appears in multiple outcome files', () => {
    const ap  = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const ts1 = new Date(BASE_MS - 3_600_000).toISOString(); // older
    const ts2 = new Date(BASE_MS).toISOString();             // newer
    const oc1 = writeOutcomeJson('out1.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10.0, checkpointAt: ts1 },
    ]));
    const oc2 = writeOutcomeJson('out2.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9, checkpointAt: ts2 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc1, oc2] });
    // Must use the latest checkpoint → 49.9
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });

  it('prefers latest checkpoint even when loaded in reverse order', () => {
    const ap  = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const ts1 = new Date(BASE_MS - 3_600_000).toISOString(); // older
    const ts2 = new Date(BASE_MS).toISOString();             // newer
    const oc1 = writeOutcomeJson('out1.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10.0, checkpointAt: ts1 },
    ]));
    const oc2 = writeOutcomeJson('out2.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9, checkpointAt: ts2 },
    ]));
    // Reverse order
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc2, oc1] });
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });

  it('reports missing outcome files gracefully', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [ap],
      outcomePaths:  ['/no/such/out.json'],
    });
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(1);
  });
});

// ── Group classification tests ────────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — group classification', () => {
  it('classifies candidate as PASS when shadowPolicyPass=true', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['PASS'].count).toBe(1);
    expect(result.groups['FAIL'].count).toBe(0);
    expect(result.groups['MISSING'].count).toBe(0);
  });

  it('classifies candidate as FAIL when shadowPolicyPass=false', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['FAIL'].count).toBe(1);
    expect(result.groups['PASS'].count).toBe(0);
  });

  it('classifies old artifact (no shadow fields) as MISSING', () => {
    const fixture = {
      id:              'old-fix', capturedAt: BASE_ISO, source: 'test', sourceKind: 'dex',
      normalizedSignal: makeSignal({ contract: CONTRACT_A }),
      ripperInput: null, ripperScore: 85, ageMinutes: 6,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      blockers: [], topReasons: [], warnings: [], raw: { clusterRisk: 'CLEAN' },
      realTradingLocked: true, paperOnly: true, readOnly: true,
      // no shadow fields
    };
    const ap = writeApprovalJsonl('old.jsonl', [fixture]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['MISSING'].count).toBe(1);
    expect(result.groups['PASS'].count).toBe(0);
    expect(result.groups['FAIL'].count).toBe(0);
  });

  it('ALL group contains all candidates regardless of shadow policy', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    expect(result.groups['ALL'].count).toBe(4);
    expect(result.groups['PASS'].count).toBe(2);
    expect(result.groups['FAIL'].count).toBe(2);
    expect(result.groups['MISSING'].count).toBe(0);
  });
});

// ── Outcome classification tests ──────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — outcome classification', () => {
  it('classifies WINNER when outcomePctChange > 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('WINNER');
  });

  it('classifies LOSER when outcomePctChange = 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 0 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('LOSER');
  });

  it('classifies LOSER when outcomePctChange < 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('LOSER');
  });

  it('classifies PENDING_PRICE when no outcome', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('PENDING_PRICE');
  });
});

// ── Group stats computation tests ─────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — group stats', () => {
  it('computes winners, losers, pendingCount for ALL group', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const all = result.groups['ALL'];
    expect(all.winners).toBe(1);        // GUARDIAN
    expect(all.losers).toBe(2);         // Trilly + SPCX69
    expect(all.pendingCount).toBe(1);   // PEND
    expect(all.pricedCount).toBe(3);
  });

  it('computes winRate as winners / priced * 100', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  40 }, // WIN
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 }, // LOSS
      { contractKey: CONTRACT_C, pctChangeFromEntry:  20 }, // WIN
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    const pass = result.groups['PASS'];
    expect(pass.winRate).toBeCloseTo(66.67, 1); // 2/3 * 100
  });

  it('winRate is null when no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['ALL'].winRate).toBeNull();
  });

  it('computes avgPct for priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  40 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.groups['PASS'].avgPct).toBeCloseTo(15, 3); // (40 + -10) / 2
  });

  it('computes medianPct correctly', () => {
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
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.groups['PASS'].medianPct).toBeCloseTo(20, 3); // sorted: [10,20,30] → 20
  });

  it('computes medianPct for even-count group (average of two middle values)', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 30 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.groups['PASS'].medianPct).toBeCloseTo(20, 3); // (10+30)/2
  });

  it('computes totalSimPct as sum of all priced outcomes', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    // ALL priced: 49.9 + (-42.7) + (-38.5) = -31.3
    expect(result.groups['ALL'].totalSimPct).toBeCloseTo(49.9 - 42.7 - 38.5, 3);
  });

  it('totalSimPct is null when no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['ALL'].totalSimPct).toBeNull();
  });

  it('computes avgWinnerPct and avgLoserPct', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_C, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  40 }, // winner
      { contractKey: CONTRACT_B, pctChangeFromEntry:  20 }, // winner
      { contractKey: CONTRACT_C, pctChangeFromEntry: -15 }, // loser
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    // ALL group
    expect(result.groups['ALL'].avgWinnerPct).toBeCloseTo(30, 3);  // (40+20)/2
    expect(result.groups['ALL'].avgLoserPct).toBeCloseTo(-15, 3);
  });

  it('avgWinnerPct is null when no winners', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -10 }, // loser only
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.groups['ALL'].avgWinnerPct).toBeNull();
    expect(result.groups['ALL'].avgLoserPct).toBeCloseTo(-10, 3);
  });

  it('identifies bestCandidate and worstCandidate', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const all = result.groups['ALL'];
    expect(all.bestCandidate?.symbol).toBe('GUARDIAN');
    expect(all.bestCandidate?.outcomePctChange).toBe(49.9);
    expect(all.worstCandidate?.symbol).toBe('Trilly');
    expect(all.worstCandidate?.outcomePctChange).toBe(-42.7);
  });

  it('bestCandidate and worstCandidate are null when no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [] });
    expect(result.groups['ALL'].bestCandidate).toBeNull();
    expect(result.groups['ALL'].worstCandidate).toBeNull();
  });
});

// ── Policy read comparison tests ──────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — policyRead', () => {
  it('passIsOutperforming=true when PASS avg > FAIL avg', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    // PASS priced: GUARDIAN +49.9 → avg +49.9
    // FAIL priced: Trilly -42.7, SPCX69 -38.5 → avg -40.6
    expect(result.policyRead.passIsOutperforming).toBe(true);
    expect(result.policyRead.passAvgPct).toBeCloseTo(49.9, 3);
    expect(result.policyRead.failAvgPct).toBeCloseTo((-42.7 + -38.5) / 2, 3);
  });

  it('passIsOutperforming=false when PASS avg < FAIL avg', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -20 }, // PASS loses
      { contractKey: CONTRACT_B, pctChangeFromEntry:  30 }, // FAIL wins
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.policyRead.passIsOutperforming).toBe(false);
  });

  it('passIsOutperforming=null when PASS has no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, shadowPolicyPass: true,  shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
      makeApprovalFixture({ contract: CONTRACT_B, shadowPolicyPass: false, shadowPolicyId: SHADOW_POLICY_PRICE_GT_0_25 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      // Only FAIL priced; PASS pending
      { contractKey: CONTRACT_B, pctChangeFromEntry: -20 },
    ]));
    const result = runRipperShadowPortfolioReport({ approvalPaths: [ap], outcomePaths: [oc] });
    expect(result.policyRead.passIsOutperforming).toBeNull();
  });

  it('reports pass/fail win rates in policyRead', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    // PASS priced: 1 winner → 100%
    expect(result.policyRead.passWinRate).toBeCloseTo(100, 1);
    // FAIL priced: 0 winners of 2 → 0%
    expect(result.policyRead.failWinRate).toBeCloseTo(0, 1);
  });

  it('reports worst loss for pass and fail groups', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    // PASS worst: GUARDIAN +49.9 (only one priced — best = worst)
    expect(result.policyRead.passWorstLossPct).toBeCloseTo(49.9, 3);
    // FAIL worst: Trilly -42.7
    expect(result.policyRead.failWorstLossPct).toBeCloseTo(-42.7, 3);
  });

  it('reports pending counts in policyRead', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    expect(result.policyRead.passPendingCount).toBe(1); // PEND
    expect(result.policyRead.failPendingCount).toBe(0);
  });

  it('reports totalPricedCount across all groups', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    expect(result.policyRead.totalPricedCount).toBe(3);
  });
});

// ── Safety field tests ────────────────────────────────────────────────────────

describe('runRipperShadowPortfolioReport — safety fields', () => {
  it('always sets realTradingLocked=true', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.realTradingLocked).toBe(true);
  });

  it('always sets tradingExecuted=0', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.tradingExecuted).toBe(0);
  });

  it('always sets noRealTradeSent=true', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.noRealTradeSent).toBe(true);
  });

  it('always sets paperOnly=true and readOnly=true', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────

describe('renderRipperShadowPortfolioReport', () => {
  it('includes REAL TRADING LOCKED safety notice', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    const text   = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('REAL TRADING LOCKED');
  });

  it('includes safety footer with realTradingLocked and tradingExecuted=0', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    const text   = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('realTradingLocked=true');
    expect(text).toContain('tradingExecuted=0');
    expect(text).toContain('paperOnly=true');
  });

  it('includes Policy Read section', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('POLICY READ');
  });

  it('includes Do Not Apply Yet section', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('DO NOT APPLY YET');
  });

  it('includes Portfolio Groups section with group names', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('PORTFOLIO GROUPS');
    expect(text).toContain('PASS');
    expect(text).toContain('FAIL');
  });

  it('mentions candidate symbols in output', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowPortfolioReport({
      approvalPaths: [approvalPath], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('GUARDIAN');
    expect(text).toContain('Trilly');
    expect(text).toContain('SPCX69');
  });

  it('mentions price_gt_0_25 policy id', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    const text   = renderRipperShadowPortfolioReport(result);
    expect(text).toContain('price_gt_0_25');
  });

  it('returns a non-empty string', () => {
    const result = runRipperShadowPortfolioReport({ approvalPaths: [], outcomePaths: [] });
    const text   = renderRipperShadowPortfolioReport(result);
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
