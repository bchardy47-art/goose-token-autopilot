// ── Dex feed refresh — ONE-SHOT wrapper (paper-only, cron-safe) ──────────────────────────
//
// token:dex-feed-refresh performs a SINGLE Dex feed refresh cycle and then EXITS.
// It is a thin, hard-capped wrapper around runDexDayWatch:
//
//   • ONE cycle only            — cycles is FORCED to 1, never the 24-cycle day-watch loop.
//   • NO between-cycle sleep     — sleepBetweenCyclesMs is FORCED to 0 (no 20-minute waits).
//   • PAPER ONLY / READ-ONLY     — runner → journal → planner. tradingExecuted: 0.
//   • NO wallet, NO signing, NO swap, NO private keys, NO real trading.
//   • Does NOT run the auto-paper or paper-buy commands.
//   • UNKNOWN stays UNKNOWN — this only refreshes the upstream feed; it makes no verdicts.
//
// Unlike token:dex-day-watch (a long unattended runner), this exits after saving one fresh
// dex-watch run so cron can schedule it directly and safely.

import { runDexDayWatch, type DayWatchOptions, type DayWatchResult } from './dexDayWatch';

// ── Hard caps — not user-overridable ─────────────────────────────────────────────────────

/** ONE cycle only. Never the 24-cycle day-watch loop. */
export const DEX_FEED_REFRESH_CYCLES = 1 as const;
/** NO between-cycle sleep. Never the 20-minute day-watch sleep. */
export const DEX_FEED_REFRESH_SLEEP_MS = 0 as const;

// ── Defaults (match token:dex-day-watch / the ripper-paper-loop refresh source) ──────────

export const DEX_FEED_REFRESH_DEFAULTS = {
  dexConfigPath: 'config/dex-ears.example.json',
  signalsOut:    'data/token-grab/x-ears/presignals.dex.json',
  runsDir:       'data/token-grab/dex-watch-runs',
  journalOut:    'data/token-grab/paper-journal/dex-paper-journal.json',
  plannerOut:    'data/token-grab/paper-plans/dex-paper-entry-plan.json',
  dayLogPath:    'data/token-grab/day-watch/dex-day-watch.jsonl',
  fakeBankroll:  20,
  positionSize:  1,
  minutes:       1,
  intervalSeconds: 30,
} as const;

export interface DexFeedRefreshOptions {
  dexConfigPath?: string;
  signalsOut?: string;
  runsDir?: string;
  journalOut?: string;
  plannerOut?: string;
  dayLogPath?: string;
  fakeBankroll?: number;
  positionSize?: number;
  /** Watch window per cycle in minutes (default 1). */
  minutes?: number;
  /** Snapshot interval within the single cycle (default 30s). */
  intervalSeconds?: number;
  log?: (msg: string) => void;
  // ── Test seams ────────────────────────────────────────────────────────────
  endpointFetcher?: DayWatchOptions['endpointFetcher'];
  watchFetchImpl?: DayWatchOptions['watchFetchImpl'];
  sleepImpl?: DayWatchOptions['sleepImpl'];
  nowFn?: DayWatchOptions['nowFn'];
  /** Inject a fake runDexDayWatch for tests. */
  _runDexDayWatch?: (opts: DayWatchOptions) => Promise<DayWatchResult>;
}

export interface DexFeedRefreshResult extends DayWatchResult {
  cyclesRun: number;
  dayLogPath: string;
  tradingExecuted: 0;
  paperOnly: true;
  readOnly: true;
  noRealTradeSent: true;
}

/**
 * Build the DayWatchOptions for a one-shot refresh. cycles and sleepBetweenCyclesMs are
 * FORCED to their hard caps regardless of anything the caller passes — this is what keeps
 * the command safe to schedule directly in cron.
 */
