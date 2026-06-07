import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectSourceFromFilename,
  parseTxtFile,
  parseMdFile,
  parseJsonFile,
  parseSourceFile,
  buildEarsIngestReport,
  renderEarsIngestReport,
  extractSignalUrl,
} from '../src/token-grab/earsIngest';
import type { EarsIngestInput, SourceFileResult } from '../src/token-grab/earsIngest';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

const TS = '2026-06-07T00:00:00.000Z';
const FIXTURES = path.join('tests', 'fixtures', 'ears-source-drops');

function loadFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES, filename), 'utf-8');
}

function makeIngestInput(overrides: Partial<EarsIngestInput> = {}): EarsIngestInput {
  return {
    sourceFiles: [],
    existingSignals: [],
    generatedAt: TS,
    dryRun: false,
    outputPath: 'data/token-grab/x-ears/presignals.test.json',
    ...overrides,
  };
}

function loadAllFixtures(): SourceFileResult[] {
  const files = ['x-launches.txt', 'telegram-calls.txt', 'discord-watch.md', 'news-launches.json'];
  return files.map(f =>
    parseSourceFile(path.join(FIXTURES, f), loadFixture(f), 'x_manual'),
  );
}

// ── detectSourceFromFilename ──────────────────────────────────────────────────

describe('detectSourceFromFilename', () => {
  it('detects x_manual from x- prefix', () => {
    expect(detectSourceFromFilename('x-launches.txt', 'other')).toBe('x_manual');
  });

  it('detects telegram_manual from telegram- prefix', () => {
    expect(detectSourceFromFilename('telegram-calls.txt', 'other')).toBe('telegram_manual');
  });

  it('detects discord_manual from discord- prefix', () => {
    expect(detectSourceFromFilename('discord-watch.md', 'other')).toBe('discord_manual');
  });

  it('detects news_manual from news- prefix', () => {
    expect(detectSourceFromFilename('news-launches.json', 'other')).toBe('news_manual');
  });

  it('falls back to defaultSource for unrecognized prefix', () => {
    expect(detectSourceFromFilename('caller-drops.txt', 'telegram_manual')).toBe('telegram_manual');
  });

  it('handles full paths by using only the basename', () => {
    expect(detectSourceFromFilename('/some/dir/x-foo.txt', 'other')).toBe('x_manual');
  });
});

// ── extractSignalUrl ──────────────────────────────────────────────────────────

describe('extractSignalUrl', () => {
  it('extracts x.com URL', () => {
    expect(extractSignalUrl('Signal https://x.com/user/status/123')).toBe('https://x.com/user/status/123');
  });

  it('extracts t.me URL', () => {
    expect(extractSignalUrl('Join https://t.me/callergroup/9')).toBe('https://t.me/callergroup/9');
  });

  it('extracts pump.fun URL', () => {
    expect(extractSignalUrl('Live on https://pump.fun/token/abc')).toBe('https://pump.fun/token/abc');
  });

  it('returns undefined for non-signal domains', () => {
    expect(extractSignalUrl('See https://random-news.com/article')).toBeUndefined();
  });

  it('returns undefined when no URL present', () => {
    expect(extractSignalUrl('Plain text with no URL')).toBeUndefined();
  });
});

// ── parseTxtFile ──────────────────────────────────────────────────────────────

describe('parseTxtFile', () => {
  it('returns one item per non-comment non-empty line', () => {
    const content = '# comment\n$GOOSE launch on Raydium\n\n$FROGAI pump.fun\n';
    const items = parseTxtFile(content);
    expect(items).toHaveLength(2);
    expect(items[0].text).toContain('GOOSE');
    expect(items[1].text).toContain('FROGAI');
  });

  it('skips blank lines and # comment lines', () => {
    const content = '\n# skip me\n  \n$TICKER here\n';
    expect(parseTxtFile(content)).toHaveLength(1);
  });

  it('extracts signal URL when known domain present', () => {
    const content = '$GOOSE on https://x.com/user/status/1\n';
    const items = parseTxtFile(content);
    expect(items[0].url).toBe('https://x.com/user/status/1');
  });

  it('omits url when no known signal domain present', () => {
    const content = '$GOOSE mentioned at https://example.com/news\n';
    const items = parseTxtFile(content);
    expect(items[0].url).toBeUndefined();
  });

  it('normalizes ticker: SYMBOL pattern to $SYMBOL', () => {
    const items = parseTxtFile('ticker: MOONCAT launching today\n');
    expect(items[0].text).toContain('$MOONCAT');
  });

  it('normalizes symbol: SYMBOL pattern to $SYMBOL', () => {
    const items = parseTxtFile('symbol: FROGAI spotted\n');
    expect(items[0].text).toContain('$FROGAI');
  });
});

// ── parseMdFile ───────────────────────────────────────────────────────────────

