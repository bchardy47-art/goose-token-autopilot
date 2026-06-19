import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLearningMemory,
  renderRipperLearningMemoryResult,
  classifyOutcome,
  bucketLiquidity,
  bucketVlr,
  inferMemoryUniverse,
  type LearningMemoryRow,
} from '../src/token-grab/ripperLearningMemory';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();
const LATER_ISO = new Date(BASE_MS + 5 * 60_000).toISOString();

const CONTRACT_A = 'Contract00000000000000000000000000000000001';
const CONTRACT_B = 'Contract00000000000000000000000000000000002';
const CONTRACT_C = 'Contract00000000000000000000000000000000003';

function makeCycleRow(opts: {
  contract:         string;
  capturedAt?:      string;
  buyGateDecision?: string;
  ripperScore?:     number;
  ageMinutes?:      number;
  liquidityUsd?:    number;
  clusterRisk?:     string;
  launchAgeBucket?: string;
  entryDecision?:   string;
  vlr?:             number;
  bubbleMapsScore?: number;
  symbol?:          string;
}): Record<string, unknown> {
  const captured = opts.capturedAt ?? BASE_ISO;
  const ns: Record<string, unknown> = {
    contract:    opts.contract,
    symbol:      opts.symbol ?? 'TEST',
    discoveredAt: captured,
  };
  if (opts.liquidityUsd != null) ns['liquidityUsd'] = opts.liquidityUsd;
  if (opts.vlr != null) ns['volumeLiquidityRatio'] = opts.vlr;
  const raw: Record<string, unknown> = {
    contract: opts.contract,
    symbol:   opts.symbol ?? 'TEST',
  };
  if (opts.clusterRisk) raw['clusterRisk'] = opts.clusterRisk;
  if (opts.bubbleMapsScore != null) raw['clusterNotes'] = [`bubbleMapsScore ${opts.bubbleMapsScore}`];
  return {
    id:               `cycle:${opts.contract}`,
    capturedAt:       captured,
    source:           'dex-watch-run',
    sourceKind:       'DEX_NEW_POOL',
    normalizedSignal: ns,
    raw,
    ripperScore:      opts.ripperScore ?? 95,
    ageMinutes:       opts.ageMinutes ?? 5,
    launchAgeBucket:  opts.launchAgeBucket ?? 'PRIME_WINDOW',
    entryDecision:    opts.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked:true,
    paperOnly:        true,
    readOnly:         true,
  };
}

function makeObsRow(opts: {
  contract:       string;
  observedAt?:    string;
  priceChangePct: number;
}): Record<string, unknown> {
  return {
    id:               `obs:${opts.contract}`,
    capturedAt:       opts.observedAt ?? LATER_ISO,
    source:           'dex-watch-run',
    sourceKind:       'DEX_NEW_POOL',
    normalizedSignal: {
      contract:       opts.contract,
      priceChangePct: opts.priceChangePct,
    },
    raw: { contract: opts.contract, priceChangePct: opts.priceChangePct },
  };
}

function makeEnrollmentRow(opts: {
  contract:        string;
  cycleFile:       string;
  capturedAt?:     string;
  age_gte10m?:     boolean;
  liq_lt10k?:      boolean;
}): Record<string, unknown> {
  const liqLt = opts.liq_lt10k ?? false;
  const ageGte = opts.age_gte10m ?? false;
  return {
    contract:           opts.contract,
    cycleFile:          opts.cycleFile,
    capturedAt:         opts.capturedAt ?? BASE_ISO,
    buyGateDecision:    'BUY_APPROVED_PAPER',
    shadowRejectFlags:  {
      age_gte10m: ageGte,
      liq_lt10k:  liqLt,
      liq_OR_age: ageGte || liqLt,
    },
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

let tmpDir: string;
let cyclesDir: string;
let obsDir: string;
let dexDir: string;
let enrollmentsPath: string;
let paperIntentPath: string;
let outPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-test-'));
  cyclesDir = path.join(tmpDir, 'cycles');
  obsDir    = path.join(tmpDir, 'observations');
  dexDir    = path.join(tmpDir, 'dex-watch-runs');
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.mkdirSync(obsDir,    { recursive: true });
  fs.mkdirSync(dexDir,    { recursive: true });
  enrollmentsPath = path.join(tmpDir, 'shadow-reject-filter-enrollments.jsonl');
  paperIntentPath = path.join(tmpDir, 'paper-intent-observations.jsonl');
  outPath         = path.join(tmpDir, 'learning-memory.jsonl');
});

afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(file: string, rows: object[]): void {
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function readMemory(): LearningMemoryRow[] {
  if (!fs.existsSync(outPath)) return [];
  return fs.readFileSync(outPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as LearningMemoryRow);
}

function runDefault() {
  return runRipperLearningMemory({
    cyclesDir,
    enrollmentsPath,
    paperIntentObsPath: paperIntentPath,
    observationsDir:    obsDir,
    dexWatchRunsDir:    dexDir,
    outPath,
  });
}

describe('classifyOutcome', () => {
  it('labels outcomes per priceChangePct thresholds', () => {
    expect(classifyOutcome(8)).toBe('BIG_WINNER');
    expect(classifyOutcome(5)).toBe('BIG_WINNER');
    expect(classifyOutcome(4)).toBe('WINNER');
    expect(classifyOutcome(3)).toBe('WINNER');
    expect(classifyOutcome(2)).toBe('SMALL_WINNER');
    expect(classifyOutcome(1)).toBe('SMALL_WINNER');
    expect(classifyOutcome(0)).toBe('FLAT_JUNK');
    expect(classifyOutcome(-0.5)).toBe('FLAT_JUNK');
    expect(classifyOutcome(-1)).toBe('DUMP');
    expect(classifyOutcome(-12)).toBe('DUMP');
    expect(classifyOutcome(null)).toBe('UNKNOWN');
    expect(classifyOutcome(undefined)).toBe('UNKNOWN');
  });
});

describe('bucketLiquidity / bucketVlr', () => {
  it('buckets liquidity into discrete ranges', () => {
    expect(bucketLiquidity(null)).toBe('LIQ_UNKNOWN');
    expect(bucketLiquidity(5_000)).toBe('LIQ_LT_10K');
    expect(bucketLiquidity(20_000)).toBe('LIQ_10K_30K');
    expect(bucketLiquidity(50_000)).toBe('LIQ_30K_100K');
    expect(bucketLiquidity(250_000)).toBe('LIQ_GTE_100K');
  });
  it('buckets VLR', () => {
    expect(bucketVlr(null)).toBe('VLR_UNKNOWN');
    expect(bucketVlr(0.2)).toBe('VLR_LT_0_5');
    expect(bucketVlr(1)).toBe('VLR_0_5_TO_2');
    expect(bucketVlr(3)).toBe('VLR_GTE_2');
  });
});

describe('runRipperLearningMemory — basics', () => {
  it('appends rows with safety flags and joins observation outcomes', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({
        contract: CONTRACT_A,
        liquidityUsd: 20_000,
        ageMinutes: 5,
        clusterRisk: 'CLEAN',
        ripperScore: 100,
        bubbleMapsScore: 73.8,
        vlr: 1.2,
      }),
    ]);
    const obsFile = path.join(obsDir, 'obs-2026-06-12-133000.jsonl');
    writeJsonl(obsFile, [
      makeObsRow({ contract: CONTRACT_A, priceChangePct: 8 }),
    ]);

    const result = runDefault();
    expect(result.rowsAppended).toBe(1);
    const rows = readMemory();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.contract).toBe(CONTRACT_A);
    expect(r.cycleId).toBe('cycle-2026-06-12-132744');
    expect(r.outcomeLabel).toBe('BIG_WINNER');
    expect(r.priceChangePct).toBe(8);
    expect(r.observedAt).toBeTruthy();
    expect(r.liquidityBucket).toBe('LIQ_10K_30K');
    expect(r.bubbleMapsScore).toBe(73.8);
    expect(r.vlrBucket).toBe('VLR_0_5_TO_2');
    expect(r.timingPath).toBe('ENTER_NOW');
    expect(r.wouldRejectByLiqOrAge).toBe(false);
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });

  it('flags liq_OR_age blocked rows from enrollment and from inferred values', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 5_000, ageMinutes: 5 }),
      makeCycleRow({ contract: CONTRACT_B, liquidityUsd: 20_000, ageMinutes: 12 }),
      makeCycleRow({ contract: CONTRACT_C, liquidityUsd: 25_000, ageMinutes: 5 }),
    ]);
    writeJsonl(enrollmentsPath, [
      makeEnrollmentRow({
        contract: CONTRACT_A, cycleFile: 'cycle-2026-06-12-132744.jsonl', liq_lt10k: true,
      }),
    ]);
    const result = runDefault();
    expect(result.rowsAppended).toBe(3);
    const rows = readMemory();
    const a = rows.find(r => r.contract === CONTRACT_A)!;
    const b = rows.find(r => r.contract === CONTRACT_B)!;
    const c = rows.find(r => r.contract === CONTRACT_C)!;
    expect(a.wouldRejectByLiqOrAge).toBe(true);
    expect(a.blockedByLowLiquidity).toBe(true);
    expect(a.blockedByAgeGte10m).toBe(false);
    expect(b.wouldRejectByLiqOrAge).toBe(true);
    expect(b.blockedByAgeGte10m).toBe(true);
    expect(c.wouldRejectByLiqOrAge).toBe(false);
    expect(c.blockedByLowLiquidity).toBe(false);
    expect(c.blockedByAgeGte10m).toBe(false);
    expect(result.blockedByLiqOrAge).toBe(2);
  });

  it('dedupes append-only writes using contract+cycleId+observedAt', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }),
    ]);
    const obsFile = path.join(obsDir, 'obs-2026-06-12-133000.jsonl');
    writeJsonl(obsFile, [
      makeObsRow({ contract: CONTRACT_A, priceChangePct: 4 }),
    ]);
    const first = runDefault();
    expect(first.rowsAppended).toBe(1);
    const second = runDefault();
    expect(second.rowsAppended).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(readMemory()).toHaveLength(1);
  });

  it('labels UNKNOWN for rows with no observation outcome', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }),
    ]);
    const result = runDefault();
    expect(result.rowsAppended).toBe(1);
    expect(result.unknownRows).toBe(1);
    expect(readMemory()[0].outcomeLabel).toBe('UNKNOWN');
  });
});

