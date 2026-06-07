import fs from 'node:fs';
import path from 'node:path';
import type { PreSignal } from './xEarsPreSignal';
import {
  loadDexEarsConfig,
  buildDexEarsReport,
  fetchLatestProfiles,
  fetchLatestBoosts,
  fetchTopBoosts,
  type DexEarsConfig,
  type DexEndpointResult,
} from './dexEars';
import { runDexWatch, type DexWatchReport } from './dexWatch';
import { buildDexCandidateSimReport, type DexCandidateSimReport } from './dexCandidateSim';

// ── Types ───────────────────────────────────────────────────────────────────────────

/** Pulls the three DEX Screener endpoints for one ears pass. Injectable for tests. */
export type EndpointFetcher = (config: DexEarsConfig) => Promise<DexEndpointResult[]>;

export interface DexPaperCycleResult {
  cycle: number;
  generatedAt: string;
  signalsFound: number;
  contractsWatched: number;
  winners: number;
  losers: number;
  flat: number;
  savedRunPath: string;
  tradesSimulated: number;
  fakePnlDollars: number;
  fakePnlPct: number;
  winRate: number;
  blockedCount: number;
}

export interface DexPaperRunnerReport {
  cyclesRequested: number;
  cyclesCompleted: number;
  cycles: DexPaperCycleResult[];
  signalsOut: string;
  runsDir: string;
  fakeBankroll: number;
  fakePositionSize: number;
  dryRun: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface DexPaperRunnerOptions {
  dexConfigPath: string;
  signalsOut: string;
  runsDir: string;
  minutes: number;
  intervalSeconds: number;
  fakeBankroll: number;
  positionSize: number;
  cycles: number;
  chain?: string;
  minConfidence?: 'low' | 'medium' | 'high';
  // ── Injection points (production defaults reuse the real modules) ──
  endpointFetcher?: EndpointFetcher;
  watchFetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
  log?: (msg: string) => void;
}

// ── Defaults — reuse the real dexEars fetchers (same as token:ears-dex) ────────────────

const defaultEndpointFetcher: EndpointFetcher = async (config) => {
  const results = await Promise.all([
    config.endpoints.latestProfiles
      ? fetchLatestProfiles(config.maxItemsPerEndpoint, config.timeoutMs)
      : Promise.resolve(null),
    config.endpoints.latestBoosts
      ? fetchLatestBoosts(config.maxItemsPerEndpoint, config.timeoutMs)
      : Promise.resolve(null),
    config.endpoints.topBoosts
      ? fetchTopBoosts(config.maxItemsPerEndpoint, config.timeoutMs)
      : Promise.resolve(null),
  ]);
  return results.filter((r): r is DexEndpointResult => r !== null);
};

// ── Helpers — pure ────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** run-YYYYMMDD-HHMMSS — uses UTC for stability across machines. */
export function runFilename(now: Date): string {
  const y = now.getUTCFullYear();
  const mo = pad2(now.getUTCMonth() + 1);
  const d = pad2(now.getUTCDate());
  const h = pad2(now.getUTCHours());
  const mi = pad2(now.getUTCMinutes());
  const s = pad2(now.getUTCSeconds());
  return `run-${y}${mo}${d}-${h}${mi}${s}.json`;
}

function readExistingSignals(signalsOut: string): PreSignal[] {
  if (!fs.existsSync(signalsOut)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(signalsOut, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as PreSignal[]) : [];
  } catch {
    return [];
  }
}

// ── Runner — async orchestration (paper-only; reuses dexEars / dexWatch / dexCandidateSim) ──

export async function runDexPaperRunner(options: DexPaperRunnerOptions): Promise<DexPaperRunnerReport> {
  const {
    dexConfigPath,
    signalsOut,
    runsDir,
    minutes,
    intervalSeconds,
    fakeBankroll,
    positionSize,
    cycles,
    endpointFetcher = defaultEndpointFetcher,
    watchFetchImpl,
    sleepImpl,
    nowFn = () => new Date(),
    log = () => {},
  } = options;

  const config = loadDexEarsConfig(dexConfigPath);
  const chain = options.chain ?? config.chain;
  const minConfidence = options.minConfidence ?? config.minConfidence;

  const cycleResults: DexPaperCycleResult[] = [];

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const generatedAt = nowFn().toISOString();
    log(`── Cycle ${cycle}/${cycles} ──`);

    // 1. Pull fresh DEX signals (same logic as token:ears-dex).
    const endpointResults = await endpointFetcher(config);
    const existing = readExistingSignals(signalsOut);
    const earsReport = buildDexEarsReport({
      endpointResults,
      existingSignals: existing,
      generatedAt,
      chain,
      minConfidence,
      dryRun: false,
      outputPath: signalsOut,
    });

    // 2. Save signals to --signals-out (append, mirroring the CLI).
    if (earsReport.uniqueSignals.length > 0) {
      const updated = [...existing, ...earsReport.uniqueSignals];
      fs.mkdirSync(path.dirname(signalsOut), { recursive: true });
      fs.writeFileSync(signalsOut, JSON.stringify(updated, null, 2), 'utf-8');
    }
    log(`  signals found: ${earsReport.uniqueSignals.length}`);

    // 3. Watch them for a short window (same logic as token:ears-dex-watch).
    const watchReport: DexWatchReport = await runDexWatch({
      signalsPath: signalsOut,
      minutes,
      intervalSeconds,
      chain,
      dryRun: false,
      fetchImpl: watchFetchImpl,
      sleepImpl,
      nowFn,
      log: (m) => log(`    ${m}`),
    });

    // 4. Save the watch run to runs-dir/run-YYYYMMDD-HHMMSS.json.
    const savedRunPath = path.join(runsDir, runFilename(nowFn()));
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(savedRunPath, JSON.stringify(watchReport, null, 2), 'utf-8');
    log(`  saved run: ${savedRunPath}`);

    // 5. Run candidate simulation (same logic as token:dex-candidate-sim) over this run.
    const sim: DexCandidateSimReport = buildDexCandidateSimReport([watchReport], {
      dir: runsDir,
      fakeBankroll,
      positionSize,
    });

    cycleResults.push({
      cycle,
      generatedAt,
      signalsFound: earsReport.uniqueSignals.length,
      contractsWatched: watchReport.signalsWatched,
      winners: watchReport.winners.length,
      losers: watchReport.losers.length,
      flat: watchReport.flat.length,
      savedRunPath,
      tradesSimulated: sim.tradesSimulated,
      fakePnlDollars: sim.fakeRealizedPnlDollars,
      fakePnlPct: sim.fakeRealizedPnlPct,
      winRate: sim.winRate,
      blockedCount: sim.blockedCount,
    });

    log(
      `  paper P/L: ${sim.fakeRealizedPnlDollars >= 0 ? '+' : '-'}$${Math.abs(sim.fakeRealizedPnlDollars).toFixed(2)}` +
        ` over ${sim.tradesSimulated} fake trades (win rate ${(sim.winRate * 100).toFixed(1)}%)`,
    );
  }