describe('parseMdFile', () => {
  it('strips - bullet prefix from lines', () => {
    const content = '- $BRAINROT meme going viral\n';
    const items = parseMdFile(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('$BRAINROT meme going viral');
  });

  it('strips * bullet prefix from lines', () => {
    const content = '* $PEPE2 raid in progress\n';
    const items = parseMdFile(content);
    expect(items[0].text).toBe('$PEPE2 raid in progress');
  });

  it('skips # heading lines', () => {
    const content = '# Heading\n- actual item\n';
    expect(parseMdFile(content)).toHaveLength(1);
  });

  it('extracts signal URL from bullet text when domain matches', () => {
    const content = '- $GOOSE live https://pump.fun/token/abc\n';
    const items = parseMdFile(content);
    expect(items[0].url).toBe('https://pump.fun/token/abc');
  });

  it('parses discord-watch.md fixture correctly', () => {
    const items = parseMdFile(loadFixture('discord-watch.md'));
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('$BRAINROT meme coin going viral, trending everywhere');
    expect(items[1].text).toBe('$MOONCAT launched on Raydium with initial liquidity');
  });
});

// ── parseJsonFile ─────────────────────────────────────────────────────────────

describe('parseJsonFile', () => {
  it('parses JSON array of {text} objects', () => {
    const json = JSON.stringify([
      { text: '$GOOSE launch on Raydium', url: 'https://example.com' },
      { text: '$FROGAI pump.fun listing' },
    ]);
    const items = parseJsonFile(json);
    expect(items).toHaveLength(2);
    expect(items[0].text).toContain('GOOSE');
    expect(items[0].url).toBe('https://example.com');
  });

  it('parses JSON object with items array', () => {
    const json = JSON.stringify({
      items: [
        { text: '$SOLCAT deploying on Raydium', seenAt: TS },
      ],
    });
    const items = parseJsonFile(json);
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('SOLCAT');
    expect(items[0].seenAt).toBe(TS);
  });

  it('preserves url and seenAt from JSON entries', () => {
    const json = JSON.stringify([{ text: '$X launch', url: 'https://x.com/1', seenAt: TS }]);
    const item = parseJsonFile(json)[0];
    expect(item.url).toBe('https://x.com/1');
    expect(item.seenAt).toBe(TS);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseJsonFile('not json at all')).toEqual([]);
    expect(parseJsonFile('{bad:')).toEqual([]);
  });

  it('skips entries without text field', () => {
    const json = JSON.stringify([{ url: 'https://example.com' }, { text: '$VALID item' }]);
    expect(parseJsonFile(json)).toHaveLength(1);
  });

  it('parses news-launches.json fixture (object format)', () => {
    const items = parseJsonFile(loadFixture('news-launches.json'));
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://news.example.com/1');
    expect(items[1].seenAt).toBe('2026-06-07T00:00:00.000Z');
  });
});

// ── parseSourceFile ───────────────────────────────────────────────────────────

describe('parseSourceFile', () => {
  it('dispatches to parseTxtFile for .txt extension', () => {
    const result = parseSourceFile('x-test.txt', '# skip\n$GOOSE launch\n', 'other');
    expect(result.items).toHaveLength(1);
  });

  it('dispatches to parseMdFile for .md extension', () => {
    const result = parseSourceFile('discord-test.md', '- $GOOSE launch\n', 'other');
    expect(result.items[0].text).toBe('$GOOSE launch');
  });

  it('dispatches to parseJsonFile for .json extension', () => {
    const json = JSON.stringify([{ text: '$GOOSE launch' }]);
    const result = parseSourceFile('news-test.json', json, 'other');
    expect(result.items).toHaveLength(1);
  });

  it('sets source from filename prefix', () => {
    const result = parseSourceFile('telegram-drops.txt', '$GOOSE launch\n', 'other');
    expect(result.source).toBe('telegram_manual');
  });

  it('uses defaultSource when filename has no recognized prefix', () => {
    const result = parseSourceFile('random-file.txt', '$GOOSE\n', 'discord_manual');
    expect(result.source).toBe('discord_manual');
  });
});

// ── buildEarsIngestReport ─────────────────────────────────────────────────────

