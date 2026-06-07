import type { DexWatchReport, DexWatchOutcome } from './dexWatch';
import { outcomesFromReport, DRAIN_PCT } from './dexWatchSummary';

// ── Candidate thresholds (scoped to this command only) ─────────────────────────────

/** PASS requires a strong price move. */
export const PASS_PRICE_PCT = 20;
/** PASS requires liquidity rising with it. */
export const PASS_LIQ_PCT = 10;
/** PASS requires churn (volume/liquidity) at or below this. */
export const PASS_VLR_MAX = 1.0;
/** BLOCK when churn exceeds this. */
export const BLOCK_VLR_MAX = 1.5;
/** BLOCK when a contract has lost / drained at least this many times. */
export const BLOCK_REPEAT_MIN = 1;

// ── Types ───────────────────────────────────────────────────────────────────────────

export type CandidateStatus = 'PASS' | 'BLOCK' | 'SKIP';

export interface DexWatchCandidate {
  contract: string;
  symbol?: string;
  chainId: string;
  pairUrl?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  loseCount: number;
  drainCount: number;
  status: CandidateStatus;
  /** Observational label only — granted to PASS candidates. */
  label: 'DEX_PLAN_ONLY_CANDIDATE' | null;
  blockReasons: string[];
}

export interface DexWatchCandidatesReport {
  dir: string;
  runsRead: number;
  outcomesScanned: number;
  contractsEvaluated: number;
  passedCount: number;
  blockedCount: number;
  passed: DexWatchCandidate[];
  blocked: DexWatchCandidate[];
  dryRun: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Per-contract rollup ───────────────────────────────────────────────────────────────

interface ContractRollup {
  contract: string;
  symbol?: string;
  chainId: string;
  pairUrl?: string;
  outcomes: DexWatchOutcome[];
  loseCount: number;
  drainCount: number;
  strongest?: DexWatchOutcome; // outcome with the highest defined priceChangePct
}

function rollupByContract(reports: DexWatchReport[]): ContractRollup[] {
  const map = new Map<string, ContractRollup>();

  for (const report of reports) {
    for (const o of outcomesFromReport(report)) {
      const key = o.contract.toLowerCase();
      let r = map.get(key);
      if (!r) {
        r = {
          contract: o.contract,
          symbol: o.symbol,
          chainId: o.chainId,
          pairUrl: o.pairUrl,
          outcomes: [],
          loseCount: 0,
          drainCount: 0,
        };
        map.set(key, r);
      }
      if (!r.symbol && o.symbol) r.symbol = o.symbol;
      if (!r.pairUrl && o.pairUrl) r.pairUrl = o.pairUrl;
      r.outcomes.push(o);

      if (o.classification === 'loser') r.loseCount += 1;
      if (typeof o.liquidityChangePct === 'number' && o.liquidityChangePct <= DRAIN_PCT) {
        r.drainCount += 1;
      }

      // Strongest = highest priceChangePct (missing pct never wins unless nothing else).
      const cur = r.strongest?.priceChangePct;
      const next = o.priceChangePct;
      if (r.strongest === undefined) {
        r.strongest = o;
      } else if (typeof next === 'number' && (typeof cur !== 'number' || next > cur)) {
        r.strongest = o;
      }
    }
  }

  return Array.from(map.values());
}

// ── Evaluation — pure ─────────────────────────────────────────────────────────────────

/** Evaluates one contract's rollup into a PASS / BLOCK / SKIP candidate. */
export function evaluateRollup(r: ContractRollup): DexWatchCandidate {
  const s = r.strongest;
  const price = s?.priceChangePct;
  const liq = s?.liquidityChangePct;
  const vlr = s?.volumeToLiquidityRatio;

  const blockReasons: string[] = [];
  if (r.loseCount >= BLOCK_REPEAT_MIN) blockReasons.push(`loser count >= ${BLOCK_REPEAT_MIN} (loseCount=${r.loseCount})`);
  if (r.drainCount >= BLOCK_REPEAT_MIN) blockReasons.push(`liquidity drain count >= ${BLOCK_REPEAT_MIN} (drainCount=${r.drainCount})`);
  if (typeof vlr === 'number' && vlr > BLOCK_VLR_MAX) blockReasons.push(`volumeLiquidityRatio > ${BLOCK_VLR_MAX} (${vlr.toFixed(2)})`);
  if (liq == null) blockReasons.push('liquidityChangePct missing');
  if (price == null) blockReasons.push('priceChangePct missing');

  const base = {
    contract: r.contract,
    symbol: r.symbol,
    chainId: r.chainId,
    pairUrl: r.pairUrl,
    priceChangePct: price,
    liquidityChangePct: liq,
    volumeLiquidityRatio: vlr,
    loseCount: r.loseCount,
    drainCount: r.drainCount,
  };

  if (blockReasons.length > 0) {
    return { ...base, status: 'BLOCK', label: null, blockReasons };
  }

  const passes =
    typeof price === 'number' && price >= PASS_PRICE_PCT &&
    typeof liq === 'number' && liq >= PASS_LIQ_PCT &&
    typeof vlr === 'number' && vlr <= PASS_VLR_MAX;

  if (passes) {
    return { ...base, status: 'PASS', label: 'DEX_PLAN_ONLY_CANDIDATE', blockReasons: [] };
  }

  return { ...base, status: 'SKIP', label: null, blockReasons: [] };
}

/** Rank: highest price, then highest liquidity, then lowest churn. */
export function rankCandidates(cands: DexWatchCandidate[]): DexWatchCandidate[] {
  return [...cands].sort((a, b) => {
    const pa = a.priceChangePct ?? -Infinity;
    const pb = b.priceChangePct ?? -Infinity;
    if (pb !== pa) return pb - pa;
    const la = a.liquidityChangePct ?? -Infinity;
    const lb = b.liquidityChangePct ?? -Infinity;
    if (lb !== la) return lb - la;
    const va = a.volumeLiquidityRatio ?? Infinity;
    const vb = b.volumeLiquidityRatio ?? Infinity;
    return va - vb;
  });
}

// ── Report builder — pure ──────────────────────────────────────────────────────────────

export function buildDexWatchCandidatesReport(
  reports: DexWatchReport[],
  dir = '',
): DexWatchCandidatesReport {
  const rollups = rollupByContract(reports);
  const outcomesScanned = reports.reduce((sum, r) => sum + outcomesFromReport(r).length, 0);

  const evaluated = rollups.map(evaluateRollup);
  const passed = rankCandidates(evaluated.filter(c => c.status === 'PASS'));
  const blocked = evaluated.filter(c => c.status === 'BLOCK');

  return {
    dir,
    runsRead: reports.length,
    outcomesScanned,
    contractsEvaluated: rollups.length,
    passedCount: passed.length,
    blockedCount: blocked.length,
    passed,
    blocked,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

export function renderDexWatchCandidatesReport(report: DexWatchCandidatesReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX WATCH CANDIDATES V1');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Runs dir           : ${report.dir}`);
  lines.push(`  Runs read          : ${report.runsRead}`);
  lines.push(`  Outcomes scanned   : ${report.outcomesScanned}`);
  lines.push(`  Contracts evaluated: ${report.contractsEvaluated}`);
  lines.push(`  Candidates passed  : ${report.passedCount}`);
  lines.push(`  Candidates blocked : ${report.blockedCount}`);

  lines.push('');
  lines.push(THIN);
  lines.push(`  Top candidates — DEX_PLAN_ONLY_CANDIDATE (${report.passed.length}):`);
  if (report.passed.length === 0) {
    lines.push('    (none)');
  } else {
    for (const c of report.passed.slice(0, 10)) {
      const sym = (c.symbol ? `$${c.symbol}` : '(no sym)').padEnd(12);
      const vlr = c.volumeLiquidityRatio != null ? c.volumeLiquidityRatio.toFixed(2) : 'n/a';
      lines.push(
        `    ${sym} price ${fmtPct(c.priceChangePct).padStart(8)}` +
          `  liq ${fmtPct(c.liquidityChangePct).padStart(8)}  v/l ${vlr.padStart(6)}  ${c.contract.slice(0, 6)}…`,
      );
      lines.push(`      DEX_PLAN_ONLY_CANDIDATE — observational only`);
    }
  }

  lines.push('');
  lines.push(THIN);
  lines.push(`  Blocked (${report.blocked.length}):`);
  if (report.blocked.length === 0) {
    lines.push('    (none)');
  } else {
    for (const c of report.blocked.slice(0, 20)) {
      const sym = (c.symbol ? `$${c.symbol}` : '(no sym)').padEnd(12);
      lines.push(`    ${sym} ${c.contract.slice(0, 8)}…  — ${c.blockReasons.join('; ')}`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  DEX_PLAN_ONLY_CANDIDATE is observational only — NOT a trade, NOT a PLAN_ONLY grant');
  lines.push('  No live-harness gate changed — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
