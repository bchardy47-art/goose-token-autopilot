import * as fs from 'fs';
import * as path from 'path';
import {
  earSignalToRipperInput,
  getContractAddress,
  type RipperEarSignal,
  type RipperEarSourceKind,
} from './ripperEars';
import {
  scoreRipper,
  checkPaperBuyGate,
  DEFAULT_RIPPER_CONFIG,
  type RipperInput,
  type RipperConfig,
} from './dexRipperEngine';
import { loadEarSignals, type EarsInputFormat } from './ripperEarsReport';
import { type ClusterRiskProvider, type ClusterRiskResult, type ClusterRiskCacheStats } from './clusterRiskProvider';

// ── Shadow policy ─────────────────────────────────────────────────────────────────────────

export const SHADOW_POLICY_PRICE_GT_0_25 = 'price_gt_0_25';

export interface ShadowPolicyTag {
  shadowPolicyId:     string;
  shadowPolicyPass:   boolean;
  shadowPolicyReason: string;
  shadowPolicyValue:  number | null;
  shadowPolicyMode:   'shadow_only';
}

/**
 * Computes the shadow policy tag for a candidate at approval time.
 * Policy: price_gt_0_25 — approvalPriceChangePct > 0.25
 * Shadow-only: does not affect eligibility, scoring, or buy gates.
 */
export function computeShadowPolicy(priceChangePct: number | null | undefined): ShadowPolicyTag {
  const value = (priceChangePct != null && Number.isFinite(Number(priceChangePct)))
    ? Number(priceChangePct)
    : null;

  if (value == null) {
    return {
      shadowPolicyId:     SHADOW_POLICY_PRICE_GT_0_25,
      shadowPolicyPass:   false,
      shadowPolicyReason: 'approvalPriceChangePct missing',
      shadowPolicyValue:  null,
      shadowPolicyMode:   'shadow_only',
    };
  }

  if (value > 0.25) {
    return {
      shadowPolicyId:     SHADOW_POLICY_PRICE_GT_0_25,
      shadowPolicyPass:   true,
      shadowPolicyReason: 'approvalPriceChangePct > 0.25',
      shadowPolicyValue:  value,
      shadowPolicyMode:   'shadow_only',
    };
  }

  return {
    shadowPolicyId:     SHADOW_POLICY_PRICE_GT_0_25,
    shadowPolicyPass:   false,
    shadowPolicyReason: 'approvalPriceChangePct <= 0.25',
    shadowPolicyValue:  value,
    shadowPolicyMode:   'shadow_only',
  };
}

// ── Fixture shape ─────────────────────────────────────────────────────────────────────────

export interface LiveRipperFixture {
  id: string;
  capturedAt: string;
  source: string;
  sourceKind: RipperEarSourceKind;
  raw?: unknown;
  normalizedSignal: RipperEarSignal;
  ripperInput: RipperInput | null;
  ripperScore?: number;
  launchAgeBucket?: string;
  ageMinutes?: number;
  entryDecision?: string;
  buyGateDecision?: string;
  blockers: string[];
  topReasons: string[];
  warnings: string[];
  /** Shadow policy tag — present only on BUY_APPROVED_PAPER fixtures (missing on old artifacts) */
  shadowPolicyId?:     string;
  shadowPolicyPass?:   boolean;
  shadowPolicyReason?: string;
  shadowPolicyValue?:  number | null;
  shadowPolicyMode?:   'shadow_only';
  realTradingLocked: true;
  paperOnly: true;
  readOnly: true;
}

// ── Fixture builder (pure) ────────────────────────────────────────────────────────────────

