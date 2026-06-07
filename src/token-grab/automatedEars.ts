import fs from 'node:fs';
import type { PreSignal, PreSignalSource } from './xEarsPreSignal';
import { buildPreSignalsFromItems, deduplicateSignals } from './earsCollector';
import type { InputItem } from './earsCollector';
import {
  filterByKeywords,
  passesQualityFilter,
  feedItemToInputItem,
  type RssFeedConfig,
  type FeedResult,
} from './rssEarsAdapter';

// ── Config types ───────────────────────────────────────────────────────────────

export interface AutomatedEarsRssConfig {
  enabled: boolean;
  feeds: RssFeedConfig[];
  maxItemsPerFeed: number;
}

export interface AutomatedEarsXConfig {
  enabled: boolean;
  keywords: string[];
  accounts: string[];
  maxItems: number;
}

export interface AutomatedEarsTelegramConfig {
  enabled: boolean;
  chatIds: string[];
  maxItems: number;
}

export interface AutomatedEarsDiscordConfig {
  enabled: boolean;
  channelIds: string[];
  maxItems: number;
}

export interface AutomatedEarsConfig {
  keywords: string[];
  rss: AutomatedEarsRssConfig;
  x: AutomatedEarsXConfig;
  telegram: AutomatedEarsTelegramConfig;
  discord: AutomatedEarsDiscordConfig;
}

// ── Connector types ────────────────────────────────────────────────────────────

export interface ConnectorResult {
  name: string;
  source: PreSignalSource;
  enabled: boolean;
  skipped: boolean;
  skipReason?: string;
  itemsFetched: number;
  items: InputItem[];
  error?: string;
}

export interface ConnectorSummary {
  name: string;
  enabled: boolean;
  skipped: boolean;
  skipReason?: string;
  itemsFetched: number;
  signalsExtracted: number;
  error?: string;
}

// ── Report types ───────────────────────────────────────────────────────────────

export interface AutomatedEarsInput {
  connectorResults: ConnectorResult[];
  existingSignals: PreSignal[];
  generatedAt: string;
  dryRun: boolean;
  outputPath: string;
}

export interface AutomatedEarsReport {
  outputPath: string;
  connectors: ConnectorSummary[];
  totalItemsScanned: number;
  signalsExtracted: number;
  duplicatesSkipped: number;
  uniqueSignals: PreSignal[];
  bySource: Record<string, number>;
  bySignalType: Record<string, number>;
  byConfidence: Record<string, number>;
  highConfidenceCount: number;
  contractCount: number;
  tickerCount: number;
  dryRun: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
  suggestedHarnessCommand: string;
}

// ── Valid sources ──────────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<string>([
  'x_manual', 'x_api_future', 'news_manual',
  'telegram_manual', 'discord_manual', 'other',
]);

// ── Config parser — pure ───────────────────────────────────────────────────────

