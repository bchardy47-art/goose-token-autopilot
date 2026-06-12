import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as freshPoolFeedModule from '../src/token-grab/freshPoolFeed';
import {
  dexWatchOutcomeToEarSignal,
  freshPoolToEarSignal,
  findMostRecentRunFile,
  loadOutcomesFromRunFile,
  runFreshPoolFeed,
  renderFreshPoolFeedResult,
  ageMinutes,
} from '../src/token-grab/freshPoolFeed';
import { runLiveFixtureCapture } from '../src/token-grab/liveFixtureCapture';

// ── Time anchor ───────────────────────────────────────────────────────────────

// Pool observed 8 minutes ago → PRIME_WINDOW
const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const EIGHT_MIN_AGO  = new Date(NOW_MS - 8  * 60_000).toISOString();
const THIRTY_MIN_AGO = new Date(NOW_MS - 30 * 60_000).toISOString();
const TWO_HR_AGO     = new Date(NOW_MS - 120 * 60_000).toISOString();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOutcome(overrides: Partial<{
  contract: string;
  symbol: string;
  observedAt: string;
  priceChangePct: number;
  liquidityChangePct: number;
  volumeToLiquidityRatio: number;
  classification: string;
  liquidityUsd: number;
  pairAddress: string;
}> = {}) {
  return {
    signalId: 'dex-test-001',
    contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
    symbol: overrides.symbol ?? 'FRESH',
    chainId: 'solana',
    pairUrl: 'https://dexscreener.com/solana/testpair',
    entry: {
      contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId: 'solana',
      pairAddress: overrides.pairAddress ?? 'PairAAA111',
      symbol: overrides.symbol ?? 'FRESH',
      priceUsd: 0.00015,
      liquidityUsd: overrides.liquidityUsd ?? 25000,
      volumeUsd: 50000,
      observedAt: overrides.observedAt ?? EIGHT_MIN_AGO,
    },
    final: {
      contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId: 'solana',
      observedAt: NOW_ISO,
    },
    priceChangePct: overrides.priceChangePct ?? 45.0,
    liquidityChangePct: overrides.liquidityChangePct ?? 12.0,
    volumeToLiquidityRatio: overrides.volumeToLiquidityRatio ?? 2.0,
    classification: overrides.classification ?? 'winner',
  };
}

function makeFreshPool(overrides: Partial<{
  contractAddress: string;
  ticker: string;
  tokenName: string;
  createdAt: string;
  liquidityUsd: number;
  volume5mUsd: number;
  poolAddress: string;
}> = {}) {
  return {
    id: 'fp-test-001',
    contractAddress: overrides.contractAddress ?? 'GooseContractXXX111222333444555666777888',
    ticker: overrides.ticker ?? 'GOOSE',
    tokenName: overrides.tokenName ?? 'Goose Token',
    createdAt: overrides.createdAt ?? EIGHT_MIN_AGO,
    liquidityUsd: overrides.liquidityUsd ?? 45000,
    volume5mUsd: overrides.volume5mUsd ?? 8200,
    poolAddress: overrides.poolAddress ?? 'GoosePool111',
    source: 'fixture',
  };
}