export function buildFixture(
  signal: RipperEarSignal,
  config: RipperConfig,
  nowMs: number,
  clusterResult?: ClusterRiskResult,
): LiveRipperFixture {
  const contract   = getContractAddress(signal);
  const capturedAt = new Date(nowMs).toISOString();
  const baseInput  = earSignalToRipperInput(signal);

  // Inject cluster risk into scoring when enrichment is available
  const ripperInput = baseInput && clusterResult
    ? { ...baseInput, clusterRisk: clusterResult.clusterRisk }
    : baseInput;

  // Merge cluster metadata into raw so downstream audit tools (primeGateAudit, autonomyReadiness) can read it
  const rawWithCluster: unknown = clusterResult
    ? {
        ...(typeof signal.raw === 'object' && signal.raw !== null
          ? signal.raw as Record<string, unknown>
          : {}),
        clusterRisk:       clusterResult.clusterRisk,
        clusterProvider:   clusterResult.clusterProvider,
        clusterCheckedAt:  clusterResult.clusterCheckedAt,
        clusterConfidence: clusterResult.clusterConfidence,
        clusterNotes:      clusterResult.clusterNotes,
        ...(clusterResult.clusterFetchError !== undefined
          ? { clusterFetchError: clusterResult.clusterFetchError }
          : {}),
      }
    : signal.raw;

  let ripperScore: number | undefined;
  let launchAgeBucket: string | undefined;
  let ageMinutes: number | undefined;
  let entryDecision: string | undefined;
  let buyGateDecision: string | undefined;
  let blockers: string[] = [];
  let topReasons: string[] = [];

  if (ripperInput) {
    const rs = scoreRipper(ripperInput, config, nowMs);
    ripperScore     = rs.ripperScore;
    launchAgeBucket = rs.launchAgeBucket;
    ageMinutes      = rs.ageMinutes;
    entryDecision   = rs.entryDecision;
    blockers        = [...rs.blockers];
    topReasons      = [...rs.topReasons];

    const gate     = checkPaperBuyGate(rs, config);
    buyGateDecision = gate.decision;

    if (gate.decision === 'BUY_REJECTED') {
      for (const b of gate.blockers) {
        if (!blockers.some(x => x.startsWith(b.slice(0, 15)))) blockers.push(b);
      }
    } else {
      topReasons.push(...gate.reasons);
    }
  } else {
    blockers = ['no contract address — could not convert to RipperInput'];
    buyGateDecision = 'BUY_REJECTED';
  }

  // Stable ID: source + token (first 16 chars) + timestamp minute
  const token = (contract ?? signal.poolAddress ?? 'unknown').slice(0, 16);
  const ts    = capturedAt.slice(0, 16).replace('T', '-').replace(':', '');
  const id    = `${signal.source}:${token}:${ts}`;

  const fixture: LiveRipperFixture = {
    id,
    capturedAt,
    source: signal.source,
    sourceKind: signal.sourceKind,
    raw: rawWithCluster,
    normalizedSignal: signal,
    ripperInput,
    ripperScore,
    launchAgeBucket,
    ageMinutes,
    entryDecision,
    buyGateDecision,
    blockers: blockers.slice(0, 10),
    topReasons: topReasons.slice(0, 10),
    warnings: signal.warnings,
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
  };

  // Attach shadow policy metadata only to approved candidates (shadow-only, never gates)
  if (buyGateDecision === 'BUY_APPROVED_PAPER') {
    const sp = computeShadowPolicy(signal.priceChangePct);
    fixture.shadowPolicyId     = sp.shadowPolicyId;
    fixture.shadowPolicyPass   = sp.shadowPolicyPass;
    fixture.shadowPolicyReason = sp.shadowPolicyReason;
    fixture.shadowPolicyValue  = sp.shadowPolicyValue;
    fixture.shadowPolicyMode   = sp.shadowPolicyMode;
  }

  return fixture;
}

// ── JSONL storage ─────────────────────────────────────────────────────────────────────────

export function appendFixtureToJsonl(fixture: LiveRipperFixture, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, JSON.stringify(fixture) + '\n', 'utf-8');
}

export function readFixturesFromJsonl(outputPath: string): LiveRipperFixture[] {
  if (!fs.existsSync(outputPath)) return [];
  const raw = fs.readFileSync(outputPath, 'utf-8');
  const fixtures: LiveRipperFixture[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      fixtures.push(JSON.parse(trimmed) as LiveRipperFixture);
    } catch {
      // Skip malformed lines silently
    }
  }
  return fixtures;
}

