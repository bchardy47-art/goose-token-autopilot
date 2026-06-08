import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDexWatchReport,
  type DexWatchOutcome,
  type DexWatchReport,
} from '../src/token-grab/dexWatch';
import {
  buildDexPaperJournal,
  renderDexPaperJournal,
  runDexPaperJournal,
  loadRunsWithFiles,
  writeJournal,
  type LoadedRun,
} from '../src/token-grab/dexPaperJournal';

// ── Fixtures ────────────────────────────────────────────────────────────────────────

function outcome(over: Partial<DexWatchOutcome> & Pick<DexWatchOutcome, 'contract' | 'classification'>): DexWatchOutcome {
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

const winO = (contract: string, symbol: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract, symbol, classification: 'winner', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });
const loseO = (contract: string, symbol: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract, symbol, classification: 'loser', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });

const SATOSHI = 'SatoSh11111111111111111111111111111111111111';
const ELON = 'eLonBuck2222222222222222222222222222222222222';
const ONE = 'OneChurn333333333333333333333333333333333333';

// Two clean winners (pass) + one ugly-history token (blocked).
function makeRuns(): LoadedRun[] {
  return [
    { file: 'run-1.json', report: report([winO(SATOSHI, 'SATOSHI', 54, 23, 0.33)], '2026-06-07T10:00:00.000Z'), generatedAt: '2026-06-07T10:00:00.000Z' },
    { file: 'run-2.json', report: report([winO(ELON, 'elonbucks', 29, 13, 0.44)], '2026-06-07T10:10:00.000Z'), generatedAt: '2026-06-07T10:10:00.000Z' },
    // ONE: a strong win but with losing/draining history → history-risk blocked.
    { file: 'run-3.json', report: report([winO(ONE, '1', 40, 16, 0.6)], '2026-06-07T10:20:00.000Z'), generatedAt: '2026-06-07T10:20:00.000Z' },
    { file: 'run-4.json', report: report([loseO(ONE, '1', -30, -25, 0.7)], '2026-06-07T10:30:00.000Z'), generatedAt: '2026-06-07T10:30:00.000Z' },
  ];
}

const OPTS = { dir: 'd', out: 'out/journal.json', fakeBankroll: 20, positionSize: 1, journaledAt: '2026-06-07T12:00:00.000Z' };

// ── Building the journal ──────────────────────────────────────────────────────────────

describe('buildDexPaperJournal', () => {
  const journal = buildDexPaperJournal(makeRuns(), OPTS);

  it('records every simulated candidate trade', () => {
    expect(journal.totalSimulatedTrades).toBe(2); // SATOSHI + ELON
    expect(journal.trades.map(t => t.contract).sort()).toEqual([SATOSHI, ELON].sort());
  });

  it('enriches trades with price/liquidity/vlr, P/L, pass reason and source run', () => {
    const sat = journal.trades.find(t => t.contract === SATOSHI)!;
    expect(sat.priceChangePct).toBeCloseTo(54);
    expect(sat.liquidityChangePct).toBeCloseTo(23);
    expect(sat.volumeLiquidityRatio).toBeCloseTo(0.33);
    expect(sat.fakePnlDollars).toBeCloseTo(0.54);
    expect(sat.fakePnlPct).toBeCloseTo(54);
    expect(sat.fakePositionSize).toBe(1);
    expect(sat.passReason).toMatch(/PASS/);
    expect(sat.sourceRunFile).toBe('run-1.json');
    expect(sat.runGeneratedAt).toBe('2026-06-07T10:00:00.000Z');
    expect(sat.outcome).toBe('winner');
  });

  it('includes blocked history-risk records separately', () => {
    expect(journal.blockedByHistoryRisk).toBe(1);
    const b = journal.blocked.find(x => x.contract === ONE)!;
    expect(b).toBeDefined();
    expect(b.reasons.join(' ')).toMatch(/loseCount >= 1|drainCount >= 1/);
    // A blocked candidate must NOT appear as a simulated trade.
    expect(journal.trades.some(t => t.contract === ONE)).toBe(false);
  });

  it('does not create trades the sim would not pass', () => {
    // ONE only appears in blocked, never in trades.
    expect(journal.trades.some(t => t.contract === ONE)).toBe(false);
  });

  it('totals fake P/L and win rate', () => {
    expect(journal.totalFakePnlDollars).toBeCloseTo(0.54 + 0.29);
    expect(journal.winRate).toBeCloseTo(1.0);
  });

  it('carries read-only / paper-only safety markers', () => {
    expect(journal.readOnly).toBe(true);
    expect(journal.paperOnly).toBe(true);
    expect(journal.dryRun).toBe(false);
    expect(journal.tradingExecuted).toBe(0);
    expect(journal.noRealTradeSent).toBe(true);
  });

  it('does not write any live-trade fields', () => {
    const json = JSON.stringify(journal);
    expect(json).not.toMatch(/txHash|signature|walletAddress|privateKey|secretKey|executed["']?\s*:\s*true|LIVE_EXECUTED|swapTx/i);
  });
});

// ── Writing + reading the journal file ──────────────────────────────────────────────────

describe('writeJournal / valid JSON', () => {
  it('writes a journal file that is valid JSON with trades + blocked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    const out = path.join(dir, 'nested', 'dex-paper-journal.json');
    const journal = buildDexPaperJournal(makeRuns(), { ...OPTS, out });
    writeJournal(journal, out);
    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.trades).toHaveLength(2);
    expect(parsed.blocked).toHaveLength(1);
    expect(parsed.tradingExecuted).toBe(0);
  });
});

