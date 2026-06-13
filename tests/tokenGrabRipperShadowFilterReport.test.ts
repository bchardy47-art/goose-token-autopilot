import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperShadowFilterReport,
  renderRipperShadowFilterReport,
  type ShadowFilterId,
} from '../src/token-grab/ripperShadowFilterReport';

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
  liquidityUsd?:   number;
  volumeUsd?:      number;
} = {}) {
  return {
    id:            'sig-id',
    source:        'test',
    sourceKind:    'dex',
    discoveredAt:  BASE_ISO,
    contract:      opts.contract ?? CONTRACT_A,
    symbol:        opts.symbol,
    priceChangePct: opts.priceChangePct,
    liquidityUsd:  opts.liquidityUsd,
    volumeUsd:     opts.volumeUsd,
    warnings:      [],
  };
}

function makeApprovalFixture(opts: {
  contract?:       string;
  symbol?:         string;
  ripperScore?:    number;
  ageMinutes?:     number;
  capturedAt?:     string;
  priceChangePct?: number;
  liquidityUsd?:   number;
  volumeUsd?:      number;
  clusterRisk?:    string;
  buyGateDecision?: string;
} = {}) {
  return {
    id:              'fix-id',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    source:          'test',
    sourceKind:      'dex',
    normalizedSignal: makeSignal({
      contract:       opts.contract,
      symbol:         opts.symbol,
      priceChangePct: opts.priceChangePct,
      liquidityUsd:   opts.liquidityUsd,
      volumeUsd:      opts.volumeUsd,
    }),
    ripperInput:      null,
    ripperScore:      opts.ripperScore ?? 85,
    ageMinutes:       opts.ageMinutes  ?? 6,
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    raw:              { clusterRisk: opts.clusterRisk ?? 'CLEAN' },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function makeObsFixture(opts: {
  contract?:    string;
  ripperScore?: number;
  ageMinutes?:  number;
  capturedAt?:  string;
} = {}) {
  return {
    ...makeApprovalFixture({
      contract:    opts.contract,
      ripperScore: opts.ripperScore,
      ageMinutes:  opts.ageMinutes,
      capturedAt:  opts.capturedAt,
    }),
    postApprovalObservation: true,
  };
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
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsfr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeApprovalJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeObsJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return p;
}

function writeOutcomeJson(name: string, content: object): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(content), 'utf-8');
  return p;
}

function findCand(result: ReturnType<typeof runRipperShadowFilterReport>, contractKey: string) {
  return result.candidates.find(c => c.contractKey === contractKey) ?? null;
}

function findFilter(result: ReturnType<typeof runRipperShadowFilterReport>, id: ShadowFilterId) {
  return result.filterSummaries.find(s => s.filterId === id) ?? null;
}

// ── Standard 4-candidate dataset ─────────────────────────────────────────────
// GUARDIAN (A): winner, high liq/vol/price → passes all 14 filters
// Trilly (B):   loser, low liq/vol/price   → fails all 14 filters
// SPCX69 (C):   loser, low liq/vol/price   → fails all 14 filters
// Pending (D):  no outcome, mid liq/vol/price → passes some filters

