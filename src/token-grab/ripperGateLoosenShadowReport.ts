import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PolicyName = 'CURRENT_APPROVAL' | 'LOOSE_60_WATCH' | 'AGGRESSIVE_55_WATCH';

export type CandidateVerdict =
  | 'WOULD_HAVE_HELPED'
  | 'NO_EDGE'
  | 'DUMP_RISK'
  | 'NO_LATER_DATA';

export interface ExtraCandidate {
  symbol:            string | null;
  contractShort:     string;
  contractKey:       string;
  score:             number | null;
  launchAgeBucket:   string | null;
  entryDecision:     string | null;
  clusterRisk:       string;
  firstSeenAt:       string;
  bestLaterMovePct:  number | null;
  worstLaterMovePct: number | null;
  verdict:           CandidateVerdict;
}

export interface PolicyStats {
  policy:             PolicyName;
  totalCandidates:    number;
  uniqueContracts:    number;
  overlapWithCurrent: number;
  extraBeyondCurrent: number;
  movedPlus1:         number;
  movedPlus3:         number;
  movedPlus5:         number;
  dumpedMinus3:       number;
  noLaterData:        number;
  avgBestLaterMove:   number | null;
  medianBestLaterMove: number | null;
  worstLaterMove:     number | null;
  topExtras:          ExtraCandidate[];
}

export interface RipperGateLoosenShadowReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
}

export interface RipperGateLoosenShadowReportResult {
  generatedAt:       string;
  current:           PolicyStats;
  loose60:           PolicyStats;
  aggressive55:      PolicyStats;
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DANGER_TERMS = ['dangerous', 'rug', 'blacklist', 'honeypot', 'freeze', 'mint authority'];

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

function getRaw(f: LiveRipperFixture): Record<string, unknown> {
  return (f.raw as Record<string, unknown> | undefined) ?? {};
}

function getClusterRisk(f: LiveRipperFixture): string {
  const v = getRaw(f)['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' || v === 'UNKNOWN') return v as string;
  // also try ripperInput
  const ri = f.ripperInput as Record<string, unknown> | null;
  if (ri) {
    const rv = ri['clusterRisk'];
    if (rv === 'CLEAN' || rv === 'WATCH' || rv === 'RISKY' || rv === 'UNKNOWN') return rv as string;
  }
  return 'UNKNOWN';
}

function hasDanger(f: LiveRipperFixture): boolean {
  const combined = [...(f.blockers ?? []), ...(f.warnings ?? [])].map(s => s.toLowerCase());
  return DANGER_TERMS.some(term => combined.some(s => s.includes(term)));
}

function passesLoose60(f: LiveRipperFixture): boolean {
  const score = f.ripperScore ?? 0;
  if (score < 60) return false;
  const ed = f.entryDecision ?? '';
  if (ed !== 'READY_TO_SNIPE_PAPER' && ed !== 'WATCH') return false;
  const lab = f.launchAgeBucket ?? '';
  if (lab !== 'TOO_EARLY' && lab !== 'PRIME_WINDOW') return false;
  const cr = getClusterRisk(f);
  if (cr !== 'WATCH' && cr !== 'CLEAN' && cr !== 'LOW' && cr !== 'UNKNOWN') return false;
  if (hasDanger(f)) return false;
  return true;
}

function passesAggressive55(f: LiveRipperFixture): boolean {
  const score = f.ripperScore ?? 0;
  if (score < 55) return false;
  const ed = f.entryDecision ?? '';
  if (ed !== 'READY_TO_SNIPE_PAPER' && ed !== 'WATCH') return false;
  // LATE is also allowed for aggressive
  const lab = f.launchAgeBucket ?? '';
  if (lab !== 'TOO_EARLY' && lab !== 'PRIME_WINDOW' && lab !== 'LATE') return false;
  const cr = getClusterRisk(f);
  if (cr !== 'WATCH' && cr !== 'CLEAN' && cr !== 'LOW' && cr !== 'UNKNOWN') return false;
  if (hasDanger(f)) return false;
  return true;
}

function avg(vals: number[]): number | null {
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ── Core ──────────────────────────────────────────────────────────────────────

export function runRipperGateLoosenShadowReport(
  options: RipperGateLoosenShadowReportOptions,
): RipperGateLoosenShadowReportResult {
  const generatedAt = new Date().toISOString();

  // ── Load approval fixtures ─────────────────────────────────────────────────
  // Maps contractKey → first fixture that matches each policy
  const currentMap:     Map<string, LiveRipperFixture> = new Map();
  const loose60Map:     Map<string, LiveRipperFixture> = new Map();
  const aggressive55Map: Map<string, LiveRipperFixture> = new Map();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const key = signalKey(f.normalizedSignal);
      if (f.buyGateDecision === 'BUY_APPROVED_PAPER' && !currentMap.has(key)) {
        currentMap.set(key, f);
      }
      if (passesLoose60(f)     && !loose60Map.has(key))      loose60Map.set(key, f);
      if (passesAggressive55(f) && !aggressive55Map.has(key)) aggressive55Map.set(key, f);
    }
  }

