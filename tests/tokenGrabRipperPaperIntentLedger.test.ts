import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readPaperIntents,
  appendPaperIntents,
  updateIntentStatuses,
} from '../src/token-grab/ripperPaperIntentLedger';
import type { PaperIntent } from '../src/token-grab/ripperPaperDecisionPolicy';

const BASE_ISO = '2026-06-15T12:00:00.000Z';

function makeIntent(overrides: Partial<PaperIntent> = {}): PaperIntent {
  return {
    intentId:         'aabbcc112233',
    contract:         'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol:           'TOK',
    approvedAt:       BASE_ISO,
    targetEntryAt:    BASE_ISO,
    paperEntryTiming: 'ENTER_NOW',
    reason:           'DEFAULT_APPROVED_ENTER_NOW',
    sourceCycle:      'cycle-2026-06-15-120000',
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

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function ledgerPath(): string { return path.join(tmpDir, 'paper-intents.jsonl'); }

// ── readPaperIntents ──────────────────────────────────────────────────────────

describe('readPaperIntents', () => {
  it('returns empty array when file does not exist', () => {
    expect(readPaperIntents('/no/such/file.jsonl')).toEqual([]);
  });

  it('reads a single intent', () => {
    const p = ledgerPath();
    fs.writeFileSync(p, JSON.stringify(makeIntent()) + '\n', 'utf-8');
    const intents = readPaperIntents(p);
    expect(intents).toHaveLength(1);
    expect(intents[0].intentId).toBe('aabbcc112233');
  });

  it('reads multiple intents', () => {
    const p = ledgerPath();
    const a = makeIntent({ intentId: 'aaa', contract: 'AAA' });
    const b = makeIntent({ intentId: 'bbb', contract: 'BBB' });
    fs.writeFileSync(p, [a, b].map(i => JSON.stringify(i)).join('\n') + '\n', 'utf-8');
    expect(readPaperIntents(p)).toHaveLength(2);
  });

  it('skips malformed lines gracefully', () => {
    const p = ledgerPath();
    fs.writeFileSync(p, JSON.stringify(makeIntent()) + '\nnot-json\n', 'utf-8');
    expect(readPaperIntents(p)).toHaveLength(1);
  });

  it('returns empty array for empty file', () => {
    const p = ledgerPath();
    fs.writeFileSync(p, '', 'utf-8');
    expect(readPaperIntents(p)).toHaveLength(0);
  });
});

// ── appendPaperIntents ────────────────────────────────────────────────────────

describe('appendPaperIntents', () => {
  it('creates file if it does not exist', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent()]);
    expect(fs.existsSync(p)).toBe(true);
    expect(readPaperIntents(p)).toHaveLength(1);
  });

  it('appends new intents', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent({ intentId: 'aaa', contract: 'AAA' })]);
    appendPaperIntents(p, [makeIntent({ intentId: 'bbb', contract: 'BBB' })]);
    expect(readPaperIntents(p)).toHaveLength(2);
  });

  it('deduplicates by contract + targetEntryAt + reason', () => {
    const p = ledgerPath();
    const intent = makeIntent({ intentId: 'aaa' });
    appendPaperIntents(p, [intent]);
    const result = appendPaperIntents(p, [intent]);
    expect(readPaperIntents(p)).toHaveLength(1);
    expect(result.deduped).toBe(1);
    expect(result.appended).toBe(0);
  });

  it('deduplicates even when intentId differs but key is the same', () => {
    const p = ledgerPath();
    const a = makeIntent({ intentId: 'aaa' });
    const b = { ...a, intentId: 'bbb' }; // same key, different intentId
    appendPaperIntents(p, [a]);
    const result = appendPaperIntents(p, [b]);
    expect(readPaperIntents(p)).toHaveLength(1);
    expect(result.deduped).toBe(1);
  });

  it('does not deduplicate intents with different targetEntryAt', () => {
    const p = ledgerPath();
    const a = makeIntent({ intentId: 'aaa', targetEntryAt: '2026-06-15T12:00:00.000Z' });
    const b = makeIntent({ intentId: 'bbb', targetEntryAt: '2026-06-15T12:10:00.000Z' });
    appendPaperIntents(p, [a]);
    appendPaperIntents(p, [b]);
    expect(readPaperIntents(p)).toHaveLength(2);
  });

  it('returns appended count', () => {
    const p = ledgerPath();
    const result = appendPaperIntents(p, [
      makeIntent({ intentId: 'aaa', contract: 'AAA' }),
      makeIntent({ intentId: 'bbb', contract: 'BBB' }),
    ]);
    expect(result.appended).toBe(2);
    expect(result.deduped).toBe(0);
  });

  it('appending empty array is a no-op', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent()]);
    appendPaperIntents(p, []);
    expect(readPaperIntents(p)).toHaveLength(1);
  });

  it('creates parent directories if needed', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'intents.jsonl');
    appendPaperIntents(nested, [makeIntent()]);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ── updateIntentStatuses ──────────────────────────────────────────────────────

