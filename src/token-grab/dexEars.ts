import fs from 'node:fs';
import type { PreSignal, PreSignalSource, PreSignalType } from './xEarsPreSignal';
import { normalizeSymbol } from './xEarsPreSignal';
import { simpleHash, deduplicateSignals } from './earsCollector';

// ── Endpoint names ────────────────────────────────────────────────────────────

export type DexEndpoint = 'latest_profiles' | 'latest_boosts' | 'top_boosts';

// ── Config types ───────────────────────────────────────────────────────────────

export interface DexEarsConfig {
  chain: string;
  minConfidence: 'low' | 'medium' | 'high';
  maxItemsPerEndpoint: number;
  timeoutMs: number;
  endpoints: {
    latestProfiles: boolean;
    latestBoosts: boolean;
    topBoosts: boolean;
  };
}

// ── API response types ─────────────────────────────────────────────────────────

export interface DexScreenerProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  header?: string;
  description?: string;
  links?: { type: string; label?: string; url: string }[];
}

export interface DexScreenerBoost extends DexScreenerProfile {
  amount?: number;
  totalAmount?: number;
}

// ── Candidate (internal aggregation) ─────────────────────────────────────────

export interface DexEarsCandidate {
  chainId: string;
  tokenAddress: string;
  name?: string;
  description?: string;
  url: string;
  foundIn: Set<DexEndpoint>;
  hasProfile: boolean;
  hasBoost: boolean;
  hasCto: boolean;
  totalBoostAmount: number;
}

// ── Endpoint result ────────────────────────────────────────────────────────────

export interface DexEndpointResult {
  endpoint: DexEndpoint;
  fetched: number;
  items: DexScreenerProfile[];
  error?: string;
}

// ── Report types ───────────────────────────────────────────────────────────────

export interface DexEarsInput {
  endpointResults: DexEndpointResult[];
  existingSignals: PreSignal[];
  generatedAt: string;
  chain: string;
  minConfidence: 'low' | 'medium' | 'high';
  dryRun: boolean;
  outputPath: string;
}

export interface DexEndpointSummary {
  endpoint: DexEndpoint;
  fetched: number;
  error?: string;
}

export interface DexEarsReport {
  outputPath: string;
  chain: string;
  minConfidence: string;
  endpointsSummary: DexEndpointSummary[];
  candidatesFound: number;
  signalsExtracted: number;
  duplicatesSkipped: number;
  uniqueSignals: PreSignal[];
  byConfidence: Record<string, number>;
  highConfidenceCount: number;
  contractCount: number;
  dryRun: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
  suggestedHarnessCommand: string;
}

// ── Confidence ordering ────────────────────────────────────────────────────────

export const CONF_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

// ── Config parser — pure ───────────────────────────────────────────────────────

export function parseDexEarsConfig(raw: unknown): DexEarsConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('[parseDexEarsConfig] Expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const chain = typeof obj['chain'] === 'string' ? obj['chain'] : 'solana';
  const rawConf = typeof obj['minConfidence'] === 'string' ? obj['minConfidence'] : 'medium';
  const minConfidence = (['low', 'medium', 'high'] as const).includes(rawConf as 'low' | 'medium' | 'high')
    ? (rawConf as 'low' | 'medium' | 'high')
    : 'medium';
  const maxItemsPerEndpoint = typeof obj['maxItemsPerEndpoint'] === 'number'
    ? Math.max(1, obj['maxItemsPerEndpoint'])
    : 50;
  const timeoutMs = typeof obj['timeoutMs'] === 'number'
    ? Math.max(1000, obj['timeoutMs'])
    : 10_000;

  const endpointsRaw = typeof obj['endpoints'] === 'object' && obj['endpoints'] !== null
    ? (obj['endpoints'] as Record<string, unknown>)
    : {} as Record<string, unknown>;

  return {
    chain,
    minConfidence,
    maxItemsPerEndpoint,
    timeoutMs,
    endpoints: {
      latestProfiles: typeof endpointsRaw['latestProfiles'] === 'boolean' ? endpointsRaw['latestProfiles'] : true,
      latestBoosts: typeof endpointsRaw['latestBoosts'] === 'boolean' ? endpointsRaw['latestBoosts'] : true,
      topBoosts: typeof endpointsRaw['topBoosts'] === 'boolean' ? endpointsRaw['topBoosts'] : true,
    },
  };
}

