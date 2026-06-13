import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovedObservationAutopsy,
  renderRipperApprovedObservationAutopsy,
  type ObservationClassification,
} from '../src/token-grab/ripperApprovedObservationAutopsy';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Test fixture helpers ───────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function makeSignal(overrides: {
  contract?: string;
  symbol?: string;
  priceChangePct?: number;
} = {}) {
  return {
    id:            'sig-id',
    source:        'test',
    sourceKind:    'dex',
    discoveredAt:  BASE_ISO,
    contract:      overrides.contract ?? CONTRACT_A,
    symbol:        overrides.symbol,
    priceChangePct: overrides.priceChangePct ?? 5,
    warnings:      [],
  };
}

function makeApprovalFixture(overrides: {
  contract?:      string;
  symbol?:        string;
  ripperScore?:   number;
  ageMinutes?:    number;
  capturedAt?:    string;
  clusterRisk?:   string;
  priceChangePct?: number;
} = {}) {
  return {
    id:              'fix-id',
    capturedAt:      overrides.capturedAt ?? BASE_ISO,
    source:          'test',
    sourceKind:      'dex',
    normalizedSignal: makeSignal({
      contract:      overrides.contract ?? CONTRACT_A,
      symbol:        overrides.symbol,
      priceChangePct: overrides.priceChangePct,
    }),
    ripperInput:     null,
    ripperScore:     overrides.ripperScore ?? 80,
    ageMinutes:      overrides.ageMinutes  ?? 8,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers:        [],
    topReasons:      [],
    warnings:        [],
    raw:             { clusterRisk: overrides.clusterRisk ?? 'CLEAN' },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function makeObsFixture(overrides: {
  contract?:      string;
  symbol?:        string;
  ripperScore?:   number;
  ageMinutes?:    number;
  capturedAt?:    string;
  priceChangePct?: number;
} = {}) {
  return {
    ...makeApprovalFixture({
      contract:      overrides.contract,
      symbol:        overrides.symbol,
      ripperScore:   overrides.ripperScore,
      ageMinutes:    overrides.ageMinutes,
      capturedAt:    overrides.capturedAt,
      priceChangePct: overrides.priceChangePct,
    }),
    buyGateDecision:        'BUY_APPROVED_PAPER',
    postApprovalObservation: true,
    originalApprovedAt:      BASE_ISO,
  };
}

function makeOutcomeFile(candidates: Array<{
  contractKey:        string;
  pctChangeFromEntry?: number | null;
  multipleFromEntry?:  number | null;
}>) {
  return {
    generatedAt: BASE_ISO,
    candidates:  candidates.map(c => ({
      contractKey:        c.contractKey,
      pctChangeFromEntry: c.pctChangeFromEntry ?? null,
      multipleFromEntry:  c.multipleFromEntry  ?? null,
    })),
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raoa-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

// ── empty / missing paths ─────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — empty inputs', () => {
  it('returns 0 matched candidates when no approval files provided', () => {
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [],
      observationPaths: [],
      outcomePaths:     [],
    });
    expect(result.matchedCandidates).toBe(0);
    expect(result.approvalsRead).toBe(0);
  });

  it('counts missing files correctly', () => {
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [path.join(tmpDir, 'no-approvals.jsonl')],
      observationPaths: [path.join(tmpDir, 'no-obs.jsonl')],
      outcomePaths:     [path.join(tmpDir, 'no-outcome.json')],
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.observationFilesMissing).toBe(1);
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.matchedCandidates).toBe(0);
  });

  it('safety fields are set correctly on empty result', () => {
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [],
      observationPaths: [],
      outcomePaths:     [],
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── approval reading ──────────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — approval reading', () => {
  it('reads BUY_APPROVED_PAPER fixtures only', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      { ...makeApprovalFixture({ contract: CONTRACT_B }), buyGateDecision: 'BUY_REJECTED' },
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    expect(result.approvalsRead).toBe(1);
    expect(result.matchedCandidates).toBe(1);
    expect(result.candidates[0].contractKey).toBe(CONTRACT_A);
  });

  it('deduplicates: keeps earliest capturedAt when same contractKey appears twice', () => {
    const earlier = new Date(BASE_MS - 60_000).toISOString();
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO,  ripperScore: 85 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier, ripperScore: 70 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    expect(result.matchedCandidates).toBe(1);
    // Takes the earliest capturedAt → score 70
    expect(result.candidates[0].approvalScore).toBe(70);
  });

  it('reads across multiple approval JSONL files', () => {
    const p1 = writeApprovalJsonl('cycle1.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const p2 = writeApprovalJsonl('cycle2.jsonl', [makeApprovalFixture({ contract: CONTRACT_B })]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [p1, p2],
      observationPaths: [],
      outcomePaths:     [],
    });

    expect(result.matchedCandidates).toBe(2);
    expect(result.approvalFilesRead).toBe(2);
  });

  it('captures approvalScore, approvalAgeMinutes, and approvalClusterRisk', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 82, ageMinutes: 9, clusterRisk: 'WATCH' }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    const c = result.candidates[0];
    expect(c.approvalScore).toBe(82);
    expect(c.approvalAgeMinutes).toBe(9);
    expect(c.approvalClusterRisk).toBe('WATCH');
  });

  it('captures approvalPriceChangePct from normalizedSignal', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 12.5 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    expect(result.candidates[0].approvalPriceChangePct).toBe(12.5);
  });
});