  return {
    cyclesRequested: cycles,
    cyclesCompleted: cycleResults.length,
    cycles: cycleResults,
    signalsOut,
    runsDir,
    fakeBankroll,
    fakePositionSize: positionSize,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

export function renderDexPaperRunnerReport(report: DexPaperRunnerReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX PAPER RUNNER V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Signals out      : ${report.signalsOut}`);
  lines.push(`  Runs dir         : ${report.runsDir}`);
  lines.push(`  Fake bankroll    : $${report.fakeBankroll.toFixed(2)}`);
  lines.push(`  Fake position    : $${report.fakePositionSize.toFixed(2)}`);
  lines.push(`  Cycles requested : ${report.cyclesRequested}`);
  lines.push(`  Cycles completed : ${report.cyclesCompleted}`);

  for (const c of report.cycles) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  Cycle ${c.cycle}`);
    lines.push(`    Signals found      : ${c.signalsFound}`);
    lines.push(`    Contracts watched  : ${c.contractsWatched}`);
    lines.push(`    Winners/Losers/Flat: ${c.winners} / ${c.losers} / ${c.flat}`);
    lines.push(`    Saved run          : ${c.savedRunPath}`);
    lines.push(`    Candidate trades   : ${c.tradesSimulated}`);
    lines.push(`    Fake P/L           : ${fmtUsd(c.fakePnlDollars)} (${c.fakePnlPct >= 0 ? '+' : ''}${c.fakePnlPct.toFixed(1)}%)`);
    lines.push(`    Win rate           : ${(c.winRate * 100).toFixed(1)}%`);
    lines.push(`    Blocked            : ${c.blockedCount}`);
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  PAPER ONLY — no live-harness gate changed, no PLAN_ONLY trade created');
  lines.push('  Fake P/L is hypothetical — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