// ── Config loader — I/O ────────────────────────────────────────────────────────

export function loadDexEarsConfig(configPath: string): DexEarsConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  return parseDexEarsConfig(raw);
}

// ── API response parsers — pure ────────────────────────────────────────────────

function parseDexScreenerItem(item: unknown): DexScreenerProfile | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj['chainId'] !== 'string' || typeof obj['tokenAddress'] !== 'string') return null;
  if (!obj['chainId'] || !obj['tokenAddress']) return null;
  return {
    url: typeof obj['url'] === 'string'
      ? obj['url']
      : `https://dexscreener.com/${obj['chainId']}/${obj['tokenAddress']}`,
    chainId: obj['chainId'],
    tokenAddress: obj['tokenAddress'],
    header: typeof obj['header'] === 'string' ? obj['header'] : undefined,
    description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
    links: Array.isArray(obj['links'])
      ? (obj['links'] as { type: string; label?: string; url: string }[])
      : undefined,
  };
}

export function parseProfilesResponse(raw: unknown): DexScreenerProfile[] {
  if (!Array.isArray(raw)) return [];
  const items: DexScreenerProfile[] = [];
  for (const item of raw) {
    const parsed = parseDexScreenerItem(item);
    if (parsed) items.push(parsed);
  }
  return items;
}

export function parseBoostsResponse(raw: unknown): DexScreenerBoost[] {
  if (!Array.isArray(raw)) return [];
  const items: DexScreenerBoost[] = [];
  for (const item of raw) {
    const base = parseDexScreenerItem(item);
    if (!base) continue;
    const obj = item as Record<string, unknown>;
    items.push({
      ...base,
      amount: typeof obj['amount'] === 'number' ? obj['amount'] : undefined,
      totalAmount: typeof obj['totalAmount'] === 'number' ? obj['totalAmount'] : undefined,
    });
  }
  return items;
}

// ── Candidate builder — pure ──────────────────────────────────────────────────

export function buildDexEarsCandidates(
  results: DexEndpointResult[],
  chain: string,
): DexEarsCandidate[] {
  const map = new Map<string, DexEarsCandidate>();
  const normalizedChain = chain.toLowerCase();

  for (const result of results) {
    if (result.error) continue;
    for (const item of result.items) {
      if (item.chainId.toLowerCase() !== normalizedChain) continue;
      const key = `${item.chainId.toLowerCase()}:${item.tokenAddress.toLowerCase()}`;

      if (!map.has(key)) {
        map.set(key, {
          chainId: item.chainId,
          tokenAddress: item.tokenAddress,
          name: item.header,
          description: item.description,
          url: item.url,
          foundIn: new Set<DexEndpoint>(),
          hasProfile: false,
          hasBoost: false,
          hasCto: false,
          totalBoostAmount: 0,
        });
      }

      const candidate = map.get(key)!;
      candidate.foundIn.add(result.endpoint);

      if (result.endpoint === 'latest_profiles') {
        candidate.hasProfile = true;
        // prefer name from profile if not yet set
        if (!candidate.name && item.header) candidate.name = item.header;
      } else if (result.endpoint === 'latest_boosts') {
        candidate.hasBoost = true;
        const boost = item as DexScreenerBoost;
        candidate.totalBoostAmount += boost.totalAmount ?? 0;
        if (!candidate.name && item.header) candidate.name = item.header;
      } else if (result.endpoint === 'top_boosts') {
        candidate.hasCto = true;
        const boost = item as DexScreenerBoost;
        candidate.totalBoostAmount = Math.max(candidate.totalBoostAmount, boost.totalAmount ?? 0);
        if (!candidate.name && item.header) candidate.name = item.header;
      }
    }
  }

  return Array.from(map.values());
}

