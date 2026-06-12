import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperEntrySim,
  renderRipperEntrySim,
  SIM_RULES,
  type RipperEntrySimResult,
} from '../src/token-grab/ripperEntrySim';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

// ── Time anchor ───────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeFixture(overrides: Partial<{
  contract:        string;
  symbol:          string;
  buyGateDecision: string;
  score:           number;
  ageMinutes:      number;
  priceChangePct:  number;
  clusterRisk:     string;
  entryPriceUsd:   number;
}> = {}): LiveRipperFixture {
  const contract = overrides.contract ?? 'ContractAAAA1111BBBB2222CCCC3333';
  return {
    id:         `fixture:${contract}`,
    capturedAt: NOW_ISO,
    source:     'dex-watch',
    sourceKind: 'DEX_NEW_POOL',
    normalizedSignal: {
      id:           contract,
      source:       'dex-watch',
      sourceKind:   'DEX_NEW_POOL',
      contract,
      symbol:       overrides.symbol ?? 'FRESH',
      discoveredAt: NOW_ISO,
      observedAt:   NOW_ISO,
      priceChangePct: overrides.priceChangePct ?? 10,
      raw: {
        entry:       { priceUsd: overrides.entryPriceUsd ?? 0.0001 },
        clusterRisk: overrides.clusterRisk ?? 'CLEAN',
      },
    },
    ripperInput:     null,
    ripperScore:     overrides.score        ?? 82,
    ageMinutes:      overrides.ageMinutes   ?? 8.5,
    buyGateDecision: overrides.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision:   'READY_TO_SNIPE_PAPER',
    blockers:        [],
    topReasons:      [],
    warnings:        [],
    raw: {
      clusterRisk:     overrides.clusterRisk ?? 'CLEAN',
      clusterProvider: 'offline',
    },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  } as unknown as LiveRipperFixture;
}

function writeJsonl(filePath: string, fixtures: LiveRipperFixture[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
}

interface OutcomeCandidate {
  contractKey: string;
  pctChangeFromEntry?: number | null;
  multipleFromEntry?: number | null;
  checkpointAt?: string;
}

function writeOutcomeFile(
  filePath: string,
  data: { checkpointAt?: string; checkpointLabel?: string; candidates: OutcomeCandidate[] },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ candidates: [], ...data }, null, 2), 'utf-8');
}

// ── Temp dir ──────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-sim-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fp(name: string): string { return path.join(tmpDir, name); }

// ── SIM_RULES structure ───────────────────────────────────────────────────────

describe('SIM_RULES', () => {
  it('exports 10 rules', () => {
    expect(SIM_RULES).toHaveLength(10);
  });

  it('first rule is current-approved and always returns true', () => {
    const rule = SIM_RULES[0];
    expect(rule.name).toBe('current-approved');
    const c = { contractKey: 'x', ageMinutes: 0, score: 0, priceChangePct: -99, clusterRisk: 'RISKY', entryPriceUsd: null, approvedAt: NOW_ISO };
    expect(rule.test(c)).toBe(true);
  });
});

// ── current approved rule ─────────────────────────────────────────────────────

describe('runRipperEntrySim — current-approved rule', () => {
  it('selects all BUY_APPROVED_PAPER fixtures', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'B', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'C', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    const rule1 = result.rules[0];
    expect(rule1.ruleName).toBe('current-approved');
    expect(rule1.selectedCount).toBe(2);
  });

  it('ignores non-approved fixtures', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ buyGateDecision: 'BUY_REJECTED' }),
      makeFixture({ contract: 'AlsoRej', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules[0].selectedCount).toBe(0);
  });

  it('dedupes by contractKey keeping first seen', () => {
    const j1 = fp('c1.jsonl');
    const j2 = fp('c2.jsonl');
    writeJsonl(j1, [makeFixture({ contract: 'DupToken', score: 90 })]);
    writeJsonl(j2, [makeFixture({ contract: 'DupToken', score: 60 })]);

    const result = runRipperEntrySim({ inputPaths: [j1, j2], nowMs: NOW_MS });

    expect(result.uniqueApprovedCandidates).toBe(1);
    expect(result.rules[0].selectedCount).toBe(1);
    // First seen (score 90) kept
    expect(result.rules[0].avgScore).toBeCloseTo(90, 1);
  });
});

