import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildTokenGrabReport } from '../src/token-grab/report';
import { loadFreshPoolsFromFile, loadEventSignalsFromFile } from '../src/token-grab/loaders';
import { mapXEarsPostsToSocialSignals } from '../src/token-grab/xEarsAdapter';
import type { SocialSignal, EventSignal, FreshPool } from '../src/token-grab/types';
import type { SocialPost } from '../src/social/xEarsAnalyzer';

// ── Factories ─────────────────────────────────────────────────────────────────

const GOOSE_CA = 'GooseFakeCAForTestingPurposesNa11111111111';
const SCAM_CA  = 'ScamGemFakeCAForTestingPurposesNa11111111';

function makeSocial(overrides: Partial<SocialSignal> = {}): SocialSignal {
  return {
    id: 'ss-1',
    source: 'x',
    authorHandle: 'Caller1',
    text: `$GOOSE fair launch CA soon ${GOOSE_CA}`,
    firstSeenAt: '2026-06-05T08:00:00Z',
    createdAt: '2026-06-05T08:00:00Z',
    engagement: { likes: 30, reposts: 10, replies: 3 },
    extracted: {
      tickers: ['GOOSE'],
      tokenNames: [],
      contractAddresses: [GOOSE_CA],
      urls: [],
      phrases: ['fair launch', 'ca soon'],
    },
    flags: {},
    ...overrides,
  };
}

