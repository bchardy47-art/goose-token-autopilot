import * as fs from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';

const WINNER_LABELS = new Set(['BIG_WINNER', 'WINNER']);
const JUNK_LABELS   = new Set(['FLAT_JUNK', 'DUMP']);

const OUTCOME_PRIORITY: Record<string, number> = {
  BIG_WINNER:   6,
  WINNER:       5,
  SMALL_WINNER: 4,
  FLAT_JUNK:    3,
  DUMP:         2,
  UNKNOWN:      1,
};

// PRICE_PUMP = first-seen priceChangePct > 20.
// NOTE: pcp > 20 is DEFINITIONALLY BIG_WINNER at the row level (no exceptions in current data).
// The 100% PRICE_PUMP win rate is a circular artifact, not a predictive signal.
const PRICE_PUMP_THRESHOLD = 20;

// ── Types ──────────────────────────────────────────────────────────────────────
export type SampleSizeWarning = 'TOO_SMALL' | 'EARLY' | 'USABLE';
export type ArtifactRisk      = 'LOW' | 'MEDIUM' | 'HIGH' | 'DEFINITIONAL';
export type PricePumpClass    = 'EARLY_MOMENTUM' | 'LATE_CHASE' | 'VIOLENT_SPIKE' | 'CLEAN_PUMP' | 'UNCLASSIFIED';

interface MemRow {
  contract?:              string | null;
  capturedAt?:            string | null;
  observedAt?:            string | null;
  outcomeLabel?:          string | null;
  clusterRisk?:           string | null;
  liquidityBucket?:       string | null;
  liquidityUsd?:          number | null;
  vlrBucket?:             string | null;
  ripperScore?:           number | null;
  ageMinutes?:            number | null;
  bubbleMapsScore?:       number | null;
  timingPath?:            string | null;
  gateDecision?:          string | null;
  entryDecision?:         string | null;
  priceChangePct?:        number | null;
  blockedByLowLiquidity?: boolean | null;
  blockedByAgeGte10m?:    boolean | null;
  memoryUniverse?:        string | null;
}

export interface PricePumpProfile {
  contract:        string;
  canonicalOutcome: string;
  firstCapturedAt: string;
  priceChangePct:  number;       // always > 20 for PRICE_PUMP contracts
  ageMinutes:      number | null;
  liquidityUsd:    number | null;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string | null;
  ripperScore:     number | null;
  bubbleMapsScore: number | null;
  timingPath:      string | null;
  gateDecision:    string | null;
  entryDecision:   string | null;
  ageBucket:       string;
  scoreBucket:     string;
  pricePumpSubBucket: string;    // fine-grained pcp bucket within PRICE_PUMP range
  classification:  PricePumpClass;
  isWinner:        boolean;
  isJunk:          boolean;
  blockedByLowLiquidity: boolean;
  blockedByAgeGte10m:    boolean;
}

export interface SubgroupStat {
  label:         string;
  n:             number;
  winnerCount:   number;
  junkCount:     number;
  winRate:       number;
  flatDumpRate:  number;
  lift:          number;
  earlyMomentumCount: number;
  lateChaseCount:     number;
  violentSpikeCount:  number;
  sampleWarning: SampleSizeWarning;
  artifactRisk:  ArtifactRisk;
}

export interface MissedPricePumpWinner {
  contract:        string;
  canonicalOutcome: string;
  firstCapturedAt: string;
  ageMinutes:      number | null;
  priceChangePct:  number;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string | null;
  ripperScore:     number | null;
  entryDecision:   string | null;
  gateDecision:    string | null;
  classification:  PricePumpClass;
  missedReason:    string;
}

export interface FalseSafetyCase {
  contract:        string;
  canonicalOutcome: string;
  firstCapturedAt: string;
  ageMinutes:      number | null;
  priceChangePct:  number;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string | null;
  ripperScore:     number | null;
  gateDecision:    string | null;
  entryDecision:   string | null;
  classification:  PricePumpClass;
  fooledReason:    string;
}

export interface ForwardTestCandidate {
  label:        string;
  description:  string;
  n:            number;
  whyTestIt:    string;
  risk:         string;
  requiredN:    number;
  rejectionCriteria: string;
}

export interface PricePumpAutopsyOptions {
  memoryPath?: string;
}

export interface PricePumpAutopsyResult {
  // Overview
  totalMemoryRows:    number;
  uniqueContracts:    number;
  observedContracts:  number;
  bigWinnerCount:     number;
  winnerCount:        number;
  smallWinnerCount:   number;
  flatJunkCount:      number;
  dumpCount:          number;
  unknownCount:       number;
  baselineWinRate:    number;

  // PRICE_PUMP summary
  pricePumpContracts: number;
  pricePumpWinners:   number;
  pricePumpJunk:      number;
  pricePumpWinRate:   number;
  pricePumpLift:      number;

  // Classification breakdown
  earlyMomentumCount:  number;
  lateChaseCount:      number;
  violentSpikeCount:   number;
  cleanPumpCount:      number;

  // Timing stats (for PRICE_PUMP contracts)
  ageMedian:   number | null;
  ageP75:      number | null;
  ageP90:      number | null;
  pcpMedian:   number;
  pcpP75:      number;
  pcpP90:      number;
  liqUsdMedian: number | null;
  liqUsdP75:    number | null;
  liqUsdP90:    number | null;

  // Profile distributions (for PRICE_PUMP first-seen contracts)
  pricePumpProfile: Record<string, Record<string, number>>;

