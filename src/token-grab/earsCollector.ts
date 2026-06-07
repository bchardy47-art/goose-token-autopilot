import type { PreSignal, PreSignalSource, PreSignalType, PreSignalConfidence } from './xEarsPreSignal';
import { normalizeSymbol } from './xEarsPreSignal';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InputItem {
  text: string;
  url?: string;
  seenAt?: string;
}

export interface EarsCollectorInput {
  inputPath: string;
  rawContent: string;
  outputPath: string;
  source: PreSignalSource;
  append: boolean;
  existingSignals: PreSignal[];
  generatedAt: string;
}

export interface EarsCollectorReport {
  inputPath: string;
  outputPath: string;
  parsedItemCount: number;
  skippedLineCount: number;
  freshSignalCount: number;
  duplicateCount: number;
  validSignalsWritten: number;
  totalSignalsInOutput: number;
  bySource: Record<string, number>;
  bySignalType: Record<string, number>;
  byConfidence: Record<string, number>;
  signals: PreSignal[];
  readOnly: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Keyword patterns ──────────────────────────────────────────────────────────

const LAUNCH_RE = /\b(?:launch(?:ing|ed)?|live|deploy(?:ing|ed)?|pair(?:ing|ed)?|liquidity|raydium|pump\.?fun|pumpfun|listing|listed)\b/i;
const INFLUENCER_RE = /\b(?:influencer|large\s+account|kol|caller|big\s+caller|alpha\s+caller)\b/i;
const MEME_RE = /\b(?:meme|breaking|viral|trending|news|event|moonshot|gem)\b/i;
const RAID_RE = /\b(?:raid|community\s+raid|army|lfg|wagmi)\b/i;

// ── Deterministic hash ────────────────────────────────────────────────────────

/**
 * Simple deterministic integer hash of a string. No randomness, no Date. Pure.
 */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

// ── Extractors ────────────────────────────────────────────────────────────────

/**
 * Extracts a Solana-style contract address from text.
 * Prefers CA:/contract: prefix; falls back to standalone 40-44 char base58. Pure.
 */
export function extractContractAddress(text: string): string | null {
  const prefixMatch = text.match(
    /(?:CA:|contract(?:\s+address)?:|address:|addr:)\s*([1-9A-HJ-NP-Za-km-z]{32,44})\b/i,
  );
  if (prefixMatch?.[1]) return prefixMatch[1];
  const standalone = text.match(/\b([1-9A-HJ-NP-Za-km-z]{40,44})\b/);
  if (standalone?.[1]) return standalone[1];
  return null;
}

/**
 * Extracts a URL from text. Pure.
 */
export function extractUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m?.[0];
}

/**
 * Extracts all $TICKER symbols from text. Pure.
 */
export function extractAllTickers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$([A-Za-z]{2,10})\b/g)) {
    found.add(m[1].toUpperCase());
  }
  return [...found];
}

// Uppercase words to skip when falling back from $TICKER to bare CAPS
const IGNORE_CAPS = new Set([
  'CA', 'AI', 'LP', 'NFT', 'DAO', 'DEX', 'CEX', 'KOL', 'LFG', 'ATH', 'ATL',
  'USD', 'USDC', 'USDT', 'SOL', 'ETH', 'BTC', 'APY', 'APR', 'TVL', 'MC',
  'DEV', 'CTO', 'CEO', 'FUD', 'FOMO', 'WAGMI', 'REKT', 'HODL', 'DYOR', 'NFA',
  'IRL', 'URL', 'API', 'TX', 'TXN', 'RPC', 'GM', 'GN', 'WL', 'OG', 'TG',
  'TW', 'PR', 'VC', 'ID', 'OK', 'GO',
]);

/**
 * Extracts the primary ticker from text. Prefers $TICKER. Pure.
 */
export function extractTicker(text: string): string | undefined {
  const dollarMatch = text.match(/\$([A-Za-z]{2,10})\b/);
  if (dollarMatch?.[1]) return dollarMatch[1].toUpperCase();
  const capsMatches = text.match(/\b([A-Z]{3,10})\b/g) ?? [];
  for (const w of capsMatches) {
    if (!IGNORE_CAPS.has(w)) return w;
  }
  return undefined;
}

