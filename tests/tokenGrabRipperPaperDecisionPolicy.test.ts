import { describe, it, expect } from 'vitest';
import {
  applyPaperDecisionPolicy,
  applyPolicyToFixtures,
  isHighQualitySubgroup,
  type ApprovedFixtureInput,
} from '../src/token-grab/ripperPaperDecisionPolicy';

const BASE_ISO = '2026-06-15T12:00:00.000Z';
const BASE_MS  = Date.parse(BASE_ISO);

function makeFixture(overrides: Partial<ApprovedFixtureInput> = {}): ApprovedFixtureInput {
  return {
    contract:        'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol:          'TOK',
    approvedAt:      BASE_ISO,
    clusterRisk:     'CLEAN',
    ripperScore:     100,
    launchAgeBucket: 'PRIME_WINDOW',
    entryDecision:   'READY_TO_SNIPE_PAPER',
    sourceCycle:     'cycle-2026-06-15-120000',
    ...overrides,
  };
}

// ── isHighQualitySubgroup ────────────────────────────────────────────────────

describe('isHighQualitySubgroup', () => {
  it('returns true for canonical high-quality fixture', () => {
    expect(isHighQualitySubgroup(makeFixture())).toBe(true);
  });

  it('returns false when clusterRisk is WATCH', () => {
    expect(isHighQualitySubgroup(makeFixture({ clusterRisk: 'WATCH' }))).toBe(false);
  });

  it('returns false when clusterRisk is RISKY', () => {
    expect(isHighQualitySubgroup(makeFixture({ clusterRisk: 'RISKY' }))).toBe(false);
  });

  it('returns false when clusterRisk is UNKNOWN', () => {
    expect(isHighQualitySubgroup(makeFixture({ clusterRisk: 'UNKNOWN' }))).toBe(false);
  });

  it('returns false when ripperScore is 99', () => {
    expect(isHighQualitySubgroup(makeFixture({ ripperScore: 99 }))).toBe(false);
  });

  it('returns false when ripperScore is null', () => {
    expect(isHighQualitySubgroup(makeFixture({ ripperScore: null }))).toBe(false);
  });

  it('returns false when launchAgeBucket is TOO_EARLY', () => {
    expect(isHighQualitySubgroup(makeFixture({ launchAgeBucket: 'TOO_EARLY' }))).toBe(false);
  });

  it('returns false when launchAgeBucket is null', () => {
    expect(isHighQualitySubgroup(makeFixture({ launchAgeBucket: null }))).toBe(false);
  });

  it('returns false when entryDecision is WATCH', () => {
    expect(isHighQualitySubgroup(makeFixture({ entryDecision: 'WATCH' }))).toBe(false);
  });

  it('returns false when entryDecision is null', () => {
    expect(isHighQualitySubgroup(makeFixture({ entryDecision: null }))).toBe(false);
  });
});

// ── applyPaperDecisionPolicy ─────────────────────────────────────────────────

describe('applyPaperDecisionPolicy — high-quality subgroup', () => {
  it('assigns WAIT_10M for high-quality subgroup', () => {
    const intent = applyPaperDecisionPolicy(makeFixture());
    expect(intent.paperEntryTiming).toBe('WAIT_10M');
  });

  it('assigns HIGH_QUALITY_WAIT10_SUBGROUP reason', () => {
    const intent = applyPaperDecisionPolicy(makeFixture());
    expect(intent.reason).toBe('HIGH_QUALITY_WAIT10_SUBGROUP');
  });

  it('targetEntryAt is approvedAt + 10 minutes for WAIT_10M', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ approvedAt: BASE_ISO }));
    const expected = new Date(BASE_MS + 10 * 60_000).toISOString();
    expect(intent.targetEntryAt).toBe(expected);
  });
});

