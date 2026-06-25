// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveLoopConfig,
  runRipperLearningLoop,
  renderRipperLearningLoopResult,
  renderRipperLearningLoopSummary,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_LOOPS,
  ENV_INTERVAL_KEY,
  ENV_MAX_LOOPS_KEY,
} from '../src/token-grab/ripperLearningLoop';

// ── Helpers ────────────────────────────────────────────────────────────────────

const noop = async () => {};

function okCycleResult() {
  return { approved: 2, rejected: 5, bmLiveCalls: 1, bmCacheHits: 3, bmSkipped: 0 };
}

function okDiagResult() {
  return { cooldownActive: false };
}

function okSimResult() {
  return { recommendation: 'KEEP_COLLECTING', winRate: 0.45, simulatedTrades: 100 };
}

function okAutopilotResult() {
  return { mode: 'PAPER_ONLY', realTradingLocked: true, tradingExecuted: 0 };
}

// ── Safety strings ─────────────────────────────────────────────────────────────

describe('safety strings', () => {
  it('source file has DO_NOT_ENABLE_REAL_TRADING', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/ripperLearningLoop.ts'),
      'utf-8',
    );
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source file has HOLD_CURRENT_GATES', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/ripperLearningLoop.ts'),
      'utf-8',
    );
    expect(src).toContain('HOLD_CURRENT_GATES');
  });

  it('source file has no signTransaction', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/ripperLearningLoop.ts'),
      'utf-8',
    );
    expect(src).not.toContain('signTransaction');
  });
});

// ── Default config is safe ─────────────────────────────────────────────────────

