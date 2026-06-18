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

// ── Types ──────────────────────────────────────────────────────────────────────
export type SampleSizeWarning = 'TOO_SMALL' | 'EARLY' | 'USABLE';
export type ArtifactRisk      = 'LOW' | 'MEDIUM' | 'HIGH';
export type FingerprintRec    =
  | 'TEST_FORWARD'
  | 'NEEDS_MORE_DATA'
  | 'LIKELY_ARTIFACT'
  | 'REJECT_JUNK_HEAVY';

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
}

export interface ContractProfile {
  contract:             string;
  outcomeLabel:         string;
  firstCapturedAt:      string;
  clusterRisk:          string | null;
  gateDecision:         string | null;
  entryDecision:        string | null;
  timingPath:           string | null;
  ripperScore:          number | null;
  ageMinutes:           number | null;
  liquidityUsd:         number | null;
  liquidityBucket:      string;
  bubbleMapsScore:      number | null;
  vlrBucket:            string;
  priceChangePct:       number | null;
  ageBucket:            string;
  bmsBucket:            string;
  scoreBucket:          string;
  priceBucket:          string;
  isWinner:             boolean;
  isJunk:               boolean;
  blockedByLowLiquidity: boolean;
  blockedByAgeGte10m:    boolean;
}

export interface FeatureStat {
  featureName:   string;
  featureValue:  string;
  winnerCount:   number;
  junkCount:     number;
  totalObserved: number;
  winRate:       number;
  flatDumpRate:  number;
  lift:          number;
  sampleWarning: SampleSizeWarning;
}

export interface FingerprintResult {
  description:     string;
  features:        Record<string, string>;
  uniqueContracts: number;
  winnerCount:     number;
  junkCount:       number;
  winRate:         number;
  flatDumpRate:    number;
  lift:            number;
  artifactRisk:    ArtifactRisk;
  recommendation:  FingerprintRec;
  sampleWarning:   SampleSizeWarning;
}

export interface FalseReject {
  contract:        string;
  outcomeLabel:    string;
  firstCapturedAt: string;
  gateDecision:    string | null;
  entryDecision:   string | null;
  clusterRisk:     string | null;
  liquidityBucket: string;
  vlrBucket:       string;
  bubbleMapsScore: number | null;
  ripperScore:     number | null;
  priceChangePct:  number | null;
  missedReason:    string;
}

export interface FalseApprove {
  contract:        string;
  outcomeLabel:    string;
  firstCapturedAt: string;
  gateDecision:    string | null;
  entryDecision:   string | null;
  clusterRisk:     string | null;
  liquidityBucket: string;
  vlrBucket:       string;
  bubbleMapsScore: number | null;
  ripperScore:     number | null;
  priceChangePct:  number | null;
  fooledReason:    string;
}

export interface EarlyFingerprintReportOptions {
  memoryPath?: string;
}