// ── observation reading ───────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — observation reading', () => {
  it('joins approval with latest observation by contractKey', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80, ageMinutes: 8 }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 65, ageMinutes: 15 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    const c = result.candidates[0];
    expect(c.approvalScore).toBe(80);
    expect(c.latestObsScore).toBe(65);
    expect(c.latestObsAgeMinutes).toBe(15);
    expect(c.scoreDelta).toBe(-15);
  });

  it('selects observation with highest ageMinutes as latest', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80 }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 70, ageMinutes: 5  }),
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 55, ageMinutes: 20 }),  // latest
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 60, ageMinutes: 10 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.candidates[0].latestObsScore).toBe(55);
    expect(result.candidates[0].latestObsAgeMinutes).toBe(20);
  });

  it('falls back to capturedAt desc when ageMinutes is absent', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const earlier  = new Date(BASE_MS - 300_000).toISOString();
    const laterIso = new Date(BASE_MS + 300_000).toISOString();

    const obsPath = writeObsJsonl('obs.jsonl', [
      { ...makeObsFixture({ contract: CONTRACT_A, ripperScore: 70 }), ageMinutes: undefined, capturedAt: earlier  },
      { ...makeObsFixture({ contract: CONTRACT_A, ripperScore: 50 }), ageMinutes: undefined, capturedAt: laterIso },
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.candidates[0].latestObsScore).toBe(50);
  });

  it('counts obsCount correctly for a candidate with multiple observations', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5  }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 20 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.candidates[0].obsCount).toBe(3);
  });

  it('sets obsCount=0 and null obs fields when no observations for a candidate', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    const c = result.candidates[0];
    expect(c.obsCount).toBe(0);
    expect(c.latestObsScore).toBeNull();
    expect(c.latestObsAgeMinutes).toBeNull();
    expect(c.scoreDelta).toBeNull();
  });

  it('reads across multiple observation JSONL files', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const obs1 = writeObsJsonl('obs1.jsonl', [makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5  })]);
    const obs2 = writeObsJsonl('obs2.jsonl', [makeObsFixture({ contract: CONTRACT_A, ageMinutes: 15 })]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obs1, obs2],
      outcomePaths:     [],
    });

    expect(result.candidates[0].obsCount).toBe(2);
    expect(result.candidates[0].latestObsAgeMinutes).toBe(15);
  });
});

