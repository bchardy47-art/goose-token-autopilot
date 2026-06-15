import * as fs from 'fs';
import * as path from 'path';
import { runLiveFixtureCapture } from './liveFixtureCapture';
import { makeCycleSlug } from './ripperPaperCycle';
import type { RipperEarSignal } from './ripperEars';
import type { ForwardEnrollRow } from './ripperLooseExtraForwardEnroll';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperLooseExtraObservationCaptureOptions {
  enrollPath:      string;
  observationsDir: string;
  outPrefix:       string;
  nowMs?:          number; // injectable for deterministic testing
}

export interface RipperLooseExtraObservationCaptureResult {
  enrollRowsRead:     number;
  dueCheckpoints:     number;
  uniqueContractsDue: number;
  fixturesCaptured:   number;
  feedPath:           string;
  outputPath:         string;
  slug:               string;
  reportOnly:         true;
  readOnly:           true;
  tradingExecuted:    0;
  realTradingLocked:  true;
  paperOnly:          true;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface DueEntry {
  row:                ForwardEnrollRow;
  dueCheckpointLabels: string[];
}

function readEnrollRows(enrollPath: string): ForwardEnrollRow[] {
  if (!fs.existsSync(enrollPath)) return [];
  const rows: ForwardEnrollRow[] = [];
  const lines = fs.readFileSync(enrollPath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try { rows.push(JSON.parse(line) as ForwardEnrollRow); } catch { /* skip malformed */ }
  }
  return rows;
}

function findDueEntries(rows: ForwardEnrollRow[], nowMs: number): Map<string, DueEntry> {
  const dueMap = new Map<string, DueEntry>();
  for (const row of rows) {
    if (dueMap.has(row.contract)) continue; // dedup by contract
    const dueLabels = (row.checkpoints ?? [])
      .filter(cp => Date.parse(cp.targetAt) <= nowMs)
      .map(cp => cp.label);
    if (dueLabels.length > 0) {
      dueMap.set(row.contract, { row, dueCheckpointLabels: dueLabels });
    }
  }
  return dueMap;
}

function buildEarSignal(entry: DueEntry, nowIso: string): RipperEarSignal {
  const { row, dueCheckpointLabels } = entry;
  return {
    id:             `loose-extra:${row.contract}:${nowIso}`,
    source:         'loose-extra-forward-enroll',
    sourceKind:     'DEX_NEW_POOL',
    contract:       row.contract,
    symbol:         row.symbol ?? undefined,
    discoveredAt:   row.firstSeenAt,   // anchor launch-age from original first-seen
    observedAt:     nowIso,
    confidence:     'MEDIUM',
    signalReasons:  [`loose-extra checkpoints due: ${dueCheckpointLabels.join(', ')}`],
    warnings:       [],
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runRipperLooseExtraObservationCapture(
  options: RipperLooseExtraObservationCaptureOptions,
): Promise<RipperLooseExtraObservationCaptureResult> {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const slug   = makeCycleSlug(nowMs);

  const feedPath   = path.join(options.observationsDir, `${options.outPrefix}-${slug}-feed.json`);
  const outputPath = path.join(options.observationsDir, `${options.outPrefix}-${slug}.jsonl`);

  // Read enrollment
  const enrollRows = readEnrollRows(options.enrollPath);

  // Find due checkpoints, deduped by contract
  const dueMap = findDueEntries(enrollRows, nowMs);

  let dueCheckpoints = 0;
  for (const entry of dueMap.values()) {
    dueCheckpoints += entry.dueCheckpointLabels.length;
  }

  // Build ear signals feed
  const signals: RipperEarSignal[] = [];
  for (const entry of dueMap.values()) {
    signals.push(buildEarSignal(entry, nowIso));
  }

  // Write feed file and run capture
  fs.mkdirSync(options.observationsDir, { recursive: true });
  fs.writeFileSync(feedPath, JSON.stringify({ signals }, null, 2), 'utf-8');

  const captureResult = await runLiveFixtureCapture({
    inputPath:           feedPath,
    outputPath,
    format:              'ear-signals',
    reset:               true,
    clusterRiskProvider: undefined,  // no BubbleMaps calls for loose-extra observations
    nowMs,
  });

  // Annotate fixtures and rewrite JSONL
  if (captureResult.capturedCount > 0) {
    const annotated = captureResult.fixtures.map(f => {
      const contract = f.normalizedSignal.contract ?? '';
      const entry    = dueMap.get(contract);
      return {
        ...f,
        looseExtraObservation:  true as const,
        policyName:             entry?.row.policyName ?? 'LOOSE_60_WATCH',
        enrolledAt:             entry?.row.enrolledAt ?? null,
        dueCheckpointLabels:    entry?.dueCheckpointLabels ?? [],
        originalFirstSeenAt:    entry?.row.firstSeenAt ?? null,
      };
    });
    fs.writeFileSync(
      outputPath,
      annotated.map(f => JSON.stringify(f)).join('\n') + '\n',
      'utf-8',
    );
  }

  return {
    enrollRowsRead:     enrollRows.length,
    dueCheckpoints,
    uniqueContractsDue: dueMap.size,
    fixturesCaptured:   captureResult.capturedCount,
    feedPath,
    outputPath,
    slug,
    reportOnly:         true,
    readOnly:           true,
    tradingExecuted:    0,
    realTradingLocked:  true,
    paperOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperLooseExtraObservationCapture(
  result: RipperLooseExtraObservationCaptureResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LOOSE EXTRA OBSERVATION CAPTURE');
  lines.push('  [OBSERVATION ONLY — NO TRADES — NO APPROVALS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  CAPTURE SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enroll rows read      : ${result.enrollRowsRead}`);
  lines.push(`  Due checkpoints       : ${result.dueCheckpoints}`);
  lines.push(`  Unique contracts due  : ${result.uniqueContractsDue}`);
  lines.push(`  Fixtures captured     : ${result.fixturesCaptured}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  OUTPUT ARTIFACTS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Slug                  : ${result.slug}`);
  lines.push(`  Feed                  : ${result.feedPath}`);
  lines.push(`  Fixtures              : ${result.outputPath}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Observation capture only — no trades, no approvals, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES OR BUY GATE DECISIONS');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
