import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperExitSim,
  renderRipperExitSim,
  type ExitRuleId,
  type ExitSimClassification,
} from '../src/token-grab/ripperExitSim';

// ── Time anchors ──────────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

// ── Contract keys ─────────────────────────────────────────────────────────────

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_C = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeSignal(opts: {
  contract?:      string;
  symbol?:        string;
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
    }),
    ripperInput:     null,
    ripperScore:     opts.ripperScore ?? 85,
    ageMinutes:      opts.ageMinutes  ?? 6,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers:        [],
    topReasons:      [],
    warnings:        [],
    raw:             { clusterRisk: 'CLEAN' },
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
    ...makeApprovalFixture(opts),
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
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-test-')); });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRule(rules: ReturnType<typeof runRipperExitSim>['rules'], id: ExitRuleId) {
  const r = rules.find(r => r.ruleId === id);
  if (!r) throw new Error(`Rule ${id} not found`);
  return r;
}

function findCand(
  rules: ReturnType<typeof runRipperExitSim>['rules'],
  ruleId: ExitRuleId,
  contractKey: string,
) {
  return findRule(rules, ruleId).candidates.find(c => c.contractKey === contractKey) ?? null;
}

// Relative gain helper — mirrors the module's formula
function relGain(approvalPct: number, obsPct: number): number {
  return ((1 + obsPct / 100) / (1 + approvalPct / 100) - 1) * 100;
}

// ── Loading tests ─────────────────────────────────────────────────────────────

describe('runRipperExitSim — data loading', () => {
  it('loads approvals by contractKey and skips non-approved fixtures', () => {
    const p = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      { ...makeApprovalFixture({ contract: CONTRACT_B }), buyGateDecision: 'BUY_REJECTED' },
    ]);
    const result = runRipperExitSim({
      approvalPaths: [p], observationPaths: [], outcomePaths: [],
    });
    expect(result.matchedCandidates).toBe(1);
    expect(result.approvalsRead).toBe(1);
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand).not.toBeNull();
  });

  it('deduplicates approvals: keeps earliest capturedAt per contractKey', () => {
    const earlier = new Date(BASE_MS - 60_000).toISOString();
    const p = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: BASE_ISO,  ripperScore: 90 }),
      makeApprovalFixture({ contract: CONTRACT_A, capturedAt: earlier, ripperScore: 70 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [p], observationPaths: [], outcomePaths: [] });
    expect(result.matchedCandidates).toBe(1);
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.approvalScore).toBe(70); // earliest
  });

  it('reads observations and attaches to correct contractKey', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 65 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    expect(result.observationsRead).toBe(1);
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.latestObsScore).toBe(65);
    expect(cand?.latestObsAgeMinutes).toBe(10);
  });

  it('selects latest observation by highest ageMinutes for display fields', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 80 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 20, ripperScore: 55 }), // latest
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 70 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.latestObsScore).toBe(55);
    expect(cand?.latestObsAgeMinutes).toBe(20);
  });

  it('loads outcome pctChange by contractKey', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('outcomes.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.outcomePctChange).toBe(49.9);
  });

  it('keeps latest checkpointAt outcome when same contractKey appears twice', () => {
    const earlier = new Date(BASE_MS - 3_600_000).toISOString();
    const later   = new Date(BASE_MS + 3_600_000).toISOString();
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc1 = writeOutcomeJson('out1.json', {
      generatedAt: earlier, checkpointAt: earlier,
      candidates: [{ contractKey: CONTRACT_A, pctChangeFromEntry: 5 }],
    });
    const oc2 = writeOutcomeJson('out2.json', {
      generatedAt: later, checkpointAt: later,
      candidates: [{ contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 }],
    });
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc1, oc2] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.outcomePctChange).toBe(49.9);
  });

  it('counts missing files', () => {
    const result = runRipperExitSim({
      approvalPaths:    [path.join(tmpDir, 'missing-approvals.jsonl')],
      observationPaths: [path.join(tmpDir, 'missing-obs.jsonl')],
      outcomePaths:     [path.join(tmpDir, 'missing-outcomes.json')],
    });
    expect(result.approvalFilesMissing).toBe(1);
    expect(result.observationFilesMissing).toBe(1);
    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.matchedCandidates).toBe(0);
  });

  it('emits all 10 rule summaries regardless of data', () => {
    const result = runRipperExitSim({ approvalPaths: [], observationPaths: [], outcomePaths: [] });
    expect(result.rules).toHaveLength(10);
  });
});