  // Also check obs fixtures for policy matches (dual-source: approvals may be in obs too)
  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const key = signalKey(f.normalizedSignal);
      if (f.buyGateDecision === 'BUY_APPROVED_PAPER' && !currentMap.has(key)) {
        currentMap.set(key, f);
      }
      if (passesLoose60(f)     && !loose60Map.has(key))      loose60Map.set(key, f);
      if (passesAggressive55(f) && !aggressive55Map.has(key)) aggressive55Map.set(key, f);
    }
  }

  // ── Load observation price data ────────────────────────────────────────────
  // contractKey → sorted list of { capturedAtMs, priceChangePct }
  const priceHistory = new Map<string, Array<{ capturedAtMs: number; pct: number | null }>>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const key = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      const pct = sig['priceChangePct'];
      const pctNum = pct != null && Number.isFinite(Number(pct)) ? Number(pct) : null;
      const list = priceHistory.get(key);
      if (list) list.push({ capturedAtMs, pct: pctNum });
      else priceHistory.set(key, [{ capturedAtMs, pct: pctNum }]);
    }
  }

  for (const list of priceHistory.values()) {
    list.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  }

  // ── Compute stats for a candidate set ─────────────────────────────────────
  function computeStats(
    candidateMap: Map<string, LiveRipperFixture>,
    policy:       PolicyName,
    currentKeys:  Set<string>,
  ): PolicyStats {
    const extraKeys   = new Set<string>();
    const bestMoves:  number[] = [];
    let movedPlus1    = 0;
    let movedPlus3    = 0;
    let movedPlus5    = 0;
    let dumpedMinus3  = 0;
    let noLaterData   = 0;

    const extraCandidates: ExtraCandidate[] = [];

    for (const [key, f] of candidateMap) {
      const isExtra = !currentKeys.has(key);
      if (isExtra) extraKeys.add(key);

      const firstSeenMs = Date.parse(f.capturedAt);
      const history     = priceHistory.get(key) ?? [];
      const laterObs    = history.filter(h => h.capturedAtMs > firstSeenMs);
      const laterPcts   = laterObs.map(h => h.pct).filter((v): v is number => v != null);

      if (laterPcts.length === 0) {
        noLaterData++;
        if (isExtra) {
          extraCandidates.push({
            symbol:            f.normalizedSignal.symbol ?? null,
            contractShort:     shortKey(key),
            contractKey:       key,
            score:             f.ripperScore ?? null,
            launchAgeBucket:   f.launchAgeBucket ?? null,
            entryDecision:     f.entryDecision   ?? null,
            clusterRisk:       getClusterRisk(f),
            firstSeenAt:       f.capturedAt,
            bestLaterMovePct:  null,
            worstLaterMovePct: null,
            verdict:           'NO_LATER_DATA',
          });
        }
      } else {
        const best  = Math.max(...laterPcts);
        const worst = Math.min(...laterPcts);
        bestMoves.push(best);
        if (best >= 1)  movedPlus1++;
        if (best >= 3)  movedPlus3++;
        if (best >= 5)  movedPlus5++;
        if (worst <= -3) dumpedMinus3++;

        if (isExtra) {
          let verdict: CandidateVerdict;
          if (worst <= -3)    verdict = 'DUMP_RISK';
          else if (best >= 1) verdict = 'WOULD_HAVE_HELPED';
          else                verdict = 'NO_EDGE';

          extraCandidates.push({
            symbol:            f.normalizedSignal.symbol ?? null,
            contractShort:     shortKey(key),
            contractKey:       key,
            score:             f.ripperScore ?? null,
            launchAgeBucket:   f.launchAgeBucket ?? null,
            entryDecision:     f.entryDecision   ?? null,
            clusterRisk:       getClusterRisk(f),
            firstSeenAt:       f.capturedAt,
            bestLaterMovePct:  best,
            worstLaterMovePct: worst,
            verdict,
          });
        }
      }
    }

    // Sort extra candidates: WOULD_HAVE_HELPED first, then by bestLaterMovePct desc
    extraCandidates.sort((a, b) => {
      const vOrder: Record<CandidateVerdict, number> = {
        WOULD_HAVE_HELPED: 0, NO_LATER_DATA: 1, NO_EDGE: 2, DUMP_RISK: 3,
      };
      const vDiff = vOrder[a.verdict] - vOrder[b.verdict];
      if (vDiff !== 0) return vDiff;
      return (b.bestLaterMovePct ?? -Infinity) - (a.bestLaterMovePct ?? -Infinity);
    });

    return {
      policy,
      totalCandidates:    candidateMap.size,
      uniqueContracts:    candidateMap.size,
      overlapWithCurrent: candidateMap.size - extraKeys.size,
      extraBeyondCurrent: extraKeys.size,
      movedPlus1,
      movedPlus3,
      movedPlus5,
      dumpedMinus3,
      noLaterData,
      avgBestLaterMove:    avg(bestMoves),
      medianBestLaterMove: median(bestMoves),
      worstLaterMove:      bestMoves.length > 0 ? Math.min(...bestMoves) : null,
      topExtras:           extraCandidates.slice(0, 15),
    };
  }

  const currentKeys = new Set(currentMap.keys());
  const current     = computeStats(currentMap,       'CURRENT_APPROVAL',    currentKeys);
  const loose60     = computeStats(loose60Map,        'LOOSE_60_WATCH',      currentKeys);
  const aggressive55 = computeStats(aggressive55Map, 'AGGRESSIVE_55_WATCH', currentKeys);

  return {
    generatedAt,
    current,
    loose60,
    aggressive55,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n == null) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtN(n: number | null | undefined): string {
  return n == null ? 'n/a' : String(n);
}