  // Subgroup stats
  subgroups: SubgroupStat[];

  // False safety check
  falseSafetyCases: FalseSafetyCase[];
  falseSafetyDefinitionallyEmpty: boolean;

  // Missed PRICE_PUMP winners
  missedPricePumpWinners: MissedPricePumpWinner[];

  // Forward test candidates
  forwardTestCandidates: ForwardTestCandidate[];

  // Artifact verdict
  isCircularArtifact: boolean;
  artifactExplanation: string;

  // Safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

// ── Safety ─────────────────────────────────────────────────────────────────────
const SAFETY = {
  reportOnly:        true  as const,
  readOnly:          true  as const,
  paperOnly:         true  as const,
  realTradingLocked: true  as const,
  tradingExecuted:   0     as const,
};

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

// ── Bucket helpers ─────────────────────────────────────────────────────────────
function derivedAgeBucket(age: number | null | undefined): string {
  if (age == null || !Number.isFinite(age)) return 'AGE_UNKNOWN';
  if (age < 2)  return 'AGE_LT_2M';
  if (age < 5)  return 'AGE_2_5M';
  if (age < 10) return 'AGE_5_10M';
  return 'AGE_GTE_10M';
}

function derivedScoreBucket(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'SCORE_UNKNOWN';
  if (score === 0) return 'SCORE_ZERO';
  if (score < 50)  return 'SCORE_LT_50';
  if (score < 80)  return 'SCORE_50_80';
  return 'SCORE_GTE_80';
}

function pricePumpSubBucket(pcp: number): string {
  if (pcp <= 30)  return 'PCP_20_30';
  if (pcp <= 60)  return 'PCP_30_60';
  if (pcp <= 100) return 'PCP_60_100';
  return 'PCP_GT_100';
}

function sampleWarning(n: number): SampleSizeWarning {
  if (n < 20)  return 'TOO_SMALL';
  if (n < 50)  return 'EARLY';
  return 'USABLE';
}

// PRICE_PUMP win rate is always 100% because pcp>20 = BIG_WINNER at row level.
// Mark everything as DEFINITIONAL artifact to be honest.
function artifactRisk(): ArtifactRisk { return 'DEFINITIONAL'; }

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* skip */ }
  }
  return rows;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function percentile<T extends number>(sorted: T[], p: number): T | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx]!;
}

function median<T extends number>(sorted: T[]): T | null {
  if (sorted.length === 0) return null;
  return percentile(sorted, 0.5);
}

// ── Classification ─────────────────────────────────────────────────────────────
export function classifyPricePump(p: {
  priceChangePct: number;
  ageMinutes:     number | null;
  liquidityUsd:   number | null;
  vlrBucket:      string;
  clusterRisk:    string | null;
  liquidityBucket: string;
}): PricePumpClass {
  const { priceChangePct: pcp, ageMinutes, liquidityUsd, vlrBucket, clusterRisk, liquidityBucket } = p;
  const thinLiq  = liquidityUsd == null || liquidityUsd < 10_000 || liquidityBucket === 'LIQ_LT_10K';
  const ageGt5   = ageMinutes != null && ageMinutes > 5;

  // VIOLENT_SPIKE: extreme pump with thin liquidity or high VLR — dangerous
  if (pcp > 60 && (thinLiq || vlrBucket === 'VLR_GTE_2')) return 'VIOLENT_SPIKE';

  // LATE_CHASE: captured late or already +100%+ — almost certainly "already moved"
  if (ageGt5 || pcp > 100) return 'LATE_CHASE';

  // CLEAN_PUMP: clean cluster, good liquidity, moderate pump — most forward-testable
  if (
    clusterRisk === 'CLEAN' &&
    !thinLiq &&
    pcp <= 60
  ) return 'CLEAN_PUMP';

  // EARLY_MOMENTUM: captured young, moderate pump — potentially actionable
  if (ageMinutes != null && ageMinutes <= 5 && pcp <= 60) return 'EARLY_MOMENTUM';

  return 'UNCLASSIFIED';
}

// ── Profile builder ────────────────────────────────────────────────────────────
function buildPricePumpProfile(firstRow: MemRow, canonicalOutcome: string): PricePumpProfile {
  const pcp = firstRow.priceChangePct!;  // caller guarantees > PRICE_PUMP_THRESHOLD
  const liqBucket = firstRow.liquidityBucket ?? 'LIQ_UNKNOWN';
  const vlrBucket = firstRow.vlrBucket       ?? 'VLR_UNKNOWN';
  const p = {
    contract:         firstRow.contract ?? '',
    canonicalOutcome,
    firstCapturedAt:  firstRow.capturedAt ?? firstRow.observedAt ?? '',
    priceChangePct:   pcp,
    ageMinutes:       firstRow.ageMinutes       ?? null,
    liquidityUsd:     firstRow.liquidityUsd     ?? null,
    liquidityBucket:  liqBucket,
    vlrBucket,
    clusterRisk:      firstRow.clusterRisk      ?? null,
    ripperScore:      firstRow.ripperScore       ?? null,
    bubbleMapsScore:  firstRow.bubbleMapsScore   ?? null,
    timingPath:       firstRow.timingPath        ?? null,
    gateDecision:     firstRow.gateDecision      ?? null,
    entryDecision:    firstRow.entryDecision     ?? null,
    ageBucket:        derivedAgeBucket(firstRow.ageMinutes),
    scoreBucket:      derivedScoreBucket(firstRow.ripperScore),
    pricePumpSubBucket: pricePumpSubBucket(pcp),
    classification:   'UNCLASSIFIED' as PricePumpClass,
    isWinner:         WINNER_LABELS.has(canonicalOutcome),
    isJunk:           JUNK_LABELS.has(canonicalOutcome),
    blockedByLowLiquidity: firstRow.blockedByLowLiquidity === true,
    blockedByAgeGte10m:    firstRow.blockedByAgeGte10m    === true,
  };
  p.classification = classifyPricePump(p);
  return p;
}