export function resetFixtureFile(outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, '', 'utf-8');
}

// ── Capture orchestrator ──────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  inputPath: string;
  outputPath: string;
  format: EarsInputFormat;
  reset?: boolean;
  config?: Partial<RipperConfig>;
  nowMs?: number;
  clusterRiskProvider?: ClusterRiskProvider;
}

export interface CaptureResult {
  capturedCount: number;
  skippedCount: number;       // conversion failures (no contract)
  appendedCount: number;
  outputPath: string;
  inputMissing: boolean;
  loadWarnings: string[];
  fixtures: LiveRipperFixture[];
  /** Populated when the provider is a caching wrapper (BubbleMapsCache) */
  bubbleMapsStats?: ClusterRiskCacheStats;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

export async function runLiveFixtureCapture(options: CaptureOptions): Promise<CaptureResult> {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const config = { ...DEFAULT_RIPPER_CONFIG, ...(options.config ?? {}) };

  const { signals, loadWarnings, missing } = loadEarSignals(
    options.inputPath,
    options.format,
    nowIso,
  );

  if (missing) {
    return {
      capturedCount: 0,
      skippedCount: 0,
      appendedCount: 0,
      outputPath: options.outputPath,
      inputMissing: true,
      loadWarnings,
      fixtures: [],
      tradingExecuted: 0,
      noRealTradeSent: true,
      paperOnly: true,
      readOnly: true,
    };
  }

  if (options.reset) {
    resetFixtureFile(options.outputPath);
  }

  // Per-run cache: one BubbleMaps call per unique contract address
  const clusterCache = new Map<string, ClusterRiskResult>();

  const fixtures: LiveRipperFixture[] = [];
  let skippedCount = 0;

  for (const signal of signals) {
    let clusterResult: ClusterRiskResult | undefined;
    if (options.clusterRiskProvider) {
      const contract = getContractAddress(signal);
      if (contract) {
        const cached = clusterCache.get(contract);
        if (cached) {
          clusterResult = cached;
        } else {
          try {
            clusterResult = await options.clusterRiskProvider.fetchClusterRisk(contract);
          } catch (err) {
            // Provider threw unexpectedly — degrade to UNKNOWN, never crash live capture
            clusterResult = {
              clusterRisk:       'UNKNOWN',
              clusterProvider:   options.clusterRiskProvider.name,
              clusterCheckedAt:  nowIso,
              clusterConfidence: 'UNKNOWN',
              clusterNotes:      ['CLUSTER_PROVIDER_UNAVAILABLE — provider threw unexpectedly'],
              clusterFetchError: err instanceof Error ? err.message : 'unexpected provider error',
            };
          }
          clusterCache.set(contract, clusterResult);
        }
      }
    }

    const fixture = buildFixture(signal, config, nowMs, clusterResult);
    if (fixture.ripperInput === null && !getContractAddress(signal)) {
      skippedCount += 1;
    }
    fixtures.push(fixture);
    appendFixtureToJsonl(fixture, options.outputPath);
  }

  // Extract cache stats if the provider supports it (duck-typed — no hard dep on BubbleMapsCache)
  type MaybeStats = ClusterRiskProvider & { getStats?: () => ClusterRiskCacheStats };
  const bubbleMapsStats =
    options.clusterRiskProvider &&
    typeof (options.clusterRiskProvider as MaybeStats).getStats === 'function'
      ? (options.clusterRiskProvider as MaybeStats).getStats!()
      : undefined;

  return {
    capturedCount: signals.length,
    skippedCount,
    appendedCount: fixtures.length,
    outputPath: options.outputPath,
    inputMissing: false,
    loadWarnings,
    fixtures,
    bubbleMapsStats,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────────────────

export interface FixtureReportResult {
  outputPath: string;
  fileMissing: boolean;
  totalFixtures: number;
  sourcesFound: string[];
  newestCaptureAt: string | null;
  primeWindowCount: number;
  readyToSnipeCount: number;
  paperBuyApprovedCount: number;
  blockedCount: number;
  topBlockers: string[];           // blocker text → count formatted
  topScores: LiveRipperFixture[];  // top 5 by ripperScore
  topNearMisses: LiveRipperFixture[]; // BUY_REJECTED but high score
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export function runLiveFixtureReport(outputPath: string): FixtureReportResult {
  const fixtures = readFixturesFromJsonl(outputPath);
  const fileMissing = !fs.existsSync(outputPath);

  if (fixtures.length === 0) {
    return {
      outputPath,
      fileMissing,
      totalFixtures: 0,
      sourcesFound: [],
      newestCaptureAt: null,
      primeWindowCount: 0,
      readyToSnipeCount: 0,
      paperBuyApprovedCount: 0,
      blockedCount: 0,
      topBlockers: [],
      topScores: [],
      topNearMisses: [],
      tradingExecuted: 0,
      noRealTradeSent: true,
    };
  }

  const sourcesFound   = [...new Set(fixtures.map(f => f.source))];
  const newestCaptureAt = fixtures
    .map(f => f.capturedAt)
    .sort()
    .at(-1) ?? null;

  const primeWindowCount     = fixtures.filter(f => f.launchAgeBucket === 'PRIME_WINDOW').length;
  const readyToSnipeCount    = fixtures.filter(f => f.entryDecision === 'READY_TO_SNIPE_PAPER').length;
  const paperBuyApprovedCount = fixtures.filter(f => f.buyGateDecision === 'BUY_APPROVED_PAPER').length;
  const blockedCount         = fixtures.filter(f => f.buyGateDecision === 'BUY_REJECTED').length;

  // Count blocker occurrences
  const blockerCounts = new Map<string, number>();
  for (const f of fixtures) {
    for (const b of f.blockers) {
      blockerCounts.set(b, (blockerCounts.get(b) ?? 0) + 1);
    }
  }
  const topBlockers = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([b, n]) => `${b} (×${n})`);

  // Top scores
  const topScores = [...fixtures]
    .filter(f => f.ripperScore != null)
    .sort((a, b) => (b.ripperScore ?? 0) - (a.ripperScore ?? 0))
    .slice(0, 5);

  // Near-misses: BUY_REJECTED with decent score
  const topNearMisses = [...fixtures]
    .filter(f => f.buyGateDecision === 'BUY_REJECTED' && (f.ripperScore ?? 0) >= 35)
    .sort((a, b) => (b.ripperScore ?? 0) - (a.ripperScore ?? 0))
    .slice(0, 5);

  return {
    outputPath,
    fileMissing: false,
    totalFixtures: fixtures.length,
    sourcesFound,
    newestCaptureAt,
    primeWindowCount,
    readyToSnipeCount,
    paperBuyApprovedCount,
    blockedCount,
    topBlockers,
    topScores,
    topNearMisses,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Autopsy ───────────────────────────────────────────────────────────────────────────────

export interface AutopsyEntry {
  id: string;
  contract?: string;
  symbol?: string;
  source: string;
  capturedAt: string;
  ageMinutes?: number;
  launchAgeBucket?: string;
  ripperScore?: number;
  entryDecision?: string;
  buyGateDecision?: string;
  blockers: string[];
  warnings: string[];
  autopsyNote: string;
}

export interface FixtureAutopsyResult {
  outputPath: string;
  fileMissing: boolean;
  totalFixtures: number;
  autopsiedCount: number;
  entries: AutopsyEntry[];
  tradingExecuted: 0;
  noRealTradeSent: true;
}

function autopsyNote(fixture: LiveRipperFixture): string {
  if (!fixture.ripperInput) return 'missing contract address — could not score';
  if (fixture.launchAgeBucket === 'DEAD_WINDOW') return 'too old — dead window at capture time';
  if (fixture.launchAgeBucket === 'TOO_EARLY')   return 'caught too early — needed more time in prime window';
  if (fixture.launchAgeBucket === 'LATE')         return 'caught late — ripper window already closing';
  if (fixture.blockers.some(b => b.includes('holder') && b.includes('RISKY')))
    return 'blocked by holder concentration risk';
  if (fixture.blockers.some(b => b.includes('cluster') && b.includes('RISKY')))
    return 'blocked by cluster/wallet-graph risk';
  if (fixture.blockers.some(b => b.includes('bot') || b.includes('pump')))
    return 'blocked by bot/pump risk signal';
  if (fixture.blockers.some(b => b.includes('one-sided') || b.includes('liquidity')))
    return 'blocked by liquidity quality issue';
  if (fixture.blockers.some(b => b.includes('score') && b.includes('below')))
    return `score ${fixture.ripperScore} below buy threshold`;
  if (fixture.warnings.some(w => w.includes('pairCreatedAt missing')))
    return 'age unknown — pairCreatedAt missing from source data';
  if (fixture.entryDecision === 'WATCH')
    return `watching — score ${fixture.ripperScore} not yet above ready threshold`;
  return 'blocked — see blockers for details';
}

export function runLiveFixtureAutopsy(outputPath: string): FixtureAutopsyResult {
  const fixtures = readFixturesFromJsonl(outputPath);
  const fileMissing = !fs.existsSync(outputPath);

  // Autopsy focuses on fixtures that were NOT approved
  const candidates = fixtures.filter(
    f => f.buyGateDecision !== 'BUY_APPROVED_PAPER' ||
         f.entryDecision === 'WATCH' ||
         f.entryDecision === 'PAPER_BUY_BLOCKED',
  );

  const entries: AutopsyEntry[] = candidates.map(f => ({
    id: f.id,
    contract: getContractAddress(f.normalizedSignal),
    symbol: f.normalizedSignal.symbol,
    source: f.source,
    capturedAt: f.capturedAt,
    ageMinutes: f.ageMinutes,
    launchAgeBucket: f.launchAgeBucket,
    ripperScore: f.ripperScore,
    entryDecision: f.entryDecision,
    buyGateDecision: f.buyGateDecision,
    blockers: f.blockers,
    warnings: f.warnings,
    autopsyNote: autopsyNote(f),
  }));

  entries.sort((a, b) => (b.ripperScore ?? 0) - (a.ripperScore ?? 0));

  return {
    outputPath,
    fileMissing,
    totalFixtures: fixtures.length,
    autopsiedCount: entries.length,
    entries,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────────────────

function fmtAge(m: number | undefined): string {
  if (m == null) return 'age?';
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtScore(n: number | undefined): string {
  if (n == null) return 'n/a';
  const bars = Math.round(n / 10);
  return `${'█'.repeat(bars)}${'░'.repeat(10 - bars)} ${n}`;
}

export function renderCaptureResult(result: CaptureResult, debug = false): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — LIVE FIXTURE CAPTURE');
  lines.push(`  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.inputMissing) {
    lines.push(`  Input file not found: ${result.outputPath}`);
    lines.push('');
    lines.push('  Expected ear-signals format:');
    lines.push('  { "signals": [ { "id":"...", "source":"dexscreener", "sourceKind":"DEX_NEW_POOL",');
    lines.push('    "contract":"<mint>", "discoveredAt":"<ISO>", "observedAt":"<ISO>",');
    lines.push('    "confidence":"MEDIUM", "signalReasons":[], "warnings":[] } ] }');
    lines.push('');
    lines.push('  Or pass --format dexscreener with raw DexScreener pairs JSON.');
    lines.push('');
    lines.push(`  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Input  : ${result.capturedCount} signals`);
  lines.push(`  Written: ${result.appendedCount} fixtures → ${result.outputPath}`);
  if (result.skippedCount > 0) lines.push(`  Skipped: ${result.skippedCount} (no contract address)`);
  if (result.loadWarnings.length > 0) {
    for (const w of result.loadWarnings) lines.push(`  ⚠ ${w}`);
  }
  lines.push('');

  const readyCount   = result.fixtures.filter(f => f.entryDecision === 'READY_TO_SNIPE_PAPER').length;
  const watchCount   = result.fixtures.filter(f => f.entryDecision === 'WATCH').length;
  const blockedCount = result.fixtures.filter(f => f.entryDecision === 'PAPER_BUY_BLOCKED').length;
  const ignoreCount  = result.fixtures.filter(f => f.entryDecision === 'IGNORE' || !f.entryDecision).length;
  const approvedCount = result.fixtures.filter(f => f.buyGateDecision === 'BUY_APPROVED_PAPER').length;

  lines.push(`  READY_TO_SNIPE_PAPER : ${readyCount}`);
  lines.push(`  WATCH                : ${watchCount}`);
  lines.push(`  PAPER_BUY_BLOCKED    : ${blockedCount}`);
  lines.push(`  IGNORE               : ${ignoreCount}`);
  lines.push(`  BUY_APPROVED_PAPER   : ${approvedCount}`);
  lines.push('');

  if (debug) {
    lines.push('  ── DEBUG: CAPTURED FIXTURES ──');
    for (const f of result.fixtures) {
      const sym = f.normalizedSignal.symbol ? `$${f.normalizedSignal.symbol}` : '(no sym)';
      lines.push(`  ${sym.padEnd(10)} score=${fmtScore(f.ripperScore)}  ${(f.entryDecision ?? 'n/a').padEnd(22)}  age=${fmtAge(f.ageMinutes)}`);
      for (const b of f.blockers.slice(0, 2)) lines.push(`    ✗ ${b}`);
    }
    lines.push('');
  }

  if (result.bubbleMapsStats) {
    const bms = result.bubbleMapsStats;
    lines.push(`  BubbleMaps mode       : ${bms.mode}`);
    lines.push(`  BubbleMaps live calls : ${bms.liveCallsThisRun} / ${bms.capLimit} (cap)`);
    lines.push(`  BubbleMaps cache hits : ${bms.cacheHitsThisRun}`);
    if (bms.skippedDueToCap > 0) {
      const label = bms.mode === 'DISABLED'
        ? '← BubbleMaps disabled — no live calls'
        : '← BubbleMaps calls skipped due to cap';
      lines.push(`  BubbleMaps skipped    : ${bms.skippedDueToCap}  ${label}`);
    } else {
      lines.push(`  BubbleMaps skipped    : 0`);
    }
    lines.push('');
  }

  lines.push(`  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderFixtureReport(result: FixtureReportResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — LIVE FIXTURE REPORT');
  lines.push(`  [REAL TRADING LOCKED]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.fileMissing || result.totalFixtures === 0) {
    lines.push(`  No fixtures found at: ${result.outputPath}`);
    lines.push('  Run token:live-fixture-capture first to collect samples.');
    lines.push('');
    lines.push(`  tradingExecuted=0  noRealTradeSent=true`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Total fixtures    : ${result.totalFixtures}`);
  lines.push(`  Sources           : ${result.sourcesFound.join(', ')}`);
  lines.push(`  Newest capture    : ${result.newestCaptureAt?.slice(0, 19).replace('T', ' ') ?? 'n/a'}`);
  lines.push(`  Prime-window hits : ${result.primeWindowCount}`);
  lines.push(`  Ready-to-snipe    : ${result.readyToSnipeCount}`);
  lines.push(`  Buy approved      : ${result.paperBuyApprovedCount}`);
  lines.push(`  Buy blocked       : ${result.blockedCount}`);
  lines.push('');

  if (result.topBlockers.length > 0) {
    lines.push('  TOP BLOCKERS');
    for (const b of result.topBlockers) lines.push(`    • ${b}`);
    lines.push('');
  }

  if (result.topScores.length > 0) {
    lines.push('  TOP SCORES');
    for (const f of result.topScores) {
      const sym = f.normalizedSignal.symbol ? `$${f.normalizedSignal.symbol}` : '(no sym)';
      lines.push(`    ${sym.padEnd(12)} ${fmtScore(f.ripperScore)}  ${(f.entryDecision ?? '').padEnd(22)}  age=${fmtAge(f.ageMinutes)}`);
    }
    lines.push('');
  }

  if (result.topNearMisses.length > 0) {
    lines.push('  NEAR-MISSES (BUY_REJECTED, score ≥ 35)');
    for (const f of result.topNearMisses) {
      const sym = f.normalizedSignal.symbol ? `$${f.normalizedSignal.symbol}` : '(no sym)';
      lines.push(`    ${sym.padEnd(12)} score=${f.ripperScore}  ${(f.entryDecision ?? '').padEnd(22)}  age=${fmtAge(f.ageMinutes)}`);
      for (const b of f.blockers.slice(0, 2)) lines.push(`      ✗ ${b}`);
    }
    lines.push('');
  }

  lines.push(`  tradingExecuted=0  noRealTradeSent=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderAutopsyReport(result: FixtureAutopsyResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — LIVE FIXTURE AUTOPSY');
  lines.push(`  [REAL TRADING LOCKED]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.fileMissing || result.totalFixtures === 0) {
    lines.push(`  No fixtures found at: ${result.outputPath}`);
    lines.push('  Run token:live-fixture-capture first.');
    lines.push('');
    lines.push(`  tradingExecuted=0  noRealTradeSent=true`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Total fixtures: ${result.totalFixtures}   Autopsied (not approved): ${result.autopsiedCount}`);
  lines.push('');

  if (result.entries.length === 0) {
    lines.push('  All captured fixtures were BUY_APPROVED_PAPER — nothing to autopsy.');
  } else {
    for (const e of result.entries) {
      const sym = e.symbol ? `$${e.symbol}` : (e.contract ?? 'unknown').slice(0, 12) + '…';
      const scr = e.ripperScore != null ? String(e.ripperScore) : 'n/a';
      lines.push(`  ${sym.padEnd(14)} score=${scr.padStart(3)}  ${(e.entryDecision ?? 'n/a').padEnd(22)}  age=${fmtAge(e.ageMinutes)}`);
      lines.push(`    → ${e.autopsyNote}`);
      for (const b of e.blockers.slice(0, 2)) lines.push(`    ✗ ${b}`);
      for (const w of e.warnings.slice(0, 1)) lines.push(`    ⚠ ${w}`);
    }
  }

  lines.push('');
  lines.push(`  tradingExecuted=0  noRealTradeSent=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderLiveFixtureCaptureUsage(): string {
  return `
token:live-fixture-capture — capture normalized ripper signals to append-only local JSONL

Usage:
  npm run token:live-fixture-capture [options]

Options:
  --input <path>    ear signals or dexscreener JSON (default: data/token-grab/ripper/ripper-ears-input.json)
  --output <path>   JSONL output path (default: data/token-grab/ripper/live-fixtures.jsonl)
  --format <fmt>    ear-signals (default) | dexscreener
  --reset           clear output file before writing (default: append)
  --debug           print per-fixture detail
  --help            show this message

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only capture.
`.trim();
}

export function renderLiveFixtureReportUsage(): string {
  return `
token:live-fixture-report — summarize all captured live fixtures

Usage:
  npm run token:live-fixture-report [options]

Options:
  --fixtures <path>   JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --help              show this message

Safety:
  REAL TRADING LOCKED. Read-only.
`.trim();
}

export function renderLiveFixtureAutopsyUsage(): string {
  return `
token:live-fixture-autopsy — explain why captured signals were skipped/blocked

Usage:
  npm run token:live-fixture-autopsy [options]

Options:
  --fixtures <path>   JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --help              show this message

Safety:
  REAL TRADING LOCKED. Read-only.
`.trim();
}
