import * as fs from 'fs';
import * as path from 'path';
import {
  earSignalToRipperInput,
  getContractAddress,
  type RipperEarSignal,
  type RipperEarsInputFile,
} from './ripperEars';
import {
  normalizeDexPairs,
  type DexPairRaw,
} from './dexScreenerRipperAdapter';
import {
  scoreRipper,
  checkPaperBuyGate,
  DEFAULT_RIPPER_CONFIG,
  type RipperConfig,
  type RipperSignal,
} from './dexRipperEngine';
import type { RipperSessionState } from './dexRipperSession';

// ── Input loading ─────────────────────────────────────────────────────────────────────────

export type EarsInputFormat = 'ear-signals' | 'dexscreener';

interface LoadResult {
  signals: RipperEarSignal[];
  loadWarnings: string[];
  missing: boolean;
}

export function loadEarSignals(
  inputPath: string,
  format: EarsInputFormat,
  nowIso: string,
): LoadResult {
  if (!fs.existsSync(inputPath)) {
    return { signals: [], loadWarnings: [], missing: true };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  } catch (e) {
    return {
      signals: [],
      loadWarnings: [`failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`],
      missing: false,
    };
  }

  if (format === 'dexscreener') {
    let pairs: DexPairRaw[] = [];
    if (Array.isArray(raw)) pairs = raw as DexPairRaw[];
    else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj['pairs'])) pairs = obj['pairs'] as DexPairRaw[];
      else if (obj['pair']) pairs = [obj['pair'] as DexPairRaw];
    }
    const result = normalizeDexPairs(pairs, nowIso);
    const warns: string[] = [];
    if (result.skippedCount > 0) warns.push(`${result.skippedCount} pair(s) skipped (missing required fields)`);
    if (result.warningCount > 0) warns.push(`${result.warningCount} data warning(s) in normalized signals`);
    return { signals: result.signals, loadWarnings: warns, missing: false };
  }

  // ear-signals format: { "signals": [...] } OR raw array
  let signals: RipperEarSignal[] = [];
  if (Array.isArray(raw)) {
    signals = raw as RipperEarSignal[];
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Partial<RipperEarsInputFile>;
    if (Array.isArray(obj.signals)) signals = obj.signals;
  }

  return { signals, loadWarnings: [], missing: false };
}

// ── Report types ──────────────────────────────────────────────────────────────────────────

export interface ScoredEarSignal {
  signal: RipperEarSignal;
  ripperInput: ReturnType<typeof earSignalToRipperInput>;
  ripperSignal?: RipperSignal;
  conversionWarning?: string;  // why earSignalToRipperInput returned null
}