// ── Signal classification ─────────────────────────────────────────────────────

/**
 * Classifies a signal type from text features. Priority order per spec. Pure.
 */
export function classifySignalType(
  text: string,
  hasContract: boolean,
  tickerFreq: number,
): PreSignalType {
  if (hasContract) return 'contract_posted';
  if (LAUNCH_RE.test(text)) return 'launch_mention';
  if (tickerFreq >= 3) return 'ticker_repetition';
  if (INFLUENCER_RE.test(text)) return 'influencer_mention';
  if (MEME_RE.test(text)) return 'meme_event';
  if (RAID_RE.test(text)) return 'community_raid';
  return 'unknown';
}

/**
 * Classifies confidence from text signals. Pure.
 */
export function classifyConfidence(
  text: string,
  hasContract: boolean,
  hasTicker: boolean,
  tickerFreq: number,
): PreSignalConfidence {
  if (hasContract) return 'high';
  if (hasTicker && tickerFreq >= 3 && LAUNCH_RE.test(text)) return 'high';
  if (hasTicker && (LAUNCH_RE.test(text) || MEME_RE.test(text) || RAID_RE.test(text) || INFLUENCER_RE.test(text))) return 'medium';
  return 'low';
}

// ── Input parser ──────────────────────────────────────────────────────────────

/**
 * Parses raw file content into input items.
 * Handles plain-text lines or JSON array/object. Pure.
 */
export function parseRawInput(content: string): { items: InputItem[]; skippedCount: number } {
  const trimmed = content.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const items: InputItem[] = [];
      let skippedCount = 0;
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const o = item as Record<string, unknown>;
          if (typeof o['text'] === 'string' && o['text'].trim().length > 0) {
            items.push({
              text: o['text'],
              url: typeof o['url'] === 'string' ? o['url'] : undefined,
              seenAt: typeof o['seenAt'] === 'string' ? o['seenAt'] : undefined,
            });
          } else {
            skippedCount++;
          }
        } else {
          skippedCount++;
        }
      }
      return { items, skippedCount };
    } catch {
      // fall through to line parsing
    }
  }

  // Plain text — one item per non-empty, non-comment line
  const lines = trimmed.split('\n');
  const items: InputItem[] = [];
  let skippedCount = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) {
      skippedCount++;
    } else {
      items.push({ text: t });
    }
  }
  return { items, skippedCount };
}

// ── Signal builder ────────────────────────────────────────────────────────────

/**
 * Builds one PreSignal from a single parsed input item.
 * `tickerFrequencies` is the cross-item ticker count used for ticker_repetition. Pure.
 */
export function buildPreSignalFromItem(
  item: InputItem,
  index: number,
  source: PreSignalSource,
  generatedAt: string,
  tickerFrequencies: Record<string, number>,
): PreSignal {
  const contract = extractContractAddress(item.text);
  const ticker = extractTicker(item.text);
  const urlFromText = extractUrl(item.text);
  const tickerFreq = ticker != null ? (tickerFrequencies[ticker] ?? 1) : 1;
  const hasContract = contract != null;
  const hasTicker = ticker != null;

  const signalType = classifySignalType(item.text, hasContract, tickerFreq);
  const confidence = classifyConfidence(item.text, hasContract, hasTicker, tickerFreq);

  const id = `ec-${String(index).padStart(3, '0')}-${simpleHash(item.text)}`;

  return {
    id,
    source,
    text: item.text,
    symbol: ticker,
    contract: contract ?? null,
    url: item.url ?? urlFromText,
    seenAt: item.seenAt ?? generatedAt,
    signalType,
    confidence,
  };
}

/**
 * Builds all PreSignal records from parsed items.
 * Performs a first pass to count ticker frequencies for ticker_repetition detection. Pure.
 */
