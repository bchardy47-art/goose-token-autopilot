import { describe, it, expect } from 'vitest';
import {
  parseDexEarsConfig,
  parseProfilesResponse,
  parseBoostsResponse,
  buildDexEarsCandidates,
  computeDexConfidence,
  computeDexSignalType,
  candidateToPreSignal,
  buildDexEarsReport,
  renderDexEarsReport,
  CONF_ORDER,
  type DexEarsCandidate,
  type DexEndpointResult,
  type DexEarsInput,
} from '../src/token-grab/dexEars';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SOL_ADDR_A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOL_ADDR_B = 'AnotherToken1111111111111111111111111111111';
const SOL_ADDR_C = 'CTOToken11111111111111111111111111111111111';
const ETH_ADDR   = '0xDeadBeefDeadBeefDeadBeefDeadBeef00000001';

const PROFILE_A = {
  url: `https://dexscreener.com/solana/${SOL_ADDR_A}`,
  chainId: 'solana',
  tokenAddress: SOL_ADDR_A,
  header: 'GOOSE',
  description: 'The GOOSE token on Solana',
};
const PROFILE_ETH = {
  url: `https://dexscreener.com/ethereum/${ETH_ADDR}`,
  chainId: 'ethereum',
  tokenAddress: ETH_ADDR,
  header: 'ETHTOKEN',
};
const BOOST_A = {
  url: `https://dexscreener.com/solana/${SOL_ADDR_A}`,
  chainId: 'solana',
  tokenAddress: SOL_ADDR_A,
  header: 'GOOSE',
  amount: 500,
  totalAmount: 1500,
};
const BOOST_B = {
  url: `https://dexscreener.com/solana/${SOL_ADDR_B}`,
  chainId: 'solana',
  tokenAddress: SOL_ADDR_B,
  header: 'FROG',
  amount: 100,
  totalAmount: 100,
};
const TOP_BOOST_C = {
  url: `https://dexscreener.com/solana/${SOL_ADDR_C}`,
  chainId: 'solana',
  tokenAddress: SOL_ADDR_C,
  header: 'MOON',
  amount: 10000,
  totalAmount: 50000,
};

function makeProfileResult(items: unknown[] = [PROFILE_A]): DexEndpointResult {
  return { endpoint: 'latest_profiles', fetched: items.length, items: parseProfilesResponse(items) };
}
function makeBoostResult(items: unknown[] = [BOOST_A]): DexEndpointResult {
  return { endpoint: 'latest_boosts', fetched: items.length, items: parseBoostsResponse(items) };
}
function makeTopBoostResult(items: unknown[] = [TOP_BOOST_C]): DexEndpointResult {
  return { endpoint: 'top_boosts', fetched: items.length, items: parseBoostsResponse(items) };
}

function makeInput(overrides: Partial<DexEarsInput> = {}): DexEarsInput {
  return {
    endpointResults: [],
    existingSignals: [],
    generatedAt: '2026-06-07T00:00:00.000Z',
    chain: 'solana',
    minConfidence: 'medium',
    dryRun: false,
    outputPath: 'data/token-grab/x-ears/presignals.json',
    ...overrides,
  };
}

function makeCandidateWith(overrides: Partial<Omit<DexEarsCandidate, 'foundIn'>> & { foundIn?: Set<import('../src/token-grab/dexEars').DexEndpoint> }): DexEarsCandidate {
  return {
    chainId: 'solana',
    tokenAddress: SOL_ADDR_A,
    name: 'GOOSE',
    url: `https://dexscreener.com/solana/${SOL_ADDR_A}`,
    foundIn: new Set(['latest_profiles'] as import('../src/token-grab/dexEars').DexEndpoint[]),
    hasProfile: true,
    hasBoost: false,
    hasCto: false,
    totalBoostAmount: 0,
    ...overrides,
  };
}

// ── parseDexEarsConfig ─────────────────────────────────────────────────────────