export interface EarlyFingerprintReportResult {
  totalMemoryRows:   number;
  uniqueContracts:   number;
  observedContracts: number;
  bigWinnerCount:    number;
  winnerCount:       number;
  smallWinnerCount:  number;
  flatJunkCount:     number;
  dumpCount:         number;
  unknownCount:      number;
  baselineWinRate:   number;
  winnerProfile:     Record<string, Record<string, number>>;
  junkProfile:       Record<string, Record<string, number>>;
  featureStats:      FeatureStat[];
  falseRejectWinners: FalseReject[];
  falseApproveJunks:  FalseApprove[];
  fingerprints:      FingerprintResult[];
  trustRules:        string[];
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

// ── Separators ─────────────────────────────────────────────────────────────────
const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

// ── Bucket helpers ─────────────────────────────────────────────────────────────
function derivedAgeBucket(ageMinutes: number | null | undefined): string {
  if (ageMinutes == null || !Number.isFinite(ageMinutes)) return 'AGE_UNKNOWN';
  if (ageMinutes < 2)  return 'AGE_LT_2M';
  if (ageMinutes < 5)  return 'AGE_2_5M';
  if (ageMinutes < 10) return 'AGE_5_10M';
  return 'AGE_GTE_10M';
}

function derivedBmsBucket(bms: number | null | undefined): string {
  if (bms == null || !Number.isFinite(bms)) return 'BMS_UNKNOWN';
  if (bms < 30) return 'BMS_LT_30';
  if (bms < 50) return 'BMS_30_50';
  if (bms < 70) return 'BMS_50_70';
  return 'BMS_GTE_70';
}

function derivedScoreBucket(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'SCORE_UNKNOWN';
  if (score === 0) return 'SCORE_ZERO';
  if (score < 50)  return 'SCORE_LT_50';
  if (score < 80)  return 'SCORE_50_80';
  return 'SCORE_GTE_80';
}

function derivedPriceBucket(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'PRICE_UNKNOWN';
  if (pct <= -20) return 'PRICE_DUMP';
  if (pct <= -5)  return 'PRICE_DOWN';
  if (pct <= 5)   return 'PRICE_FLAT';
  if (pct <= 20)  return 'PRICE_UP';
  return 'PRICE_PUMP';
}

export function sampleWarning(n: number): SampleSizeWarning {
  if (n < 20)  return 'TOO_SMALL';
  if (n < 50)  return 'EARLY';
  return 'USABLE';
}

export function computeArtifactRisk(n: number, lift: number): ArtifactRisk {
  if (n < 20)             return 'HIGH';
  if (n < 50 || lift > 5) return 'MEDIUM';
  return 'LOW';
}

export function computeFingerprintRec(
  n: number,
  winRate: number,
  flatDumpRate: number,
  lift: number,
): FingerprintRec {
  if (n < 20)              return 'NEEDS_MORE_DATA';
  if (flatDumpRate > 0.60) return 'REJECT_JUNK_HEAVY';
  if (lift > 5 && n < 50)  return 'LIKELY_ARTIFACT';
  if (winRate > 0.30 && lift >= 1.3) return 'TEST_FORWARD';
  return 'NEEDS_MORE_DATA';
}

// ── I/O helpers ────────────────────────────────────────────────────────────────
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

// ── Profile building ───────────────────────────────────────────────────────────
function buildProfile(firstRow: MemRow, outcomeLabel: string): ContractProfile {
  const liquidityBucket = firstRow.liquidityBucket ?? 'LIQ_UNKNOWN';
  const vlrBucket       = firstRow.vlrBucket       ?? 'VLR_UNKNOWN';
  return {
    contract:        firstRow.contract ?? '',
    outcomeLabel,
    firstCapturedAt: firstRow.capturedAt ?? firstRow.observedAt ?? '',
    clusterRisk:     firstRow.clusterRisk  ?? null,
    gateDecision:    firstRow.gateDecision ?? null,
    entryDecision:   firstRow.entryDecision ?? null,
    timingPath:      firstRow.timingPath   ?? null,
    ripperScore:     firstRow.ripperScore  ?? null,
    ageMinutes:      firstRow.ageMinutes   ?? null,
    liquidityUsd:    firstRow.liquidityUsd ?? null,
    liquidityBucket,
    bubbleMapsScore: firstRow.bubbleMapsScore ?? null,
    vlrBucket,
    priceChangePct:  firstRow.priceChangePct ?? null,
    ageBucket:       derivedAgeBucket(firstRow.ageMinutes),
    bmsBucket:       derivedBmsBucket(firstRow.bubbleMapsScore),
    scoreBucket:     derivedScoreBucket(firstRow.ripperScore),
    priceBucket:     derivedPriceBucket(firstRow.priceChangePct),
    isWinner:        WINNER_LABELS.has(outcomeLabel),
    isJunk:          JUNK_LABELS.has(outcomeLabel),
    blockedByLowLiquidity: firstRow.blockedByLowLiquidity === true,
    blockedByAgeGte10m:    firstRow.blockedByAgeGte10m    === true,
  };
}

function getProfileFeature(p: ContractProfile, key: string): string {
  switch (key) {
    case 'liquidityBucket': return p.liquidityBucket;
    case 'vlrBucket':       return p.vlrBucket;
    case 'clusterRisk':     return p.clusterRisk  ?? 'UNKNOWN';
    case 'ageBucket':       return p.ageBucket;
    case 'bmsBucket':       return p.bmsBucket;
    case 'scoreBucket':     return p.scoreBucket;
    case 'priceBucket':     return p.priceBucket;
    case 'timingPath':      return p.timingPath    ?? 'UNKNOWN';
    case 'gateDecision':    return p.gateDecision  ?? 'UNKNOWN';
    case 'entryDecision':   return p.entryDecision ?? 'UNKNOWN';
    default: return 'UNKNOWN';
  }
}

// ── Feature distribution ───────────────────────────────────────────────────────
const FEATURE_KEYS = [
  'liquidityBucket',
  'vlrBucket',
  'clusterRisk',
  'ageBucket',
  'bmsBucket',
  'scoreBucket',
  'priceBucket',
  'timingPath',
  'gateDecision',
  'entryDecision',
] as const;

function buildFeatureDistribution(
  profiles: ContractProfile[],
): Record<string, Record<string, number>> {
  const dist: Record<string, Record<string, number>> = {};
  for (const key of FEATURE_KEYS) dist[key] = {};
  for (const p of profiles) {
    for (const key of FEATURE_KEYS) {
      const val = getProfileFeature(p, key);
      dist[key]![val] = (dist[key]![val] ?? 0) + 1;
    }
  }
  return dist;
}

// ── Feature separation ─────────────────────────────────────────────────────────
function computeFeatureStats(
  observedProfiles: ContractProfile[],
  baselineWinRate:  number,
): FeatureStat[] {
  const stats: FeatureStat[] = [];

  for (const key of FEATURE_KEYS) {
    const byValue = new Map<string, { winners: number; junks: number }>();
    for (const p of observedProfiles) {
      const val = getProfileFeature(p, key);
      if (!byValue.has(val)) byValue.set(val, { winners: 0, junks: 0 });
      const entry = byValue.get(val)!;
      if (p.isWinner) entry.winners++;
      if (p.isJunk)   entry.junks++;
    }
    for (const [featureValue, { winners, junks }] of byValue) {
      const total = winners + junks;
      if (total === 0) continue;
      const winRate      = winners / total;
      const flatDumpRate = junks   / total;
      const lift = baselineWinRate > 0 ? winRate / baselineWinRate : 0;
      stats.push({
        featureName: key,
        featureValue,
        winnerCount:   winners,
        junkCount:     junks,
        totalObserved: total,
        winRate,
        flatDumpRate,
        lift,
        sampleWarning: sampleWarning(total),
      });
    }
  }

  return stats.sort((a, b) => b.lift - a.lift || b.totalObserved - a.totalObserved);
}

// ── Fingerprint candidates ─────────────────────────────────────────────────────
const FINGERPRINT_CANDIDATES: Array<{ desc: string; features: Record<string, string> }> = [
  { desc: 'LIQ_10K_30K + CLEAN',                 features: { liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'CLEAN' } },
  { desc: 'LIQ_10K_30K + WATCH',                 features: { liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'WATCH' } },
  { desc: 'LIQ_10K_30K + READY_TO_SNIPE_PAPER',  features: { liquidityBucket: 'LIQ_10K_30K', entryDecision: 'READY_TO_SNIPE_PAPER' } },
  { desc: 'LIQ_10K_30K + VLR_LT_0_5',           features: { liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5' } },
  { desc: 'LIQ_10K_30K + VLR_GTE_2',            features: { liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' } },
  { desc: 'CLEAN + READY_TO_SNIPE_PAPER',         features: { clusterRisk: 'CLEAN', entryDecision: 'READY_TO_SNIPE_PAPER' } },
  { desc: 'WATCH + READY_TO_SNIPE_PAPER',         features: { clusterRisk: 'WATCH', entryDecision: 'READY_TO_SNIPE_PAPER' } },
  { desc: 'CLEAN + VLR_LT_0_5',                  features: { clusterRisk: 'CLEAN', vlrBucket: 'VLR_LT_0_5' } },
  { desc: 'CLEAN + SCORE_GTE_80',                 features: { clusterRisk: 'CLEAN', scoreBucket: 'SCORE_GTE_80' } },
  { desc: 'WATCH + SCORE_GTE_80',                 features: { clusterRisk: 'WATCH', scoreBucket: 'SCORE_GTE_80' } },
  { desc: 'SCORE_GTE_80 + READY_TO_SNIPE_PAPER', features: { scoreBucket: 'SCORE_GTE_80', entryDecision: 'READY_TO_SNIPE_PAPER' } },
  { desc: 'AGE_2_5M + SCORE_GTE_80',             features: { ageBucket: 'AGE_2_5M', scoreBucket: 'SCORE_GTE_80' } },
  { desc: 'ENTER_NOW + READY_TO_SNIPE_PAPER',     features: { timingPath: 'ENTER_NOW', entryDecision: 'READY_TO_SNIPE_PAPER' } },
  { desc: 'VLR_GTE_2 (junk signal)',              features: { vlrBucket: 'VLR_GTE_2' } },
  { desc: 'SCORE_ZERO (no signal)',               features: { scoreBucket: 'SCORE_ZERO' } },
  { desc: 'LIQ_10K_30K + CLEAN + SCORE_GTE_80',  features: { liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'CLEAN', scoreBucket: 'SCORE_GTE_80' } },
  { desc: 'WATCH + LIQ_10K_30K + SCORE_GTE_80',  features: { clusterRisk: 'WATCH', liquidityBucket: 'LIQ_10K_30K', scoreBucket: 'SCORE_GTE_80' } },
  { desc: 'AGE_LT_2M + READY_TO_SNIPE_PAPER',    features: { ageBucket: 'AGE_LT_2M', entryDecision: 'READY_TO_SNIPE_PAPER' } },
];

function computeFingerprints(
  observedProfiles: ContractProfile[],
  baselineWinRate:  number,
): FingerprintResult[] {
  const results: FingerprintResult[] = [];
  for (const { desc, features } of FINGERPRINT_CANDIDATES) {
    const matched = observedProfiles.filter(p =>
      Object.entries(features).every(([k, v]) => getProfileFeature(p, k) === v),
    );
    const winners = matched.filter(p => p.isWinner).length;
    const junks   = matched.filter(p => p.isJunk).length;
    const total   = winners + junks;
    if (total === 0) continue;
    const winRate      = winners / total;
    const flatDumpRate = junks   / total;
    const lift         = baselineWinRate > 0 ? winRate / baselineWinRate : 0;
    results.push({
      description:     desc,
      features,
      uniqueContracts: matched.length,
      winnerCount:     winners,
      junkCount:       junks,
      winRate,
      flatDumpRate,
      lift,
      artifactRisk:   computeArtifactRisk(total, lift),
      recommendation: computeFingerprintRec(total, winRate, flatDumpRate, lift),
      sampleWarning:  sampleWarning(total),
    });
  }
  return results.sort((a, b) => b.lift - a.lift);
}

// ── False reject / approve ─────────────────────────────────────────────────────
function deriveMissedReason(p: ContractProfile): string {
  const parts: string[] = [];
  if (p.entryDecision && p.entryDecision !== 'READY_TO_SNIPE_PAPER') {
    parts.push(`entryDecision=${p.entryDecision}`);
  }
  if (p.clusterRisk === 'WATCH') parts.push('WATCH cluster risk');
  if (p.vlrBucket === 'VLR_GTE_2') parts.push('VLR_GTE_2 excluded');
  if (p.ripperScore != null && p.ripperScore < 80) parts.push(`ripperScore=${p.ripperScore.toFixed(0)} (below 80)`);
  if (p.blockedByLowLiquidity) parts.push('blockedByLowLiquidity');
  if (p.blockedByAgeGte10m)    parts.push('blockedByAgeGte10m');
  return parts.join('; ') || 'entry not approved (reason unclear)';
}

function deriveFooledReason(p: ContractProfile): string {
  const parts: string[] = [];
  if (p.entryDecision === 'READY_TO_SNIPE_PAPER') parts.push('paper entry approved');
  if (p.clusterRisk === 'CLEAN') parts.push('cluster=CLEAN');
  if (p.ripperScore != null && p.ripperScore >= 80) parts.push(`ripperScore=${p.ripperScore.toFixed(0)} (high)`);
  if (p.vlrBucket === 'VLR_LT_0_5') parts.push('low VLR appeared safe');
  if (p.vlrBucket === 'VLR_GTE_2')  parts.push('high VLR — should have been excluded');
  if (p.priceChangePct != null && p.priceChangePct > 20) parts.push(`initial pump +${p.priceChangePct.toFixed(1)}%`);
  return parts.join('; ') || 'appeared normal on entry';
}

// ── Trust rules ────────────────────────────────────────────────────────────────
function deriveTrustRules(
  featureStats:    FeatureStat[],
  baselineWinRate: number,
): string[] {
  const rules: string[] = [];

  const highLift = featureStats.filter(
    s => s.lift >= 1.4 && s.totalObserved >= 20 && s.winRate > baselineWinRate,
  );
  for (const s of highLift.slice(0, 4)) {
    rules.push(
      `Trust cautiously: ${s.featureName}=${s.featureValue}` +
      ` — win5=${pct(s.winRate)}, lift=${s.lift.toFixed(1)}x, n=${s.totalObserved} (${s.sampleWarning})`,
    );
  }

  const junkHeavy = featureStats.filter(s => s.flatDumpRate > 0.65 && s.totalObserved >= 10);
  for (const s of junkHeavy.slice(0, 4)) {
    rules.push(
      `Distrust: ${s.featureName}=${s.featureValue}` +
      ` — flatDump=${pct(s.flatDumpRate)}, n=${s.totalObserved} (${s.sampleWarning})`,
    );
  }

  const tinyHighLift = featureStats.filter(
    s => s.sampleWarning === 'TOO_SMALL' && s.lift > 1.8,
  );
  if (tinyHighLift.length > 0) {
    const examples = tinyHighLift.slice(0, 3).map(s => `${s.featureName}=${s.featureValue}`).join(', ');
    rules.push(`Needs enrichment: ${examples} — lift appears high but n<20 each`);
  }

  rules.push(
    `Baseline win rate: ${pct(baselineWinRate)} — any fingerprint must beat this to be useful`,
  );

  return rules;
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runEarlyFingerprintReport(
  options: EarlyFingerprintReportOptions = {},
): EarlyFingerprintReportResult {
  const memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
  const allRows    = readJsonl<MemRow>(memoryPath);

  // Group rows by contract
  const byContract = new Map<string, MemRow[]>();
  for (const row of allRows) {
    if (!row.contract) continue;
    if (!byContract.has(row.contract)) byContract.set(row.contract, []);
    byContract.get(row.contract)!.push(row);
  }

  // Per-contract: canonical outcome (best priority) + first-seen row (earliest capturedAt)
  const outcomeCounts: Record<string, number> = {};
  const profiles: ContractProfile[] = [];

  for (const [, contractRows] of byContract) {
    let canonicalOutcome = 'UNKNOWN';
    let bestPriority = 0;
    for (const r of contractRows) {
      const label    = r.outcomeLabel ?? 'UNKNOWN';
      const priority = OUTCOME_PRIORITY[label] ?? 0;
      if (priority > bestPriority) { bestPriority = priority; canonicalOutcome = label; }
    }

    const sorted = [...contractRows].sort((a, b) => {
      const ta = a.capturedAt ?? a.observedAt ?? '';
      const tb = b.capturedAt ?? b.observedAt ?? '';
      return ta.localeCompare(tb);
    });

    outcomeCounts[canonicalOutcome] = (outcomeCounts[canonicalOutcome] ?? 0) + 1;
    profiles.push(buildProfile(sorted[0]!, canonicalOutcome));
  }

  // Observed = winners + junks (excludes SMALL_WINNER and UNKNOWN from lift analysis)
  const observedProfiles = profiles.filter(p => p.isWinner || p.isJunk);
  const winnerProfiles   = observedProfiles.filter(p => p.isWinner);
  const junkProfiles     = observedProfiles.filter(p => p.isJunk);
  const baselineWinRate  = observedProfiles.length > 0
    ? winnerProfiles.length / observedProfiles.length
    : 0;

  const winnerProfile = buildFeatureDistribution(winnerProfiles);
  const junkProfile   = buildFeatureDistribution(junkProfiles);
  const featureStats  = computeFeatureStats(observedProfiles, baselineWinRate);

  // False rejects: winners where first-seen entryDecision was not approved
  const falseRejectWinners: FalseReject[] = winnerProfiles
    .filter(p => p.entryDecision !== 'READY_TO_SNIPE_PAPER')
    .map(p => ({
      contract:        p.contract,
      outcomeLabel:    p.outcomeLabel,
      firstCapturedAt: p.firstCapturedAt,
      gateDecision:    p.gateDecision,
      entryDecision:   p.entryDecision,
      clusterRisk:     p.clusterRisk,
      liquidityBucket: p.liquidityBucket,
      vlrBucket:       p.vlrBucket,
      bubbleMapsScore: p.bubbleMapsScore,
      ripperScore:     p.ripperScore,
      priceChangePct:  p.priceChangePct,
      missedReason:    deriveMissedReason(p),
    }));

  // False approves: junks where first-seen entryDecision was approved
  const falseApproveJunks: FalseApprove[] = junkProfiles
    .filter(p => p.entryDecision === 'READY_TO_SNIPE_PAPER')
    .map(p => ({
      contract:        p.contract,
      outcomeLabel:    p.outcomeLabel,
      firstCapturedAt: p.firstCapturedAt,
      gateDecision:    p.gateDecision,
      entryDecision:   p.entryDecision,
      clusterRisk:     p.clusterRisk,
      liquidityBucket: p.liquidityBucket,
      vlrBucket:       p.vlrBucket,
      bubbleMapsScore: p.bubbleMapsScore,
      ripperScore:     p.ripperScore,
      priceChangePct:  p.priceChangePct,
      fooledReason:    deriveFooledReason(p),
    }));

  const fingerprints = computeFingerprints(observedProfiles, baselineWinRate);
  const trustRules   = deriveTrustRules(featureStats, baselineWinRate);

  return {
    totalMemoryRows:    allRows.length,
    uniqueContracts:    byContract.size,
    observedContracts:  observedProfiles.length,
    bigWinnerCount:     outcomeCounts['BIG_WINNER']    ?? 0,
    winnerCount:        outcomeCounts['WINNER']         ?? 0,
    smallWinnerCount:   outcomeCounts['SMALL_WINNER']   ?? 0,
    flatJunkCount:      outcomeCounts['FLAT_JUNK']      ?? 0,
    dumpCount:          outcomeCounts['DUMP']            ?? 0,
    unknownCount:       outcomeCounts['UNKNOWN']         ?? 0,
    baselineWinRate,
    winnerProfile,
    junkProfile,
    featureStats,
    falseRejectWinners,
    falseApproveJunks,
    fingerprints,
    trustRules,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
function renderProfileTable(
  profile: Record<string, Record<string, number>>,
  totalProfiles: number,
): string[] {
  const L: string[] = [];
  for (const [feature, valueCounts] of Object.entries(profile)) {
    const sorted = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]);
    L.push(`  ${feature}:`);
    for (const [val, n] of sorted) {
      const p = totalProfiles > 0 ? ` (${(n / totalProfiles * 100).toFixed(1)}%)` : '';
      L.push(`    ${val.padEnd(28)} ${String(n).padStart(4)}${p}`);
    }
    L.push('');
  }
  return L;
}

export function renderEarlyFingerprintReport(
  result: EarlyFingerprintReportResult,
): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — HISTORICAL EARLY FINGERPRINT REPORT v1');
  L.push('  [REPORT ONLY — NO TRADING — NO WALLET — NO POLICY CHANGE — READ ONLY]');
  L.push(SEP, '');

  // ── Section 1: Overview ──────────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Memory path          : data/token-grab/ripper/learning-memory.jsonl`);
  L.push(`  Total memory rows    : ${result.totalMemoryRows}`);
  L.push(`  Unique contracts     : ${result.uniqueContracts}`);
  L.push(`  Observed (W+J only)  : ${result.observedContracts}  (excludes UNKNOWN + SMALL_WINNER)`);
  L.push('');
  L.push('  Canonical outcome breakdown (unique contracts):');
  L.push(`    BIG_WINNER   : ${result.bigWinnerCount}`);
  L.push(`    WINNER       : ${result.winnerCount}`);
  L.push(`    SMALL_WINNER : ${result.smallWinnerCount}`);
  L.push(`    FLAT_JUNK    : ${result.flatJunkCount}`);
  L.push(`    DUMP         : ${result.dumpCount}`);
  L.push(`    UNKNOWN      : ${result.unknownCount}`);
  L.push('');
  const totalWinners = result.bigWinnerCount + result.winnerCount;
  const totalJunks   = result.flatJunkCount  + result.dumpCount;
  L.push(`  Winners (BIG+WIN)    : ${totalWinners}  Junks (FLAT+DUMP): ${totalJunks}`);
  L.push(`  Baseline win rate    : ${pct(result.baselineWinRate)}  (among observed W+J unique contracts)`);
  L.push('');

  // ── Section 2: Winner profile ────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 2 — FIRST-SEEN WINNER PROFILE  (n=${totalWinners} unique contracts)`);
  L.push(`  ${SEP2}`, '');
  L.push('  Feature distributions for contracts that became BIG_WINNER or WINNER,');
  L.push('  measured at their earliest captured row.', '');
  L.push(...renderProfileTable(result.winnerProfile, totalWinners));

  // ── Section 3: Junk/Dump profile ─────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 3 — FIRST-SEEN JUNK/DUMP PROFILE  (n=${totalJunks} unique contracts)`);
  L.push(`  ${SEP2}`, '');
  L.push('  Feature distributions for contracts that became FLAT_JUNK or DUMP,');
  L.push('  measured at their earliest captured row.', '');
  L.push(...renderProfileTable(result.junkProfile, totalJunks));

  // ── Section 4: Feature separation ────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — FEATURE SEPARATION TABLE');
  L.push(`  ${SEP2}`, '');
  L.push('  Sorted by lift vs baseline. W=winners, J=junks, n=W+J among observed contracts.');
  L.push(`  Baseline win rate: ${pct(result.baselineWinRate)}`, '');

  const displayStats = result.featureStats.filter(s => s.totalObserved >= 5).slice(0, 30);
  const colW = 30;
  L.push(
    `  ${'feature=value'.padEnd(colW)} ${'win%'.padStart(6)} ${'junk%'.padStart(6)} ${'lift'.padStart(5)} ${'W'.padStart(4)} ${'J'.padStart(4)} ${'n'.padStart(4)} sample`,
  );
  L.push(`  ${'-'.repeat(colW)} ${'------'} ${'------'} ${'-----'} ${'----'} ${'----'} ${'----'} ------`);
  for (const s of displayStats) {
    const label = `${s.featureName}=${s.featureValue}`;
    L.push(
      `  ${label.slice(0, colW).padEnd(colW)} ` +
      `${pct(s.winRate).padStart(6)} ` +
      `${pct(s.flatDumpRate).padStart(6)} ` +
      `${s.lift.toFixed(2).padStart(5)}x ` +
      `${String(s.winnerCount).padStart(4)} ` +
      `${String(s.junkCount).padStart(4)} ` +
      `${String(s.totalObserved).padStart(4)} ` +
      `${s.sampleWarning}`,
    );
  }
  L.push('');

  // ── Section 5: False reject winners ─────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 5 — FALSE REJECT WINNERS  (n=${result.falseRejectWinners.length})`);
  L.push(`  ${SEP2}`, '');
  L.push('  Winners where first-seen entryDecision was not READY_TO_SNIPE_PAPER.');
  L.push('  These tokens eventually won but the system missed them early.', '');

  if (result.falseRejectWinners.length === 0) {
    L.push('  (none — all winners had READY_TO_SNIPE_PAPER on first-seen row)', '');
  } else {
    for (const f of result.falseRejectWinners.slice(0, 20)) {
      L.push(`  ${f.contract.slice(0, 44)}`);
      L.push(`    outcome       : ${f.outcomeLabel}`);
      L.push(`    firstSeenAt   : ${f.firstCapturedAt}`);
      L.push(`    entryDecision : ${f.entryDecision ?? 'null'}`);
      L.push(`    clusterRisk   : ${f.clusterRisk ?? 'null'}`);
      L.push(`    liqBucket     : ${f.liquidityBucket}   vlrBucket: ${f.vlrBucket}`);
      if (f.ripperScore != null) L.push(`    ripperScore   : ${f.ripperScore.toFixed(0)}`);
      if (f.priceChangePct != null) L.push(`    priceChg      : ${f.priceChangePct.toFixed(2)}%`);
      L.push(`    missedReason  : ${f.missedReason}`, '');
    }
    if (result.falseRejectWinners.length > 20) {
      L.push(`  ... and ${result.falseRejectWinners.length - 20} more`, '');
    }
  }

  // ── Section 6: False approve junk ────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 6 — FALSE APPROVE JUNK  (n=${result.falseApproveJunks.length})`);
  L.push(`  ${SEP2}`, '');
  L.push('  Junk/Dump contracts where first-seen entryDecision was READY_TO_SNIPE_PAPER.');
  L.push('  These tokens were approved early but became junk.', '');

  if (result.falseApproveJunks.length === 0) {
    L.push('  (none)', '');
  } else {
    for (const f of result.falseApproveJunks.slice(0, 20)) {
      L.push(`  ${f.contract.slice(0, 44)}`);
      L.push(`    outcome       : ${f.outcomeLabel}`);
      L.push(`    firstSeenAt   : ${f.firstCapturedAt}`);
      L.push(`    clusterRisk   : ${f.clusterRisk ?? 'null'}`);
      L.push(`    liqBucket     : ${f.liquidityBucket}   vlrBucket: ${f.vlrBucket}`);
      if (f.ripperScore != null) L.push(`    ripperScore   : ${f.ripperScore.toFixed(0)}`);
      if (f.priceChangePct != null) L.push(`    priceChg      : ${f.priceChangePct.toFixed(2)}%`);
      L.push(`    fooledReason  : ${f.fooledReason}`, '');
    }
    if (result.falseApproveJunks.length > 20) {
      L.push(`  ... and ${result.falseApproveJunks.length - 20} more`, '');
    }
  }

  // ── Section 7: Fingerprint candidates ────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — EARLY FINGERPRINT CANDIDATES');
  L.push(`  ${SEP2}`, '');
  L.push('  Multi-feature combinations evaluated against observed unique contracts.');
  L.push(`  Baseline: ${pct(result.baselineWinRate)} win rate. Sorted by lift.`, '');

  if (result.fingerprints.length === 0) {
    L.push('  (no fingerprints had sufficient data)', '');
  } else {
    for (const fp of result.fingerprints) {
      const warn = fp.sampleWarning !== 'USABLE' ? ` ⚠ ${fp.sampleWarning}` : '';
      L.push(`  [${fp.recommendation}]${warn}`);
      L.push(`  ${fp.description}`);
      L.push(`    n=${fp.uniqueContracts}  W=${fp.winnerCount}  J=${fp.junkCount}  win=${pct(fp.winRate)}  flatDump=${pct(fp.flatDumpRate)}  lift=${fp.lift.toFixed(2)}x  artifact=${fp.artifactRisk}`);
      L.push('');
    }
  }

  // ── Section 8: Trust rules ────────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — FRESH PAIR TRUST RULES');
  L.push(`  ${SEP2}`, '');
  L.push('  Derived from feature separation analysis. Not policy — use as research input.', '');
  for (const rule of result.trustRules) {
    L.push(`  • ${rule}`);
  }
  L.push('');

  // ── Section 9: Safety footer ──────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  paperOnly=true    No data files mutated.');
  L.push(SEP, '');

  return L.join('\n');
}