function makeRunFile(outcomes: object[], generatedAt = NOW_ISO): object {
  const all = outcomes;
  const winners = all.filter((o: any) => o.classification === 'winner');
  const flat    = all.filter((o: any) => o.classification === 'flat');
  const losers  = all.filter((o: any) => o.classification === 'loser');
  const missing = all.filter((o: any) => o.classification === 'missing');
  return { generatedAt, signalsRead: all.length, winners, flat, losers, missing };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpf-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunsDir(runFiles: Record<string, object>): string {
  const runsDir = path.join(tmpDir, 'dex-watch-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (const [name, content] of Object.entries(runFiles)) {
    fs.writeFileSync(path.join(runsDir, name), JSON.stringify(content));
  }
  return runsDir;
}

// ── dexWatchOutcomeToEarSignal ────────────────────────────────────────────────

describe('dexWatchOutcomeToEarSignal', () => {
  it('produces a RipperEarSignal with required fields', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome(), NOW_ISO);
    expect(sig.id).toBeTruthy();
    expect(sig.source).toBe('dex-watch-run');
    expect(sig.sourceKind).toBe('DEX_NEW_POOL');
    expect(sig.contract).toBe(makeOutcome().contract);
  });

  it('uses entry.observedAt as discoveredAt', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ observedAt: EIGHT_MIN_AGO }), NOW_ISO);
    expect(sig.discoveredAt).toBe(EIGHT_MIN_AGO);
    expect(sig.observedAt).toBe(NOW_ISO);
  });

  it('preserves symbol, priceChangePct, liquidityChangePct, vlr', () => {
    const o   = makeOutcome({ symbol: 'FRESH', priceChangePct: 55.5, liquidityChangePct: 10.2, volumeToLiquidityRatio: 3.1 });
    const sig = dexWatchOutcomeToEarSignal(o, NOW_ISO);
    expect(sig.symbol).toBe('FRESH');
    expect(sig.priceChangePct).toBe(55.5);
    expect(sig.liquidityChangePct).toBe(10.2);
    expect(sig.volumeLiquidityRatio).toBe(3.1);
  });

  it('maps winner + >40% to HIGH confidence', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ classification: 'winner', priceChangePct: 50 }), NOW_ISO);
    expect(sig.confidence).toBe('HIGH');
  });

  it('maps winner + <40% to MEDIUM confidence', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ classification: 'winner', priceChangePct: 30 }), NOW_ISO);
    expect(sig.confidence).toBe('MEDIUM');
  });

  it('maps flat classification to LOW confidence', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ classification: 'flat', priceChangePct: 5 }), NOW_ISO);
    expect(sig.confidence).toBe('LOW');
  });

  it('maps loser classification to UNKNOWN confidence', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ classification: 'loser', priceChangePct: -30 }), NOW_ISO);
    expect(sig.confidence).toBe('UNKNOWN');
  });

  it('includes classification in signalReasons', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ classification: 'winner' }), NOW_ISO);
    expect(sig.signalReasons.some(r => r.includes('winner'))).toBe(true);
  });

  it('includes price change in signalReasons', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ priceChangePct: 45.0 }), NOW_ISO);
    expect(sig.signalReasons.some(r => r.includes('+45.0%'))).toBe(true);
  });

  it('uses nowIso as discoveredAt when entry.observedAt missing', () => {
    const o = { ...makeOutcome(), entry: undefined };
    const sig = dexWatchOutcomeToEarSignal(o as any, NOW_ISO);
    expect(sig.discoveredAt).toBe(NOW_ISO);
    expect(sig.warnings.some(w => w.includes('observedAt missing'))).toBe(true);
  });

  it('preserves liquidityUsd from entry', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ liquidityUsd: 30000 }), NOW_ISO);
    expect(sig.liquidityUsd).toBe(30000);
  });

  it('preserves pairAddress as poolAddress', () => {
    const sig = dexWatchOutcomeToEarSignal(makeOutcome({ pairAddress: 'PairXXX999' }), NOW_ISO);
    expect(sig.poolAddress).toBe('PairXXX999');
  });
});

// ── freshPoolToEarSignal ──────────────────────────────────────────────────────

