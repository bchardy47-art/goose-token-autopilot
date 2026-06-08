import fs from 'node:fs';
import os from 'node:os';
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
  watchSkipped: boolean;
  contractsWatched: number;
  winners: number;
  losers: number;
  flat: number;
  savedRunPath: string; // '' when the watch was skipped
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
  freshOnly: boolean;
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
  /** When true, watch only this cycle's fresh (non-duplicate) signals, not the full accumulated file. */
  freshOnly?: boolean;
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
    freshOnly = false,
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
    const fresh = earsReport.uniqueSignals;
    log(`  signals found: ${fresh.length}`);

    // 3. --fresh-only with no fresh signals: skip the watch entirely (don't watch the accumulated list).
    if (freshOnly && fresh.length === 0) {
      log('No fresh DEX signals this cycle. Watch skipped.');
      cycleResults.push({
        cycle,
        generatedAt,
        signalsFound: 0,
        watchSkipped: true,
        contractsWatched: 0,
        winners: 0,
        losers: 0,
        flat: 0,
        savedRunPath: '',
        tradesSimulated: 0,
        fakePnlDollars: 0,
        fakePnlPct: 0,
        winRate: 0,
        blockedCount: 0,
      });
      continue;
    }

    // 3b. Choose what to watch: full accumulated file (default) or only this cycle's fresh signals.
    let watchSignalsPath = signalsOut;
    let freshTempFile: string | undefined;
    if (freshOnly) {
      freshTempFile = path.join(os.tmpdir(), `dex-fresh-cycle${cycle}-${runFilename(nowFn())}`);
      fs.writeFileSync(freshTempFile, JSON.stringify(fresh, null, 2), 'utf-8');
      watchSignalsPath = freshTempFile;
      log(`  fresh-only: watching ${fresh.length} fresh contract(s) from this cycle`);
    }

    // 4. Watch for a short window (same logic as token:ears-dex-watch).
    const watchReport: DexWatchReport = await runDexWatch({
      signalsPath: watchSignalsPath,
      minutes,
      intervalSeconds,
      chain,
      dryRun: false,
      fetchImpl: watchFetchImpl,
      sleepImpl,
      nowFn,
      log: (m) => log(`    ${m}`),
    });

    // Clean up the temporary fresh-signals file (read-only artifact, not a saved run).
    if (freshTempFile) {
      try { fs.rmSync(freshTempFile, { force: true }); } catch { /* ignore */ }
    }

    // 5. Save the watch run to runs-dir/run-YYYYMMDD-HHMMSS.json.
    const savedRunPath = path.join(runsDir, runFilename(nowFn()));
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(savedRunPath, JSON.stringify(watchReport, null, 2), 'utf-8');
    log(`  saved run: ${savedRunPath}`);

    // 6. Run candidate simulation (same logic as token:dex-candidate-sim) over this run.
    const sim: DexCandidateSimReport = buildDexCandidateSimReport([watchReport], {
      dir: runsDir,
      fakeBankroll,
      positionSize,
    });

    cycleResults.push({
      cycle,
      generatedAt,
      signalsFound: fresh.length,
      watchSkipped: false,
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
    freshOnly,
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
  lines.push(`  Watch mode       : ${report.freshOnly ? 'fresh-only (current cycle)' : 'full accumulated'}`);
  lines.push(`  Cycles requested : ${report.cyclesRequested}`);
  lines.push(`  Cycles completed : ${report.cyclesCompleted}`);

  for (const c of report.cycles) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  Cycle ${c.cycle}`);
    lines.push(`    Signals found      : ${c.signalsFound}`);
    if (c.watchSkipped) {
      lines.push(`    Watch skipped      : no fresh DEX signals this cycle`);
      continue;
    }
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
