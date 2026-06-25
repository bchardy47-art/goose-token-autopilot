// DO_NOT_ENABLE_REAL_TRADING  HOLD_CURRENT_GATES  paperOnly=true  readOnly=true  tradingExecuted=0
//
// Ripper Learning Loop — orchestrates repeated paper-only data collection cycles.
// Calls paper cycle, BubbleMaps diagnostic (report-only), simulation report (report-only),
// and autopilot status in sequence. Stops on failure. Never enables real trading.

// ── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_INTERVAL_MINUTES = 10;
export const DEFAULT_MAX_LOOPS        = 6;

export const ENV_INTERVAL_KEY  = 'TOKEN_GRAB_LEARNING_LOOP_INTERVAL_MINUTES';
export const ENV_MAX_LOOPS_KEY = 'TOKEN_GRAB_LEARNING_LOOP_MAX_LOOPS';

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PaperCycleStepResult {
  approved:     number;
  rejected:     number;
  bmLiveCalls:  number | null;
  bmCacheHits:  number | null;
  bmSkipped:    number | null;
}

export interface DiagnosticStepResult {
  cooldownActive: boolean | null;
}

export interface SimulationStepResult {
  recommendation:  string | null;
  winRate:         number | null;
  simulatedTrades: number;
}

// Paper-only subgroup watch (report-only). A hit is NOT a buy signal and changes nothing.
export interface SubgroupWatchStepResult {
  hitCount: number;
}

export interface AutopilotStepResult {
  mode:              string;
  realTradingLocked: boolean;
  tradingExecuted:   number;
}

export interface RipperLearningLoopSummary {
  loopNumber:       number;
  startedAt:        string;
  endedAt:          string;
  approved:         number | null;
  rejected:         number | null;
  bmLiveCalls:      number | null;
  bmCacheHits:      number | null;
  bmSkipped:        number | null;
  cooldownActive:   boolean | null;
  simRecommendation: string | null;
  simTrades:        number | null;
  simWinRate:       number | null;
  subgroupWatchHits: number | null;  // paper-only watch hits this loop (NOT buys)
  failedStep:       string | null;
  failureReason:    string | null;
}

export interface RipperLearningLoopResult {
  sessionStartedAt:  string;
  sessionEndedAt:    string;
  loopsAttempted:    number;
  loopsCompleted:    number;
  stoppedByMaxLoops: boolean;
  stoppedByFailure:  boolean;
  failedLoopNumber:  number | null;
  failedStep:        string | null;
  failureReason:     string | null;
  intervalMinutes:   number;
  maxLoops:          number;
  summaries:         RipperLearningLoopSummary[];
  // safety
  realTradingLocked: true;
  tradingExecuted:   0;
  paperOnly:         true;
  readOnly:          true;
}

export interface RipperLearningLoopOptions {
  intervalMinutes?:    number;
  maxLoops?:           number;
  // injectable step functions (required for actual execution; omit to skip that step)
  runPaperCycle?:      () => Promise<PaperCycleStepResult>;
  runDiagnostic?:      () => DiagnosticStepResult;
  runSimulation?:      () => SimulationStepResult;
  runSubgroupWatch?:   () => SubgroupWatchStepResult;
  runAutopilotStatus?: () => AutopilotStepResult;
  // test / timing overrides
  _sleep?:             (ms: number) => Promise<void>;
  _getNow?:            () => string;
  onLoopStart?:        (loopNumber: number, maxLoops: number) => void;
  onLoopComplete?:     (summary: RipperLearningLoopSummary) => void;
}

// ── Config resolution ──────────────────────────────────────────────────────────

export function resolveLoopConfig(opts: Pick<RipperLearningLoopOptions, 'intervalMinutes' | 'maxLoops'>): {
  intervalMinutes: number;
  maxLoops:        number;
} {
  let intervalMinutes = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  let maxLoops        = opts.maxLoops        ?? DEFAULT_MAX_LOOPS;

  const envInterval = process.env[ENV_INTERVAL_KEY];
  if (envInterval != null && envInterval.trim() !== '') {
    const parsed = Number(envInterval);
    if (Number.isFinite(parsed) && parsed > 0) intervalMinutes = parsed;
  }

  const envMaxLoops = process.env[ENV_MAX_LOOPS_KEY];
  if (envMaxLoops != null && envMaxLoops.trim() !== '') {
    const parsed = Math.floor(Number(envMaxLoops));
    if (Number.isFinite(parsed) && parsed > 0) maxLoops = parsed;
  }

  return { intervalMinutes, maxLoops };
}

// ── Core ───────────────────────────────────────────────────────────────────────