function buildStandardDataset(tmpDir: string) {
  const approvalPath = path.join(tmpDir, 'approvals.jsonl');
  fs.writeFileSync(approvalPath, [
    makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', liquidityUsd: 200_000, volumeUsd: 80_000, priceChangePct: 5.0,  ripperScore: 92 }),
    makeApprovalFixture({ contract: CONTRACT_B, symbol: 'Trilly',   liquidityUsd:  20_000, volumeUsd:  8_000, priceChangePct: -1.0, ripperScore: 78 }),
    makeApprovalFixture({ contract: CONTRACT_C, symbol: 'SPCX69',   liquidityUsd:  30_000, volumeUsd: 15_000, priceChangePct:  0.1, ripperScore: 72 }),
    makeApprovalFixture({ contract: CONTRACT_D, symbol: 'PEND',     liquidityUsd:  80_000, volumeUsd: 30_000, priceChangePct:  0.6, ripperScore: 80 }),
  ].map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');

  const outcomePath = path.join(tmpDir, 'outcomes.json');
  fs.writeFileSync(outcomePath, JSON.stringify(makeOutcomeFile([
    { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
    { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    { contractKey: CONTRACT_C, pctChangeFromEntry: -38.5 },
  ])), 'utf-8');

  return { approvalPath, outcomePath };
}

// ── Loading tests ─────────────────────────────────────────────────────────────

describe('runRipperShadowFilterReport — data loading', () => {
  it('loads only BUY_APPROVED_PAPER fixtures, skips others', () => {
    const p = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [p], observationPaths: [], outcomePaths: [],
    });
    expect(result.totalCandidates).toBe(1);
    expect(result.approvalsRead).toBe(1);
    expect(findCand(result, CONTRACT_A)).not.toBeNull();
    expect(findCand(result, CONTRACT_B)).toBeNull();
  });

  it('keeps earliest capturedAt when same contractKey appears twice', () => {
    const earlier = new Date(BASE_MS - 60_000).toISOString();
    const p = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO, ripperScore: 90 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier,  ripperScore: 70 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [p], observationPaths: [], outcomePaths: [],
    });
    expect(result.totalCandidates).toBe(1);
    expect(findCand(result, CONTRACT_A)?.approvalScore).toBe(70); // earliest
  });

  it('reports missing approval files without crashing', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths:    ['/no/such/file.jsonl'],
      observationPaths: [],
      outcomePaths:     [],
    });
    expect(result.approvalFilesRead).toBe(0);
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(0);
  });

  it('reports missing observation files without crashing', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowFilterReport({
      approvalPaths:    [ap],
      observationPaths: ['/no/such/obs.jsonl'],
      outcomePaths:     [],
    });
    expect(result.observationFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(1);
  });

  it('reports missing outcome files without crashing', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowFilterReport({
      approvalPaths:    [ap],
      observationPaths: [],
      outcomePaths:     ['/no/such/out.json'],
    });
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(1);
  });

  it('joins outcomes by contractKey, assigns outcomePctChange', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });

  it('loads latest obs score per contractKey', () => {
    const ap  = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const ob  = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 60, ageMinutes: 5 }),
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 45, ageMinutes: 12 }), // later → use this
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [ob], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.latestObsScore).toBe(45);
  });
});

// ── Classification tests ──────────────────────────────────────────────────────

describe('runRipperShadowFilterReport — classification', () => {
  it('classifies WINNER when outcomePctChange > 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('WINNER');
    expect(result.winnersCount).toBe(1);
  });

  it('classifies LOSER when outcomePctChange <= 0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 0 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('LOSER');
    expect(result.losersCount).toBe(1);
  });

  it('classifies LOSER when outcome is negative', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('LOSER');
  });

  it('classifies PENDING_PRICE when no outcome', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.classification).toBe('PENDING_PRICE');
    expect(result.pendingCount).toBe(1);
  });
});

// ── Filter evaluation tests ───────────────────────────────────────────────────

describe('runRipperShadowFilterReport — single-field filter evaluation', () => {
  it('filter A: liquidityUsd >= 50000 — passes at threshold, fails below', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 50_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 49_999 }),
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: undefined }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['A']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['A']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['A']).toBe(false); // null → fail
  });

  it('filter B: liquidityUsd >= 75000', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 75_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 74_999 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['B']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['B']).toBe(false);
  });

  it('filter C: liquidityUsd >= 100000', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 100_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 99_999 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['C']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['C']).toBe(false);
  });

  it('filter D: volumeUsd >= 20000', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, volumeUsd: 20_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, volumeUsd: 19_999 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['D']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['D']).toBe(false);
  });

  it('filter E: volumeUsd >= 25000', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, volumeUsd: 25_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, volumeUsd: 24_999 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['E']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['E']).toBe(false);
  });

  it('filter F: volumeUsd >= 50000', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, volumeUsd: 50_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, volumeUsd: 49_999 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['F']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['F']).toBe(false);
  });

  it('filter G: approvalPriceChangePct > 0.25', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 0.26 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.25 }), // not strictly greater
      makeApprovalFixture({ contract: CONTRACT_C, priceChangePct: undefined }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['G']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['G']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['G']).toBe(false); // null → fail
  });

  it('filter H: approvalPriceChangePct > 0.5', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 0.51 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 0.5 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['H']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['H']).toBe(false);
  });

  it('filter I: approvalPriceChangePct > 1.0', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 1.01 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 1.0 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['I']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['I']).toBe(false);
  });

  it('null liquidityUsd fails all liquidity-based filters', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: undefined }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const cand = findCand(result, CONTRACT_A)!;
    expect(cand.filterResults['A']).toBe(false);
    expect(cand.filterResults['B']).toBe(false);
    expect(cand.filterResults['C']).toBe(false);
  });

  it('null volumeUsd fails all volume-based filters', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, volumeUsd: undefined }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const cand = findCand(result, CONTRACT_A)!;
    expect(cand.filterResults['D']).toBe(false);
    expect(cand.filterResults['E']).toBe(false);
    expect(cand.filterResults['F']).toBe(false);
  });
});