describe('updateIntentStatuses', () => {
  it('returns 0 updated when file does not exist', () => {
    const result = updateIntentStatuses('/no/such.jsonl', [
      { intentId: 'abc', status: 'ENTRY_DUE' },
    ]);
    expect(result.updated).toBe(0);
  });

  it('updates status for matching intentId', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent({ intentId: 'abc', status: 'PLANNED' })]);
    updateIntentStatuses(p, [{ intentId: 'abc', status: 'ENTRY_DUE' }]);
    const intents = readPaperIntents(p);
    expect(intents[0].status).toBe('ENTRY_DUE');
  });

  it('does not touch intents not in the update list', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [
      makeIntent({ intentId: 'aaa', contract: 'AAA', status: 'PLANNED' }),
      makeIntent({ intentId: 'bbb', contract: 'BBB', status: 'PLANNED' }),
    ]);
    updateIntentStatuses(p, [{ intentId: 'aaa', status: 'ENTRY_DUE' }]);
    const intents = readPaperIntents(p);
    const bbb = intents.find(i => i.intentId === 'bbb');
    expect(bbb!.status).toBe('PLANNED');
  });

  it('returns updated count', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [
      makeIntent({ intentId: 'aaa', contract: 'AAA' }),
      makeIntent({ intentId: 'bbb', contract: 'BBB' }),
    ]);
    const result = updateIntentStatuses(p, [
      { intentId: 'aaa', status: 'OBSERVED' },
      { intentId: 'bbb', status: 'EXPIRED_NO_DATA' },
    ]);
    expect(result.updated).toBe(2);
  });

  it('can update to OBSERVED with observedAt and priceChangePct', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent({ intentId: 'abc' })]);
    updateIntentStatuses(p, [{
      intentId: 'abc',
      status: 'OBSERVED',
      observedAt: '2026-06-15T12:15:00.000Z',
      priceChangePct: 5.5,
    }]);
    const intents = readPaperIntents(p);
    const updated = intents[0] as Record<string, unknown>;
    expect(updated['status']).toBe('OBSERVED');
    expect(updated['observedAt']).toBe('2026-06-15T12:15:00.000Z');
    expect(updated['priceChangePct']).toBe(5.5);
  });

  it('preserves all fields when not in update', () => {
    const p = ledgerPath();
    const original = makeIntent({ intentId: 'abc', clusterRisk: 'CLEAN', ripperScore: 100 });
    appendPaperIntents(p, [original]);
    updateIntentStatuses(p, [{ intentId: 'abc', status: 'ENTRY_DUE' }]);
    const intents = readPaperIntents(p);
    expect(intents[0].clusterRisk).toBe('CLEAN');
    expect(intents[0].ripperScore).toBe(100);
  });

  it('ignores unknown intentIds gracefully', () => {
    const p = ledgerPath();
    appendPaperIntents(p, [makeIntent({ intentId: 'aaa' })]);
    const result = updateIntentStatuses(p, [{ intentId: 'zzz', status: 'OBSERVED' }]);
    expect(result.updated).toBe(0);
    expect(readPaperIntents(p)[0].status).toBe('PLANNED');
  });
});
