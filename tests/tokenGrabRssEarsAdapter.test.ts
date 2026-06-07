import { describe, it, expect } from 'vitest';
import {
  parseRssConfig,
  parseRssXml,
  feedItemToInputItem,
  filterByKeywords,
  buildRssAdapterReport,
  renderRssAdapterReport,
} from '../src/token-grab/rssEarsAdapter';
import type { RssAdapterInput, FeedResult, RssFeedItem } from '../src/token-grab/rssEarsAdapter';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

const TS = '2026-06-07T00:00:00.000Z';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>New Solana meme token launches on Raydium</title>
      <link>https://example.com/1</link>
      <description>$GOOSE token is now live on Raydium with liquidity added.</description>
      <pubDate>Sat, 07 Jun 2026 12:00:00 +0000</pubDate>
    </item>
    <item>
      <title><![CDATA[Breaking: CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU posted by caller]]></title>
      <link>https://example.com/2</link>
      <description><![CDATA[Influencer drops contract address for new pump.fun token $FROGAI]]></description>
      <pubDate>Sat, 07 Jun 2026 11:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Stock market update: equities rally</title>
      <link>https://example.com/3</link>
      <description>S&amp;P 500 rises as inflation data improves.</description>
      <pubDate>Sat, 07 Jun 2026 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const CRYPTO_KEYWORDS = ['launch', 'meme', 'token', 'Raydium', 'pump.fun', 'Solana', 'CA'];