describe('parseDexEarsConfig', () => {
  it('parses a complete valid config', () => {
    const raw = {
      chain: 'solana',
      minConfidence: 'high',
      maxItemsPerEndpoint: 30,
      timeoutMs: 8000,
      endpoints: { latestProfiles: true, latestBoosts: false, topBoosts: true },
    };
    const cfg = parseDexEarsConfig(raw);
    expect(cfg.chain).toBe('solana');
    expect(cfg.minConfidence).toBe('high');
    expect(cfg.maxItemsPerEndpoint).toBe(30);
    expect(cfg.timeoutMs).toBe(8000);
    expect(cfg.endpoints.latestBoosts).toBe(false);
    expect(cfg.endpoints.topBoosts).toBe(true);
  });

  it('applies defaults on empty object', () => {
    const cfg = parseDexEarsConfig({});
    expect(cfg.chain).toBe('solana');
    expect(cfg.minConfidence).toBe('medium');
    expect(cfg.maxItemsPerEndpoint).toBe(50);
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.endpoints.latestProfiles).toBe(true);
    expect(cfg.endpoints.latestBoosts).toBe(true);
    expect(cfg.endpoints.topBoosts).toBe(true);
  });

  it('throws on non-object input', () => {
    expect(() => parseDexEarsConfig(null)).toThrow('[parseDexEarsConfig]');
    expect(() => parseDexEarsConfig('string')).toThrow('[parseDexEarsConfig]');
    expect(() => parseDexEarsConfig(42)).toThrow('[parseDexEarsConfig]');
  });

  it('falls back to medium for invalid minConfidence', () => {
    expect(parseDexEarsConfig({ minConfidence: 'extreme' }).minConfidence).toBe('medium');
  });
});

// ── parseProfilesResponse ──────────────────────────────────────────────────────

describe('parseProfilesResponse', () => {
  it('parses a valid profiles array', () => {
    const items = parseProfilesResponse([PROFILE_A, PROFILE_ETH]);
    expect(items).toHaveLength(2);
    expect(items[0].tokenAddress).toBe(SOL_ADDR_A);
    expect(items[0].header).toBe('GOOSE');
    expect(items[1].chainId).toBe('ethereum');
  });

  it('skips items missing required fields', () => {
    const items = parseProfilesResponse([
      { url: 'https://example.com' }, // no chainId/tokenAddress
      { chainId: 'solana' },           // no tokenAddress
      PROFILE_A,
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].tokenAddress).toBe(SOL_ADDR_A);
  });

  it('returns empty array for non-array input', () => {
    expect(parseProfilesResponse(null)).toHaveLength(0);
    expect(parseProfilesResponse({})).toHaveLength(0);
    expect(parseProfilesResponse('string')).toHaveLength(0);
  });

  it('synthesizes url when missing', () => {
    const item = { chainId: 'solana', tokenAddress: SOL_ADDR_A };
    const result = parseProfilesResponse([item]);
    expect(result[0].url).toContain(SOL_ADDR_A);
    expect(result[0].url).toContain('dexscreener.com');
  });
});

// ── parseBoostsResponse ────────────────────────────────────────────────────────

describe('parseBoostsResponse', () => {
  it('parses a valid boosts array with amount fields', () => {
    const items = parseBoostsResponse([BOOST_A, BOOST_B]);
    expect(items).toHaveLength(2);
    expect(items[0].tokenAddress).toBe(SOL_ADDR_A);
    expect(items[0].amount).toBe(500);
    expect(items[0].totalAmount).toBe(1500);
  });

  it('parses boost items without amount fields gracefully', () => {
    const item = { chainId: 'solana', tokenAddress: SOL_ADDR_B };
    const result = parseBoostsResponse([item]);
    expect(result[0].amount).toBeUndefined();
    expect(result[0].totalAmount).toBeUndefined();
  });

  it('returns empty array for non-array input', () => {
    expect(parseBoostsResponse(null)).toHaveLength(0);
  });
});

// ── buildDexEarsCandidates ─────────────────────────────────────────────────────

