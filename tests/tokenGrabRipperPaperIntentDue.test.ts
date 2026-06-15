import { describe, it, expect } from 'vitest';
import {
  isPaperIntentOpen,
  isPaperIntentDue,
  getDuePaperIntents,
} from '../src/token-grab/ripperPaperIntentDue';
import type { PaperIntent } from '../src/token-grab/ripperPaperDecisionPolicy';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

function makeIntent(overrides: Partial<PaperIntent> = {}): PaperIntent {
  return {
    intentId:         'testid123456789',
    contract:         'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol:           'TOK',
    approvedAt:       BASE_ISO,
    targetEntryAt:    BASE_ISO,
    paperEntryTiming: 'ENTER_NOW',
    reason:           'DEFAULT_APPROVED_ENTER_NOW',
    sourceCycle:      null,
    clusterRisk:      'CLEAN',
    ripperScore:      90,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    status:           'PLANNED',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
    ...overrides,
  };
}

// ── isPaperIntentOpen ─────────────────────────────────────────────────────────

describe('isPaperIntentOpen', () => {
  it('returns true for PLANNED', () => {
    expect(isPaperIntentOpen('PLANNED')).toBe(true);
  });

  it('returns true for ENTRY_DUE', () => {
    expect(isPaperIntentOpen('ENTRY_DUE')).toBe(true);
  });

  it('returns false for OBSERVED', () => {
    expect(isPaperIntentOpen('OBSERVED')).toBe(false);
  });

  it('returns false for EXPIRED_NO_DATA', () => {
    expect(isPaperIntentOpen('EXPIRED_NO_DATA')).toBe(false);
  });
});

// ── isPaperIntentDue ──────────────────────────────────────────────────────────

describe('isPaperIntentDue', () => {
  it('returns true for PLANNED when targetEntryAt <= nowMs', () => {
    const intent = makeIntent({ status: 'PLANNED', targetEntryAt: at(-1_000) });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(true);
  });

  it('returns true for ENTRY_DUE when targetEntryAt <= nowMs', () => {
    const intent = makeIntent({ status: 'ENTRY_DUE', targetEntryAt: at(-1_000) });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(true);
  });

  it('returns false for PLANNED when targetEntryAt > nowMs', () => {
    const intent = makeIntent({ status: 'PLANNED', targetEntryAt: at(10 * 60_000) });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(false);
  });

  it('returns false for OBSERVED even if targetEntryAt is in the past', () => {
    const intent = makeIntent({ status: 'OBSERVED', targetEntryAt: at(-1_000) });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(false);
  });

  it('returns false for EXPIRED_NO_DATA even if targetEntryAt is in the past', () => {
    const intent = makeIntent({ status: 'EXPIRED_NO_DATA', targetEntryAt: at(-1_000) });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(false);
  });

  it('returns true when targetEntryAt exactly equals nowMs', () => {
    const intent = makeIntent({ status: 'PLANNED', targetEntryAt: BASE_ISO });
    expect(isPaperIntentDue(intent, BASE_MS)).toBe(true);
  });
});

// ── getDuePaperIntents ────────────────────────────────────────────────────────

describe('getDuePaperIntents', () => {
  it('returns empty array when no intents', () => {
    expect(getDuePaperIntents([], BASE_MS)).toHaveLength(0);
  });

  it('returns only PLANNED and ENTRY_DUE intents with past targetEntryAt', () => {
    const intents = [
      makeIntent({ intentId: 'a', status: 'PLANNED',        targetEntryAt: at(-1_000) }),
      makeIntent({ intentId: 'b', status: 'ENTRY_DUE',      targetEntryAt: at(-1_000) }),
      makeIntent({ intentId: 'c', status: 'PLANNED',        targetEntryAt: at(10_000) }),
      makeIntent({ intentId: 'd', status: 'OBSERVED',       targetEntryAt: at(-1_000) }),
      makeIntent({ intentId: 'e', status: 'EXPIRED_NO_DATA', targetEntryAt: at(-1_000) }),
    ];
    const due = getDuePaperIntents(intents, BASE_MS);
    expect(due).toHaveLength(2);
    const ids = due.map(i => i.intentId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('does not include intents whose targetEntryAt is in the future', () => {
    const intents = [
      makeIntent({ intentId: 'future', status: 'PLANNED', targetEntryAt: at(10_000) }),
    ];
    expect(getDuePaperIntents(intents, BASE_MS)).toHaveLength(0);
  });

  it('preserves all fields of returned intents', () => {
    const intent = makeIntent({ intentId: 'preserve-me', status: 'ENTRY_DUE', targetEntryAt: at(-1_000), ripperScore: 100 });
    const due = getDuePaperIntents([intent], BASE_MS);
    expect(due[0].intentId).toBe('preserve-me');
    expect(due[0].ripperScore).toBe(100);
  });
});
