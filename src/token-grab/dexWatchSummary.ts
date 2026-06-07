import fs from 'node:fs';
import path from 'node:path';
import type { DexWatchReport, DexWatchOutcome, DexWatchClass } from './dexWatch';

// ── Thresholds ─────────────────────────────────────────────────────────────────────

/** A liquidity move at or below this percent counts as a "drain" occurrence. */
export const DRAIN_PCT = -20;
/** Minimum repeats for repeat-winner / repeat-loser / avoid / churn classification. */
export const REPEAT_MIN = 2;

// ── Types ───────────────────────────────────────────────────────────────────────────

/** Per-contract aggregate rolled up across many watch runs. */
export interface ContractAggregate {
  contract: string;
  symbol?: string;
  appearances: number;
  winCount: number;
  loseCount: number;
  flatCount: number;
  missingCount: number;
  drainCount: number; // runs where liquidity dropped <= DRAIN_PCT
  priceUpLiqUpCount: number; // runs where price AND liquidity both rose
  avgPricePct?: number;
  avgLiquidityPct?: number;
  avgVlr?: number; // average volume/liquidity ratio
  maxVlr?: number;
}

export interface DexWatchSummary {
  dir: string;
  totalRuns: number;
  contractsWatched: number; // distinct contracts seen
  totalOutcomes: number;

  winnersCount: number;
  losersCount: number;
  flatCount: number;
  missingCount: number;

  repeatWinnersCount: number;
  repeatLosersCount: number;

  avgWinnerPricePct?: number;
  avgWinnerLiquidityPct?: number;
  avgLoserPricePct?: number;
  avgLoserLiquidityPct?: number;

  repeatWinners: ContractAggregate[];
  repeatLosers: ContractAggregate[];
  repeatedlyLosing: ContractAggregate[]; // contracts that lose >= REPEAT_MIN times
  topVlChurn: ContractAggregate[];

  avoidList: ContractAggregate[];
  watchList: ContractAggregate[];

  dryRun: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Loading saved reports — I/O ──────────────────────────────────────────────────────

function isOutcome(v: unknown): v is DexWatchOutcome {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['contract'] === 'string' && typeof o['classification'] === 'string';
}

/** Validates a parsed JSON blob is a usable DexWatchReport. Lenient: tolerates missing arrays. */
export function parseWatchReport(raw: unknown): DexWatchReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const arrays = ['winners', 'losers', 'flat', 'missing'];
  // Must have at least the four outcome arrays to be a watch report.
  for (const key of arrays) {
    if (!Array.isArray(obj[key])) return null;
  }
  return obj as unknown as DexWatchReport;
}

/**
 * Reads up to `limit` saved DEX watch reports from a directory (newest first).
 * Newest is determined by `generatedAt` when present, else file mtime.
 * Read-only — never writes. Skips unparseable files silently.
 */
export function loadWatchReports(dir: string, limit = 20): DexWatchReport[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.json'));

  const loaded: Array<{ report: DexWatchReport; sortKey: string }> = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    const report = parseWatchReport(parsed);
    if (!report) continue;
    const mtime = (() => {
      try {
        return fs.statSync(full).mtime.toISOString();
      } catch {
        return '';
      }
    })();
    loaded.push({ report, sortKey: report.generatedAt ?? mtime ?? file });
  }

  loaded.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return loaded.slice(0, Math.max(0, limit)).map(l => l.report);
}

// ── Aggregation — pure ───────────────────────────────────────────────────────────────

/** Flattens a report's classified outcome arrays back into a single labelled list. */
export function outcomesFromReport(report: DexWatchReport): DexWatchOutcome[] {
  const out: DexWatchOutcome[] = [];
  const groups: Array<[DexWatchClass, DexWatchOutcome[] | undefined]> = [
    ['winner', report.winners],
    ['loser', report.losers],
    ['flat', report.flat],
    ['missing', report.missing],
  ];
  for (const [cls, list] of groups) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (!isOutcome(o)) continue;
      // Trust the bucket it was filed under for classification.
      out.push({ ...o, classification: cls });
    }
  }
  return out;
}

