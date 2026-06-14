import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';
import {
  WATCH_EARLY_RIP_LIQ_MIN,
  WATCH_EARLY_RIP_VOL_MIN,
  WATCH_EARLY_RIP_PCT_MIN,
  WATCH_EARLY_RIP_PCT_MAX,
} from './ripperEarlyWatchPolicyReport';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BlockerLabel =
  | 'LOW_LIQUIDITY_AT_BEST'
  | 'LOW_VOLUME_AT_BEST'
  | 'PRICE_ALREADY_MOVED_TOO_FAR'
  | 'HOLDER_RISK'
  | 'CLUSTER_RISK'
  | 'SAFETY_NOT_ENRICHED'
  | 'UNKNOWN_BLOCKER';

export interface BlockerAutopsyRow {
  contractKey:           string;
  contractKeyShort:      string;
  symbol?:               string;
  firstWatchAt:          string;
  bestMoveAt:            string;
  watchPriceChangePct:   number | null;
  watchLiquidityUsd:     number | null;
  watchVolumeUsd:        number | null;
  bestPriceChangePct:    number | null;
  bestLiquidityUsd:      number | null;
  bestVolumeUsd:         number | null;
  latestPriceChangePct:  number | null;
  latestLiquidityUsd:    number | null;
  latestVolumeUsd:       number | null;
  bestMoveGateDecision:  string | null;
  bestMoveRipperScore:   number | null;
  engineBlockers:        string[];
  derivedBlockers:       BlockerLabel[];
}

export interface RipperEarlyWatchBlockerAutopsyOptions {
  observationPaths: string[];
  approvalPaths:    string[];
  nowMs?:           number;
}

