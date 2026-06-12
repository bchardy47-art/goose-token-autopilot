import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperNearMissReportOptions {
  inputPaths: string[];
  /** Number of near-miss entries to show in the ranked list (default: 20) */
  topN?: number;
}

export interface NearMissReportEntry {
  symbol?: string;
  contractShort: string;
  contractFull: string;
  ripperScore?: number;
  launchAgeBucket?: string;
  ageMinutes?: number;
  buyGateDecision?: string;
  clusterRisk: string;
  blockers: string[];
  nearestBlocker: string;
  capturedAt: string;
}

export interface BlockerGroupCounts {
  tooEarly: number;
  deadWindow: number;
  late: number;
  scoreBelow: number;
  entryDecision: number;
  clusterRisky: number;
  clusterWatch: number;
  holderRisky: number;
  botPumpRisky: number;
  suspiciousLiquidity: number;
  oneSidedLiquidity: number;
  priceDecline: number;
  liquidityThin: number;
  other: number;
}

export interface TuningCandidates {
  /** Rejected with score >= 75 — high-quality tokens blocked by a gating rule */
  highScoreRejected: NearMissReportEntry[];
  /** Rejected in PRIME_WINDOW — right age, wrong something else */
  primeWindowRejected: NearMissReportEntry[];
  /** Rejected with exactly one blocker — one rule change away from approval */
  singleBlockerRejected: NearMissReportEntry[];
}