// ── Combined filter tests ─────────────────────────────────────────────────────

describe('runRipperShadowFilterReport — combined filter evaluation', () => {
  it('filter J (liq≥75k AND vol≥25k) requires both conditions', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000, volumeUsd: 30_000 }), // both pass
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 80_000, volumeUsd: 20_000 }), // vol fails
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: 50_000, volumeUsd: 30_000 }), // liq fails
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['J']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['J']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['J']).toBe(false);
  });

  it('filter K (liq≥75k AND price>0.5%) requires both conditions', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000, priceChangePct: 0.6 }), // both pass
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 80_000, priceChangePct: 0.5 }), // price not >0.5
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: 60_000, priceChangePct: 0.6 }), // liq fails
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['K']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['K']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['K']).toBe(false);
  });

  it('filter L (vol≥25k AND price>0.5%) requires both conditions', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, volumeUsd: 30_000, priceChangePct: 0.6 }), // both pass
      makeApprovalFixture({ contract: CONTRACT_B, volumeUsd: 30_000, priceChangePct: 0.4 }), // price fails
      makeApprovalFixture({ contract: CONTRACT_C, volumeUsd: 20_000, priceChangePct: 0.6 }), // vol fails
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['L']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['L']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['L']).toBe(false);
  });

  it('filter M requires all three conditions', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000, volumeUsd: 30_000, priceChangePct: 0.6 }), // all pass
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 80_000, volumeUsd: 30_000, priceChangePct: 0.4 }), // price fails
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: 80_000, volumeUsd: 20_000, priceChangePct: 0.6 }), // vol fails
      makeApprovalFixture({ contract: CONTRACT_D, liquidityUsd: 60_000, volumeUsd: 30_000, priceChangePct: 0.6 }), // liq fails
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['M']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['M']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['M']).toBe(false);
    expect(findCand(result, CONTRACT_D)?.filterResults['M']).toBe(false);
  });

  it('filter N requires liq≥100k AND vol≥50k AND price>1%', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 120_000, volumeUsd: 60_000, priceChangePct: 2.0 }), // all pass
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 120_000, volumeUsd: 60_000, priceChangePct: 1.0 }), // price not >1
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: 120_000, volumeUsd: 49_000, priceChangePct: 2.0 }), // vol fails
      makeApprovalFixture({ contract: CONTRACT_D, liquidityUsd:  90_000, volumeUsd: 60_000, priceChangePct: 2.0 }), // liq fails
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.filterResults['N']).toBe(true);
    expect(findCand(result, CONTRACT_B)?.filterResults['N']).toBe(false);
    expect(findCand(result, CONTRACT_C)?.filterResults['N']).toBe(false);
    expect(findCand(result, CONTRACT_D)?.filterResults['N']).toBe(false);
  });
});

// ── Filter summary computation tests ─────────────────────────────────────────