describe('applyPaperDecisionPolicy — non-high-quality', () => {
  it('WATCH cluster gets ENTER_NOW', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ clusterRisk: 'WATCH' }));
    expect(intent.paperEntryTiming).toBe('ENTER_NOW');
    expect(intent.reason).toBe('DEFAULT_APPROVED_ENTER_NOW');
  });

  it('score below 100 gets ENTER_NOW', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ ripperScore: 85 }));
    expect(intent.paperEntryTiming).toBe('ENTER_NOW');
    expect(intent.reason).toBe('DEFAULT_APPROVED_ENTER_NOW');
  });

  it('TOO_EARLY gets ENTER_NOW', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ launchAgeBucket: 'TOO_EARLY' }));
    expect(intent.paperEntryTiming).toBe('ENTER_NOW');
  });

  it('non-READY_TO_SNIPE_PAPER entryDecision gets ENTER_NOW', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ entryDecision: 'WATCH' }));
    expect(intent.paperEntryTiming).toBe('ENTER_NOW');
  });

  it('targetEntryAt equals approvedAt for ENTER_NOW', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ clusterRisk: 'WATCH', approvedAt: BASE_ISO }));
    expect(intent.targetEntryAt).toBe(BASE_ISO);
  });
});

describe('applyPaperDecisionPolicy — intent fields', () => {
  it('carries contract, symbol, approvedAt', () => {
    const f = makeFixture({ contract: 'CTR123', symbol: 'SYM' });
    const intent = applyPaperDecisionPolicy(f);
    expect(intent.contract).toBe('CTR123');
    expect(intent.symbol).toBe('SYM');
    expect(intent.approvedAt).toBe(f.approvedAt);
  });

  it('status is PLANNED', () => {
    expect(applyPaperDecisionPolicy(makeFixture()).status).toBe('PLANNED');
  });

  it('carries sourceCycle', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ sourceCycle: 'cycle-abc' }));
    expect(intent.sourceCycle).toBe('cycle-abc');
  });

  it('sourceCycle is null when not provided', () => {
    const intent = applyPaperDecisionPolicy(makeFixture({ sourceCycle: undefined }));
    expect(intent.sourceCycle).toBeNull();
  });

  it('carries clusterRisk, ripperScore, launchAgeBucket, entryDecision', () => {
    const f = makeFixture({ clusterRisk: 'WATCH', ripperScore: 80, launchAgeBucket: 'TOO_EARLY', entryDecision: 'WATCH' });
    const intent = applyPaperDecisionPolicy(f);
    expect(intent.clusterRisk).toBe('WATCH');
    expect(intent.ripperScore).toBe(80);
    expect(intent.launchAgeBucket).toBe('TOO_EARLY');
    expect(intent.entryDecision).toBe('WATCH');
  });

  it('intentId is a non-empty string', () => {
    const intent = applyPaperDecisionPolicy(makeFixture());
    expect(typeof intent.intentId).toBe('string');
    expect(intent.intentId.length).toBeGreaterThan(0);
  });

  it('two intents with same contract+targetEntryAt+reason get same intentId', () => {
    const i1 = applyPaperDecisionPolicy(makeFixture());
    const i2 = applyPaperDecisionPolicy(makeFixture());
    expect(i1.intentId).toBe(i2.intentId);
  });

  it('different contracts get different intentIds', () => {
    const i1 = applyPaperDecisionPolicy(makeFixture({ contract: 'AAA' }));
    const i2 = applyPaperDecisionPolicy(makeFixture({ contract: 'BBB' }));
    expect(i1.intentId).not.toBe(i2.intentId);
  });
});

describe('safety fields', () => {
  it('realTradingLocked is true', () => {
    expect(applyPaperDecisionPolicy(makeFixture()).realTradingLocked).toBe(true);
  });

  it('paperOnly is true', () => {
    expect(applyPaperDecisionPolicy(makeFixture()).paperOnly).toBe(true);
  });

  it('tradingExecuted is 0', () => {
    expect(applyPaperDecisionPolicy(makeFixture()).tradingExecuted).toBe(0);
  });
});

describe('applyPolicyToFixtures', () => {
  it('returns one intent per fixture', () => {
    const fixtures = [makeFixture(), makeFixture({ contract: 'BBB' })];
    expect(applyPolicyToFixtures(fixtures)).toHaveLength(2);
  });

  it('returns empty array for no fixtures', () => {
    expect(applyPolicyToFixtures([])).toHaveLength(0);
  });

  it('correctly mixes ENTER_NOW and WAIT_10M', () => {
    const fixtures = [
      makeFixture(),                                   // high quality → WAIT_10M
      makeFixture({ contract: 'BBB', clusterRisk: 'WATCH' }), // → ENTER_NOW
    ];
    const intents = applyPolicyToFixtures(fixtures);
    expect(intents[0].paperEntryTiming).toBe('WAIT_10M');
    expect(intents[1].paperEntryTiming).toBe('ENTER_NOW');
  });
});
