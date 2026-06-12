import * as fs from 'fs';
import type { ClusterRiskProvider } from './clusterRiskProvider';
import {
  runRipperPaperCycle,
  type RipperPaperCycleResult,
} from './ripperPaperCycle';

const DEFAULT_INTERVAL_SECONDS = 180;
const DEFAULT_MAX_CYCLES       = 10;
const DEFAULT_CYCLES_DIR       = 'data/token-grab/ripper/cycles';
const DEFAULT_RUNS_DIR         = 'data/token-grab/dex-watch-runs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperLoopOptions {
  runsDir?: string;
  cyclesDir?: string;
  clusterRiskProvider?: ClusterRiskProvider;
  intervalSeconds?: number;
  maxCycles?: number;
  stopFilePath?: string;
  /** Injected for testing — defaults to Date.now */
  getNowMs?: () => number;
  /** Injected for testing — defaults to setTimeout-based sleep */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each successful cycle completes (used for inline printing) */
  onCycleComplete?: (cycleResult: RipperPaperCycleResult, cycleNumber: number) => void;
  /** Overrides the cycle runner — for testing error paths only */
  _runCycle?: (options: { runsDir: string; cyclesDir: string; clusterRiskProvider?: ClusterRiskProvider; nowMs: number }) => Promise<RipperPaperCycleResult>;
}

export interface RipperPaperLoopCycleSummary {
  cycleNumber: number;
  result: RipperPaperCycleResult;
}

export interface RipperPaperLoopError {
  cycleNumber: number;
  error: string;
}

