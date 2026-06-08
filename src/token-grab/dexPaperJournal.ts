import fs from 'node:fs';
import path from 'node:path';
import type { DexWatchReport, DexWatchOutcome } from './dexWatch';
import { parseWatchReport, outcomesFromReport } from './dexWatchSummary';
import { buildDexCandidateSimReport } from './dexCandidateSim';
import { PASS_PRICE_PCT, PASS_LIQ_PCT, PASS_VLR_MAX } from './dexWatchCandidates';

// ── Types ───────────────────────────────────────────────────────────────────────────

/** A saved watch run paired with its source file name. */
export interface LoadedRun {
  file: string; // basename of the run file
  report: DexWatchReport;
  generatedAt?: string;
}

/** One journaled paper (fake) entry — all fields are hypothetical, no real order. */
export interface JournalTrade {
  runGeneratedAt?: string;
  sourceRunFile?: string;
  symbol?: string;
  contract: string;
  fakePositionSize: number;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  fakePnlDollars: number;
  fakePnlPct: number;
  passReason: string;
  outcome: 'winner' | 'loser';
}

/** A candidate that met PASS thresholds but was blocked by ugly prior history. */
export interface JournalBlocked {
  symbol?: string;
  contract: string;
  priceChangePct?: number;
  loseCount: number;
  drainCount: number;
  missingCount: number;
  avgVolumeLiquidityRatio?: number;
  reasons: string[];
}

export interface DexPaperJournal {
  journaledAt?: string;
  dir: string;
  out: string;
  fakeBankroll: number;
  fakePositionSize: number;

  totalSimulatedTrades: number;
  totalFakePnlDollars: number;
  totalFakePnlPct: number;
  winRate: number;
  blockedByHistoryRisk: number;

  trades: JournalTrade[];
  blocked: JournalBlocked[];

  // ── Safety markers (read-only, paper-only) ──
  readOnly: true;
  paperOnly: true;
  dryRun: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface DexPaperJournalOptions {
  dir: string;
  out: string;
  fakeBankroll?: number;
  positionSize?: number;
  journaledAt?: string;
}

// ── Loading runs (read-only, keeps source file names) ──────────────────────────────────

/** Reads every saved watch report from a directory, newest first, retaining file names. */
export function loadRunsWithFiles(dir: string): LoadedRun[] {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ run: LoadedRun; sortKey: string }> = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.json')) continue;
    const full = path.join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    const report = parseWatchReport(parsed);
    if (!report) continue;
    let mtime = '';
    try {
      mtime = fs.statSync(full).mtime.toISOString();
    } catch {
      mtime = '';
    }
    out.push({
      run: { file, report, generatedAt: report.generatedAt },
      sortKey: report.generatedAt ?? mtime ?? file,
    });
  }
  out.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return out.map(o => o.run);
}

// ── Strongest-outcome + source lookup (mirrors the sim's strongest selection) ──────────

interface StrongestInfo {
  outcome: DexWatchOutcome;
  file?: string;
  generatedAt?: string;
}

function strongestByContract(runs: LoadedRun[]): Map<string, StrongestInfo> {
  const map = new Map<string, StrongestInfo>();
  for (const run of runs) {
    for (const o of outcomesFromReport(run.report)) {
      const key = o.contract.toLowerCase();
      const cur = map.get(key);
      const curPct = cur?.outcome.priceChangePct;
      const nextPct = o.priceChangePct;
      if (!cur) {
        map.set(key, { outcome: o, file: run.file, generatedAt: run.generatedAt });
      } else if (typeof nextPct === 'number' && (typeof curPct !== 'number' || nextPct > curPct)) {
        map.set(key, { outcome: o, file: run.file, generatedAt: run.generatedAt });
      }
    }
  }
  return map;
}

function passReasonFor(price?: number, liq?: number, vlr?: number): string {
  const p = typeof price === 'number' ? `+${price.toFixed(1)}%` : 'n/a';
  const l = typeof liq === 'number' ? `+${liq.toFixed(1)}%` : 'n/a';
  const v = typeof vlr === 'number' ? vlr.toFixed(2) : 'n/a';
  return `PASS: price ${p} >= +${PASS_PRICE_PCT}, liquidity ${l} >= +${PASS_LIQ_PCT}, v/l ${v} <= ${PASS_VLR_MAX}, history clean`;
}

// ── Journal builder — pure ──────────────────────────────────────────────────────────────

