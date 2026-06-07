import { describe, it, expect } from 'vitest';
import { runWatchCycle, renderWatchCycleReport } from '../src/token-grab/earsWatcher';
import type { WatchCycleInput } from '../src/token-grab/earsWatcher';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

const TS = '2026-06-07T00:00:00.000Z';
const CONTRACT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeInput(overrides: Partial<WatchCycleInput> = {}): WatchCycleInput {
  return {
    rawContent: '$GOOSE launching on Raydium\n$PEPE2 pump incoming\n',
    existingSignals: [],
    source: 'x_manual',
    generatedAt: TS,
    cycleNumber: 1,
    inputPath: 'test/input.txt',
    outputPath: 'test/presignals.json',
    dryRun: false,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<PreSignal> = {}): PreSignal {
  return {
    id: 'test-001',
    source: 'x_manual',
    text: 'test text',
    symbol: undefined,
    contract: null,
    seenAt: TS,
    signalType: 'unknown',
    confidence: 'low',
    ...overrides,
  };
}

// ── runWatchCycle — input parsing ─────────────────────────────────────────────

describe('runWatchCycle — input parsing', () => {
  it('counts scanned items from non-empty, non-comment lines', () => {
    const out = runWatchCycle(makeInput({ rawContent: '$GOOSE launch\n$FROGAI pump\n' }));
    expect(out.itemsScanned).toBe(2);
  });

  it('counts skipped lines (comments and blank)', () => {
    const out = runWatchCycle(makeInput({ rawContent: '# comment\n\n$GOOSE launch\n' }));
    expect(out.itemsScanned).toBe(1);
    expect(out.linesSkipped).toBe(2);
  });

  it('returns signalsExtracted equal to item count when no duplicates', () => {
    const out = runWatchCycle(makeInput());
    expect(out.signalsExtracted).toBe(out.itemsScanned);
  });

  it('handles empty rawContent without throwing', () => {
    const out = runWatchCycle(makeInput({ rawContent: '' }));
    expect(out.itemsScanned).toBe(0);
    expect(out.signalsExtracted).toBe(0);
    expect(out.uniqueSignals).toHaveLength(0);
  });
});

// ── runWatchCycle — safety fields ─────────────────────────────────────────────

describe('runWatchCycle — safety fields', () => {
  it('noRealTradeSent is always true', () => {
    expect(runWatchCycle(makeInput()).noRealTradeSent).toBe(true);
    expect(runWatchCycle(makeInput({ dryRun: true })).noRealTradeSent).toBe(true);
  });

  it('tradingExecuted is always 0', () => {
    expect(runWatchCycle(makeInput()).tradingExecuted).toBe(0);
    expect(runWatchCycle(makeInput({ dryRun: true })).tradingExecuted).toBe(0);
  });

  it('dryRun flag passes through to output', () => {
    expect(runWatchCycle(makeInput({ dryRun: true })).dryRun).toBe(true);
    expect(runWatchCycle(makeInput({ dryRun: false })).dryRun).toBe(false);
  });

  it('cycleNumber passes through to output', () => {
    expect(runWatchCycle(makeInput({ cycleNumber: 3 })).cycleNumber).toBe(3);
  });
});

// ── runWatchCycle — deduplication ─────────────────────────────────────────────

describe('runWatchCycle — deduplication', () => {
  it('deduplicates fresh signals against existing by contract', () => {
    const existing = [makeSignal({ contract: CONTRACT, text: 'old signal with contract' })];
    const raw = `check out this address ${CONTRACT} launching now`;
    const out = runWatchCycle(makeInput({ rawContent: raw, existingSignals: existing }));
    expect(out.duplicatesSkipped).toBe(1);
    expect(out.uniqueSignals).toHaveLength(0);
  });

  it('deduplicates fresh signals against existing by symbol+text hash', () => {
    const text = '$GOOSE launching on Raydium';
    const existing = [makeSignal({ symbol: 'GOOSE', text, contract: null })];
    const out = runWatchCycle(makeInput({ rawContent: text, existingSignals: existing }));
    expect(out.duplicatesSkipped).toBe(1);
    expect(out.uniqueSignals).toHaveLength(0);
  });

  it('passes through signals not present in existing', () => {
    const existing = [makeSignal({ symbol: 'FROGAI', text: 'frogai stuff', contract: null })];
    const out = runWatchCycle(
      makeInput({ rawContent: '$GOOSE launching on Raydium', existingSignals: existing }),
    );
    expect(out.uniqueSignals).toHaveLength(1);
    expect(out.duplicatesSkipped).toBe(0);
  });

  it('simulates two cycles: second cycle dedupes first cycle output', () => {
    const rawContent = '$GOOSE launching on Raydium\n$PEPE2 pump\n';

    // Cycle 1 — no existing
    const cycle1 = runWatchCycle(makeInput({ rawContent, cycleNumber: 1 }));
    expect(cycle1.uniqueSignals.length).toBeGreaterThan(0);

    // Cycle 2 — pass cycle 1 output as existing
    const cycle2 = runWatchCycle(
      makeInput({ rawContent, existingSignals: cycle1.uniqueSignals, cycleNumber: 2 }),
    );
    expect(cycle2.duplicatesSkipped).toBe(cycle1.signalsExtracted);
    expect(cycle2.uniqueSignals).toHaveLength(0);
  });
});

// ── runWatchCycle — dryRun semantics ─────────────────────────────────────────

describe('runWatchCycle — dryRun semantics', () => {
  it('uniqueSignals still populated when dryRun=true (caller decides whether to write)', () => {
    const out = runWatchCycle(makeInput({ dryRun: true }));
    // The pure function always produces uniqueSignals — the CLI skips the write
    expect(out.uniqueSignals.length).toBeGreaterThan(0);
  });

  it('output is identical regardless of dryRun flag (dryRun only affects CLI write step)', () => {
    const wet = runWatchCycle(makeInput({ dryRun: false }));
    const dry = runWatchCycle(makeInput({ dryRun: true }));
    expect(dry.itemsScanned).toBe(wet.itemsScanned);
    expect(dry.signalsExtracted).toBe(wet.signalsExtracted);
    expect(dry.uniqueSignals).toHaveLength(wet.uniqueSignals.length);
  });
});

// ── renderWatchCycleReport ────────────────────────────────────────────────────

describe('renderWatchCycleReport', () => {
  it('contains safety markers', () => {
    const out = runWatchCycle(makeInput());
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
    expect(rendered).toContain('No wallet, swap, signing, or live-intent');
  });

  it('shows [DRY RUN] label when dryRun=true', () => {
    const out = runWatchCycle(makeInput({ dryRun: true }));
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain('[DRY RUN — no file written]');
  });

  it('shows Written: 0 when dryRun=true', () => {
    const out = runWatchCycle(makeInput({ dryRun: true }));
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain('Written         : 0');
  });

  it('shows Written > 0 when dryRun=false and signals found', () => {
    const out = runWatchCycle(makeInput({ dryRun: false }));
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain(`Written         : ${out.uniqueSignals.length}`);
    expect(out.uniqueSignals.length).toBeGreaterThan(0);
  });

  it('shows cycle number in header', () => {
    const out = runWatchCycle(makeInput({ cycleNumber: 7 }));
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain('Cycle 7');
  });

  it('shows input and output paths', () => {
    const out = runWatchCycle(
      makeInput({ inputPath: 'my/input.txt', outputPath: 'my/presignals.json' }),
    );
    const rendered = renderWatchCycleReport(out);
    expect(rendered).toContain('my/input.txt');
    expect(rendered).toContain('my/presignals.json');
  });

  it('does not contain LIVE_EXECUTED, privateKey, or signTransaction', () => {
    const out = runWatchCycle(makeInput());
    const rendered = renderWatchCycleReport(out);
    expect(rendered).not.toContain('LIVE_EXECUTED');
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('signTransaction');
    expect(rendered).not.toContain('sendTransaction');
  });
});