// ── age-gate rules ────────────────────────────────────────────────────────────

describe('runRipperEntrySim — age rules', () => {
  it('age-gte-5m excludes candidates with ageMinutes < 5', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'TooYoung', ageMinutes: 3.5 }),
      makeFixture({ contract: 'OldEnough', ageMinutes: 6.0 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    const r = result.rules.find(r => r.ruleName === 'age-gte-5m')!;
    expect(r.selectedCount).toBe(1);
    expect(r.avgAge).toBeCloseTo(6.0, 1);
  });

  it('age-gte-8m applies stricter threshold', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Age4',  ageMinutes: 4  }),
      makeFixture({ contract: 'Age7',  ageMinutes: 7  }),
      makeFixture({ contract: 'Age10', ageMinutes: 10 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    const r8 = result.rules.find(r => r.ruleName === 'age-gte-8m')!;
    expect(r8.selectedCount).toBe(1);
  });

  it('age-gte-10m is most restrictive age filter', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Age9',  ageMinutes: 9  }),
      makeFixture({ contract: 'Age11', ageMinutes: 11 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'age-gte-10m')!.selectedCount).toBe(1);
  });

  it('excludes candidate when ageMinutes is null from age rules', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoAge' });
    (f as unknown as Record<string, unknown>).ageMinutes = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'age-gte-5m')!.selectedCount).toBe(0);
  });
});

// ── priceChangePct rules ─────────────────────────────────────────────────────

describe('runRipperEntrySim — priceChangePct rules', () => {
  it('pct-gte-0 selects only candidates with priceChangePct >= 0', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'NegPct',  priceChangePct: -5 }),
      makeFixture({ contract: 'ZeroPct', priceChangePct:  0 }),
      makeFixture({ contract: 'PosPct',  priceChangePct:  8 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'pct-gte-0')!.selectedCount).toBe(2);
  });

  it('pct-gte-2 applies minimum 2% threshold', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Pct1', priceChangePct: 1 }),
      makeFixture({ contract: 'Pct2', priceChangePct: 2 }),
      makeFixture({ contract: 'Pct5', priceChangePct: 5 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'pct-gte-2')!.selectedCount).toBe(2);
  });

  it('pct-gte-5 applies minimum 5% threshold', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Pct4', priceChangePct: 4   }),
      makeFixture({ contract: 'Pct5', priceChangePct: 5   }),
      makeFixture({ contract: 'Pct9', priceChangePct: 9.9 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'pct-gte-5')!.selectedCount).toBe(2);
  });

  it('excludes candidate when priceChangePct is null from pct rules', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoPct' });
    (f.normalizedSignal as unknown as Record<string, unknown>).priceChangePct = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'pct-gte-0')!.selectedCount).toBe(0);
  });
});

// ── combined rules ────────────────────────────────────────────────────────────

describe('runRipperEntrySim — combined rules', () => {
  it('score100-pct-gte-0 requires score >= 100 AND pct >= 0', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'HighScore', score: 105, priceChangePct:  3 }), // pass
      makeFixture({ contract: 'LowScore',  score:  80, priceChangePct:  5 }), // fail (score)
      makeFixture({ contract: 'NegPct',    score: 110, priceChangePct: -1 }), // fail (pct)
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'score100-pct-gte-0')!.selectedCount).toBe(1);
  });

  it('clean-age5-pct0 requires CLEAN AND age >= 5m AND pct >= 0', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Pass',     clusterRisk: 'CLEAN', ageMinutes: 7,  priceChangePct:  5 }), // pass
      makeFixture({ contract: 'Risky',    clusterRisk: 'RISKY', ageMinutes: 9,  priceChangePct:  5 }), // fail cluster
      makeFixture({ contract: 'TooYoung', clusterRisk: 'CLEAN', ageMinutes: 3,  priceChangePct:  5 }), // fail age
      makeFixture({ contract: 'NegPct',   clusterRisk: 'CLEAN', ageMinutes: 7,  priceChangePct: -3 }), // fail pct
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'clean-age5-pct0')!.selectedCount).toBe(1);
  });

  it('clean-age8-pct0 is stricter than clean-age5-pct0', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Age6', clusterRisk: 'CLEAN', ageMinutes: 6, priceChangePct: 5 }),
      makeFixture({ contract: 'Age9', clusterRisk: 'CLEAN', ageMinutes: 9, priceChangePct: 5 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules.find(r => r.ruleName === 'clean-age5-pct0')!.selectedCount).toBe(2);
    expect(result.rules.find(r => r.ruleName === 'clean-age8-pct0')!.selectedCount).toBe(1);
  });
});

