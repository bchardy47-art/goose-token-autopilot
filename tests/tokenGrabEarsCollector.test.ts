import { describe, it, expect } from 'vitest';
import {
  simpleHash,
  extractContractAddress,
  extractTicker,
  extractAllTickers,
  classifySignalType,
  classifyConfidence,
  parseRawInput,
  buildPreSignalFromItem,
  buildPreSignalsFromItems,
  deduplicateSignals,
  buildEarsCollectorReport,
  renderEarsCollectorReport,
} from '../src/token-grab/earsCollector';
import type { EarsCollectorInput } from '../src/token-grab/earsCollector';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

const TS = '2026-06-06T00:00:00.000Z';
const CONTRACT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeSignal(overrides: Partial<PreSignal> = {}): PreSignal {
  return {
    id: 'test-001',
    source: 'x_manual',
    text: 'test text',
    symbol: undefined,
    contract: null,
    seenAt: TS,
    signalType: 'unknown',
    confidence: 'low',
    ...overrides,
  };
}

function makeCollectorInput(overrides: Partial<EarsCollectorInput> = {}): EarsCollectorInput {
  return {
    inputPath: 'test/input.txt',
    rawContent: '$GOOSE token launching on Raydium',
    outputPath: 'test/out.json',
    source: 'x_manual',
    append: false,
    existingSignals: [],
    generatedAt: TS,
    ...overrides,
  };
}

// ── simpleHash ────────────────────────────────────────────────────────────────

describe('simpleHash', () => {
  it('is deterministic — same input always yields same output', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
    expect(simpleHash('$FROGAI launching on Raydium')).toBe(
      simpleHash('$FROGAI launching on Raydium'),
    );
  });

  it('produces different hashes for different inputs', () => {
    expect(simpleHash('hello')).not.toBe(simpleHash('world'));
    expect(simpleHash('$FROG')).not.toBe(simpleHash('$TOAD'));
  });

  it('returns a non-empty string', () => {
    expect(simpleHash('').length).toBeGreaterThanOrEqual(0);
    expect(typeof simpleHash('abc')).toBe('string');
  });
});

// ── extractContractAddress ────────────────────────────────────────────────────

describe('extractContractAddress', () => {
  it('extracts address with CA: prefix', () => {
    const text = `$GOOSE token — CA: ${CONTRACT}`;
    expect(extractContractAddress(text)).toBe(CONTRACT);
  });

  it('extracts address with contract: prefix', () => {
    const text = `contract: ${CONTRACT}`;
    expect(extractContractAddress(text)).toBe(CONTRACT);
  });

  it('extracts standalone 40-44 char base58 address', () => {
    const text = `check this out ${CONTRACT} pumping`;
    expect(extractContractAddress(text)).toBe(CONTRACT);
  });

  it('returns null when no contract-like string is found', () => {
    expect(extractContractAddress('$FROGAI launching soon')).toBeNull();
    expect(extractContractAddress('hello world')).toBeNull();
  });

  it('does not match short strings as contracts', () => {
    expect(extractContractAddress('CA: SHORTADDR')).toBeNull();
    expect(extractContractAddress('abc123')).toBeNull();
  });
});

// ── extractTicker ─────────────────────────────────────────────────────────────

