import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDexWatchReport, type DexWatchOutcome, type DexWatchReport } from '../src/token-grab/dexWatch';
import {
  buildDexPaperEntryPlans,
  renderDexPaperEntryPlanReport,
  runDexPaperEntryPlanner,
  findLatestRealRunFile,
  type DexPaperEntryPlannerOptions,
} from '../src/token-grab/dexPaperEntryPlanner';
import type { LoadedRun, DexPaperJournal } from '../src/token-grab/dexPaperJournal';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

function outcome(
  over: Partial<DexWatchOutcome> & Pick<DexWatchOutcome, 'contract' | 'classification'>,
): DexWatchOutcome {
  return { signalId: `sig-${over.contract}`, chainId: 'solana', ...over };
}

function report(outcomes: DexWatchOutcome[], generatedAt = '2026-06-09T10:00:00.000Z'): DexWatchReport {
  return buildDexWatchReport({
    generatedAt,
    signalsRead: outcomes.length,
    outcomes,
    chain: 'solana',
    minutes: 10,
    intervalSeconds: 60,
    dryRun: false,
  });
}

const winO = (c: string, sym: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract: c, symbol: sym, classification: 'winner', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });

const loseO = (c: string, sym: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract: c, symbol: sym, classification: 'loser', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });

const flatO = (c: string, sym: string): DexWatchOutcome =>
  outcome({ contract: c, symbol: sym, classification: 'flat', priceChangePct: 5, liquidityChangePct: 2, volumeToLiquidityRatio: 0.5 });

const negO = (c: string, sym: string): DexWatchOutcome =>
  outcome({ contract: c, symbol: sym, classification: 'loser', priceChangePct: -10, liquidityChangePct: -5 });

// Contracts
const SATOSHI  = 'SatoSh11111111111111111111111111111111111111'; // historical winner (old run)
const ELON     = 'eLonBuck2222222222222222222222222222222222222'; // current-cycle winner (newest run)
const ONE      = 'OneChurn333333333333333333333333333333333333'; // pass thresholds but history blocked
const FLAT_TK  = 'FlatTk44444444444444444444444444444444444444'; // small movement → WATCH_ONLY
const NEG_TK   = 'NegTk555555555555555555555555555555555555555'; // negative → NO_ENTRY
const MISSING  = 'missingX666666666666666666666666666666666666'; // in signals only → NO_ENTRY
const SMOKE_TK = 'SmokeTk77777777777777777777777777777777777777'; // in smoke.json only

/**
 * Standard test fixture.
 * Runs sort lexicographically by file name — the newest real run is run-e-new.json.
 *
 * run-a-old : SATOSHI wins    → HISTORICAL_JOURNAL_WINNER
 * run-b-old : ONE wins        → (but loses in run-c → BLOCKED_HISTORY_RISK)
 * run-c-old : ONE loses
 * run-d-old : FLAT_TK flat, NEG_TK loses
 * run-e-new : ELON wins       → CURRENT_CYCLE_PAPER_ENTRY  (newest real run)
 * smoke.json: SMOKE_TK wins   → must NOT become CURRENT_CYCLE_PAPER_ENTRY
 */
function makeRuns(): LoadedRun[] {
  return [
    { file: 'run-a-old.json', report: report([winO(SATOSHI, 'SATOSHI', 54, 23, 0.33)]), generatedAt: '2026-06-07T10:00:00.000Z' },
    { file: 'run-b-old.json', report: report([winO(ONE,  'ONE',  40, 16, 0.6)]),  generatedAt: '2026-06-07T10:10:00.000Z' },
    { file: 'run-c-old.json', report: report([loseO(ONE, 'ONE', -30, -25, 0.7)]), generatedAt: '2026-06-07T10:20:00.000Z' },
    { file: 'run-d-old.json', report: report([flatO(FLAT_TK, 'FLAT'), negO(NEG_TK, 'NEG')]), generatedAt: '2026-06-07T10:30:00.000Z' },
    // Newest real run — ELON passes here:
    { file: 'run-e-new.json', report: report([winO(ELON, 'ELON', 29, 13, 0.44)]), generatedAt: '2026-06-09T01:00:00.000Z' },
    // smoke.json must be ignored when selecting the latest real run:
    { file: 'smoke.json', report: report([winO(SMOKE_TK, 'SMOKE', 55, 22, 0.3)]), generatedAt: '2026-06-09T02:00:00.000Z' },
  ];
}