// ── aggregate stats per rule ──────────────────────────────────────────────────

describe('runRipperEntrySim — rule aggregate stats', () => {
  it('computes avgScore for selected candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', score: 80 }),
      makeFixture({ contract: 'B', score: 100 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules[0].avgScore).toBeCloseTo(90, 1);
  });

  it('computes avgAge for selected candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', ageMinutes: 4 }),
      makeFixture({ contract: 'B', ageMinutes: 10 }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules[0].avgAge).toBeCloseTo(7.0, 1);
  });

  it('computes clusterBreakdown', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', clusterRisk: 'CLEAN' }),
      makeFixture({ contract: 'B', clusterRisk: 'CLEAN' }),
      makeFixture({ contract: 'C', clusterRisk: 'WATCH' }),
      makeFixture({ contract: 'D', clusterRisk: 'RISKY' }),
    ]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    const bd = result.rules[0].clusterBreakdown;
    expect(bd.CLEAN).toBe(2);
    expect(bd.WATCH).toBe(1);
    expect(bd.RISKY).toBe(1);
    expect(bd.UNKNOWN).toBe(0);
  });

  it('avgScore is null when no selected candidates have scores', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoScore' });
    (f as unknown as Record<string, unknown>).ripperScore = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules[0].avgScore).toBeNull();
  });
});

// ── outcome matching ──────────────────────────────────────────────────────────

