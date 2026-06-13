import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelayedWatchCandidate {
  contractKey: string;
  symbol?: string;
  score: number | null;                    // original immediate-approval score
  ageMinutes: number | null;               // original immediate-approval age
  clusterRisk: string;
  entryPriceUsd: number | null;
  priceChangePct: number | null;           // original immediate-approval pct
  approvedAt: string;
  sourceArtifact: string;
  immediateApproved: true;
  delayTargetMinutes: number;
  delayRemainingMinutes: number;
  eligibleForDelayedEntry: boolean;
  latestObservedAgeMinutes: number | null;
  latestObservedScore: number | null;
  latestObservedPriceChangePct: number | null;
  latestObservedAt?: string;
  latestObservationArtifact?: string;
  postApprovalObservationCount: number;
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
  postApprovalObservationsRead: number;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asSignalRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contractKeyOfSignal(signal: Record<string, unknown>): string | null {
  return getString(signal['contract'])
    ?? getString(signal['tokenAddress'])
    ?? getString(signal['poolAddress'])
    ?? getString(signal['id'])
    ?? null;
}

function getSymbol(signal: Record<string, unknown>): string | undefined {
  return getString(signal['symbol']);
}

function getClusterRisk(fixture: Record<string, unknown>): string {
  const raw = asRecord(fixture['raw']);
  const value = raw?.['clusterRisk'];
  if (value === 'CLEAN' || value === 'WATCH' || value === 'RISKY') return value;
  return 'UNKNOWN';
}

function getEntryPriceUsd(signal: Record<string, unknown>): number | null {
  const raw   = asRecord(signal['raw']);
  const entry = asRecord(raw?.['entry']);
  return getNumber(entry?.['priceUsd']);
}

function getPriceChangePct(signal: Record<string, unknown>): number | null {
  return getNumber(signal['priceChangePct']);
}

function isPostApprovalObservation(fixture: Record<string, unknown>): boolean {
  return fixture['postApprovalObservation'] === true;
}

function getAgeMinutes(fixture: Record<string, unknown>): number | null {
  return getNumber(fixture['ageMinutes']);
}

function getScore(fixture: Record<string, unknown>): number | null {
  return getNumber(fixture['ripperScore']);
}

function getCapturedAt(fixture: Record<string, unknown>): string | undefined {
  return getString(fixture['capturedAt']);
}

function latestAge(candidate: DelayedWatchCandidate): number | null {
  return candidate.latestObservedAgeMinutes ?? candidate.ageMinutes;
}

function latestScore(candidate: DelayedWatchCandidate): number | null {
  return candidate.latestObservedScore ?? candidate.score;
}

function latestPct(candidate: DelayedWatchCandidate): number | null {
  return candidate.latestObservedPriceChangePct ?? candidate.priceChangePct;
}

function shouldReplaceObservation(
  currentAge: number | null,
  currentAt: string | undefined,
  nextAge: number | null,
  nextAt: string | undefined,
): boolean {
  if (currentAge == null && nextAge != null) return true;
  if (currentAge != null && nextAge != null) {
    if (nextAge > currentAge) return true;
    if (nextAge < currentAge) return false;
  }
  if (!currentAt && nextAt) return true;
  if (currentAt && nextAt) return nextAt > currentAt;
  return false;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function buildImmediateCandidate(
  fixture: Record<string, unknown>,
  signal: Record<string, unknown>,
  key: string,
  inputPath: string,
  delayTargetMinutes: number,
): DelayedWatchCandidate {
  const ageMinutes = getAgeMinutes(fixture);
  const effectiveAge = ageMinutes;
  const delayRemaining = effectiveAge != null
    ? Math.max(0, delayTargetMinutes - effectiveAge)
    : delayTargetMinutes;

  return {
    contractKey: key,
    symbol: getSymbol(signal),
    score: getScore(fixture),
    ageMinutes,
    clusterRisk: getClusterRisk(fixture),
    entryPriceUsd: getEntryPriceUsd(signal),
    priceChangePct: getPriceChangePct(signal),
    approvedAt: getCapturedAt(fixture) ?? '',
    sourceArtifact: inputPath,
    immediateApproved: true,
    delayTargetMinutes,
    delayRemainingMinutes: delayRemaining,
    eligibleForDelayedEntry: effectiveAge != null && effectiveAge >= delayTargetMinutes,
    latestObservedAgeMinutes: null,
    latestObservedScore: null,
    latestObservedPriceChangePct: null,
    postApprovalObservationCount: 0,
  };
}

function applyObservationToCandidate(
  candidate: DelayedWatchCandidate,
  fixture: Record<string, unknown>,
  signal: Record<string, unknown>,
  inputPath: string,
  delayTargetMinutes: number,
): void {
  const observationAge = getAgeMinutes(fixture);
  const observationAt = getCapturedAt(fixture);
  candidate.postApprovalObservationCount += 1;

  if (shouldReplaceObservation(
    candidate.latestObservedAgeMinutes,
    candidate.latestObservedAt,
    observationAge,
    observationAt,
  )) {
    candidate.latestObservedAgeMinutes = observationAge;
    candidate.latestObservedScore = getScore(fixture);
    candidate.latestObservedPriceChangePct = getPriceChangePct(signal);
    candidate.latestObservedAt = observationAt;
    candidate.latestObservationArtifact = inputPath;
  }

  const effectiveAge = latestAge(candidate);
  candidate.delayRemainingMinutes = effectiveAge != null
    ? Math.max(0, delayTargetMinutes - effectiveAge)
    : delayTargetMinutes;
  candidate.eligibleForDelayedEntry = effectiveAge != null && effectiveAge >= delayTargetMinutes;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperDelayedWatch(
  options: RipperDelayedWatchOptions,
): RipperDelayedWatchResult {
  const nowMs              = options.nowMs ?? Date.now();
  const generatedAt        = new Date(nowMs).toISOString();
  const delayTargetMinutes = options.delayTargetMinutes;
  const inputPaths         = Array.isArray(options.inputPaths) ? options.inputPaths : [];

  let filesRead                   = 0;
  let filesMissing                = 0;
  let fixturesScanned             = 0;
  let immediateApprovalCount      = 0;
  let postApprovalObservationsRead = 0;

  const candidatesByKey = new Map<string, DelayedWatchCandidate>();

  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      filesMissing += 1;
      continue;
    }
    filesRead += 1;
    const fixtures = readFixturesFromJsonl(inputPath) as unknown as unknown[];
    fixturesScanned += fixtures.length;

    for (const fixtureValue of fixtures) {
      const fixture = asRecord(fixtureValue);
      const signal = asSignalRecord(fixture?.['normalizedSignal']);
      if (!fixture || !signal) continue;

      const key = contractKeyOfSignal(signal);
      if (!key) continue;

      if (isPostApprovalObservation(fixture)) {
        postApprovalObservationsRead += 1;
        const existing = candidatesByKey.get(key)
          ?? buildImmediateCandidate(fixture, signal, key, inputPath, delayTargetMinutes);
        if (!candidatesByKey.has(key)) {
          const originalApprovedAt = getString(fixture['originalApprovedAt']);
          if (originalApprovedAt) existing.approvedAt = originalApprovedAt;
          existing.sourceArtifact = inputPath;
        }
        applyObservationToCandidate(existing, fixture, signal, inputPath, delayTargetMinutes);
        candidatesByKey.set(key, existing);
        continue;
      }

      if (fixture['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
      if (candidatesByKey.has(key)) continue;

      immediateApprovalCount += 1;
      candidatesByKey.set(key, buildImmediateCandidate(fixture, signal, key, inputPath, delayTargetMinutes));
    }
  }

  const candidates = [...candidatesByKey.values()];

  candidates.sort((a, b) => {
    if (a.eligibleForDelayedEntry !== b.eligibleForDelayedEntry) {
      return a.eligibleForDelayedEntry ? -1 : 1;
    }
    if (a.eligibleForDelayedEntry) {
      return (latestAge(b) ?? 0) - (latestAge(a) ?? 0);
    }
    return a.delayRemainingMinutes - b.delayRemainingMinutes;
  });

  const clusterBreakdown = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };
  for (const c of candidates) {
    const key = c.clusterRisk as keyof typeof clusterBreakdown;
    if (key in clusterBreakdown) clusterBreakdown[key] += 1;
    else clusterBreakdown.UNKNOWN += 1;
  }

  const tooYoungCount = candidates.filter(c => !c.eligibleForDelayedEntry).length;
  const eligibleCount = candidates.filter(c => c.eligibleForDelayedEntry).length;

  const result: RipperDelayedWatchResult = {
    generatedAt,
    outPath: options.outPath,
    delayTargetMinutes,
    filesRead,
    filesMissing,
    fixturesScanned,
    candidatesFound: candidates.length,
    immediateApprovalCount,
    postApprovalObservationsRead,
    tooYoungCount,
    eligibleCount,
    avgAge: avgOf(candidates.map(c => latestAge(c))),
    avgScore: avgOf(candidates.map(c => latestScore(c))),
    clusterBreakdown,
    candidates,
    realTradingLocked: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
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
    `  Input files read   : ${result.filesRead}` +
    (result.filesMissing > 0 ? `  (${result.filesMissing} missing)` : ''),
  );
  lines.push(`  Fixtures scanned   : ${result.fixturesScanned}`);
  lines.push(`  Delay target       : ${result.delayTargetMinutes}m`);
  lines.push('');
  lines.push(`  Candidates found   : ${result.candidatesFound}`);
  lines.push(`  Immediate approvals: ${result.immediateApprovalCount}  (current gate — unchanged)`);
  lines.push(`  Post-approval obs  : ${result.postApprovalObservationsRead}`);
  lines.push(`  Too young for delay: ${result.tooYoungCount}  (need more time before delayed entry)`);
  lines.push(`  Eligible for delay : ${result.eligibleCount}  (latest age >= ${result.delayTargetMinutes}m)`);
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
    const eligible = result.candidates.filter(c => c.eligibleForDelayedEntry);
    const tooYoung = result.candidates.filter(c => !c.eligibleForDelayedEntry);

    if (eligible.length > 0) {
      lines.push(`  — ELIGIBLE for delayed entry (latest age >= ${result.delayTargetMinutes}m) —————————————`);
      for (const c of eligible) {
        const sym = c.symbol ? `$${c.symbol}` : '(unknown)';
        const addr = c.contractKey.length > 12 ? `${c.contractKey.slice(0, 12)}…` : c.contractKey;
        lines.push(
          `  score=${fmtScore(latestScore(c))}  ${sym.padEnd(14)}  age=${fmtAge(latestAge(c)).padEnd(6)}` +
          `  cluster=${c.clusterRisk.padEnd(7)}  pct=${fmtPct(latestPct(c)).padEnd(8)}  ✓ eligible`,
        );
        lines.push(
          `           ${addr}  approved=${c.approvedAt}  obs=${c.postApprovalObservationCount}` +
          `  latestAge=${fmtAge(c.latestObservedAgeMinutes)}  latestScore=${fmtScore(c.latestObservedScore)}` +
          `  latestPct=${fmtPct(c.latestObservedPriceChangePct)}`,
        );
      }
      lines.push('');
    }

    if (tooYoung.length > 0) {
      lines.push(`  — TOO YOUNG for delayed entry (need >= ${result.delayTargetMinutes}m latest age) ———————`);
      for (const c of tooYoung) {
        const sym = c.symbol ? `$${c.symbol}` : '(unknown)';
        const addr = c.contractKey.length > 12 ? `${c.contractKey.slice(0, 12)}…` : c.contractKey;
        lines.push(
          `  score=${fmtScore(latestScore(c))}  ${sym.padEnd(14)}  age=${fmtAge(latestAge(c)).padEnd(6)}` +
          `  cluster=${c.clusterRisk.padEnd(7)}  pct=${fmtPct(latestPct(c)).padEnd(8)}` +
          `  wait=${fmtAge(c.delayRemainingMinutes)} more`,
        );
        lines.push(
          `           ${addr}  approved=${c.approvedAt}  obs=${c.postApprovalObservationCount}` +
          `  latestAge=${fmtAge(c.latestObservedAgeMinutes)}  latestScore=${fmtScore(c.latestObservedScore)}` +
          `  latestPct=${fmtPct(c.latestObservedPriceChangePct)}`,
        );
      }
      lines.push('');
    }
  }

  lines.push(`  Output             : ${result.outPath}`);
  lines.push('');
  lines.push('  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true');
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}
