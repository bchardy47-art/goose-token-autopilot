import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperPaperAutopilotCycle,
  renderRipperPaperAutopilotCycle,
} from '../src/token-grab/ripperPaperAutopilotCycle';
import { readPaperIntents } from '../src/token-grab/ripperPaperIntentLedger';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function makeFixture(opts: {
  contract?:       string;
  symbol?:         string;
  capturedAt?:     string;
  buyGateDecision?: string;
  clusterRisk?:    string;
  ripperScore?:    number;
  launchAgeBucket?: string;
  entryDecision?:  string;
} = {}) {
  return {
    capturedAt:       opts.capturedAt     ?? BASE_ISO,
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    ripperScore:      opts.ripperScore     ?? 90,
    launchAgeBucket:  opts.launchAgeBucket ?? 'PRIME_WINDOW',
    entryDecision:    opts.entryDecision   ?? 'READY_TO_SNIPE_PAPER',
    normalizedSignal: {
      contract: opts.contract ?? CONTRACT_A,
      symbol:   opts.symbol   ?? 'TOK',
      id: 'sig-id', source: 'test', sourceKind: 'DEX_NEW_POOL',
      discoveredAt: BASE_ISO, warnings: [],
    },
    raw: {
      clusterRisk: opts.clusterRisk ?? 'CLEAN',
    },
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

function makeObs(opts: { contract?: string; capturedAt?: string; priceChangePct?: number } = {}) {
  return {
    capturedAt: opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract: opts.contract ?? CONTRACT_A,
      id: 'o', source: 'test', sourceKind: 'DEX_NEW_POOL',
      discoveredAt: BASE_ISO, warnings: [],
      priceChangePct: opts.priceChangePct ?? null,
    },
    raw: {},
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeOptions(opts: {
  cyclesDir?: string; observationsDir?: string;
  intentsPath?: string; nowMs?: number; dryRun?: boolean; maxAgeMinutes?: number;
} = {}) {
  return {
    cyclesDir:       opts.cyclesDir       ?? path.join(tmpDir, 'cycles'),
    observationsDir: opts.observationsDir ?? path.join(tmpDir, 'obs'),
    intentsPath:     opts.intentsPath     ?? path.join(tmpDir, 'paper-intents.jsonl'),
    nowMs:           opts.nowMs           ?? BASE_MS,
    dryRun:          opts.dryRun,
    maxAgeMinutes:   opts.maxAgeMinutes,
  };
}

function writeCycleFile(fixtures: object[], slug = 'cycle-2026-06-15-120000'): string {
  const cyclesDir = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  const file = path.join(cyclesDir, `${slug}.jsonl`);
  fs.writeFileSync(file, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return file;
}

function writeObsFile(observations: object[], name = 'obs.jsonl'): string {
  const obsDir = path.join(tmpDir, 'obs');
  fs.mkdirSync(obsDir, { recursive: true });
  const file = path.join(obsDir, name);
  fs.writeFileSync(file, observations.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
  return file;
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('always sets reportOnly, readOnly, tradingExecuted=0, realTradingLocked, paperOnly', () => {
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── No cycle file ─────────────────────────────────────────────────────────────

describe('no cycle file', () => {
  it('returns null latestCycleFile when cycles dir empty', () => {
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.latestCycleFile).toBeNull();
    expect(result.fixturesRead).toBe(0);
    expect(result.buyApprovedPaper).toBe(0);
  });
});

// ── Fixture loading ───────────────────────────────────────────────────────────

describe('fixture loading', () => {
  it('reads only BUY_APPROVED_PAPER fixtures', () => {
    writeCycleFile([
      makeFixture({ contract: CONTRACT_A }),
      makeFixture({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ dryRun: true }));
    expect(result.fixturesRead).toBe(2);
    expect(result.buyApprovedPaper).toBe(1);
  });

  it('does not create intent for rejected fixture', () => {
    writeCycleFile([
      makeFixture({ contract: CONTRACT_A, buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const opts = makeOptions();
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents).toHaveLength(0);
  });

  it('creates intent for approved fixture', () => {
    writeCycleFile([makeFixture({ contract: CONTRACT_A })]);
    const opts = makeOptions();
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents).toHaveLength(1);
    expect(intents[0].contract).toBe(CONTRACT_A);
  });
});

// ── WAIT_10M vs ENTER_NOW policy ──────────────────────────────────────────────

describe('WAIT_10M vs ENTER_NOW policy', () => {
  it('assigns WAIT_10M only for high-quality subgroup', () => {
    writeCycleFile([
      makeFixture({ contract: CONTRACT_A, clusterRisk: 'CLEAN', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW', entryDecision: 'READY_TO_SNIPE_PAPER' }),
      makeFixture({ contract: CONTRACT_B, clusterRisk: 'WATCH' }),
    ]);
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.wait10mCount).toBe(1);
    expect(result.enterNowCount).toBe(1);
  });

  it('assigns ENTER_NOW when ripperScore < 100', () => {
    writeCycleFile([
      makeFixture({ ripperScore: 99, clusterRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW', entryDecision: 'READY_TO_SNIPE_PAPER' }),
    ]);
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.enterNowCount).toBe(1);
    expect(result.wait10mCount).toBe(0);
  });

  it('assigns ENTER_NOW for WATCH cluster', () => {
    writeCycleFile([
      makeFixture({ clusterRisk: 'WATCH', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW', entryDecision: 'READY_TO_SNIPE_PAPER' }),
    ]);
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.enterNowCount).toBe(1);
    expect(result.wait10mCount).toBe(0);
  });

  it('assigns ENTER_NOW for TOO_EARLY', () => {
    writeCycleFile([
      makeFixture({ launchAgeBucket: 'TOO_EARLY', clusterRisk: 'CLEAN', ripperScore: 100, entryDecision: 'READY_TO_SNIPE_PAPER' }),
    ]);
    const result = runRipperPaperAutopilotCycle(makeOptions());
    expect(result.enterNowCount).toBe(1);
    expect(result.wait10mCount).toBe(0);
  });
});

// ── Deduplication ────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('deduplicates intents from repeated cycle runs', () => {
    writeCycleFile([makeFixture({ contract: CONTRACT_A })]);
    const opts = makeOptions();
    runRipperPaperAutopilotCycle(opts);
    const result2 = runRipperPaperAutopilotCycle(opts);
    expect(result2.intentsDeduplicated).toBe(1);
    expect(result2.intentsCreated).toBe(0);
    expect(readPaperIntents(opts.intentsPath!)).toHaveLength(1);
  });

  it('does not dedup different contracts', () => {
    writeCycleFile([
      makeFixture({ contract: CONTRACT_A }),
      makeFixture({ contract: CONTRACT_B }),
    ]);
    const opts = makeOptions();
    runRipperPaperAutopilotCycle(opts);
    expect(readPaperIntents(opts.intentsPath!)).toHaveLength(2);
  });
});

// ── Due intent marking ────────────────────────────────────────────────────────

describe('due intent marking', () => {
  it('marks PLANNED intents as ENTRY_DUE when targetEntryAt <= now', () => {
    // Approved now, ENTER_NOW → targetEntryAt = approvedAt (past)
    writeCycleFile([makeFixture({ capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    const opts = makeOptions({ nowMs: BASE_MS });
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents[0].status).toBe('ENTRY_DUE');
  });

  it('leaves PLANNED when targetEntryAt is in the future', () => {
    // WAIT_10M with approvedAt = now → targetEntryAt = now + 10m (future)
    writeCycleFile([makeFixture({ capturedAt: BASE_ISO, clusterRisk: 'CLEAN', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW', entryDecision: 'READY_TO_SNIPE_PAPER' })]);
    const opts = makeOptions({ nowMs: BASE_MS });
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents[0].status).toBe('PLANNED');
  });

  it('marks as EXPIRED_NO_DATA when targetEntryAt is beyond maxAgeMinutes', () => {
    // Approved 30 min ago, ENTER_NOW, maxAgeMinutes=20 → expired
    writeCycleFile([makeFixture({ capturedAt: at(-30 * 60_000), clusterRisk: 'WATCH' })]);
    const opts = makeOptions({ nowMs: BASE_MS, maxAgeMinutes: 20 });
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents[0].status).toBe('EXPIRED_NO_DATA');
  });

  it('reports dueIntentsCount correctly', () => {
    writeCycleFile([makeFixture({ capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ nowMs: BASE_MS }));
    expect(result.dueIntentsCount).toBe(1);
  });

  it('reports expiredNoDataCount correctly', () => {
    writeCycleFile([makeFixture({ capturedAt: at(-30 * 60_000), clusterRisk: 'WATCH' })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ nowMs: BASE_MS, maxAgeMinutes: 20 }));
    expect(result.expiredNoDataCount).toBe(1);
  });
});

// ── Observation matching ──────────────────────────────────────────────────────

describe('observation matching', () => {
  it('captures observation for due intent when obs exists', () => {
    // Approved 5 min ago (ENTER_NOW, due), obs captured 1 min ago
    writeCycleFile([makeFixture({ capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    writeObsFile([makeObs({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 7 })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ nowMs: BASE_MS }));
    expect(result.observationsCaptured).toBe(1);
  });

  it('marks intent OBSERVED after observation found', () => {
    writeCycleFile([makeFixture({ capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    writeObsFile([makeObs({ contract: CONTRACT_A, capturedAt: at(-1 * 60_000), priceChangePct: 7 })]);
    const opts = makeOptions({ nowMs: BASE_MS });
    runRipperPaperAutopilotCycle(opts);
    const intents = readPaperIntents(opts.intentsPath!);
    expect(intents[0].status).toBe('OBSERVED');
  });

  it('does not capture obs from wrong contract', () => {
    writeCycleFile([makeFixture({ contract: CONTRACT_A, capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    writeObsFile([makeObs({ contract: CONTRACT_B, capturedAt: at(-1 * 60_000), priceChangePct: 7 })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ nowMs: BASE_MS }));
    expect(result.observationsCaptured).toBe(0);
  });

  it('does not count observation if no obs file exists', () => {
    writeCycleFile([makeFixture({ capturedAt: at(-5 * 60_000), clusterRisk: 'WATCH' })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ nowMs: BASE_MS }));
    expect(result.observationsCaptured).toBe(0);
  });
});

// ── Dry run ───────────────────────────────────────────────────────────────────

describe('dry run', () => {
  it('dry-run does not write intents file', () => {
    writeCycleFile([makeFixture({ contract: CONTRACT_A })]);
    const opts = makeOptions({ dryRun: true });
    runRipperPaperAutopilotCycle(opts);
    expect(fs.existsSync(opts.intentsPath!)).toBe(false);
  });

  it('dry-run still reports correct counts', () => {
    writeCycleFile([makeFixture({ contract: CONTRACT_A })]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.intentsCreated).toBe(1);
  });
});

// ── Renderer ─────────────────────────────────────────────────────────────────

describe('renderRipperPaperAutopilotCycle', () => {
  it('includes safety header', () => {
    const result = runRipperPaperAutopilotCycle(makeOptions());
    const output = renderRipperPaperAutopilotCycle(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('includes safety field line', () => {
    const result = runRipperPaperAutopilotCycle(makeOptions());
    const output = renderRipperPaperAutopilotCycle(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('shows CYCLE SUMMARY section', () => {
    const result = runRipperPaperAutopilotCycle(makeOptions());
    const output = renderRipperPaperAutopilotCycle(result);
    expect(output).toContain('CYCLE SUMMARY');
  });

  it('shows DRY-RUN mode when applicable', () => {
    writeCycleFile([makeFixture()]);
    const result = runRipperPaperAutopilotCycle(makeOptions({ dryRun: true }));
    const output = renderRipperPaperAutopilotCycle(result);
    expect(output).toContain('DRY-RUN');
  });
});
