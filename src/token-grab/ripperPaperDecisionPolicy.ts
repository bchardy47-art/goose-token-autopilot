import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaperEntryTiming = 'ENTER_NOW' | 'WAIT_10M';
export type PaperIntentStatus = 'PLANNED' | 'ENTRY_DUE' | 'OBSERVED' | 'EXPIRED_NO_DATA';

export type PaperIntentReason =
  | 'DEFAULT_APPROVED_ENTER_NOW'
  | 'HIGH_QUALITY_WAIT10_SUBGROUP';

export interface PaperIntent {
  intentId:          string;
  contract:          string;
  symbol:            string | null;
  approvedAt:        string;
  targetEntryAt:     string;
  paperEntryTiming:  PaperEntryTiming;
  reason:            PaperIntentReason;
  sourceCycle:       string | null;
  clusterRisk:       string;
  ripperScore:       number | null;
  launchAgeBucket:   string | null;
  entryDecision:     string | null;
  entryMomentumPct?: number | null;
  status:            PaperIntentStatus;
  realTradingLocked: true;
  paperOnly:         true;
  tradingExecuted:   0;
}

export interface ApprovedFixtureInput {
  contract:          string;
  symbol:            string | null;
  approvedAt:        string;
  clusterRisk:       string;
  ripperScore:       number | null;
  launchAgeBucket:   string | null;
  entryDecision:     string | null;
  sourceCycle?:      string | null;
  entryMomentumPct?: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WAIT_10M_OFFSET_MS = 10 * 60_000;

// ── High-quality subgroup predicate ──────────────────────────────────────────

export function isHighQualitySubgroup(f: ApprovedFixtureInput): boolean {
  return (
    f.clusterRisk      === 'CLEAN'                 &&
    typeof f.ripperScore === 'number'              &&
    f.ripperScore      >= 100                       &&
    f.launchAgeBucket  === 'PRIME_WINDOW'           &&
    f.entryDecision    === 'READY_TO_SNIPE_PAPER'
  );
}

// ── Intent ID ─────────────────────────────────────────────────────────────────

function makeIntentId(contract: string, targetEntryAt: string, reason: PaperIntentReason): string {
  return crypto
    .createHash('sha256')
    .update(`${contract}::${targetEntryAt}::${reason}`)
    .digest('hex')
    .slice(0, 16);
}

// ── Policy ────────────────────────────────────────────────────────────────────

export function applyPaperDecisionPolicy(fixture: ApprovedFixtureInput): PaperIntent {
  const approvedMs      = Date.parse(fixture.approvedAt);
  const hq              = isHighQualitySubgroup(fixture);
  const timing          = hq ? 'WAIT_10M'   : 'ENTER_NOW';
  const reason          = hq
    ? 'HIGH_QUALITY_WAIT10_SUBGROUP'
    : 'DEFAULT_APPROVED_ENTER_NOW';
  const offsetMs        = hq ? WAIT_10M_OFFSET_MS : 0;
  const targetEntryAt   = new Date(approvedMs + offsetMs).toISOString();
  const intentId        = makeIntentId(fixture.contract, targetEntryAt, reason);

  return {
    intentId,
    contract:          fixture.contract,
    symbol:            fixture.symbol,
    approvedAt:        fixture.approvedAt,
    targetEntryAt,
    paperEntryTiming:  timing,
    reason,
    sourceCycle:       fixture.sourceCycle ?? null,
    clusterRisk:       fixture.clusterRisk,
    ripperScore:       fixture.ripperScore,
    launchAgeBucket:   fixture.launchAgeBucket,
    entryDecision:     fixture.entryDecision,
    entryMomentumPct:  fixture.entryMomentumPct ?? null,
    status:            'PLANNED',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
  };
}

// ── Batch application ─────────────────────────────────────────────────────────

export function applyPolicyToFixtures(
  fixtures: ApprovedFixtureInput[],
): PaperIntent[] {
  return fixtures.map(f => applyPaperDecisionPolicy(f));
}
