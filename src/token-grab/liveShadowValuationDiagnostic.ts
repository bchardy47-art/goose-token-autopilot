// LIVE-SHADOW VALUATION DIAGNOSTIC
//
// REPORT ONLY  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true  DO_NOT_ENABLE_REAL_TRADING  UNKNOWN ≠ CLEAN
//
// For every OPEN live-shadow position, shows the real entry valuation (field + value), the latest
// matched cycle valuation for the same contract, the computed pnlPct, whether the valuation is
// usable, and — when it is not — the exact missing valuation inputs. Read-only: it never mutates
// state/events, never trades, never touches a wallet/keys, never signs, never swaps.

import {
  DEFAULT_LIVE_SHADOW_STATE_PATH,
  DEFAULT_LIVE_SHADOW_CYCLES_DIR,
  DEFAULT_MAX_SOURCE_AGE_MINUTES,
  loadOrCreateLiveShadowState,
  resolveLiveShadowSource,
  computeRealizedPnl,
  BANKROLL_TIERS,
  VALUATION_FIELDS_CHECKED,
  type ShadowCandidate,
  type LiveShadowPosition,
  type BankrollTier,
} from './liveShadow';

export interface OpenPositionValuation {
  bankroll: BankrollTier;
  contract: string;
  symbol: string | null;
  openedAt: string;
  lane: string;
  entrySourceCycle: string;
  positionSizeUsd: number;
  entryValuationField: string | null;
  entryValuation: number | null;
  matchedInLatestCycle: boolean;
  latestValuationField: string | null;
  latestValuation: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  valuationUsable: boolean;
  valuationStatus: 'OK' | 'VALUATION_UNAVAILABLE';
  missingFields: string[];
}

export interface LiveShadowValuationDiagnosticResult {
  generatedAt: string;
  statePath: string;
  sourceCycle: string;
  sourceFile: string | null;
  sourceAgeMinutes: number | null;
  staleSource: boolean;
  valuationFieldsChecked: string[];
  openPositionCount: number;
  usableCount: number;
  unavailableCount: number;
  positions: OpenPositionValuation[];
  READY_FOR_REAL_TRADING: false;
  LIVE_SHADOW_ONLY: true;
  REAL_TRADING: false;
  NO_WALLET: true;
  NO_SWAP: true;
  NO_SIGNING: true;
  UNKNOWN_NEVER_CLEAN: true;
}

export interface LiveShadowValuationDiagnosticOptions {
  statePath?: string;
  cyclesDir?: string;
  legacyFeedPath?: string;
  maxSourceAgeMinutes?: number;
  generatedAt?: string;
  nowMs?: number;
}

export function runLiveShadowValuationDiagnostic(
  opts: LiveShadowValuationDiagnosticOptions = {},
): LiveShadowValuationDiagnosticResult {
  const statePath = opts.statePath ?? DEFAULT_LIVE_SHADOW_STATE_PATH;
  const nowMs = opts.nowMs ?? Date.now();
  const generatedAt = opts.generatedAt ?? new Date(nowMs).toISOString();

  const state = loadOrCreateLiveShadowState(statePath, generatedAt);
  const resolved = resolveLiveShadowSource({
    cyclesDir: opts.cyclesDir ?? DEFAULT_LIVE_SHADOW_CYCLES_DIR,
    legacyFeedPath: opts.legacyFeedPath,
    maxSourceAgeMinutes: opts.maxSourceAgeMinutes ?? DEFAULT_MAX_SOURCE_AGE_MINUTES,
    statePath, eventsPath: '',   // eventsPath unused by resolveLiveShadowSource
  }, nowMs);

  const byContract = new Map<string, ShadowCandidate>(resolved.candidates.map(c => [c.contract, c]));

  const positions: OpenPositionValuation[] = [];
  // De-dup across tiers is not needed — each tier is an independent bankroll simulation, so a
  // contract can be open on more than one tier. We report each open position row.
  for (const tier of BANKROLL_TIERS) {
    const bs = state.bankrolls[tier];
    for (const pos of bs?.openPositions ?? []) {
      positions.push(describePosition(tier, pos, byContract.get(pos.contract) ?? null));
    }
  }

  const usableCount = positions.filter(p => p.valuationUsable).length;
  return {
    generatedAt, statePath,
    sourceCycle: resolved.sourceCycle, sourceFile: resolved.info.sourceFile,
    sourceAgeMinutes: resolved.info.sourceAgeMinutes, staleSource: resolved.info.staleSource,
    valuationFieldsChecked: [...VALUATION_FIELDS_CHECKED],
    openPositionCount: positions.length,
    usableCount, unavailableCount: positions.length - usableCount,
    positions,
    READY_FOR_REAL_TRADING: false,
    LIVE_SHADOW_ONLY: true, REAL_TRADING: false, NO_WALLET: true, NO_SWAP: true, NO_SIGNING: true,
    UNKNOWN_NEVER_CLEAN: true,
  };
}

