import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { runLiveDaemon, type LiveDaemonOptions } from '../src/token-grab/ripperLiveDaemon';
import type { LiveRunnerResult } from '../src/token-grab/ripperLiveRunner';

let root: string;
let stopFile: string;
let daemonLog: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldaemon-test-'));
  stopFile = path.join(root, 'LIVE_STOP');
  daemonLog = path.join(root, 'live-daemon-log.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fakeRun(over: Partial<LiveRunnerResult> = {}): LiveRunnerResult {
  return {
    runId: 'run_x', mode: 'dry-run', liveUnlocked: false, blocked: false, blockReason: null,
    openPositionsAtStart: 0, exitsEvaluated: [], candidatesConsidered: 1, candidateOutcomes: [],
    tradesToday: 0, dailyLoss: 0, ledgerEventsWritten: 3, safetyFlags: {}, ...over,
  };
}

function base(over: Partial<LiveDaemonOptions> = {}): LiveDaemonOptions {
  return {
    stopFile, daemonLog, sleep: async () => {}, now: () => new Date('2026-06-20T12:00:00Z'),
    runOnce: async () => fakeRun(),
    ...over,
  };
}

describe('Live Daemon v1', () => {
  it('--once runs exactly one cycle', async () => {
    let calls = 0;
    const r = await runLiveDaemon(base({ once: true, runOnce: async () => { calls++; return fakeRun(); } }));
    expect(calls).toBe(1);
    expect(r.cyclesRun).toBe(1);
    expect(r.stoppedReason).toBe('ONCE');
  });

  it('honors max-runs', async () => {
    let calls = 0;
    const r = await runLiveDaemon(base({ maxRuns: 3, runOnce: async () => { calls++; return fakeRun(); } }));
    expect(calls).toBe(3);
    expect(r.cyclesRun).toBe(3);
    expect(r.stoppedReason).toBe('MAX_RUNS');
  });

  it('honors the stop file', async () => {
    let calls = 0;
    const r = await runLiveDaemon(base({
      maxRuns: 5,
      runOnce: async () => { calls++; if (calls === 2) fs.writeFileSync(stopFile, 'stop'); return fakeRun(); },
    }));
    expect(r.stoppedReason).toBe('STOP_FILE');
    expect(calls).toBe(2);     // stop file written during cycle 2 → checked before cycle 3
  });

  it('stops after 3 consecutive failures', async () => {
    const r = await runLiveDaemon(base({
      maxRuns: 10,
      runOnce: async () => { throw new Error('boom'); },
    }));
    expect(r.stoppedReason).toBe('CONSECUTIVE_FAILURES');
    expect(r.consecutiveFailures).toBe(3);
    expect(r.cyclesRun).toBe(3);
  });

  it('refuses interval under 5 minutes unless overridden', async () => {
    const refused = await runLiveDaemon(base({ intervalMinutes: 2, maxRuns: 1 }));
    expect(refused.stoppedReason).toBe('INTERVAL_REFUSED');
    expect(refused.cyclesRun).toBe(0);

    const allowed = await runLiveDaemon(base({ intervalMinutes: 2, maxRuns: 1, allowShortInterval: true }));
    expect(allowed.cyclesRun).toBe(1);
  });

  it('live mode still delegates refusal to the runner (no unlock → blocked run)', async () => {
    const r = await runLiveDaemon(base({
      mode: 'live', once: true,
      runOnce: async () => fakeRun({ mode: 'live', blocked: true, blockReason: 'not unlocked' }),
    }));
    expect(r.cycles[0].blocked).toBe(true);
    expect(r.cycles[0].blockReason).toMatch(/not unlocked/);
  });

  it('writes a daemon log line per cycle', async () => {
    await runLiveDaemon(base({ maxRuns: 2 }));
    const lines = fs.readFileSync(daemonLog, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).cycle).toBe(1);
  });

  it('defaults to dry-run mode', async () => {
    const r = await runLiveDaemon(base({ once: true }));
    expect(r.mode).toBe('dry-run');
  });
});