// ── End-to-end from saved run files ──────────────────────────────────────────────────────

describe('runDexPaperJournal', () => {
  it('loads saved runs from a dir, simulates and writes the journal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-runs-'));
    const runs = makeRuns();
    runs.forEach(r => fs.writeFileSync(path.join(dir, r.file), JSON.stringify(r.report, null, 2), 'utf-8'));
    const out = path.join(dir, 'paper-journal', 'dex-paper-journal.json');
    const journal = runDexPaperJournal({ dir, out, fakeBankroll: 20, positionSize: 1, journaledAt: 't' });
    expect(journal.totalSimulatedTrades).toBe(2);
    expect(journal.blockedByHistoryRisk).toBe(1);
    expect(fs.existsSync(out)).toBe(true);
    // source run files are real basenames from the dir
    const sat = journal.trades.find(t => t.contract === SATOSHI)!;
    expect(sat.sourceRunFile).toBe('run-1.json');
  });

  it('loadRunsWithFiles ignores non-watch-report json and missing dirs', () => {
    expect(loadRunsWithFiles(path.join(os.tmpdir(), 'nope-xyz'))).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-bad-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf-8');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not valid', 'utf-8');
    fs.writeFileSync(path.join(dir, 'notreport.json'), JSON.stringify({ foo: 1 }), 'utf-8');
    expect(loadRunsWithFiles(dir)).toEqual([]);
  });
});

// ── Render / safety ──────────────────────────────────────────────────────────────────────

describe('renderDexPaperJournal', () => {
  const out = renderDexPaperJournal(buildDexPaperJournal(makeRuns(), OPTS));

  it('shows journal path, totals, win rate, blocked count and top trades', () => {
    expect(out).toMatch(/Journal out/);
    expect(out).toMatch(/Total simulated/);
    expect(out).toMatch(/Total fake P\/L/);
    expect(out).toMatch(/Win rate/);
    expect(out).toMatch(/Blocked \(history\)/);
    expect(out).toMatch(/Top journaled trades/);
  });

  it('includes read-only / paper-only safety banners', () => {
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
  });

  it('contains no trading / swap / signing terms beyond explicit negations', () => {
    expect(out).not.toMatch(/LIVE_EXECUTED/);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toMatch(/sign(ing)? transaction/i);
    for (const word of ['swap', 'wallet', 'signing']) {
      const lines = out.split('\n').filter(l => l.toLowerCase().includes(word));
      for (const l of lines) expect(l.toLowerCase()).toMatch(/no /);
    }
  });
});

describe('dexPaperJournal source safety', () => {
  it('module exposes no wallet / key / swap / signing / browser primitives', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexPaperJournal.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|seed phrase|wallet\.connect|jupiter\.swap|executeSwap|LIVE_EXECUTED|puppeteer|playwright|selenium/i);
  });
});
