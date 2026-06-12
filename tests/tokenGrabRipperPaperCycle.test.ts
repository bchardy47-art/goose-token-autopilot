import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperPaperCycle,
  makeCycleSlug,
  renderRipperPaperCycleResult,
} from '../src/token-grab/ripperPaperCycle';
import { offlineClusterRiskProvider } from '../src/token-grab/clusterRiskProvider';

// ── Time anchor ───────────────────────────────────────────────────────────────

const NOW_MS       = 1_700_000_000_000;
const NOW_ISO      = new Date(NOW_MS).toISOString();
const ONE_MIN_AGO    = new Date(NOW_MS - 1  * 60_000).toISOString();
const EIGHT_MIN_AGO  = new Date(NOW_MS - 8  * 60_000).toISOString();
const THIRTY_MIN_AGO = new Date(NOW_MS - 30 * 60_000).toISOString();
const TWO_HR_AGO     = new Date(NOW_MS - 120 * 60_000).toISOString();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOutcome(overrides: Partial<{
  contract: string;
  observedAt: string;
  classification: string;
  priceChangePct: number;
}> = {}) {
  return {
    signalId: 'test-001',
    contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
    symbol: 'FRESH',
    chainId: 'solana',
    pairUrl: 'https://dexscreener.com/solana/testpair',
    entry: {
      contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId: 'solana',
      pairAddress: 'PairAAA111',
      symbol: 'FRESH',
      priceUsd: 0.00015,
      liquidityUsd: 25000,
      volumeUsd: 50000,
      observedAt: overrides.observedAt ?? EIGHT_MIN_AGO,
    },
    final: {
      contract: overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId: 'solana',
      observedAt: NOW_ISO,
    },
    priceChangePct: overrides.priceChangePct ?? 45.0,
    liquidityChangePct: 12.0,
    volumeToLiquidityRatio: 2.0,
    classification: overrides.classification ?? 'winner',
  };
}