// ── hold-to-checkpoint ────────────────────────────────────────────────────────

describe('runRipperExitSim — hold-to-checkpoint', () => {
  it('returns outcomePctChange as simulatedPctResult', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([{ contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 }]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(49.9);
    expect(cand?.classification).toBe('WIN');
    expect(cand?.exitReason).toBe('held-to-checkpoint');
  });

  it('returns null when no outcome file provided', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBeNull();
    expect(cand?.classification).toBe('PENDING_PRICE');
  });

  it('classifies LOSS when outcome is negative', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([{ contractKey: CONTRACT_A, pctChangeFromEntry: -42.7 }]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.classification).toBe('LOSS');
  });
});

// ── TP / SL rules ─────────────────────────────────────────────────────────────

describe('runRipperExitSim — take-profit / stop-loss simulation', () => {
  // Approval priceChangePct = 50% from pool creation
  // At TP +5%: obs priceChangePct such that relGain >= 5
  //   Need: (1 + x/100) / 1.50 >= 1.05 → x >= 57.5
  // At SL -10%: obs priceChangePct such that relGain <= -10
  //   Need: (1 + x/100) / 1.50 <= 0.90 → x <= 35

  it('tp5-sl10: triggers TP when obs crosses +5% relative gain', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  priceChangePct: 55 }), // +3.3% — no trigger
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 8,  priceChangePct: 57.5 }), // +5% — TP hit
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'tp5-sl10', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(5);
    expect(cand?.classification).toBe('WIN');
    expect(cand?.exitReason).toContain('tp5-hit');
  });

  it('tp10-sl10: triggers SL when obs crosses -10% relative gain', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  priceChangePct: 46 }), // ~-2.7% — no trigger
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 8,  priceChangePct: 34 }), // ~-10.7% — SL hit
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'tp10-sl10', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(-10);
    expect(cand?.classification).toBe('LOSS');
    expect(cand?.exitReason).toContain('sl10-hit');
  });

  it('tp5-sl10: no trigger falls through to outcome', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    // Observations that don't cross TP or SL (stay between -9.9% and +4.9%)
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5, priceChangePct: 53 }), // +2%
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 8, priceChangePct: 54 }), // +2.7%
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 1.3 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'tp5-sl10', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(1.3); // fell through to outcome
    expect(cand?.exitReason).toContain('no-trigger-held-to-checkpoint');
  });

  it('tp5-sl10: no trigger and no outcome → PENDING_PRICE', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5, priceChangePct: 53 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'tp5-sl10', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBeNull();
    expect(cand?.exitReason).toContain('no-trigger-no-outcome');
  });

  it('tp30-sl20: does not trigger TP early — correctly walks observations in age order', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    // Obs at age 5m: +15% relative — below TP +30%, above SL -20%
    // Obs at age 10m: +35% relative — hits TP
    // priceChangePct for +15% rel from 50%: (1.15 * 1.50 - 1) * 100 = 72.5
    // priceChangePct for +35% rel from 50%: (1.35 * 1.50 - 1) * 100 = 102.5
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  priceChangePct: 72.5 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, priceChangePct: 102.5 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'tp30-sl20', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(30);
    expect(cand?.exitReason).toContain('tp30-hit-at-10m');
  });

  it('missing approvalPriceChangePct skips price-based checks and falls through', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      // no priceChangePct in signal — omit the field
      { ...makeApprovalFixture({ contract: CONTRACT_A }), normalizedSignal: { ...makeSignal({ contract: CONTRACT_A }) } },
    ]);
    // Observations have prices but approval pct is undefined → can't compute relGain
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5, priceChangePct: 60 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 10 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'tp5-sl10', CONTRACT_A);
    // Falls through since can't compute relative gain
    expect(cand?.simulatedPctResult).toBe(10);
    expect(cand?.exitReason).toContain('no-trigger-held-to-checkpoint');
  });
});

