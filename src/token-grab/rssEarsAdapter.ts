import fs from 'node:fs';
import type { PreSignal, PreSignalSource } from './xEarsPreSignal';
import { buildPreSignalsFromItems, deduplicateSignals } from './earsCollector';
import type { InputItem } from './earsCollector';

// ── Config types ──────────────────────────────────────────────────────────────

export interface RssFeedConfig {
  name: string;
  url: string;
  source: PreSignalSource;
}

export interface RssConfig {
  feeds: RssFeedConfig[];
  keywords: string[];
  maxItemsPerFeed: number;
}

// ── Feed item ─────────────────────────────────────────────────────────────────

export interface RssFeedItem {
  title: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

// ── Report types ──────────────────────────────────────────────────────────────

export interface FeedResult {
  feed: RssFeedConfig;
  items: RssFeedItem[];
  error?: string;
}

export interface RssAdapterInput {
  feedResults: FeedResult[];
  existingSignals: PreSignal[];
  config: RssConfig;
  generatedAt: string;
  dryRun: boolean;
  outputPath: string;
}

export interface RssAdapterReport {
  outputPath: string;
  feedsChecked: number;
  feedErrors: number;
  itemsScanned: number;
  keywordMatches: number;
  qualityPassed: number;
  qualityRejected: number;
  rejectedReasonCounts: Record<string, number>;
  signalsExtracted: number;
  duplicatesSkipped: number;
  uniqueSignals: PreSignal[];
  dryRun: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Config parser — pure ──────────────────────────────────────────────────────

const RSS_CONFIG_DEFAULTS: Pick<RssConfig, 'keywords' | 'maxItemsPerFeed'> = {
  keywords: [],
  maxItemsPerFeed: 20,
};

const VALID_SOURCES = new Set<string>([
  'x_manual', 'x_api_future', 'news_manual',
  'telegram_manual', 'discord_manual', 'other',
]);

export function parseRssConfig(raw: unknown): RssConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('[parseRssConfig] Expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const feeds: RssFeedConfig[] = [];
  if (Array.isArray(obj['feeds'])) {
    for (const f of obj['feeds'] as unknown[]) {
      if (typeof f !== 'object' || f === null) continue;
      const fobj = f as Record<string, unknown>;
      if (typeof fobj['name'] !== 'string' || typeof fobj['url'] !== 'string') continue;
      const src = typeof fobj['source'] === 'string' && VALID_SOURCES.has(fobj['source'])
        ? (fobj['source'] as PreSignalSource)
        : 'news_manual';
      feeds.push({ name: fobj['name'], url: fobj['url'], source: src });
    }
  }

  return {
    feeds,
    keywords: Array.isArray(obj['keywords'])
      ? (obj['keywords'] as unknown[]).filter(k => typeof k === 'string') as string[]
      : RSS_CONFIG_DEFAULTS.keywords,
    maxItemsPerFeed:
      typeof obj['maxItemsPerFeed'] === 'number' && obj['maxItemsPerFeed'] > 0
        ? obj['maxItemsPerFeed']
        : RSS_CONFIG_DEFAULTS.maxItemsPerFeed,
  };
}

// ── Quality filter — pure ─────────────────────────────────────────────────────

// An RSS item must have at least one of:
// 1. Contract/CA address
// 2. $TICKER symbol
// 3. Strong launch terms
// 4. Meme/trending terms AND token/coin language

const QF_CONTRACT_RE =
  /(?:CA:|contract(?:\s+address)?:|address:|addr:)\s*[1-9A-HJ-NP-Za-km-z]{32,44}|\b[1-9A-HJ-NP-Za-km-z]{40,44}\b/i;
const QF_TICKER_RE = /\$[A-Za-z]{2,10}\b/;
const QF_LAUNCH_RE =
  /\b(?:launch(?:ed|ing)?|deploy(?:ing|ed)?|raydium|pump\.?fun|pumpfun|liquidity|pair(?:ing|ed)?|listed|listing|live)\b/i;
const QF_MEME_RE = /\b(?:meme|viral|trending|moonshot)\b/i;
const QF_TOKEN_RE = /\b(?:token|coin|memecoin|ticker|altcoin)\b/i;

export interface QualityFilterResult {
  passed: boolean;
  reason?: string;
}

/**
 * Returns true only when the RSS item contains real launch/token evidence. Pure.
 */
export function passesQualityFilter(item: RssFeedItem): QualityFilterResult {
  const text = [item.title, item.description ?? ''].join(' ');
  if (QF_CONTRACT_RE.test(text)) return { passed: true };
  if (QF_TICKER_RE.test(text)) return { passed: true };
  if (QF_LAUNCH_RE.test(text)) return { passed: true };
  if (QF_MEME_RE.test(text) && QF_TOKEN_RE.test(text)) return { passed: true };
  if (QF_MEME_RE.test(text)) return { passed: false, reason: 'meme_without_token_language' };
  return { passed: false, reason: 'no_quality_signal' };
}

export function loadRssConfig(filePath: string): RssConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`[loadRssConfig] Cannot read: ${filePath} — ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[loadRssConfig] Invalid JSON in: ${filePath} — ${(e as Error).message}`);
  }
  return parseRssConfig(parsed);
}