function makeRunFile(outcomes: object[]): object {
  const winners = outcomes.filter((o: any) => o.classification === 'winner');
  const flat    = outcomes.filter((o: any) => o.classification === 'flat');
  const losers  = outcomes.filter((o: any) => o.classification === 'loser');
  const missing = outcomes.filter((o: any) => !['winner', 'flat', 'loser'].includes((o as any).classification));
  return { generatedAt: NOW_ISO, signalsRead: outcomes.length, winners, flat, losers, missing };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunsDir(runFiles: Record<string, object>): string {
  const dir = path.join(tmpDir, 'dex-watch-runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(runFiles)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

// ── makeCycleSlug ─────────────────────────────────────────────────────────────

describe('makeCycleSlug', () => {
  it('produces a filesystem-safe slug from nowMs', () => {
    const slug = makeCycleSlug(NOW_MS);
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
  });

  it('does not contain colons or T', () => {
    const slug = makeCycleSlug(NOW_MS);
    expect(slug).not.toContain(':');
    expect(slug).not.toContain('T');
  });

  it('is deterministic for the same nowMs', () => {
    expect(makeCycleSlug(NOW_MS)).toBe(makeCycleSlug(NOW_MS));
  });
});

// ── no run files ──────────────────────────────────────────────────────────────

describe('runRipperPaperCycle — no run files', () => {
  it('exits cleanly with captureSkipped=true', async () => {
    const result = await runRipperPaperCycle({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      nowMs:      NOW_MS,
    });
    expect(result.captureSkipped).toBe(true);
    expect(result.fixturesCaptured).toBe(0);
    expect(result.feedSignalsWritten).toBe(0);
  });

  it('captureSkipReason mentions missing run files', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    expect(result.captureSkipReason).toMatch(/no dex-watch run files/);
  });

  it('outputPath is null when capture skipped', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    expect(result.outputPath).toBeNull();
  });

  it('all safety fields present', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── all stale candidates ──────────────────────────────────────────────────────

describe('runRipperPaperCycle — all candidates stale', () => {
  it('exits cleanly with captureSkipped=true', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir, cyclesDir: path.join(tmpDir, 'cycles'), nowMs: NOW_MS,
    });
    expect(result.captureSkipped).toBe(true);
    expect(result.feedSkippedOldCount).toBe(1);
    expect(result.feedSignalsWritten).toBe(0);
    expect(result.fixturesCaptured).toBe(0);
  });

  it('captureSkipReason mentions stale candidates', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir, cyclesDir: path.join(tmpDir, 'cycles'), nowMs: NOW_MS,
    });
    expect(result.captureSkipReason).toMatch(/older than prime window/);
  });

  it('does not create fixture jsonl file when capture skipped', async () => {
    const runsDir  = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const cyclesDir = path.join(tmpDir, 'cycles');
    await runRipperPaperCycle({ runsDir, cyclesDir, nowMs: NOW_MS });
    const files = fs.existsSync(cyclesDir) ? fs.readdirSync(cyclesDir) : [];
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    expect(jsonlFiles).toHaveLength(0);
  });

  it('feed output file still exists with empty signals (no stale reuse)', async () => {
    const runsDir  = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const cyclesDir = path.join(tmpDir, 'cycles');
    const result = await runRipperPaperCycle({ runsDir, cyclesDir, nowMs: NOW_MS });
    expect(fs.existsSync(result.feedOutputPath)).toBe(true);
    const feed = JSON.parse(fs.readFileSync(result.feedOutputPath, 'utf-8'));
    expect(feed.signals).toEqual([]);
  });

  it('all safety fields present', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir, cyclesDir: path.join(tmpDir, 'cycles'), nowMs: NOW_MS,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── fresh signals present ─────────────────────────────────────────────────────

describe('runRipperPaperCycle — fresh signals present', () => {
  it('runs capture and returns fixturesCaptured > 0', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.captureSkipped).toBe(false);
    expect(result.feedSignalsWritten).toBe(1);
    expect(result.fixturesCaptured).toBe(1);
  });

  it('outputPath points to unique cycle jsonl file', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.outputPath).not.toBeNull();
    expect(result.outputPath!).toContain('cycles');
    expect(result.outputPath!).toMatch(/\.jsonl$/);
    expect(fs.existsSync(result.outputPath!)).toBe(true);
  });

  it('feed output and fixture output paths share the same cycle slug', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.feedOutputPath).toContain(result.cycleSlug);
    expect(result.outputPath!).toContain(result.cycleSlug);
  });

  it('clusterRiskCounts totals equal fixturesCaptured', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'TokenAAA' }),
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'TokenBBB' }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    const total = Object.values(result.clusterRiskCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.fixturesCaptured);
  });

  it('offline provider registers 0 bubblemapsProviderCount', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.bubblemapsProviderCount).toBe(0);
  });

  it('buyApprovedPaper + buyRejected equals fixturesCaptured', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'TokenAAA' }),
        makeOutcome({ observedAt: EIGHT_MIN_AGO, contract: 'TokenBBB' }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.buyApprovedPaper + result.buyRejected).toBe(result.fixturesCaptured);
  });

  it('all safety fields present', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('cycle-level output does not reuse default ripper-ears-input.json path', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.feedOutputPath).not.toContain('ripper-ears-input.json');
    expect(result.outputPath).not.toContain('live-fixtures.jsonl');
  });
});

// ── mixed: fresh + stale in same run ──────────────────────────────────────────

describe('runRipperPaperCycle — mixed fresh and stale', () => {
  it('only fresh signals pass through to capture', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ observedAt: EIGHT_MIN_AGO,  contract: 'FreshToken' }),
        makeOutcome({ observedAt: THIRTY_MIN_AGO, contract: 'StaleToken' }),
        makeOutcome({ observedAt: TWO_HR_AGO,     contract: 'DeadToken'  }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    expect(result.captureSkipped).toBe(false);
    expect(result.feedSignalsWritten).toBe(1);
    expect(result.feedSkippedOldCount).toBe(2);
    expect(result.fixturesCaptured).toBe(1);
  });
});

// ── recheck-aware session dedupe ──────────────────────────────────────────────

