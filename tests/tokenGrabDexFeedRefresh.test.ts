import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEX_FEED_REFRESH_CYCLES,
  DEX_FEED_REFRESH_SLEEP_MS,
  buildDexFeedRefreshDayWatchOptions,
  runDexFeedRefresh,
  renderDexFeedRefreshUsage,
  renderDexFeedRefreshResult,
  type DexFeedRefreshResult,
} from '../src/token-grab/dexFeedRefresh';
import type { DayWatchOptions, DayWatchResult } from '../src/token-grab/dexDayWatch';

const REPO_ROOT = path.join(__dirname, '..');

// ── One-shot hard caps ──────────────────────────────────────────────────────────────────

describe('dex-feed-refresh hard caps', () => {
  it('exposes cycles cap of exactly 1', () => {
    expect(DEX_FEED_REFRESH_CYCLES).toBe(1);
  });

  it('exposes a sleep cap of exactly 0 (no between-cycle sleep)', () => {
    expect(DEX_FEED_REFRESH_SLEEP_MS).toBe(0);
  });

  it('forces cycles to 1 in the built options', () => {
    const opts = buildDexFeedRefreshDayWatchOptions();
    expect(opts.cycles).toBe(1);
  });

  it('forces sleepBetweenCyclesMs to 0 in the built options', () => {
    const opts = buildDexFeedRefreshDayWatchOptions();
    expect(opts.sleepBetweenCyclesMs).toBe(0);
  });

  it('cannot be overridden to a 24-cycle loop or a 20-minute sleep', () => {
    // Callers have no --cycles / --sleep flag, but even if the field is smuggled in
    // via an object cast the builder must ignore it.
    const smuggled = { cycles: 24, sleepBetweenCyclesMs: 20 * 60 * 1000 } as unknown as Parameters<
      typeof buildDexFeedRefreshDayWatchOptions
    >[0];
    const opts = buildDexFeedRefreshDayWatchOptions(smuggled);
    expect(opts.cycles).toBe(1);
    expect(opts.sleepBetweenCyclesMs).toBe(0);
  });
});

// ── Behavior: exits after one cycle, no loop, no real sleep ──────────────────────────────

describe('runDexFeedRefresh behavior', () => {
  it('invokes the day-watch runner exactly once with cycles=1 and sleep=0, then resolves', async () => {
    const calls: DayWatchOptions[] = [];
    const fakeRunner = async (opts: DayWatchOptions): Promise<DayWatchResult> => {
      calls.push(opts);
      return { cyclesRun: 1, dayLogPath: opts.dayLogPath };
    };

    const result = await runDexFeedRefresh({ _runDexDayWatch: fakeRunner });

    expect(calls).toHaveLength(1);
    expect(calls[0].cycles).toBe(1);
    expect(calls[0].sleepBetweenCyclesMs).toBe(0);
    expect(result.cyclesRun).toBe(1);
  });

  it('never sleeps 24 times / never calls the sleep impl (no loop)', async () => {
    let sleepCalls = 0;
    const sleepSpy = async () => {
      sleepCalls += 1;
    };
    // Use the REAL runDexDayWatch through a fetch stub that returns no signals so the
    // single cycle short-circuits — this exercises the real orchestration once.
    const emptyFetch = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-refresh-'));
    const cfg = path.join(tmp, 'dex-ears.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        chain: 'solana',
        minConfidence: 'medium',
        maxItemsPerEndpoint: 50,
        timeoutMs: 1000,
        endpoints: { latestProfiles: true, latestBoosts: false, topBoosts: false },
      }),
    );

    const result = await runDexFeedRefresh({
      dexConfigPath: cfg,
      signalsOut: path.join(tmp, 'signals.json'),
      runsDir: path.join(tmp, 'runs'),
      journalOut: path.join(tmp, 'journal.json'),
      plannerOut: path.join(tmp, 'plan.json'),
      dayLogPath: path.join(tmp, 'day.jsonl'),
      minutes: 0,
      intervalSeconds: 1,
      watchFetchImpl: emptyFetch,
      sleepImpl: sleepSpy,
      nowFn: () => new Date('2026-07-02T20:00:00.000Z'),
    });

    // Exactly one cycle ran and the between-cycle sleep was never reached.
    expect(result.cyclesRun).toBe(1);
    expect(sleepCalls).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('tags the result as paper-only / read-only with tradingExecuted 0', async () => {
    const fakeRunner = async (opts: DayWatchOptions): Promise<DayWatchResult> => ({
      cyclesRun: 1,
      dayLogPath: opts.dayLogPath,
    });
    const result: DexFeedRefreshResult = await runDexFeedRefresh({ _runDexDayWatch: fakeRunner });
    expect(result.tradingExecuted).toBe(0);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.noRealTradeSent).toBe(true);
  });
});

// ── Safety: no unsafe trading code in the module ─────────────────────────────────────────

describe('dex-feed-refresh safety', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'token-grab', 'dexFeedRefresh.ts'),
    'utf-8',
  );

  it('does not reference auto-paper or paper-buy', () => {
    expect(source).not.toContain('token:auto-paper');
    expect(source).not.toContain('token:paper-buy');
  });

  it('does not contain wallet/signing/swap/private-key execution code', () => {
    expect(source).not.toMatch(/signTransaction|keypair\.sign|sendSwap|executeSwap|privateKey/i);
  });

  it('does not enable real trading', () => {
    expect(source).not.toMatch(/enableRealTrading|realTrading\s*=\s*true|READY_FOR_REAL_TRADING\s*=\s*true/);
  });
});

// ── Usage + result renderers ─────────────────────────────────────────────────────────────

describe('dex-feed-refresh renderers', () => {
  it('usage documents one-shot / no-loop / no-sleep and paper-only safety', () => {
    const usage = renderDexFeedRefreshUsage();
    expect(usage).toContain('ONE-SHOT');
    expect(usage).toContain('never loops 24');
    expect(usage).toContain('PAPER ONLY');
    expect(usage).toContain('tradingExecuted: 0');
  });

  it('result renderer shows the one-cycle hard cap and paper-only banner', () => {
    const out = renderDexFeedRefreshResult({
      cyclesRun: 1,
      dayLogPath: 'data/x.jsonl',
      tradingExecuted: 0,
      paperOnly: true,
      readOnly: true,
      noRealTradeSent: true,
    });
    expect(out).toContain('DEX FEED REFRESH (ONE-SHOT)');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toContain('One cycle only');
  });
});

// ── package.json registration ────────────────────────────────────────────────────────────

describe('package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };

  it('registers token:dex-feed-refresh', () => {
    expect(pkg.scripts['token:dex-feed-refresh']).toBeDefined();
  });

  it('token:dex-feed-refresh runs the CLI command (not the 24-cycle day-watch)', () => {
    expect(pkg.scripts['token:dex-feed-refresh']).toContain('token:dex-feed-refresh');
    expect(pkg.scripts['token:dex-feed-refresh']).not.toContain('token:dex-day-watch');
  });
});
