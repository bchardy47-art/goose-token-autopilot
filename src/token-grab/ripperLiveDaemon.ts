// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  defaultMode=dry-run  stopFileHonored=true
//
// Live Daemon v1 — runs the Live Runner on an interval until a stop condition. Default
// mode is dry-run. Refuses sub-5-minute intervals unless explicitly overridden. Honors a
// stop file. Stops after 3 consecutive failures. Logs daemon state to a JSONL log.
//
// The daemon never trades by itself — it delegates each cycle to the Live Runner, which
// enforces all unlock/signer/risk rules. Live mode still requires full unlock.

import * as fs   from 'fs';
import * as path from 'path';

import { runLiveRunner, type LiveRunnerOptions, type LiveRunnerResult } from './ripperLiveRunner';
import type { ExecutionMode } from './ripperLiveTradingConfig';

export const DEFAULT_STOP_FILE   = 'data/token-grab/ripper/LIVE_STOP';
export const DEFAULT_DAEMON_LOG  = 'data/token-grab/ripper/live-daemon-log.jsonl';
export const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface LiveDaemonOptions {
  mode?:            ExecutionMode;
  intervalMinutes?: number;
  maxRuns?:         number;
  once?:            boolean;
  allowShortInterval?: boolean;
  stopFile?:        string;
  daemonLog?:       string;
  // injection
  runnerOptions?:   Partial<LiveRunnerOptions>;
  runOnce?:         (opts: LiveRunnerOptions) => Promise<LiveRunnerResult>;  // override for tests
  sleep?:           (ms: number) => Promise<void>;
  now?:             () => Date;
}

export interface DaemonCycleLog {
  cycle:        number;
  at:           string;
  mode:         ExecutionMode;
  runId:        string | null;
  blocked:      boolean;
  blockReason:  string | null;
  candidates:   number;
  exits:        number;
  ok:           boolean;
  error:        string | null;
}

export interface LiveDaemonResult {
  mode:             ExecutionMode;
  intervalMinutes:  number;
  cyclesRun:        number;
  stoppedReason:    'MAX_RUNS' | 'STOP_FILE' | 'CONSECUTIVE_FAILURES' | 'ONCE' | 'INTERVAL_REFUSED';
  consecutiveFailures: number;
  cycles:           DaemonCycleLog[];
  stopFileChecked:  string;
  daemonLogPath:    string;
}

function appendLog(logPath: string, entry: DaemonCycleLog): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* non-fatal */ }
}

export async function runLiveDaemon(opts: LiveDaemonOptions = {}): Promise<LiveDaemonResult> {
  const mode: ExecutionMode = opts.mode ?? 'dry-run';
  const stopFile = opts.stopFile ?? DEFAULT_STOP_FILE;
  const daemonLog = opts.daemonLog ?? DEFAULT_DAEMON_LOG;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)));
  const runOnce = opts.runOnce ?? runLiveRunner;
  const once = opts.once ?? false;
  const intervalMinutes = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  // Refuse dangerously short intervals unless explicitly overridden.
  if (!once && intervalMinutes < MIN_INTERVAL_MINUTES && !opts.allowShortInterval) {
    return {
      mode, intervalMinutes, cyclesRun: 0, stoppedReason: 'INTERVAL_REFUSED',
      consecutiveFailures: 0, cycles: [], stopFileChecked: stopFile, daemonLogPath: daemonLog,
    };
  }

  const maxRuns = once ? 1 : (opts.maxRuns ?? Infinity);
  const cycles: DaemonCycleLog[] = [];
  let consecutiveFailures = 0;
  let cyclesRun = 0;
  let stoppedReason: LiveDaemonResult['stoppedReason'] = once ? 'ONCE' : 'MAX_RUNS';

  for (let i = 0; i < maxRuns; i++) {
    // Stop file check BEFORE each cycle.
    if (fs.existsSync(stopFile)) { stoppedReason = 'STOP_FILE'; break; }

    let log: DaemonCycleLog;
    try {
      const res = await runOnce({ ...opts.runnerOptions, mode, once: true });
      cyclesRun += 1;
      log = {
        cycle: i + 1, at: now().toISOString(), mode, runId: res.runId,
        blocked: res.blocked, blockReason: res.blockReason,
        candidates: res.candidatesConsidered, exits: res.exitsEvaluated.length,
        ok: true, error: null,
      };
      consecutiveFailures = 0;   // a completed cycle (even if run was "blocked") is not a failure
    } catch (err) {
      cyclesRun += 1;
      consecutiveFailures += 1;
      log = {
        cycle: i + 1, at: now().toISOString(), mode, runId: null,
        blocked: false, blockReason: null, candidates: 0, exits: 0,
        ok: false, error: err instanceof Error ? err.message : String(err),
      };
    }
    cycles.push(log);
    appendLog(daemonLog, log);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { stoppedReason = 'CONSECUTIVE_FAILURES'; break; }
    if (once) { stoppedReason = 'ONCE'; break; }
    if (i + 1 >= maxRuns) { stoppedReason = 'MAX_RUNS'; break; }

    // Stop file check AFTER cycle too, before sleeping.
    if (fs.existsSync(stopFile)) { stoppedReason = 'STOP_FILE'; break; }
    await sleep(intervalMinutes * 60_000);
  }

  return {
    mode, intervalMinutes, cyclesRun, stoppedReason, consecutiveFailures,
    cycles, stopFileChecked: stopFile, daemonLogPath: daemonLog,
  };
}

const SEP = '━'.repeat(64);
export function renderLiveDaemon(r: LiveDaemonResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — LIVE DAEMON');
  L.push(`  [mode=${r.mode}  interval=${r.intervalMinutes}m  REAL TRADING DEFAULTS OFF]`);
  L.push(SEP, '');
  L.push(`  cycles run        : ${r.cyclesRun}`);
  L.push(`  stopped reason    : ${r.stoppedReason}`);
  L.push(`  consecutive fails : ${r.consecutiveFailures}`);
  L.push(`  stop file         : ${r.stopFileChecked}`);
  L.push(`  daemon log        : ${r.daemonLogPath}`);
  L.push('');
  for (const c of r.cycles) {
    L.push(`    cycle ${c.cycle}: ${c.ok ? 'ok' : 'FAIL'} runId=${c.runId ?? '-'} blocked=${c.blocked} candidates=${c.candidates} exits=${c.exits}${c.error ? '  err=' + c.error : ''}`);
  }
  L.push('');
  L.push('  SAFETY: daemon delegates to the Live Runner; live still requires unlock + signer. Stop file honored.');
  L.push(SEP, '');
  return L.join('\n');
}