export function renderRipperGateLoosenShadowReport(
  result: RipperGateLoosenShadowReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER GATE LOOSEN SHADOW REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO GATE CHANGES — READ ONLY]');
  lines.push(SEP, '');
  lines.push(`  Generated : ${result.generatedAt}`);
  lines.push('');

  function renderPolicy(s: PolicyStats): void {
    lines.push(`  ${SEP2}`);
    lines.push(`  POLICY: ${s.policy}`);
    lines.push(`  ${SEP2}`, '');
    lines.push(`  Total candidates    : ${fmtN(s.totalCandidates)}`);
    lines.push(`  Unique contracts    : ${fmtN(s.uniqueContracts)}`);
    lines.push(`  Overlap w/ current  : ${fmtN(s.overlapWithCurrent)}`);
    lines.push(`  Extra beyond current: ${fmtN(s.extraBeyondCurrent)}`);
    lines.push('');
    lines.push(`  Among selected (with later obs):`);
    lines.push(`    Moved >= +1% : ${fmtN(s.movedPlus1)}`);
    lines.push(`    Moved >= +3% : ${fmtN(s.movedPlus3)}`);
    lines.push(`    Moved >= +5% : ${fmtN(s.movedPlus5)}`);
    lines.push(`    Dumped <=-3% : ${fmtN(s.dumpedMinus3)}`);
    lines.push(`    No later data: ${fmtN(s.noLaterData)}`);
    lines.push('');
    lines.push(`  Avg best later move   : ${fmtPct(s.avgBestLaterMove)}`);
    lines.push(`  Median best later move: ${fmtPct(s.medianBestLaterMove)}`);
    lines.push(`  Worst later move      : ${fmtPct(s.worstLaterMove)}`);

    if (s.topExtras.length > 0) {
      lines.push('');
      lines.push(`  TOP EXTRA CANDIDATES (beyond CURRENT_APPROVAL):`);
      const hdr = [
        'sym/addr'.padEnd(14),
        'score'.padStart(6),
        'launch'.padEnd(13),
        'entry'.padEnd(20),
        'cluster'.padEnd(8),
        'bestMove'.padStart(9),
        'worstMove'.padStart(10),
        'verdict',
      ].join('  ');
      lines.push(`  ${hdr}`);
      lines.push(`  ${'─'.repeat(hdr.length)}`);
      for (const e of s.topExtras) {
        const label = e.symbol ? `$${e.symbol}` : e.contractShort;
        const row = [
          label.padEnd(14),
          fmtN(e.score).padStart(6),
          (e.launchAgeBucket ?? 'n/a').padEnd(13),
          (e.entryDecision   ?? 'n/a').padEnd(20),
          e.clusterRisk.padEnd(8),
          fmtPct(e.bestLaterMovePct).padStart(9),
          fmtPct(e.worstLaterMovePct).padStart(10),
          e.verdict,
        ].join('  ');
        lines.push(`  ${row}`);
      }
    }
    lines.push('');
  }

  renderPolicy(result.current);
  renderPolicy(result.loose60);
  renderPolicy(result.aggressive55);

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Report-only — no trades, no gate changes, no ripper-autopilot wiring.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL THRESHOLDS');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
