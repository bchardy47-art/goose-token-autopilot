import * as fs from 'fs';
import * as path from 'path';
import type { ClusterRisk } from './dexRipperEngine';
import { runFreshPoolFeed } from './freshPoolFeed';
import { runLiveFixtureCapture, type LiveRipperFixture } from './liveFixtureCapture';
import type { ClusterRiskProvider, ClusterRiskCacheStats } from './clusterRiskProvider';
import type { RipperEarSignal } from './ripperEars';

const DEFAULT_RUNS_DIR         = 'data/token-grab/dex-watch-runs';
const DEFAULT_CYCLES_DIR       = 'data/token-grab/ripper/cycles';
const DEFAULT_OBSERVATIONS_DIR = 'data/token-grab/ripper/observations';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperCycleOptions {
  runsDir?: string;
  cyclesDir?: string;
  clusterRiskProvider?: ClusterRiskProvider;
  nowMs?: number;
  /** Session-level dedupe set — mutated in place; contracts processed this cycle are added */
  seenContracts?: Set<string>;
  /** Session-level first-seen map — key → earliest discoveredAt ISO; mutated in place */
  firstSeenMap?: Map<string, string>;
  /** Approved contracts from this session — key → original approvedAt ISO; mutated in place */
  approvedContracts?: Map<string, string>;
  /** Directory for post-approval observation artifacts (default: data/token-grab/ripper/observations) */
  observationsDir?: string;
}