export function buildDexFeedRefreshDayWatchOptions(options: DexFeedRefreshOptions = {}): DayWatchOptions {
  return {
    dexConfigPath: options.dexConfigPath ?? DEX_FEED_REFRESH_DEFAULTS.dexConfigPath,
    signalsOut:    options.signalsOut    ?? DEX_FEED_REFRESH_DEFAULTS.signalsOut,
    runsDir:       options.runsDir       ?? DEX_FEED_REFRESH_DEFAULTS.runsDir,
    journalOut:    options.journalOut    ?? DEX_FEED_REFRESH_DEFAULTS.journalOut,
    plannerOut:    options.plannerOut    ?? DEX_FEED_REFRESH_DEFAULTS.plannerOut,
    dayLogPath:    options.dayLogPath    ?? DEX_FEED_REFRESH_DEFAULTS.dayLogPath,
    fakeBankroll:  options.fakeBankroll  ?? DEX_FEED_REFRESH_DEFAULTS.fakeBankroll,
    positionSize:  options.positionSize  ?? DEX_FEED_REFRESH_DEFAULTS.positionSize,
    minutes:       options.minutes       ?? DEX_FEED_REFRESH_DEFAULTS.minutes,
    intervalSeconds: options.intervalSeconds ?? DEX_FEED_REFRESH_DEFAULTS.intervalSeconds,
    // Hard caps — NOT overridable by the caller. One cycle, no sleep.
    cycles:               DEX_FEED_REFRESH_CYCLES,
    sleepBetweenCyclesMs: DEX_FEED_REFRESH_SLEEP_MS,
    endpointFetcher: options.endpointFetcher,
    watchFetchImpl:  options.watchFetchImpl,
    sleepImpl:       options.sleepImpl,
    nowFn:           options.nowFn,
    log:             options.log,
  };
}

/**
 * Run exactly one Dex feed refresh cycle, then resolve. Saves a fresh dex-watch run into
 * runsDir and appends one entry to the day log. Never loops, never sleeps between cycles.
 */
export async function runDexFeedRefresh(options: DexFeedRefreshOptions = {}): Promise<DexFeedRefreshResult> {
  const runner = options._runDexDayWatch ?? runDexDayWatch;
  const dayWatchOptions = buildDexFeedRefreshDayWatchOptions(options);
  const result = await runner(dayWatchOptions);
  return {
    ...result,
    tradingExecuted: 0,
    paperOnly: true,
    readOnly: true,
    noRealTradeSent: true,
  };
}

export function renderDexFeedRefreshUsage(): string {
  return [
    'Usage: npm run token:dex-feed-refresh -- [options]',
    '',
    'ONE-SHOT Dex feed refresh — runs a SINGLE runner → journal → planner cycle and EXITS.',
    'Cron-safe: unlike token:dex-day-watch, this never loops 24 times and never sleeps 20m.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. No private keys. tradingExecuted: 0.',
    'Does NOT run the auto-paper or paper-buy commands. UNKNOWN stays UNKNOWN.',
    '',
    'Options:',
    '  --dex-config <path>      DEX ears config (default: config/dex-ears.example.json)',
    '  --signals-out <path>     Presignals output (default: data/token-grab/x-ears/presignals.dex.json)',
    '  --runs-dir <path>        Watch runs directory (default: data/token-grab/dex-watch-runs)',
    '  --journal <path>         Paper journal output (default: data/token-grab/paper-journal/dex-paper-journal.json)',
    '  --planner-out <path>     Planner output (default: data/token-grab/paper-plans/dex-paper-entry-plan.json)',
    '  --day-log <path>         Day watch JSONL log (default: data/token-grab/day-watch/dex-day-watch.jsonl)',
    '  --fake-bankroll <n>      Fake bankroll in USD (default: 20)',
    '  --position-size <n>      Fake position size in USD (default: 1)',
    '  --minutes <n>            Watch window for the single cycle in minutes (default: 1)',
    '  --interval-seconds <n>   Snapshot interval within the cycle (default: 30)',
    '  --help, -h               Show this help and exit',
    '',
    'Exits after saving ONE fresh dex-watch run. Run token:ripper-paper-cycle next to capture it.',
  ].join('\n');
}

export function renderDexFeedRefreshResult(result: DexFeedRefreshResult): string {
  const WIDE = '═'.repeat(72);
  return [
    WIDE,
    '  TOKEN GRAB — DEX FEED REFRESH (ONE-SHOT)',
    '  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0',
    '  No wallet. No signing. No swap. No private keys. One cycle only — no loop, no sleep.',
    WIDE,
    '',
    `  Cycles run   : ${result.cyclesRun} (hard cap: ${DEX_FEED_REFRESH_CYCLES})`,
    `  Day log      : ${result.dayLogPath}`,
    '',
    '  Next: npm run token:ripper-paper-cycle  (captures this fresh run)',
    WIDE,
  ].join('\n');
}
