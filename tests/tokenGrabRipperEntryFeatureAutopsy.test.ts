import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperEntryFeatureAutopsy,
  renderRipperEntryFeatureAutopsy,
  type EntryClassification,
} from '../src/token-grab/ripperEntryFeatureAutopsy';

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
  txnCount?:       number;
  buys?:           number;
  sells?:          number;
  holderRiskHint?: string;
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
    txnCount:      opts.txnCount,
    buys:          opts.buys,
    sells:         opts.sells,
    holderRiskHint: opts.holderRiskHint,
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
  txnCount?:       number;
  buys?:           number;
  sells?:          number;
  holderRiskHint?: string;
  clusterRisk?:    string;
  topReasons?:     string[];
  blockers?:       string[];
  warnings?:       string[];
  raw?:            Record<string, unknown>;
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
      txnCount:       opts.txnCount,
      buys:           opts.buys,
      sells:          opts.sells,
      holderRiskHint: opts.holderRiskHint,
    }),
    ripperInput:     null,
    ripperScore:     opts.ripperScore ?? 85,
    ageMinutes:      opts.ageMinutes  ?? 6,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers:        opts.blockers    ?? [],
    topReasons:      opts.topReasons  ?? [],
    warnings:        opts.warnings    ?? [],
    raw:             opts.raw ?? { clusterRisk: opts.clusterRisk ?? 'CLEAN' },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function makeObsFixture(opts: {
  contract?:       string;
  ripperScore?:    number;
  ageMinutes?:     number;
  capturedAt?:     string;
  priceChangePct?: number;
} = {}) {
  return {
    ...makeApprovalFixture({
      contract:       opts.contract,
      ripperScore:    opts.ripperScore,
      ageMinutes:     opts.ageMinutes,
      capturedAt:     opts.capturedAt,
      priceChangePct: opts.priceChangePct,
    }),
    postApprovalObservation: true,
  };
}

function makeOutcomeFile(candidates: Array<{
  contractKey:        string;
  pctChangeFromEntry?: number | null;
}>) {
  return {
    generatedAt: BASE_ISO,
    candidates:  candidates.map(c => ({
      contractKey:        c.contractKey,
      pctChangeFromEntry: c.pctChangeFromEntry ?? null,
    })),
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refa-test-')); });
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

function findCand(result: ReturnType<typeof runRipperEntryFeatureAutopsy>, contractKey: string) {
  return result.candidates.find(c => c.contractKey === contractKey) ?? null;
}

// ── Loading tests ─────────────────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — data loading', () => {
  it('loads approvals by contractKey, skipping non-approved fixtures', () => {
    const p = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      { ...makeApprovalFixture({ contract: CONTRACT_B }), buyGateDecision: 'BUY_REJECTED' },
    ]);
    const result = runRipperEntryFeatureAutopsy({
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
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO,  ripperScore: 90 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier, ripperScore: 70 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [p], observationPaths: [], outcomePaths: [],
    });
    expect(result.totalCandidates).toBe(1);
    expect(findCand(result, CONTRACT_A)?.approvalScore).toBe(70); // earliest
  });

  it('joins outcomes by contractKey and assigns outcomePctChange', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(findCand(result, CONTRACT_A)?.outcomePctChange).toBe(49.9);
  });

  it('joins latest observations by contractKey — picks highest ageMinutes', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 80 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 20, ripperScore: 55 }), // latest
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 70 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [op], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.latestObsScore).toBe(55);
    expect(findCand(result, CONTRACT_A)?.latestObsAgeMinutes).toBe(20);
  });

  it('computes scoreDelta as latestObsScore − approvalScore', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 15, ripperScore: 55 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [op], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.scoreDelta).toBe(-25);
  });

  it('counts missing files', () => {
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths:    [path.join(tmpDir, 'no-approvals.jsonl')],
      observationPaths: [path.join(tmpDir, 'no-obs.jsonl')],
      outcomePaths:     [path.join(tmpDir, 'no-out.json')],
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.observationFilesMissing).toBe(1);
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.totalCandidates).toBe(0);
  });
});

// ── Classification tests ──────────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — classification', () => {
  function classify(outcomePct: number | null): EntryClassification {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const ocFiles: string[] = [];
    if (outcomePct !== null) {
      ocFiles.push(writeOutcomeJson('out.json', makeOutcomeFile([
        { contractKey: CONTRACT_A, pctChangeFromEntry: outcomePct },
      ])));
    }
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: ocFiles,
    });
    return findCand(result, CONTRACT_A)!.classification;
  }

  it('classifies WINNER when outcome > 0', () => {
    expect(classify(49.9)).toBe('WINNER');
  });

  it('classifies LOSER when outcome < 0', () => {
    expect(classify(-42.7)).toBe('LOSER');
  });

  it('classifies LOSER when outcome exactly 0', () => {
    expect(classify(0)).toBe('LOSER');
  });

  it('classifies PENDING_PRICE when no outcome provided', () => {
    expect(classify(null)).toBe('PENDING_PRICE');
  });

  it('counts winners, losers, pending correctly', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
      // C has no outcome
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.winnersCount).toBe(1);
    expect(result.losersCount).toBe(1);
    expect(result.pendingCount).toBe(1);
  });

  it('sorts candidates: winners first (desc), losers next, pending last', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
      makeApprovalFixture({ contract: CONTRACT_D }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry:   4.2 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -42.7 },
      // D pending
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.candidates[0].contractKey).toBe(CONTRACT_A);
    expect(result.candidates[1].contractKey).toBe(CONTRACT_B);
    expect(result.candidates[2].contractKey).toBe(CONTRACT_C);
    expect(result.candidates[3].contractKey).toBe(CONTRACT_D);
  });
});