// ── Confidence + signal type — pure ──────────────────────────────────────────

export function computeDexConfidence(c: DexEarsCandidate): 'high' | 'medium' | 'low' {
  if (
    c.foundIn.size >= 2 ||
    (c.hasBoost && c.hasProfile) ||
    (c.hasCto && c.hasProfile)
  ) return 'high';
  if (c.hasBoost || c.hasCto) return 'medium';
  return 'low';
}

export function computeDexSignalType(c: DexEarsCandidate): PreSignalType {
  if (c.hasCto) return 'community_raid';
  if (c.hasBoost || c.hasProfile) return 'launch_mention';
  return 'launch_mention';
}

// ── Ticker extraction from DEX header ─────────────────────────────────────────

function extractDexSymbol(header?: string): string | undefined {
  if (!header) return undefined;
  // DEX Screener header field is a CDN image URL, not a name; skip URL values
  if (header.startsWith('http') || header.includes('/') || header.includes('.')) return undefined;
  const clean = header.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length >= 2 && clean.length <= 10 && /^[A-Z]/.test(clean)) return clean;
  return undefined;
}

// ── Candidate → PreSignal — pure ──────────────────────────────────────────────

export function candidateToPreSignal(
  c: DexEarsCandidate,
  generatedAt: string,
): PreSignal {
  const symbol = extractDexSymbol(c.name);
  const symbolPart = symbol ? `$${symbol}` : '';

  const evidenceParts: string[] = [];
  if (c.hasProfile) evidenceParts.push('token profile');
  if (c.hasBoost) evidenceParts.push(`boost ${c.totalBoostAmount > 0 ? c.totalBoostAmount : 'active'}`);
  if (c.hasCto) evidenceParts.push('community takeover');
  const evidence = evidenceParts.join(' + ') || 'DEX signal';

  const parts: string[] = [];
  if (symbolPart) parts.push(symbolPart);
  parts.push(`CA: ${c.tokenAddress}`);
  parts.push(`launch signal (${evidence}) — ${c.chainId} — dexscreener`);

  const text = parts.join(' — ');

  return {
    id: `dex-${simpleHash(c.chainId + ':' + c.tokenAddress)}`,
    source: 'other' as PreSignalSource,
    text,
    symbol: symbol,
    contract: c.tokenAddress,
    url: c.url,
    seenAt: generatedAt,
    signalType: computeDexSignalType(c),
    confidence: computeDexConfidence(c),
  };
}

// ── Report builder — pure ─────────────────────────────────────────────────────