export interface RipperPaperCycleResult {
  cycleStartedAt: string;
  cycleSlug: string;
  feedSignalsWritten: number;
  feedSkippedOldCount: number;
  captureSkipped: boolean;
  captureSkipReason?: string;
  fixturesCaptured: number;
  clusterRiskCounts: Record<ClusterRisk, number>;
  bubblemapsProviderCount: number;
  buyApprovedPaper: number;
  buyRejected: number;
  /** Shadow policy counts across approved fixtures (shadow-only, does not affect gates) */
  shadowPolicyPass?:    number;
  shadowPolicyFail?:    number;
  shadowPolicyMissing?: number;
  seenSkippedCount: number;
  /** Fixtures that were TOO_EARLY and not added to seenContracts — will be rechecked next cycle */
  tooEarlyRecheckableCount: number;
  outputPath: string | null;
  feedOutputPath: string;
  /** Post-approval observation fixtures captured this cycle (read-only, no new buy approvals) */
  postApprovalObservedCount: number;
  /** Path to observation JSONL artifact (null if no observations this cycle) */
  observationOutputPath: string | null;
  /** BubbleMaps cache/cap stats for this cycle (present when using BubbleMapsCache provider) */
  bubbleMapsStats?: ClusterRiskCacheStats;
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function makeCycleSlug(nowMs: number): string {
  return new Date(nowMs).toISOString()
    .slice(0, 19)
    .replace('T', '-')
    .replace(/:/g, '');
}

function getClusterRisk(f: LiveRipperFixture): ClusterRisk {
  const raw = f.raw as Record<string, unknown> | undefined;
  const v = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function isBubblemapsProvider(f: LiveRipperFixture): boolean {
  const raw = f.raw as Record<string, unknown> | undefined;
  return (raw?.['clusterProvider'] as string | undefined) === 'bubblemaps';
}

/** Stable identity key for session-level dedupe. Prefers the on-chain mint address. */
function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

/**
 * Returns true when a fixture was rejected ONLY because the token is too young
 * (launchAgeBucket === 'TOO_EARLY' and every blocker is age-related).
 * These candidates should NOT be added to the permanent seenContracts set —
 * they become eligible again once they age into the prime window.
 */
function isRecheckableTooEarly(f: LiveRipperFixture): boolean {
  if (f.launchAgeBucket !== 'TOO_EARLY') return false;
  return f.blockers.every(
    b => b.startsWith('too early') || b.startsWith('launch age TOO_EARLY'),
  );
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runRipperPaperCycle(
  options: RipperPaperCycleOptions = {},
): Promise<RipperPaperCycleResult> {
  const nowMs      = options.nowMs ?? Date.now();
  const cyclesDir  = options.cyclesDir ?? DEFAULT_CYCLES_DIR;
  const runsDir    = options.runsDir   ?? DEFAULT_RUNS_DIR;

  const cycleSlug         = makeCycleSlug(nowMs);
  const cycleStartedAt    = new Date(nowMs).toISOString();
  const feedOutputPath    = path.join(cyclesDir, `cycle-${cycleSlug}-feed.json`);
  const fixtureOutputPath = path.join(cyclesDir, `cycle-${cycleSlug}.jsonl`);

  const safetyFields = {
    realTradingLocked: true  as const,
    tradingExecuted:   0     as const,
    noRealTradeSent:   true  as const,
    paperOnly:         true  as const,
    readOnly:          true  as const,
  };

  // ── Step 1: fresh-pool-feed ───────────────────────────────────────────────
  const feedResult = runFreshPoolFeed({ runsDir, outputPath: feedOutputPath, nowMs });

  // ── Step 2: skip capture when no fresh signals ────────────────────────────
  if (feedResult.sourceMissing || feedResult.signalsWritten === 0) {
    const captureSkipReason = feedResult.sourceMissing
      ? `no dex-watch run files found in ${runsDir}`
      : feedResult.skippedOldCount > 0
        ? `all ${feedResult.skippedOldCount} candidates older than prime window — run token:dex-day-watch`
        : `no candidates in run file`;

    return {
      cycleStartedAt,
      cycleSlug,
      feedSignalsWritten:  0,
      feedSkippedOldCount: feedResult.skippedOldCount,
      captureSkipped:      true,
      captureSkipReason,
      fixturesCaptured:    0,
      clusterRiskCounts:   { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
      bubblemapsProviderCount: 0,
      buyApprovedPaper:    0,
      buyRejected:         0,
      seenSkippedCount:    0,
      tooEarlyRecheckableCount: 0,
      outputPath:          null,
      feedOutputPath,
      postApprovalObservedCount: 0,
      observationOutputPath:     null,
      ...safetyFields,
    };
  }

  // ── Step 2b: session dedupe — separate new signals from observation candidates ──
  let effectiveSignals = feedResult.signals;
  let toObserve: RipperEarSignal[] = [];
  let seenSkippedCount = 0;

  if (options.seenContracts && options.seenContracts.size > 0) {
    const newSignals: RipperEarSignal[] = [];
    for (const s of feedResult.signals) {
      const key = signalKey(s);
      if (options.seenContracts.has(key)) {
        if (options.approvedContracts?.has(key)) {
          toObserve.push(s);
        } else {
          seenSkippedCount++;
        }
      } else {
        newSignals.push(s);
      }
    }
    if (seenSkippedCount > 0 || toObserve.length > 0) {
      effectiveSignals = newSignals;
      try {
        fs.writeFileSync(feedOutputPath, JSON.stringify({ signals: newSignals }, null, 2), 'utf-8');
      } catch {
        // non-fatal: capture will read missing/stale file and return 0 fixtures
      }
    }
  }

  // Early-exit only when there is nothing to process at all (neither new signals nor observations)
  if (effectiveSignals.length === 0 && toObserve.length === 0) {
    return {
      cycleStartedAt,
      cycleSlug,
      feedSignalsWritten:  feedResult.signalsWritten,
      feedSkippedOldCount: feedResult.skippedOldCount,
      captureSkipped:      true,
      captureSkipReason:   `all ${seenSkippedCount} signals already seen in this session`,
      fixturesCaptured:    0,
      clusterRiskCounts:   { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
      bubblemapsProviderCount: 0,
      buyApprovedPaper:    0,
      buyRejected:         0,
      seenSkippedCount,
      tooEarlyRecheckableCount: 0,
      outputPath:          null,
      feedOutputPath,
      postApprovalObservedCount: 0,
      observationOutputPath:     null,
      ...safetyFields,
    };
  }

  // ── Step 2c: anchor discoveredAt to first-seen time ───────────────────────
  // When --refresh-source rewrites run files, each new dex-day-watch run
  // stamps fresh observedAt values, resetting discoveredAt to ~now. Without
  // anchoring, a candidate that was TOO_EARLY last cycle looks TOO_EARLY again
  // after the refresh even though real elapsed time has accumulated. We pin
  // discoveredAt to the EARLIEST value recorded for each candidate key so age
  // grows correctly across cycles.
  if (options.firstSeenMap) {
    if (effectiveSignals.length > 0) {
      let anyNormalized = false;
      const normalizedSignals = effectiveSignals.map(s => {
        const key      = signalKey(s);
        const existing = options.firstSeenMap!.get(key);
        if (existing) {
          if (s.discoveredAt !== existing) {
            anyNormalized = true;
            return { ...s, discoveredAt: existing };
          }
          return s;
        }
        options.firstSeenMap!.set(key, s.discoveredAt);
        return s;
      });

      if (anyNormalized) {
        effectiveSignals = normalizedSignals;
        try {
          fs.writeFileSync(
            feedOutputPath,
            JSON.stringify({ signals: normalizedSignals }, null, 2),
            'utf-8',
          );
        } catch {
          // non-fatal: age may not normalize correctly this cycle
        }
      }
    }

    if (toObserve.length > 0) {
      toObserve = toObserve.map(s => {
        const key      = signalKey(s);
        const existing = options.firstSeenMap!.get(key);
        return existing && s.discoveredAt !== existing ? { ...s, discoveredAt: existing } : s;
      });
    }
  }

  // ── Step 3: live-fixture-capture (new signals only) ───────────────────────
  const captureSkipped = effectiveSignals.length === 0;
  const captureSkipReason = captureSkipped
    ? `all ${seenSkippedCount} signals already seen in this session`
    : undefined;

  const captureResult = captureSkipped
    ? { capturedCount: 0, fixtures: [] as LiveRipperFixture[] }
    : await runLiveFixtureCapture({
        inputPath:           feedOutputPath,
        outputPath:          fixtureOutputPath,
        format:              'ear-signals',
        reset:               true,
        clusterRiskProvider: options.clusterRiskProvider,
        nowMs,
      });

  // ── Step 4: aggregate counts from fixtures ────────────────────────────────
  const clusterRiskCounts: Record<ClusterRisk, number> = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };
  let bubblemapsProviderCount = 0;
  let buyApprovedPaper        = 0;
  let buyRejected             = 0;
  let shadowPolicyPass        = 0;
  let shadowPolicyFail        = 0;
  let shadowPolicyMissing     = 0;

  for (const f of captureResult.fixtures) {
    clusterRiskCounts[getClusterRisk(f)] += 1;
    if (isBubblemapsProvider(f)) bubblemapsProviderCount += 1;
    if (f.buyGateDecision === 'BUY_APPROVED_PAPER') {
      buyApprovedPaper += 1;
      if (f.shadowPolicyPass === true)       shadowPolicyPass    += 1;
      else if (f.shadowPolicyPass === false) shadowPolicyFail    += 1;
      else                                   shadowPolicyMissing += 1;
    } else {
      buyRejected += 1;
    }
  }

  // Mark processed contracts as seen — skip recheckable TOO_EARLY fixtures so they can
  // age into the prime window and be evaluated again in a later cycle.
  let tooEarlyRecheckableCount = 0;
  if (options.seenContracts) {
    for (const f of captureResult.fixtures) {
      if (isRecheckableTooEarly(f)) {
        tooEarlyRecheckableCount += 1;
      } else {
        options.seenContracts.add(signalKey(f.normalizedSignal));
      }
    }
  } else {
    tooEarlyRecheckableCount = captureResult.fixtures.filter(isRecheckableTooEarly).length;
  }

  // Record newly approved contracts so they can be re-observed in later cycles
  if (options.approvedContracts) {
    for (const f of captureResult.fixtures) {
      if (f.buyGateDecision === 'BUY_APPROVED_PAPER') {
        options.approvedContracts.set(signalKey(f.normalizedSignal), f.capturedAt);
      }
    }
  }

  // ── Step 5: post-approval observations (read-only, no new approvals) ──────
  let postApprovalObservedCount = 0;
  let observationOutputPath: string | null = null;

  if (toObserve.length > 0) {
    const obsDir        = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR;
    const obsFeedPath   = path.join(obsDir, `obs-${cycleSlug}-feed.json`);
    const obsOutputPath = path.join(obsDir, `obs-${cycleSlug}.jsonl`);

    try {
      fs.mkdirSync(obsDir, { recursive: true });
      fs.writeFileSync(obsFeedPath, JSON.stringify({ signals: toObserve }, null, 2), 'utf-8');

      const obsCaptureResult = await runLiveFixtureCapture({
        inputPath:           obsFeedPath,
        outputPath:          obsOutputPath,
        format:              'ear-signals',
        reset:               true,
        clusterRiskProvider: undefined,   // no new BubbleMaps calls for observations
        nowMs,
      });

      if (obsCaptureResult.capturedCount > 0) {
        const annotated = obsCaptureResult.fixtures.map(f => {
          const key = signalKey(f.normalizedSignal);
          const originalApprovedAt = options.approvedContracts?.get(key);
          return { ...f, postApprovalObservation: true as const, originalApprovedAt };
        });

        fs.writeFileSync(
          obsOutputPath,
          annotated.map(f => JSON.stringify(f)).join('\n') + '\n',
          'utf-8',
        );

        postApprovalObservedCount = annotated.length;
        observationOutputPath     = obsOutputPath;
      }
    } catch {
      // non-fatal: observation failure must not disrupt the main cycle result
    }
  }

  return {
    cycleStartedAt,
    cycleSlug,
    feedSignalsWritten:  feedResult.signalsWritten,
    feedSkippedOldCount: feedResult.skippedOldCount,
    captureSkipped,
    captureSkipReason,
    fixturesCaptured:    captureResult.capturedCount,
    clusterRiskCounts,
    bubblemapsProviderCount,
    buyApprovedPaper,
    buyRejected,
    shadowPolicyPass,
    shadowPolicyFail,
    shadowPolicyMissing,
    seenSkippedCount,
    tooEarlyRecheckableCount,
    outputPath:    captureResult.capturedCount > 0 ? fixtureOutputPath : null,
    feedOutputPath,
    postApprovalObservedCount,
    observationOutputPath,
    bubbleMapsStats: 'bubbleMapsStats' in captureResult ? captureResult.bubbleMapsStats : undefined,
    ...safetyFields,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperPaperCycleResult(result: RipperPaperCycleResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];
  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER PAPER CYCLE');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Cycle started  : ${result.cycleStartedAt}`);
  lines.push(`  Cycle ID       : ${result.cycleSlug}`);
  lines.push('');

  lines.push(`  Feed signals   : ${result.feedSignalsWritten}`);
  lines.push(`  Skipped (stale): ${result.feedSkippedOldCount}`);
  lines.push('');

  if (result.captureSkipped) {
    lines.push(`  Capture skipped: YES`);
    lines.push(`  Reason         : ${result.captureSkipReason ?? 'no fresh signals'}`);
    lines.push('');
    lines.push('  No fixtures captured. No BubbleMaps calls made.');
    lines.push('');
    lines.push('  Next: npm run token:dex-day-watch');
  } else {
    lines.push(`  Capture skipped: NO`);
    lines.push(`  Fixtures cap.  : ${result.fixturesCaptured}`);
    lines.push('');
    lines.push('  Cluster risk:');
    lines.push(`    CLEAN        : ${result.clusterRiskCounts.CLEAN}`);
    lines.push(`    WATCH        : ${result.clusterRiskCounts.WATCH}`);
    lines.push(`    RISKY        : ${result.clusterRiskCounts.RISKY}`);
    lines.push(`    UNKNOWN      : ${result.clusterRiskCounts.UNKNOWN}`);
    if (result.bubbleMapsStats) {
      const bms = result.bubbleMapsStats;
      lines.push(`    BubbleMaps live calls : ${bms.liveCallsThisRun} / ${bms.capLimit} (cap)`);
      lines.push(`    BubbleMaps cache hits : ${bms.cacheHitsThisRun}`);
      if (bms.skippedDueToCap > 0) {
        lines.push(`    BubbleMaps cap skips  : ${bms.skippedDueToCap}  ← BubbleMaps calls skipped due to cap`);
      } else {
        lines.push(`    BubbleMaps cap skips  : 0`);
      }
    } else {
      lines.push(`    BubbleMaps   : ${result.bubblemapsProviderCount} (provider count)`);
    }
    lines.push('');
    lines.push('  Gate decisions:');
    lines.push(`    BUY_APPROVED_PAPER : ${result.buyApprovedPaper}`);
    lines.push(`    BUY_REJECTED       : ${result.buyRejected}`);
    lines.push('');
    if (result.outputPath) {
      lines.push(`  ✓ Fixtures     : ${result.outputPath}`);
    } else {
      lines.push('  (no fixtures written — 0 captured)');
    }
    lines.push(`  Feed output    : ${result.feedOutputPath}`);
  }

  if (result.postApprovalObservedCount > 0) {
    lines.push('');
    lines.push(`  Post-approval obs: ${result.postApprovalObservedCount}`);
    if (result.observationOutputPath) {
      lines.push(`    artifact: ${result.observationOutputPath}`);
    }
  }

  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperPaperCycleUsage(): string {
  return `
token:ripper-paper-cycle — one-shot fresh ripper paper cycle

Usage:
  npm run token:ripper-paper-cycle [options]

Options:
  --runs-dir <path>     dex-watch run files directory (default: data/token-grab/dex-watch-runs)
  --cycles-dir <path>   output directory for cycle artifacts (default: data/token-grab/ripper/cycles)
  --help                show this message

Sequence:
  1. Read the most recent dex-watch run file from --runs-dir
  2. Filter signals to prime window (≤20 minutes old)
  3. If 0 fresh signals: exit 0 cleanly, no capture, no BubbleMaps calls
  4. If fresh signals: run live-fixture-capture with BubbleMaps enrichment
  5. Print operator summary

Output artifacts per cycle (under --cycles-dir):
  cycle-<slug>-feed.json   ear signals passed to capture
  cycle-<slug>.jsonl       fixtures (only written if signals > 0)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
  Buy gates are unchanged. Age semantics are unchanged.
`.trim();
}