function describePosition(
  tier: BankrollTier, pos: LiveShadowPosition, current: ShadowCandidate | null,
): OpenPositionValuation {
  const pnl = computeRealizedPnl(pos, current);
  const missing = [...pnl.missing];
  // If the row is present but carries no valuation field, surface exactly what we looked for.
  if (current != null && current.valuation == null) {
    for (const f of current.valuationChecked ?? VALUATION_FIELDS_CHECKED) {
      if (!missing.includes(f)) missing.push(f);
    }
  }
  return {
    bankroll: tier,
    contract: pos.contract,
    symbol: pos.symbol ?? null,
    openedAt: pos.openedAt,
    lane: pos.lane,
    entrySourceCycle: pos.sourceCycle,
    positionSizeUsd: pos.positionSizeUsd,
    entryValuationField: pos.valuationField ?? null,
    entryValuation: pos.entryValuation ?? null,
    matchedInLatestCycle: current != null,
    latestValuationField: current?.valuationField ?? null,
    latestValuation: current?.valuation ?? null,
    pnlPct: pnl.pnlPct,
    pnlUsd: pnl.pnlUsd,
    valuationUsable: pnl.usable,
    valuationStatus: pnl.status,
    missingFields: pnl.usable ? [] : missing,
  };
}

export function renderLiveShadowValuationDiagnostic(r: LiveShadowValuationDiagnosticResult): string {
  const WIDE = '═'.repeat(74);
  const THIN = '─'.repeat(74);
  const num = (n: number | null, dp = 8): string => (n == null ? '(none)' : n.toFixed(dp));
  const pct = (n: number | null): string => (n == null ? 'VALUATION_UNAVAILABLE' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — LIVE-SHADOW VALUATION DIAGNOSTIC');
  L.push('  REPORT ONLY  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  UNKNOWN ≠ CLEAN');
  L.push(WIDE, '');
  L.push(`  Generated at        : ${r.generatedAt}`);
  L.push(`  State file          : ${r.statePath}`);
  L.push(`  Latest source cycle : ${r.sourceCycle}   (age ${r.sourceAgeMinutes ?? '(unknown)'} min, stale=${r.staleSource})`);
  L.push(`  Valuation fields    : ${r.valuationFieldsChecked.join(', ')}`);
  L.push(`  Open positions      : ${r.openPositionCount}   usable=${r.usableCount}   unavailable=${r.unavailableCount}`);
  L.push('');

  if (r.positions.length === 0) {
    L.push('  (no open live-shadow positions)');
  }
  for (const p of r.positions) {
    const c = p.contract.length > 14 ? p.contract.slice(0, 6) + '..' + p.contract.slice(-4) : p.contract;
    L.push(THIN);
    L.push(`  $${p.bankroll}  ${(p.symbol ?? '-').padEnd(10)} ${c}   lane=${p.lane}`);
    L.push(`     entry  : ${p.entryValuationField ?? '(no field)'}=${num(p.entryValuation)}   (cycle ${p.entrySourceCycle})`);
    L.push(`     latest : ${p.matchedInLatestCycle ? `${p.latestValuationField ?? '(no field)'}=${num(p.latestValuation)}` : 'contract not in latest cycle'}`);
    L.push(`     pnlPct : ${pct(p.pnlPct)}   pnlUsd : ${p.pnlUsd == null ? 'VALUATION_UNAVAILABLE' : (p.pnlUsd >= 0 ? '+' : '') + '$' + p.pnlUsd.toFixed(4)}`);
    L.push(`     usable : ${p.valuationUsable}   status=${p.valuationStatus}` + (p.missingFields.length ? `   missing=[${p.missingFields.join(', ')}]` : ''));
  }
  L.push('');
  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  REPORT_ONLY=true  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false');
  L.push('  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true  UNKNOWN_NEVER_CLEAN=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE, '');
  return L.join('\n');
}

export function renderLiveShadowValuationDiagnosticUsage(): string {
  return `
token:live-shadow-valuation-diagnostic — show real entry vs. latest-cycle valuations and the
computed P/L for every OPEN live-shadow position; flags VALUATION_UNAVAILABLE with exact missing
fields. Report-only, read-only.

Usage:
  npm run token:live-shadow-valuation-diagnostic [options]

Options:
  --cycles-dir <path>            latest ripper cycles dir (default: ${DEFAULT_LIVE_SHADOW_CYCLES_DIR})
  --legacy-feed <path>           LEGACY/DEBUG source instead of fresh cycles
  --max-source-age-minutes <N>   freshness window (default: ${DEFAULT_MAX_SOURCE_AGE_MINUTES})
  --state <path>                 live-shadow state file (default: ${DEFAULT_LIVE_SHADOW_STATE_PATH})
  --json                         emit machine-readable JSON
  --help                         show this message

Safety:
  Report only. Never mutates state/events. READY_FOR_REAL_TRADING=false. UNKNOWN stays UNKNOWN.
`.trim();
}