export interface RipperPaperLoopResult {
  sessionStartedAt: string;
  sessionEndedAt: string;
  cyclesAttempted: number;
  cyclesCompleted: number;
  stoppedByFile: boolean;
  stoppedByMaxCycles: boolean;
  stoppedByError: boolean;
  totalFixtures: number;
  totalPaperApprovals: number;
  totalRejected: number;
  errors: RipperPaperLoopError[];
  cycles: RipperPaperLoopCycleSummary[];
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Loop orchestrator ─────────────────────────────────────────────────────────

export async function runRipperPaperLoop(
  options: RipperPaperLoopOptions = {},
): Promise<RipperPaperLoopResult> {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxCycles       = options.maxCycles       ?? DEFAULT_MAX_CYCLES;
  const stopFilePath    = options.stopFilePath;
  const getNowMs        = options.getNowMs ?? (() => Date.now());
  const sleep           = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const runCycle        = options._runCycle ?? runRipperPaperCycle;

  const sessionStartedAt = new Date(getNowMs()).toISOString();

  let cyclesAttempted   = 0;
  let cyclesCompleted   = 0;
  let totalFixtures     = 0;
  let totalPaperApprovals = 0;
  let totalRejected     = 0;
  let stoppedByFile     = false;
  let stoppedByError    = false;
  const errors: RipperPaperLoopError[] = [];
  const cycles: RipperPaperLoopCycleSummary[] = [];

  for (let i = 0; i < maxCycles; i++) {
    const cycleNumber = i + 1;

    // ── Stop file check (before cycle) ───────────────────────────────────────
    if (stopFilePath && fs.existsSync(stopFilePath)) {
      stoppedByFile = true;
      break;
    }

    cyclesAttempted += 1;

    // ── Run one paper cycle ───────────────────────────────────────────────────
    let cycleResult: RipperPaperCycleResult;
    try {
      cycleResult = await runCycle({
        runsDir:             options.runsDir    ?? DEFAULT_RUNS_DIR,
        cyclesDir:           options.cyclesDir  ?? DEFAULT_CYCLES_DIR,
        clusterRiskProvider: options.clusterRiskProvider,
        nowMs:               getNowMs(),
      });
    } catch (err) {
      errors.push({
        cycleNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      stoppedByError = true;
      break;
    }

    cycles.push({ cycleNumber, result: cycleResult });
    cyclesCompleted      += 1;
    totalFixtures        += cycleResult.fixturesCaptured;
    totalPaperApprovals  += cycleResult.buyApprovedPaper;
    totalRejected        += cycleResult.buyRejected;

    options.onCycleComplete?.(cycleResult, cycleNumber);

    // ── Sleep between cycles (not after the last one) ─────────────────────────
    const isLastCycle = i === maxCycles - 1;
    if (!isLastCycle) {
      if (stopFilePath && fs.existsSync(stopFilePath)) {
        stoppedByFile = true;
        break;
      }
      await sleep(intervalSeconds * 1_000);
    }
  }

  const stoppedByMaxCycles =
    !stoppedByFile && !stoppedByError && cyclesCompleted >= maxCycles;

  return {
    sessionStartedAt,
    sessionEndedAt:    new Date(getNowMs()).toISOString(),
    cyclesAttempted,
    cyclesCompleted,
    stoppedByFile,
    stoppedByMaxCycles,
    stoppedByError,
    totalFixtures,
    totalPaperApprovals,
    totalRejected,
    errors,
    cycles,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

export function renderLoopCycleLine(
  result: RipperPaperCycleResult,
  cycleNumber: number,
  maxCycles: number,
): string {
  const pad = (n: number) => String(n).padStart(2);
  const num = `[${pad(cycleNumber)}/${pad(maxCycles)}]`;

  if (result.captureSkipped) {
    return (
      `  ${num}  skip — ${result.captureSkipReason ?? 'no fresh signals'}` +
      `  | locked=true tradingExecuted=0`
    );
  }

  const cr = result.clusterRiskCounts;
  return (
    `  ${num}` +
    `  signals=${result.feedSignalsWritten}` +
    `  fixtures=${result.fixturesCaptured}` +
    `  approved=${result.buyApprovedPaper}` +
    `  rejected=${result.buyRejected}` +
    `  CLEAN=${cr.CLEAN} WATCH=${cr.WATCH} RISKY=${cr.RISKY} UNK=${cr.UNKNOWN}` +
    `  locked=true tradingExecuted=0` +
    (result.outputPath ? `\n         artifact: ${result.outputPath}` : '')
  );
}

export function renderRipperPaperLoopResult(
  result: RipperPaperLoopResult,
  maxCycles: number,
): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];
  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER PAPER LOOP — SESSION SUMMARY');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Session started : ${result.sessionStartedAt}`);
  lines.push(`  Session ended   : ${result.sessionEndedAt}`);
  lines.push('');
  lines.push(`  Cycles attempted: ${result.cyclesAttempted}`);
  lines.push(`  Cycles completed: ${result.cyclesCompleted}`);
  lines.push('');
  lines.push(`  Total fixtures  : ${result.totalFixtures}`);
  lines.push(`  Paper approvals : ${result.totalPaperApprovals}`);
  lines.push(`  Total rejected  : ${result.totalRejected}`);
  lines.push('');

  const stopReason = result.stoppedByFile
    ? 'stop file detected'
    : result.stoppedByError
      ? `error on cycle ${result.errors[0]?.cycleNumber ?? '?'}`
      : result.stoppedByMaxCycles
        ? `max cycles (${maxCycles}) reached`
        : 'completed';
  lines.push(`  Stop reason     : ${stopReason}`);

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('  Errors:');
    for (const e of result.errors) {
      lines.push(`    cycle ${e.cycleNumber}: ${e.error}`);
    }
  }

  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperPaperLoopUsage(): string {
  return `
token:ripper-paper-loop — run paper cycle repeatedly until stopped

Usage:
  npm run token:ripper-paper-loop [options]

Options:
  --interval-seconds <n>   seconds to sleep between cycles (default: 180)
  --max-cycles <n>         stop after this many cycles (default: 10)
  --cycles-dir <path>      directory for cycle artifacts (default: data/token-grab/ripper/cycles)
  --stop-file <path>       if this file exists at cycle start, exit cleanly
  --help                   show this message

Stop mechanisms:
  1. --max-cycles reached (clean exit)
  2. --stop-file is present before a cycle starts (clean exit)
  3. A cycle throws an unhandled error (logged, loop stops)
  4. Ctrl+C (sends SIGINT; the loop will finish the current cycle then exit)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  Buy gates are unchanged. Age semantics are unchanged. Paper only.
`.trim();
}