describe('buildDexEarsCandidates', () => {
  it('groups by tokenAddress across endpoints', () => {
    const results = [makeProfileResult([PROFILE_A]), makeBoostResult([BOOST_A, BOOST_B])];
    const candidates = buildDexEarsCandidates(results, 'solana');
    // ADDR_A appears in both, ADDR_B only in boosts
    expect(candidates).toHaveLength(2);
    const a = candidates.find(c => c.tokenAddress === SOL_ADDR_A);
    expect(a).toBeDefined();
    expect(a!.foundIn.size).toBe(2);
    expect(a!.hasProfile).toBe(true);
    expect(a!.hasBoost).toBe(true);
  });

  it('filters by chain — excludes non-matching chains', () => {
    const results = [makeProfileResult([PROFILE_A, PROFILE_ETH])];
    const candidates = buildDexEarsCandidates(results, 'solana');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].tokenAddress).toBe(SOL_ADDR_A);
  });

  it('chain comparison is case-insensitive', () => {
    const results = [makeProfileResult([PROFILE_A])];
    expect(buildDexEarsCandidates(results, 'Solana')).toHaveLength(1);
    expect(buildDexEarsCandidates(results, 'SOLANA')).toHaveLength(1);
  });

  it('sets hasCto for top_boosts endpoint', () => {
    const results = [makeTopBoostResult([TOP_BOOST_C])];
    const candidates = buildDexEarsCandidates(results, 'solana');
    expect(candidates[0].hasCto).toBe(true);
    expect(candidates[0].hasProfile).toBe(false);
    expect(candidates[0].hasBoost).toBe(false);
  });

  it('accumulates totalBoostAmount from latest_boosts', () => {
    const results = [makeBoostResult([BOOST_A])];
    const candidates = buildDexEarsCandidates(results, 'solana');
    expect(candidates[0].totalBoostAmount).toBe(1500);
  });

  it('skips errored endpoints', () => {
    const errorResult: DexEndpointResult = {
      endpoint: 'latest_profiles',
      fetched: 0,
      items: [],
      error: 'Connection refused',
    };
    const candidates = buildDexEarsCandidates([errorResult], 'solana');
    expect(candidates).toHaveLength(0);
  });

  it('returns empty array when no matching chain items', () => {
    const results = [makeProfileResult([PROFILE_ETH])];
    expect(buildDexEarsCandidates(results, 'solana')).toHaveLength(0);
  });
});

// ── computeDexConfidence ───────────────────────────────────────────────────────

describe('computeDexConfidence', () => {
  it('high: token appears in 2+ endpoints', () => {
    const c = makeCandidateWith({
      foundIn: new Set(['latest_profiles', 'latest_boosts'] as import('../src/token-grab/dexEars').DexEndpoint[]),
      hasProfile: true,
      hasBoost: true,
    });
    expect(computeDexConfidence(c)).toBe('high');
  });

  it('high: boost + profile', () => {
    const c = makeCandidateWith({ hasProfile: true, hasBoost: true });
    expect(computeDexConfidence(c)).toBe('high');
  });

  it('high: cto + profile', () => {
    const c = makeCandidateWith({ hasProfile: true, hasCto: true });
    expect(computeDexConfidence(c)).toBe('high');
  });

  it('medium: boost only (no profile)', () => {
    const c = makeCandidateWith({
      foundIn: new Set(['latest_boosts'] as import('../src/token-grab/dexEars').DexEndpoint[]),
      hasProfile: false,
      hasBoost: true,
    });
    expect(computeDexConfidence(c)).toBe('medium');
  });

  it('medium: cto only (no profile)', () => {
    const c = makeCandidateWith({
      foundIn: new Set(['top_boosts'] as import('../src/token-grab/dexEars').DexEndpoint[]),
      hasProfile: false,
      hasCto: true,
    });
    expect(computeDexConfidence(c)).toBe('medium');
  });

  it('low: profile only', () => {
    const c = makeCandidateWith({
      foundIn: new Set(['latest_profiles'] as import('../src/token-grab/dexEars').DexEndpoint[]),
      hasProfile: true,
      hasBoost: false,
      hasCto: false,
    });
    expect(computeDexConfidence(c)).toBe('low');
  });
});

// ── computeDexSignalType ───────────────────────────────────────────────────────

describe('computeDexSignalType', () => {
  it('community_raid for cto candidate', () => {
    expect(computeDexSignalType(makeCandidateWith({ hasCto: true }))).toBe('community_raid');
  });

  it('launch_mention for boost candidate', () => {
    expect(computeDexSignalType(makeCandidateWith({ hasBoost: true, hasCto: false }))).toBe('launch_mention');
  });

  it('launch_mention for profile-only candidate', () => {
    expect(computeDexSignalType(makeCandidateWith({ hasProfile: true, hasBoost: false, hasCto: false }))).toBe('launch_mention');
  });
});