describe('freshPoolToEarSignal', () => {
  it('produces a RipperEarSignal from a FreshPool', () => {
    const sig = freshPoolToEarSignal(makeFreshPool(), NOW_ISO);
    expect(sig).not.toBeNull();
    expect(sig!.source).toBe('gecko-fresh-pools');
    expect(sig!.sourceKind).toBe('DEX_NEW_POOL');
    expect(sig!.contract).toBe(makeFreshPool().contractAddress);
  });

  it('uses createdAt as discoveredAt', () => {
    const sig = freshPoolToEarSignal(makeFreshPool({ createdAt: EIGHT_MIN_AGO }), NOW_ISO);
    expect(sig!.discoveredAt).toBe(EIGHT_MIN_AGO);
    expect(sig!.observedAt).toBe(NOW_ISO);
  });

  it('preserves symbol (ticker) and name', () => {
    const sig = freshPoolToEarSignal(makeFreshPool({ ticker: 'GOOSE', tokenName: 'Goose Token' }), NOW_ISO);
    expect(sig!.symbol).toBe('GOOSE');
    expect(sig!.name).toBe('Goose Token');
  });

  it('computes VLR from liquidityUsd and volume5mUsd', () => {
    const sig = freshPoolToEarSignal(makeFreshPool({ liquidityUsd: 10000, volume5mUsd: 5000 }), NOW_ISO);
    expect(sig!.volumeLiquidityRatio).toBeCloseTo(0.5);
  });

  it('sets MEDIUM confidence when liquidity >= 10000', () => {
    const sig = freshPoolToEarSignal(makeFreshPool({ liquidityUsd: 15000 }), NOW_ISO);
    expect(sig!.confidence).toBe('MEDIUM');
  });

  it('sets LOW confidence when liquidity < 10000', () => {
    const sig = freshPoolToEarSignal(makeFreshPool({ liquidityUsd: 5000 }), NOW_ISO);
    expect(sig!.confidence).toBe('LOW');
  });

  it('returns null when contractAddress is missing', () => {
    const pool = { ...makeFreshPool(), contractAddress: undefined };
    expect(freshPoolToEarSignal(pool as any, NOW_ISO)).toBeNull();
  });

  it('warns when createdAt is missing', () => {
    const pool = { ...makeFreshPool(), createdAt: undefined };
    const sig  = freshPoolToEarSignal(pool as any, NOW_ISO);
    expect(sig!.warnings.some(w => w.includes('createdAt missing'))).toBe(true);
  });
});

// ── findMostRecentRunFile ─────────────────────────────────────────────────────

describe('findMostRecentRunFile', () => {
  it('returns null when directory does not exist', () => {
    expect(findMostRecentRunFile(path.join(tmpDir, 'no-such-dir'))).toBeNull();
  });

  it('returns null when directory is empty', () => {
    const dir = path.join(tmpDir, 'empty-runs');
    fs.mkdirSync(dir);
    expect(findMostRecentRunFile(dir)).toBeNull();
  });

  it('returns the most recent run file by name sort', () => {
    const dir = makeRunsDir({
      'run-20260607-120000.json': {},
      'run-20260608-080000.json': {},
      'run-20260610-042303.json': {},
    });
    const result = findMostRecentRunFile(dir);
    expect(result).toContain('run-20260610-042303.json');
  });

  it('ignores non-run-*.json files', () => {
    const dir = makeRunsDir({
      'run-20260609-100000.json': {},
      'not-a-run.json': {},
      'run-20260610-050000.json': {},
    });
    const result = findMostRecentRunFile(dir);
    expect(result).toContain('run-20260610-050000.json');
  });
});

// ── loadOutcomesFromRunFile ───────────────────────────────────────────────────