// ── Feature extraction tests ──────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — feature extraction', () => {
  it('extracts liquidityUsd, volumeUsd, txnCount from normalizedSignal', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({
        contract:     CONTRACT_A,
        liquidityUsd: 150_000,
        volumeUsd:    80_000,
        txnCount:     250,
      }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c?.liquidityUsd).toBe(150_000);
    expect(c?.volumeUsd).toBe(80_000);
    expect(c?.txnCount).toBe(250);
  });

  it('computes buySellRatio from buys and sells', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, buys: 75, sells: 25 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c?.buys).toBe(75);
    expect(c?.sells).toBe(25);
    expect(c?.buySellRatio).toBeCloseTo(0.75, 5);
  });

  it('sets buySellRatio null when buys+sells = 0', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, buys: 0, sells: 0 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.buySellRatio).toBeNull();
  });

  it('extracts clusterRisk from raw field', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, clusterRisk: 'WATCH' }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.clusterRisk).toBe('WATCH');
  });

  it('falls back to UNKNOWN clusterRisk when raw is missing or has unknown value', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      { ...makeApprovalFixture({ contract: CONTRACT_A }), raw: null },
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.clusterRisk).toBe('UNKNOWN');
  });

  it('extracts clusterProvider from raw', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({
        contract: CONTRACT_A,
        raw: { clusterRisk: 'CLEAN', clusterProvider: 'bubblemaps' },
      }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.clusterProvider).toBe('bubblemaps');
  });

  it('extracts extra raw fields that are not clusterRisk/clusterProvider', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({
        contract: CONTRACT_A,
        raw: { clusterRisk: 'CLEAN', clusterProvider: 'bubblemaps', topHolderPct: 35, concentration: 'HIGH' },
      }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c?.rawFields['topHolderPct']).toBe(35);
    expect(c?.rawFields['concentration']).toBe('HIGH');
    expect(c?.rawFields['clusterRisk']).toBeUndefined();
    expect(c?.rawFields['clusterProvider']).toBeUndefined();
  });

  it('handles missing raw gracefully — no crash, rawFields empty', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      { ...makeApprovalFixture({ contract: CONTRACT_A }), raw: undefined },
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c).not.toBeNull();
    expect(c?.rawFields).toEqual({});
    expect(c?.clusterRisk).toBe('UNKNOWN');
  });

  it('extracts topReasons and warnings from fixture', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({
        contract:   CONTRACT_A,
        topReasons: ['high-volume', 'fresh-launch'],
        warnings:   ['low-liquidity'],
      }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c?.approvalTopReasons).toContain('high-volume');
    expect(c?.approvalTopReasons).toContain('fresh-launch');
    expect(c?.approvalWarnings).toContain('low-liquidity');
  });

  it('extracts holderRiskHint from signal', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, holderRiskHint: 'HIGH_CONCENTRATION' }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(findCand(result, CONTRACT_A)?.holderRiskHint).toBe('HIGH_CONCENTRATION');
  });

  it('handles all null market fields without crashing', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    const c = findCand(result, CONTRACT_A);
    expect(c?.liquidityUsd).toBeNull();
    expect(c?.volumeUsd).toBeNull();
    expect(c?.txnCount).toBeNull();
    expect(c?.buySellRatio).toBeNull();
    expect(c?.holderRiskHint).toBeNull();
  });
});