// ── candidateToPreSignal ───────────────────────────────────────────────────────

describe('candidateToPreSignal', () => {
  const TS = '2026-06-07T00:00:00.000Z';

  it('sets contract to tokenAddress', () => {
    const sig = candidateToPreSignal(makeCandidateWith({}), TS);
    expect(sig.contract).toBe(SOL_ADDR_A);
  });

  it('includes CA: in text', () => {
    const sig = candidateToPreSignal(makeCandidateWith({}), TS);
    expect(sig.text).toContain('CA:');
    expect(sig.text).toContain(SOL_ADDR_A);
  });

  it('includes symbol when header is valid ticker', () => {
    const sig = candidateToPreSignal(makeCandidateWith({ name: 'GOOSE' }), TS);
    expect(sig.symbol).toBe('GOOSE');
    expect(sig.text).toContain('$GOOSE');
  });

  it('sets seenAt to generatedAt', () => {
    const sig = candidateToPreSignal(makeCandidateWith({}), TS);
    expect(sig.seenAt).toBe(TS);
  });

  it('sets source to other', () => {
    expect(candidateToPreSignal(makeCandidateWith({}), TS).source).toBe('other');
  });

  it('id is deterministic for same address', () => {
    const a = candidateToPreSignal(makeCandidateWith({}), TS);
    const b = candidateToPreSignal(makeCandidateWith({}), TS);
    expect(a.id).toBe(b.id);
  });
});

// ── buildDexEarsReport ─────────────────────────────────────────────────────────

describe('buildDexEarsReport', () => {
  it('returns tradingExecuted: 0', () => {
    expect(buildDexEarsReport(makeInput()).tradingExecuted).toBe(0);
  });

  it('returns noRealTradeSent: true', () => {
    expect(buildDexEarsReport(makeInput()).noRealTradeSent).toBe(true);
  });

  it('passes through dryRun: true', () => {
    expect(buildDexEarsReport(makeInput({ dryRun: true })).dryRun).toBe(true);
  });

  it('includes suggestedHarnessCommand with outputPath', () => {
    const report = buildDexEarsReport(makeInput({ outputPath: 'data/token-grab/x-ears/presignals.json' }));
    expect(report.suggestedHarnessCommand).toContain('token:live-harness');
    expect(report.suggestedHarnessCommand).toContain('--pre-signals');
    expect(report.suggestedHarnessCommand).toContain('presignals.json');
  });

  it('minConfidence=medium excludes low-confidence signals', () => {
    // profile-only → low confidence
    const results = [makeProfileResult([PROFILE_A])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'medium' }));
    expect(report.signalsExtracted).toBe(0);
    expect(report.uniqueSignals).toHaveLength(0);
  });

  it('minConfidence=low includes low-confidence signals', () => {
    const results = [makeProfileResult([PROFILE_A])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'low' }));
    expect(report.signalsExtracted).toBe(1);
    expect(report.uniqueSignals).toHaveLength(1);
  });

  it('boost-only token passes medium threshold', () => {
    const results = [makeBoostResult([BOOST_B])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'medium' }));
    expect(report.signalsExtracted).toBe(1);
  });

  it('multi-endpoint token gets high confidence', () => {
    const results = [makeProfileResult([PROFILE_A]), makeBoostResult([BOOST_A])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'low' }));
    const sig = report.uniqueSignals.find(s => s.contract === SOL_ADDR_A);
    expect(sig?.confidence).toBe('high');
    expect(report.highConfidenceCount).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates signals against existing signals', () => {
    const results = [makeBoostResult([BOOST_B])];
    const firstReport = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'low' }));
    const secondReport = buildDexEarsReport(makeInput({
      endpointResults: results,
      existingSignals: firstReport.uniqueSignals,
      minConfidence: 'low',
    }));
    expect(secondReport.uniqueSignals).toHaveLength(0);
    expect(secondReport.duplicatesSkipped).toBe(1);
  });

  it('deduplicates same token appearing in multiple endpoints', () => {
    // ADDR_A in both profiles and boosts — should produce 1 unique signal
    const results = [makeProfileResult([PROFILE_A]), makeBoostResult([BOOST_A])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'low' }));
    const addrASignals = report.uniqueSignals.filter(s => s.contract === SOL_ADDR_A);
    expect(addrASignals).toHaveLength(1);
  });

  it('Solana-only filter excludes ethereum tokens', () => {
    const results = [makeProfileResult([PROFILE_A, PROFILE_ETH])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, chain: 'solana', minConfidence: 'low' }));
    expect(report.uniqueSignals.every(s => !s.contract?.startsWith('0x'))).toBe(true);
  });

  it('produces byConfidence breakdown', () => {
    const results = [makeBoostResult([BOOST_A, BOOST_B])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'medium' }));
    expect(Object.keys(report.byConfidence).length).toBeGreaterThan(0);
  });

  it('contractCount equals uniqueSignals with contract addresses', () => {
    const results = [makeBoostResult([BOOST_A, BOOST_B])];
    const report = buildDexEarsReport(makeInput({ endpointResults: results, minConfidence: 'medium' }));
    expect(report.contractCount).toBe(report.uniqueSignals.length);
  });

  it('endpoint error is reflected in endpointsSummary', () => {
    const errorResult: DexEndpointResult = {
      endpoint: 'latest_boosts',
      fetched: 0,
      items: [],
      error: 'Timeout',
    };
    const report = buildDexEarsReport(makeInput({ endpointResults: [errorResult] }));
    const summary = report.endpointsSummary.find(e => e.endpoint === 'latest_boosts');
    expect(summary?.error).toBe('Timeout');
  });
});