// ── RSS XML parser — pure ─────────────────────────────────────────────────────

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function extractText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m?.[1]) return undefined;
  return stripCdata(m[1]).trim() || undefined;
}

function extractLink(block: string): string | undefined {
  // Prefer href="..." (Atom-style)
  const hrefMatch = block.match(/<link[^>]+href="([^"]+)"/i);
  if (hrefMatch?.[1]) return hrefMatch[1].trim();
  // Fall back to text content
  const textMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
  return textMatch?.[1]?.trim() || undefined;
}

/**
 * Parses RSS/Atom XML into feed items. Pure — no I/O.
 */
export function parseRssXml(xml: string, maxItems: number): RssFeedItem[] {
  const items: RssFeedItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    if (items.length >= maxItems) break;
    const block = m[1];
    const title = extractText(block, 'title');
    if (!title) continue;
    const description = extractText(block, 'description');
    const link = extractLink(block);
    const pubDateRaw = extractText(block, 'pubDate') ?? extractText(block, 'published');
    let pubDate: string | undefined;
    if (pubDateRaw) {
      try {
        pubDate = new Date(pubDateRaw).toISOString();
      } catch {
        pubDate = undefined;
      }
    }
    items.push({ title, link, description, pubDate });
  }
  return items;
}

// ── Converters — pure ─────────────────────────────────────────────────────────

/**
 * Converts an RSS feed item to an ears-collector InputItem. Pure.
 */
export function feedItemToInputItem(item: RssFeedItem): InputItem {
  const parts = [item.title];
  if (item.description) {
    const snippet = item.description.replace(/<[^>]+>/g, '').slice(0, 300).trim();
    if (snippet) parts.push(snippet);
  }
  return {
    text: parts.join(' — ').slice(0, 500),
    url: item.link,
    seenAt: item.pubDate,
  };
}

/**
 * Filters feed items to those containing at least one keyword. Case-insensitive. Pure.
 */
export function filterByKeywords(items: RssFeedItem[], keywords: string[]): RssFeedItem[] {
  if (keywords.length === 0) return items;
  const lower = keywords.map(k => k.toLowerCase());
  return items.filter(item => {
    const haystack = [item.title, item.description ?? ''].join(' ').toLowerCase();
    return lower.some(kw => haystack.includes(kw));
  });
}

// ── Fetch — I/O ───────────────────────────────────────────────────────────────

/**
 * Fetches one RSS feed URL and parses items. Requires Node 18+ fetch.
 */