describe('inferMemoryUniverse — universe classification', () => {
  it('returns SHADOW_ENROLLED_APPROVED for approved row with enrollment in sourceFiles', () => {
    expect(inferMemoryUniverse({
      gateDecision: 'BUY_APPROVED_PAPER',
      sourceFiles:  ['cycle-2026-06-12.jsonl', 'shadow-reject-filter-enrollments.jsonl'],
      outcomeSource: 'obs-test.jsonl',
    })).toBe('SHADOW_ENROLLED_APPROVED');
  });

  it('returns PAPER_INTENT_OBSERVED for approved row with paper-intent outcomeSource', () => {
    expect(inferMemoryUniverse({
      gateDecision:  'BUY_APPROVED_PAPER',
      sourceFiles:   ['cycle-2026-06-12.jsonl'],
      outcomeSource: 'paper-intent-observations.jsonl',
    })).toBe('PAPER_INTENT_OBSERVED');
  });

  it('returns PAPER_POLICY_TEST_APPROVED for approved row not enrolled and not paper-intent', () => {
    expect(inferMemoryUniverse({
      gateDecision:  'BUY_APPROVED_PAPER',
      sourceFiles:   ['cycle-2026-06-12.jsonl'],
      outcomeSource: 'obs-2026-06-12.jsonl',
    })).toBe('PAPER_POLICY_TEST_APPROVED');
  });

  it('returns PAPER_POLICY_TEST_APPROVED for approved row with no outcome at all', () => {
    expect(inferMemoryUniverse({
      gateDecision:  'BUY_APPROVED_PAPER',
      sourceFiles:   ['cycle-2026-06-12.jsonl'],
      outcomeSource: null,
    })).toBe('PAPER_POLICY_TEST_APPROVED');
  });

  it('returns DEX_WATCH_GENERAL for non-approved row with dex-watch .json outcome', () => {
    expect(inferMemoryUniverse({
      gateDecision:  'BUY_REJECTED',
      sourceFiles:   ['cycle-2026-06-12.jsonl'],
      outcomeSource: 'run-2026-06-12-130000.json',
    })).toBe('DEX_WATCH_GENERAL');
  });

  it('returns UNKNOWN_GENERAL for non-approved row with no dex-watch outcome', () => {
    expect(inferMemoryUniverse({
      gateDecision:  'BUY_REJECTED',
      sourceFiles:   ['cycle-2026-06-12.jsonl'],
      outcomeSource: null,
    })).toBe('UNKNOWN_GENERAL');
  });

  it('returns UNKNOWN_GENERAL for null gateDecision with non-json outcome', () => {
    expect(inferMemoryUniverse({
      gateDecision:  null,
      sourceFiles:   [],
      outcomeSource: 'obs-test.jsonl',
    })).toBe('UNKNOWN_GENERAL');
  });
});