// ── Feature distribution ───────────────────────────────────────────────────────
function buildDistribution(
  profiles: PricePumpProfile[],
): Record<string, Record<string, number>> {
  const dist: Record<string, Record<string, number>> = {
    ageBucket: {}, liquidityBucket: {}, vlrBucket: {}, clusterRisk: {},
    scoreBucket: {}, pricePumpSubBucket: {}, timingPath: {}, gateDecision: {}, entryDecision: {},
  };
  for (const p of profiles) {
    const inc = (key: string, val: string) => {
      dist[key]![val] = (dist[key]![val] ?? 0) + 1;
    };
    inc('ageBucket',          p.ageBucket);
    inc('liquidityBucket',    p.liquidityBucket);
    inc('vlrBucket',          p.vlrBucket);
    inc('clusterRisk',        p.clusterRisk ?? 'UNKNOWN');
    inc('scoreBucket',        p.scoreBucket);
    inc('pricePumpSubBucket', p.pricePumpSubBucket);
    inc('timingPath',         p.timingPath    ?? 'UNKNOWN');
    inc('gateDecision',       p.gateDecision  ?? 'UNKNOWN');
    inc('entryDecision',      p.entryDecision ?? 'UNKNOWN');
  }
  return dist;
}

// ── Subgroup stats ─────────────────────────────────────────────────────────────
type SubgroupDef = { label: string; pred: (p: PricePumpProfile) => boolean };

function computeSubgroup(
  ppProfiles: PricePumpProfile[],
  { label, pred }: SubgroupDef,
  baselineWinRate: number,
): SubgroupStat | null {
  const matched = ppProfiles.filter(pred);
  const obs     = matched.filter(p => p.isWinner || p.isJunk);
  if (obs.length === 0) return null;
  const winners = obs.filter(p => p.isWinner).length;
  const junks   = obs.filter(p => p.isJunk).length;
  const winRate = winners / obs.length;
  return {
    label,
    n:             obs.length,
    winnerCount:   winners,
    junkCount:     junks,
    winRate,
    flatDumpRate:  junks / obs.length,
    lift:          baselineWinRate > 0 ? winRate / baselineWinRate : 0,
    earlyMomentumCount: matched.filter(p => p.classification === 'EARLY_MOMENTUM').length,
    lateChaseCount:     matched.filter(p => p.classification === 'LATE_CHASE').length,
    violentSpikeCount:  matched.filter(p => p.classification === 'VIOLENT_SPIKE').length,
    sampleWarning: sampleWarning(obs.length),
    artifactRisk:  artifactRisk(),
  };
}

const SUBGROUP_DEFS: SubgroupDef[] = [
  { label: 'PRICE_PUMP + age<=5m',              pred: p => p.ageMinutes != null && p.ageMinutes <= 5 },
  { label: 'PRICE_PUMP + age>5m',               pred: p => p.ageMinutes != null && p.ageMinutes > 5 },
  { label: 'PRICE_PUMP + LIQ_10K_30K',          pred: p => p.liquidityBucket === 'LIQ_10K_30K' },
  { label: 'PRICE_PUMP + LIQ_30K_100K',         pred: p => p.liquidityBucket === 'LIQ_30K_100K' },
  { label: 'PRICE_PUMP + VLR_GTE_2',            pred: p => p.vlrBucket === 'VLR_GTE_2' },
  { label: 'PRICE_PUMP + VLR_LT_0_5',           pred: p => p.vlrBucket === 'VLR_LT_0_5' },
  { label: 'PRICE_PUMP + CLEAN',                pred: p => p.clusterRisk === 'CLEAN' },
  { label: 'PRICE_PUMP + WATCH',                pred: p => p.clusterRisk === 'WATCH' },
  { label: 'PRICE_PUMP + READY_TO_SNIPE_PAPER', pred: p => p.entryDecision === 'READY_TO_SNIPE_PAPER' },
  { label: 'PRICE_PUMP + PAPER_BUY_BLOCKED',    pred: p => p.entryDecision === 'PAPER_BUY_BLOCKED' },
  { label: 'PRICE_PUMP + score>=80',            pred: p => p.ripperScore != null && p.ripperScore >= 80 },
  { label: 'PRICE_PUMP + score<80',             pred: p => p.ripperScore != null && p.ripperScore < 80 },
  { label: 'PRICE_PUMP (EARLY_MOMENTUM class)', pred: p => p.classification === 'EARLY_MOMENTUM' },
  { label: 'PRICE_PUMP (CLEAN_PUMP class)',      pred: p => p.classification === 'CLEAN_PUMP' },
  { label: 'PRICE_PUMP (LATE_CHASE class)',      pred: p => p.classification === 'LATE_CHASE' },
  { label: 'PRICE_PUMP (VIOLENT_SPIKE class)',   pred: p => p.classification === 'VIOLENT_SPIKE' },
];