describe('loadOutcomesFromRunFile', () => {
  it('loads winners, flat, losers, missing into flat outcomes array', () => {
    const runFile = path.join(tmpDir, 'run-test.json');
    fs.writeFileSync(runFile, JSON.stringify({
      generatedAt: NOW_ISO,
      winners: [makeOutcome({ classification: 'winner' })],
      flat:    [makeOutcome({ classification: 'flat', contract: 'FlatContract111' })],
      losers:  [makeOutcome({ classification: 'loser', contract: 'LoserContract222' })],
      missing: [],
    }));
    const { outcomes } = loadOutcomesFromRunFile(runFile);
    expect(outcomes).toHaveLength(3);
  });

  it('handles missing array fields gracefully', () => {
    const runFile = path.join(tmpDir, 'run-partial.json');
    fs.writeFileSync(runFile, JSON.stringify({ generatedAt: NOW_ISO, winners: [makeOutcome()] }));
    const { outcomes } = loadOutcomesFromRunFile(runFile);
    expect(outcomes).toHaveLength(1);
  });

  it('returns warnings on parse error', () => {
    const runFile = path.join(tmpDir, 'run-bad.json');
    fs.writeFileSync(runFile, 'NOT_JSON');
    const { outcomes, warnings } = loadOutcomesFromRunFile(runFile);
    expect(outcomes).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ── runFreshPoolFeed — missing source ─────────────────────────────────────────

describe('runFreshPoolFeed — missing source', () => {
  it('does not crash when runs dir does not exist', () => {
    const result = runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such-dir'),
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.sourceMissing).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('gives helpful nextStep hint pointing to token:dex-day-watch', () => {
    const result = runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such-dir'),
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.nextStep).toContain('token:dex-day-watch');
  });

  it('does not write output file when no source', () => {
    const out = path.join(tmpDir, 'out.json');
    runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such-dir'),
      outputPath: out,
      nowMs: NOW_MS,
    });
    expect(fs.existsSync(out)).toBe(false);
  });

  it('noFreshSignals=false when runs dir is missing entirely', () => {
    const result = runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such-dir'),
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.sourceMissing).toBe(true);
    expect(result.noFreshSignals).toBe(false);
  });
});

// ── runFreshPoolFeed — all old (skipped) ──────────────────────────────────────

describe('runFreshPoolFeed — all candidates too old', () => {
  it('returns noFreshSignals=true, skippedOldCount > 0 when all too old', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      maxAgeMinutes: 60,
      nowMs: NOW_MS,
    });
    expect(result.noFreshSignals).toBe(true);
    expect(result.skippedOldCount).toBe(1);
    expect(result.signalsWritten).toBe(0);
    expect(result.sourceMissing).toBe(false);
    expect(result.sourceUsed).toBeTruthy();
  });

  it('does not write output file when all candidates too old', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const out = path.join(tmpDir, 'out.json');
    runFreshPoolFeed({ runsDir, outputPath: out, maxAgeMinutes: 60, nowMs: NOW_MS });
    expect(fs.existsSync(out)).toBe(false);
  });

  it('nextStep hints at token:dex-day-watch when all too old', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), maxAgeMinutes: 60, nowMs: NOW_MS,
    });
    expect(result.nextStep).toContain('token:dex-day-watch');
  });
});

// ── runFreshPoolFeed — fresh data ─────────────────────────────────────────────

describe('runFreshPoolFeed — fresh data present', () => {
  it('reads fresh run file and writes signals', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    expect(result.sourceMissing).toBe(false);
    expect(result.noFreshSignals).toBe(false);
    expect(result.signalsWritten).toBe(1);
    expect(fs.existsSync(out)).toBe(true);
  });

  it('skips old candidates and keeps fresh ones', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'FreshToken111' }),
        makeOutcome({ observedAt: TWO_HR_AGO,    contract: 'OldToken222' }),
      ]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, maxAgeMinutes: 60, nowMs: NOW_MS });
    expect(result.signalsWritten).toBe(1);
    expect(result.skippedOldCount).toBe(1);
    expect(result.signals[0].contract).toBe('FreshToken111');
  });

  it('includes old candidates when includeOld=true', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO }),
        makeOutcome({ observedAt: TWO_HR_AGO, contract: 'OldToken222' }),
      ]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, includeOld: true, nowMs: NOW_MS });
    expect(result.signalsWritten).toBe(2);
    expect(result.skippedOldCount).toBe(0);
  });

  it('respects custom maxAgeMinutes', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'FreshToken111' }),
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'LateToken333' }),
        makeOutcome({ observedAt: TWO_HR_AGO,    contract: 'DeadToken444' }),
      ]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, maxAgeMinutes: 20, nowMs: NOW_MS });
    expect(result.signalsWritten).toBe(1);
    expect(result.skippedOldCount).toBe(2);
    expect(result.signals[0].contract).toBe('FreshToken111');
  });

  it('creates output directory if it does not exist', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const out = path.join(tmpDir, 'nested', 'deep', 'out.json');
    runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    expect(fs.existsSync(out)).toBe(true);
  });

  it('writeVerified is true after successful write', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    expect(result.writeVerified).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  });

  it('output file is valid ear-signals JSON', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const out = path.join(tmpDir, 'out.json');
    runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(Array.isArray(written.signals)).toBe(true);
    expect(written.signals[0].sourceKind).toBe('DEX_NEW_POOL');
    expect(written.signals[0].contract).toBeTruthy();
  });

  it('uses the MOST RECENT run file when multiple exist', () => {
    const older  = makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'OlderRunToken' })]);
    const newer  = makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'NewerRunToken' })]);
    const runsDir = makeRunsDir({
      'run-20260608-120000.json': older,
      'run-20260610-150000.json': newer,
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    expect(result.signals[0].contract).toBe('NewerRunToken');
  });

  it('all safety fields present on success', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── freshness metrics ─────────────────────────────────────────────────────────

describe('freshPoolFeed freshness metrics', () => {
  it('computes primeWindowCount correctly (2–20 min)', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO,  contract: 'PrimeTok1' }),  // 8m → PRIME
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'LateTok2' }),   // 30m → LATE
        makeOutcome({ observedAt: new Date(NOW_MS - 1 * 60_000).toISOString(), contract: 'EarlyTok3' }), // 1m → TOO_EARLY
      ]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), maxAgeMinutes: 60, nowMs: NOW_MS,
    });
    expect(result.primeWindowCount).toBe(1);
  });

  it('reports freshestAgeMinutes as minimum age of fresh signals', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO,  contract: 'FreshTok1' }),
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'LateTok2' }),
      ]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), maxAgeMinutes: 60, nowMs: NOW_MS,
    });
    expect(result.freshestAgeMinutes).not.toBeNull();
    expect(result.freshestAgeMinutes!).toBeCloseTo(8, 0);
  });

  it('rawCandidatesRead includes all classification types', () => {
    const runFile = makeRunFile([
      makeOutcome({ classification: 'winner', contract: 'W1', observedAt: EIGHT_MIN_AGO }),
      makeOutcome({ classification: 'flat',   contract: 'F1', observedAt: EIGHT_MIN_AGO }),
      makeOutcome({ classification: 'loser',  contract: 'L1', observedAt: EIGHT_MIN_AGO }),
      makeOutcome({ classification: 'missing', contract: 'M1', observedAt: EIGHT_MIN_AGO }),
    ]);
    const runsDir = makeRunsDir({ 'run-20260610-100000.json': runFile });
    const result  = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    expect(result.rawCandidatesRead).toBe(4);
    expect(result.signalsWritten).toBe(4);
  });
});