// ── Score-drop exit ───────────────────────────────────────────────────────────

describe('runRipperExitSim — score-exit rules', () => {
  it('score-exit-75: exits at first obs where score drops below 75', () => {
    // Approval at 50% from pool creation
    // Obs at 5m: score=80 (no exit), priceChangePct=55 (+3.3%)
    // Obs at 10m: score=70 (exit!), priceChangePct=53 (+2%)
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 80, priceChangePct: 55 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 70, priceChangePct: 53 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'score-exit-75', CONTRACT_A);
    const expected = ((1 + 53 / 100) / (1 + 50 / 100) - 1) * 100;
    expect(cand?.simulatedPctResult).toBeCloseTo(expected, 4);
    expect(cand?.exitReason).toContain('score-below-75-at-10m');
  });

  it('score-exit-60: does not exit at score=65 but exits at score=55', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 65, priceChangePct: 54 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 55, priceChangePct: 51 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand60 = findCand(result.rules, 'score-exit-60', CONTRACT_A);
    const cand75 = findCand(result.rules, 'score-exit-75', CONTRACT_A);
    // score-exit-75 triggers at 5m (score=65 < 75)
    expect(cand75?.exitReason).toContain('score-below-75-at-5m');
    // score-exit-60 triggers at 10m (score=55 < 60)
    expect(cand60?.exitReason).toContain('score-below-60-at-10m');
  });

  it('score-exit-75: falls through to outcome when score never drops below 75', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 85 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 80 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 15 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [oc] });
    const cand = findCand(result.rules, 'score-exit-75', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(15);
    expect(cand?.exitReason).toBe('score-held-strong-to-checkpoint');
  });
});

// ── Force-exit rules ──────────────────────────────────────────────────────────

describe('runRipperExitSim — force-exit rules', () => {
  it('force-exit-5m: exits at obs closest to 5 minutes', () => {
    // Approval at 50% from pool, obs at 5m at 57.5% → +5% relative
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  priceChangePct: 57.5 }),
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, priceChangePct: 54 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'force-exit-5m', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBeCloseTo(5, 4);
    expect(cand?.exitReason).toContain('force-exit-at-5m');
  });

  it('force-exit-8m: picks closest obs to 8m when exact match absent', () => {
    // Obs at 6m and 10m — 10m is closer to 8 than 6m is (diff=2 vs 2, actually tie → 6m wins)
    // Let's use 7m and 12m: 7m is closer to 8 (diff=1 vs diff=4)
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 7,  priceChangePct: 56 }), // closer to 8m
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 12, priceChangePct: 52 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'force-exit-8m', CONTRACT_A);
    expect(cand?.exitReason).toContain('force-exit-at-7m');
  });

  it('force-exit-5m: PENDING_PRICE when no observations available', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [] });
    const cand = findCand(result.rules, 'force-exit-5m', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBeNull();
    expect(cand?.classification).toBe('PENDING_PRICE');
  });
});

// ── Hybrid rule ───────────────────────────────────────────────────────────────