// ── renderDexEarsReport ────────────────────────────────────────────────────────

describe('renderDexEarsReport', () => {
  function makeFullReport(dryRun = false) {
    const results = [makeBoostResult([BOOST_A, BOOST_B]), makeTopBoostResult([TOP_BOOST_C])];
    return buildDexEarsReport(makeInput({ endpointResults: results, dryRun, minConfidence: 'low' }));
  }

  it('contains NO REAL TRADE SENT', () => {
    expect(renderDexEarsReport(makeFullReport())).toContain('NO REAL TRADE SENT');
  });

  it('contains tradingExecuted: 0', () => {
    expect(renderDexEarsReport(makeFullReport())).toContain('tradingExecuted: 0');
  });

  it('shows [DRY RUN] when dryRun=true', () => {
    expect(renderDexEarsReport(makeFullReport(true))).toContain('DRY RUN');
  });

  it('does not show DRY RUN when dryRun=false', () => {
    expect(renderDexEarsReport(makeFullReport(false))).not.toContain('DRY RUN');
  });

  it('shows Written: 0 in dry-run mode', () => {
    expect(renderDexEarsReport(makeFullReport(true))).toContain('Written          : 0');
  });

  it('shows endpoint names', () => {
    const rendered = renderDexEarsReport(makeFullReport());
    expect(rendered).toContain('latest_boosts');
    expect(rendered).toContain('top_boosts');
  });

  it('shows chain and minConfidence', () => {
    const rendered = renderDexEarsReport(makeFullReport());
    expect(rendered).toContain('solana');
    expect(rendered).toContain('low');
  });

  it('shows suggested harness command', () => {
    const rendered = renderDexEarsReport(makeFullReport());
    expect(rendered).toContain('token:live-harness');
    expect(rendered).toContain('--pre-signals');
  });

  it('does not contain LIVE_EXECUTED', () => {
    expect(renderDexEarsReport(makeFullReport())).not.toContain('LIVE_EXECUTED');
  });

  it('does not contain privateKey, signTransaction, or sendTransaction', () => {
    const rendered = renderDexEarsReport(makeFullReport());
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });

  it('shows token:auto-paper was NOT run', () => {
    expect(renderDexEarsReport(makeFullReport())).toContain('token:auto-paper was NOT run');
  });

  it('CONF_ORDER correctly orders confidence levels', () => {
    expect(CONF_ORDER['low']).toBeLessThan(CONF_ORDER['medium']);
    expect(CONF_ORDER['medium']).toBeLessThan(CONF_ORDER['high']);
  });
});
