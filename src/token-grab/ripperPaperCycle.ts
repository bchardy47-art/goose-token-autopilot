import * as fs from 'fs';
import * as path from 'path';
import type { ClusterRisk } from './dexRipperEngine';
import { runFreshPoolFeed } from './freshPoolFeed';
import { runLiveFixtureCapture, type LiveRipperFixture } from './liveFixtureCapture';
import type { ClusterRiskProvider } from './clusterRiskProvider';
import type { RipperEarSignal } from './ripperEars';

const DEFAULT_RUNS_DIR   = 'data/token-grab/dex-watch-runs';
const DEFAULT_CYCLES_DIR = 'data/token-grab/ripper/cycles';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperCycleOptions {
  runsDir?: string;
  cyclesDir?: string;
  clusterRiskProvider?: ClusterRiskProvider;
  nowMs?: number;
  /** Session-level dedupe set — mutated in place; contracts processed this cycle are added */
  seenContracts?: Set<string>;
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
  seenSkippedCount: number;
  outputPath: string | null;
  feedOutputPath: string;
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
      outputPath:          null,
      feedOutputPath,
      ...safetyFields,
    };
  }

  // ── Step 2b: session dedupe — filter signals already seen this session ────
  let effectiveSignals = feedResult.signals;
  let seenSkippedCount = 0;

  if (options.seenContracts && options.seenContracts.size > 0) {
    const newSignals = feedResult.signals.filter(s => !options.seenContracts!.has(signalKey(s)));
    seenSkippedCount = feedResult.signals.length - newSignals.length;

    if (seenSkippedCount > 0) {
      effectiveSignals = newSignals;
      try {
        fs.writeFileSync(feedOutputPath, JSON.stringify({ signals: newSignals }, null, 2), 'utf-8');
      } catch {
        // non-fatal: capture will read missing/stale file and return 0 fixtures
      }
    }
  }

  if (effectiveSignals.length === 0) {
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
      outputPath:          null,
      feedOutputPath,
      ...safetyFields,
    };
  }

  // ── Step 3: live-fixture-capture with BubbleMaps enrichment ──────────────
  const captureResult = await runLiveFixtureCapture({
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

  for (const f of captureResult.fixtures) {
    clusterRiskCounts[getClusterRisk(f)] += 1;
    if (isBubblemapsProvider(f)) bubblemapsProviderCount += 1;
    if (f.buyGateDecision === 'BUY_APPROVED_PAPER') buyApprovedPaper += 1;
    else buyRejected += 1;
  }

  // Mark all processed contracts as seen for the rest of this session
  if (options.seenContracts) {
    for (const s of effectiveSignals) {
      options.seenContracts.add(signalKey(s));
    }
  }

  return {
    cycleStartedAt,
    cycleSlug,
    feedSignalsWritten:  feedResult.signalsWritten,
    feedSkippedOldCount: feedResult.skippedOldCount,
    captureSkipped:      false,
    fixturesCaptured:    captureResult.capturedCount,
    clusterRiskCounts,
    bubblemapsProviderCount,
    buyApprovedPaper,
    buyRejected,
    seenSkippedCount,
    outputPath:    captureResult.capturedCount > 0 ? fixtureOutputPath : null,
    feedOutputPath,
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
    lines.push(`    BubbleMaps   : ${result.bubblemapsProviderCount} (live API calls)`);
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
