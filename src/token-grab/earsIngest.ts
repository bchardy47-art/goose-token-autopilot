import type { PreSignal, PreSignalSource } from './xEarsPreSignal';
import { buildPreSignalsFromItems, deduplicateSignals } from './earsCollector';
import type { InputItem } from './earsCollector';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SourceFileResult {
  filename: string;
  source: PreSignalSource;
  items: InputItem[];
  error?: string;
}

export interface EarsIngestInput {
  sourceFiles: SourceFileResult[];
  existingSignals: PreSignal[];
  generatedAt: string;
  dryRun: boolean;
  outputPath: string;
}

export interface EarsIngestReport {
  outputPath: string;
  filesScanned: number;
  observationsScanned: number;
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

// ── Source detection from filename ────────────────────────────────────────────

export function detectSourceFromFilename(
  filename: string,
  defaultSource: PreSignalSource,
): PreSignalSource {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  if (/^x-/i.test(base)) return 'x_manual';
  if (/^telegram-/i.test(base)) return 'telegram_manual';
  if (/^discord-/i.test(base)) return 'discord_manual';
  if (/^news-/i.test(base)) return 'news_manual';
  return defaultSource;
}

// ── Ticker text normalization — pure ──────────────────────────────────────────

function normalizeTickers(text: string): string {
  return text
    .replace(/\bticker:\s*([A-Za-z]{2,10})\b/gi, '$$$1')
    .replace(/\bsymbol:\s*([A-Za-z]{2,10})\b/gi, '$$$1')
    .replace(/\bsymbol\s+([A-Za-z]{2,10})\b/gi, '$$$1');
}

// ── Signal URL extraction — domain-filtered, pure ────────────────────────────

const SIGNAL_DOMAINS = [
  'x.com', 'twitter.com', 't.me', 'discord',
  'dexscreener.com', 'geckoterminal.com', 'pump.fun', 'raydium.io',
];

export function extractSignalUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s]+/);
  if (!m) return undefined;
  const url = m[0];
  return SIGNAL_DOMAINS.some(d => url.includes(d)) ? url : undefined;
}

// ── .txt parser — pure ────────────────────────────────────────────────────────

export function parseTxtFile(content: string): InputItem[] {
  const items: InputItem[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const text = normalizeTickers(line);
    items.push({ text, url: extractSignalUrl(text) });
  }
  return items;
}

// ── .md parser — pure ─────────────────────────────────────────────────────────

export function parseMdFile(content: string): InputItem[] {
  const items: InputItem[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.replace(/^[-*+]\s+/, '').trim();
    if (!stripped) continue;
    const text = normalizeTickers(stripped);
    items.push({ text, url: extractSignalUrl(text) });
  }
  return items;
}

// ── .json parser — pure ───────────────────────────────────────────────────────

export function parseJsonFile(content: string): InputItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>)['items'])
      ? ((parsed as Record<string, unknown>)['items'] as unknown[])
      : [];

  const items: InputItem[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj['text'] !== 'string' || !obj['text'].trim()) continue;
    items.push({
      text: normalizeTickers(obj['text'].trim()),
      url: typeof obj['url'] === 'string' ? obj['url'] : undefined,
      seenAt: typeof obj['seenAt'] === 'string' ? obj['seenAt'] : undefined,
    });
  }
  return items;
}

// ── Source file parser dispatch — pure ───────────────────────────────────────

export function parseSourceFile(
  filename: string,
  content: string,
  defaultSource: PreSignalSource,
): SourceFileResult {
  const source = detectSourceFromFilename(filename, defaultSource);
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  let items: InputItem[];
  if (ext === 'json') {
    items = parseJsonFile(content);
  } else if (ext === 'md') {
    items = parseMdFile(content);
  } else {
    items = parseTxtFile(content);
  }
  return { filename, source, items };
}

// ── Report builder — pure ─────────────────────────────────────────────────────

export function buildEarsIngestReport(input: EarsIngestInput): EarsIngestReport {
  let totalObservations = 0;
  const allFresh: PreSignal[] = [];

  for (const file of input.sourceFiles) {
    if (file.error) continue;
    totalObservations += file.items.length;
    if (file.items.length === 0) continue;
    allFresh.push(...buildPreSignalsFromItems(file.items, file.source, input.generatedAt));
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
    filesScanned: input.sourceFiles.length,
    observationsScanned: totalObservations,
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

export function renderEarsIngestReport(report: EarsIngestReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push(
    '  TOKEN GRAB EARS INGEST V1' +
      (report.dryRun ? ' [DRY RUN — no file written]' : ''),
  );
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Output           : ${report.outputPath}`);
  lines.push(`  Files scanned    : ${report.filesScanned}`);
  lines.push(`  Observations     : ${report.observationsScanned}`);
  lines.push(`  Signals extracted: ${report.signalsExtracted}`);
  lines.push(`  Duplicates       : ${report.duplicatesSkipped}`);
  lines.push(`  Written          : ${report.dryRun ? 0 : report.uniqueSignals.length}`);
  lines.push(`  High confidence  : ${report.highConfidenceCount}`);
  lines.push(`  Contracts        : ${report.contractCount}`);
  lines.push(`  Tickers          : ${report.tickerCount}`);
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