export interface RipperEarlyWatchBlockerAutopsyResult {
  generatedAt:          string;
  totalPriceMovedCount: number;
  rows:                 BlockerAutopsyRow[];
  reportOnly:           true;
  readOnly:             true;
  tradingExecuted:      0;
  realTradingLocked:    true;
  paperOnly:            true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

function passesPolicy(pct: number | null, liq: number | null, vol: number | null): boolean {
  return (
    liq != null && liq >= WATCH_EARLY_RIP_LIQ_MIN &&
    vol != null && vol >= WATCH_EARLY_RIP_VOL_MIN &&
    pct != null && pct >= WATCH_EARLY_RIP_PCT_MIN && pct <= WATCH_EARLY_RIP_PCT_MAX
  );
}

function deriveBlockers(fixture: LiveRipperFixture): BlockerLabel[] {
  const labels: BlockerLabel[] = [];
  const sig    = fixture.normalizedSignal as unknown as Record<string, unknown>;
  const liq    = toFiniteNum(sig['liquidityUsd']);
  const vol    = toFiniteNum(sig['volumeUsd']);
  const pct    = toFiniteNum(sig['priceChangePct']);
  const holder = sig['holderRiskHint'];
  const cluster = sig['clusterRiskHint'];

  if (liq != null && liq < WATCH_EARLY_RIP_LIQ_MIN) labels.push('LOW_LIQUIDITY_AT_BEST');
  if (vol != null && vol < WATCH_EARLY_RIP_VOL_MIN)  labels.push('LOW_VOLUME_AT_BEST');
  if (pct != null && pct > 1.0)                      labels.push('PRICE_ALREADY_MOVED_TOO_FAR');
  if (holder === 'RISKY')                             labels.push('HOLDER_RISK');
  if (cluster != null && typeof cluster === 'string' &&
      (cluster.toUpperCase().includes('RISK') || cluster.toUpperCase().includes('DANGER'))) {
    labels.push('CLUSTER_RISK');
  }
  if (holder == null && cluster == null) labels.push('SAFETY_NOT_ENRICHED');

  if (labels.length === 0) labels.push('UNKNOWN_BLOCKER');
  return labels;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEarlyWatchBlockerAutopsy(
  options: RipperEarlyWatchBlockerAutopsyOptions,
): RipperEarlyWatchBlockerAutopsyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Load observations ──────────────────────────────────────────────────────
  // Per-contract: sorted ascending by capturedAt
  const allFixturesMap  = new Map<string, LiveRipperFixture[]>();
  const firstHitMap     = new Map<string, LiveRipperFixture>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const contractKey  = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;

      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      const pct = toFiniteNum(sig['priceChangePct']);
      const liq = toFiniteNum(sig['liquidityUsd']);
      const vol = toFiniteNum(sig['volumeUsd']);

      const list = allFixturesMap.get(contractKey);
      if (list) list.push(f);
      else allFixturesMap.set(contractKey, [f]);

      if (passesPolicy(pct, liq, vol)) {
        const existing = firstHitMap.get(contractKey);
        if (!existing || capturedAtMs < Date.parse(existing.capturedAt)) {
          firstHitMap.set(contractKey, f);
        }
      }
    }
  }

  // Sort all fixture lists ascending
  for (const list of allFixturesMap.values()) {
    list.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  }

  // ── Load approvals ─────────────────────────────────────────────────────────
  const instanceKeySet = new Set<string>();
  const approvalsMap   = new Map<string, number[]>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey  = signalKey(f.normalizedSignal);
      const instanceKey  = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) continue;
      instanceKeySet.add(instanceKey);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      const list = approvalsMap.get(contractKey);
      if (list) list.push(capturedAtMs);
      else approvalsMap.set(contractKey, [capturedAtMs]);
    }
  }

  // ── Build rows ─────────────────────────────────────────────────────────────
  const rows: BlockerAutopsyRow[] = [];

  for (const [contractKey, firstHit] of firstHitMap) {
    const firstWatchAtMs = Date.parse(firstHit.capturedAt);
    const allFixtures    = allFixturesMap.get(contractKey) ?? [];

    // Later fixtures strictly after first watch
    const laterFixtures = allFixtures.filter(f => Date.parse(f.capturedAt) > firstWatchAtMs);

    // Find fixture with best priceChangePct among later fixtures
    let bestMoveFixture: LiveRipperFixture | null = null;
    let bestPct: number | null = null;
    for (const f of laterFixtures) {
      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      const pct = toFiniteNum(sig['priceChangePct']);
      if (pct != null && (bestPct == null || pct > bestPct)) {
        bestPct = pct;
        bestMoveFixture = f;
      }
    }

    // Filter: only PRICE_MOVED candidates (best > 0.25, no approval)
    if (bestPct == null || bestPct <= WATCH_EARLY_RIP_PCT_MAX) continue;
    const approvalTimes    = approvalsMap.get(contractKey) ?? [];
    const laterBuyApproved = approvalTimes.some(t => t >= firstWatchAtMs);
    if (laterBuyApproved) continue;

    const latestFixture = allFixtures[allFixtures.length - 1] ?? firstHit;

    const watchSig  = firstHit.normalizedSignal as unknown as Record<string, unknown>;
    const bestSig   = bestMoveFixture
      ? bestMoveFixture.normalizedSignal as unknown as Record<string, unknown>
      : null;
    const latestSig = latestFixture.normalizedSignal as unknown as Record<string, unknown>;

    const engineBlockers  = bestMoveFixture?.blockers ?? [];
    const derivedBlockers = bestMoveFixture ? deriveBlockers(bestMoveFixture) : ['UNKNOWN_BLOCKER' as const];

    rows.push({
      contractKey,
      contractKeyShort:      shortKey(contractKey),
      symbol:                firstHit.normalizedSignal.symbol,
      firstWatchAt:          firstHit.capturedAt,
      bestMoveAt:            bestMoveFixture?.capturedAt ?? firstHit.capturedAt,
      watchPriceChangePct:   toFiniteNum(watchSig['priceChangePct']),
      watchLiquidityUsd:     toFiniteNum(watchSig['liquidityUsd']),
      watchVolumeUsd:        toFiniteNum(watchSig['volumeUsd']),
      bestPriceChangePct:    bestSig ? toFiniteNum(bestSig['priceChangePct']) : null,
      bestLiquidityUsd:      bestSig ? toFiniteNum(bestSig['liquidityUsd'])   : null,
      bestVolumeUsd:         bestSig ? toFiniteNum(bestSig['volumeUsd'])      : null,
      latestPriceChangePct:  toFiniteNum(latestSig['priceChangePct']),
      latestLiquidityUsd:    toFiniteNum(latestSig['liquidityUsd']),
      latestVolumeUsd:       toFiniteNum(latestSig['volumeUsd']),
      bestMoveGateDecision:  bestMoveFixture?.buyGateDecision ?? null,
      bestMoveRipperScore:   bestMoveFixture?.ripperScore     ?? null,
      engineBlockers,
      derivedBlockers,
    });
  }

  rows.sort((a, b) => a.firstWatchAt.localeCompare(b.firstWatchAt));

  return {
    generatedAt,
    totalPriceMovedCount: rows.length,
    rows,
    reportOnly:           true,
    readOnly:             true,
    tradingExecuted:      0,
    realTradingLocked:    true,
    paperOnly:            true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtTs(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

export function renderRipperEarlyWatchBlockerAutopsy(
  result: RipperEarlyWatchBlockerAutopsyResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EARLY WATCH BLOCKER AUTOPSY');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated           : ${result.generatedAt}`);
  lines.push(`  PRICE_MOVED (total) : ${result.totalPriceMovedCount}`);
  lines.push('  (candidates that moved >0.25% after first watch but never got BUY_APPROVED_PAPER)');
  lines.push('');
  lines.push(`  Policy filter: WATCH_EARLY_RIP`);
  lines.push(`    liquidityUsd >= ${WATCH_EARLY_RIP_LIQ_MIN.toLocaleString()}`);
  lines.push(`    volumeUsd    >= ${WATCH_EARLY_RIP_VOL_MIN.toLocaleString()}`);
  lines.push(`    priceChangePct in [${WATCH_EARLY_RIP_PCT_MIN}, ${WATCH_EARLY_RIP_PCT_MAX}]`);
  lines.push('');

  if (result.rows.length === 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  BLOCKER AUTOPSY ROWS');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  (no PRICE_MOVED candidates to autopsy)');
    lines.push('');
  } else {
    for (const [i, r] of result.rows.entries()) {
      const label = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      lines.push(`  ${SEP2}`);
      lines.push(`  [${i + 1}] ${label}  (${r.contractKeyShort})`);
      lines.push(`  ${SEP2}`);
      lines.push('');
      lines.push(`    firstWatchAt : ${fmtTs(r.firstWatchAt)}`);
      lines.push(`    bestMoveAt   : ${fmtTs(r.bestMoveAt)}`);
      lines.push('');
      lines.push(`    At first watch:`);
      lines.push(`      priceChangePct : ${fmtPct(r.watchPriceChangePct)}`);
      lines.push(`      liquidityUsd   : ${fmtUsd(r.watchLiquidityUsd)}`);
      lines.push(`      volumeUsd      : ${fmtUsd(r.watchVolumeUsd)}`);
      lines.push('');
      lines.push(`    At best move:`);
      lines.push(`      priceChangePct : ${fmtPct(r.bestPriceChangePct)}`);
      lines.push(`      liquidityUsd   : ${fmtUsd(r.bestLiquidityUsd)}`);
      lines.push(`      volumeUsd      : ${fmtUsd(r.bestVolumeUsd)}`);
      lines.push(`      gateDecision   : ${r.bestMoveGateDecision ?? 'n/a'}`);
      lines.push(`      ripperScore    : ${r.bestMoveRipperScore != null ? String(r.bestMoveRipperScore) : 'n/a'}`);
      lines.push('');
      lines.push(`    Latest observed:`);
      lines.push(`      priceChangePct : ${fmtPct(r.latestPriceChangePct)}`);
      lines.push(`      liquidityUsd   : ${fmtUsd(r.latestLiquidityUsd)}`);
      lines.push(`      volumeUsd      : ${fmtUsd(r.latestVolumeUsd)}`);
      lines.push('');
      lines.push(`    Engine blockers (from fixture):`);
      if (r.engineBlockers.length === 0) {
        lines.push(`      (none recorded)`);
      } else {
        for (const b of r.engineBlockers) {
          lines.push(`      - ${b}`);
        }
      }
      lines.push('');
      lines.push(`    Derived blocker labels:`);
      for (const b of r.derivedBlockers) {
        lines.push(`      - ${b}`);
      }
      lines.push('');
    }
  }

  lines.push(`  ${SEP2}`);
  lines.push('  BLOCKER LABEL KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  LOW_LIQUIDITY_AT_BEST      liquidityUsd < 30,000 at best-move observation');
  lines.push('  LOW_VOLUME_AT_BEST         volumeUsd < 20,000 at best-move observation');
  lines.push('  PRICE_ALREADY_MOVED_TOO_FAR priceChangePct > 100% at best-move observation');
  lines.push('  HOLDER_RISK                holderRiskHint = RISKY at best-move observation');
  lines.push('  CLUSTER_RISK               clusterRiskHint indicates risk');
  lines.push('  SAFETY_NOT_ENRICHED        no holderRiskHint or clusterRiskHint present');
  lines.push('  UNKNOWN_BLOCKER            no field-derivable blocker found');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Report-only — no real or paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CALL AUTO-PAPER');
  lines.push('  * DO NOT change buy gates, approval logic, or scoring weights.');
  lines.push('  * DO NOT wire into ripper-autopilot.');
  lines.push('');
  lines.push(`  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
