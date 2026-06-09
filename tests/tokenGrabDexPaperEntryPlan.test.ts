import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDexWatchReport, type DexWatchOutcome, type DexWatchReport } from '../src/token-grab/dexWatch';
import {
  buildDexPaperEntryPlans,
  renderDexPaperEntryPlanReport,
  runDexPaperEntryPlanner,
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

function report(outcomes: DexWatchOutcome[], generatedAt = '2026-06-07T10:00:00.000Z'): DexWatchReport {
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
const SATOSHI  = 'SatoSh11111111111111111111111111111111111111'; // clean pass
const ELON     = 'eLonBuck2222222222222222222222222222222222222'; // clean pass
const ONE      = 'OneChurn333333333333333333333333333333333333'; // pass thresholds but history blocked
const FLAT_TK  = 'FlatTk44444444444444444444444444444444444444'; // small movement → WATCH_ONLY
const NEG_TK   = 'NegTk555555555555555555555555555555555555555'; // negative/flat → NO_ENTRY
const MISSING  = 'missingX666666666666666666666666666666666666'; // in signals only, no run data

function makeRuns(): LoadedRun[] {
  return [
    { file: 'run-1.json', report: report([winO(SATOSHI, 'SATOSHI', 54, 23, 0.33)]), generatedAt: '2026-06-07T10:00:00.000Z' },
    { file: 'run-2.json', report: report([winO(ELON,    'ELON',    29, 13, 0.44)]), generatedAt: '2026-06-07T10:10:00.000Z' },
    // ONE: strong win once, hard loss once → loseCount >= 1 → BLOCKED_HISTORY_RISK
    { file: 'run-3.json', report: report([winO(ONE,  'ONE',  40, 16, 0.6)]),  generatedAt: '2026-06-07T10:20:00.000Z' },
    { file: 'run-4.json', report: report([loseO(ONE, 'ONE', -30, -25, 0.7)]), generatedAt: '2026-06-07T10:30:00.000Z' },
    // FLAT_TK: only small movement, not enough for PASS → WATCH_ONLY
    { file: 'run-5.json', report: report([flatO(FLAT_TK, 'FLAT')]), generatedAt: '2026-06-07T10:40:00.000Z' },
    // NEG_TK: negative movement → NO_ENTRY
    { file: 'run-6.json', report: report([negO(NEG_TK, 'NEG')]), generatedAt: '2026-06-07T10:50:00.000Z' },
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
        sourceRunFile: 'run-1.json',
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
  plannedAt: '2026-06-07T12:00:00.000Z',
};

// ── Core planner tests ───────────────────────────────────────────────────────────────

describe('buildDexPaperEntryPlans', () => {
  const planner = buildDexPaperEntryPlans(makeRuns(), makeSignals(), makeJournal(), OPTS);

  it('creates a valid plan JSON with plans array', () => {
    expect(planner.plans).toBeInstanceOf(Array);
    expect(planner.totalPlans).toBeGreaterThan(0);
    expect(planner.plans.length).toBe(planner.totalPlans);
  });

  it('PAPER_ENTRY_CANDIDATE only for candidates passing existing sim rules', () => {
    const candidates = planner.plans.filter(p => p.recommendation === 'PAPER_ENTRY_CANDIDATE');
    expect(candidates.length).toBe(2); // SATOSHI + ELON
    const cs = candidates.map(p => p.contract);
    expect(cs).toContain(SATOSHI);
    expect(cs).toContain(ELON);
    expect(cs).not.toContain(ONE);  // ONE is blocked by history
    expect(cs).not.toContain(FLAT_TK);
  });

  it('BLOCKED_HISTORY_RISK for candidates blocked by existing history-risk logic', () => {
    const blocked = planner.plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK');
    expect(blocked.length).toBeGreaterThan(0);
    const cs = blocked.map(p => p.contract);
    expect(cs).toContain(ONE);
    expect(cs).not.toContain(SATOSHI);
    expect(cs).not.toContain(ELON);
  });

  it('WATCH_ONLY for tokens moving but not clean enough', () => {
    const watchOnly = planner.plans.filter(p => p.recommendation === 'WATCH_ONLY');
    const cs = watchOnly.map(p => p.contract);
    expect(cs).toContain(FLAT_TK);
  });

  it('NO_ENTRY for flat/negative tokens and tokens only in signals', () => {
    const noEntry = planner.plans.filter(p => p.recommendation === 'NO_ENTRY');
    const cs = noEntry.map(p => p.contract);
    expect(cs).toContain(MISSING); // in signals but no run data
    expect(cs).toContain(NEG_TK);  // negative movement, no upside
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
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.priceChangePct).toBeCloseTo(54);
    expect(sat.liquidityChangePct).toBeCloseTo(23);
    expect(sat.volumeLiquidityRatio).toBeCloseTo(0.33);
  });

  it('includes source run file for run-backed candidates', () => {
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.sourceRunFile).toBe('run-1.json');
  });

  it('includes journal similarity note for prior journal winners', () => {
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.journalSimilarity).toBeDefined();
    expect(sat.journalSimilarity).toContain('prior winner');
  });

  it('historyRiskStatus CLEAN for passing candidates', () => {
    const sat = planner.plans.find(p => p.contract === SATOSHI)!;
    expect(sat.historyRiskStatus).toBe('CLEAN');
    expect(sat.historyRiskReasons).toBeUndefined();
  });

  it('historyRiskStatus BLOCKED with reasons for blocked tokens', () => {
    const one = planner.plans.find(p => p.contract === ONE)!;
    expect(one.historyRiskStatus).toBe('BLOCKED');
    expect(one.historyRiskReasons).toBeDefined();
    expect(one.historyRiskReasons!.length).toBeGreaterThan(0);
    expect(one.historyRiskReasons!.join(' ')).toMatch(/loseCount >= 1/);
  });

  it('does not include live trade fields', () => {
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

  it('PAPER_ENTRY_CANDIDATE plans rank before WATCH_ONLY and BLOCKED_HISTORY_RISK', () => {
    const indices = planner.plans.map((p, i) => ({ rec: p.recommendation, i }));
    const lastCandidate = [...indices].reverse().find(x => x.rec === 'PAPER_ENTRY_CANDIDATE');
    const firstNonCandidate = indices.find(x => x.rec !== 'PAPER_ENTRY_CANDIDATE');
    if (lastCandidate && firstNonCandidate) {
      expect(lastCandidate.i).toBeLessThan(firstNonCandidate.i);
    }
  });

  it('fakeEntrySize equals positionSize', () => {
    for (const plan of planner.plans) {
      expect(plan.fakeEntrySize).toBe(1);
    }
  });

  it('counts match plan list', () => {
    const c = planner.plans.filter(p => p.recommendation === 'PAPER_ENTRY_CANDIDATE').length;
    const w = planner.plans.filter(p => p.recommendation === 'WATCH_ONLY').length;
    const b = planner.plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK').length;
    const n = planner.plans.filter(p => p.recommendation === 'NO_ENTRY').length;
    expect(planner.paperEntryCandidates).toBe(c);
    expect(planner.watchOnly).toBe(w);
    expect(planner.blockedHistoryRisk).toBe(b);
    expect(planner.noEntry).toBe(n);
    expect(planner.totalPlans).toBe(c + w + b + n);
  });
});

// ── Renderer tests ────────────────────────────────────────────────────────────────────

describe('renderDexPaperEntryPlanReport', () => {
  const planner = buildDexPaperEntryPlans(makeRuns(), makeSignals(), makeJournal(), OPTS);
  const rendered = renderDexPaperEntryPlanReport(planner);

  it('includes safety banners in rendered output', () => {
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).toContain('PAPER ONLY');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('NO REAL TRADE SENT');
  });

  it('shows recommendation category counts', () => {
    expect(rendered).toContain('PAPER_ENTRY_CANDIDATE');
    expect(rendered).toContain('BLOCKED_HISTORY_RISK');
    expect(rendered).toContain('WATCH_ONLY');
  });

  it('does not mention live trade execution fields', () => {
    // Safety banners ("No wallet", "No swap") are expected and allowed.
    // What we must NOT see are fields that indicate a real trade was sent.
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

    const run = report([winO(SATOSHI, 'SATOSHI', 54, 23, 0.33)]);
    fs.writeFileSync(path.join(runsDir, 'run-1.json'), JSON.stringify(run));

    const outPath = path.join(tmpDir, 'out', 'plan.json');
    const opts: DexPaperEntryPlannerOptions = {
      signalsFile: path.join(tmpDir, 'signals.json'), // missing signals file → empty
      runsDir,
      journalFile: path.join(tmpDir, 'journal.json'), // missing journal → empty
      out: outPath,
      fakeBankroll: 20,
      positionSize: 1,
    };

    const result = runDexPaperEntryPlanner(opts);
    expect(result.totalPlans).toBeGreaterThan(0);
    expect(fs.existsSync(outPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as DexPaperEntryPlanReport;
    expect(written.tradingExecuted).toBe(0);
    expect(written.readOnly).toBe(true);
    expect(written.paperOnly).toBe(true);
    expect(written.noRealTradeSent).toBe(true);
    expect(written.plans).toBeInstanceOf(Array);
  });

  it('plan JSON never contains live-trade fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-planner2-'));
    const runsDir = path.join(tmpDir, 'runs');
    fs.mkdirSync(runsDir);
    const run = report([winO(SATOSHI, 'SATOSHI', 54, 23, 0.33)]);
    fs.writeFileSync(path.join(runsDir, 'run-1.json'), JSON.stringify(run));

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
});

// ── Type import reference (keeps compiler happy) ─────────────────────────────────────
type DexPaperEntryPlanReport = ReturnType<typeof buildDexPaperEntryPlans>;