describe('runRipperEntrySim — outcome matching', () => {
  it('matches candidates by contractKey to outcome data', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'TokA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'TokB', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const outcome = fp('outcomes.json');
    writeOutcomeFile(outcome, {
      checkpointAt: NOW_ISO,
      candidates:   [
        { contractKey: 'TokA', pctChangeFromEntry: -10 },
        { contractKey: 'TokB', pctChangeFromEntry:  25 },
      ],
    });

    const result = runRipperEntrySim({ inputPaths: [jsonl], outcomePaths: [outcome], nowMs: NOW_MS });

    const rule1 = result.rules[0];
    expect(rule1.matchedOutcomeCount).toBe(2);
    expect(rule1.winnersCount).toBe(1);
    expect(rule1.losersCount).toBe(1);
    expect(rule1.avgOutcomePctChange).toBeCloseTo(7.5, 5);
  });

  it('only counts matched outcomes for the subset selected by each rule', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Young', ageMinutes: 2, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Old',   ageMinutes: 9, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const outcome = fp('outcomes.json');
    writeOutcomeFile(outcome, {
      checkpointAt: NOW_ISO,
      candidates:   [
        { contractKey: 'Young', pctChangeFromEntry: -20 },
        { contractKey: 'Old',   pctChangeFromEntry:  50 },
      ],
    });

    const result = runRipperEntrySim({ inputPaths: [jsonl], outcomePaths: [outcome], nowMs: NOW_MS });

    // Rule 1 (all approved): 2 matches
    expect(result.rules[0].matchedOutcomeCount).toBe(2);
    // age-gte-5m: only Old matches -> 1 outcome
    const r5 = result.rules.find(r => r.ruleName === 'age-gte-5m')!;
    expect(r5.matchedOutcomeCount).toBe(1);
    expect(r5.winnersCount).toBe(1);
    expect(r5.avgOutcomePctChange).toBeCloseTo(50, 1);
  });

  it('computes winners and losers for matched outcome candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'W1' }),
      makeFixture({ contract: 'W2' }),
      makeFixture({ contract: 'L1' }),
    ]);

    const outcome = fp('outcomes.json');
    writeOutcomeFile(outcome, {
      checkpointAt: NOW_ISO,
      candidates:   [
        { contractKey: 'W1', pctChangeFromEntry:  30 },
        { contractKey: 'W2', pctChangeFromEntry:  10 },
        { contractKey: 'L1', pctChangeFromEntry: -15 },
      ],
    });

    const result = runRipperEntrySim({ inputPaths: [jsonl], outcomePaths: [outcome], nowMs: NOW_MS });

    expect(result.rules[0].winnersCount).toBe(2);
    expect(result.rules[0].losersCount).toBe(1);
  });

  it('uses latest-checkpointAt outcome when same contract appears in multiple outcome files', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ contract: 'Tok' })]);

    const early = fp('out1.json');
    const late  = fp('out2.json');
    const T1 = new Date(NOW_MS - 60_000).toISOString();
    const T2 = new Date(NOW_MS).toISOString();
    writeOutcomeFile(early, { checkpointAt: T1, candidates: [{ contractKey: 'Tok', pctChangeFromEntry:  50, checkpointAt: T1 }] });
    writeOutcomeFile(late,  { checkpointAt: T2, candidates: [{ contractKey: 'Tok', pctChangeFromEntry: -20, checkpointAt: T2 }] });

    const result = runRipperEntrySim({ inputPaths: [jsonl], outcomePaths: [early, late], nowMs: NOW_MS });

    // Latest checkpoint (T2) wins: -20 → loser
    expect(result.rules[0].winnersCount).toBe(0);
    expect(result.rules[0].losersCount).toBe(1);
    expect(result.rules[0].avgOutcomePctChange).toBeCloseTo(-20, 1);
  });

  it('matchedOutcomeCount is 0 when no outcome data provided', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.rules[0].matchedOutcomeCount).toBe(0);
    expect(result.rules[0].avgOutcomePctChange).toBeNull();
  });

  it('handles candidate with null pctChangeFromEntry in outcome file', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ contract: 'NoPx' })]);

    const outcome = fp('out.json');
    writeOutcomeFile(outcome, {
      checkpointAt: NOW_ISO,
      candidates:   [{ contractKey: 'NoPx', pctChangeFromEntry: null }],
    });

    const result = runRipperEntrySim({ inputPaths: [jsonl], outcomePaths: [outcome], nowMs: NOW_MS });

    expect(result.rules[0].matchedOutcomeCount).toBe(0);
    expect(result.rules[0].avgOutcomePctChange).toBeNull();
  });
});

// ── missing / empty files ─────────────────────────────────────────────────────