function makeSignals(): PreSignal[] {
  return [
    {
      id: 'sig-satoshi',
      source: 'x_manual',
      text: '$SATOSHI up',
      symbol: 'SATOSHI',
      contract: SATOSHI,
      seenAt: '2026-06-07T09:00:00.000Z',
      signalType: 'ticker_repetition',
      confidence: 'medium',
    },
    {
      id: 'sig-missing',
      source: 'x_manual',
      text: '$MISSING new token',
      symbol: 'MISSING',
      contract: MISSING,
      seenAt: '2026-06-07T09:05:00.000Z',
      signalType: 'launch_mention',
      confidence: 'low',
    },
  ];
}

function makeJournal(): DexPaperJournal {
  return {
    journaledAt: '2026-06-07T12:00:00.000Z',
    dir: 'data/token-grab/dex-watch-runs',
    out: 'data/token-grab/paper-journal/dex-paper-journal.json',
    fakeBankroll: 20,
    fakePositionSize: 1,
    totalSimulatedTrades: 1,
    totalFakePnlDollars: 0.54,
    totalFakePnlPct: 54,
    winRate: 1.0,
    blockedByHistoryRisk: 0,
    trades: [
      {
        symbol: 'SATOSHI',
        contract: SATOSHI,
        fakePositionSize: 1,
        priceChangePct: 54,
        liquidityChangePct: 23,
        volumeLiquidityRatio: 0.33,
        fakePnlDollars: 0.54,
        fakePnlPct: 54,
        passReason: 'PASS: price +54.0% >= +20, liquidity +23.0% >= +10, v/l 0.33 <= 1.0, history clean',
        outcome: 'winner',
        sourceRunFile: 'run-a-old.json',
      },
    ],
    blocked: [],
    readOnly: true,
    paperOnly: true,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

const OPTS: DexPaperEntryPlannerOptions = {
  signalsFile: 'data/token-grab/x-ears/presignals.dex.json',
  runsDir: 'data/token-grab/dex-watch-runs',
  journalFile: 'data/token-grab/paper-journal/dex-paper-journal.json',
  out: 'data/token-grab/paper-plans/dex-paper-entry-plan.json',
  fakeBankroll: 20,
  positionSize: 1,
  plannedAt: '2026-06-09T12:00:00.000Z',
};

// ── findLatestRealRunFile ────────────────────────────────────────────────────────────

describe('findLatestRealRunFile', () => {
  it('returns the lexicographically newest run-*.json file', () => {
    const result = findLatestRealRunFile(makeRuns());
    expect(result).toBe('run-e-new.json');
  });

  it('ignores smoke.json even when it sorts after real runs', () => {
    const result = findLatestRealRunFile(makeRuns());
    expect(result).not.toBe('smoke.json');
  });

  it('ignores files that do not match run-*.json pattern', () => {
    const extra: LoadedRun[] = [
      { file: 'zzz-fixture.json', report: report([winO(SATOSHI, 'S', 50, 20, 0.5)]), generatedAt: '2030-01-01T00:00:00.000Z' },
      ...makeRuns(),
    ];
    expect(findLatestRealRunFile(extra)).toBe('run-e-new.json');
  });

  it('returns undefined when no real runs exist', () => {
    const smokeOnly: LoadedRun[] = [
      { file: 'smoke.json', report: report([winO(SATOSHI, 'S', 50, 20, 0.5)]) },
    ];
    expect(findLatestRealRunFile(smokeOnly)).toBeUndefined();
  });
});

// ── Core planner tests ───────────────────────────────────────────────────────────────

describe('buildDexPaperEntryPlans', () => {
  const runs = makeRuns();
  const planner = buildDexPaperEntryPlans(runs, makeSignals(), makeJournal(), OPTS);

  it('identifies the latest real run file (ignoring smoke.json)', () => {
    expect(planner.latestRealRunFile).toBe('run-e-new.json');
  });

  it('creates a valid plan JSON with plans array', () => {
    expect(planner.plans).toBeInstanceOf(Array);
    expect(planner.totalPlans).toBeGreaterThan(0);
    expect(planner.plans.length).toBe(planner.totalPlans);
  });

  it('CURRENT_CYCLE_PAPER_ENTRY only for tokens passing V2 sim in the newest real run', () => {
    const current = planner.plans.filter(p => p.recommendation === 'CURRENT_CYCLE_PAPER_ENTRY');
    expect(current.length).toBe(1); // only ELON is in run-e-new.json passing thresholds
    expect(current[0].contract).toBe(ELON);
    expect(current[0].isCurrentCycle).toBe(true);
    expect(current[0].sourceRunFile).toBe('run-e-new.json');
  });

  it('SATOSHI (historical winner) is HISTORICAL_JOURNAL_WINNER, not CURRENT_CYCLE_PAPER_ENTRY', () => {
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.recommendation).toBe('HISTORICAL_JOURNAL_WINNER');
    expect(sat.isCurrentCycle).toBe(false);
    expect(sat.sourceRunFile).toBe('run-a-old.json');
  });

  it('newest run with 0 candidates → CURRENT_CYCLE_PAPER_ENTRY count equals 0', () => {
    // Replace the newest run with a flat-only run
    const flatNewestRuns: LoadedRun[] = [
      ...makeRuns().filter(r => r.file !== 'run-e-new.json'),
      {
        file: 'run-e-new.json',
        report: report([flatO(ELON, 'ELON')]),
        generatedAt: '2026-06-09T01:00:00.000Z',
      },
    ];
    const flatResult = buildDexPaperEntryPlans(flatNewestRuns, makeSignals(), makeJournal(), OPTS);
    expect(flatResult.currentCyclePaperEntry).toBe(0);
    // ELON moves to WATCH_ONLY (small movement, not passing)
    const elonPlan = flatResult.plans.find(p => p.contract === ELON)!;
    expect(elonPlan.recommendation).toBe('WATCH_ONLY');
  });

  it('smoke.json winner is not labeled CURRENT_CYCLE_PAPER_ENTRY', () => {
    const smokePlan = planner.plans.find(p => p.contract === SMOKE_TK);
    // smoke.json runs through HISTORICAL_JOURNAL_WINNER (it passes thresholds but came from smoke.json)
    // or WATCH_ONLY depending on whether it's a winner
    // either way it must NOT be CURRENT_CYCLE_PAPER_ENTRY
    if (smokePlan) {
      expect(smokePlan.recommendation).not.toBe('CURRENT_CYCLE_PAPER_ENTRY');
      expect(smokePlan.isCurrentCycle).toBe(false);
    }
  });

  it('BLOCKED_HISTORY_RISK for tokens blocked by existing history-risk logic', () => {
    const blocked = planner.plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK');
    expect(blocked.length).toBeGreaterThan(0);
    const cs = blocked.map(p => p.contract);
    expect(cs).toContain(ONE);
    expect(cs).not.toContain(ELON);
    expect(cs).not.toContain(SATOSHI);
  });

  it('WATCH_ONLY for tokens moving but not passing thresholds', () => {
    const watchOnly = planner.plans.filter(p => p.recommendation === 'WATCH_ONLY');
    expect(watchOnly.map(p => p.contract)).toContain(FLAT_TK);
  });

  it('NO_ENTRY for tokens in signals only or with flat/negative data', () => {
    const noEntry = planner.plans.filter(p => p.recommendation === 'NO_ENTRY');
    const cs = noEntry.map(p => p.contract);
    expect(cs).toContain(MISSING);
    expect(cs).toContain(NEG_TK);
  });

  it('every plan carries isCurrentCycle and latestRunFile', () => {
    for (const plan of planner.plans) {
      expect(typeof plan.isCurrentCycle).toBe('boolean');
      // latestRunFile is set when there is a real run
      expect(plan.latestRunFile).toBe('run-e-new.json');
    }
  });

  it('fake stop/take-profit/cancel conditions on every plan', () => {
    for (const plan of planner.plans) {
      expect(plan.fakeStopLossPct).toBe(-20);
      expect(plan.fakeTakeProfitPct).toBe(25);
      expect(plan.fakeRunnerTargetPct).toBe(50);
      expect(plan.cancelConditions.length).toBeGreaterThan(0);
      expect(plan.cancelConditions.some(c => c.includes('liquidity'))).toBe(true);
    }
  });

  it('includes priceChangePct/liquidityChangePct/volumeLiquidityRatio for run-backed plans', () => {
    const elon = planner.plans.find(p => p.contract === ELON)!;
    expect(elon.priceChangePct).toBeCloseTo(29);
    expect(elon.liquidityChangePct).toBeCloseTo(13);
    expect(elon.volumeLiquidityRatio).toBeCloseTo(0.44);
  });

  it('includes source run file for run-backed candidates', () => {
    const elon = planner.plans.find(p => p.contract === ELON)!;
    expect(elon.sourceRunFile).toBe('run-e-new.json');
  });

  it('includes journal similarity note for prior journal winners', () => {
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.journalSimilarity).toBeDefined();
    expect(sat.journalSimilarity).toContain('prior winner');
  });

  it('historyRiskStatus CLEAN for current-cycle and historical winners', () => {
    const elon = planner.plans.find(p => p.contract === ELON)!;
    expect(elon.historyRiskStatus).toBe('CLEAN');
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.historyRiskStatus).toBe('CLEAN');
  });

  it('historyRiskStatus BLOCKED with reasons for blocked tokens', () => {
    const one = planner.plans.find(p => p.contract === ONE)!;
    expect(one.historyRiskStatus).toBe('BLOCKED');
    expect(one.historyRiskReasons).toBeDefined();
    expect(one.historyRiskReasons!.join(' ')).toMatch(/loseCount >= 1/);
  });

  it('does not include live trade fields on any plan', () => {
    for (const plan of planner.plans) {
      expect((plan as Record<string, unknown>).txHash).toBeUndefined();
      expect((plan as Record<string, unknown>).wallet).toBeUndefined();
      expect((plan as Record<string, unknown>).privateKey).toBeUndefined();
      expect((plan as Record<string, unknown>).signature).toBeUndefined();
      expect((plan as Record<string, unknown>).LIVE_EXECUTED).toBeUndefined();
    }
  });

  it('each plan has safety banners', () => {
    for (const plan of planner.plans) {
      expect(plan.tradingExecuted).toBe(0);
      expect(plan.noRealTradeSent).toBe(true);
      expect(plan.readOnly).toBe(true);
      expect(plan.paperOnly).toBe(true);
    }
  });

  it('report-level safety banners are set', () => {
    expect(planner.readOnly).toBe(true);
    expect(planner.paperOnly).toBe(true);
    expect(planner.tradingExecuted).toBe(0);
    expect(planner.noRealTradeSent).toBe(true);
  });

  it('CURRENT_CYCLE_PAPER_ENTRY plans rank before all others', () => {
    const indices = planner.plans.map((p, i) => ({ rec: p.recommendation, i }));
    const lastCurrent = [...indices].reverse().find(x => x.rec === 'CURRENT_CYCLE_PAPER_ENTRY');
    const firstNonCurrent = indices.find(x => x.rec !== 'CURRENT_CYCLE_PAPER_ENTRY');
    if (lastCurrent && firstNonCurrent) {
      expect(lastCurrent.i).toBeLessThan(firstNonCurrent.i);
    }
  });

  it('HISTORICAL_JOURNAL_WINNER ranks after CURRENT_CYCLE_PAPER_ENTRY but before WATCH_ONLY', () => {
    const recs = planner.plans.map(p => p.recommendation);
    const firstHistorical = recs.indexOf('HISTORICAL_JOURNAL_WINNER');
    const firstWatch = recs.indexOf('WATCH_ONLY');
    const lastCurrent = [...recs].reverse().indexOf('CURRENT_CYCLE_PAPER_ENTRY');
    const lastCurrentIdx = recs.length - 1 - lastCurrent;
    if (firstHistorical >= 0 && firstWatch >= 0) {
      expect(firstHistorical).toBeLessThan(firstWatch);
    }
    if (lastCurrentIdx >= 0 && firstHistorical >= 0) {
      expect(lastCurrentIdx).toBeLessThan(firstHistorical);
    }
  });

  it('counts match plan list', () => {
    const c = planner.plans.filter(p => p.recommendation === 'CURRENT_CYCLE_PAPER_ENTRY').length;
    const h = planner.plans.filter(p => p.recommendation === 'HISTORICAL_JOURNAL_WINNER').length;
    const w = planner.plans.filter(p => p.recommendation === 'WATCH_ONLY').length;
    const b = planner.plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK').length;
    const n = planner.plans.filter(p => p.recommendation === 'NO_ENTRY').length;
    expect(planner.currentCyclePaperEntry).toBe(c);
    expect(planner.historicalJournalWinners).toBe(h);
    expect(planner.watchOnly).toBe(w);
    expect(planner.blockedHistoryRisk).toBe(b);
    expect(planner.noEntry).toBe(n);
    expect(planner.totalPlans).toBe(c + h + w + b + n);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────────────

describe('renderDexPaperEntryPlanReport', () => {
  const planner = buildDexPaperEntryPlans(makeRuns(), makeSignals(), makeJournal(), OPTS);
  const rendered = renderDexPaperEntryPlanReport(planner);

  it('includes safety banners', () => {
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).toContain('PAPER ONLY');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('NO REAL TRADE SENT');
  });

  it('shows CURRENT_CYCLE_PAPER_ENTRY and HISTORICAL_JOURNAL_WINNER labels', () => {
    expect(rendered).toContain('CURRENT_CYCLE_PAPER_ENTRY');
    expect(rendered).toContain('HISTORICAL_JOURNAL_WINNER');
  });

  it('shows the latest real run file name', () => {
    expect(rendered).toContain('run-e-new.json');
  });

  it('does not mention live trade execution fields', () => {
    expect(rendered).not.toContain('txHash');
    expect(rendered).not.toContain('LIVE_EXECUTED');
    expect(rendered).not.toContain('privateKey');
    expect(rendered).not.toContain('walletAddress');
  });
});

// ── I/O: runDexPaperEntryPlanner ─────────────────────────────────────────────────────

describe('runDexPaperEntryPlanner (I/O)', () => {
  it('writes a valid plan JSON to the out path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-planner-'));
    const runsDir = path.join(tmpDir, 'runs');
    fs.mkdirSync(runsDir);

    const run = report([winO(ELON, 'ELON', 29, 13, 0.44)]);
    fs.writeFileSync(path.join(runsDir, 'run-001.json'), JSON.stringify(run));

    const outPath = path.join(tmpDir, 'out', 'plan.json');
    const opts: DexPaperEntryPlannerOptions = {
      signalsFile: path.join(tmpDir, 'signals.json'),
      runsDir,
      journalFile: path.join(tmpDir, 'journal.json'),
      out: outPath,
      fakeBankroll: 20,
      positionSize: 1,
    };

    const result = runDexPaperEntryPlanner(opts);
    expect(result.totalPlans).toBeGreaterThan(0);
    expect(result.latestRealRunFile).toBe('run-001.json');
    expect(result.currentCyclePaperEntry).toBe(1);
    expect(fs.existsSync(outPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as DexPaperEntryPlanReport;
    expect(written.tradingExecuted).toBe(0);
    expect(written.readOnly).toBe(true);
    expect(written.paperOnly).toBe(true);
    expect(written.noRealTradeSent).toBe(true);
    expect(written.plans).toBeInstanceOf(Array);
    expect(written.latestRealRunFile).toBe('run-001.json');
  });

  it('plan JSON never contains live-trade fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-planner2-'));
    const runsDir = path.join(tmpDir, 'runs');
    fs.mkdirSync(runsDir);
    const run = report([winO(ELON, 'ELON', 29, 13, 0.44)]);
    fs.writeFileSync(path.join(runsDir, 'run-001.json'), JSON.stringify(run));

    const outPath = path.join(tmpDir, 'plan.json');
    runDexPaperEntryPlanner({
      signalsFile: path.join(tmpDir, 'signals.json'),
      runsDir,
      journalFile: path.join(tmpDir, 'journal.json'),
      out: outPath,
    });

    const raw = fs.readFileSync(outPath, 'utf-8');
    expect(raw).not.toContain('txHash');
    expect(raw).not.toContain('wallet');
    expect(raw).not.toContain('privateKey');
    expect(raw).not.toContain('signature');
    expect(raw).not.toContain('LIVE_EXECUTED');
  });

  it('smoke.json in runs dir is ignored when determining latest real run', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-planner3-'));
    const runsDir = path.join(tmpDir, 'runs');
    fs.mkdirSync(runsDir);

    // Real run (older)
    const realRun = report([winO(ELON, 'ELON', 29, 13, 0.44)]);
    fs.writeFileSync(path.join(runsDir, 'run-001.json'), JSON.stringify(realRun));

    // smoke.json has a token that would win if considered "current"
    const smokeRun = report([winO(SMOKE_TK, 'SMOKE', 99, 50, 0.2)]);
    fs.writeFileSync(path.join(runsDir, 'smoke.json'), JSON.stringify(smokeRun));

    const outPath = path.join(tmpDir, 'plan.json');
    const result = runDexPaperEntryPlanner({
      signalsFile: path.join(tmpDir, 'signals.json'),
      runsDir,
      journalFile: path.join(tmpDir, 'journal.json'),
      out: outPath,
    });

    expect(result.latestRealRunFile).toBe('run-001.json');
    const smokePlan = result.plans.find(p => p.contract === SMOKE_TK);
    if (smokePlan) {
      expect(smokePlan.recommendation).not.toBe('CURRENT_CYCLE_PAPER_ENTRY');
    }
  });
});

// ── Type reference ────────────────────────────────────────────────────────────────────
type DexPaperEntryPlanReport = ReturnType<typeof buildDexPaperEntryPlans>;