export function buildDexEarsReport(input: DexEarsInput): DexEarsReport {
  const candidates = buildDexEarsCandidates(input.endpointResults, input.chain);
  const minConfOrder = CONF_ORDER[input.minConfidence] ?? 0;

  const allFresh = candidates
    .map(c => candidateToPreSignal(c, input.generatedAt))
    .filter(sig => (CONF_ORDER[sig.confidence] ?? 0) >= minConfOrder);

  const { unique, duplicateCount } = deduplicateSignals(allFresh, input.existingSignals);

  const byConfidence: Record<string, number> = {};
  let highConfidenceCount = 0;
  let contractCount = 0;

  for (const sig of unique) {
    byConfidence[sig.confidence] = (byConfidence[sig.confidence] ?? 0) + 1;
    if (sig.confidence === 'high') highConfidenceCount++;
    if (sig.contract) contractCount++;
  }

  return {
    outputPath: input.outputPath,
    chain: input.chain,
    minConfidence: input.minConfidence,
    endpointsSummary: input.endpointResults.map(r => ({
      endpoint: r.endpoint,
      fetched: r.fetched,
      error: r.error,
    })),
    candidatesFound: candidates.length,
    signalsExtracted: allFresh.length,
    duplicatesSkipped: duplicateCount,
    uniqueSignals: unique,
    byConfidence,
    highConfidenceCount,
    contractCount,
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

// ── Renderer — pure ───────────────────────────────────────────────────────────

export function renderDexEarsReport(report: DexEarsReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push(
    '  TOKEN GRAB DEX EARS V1' +
      (report.dryRun ? ' [DRY RUN — no file written]' : ''),
  );
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Output           : ${report.outputPath}`);
  lines.push(`  Chain            : ${report.chain}`);
  lines.push(`  Min confidence   : ${report.minConfidence}`);
  lines.push(`  Candidates found : ${report.candidatesFound}`);
  lines.push(`  Signals extracted: ${report.signalsExtracted}`);
  lines.push(`  Duplicates       : ${report.duplicatesSkipped}`);
  lines.push(`  Written          : ${report.dryRun ? 0 : report.uniqueSignals.length}`);
  lines.push(`  High confidence  : ${report.highConfidenceCount}`);
  lines.push(`  Contracts        : ${report.contractCount}`);
  lines.push('');
  lines.push(THIN);
  lines.push('  Endpoints:');
  for (const e of report.endpointsSummary) {
    if (e.error) {
      lines.push(`    ${e.endpoint.padEnd(20)} ERROR  ${e.error}`);
    } else {
      lines.push(`    ${e.endpoint.padEnd(20)} ok     fetched: ${e.fetched}`);
    }
  }
  lines.push('');

  if (Object.keys(report.byConfidence).length > 0) {
    lines.push(THIN);
    lines.push('  By confidence:');
    for (const [conf, count] of Object.entries(report.byConfidence)) {
      lines.push(`    ${conf}: ${count}`);
    }
    lines.push('');
  }

  if (report.uniqueSignals.length > 0) {
    lines.push(THIN);
    lines.push(`  Top signals (showing up to 5):`);
    for (const sig of report.uniqueSignals.slice(0, 5)) {
      const sym = sig.symbol ? `$${sig.symbol}` : '(no symbol)';
      lines.push(`    ${sym.padEnd(12)} ${sig.confidence.padEnd(7)} ${sig.signalType}`);
      lines.push(`      CA: ${sig.contract ?? 'none'}`);
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

// ── Fetch functions — async I/O ───────────────────────────────────────────────

export async function fetchLatestProfiles(
  maxItems: number,
  timeoutMs = 10_000,
): Promise<DexEndpointResult> {
  try {
    const resp = await fetch(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) {
      return { endpoint: 'latest_profiles', fetched: 0, items: [], error: `HTTP ${resp.status}` };
    }
    const raw = await resp.json() as unknown;
    const items = parseProfilesResponse(raw).slice(0, maxItems);
    return { endpoint: 'latest_profiles', fetched: items.length, items };
  } catch (e) {
    return { endpoint: 'latest_profiles', fetched: 0, items: [], error: (e as Error).message };
  }
}

export async function fetchLatestBoosts(
  maxItems: number,
  timeoutMs = 10_000,
): Promise<DexEndpointResult> {
  try {
    const resp = await fetch(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) {
      return { endpoint: 'latest_boosts', fetched: 0, items: [], error: `HTTP ${resp.status}` };
    }
    const raw = await resp.json() as unknown;
    const items = parseBoostsResponse(raw).slice(0, maxItems);
    return { endpoint: 'latest_boosts', fetched: items.length, items };
  } catch (e) {
    return { endpoint: 'latest_boosts', fetched: 0, items: [], error: (e as Error).message };
  }
}

export async function fetchTopBoosts(
  maxItems: number,
  timeoutMs = 10_000,
): Promise<DexEndpointResult> {
  try {
    const resp = await fetch(
      'https://api.dexscreener.com/token-boosts/top/v1',
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) {
      return { endpoint: 'top_boosts', fetched: 0, items: [], error: `HTTP ${resp.status}` };
    }
    const raw = await resp.json() as unknown;
    const items = parseBoostsResponse(raw).slice(0, maxItems);
    return { endpoint: 'top_boosts', fetched: items.length, items };
  } catch (e) {
    return { endpoint: 'top_boosts', fetched: 0, items: [], error: (e as Error).message };
  }
}