function makeFeedItem(overrides: Partial<RssFeedItem> = {}): RssFeedItem {
  return {
    title: 'Solana token launches on Raydium',
    link: 'https://example.com/article',
    description: '$GOOSE is live on pump.fun with liquidity.',
    pubDate: TS,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<PreSignal> = {}): PreSignal {
  return {
    id: 'test-001',
    source: 'news_manual',
    text: 'existing signal text',
    symbol: undefined,
    contract: null,
    seenAt: TS,
    signalType: 'unknown',
    confidence: 'low',
    ...overrides,
  };
}

function makeAdapterInput(overrides: Partial<RssAdapterInput> = {}): RssAdapterInput {
  const items = parseRssXml(FIXTURE_XML, 20);
  const feedResult: FeedResult = {
    feed: { name: 'Test', url: 'https://example.com/rss', source: 'news_manual' },
    items,
  };
  return {
    feedResults: [feedResult],
    existingSignals: [],
    config: { feeds: [feedResult.feed], keywords: CRYPTO_KEYWORDS, maxItemsPerFeed: 20 },
    generatedAt: TS,
    dryRun: false,
    outputPath: 'test/presignals.json',
    ...overrides,
  };
}

// ── parseRssConfig ────────────────────────────────────────────────────────────

describe('parseRssConfig', () => {
  it('parses valid config with all fields', () => {
    const raw = {
      feeds: [{ name: 'CoinDesk', url: 'https://example.com/rss', source: 'news_manual' }],
      keywords: ['launch', 'meme'],
      maxItemsPerFeed: 10,
    };
    const config = parseRssConfig(raw);
    expect(config.feeds).toHaveLength(1);
    expect(config.feeds[0].name).toBe('CoinDesk');
    expect(config.feeds[0].source).toBe('news_manual');
    expect(config.keywords).toEqual(['launch', 'meme']);
    expect(config.maxItemsPerFeed).toBe(10);
  });

  it('applies defaults for missing optional fields', () => {
    const config = parseRssConfig({ feeds: [] });
    expect(config.keywords).toEqual([]);
    expect(config.maxItemsPerFeed).toBe(20);
  });

  it('defaults invalid source to news_manual', () => {
    const raw = {
      feeds: [{ name: 'X', url: 'https://example.com', source: 'invalid_source' }],
    };
    const config = parseRssConfig(raw);
    expect(config.feeds[0].source).toBe('news_manual');
  });

  it('throws on non-object input', () => {
    expect(() => parseRssConfig(null)).toThrow('[parseRssConfig]');
    expect(() => parseRssConfig('string')).toThrow('[parseRssConfig]');
  });

  it('skips feed entries missing name or url', () => {
    const raw = {
      feeds: [
        { name: 'Valid', url: 'https://example.com', source: 'news_manual' },
        { url: 'https://no-name.com' },
        { name: 'No URL' },
      ],
    };
    const config = parseRssConfig(raw);
    expect(config.feeds).toHaveLength(1);
  });
});

// ── parseRssXml ───────────────────────────────────────────────────────────────

describe('parseRssXml', () => {
  it('parses title, link, description, and pubDate from plain items', () => {
    const items = parseRssXml(FIXTURE_XML, 20);
    expect(items.length).toBeGreaterThan(0);
    const first = items[0];
    expect(first.title).toBe('New Solana meme token launches on Raydium');
    expect(first.link).toBe('https://example.com/1');
    expect(first.description).toContain('GOOSE');
    expect(first.pubDate).toBe('2026-06-07T12:00:00.000Z');
  });

  it('strips CDATA from title and description', () => {
    const items = parseRssXml(FIXTURE_XML, 20);
    const cdataItem = items[1];
    expect(cdataItem.title).toContain('Breaking: CA:');
    expect(cdataItem.title).not.toContain('CDATA');
    expect(cdataItem.description).toContain('pump.fun');
    expect(cdataItem.description).not.toContain('CDATA');
  });

  it('respects maxItems limit', () => {
    const items = parseRssXml(FIXTURE_XML, 1);
    expect(items).toHaveLength(1);
  });

  it('returns empty array for empty or malformed XML', () => {
    expect(parseRssXml('', 20)).toEqual([]);
    expect(parseRssXml('<not-rss/>', 20)).toEqual([]);
    expect(parseRssXml('not xml at all', 20)).toEqual([]);
  });

  it('parses all three fixture items when maxItems is large', () => {
    const items = parseRssXml(FIXTURE_XML, 100);
    expect(items).toHaveLength(3);
  });
});

// ── feedItemToInputItem ───────────────────────────────────────────────────────

describe('feedItemToInputItem', () => {
  it('combines title and description into text', () => {
    const item = makeFeedItem();
    const input = feedItemToInputItem(item);
    expect(input.text).toContain(item.title);
    expect(input.text).toContain('GOOSE');
  });

  it('uses link as url', () => {
    const item = makeFeedItem({ link: 'https://example.com/test' });
    expect(feedItemToInputItem(item).url).toBe('https://example.com/test');
  });

  it('uses pubDate as seenAt', () => {
    const item = makeFeedItem({ pubDate: TS });
    expect(feedItemToInputItem(item).seenAt).toBe(TS);
  });

  it('omits url and seenAt when not present in item', () => {
    const item = makeFeedItem({ link: undefined, pubDate: undefined });
    expect(feedItemToInputItem(item).url).toBeUndefined();
    expect(feedItemToInputItem(item).seenAt).toBeUndefined();
  });

  it('strips HTML tags from description', () => {
    const item = makeFeedItem({ description: '<b>$GOOSE</b> is <em>live</em> now' });
    expect(feedItemToInputItem(item).text).toContain('$GOOSE');
    expect(feedItemToInputItem(item).text).not.toContain('<b>');
  });
});

// ── filterByKeywords ──────────────────────────────────────────────────────────

describe('filterByKeywords', () => {
  it('returns items containing any keyword (case-insensitive)', () => {
    const items = parseRssXml(FIXTURE_XML, 20);
    const filtered = filterByKeywords(items, ['raydium', 'pump.fun']);
    // Items 1 and 2 match; item 3 (equities) does not
    expect(filtered.length).toBe(2);
  });

  it('returns all items when keywords array is empty', () => {
    const items = parseRssXml(FIXTURE_XML, 20);
    expect(filterByKeywords(items, [])).toHaveLength(items.length);
  });

  it('rejects items with no keyword match', () => {
    const items = [makeFeedItem({ title: 'Stock market rally', description: 'Equities up today' })];
    const filtered = filterByKeywords(items, ['solana', 'raydium', 'meme']);
    expect(filtered).toHaveLength(0);
  });

  it('matches keywords in description as well as title', () => {
    const item = makeFeedItem({ title: 'Breaking news', description: 'New Raydium pool detected' });
    expect(filterByKeywords([item], ['raydium'])).toHaveLength(1);
  });
});

// ── buildRssAdapterReport ─────────────────────────────────────────────────────

describe('buildRssAdapterReport', () => {
  it('returns noRealTradeSent: true always', () => {
    expect(buildRssAdapterReport(makeAdapterInput()).noRealTradeSent).toBe(true);
    expect(buildRssAdapterReport(makeAdapterInput({ dryRun: true })).noRealTradeSent).toBe(true);
  });

  it('returns tradingExecuted: 0 always', () => {
    expect(buildRssAdapterReport(makeAdapterInput()).tradingExecuted).toBe(0);
    expect(buildRssAdapterReport(makeAdapterInput({ dryRun: true })).tradingExecuted).toBe(0);
  });

  it('dryRun flag passes through to report', () => {
    expect(buildRssAdapterReport(makeAdapterInput({ dryRun: true })).dryRun).toBe(true);
    expect(buildRssAdapterReport(makeAdapterInput({ dryRun: false })).dryRun).toBe(false);
  });

  it('counts feedErrors for results with error field', () => {
    const items = parseRssXml(FIXTURE_XML, 20);
    const feedResults: FeedResult[] = [
      { feed: { name: 'OK', url: 'https://ok.com', source: 'news_manual' }, items },
      { feed: { name: 'Bad', url: 'https://bad.com', source: 'news_manual' }, items: [], error: 'HTTP 404' },
    ];
    const report = buildRssAdapterReport(makeAdapterInput({ feedResults }));
    expect(report.feedErrors).toBe(1);
    expect(report.feedsChecked).toBe(2);
  });

  it('deduplicates fresh signals against existing by symbol+text', () => {
    const input = makeAdapterInput();
    // First run to get signals
    const first = buildRssAdapterReport(input);
    expect(first.uniqueSignals.length).toBeGreaterThan(0);

    // Second run with first run's signals as existing → all should be dupes
    const second = buildRssAdapterReport(makeAdapterInput({ existingSignals: first.uniqueSignals }));
    expect(second.duplicatesSkipped).toBe(first.signalsExtracted);
    expect(second.uniqueSignals).toHaveLength(0);
  });

  it('only counts keyword-matching items in keywordMatches', () => {
    const report = buildRssAdapterReport(makeAdapterInput());
    // Fixture has 3 items, 2 match crypto keywords
    expect(report.itemsScanned).toBe(3);
    expect(report.keywordMatches).toBe(2);
  });

  it('produces unique signals for fresh non-duplicate items', () => {
    const report = buildRssAdapterReport(makeAdapterInput({ existingSignals: [] }));
    expect(report.uniqueSignals.length).toBeGreaterThan(0);
  });
});

// ── renderRssAdapterReport ────────────────────────────────────────────────────

describe('renderRssAdapterReport', () => {
  it('contains safety markers', () => {
    const report = buildRssAdapterReport(makeAdapterInput());
    const rendered = renderRssAdapterReport(report);
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
  });

  it('shows [DRY RUN] label when dryRun=true', () => {
    const report = buildRssAdapterReport(makeAdapterInput({ dryRun: true }));
    expect(renderRssAdapterReport(report)).toContain('[DRY RUN — no file written]');
  });

  it('shows Written: 0 when dryRun=true', () => {
    const report = buildRssAdapterReport(makeAdapterInput({ dryRun: true }));
    expect(renderRssAdapterReport(report)).toContain('Written         : 0');
  });

  it('shows feed stats in output', () => {
    const report = buildRssAdapterReport(makeAdapterInput());
    const rendered = renderRssAdapterReport(report);
    expect(rendered).toContain('Feeds checked');
    expect(rendered).toContain('Items scanned');
    expect(rendered).toContain('Keyword matches');
    expect(rendered).toContain('Signals found');
  });

  it('does not contain LIVE_EXECUTED, privateKey, or signTransaction', () => {
    const report = buildRssAdapterReport(makeAdapterInput());
    const rendered = renderRssAdapterReport(report);
    expect(rendered).not.toContain('LIVE_EXECUTED');
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });
});