// ── outcome reading ───────────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — outcome reading', () => {
  it('matches outcome by contractKey', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9, multipleFromEntry: 1.499 },
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    const c = result.candidates[0];
    expect(c.outcomePctChange).toBe(49.9);
    expect(c.outcomeMultiple).toBe(1.499);
  });

  it('leaves outcomePctChange null when contractKey not in any outcome file', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_B, pctChangeFromEntry: 10 },
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.candidates[0].outcomePctChange).toBeNull();
  });

  it('uses latest checkpointAt when same contractKey appears across multiple outcome files', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const earlier = new Date(BASE_MS - 3_600_000).toISOString();
    const later   = new Date(BASE_MS + 3_600_000).toISOString();

    const outcome1 = writeOutcomeJson('outcomes1.json', {
      generatedAt: earlier,
      checkpointAt: earlier,
      candidates:  [{ contractKey: CONTRACT_A, pctChangeFromEntry: 5.0,  multipleFromEntry: 1.05 }],
    });
    const outcome2 = writeOutcomeJson('outcomes2.json', {
      generatedAt: later,
      checkpointAt: later,
      candidates:  [{ contractKey: CONTRACT_A, pctChangeFromEntry: 49.9, multipleFromEntry: 1.499 }],
    });

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcome1, outcome2],
    });

    expect(result.candidates[0].outcomePctChange).toBe(49.9);
  });

  it('handles null pctChangeFromEntry in outcome (price lookup failed)', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: null },
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.candidates[0].outcomePctChange).toBeNull();
    expect(result.candidates[0].classification).toBe('PENDING_PRICE');
  });
});

// ── classification ────────────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — classification', () => {
  function setupAndClassify(opts: {
    obsScore?:     number;
    outcomePct?:   number | null;
    approvalScore?: number;
  }): ObservationClassification {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: opts.approvalScore ?? 80 }),
    ]);
    const obsFiles: string[] = [];
    if (opts.obsScore !== undefined) {
      obsFiles.push(writeObsJsonl('obs.jsonl', [
        makeObsFixture({ contract: CONTRACT_A, ripperScore: opts.obsScore }),
      ]));
    }
    const outcomeFiles: string[] = [];
    if (opts.outcomePct !== undefined) {
      outcomeFiles.push(writeOutcomeJson('outcomes.json', makeOutcomeFile([
        { contractKey: CONTRACT_A, pctChangeFromEntry: opts.outcomePct },
      ])));
    }

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: obsFiles,
      outcomePaths:     outcomeFiles,
      nowMs:            BASE_MS,
    });
    return result.candidates[0].classification;
  }

  it('classifies STILL_STRONG when outcome > 0 and obs score >= 75', () => {
    expect(setupAndClassify({ obsScore: 78, outcomePct: 49.9 })).toBe('STILL_STRONG');
  });

  it('classifies STILL_STRONG when obs score exactly 75', () => {
    expect(setupAndClassify({ obsScore: 75, outcomePct: 10 })).toBe('STILL_STRONG');
  });

  it('classifies EARLY_WINNER when outcome > 0 and obs score < 75', () => {
    expect(setupAndClassify({ obsScore: 60, outcomePct: 49.9 })).toBe('EARLY_WINNER');
  });

  it('classifies FADED when outcome in (-25, 0] and obs score < 75', () => {
    expect(setupAndClassify({ obsScore: 55, outcomePct: -10 })).toBe('FADED');
  });

  it('classifies FADED when outcome exactly 0 and obs score < 75', () => {
    expect(setupAndClassify({ obsScore: 60, outcomePct: 0 })).toBe('FADED');
  });

  it('classifies CRUSHED when outcome <= -25', () => {
    expect(setupAndClassify({ obsScore: 60, outcomePct: -25 })).toBe('CRUSHED');
  });

  it('classifies CRUSHED when outcome is deeply negative regardless of obs score', () => {
    expect(setupAndClassify({ obsScore: 80, outcomePct: -42.7 })).toBe('CRUSHED');
  });

  it('classifies PENDING_PRICE when no outcome file provided', () => {
    expect(setupAndClassify({ obsScore: 65 })).toBe('PENDING_PRICE');
  });

  it('classifies PENDING_PRICE when outcome pctChange is null', () => {
    expect(setupAndClassify({ obsScore: 65, outcomePct: null })).toBe('PENDING_PRICE');
  });

  it('classifies UNKNOWN when outcome > 0 and no observation data', () => {
    expect(setupAndClassify({ outcomePct: 30 })).toBe('UNKNOWN');
  });

  it('classifies UNKNOWN when outcome in (-25, 0] and obs score >= 75', () => {
    expect(setupAndClassify({ obsScore: 80, outcomePct: -5 })).toBe('UNKNOWN');
  });
});