describe('loop defaults are safe', () => {
  beforeEach(() => {
    delete process.env[ENV_INTERVAL_KEY];
    delete process.env[ENV_MAX_LOOPS_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_INTERVAL_KEY];
    delete process.env[ENV_MAX_LOOPS_KEY];
  });

  it('default interval is 10 minutes', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(10);
    const { intervalMinutes } = resolveLoopConfig({});
    expect(intervalMinutes).toBe(10);
  });

  it('default max loops is 6', () => {
    expect(DEFAULT_MAX_LOOPS).toBe(6);
    const { maxLoops } = resolveLoopConfig({});
    expect(maxLoops).toBe(6);
  });

  it('defaults are finite positive numbers', () => {
    const { intervalMinutes, maxLoops } = resolveLoopConfig({});
    expect(intervalMinutes).toBeGreaterThan(0);
    expect(maxLoops).toBeGreaterThan(0);
    expect(Number.isFinite(intervalMinutes)).toBe(true);
    expect(Number.isFinite(maxLoops)).toBe(true);
  });

  it('result always has safety fields locked', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── Env overrides parsed safely ────────────────────────────────────────────────

describe('env overrides are parsed safely', () => {
  afterEach(() => {
    delete process.env[ENV_INTERVAL_KEY];
    delete process.env[ENV_MAX_LOOPS_KEY];
  });

  it('integer env values override defaults', () => {
    process.env[ENV_INTERVAL_KEY]  = '5';
    process.env[ENV_MAX_LOOPS_KEY] = '3';
    const { intervalMinutes, maxLoops } = resolveLoopConfig({});
    expect(intervalMinutes).toBe(5);
    expect(maxLoops).toBe(3);
  });

  it('fractional interval is accepted', () => {
    process.env[ENV_INTERVAL_KEY] = '2.5';
    const { intervalMinutes } = resolveLoopConfig({});
    expect(intervalMinutes).toBe(2.5);
  });

  it('non-numeric env values fall back to defaults', () => {
    process.env[ENV_INTERVAL_KEY]  = 'banana';
    process.env[ENV_MAX_LOOPS_KEY] = 'NaN';
    const { intervalMinutes, maxLoops } = resolveLoopConfig({});
    expect(intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(maxLoops).toBe(DEFAULT_MAX_LOOPS);
  });

  it('zero or negative env values fall back to defaults', () => {
    process.env[ENV_INTERVAL_KEY]  = '0';
    process.env[ENV_MAX_LOOPS_KEY] = '-1';
    const { intervalMinutes, maxLoops } = resolveLoopConfig({});
    expect(intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(maxLoops).toBe(DEFAULT_MAX_LOOPS);
  });

  it('opts override takes precedence over env when env is absent', () => {
    delete process.env[ENV_INTERVAL_KEY];
    delete process.env[ENV_MAX_LOOPS_KEY];
    const { intervalMinutes, maxLoops } = resolveLoopConfig({ intervalMinutes: 7, maxLoops: 4 });
    expect(intervalMinutes).toBe(7);
    expect(maxLoops).toBe(4);
  });

  it('env override wins over opts when both are provided', () => {
    process.env[ENV_INTERVAL_KEY]  = '3';
    process.env[ENV_MAX_LOOPS_KEY] = '2';
    const { intervalMinutes, maxLoops } = resolveLoopConfig({ intervalMinutes: 15, maxLoops: 10 });
    expect(intervalMinutes).toBe(3);
    expect(maxLoops).toBe(2);
  });
});

// ── Max loops prevents infinite running ───────────────────────────────────────

describe('max loops prevents infinite running', () => {
  it('runs exactly maxLoops iterations and stops', async () => {
    const MAX = 3;
    let calls = 0;
    const result = await runRipperLearningLoop({
      maxLoops: MAX,
      intervalMinutes: 0,
      _sleep: noop,
      runPaperCycle: async () => { calls++; return okCycleResult(); },
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.loopsCompleted).toBe(MAX);
    expect(result.loopsAttempted).toBe(MAX);
    expect(result.stoppedByMaxLoops).toBe(true);
    expect(result.stoppedByFailure).toBe(false);
    expect(calls).toBe(MAX);
    expect(result.summaries).toHaveLength(MAX);
  });

  it('sleep is called between loops but not after the last', async () => {
    const MAX = 3;
    let sleepCount = 0;
    await runRipperLearningLoop({
      maxLoops: MAX,
      intervalMinutes: 1,
      _sleep: async () => { sleepCount++; },
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(sleepCount).toBe(MAX - 1);
  });

  it('maxLoops=1 runs exactly once with no sleep', async () => {
    let sleepCount = 0;
    let cycleCalls = 0;
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: async () => { sleepCount++; },
      runPaperCycle: async () => { cycleCalls++; return okCycleResult(); },
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(cycleCalls).toBe(1);
    expect(sleepCount).toBe(0);
    expect(result.loopsCompleted).toBe(1);
  });
});

// ── Failed step stops the loop ─────────────────────────────────────────────────

describe('failed step stops the loop', () => {
  it('paper-cycle failure on loop 2 stops before loop 3', async () => {
    let calls = 0;
    const result = await runRipperLearningLoop({
      maxLoops: 5,
      _sleep: noop,
      runPaperCycle: async () => {
        calls++;
        if (calls >= 2) throw new Error('paper cycle exploded');
        return okCycleResult();
      },
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.stoppedByFailure).toBe(true);
    expect(result.stoppedByMaxLoops).toBe(false);
    expect(result.failedLoopNumber).toBe(2);
    expect(result.failedStep).toBe('paper-cycle');
    expect(result.failureReason).toContain('paper cycle exploded');
    expect(result.loopsCompleted).toBe(1);
    expect(result.loopsAttempted).toBe(2);
    expect(calls).toBe(2);
  });

  it('diagnostic failure stops the loop and marks correct step', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 5,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => { throw new Error('diagnostic broke'); },
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.stoppedByFailure).toBe(true);
    expect(result.failedStep).toBe('bubblemaps-diagnostic');
    expect(result.failureReason).toContain('diagnostic broke');
    expect(result.loopsCompleted).toBe(0);
  });

  it('simulation failure stops the loop and marks correct step', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 5,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => { throw new Error('sim crashed'); },
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.stoppedByFailure).toBe(true);
    expect(result.failedStep).toBe('simulation-report');
    expect(result.failureReason).toContain('sim crashed');
  });

  it('autopilot-status failure stops the loop and marks correct step', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 5,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => { throw new Error('status broken'); },
    });
    expect(result.stoppedByFailure).toBe(true);
    expect(result.failedStep).toBe('autopilot-status');
    expect(result.failureReason).toContain('status broken');
  });

  it('summary for failed loop records failedStep and reason', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 3,
      _sleep: noop,
      runPaperCycle: async () => { throw new Error('oops'); },
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].failedStep).toBe('paper-cycle');
    expect(result.summaries[0].failureReason).toContain('oops');
  });
});

