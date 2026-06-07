import type { PreSignal, PreSignalSource } from './xEarsPreSignal';
import { parseRawInput, buildPreSignalsFromItems, deduplicateSignals } from './earsCollector';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WatchCycleInput {
  rawContent: string;
  existingSignals: PreSignal[];
  source: PreSignalSource;
  generatedAt: string;
  cycleNumber: number;
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
}

export interface WatchCycleOutput {
  cycleNumber: number;
  inputPath: string;
  outputPath: string;
  itemsScanned: number;
  linesSkipped: number;
  signalsExtracted: number;
  duplicatesSkipped: number;
  uniqueSignals: PreSignal[];
  dryRun: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Core cycle — pure, no I/O ─────────────────────────────────────────────────

/**
 * Runs one ears-watcher cycle over pre-loaded raw content.
 * No filesystem access — the caller reads/writes files. Pure.
 */
export function runWatchCycle(input: WatchCycleInput): WatchCycleOutput {
  const { items, skippedCount } = parseRawInput(input.rawContent);
  const fresh = buildPreSignalsFromItems(items, input.source, input.generatedAt);
  const { unique, duplicateCount } = deduplicateSignals(fresh, input.existingSignals);

  return {
    cycleNumber: input.cycleNumber,
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    itemsScanned: items.length,
    linesSkipped: skippedCount,
    signalsExtracted: fresh.length,
    duplicatesSkipped: duplicateCount,
    uniqueSignals: unique,
    dryRun: input.dryRun,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Render — pure ─────────────────────────────────────────────────────────────

export function renderWatchCycleReport(output: WatchCycleOutput): string {
  const WIDE = '═'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push(
    `  EARS WATCHER V0 — Cycle ${output.cycleNumber}` +
      (output.dryRun ? ' [DRY RUN — no file written]' : ''),
  );
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Input           : ${output.inputPath}`);
  lines.push(`  Output          : ${output.outputPath}`);
  lines.push(`  Items scanned   : ${output.itemsScanned}`);
  lines.push(`  Lines skipped   : ${output.linesSkipped}`);
  lines.push(`  Signals found   : ${output.signalsExtracted}`);
  lines.push(`  Duplicates      : ${output.duplicatesSkipped}`);
  lines.push(`  Written         : ${output.dryRun ? 0 : output.uniqueSignals.length}`);
  lines.push('');
  lines.push(WIDE);
  lines.push('  NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  No wallet, swap, signing, or live-intent in this run');
  lines.push(WIDE);

  return lines.join('\n');
}
