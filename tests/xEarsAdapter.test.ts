import { describe, expect, it } from 'vitest';
import { mapXEarsPostsToSocialSignals, mapXEarsReportToSocialSignals } from '../src/token-grab/xEarsAdapter';
import { buildTokenGrabReport } from '../src/token-grab/report';
import type { SocialPost, XEarsReport } from '../src/social/xEarsAnalyzer';

// ── Factories ─────────────────────────────────────────────────────────────────

function makePost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    id: 'post-001',
    author: 'CryptoWatcher',
    authorAgeDays: 365,
    text: '$GOOSE fair launch CA soon GooseFakeCAForTestingPurposesNa11111111111',
    createdAt: '2026-06-05T08:00:00Z',
    replyCount: 3,
    repostCount: 8,
    likeCount: 42,
    url: 'https://x.com/CryptoWatcher/status/001',
    ...overrides,
  };
}

function makeBotPost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    id: 'bot-001',
    author: 'SpamBot',
    authorAgeDays: 5,
    text: 'Buy $SCAM now 100x guaranteed!!!',
    createdAt: '2026-06-05T09:00:00Z',
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    ...overrides,
  };
}

function makeXEarsReport(overrides: Partial<XEarsReport> = {}): XEarsReport {
  return {
    timestamp: '2026-06-05T10:00:00Z',
    sourceMode: 'fixture',
    totalPostsInspected: 2,
    windowMinutes: 90,
    clusters: [
      {
        key: 'GooseFakeCAForTestingPurposesNa11111111111',
        keyType: 'contract',
        postCount: 2,
        independentAuthorCount: 2,
        launchIntentScore: 80,
        botNoiseRisk: 10,
        hasContract: true,
        hasTicker: true,
        repeatedTextRisk: 0,
        staleRisk: 0,
        decision: 'WAIT_FOR_POOL',
        oneLineReason: 'Contract address + launch-intent across multiple authors',
        topPosts: [
          {
            author: 'CryptoWatcher',
            text: '$GOOSE fair launch CA soon GooseFakeCAForTestingPurposesNa11111111111',
            createdAt: '2026-06-05T08:00:00Z',
            likeCount: 42,
            repostCount: 8,
            replyCount: 3,
            url: 'https://x.com/CryptoWatcher/status/001',
          },
          {
            author: 'SolanaWatcher99',
            text: '$GOOSE is launching GooseFakeCAForTestingPurposesNa11111111111',
            createdAt: '2026-06-05T08:15:00Z',
            likeCount: 10,
            repostCount: 2,
            replyCount: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ── mapXEarsPostsToSocialSignals ──────────────────────────────────────────────

describe('mapXEarsPostsToSocialSignals', () => {
  it('maps a post with ticker, CA, URL, and engagement into SocialSignal', () => {
    const post = makePost();
    const [signal] = mapXEarsPostsToSocialSignals([post]);

    expect(signal).toBeDefined();
    expect(signal!.id).toBe('x-post-001');
    expect(signal!.source).toBe('x');
    expect(signal!.authorHandle).toBe('CryptoWatcher');
    expect(signal!.text).toBe(post.text);
    expect(signal!.url).toBe('https://x.com/CryptoWatcher/status/001');
    expect(signal!.firstSeenAt).toBe('2026-06-05T08:00:00Z');
    expect(signal!.createdAt).toBe('2026-06-05T08:00:00Z');
    expect(signal!.engagement?.likes).toBe(42);
    expect(signal!.engagement?.reposts).toBe(8);
    expect(signal!.engagement?.replies).toBe(3);
    expect(signal!.extracted.tickers).toContain('GOOSE');
    expect(signal!.extracted.contractAddresses).toContain('GooseFakeCAForTestingPurposesNa11111111111');
    expect(signal!.extracted.phrases).toContain('fair launch');
    expect(signal!.extracted.phrases).toContain('ca soon');
  });

  it('maps bot indicators: young account + zero engagement → suspectedBot', () => {
    const post = makeBotPost();
    const [signal] = mapXEarsPostsToSocialSignals([post]);

    expect(signal!.flags.suspectedBot).toBe(true);
    expect(signal!.flags.identicalSpamCluster).toBeUndefined();
  });

  it('does not set suspectedBot for old account with zero engagement', () => {
    const post = makeBotPost({ authorAgeDays: 500 });
    const [signal] = mapXEarsPostsToSocialSignals([post]);

    expect(signal!.flags.suspectedBot).toBeUndefined();
  });

  it('does not set suspectedBot for young account with engagement', () => {
    const post = makeBotPost({ likeCount: 5 });
    const [signal] = mapXEarsPostsToSocialSignals([post]);

    expect(signal!.flags.suspectedBot).toBeUndefined();
  });

  it('detects identicalSpamCluster when normalized text appears more than once', () => {
    const spamText = 'Buy $SCAM now 100x guaranteed!!!';
    const posts = [
      makeBotPost({ id: 'b1', author: 'Bot1', text: spamText }),
      makeBotPost({ id: 'b2', author: 'Bot2', text: spamText }),
      makeBotPost({ id: 'b3', author: 'Bot3', text: spamText }),
    ];
    const signals = mapXEarsPostsToSocialSignals(posts);

    expect(signals).toHaveLength(3);
    for (const s of signals) {
      expect(s.flags.identicalSpamCluster).toBe(true);
    }
  });

  it('does not set identicalSpamCluster for unique texts', () => {
    const posts = [
      makePost({ id: 'p1', text: '$GOOSE launching now CA: GooseFakeCAForTestingPurposesNa11111111111' }),
      makePost({ id: 'p2', text: '$GOOSE fair launch soon watch this space' }),
    ];
    const signals = mapXEarsPostsToSocialSignals(posts);

    for (const s of signals) {
      expect(s.flags.identicalSpamCluster).toBeUndefined();
    }
  });

  it('preserves timestamps from post', () => {
    const post = makePost({ createdAt: '2026-06-05T07:30:00Z' });
    const [signal] = mapXEarsPostsToSocialSignals([post]);

    expect(signal!.firstSeenAt).toBe('2026-06-05T07:30:00Z');
    expect(signal!.createdAt).toBe('2026-06-05T07:30:00Z');
  });

  it('falls back to nowIso when post has no createdAt', () => {
    const post = makePost({ createdAt: undefined });
    const [signal] = mapXEarsPostsToSocialSignals([post], '2026-06-05T12:00:00Z');

    expect(signal!.firstSeenAt).toBe('2026-06-05T12:00:00Z');
    expect(signal!.createdAt).toBeUndefined();
  });

  it('generates stable deterministic id from author + text when post.id is absent', () => {
    const post = makePost({ id: undefined });
    const [s1] = mapXEarsPostsToSocialSignals([post]);
    const [s2] = mapXEarsPostsToSocialSignals([post]);

    expect(s1!.id).toBe(s2!.id);
    expect(s1!.id).toMatch(/^x-[0-9a-f]+$/);
  });

  it('handles empty posts array without error', () => {
    expect(mapXEarsPostsToSocialSignals([])).toEqual([]);
  });

  it('does not set knownCaller or officialProjectAccount (x-ears has no concept of these)', () => {
    const [signal] = mapXEarsPostsToSocialSignals([makePost()]);
    expect(signal!.flags.knownCaller).toBeUndefined();
    expect(signal!.flags.officialProjectAccount).toBeUndefined();
  });
});

// ── mapXEarsReportToSocialSignals ─────────────────────────────────────────────

describe('mapXEarsReportToSocialSignals', () => {
  it('extracts signals from cluster topPosts', () => {
    const report = makeXEarsReport();
    const signals = mapXEarsReportToSocialSignals(report);

    expect(signals).toHaveLength(2);
    expect(signals[0]!.source).toBe('x');
    expect(signals[0]!.authorHandle).toBe('CryptoWatcher');
    expect(signals[1]!.authorHandle).toBe('SolanaWatcher99');
  });

  it('uses contract cluster key as contractAddresses for contract-type clusters', () => {
    const report = makeXEarsReport();
    const signals = mapXEarsReportToSocialSignals(report);

    for (const s of signals) {
      expect(s.extracted.contractAddresses).toContain('GooseFakeCAForTestingPurposesNa11111111111');
    }
  });

  it('uses ticker cluster key as tickers for ticker-type clusters', () => {
    const report = makeXEarsReport({
      clusters: [
        {
          key: 'GOOSE',
          keyType: 'ticker',
          postCount: 1,
          independentAuthorCount: 1,
          launchIntentScore: 40,
          botNoiseRisk: 5,
          hasContract: false,
          hasTicker: true,
          repeatedTextRisk: 0,
          staleRisk: 0,
          decision: 'WATCH_SOCIAL',
          oneLineReason: 'Ticker with moderate intent',
          topPosts: [{ author: 'Watcher', text: '$GOOSE soon', createdAt: '2026-06-05T08:00:00Z' }],
        },
      ],
    });
    const [signal] = mapXEarsReportToSocialSignals(report);
    expect(signal!.extracted.tickers).toContain('GOOSE');
  });

  it('sets suspectedBot on signals from high-botNoiseRisk clusters', () => {
    const report = makeXEarsReport({
      clusters: [
        {
          key: 'fair launch',
          keyType: 'narrative',
          postCount: 3,
          independentAuthorCount: 1,
          launchIntentScore: 20,
          botNoiseRisk: 90,
          hasContract: false,
          hasTicker: false,
          repeatedTextRisk: 90,
          staleRisk: 0,
          decision: 'IGNORE_UNSAFE_OR_BOTLIKE',
          oneLineReason: 'High bot/spam indicators',
          topPosts: [{ author: 'bot1', text: 'fair launch soon buy now', createdAt: '2026-06-05T09:00:00Z' }],
        },
      ],
    });
    const [signal] = mapXEarsReportToSocialSignals(report);

    expect(signal!.flags.suspectedBot).toBe(true);
    expect(signal!.flags.identicalSpamCluster).toBe(true);
  });

  it('does not set bot flags on clean low-risk clusters', () => {
    const report = makeXEarsReport();
    const signals = mapXEarsReportToSocialSignals(report);

    for (const s of signals) {
      expect(s.flags.suspectedBot).toBeUndefined();
      expect(s.flags.identicalSpamCluster).toBeUndefined();
    }
  });

  it('preserves timestamps from topPosts', () => {
    const report = makeXEarsReport();
    const [signal] = mapXEarsReportToSocialSignals(report);

    expect(signal!.firstSeenAt).toBe('2026-06-05T08:00:00Z');
    expect(signal!.createdAt).toBe('2026-06-05T08:00:00Z');
  });

  it('returns empty array for report with no clusters', () => {
    const report = makeXEarsReport({ clusters: [] });
    expect(mapXEarsReportToSocialSignals(report)).toEqual([]);
  });
});

// ── Token Grab report built from x-ears adapter output ───────────────────────

describe('buildTokenGrabReport with x-ears adapter output', () => {
  it('handles zero social signals gracefully — returns empty candidates', () => {
    const report = buildTokenGrabReport({
      socialSignals: [],
      eventSignals: [],
      freshPools: [],
    });

    expect(report.candidates).toHaveLength(0);
    expect(report.summary.tradingExecuted).toBe(0);
    expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });

  it('produces PRE_LAUNCH_WATCH candidates from x-ears signals with valid ticker + 2 authors', () => {
    const posts: SocialPost[] = [
      makePost({ id: 'p1', author: 'Alice', text: '$GOOSE fair launch CA soon' }),
      makePost({ id: 'p2', author: 'Bob', text: '$GOOSE launch soon' }),
    ];
    const signals = mapXEarsPostsToSocialSignals(posts);
    const report = buildTokenGrabReport({
      socialSignals: signals,
      eventSignals: [],
      freshPools: [],
    });

    const prelaunch = report.candidates.filter(c => c.lane === 'PRE_LAUNCH_WATCH');
    expect(prelaunch.length).toBeGreaterThan(0);
    expect(report.summary.tradingExecuted).toBe(0);
    expect(prelaunch[0]!.noTradingExecuted).toBe(true);
  });

  it('rejects bot-only signals — no candidates become PRE_LAUNCH_WATCH', () => {
    const spamText = 'fair launch 100x buy now guaranteed!!!';
    const posts: SocialPost[] = [
      makeBotPost({ id: 'b1', author: 'Bot1', text: spamText }),
      makeBotPost({ id: 'b2', author: 'Bot2', text: spamText }),
    ];
    const signals = mapXEarsPostsToSocialSignals(posts);
    const report = buildTokenGrabReport({
      socialSignals: signals,
      eventSignals: [],
      freshPools: [],
    });

    const prelaunch = report.candidates.filter(c => c.lane === 'PRE_LAUNCH_WATCH');
    expect(prelaunch).toHaveLength(0);
    expect(report.summary.tradingExecuted).toBe(0);
  });
});