// ── aggregates ────────────────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — aggregates', () => {
  it('counts winners and losers correctly', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
      // CONTRACT_C has no outcome
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.winners).toBe(1);
    expect(result.losers).toBe(1);
    expect(result.pendingPrice).toBe(1);
    expect(result.pricedCandidates).toBe(2);
  });

  it('computes avgApprovalScore across all candidates', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80 }),
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 60 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    expect(result.avgApprovalScore).toBe(70);
  });

  it('computes avgLatestObsScore across observed candidates', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 60 }),
      makeObsFixture({ contract: CONTRACT_B, ripperScore: 80 }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.avgLatestObsScore).toBe(70);
  });

  it('computes avgScoreDelta correctly', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 80 }),
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 60 }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 70 }),  // delta = -10
      makeObsFixture({ contract: CONTRACT_B, ripperScore: 50 }),  // delta = -10
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.avgScoreDelta).toBe(-10);
  });

  it('computes avgOutcomePctChange across priced candidates only', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 40 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -20 },
      // C has no price
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.avgOutcomePctChange).toBe(10);  // (40 + -20) / 2
  });

  it('lists fadedFromStrong candidates (approvalScore >= 75, latestObsScore < 75)', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 85 }),  // strong
      makeApprovalFixture({ contract: CONTRACT_B, ripperScore: 60 }),  // already weak
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 55 }),  // faded
      makeObsFixture({ contract: CONTRACT_B, ripperScore: 50 }),  // was already weak
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
    });

    expect(result.fadedFromStrong).toHaveLength(1);
    expect(result.fadedFromStrong[0].contractKey).toBe(CONTRACT_A);
  });

  it('topWinners lists up to 5 best-outcome candidates', () => {
    const fixtures = [CONTRACT_A, CONTRACT_B, CONTRACT_C].map((c, i) =>
      makeApprovalFixture({ contract: c, ripperScore: 80 }),
    );
    const approvalPath = writeApprovalJsonl('cycle.jsonl', fixtures);
    const outcomePath  = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: 20   },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -5   },
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.topWinners).toHaveLength(2);
    expect(result.topWinners[0].contractKey).toBe(CONTRACT_A);
  });

  it('worstLosers lists worst-outcome candidates', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -42.7 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -5    },
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.worstLosers).toHaveLength(2);
    expect(result.worstLosers[0].contractKey).toBe(CONTRACT_A);
  });

  it('classificationCounts sums to matchedCandidates', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
    });

    const total = Object.values(result.classificationCounts).reduce((s, n) => s + n, 0);
    expect(total).toBe(result.matchedCandidates);
  });

  it('candidates sorted: priced first (desc by outcomePct), then pending', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -20 },
      { contractKey: CONTRACT_B, pctChangeFromEntry:  50 },
      // C pending
    ]));

    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
    });

    expect(result.candidates[0].contractKey).toBe(CONTRACT_B);  // best outcome
    expect(result.candidates[1].contractKey).toBe(CONTRACT_A);
    expect(result.candidates[2].contractKey).toBe(CONTRACT_C);  // pending last
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperApprovedObservationAutopsy', () => {
  it('includes safety header and footer', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows matched candidates count', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
    ]);
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('2');
    expect(out).toContain('Matched candidates');
  });

  it('shows classification counts section', () => {
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [],
      observationPaths: [],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('Classifications');
    expect(out).toContain('STILL_STRONG');
    expect(out).toContain('PENDING_PRICE');
  });

  it('shows top winners section when winners exist', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const outcomePath = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [outcomePath],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('TOP WINNERS');
    expect(out).toContain('+49.9%');
  });

  it('shows faded-from-strong section when applicable', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, ripperScore: 85 }),
    ]);
    const obsPath = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ripperScore: 55 }),
    ]);
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [obsPath],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('FADED FROM STRONG');
  });

  it('shows no-candidate message when approvals is empty', () => {
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [],
      observationPaths: [],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    const out = renderRipperApprovedObservationAutopsy(result);
    expect(out).toContain('no candidates found');
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperApprovedObservationAutopsy — safety fields', () => {
  it('result always has all safety fields locked correctly', () => {
    const approvalPath = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
    ]);
    const result = runRipperApprovedObservationAutopsy({
      approvalPaths:    [approvalPath],
      observationPaths: [],
      outcomePaths:     [],
      nowMs:            BASE_MS,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