describe('runRipperPaperCycle — recheck-aware dedupe', () => {
  it('TOO_EARLY signal is not added to seenContracts', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'TooEarlyToken', observedAt: ONE_MIN_AGO }),
      ]),
    });
    const seenContracts = new Set<string>();
    await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
      seenContracts,
    });
    expect(seenContracts.has('TooEarlyToken')).toBe(false);
    expect(seenContracts.size).toBe(0);
  });

  it('tooEarlyRecheckableCount is 1 for a TOO_EARLY signal', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'TooEarlyToken', observedAt: ONE_MIN_AGO }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    expect(result.tooEarlyRecheckableCount).toBe(1);
  });

  it('PRIME_WINDOW signal IS added to seenContracts', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'PrimeToken', observedAt: EIGHT_MIN_AGO }),
      ]),
    });
    const seenContracts = new Set<string>();
    await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
      seenContracts,
    });
    expect(seenContracts.has('PrimeToken')).toBe(true);
  });

  it('tooEarlyRecheckableCount is 0 for a PRIME_WINDOW signal', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'PrimeToken', observedAt: EIGHT_MIN_AGO }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    expect(result.tooEarlyRecheckableCount).toBe(0);
  });

  it('TOO_EARLY candidate is processed again in later cycle when time advances', async () => {
    const contract = 'TimeAdvancingToken';
    const runsDir  = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract, observedAt: ONE_MIN_AGO }),
      ]),
    });
    const cyclesDir     = path.join(tmpDir, 'cycles');
    const seenContracts = new Set<string>();

    // Cycle 1: token is 1 min old → TOO_EARLY → NOT added to seenContracts
    const r1 = await runRipperPaperCycle({
      runsDir, cyclesDir, nowMs: NOW_MS, seenContracts,
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    expect(r1.tooEarlyRecheckableCount).toBe(1);
    expect(seenContracts.has(contract)).toBe(false);

    // Cycle 2: 7 minutes later, token is 8 min old → PRIME_WINDOW → processed normally
    const laterMs = NOW_MS + 7 * 60_000;
    const r2 = await runRipperPaperCycle({
      runsDir, cyclesDir, nowMs: laterMs, seenContracts,
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    expect(r2.seenSkippedCount).toBe(0);   // not deduped — seenContracts was empty
    expect(r2.fixturesCaptured).toBe(1);   // processed again
    expect(r2.tooEarlyRecheckableCount).toBe(0);
    expect(seenContracts.has(contract)).toBe(true); // added after PRIME_WINDOW processing
  });

  it('mixed: TOO_EARLY not deduped, PRIME_WINDOW deduped', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'TooEarlyToken', observedAt: ONE_MIN_AGO }),
        makeOutcome({ contract: 'PrimeToken',    observedAt: EIGHT_MIN_AGO }),
      ]),
    });
    const seenContracts = new Set<string>();
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
      seenContracts,
    });
    expect(result.tooEarlyRecheckableCount).toBe(1);
    expect(seenContracts.has('TooEarlyToken')).toBe(false);
    expect(seenContracts.has('PrimeToken')).toBe(true);
  });

  it('tooEarlyRecheckableCount is 0 on all early-return paths', async () => {
    // No run files → early return from feed missing
    const r1 = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    expect(r1.tooEarlyRecheckableCount).toBe(0);

    // Stale signals → early return from 0 feed signals
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });
    const r2 = await runRipperPaperCycle({
      runsDir, cyclesDir: path.join(tmpDir, 'cycles'), nowMs: NOW_MS,
    });
    expect(r2.tooEarlyRecheckableCount).toBe(0);
  });

  it('safety fields remain true regardless of TOO_EARLY status', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'TooEarlyToken', observedAt: ONE_MIN_AGO }),
      ]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs: NOW_MS,
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperPaperCycleResult', () => {
  it('includes REAL TRADING LOCKED and safety fields', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    const out = renderRipperPaperCycleResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
  });

  it('shows capture-skipped state when no fresh signals', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    const out = renderRipperPaperCycleResult(result);
    expect(out).toContain('Capture skipped: YES');
    expect(out).toContain('No fixtures captured');
    expect(out).toContain('No BubbleMaps calls made');
  });

  it('shows gate counts and cluster risk counts when capture runs', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: EIGHT_MIN_AGO })]),
    });
    const result = await runRipperPaperCycle({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      clusterRiskProvider: offlineClusterRiskProvider,
      nowMs: NOW_MS,
    });
    const out = renderRipperPaperCycleResult(result);
    expect(out).toContain('BUY_APPROVED_PAPER');
    expect(out).toContain('BUY_REJECTED');
    expect(out).toContain('CLEAN');
    expect(out).toContain('UNKNOWN');
    expect(out).toContain('Capture skipped: NO');
  });

  it('shows cycle started time', async () => {
    const result = await runRipperPaperCycle({
      runsDir:   path.join(tmpDir, 'no-such-dir'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      nowMs:     NOW_MS,
    });
    const out = renderRipperPaperCycleResult(result);
    expect(out).toContain(new Date(NOW_MS).toISOString());
  });
});