export async function fetchFeedItems(
  feed: RssFeedConfig,
  maxItems: number,
): Promise<{ items: RssFeedItem[]; error?: string }> {
  try {
    const resp = await fetch(feed.url, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!resp.ok) return { items: [], error: `HTTP ${resp.status}` };
    const xml = await resp.text();
    return { items: parseRssXml(xml, maxItems) };
  } catch (e) {
    return { items: [], error: (e as Error).message ?? 'fetch error' };
  }
}

// ── Report builder — pure ─────────────────────────────────────────────────────

/**
 * Builds the RSS adapter report from pre-fetched feed results. Pure — no I/O.
 */
export function buildRssAdapterReport(input: RssAdapterInput): RssAdapterReport {
  let totalItemsScanned = 0;
  let totalKeywordMatches = 0;
  let qualityPassed = 0;
  let qualityRejected = 0;
  let feedErrors = 0;
  const rejectedReasonCounts: Record<string, number> = {};

  // Collect quality-passing items grouped by source
  const bySource = new Map<PreSignalSource, InputItem[]>();

  for (const result of input.feedResults) {
    if (result.error) feedErrors++;
    totalItemsScanned += result.items.length;

    const matched = filterByKeywords(result.items, input.config.keywords);
    totalKeywordMatches += matched.length;

    for (const item of matched) {
      const qf = passesQualityFilter(item);
      if (qf.passed) {
        qualityPassed++;
        const inputItem = feedItemToInputItem(item);
        const bucket = bySource.get(result.feed.source) ?? [];
        bucket.push(inputItem);
        bySource.set(result.feed.source, bucket);
      } else {
        qualityRejected++;
        const reason = qf.reason ?? 'no_quality_signal';
        rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] ?? 0) + 1;
      }
    }
  }

  // Build signals per source, then dedup
  const allFresh: PreSignal[] = [];
  for (const [source, items] of bySource) {
    allFresh.push(...buildPreSignalsFromItems(items, source, input.generatedAt));
  }

  const { unique, duplicateCount } = deduplicateSignals(allFresh, input.existingSignals);

  return {
    outputPath: input.outputPath,
    feedsChecked: input.feedResults.length,
    feedErrors,
    itemsScanned: totalItemsScanned,
    keywordMatches: totalKeywordMatches,
    qualityPassed,
    qualityRejected,
    rejectedReasonCounts,
    signalsExtracted: allFresh.length,
    duplicatesSkipped: duplicateCount,
    uniqueSignals: unique,
    dryRun: input.dryRun,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Render — pure ─────────────────────────────────────────────────────────────

export function renderRssAdapterReport(report: RssAdapterReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push(
    '  TOKEN GRAB RSS/NEWS EARS ADAPTER V1' +
      (report.dryRun ? ' [DRY RUN — no file written]' : ''),
  );
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Output          : ${report.outputPath}`);
  lines.push(`  Feeds checked   : ${report.feedsChecked}`);
  lines.push(`  Feed errors     : ${report.feedErrors}`);
  lines.push(`  Items scanned   : ${report.itemsScanned}`);
  lines.push(`  Keyword matches : ${report.keywordMatches}`);
  lines.push(`  Quality passed  : ${report.qualityPassed}`);
  lines.push(`  Quality rejected: ${report.qualityRejected}`);
  if (report.qualityRejected > 0) {
    for (const [reason, count] of Object.entries(report.rejectedReasonCounts)) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  lines.push(`  Signals found   : ${report.signalsExtracted}`);
  lines.push(`  Duplicates      : ${report.duplicatesSkipped}`);
  lines.push(`  Written         : ${report.dryRun ? 0 : report.uniqueSignals.length}`);
  lines.push('');

  if (report.feedErrors > 0) {
    lines.push(THIN);
    lines.push(`  ${report.feedErrors} feed(s) returned errors — check URLs and network access`);
    lines.push('');
  }

  lines.push(WIDE);
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  No wallet-key loading, swap execution, signing, or live-intent');
  lines.push(WIDE);

  return lines.join('\n');
}