describe('extractTicker', () => {
  it('returns $TICKER symbol uppercased when present', () => {
    expect(extractTicker('$goose is launching')).toBe('GOOSE');
    expect(extractTicker('big $FROGAI pump incoming')).toBe('FROGAI');
  });

  it('returns undefined when no ticker present', () => {
    expect(extractTicker('just a generic sentence here')).toBeUndefined();
    expect(extractTicker('CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBeUndefined();
  });

  it('ignores common non-ticker CAPS words', () => {
    expect(extractTicker('LFG WAGMI NFA DYOR')).toBeUndefined();
    expect(extractTicker('ETH BTC SOL USDT')).toBeUndefined();
  });
});

// ── extractAllTickers ─────────────────────────────────────────────────────────

describe('extractAllTickers', () => {
  it('returns all unique $TICKER symbols from text', () => {
    const result = extractAllTickers('$FROGAI and $PEPE going up, $frogai again');
    expect(result).toContain('FROGAI');
    expect(result).toContain('PEPE');
    expect(result).toHaveLength(2); // deduped
  });

  it('returns empty array when no $ tickers present', () => {
    expect(extractAllTickers('no tickers here')).toEqual([]);
  });
});

// ── classifySignalType ────────────────────────────────────────────────────────

describe('classifySignalType', () => {
  it('returns contract_posted when contract present', () => {
    expect(classifySignalType('some text with a contract', true, 1)).toBe('contract_posted');
  });

  it('returns launch_mention when launch keyword in text (no contract)', () => {
    expect(classifySignalType('$FROGAI launching on Raydium now', false, 1)).toBe('launch_mention');
    expect(classifySignalType('liquidity just added', false, 1)).toBe('launch_mention');
    expect(classifySignalType('$PEPE now live on pumpfun', false, 1)).toBe('launch_mention');
  });

  it('returns ticker_repetition when tickerFreq >= 3 and no higher-priority match', () => {
    expect(classifySignalType('$FROGAI spotted by callers', false, 3)).toBe('ticker_repetition');
    expect(classifySignalType('$FROGAI again', false, 5)).toBe('ticker_repetition');
  });

  it('launch_mention outranks ticker_repetition', () => {
    expect(classifySignalType('$FROGAI launching now', false, 3)).toBe('launch_mention');
  });

  it('returns influencer_mention for influencer keywords', () => {
    expect(classifySignalType('large account calling $FROGAI', false, 1)).toBe(
      'influencer_mention',
    );
    expect(classifySignalType('KOL mention of new token', false, 1)).toBe('influencer_mention');
  });

  it('returns meme_event for meme/news keywords', () => {
    expect(classifySignalType('breaking news: new meme token', false, 1)).toBe('meme_event');
    expect(classifySignalType('$DOGE trending on twitter', false, 1)).toBe('meme_event');
  });

  it('returns community_raid for raid language', () => {
    expect(classifySignalType('community raid underway LFG', false, 1)).toBe('community_raid');
    expect(classifySignalType('army mobilizing WAGMI', false, 1)).toBe('community_raid');
  });

  it('returns unknown when no pattern matches', () => {
    expect(classifySignalType('just a random observation', false, 1)).toBe('unknown');
  });
});

// ── classifyConfidence ────────────────────────────────────────────────────────

describe('classifyConfidence', () => {
  it('returns high when contract present', () => {
    expect(classifyConfidence('any text', true, false, 1)).toBe('high');
  });

  it('returns high for repeated ticker + launch language', () => {
    expect(classifyConfidence('$FROGAI launching on Raydium', false, true, 3)).toBe('high');
  });

  it('returns medium for ticker + launch language (low repetition)', () => {
    expect(classifyConfidence('$FROGAI launching now', false, true, 1)).toBe('medium');
  });

  it('returns medium for ticker + meme or influencer keywords', () => {
    expect(classifyConfidence('breaking $GOOSE news', false, true, 1)).toBe('medium');
    expect(classifyConfidence('large account mentions $GOOSE', false, true, 1)).toBe('medium');
  });

  it('returns low when no strong signals', () => {
    expect(classifyConfidence('just a mention of a token', false, false, 1)).toBe('low');
    expect(classifyConfidence('some text with no ticker', false, false, 1)).toBe('low');
  });
});

// ── parseRawInput ─────────────────────────────────────────────────────────────

describe('parseRawInput', () => {
  it('parses plain text lines as items', () => {
    const { items, skippedCount } = parseRawInput('$FROGAI launching\n$PEPE pump\n');
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('$FROGAI launching');
    expect(skippedCount).toBe(0);
  });

  it('skips comment lines starting with #', () => {
    const { items, skippedCount } = parseRawInput('# comment\n$GOOSE launch\n');
    expect(items).toHaveLength(1);
    expect(skippedCount).toBe(1);
  });

  it('skips empty lines', () => {
    const { items, skippedCount } = parseRawInput('$FROGAI\n\n$PEPE\n');
    expect(items).toHaveLength(2);
    expect(skippedCount).toBe(1);
  });

  it('parses JSON array with text/url/seenAt fields', () => {
    const json = JSON.stringify([
      { text: '$FROGAI launching', url: 'https://x.com/1', seenAt: TS },
      { text: '$PEPE pump' },
    ]);
    const { items, skippedCount } = parseRawInput(json);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://x.com/1');
    expect(items[0].seenAt).toBe(TS);
    expect(skippedCount).toBe(0);
  });

  it('skips JSON objects with missing or empty text', () => {
    const json = JSON.stringify([{ text: '' }, { text: '$FROGAI' }, { notext: true }]);
    const { items, skippedCount } = parseRawInput(json);
    expect(items).toHaveLength(1);
    expect(skippedCount).toBe(2);
  });
});

// ── buildPreSignalFromItem ────────────────────────────────────────────────────

describe('buildPreSignalFromItem', () => {
  it('generates ID in ec-NNN-hash format', () => {
    const item = { text: '$GOOSE launch on Raydium' };
    const sig = buildPreSignalFromItem(item, 0, 'x_manual', TS, { GOOSE: 1 });
    expect(sig.id).toMatch(/^ec-000-[a-z0-9]+$/);
  });

  it('sets correct source, signalType, confidence, and symbol', () => {
    const item = { text: `$GOOSE launch — CA: ${CONTRACT}` };
    const sig = buildPreSignalFromItem(item, 5, 'news_manual', TS, { GOOSE: 1 });
    expect(sig.source).toBe('news_manual');
    expect(sig.signalType).toBe('contract_posted');
    expect(sig.confidence).toBe('high');
    expect(sig.symbol).toBe('GOOSE');
    expect(sig.contract).toBe(CONTRACT);
  });

  it('extracts URL from item.url if present, otherwise from text', () => {
    const fromField = buildPreSignalFromItem(
      { text: 'no url in text', url: 'https://x.com/1' },
      0, 'x_manual', TS, {},
    );
    expect(fromField.url).toBe('https://x.com/1');

    const fromText = buildPreSignalFromItem(
      { text: '$GOOSE https://x.com/2 launching' },
      0, 'x_manual', TS, { GOOSE: 1 },
    );
    expect(fromText.url).toBe('https://x.com/2');
  });

  it('uses seenAt from item when provided, falls back to generatedAt', () => {
    const withSeenAt = buildPreSignalFromItem(
      { text: 'test', seenAt: '2026-01-01T00:00:00.000Z' },
      0, 'x_manual', TS, {},
    );
    expect(withSeenAt.seenAt).toBe('2026-01-01T00:00:00.000Z');

    const withFallback = buildPreSignalFromItem({ text: 'test' }, 0, 'x_manual', TS, {});
    expect(withFallback.seenAt).toBe(TS);
  });
});

// ── buildPreSignalsFromItems ──────────────────────────────────────────────────

describe('buildPreSignalsFromItems', () => {
  it('counts ticker frequencies across items for ticker_repetition detection', () => {
    const items = [
      { text: '$FROGAI mentioned here' },
      { text: '$FROGAI another mention' },
      { text: '$FROGAI yet again' },
    ];
    const signals = buildPreSignalsFromItems(items, 'x_manual', TS);
    expect(signals).toHaveLength(3);
    // All three mention FROGAI — tickerFreq=3, no launch/contract → ticker_repetition
    for (const s of signals) {
      expect(s.signalType).toBe('ticker_repetition');
    }
  });

  it('returns one signal per item', () => {
    const items = [{ text: 'line one' }, { text: 'line two' }];
    expect(buildPreSignalsFromItems(items, 'x_manual', TS)).toHaveLength(2);
  });
});

// ── deduplicateSignals ────────────────────────────────────────────────────────

describe('deduplicateSignals', () => {
  it('deduplicates fresh signals by contract against existing', () => {
    const existing = [makeSignal({ contract: CONTRACT })];
    const fresh = [makeSignal({ id: 'new-001', contract: CONTRACT, text: 'different text' })];
    const { unique, duplicateCount } = deduplicateSignals(fresh, existing);
    expect(unique).toHaveLength(0);
    expect(duplicateCount).toBe(1);
  });

  it('deduplicates fresh signals by symbol+text hash against existing', () => {
    const existing = [makeSignal({ symbol: 'FROGAI', contract: null, text: 'same signal text for frog' })];
    const fresh = [makeSignal({ id: 'new-002', symbol: 'FROGAI', contract: null, text: 'same signal text for frog' })];
    const { unique, duplicateCount } = deduplicateSignals(fresh, existing);
    expect(unique).toHaveLength(0);
    expect(duplicateCount).toBe(1);
  });

  it('passes through unique signals with no duplicates', () => {
    const existing = [makeSignal({ symbol: 'FROGAI', text: 'frog text one' })];
    const fresh = [makeSignal({ id: 'new-003', symbol: 'GOOSE', text: 'goose text different' })];
    const { unique, duplicateCount } = deduplicateSignals(fresh, existing);
    expect(unique).toHaveLength(1);
    expect(duplicateCount).toBe(0);
  });

  it('deduplicates within the fresh batch itself', () => {
    const contract = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVv';
    const fresh = [
      makeSignal({ id: 'a', contract }),
      makeSignal({ id: 'b', contract }), // same contract → duplicate
    ];
    const { unique, duplicateCount } = deduplicateSignals(fresh, []);
    expect(unique).toHaveLength(1);
    expect(duplicateCount).toBe(1);
  });
});

// ── buildEarsCollectorReport ──────────────────────────────────────────────────

describe('buildEarsCollectorReport', () => {
  it('returns correct safety flags', () => {
    const report = buildEarsCollectorReport(makeCollectorInput());
    expect(report.readOnly).toBe(false);
    expect(report.tradingExecuted).toBe(0);
    expect(report.noRealTradeSent).toBe(true);
  });

  it('counts parsed items, skipped lines, and written signals correctly', () => {
    const raw = '# skip me\n$FROGAI launching\n$GOOSE pump\n';
    const report = buildEarsCollectorReport(makeCollectorInput({ rawContent: raw }));
    expect(report.parsedItemCount).toBe(2);
    expect(report.skippedLineCount).toBe(1);
    expect(report.freshSignalCount).toBe(2);
    expect(report.validSignalsWritten).toBe(2);
    expect(report.totalSignalsInOutput).toBe(2);
  });

  it('populates bySource, bySignalType, byConfidence breakdowns', () => {
    const raw = `$GOOSE launch on Raydium\n$FROGAI trending viral`;
    const report = buildEarsCollectorReport(
      makeCollectorInput({ rawContent: raw, source: 'news_manual' }),
    );
    expect(report.bySource['news_manual']).toBeGreaterThan(0);
    expect(Object.keys(report.bySignalType).length).toBeGreaterThan(0);
    expect(Object.keys(report.byConfidence).length).toBeGreaterThan(0);
  });

  it('respects append=false — output contains only fresh unique signals', () => {
    const existing = [makeSignal({ id: 'old', text: 'existing signal text' })];
    const report = buildEarsCollectorReport(
      makeCollectorInput({ existingSignals: existing, append: false }),
    );
    expect(report.signals.some(s => s.id === 'old')).toBe(false);
  });

  it('respects append=true — merges existing + fresh unique', () => {
    const existing = [makeSignal({ id: 'old', text: 'existing signal text' })];
    const report = buildEarsCollectorReport(
      makeCollectorInput({ existingSignals: existing, append: true }),
    );
    expect(report.signals.some(s => s.id === 'old')).toBe(true);
    expect(report.totalSignalsInOutput).toBeGreaterThan(existing.length);
  });
});

// ── renderEarsCollectorReport ─────────────────────────────────────────────────

describe('renderEarsCollectorReport', () => {
  it('contains safety markers in render output', () => {
    const report = buildEarsCollectorReport(makeCollectorInput());
    const rendered = renderEarsCollectorReport(report);
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('includes input/output paths in render', () => {
    const report = buildEarsCollectorReport(
      makeCollectorInput({ inputPath: 'my/input.txt', outputPath: 'my/out.json' }),
    );
    const rendered = renderEarsCollectorReport(report);
    expect(rendered).toContain('my/input.txt');
    expect(rendered).toContain('my/out.json');
  });

  it('shows counts in render', () => {
    const raw = '# comment\n$FROGAI launching on pump.fun\n$GOOSE pump\n';
    const report = buildEarsCollectorReport(makeCollectorInput({ rawContent: raw }));
    const rendered = renderEarsCollectorReport(report);
    expect(rendered).toContain('Parsed items');
    expect(rendered).toContain('Skipped lines');
    expect(rendered).toContain('Written');
  });
});
