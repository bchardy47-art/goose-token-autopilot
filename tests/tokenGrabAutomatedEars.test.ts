import { describe, it, expect } from 'vitest';
import {
  parseAutomatedEarsConfig,
  buildRssConnectorResult,
  runXConnector,
  runTelegramConnector,
  runDiscordConnector,
  buildAutomatedEarsReport,
  renderAutomatedEarsReport,
  type ConnectorResult,
  type AutomatedEarsInput,
} from '../src/token-grab/automatedEars';
import type { FeedResult } from '../src/token-grab/rssEarsAdapter';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeConnectorResult(overrides: Partial<ConnectorResult> = {}): ConnectorResult {
  return {
    name: 'rss',
    source: 'news_manual',
    enabled: true,
    skipped: false,
    itemsFetched: 0,
    items: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<AutomatedEarsInput> = {}) {
  return buildAutomatedEarsReport({
    connectorResults: [],
    existingSignals: [],
    generatedAt: '2026-06-06T00:00:00.000Z',
    dryRun: false,
    outputPath: 'data/token-grab/x-ears/presignals.json',
    ...overrides,
  });
}

const LAUNCH_ITEM = { text: '$GOOSE token launch on Raydium — CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };
const MEME_ITEM = { text: '$MEME new token launched on pump.fun — ticker: MEME, listing live' };

// ── parseAutomatedEarsConfig ───────────────────────────────────────────────────

describe('parseAutomatedEarsConfig', () => {
  it('parses a complete valid config', () => {
    const raw = {
      keywords: ['launch', 'CA:', 'Raydium'],
      rss: {
        enabled: true,
        feeds: [{ name: 'CoinDesk', url: 'https://coindesk.com/rss', source: 'news_manual' }],
        maxItemsPerFeed: 15,
      },
      x: { enabled: false, keywords: ['token launch'], accounts: ['caller'], maxItems: 30 },
      telegram: { enabled: false, chatIds: ['-100123'], maxItems: 25 },
      discord: { enabled: false, channelIds: ['987654321'], maxItems: 20 },
    };
    const cfg = parseAutomatedEarsConfig(raw);
    expect(cfg.keywords).toEqual(['launch', 'CA:', 'Raydium']);
    expect(cfg.rss.enabled).toBe(true);
    expect(cfg.rss.feeds).toHaveLength(1);
    expect(cfg.rss.feeds[0].name).toBe('CoinDesk');
    expect(cfg.rss.maxItemsPerFeed).toBe(15);
    expect(cfg.x.enabled).toBe(false);
    expect(cfg.x.accounts).toEqual(['caller']);
    expect(cfg.telegram.chatIds).toEqual(['-100123']);
    expect(cfg.discord.channelIds).toEqual(['987654321']);
  });

  it('applies defaults when fields are missing', () => {
    const cfg = parseAutomatedEarsConfig({});
    expect(cfg.keywords).toEqual([]);
    expect(cfg.rss.enabled).toBe(false);
    expect(cfg.rss.feeds).toEqual([]);
    expect(cfg.rss.maxItemsPerFeed).toBe(20);
    expect(cfg.x.enabled).toBe(false);
    expect(cfg.x.keywords).toEqual([]);
    expect(cfg.x.maxItems).toBe(50);
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.telegram.chatIds).toEqual([]);
    expect(cfg.discord.enabled).toBe(false);
    expect(cfg.discord.channelIds).toEqual([]);
  });

  it('throws on non-object input', () => {
    expect(() => parseAutomatedEarsConfig(null)).toThrow('[parseAutomatedEarsConfig]');
    expect(() => parseAutomatedEarsConfig('string')).toThrow('[parseAutomatedEarsConfig]');
    expect(() => parseAutomatedEarsConfig(42)).toThrow('[parseAutomatedEarsConfig]');
  });

  it('throws on invalid rss feed source', () => {
    const raw = {
      rss: {
        enabled: true,
        feeds: [{ name: 'Bad', url: 'https://example.com/rss', source: 'invalid_source' }],
      },
    };
    expect(() => parseAutomatedEarsConfig(raw)).toThrow('[parseAutomatedEarsConfig]');
  });

  it('throws on rss feed missing name', () => {
    const raw = {
      rss: {
        feeds: [{ url: 'https://example.com/rss', source: 'news_manual' }],
      },
    };
    expect(() => parseAutomatedEarsConfig(raw)).toThrow('[parseAutomatedEarsConfig]');
  });

  it('filters non-string keywords silently', () => {
    const cfg = parseAutomatedEarsConfig({ keywords: ['launch', 42, null, 'CA:'] });
    expect(cfg.keywords).toEqual(['launch', 'CA:']);
  });
});

// ── buildRssConnectorResult ───────────────────────────────────────────────────

describe('buildRssConnectorResult', () => {
  const launchFeedResult: FeedResult = {
    feed: { name: 'TestFeed', url: 'https://test.com/rss', source: 'news_manual' },
    items: [
      {
        title: '$GOOSE token launch on Raydium',
        description: 'CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU — live with liquidity',
      },
      { title: 'Market update: equities decline', description: 'Stocks fell today.' },
    ],
  };

  it('returns enabled, non-skipped connector', () => {
    const result = buildRssConnectorResult([launchFeedResult], ['launch', 'Raydium']);
    expect(result.name).toBe('rss');
    expect(result.enabled).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.source).toBe('news_manual');
  });

  it('counts itemsFetched as total raw items before filtering', () => {
    const result = buildRssConnectorResult([launchFeedResult], ['launch', 'Raydium', 'CA:']);
    expect(result.itemsFetched).toBe(2);
  });

  it('applies keyword filter — non-matching items excluded', () => {
    const result = buildRssConnectorResult([launchFeedResult], ['launch', 'Raydium', 'CA:']);
    // Market update item does not match launch/Raydium/CA:
    expect(result.items.some(i => i.text.toLowerCase().includes('equities'))).toBe(false);
  });

  it('applies quality filter — launch item passes', () => {
    const result = buildRssConnectorResult([launchFeedResult], ['launch', 'Raydium', 'CA:']);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.some(i => i.text.includes('GOOSE') || i.text.includes('launch'))).toBe(true);
  });

  it('returns zero items when keywords produce no matches', () => {
    const result = buildRssConnectorResult([launchFeedResult], ['unrelated', 'keyword']);
    expect(result.items).toHaveLength(0);
    expect(result.itemsFetched).toBe(2);
  });

  it('records error for errored feed without crashing', () => {
    const errorFeed: FeedResult = {
      feed: { name: 'BadFeed', url: 'https://bad.example.com/rss', source: 'news_manual' },
      items: [],
      error: 'Connection refused',
    };
    const result = buildRssConnectorResult([errorFeed], ['launch']);
    expect(result.error).toContain('BadFeed');
    expect(result.error).toContain('Connection refused');
    expect(result.items).toHaveLength(0);
  });

  it('aggregates items across multiple feeds', () => {
    const feed2: FeedResult = {
      feed: { name: 'Feed2', url: 'https://feed2.com/rss', source: 'news_manual' },
      items: [{ title: 'New meme coin launch on pump.fun — $MEME listed live', description: 'Liquidity added' }],
    };
    const result = buildRssConnectorResult([launchFeedResult, feed2], ['launch', 'Raydium', 'pump.fun', 'listed', 'meme', 'live']);
    expect(result.itemsFetched).toBe(3);
  });

  it('handles empty feedResults array', () => {
    const result = buildRssConnectorResult([], ['launch']);
    expect(result.itemsFetched).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});

// ── runXConnector ──────────────────────────────────────────────────────────────

describe('runXConnector', () => {
  const enabledCfg = { enabled: true, keywords: ['launch', 'CA:'], accounts: [], maxItems: 50 };
  const disabledCfg = { ...enabledCfg, enabled: false };

  it('skips with MISSING_X_BEARER_TOKEN when token is undefined', async () => {
    const result = await runXConnector(enabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('MISSING_X_BEARER_TOKEN');
    expect(result.enabled).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.itemsFetched).toBe(0);
  });

  it('skips with DISABLED when connector is disabled', async () => {
    const result = await runXConnector(disabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('DISABLED');
    expect(result.enabled).toBe(false);
  });

  it('disabled check takes priority over missing token', async () => {
    const result = await runXConnector(disabledCfg, 'some-token');
    expect(result.skipReason).toBe('DISABLED');
  });

  it('returns X_API_NOT_YET_IMPLEMENTED placeholder when token is present', async () => {
    const result = await runXConnector(enabledCfg, 'fake-bearer-token');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('X_API_NOT_YET_IMPLEMENTED');
    expect(result.items).toHaveLength(0);
  });
});

// ── runTelegramConnector ───────────────────────────────────────────────────────

describe('runTelegramConnector', () => {
  const enabledCfg = { enabled: true, chatIds: [], maxItems: 50 };
  const disabledCfg = { ...enabledCfg, enabled: false };

  it('skips with MISSING_TELEGRAM_BOT_TOKEN when token is undefined', async () => {
    const result = await runTelegramConnector(enabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('MISSING_TELEGRAM_BOT_TOKEN');
    expect(result.enabled).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('skips with DISABLED when connector is disabled', async () => {
    const result = await runTelegramConnector(disabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('DISABLED');
    expect(result.enabled).toBe(false);
  });

  it('disabled check takes priority over missing token', async () => {
    const result = await runTelegramConnector(disabledCfg, 'some-token');
    expect(result.skipReason).toBe('DISABLED');
  });
});

// ── runDiscordConnector ────────────────────────────────────────────────────────

describe('runDiscordConnector', () => {
  const enabledCfg = { enabled: true, channelIds: [], maxItems: 50 };
  const disabledCfg = { ...enabledCfg, enabled: false };

  it('skips with MISSING_DISCORD_BOT_TOKEN when token is undefined', async () => {
    const result = await runDiscordConnector(enabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('MISSING_DISCORD_BOT_TOKEN');
    expect(result.enabled).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('skips with DISABLED when connector is disabled', async () => {
    const result = await runDiscordConnector(disabledCfg, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('DISABLED');
    expect(result.enabled).toBe(false);
  });

  it('disabled check takes priority over missing token', async () => {
    const result = await runDiscordConnector(disabledCfg, 'some-token');
    expect(result.skipReason).toBe('DISABLED');
  });
});

// ── buildAutomatedEarsReport ───────────────────────────────────────────────────

describe('buildAutomatedEarsReport', () => {
  it('returns tradingExecuted: 0', () => {
    expect(makeReport().tradingExecuted).toBe(0);
  });

  it('returns noRealTradeSent: true', () => {
    expect(makeReport().noRealTradeSent).toBe(true);
  });

  it('passes through dryRun: true', () => {
    expect(makeReport({ dryRun: true }).dryRun).toBe(true);
  });

  it('passes through dryRun: false', () => {
    expect(makeReport({ dryRun: false }).dryRun).toBe(false);
  });

  it('includes suggestedHarnessCommand with --pre-signals and outputPath', () => {
    const report = makeReport({ outputPath: 'data/token-grab/x-ears/presignals.json' });
    expect(report.suggestedHarnessCommand).toContain('token:live-harness');
    expect(report.suggestedHarnessCommand).toContain('--pre-signals');
    expect(report.suggestedHarnessCommand).toContain('presignals.json');
    expect(report.suggestedHarnessCommand).toContain('--dry-run');
  });

  it('extracts signals from active connector results', () => {
    const connectorResults = [makeConnectorResult({ items: [LAUNCH_ITEM], itemsFetched: 1 })];
    const report = makeReport({ connectorResults });
    expect(report.signalsExtracted).toBeGreaterThan(0);
    expect(report.uniqueSignals.length).toBeGreaterThan(0);
  });

  it('skips disabled connectors — no signals extracted', () => {
    const connectorResults = [
      makeConnectorResult({ enabled: false, skipped: true, skipReason: 'DISABLED', items: [LAUNCH_ITEM], itemsFetched: 1 }),
    ];
    const report = makeReport({ connectorResults });
    expect(report.signalsExtracted).toBe(0);
    expect(report.uniqueSignals).toHaveLength(0);
    expect(report.connectors[0].signalsExtracted).toBe(0);
  });

  it('skips connectors with skipped=true — no signals extracted', () => {
    const connectorResults = [
      makeConnectorResult({ skipped: true, skipReason: 'MISSING_X_BEARER_TOKEN', source: 'x_manual', items: [], itemsFetched: 0 }),
    ];
    const report = makeReport({ connectorResults });
    expect(report.signalsExtracted).toBe(0);
  });

  it('deduplicates signals when same item appears in two connectors', () => {
    const connectorResults = [
      makeConnectorResult({ name: 'rss', source: 'news_manual', items: [LAUNCH_ITEM], itemsFetched: 1 }),
      makeConnectorResult({ name: 'telegram', source: 'telegram_manual', items: [LAUNCH_ITEM], itemsFetched: 1 }),
    ];
    const report = makeReport({ connectorResults });
    expect(report.signalsExtracted).toBe(2);
    expect(report.duplicatesSkipped).toBe(1);
    expect(report.uniqueSignals).toHaveLength(1);
  });

  it('deduplicates new signals against existing signals', () => {
    const connectorResults = [makeConnectorResult({ items: [LAUNCH_ITEM], itemsFetched: 1 })];
    const firstReport = makeReport({ connectorResults });
    const secondReport = makeReport({ connectorResults, existingSignals: firstReport.uniqueSignals });
    expect(secondReport.uniqueSignals).toHaveLength(0);
    expect(secondReport.duplicatesSkipped).toBe(firstReport.uniqueSignals.length);
  });

  it('preserves connector error in summary', () => {
    const connectorResults = [makeConnectorResult({ error: 'Network timeout', itemsFetched: 0 })];
    const report = makeReport({ connectorResults });
    expect(report.connectors[0].error).toBe('Network timeout');
  });

  it('produces bySource, bySignalType, byConfidence breakdowns when signals exist', () => {
    const connectorResults = [makeConnectorResult({ items: [LAUNCH_ITEM, MEME_ITEM], itemsFetched: 2 })];
    const report = makeReport({ connectorResults });
    if (report.uniqueSignals.length > 0) {
      expect(Object.keys(report.bySource).length).toBeGreaterThan(0);
      expect(Object.keys(report.bySignalType).length).toBeGreaterThan(0);
      expect(Object.keys(report.byConfidence).length).toBeGreaterThan(0);
    }
  });

  it('counts highConfidenceCount and contractCount for contract signal', () => {
    const connectorResults = [makeConnectorResult({ items: [LAUNCH_ITEM], itemsFetched: 1 })];
    const report = makeReport({ connectorResults });
    // LAUNCH_ITEM contains a real CA — should be high confidence
    if (report.uniqueSignals.length > 0) {
      expect(report.contractCount).toBeGreaterThan(0);
      expect(report.highConfidenceCount).toBeGreaterThan(0);
    }
  });

  it('sums totalItemsScanned from all connector itemsFetched', () => {
    const connectorResults = [
      makeConnectorResult({ name: 'rss', itemsFetched: 15, items: [] }),
      makeConnectorResult({ name: 'x', source: 'x_manual', skipped: true, skipReason: 'MISSING_X_BEARER_TOKEN', itemsFetched: 0, items: [] }),
    ];
    expect(makeReport({ connectorResults }).totalItemsScanned).toBe(15);
  });

  it('returns empty uniqueSignals when all connectors are skipped', () => {
    const connectorResults = [
      { name: 'x', source: 'x_manual' as const, enabled: true, skipped: true, skipReason: 'MISSING_X_BEARER_TOKEN', itemsFetched: 0, items: [] },
      { name: 'telegram', source: 'telegram_manual' as const, enabled: true, skipped: true, skipReason: 'MISSING_TELEGRAM_BOT_TOKEN', itemsFetched: 0, items: [] },
      { name: 'discord', source: 'discord_manual' as const, enabled: true, skipped: true, skipReason: 'MISSING_DISCORD_BOT_TOKEN', itemsFetched: 0, items: [] },
    ];
    const report = makeReport({ connectorResults });
    expect(report.uniqueSignals).toHaveLength(0);
    expect(report.signalsExtracted).toBe(0);
  });
});

// ── renderAutomatedEarsReport ─────────────────────────────────────────────────

describe('renderAutomatedEarsReport', () => {
  function makeFullReport(dryRun = false) {
    const connectorResults: ConnectorResult[] = [
      makeConnectorResult({ name: 'rss', itemsFetched: 10, items: [LAUNCH_ITEM] }),
      { name: 'x', source: 'x_manual', enabled: true, skipped: true, skipReason: 'MISSING_X_BEARER_TOKEN', itemsFetched: 0, items: [] },
      { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: true, skipReason: 'MISSING_TELEGRAM_BOT_TOKEN', itemsFetched: 0, items: [] },
      { name: 'discord', source: 'discord_manual', enabled: true, skipped: true, skipReason: 'MISSING_DISCORD_BOT_TOKEN', itemsFetched: 0, items: [] },
    ];
    return buildAutomatedEarsReport({
      connectorResults,
      existingSignals: [],
      generatedAt: '2026-06-06T00:00:00.000Z',
      dryRun,
      outputPath: 'data/token-grab/x-ears/presignals.json',
    });
  }

  it('contains NO REAL TRADE SENT', () => {
    expect(renderAutomatedEarsReport(makeFullReport())).toContain('NO REAL TRADE SENT');
  });

  it('contains tradingExecuted: 0', () => {
    expect(renderAutomatedEarsReport(makeFullReport())).toContain('tradingExecuted: 0');
  });

  it('shows [DRY RUN] when dryRun=true', () => {
    expect(renderAutomatedEarsReport(makeFullReport(true))).toContain('DRY RUN');
  });

  it('does not show DRY RUN when dryRun=false', () => {
    expect(renderAutomatedEarsReport(makeFullReport(false))).not.toContain('DRY RUN');
  });

  it('shows SKIP and skip reasons for skipped connectors', () => {
    const rendered = renderAutomatedEarsReport(makeFullReport());
    expect(rendered).toContain('MISSING_X_BEARER_TOKEN');
    expect(rendered).toContain('MISSING_TELEGRAM_BOT_TOKEN');
    expect(rendered).toContain('MISSING_DISCORD_BOT_TOKEN');
  });

  it('shows all connector names', () => {
    const rendered = renderAutomatedEarsReport(makeFullReport());
    expect(rendered).toContain('rss');
    expect(rendered).toContain('telegram');
    expect(rendered).toContain('discord');
  });

  it('shows the suggested harness command', () => {
    const rendered = renderAutomatedEarsReport(makeFullReport());
    expect(rendered).toContain('token:live-harness');
    expect(rendered).toContain('--pre-signals');
    expect(rendered).toContain('presignals.json');
  });

  it('shows Written: 0 in dry-run mode', () => {
    const rendered = renderAutomatedEarsReport(makeFullReport(true));
    expect(rendered).toContain('Written          : 0');
  });

  it('does not contain LIVE_EXECUTED', () => {
    expect(renderAutomatedEarsReport(makeFullReport())).not.toContain('LIVE_EXECUTED');
  });

  it('does not contain privateKey, signTransaction, or sendTransaction', () => {
    const rendered = renderAutomatedEarsReport(makeFullReport());
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });

  it('shows token:auto-paper was NOT run', () => {
    expect(renderAutomatedEarsReport(makeFullReport())).toContain('token:auto-paper was NOT run');
  });
});