// ── Group stats tests ─────────────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — group stats', () => {
  it('computes winner vs loser avgApprovalScore', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 90 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 70 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_C, ripperScore: 60 }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry:   4.6 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.winnerStats.avgApprovalScore).toBe(80); // (90+70)/2
    expect(result.loserStats.avgApprovalScore).toBe(60);
  });

  it('computes avgApprovalPriceChangePct per group', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 100 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct:  40 }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.winnerStats.avgApprovalPriceChangePct).toBe(100);
    expect(result.loserStats.avgApprovalPriceChangePct).toBe(40);
  });

  it('computes avgLiquidityUsd only from candidates with the field', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 200_000 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B }),  // winner, no liquidity
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 20 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.winnerStats.avgLiquidityUsd).toBe(200_000); // only A contributes
  });

  it('computes clusterRisk distribution by group', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, clusterRisk: 'CLEAN' }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, clusterRisk: 'WATCH'  }),  // loser
      makeApprovalFixture({ contract: CONTRACT_C, clusterRisk: 'WATCH'  }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -20 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    expect(result.winnerStats.clusterRiskCounts['CLEAN']).toBe(1);
    expect(result.loserStats.clusterRiskCounts['WATCH']).toBe(2);
  });

  it('extracts repeated warning phrases within winners group', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, warnings: ['low-liquidity', 'new-pool'] }),
      makeApprovalFixture({ contract: CONTRACT_B, warnings: ['low-liquidity'] }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 20 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const phrases = result.winnerStats.warningPhrases;
    const lowLiq  = phrases.find(p => p.phrase === 'low-liquidity');
    const newPool  = phrases.find(p => p.phrase === 'new-pool');
    expect(lowLiq?.count).toBe(2);
    expect(newPool?.count).toBe(1);
  });

  it('extracts topReason phrases within loser group', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, topReasons: ['high-volume', 'fresh-launch'] }),
      makeApprovalFixture({ contract: CONTRACT_B, topReasons: ['fresh-launch'] }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -5  },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const freshLaunch = result.loserStats.topReasonPhrases.find(p => p.phrase === 'fresh-launch');
    expect(freshLaunch?.count).toBe(2);
  });

  it('returns null group averages when no candidates in group', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    // loserStats should be empty
    expect(result.loserStats.count).toBe(0);
    expect(result.loserStats.avgApprovalScore).toBeNull();
  });
});

// ── Possible separators tests ─────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — possible separators', () => {
  it('detects meaningful numeric difference between winner/loser groups', () => {
    // Large priceChangePct difference: winners=200, losers=20 (900% relative diff > 5%)
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 200 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct:  20 }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const sep = result.possibleSeparators.find(s => s.field === 'approvalPriceChangePct');
    expect(sep).not.toBeUndefined();
    expect(sep?.winnerValue).toBe('200.00');
    expect(sep?.loserValue).toBe('20.00');
  });

  it('skips numeric fields where relative difference < 5%', () => {
    // Scores very similar: 80 vs 81 → <2% difference
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80 }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 81 }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const sep = result.possibleSeparators.find(s => s.field === 'approvalScore');
    expect(sep).toBeUndefined();
  });

  it('detects clusterRisk distribution difference', () => {
    // 100% CLEAN in winners, 100% WATCH in losers → 100% rate difference
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, clusterRisk: 'CLEAN' }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, clusterRisk: 'WATCH'  }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const cleanSep = result.possibleSeparators.find(s => s.field === 'clusterRisk=CLEAN');
    expect(cleanSep).not.toBeUndefined();
  });

  it('detects warning phrase present in >=50% of losers but absent in winners', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, warnings: [] }),  // winner
      makeApprovalFixture({ contract: CONTRACT_B, warnings: ['suspicious-wallet'] }),  // loser
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const phraseSep = result.possibleSeparators.find(
      s => s.field === 'warning phrase' && s.loserValue.includes('suspicious-wallet'),
    );
    expect(phraseSep).not.toBeUndefined();
  });

  it('includes sample size note in separator notes', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 200 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct:  20 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc],
    });
    const sep = result.possibleSeparators.find(s => s.field === 'approvalPriceChangePct');
    expect(sep?.note).toContain('research only');
    expect(sep?.note).toContain('n=');
  });

  it('returns empty possibleSeparators when no priced candidates', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [],
    });
    expect(result.possibleSeparators).toHaveLength(0);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────

describe('renderRipperEntryFeatureAutopsy', () => {
  it('includes safety header and footer', () => {
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [], observationPaths: [], outcomePaths: [], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows no-candidates message when approvals is empty', () => {
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [], observationPaths: [], outcomePaths: [], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('no candidates');
  });

  it('shows winner/loser group stats', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 90 }),
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 60 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('WINNERS');
    expect(out).toContain('LOSERS');
    expect(out).toContain('GROUP COMPARISON');
  });

  it('shows possible separators section', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 200 }),
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct:  20 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -10 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('POSSIBLE SEPARATORS');
    expect(out).toContain('Exploratory');
  });

  it('shows "Do Not Build Yet" section', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('DO NOT BUILD YET');
    expect(out).toContain('Do not create gates');
    expect(out).toContain('Do not enable real trading');
  });

  it('shows per-candidate features including symbol and outcome', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARDIAN', priceChangePct: 150 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [oc], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('$GUARDIAN');
    expect(out).toContain('+49.9%');
    expect(out).toContain('WINNER');
  });

  it('renders optional market fields only when present', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, liquidityUsd: 150_000, volumeUsd: 80_000 }),
    ]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [], nowMs: BASE_MS,
    });
    const out = renderRipperEntryFeatureAutopsy(result);
    expect(out).toContain('liquidityUsd');
    expect(out).toContain('volumeUsd');
  });
});

// ── Safety fields tests ───────────────────────────────────────────────────────

describe('runRipperEntryFeatureAutopsy — safety fields', () => {
  it('all safety fields locked correctly', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [ap], observationPaths: [], outcomePaths: [], nowMs: BASE_MS,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields locked on empty run', () => {
    const result = runRipperEntryFeatureAutopsy({
      approvalPaths: [], observationPaths: [], outcomePaths: [],
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