describe('runRipperShadowFilterReport — per-filter summary', () => {
  it('produces 14 filter summaries covering all filter IDs', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    expect(result.filterSummaries).toHaveLength(14);
    const ids = result.filterSummaries.map(s => s.filterId);
    const expected: ShadowFilterId[] = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];
    for (const id of expected) expect(ids).toContain(id);
  });

  it('filter A summary: counts passed/rejected/winners/losers/pending correctly', () => {
    // GUARDIAN (liq=200k) → passes A
    // Trilly (liq=20k) → fails A
    // SPCX69 (liq=30k) → fails A
    // Pending (liq=80k) → passes A
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const a = findFilter(result, 'A')!;
    expect(a.candidatesPassed).toBe(2);   // GUARDIAN + Pending
    expect(a.candidatesRejected).toBe(2); // Trilly + SPCX69
    expect(a.winnersKept).toBe(1);
    expect(a.winnersRejected).toBe(0);
    expect(a.losersKept).toBe(0);
    expect(a.losersRejected).toBe(2);
    expect(a.pendingKept).toBe(1);
    expect(a.pendingRejected).toBe(0);
  });

  it('filter C summary (liq≥100k): rejects Pending (liq=80k)', () => {
    // Only GUARDIAN (liq=200k) passes
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const c = findFilter(result, 'C')!;
    expect(c.candidatesPassed).toBe(1);   // GUARDIAN only
    expect(c.candidatesRejected).toBe(3);
    expect(c.winnersKept).toBe(1);
    expect(c.pendingKept).toBe(0);
    expect(c.pendingRejected).toBe(1);
  });

  it('keptWinnerPct = winnersKept / totalWinners * 100', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const a = findFilter(result, 'A')!;
    // 1 winner total, 1 kept
    expect(a.keptWinnerPct).toBeCloseTo(100, 1);
  });

  it('rejectedLoserPct = losersRejected / totalLosers * 100', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const a = findFilter(result, 'A')!;
    // 2 losers total, 2 rejected
    expect(a.rejectedLoserPct).toBeCloseTo(100, 1);
  });

  it('keptWinnerPct is null when there are no winners', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -5 }, // LOSER
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const a = findFilter(result, 'A')!;
    expect(a.keptWinnerPct).toBeNull();
  });

  it('rejectedLoserPct is null when there are no losers', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 20 }, // WINNER
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const a = findFilter(result, 'A')!;
    expect(a.rejectedLoserPct).toBeNull();
  });

  it('keptAvgOutcomePct: average of priced candidates that pass', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 80_000 }),
      makeApprovalFixture({ contract: CONTRACT_C, liquidityUsd: 20_000 }), // fails A
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 40 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 20 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -30 }, // rejected by A
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const a = findFilter(result, 'A')!;
    expect(a.keptAvgOutcomePct).toBeCloseTo(30, 3); // (40 + 20) / 2
    expect(a.rejectedAvgOutcomePct).toBeCloseTo(-30, 3);
  });

  it('keptAvgOutcomePct excludes pending (null outcome) candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 80_000 }),
      makeApprovalFixture({ contract: CONTRACT_B, liquidityUsd: 80_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 30 },
      // B has no outcome → PENDING_PRICE
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const a = findFilter(result, 'A')!;
    expect(a.keptAvgOutcomePct).toBeCloseTo(30, 3); // only A is priced
  });
});

// ── Spotlight symbol tracking tests ──────────────────────────────────────────

describe('runRipperShadowFilterReport — GUARDIAN/Trilly/SPCX69 tracking', () => {
  it('keptGuardian is true when GUARDIAN passes the filter', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    // Filter A keeps GUARDIAN (liq=200k ≥ 50k)
    expect(findFilter(result, 'A')!.keptGuardian).toBe(true);
  });

  it('keptGuardian is false when GUARDIAN fails the filter', () => {
    // GUARDIAN with low liquidity → fails filter C (≥100k)
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', liquidityUsd: 60_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findFilter(result, 'C')!.keptGuardian).toBe(false);
  });

  it('rejectedTrilly is true when Trilly fails the filter (generic by symbol)', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    // Filter A rejects Trilly (liq=20k < 50k)
    expect(findFilter(result, 'A')!.rejectedTrilly).toBe(true);
  });

  it('rejectedTrilly is false when Trilly passes the filter', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_B, symbol: 'Trilly', liquidityUsd: 60_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findFilter(result, 'A')!.rejectedTrilly).toBe(false);
  });

  it('rejectedSpcx69 is true when SPCX69 fails the filter (generic by symbol)', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    // Filter A rejects SPCX69 (liq=30k < 50k)
    expect(findFilter(result, 'A')!.rejectedSpcx69).toBe(true);
  });

  it('rejectedSpcx69 is false when SPCX69 passes the filter', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_C, symbol: 'SPCX69', liquidityUsd: 80_000 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_C, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findFilter(result, 'A')!.rejectedSpcx69).toBe(false);
  });

  it('both rejected flags false when neither Trilly nor SPCX69 in dataset', () => {
    const ap = writeApprovalJsonl('c.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'OTHER', liquidityUsd: 20_000 }),
    ]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const a = findFilter(result, 'A')!;
    expect(a.rejectedTrilly).toBe(false);
    expect(a.rejectedSpcx69).toBe(false);
  });
});

// ── Best-looking filter ranking tests ─────────────────────────────────────────

