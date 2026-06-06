import { describe, expect, it } from 'vitest';
import { matchPoolToSignals, deriveLaunchSignalsFromSocial } from '../src/token-grab/matching';
import { scoreFreshPoolCandidate, scoreEventCandidate } from '../src/token-grab/scoring';
import { buildTokenGrabReport, renderTokenGrabReport } from '../src/token-grab/report';
import type {
  SocialSignal,
  EventSignal,
  FreshPool,
  LaunchSignal,
  TokenGrabFixtures,
} from '../src/token-grab/types';

// ── Factories ────────────────────────────────────────────────────────────────

function makeSocialSignal(overrides: Partial<SocialSignal> = {}): SocialSignal {
  return {
    id: 'ss-test',
    source: 'fixture',
    authorHandle: 'TestCaller',
    text: '$TEST fair launch CA soon',
    firstSeenAt: '2026-06-05T08:00:00Z',
    createdAt: '2026-06-05T08:00:00Z',
    engagement: { likes: 50, reposts: 15, replies: 5 },
    extracted: {
      tickers: ['TEST'],
      tokenNames: ['Test'],
      contractAddresses: [],
      urls: [],
      phrases: ['fair launch', 'CA soon'],
    },
    flags: {},
    ...overrides,
  };
}

function makeEventSignal(overrides: Partial<EventSignal> = {}): EventSignal {
  return {
    id: 'ev-test',
    source: 'fixture',
    phrase: 'PRESIDENT TOAD',
    normalizedPhrase: 'president toad',
    category: 'internet',
    firstSeenAt: '2026-06-05T06:00:00Z',
    velocityScore: 72,
    evidenceCount: 145,
    relatedTerms: ['ptoad', 'toadcoin'],
    exampleUrls: [],
    ...overrides,
  };
}

function makeFreshPool(overrides: Partial<FreshPool> = {}): FreshPool {
  return {
    id: 'fp-test',
    chain: 'solana',
    tokenName: 'Test',
    ticker: 'TEST',
    contractAddress: 'TestFakeCAForTestingPurposesOnly11111111111',
    createdAt: '2026-06-05T10:00:00Z',
    liquidityUsd: 35000,
    metadata: { website: 'https://test.example.com', x: 'https://x.com/fixture/test' },
    ...overrides,
  };
}

function makeLaunchSignal(overrides: Partial<LaunchSignal> = {}): LaunchSignal {
  return {
    id: 'derived-TEST',
    ticker: 'TEST',
    chain: 'solana',
    firstSeenAt: '2026-06-05T08:00:00Z',
    sourceSignalIds: ['ss-test'],
    officialLinks: [],
    confidence: 50,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deriveLaunchSignalsFromSocial', () => {
  it('derives launch signal when 2+ independent credible authors mention same ticker', () => {
    const signals = [
      makeSocialSignal({ id: 'ss1', authorHandle: 'Alice', extracted: { tickers: ['GOOSE'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] } }),
      makeSocialSignal({ id: 'ss2', authorHandle: 'Bob', extracted: { tickers: ['GOOSE'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] } }),
    ];
    const launches = deriveLaunchSignalsFromSocial(signals);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.ticker).toBe('GOOSE');
    expect(launches[0]!.confidence).toBe(50);
  });

  it('derives launch signal when 1 official/known-caller account mentions ticker', () => {
    const signals = [
      makeSocialSignal({ id: 'ss1', authorHandle: 'OfficialDev', flags: { officialProjectAccount: true }, extracted: { tickers: ['PHANTOM'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] } }),
    ];
    const launches = deriveLaunchSignalsFromSocial(signals);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.confidence).toBe(75);
  });

  it('does not derive launch signal from bot/spam signals even with many authors', () => {
    const botSignals = ['Bot1', 'Bot2', 'Bot3'].map((handle, i) =>
      makeSocialSignal({
        id: `ss${i}`,
        authorHandle: handle,
        flags: { suspectedBot: true, identicalSpamCluster: true },
        extracted: { tickers: ['SCAMGEM'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] },
      }),
    );
    const launches = deriveLaunchSignalsFromSocial(botSignals);
    expect(launches).toHaveLength(0);
  });
});