export function parseAutomatedEarsConfig(raw: unknown): AutomatedEarsConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('[parseAutomatedEarsConfig] Expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const keywords: string[] = Array.isArray(obj['keywords'])
    ? (obj['keywords'] as unknown[]).filter(k => typeof k === 'string') as string[]
    : [];

  // RSS
  const rssRaw = typeof obj['rss'] === 'object' && obj['rss'] !== null
    ? (obj['rss'] as Record<string, unknown>)
    : {} as Record<string, unknown>;
  const rssEnabled = typeof rssRaw['enabled'] === 'boolean' ? rssRaw['enabled'] : false;
  const rssMaxItems = typeof rssRaw['maxItemsPerFeed'] === 'number'
    ? Math.max(1, rssRaw['maxItemsPerFeed'])
    : 20;
  const rssFeedsRaw = Array.isArray(rssRaw['feeds']) ? (rssRaw['feeds'] as unknown[]) : [];
  const rssFeeds: RssFeedConfig[] = rssFeedsRaw.map((f, i) => {
    if (typeof f !== 'object' || f === null) {
      throw new Error(`[parseAutomatedEarsConfig] rss.feeds[${i}] must be an object`);
    }
    const feed = f as Record<string, unknown>;
    if (typeof feed['name'] !== 'string') {
      throw new Error(`[parseAutomatedEarsConfig] rss.feeds[${i}].name must be a string`);
    }
    if (typeof feed['url'] !== 'string') {
      throw new Error(`[parseAutomatedEarsConfig] rss.feeds[${i}].url must be a string`);
    }
    const src = typeof feed['source'] === 'string' ? feed['source'] : 'news_manual';
    if (!VALID_SOURCES.has(src)) {
      throw new Error(`[parseAutomatedEarsConfig] rss.feeds[${i}].source "${src}" is not a valid source`);
    }
    return { name: feed['name'], url: feed['url'], source: src as PreSignalSource };
  });

  // X
  const xRaw = typeof obj['x'] === 'object' && obj['x'] !== null
    ? (obj['x'] as Record<string, unknown>)
    : {} as Record<string, unknown>;
  const xEnabled = typeof xRaw['enabled'] === 'boolean' ? xRaw['enabled'] : false;
  const xKeywords: string[] = Array.isArray(xRaw['keywords'])
    ? (xRaw['keywords'] as unknown[]).filter(k => typeof k === 'string') as string[]
    : [];
  const xAccounts: string[] = Array.isArray(xRaw['accounts'])
    ? (xRaw['accounts'] as unknown[]).filter(a => typeof a === 'string') as string[]
    : [];
  const xMaxItems = typeof xRaw['maxItems'] === 'number' ? Math.max(1, xRaw['maxItems']) : 50;

  // Telegram
  const tgRaw = typeof obj['telegram'] === 'object' && obj['telegram'] !== null
    ? (obj['telegram'] as Record<string, unknown>)
    : {} as Record<string, unknown>;
  const tgEnabled = typeof tgRaw['enabled'] === 'boolean' ? tgRaw['enabled'] : false;
  const tgChatIds: string[] = Array.isArray(tgRaw['chatIds'])
    ? (tgRaw['chatIds'] as unknown[]).filter(id => typeof id === 'string') as string[]
    : [];
  const tgMaxItems = typeof tgRaw['maxItems'] === 'number' ? Math.max(1, tgRaw['maxItems']) : 50;

  // Discord
  const dcRaw = typeof obj['discord'] === 'object' && obj['discord'] !== null
    ? (obj['discord'] as Record<string, unknown>)
    : {} as Record<string, unknown>;
  const dcEnabled = typeof dcRaw['enabled'] === 'boolean' ? dcRaw['enabled'] : false;
  const dcChannelIds: string[] = Array.isArray(dcRaw['channelIds'])
    ? (dcRaw['channelIds'] as unknown[]).filter(id => typeof id === 'string') as string[]
    : [];
  const dcMaxItems = typeof dcRaw['maxItems'] === 'number' ? Math.max(1, dcRaw['maxItems']) : 50;

  return {
    keywords,
    rss: { enabled: rssEnabled, feeds: rssFeeds, maxItemsPerFeed: rssMaxItems },
    x: { enabled: xEnabled, keywords: xKeywords, accounts: xAccounts, maxItems: xMaxItems },
    telegram: { enabled: tgEnabled, chatIds: tgChatIds, maxItems: tgMaxItems },
    discord: { enabled: dcEnabled, channelIds: dcChannelIds, maxItems: dcMaxItems },
  };
}

// ── Config loader — I/O ────────────────────────────────────────────────────────

export function loadAutomatedEarsConfig(configPath: string): AutomatedEarsConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  return parseAutomatedEarsConfig(raw);
}

// ── RSS connector helper — pure ────────────────────────────────────────────────