export function buildPreSignalsFromItems(
  items: InputItem[],
  source: PreSignalSource,
  generatedAt: string,
): PreSignal[] {
  const tickerFrequencies: Record<string, number> = {};
  for (const item of items) {
    for (const ticker of extractAllTickers(item.text)) {
      tickerFrequencies[ticker] = (tickerFrequencies[ticker] ?? 0) + 1;
    }
  }
  return items.map((item, index) =>
    buildPreSignalFromItem(item, index, source, generatedAt, tickerFrequencies),
  );
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Deduplicates fresh signals against existing signals.
 * Primary key: contract (when non-null). Secondary key: normalized symbol + text hash. Pure.
 */
export function deduplicateSignals(
  fresh: PreSignal[],
  existing: PreSignal[],
): { unique: PreSignal[]; duplicateCount: number } {
  const contractSeen = new Set<string>(
    existing.filter(s => s.contract).map(s => s.contract as string),
  );
  const symbolTextSeen = new Set<string>(
    existing.map(s => `${normalizeSymbol(s.symbol ?? '')}\x00${simpleHash(s.text.slice(0, 50))}`),
  );

  const unique: PreSignal[] = [];
  let duplicateCount = 0;

  for (const sig of fresh) {
    if (sig.contract && contractSeen.has(sig.contract)) {
      duplicateCount++;
      continue;
    }
    const key = `${normalizeSymbol(sig.symbol ?? '')}\x00${simpleHash(sig.text.slice(0, 50))}`;
    if (symbolTextSeen.has(key)) {
      duplicateCount++;
      continue;
    }
    if (sig.contract) contractSeen.add(sig.contract);
    symbolTextSeen.add(key);
    unique.push(sig);
  }

  return { unique, duplicateCount };
}

// ── Report builder ────────────────────────────────────────────────────────────

/**
 * Builds the ears collector report. Pure — no I/O.
 */
export function buildEarsCollectorReport(input: EarsCollectorInput): EarsCollectorReport {
  const { items, skippedCount } = parseRawInput(input.rawContent);
  const fresh = buildPreSignalsFromItems(items, input.source, input.generatedAt);
  const { unique, duplicateCount } = deduplicateSignals(fresh, input.existingSignals);

  const outputSignals = input.append ? [...input.existingSignals, ...unique] : unique;

  const bySource: Record<string, number> = {};
  const bySignalType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const s of unique) {
    bySource[s.source] = (bySource[s.source] ?? 0) + 1;
    bySignalType[s.signalType] = (bySignalType[s.signalType] ?? 0) + 1;
    byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
  }

  return {
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    parsedItemCount: items.length,
    skippedLineCount: skippedCount,
    freshSignalCount: fresh.length,
    duplicateCount,
    validSignalsWritten: unique.length,
    totalSignalsInOutput: outputSignals.length,
    bySource,
    bySignalType,
    byConfidence,
    signals: outputSignals,
    readOnly: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

/**
 * Renders the ears collector report as a terminal string. Pure — no I/O.
 */
export function renderEarsCollectorReport(report: EarsCollectorReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB X/NEWS EARS COLLECTOR V1');
  lines.push('  Writes pre-signal file — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Input           : ${report.inputPath}`);
  lines.push(`  Output          : ${report.outputPath}`);
  lines.push(`  Parsed items    : ${report.parsedItemCount}`);
  lines.push(`  Skipped lines   : ${report.skippedLineCount}`);
  lines.push(`  Fresh signals   : ${report.freshSignalCount}`);
  lines.push(`  Duplicates      : ${report.duplicateCount}`);
  lines.push(`  Written         : ${report.validSignalsWritten}`);
  lines.push(`  Total in output : ${report.totalSignalsInOutput}`);
  lines.push('');

  lines.push(THIN);
  lines.push('By Source');
  lines.push(THIN);
  if (Object.keys(report.bySource).length === 0) {
    lines.push('  (none)');
  } else {
    for (const [k, v] of Object.entries(report.bySource)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(THIN);
  lines.push('By Signal Type');
  lines.push(THIN);
  if (Object.keys(report.bySignalType).length === 0) {
    lines.push('  (none)');
  } else {
    for (const [k, v] of Object.entries(report.bySignalType)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(THIN);
  lines.push('By Confidence');
  lines.push(THIN);
  if (Object.keys(report.byConfidence).length === 0) {
    lines.push('  (none)');
  } else {
    for (const [k, v] of Object.entries(report.byConfidence)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(WIDE);
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  Pre-signals written for use with --pre-signals in token:live-harness');
  lines.push(WIDE);

  return lines.join('\n');
}