describe('runRipperExitSim — hybrid-tp10-sl10-score75', () => {
  it('exits on score drop before TP is reached', () => {
    // Score drops at 5m → exits there, even if price would eventually hit TP
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 60, priceChangePct: 53 }),  // score < 75
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 10, ripperScore: 50, priceChangePct: 65 }),  // would be +10%
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'hybrid-tp10-sl10-score75', CONTRACT_A);
    // Should exit at 5m on score drop, not wait for TP at 10m
    expect(cand?.exitReason).toContain('hybrid-score-below-75-at-5m');
    const expected = ((1 + 53 / 100) / (1 + 50 / 100) - 1) * 100;
    expect(cand?.simulatedPctResult).toBeCloseTo(expected, 4);
  });

  it('exits on TP when score stays strong', () => {
    // score stays >= 75 throughout, TP triggers
    // TP +10% clear: use obsPct=67 → relGain(50,67) = (1.67/1.50 - 1)*100 ≈ +11.3%
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5,  ripperScore: 85, priceChangePct: 55 }), // +3.3%, no trigger
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 8,  ripperScore: 80, priceChangePct: 67 }), // ~+11.3%, TP hit
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'hybrid-tp10-sl10-score75', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBe(10);
    expect(cand?.exitReason).toContain('hybrid-tp10-hit-at-8m');
  });
});

// ── Pending price / missing observations ──────────────────────────────────────

describe('runRipperExitSim — missing data handling', () => {
  it('PENDING_PRICE when no outcome and no observations', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [] });
    for (const rule of result.rules) {
      const cand = rule.candidates.find(c => c.contractKey === CONTRACT_A);
      expect(cand?.classification).toBe('PENDING_PRICE');
    }
  });

  it('obsCount=0 and null latest obs fields when no observations for a candidate', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [] });
    const cand = findCand(result.rules, 'hold-to-checkpoint', CONTRACT_A);
    expect(cand?.latestObsScore).toBeNull();
    expect(cand?.latestObsAgeMinutes).toBeNull();
  });

  it('NO_EXIT_SIGNAL for score rules when obs exist but no outcome', () => {
    // Obs with score >= 75 throughout (never triggers score-exit) AND no outcome
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5, ripperScore: 85 }),
    ]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [] });
    const cand = findCand(result.rules, 'score-exit-75', CONTRACT_A);
    expect(cand?.simulatedPctResult).toBeNull();
    expect(cand?.classification).toBe('NO_EXIT_SIGNAL');
  });
});

// ── Rule summaries ────────────────────────────────────────────────────────────