function avg(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function buildDexWatchSummary(reports: DexWatchReport[], dir = ''): DexWatchSummary {
  const byContract = new Map<
    string,
    {
      contract: string;
      symbol?: string;
      appearances: number;
      winCount: number;
      loseCount: number;
      flatCount: number;
      missingCount: number;
      drainCount: number;
      priceUpLiqUpCount: number;
      pricePcts: number[];
      liqPcts: number[];
      vlrs: number[];
    }
  >();

  let winnersCount = 0;
  let losersCount = 0;
  let flatCount = 0;
  let missingCount = 0;

  const winnerPrice: number[] = [];
  const winnerLiq: number[] = [];
  const loserPrice: number[] = [];
  const loserLiq: number[] = [];

  for (const report of reports) {
    for (const o of outcomesFromReport(report)) {
      const key = o.contract.toLowerCase();
      let agg = byContract.get(key);
      if (!agg) {
        agg = {
          contract: o.contract,
          symbol: o.symbol,
          appearances: 0,
          winCount: 0,
          loseCount: 0,
          flatCount: 0,
          missingCount: 0,
          drainCount: 0,
          priceUpLiqUpCount: 0,
          pricePcts: [],
          liqPcts: [],
          vlrs: [],
        };
        byContract.set(key, agg);
      }
      if (!agg.symbol && o.symbol) agg.symbol = o.symbol;
      agg.appearances += 1;

      if (typeof o.priceChangePct === 'number') agg.pricePcts.push(o.priceChangePct);
      if (typeof o.liquidityChangePct === 'number') agg.liqPcts.push(o.liquidityChangePct);
      if (typeof o.volumeToLiquidityRatio === 'number') agg.vlrs.push(o.volumeToLiquidityRatio);

      if (typeof o.liquidityChangePct === 'number' && o.liquidityChangePct <= DRAIN_PCT) {
        agg.drainCount += 1;
      }
      if (
        typeof o.priceChangePct === 'number' &&
        o.priceChangePct > 0 &&
        typeof o.liquidityChangePct === 'number' &&
        o.liquidityChangePct > 0
      ) {
        agg.priceUpLiqUpCount += 1;
      }

      switch (o.classification) {
        case 'winner':
          agg.winCount += 1;
          winnersCount += 1;
          if (typeof o.priceChangePct === 'number') winnerPrice.push(o.priceChangePct);
          if (typeof o.liquidityChangePct === 'number') winnerLiq.push(o.liquidityChangePct);
          break;
        case 'loser':
          agg.loseCount += 1;
          losersCount += 1;
          if (typeof o.priceChangePct === 'number') loserPrice.push(o.priceChangePct);
          if (typeof o.liquidityChangePct === 'number') loserLiq.push(o.liquidityChangePct);
          break;
        case 'flat':
          agg.flatCount += 1;
          flatCount += 1;
          break;
        case 'missing':
          agg.missingCount += 1;
          missingCount += 1;
          break;
      }
    }
  }

  const aggregates: ContractAggregate[] = Array.from(byContract.values()).map(a => ({
    contract: a.contract,
    symbol: a.symbol,
    appearances: a.appearances,
    winCount: a.winCount,
    loseCount: a.loseCount,
    flatCount: a.flatCount,
    missingCount: a.missingCount,
    drainCount: a.drainCount,
    priceUpLiqUpCount: a.priceUpLiqUpCount,
    avgPricePct: avg(a.pricePcts),
    avgLiquidityPct: avg(a.liqPcts),
    avgVlr: avg(a.vlrs),
    maxVlr: a.vlrs.length ? Math.max(...a.vlrs) : undefined,
  }));

  const repeatWinners = aggregates
    .filter(a => a.winCount >= REPEAT_MIN)
    .sort((x, y) => y.winCount - x.winCount);
  const repeatLosers = aggregates
    .filter(a => a.loseCount >= REPEAT_MIN)
    .sort((x, y) => y.loseCount - x.loseCount);
  const repeatedlyLosing = repeatLosers; // alias: contracts that repeatedly lose

  const topVlChurn = aggregates
    .filter(a => a.avgVlr != null)
    .sort((x, y) => (y.avgVlr ?? 0) - (x.avgVlr ?? 0))
    .slice(0, 10);

  // Avoid: loses 2+ times OR liquidity drains 2+ times.
  const avoidList = aggregates
    .filter(a => a.loseCount >= REPEAT_MIN || a.drainCount >= REPEAT_MIN)
    .sort((x, y) => y.loseCount + y.drainCount - (x.loseCount + x.drainCount));

  // Watch: wins 2+ times OR price + liquidity rose together at least once.
  const watchList = aggregates
    .filter(a => a.winCount >= REPEAT_MIN || a.priceUpLiqUpCount >= 1)
    .sort((x, y) => y.winCount + y.priceUpLiqUpCount - (x.winCount + x.priceUpLiqUpCount));

  return {
    dir,
    totalRuns: reports.length,
    contractsWatched: byContract.size,
    totalOutcomes: winnersCount + losersCount + flatCount + missingCount,
    winnersCount,
    losersCount,
    flatCount,
    missingCount,
    repeatWinnersCount: repeatWinners.length,
    repeatLosersCount: repeatLosers.length,
    avgWinnerPricePct: avg(winnerPrice),
    avgWinnerLiquidityPct: avg(winnerLiq),
    avgLoserPricePct: avg(loserPrice),
    avgLoserLiquidityPct: avg(loserLiq),
    repeatWinners,
    repeatLosers,
    repeatedlyLosing,
    topVlChurn,
    avoidList,
    watchList,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderer — pure ───────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function aggRow(a: ContractAggregate): string {
  const sym = (a.symbol ? `$${a.symbol}` : '(no sym)').padEnd(12);
  return (
    `    ${sym} W${a.winCount} L${a.loseCount} F${a.flatCount} M${a.missingCount}` +
    `  drain ${a.drainCount}  upUp ${a.priceUpLiqUpCount}` +
    `  price ${fmtPct(a.avgPricePct)}  liq ${fmtPct(a.avgLiquidityPct)}` +
    `  v/l ${a.avgVlr != null ? a.avgVlr.toFixed(2) : 'n/a'}  ${a.contract.slice(0, 6)}…`
  );
}

export function renderDexWatchSummary(summary: DexWatchSummary): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX WATCH AUTOPSY V1');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Runs dir          : ${summary.dir}`);
  lines.push(`  Total runs        : ${summary.totalRuns}`);
  lines.push(`  Distinct contracts: ${summary.contractsWatched}`);
  lines.push(`  Total outcomes    : ${summary.totalOutcomes}`);
  lines.push('');
  lines.push(`  Winners : ${summary.winnersCount}   (repeat: ${summary.repeatWinnersCount})`);
  lines.push(`  Losers  : ${summary.losersCount}   (repeat: ${summary.repeatLosersCount})`);
  lines.push(`  Flat    : ${summary.flatCount}`);
  lines.push(`  Missing : ${summary.missingCount}`);
  lines.push('');
  lines.push(`  Avg winner  price ${fmtPct(summary.avgWinnerPricePct)}  liquidity ${fmtPct(summary.avgWinnerLiquidityPct)}`);
  lines.push(`  Avg loser   price ${fmtPct(summary.avgLoserPricePct)}  liquidity ${fmtPct(summary.avgLoserLiquidityPct)}`);

  const section = (title: string, rows: ContractAggregate[]) => {
    lines.push('');
    lines.push(THIN);
    lines.push(`  ${title} (${rows.length}):`);
    if (rows.length === 0) lines.push('    (none)');
    for (const a of rows.slice(0, 10)) lines.push(aggRow(a));
  };

  section('Repeat winners (win >= 2)', summary.repeatWinners);
  section('Repeat losers (lose >= 2)', summary.repeatLosers);
  section('Top v/l churn', summary.topVlChurn);
  section('AVOID-LIST candidates (lose 2+ or drain 2+)', summary.avoidList);
  section('WATCH-LIST candidates (win 2+ or price+liq up)', summary.watchList);

  lines.push('');
  lines.push(WIDE);
  lines.push('  READ-ONLY AUTOPSY — no trading, no wallet, no signing, no swap');
  lines.push('  Candidates are observational only — NO PLAN_ONLY gate granted');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run');
  lines.push(WIDE);

  return lines.join('\n');
}