export async function runRipperLearningLoop(
  opts: RipperLearningLoopOptions = {},
): Promise<RipperLearningLoopResult> {
  const { intervalMinutes, maxLoops } = resolveLoopConfig(opts);
  const sleep  = opts._sleep  ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const getNow = opts._getNow ?? (() => new Date().toISOString());

  const sessionStartedAt = getNow();
  const summaries: RipperLearningLoopSummary[] = [];

  let loopsAttempted   = 0;
  let loopsCompleted   = 0;
  let stoppedByFailure = false;
  let failedLoopNumber: number | null = null;
  let failedStep:       string | null = null;
  let failureReason:    string | null = null;

  for (let loop = 1; loop <= maxLoops; loop++) {
    loopsAttempted++;
    const loopStartedAt = getNow();

    opts.onLoopStart?.(loop, maxLoops);

    let approved:         number | null  = null;
    let rejected:         number | null  = null;
    let bmLiveCalls:      number | null  = null;
    let bmCacheHits:      number | null  = null;
    let bmSkipped:        number | null  = null;
    let cooldownActive:   boolean | null = null;
    let simRecommendation: string | null = null;
    let simTrades:        number | null  = null;
    let simWinRate:       number | null  = null;
    let subgroupWatchHits: number | null = null;
    let loopFailedStep:   string | null  = null;
    let loopFailureReason: string | null = null;

    // Step 1 — paper cycle (mutates cycle/fixture data; the only writing step)
    if (opts.runPaperCycle && !loopFailedStep) {
      try {
        const r = await opts.runPaperCycle();
        approved    = r.approved;
        rejected    = r.rejected;
        bmLiveCalls = r.bmLiveCalls;
        bmCacheHits = r.bmCacheHits;
        bmSkipped   = r.bmSkipped;
      } catch (err) {
        loopFailedStep    = 'paper-cycle';
        loopFailureReason = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 2 — BubbleMaps coverage diagnostic (report-only, no mutation)
    if (opts.runDiagnostic && !loopFailedStep) {
      try {
        const d = opts.runDiagnostic();
        cooldownActive = d.cooldownActive;
      } catch (err) {
        loopFailedStep    = 'bubblemaps-diagnostic';
        loopFailureReason = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 3 — simulation report (report-only, no mutation)
    if (opts.runSimulation && !loopFailedStep) {
      try {
        const s = opts.runSimulation();
        simRecommendation = s.recommendation;
        simTrades         = s.simulatedTrades;
        simWinRate        = s.winRate;
      } catch (err) {
        loopFailedStep    = 'simulation-report';
        loopFailureReason = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 3.5 — subgroup watch (report-only, paper-only). A hit is NOT a buy signal;
    // it does not affect gate decisions, write trades, or enable real trading.
    if (opts.runSubgroupWatch && !loopFailedStep) {
      try {
        const w = opts.runSubgroupWatch();
        subgroupWatchHits = w.hitCount;
      } catch (err) {
        loopFailedStep    = 'subgroup-watch';
        loopFailureReason = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 4 — autopilot status (report-only, safety check)
    if (opts.runAutopilotStatus && !loopFailedStep) {
      try {
        opts.runAutopilotStatus();
      } catch (err) {
        loopFailedStep    = 'autopilot-status';
        loopFailureReason = err instanceof Error ? err.message : String(err);
      }
    }

    const summary: RipperLearningLoopSummary = {
      loopNumber:        loop,
      startedAt:         loopStartedAt,
      endedAt:           getNow(),
      approved,
      rejected,
      bmLiveCalls,
      bmCacheHits,
      bmSkipped,
      cooldownActive,
      simRecommendation,
      simTrades,
      simWinRate,
      subgroupWatchHits,
      failedStep:        loopFailedStep,
      failureReason:     loopFailureReason,
    };

    summaries.push(summary);
    opts.onLoopComplete?.(summary);

    if (loopFailedStep) {
      stoppedByFailure = true;
      failedLoopNumber = loop;
      failedStep       = loopFailedStep;
      failureReason    = loopFailureReason;
      break;
    }

    loopsCompleted++;

    // Sleep between loops — not after the last one
    if (loop < maxLoops) {
      await sleep(intervalMinutes * 60 * 1_000);
    }
  }

  return {
    sessionStartedAt,
    sessionEndedAt:    getNow(),
    loopsAttempted,
    loopsCompleted,
    stoppedByMaxLoops: !stoppedByFailure && loopsCompleted >= maxLoops,
    stoppedByFailure,
    failedLoopNumber,
    failedStep,
    failureReason,
    intervalMinutes,
    maxLoops,
    summaries,
    realTradingLocked: true,
    tradingExecuted:   0,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderers ──────────────────────────────────────────────────────────────────

export function renderRipperLearningLoopSummary(summary: RipperLearningLoopSummary): string {
  const lines: string[] = [''];
  lines.push(`  ${SEP2}`);
  lines.push(`  LOOP ${summary.loopNumber} SUMMARY`);
  lines.push(`  ${SEP2}`);

  if (summary.failedStep) {
    lines.push(`  FAILED at step : ${summary.failedStep}`);
    lines.push(`  Reason         : ${summary.failureReason ?? 'unknown'}`);
  } else {
    if (summary.approved  != null) lines.push(`  Cycle approved : ${summary.approved}`);
    if (summary.rejected  != null) lines.push(`  Cycle rejected : ${summary.rejected}`);
    if (summary.bmLiveCalls != null) lines.push(`  BM live calls  : ${summary.bmLiveCalls}`);
    if (summary.bmCacheHits != null) lines.push(`  BM cache hits  : ${summary.bmCacheHits}`);
    if (summary.bmSkipped != null && summary.bmSkipped > 0)
      lines.push(`  BM skipped     : ${summary.bmSkipped}`);
    if (summary.cooldownActive != null)
      lines.push(`  Cooldown active: ${summary.cooldownActive ? 'YES' : 'no'}`);
    if (summary.simRecommendation != null)
      lines.push(`  Sim recommend  : ${summary.simRecommendation}`);
    if (summary.simWinRate != null)
      lines.push(`  Sim win rate   : ${(summary.simWinRate * 100).toFixed(1)}% (n=${summary.simTrades ?? 0})`);
    if (summary.subgroupWatchHits != null)
      lines.push(`  Subgroup watch : ${summary.subgroupWatchHits} hit(s)  [PAPER_ONLY_WATCH_NOT_BUY]`);
  }

  lines.push(`  Mode=PAPER_ONLY  realTradingLocked=true  tradingExecuted=0  DO_NOT_ENABLE_REAL_TRADING`);

  return lines.join('\n');
}

export function renderRipperLearningLoopResult(result: RipperLearningLoopResult): string {
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LEARNING LOOP — SESSION COMPLETE');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP, '');
  lines.push(`  Session started  : ${result.sessionStartedAt}`);
  lines.push(`  Session ended    : ${result.sessionEndedAt}`);
  lines.push(`  Max loops        : ${result.maxLoops}`);
  lines.push(`  Interval         : ${result.intervalMinutes} min`);
  lines.push(`  Loops attempted  : ${result.loopsAttempted}`);
  lines.push(`  Loops completed  : ${result.loopsCompleted}`);
  lines.push('');

  if (result.stoppedByMaxLoops) {
    lines.push('  Stopped by : max loops reached — session complete.');
  } else if (result.stoppedByFailure) {
    lines.push(`  Stopped by : FAILURE at loop ${result.failedLoopNumber}, step=${result.failedStep}`);
    lines.push(`  Reason     : ${result.failureReason}`);
  }

  lines.push('');
  lines.push('  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING  HOLD_CURRENT_GATES  PAPER_ONLY');
  lines.push('  DO_NOT_CALL_AUTO_PAPER  DO_NOT_CALL_PAPER_BUY  DO_NOT_LOOSEN_GATES');
  lines.push(SEP, '');

  return lines.join('\n');
}

export function renderRipperLearningLoopUsage(): string {
  return [
    '',
    '  token:ripper-learning-loop',
    '  Runs the full paper-only learning cycle on a repeat interval.',
    '',
    '  Each loop runs in order:',
    '    1. token:ripper-paper-cycle         (captures fresh data)',
    '    2. bubblemaps-live-runner-diagnostic (report-only)',
    '    3. paper-trade-simulation-report    (report-only)',
    '    4. ripper-autopilot-status          (report-only)',
    '',
    '  Options:',
    '    --max-loops N           max iterations (default: 6)',
    '    --interval-minutes N    minutes between loops (default: 10)',
    '',
    '  Env overrides:',
    `    ${ENV_INTERVAL_KEY}`,
    `    ${ENV_MAX_LOOPS_KEY}`,
    '',
    '  Safety: PAPER_ONLY — real trading is permanently locked.',
    '  HOLD_CURRENT_GATES  DO_NOT_ENABLE_REAL_TRADING',
    '  DO_NOT_CALL_AUTO_PAPER  DO_NOT_CALL_PAPER_BUY',
    '',
  ].join('\n');
}
