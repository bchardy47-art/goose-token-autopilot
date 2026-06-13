import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelayedWatchCandidate {
  contractKey: string;
  symbol?: string;
  score: number | null;
  ageMinutes: number | null;
  clusterRisk: string;
  entryPriceUsd: number | null;
  priceChangePct: number | null;
  approvedAt: string;
  sourceArtifact: string;
  immediateApproved: true;
  delayTargetMinutes: number;
  delayRemainingMinutes: number;
  eligibleForDelayedEntry: boolean;
}

export interface RipperDelayedWatchOptions {
  inputPaths: string[];
  outPath: string;
  delayTargetMinutes: number;
  nowMs?: number;
}

export interface RipperDelayedWatchResult {
  generatedAt: string;
  outPath: string;
  delayTargetMinutes: number;
  filesRead: number;
  filesMissing: number;
  fixturesScanned: number;
  candidatesFound: number;
  immediateApprovalCount: number;
  tooYoungCount: number;
  eligibleCount: number;
  avgAge: number | null;
  avgScore: number | null;
  clusterBreakdown: { CLEAN: number; WATCH: number; RISKY: number; UNKNOWN: number };
  candidates: DelayedWatchCandidate[];
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Extraction helpers ────────────────────────────────────────────────────────

function contractKeyOf(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = f.raw as Record<string, unknown> | undefined;
  const v   = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function getEntryPriceUsd(f: LiveRipperFixture): number | null {
  const raw   = f.normalizedSignal.raw as Record<string, unknown> | undefined;
  const entry = raw?.['entry'] as Record<string, unknown> | undefined;
  const price = entry?.['priceUsd'];
  return typeof price === 'number' ? price : null;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperDelayedWatch(
  options: RipperDelayedWatchOptions,
): RipperDelayedWatchResult {
  const nowMs             = options.nowMs ?? Date.now();
  const generatedAt       = new Date(nowMs).toISOString();
  const delayTargetMinutes = options.delayTargetMinutes;

  let filesRead      = 0;
  let filesMissing   = 0;
  let fixturesScanned = 0;

  const seen:       Set<string>              = new Set();
  const candidates: DelayedWatchCandidate[]  = [];

  for (const inputPath of options.inputPaths) {
    if (!fs.existsSync(inputPath)) {
      filesMissing++;
      continue;
    }
    filesRead++;
    const fixtures = readFixturesFromJsonl(inputPath);
    fixturesScanned += fixtures.length;

    for (const f of fixtures) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const key = contractKeyOf(f.normalizedSignal);
      if (seen.has(key)) continue;
      seen.add(key);

      const ageMinutes = typeof f.ageMinutes === 'number' ? f.ageMinutes : null;
      const delayRemaining = ageMinutes != null
        ? Math.max(0, delayTargetMinutes - ageMinutes)
        : delayTargetMinutes;

      candidates.push({
        contractKey:             key,
        symbol:                  f.normalizedSignal.symbol,
        score:                   typeof f.ripperScore === 'number' ? f.ripperScore : null,
        ageMinutes,
        clusterRisk:             getClusterRisk(f),
        entryPriceUsd:           getEntryPriceUsd(f),
        priceChangePct:          typeof f.normalizedSignal.priceChangePct === 'number'
          ? f.normalizedSignal.priceChangePct
          : null,
        approvedAt:              f.capturedAt,
        sourceArtifact:          inputPath,
        immediateApproved:       true,
        delayTargetMinutes,
        delayRemainingMinutes:   delayRemaining,
        eligibleForDelayedEntry: ageMinutes != null && ageMinutes >= delayTargetMinutes,
      });
    }
  }

  // Sort: eligible first (desc by ageMinutes), then too-young (asc by delayRemaining)
  candidates.sort((a, b) => {
    if (a.eligibleForDelayedEntry !== b.eligibleForDelayedEntry) {
      return a.eligibleForDelayedEntry ? -1 : 1;
    }
    if (a.eligibleForDelayedEntry) {
      return (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0);
    }
    return a.delayRemainingMinutes - b.delayRemainingMinutes;
  });

  const clusterBreakdown = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };
  for (const c of candidates) {
    const k = c.clusterRisk as keyof typeof clusterBreakdown;
    if (k in clusterBreakdown) clusterBreakdown[k]++;
    else clusterBreakdown.UNKNOWN++;
  }

  const tooYoungCount = candidates.filter(c => !c.eligibleForDelayedEntry).length;
  const eligibleCount = candidates.filter(c =>  c.eligibleForDelayedEntry).length;

  const result: RipperDelayedWatchResult = {
    generatedAt,
    outPath:               options.outPath,
    delayTargetMinutes,
    filesRead,
    filesMissing,
    fixturesScanned,
    candidatesFound:       candidates.length,
    immediateApprovalCount: candidates.length,
    tooYoungCount,
    eligibleCount,
    avgAge:                avgOf(candidates.map(c => c.ageMinutes)),
    avgScore:              avgOf(candidates.map(c => c.score)),
    clusterBreakdown,
    candidates,
    realTradingLocked:     true,
    tradingExecuted:       0,
    noRealTradeSent:       true,
    paperOnly:             true,
    readOnly:              true,
  };

  const outDir = path.dirname(options.outPath);
  if (outDir && outDir !== '.') {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(options.outPath, JSON.stringify(result, null, 2), 'utf-8');

  return result;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtAge(m: number | null | undefined): string {
  if (m == null) return 'n/a';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function fmtScore(s: number | null | undefined): string {
  return s != null ? String(Math.round(s)).padStart(3) : '  ?';
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export function renderRipperDelayedWatch(result: RipperDelayedWatchResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER DELAYED-ENTRY WATCH LANE');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — NO GATE CHANGES]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated          : ${result.generatedAt}`);
  lines.push(
    `  Cycle files read   : ${result.filesRead}` +
    (result.filesMissing > 0 ? `  (${result.filesMissing} missing)` : ''),
  );
  lines.push(`  Fixtures scanned   : ${result.fixturesScanned}`);
  lines.push(`  Delay target       : ${result.delayTargetMinutes}m`);
  lines.push('');
  lines.push(`  Candidates found   : ${result.candidatesFound}`);
  lines.push(`  Immediate approvals: ${result.immediateApprovalCount}  (current gate — unchanged)`);
  lines.push(`  Too young for delay: ${result.tooYoungCount}  (need more time before delayed entry)`);
  lines.push(`  Eligible for delay : ${result.eligibleCount}  (age >= ${result.delayTargetMinutes}m)`);
  if (result.avgAge != null) {
    lines.push(`  Avg age            : ${fmtAge(result.avgAge)}`);
  }
  if (result.avgScore != null) {
    lines.push(`  Avg score          : ${Math.round(result.avgScore)}`);
  }
  const bd = result.clusterBreakdown;
  lines.push(`  Cluster breakdown  : CLEAN=${bd.CLEAN} WATCH=${bd.WATCH} RISKY=${bd.RISKY} UNKNOWN=${bd.UNKNOWN}`);
  lines.push('');

  if (result.candidates.length === 0) {
    lines.push('  (no approved candidates found)');
  } else {
    const eligible   = result.candidates.filter(c => c.eligibleForDelayedEntry);
    const tooYoung   = result.candidates.filter(c => !c.eligibleForDelayedEntry);

    if (eligible.length > 0) {
      lines.push(`  — ELIGIBLE for delayed entry (age >= ${result.delayTargetMinutes}m) ——————————————————`);
      for (const c of eligible) {
        const sym  = c.symbol ? `$${c.symbol}` : '(unknown)';
        const addr = c.contractKey.length > 12 ? `${c.contractKey.slice(0, 12)}…` : c.contractKey;
        lines.push(
          `  score=${fmtScore(c.score)}  ${sym.padEnd(14)}  age=${fmtAge(c.ageMinutes).padEnd(6)}` +
          `  cluster=${c.clusterRisk.padEnd(7)}  pct=${fmtPct(c.priceChangePct).padEnd(8)}  ✓ eligible`,
        );
        lines.push(`           ${addr}  approved=${c.approvedAt}`);
      }
      lines.push('');
    }

    if (tooYoung.length > 0) {
      lines.push(`  — TOO YOUNG for delayed entry (need >= ${result.delayTargetMinutes}m) ———————————————`);
      for (const c of tooYoung) {
        const sym  = c.symbol ? `$${c.symbol}` : '(unknown)';
        const addr = c.contractKey.length > 12 ? `${c.contractKey.slice(0, 12)}…` : c.contractKey;
        lines.push(
          `  score=${fmtScore(c.score)}  ${sym.padEnd(14)}  age=${fmtAge(c.ageMinutes).padEnd(6)}` +
          `  cluster=${c.clusterRisk.padEnd(7)}  pct=${fmtPct(c.priceChangePct).padEnd(8)}` +
          `  wait=${fmtAge(c.delayRemainingMinutes)} more`,
        );
        lines.push(`           ${addr}  approved=${c.approvedAt}`);
      }
      lines.push('');
    }
  }

  lines.push(`  Output             : ${result.outPath}`);
  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}