export function buildDexPaperJournal(runs: LoadedRun[], options: DexPaperJournalOptions): DexPaperJournal {
  const fakeBankroll = options.fakeBankroll ?? 20;
  const positionSize = options.positionSize ?? 1;

  const reports = runs.map(r => r.report);
  // Reuse the V2 sim verbatim — identical PASS + history-risk decisions, no rule duplication.
  const sim = buildDexCandidateSimReport(reports, {
    dir: options.dir,
    fakeBankroll,
    positionSize,
  });

  const strongest = strongestByContract(runs);

  const trades: JournalTrade[] = sim.trades.map(t => {
    const info = strongest.get(t.contract.toLowerCase());
    const liq = info?.outcome.liquidityChangePct;
    const vlr = info?.outcome.volumeToLiquidityRatio;
    return {
      runGeneratedAt: info?.generatedAt,
      sourceRunFile: info?.file,
      symbol: t.symbol,
      contract: t.contract,
      fakePositionSize: t.positionSize,
      priceChangePct: t.priceChangePct,
      liquidityChangePct: liq,
      volumeLiquidityRatio: vlr,
      fakePnlDollars: t.pnlDollars,
      fakePnlPct: t.pnlPct,
      passReason: passReasonFor(t.priceChangePct, liq, vlr),
      outcome: t.outcome,
    };
  });

  const blocked: JournalBlocked[] = sim.historyRiskBlocked.map(b => ({
    symbol: b.symbol,
    contract: b.contract,
    priceChangePct: b.priceChangePct,
    loseCount: b.loseCount,
    drainCount: b.drainCount,
    missingCount: b.missingCount,
    avgVolumeLiquidityRatio: b.avgVolumeLiquidityRatio,
    reasons: b.reasons,
  }));

  return {
    journaledAt: options.journaledAt,
    dir: options.dir,
    out: options.out,
    fakeBankroll,
    fakePositionSize: positionSize,

    totalSimulatedTrades: sim.tradesSimulated,
    totalFakePnlDollars: sim.fakeRealizedPnlDollars,
    totalFakePnlPct: sim.fakeRealizedPnlPct,
    winRate: sim.winRate,
    blockedByHistoryRisk: sim.blockedByHistoryRisk,

    trades,
    blocked,

    readOnly: true,
    paperOnly: true,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Write — I/O ─────────────────────────────────────────────────────────────────────────

export function writeJournal(journal: DexPaperJournal, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(journal, null, 2), 'utf-8');
}

// ── Orchestration — I/O ─────────────────────────────────────────────────────────────────

export function runDexPaperJournal(options: DexPaperJournalOptions): DexPaperJournal {
  const runs = loadRunsWithFiles(options.dir);
  const journal = buildDexPaperJournal(runs, options);
  writeJournal(journal, options.out);
  return journal;
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export function renderDexPaperJournal(journal: DexPaperJournal): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX PAPER ENTRY JOURNAL V1');
  lines.push('  READ-ONLY — PAPER ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Runs dir            : ${journal.dir}`);
  lines.push(`  Journal out         : ${journal.out}`);
  lines.push(`  Fake bankroll       : $${journal.fakeBankroll.toFixed(2)}`);
  lines.push(`  Fake position size  : $${journal.fakePositionSize.toFixed(2)}`);
  lines.push(`  Total simulated     : ${journal.totalSimulatedTrades}`);
  lines.push(`  Total fake P/L       : ${fmtUsd(journal.totalFakePnlDollars)} (${fmtPct(journal.totalFakePnlPct)})`);
  lines.push(`  Win rate            : ${(journal.winRate * 100).toFixed(1)}%`);
  lines.push(`  Blocked (history)   : ${journal.blockedByHistoryRisk}`);

  if (journal.trades.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top journaled trades (by P/L):');
    const sorted = [...journal.trades].sort((a, b) => b.fakePnlDollars - a.fakePnlDollars).slice(0, 10);
    for (const t of sorted) {
      const sym = (t.symbol ? `$${t.symbol}` : '(no sym)').padEnd(12);
      lines.push(
        `    ${sym} ${fmtUsd(t.fakePnlDollars).padStart(9)} (${fmtPct(t.fakePnlPct)})` +
          `  price ${fmtPct(t.priceChangePct)}  liq ${fmtPct(t.liquidityChangePct)}  ${t.contract.slice(0, 6)}…`,
      );
    }
  }

  if (journal.blocked.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  Blocked by history risk (${journal.blocked.length}):`);
    for (const b of journal.blocked.slice(0, 20)) {
      const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(12);
      lines.push(`    ${sym} ${b.contract.slice(0, 8)}…  — ${b.reasons.join('; ')}`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  PAPER JOURNAL ONLY — no live-harness gate changed, no PLAN_ONLY trade created');
  lines.push('  Every entry is hypothetical — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