describe('runRipperLearningMemory — memoryUniverse on written rows', () => {
  it('sets SHADOW_ENROLLED_APPROVED on BUY_APPROVED_PAPER row present in enrollment', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 })]);
    writeJsonl(enrollmentsPath, [
      makeEnrollmentRow({ contract: CONTRACT_A, cycleFile: 'cycle-2026-06-12-132744.jsonl' }),
    ]);
    runDefault();
    const rows = readMemory();
    expect(rows[0].memoryUniverse).toBe('SHADOW_ENROLLED_APPROVED');
  });

  it('sets PAPER_POLICY_TEST_APPROVED on BUY_APPROVED_PAPER row NOT in enrollment', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 })]);
    // no enrollments file
    runDefault();
    const rows = readMemory();
    expect(rows[0].memoryUniverse).toBe('PAPER_POLICY_TEST_APPROVED');
  });

  it('sets DEX_WATCH_GENERAL on non-approved row that gets dex-watch outcome', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_A, buyGateDecision: 'BUY_REJECTED', liquidityUsd: 20_000 }),
    ]);
    // dex-watch run has observation for this contract
    const dexRun = {
      generatedAt: LATER_ISO,
      winners: [{ contract: CONTRACT_A, priceChangePct: 6, final: { observedAt: LATER_ISO } }],
      losers: [], flat: [], topMovers: [],
    };
    fs.writeFileSync(path.join(dexDir, 'run-2026-06-12-133000.json'), JSON.stringify(dexRun), 'utf-8');
    runDefault();
    const rows = readMemory();
    const r = rows.find(row => row.contract === CONTRACT_A);
    expect(r?.memoryUniverse).toBe('DEX_WATCH_GENERAL');
  });

  it('sets UNKNOWN_GENERAL on non-approved row with no matching observation', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED', liquidityUsd: 20_000 }),
    ]);
    runDefault();
    const rows = readMemory();
    expect(rows[0].memoryUniverse).toBe('UNKNOWN_GENERAL');
  });

  it('DEX_WATCH_GENERAL row does NOT distort SHADOW_ENROLLED_APPROVED stats', () => {
    // Enrolled approved row: no liqOrAge block, outcome FLAT_JUNK
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-12-132744.jsonl');
    writeJsonl(cycleFile, [
      makeCycleRow({ contract: CONTRACT_A, buyGateDecision: 'BUY_APPROVED_PAPER', liquidityUsd: 20_000, ageMinutes: 5 }),
      // Rejected row with high age — would be DEX_WATCH_GENERAL
      makeCycleRow({ contract: CONTRACT_B, buyGateDecision: 'BUY_REJECTED', liquidityUsd: 5_000, ageMinutes: 15 }),
    ]);
    writeJsonl(enrollmentsPath, [
      makeEnrollmentRow({ contract: CONTRACT_A, cycleFile: 'cycle-2026-06-12-132744.jsonl' }),
    ]);
    // Dex-watch has observation for rejected contract
    const dexRun = {
      generatedAt: LATER_ISO,
      winners: [{ contract: CONTRACT_B, priceChangePct: 8, final: { observedAt: LATER_ISO } }],
      losers: [], flat: [], topMovers: [],
    };
    fs.writeFileSync(path.join(dexDir, 'run-2026-06-12-133000.json'), JSON.stringify(dexRun), 'utf-8');
    runDefault();
    const rows = readMemory();
    const enrolledRow = rows.find(r => r.contract === CONTRACT_A)!;
    const dexRow      = rows.find(r => r.contract === CONTRACT_B)!;
    expect(enrolledRow.memoryUniverse).toBe('SHADOW_ENROLLED_APPROVED');
    expect(dexRow.memoryUniverse).toBe('DEX_WATCH_GENERAL');
    // DEX_WATCH_GENERAL row's liqOrAge=true must NOT bleed into policy evidence
    expect(dexRow.wouldRejectByLiqOrAge).toBe(true);
    expect(enrolledRow.wouldRejectByLiqOrAge).toBe(false);
  });
});