describe('runRipperEntrySim — missing files', () => {
  it('counts missing cycle files without throwing', () => {
    const result = runRipperEntrySim({
      inputPaths: [fp('ghost.jsonl')],
      nowMs:      NOW_MS,
    });

    expect(result.cycleFilesMissing).toBe(1);
    expect(result.cycleFilesRead).toBe(0);
    expect(result.uniqueApprovedCandidates).toBe(0);
  });

  it('handles missing outcome files gracefully', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);

    const result = runRipperEntrySim({
      inputPaths:   [jsonl],
      outcomePaths: [fp('no-outcome.json')],
      nowMs:        NOW_MS,
    });

    expect(result.outcomeFilesMissing).toBe(1);
    expect(result.outcomeLookupSize).toBe(0);
    expect(result.rules[0].matchedOutcomeCount).toBe(0);
  });

  it('returns zero uniqueApprovedCandidates when no input files given', () => {
    const result = runRipperEntrySim({ inputPaths: [], nowMs: NOW_MS });

    expect(result.uniqueApprovedCandidates).toBe(0);
    for (const r of result.rules) {
      expect(r.selectedCount).toBe(0);
    }
  });

  it('counts fixtures scanned across all input files', () => {
    const j1 = fp('c1.jsonl');
    const j2 = fp('c2.jsonl');
    writeJsonl(j1, [makeFixture({ contract: 'A' }), makeFixture({ contract: 'B', buyGateDecision: 'BUY_REJECTED' })]);
    writeJsonl(j2, [makeFixture({ contract: 'C' })]);

    const result = runRipperEntrySim({ inputPaths: [j1, j2], nowMs: NOW_MS });

    expect(result.fixturesScanned).toBe(3);
    expect(result.uniqueApprovedCandidates).toBe(2);
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperEntrySim — safety', () => {
  it('result always has safety fields set correctly', () => {
    const result = runRipperEntrySim({ inputPaths: [], nowMs: NOW_MS });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields unchanged when candidates and outcomes are present', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);

    const result = runRipperEntrySim({ inputPaths: [jsonl], nowMs: NOW_MS });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperEntrySim', () => {
  function makeResult(overrides: Partial<RipperEntrySimResult> = {}): RipperEntrySimResult {
    const blankRule = (name: string, desc: string) => ({
      ruleName: name, ruleDescription: desc, selectedCount: 0,
      avgScore: null, avgAge: null, avgEntryPrice: null,
      clusterBreakdown: { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
      matchedOutcomeCount: 0, avgOutcomePctChange: null, winnersCount: 0, losersCount: 0,
    });
    return {
      generatedAt:              NOW_ISO,
      cycleFilesRead:           2,
      cycleFilesMissing:        0,
      outcomeFilesRead:         1,
      outcomeFilesMissing:      0,
      fixturesScanned:          20,
      uniqueApprovedCandidates: 7,
      outcomeLookupSize:        5,
      rules: SIM_RULES.map(r => blankRule(r.name, r.description)),
      realTradingLocked:  true,
      tradingExecuted:    0,
      noRealTradeSent:    true,
      paperOnly:          true,
      readOnly:           true,
      ...overrides,
    };
  }

  it('contains REAL TRADING LOCKED header', () => {
    expect(renderRipperEntrySim(makeResult())).toContain('REAL TRADING LOCKED');
  });

  it('contains safety footer', () => {
    const out = renderRipperEntrySim(makeResult());
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows unique approved count', () => {
    expect(renderRipperEntrySim(makeResult({ uniqueApprovedCandidates: 7 }))).toContain('7');
  });

  it('shows all rule names', () => {
    const out = renderRipperEntrySim(makeResult());
    expect(out).toContain('current-approved');
    expect(out).toContain('age-gte-5m');
    expect(out).toContain('clean-age8-pct0');
  });

  it('shows missing files count when > 0', () => {
    expect(renderRipperEntrySim(makeResult({ cycleFilesMissing: 2 }))).toContain('2 missing');
  });

  it('shows no candidates message when uniqueApprovedCandidates is 0', () => {
    const out = renderRipperEntrySim(makeResult({ uniqueApprovedCandidates: 0 }));
    expect(out).toContain('no approved candidates found');
  });

  it('shows outcome data in rule rows when available', () => {
    const result = makeResult({
      rules: SIM_RULES.map((r, i) => ({
        ruleName:            r.name,
        ruleDescription:     r.description,
        selectedCount:       i === 0 ? 5 : 0,
        avgScore:            i === 0 ? 85 : null,
        avgAge:              i === 0 ? 7.2 : null,
        avgEntryPrice:       null,
        clusterBreakdown:    { CLEAN: i === 0 ? 4 : 0, WATCH: 0, RISKY: 0, UNKNOWN: i === 0 ? 1 : 0 },
        matchedOutcomeCount: i === 0 ? 4 : 0,
        avgOutcomePctChange: i === 0 ? -21.5 : null,
        winnersCount:        0,
        losersCount:         i === 0 ? 4 : 0,
      })),
    });
    const out = renderRipperEntrySim(result);
    expect(out).toContain('-21.5%');
    expect(out).toContain('Winners: 0');
    expect(out).toContain('Losers: 4');
  });
});