export interface RipperEarsReportResult {
  generatedAt: string;
  inputPath: string;
  inputMissing: boolean;
  totalSignals: number;
  sourcesFound: string[];
  loadWarnings: string[];
  primeWindowCount: number;
  readyCount: number;
  watchCount: number;
  blockedCount: number;
  ignoreCount: number;
  conversionFailures: number;
  topCandidates: ScoredEarSignal[];
  nearMisses: ScoredEarSignal[];
  allSignals: ScoredEarSignal[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────────────────

export interface RipperEarsReportOptions {
  inputPath: string;
  format: EarsInputFormat;
  config?: Partial<RipperConfig>;
  nowMs?: number;
}

export function runRipperEarsReport(options: RipperEarsReportOptions): RipperEarsReportResult {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const config = { ...DEFAULT_RIPPER_CONFIG, ...(options.config ?? {}) };

  const { signals, loadWarnings, missing } = loadEarSignals(options.inputPath, options.format, nowIso);

  const sourcesFound = [...new Set(signals.map(s => s.source))];
  let primeWindowCount  = 0;
  let readyCount        = 0;
  let watchCount        = 0;
  let blockedCount      = 0;
  let ignoreCount       = 0;
  let conversionFailures = 0;
  const scored: ScoredEarSignal[] = [];

  for (const signal of signals) {
    const ripperInput = earSignalToRipperInput(signal);
    if (!ripperInput) {
      conversionFailures += 1;
      scored.push({ signal, ripperInput: null, conversionWarning: 'no contract address' });
      ignoreCount += 1;
      continue;
    }

    const ripperSignal = scoreRipper(ripperInput, config, nowMs);
    scored.push({ signal, ripperInput, ripperSignal });

    if (ripperSignal.launchAgeBucket === 'PRIME_WINDOW') primeWindowCount += 1;

    switch (ripperSignal.entryDecision) {
      case 'READY_TO_SNIPE_PAPER': readyCount += 1; break;
      case 'WATCH':                watchCount += 1; break;
      case 'PAPER_BUY_BLOCKED':    blockedCount += 1; break;
      case 'IGNORE':               ignoreCount += 1; break;
    }
  }

  // Top candidates: READY_TO_SNIPE_PAPER, sorted by score desc
  const topCandidates = scored
    .filter(s => s.ripperSignal?.entryDecision === 'READY_TO_SNIPE_PAPER')
    .sort((a, b) => (b.ripperSignal?.ripperScore ?? 0) - (a.ripperSignal?.ripperScore ?? 0))
    .slice(0, 10);

  // Near-misses: PAPER_BUY_BLOCKED or WATCH with decent score
  const nearMisses = scored
    .filter(s =>
      s.ripperSignal?.entryDecision === 'PAPER_BUY_BLOCKED' ||
      (s.ripperSignal?.entryDecision === 'WATCH' && (s.ripperSignal?.ripperScore ?? 0) >= 45),
    )
    .sort((a, b) => (b.ripperSignal?.ripperScore ?? 0) - (a.ripperSignal?.ripperScore ?? 0))
    .slice(0, 10);

  return {
    generatedAt: nowIso,
    inputPath: options.inputPath,
    inputMissing: missing,
    totalSignals: signals.length,
    sourcesFound,
    loadWarnings,
    primeWindowCount,
    readyCount,
    watchCount,
    blockedCount,
    ignoreCount,
    conversionFailures,
    topCandidates,
    nearMisses,
    allSignals: scored,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Near-miss report ──────────────────────────────────────────────────────────────────────

export interface NearMissEntry {
  contract: string;
  symbol?: string;
  source: string;
  discoveredAt: string;
  ageMinutes?: number;
  ripperScore?: number;
  entryDecision?: string;
  blockers: string[];
  warnings: string[];
  gateBlockers?: string[];
}

export interface RipperNearMissResult {
  generatedAt: string;
  inputPath: string;
  inputMissing: boolean;
  totalScored: number;
  nearMissCount: number;
  entries: NearMissEntry[];
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface RipperNearMissOptions {
  inputPath: string;
  format: EarsInputFormat;
  sessionStatePath?: string;
  config?: Partial<RipperConfig>;
  nowMs?: number;
}

export function runRipperNearMiss(options: RipperNearMissOptions): RipperNearMissResult {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const config = { ...DEFAULT_RIPPER_CONFIG, ...(options.config ?? {}) };

  const { signals, missing } = loadEarSignals(options.inputPath, options.format, nowIso);
  const entries: NearMissEntry[] = [];

  for (const signal of signals) {
    const ripperInput = earSignalToRipperInput(signal);
    if (!ripperInput) continue;

    const rs = scoreRipper(ripperInput, config, nowMs);

    // Only include near-misses: signals that had some score potential but were blocked or watch
    if (rs.entryDecision === 'IGNORE' && rs.ripperScore < config.minScoreToWatch) continue;

    const gateResult = checkPaperBuyGate(rs, config);
    const contract = getContractAddress(signal) ?? '(unknown)';

    entries.push({
      contract,
      symbol: signal.symbol,
      source: signal.source,
      discoveredAt: signal.discoveredAt,
      ageMinutes: rs.ageMinutes,
      ripperScore: rs.ripperScore,
      entryDecision: rs.entryDecision,
      blockers: rs.blockers,
      warnings: signal.warnings,
      gateBlockers: gateResult.decision === 'BUY_REJECTED' ? gateResult.blockers : [],
    });
  }

  entries.sort((a, b) => (b.ripperScore ?? 0) - (a.ripperScore ?? 0));

  return {
    generatedAt: nowIso,
    inputPath: options.inputPath,
    inputMissing: missing,
    totalScored: signals.length,
    nearMissCount: entries.length,
    entries,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────────────────

function fmtAge(ageMinutes: number | undefined): string {
  if (ageMinutes == null) return 'age unknown';
  if (ageMinutes < 60) return `${ageMinutes.toFixed(0)}m`;
  return `${(ageMinutes / 60).toFixed(1)}h`;
}

function fmtScore(n: number | undefined): string {
  if (n == null) return 'n/a';
  const bars = Math.round(n / 10);
  return `${'█'.repeat(bars)}${'░'.repeat(10 - bars)} ${n}`;
}

export function renderRipperEarsReport(result: RipperEarsReportResult, debug = false): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RIPPER EARS REPORT');
  lines.push(`  ${result.generatedAt.slice(0, 19).replace('T', ' ')}   [REAL TRADING LOCKED — PAPER ONLY]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.inputMissing) {
    lines.push(`  Input file not found: ${result.inputPath}`);
    lines.push('');
    lines.push('  Expected schema (ear-signals format):');
    lines.push('  {');
    lines.push('    "signals": [');
    lines.push('      {');
    lines.push('        "id": "dexscreener:PAIRADDR",');
    lines.push('        "source": "dexscreener",');
    lines.push('        "sourceKind": "DEX_NEW_POOL",');
    lines.push('        "contract": "<token mint address>",');
    lines.push('        "symbol": "TEST",');
    lines.push('        "discoveredAt": "<ISO timestamp of pool creation>",');
    lines.push('        "observedAt": "<ISO timestamp of ingestion>",');
    lines.push('        "confidence": "MEDIUM",');
    lines.push('        "signalReasons": [],');
    lines.push('        "warnings": [],');
    lines.push('        "priceChangePct": 30.0,');
    lines.push('        "liquidityUsd": 10000,');
    lines.push('        "volumeUsd": 5000');
    lines.push('      }');
    lines.push('    ]');
    lines.push('  }');
    lines.push('');
    lines.push('  Or pass --format dexscreener to normalize raw DexScreener pair data.');
    lines.push('');
    lines.push(`  tradingExecuted=${result.tradingExecuted}  noRealTradeSent=${result.noRealTradeSent}  paperOnly=true  readOnly=true`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  // Summary
  lines.push('  SIGNAL SUMMARY');
  lines.push(`    Total signals    : ${result.totalSignals}`);
  lines.push(`    Sources          : ${result.sourcesFound.join(', ') || '(none)'}`);
  lines.push(`    Prime window     : ${result.primeWindowCount}`);
  lines.push(`    Ready to snipe   : ${result.readyCount}`);
  lines.push(`    Watch            : ${result.watchCount}`);
  lines.push(`    Blocked          : ${result.blockedCount}`);
  lines.push(`    Ignored          : ${result.ignoreCount}`);
  if (result.conversionFailures > 0) {
    lines.push(`    No contract      : ${result.conversionFailures} (skipped)`);
  }
  lines.push('');

  if (result.loadWarnings.length > 0) {
    lines.push('  LOAD WARNINGS');
    for (const w of result.loadWarnings) lines.push(`    ⚠  ${w}`);
    lines.push('');
  }

  // Top candidates
  if (result.topCandidates.length > 0) {
    lines.push('  TOP CANDIDATES (READY_TO_SNIPE_PAPER)');
    for (const sc of result.topCandidates) {
      const rs = sc.ripperSignal!;
      const sym = rs.symbol ? `$${rs.symbol}` : (sc.signal.contract ?? '?').slice(0, 10) + '…';
      lines.push(`    ${sym.padEnd(14)}  ${fmtScore(rs.ripperScore)}  age=${fmtAge(rs.ageMinutes)}  src=${sc.signal.source}`);
      for (const r of rs.topReasons.slice(0, 2)) lines.push(`      ✓ ${r}`);
      if (sc.signal.warnings.length > 0) lines.push(`      ⚠ ${sc.signal.warnings[0]}`);
    }
    lines.push('');
  } else {
    lines.push('  TOP CANDIDATES — none qualify for READY_TO_SNIPE_PAPER');
    lines.push('');
  }

  // Near-misses
  if (result.nearMisses.length > 0) {
    lines.push('  NEAR-MISSES (BLOCKED or high-WATCH)');
    for (const sc of result.nearMisses) {
      const rs = sc.ripperSignal!;
      const sym = rs.symbol ? `$${rs.symbol}` : (sc.signal.contract ?? '?').slice(0, 10) + '…';
      lines.push(`    ${sym.padEnd(14)}  score=${rs.ripperScore}  ${rs.entryDecision}  age=${fmtAge(rs.ageMinutes)}`);
      for (const b of rs.blockers.slice(0, 2)) lines.push(`      ✗ ${b}`);
    }
    lines.push('');
  }

  // Debug: all signals
  if (debug && result.allSignals.length > 0) {
    lines.push('  ── DEBUG: ALL SIGNALS ──');
    for (const sc of result.allSignals) {
      const rs = sc.ripperSignal;
      const sym = (rs?.symbol ?? sc.signal.symbol) ? `$${rs?.symbol ?? sc.signal.symbol}` : '(no sym)';
      const contract = getContractAddress(sc.signal) ?? '(no contract)';
      lines.push(`  ${sym.padEnd(12)} ${contract.slice(0, 20).padEnd(22)} score=${rs?.ripperScore ?? 'n/a'}  ${rs?.entryDecision ?? '(no input)'}  age=${fmtAge(rs?.ageMinutes)}`);
      if (sc.conversionWarning) lines.push(`    ⚠ conversion: ${sc.conversionWarning}`);
      for (const w of sc.signal.warnings) lines.push(`    ⚠ ${w}`);
      if (rs) {
        for (const b of rs.blockers) lines.push(`    ✗ ${b}`);
      }
    }
    lines.push('');
  }

  lines.push(`  tradingExecuted=${result.tradingExecuted}  noRealTradeSent=${result.noRealTradeSent}  paperOnly=true  readOnly=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderRipperNearMissReport(result: RipperNearMissResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RIPPER NEAR-MISS AUTOPSY');
  lines.push(`  ${result.generatedAt.slice(0, 19).replace('T', ' ')}   [REAL TRADING LOCKED]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.inputMissing) {
    lines.push(`  Input file not found: ${result.inputPath}`);
    lines.push('  Run token:ripper-ears first to generate ear signals.');
    lines.push('');
    lines.push(`  tradingExecuted=${result.tradingExecuted}  noRealTradeSent=${result.noRealTradeSent}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Scored: ${result.totalScored}   Near-misses: ${result.nearMissCount}`);
  lines.push('');

  if (result.entries.length === 0) {
    lines.push('  No near-misses found.');
  } else {
    for (const e of result.entries) {
      const sym  = e.symbol ? `$${e.symbol}` : e.contract.slice(0, 12) + '…';
      const age  = fmtAge(e.ageMinutes);
      const scr  = e.ripperScore ?? 'n/a';
      const dec  = e.entryDecision ?? 'n/a';
      lines.push(`  ${sym.padEnd(14)} score=${String(scr).padStart(3)}  ${dec.padEnd(22)}  age=${age}  src=${e.source}`);
      for (const b of (e.gateBlockers ?? e.blockers).slice(0, 3)) {
        lines.push(`    ✗ ${b}`);
      }
      for (const w of e.warnings.slice(0, 2)) {
        lines.push(`    ⚠ ${w}`);
      }
    }
  }

  lines.push('');
  lines.push(`  tradingExecuted=${result.tradingExecuted}  noRealTradeSent=${result.noRealTradeSent}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderRipperEarsUsage(): string {
  return `
token:ripper-ears — normalize fresh-token signals and score them through the ripper engine

Usage:
  npm run token:ripper-ears [options]

Options:
  --input <path>      input file path (default: data/token-grab/ripper/ripper-ears-input.json)
  --format <fmt>      ear-signals (default) | dexscreener
  --min-score <N>     override minScoreToBuy threshold
  --debug             show all signals with full detail
  --help              show this message

Formats:
  ear-signals    JSON file with { "signals": RipperEarSignal[] }
  dexscreener    raw DexScreener pairs JSON ({ "pairs": [...] } or array)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Paper only.
`.trim();
}

export function renderRipperNearMissUsage(): string {
  return `
token:ripper-near-miss — autopsy of skipped/blocked signals from the ripper ears input

Usage:
  npm run token:ripper-near-miss [options]

Options:
  --input <path>    input file path (default: data/token-grab/ripper/ripper-ears-input.json)
  --format <fmt>    ear-signals (default) | dexscreener
  --help            show this message

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. Paper only.
`.trim();
}