describe('buildEarsIngestReport — fixtures', () => {
  it('scans all 4 fixture files', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    expect(report.filesScanned).toBe(4);
  });

  it('counts total observations across all files', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // x-launches.txt: 6, telegram-calls.txt: 2, discord-watch.md: 2, news-launches.json: 2
    expect(report.observationsScanned).toBe(12);
  });

  it('deduplicates same contract address across files', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // $GOOSE CA appears in x-launches.txt AND telegram-calls.txt
    const contractSignals = report.uniqueSignals.filter(s => s.contract === '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(contractSignals).toHaveLength(1);
  });

  it('deduplicates same symbol+text across files', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // $PEPE2 raid text is identical in x-launches.txt AND telegram-calls.txt.
    // Note: extractTicker does not match $PEPE2 (digit suffix blocks \b), so symbol=undefined;
    // dedup still works via text-hash key.
    const pepe2Signals = report.uniqueSignals.filter(s => s.text.includes('PEPE2'));
    expect(pepe2Signals).toHaveLength(1);
  });

  it('reports correct duplicate count', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // telegram-calls.txt contributes 2 duplicates ($GOOSE CA + $PEPE2 raid)
    expect(report.duplicatesSkipped).toBe(2);
  });

  it('produces expected unique signals count', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // 12 total - 2 duplicates = 10 unique
    expect(report.uniqueSignals).toHaveLength(10);
  });

  it('returns tradingExecuted: 0', () => {
    expect(buildEarsIngestReport(makeIngestInput()).tradingExecuted).toBe(0);
  });

  it('returns noRealTradeSent: true', () => {
    expect(buildEarsIngestReport(makeIngestInput()).noRealTradeSent).toBe(true);
  });

  it('dryRun flag passes through to report', () => {
    expect(buildEarsIngestReport(makeIngestInput({ dryRun: true })).dryRun).toBe(true);
    expect(buildEarsIngestReport(makeIngestInput({ dryRun: false })).dryRun).toBe(false);
  });

  it('includes suggestedHarnessCommand containing the output path', () => {
    const out = 'data/token-grab/x-ears/presignals.json';
    const report = buildEarsIngestReport(makeIngestInput({ outputPath: out }));
    expect(report.suggestedHarnessCommand).toContain(out);
    expect(report.suggestedHarnessCommand).toContain('token:live-harness');
    expect(report.suggestedHarnessCommand).toContain('--pre-signals');
  });

  it('populates bySource with at least x_manual and discord_manual', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    expect(report.bySource['x_manual']).toBeGreaterThan(0);
    expect(report.bySource['discord_manual']).toBeGreaterThan(0);
  });

  it('populates bySignalType with known types from fixtures', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    expect(report.bySignalType['contract_posted']).toBeGreaterThan(0);
    expect(report.bySignalType['launch_mention']).toBeGreaterThan(0);
    expect(report.bySignalType['community_raid']).toBeGreaterThan(0);
    expect(report.bySignalType['meme_event']).toBeGreaterThan(0);
    expect(report.bySignalType['ticker_repetition']).toBeGreaterThan(0);
  });

  it('counts high-confidence signals: contract + ticker-freq-with-launch', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    // $GOOSE CA → high (contract). $FROGAI pump.fun with freq=3 → high (hasTicker+freq≥3+LAUNCH).
    expect(report.highConfidenceCount).toBe(2);
    expect(report.contractCount).toBe(1);
  });

  it('counts exactly 1 contract signal', () => {
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    expect(report.contractCount).toBe(1);
  });

  it('deduplicates against existingSignals in append mode', () => {
    const first = buildEarsIngestReport(makeIngestInput({ sourceFiles: loadAllFixtures() }));
    const second = buildEarsIngestReport(
      makeIngestInput({ sourceFiles: loadAllFixtures(), existingSignals: first.uniqueSignals }),
    );
    expect(second.uniqueSignals).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(first.signalsExtracted);
  });

  it('skips files with error set', () => {
    const errorFile: SourceFileResult = {
      filename: 'bad.txt', source: 'x_manual', items: [], error: 'could not read',
    };
    const report = buildEarsIngestReport(makeIngestInput({ sourceFiles: [errorFile] }));
    expect(report.observationsScanned).toBe(0);
    expect(report.signalsExtracted).toBe(0);
  });
});

// ── renderEarsIngestReport ────────────────────────────────────────────────────

describe('renderEarsIngestReport', () => {
  function makeReport(dryRun = false) {
    return buildEarsIngestReport(
      makeIngestInput({ sourceFiles: loadAllFixtures(), dryRun }),
    );
  }

  it('contains NO REAL TRADE SENT and tradingExecuted: 0', () => {
    const rendered = renderEarsIngestReport(makeReport());
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
  });

  it('shows [DRY RUN] label when dryRun=true', () => {
    expect(renderEarsIngestReport(makeReport(true))).toContain('[DRY RUN — no file written]');
  });

  it('shows Written: 0 when dryRun=true', () => {
    expect(renderEarsIngestReport(makeReport(true))).toContain('Written          : 0');
  });

  it('shows Written > 0 when dryRun=false', () => {
    const rendered = renderEarsIngestReport(makeReport(false));
    expect(rendered).toContain('Written          : 10');
  });

  it('shows token:auto-paper was NOT run', () => {
    expect(renderEarsIngestReport(makeReport())).toContain('token:auto-paper was NOT run');
  });

  it('shows suggested harness command', () => {
    const rendered = renderEarsIngestReport(makeReport());
    expect(rendered).toContain('Run harness:');
    expect(rendered).toContain('token:live-harness');
    expect(rendered).toContain('--pre-signals');
  });

  it('does not contain LIVE_EXECUTED', () => {
    expect(renderEarsIngestReport(makeReport())).not.toContain('LIVE_EXECUTED');
  });

  it('does not contain privateKey, signTransaction, sendTransaction', () => {
    const rendered = renderEarsIngestReport(makeReport());
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });

  it('shows by source, by signal type, by confidence sections', () => {
    const rendered = renderEarsIngestReport(makeReport());
    expect(rendered).toContain('By source:');
    expect(rendered).toContain('By signal type:');
    expect(rendered).toContain('By confidence:');
  });
});
