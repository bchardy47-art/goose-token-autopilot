import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runDexPaperRunner,
  renderDexPaperRunnerReport,
  runFilename,
  type EndpointFetcher,
} from '../src/token-grab/dexPaperRunner';
import type { DexEndpointResult } from '../src/token-grab/dexEars';

// ── Fixtures ────────────────────────────────────────────────────────────────────────

const SOL = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump'; // valid base58 solana addr

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dexpaper-'));
}

function writeConfig(dir: string): string {
  const p = path.join(dir, 'dex-ears.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      chain: 'solana',
      minConfidence: 'medium',
      maxItemsPerEndpoint: 50,
      timeoutMs: 10000,
      endpoints: { latestProfiles: true, latestBoosts: true, topBoosts: true },
    }),
    'utf-8',
  );
  return p;
}

// One profile + one boost for the same solana contract → high-confidence ears signal.
const endpointFetcher: EndpointFetcher = async (): Promise<DexEndpointResult[]> => [
  {
    endpoint: 'latest_profiles',
    fetched: 1,
    items: [{ url: `https://dexscreener.com/solana/${SOL}`, chainId: 'solana', tokenAddress: SOL, header: 'GOOSE' }],
  },
  {
    endpoint: 'latest_boosts',
    fetched: 1,
    items: [{ url: `https://dexscreener.com/solana/${SOL}`, chainId: 'solana', tokenAddress: SOL, header: 'GOOSE' } as any],
  },
];

// Watch fetch: 1st call (entry) price 1, 2nd call (final) price 1.5 → +50% price, +15% liq, low v/l.
function makeWatchFetch(): typeof fetch {
  let call = 0;
  return (async () => {
    call += 1;
    const isEntry = call === 1;
    const body = {
      pairs: [
        {
          chainId: 'solana',
          pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL, symbol: 'GOOSE' },
          priceUsd: isEntry ? '1' : '1.5',
          liquidity: { usd: isEntry ? 10000 : 11500 },
          volume: { h1: 5000 },
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function baseOpts(dir: string) {
  return {
    dexConfigPath: writeConfig(dir),
    signalsOut: path.join(dir, 'presignals.dex.json'),
    runsDir: path.join(dir, 'runs'),
    minutes: 1,
    intervalSeconds: 30,
    fakeBankroll: 20,
    positionSize: 1,
    cycles: 1,
    endpointFetcher,
    watchFetchImpl: makeWatchFetch(),
    sleepImpl: async () => {},
    nowFn: () => new Date('2026-06-07T12:34:56.000Z'),
  };
}

// ── runFilename ──────────────────────────────────────────────────────────────────────

describe('runFilename', () => {
  it('formats run-YYYYMMDD-HHMMSS.json in UTC', () => {
    expect(runFilename(new Date('2026-06-07T12:34:56.000Z'))).toBe('run-20260607-123456.json');
  });
});

// ── One paper cycle ───────────────────────────────────────────────────────────────────

describe('runDexPaperRunner — one cycle', () => {
  it('runs one paper cycle with mocked DEX signals/watch data', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    expect(report.cyclesRequested).toBe(1);
    expect(report.cyclesCompleted).toBe(1);
    expect(report.cycles).toHaveLength(1);
    const c = report.cycles[0];
    expect(c.signalsFound).toBe(1); // one ears signal extracted
    expect(c.contractsWatched).toBe(1);
  });

  it('writes signals to --signals-out', async () => {
    const dir = makeTempDir();
    const opts = baseOpts(dir);
    await runDexPaperRunner(opts);
    expect(fs.existsSync(opts.signalsOut)).toBe(true);
    const signals = JSON.parse(fs.readFileSync(opts.signalsOut, 'utf-8'));
    expect(Array.isArray(signals)).toBe(true);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].contract).toBe(SOL);
  });

  it('saves a watch report to runs-dir/run-*.json', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    const saved = report.cycles[0].savedRunPath;
    expect(saved).toMatch(/run-20260607-123456\.json$/);
    expect(fs.existsSync(saved)).toBe(true);
    const watch = JSON.parse(fs.readFileSync(saved, 'utf-8'));
    expect(watch.winners).toBeDefined();
    expect(watch.tradingExecuted).toBe(0);
  });

  it('simulates candidates and reports fake P/L', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    const c = report.cycles[0];
    expect(c.tradesSimulated).toBe(1); // PASS candidate (+50% price, +15% liq, low v/l)
    expect(c.fakePnlDollars).toBeCloseTo(0.5); // position 1 * 50%
    expect(c.winRate).toBeCloseTo(1.0);
    expect(c.winners).toBe(1);
  });

  it('reports the watch winners/losers/flat counts', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    const c = report.cycles[0];
    expect(c.winners + c.losers + c.flat).toBeGreaterThanOrEqual(1);
  });
});

// ── Cycles ────────────────────────────────────────────────────────────────────────────

describe('runDexPaperRunner — cycles', () => {
  it('respects --cycles', async () => {
    const dir = makeTempDir();
    let t = 0;
    const opts = {
      ...baseOpts(dir),
      cycles: 3,
      watchFetchImpl: makeWatchFetch(),
      // advance time each call so run filenames differ
      nowFn: () => new Date(Date.parse('2026-06-07T12:00:00.000Z') + (t++) * 1000),
    };
    const report = await runDexPaperRunner(opts);
    expect(report.cyclesRequested).toBe(3);
    expect(report.cyclesCompleted).toBe(3);
    expect(report.cycles.map(c => c.cycle)).toEqual([1, 2, 3]);
  });
});

// ── Report shape / safety ──────────────────────────────────────────────────────────────

describe('runDexPaperRunner — report safety', () => {
  it('always reports no real trading', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    expect(report.tradingExecuted).toBe(0);
    expect(report.noRealTradeSent).toBe(true);
    expect(report.dryRun).toBe(false);
  });
});

describe('renderDexPaperRunnerReport', () => {
  it('includes PAPER ONLY, NO REAL TRADE SENT and tradingExecuted: 0', async () => {
    const dir = makeTempDir();
    const report = await runDexPaperRunner(baseOpts(dir));
    const out = renderDexPaperRunnerReport(report);
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toMatch(/Fake P\/L/);
  });

  it('contains no trading / swap / signing terms beyond explicit negations', async () => {
    const dir = makeTempDir();
    const out = renderDexPaperRunnerReport(await runDexPaperRunner(baseOpts(dir)));
    expect(out).not.toMatch(/LIVE_EXECUTED/);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toMatch(/sign(ing)? transaction/i);
    for (const word of ['swap', 'wallet', 'signing']) {
      const lines = out.split('\n').filter(l => l.toLowerCase().includes(word));
      for (const l of lines) expect(l.toLowerCase()).toMatch(/no /);
    }
  });
});

describe('dexPaperRunner source safety', () => {
  it('module exposes no wallet / key / swap / signing / browser primitives', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexPaperRunner.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|seed phrase|wallet\.connect|jupiter\.swap|executeSwap|LIVE_EXECUTED|puppeteer|playwright|selenium/i);
  });
});