describe('runRipperLearningMemory — safety guarantees', () => {
  it('never imports trading guards or paper decision modules', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperLearningMemory.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/from ['"].*\/trading\/real['"]/);
    expect(src).not.toMatch(/from ['"].*\/trading\/guards['"]/);
    expect(src).not.toMatch(/from ['"].*\/trading\/paper['"]/);
    expect(src).not.toMatch(/from ['"].*\/paper\/autoPaper['"]/);
    expect(src).not.toMatch(/from ['"].*\/autopilot\/runAutopilot['"]/);
  });

  it('module text contains no real-trading call sites or simulated-buy invocations', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperLearningMemory.ts'),
      'utf-8',
    );
    // No calls to simulated-trade helpers, autopaper runner, or swap/wallet code.
    expect(src).not.toMatch(/\bpaperBuy\s*\(/);
    expect(src).not.toMatch(/\bpaperSell\s*\(/);
    expect(src).not.toMatch(/\brunAutoPaper\s*\(/);
    expect(src).not.toMatch(/\bexecuteSwap\s*\(/);
    expect(src).not.toMatch(/\bsignTransaction\s*\(/);
    expect(src).not.toMatch(/\bbroadcastTx\s*\(/);
    expect(src).not.toMatch(/\brunAutopilot\s*\(/);
    // No CLI script references either.
    expect(src).not.toMatch(/['"]token:auto-paper['"]/);
    expect(src).not.toMatch(/['"]token:paper-buy['"]/);
  });

  it('renderer prints required safety banners', () => {
    const out = renderRipperLearningMemoryResult({
      cycleFilesRead:     0,
      observationsRead:   0,
      enrollmentsRead:    0,
      paperIntentObsRead: 0,
      dexWatchRunsRead:   0,
      candidatesProcessed:0,
      rowsAppended:       0,
      duplicatesSkipped:  0,
      observedRows:       0,
      unknownRows:        0,
      blockedByLiqOrAge:  0,
      outPath,
      reportOnly:        true,
      readOnly:          true,
      paperOnly:         true,
      realTradingLocked: true,
      tradingExecuted:   0,
    });
    expect(out).toContain('HOLD_CURRENT_GATES');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('REPORT_ONLY');
    expect(out).toContain('NO_POLICY_CHANGE');
  });
});

// ── entryMomentumPct persistence ─────────────────────────────────────────────

describe('entryMomentumPct persistence into learning memory', () => {
  const CYCLE_FILE = 'cycle-2026-06-18-100000.jsonl';

  it('cycle row with positive entryMomentumPct produces memory row with that value', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }), entryMomentumPct: 18.4 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 5 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem).toHaveLength(1);
    expect(mem[0].entryMomentumPct).toBeCloseTo(18.4);
  });

  it('cycle row with negative entryMomentumPct persists correctly', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }), entryMomentumPct: -15.2 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 2 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].entryMomentumPct).toBeCloseTo(-15.2);
  });

  it('cycle row with zero entryMomentumPct persists correctly', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }), entryMomentumPct: 0 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 1 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].entryMomentumPct).toBe(0);
  });

  it('cycle row without entryMomentumPct produces memory row with null', () => {
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 })]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 3 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].entryMomentumPct).toBeNull();
  });

  it('cycle row with entryPriceChangeM5 (alternate name) normalizes to entryMomentumPct', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }), entryPriceChangeM5: 7.7 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 4 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].entryMomentumPct).toBeCloseTo(7.7);
  });

  it('entryMomentumPct from cycle preferred over entryPriceChangeM5 when both present', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 20_000, ageMinutes: 5 }), entryMomentumPct: 5.0, entryPriceChangeM5: 99.0 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 6 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].entryMomentumPct).toBeCloseTo(5.0);
  });

  it('all other learning memory fields are unaffected by entryMomentumPct presence', () => {
    const row = { ...makeCycleRow({ contract: CONTRACT_A, liquidityUsd: 25_000, ageMinutes: 5, clusterRisk: 'CLEAN' }), entryMomentumPct: 12.0 };
    writeJsonl(path.join(cyclesDir, CYCLE_FILE), [row]);
    writeJsonl(paperIntentPath, [{ capturedAt: LATER_ISO, normalizedSignal: { contract: CONTRACT_A, priceChangePct: 7 } }]);
    runDefault();
    const mem = readMemory();
    expect(mem[0].contract).toBe(CONTRACT_A);
    expect(mem[0].liquidityBucket).toBe('LIQ_10K_30K');
    expect(mem[0].reportOnly).toBe(true);
    expect(mem[0].realTradingLocked).toBe(true);
    expect(mem[0].tradingExecuted).toBe(0);
  });
});