describe('runRipperShadowFilterReport — bestLookingFilters ranking', () => {
  it('filters keeping GUARDIAN and rejecting losers score > 0', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    // Filter A keeps GUARDIAN (+3), rejects 2 losers (+2), has reasons
    const a = result.bestLookingFilters.find(r => r.filterId === 'A');
    expect(a).toBeDefined();
    expect(a!.score).toBeGreaterThan(0);
    expect(a!.reasons.length).toBeGreaterThan(0);
  });

  it('bestLookingFilters is sorted by score descending', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const scores = result.bestLookingFilters.map(r => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it('filter that rejects all candidates scores <= 0 (not in best list)', () => {
    // All candidates with liq=200k, so filter C (≥100k) keeps all, rejects none
    // But a filter requiring liq≥300k would reject everything
    // Actually, let's test: a filter that rejects all winners scores poorly
    const ap = writeApprovalJsonl('c.jsonl', [
      // GUARDIAN with liq=80k → passes A, fails C
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', liquidityUsd: 80_000, volumeUsd: 10_000, priceChangePct: 0.1 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49 }, // WINNER
    ]));
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    // Filter C (liq≥100k) rejects GUARDIAN (the only winner) → should score <= 0
    const c = result.bestLookingFilters.find(r => r.filterId === 'C');
    expect(c).toBeUndefined(); // should not appear in best list
  });

  it('filter that keeps GUARDIAN ranks above filter that loses GUARDIAN', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const guardianKeepers = result.bestLookingFilters.filter(r => {
      const s = findFilter(result, r.filterId)!;
      return s.keptGuardian;
    });
    const guardianRejectors = result.bestLookingFilters.filter(r => {
      const s = findFilter(result, r.filterId)!;
      return !s.keptGuardian;
    });
    if (guardianKeepers.length > 0 && guardianRejectors.length > 0) {
      const minKeeperScore = Math.min(...guardianKeepers.map(r => r.score));
      const maxRejectorScore = Math.max(...guardianRejectors.map(r => r.score));
      expect(minKeeperScore).toBeGreaterThan(maxRejectorScore);
    }
  });

  it('bestLookingFilters only includes filters with score > 0', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    for (const rank of result.bestLookingFilters) {
      expect(rank.score).toBeGreaterThan(0);
    }
  });

  it('bestLookingFilters includes filterId, filterLabel, filterDescription, reasons', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    if (result.bestLookingFilters.length > 0) {
      const top = result.bestLookingFilters[0];
      expect(top.filterId).toBeTruthy();
      expect(top.filterLabel).toBeTruthy();
      expect(top.filterDescription).toBeTruthy();
      expect(Array.isArray(top.reasons)).toBe(true);
    }
  });
});

// ── Overall avg outcome tests ─────────────────────────────────────────────────

describe('runRipperShadowFilterReport — overallAvgOutcomePct', () => {
  it('computes overallAvgOutcomePct across all priced candidates', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    // GUARDIAN: 49.9, Trilly: -42.7, SPCX69: -38.5 → avg = (49.9 - 42.7 - 38.5) / 3
    const expected = (49.9 - 42.7 - 38.5) / 3;
    expect(result.overallAvgOutcomePct).toBeCloseTo(expected, 3);
  });

  it('overallAvgOutcomePct is null when no priced candidates', () => {
    const ap = writeApprovalJsonl('c.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperShadowFilterReport({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(result.overallAvgOutcomePct).toBeNull();
  });
});

// ── Safety fields tests ───────────────────────────────────────────────────────

describe('runRipperShadowFilterReport — safety fields', () => {
  it('result always has realTradingLocked=true', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.realTradingLocked).toBe(true);
  });

  it('result always has tradingExecuted=0', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.tradingExecuted).toBe(0);
  });

  it('result always has noRealTradeSent=true', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.noRealTradeSent).toBe(true);
  });

  it('result always has paperOnly=true', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.paperOnly).toBe(true);
  });

  it('result always has readOnly=true', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.readOnly).toBe(true);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────

describe('renderRipperShadowFilterReport', () => {
  it('includes REAL TRADING LOCKED safety notice', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('REAL TRADING LOCKED');
  });

  it('includes DO NOT APPLY YET section', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('DO NOT APPLY YET');
  });

  it('includes filter legend with all 14 filter IDs', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowFilterReport(result);
    const ids: ShadowFilterId[] = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];
    for (const id of ids) expect(text).toContain(`[${id}]`);
  });

  it('includes candidate symbols in the output', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('GUARDIAN');
    expect(text).toContain('Trilly');
    expect(text).toContain('SPCX69');
  });

  it('includes safety footer with realTradingLocked and tradingExecuted', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('realTradingLocked=true');
    expect(text).toContain('tradingExecuted=0');
    expect(text).toContain('paperOnly=true');
  });

  it('includes BEST-LOOKING FILTERS section', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('BEST-LOOKING FILTERS');
  });

  it('includes PER-FILTER SUMMARY section', () => {
    const { approvalPath, outcomePath } = buildStandardDataset(tmpDir);
    const result = runRipperShadowFilterReport({
      approvalPaths: [approvalPath], observationPaths: [], outcomePaths: [outcomePath],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text).toContain('PER-FILTER SUMMARY');
  });

  it('returns a non-empty string', () => {
    const result = runRipperShadowFilterReport({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    const text = renderRipperShadowFilterReport(result);
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