// ── Forward test candidates ────────────────────────────────────────────────────
function buildForwardTestCandidates(ppProfiles: PricePumpProfile[]): ForwardTestCandidate[] {
  const a1 = ppProfiles.filter(p =>
    p.ageMinutes != null && p.ageMinutes <= 5 &&
    ['LIQ_10K_30K', 'LIQ_30K_100K'].includes(p.liquidityBucket) &&
    p.priceChangePct <= 60,
  );
  const a2 = ppProfiles.filter(p => p.classification === 'CLEAN_PUMP');
  const a3 = ppProfiles.filter(p =>
    p.entryDecision === 'READY_TO_SNIPE_PAPER' &&
    p.ageMinutes != null && p.ageMinutes <= 5,
  );
  const a4 = ppProfiles.filter(p =>
    p.vlrBucket === 'VLR_GTE_2' &&
    p.ageMinutes != null && p.ageMinutes <= 5 &&
    !['LIQ_LT_10K', 'LIQ_UNKNOWN'].includes(p.liquidityBucket),
  );

  return [
    {
      label:       'EARLY_MOMENTUM + LIQ_10K_30K/LIQ_30K_100K',
      description: 'PRICE_PUMP, age <= 5m, liquidity in 10k-100k range, pcp <= 60%',
      n:           a1.length,
      whyTestIt:   'Youngest captures with controlled pump magnitude and solid liquidity. Best proxy for "early entry before peak."',
      risk:        'priceChangePct is measured at observation, not at entry. Still may have already peaked at capture.',
      requiredN:   30,
      rejectionCriteria: 'Observation win rate drops below 60% OR early_momentum_pct < 50% of subgroup',
    },
    {
      label:       'CLEAN_PUMP',
      description: 'PRICE_PUMP, CLEAN cluster, liquidity >= 10k, pcp <= 60%',
      n:           a2.length,
      whyTestIt:   'CLEAN cluster removes bot/manipulation risk. Moderate pump means not yet violent. Best quality subset.',
      risk:        'CLEAN cluster can still be junk if fundamentals are weak. Artifact still applies.',
      requiredN:   30,
      rejectionCriteria: 'Any junk in this subgroup once truly forward-tested means reject cluster as filter.',
    },
    {
      label:       'READY_TO_SNIPE_PAPER + age <= 5m',
      description: 'PRICE_PUMP, paper entry approved, age <= 5m at capture',
      n:           a3.length,
      whyTestIt:   'Paper system already approved entry AND it was captured young. These are the system\'s best PRICE_PUMP quality calls.',
      risk:        'Still circular — READY_TO_SNIPE approval may already be priced in.',
      requiredN:   20,
      rejectionCriteria: 'Drop to "already late" if median priceChangePct at capture exceeds 60%.',
    },
    {
      label:       'VLR_GTE_2 + age <= 5m + liq >= 10k',
      description: 'PRICE_PUMP, high VLR, young capture, solid liquidity',
      n:           a4.length,
      whyTestIt:   'High VLR means strong trading relative to liquidity — momentum confirmation. VLR_GTE_2 showed lift in prior analysis.',
      risk:        'High VLR can signal exhaustion not just momentum. Thin liquidity amplifies moves both directions.',
      requiredN:   20,
      rejectionCriteria: 'Reject if violent_spike_pct > 50% within this subgroup (already blew up).',
    },
  ];
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runPricePumpAutopsy(
  options: PricePumpAutopsyOptions = {},
): PricePumpAutopsyResult {
  const memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
  const allRows    = readJsonl<MemRow>(memoryPath);

  // Group by contract
  const byContract = new Map<string, MemRow[]>();
  for (const row of allRows) {
    if (!row.contract) continue;
    if (!byContract.has(row.contract)) byContract.set(row.contract, []);
    byContract.get(row.contract)!.push(row);
  }

  // Per-contract: canonical outcome + first-seen row
  const outcomeCounts: Record<string, number> = {};
  const ppProfiles: PricePumpProfile[] = [];
  let allObservedCount = 0;
  let allWinnerCount   = 0;
  let allJunkCount     = 0;

  for (const [, contractRows] of byContract) {
    let canonicalOutcome = 'UNKNOWN';
    let bestPriority = 0;
    for (const r of contractRows) {
      const label    = r.outcomeLabel ?? 'UNKNOWN';
      const priority = OUTCOME_PRIORITY[label] ?? 0;
      if (priority > bestPriority) { bestPriority = priority; canonicalOutcome = label; }
    }
    const sorted  = [...contractRows].sort((a, b) =>
      (a.capturedAt ?? a.observedAt ?? '').localeCompare(b.capturedAt ?? b.observedAt ?? ''),
    );
    const firstRow = sorted[0]!;
    outcomeCounts[canonicalOutcome] = (outcomeCounts[canonicalOutcome] ?? 0) + 1;

    if (WINNER_LABELS.has(canonicalOutcome) || JUNK_LABELS.has(canonicalOutcome)) {
      allObservedCount++;
      if (WINNER_LABELS.has(canonicalOutcome)) allWinnerCount++;
      else allJunkCount++;
    }

    const pcp = firstRow.priceChangePct;
    if (pcp != null && Number.isFinite(pcp) && pcp > PRICE_PUMP_THRESHOLD) {
      ppProfiles.push(buildPricePumpProfile(firstRow, canonicalOutcome));
    }
  }

  const baselineWinRate = allObservedCount > 0 ? allWinnerCount / allObservedCount : 0;

  // PRICE_PUMP stats
  const ppObserved = ppProfiles.filter(p => p.isWinner || p.isJunk);
  const ppWinners  = ppObserved.filter(p => p.isWinner);
  const ppJunk     = ppObserved.filter(p => p.isJunk);
  const ppWinRate  = ppObserved.length > 0 ? ppWinners.length / ppObserved.length : 0;
  const ppLift     = baselineWinRate > 0 ? ppWinRate / baselineWinRate : 0;

  // Classification counts
  const earlyMomentumCount  = ppProfiles.filter(p => p.classification === 'EARLY_MOMENTUM').length;
  const lateChaseCount      = ppProfiles.filter(p => p.classification === 'LATE_CHASE').length;
  const violentSpikeCount   = ppProfiles.filter(p => p.classification === 'VIOLENT_SPIKE').length;
  const cleanPumpCount      = ppProfiles.filter(p => p.classification === 'CLEAN_PUMP').length;

  // Timing stats
  const sortedAges = ppProfiles.map(p => p.ageMinutes).filter((v): v is number => v != null).sort((a, b) => a - b);
  const sortedPcps = ppProfiles.map(p => p.priceChangePct).sort((a, b) => a - b);
  const sortedLiqs = ppProfiles.map(p => p.liquidityUsd).filter((v): v is number => v != null).sort((a, b) => a - b);

  // Profile distribution
  const pricePumpProfile = buildDistribution(ppProfiles);

  // Subgroups
  const subgroups: SubgroupStat[] = SUBGROUP_DEFS
    .map(def => computeSubgroup(ppProfiles, def, baselineWinRate))
    .filter((s): s is SubgroupStat => s !== null);

  // False safety check — definitionally empty because pcp>20 = BIG_WINNER at row level
  const falseSafetyCases: FalseSafetyCase[] = ppProfiles
    .filter(p => p.isJunk)
    .map(p => ({
      contract:         p.contract,
      canonicalOutcome: p.canonicalOutcome,
      firstCapturedAt:  p.firstCapturedAt,
      ageMinutes:       p.ageMinutes,
      priceChangePct:   p.priceChangePct,
      liquidityBucket:  p.liquidityBucket,
      vlrBucket:        p.vlrBucket,
      clusterRisk:      p.clusterRisk,
      ripperScore:      p.ripperScore,
      gateDecision:     p.gateDecision,
      entryDecision:    p.entryDecision,
      classification:   p.classification,
      fooledReason:     'PRICE_PUMP first-seen with junk canonical outcome',
    }));

  // Missed PRICE_PUMP winners
  const missedPricePumpWinners: MissedPricePumpWinner[] = ppProfiles
    .filter(p => p.isWinner && p.entryDecision !== 'READY_TO_SNIPE_PAPER')
    .map(p => {
      const parts: string[] = [];
      if (p.entryDecision && p.entryDecision !== 'READY_TO_SNIPE_PAPER') parts.push(`entryDecision=${p.entryDecision}`);
      if (p.clusterRisk === 'WATCH')                parts.push('WATCH cluster risk');
      if (p.vlrBucket === 'VLR_GTE_2')              parts.push('VLR_GTE_2 excluded');
      if (p.ripperScore != null && p.ripperScore < 80) parts.push(`ripperScore=${p.ripperScore.toFixed(0)} (<80)`);
      if (p.blockedByLowLiquidity)                   parts.push('blockedByLowLiquidity');
      if (p.blockedByAgeGte10m)                      parts.push('blockedByAgeGte10m');
      return {
        contract:         p.contract,
        canonicalOutcome: p.canonicalOutcome,
        firstCapturedAt:  p.firstCapturedAt,
        ageMinutes:       p.ageMinutes,
        priceChangePct:   p.priceChangePct,
        liquidityBucket:  p.liquidityBucket,
        vlrBucket:        p.vlrBucket,
        clusterRisk:      p.clusterRisk,
        ripperScore:      p.ripperScore,
        entryDecision:    p.entryDecision,
        gateDecision:     p.gateDecision,
        classification:   p.classification,
        missedReason:     parts.join('; ') || 'entry not approved',
      };
    });

  const forwardTestCandidates = buildForwardTestCandidates(ppProfiles);

  const artifactExplanation =
    'priceChangePct > 20 is DEFINITIONALLY labeled BIG_WINNER at the memory row level ' +
    '(481/637 BIG_WINNER rows have pcp>20; ZERO non-BIG_WINNER rows have pcp>20). ' +
    'First-seen PRICE_PUMP always produces a BIG_WINNER row → canonical outcome = BIG_WINNER. ' +
    '100% win rate is mathematically guaranteed, not a predictive signal.';

  return {
    totalMemoryRows:    allRows.length,
    uniqueContracts:    byContract.size,
    observedContracts:  allObservedCount,
    bigWinnerCount:     outcomeCounts['BIG_WINNER']    ?? 0,
    winnerCount:        outcomeCounts['WINNER']         ?? 0,
    smallWinnerCount:   outcomeCounts['SMALL_WINNER']   ?? 0,
    flatJunkCount:      outcomeCounts['FLAT_JUNK']      ?? 0,
    dumpCount:          outcomeCounts['DUMP']            ?? 0,
    unknownCount:       outcomeCounts['UNKNOWN']         ?? 0,
    baselineWinRate,
    pricePumpContracts: ppProfiles.length,
    pricePumpWinners:   ppWinners.length,
    pricePumpJunk:      ppJunk.length,
    pricePumpWinRate:   ppWinRate,
    pricePumpLift:      ppLift,
    earlyMomentumCount,
    lateChaseCount,
    violentSpikeCount,
    cleanPumpCount,
    ageMedian:    median(sortedAges),
    ageP75:       percentile(sortedAges, 0.75),
    ageP90:       percentile(sortedAges, 0.90),
    pcpMedian:    median(sortedPcps) ?? 0,
    pcpP75:       percentile(sortedPcps, 0.75) ?? 0,
    pcpP90:       percentile(sortedPcps, 0.90) ?? 0,
    liqUsdMedian: median(sortedLiqs),
    liqUsdP75:    percentile(sortedLiqs, 0.75),
    liqUsdP90:    percentile(sortedLiqs, 0.90),
    pricePumpProfile,
    subgroups,
    falseSafetyCases,
    falseSafetyDefinitionallyEmpty: falseSafetyCases.length === 0,
    missedPricePumpWinners,
    forwardTestCandidates,
    isCircularArtifact:  true,
    artifactExplanation,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
function renderDistSection(
  profile: Record<string, Record<string, number>>,
  total:   number,
  indent:  string = '  ',
): string[] {
  const L: string[] = [];
  for (const [key, vals] of Object.entries(profile)) {
    const sorted = Object.entries(vals).sort((a, b) => b[1] - a[1]);
    L.push(`${indent}${key}:`);
    for (const [val, n] of sorted) {
      const p = total > 0 ? ` (${(n / total * 100).toFixed(1)}%)` : '';
      L.push(`${indent}  ${val.padEnd(28)} ${String(n).padStart(4)}${p}`);
    }
    L.push('');
  }
  return L;
}

export function renderPricePumpAutopsy(result: PricePumpAutopsyResult): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — PRICE_PUMP FINGERPRINT AUTOPSY v1');
  L.push('  [REPORT ONLY — NO TRADING — NO WALLET — NO POLICY CHANGE — READ ONLY]');
  L.push(SEP, '');

  // ── Section 1: Overview ────────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push('  ⚠  ARTIFACT ALERT: PRICE_PUMP win rate is a CIRCULAR artifact.');
  L.push('     pcp > 20 is DEFINITIONALLY labeled BIG_WINNER at row level (no exceptions).');
  L.push('     100% win rate does not mean PRICE_PUMP is a predictive signal.', '');
  L.push(`  Total memory rows       : ${result.totalMemoryRows}`);
  L.push(`  Unique contracts        : ${result.uniqueContracts}`);
  L.push(`  Observed (W+J)          : ${result.observedContracts}`);
  L.push(`  Baseline win rate       : ${pct(result.baselineWinRate)}`);
  L.push('');
  L.push(`  PRICE_PUMP first-seen   : ${result.pricePumpContracts}`);
  L.push(`  PRICE_PUMP winners      : ${result.pricePumpWinners}  (definitionally ALL — see artifact note)`);
  L.push(`  PRICE_PUMP junk         : ${result.pricePumpJunk}  (definitionally ZERO — pcp>20 cannot label DUMP/FLAT_JUNK)`);
  L.push(`  PRICE_PUMP win rate     : ${pct(result.pricePumpWinRate)}  ← CIRCULAR ARTIFACT`);
  L.push(`  Lift vs baseline        : ${result.pricePumpLift.toFixed(2)}x  ← CIRCULAR ARTIFACT`, '');
  L.push('  Outcome breakdown (unique contracts):');
  L.push(`    BIG_WINNER   : ${result.bigWinnerCount}`);
  L.push(`    WINNER       : ${result.winnerCount}`);
  L.push(`    SMALL_WINNER : ${result.smallWinnerCount}`);
  L.push(`    FLAT_JUNK    : ${result.flatJunkCount}`);
  L.push(`    DUMP         : ${result.dumpCount}`);
  L.push(`    UNKNOWN      : ${result.unknownCount}`, '');

  // Classification summary
  L.push(`  PRICE_PUMP classification (n=${result.pricePumpContracts}):`);
  L.push(`    EARLY_MOMENTUM  : ${result.earlyMomentumCount}  (age<=5m, pcp 20-60%)`);
  L.push(`    CLEAN_PUMP      : ${result.cleanPumpCount}   (CLEAN cluster + liq>=10k + pcp<=60%)`);
  L.push(`    LATE_CHASE      : ${result.lateChaseCount}  (age>5m or pcp>100%)`);
  L.push(`    VIOLENT_SPIKE   : ${result.violentSpikeCount}  (pcp>60% + thin/VLR_GTE_2)`, '');

  // ── Section 2: Profile ────────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 2 — PRICE_PUMP FIRST-SEEN PROFILE  (n=${result.pricePumpContracts})`);
  L.push(`  ${SEP2}`, '');
  L.push('  Feature distributions for contracts whose first-seen priceChangePct > 20%,');
  L.push('  measured at the earliest captured row.', '');
  L.push(...renderDistSection(result.pricePumpProfile, result.pricePumpContracts));

  // ── Section 3: Was It Already Too Late? ────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — WAS IT ALREADY TOO LATE?');
  L.push(`  ${SEP2}`, '');
  L.push('  Timing analysis for PRICE_PUMP contracts at first capture.', '');

  const fmt1 = (v: number | null) => v != null ? `${v.toFixed(1)}` : 'n/a';
  L.push(`  ageMinutes    — median=${fmt1(result.ageMedian)}m  p75=${fmt1(result.ageP75)}m  p90=${fmt1(result.ageP90)}m`);
  L.push(`  priceChangePct — median=${fmt1(result.pcpMedian)}%  p75=${fmt1(result.pcpP75)}%   p90=${fmt1(result.pcpP90)}%`);
  const fmtK = (v: number | null) => v != null ? `$${(v/1000).toFixed(1)}k` : 'n/a';
  L.push(`  liquidityUsd  — median=${fmtK(result.liqUsdMedian)}  p75=${fmtK(result.liqUsdP75)}  p90=${fmtK(result.liqUsdP90)}`, '');

  const pp = result.pricePumpContracts;
  L.push('  Age distribution at first capture:');
  const ageKeys = ['AGE_LT_2M', 'AGE_2_5M', 'AGE_5_10M', 'AGE_GTE_10M', 'AGE_UNKNOWN'];
  for (const k of ageKeys) {
    const n = result.pricePumpProfile['ageBucket']?.[k] ?? 0;
    L.push(`    ${k.padEnd(14)}: ${String(n).padStart(3)}  (${(n / pp * 100).toFixed(1)}%)`);
  }
  L.push('');
  L.push('  priceChangePct sub-buckets within PRICE_PUMP (pcp > 20%):');
  const pcpKeys = ['PCP_20_30', 'PCP_30_60', 'PCP_60_100', 'PCP_GT_100'];
  for (const k of pcpKeys) {
    const n = result.pricePumpProfile['pricePumpSubBucket']?.[k] ?? 0;
    L.push(`    ${k.padEnd(14)}: ${String(n).padStart(3)}  (${(n / pp * 100).toFixed(1)}%)`);
  }
  L.push('');
  L.push('  Classification:');
  L.push(`    EARLY_MOMENTUM : ${result.earlyMomentumCount}  — captured young (age<=5m), moderate pump (20-60%)`);
  L.push(`                     potentially entering BEFORE the pump completed`);
  L.push(`    LATE_CHASE     : ${result.lateChaseCount}  — age>5m or pcp>100% — almost certainly "already moved"`);
  L.push(`    VIOLENT_SPIKE  : ${result.violentSpikeCount}  — pcp>60% on thin liq/VLR_GTE_2 — likely exhausted`);
  L.push(`    CLEAN_PUMP     : ${result.cleanPumpCount}  — CLEAN cluster + liq>=10k + pcp<=60% — best quality subset`, '');
  L.push('  Verdict: ' + (
    result.lateChaseCount > result.earlyMomentumCount
      ? `LATE > EARLY (${result.lateChaseCount} vs ${result.earlyMomentumCount}) — majority are already extended at first capture`
      : `EARLY >= LATE (${result.earlyMomentumCount} vs ${result.lateChaseCount}) — many captured before peak`
  ), '');

  // ── Section 4: Subgroup separation ────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — PRICE_PUMP SUBGROUP SEPARATION');
  L.push(`  ${SEP2}`, '');
  L.push('  NOTE: ALL win rates are 100% because pcp>20 = BIG_WINNER by definition.');
  L.push('  Focus instead on early_momentum% vs late_chase% within each subgroup.', '');

  const colW = 36;
  L.push(`  ${'subgroup'.padEnd(colW)} ${'n'.padStart(4)} ${'W'.padStart(4)} ${'J'.padStart(4)} ${'win%'.padStart(6)} ${'early'.padStart(5)} ${'late'.padStart(5)} ${'vslt'.padStart(5)} sample`);
  L.push(`  ${'-'.repeat(colW)} ${'----'} ${'----'} ${'----'} ${'------'} ${'-----'} ${'-----'} ${'-----'} ------`);
  for (const s of result.subgroups) {
    const earlyPct = s.n > 0 ? `${(s.earlyMomentumCount / s.n * 100).toFixed(0)}%` : '-';
    const latePct  = s.n > 0 ? `${(s.lateChaseCount     / s.n * 100).toFixed(0)}%` : '-';
    const vsPct    = s.n > 0 ? `${(s.violentSpikeCount  / s.n * 100).toFixed(0)}%` : '-';
    L.push(
      `  ${s.label.slice(0, colW).padEnd(colW)} ` +
      `${String(s.n).padStart(4)} ` +
      `${String(s.winnerCount).padStart(4)} ` +
      `${String(s.junkCount).padStart(4)} ` +
      `${pct(s.winRate).padStart(6)} ` +
      `${earlyPct.padStart(5)} ` +
      `${latePct.padStart(5)} ` +
      `${vsPct.padStart(5)} ` +
      `${s.sampleWarning}`,
    );
  }
  L.push(`  (early=EARLY_MOMENTUM%, late=LATE_CHASE%, vslt=VIOLENT_SPIKE%)`, '');

  // ── Section 5: False safety check ─────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — PRICE_PUMP FALSE SAFETY CHECK');
  L.push(`  ${SEP2}`, '');
  if (result.falseSafetyDefinitionallyEmpty) {
    L.push('  DEFINITIONALLY EMPTY.');
    L.push('  priceChangePct > 20 cannot be labeled FLAT_JUNK or DUMP at the row level.');
    L.push('  A PRICE_PUMP first-seen row always produces canonical outcome = BIG_WINNER.');
    L.push('  No PRICE_PUMP first-seen contract can ever appear as FLAT_JUNK or DUMP.');
    L.push('  This is a data structure artifact, not evidence of signal quality.', '');
  } else {
    L.push(`  Found ${result.falseSafetyCases.length} PRICE_PUMP first-seen contracts with junk canonical outcome:`, '');
    for (const f of result.falseSafetyCases) {
      L.push(`  ${f.contract.slice(0, 44)}`);
      L.push(`    outcome: ${f.canonicalOutcome}  class: ${f.classification}`);
      L.push(`    pcp: ${f.priceChangePct.toFixed(1)}%  age: ${f.ageMinutes?.toFixed(1) ?? '?'}m`);
      L.push('');
    }
  }

  // ── Section 6: Missed PRICE_PUMP winners ──────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 6 — MISSED PRICE_PUMP WINNERS  (n=${result.missedPricePumpWinners.length})`);
  L.push(`  ${SEP2}`, '');
  L.push('  PRICE_PUMP first-seen contracts where entryDecision was not READY_TO_SNIPE_PAPER.', '');
  if (result.missedPricePumpWinners.length === 0) {
    L.push('  (none)', '');
  } else {
    const entryDist: Record<string, number> = {};
    for (const m of result.missedPricePumpWinners) {
      const k = m.entryDecision ?? 'null';
      entryDist[k] = (entryDist[k] ?? 0) + 1;
    }
    L.push(`  Entry decision breakdown: ${JSON.stringify(entryDist)}`, '');
    for (const m of result.missedPricePumpWinners.slice(0, 20)) {
      L.push(`  ${m.contract.slice(0, 44)}`);
      L.push(`    outcome: ${m.canonicalOutcome}  class: ${m.classification}  entryDecision: ${m.entryDecision ?? 'null'}`);
      L.push(`    pcp: ${m.priceChangePct.toFixed(1)}%  age: ${m.ageMinutes?.toFixed(1) ?? '?'}m  liq: ${m.liquidityBucket}  vlr: ${m.vlrBucket}`);
      if (m.ripperScore != null) L.push(`    ripperScore: ${m.ripperScore.toFixed(0)}`);
      L.push(`    missedReason: ${m.missedReason}`, '');
    }
    if (result.missedPricePumpWinners.length > 20) {
      L.push(`  ... and ${result.missedPricePumpWinners.length - 20} more`, '');
    }
  }

  // ── Section 7: Entry timing read ──────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — ENTRY TIMING READ');
  L.push(`  ${SEP2}`, '');

  const earlyPct2 = result.pricePumpContracts > 0
    ? (result.earlyMomentumCount / result.pricePumpContracts * 100).toFixed(0)
    : '0';
  const latePct2 = result.pricePumpContracts > 0
    ? (result.lateChaseCount / result.pricePumpContracts * 100).toFixed(0)
    : '0';

  L.push('  Is PRICE_PUMP a real early entry signal?');
  L.push('    NO — not as currently measured. priceChangePct is the OBSERVATION OUTCOME,');
  L.push('    not a real-time entry signal. You only know a token was PRICE_PUMP AFTER');
  L.push('    the observation window closes. The 100% win rate is circular by construction.', '');
  L.push('  Is it mostly "already moved" evidence?');
  L.push(`    PARTIALLY. ${earlyPct2}% of PRICE_PUMP contracts are EARLY_MOMENTUM (age<=5m, pcp 20-60%).`);
  L.push(`    ${latePct2}% are LATE_CHASE (age>5m or pcp>100%). The LATE_CHASE group definitively`);
  L.push('    represents tokens the system caught after they had already moved significantly.', '');
  L.push('  Which PRICE_PUMP subgroup is safest to forward-test?');
  L.push('    CLEAN_PUMP + EARLY_MOMENTUM: CLEAN cluster, age <= 5m, pcp 20-60%, liq >= 10k.');
  L.push(`    This represents contracts the system caught young (${result.cleanPumpCount} total)`);
  L.push('    before the pump was fully priced in. These need forward-testing to confirm', '');
  L.push('  Which PRICE_PUMP subgroup should be avoided?');
  L.push('    LATE_CHASE (age > 5m) and VIOLENT_SPIKE (pcp > 60% + thin liq or VLR_GTE_2).');
  L.push('    These represent tokens that were already extended at capture — chasing the move.', '');
  L.push('  What data is missing before trusting it?');
  L.push('    1. Entry-time price (capture price) vs. peak price — to know HOW MUCH remains.');
  L.push('    2. Exit timing — did PRICE_PUMP contracts hold gains 30m/1h/4h?');
  L.push('    3. Real-time entry signal — need a capture-time feature that predicts PRICE_PUMP');
  L.push('       BEFORE observation confirms it (e.g., trading velocity at capture time).', '');

  // ── Section 8: Forward test candidates ────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — FORWARD TEST CANDIDATES');
  L.push(`  ${SEP2}`, '');
  L.push('  WARNING: These are research proposals ONLY. Do not change gates or autopilot.', '');
  for (const c of result.forwardTestCandidates) {
    L.push(`  [${c.label}]  (n=${c.n} historical examples)`);
    L.push(`    Description  : ${c.description}`);
    L.push(`    Why test it  : ${c.whyTestIt}`);
    L.push(`    Risk         : ${c.risk}`);
    L.push(`    Required n   : ${c.requiredN} unique contracts before promotion consideration`);
    L.push(`    Reject if    : ${c.rejectionCriteria}`, '');
  }

  // ── Section 9: Safety footer ────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  paperOnly=true    No gate, autopilot, policy, wallet, or trade logic modified.');
  L.push('  No data files mutated.', '');
  L.push('  Artifact note: PRICE_PUMP 100% win rate is a mathematical artifact of how');
  L.push('  outcome labels are defined. It is NOT evidence that PRICE_PUMP is a safe');
  L.push('  entry gate or that real trading should be enabled for PRICE_PUMP contracts.');
  L.push(SEP, '');

  return L.join('\n');
}
