import { describe, expect, it } from 'vitest';
import {
  normalizeSymbol,
  normalizeName,
  parsePreSignals,
  matchPreSignalToCandidate,
  matchAllPreSignals,
  buildPreSignalReport,
  buildPreSignalBridge,
  renderPreSignalReport,
  type PreSignal,
  type PreSignalCandidate,
  type PreSignalReport,
  type BridgeCandidate,
} from '../src/token-grab/xEarsPreSignal';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<PreSignal> = {}): PreSignal {
  return {
    id: 'xsig-test-001',
    source: 'x_manual',
    text: 'Test signal text mentioning a token',
    symbol: 'TEST',
    name: 'Test Token',
    contract: null,
    seenAt: '2026-06-07T03:00:00Z',
    signalType: 'launch_mention',
    confidence: 'medium',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<PreSignalCandidate> = {}): PreSignalCandidate {
  return {
    symbol: 'TEST',
    name: 'Test Token',
    contract: undefined,
    ...overrides,
  };
}

function makeReport(overrides: Partial<PreSignalReport> = {}): PreSignalReport {
  return {
    readOnly: true,
    tradingExecuted: 0,
    generatedAt: '2026-06-07T03:00:00Z',
    totalSignals: 0,
    malformedCount: 0,
    bySource: {},
    bySignalType: {},
    byConfidence: {},
    recentSignals: [],
    matchResults: [],
    matchCount: 0,
    freshCandidateCount: 0,
    ...overrides,
  };
}

// ── Test 1: Parses valid pre-signal JSON ──────────────────────────────────────

describe('parsePreSignals — valid records', () => {
  it('parses a valid pre-signal array', () => {
    const raw = [makeSignal()];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(1);
    expect(malformedCount).toBe(0);
    expect(valid[0]?.id).toBe('xsig-test-001');
  });

  it('parses a single valid object (not array)', () => {
    const raw = makeSignal({ id: 'xsig-single' });
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(1);
    expect(malformedCount).toBe(0);
  });

  it('parses multiple valid signals and preserves all fields', () => {
    const raw = [
      makeSignal({ id: 'sig-1', signalType: 'contract_posted', confidence: 'high' }),
      makeSignal({ id: 'sig-2', signalType: 'community_raid', confidence: 'low' }),
    ];
    const { valid } = parsePreSignals(raw);
    expect(valid).toHaveLength(2);
    expect(valid[0]?.signalType).toBe('contract_posted');
    expect(valid[1]?.confidence).toBe('low');
  });

  it('accepts all valid PreSignalSource values', () => {
    const sources = ['x_manual', 'x_api_future', 'news_manual', 'telegram_manual', 'discord_manual', 'other'] as const;
    for (const source of sources) {
      const { valid } = parsePreSignals([makeSignal({ source })]);
      expect(valid).toHaveLength(1);
    }
  });

  it('accepts all valid PreSignalType values', () => {
    const types = [
      'launch_mention', 'contract_posted', 'ticker_repetition', 'influencer_mention',
      'meme_event', 'breaking_news', 'community_raid', 'unknown',
    ] as const;
    for (const signalType of types) {
      const { valid } = parsePreSignals([makeSignal({ signalType })]);
      expect(valid).toHaveLength(1);
    }
  });
});

// ── Test 2: Ignores malformed records safely ──────────────────────────────────

describe('parsePreSignals — malformed records', () => {
  it('ignores records missing required id field', () => {
    const raw = [{ source: 'x_manual', text: 'test', seenAt: '2026-06-07T00:00:00Z', signalType: 'launch_mention', confidence: 'medium' }];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it('ignores records with unknown source', () => {
    const raw = [makeSignal({ source: 'twitter' as never })];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it('ignores records with unknown signalType', () => {
    const raw = [makeSignal({ signalType: 'pump_signal' as never })];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it('ignores records with unknown confidence', () => {
    const raw = [makeSignal({ confidence: 'very_high' as never })];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it('correctly counts malformed in mixed array', () => {
    const raw = [
      makeSignal({ id: 'good-1' }),
      { not: 'a signal' },
      makeSignal({ id: 'good-2' }),
      null,
      makeSignal({ source: 'fake_source' as never }),
    ];
    const { valid, malformedCount } = parsePreSignals(raw);
    expect(valid).toHaveLength(2);
    expect(malformedCount).toBe(3);
  });

  it('returns empty result for non-array non-object input', () => {
    const { valid, malformedCount } = parsePreSignals('not-valid');
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it('returns empty result for null input', () => {
    const { valid, malformedCount } = parsePreSignals(null);
    expect(valid).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });
});

// ── Test 3: Normalizes symbols with or without dollar sign ────────────────────

describe('normalizeSymbol / normalizeName', () => {
  it('strips leading $ from symbol', () => {
    expect(normalizeSymbol('$FROGAI')).toBe('FROGAI');
  });

  it('uppercases symbol without $', () => {
    expect(normalizeSymbol('frogai')).toBe('FROGAI');
  });

  it('handles symbol that is already normalized', () => {
    expect(normalizeSymbol('GOOSE')).toBe('GOOSE');
  });

  it('trims whitespace from symbol', () => {
    expect(normalizeSymbol('  $MEME  ')).toBe('MEME');
  });

  it('normalizes name to lowercase alphanum only', () => {
    expect(normalizeName('Frog AI')).toBe('frogai');
  });

  it('normalizeName removes special characters', () => {
    expect(normalizeName('BRAINROT!')).toBe('brainrot');
  });

  it('normalizeName handles mixed case and spaces', () => {
    expect(normalizeName('Moon Dog Token')).toBe('moondogtoken');
  });
});

// ── Test 4: Exact contract match returns STRONG ───────────────────────────────

describe('matchPreSignalToCandidate — EXACT_CONTRACT', () => {
  it('returns EXACT_CONTRACT STRONG match when contracts are identical', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const signal = makeSignal({ contract });
    const candidate = makeCandidate({ contract });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('EXACT_CONTRACT');
    expect(result?.strength).toBe('STRONG');
  });

  it('does not match when contracts differ', () => {
    const signal = makeSignal({ contract: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const candidate = makeCandidate({ contract: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });
    const result = matchPreSignalToCandidate(signal, candidate);
    // May still match on symbol or name — test that it's NOT contract match
    expect(result?.reason).not.toBe('EXACT_CONTRACT');
  });

  it('does not match contract when signal.contract is null', () => {
    const signal = makeSignal({ contract: null, symbol: 'NOMATCH_XYZ', name: 'Nomatch XYZ' });
    const candidate = makeCandidate({ contract: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', symbol: undefined, name: undefined });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result).toBeNull();
  });

  it('EXACT_CONTRACT annotation has preSignalMatch: true', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const signal = makeSignal({ contract });
    const candidate = makeCandidate({ contract });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.annotation.preSignalMatch).toBe(true);
    expect(result?.annotation.laneLabel).toBe('PRE_SIGNAL_MATCH');
    expect(result?.annotation.watchOnly).toBe(true);
    expect(result?.annotation.planOnlyNotGranted).toBe(true);
  });
});

// ── Test 5: Symbol match works ────────────────────────────────────────────────

describe('matchPreSignalToCandidate — SYMBOL_MATCH', () => {
  it('matches when both symbols normalize to the same string', () => {
    const signal = makeSignal({ symbol: '$FROGAI', contract: null, name: 'Totally Different Name' });
    const candidate = makeCandidate({ symbol: 'FROGAI', contract: undefined, name: 'Other Name' });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('SYMBOL_MATCH');
    expect(result?.strength).toBe('MEDIUM');
  });

  it('matches symbol case-insensitively', () => {
    const signal = makeSignal({ symbol: 'goose', contract: null, name: 'No Match Name ZZZZ' });
    const candidate = makeCandidate({ symbol: 'GOOSE', contract: undefined, name: 'Also No Match ZZZZ' });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('SYMBOL_MATCH');
  });

  it('does not match when symbols differ', () => {
    const signal = makeSignal({ symbol: 'DOGE', contract: null, name: 'Nomatch ZZZ' });
    const candidate = makeCandidate({ symbol: 'SHIB', contract: undefined, name: 'Nomatch YYY' });
    const result = matchPreSignalToCandidate(signal, candidate);
    // text_weak might match if text contains shib — use distinct text
    const signal2 = makeSignal({ symbol: 'DOGE', text: 'nothing here', contract: null, name: 'Nomatch ZZZ AAA' });
    const result2 = matchPreSignalToCandidate(signal2, candidate);
    expect(result2?.reason).not.toBe('SYMBOL_MATCH');
  });
});

// ── Test 6: Name match works ──────────────────────────────────────────────────

describe('matchPreSignalToCandidate — NAME_MATCH', () => {
  it('matches when names normalize to the same string', () => {
    const signal = makeSignal({ symbol: 'ZZNOTMATCH', contract: null, name: 'Frog AI' });
    const candidate = makeCandidate({ symbol: 'ZZOTHER', contract: undefined, name: 'Frog AI' });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('NAME_MATCH');
    expect(result?.strength).toBe('MEDIUM');
  });

  it('matches names case-insensitively and ignoring special chars', () => {
    const signal = makeSignal({ symbol: 'NOMATCH001', contract: null, name: 'moon-dog token' });
    const candidate = makeCandidate({ symbol: 'NOMATCH002', contract: undefined, name: 'Moon Dog Token' });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('NAME_MATCH');
  });
});

// ── Test 7: Weak text match works ─────────────────────────────────────────────

describe('matchPreSignalToCandidate — TEXT_WEAK', () => {
  it('matches when signal text contains candidate symbol (case-insensitive)', () => {
    const signal = makeSignal({
      symbol: 'NOMATCH_X1',
      name: 'NOMATCH Name A',
      contract: null,
      text: 'Someone is talking about brainrot coin today',
    });
    const candidate = makeCandidate({ symbol: 'BRAINROT', name: 'Some Other Name', contract: undefined });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('TEXT_WEAK');
    expect(result?.strength).toBe('WEAK');
  });

  it('matches when signal text contains candidate name (normalized)', () => {
    const signal = makeSignal({
      symbol: 'NOMATCH_X2',
      name: 'NOMATCH Name B',
      contract: null,
      text: 'I saw someone shilling moondog token earlier today',
    });
    const candidate = makeCandidate({ symbol: 'XYZNOMATCH', name: 'Moon Dog Token', contract: undefined });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.reason).toBe('TEXT_WEAK');
  });

  it('does not weak-match very short candidate symbols (< 3 chars)', () => {
    const signal = makeSignal({ text: 'ab test signal text ab', contract: null, symbol: 'NONE_X3', name: 'NOMATCH Z' });
    const candidate = makeCandidate({ symbol: 'AB', name: undefined, contract: undefined });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result).toBeNull();
  });
});

// ── Test 8: No match returns null ─────────────────────────────────────────────

describe('matchPreSignalToCandidate — no match', () => {
  it('returns null when nothing matches', () => {
    const signal = makeSignal({
      symbol: 'ZZZZZ',
      name: 'Zzzzz Token',
      contract: null,
      text: 'unrelated text about nothing',
    });
    const candidate = makeCandidate({ symbol: 'QQQQQ', name: 'Qqqqq Coin', contract: undefined });
    expect(matchPreSignalToCandidate(signal, candidate)).toBeNull();
  });

  it('returns null for empty signals array', () => {
    const results = matchAllPreSignals([], [makeCandidate()]);
    expect(results).toHaveLength(0);
  });

  it('returns null for empty candidates array', () => {
    const results = matchAllPreSignals([makeSignal()], []);
    expect(results).toHaveLength(0);
  });

  it('returns null for both empty arrays', () => {
    const results = matchAllPreSignals([], []);
    expect(results).toHaveLength(0);
  });
});

// ── Test 9: Report aggregates source/type/confidence counts ───────────────────

describe('buildPreSignalReport — aggregation', () => {
  it('counts by source', () => {
    const rawSignals = [
      makeSignal({ id: 's1', source: 'x_manual' }),
      makeSignal({ id: 's2', source: 'x_manual' }),
      makeSignal({ id: 's3', source: 'news_manual' }),
    ];
    const report = buildPreSignalReport({ rawSignals, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.bySource['x_manual']).toBe(2);
    expect(report.bySource['news_manual']).toBe(1);
  });

  it('counts by signalType', () => {
    const rawSignals = [
      makeSignal({ id: 't1', signalType: 'launch_mention' }),
      makeSignal({ id: 't2', signalType: 'contract_posted' }),
      makeSignal({ id: 't3', signalType: 'launch_mention' }),
    ];
    const report = buildPreSignalReport({ rawSignals, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.bySignalType['launch_mention']).toBe(2);
    expect(report.bySignalType['contract_posted']).toBe(1);
  });

  it('counts by confidence', () => {
    const rawSignals = [
      makeSignal({ id: 'c1', confidence: 'high' }),
      makeSignal({ id: 'c2', confidence: 'medium' }),
      makeSignal({ id: 'c3', confidence: 'high' }),
      makeSignal({ id: 'c4', confidence: 'low' }),
    ];
    const report = buildPreSignalReport({ rawSignals, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.byConfidence['high']).toBe(2);
    expect(report.byConfidence['medium']).toBe(1);
    expect(report.byConfidence['low']).toBe(1);
  });

  it('respects limit for recentSignals', () => {
    const rawSignals = Array.from({ length: 10 }, (_, i) => makeSignal({ id: `sig-${i}` }));
    const report = buildPreSignalReport({ rawSignals, limit: 3, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.recentSignals).toHaveLength(3);
    expect(report.totalSignals).toBe(10);
  });

  it('counts malformed signals', () => {
    const rawSignals = [
      makeSignal({ id: 'valid-1' }),
      { bad: 'record' },
      null,
    ];
    const report = buildPreSignalReport({ rawSignals, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.totalSignals).toBe(1);
    expect(report.malformedCount).toBe(2);
  });

  it('includes match results when candidates are provided', () => {
    const rawSignals = [makeSignal({ id: 'm1', symbol: 'MATCHED' })];
    const freshCandidates = [makeCandidate({ symbol: 'MATCHED' })];
    const report = buildPreSignalReport({ rawSignals, freshCandidates, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.matchCount).toBe(1);
    expect(report.freshCandidateCount).toBe(1);
    expect(report.matchResults[0]?.reason).toBe('SYMBOL_MATCH');
  });
});

// ── Test 10: JSON output includes readOnly true and tradingExecuted 0 ──────────

describe('buildPreSignalReport / PreSignalReport JSON shape', () => {
  it('report has readOnly: true and tradingExecuted: 0', () => {
    const report = buildPreSignalReport({ rawSignals: [], generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.readOnly).toBe(true);
    expect(report.tradingExecuted).toBe(0);
  });

  it('JSON serialization preserves readOnly and tradingExecuted', () => {
    const report = makeReport();
    const json = JSON.parse(JSON.stringify(report));
    expect(json.readOnly).toBe(true);
    expect(json.tradingExecuted).toBe(0);
  });

  it('report always has readOnly true even with match results', () => {
    const rawSignals = [makeSignal({ symbol: 'MATCH' })];
    const freshCandidates = [makeCandidate({ symbol: 'MATCH' })];
    const report = buildPreSignalReport({ rawSignals, freshCandidates, generatedAt: '2026-06-07T00:00:00Z' });
    expect(report.readOnly).toBe(true);
    expect(report.tradingExecuted).toBe(0);
  });
});

// ── Test 11: PRE_SIGNAL_MATCH does not create PLAN_ONLY by itself ─────────────

describe('PRE_SIGNAL_MATCH — watch only, not a buy signal', () => {
  it('annotation has planOnlyNotGranted: true', () => {
    const signal = makeSignal({ symbol: 'FROG', contract: null });
    const candidate = makeCandidate({ symbol: 'FROG' });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.annotation.planOnlyNotGranted).toBe(true);
  });

  it('annotation has watchOnly: true', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const signal = makeSignal({ contract });
    const candidate = makeCandidate({ contract });
    const result = matchPreSignalToCandidate(signal, candidate);
    expect(result?.annotation.watchOnly).toBe(true);
  });

  it('laneLabel is PRE_SIGNAL_MATCH on all match types', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const sigContract = makeSignal({ contract });
    const candContract = makeCandidate({ contract });
    const sigSym = makeSignal({ symbol: 'GOOSE', contract: null, name: 'No Match Name QQQQQ' });
    const candSym = makeCandidate({ symbol: 'GOOSE', name: 'Other Name QQQQQ', contract: undefined });

    for (const [sig, cand] of [[sigContract, candContract], [sigSym, candSym]] as const) {
      const result = matchPreSignalToCandidate(sig, cand);
      expect(result?.annotation.laneLabel).toBe('PRE_SIGNAL_MATCH');
    }
  });

  it('renderPreSignalReport output contains watch-only language', () => {
    const report = makeReport({
      matchResults: [{
        signalId: 'xsig-001',
        candidateSymbol: 'FROG',
        reason: 'SYMBOL_MATCH',
        strength: 'MEDIUM',
        confidence: 'medium',
        source: 'x_manual',
        annotation: {
          preSignalMatch: true,
          preSignalReason: 'SYMBOL_MATCH',
          preSignalConfidence: 'medium',
          preSignalSource: 'x_manual',
          laneLabel: 'PRE_SIGNAL_MATCH',
          watchOnly: true,
          planOnlyNotGranted: true,
        },
      }],
      matchCount: 1,
    });
    const rendered = renderPreSignalReport(report);
    expect(rendered).toContain('PRE_SIGNAL_MATCH');
    expect(rendered).toContain('WATCH ONLY');
    expect(rendered).toContain('NOT GRANTED');
    expect(rendered).toContain('existing confirmation gates still required');
  });
});

// ── Test 12: Existing confirmation gates still required ───────────────────────

describe('confirmation gates still required', () => {
  it('renderPreSignalReport footer states gates are still required', () => {
    const report = makeReport();
    const rendered = renderPreSignalReport(report);
    expect(rendered).toContain('Existing confirmation gates still required for PLAN_ONLY');
  });

  it('report with no matches still shows watch-only language', () => {
    const report = makeReport();
    const rendered = renderPreSignalReport(report);
    expect(rendered).toContain('PRE_SIGNAL_MATCH is WATCH ONLY');
  });

  it('matchPreSignalToCandidate never sets planOnlyNotGranted to false', () => {
    const signals = [
      makeSignal({ symbol: 'A', contract: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }),
      makeSignal({ symbol: 'GOOSE', contract: null, name: 'No Match' }),
      makeSignal({ text: 'I see brainrot everywhere today', symbol: 'NONE_XQ1', name: 'NOMATCH AA', contract: null }),
    ];
    const candidates = [
      makeCandidate({ contract: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }),
      makeCandidate({ symbol: 'GOOSE', name: 'Other Name', contract: undefined }),
      makeCandidate({ symbol: 'BRAINROT', name: 'Brain Rot', contract: undefined }),
    ];
    const results = matchAllPreSignals(signals, candidates);
    for (const r of results) {
      expect(r.annotation.planOnlyNotGranted).toBe(true);
    }
  });
});

// ── Test 13: No LIVE_EXECUTED ─────────────────────────────────────────────────

describe('xEarsPreSignal — no LIVE_EXECUTED', () => {
  it('renderPreSignalReport never contains LIVE_EXECUTED', () => {
    const report = makeReport({
      matchResults: [{
        signalId: 'x1',
        reason: 'SYMBOL_MATCH',
        strength: 'MEDIUM',
        confidence: 'medium',
        source: 'x_manual',
        annotation: {
          preSignalMatch: true,
          preSignalReason: 'SYMBOL_MATCH',
          preSignalConfidence: 'medium',
          preSignalSource: 'x_manual',
          laneLabel: 'PRE_SIGNAL_MATCH',
          watchOnly: true,
          planOnlyNotGranted: true,
        },
      }],
      matchCount: 1,
    });
    const rendered = renderPreSignalReport(report);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('PreSignalReport JSON never contains LIVE_EXECUTED', () => {
    const report = makeReport();
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/LIVE_EXECUTED/);
  });

  it('PreSignalAnnotation has no LIVE_EXECUTED field', () => {
    const signal = makeSignal({ symbol: 'FROG' });
    const candidate = makeCandidate({ symbol: 'FROG' });
    const result = matchPreSignalToCandidate(signal, candidate);
    const annotationJson = JSON.stringify(result?.annotation ?? {});
    expect(annotationJson).not.toMatch(/LIVE_EXECUTED/);
  });
});

// ── Test 14: No wallet/private key/swap/signing ────────────────────────────────

describe('xEarsPreSignal — no wallet/private key/swap/signing', () => {
  it('renderPreSignalReport contains no signing/swap/key patterns', () => {
    const report = makeReport({
      recentSignals: [makeSignal({ id: 'check-sig', confidence: 'high' })],
      matchCount: 0,
    });
    const rendered = renderPreSignalReport(report);
    expect(rendered).not.toMatch(/(?:private|secret)[\s_]?key\s*[=({]/i);
    expect(rendered).not.toMatch(/signTransaction\s*\(/i);
    expect(rendered).not.toMatch(/sendTransaction\s*\(/i);
    expect(rendered).not.toMatch(/executeSwap\s*\(/i);
    expect(rendered).not.toMatch(/wallet\.connect\s*\(/i);
    expect(rendered).not.toMatch(/LIVE_EXECUTED/);
  });

  it('renderPreSignalReport contains READ-ONLY and tradingExecuted: 0 safety text', () => {
    const report = makeReport();
    const rendered = renderPreSignalReport(report);
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('PreSignalReport sentinel fields confirm read-only', () => {
    const report = makeReport();
    expect(report.readOnly).toBe(true);
    expect(report.tradingExecuted).toBe(0);
  });
});

// ── Bridge tests (live-harness integration) ───────────────────────────────────

function makeBridgeCandidate(overrides: Partial<BridgeCandidate> = {}): BridgeCandidate {
  return { ticker: 'TEST', name: 'Test Token', contract: undefined, ...overrides };
}

describe('buildPreSignalBridge — no signals', () => {
  it('returns empty bridge when no signals provided', () => {
    const bridge = buildPreSignalBridge([], [makeBridgeCandidate()], 'presignals.json');
    expect(bridge.signalsLoaded).toBe(0);
    expect(bridge.matchCount).toBe(0);
    expect(bridge.matchedCandidates).toHaveLength(0);
    expect(bridge.watchOnly).toBe(true);
    expect(bridge.readOnly).toBe(true);
    expect(bridge.tradingExecuted).toBe(0);
  });

  it('returns empty bridge when no candidates provided', () => {
    const bridge = buildPreSignalBridge([makeSignal()], [], 'presignals.json');
    expect(bridge.signalsLoaded).toBe(1);
    expect(bridge.matchCount).toBe(0);
    expect(bridge.matchedCandidates).toHaveLength(0);
  });

  it('returns empty bridge when both empty', () => {
    const bridge = buildPreSignalBridge([], [], 'presignals.json');
    expect(bridge.signalsLoaded).toBe(0);
    expect(bridge.matchCount).toBe(0);
  });
});

describe('buildPreSignalBridge — contract match', () => {
  it('annotates candidate when contract matches exactly (STRONG)', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const signal = makeSignal({ contract, symbol: 'NOMATCH_X1', name: 'NOMATCH Name A' });
    const candidate = makeBridgeCandidate({ ticker: 'GOOSE', contract });
    const bridge = buildPreSignalBridge([signal], [candidate], 'presignals.json');
    expect(bridge.matchCount).toBe(1);
    expect(bridge.matchedCandidates[0]?.candidateTicker).toBe('GOOSE');
    expect(bridge.matchedCandidates[0]?.matchReason).toBe('EXACT_CONTRACT');
    expect(bridge.matchedCandidates[0]?.matchStrength).toBe('STRONG');
    expect(bridge.matchedCandidates[0]?.watchOnly).toBe(true);
    expect(bridge.matchedCandidates[0]?.planOnlyNotGranted).toBe(true);
  });

  it('prefers STRONG contract match over MEDIUM symbol match when both apply', () => {
    const contract = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const sigContract = makeSignal({ id: 'sig-c', contract, symbol: 'GOOSE', name: 'NOMATCH' });
    const sigSymbol = makeSignal({ id: 'sig-s', contract: null, symbol: 'GOOSE', name: 'NOMATCH' });
    const candidate = makeBridgeCandidate({ ticker: 'GOOSE', contract });
    const bridge = buildPreSignalBridge([sigContract, sigSymbol], [candidate], 'presignals.json');
    expect(bridge.matchCount).toBe(1);
    expect(bridge.matchedCandidates[0]?.matchStrength).toBe('STRONG');
    expect(bridge.matchedCandidates[0]?.matchReason).toBe('EXACT_CONTRACT');
  });
});

describe('buildPreSignalBridge — symbol match', () => {
  it('annotates candidate when ticker matches signal symbol', () => {
    const signal = makeSignal({ symbol: '$FROGAI', contract: null, name: 'NOMATCH AAA' });
    const candidate = makeBridgeCandidate({ ticker: 'FROGAI', name: 'NOMATCH BBB', contract: undefined });
    const bridge = buildPreSignalBridge([signal], [candidate], 'presignals.json');
    expect(bridge.matchCount).toBe(1);
    expect(bridge.matchedCandidates[0]?.matchReason).toBe('SYMBOL_MATCH');
    expect(bridge.matchedCandidates[0]?.matchStrength).toBe('MEDIUM');
    expect(bridge.matchedCandidates[0]?.candidateTicker).toBe('FROGAI');
  });

  it('annotates multiple candidates when multiple symbols match', () => {
    const signals = [
      makeSignal({ id: 's1', symbol: 'ALPHA', contract: null, name: 'NOMATCH 1' }),
      makeSignal({ id: 's2', symbol: 'BETA', contract: null, name: 'NOMATCH 2' }),
    ];
    const candidates = [
      makeBridgeCandidate({ ticker: 'ALPHA', name: 'NOMATCH A', contract: undefined }),
      makeBridgeCandidate({ ticker: 'BETA', name: 'NOMATCH B', contract: undefined }),
      makeBridgeCandidate({ ticker: 'GAMMA', name: 'NOMATCH C', contract: undefined }),
    ];
    const bridge = buildPreSignalBridge(signals, candidates, 'presignals.json');
    expect(bridge.matchCount).toBe(2);
    const tickers = bridge.matchedCandidates.map(m => m.candidateTicker);
    expect(tickers).toContain('ALPHA');
    expect(tickers).toContain('BETA');
    expect(tickers).not.toContain('GAMMA');
  });

  it('stores signalSource and signalConfidence on match', () => {
    const signal = makeSignal({ symbol: 'GOOSE', source: 'news_manual', confidence: 'high', contract: null, name: 'NOMATCH' });
    const candidate = makeBridgeCandidate({ ticker: 'GOOSE' });
    const bridge = buildPreSignalBridge([signal], [candidate], 'presignals.json');
    expect(bridge.matchedCandidates[0]?.signalSource).toBe('news_manual');
    expect(bridge.matchedCandidates[0]?.signalConfidence).toBe('high');
  });
});

describe('buildPreSignalBridge — PRE_SIGNAL_MATCH is WATCH ONLY', () => {
  it('planOnlyNotGranted is always true on every match', () => {
    const signals = [
      makeSignal({ symbol: 'ALPHA', contract: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }),
      makeSignal({ id: 's2', symbol: 'BETA', contract: null, name: 'NOMATCH B' }),
    ];
    const candidates = [
      makeBridgeCandidate({ ticker: 'ALPHA', contract: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }),
      makeBridgeCandidate({ ticker: 'BETA', name: 'NOMATCH B', contract: undefined }),
    ];
    const bridge = buildPreSignalBridge(signals, candidates, 'presignals.json');
    for (const m of bridge.matchedCandidates) {
      expect(m.planOnlyNotGranted).toBe(true);
      expect(m.watchOnly).toBe(true);
    }
  });

  it('bridge readOnly is always true', () => {
    const bridge = buildPreSignalBridge(
      [makeSignal({ symbol: 'GOOSE', contract: null })],
      [makeBridgeCandidate({ ticker: 'GOOSE' })],
      'presignals.json',
    );
    expect(bridge.readOnly).toBe(true);
    expect(bridge.tradingExecuted).toBe(0);
  });

  it('bridge JSON never contains LIVE_EXECUTED', () => {
    const bridge = buildPreSignalBridge(
      [makeSignal({ symbol: 'GOOSE', contract: null })],
      [makeBridgeCandidate({ ticker: 'GOOSE' })],
      'presignals.json',
    );
    expect(JSON.stringify(bridge)).not.toMatch(/LIVE_EXECUTED/);
  });

  it('bridge JSON never contains wallet/signing/swap patterns', () => {
    const bridge = buildPreSignalBridge(
      [makeSignal({ symbol: 'GOOSE', contract: null })],
      [makeBridgeCandidate({ ticker: 'GOOSE' })],
      'presignals.json',
    );
    const json = JSON.stringify(bridge);
    expect(json).not.toMatch(/signTransaction/i);
    expect(json).not.toMatch(/sendTransaction/i);
    expect(json).not.toMatch(/executeSwap/i);
    expect(json).not.toMatch(/wallet\.connect/i);
    expect(json).not.toMatch(/privateKey/i);
  });
});

describe('buildPreSignalBridge — confirmation gates still required', () => {
  it('bridge does not include a PLAN_ONLY field or status', () => {
    const bridge = buildPreSignalBridge(
      [makeSignal({ symbol: 'GOOSE', contract: null })],
      [makeBridgeCandidate({ ticker: 'GOOSE' })],
      'presignals.json',
    );
    const json = JSON.stringify(bridge);
    expect(json).not.toContain('PLAN_ONLY');
  });

  it('bridge signalsPath is recorded correctly', () => {
    const bridge = buildPreSignalBridge([], [], 'data/token-grab/x-ears/presignals.json');
    expect(bridge.signalsPath).toBe('data/token-grab/x-ears/presignals.json');
  });

  it('one match per candidate even if multiple signals match', () => {
    const signals = [
      makeSignal({ id: 'sig-a', symbol: 'GOOSE', contract: null, name: 'NOMATCH A' }),
      makeSignal({ id: 'sig-b', symbol: 'GOOSE', contract: null, name: 'NOMATCH B' }),
    ];
    const candidate = makeBridgeCandidate({ ticker: 'GOOSE' });
    const bridge = buildPreSignalBridge(signals, [candidate], 'presignals.json');
    expect(bridge.matchCount).toBe(1);
    expect(bridge.matchedCandidates).toHaveLength(1);
  });
});