describe('matchPoolToSignals', () => {
  it('matches pool to social signal by ticker', () => {
    const pool = makeFreshPool({ ticker: 'TEST' });
    const signal = makeSocialSignal({ extracted: { tickers: ['TEST'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] } });
    const match = matchPoolToSignals(pool, [signal], [], []);
    expect(match.matchedSocialSignalIds).toContain('ss-test');
    expect(match.reasons.length).toBeGreaterThan(0);
  });

  it('matches pool to social signal by contract address', () => {
    const ca = 'TestFakeCAForTestingPurposesOnly11111111111';
    const pool = makeFreshPool({ contractAddress: ca });
    const signal = makeSocialSignal({ extracted: { tickers: [], tokenNames: [], contractAddresses: [ca], urls: [], phrases: [] } });
    const match = matchPoolToSignals(pool, [signal], [], []);
    expect(match.matchedSocialSignalIds).toContain('ss-test');
  });

  it('matches pool to event signal by normalizedPhrase in token name', () => {
    const pool = makeFreshPool({ tokenName: 'president toad', ticker: 'PTOAD' });
    const event = makeEventSignal();
    const match = matchPoolToSignals(pool, [], [event], []);
    expect(match.matchedEventSignalIds).toContain('ev-test');
  });

  it('flags bot signals as red flags in match', () => {
    const pool = makeFreshPool();
    const botSignal = makeSocialSignal({ flags: { suspectedBot: true, identicalSpamCluster: true } });
    const match = matchPoolToSignals(pool, [botSignal], [], []);
    expect(match.redFlags.some(f => f.includes('bot'))).toBe(true);
    expect(match.redFlags.some(f => f.includes('spam'))).toBe(true);
  });
});

describe('scoreFreshPoolCandidate', () => {
  it('awards +25 for credible pre-launch social signal before pool creation', () => {
    const pool = makeFreshPool({ createdAt: '2026-06-05T10:00:00Z' });
    const signal = makeSocialSignal({ createdAt: '2026-06-05T08:00:00Z', flags: { knownCaller: true } });
    const launch = makeLaunchSignal();
    const match = matchPoolToSignals(pool, [signal], [], [launch]);
    const result = scoreFreshPoolCandidate(pool, match, [signal], [], [launch]);
    expect(result.score).toBeGreaterThan(50);
    expect(result.reasons.some(r => r.includes('+25'))).toBe(true);
  });

  it('penalizes spam cluster and bot signals', () => {
    const pool = makeFreshPool({ liquidityUsd: 4000, metadata: undefined });
    const spamSignal = makeSocialSignal({
      flags: { suspectedBot: true, identicalSpamCluster: true },
      engagement: { likes: 0, reposts: 0, replies: 0 },
    });
    const match = matchPoolToSignals(pool, [spamSignal], [], []);
    const result = scoreFreshPoolCandidate(pool, match, [spamSignal], [], []);
    expect(result.score).toBe(0);
    expect(result.redFlags.some(f => f.includes('spam'))).toBe(true);
    expect(result.redFlags.some(f => f.includes('bot'))).toBe(true);
  });
});