// ── Safety text ────────────────────────────────────────────────────────────────

describe('safety text includes DO_NOT_ENABLE_REAL_TRADING and PAPER_ONLY', () => {
  it('rendered result contains DO_NOT_ENABLE_REAL_TRADING', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    const rendered = renderRipperLearningLoopResult(result);
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('rendered result contains PAPER_ONLY', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    const rendered = renderRipperLearningLoopResult(result);
    expect(rendered).toContain('PAPER_ONLY');
  });

  it('rendered result contains HOLD_CURRENT_GATES', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    const rendered = renderRipperLearningLoopResult(result);
    expect(rendered).toContain('HOLD_CURRENT_GATES');
  });

  it('loop summary contains DO_NOT_ENABLE_REAL_TRADING', async () => {
    let capturedSummary: Parameters<NonNullable<Parameters<typeof runRipperLearningLoop>[0]['onLoopComplete']>>[0] | null = null;
    await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
      onLoopComplete: (s) => { capturedSummary = s; },
    });
    expect(capturedSummary).not.toBeNull();
    const rendered = renderRipperLearningLoopSummary(capturedSummary!);
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});

// ── Summary fields ─────────────────────────────────────────────────────────────

describe('loop summary fields', () => {
  it('captures paper cycle approved/rejected counts', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => ({ approved: 7, rejected: 12, bmLiveCalls: 2, bmCacheHits: 5, bmSkipped: 1 }),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.summaries[0].approved).toBe(7);
    expect(result.summaries[0].rejected).toBe(12);
    expect(result.summaries[0].bmLiveCalls).toBe(2);
    expect(result.summaries[0].bmCacheHits).toBe(5);
    expect(result.summaries[0].bmSkipped).toBe(1);
  });

  it('captures cooldown active from diagnostic', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => ({ cooldownActive: true }),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.summaries[0].cooldownActive).toBe(true);
  });

  it('captures simulation recommendation', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => ({ recommendation: 'KEEP_COLLECTING', winRate: 0.44, simulatedTrades: 200 }),
      runAutopilotStatus: () => okAutopilotResult(),
    });
    expect(result.summaries[0].simRecommendation).toBe('KEEP_COLLECTING');
    expect(result.summaries[0].simWinRate).toBe(0.44);
    expect(result.summaries[0].simTrades).toBe(200);
  });

  it('onLoopStart and onLoopComplete callbacks fire in order', async () => {
    const events: string[] = [];
    await runRipperLearningLoop({
      maxLoops: 2,
      _sleep: noop,
      runPaperCycle: async () => okCycleResult(),
      runDiagnostic: () => okDiagResult(),
      runSimulation: () => okSimResult(),
      runAutopilotStatus: () => okAutopilotResult(),
      onLoopStart:    (n) => events.push(`start:${n}`),
      onLoopComplete: (s) => events.push(`complete:${s.loopNumber}`),
    });
    expect(events).toEqual(['start:1', 'complete:1', 'start:2', 'complete:2']);
  });
});