// ── integration: fresh-pool-feed → live-fixture-capture ──────────────────────

describe('runFreshPoolFeed — integration with live-fixture-capture', () => {
  it('fresh-pool-feed → capture → report: fixture count > 0', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const feedOutputPath = path.join(tmpDir, 'ripper-ears-input.json');
    const fixturesPath   = path.join(tmpDir, 'live-fixtures.jsonl');

    // Step 1: fresh-pool-feed
    const feedResult = runFreshPoolFeed({
      runsDir,
      outputPath: feedOutputPath,
      nowMs: NOW_MS,
    });
    expect(feedResult.signalsWritten).toBe(1);
    expect(feedResult.writeVerified).toBe(true);
    expect(fs.existsSync(feedOutputPath)).toBe(true);

    // Step 2: live-fixture-capture reads the output
    const captureResult = await runLiveFixtureCapture({
      inputPath: feedOutputPath,
      outputPath: fixturesPath,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(captureResult.inputMissing).toBe(false);
    expect(captureResult.capturedCount).toBe(1);
    expect(captureResult.tradingExecuted).toBe(0);
    expect(fs.existsSync(fixturesPath)).toBe(true);
  });

  it('fresh signal in prime window scores as PRIME_WINDOW', async () => {
    // 8 minutes ago → PRIME_WINDOW (2–20m)
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const feedOutputPath = path.join(tmpDir, 'ripper-ears-input.json');
    const fixturesPath   = path.join(tmpDir, 'live-fixtures.jsonl');

    runFreshPoolFeed({ runsDir, outputPath: feedOutputPath, nowMs: NOW_MS });
    await runLiveFixtureCapture({
      inputPath: feedOutputPath,
      outputPath: fixturesPath,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });

    const lines = fs.readFileSync(fixturesPath, 'utf-8').trim().split('\n');
    const fixture = JSON.parse(lines[0]);
    expect(fixture.launchAgeBucket).toBe('PRIME_WINDOW');
    expect(fixture.realTradingLocked).toBe(true);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderFreshPoolFeedResult', () => {
  it('renders missing-source state with dex-day-watch hint', () => {
    const result = runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such-dir'),
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    const out = renderFreshPoolFeedResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('token:dex-day-watch');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders all-too-old state with dex-day-watch hint', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    const out = renderFreshPoolFeedResult(result);
    expect(out).toContain('token:dex-day-watch');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders success state with ✓ Written', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    const out = renderFreshPoolFeedResult(result);
    expect(out).toContain('✓ Written');
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
    expect(out).not.toContain('WRITE FAILED');
  });

  it('renders WRITE FAILED when writeVerified is false', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    const failedResult = { ...result, writeVerified: false };
    const out = renderFreshPoolFeedResult(failedResult);
    expect(out).toContain('WRITE FAILED');
  });
});

// ── prime window prefilter — default maxAgeMinutes=20 ────────────────────────

describe('runFreshPoolFeed — prime window prefilter (default maxAgeMinutes=20)', () => {
  it('filters LATE signal (30m ago) without explicit maxAgeMinutes', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: THIRTY_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.noFreshSignals).toBe(true);
    expect(result.signalsWritten).toBe(0);
    expect(result.skippedOldCount).toBe(1);
  });

  it('filters 2h-old signal without explicit maxAgeMinutes', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.noFreshSignals).toBe(true);
    expect(result.skippedOldCount).toBe(1);
  });

  it('passes PRIME_WINDOW signal (8m ago) through default filter', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.signalsWritten).toBe(1);
    expect(result.skippedOldCount).toBe(0);
  });

  it('keeps PRIME_WINDOW signals and drops LATE signals using default filter', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO,  contract: 'PrimeToken111' }),
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'LateToken222' }),
        makeOutcome({ observedAt: TWO_HR_AGO,     contract: 'DeadToken333' }),
      ]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.signalsWritten).toBe(1);
    expect(result.skippedOldCount).toBe(2);
    expect(result.signals[0].contract).toBe('PrimeToken111');
  });

  it('skippedOldCount is visible in renderer output', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO,  contract: 'PrimeToken111' }),
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'LateToken222' }),
      ]),
    });
    const out = path.join(tmpDir, 'out.json');
    const result = runFreshPoolFeed({ runsDir, outputPath: out, nowMs: NOW_MS });
    const rendered = renderFreshPoolFeedResult(result);
    expect(rendered).toContain('Skipped (old)  : 1');
    expect(rendered).toContain('Signals written: 1');
  });

  it('missing observedAt falls back to now and is treated as fresh (age ≈ 0)', () => {
    const outcome = { ...makeOutcome(), entry: undefined };
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([outcome as any]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    // Falls back to nowIso in dexWatchOutcomeToEarSignal → age ≈ 0 → passes default 20m filter
    expect(result.signalsWritten).toBe(1);
    expect(result.signals[0].warnings.some((w: string) => w.includes('observedAt missing'))).toBe(true);
  });

  it('--include-old bypasses the prime window prefilter', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: THIRTY_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir,
      outputPath: path.join(tmpDir, 'out.json'),
      includeOld: true,
      nowMs: NOW_MS,
    });
    expect(result.signalsWritten).toBe(1);
    expect(result.skippedOldCount).toBe(0);
  });
});

// ── ageMinutes helper ─────────────────────────────────────────────────────────

describe('ageMinutes', () => {
  it('returns ~8 for 8-min-ago timestamp', () => {
    expect(ageMinutes(EIGHT_MIN_AGO, NOW_MS)).toBeCloseTo(8, 1);
  });

  it('returns ~120 for 2-hour-ago timestamp', () => {
    expect(ageMinutes(TWO_HR_AGO, NOW_MS)).toBeCloseTo(120, 1);
  });
});

// ── safety ────────────────────────────────────────────────────────────────────

describe('safety — no live trading', () => {
  it('freshPoolFeed.ts exports do not contain signing/swap names', () => {
    const keys    = Object.keys(freshPoolFeedModule);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('result always has tradingExecuted=0 and safety flags when no source', () => {
    const result = runFreshPoolFeed({
      runsDir: path.join(tmpDir, 'no-such'),
      outputPath: path.join(tmpDir, 'out.json'),
      nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('result always has tradingExecuted=0 and safety flags when fresh data found', () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = runFreshPoolFeed({
      runsDir, outputPath: path.join(tmpDir, 'out.json'), nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