describe('buildTokenGrabReport lane assignment', () => {
  const preLaunchSocial = makeSocialSignal({
    id: 'ss-pre',
    authorHandle: 'KnownCaller',
    flags: { knownCaller: true },
    firstSeenAt: '2026-06-05T08:00:00Z',
    createdAt: '2026-06-05T08:00:00Z',
    extracted: { tickers: ['TEST'], tokenNames: ['Test'], contractAddresses: [], urls: [], phrases: [] },
  });
  const independentSocial = makeSocialSignal({
    id: 'ss-ind',
    authorHandle: 'IndieWatcher',
    firstSeenAt: '2026-06-05T08:30:00Z',
    createdAt: '2026-06-05T08:30:00Z',
    extracted: { tickers: ['TEST'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] },
  });
  const matchingPool = makeFreshPool();

  it('pre-launch signal + matching pool => FRESH_LAUNCH_CANDIDATE / ALERT_ONLY', () => {
    const fixtures: TokenGrabFixtures = {
      socialSignals: [preLaunchSocial, independentSocial],
      eventSignals: [],
      freshPools: [matchingPool],
    };
    const report = buildTokenGrabReport(fixtures);
    const c = report.candidates.find(c => c.ticker === 'TEST');
    expect(c?.lane).toBe('FRESH_LAUNCH_CANDIDATE');
    expect(c?.decision).toBe('ALERT_ONLY');
    expect(c?.noTradingExecuted).toBe(true);
  });

  it('event signal with no pool => MEME_EVENT_CANDIDATE / WATCH', () => {
    const fixtures: TokenGrabFixtures = {
      socialSignals: [],
      eventSignals: [makeEventSignal()],
      freshPools: [],
    };
    const report = buildTokenGrabReport(fixtures);
    const c = report.candidates[0];
    expect(c?.lane).toBe('MEME_EVENT_CANDIDATE');
    expect(c?.decision).toBe('WATCH');
  });

  it('pre-launch signal with no pool => PRE_LAUNCH_WATCH / WATCH', () => {
    const fixtures: TokenGrabFixtures = {
      socialSignals: [preLaunchSocial, independentSocial],
      eventSignals: [],
      freshPools: [],
    };
    const report = buildTokenGrabReport(fixtures);
    const c = report.candidates.find(c => c.ticker === 'TEST');
    expect(c?.lane).toBe('PRE_LAUNCH_WATCH');
    expect(c?.decision).toBe('WATCH');
  });

  it('fresh pool with no social/event context => NOISE_RUG_LIKELY / REJECT', () => {
    const noContextPool = makeFreshPool({
      id: 'fp-noise',
      ticker: 'NOISE',
      tokenName: 'NoiseCoin',
      contractAddress: 'NoiseCoinFakeCAForTestingPurposesOnly1111',
      liquidityUsd: 5000,
      metadata: undefined,
    });
    const fixtures: TokenGrabFixtures = {
      socialSignals: [],
      eventSignals: [],
      freshPools: [noContextPool],
    };
    const report = buildTokenGrabReport(fixtures);
    expect(report.candidates[0]?.lane).toBe('NOISE_RUG_LIKELY');
    expect(report.candidates[0]?.decision).toBe('REJECT');
  });

  it('identical spam cluster reduces score to 0 and creates red flags', () => {
    const spamSignals = ['Bot1', 'Bot2', 'Bot3'].map((h, i) =>
      makeSocialSignal({
        id: `spam-${i}`,
        authorHandle: h,
        flags: { suspectedBot: true, identicalSpamCluster: true },
        engagement: { likes: 0, reposts: 0, replies: 0 },
        extracted: { tickers: ['SCAM'], tokenNames: [], contractAddresses: [], urls: [], phrases: [] },
      }),
    );
    const spamPool = makeFreshPool({
      id: 'fp-spam',
      ticker: 'SCAM',
      tokenName: 'ScamToken',
      contractAddress: 'ScamTokenFakeCAForTestingPurposesOnly11111',
      liquidityUsd: 3000,
      metadata: undefined,
    });
    const fixtures: TokenGrabFixtures = {
      socialSignals: spamSignals,
      eventSignals: [],
      freshPools: [spamPool],
    };
    const report = buildTokenGrabReport(fixtures);
    const c = report.candidates.find(c => c.ticker === 'SCAM');
    expect(c?.score).toBe(0);
    expect(c?.lane).toBe('NOISE_RUG_LIKELY');
    expect(c?.redFlags.some(f => f.includes('spam'))).toBe(true);
  });
});

describe('renderTokenGrabReport', () => {
  it('always contains NO TRADING EXECUTED', () => {
    const fixtures: TokenGrabFixtures = { socialSignals: [], eventSignals: [], freshPools: [] };
    const report = buildTokenGrabReport(fixtures);
    const rendered = renderTokenGrabReport(report);
    expect(rendered).toContain('NO TRADING EXECUTED');
    expect(rendered).toContain('LOCKED');
    expect(rendered).toContain('fixture-only');
  });

  it('summary counts are consistent with candidates', () => {
    const fixtures: TokenGrabFixtures = {
      socialSignals: [],
      eventSignals: [makeEventSignal()],
      freshPools: [makeFreshPool({ ticker: 'NOISE', tokenName: 'NoiseCoin', contractAddress: 'NoiseCoinFakeCAForTestingPurposesOnly1111', liquidityUsd: 0, metadata: undefined })],
    };
    const report = buildTokenGrabReport(fixtures);
    const total =
      report.summary.prelaunchWatch +
      report.summary.memeEventCandidates +
      report.summary.freshLaunchCandidates +
      report.summary.rejectedNoise;
    expect(total).toBe(report.candidates.length);
    expect(report.summary.tradingExecuted).toBe(0);
  });
});

describe('module isolation — no network or trading calls', () => {
  it('buildTokenGrabReport uses only the provided fixture data', () => {
    const fixtures: TokenGrabFixtures = { socialSignals: [], eventSignals: [], freshPools: [] };
    const report = buildTokenGrabReport(fixtures);
    expect(report.mode).toBe('fixture-only');
    expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
    expect(report.candidates).toHaveLength(0);
  });
});