export interface RipperNearMissReportResult {
  filesRead: number;
  filesMissing: number;
  fixturesAnalyzed: number;
  approvedCount: number;
  rejectedCount: number;
  tooEarlyCount: number;
  primeWindowCount: number;
  lateCount: number;
  deadWindowCount: number;
  clusterRiskCounts: Record<string, number>;
  blockerGroups: BlockerGroupCounts;
  nearMisses: NearMissReportEntry[];
  tuning: TuningCandidates;
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = f.raw as Record<string, unknown> | undefined;
  const v = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function getContractKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

export function classifyBlocker(b: string): keyof BlockerGroupCounts {
  if (b.startsWith('too early') || b.startsWith('launch age TOO_EARLY')) return 'tooEarly';
  if (b.includes('dead window') || b.startsWith('launch age DEAD_WINDOW')) return 'deadWindow';
  if (b.startsWith('launch age LATE') || b.startsWith('late window')) return 'late';
  if (b.includes('score') && b.includes('below')) return 'scoreBelow';
  if (b.startsWith('entry decision')) return 'entryDecision';
  if (b.includes('cluster risk RISKY')) return 'clusterRisky';
  if (b.includes('cluster risk WATCH')) return 'clusterWatch';
  if (b.includes('holderRisk RISKY') || b.includes('holder concentration RISKY')) return 'holderRisky';
  if (b.includes('bot/pump risk RISKY') || b.startsWith('bot/pump risk')) return 'botPumpRisky';
  if (b.includes('suspicious liquidity')) return 'suspiciousLiquidity';
  if (b.includes('one-sided liquidity')) return 'oneSidedLiquidity';
  if (b.includes('price declining')) return 'priceDecline';
  if (b.includes('liquidity thinning')) return 'liquidityThin';
  return 'other';
}

function toEntry(f: LiveRipperFixture): NearMissReportEntry {
  const contractFull = getContractKey(f.normalizedSignal);
  return {
    symbol:          f.normalizedSignal.symbol,
    contractShort:   contractFull.slice(0, 12),
    contractFull,
    ripperScore:     f.ripperScore,
    launchAgeBucket: f.launchAgeBucket,
    ageMinutes:      f.ageMinutes,
    buyGateDecision: f.buyGateDecision,
    clusterRisk:     getClusterRisk(f),
    blockers:        f.blockers,
    nearestBlocker:  f.blockers[0] ?? '(no blockers recorded)',
    capturedAt:      f.capturedAt,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperNearMissReport(
  options: RipperNearMissReportOptions,
): RipperNearMissReportResult {
  const topN = options.topN ?? 20;

  // ── Load fixtures ─────────────────────────────────────────────────────────
  let filesRead    = 0;
  let filesMissing = 0;
  const allFixtures: LiveRipperFixture[] = [];

  for (const p of options.inputPaths) {
    if (!fs.existsSync(p)) {
      filesMissing += 1;
      continue;
    }
    filesRead += 1;
    allFixtures.push(...readFixturesFromJsonl(p));
  }

  // ── Summary counts ────────────────────────────────────────────────────────
  let approvedCount    = 0;
  let rejectedCount    = 0;
  let tooEarlyCount    = 0;
  let primeWindowCount = 0;
  let lateCount        = 0;
  let deadWindowCount  = 0;
  const clusterRiskCounts: Record<string, number> = {
    CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0,
  };

  for (const f of allFixtures) {
    if (f.buyGateDecision === 'BUY_APPROVED_PAPER') approvedCount += 1;
    else rejectedCount += 1;

    const bucket = f.launchAgeBucket ?? '';
    if (bucket === 'TOO_EARLY')    tooEarlyCount    += 1;
    if (bucket === 'PRIME_WINDOW') primeWindowCount += 1;
    if (bucket === 'LATE')         lateCount        += 1;
    if (bucket === 'DEAD_WINDOW')  deadWindowCount  += 1;

    const cr = getClusterRisk(f);
    clusterRiskCounts[cr] = (clusterRiskCounts[cr] ?? 0) + 1;
  }

  // ── Blocker groups (one count per fixture per category) ───────────────────
  const blockerGroups: BlockerGroupCounts = {
    tooEarly: 0, deadWindow: 0, late: 0, scoreBelow: 0, entryDecision: 0,
    clusterRisky: 0, clusterWatch: 0, holderRisky: 0, botPumpRisky: 0,
    suspiciousLiquidity: 0, oneSidedLiquidity: 0, priceDecline: 0,
    liquidityThin: 0, other: 0,
  };

  const rejected = allFixtures.filter(f => f.buyGateDecision !== 'BUY_APPROVED_PAPER');
  for (const f of rejected) {
    const seen = new Set<keyof BlockerGroupCounts>();
    for (const b of f.blockers) {
      const cat = classifyBlocker(b);
      if (!seen.has(cat)) {
        blockerGroups[cat] += 1;
        seen.add(cat);
      }
    }
    if (f.blockers.length === 0) {
      blockerGroups.other += 1;
    }
  }

  // ── Near misses: rejected sorted by score desc ────────────────────────────
  const rejectedEntries = rejected
    .map(toEntry)
    .sort((a, b) => (b.ripperScore ?? 0) - (a.ripperScore ?? 0));

  const nearMisses = rejectedEntries.slice(0, topN);

  // ── Tuning candidates ─────────────────────────────────────────────────────
  const HIGH_SCORE_THRESHOLD = 75;
  const highScoreRejected    = rejectedEntries.filter(e => (e.ripperScore ?? 0) >= HIGH_SCORE_THRESHOLD);
  const primeWindowRejected  = rejectedEntries.filter(e => e.launchAgeBucket === 'PRIME_WINDOW');
  const singleBlockerRejected = rejectedEntries.filter(e => e.blockers.length === 1);

  return {
    filesRead,
    filesMissing,
    fixturesAnalyzed: allFixtures.length,
    approvedCount,
    rejectedCount,
    tooEarlyCount,
    primeWindowCount,
    lateCount,
    deadWindowCount,
    clusterRiskCounts,
    blockerGroups,
    nearMisses,
    tuning: { highScoreRejected, primeWindowRejected, singleBlockerRejected },
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function fmtScore(s: number | undefined): string {
  return s != null ? String(Math.round(s)).padStart(3) : '  ?';
}

function fmtAge(m: number | undefined): string {
  if (m == null) return '?m';
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function renderRipperNearMissReport(result: RipperNearMissReportResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEC  = '── ';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER NEAR-MISS REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Files read      : ${result.filesRead}${result.filesMissing > 0 ? `  (${result.filesMissing} missing)` : ''}`);
  lines.push(`  Fixtures        : ${result.fixturesAnalyzed}`);
  lines.push(`  Approved        : ${result.approvedCount}`);
  lines.push(`  Rejected        : ${result.rejectedCount}`);
  lines.push('');
  lines.push(`  Too-early       : ${result.tooEarlyCount}`);
  lines.push(`  Prime-window    : ${result.primeWindowCount}`);
  if (result.lateCount > 0)       lines.push(`  Late            : ${result.lateCount}`);
  if (result.deadWindowCount > 0) lines.push(`  Dead-window     : ${result.deadWindowCount}`);
  lines.push('');
  const cr = result.clusterRiskCounts;
  lines.push(
    `  Cluster risk    : CLEAN=${cr['CLEAN'] ?? 0}` +
    `  WATCH=${cr['WATCH'] ?? 0}` +
    `  RISKY=${cr['RISKY'] ?? 0}` +
    `  UNKNOWN=${cr['UNKNOWN'] ?? 0}`,
  );

  // ── Blocker breakdown ───────────────────────────────────────────────────
  lines.push('');
  lines.push(`${SEP.slice(0, 4)}${SEC}BLOCKER BREAKDOWN (fixtures per category)`);
  lines.push('');
  const bg = result.blockerGroups;
  const blockerRows: Array<[number, string]> = ([
    [bg.tooEarly,            'too early (TOO_EARLY — will recheck when aged in)'],
    [bg.deadWindow,          'dead window (DEAD_WINDOW — too old to recover)'],
    [bg.late,                'late window (LATE — closing fast)'],
    [bg.scoreBelow,          'score below threshold'],
    [bg.entryDecision,       'entry decision not READY_TO_SNIPE_PAPER'],
    [bg.clusterRisky,        'cluster risk RISKY — buy blocked'],
    [bg.clusterWatch,        'cluster risk WATCH — buy downgraded'],
    [bg.holderRisky,         'holderRisk RISKY — concentration unsafe'],
    [bg.botPumpRisky,        'bot/pump risk RISKY — buy blocked'],
    [bg.suspiciousLiquidity, 'suspicious liquidity — buy blocked'],
    [bg.oneSidedLiquidity,   'one-sided liquidity — buy blocked'],
    [bg.priceDecline,        'price declining'],
    [bg.liquidityThin,       'liquidity thinning'],
    [bg.other,               'other'],
  ] as Array<[number, string]>).filter(([n]) => n > 0).sort(([a], [b]) => b - a);

  if (blockerRows.length === 0) {
    lines.push('  (no rejected fixtures)');
  } else {
    for (const [n, label] of blockerRows) {
      lines.push(`  ${String(n).padStart(4)}  ${label}`);
    }
  }

  // ── Near misses ──────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`${SEP.slice(0, 4)}${SEC}TOP NEAR MISSES — rejected, ranked by score`);

  if (result.nearMisses.length === 0) {
    lines.push('');
    lines.push('  (no rejected fixtures)');
  } else {
    for (let i = 0; i < result.nearMisses.length; i++) {
      const e   = result.nearMisses[i];
      const rank = `[${String(i + 1).padStart(2)}]`;
      const sym  = e.symbol ? `$${e.symbol}` : '(unknown)';
      const addr = e.contractFull.length > 12 ? `${e.contractShort}…` : e.contractFull;
      lines.push('');
      lines.push(
        `  ${rank}  ${sym.padEnd(14)}` +
        `score=${fmtScore(e.ripperScore).trim()}` +
        `  age=${fmtAge(e.ageMinutes)} (${e.launchAgeBucket ?? '?'})` +
        `  cluster=${e.clusterRisk}`,
      );
      lines.push(`         ${addr}`);
      lines.push(`    ✗ ${e.nearestBlocker}`);
      for (const b of e.blockers.slice(1, 3)) {
        lines.push(`      ${b}`);
      }
    }
  }

  // ── Tuning candidates ────────────────────────────────────────────────────
  lines.push('');
  lines.push(`${SEP.slice(0, 4)}${SEC}TUNING CANDIDATES`);
  lines.push('');
  lines.push(`  High-score rejected  (score ≥ 75)   : ${result.tuning.highScoreRejected.length}`);
  lines.push(`  Prime-window rejected                : ${result.tuning.primeWindowRejected.length}`);
  lines.push(`  Single-blocker rejected              : ${result.tuning.singleBlockerRejected.length}`);

  if (result.tuning.highScoreRejected.length > 0) {
    lines.push('');
    lines.push('  High-score details (top 5):');
    for (const e of result.tuning.highScoreRejected.slice(0, 5)) {
      const sym = e.symbol ? `$${e.symbol}` : '(unknown)';
      lines.push(
        `    score=${fmtScore(e.ripperScore).trim()}  ${sym.padEnd(12)}` +
        `  age=${fmtAge(e.ageMinutes)} (${e.launchAgeBucket ?? '?'})`,
      );
      lines.push(`      ✗ ${e.nearestBlocker}`);
    }
  }

  if (result.tuning.singleBlockerRejected.length > 0) {
    lines.push('');
    lines.push('  Single-blocker details (top 5 by score):');
    for (const e of result.tuning.singleBlockerRejected.slice(0, 5)) {
      const sym = e.symbol ? `$${e.symbol}` : '(unknown)';
      lines.push(
        `    score=${fmtScore(e.ripperScore).trim()}  ${sym.padEnd(12)}` +
        `  age=${fmtAge(e.ageMinutes)} (${e.launchAgeBucket ?? '?'})`,
      );
      lines.push(`      ✗ ${e.nearestBlocker}`);
    }
  }

  // ── Safety footer ────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperNearMissReportUsage(): string {
  return `
token:ripper-near-miss-report — analyze cycle artifact JSONL files for near-miss candidates

Usage:
  npm run token:ripper-near-miss-report -- --input <path> [<path2> ...] [options]

Options:
  --input <paths>   one or more cycle JSONL artifact files; shell globs are expanded by your shell
  --top-n <n>       number of near-miss entries to show in the ranked list (default: 20)
  --help            show this message

Example:
  npm run token:ripper-near-miss-report -- --input data/token-grab/ripper/cycles/cycle-*.jsonl
  npm run token:ripper-near-miss-report -- --input data/token-grab/ripper/cycles/cycle-2026*.jsonl --top-n 10

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No live API calls. No scoring changes. Read-only.
`.trim();
}