describe('runRipperExitSim — rule summary aggregates', () => {
  function setup3Candidates() {
    // CONTRACT_A: outcome +49.9% (winner)
    // CONTRACT_B: outcome -42.7% (loser / CRUSHED)
    // CONTRACT_C: no outcome (pending)
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    ]));
    return { ap, oc };
  }

  it('counts wins/losses/pending correctly for hold-to-checkpoint', () => {
    const { ap, oc } = setup3Candidates();
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.wins).toBe(1);
    expect(rule.losses).toBe(1);
    expect(rule.pendingPrice).toBe(1);
    expect(rule.pricedCandidates).toBe(2);
  });

  it('computes winRate correctly (wins / priced)', () => {
    const { ap, oc } = setup3Candidates();
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.winRate).toBeCloseTo(50, 1); // 1/2
  });

  it('computes avgPctResult across priced candidates only', () => {
    const { ap, oc } = setup3Candidates();
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.avgPctResult).toBeCloseTo((49.9 + -42.7) / 2, 2);
  });

  it('computes medianPctResult', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry:  20 },
      { contractKey: CONTRACT_C, pctChangeFromEntry: -5  },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    // sorted: [-5, 10, 20] → median = 10
    expect(rule.medianPctResult).toBe(10);
  });

  it('bestCandidate has highest simulatedPctResult', () => {
    const { ap, oc } = setup3Candidates();
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.bestCandidate?.contractKey).toBe(CONTRACT_A);
  });

  it('worstCandidate has lowest simulatedPctResult', () => {
    const { ap, oc } = setup3Candidates();
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.worstCandidate?.contractKey).toBe(CONTRACT_B);
  });

  it('avoidedCrushed: counts candidates where rule got out better than outcome <= -25%', () => {
    // CONTRACT_B outcome = -42.7% — a SL -10% rule would exit at -10%, better than -42.7%
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_B, priceChangePct: 50 }),
    ]);
    // Obs that crosses SL -10%: use 34 → relGain(50,34) ≈ -10.7%, clearly triggers
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_B, ageMinutes: 5, priceChangePct: 34 }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'tp10-sl10');
    expect(rule.avoidedCrushed).toBe(1);
  });

  it('capturedEarlyWinner: counts candidates where outcome>0 and simResult>0', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, priceChangePct: 50 }),
    ]);
    // TP +5% at obs (priceChangePct 57.5)
    const op = writeObsJsonl('obs.jsonl', [
      makeObsFixture({ contract: CONTRACT_A, ageMinutes: 5, priceChangePct: 57.5 }),
    ]);
    // Outcome is also positive
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 3 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [op], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'tp5-sl10');
    expect(rule.capturedEarlyWinner).toBe(1);
  });

  it('candidates sorted: priced desc then pending', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A }),
      makeApprovalFixture({ contract: CONTRACT_B }),
      makeApprovalFixture({ contract: CONTRACT_C }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: -10 },
      { contractKey: CONTRACT_B, pctChangeFromEntry:  30 },
      // C pending
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc] });
    const rule = findRule(result.rules, 'hold-to-checkpoint');
    expect(rule.candidates[0].contractKey).toBe(CONTRACT_B); // best
    expect(rule.candidates[1].contractKey).toBe(CONTRACT_A);
    expect(rule.candidates[2].contractKey).toBe(CONTRACT_C); // pending last
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperExitSim', () => {
  it('includes safety header and footer', () => {
    const result = runRipperExitSim({ approvalPaths: [], observationPaths: [], outcomePaths: [], nowMs: BASE_MS });
    const out = renderRipperExitSim(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows no-candidate message when approvals is empty', () => {
    const result = runRipperExitSim({ approvalPaths: [], observationPaths: [], outcomePaths: [], nowMs: BASE_MS });
    const out = renderRipperExitSim(result);
    expect(out).toContain('no candidates');
  });

  it('renders per-rule summary table with all 10 rules', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [], nowMs: BASE_MS });
    const out = renderRipperExitSim(result);
    expect(out).toContain('hold-to-checkpoint');
    expect(out).toContain('TP +5%');
    expect(out).toContain('TP +10%');
    expect(out).toContain('TP +20%');
    expect(out).toContain('TP +30%');
    expect(out).toContain('score < 75');
    expect(out).toContain('score < 60');
    expect(out).toContain('Force exit at 5m');
    expect(out).toContain('Force exit at 8m');
    expect(out).toContain('Hybrid');
  });

  it('shows per-rule detail with candidate rows', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'GUARD' }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry: 49.9 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc], nowMs: BASE_MS });
    const out = renderRipperExitSim(result);
    expect(out).toContain('$GUARD');
    expect(out).toContain('+49.9%');
    expect(out).toContain('WIN');
  });

  it('shows best/worst candidate lines in per-rule detail', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [
      makeApprovalFixture({ contract: CONTRACT_A, symbol: 'WINNER' }),
      makeApprovalFixture({ contract: CONTRACT_B, symbol: 'LOSER'  }),
    ]);
    const oc = writeOutcomeJson('out.json', makeOutcomeFile([
      { contractKey: CONTRACT_A, pctChangeFromEntry:  49.9 },
      { contractKey: CONTRACT_B, pctChangeFromEntry: -42.7 },
    ]));
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [oc], nowMs: BASE_MS });
    const out = renderRipperExitSim(result);
    expect(out).toContain('Best');
    expect(out).toContain('$WINNER');
    expect(out).toContain('Worst');
    expect(out).toContain('$LOSER');
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('runRipperExitSim — safety fields', () => {
  it('all safety fields are locked correctly regardless of input', () => {
    const ap = writeApprovalJsonl('cycle.jsonl', [makeApprovalFixture({ contract: CONTRACT_A })]);
    const result = runRipperExitSim({ approvalPaths: [ap], observationPaths: [], outcomePaths: [], nowMs: BASE_MS });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields locked on empty run', () => {
    const result = runRipperExitSim({ approvalPaths: [], observationPaths: [], outcomePaths: [] });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