function makePool(overrides: Partial<FreshPool> = {}): FreshPool {
  return {
    id: 'fp-1',
    chain: 'solana',
    tokenName: 'Goose',
    ticker: 'GOOSE',
    contractAddress: GOOSE_CA,
    createdAt: '2026-06-05T10:00:00Z',
    liquidityUsd: 45000,
    metadata: { website: 'https://goose.example.com', x: 'https://x.com/fixture/goose' },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventSignal> = {}): EventSignal {
  return {
    id: 'ev-1',
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

function makeBotSocial(overrides: Partial<SocialSignal> = {}): SocialSignal {
  return makeSocial({
    id: 'ss-bot',
    authorHandle: 'SpamBot1',
    flags: { suspectedBot: true, identicalSpamCluster: true },
    engagement: { likes: 0, reposts: 0, replies: 0 },
    ...overrides,
  });
}

// ── Fresh pool + social matching ──────────────────────────────────────────────

describe('buildTokenGrabReport — fresh pool with social signals', () => {
  it('social signal + matching fresh pool produces FRESH_LAUNCH_CANDIDATE', () => {
    const social1 = makeSocial({ id: 'ss-1', authorHandle: 'Alice' });
    const social2 = makeSocial({ id: 'ss-2', authorHandle: 'Bob' });
    const pool = makePool();

    const report = buildTokenGrabReport({
      socialSignals: [social1, social2],
      eventSignals: [],
      freshPools: [pool],
    });

    const candidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(candidate).toBeDefined();
    expect(candidate!.lane).toBe('FRESH_LAUNCH_CANDIDATE');
    expect(candidate!.decision).toBe('ALERT_ONLY');
    expect(candidate!.score).toBeGreaterThanOrEqual(40);
    expect(candidate!.noTradingExecuted).toBe(true);
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('social signal without pool remains PRE_LAUNCH_WATCH', () => {
    const social1 = makeSocial({ id: 'ss-1', authorHandle: 'Alice' });
    const social2 = makeSocial({ id: 'ss-2', authorHandle: 'Bob' });

    const report = buildTokenGrabReport({
      socialSignals: [social1, social2],
      eventSignals: [],
      freshPools: [],
    });

    const candidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(candidate).toBeDefined();
    expect(candidate!.lane).toBe('PRE_LAUNCH_WATCH');
    expect(candidate!.decision).toBe('WATCH');
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('event signal without pool remains MEME_EVENT_CANDIDATE', () => {
    const event = makeEvent();

    const report = buildTokenGrabReport({
      socialSignals: [],
      eventSignals: [event],
      freshPools: [],
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.lane).toBe('MEME_EVENT_CANDIDATE');
    expect(report.candidates[0]!.decision).toBe('WATCH');
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('fresh pool without any social/event context becomes NOISE_RUG_LIKELY', () => {
    const pool = makePool({
      id: 'fp-rnd',
      tokenName: 'RandomCoin',
      ticker: 'RND999',
      contractAddress: 'RandomCoin999FakeCAForTestingPurposes1111',
      liquidityUsd: 9100,
      metadata: undefined,
    });

    const report = buildTokenGrabReport({
      socialSignals: [],
      eventSignals: [],
      freshPools: [pool],
    });

    expect(report.candidates[0]!.lane).toBe('NOISE_RUG_LIKELY');
    expect(report.candidates[0]!.decision).toBe('REJECT');
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('fresh pool matched only by bot/spam social signals is NOT elevated — stays NOISE_RUG_LIKELY', () => {
    const botSignal1 = makeBotSocial({ id: 'b1', authorHandle: 'Bot1' });
    const botSignal2 = makeBotSocial({ id: 'b2', authorHandle: 'Bot2' });
    const pool = makePool({ liquidityUsd: 5000, metadata: undefined });

    const report = buildTokenGrabReport({
      socialSignals: [botSignal1, botSignal2],
      eventSignals: [],
      freshPools: [pool],
    });

    const gooseCandidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(gooseCandidate).toBeDefined();
    expect(gooseCandidate!.lane).toBe('NOISE_RUG_LIKELY');
    expect(gooseCandidate!.decision).toBe('REJECT');
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('mixed credible + bot signals — credible authors can elevate pool if score threshold met', () => {
    const credible1 = makeSocial({ id: 'ss-c1', authorHandle: 'Alice' });
    const credible2 = makeSocial({ id: 'ss-c2', authorHandle: 'Bob' });
    const bot = makeBotSocial({ id: 'ss-b1', authorHandle: 'SpamBot' });
    const pool = makePool();

    const report = buildTokenGrabReport({
      socialSignals: [credible1, credible2, bot],
      eventSignals: [],
      freshPools: [pool],
    });

    const candidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(candidate).toBeDefined();
    // Credible signals should still allow FRESH_LAUNCH_CANDIDATE
    expect(candidate!.lane).toBe('FRESH_LAUNCH_CANDIDATE');
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('empty input — renders no candidates and zero trading', () => {
    const report = buildTokenGrabReport({
      socialSignals: [],
      eventSignals: [],
      freshPools: [],
    });

    expect(report.candidates).toHaveLength(0);
    expect(report.summary.tradingExecuted).toBe(0);
    expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });

  it('all four inputs present — GOOSE pool, MOODENG pre-launch, PRESIDENT TOAD event', () => {
    const gooseSocial1 = makeSocial({ id: 'ss-1', authorHandle: 'Alice' });
    const gooseSocial2 = makeSocial({ id: 'ss-2', authorHandle: 'Bob' });
    const moodengSocial1 = makeSocial({
      id: 'ss-3', authorHandle: 'Charlie',
      text: '$MOODENG stealth launch CA soon',
      extracted: { tickers: ['MOODENG'], tokenNames: [], contractAddresses: [], urls: [], phrases: ['ca soon'] },
    });
    const moodengSocial2 = makeSocial({
      id: 'ss-4', authorHandle: 'Dave',
      text: '$MOODENG launch soon watch this',
      extracted: { tickers: ['MOODENG'], tokenNames: [], contractAddresses: [], urls: [], phrases: ['launch soon'] },
    });
    const goosePool = makePool();
    const event = makeEvent();

    const report = buildTokenGrabReport({
      socialSignals: [gooseSocial1, gooseSocial2, moodengSocial1, moodengSocial2],
      eventSignals: [event],
      freshPools: [goosePool],
    });

    const lanes = report.candidates.map(c => c.lane);
    expect(lanes).toContain('FRESH_LAUNCH_CANDIDATE');
    expect(lanes).toContain('PRE_LAUNCH_WATCH');
    expect(lanes).toContain('MEME_EVENT_CANDIDATE');
    expect(report.summary.tradingExecuted).toBe(0);

    const gooseResult = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(gooseResult!.lane).toBe('FRESH_LAUNCH_CANDIDATE');

    const moodengResult = report.candidates.find(c => c.ticker === 'MOODENG');
    expect(moodengResult!.lane).toBe('PRE_LAUNCH_WATCH');
  });
});

// ── Loaders ───────────────────────────────────────────────────────────────────

describe('loadFreshPoolsFromFile', () => {
  it('loads fresh-pools.json fixture without error', () => {
    const filePath = path.join(__dirname, '../fixtures/token-grab/fresh-pools.json');
    const pools = loadFreshPoolsFromFile(filePath);
    expect(Array.isArray(pools)).toBe(true);
    expect(pools.length).toBeGreaterThan(0);
    expect(pools[0]).toHaveProperty('id');
    expect(pools[0]).toHaveProperty('ticker');
    expect(pools[0]).toHaveProperty('contractAddress');
  });

  it('throws descriptive error for non-existent file', () => {
    expect(() => loadFreshPoolsFromFile('/no/such/file.json')).toThrow('Cannot read file');
  });

  it('throws descriptive error for malformed JSON', () => {
    const tmp = path.join(os.tmpdir(), `tg-test-bad-${process.pid}.json`);
    fs.writeFileSync(tmp, '{ not valid json }');
    try {
      expect(() => loadFreshPoolsFromFile(tmp)).toThrow('Invalid JSON');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('throws descriptive error when JSON is not an array', () => {
    const tmp = path.join(os.tmpdir(), `tg-test-obj-${process.pid}.json`);
    fs.writeFileSync(tmp, '{"id":"fp1"}');
    try {
      expect(() => loadFreshPoolsFromFile(tmp)).toThrow('Expected JSON array');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('loadEventSignalsFromFile', () => {
  it('loads event-signals.json fixture without error', () => {
    const filePath = path.join(__dirname, '../fixtures/token-grab/event-signals.json');
    const events = loadEventSignalsFromFile(filePath);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty('phrase');
    expect(events[0]).toHaveProperty('velocityScore');
  });

  it('throws descriptive error for non-existent file', () => {
    expect(() => loadEventSignalsFromFile('/no/such/events.json')).toThrow('Cannot read file');
  });
});

// ── x-ears adapter → fresh pool integration ───────────────────────────────────

describe('x-ears adapter → fresh pool integration via buildTokenGrabReport', () => {
  it('x-ears posts with matching ticker produce FRESH_LAUNCH_CANDIDATE when pool present', () => {
    const posts: SocialPost[] = [
      { id: 'p1', author: 'Alice', authorAgeDays: 300, text: '$GOOSE fair launch CA soon', likeCount: 20, repostCount: 5, replyCount: 2 },
      { id: 'p2', author: 'Bob',   authorAgeDays: 200, text: '$GOOSE launch soon watch this', likeCount: 15, repostCount: 3, replyCount: 1 },
    ];
    const socialSignals = mapXEarsPostsToSocialSignals(posts);
    const pool = makePool({ contractAddress: GOOSE_CA });

    const report = buildTokenGrabReport({ socialSignals, eventSignals: [], freshPools: [pool] });

    const candidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(candidate?.lane).toBe('FRESH_LAUNCH_CANDIDATE');
    expect(candidate?.noTradingExecuted).toBe(true);
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('x-ears bot posts do not elevate a pool to FRESH_LAUNCH_CANDIDATE', () => {
    const spamText = '$SCAMGEM 1000x now buy buy buy guaranteed';
    const posts: SocialPost[] = [
      { id: 'b1', author: 'Bot1', authorAgeDays: 2, text: spamText, likeCount: 0, repostCount: 0, replyCount: 0 },
      { id: 'b2', author: 'Bot2', authorAgeDays: 3, text: spamText, likeCount: 0, repostCount: 0, replyCount: 0 },
    ];
    const signals = mapXEarsPostsToSocialSignals(posts);
    const pool = makePool({ id: 'fp-scam', tokenName: 'ScamGem', ticker: 'SCAMGEM', contractAddress: SCAM_CA, liquidityUsd: 4000, metadata: undefined });

    const report = buildTokenGrabReport({ socialSignals: signals, eventSignals: [], freshPools: [pool] });

    const candidate = report.candidates.find(c => c.ticker === 'SCAMGEM');
    expect(candidate?.lane).toBe('NOISE_RUG_LIKELY');
    expect(report.summary.tradingExecuted).toBe(0);
  });
});