export function buildRssConnectorResult(
  feedResults: FeedResult[],
  keywords: string[],
): ConnectorResult {
  let totalItems = 0;
  const items: InputItem[] = [];
  const errors: string[] = [];

  for (const result of feedResults) {
    totalItems += result.items.length;
    if (result.error) {
      errors.push(`${result.feed.name}: ${result.error}`);
      continue;
    }
    const matched = filterByKeywords(result.items, keywords);
    for (const item of matched) {
      const qf = passesQualityFilter(item);
      if (qf.passed) {
        items.push(feedItemToInputItem(item));
      }
    }
  }

  return {
    name: 'rss',
    source: 'news_manual',
    enabled: true,
    skipped: false,
    itemsFetched: totalItems,
    items,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

// ── X connector — async I/O ────────────────────────────────────────────────────

export async function runXConnector(
  config: AutomatedEarsXConfig,
  bearerToken: string | undefined,
): Promise<ConnectorResult> {
  if (!config.enabled) {
    return { name: 'x', source: 'x_manual', enabled: false, skipped: true, skipReason: 'DISABLED', itemsFetched: 0, items: [] };
  }
  if (!bearerToken) {
    return { name: 'x', source: 'x_manual', enabled: true, skipped: true, skipReason: 'MISSING_X_BEARER_TOKEN', itemsFetched: 0, items: [] };
  }
  // V1 placeholder: bearer token present but X API search not yet implemented.
  // Real path: GET https://api.twitter.com/2/tweets/search/recent
  return { name: 'x', source: 'x_manual', enabled: true, skipped: true, skipReason: 'X_API_NOT_YET_IMPLEMENTED', itemsFetched: 0, items: [] };
}

// ── Telegram connector — async I/O ────────────────────────────────────────────

export async function runTelegramConnector(
  config: AutomatedEarsTelegramConfig,
  botToken: string | undefined,
): Promise<ConnectorResult> {
  if (!config.enabled) {
    return { name: 'telegram', source: 'telegram_manual', enabled: false, skipped: true, skipReason: 'DISABLED', itemsFetched: 0, items: [] };
  }
  if (!botToken) {
    return { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: true, skipReason: 'MISSING_TELEGRAM_BOT_TOKEN', itemsFetched: 0, items: [] };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?limit=${config.maxItems}&allowed_updates=%5B%22message%22%5D`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: false, itemsFetched: 0, items: [], error: `HTTP ${resp.status}` };
    }
    const data = await resp.json() as {
      ok: boolean;
      result?: { message?: { text?: string; chat?: { id: number } } }[];
    };
    if (!data.ok) {
      return { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: false, itemsFetched: 0, items: [], error: 'Telegram API returned ok:false' };
    }
    const updates = data.result ?? [];
    const items: InputItem[] = [];
    for (const update of updates) {
      const msg = update.message;
      if (!msg?.text) continue;
      if (config.chatIds.length > 0 && !config.chatIds.includes(String(msg.chat?.id))) continue;
      items.push({ text: msg.text });
    }
    return { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: false, itemsFetched: items.length, items };
  } catch (e) {
    return { name: 'telegram', source: 'telegram_manual', enabled: true, skipped: false, itemsFetched: 0, items: [], error: (e as Error).message };
  }
}

// ── Discord connector — async I/O ─────────────────────────────────────────────

export async function runDiscordConnector(
  config: AutomatedEarsDiscordConfig,
  botToken: string | undefined,
): Promise<ConnectorResult> {
  if (!config.enabled) {
    return { name: 'discord', source: 'discord_manual', enabled: false, skipped: true, skipReason: 'DISABLED', itemsFetched: 0, items: [] };
  }
  if (!botToken) {
    return { name: 'discord', source: 'discord_manual', enabled: true, skipped: true, skipReason: 'MISSING_DISCORD_BOT_TOKEN', itemsFetched: 0, items: [] };
  }

  try {
    const items: InputItem[] = [];
    for (const channelId of config.channelIds) {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${config.maxItems}`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (!resp.ok) continue;
      const messages = await resp.json() as { content: string }[];
      for (const msg of messages) {
        if (msg.content) items.push({ text: msg.content });
      }
    }
    return { name: 'discord', source: 'discord_manual', enabled: true, skipped: false, itemsFetched: items.length, items };
  } catch (e) {
    return { name: 'discord', source: 'discord_manual', enabled: true, skipped: false, itemsFetched: 0, items: [], error: (e as Error).message };
  }
}

// ── Report builder — pure ─────────────────────────────────────────────────────

export function buildAutomatedEarsReport(input: AutomatedEarsInput): AutomatedEarsReport {
  const allFresh: PreSignal[] = [];
  const connectorSummaries: ConnectorSummary[] = [];

  for (const connector of input.connectorResults) {
    if (!connector.enabled || connector.skipped) {
      connectorSummaries.push({
        name: connector.name,
        enabled: connector.enabled,
        skipped: connector.skipped,
        skipReason: connector.skipReason,
        itemsFetched: connector.itemsFetched,
        signalsExtracted: 0,
        error: connector.error,
      });
      continue;
    }

    const signals = connector.items.length > 0
      ? buildPreSignalsFromItems(connector.items, connector.source, input.generatedAt)
      : [];
    allFresh.push(...signals);

    connectorSummaries.push({
      name: connector.name,
      enabled: true,
      skipped: false,
      itemsFetched: connector.itemsFetched,
      signalsExtracted: signals.length,
      error: connector.error,
    });
  }

  const { unique, duplicateCount } = deduplicateSignals(allFresh, input.existingSignals);

  const bySource: Record<string, number> = {};
  const bySignalType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  let highConfidenceCount = 0;
  let contractCount = 0;
  let tickerCount = 0;

  for (const sig of unique) {
    bySource[sig.source] = (bySource[sig.source] ?? 0) + 1;
    bySignalType[sig.signalType] = (bySignalType[sig.signalType] ?? 0) + 1;
    byConfidence[sig.confidence] = (byConfidence[sig.confidence] ?? 0) + 1;
    if (sig.confidence === 'high') highConfidenceCount++;
    if (sig.contract) contractCount++;
    if (sig.symbol) tickerCount++;
  }

  return {
    outputPath: input.outputPath,
    connectors: connectorSummaries,
    totalItemsScanned: input.connectorResults.reduce((sum, c) => sum + c.itemsFetched, 0),
    signalsExtracted: allFresh.length,
    duplicatesSkipped: duplicateCount,
    uniqueSignals: unique,
    bySource,
    bySignalType,
    byConfidence,
    highConfidenceCount,
    contractCount,
    tickerCount,
    dryRun: input.dryRun,
    tradingExecuted: 0,
    noRealTradeSent: true,
    suggestedHarnessCommand:
      `npm run token:live-harness -- --fake-bankroll 20 --max-live-position 1` +
      ` --watch-minutes 10 --gecko-limit 20 --delay-ms 5000 --dry-run --watch-cycle` +
      ` --confirm-entry --confirm-minutes 2 --paper-exit-guard` +
      ` --paper-exit-interval-seconds 60 --pre-signals ${input.outputPath}`,
  };
}

// ── Render — pure ─────────────────────────────────────────────────────────────

export function renderAutomatedEarsReport(report: AutomatedEarsReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push(
    '  TOKEN GRAB AUTOMATED EARS V1' +
      (report.dryRun ? ' [DRY RUN — no file written]' : ''),
  );
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Output           : ${report.outputPath}`);
  lines.push(`  Items scanned    : ${report.totalItemsScanned}`);
  lines.push(`  Signals extracted: ${report.signalsExtracted}`);
  lines.push(`  Duplicates       : ${report.duplicatesSkipped}`);
  lines.push(`  Written          : ${report.dryRun ? 0 : report.uniqueSignals.length}`);
  lines.push(`  High confidence  : ${report.highConfidenceCount}`);
  lines.push(`  Contracts        : ${report.contractCount}`);
  lines.push(`  Tickers          : ${report.tickerCount}`);
  lines.push('');
  lines.push(THIN);
  lines.push('  Connectors:');
  for (const c of report.connectors) {
    if (!c.enabled) {
      lines.push(`    ${c.name.padEnd(12)} disabled`);
    } else if (c.skipped) {
      lines.push(`    ${c.name.padEnd(12)} SKIP  ${c.skipReason ?? ''}`);
    } else if (c.error) {
      lines.push(`    ${c.name.padEnd(12)} ERROR ${c.error}  items: ${c.itemsFetched}  signals: ${c.signalsExtracted}`);
    } else {
      lines.push(`    ${c.name.padEnd(12)} ok    items: ${c.itemsFetched}  signals: ${c.signalsExtracted}`);
    }
  }
  lines.push('');

  if (Object.keys(report.bySource).length > 0) {
    lines.push(THIN);
    lines.push('  By source:');
    for (const [src, count] of Object.entries(report.bySource)) {
      lines.push(`    ${src}: ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(report.bySignalType).length > 0) {
    lines.push(THIN);
    lines.push('  By signal type:');
    for (const [type, count] of Object.entries(report.bySignalType)) {
      lines.push(`    ${type}: ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(report.byConfidence).length > 0) {
    lines.push(THIN);
    lines.push('  By confidence:');
    for (const [conf, count] of Object.entries(report.byConfidence)) {
      lines.push(`    ${conf}: ${count}`);
    }
    lines.push('');
  }

  lines.push(THIN);
  lines.push('  Run harness:');
  lines.push(`  ${report.suggestedHarnessCommand}`);
  lines.push('');
  lines.push(WIDE);
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  No wallet-key loading, swap execution, signing, or live-intent');
  lines.push(WIDE);

  return lines.join('\n');
}
