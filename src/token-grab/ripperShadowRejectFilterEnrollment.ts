import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShadowRejectFlags {
  age_gte10m: boolean;
  liq_lt10k:  boolean;
  liq_OR_age: boolean;
}

export interface ShadowRejectEnrollmentRow {
  capturedAt:              string;
  cycleFile:               string;
  contract:                string;
  symbol:                  string | null;
  buyGateDecision:         'BUY_APPROVED_PAPER';
  ripperScore:             number | null;
  clusterRisk:             string | null;
  launchAgeBucket:         string | null;
  entryDecision:           string | null;
  ageMinutes:              number | null;
  liquidityUsd:            number | null;
  volumeLiquidityRatio:    number | null;
  shadowRejectFlags:       ShadowRejectFlags;
  wouldRejectByBestCombo:  boolean;
  wouldRejectReason:       string | null;
  actualDecisionPreserved: true;
  reportOnly:              true;
  readOnly:                true;
  paperOnly:               true;
  realTradingLocked:       true;
  tradingExecuted:         0;
}

export interface ShadowRejectFilterEnrollmentResult {
  latestCycleFile:        string | null;
  cycleFilesRead:         number;
  approvedAnalyzed:       number;
  enrollmentsAppended:    number;
  duplicatesSkipped:      number;
  ageGte10mCount:         number;
  liqLt10kCount:          number;
  liqOrAgeCount:          number;
  actualDecisionsChanged: 0;
  outPath:                string;
  reportOnly:             true;
  readOnly:               true;
  tradingExecuted:        0;
  realTradingLocked:      true;
  paperOnly:              true;
}

export interface ShadowRejectFilterEnrollmentOptions {
  cyclesDir: string;
  outPath:   string;
  nowMs?:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function enrollmentKey(contract: string, cycleFile: string, capturedAt: string): string {
  return `${contract}::${cycleFile}::${capturedAt}`;
}

function computeFlags(ageMinutes: number | null, liquidityUsd: number | null): ShadowRejectFlags {
  const age_gte10m = ageMinutes != null && ageMinutes >= 10;
  const liq_lt10k  = liquidityUsd != null && liquidityUsd < 10_000;
  return { age_gte10m, liq_lt10k, liq_OR_age: age_gte10m || liq_lt10k };
}

function rejectReason(flags: ShadowRejectFlags): string | null {
  if (!flags.liq_OR_age) return null;
  const parts: string[] = [];
  if (flags.age_gte10m) parts.push('ageMinutes >= 10');
  if (flags.liq_lt10k)  parts.push('liquidityUsd < $10k');
  return parts.join(' + ');
}

function listCycleFiles(cyclesDir: string): string[] {
  if (!fs.existsSync(cyclesDir)) return [];
  return fs.readdirSync(cyclesDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl') && !f.endsWith('-feed.json'))
    .sort()
    .map(f => path.join(cyclesDir, f));
}

function readExistingKeys(outPath: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(outPath)) return keys;
  const lines = fs.readFileSync(outPath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<ShadowRejectEnrollmentRow>;
      if (r.contract && r.cycleFile && r.capturedAt) {
        keys.add(enrollmentKey(r.contract, r.cycleFile, r.capturedAt));
      }
    } catch { /* skip */ }
  }
  return keys;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runShadowRejectFilterEnrollment(
  options: ShadowRejectFilterEnrollmentOptions,
): ShadowRejectFilterEnrollmentResult {
  const cycleFiles     = listCycleFiles(options.cyclesDir);
  const existingKeys   = readExistingKeys(options.outPath);
  const newRows: ShadowRejectEnrollmentRow[] = [];

  let approvedAnalyzed  = 0;
  let duplicatesSkipped = 0;
  let ageGte10mCount    = 0;
  let liqLt10kCount     = 0;
  let liqOrAgeCount     = 0;

  for (const cyclePath of cycleFiles) {
    const cycleFile = path.basename(cyclePath);
    let lines: string[];
    try {
      lines = fs.readFileSync(cyclePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    } catch { continue; }

    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;

        const contract   = extractRipperContract(f);
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;

        approvedAnalyzed++;

        const key = enrollmentKey(contract, cycleFile, capturedAt);
        if (existingKeys.has(key)) { duplicatesSkipped++; continue; }
        existingKeys.add(key);

        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;

        const symbol:               string | null = typeof ns?.['symbol'] === 'string' ? ns['symbol'] as string : null;
        const ripperScore:          number | null = typeof f['ripperScore'] === 'number' ? f['ripperScore'] as number : null;
        const clusterRisk:          string | null = typeof raw?.['clusterRisk'] === 'string' ? raw['clusterRisk'] as string : null;
        const launchAgeBucket:      string | null = typeof f['launchAgeBucket'] === 'string' ? f['launchAgeBucket'] as string : null;
        const entryDecision:        string | null = typeof f['entryDecision'] === 'string' ? f['entryDecision'] as string : null;
        const ageMinutes:           number | null = typeof f['ageMinutes'] === 'number' ? f['ageMinutes'] as number : null;
        const liquidityUsd:         number | null = typeof ns?.['liquidityUsd'] === 'number' ? ns['liquidityUsd'] as number : null;
        const volumeLiquidityRatio: number | null = typeof ns?.['volumeLiquidityRatio'] === 'number' ? ns['volumeLiquidityRatio'] as number : null;

        const flags  = computeFlags(ageMinutes, liquidityUsd);
        const reason = rejectReason(flags);

        if (flags.age_gte10m) ageGte10mCount++;
        if (flags.liq_lt10k)  liqLt10kCount++;
        if (flags.liq_OR_age) liqOrAgeCount++;

        newRows.push({
          capturedAt,
          cycleFile,
          contract,
          symbol,
          buyGateDecision:         'BUY_APPROVED_PAPER',
          ripperScore,
          clusterRisk,
          launchAgeBucket,
          entryDecision,
          ageMinutes,
          liquidityUsd,
          volumeLiquidityRatio,
          shadowRejectFlags:       flags,
          wouldRejectByBestCombo:  flags.liq_OR_age,
          wouldRejectReason:       reason,
          actualDecisionPreserved: true,
          reportOnly:              true,
          readOnly:                true,
          paperOnly:               true,
          realTradingLocked:       true,
          tradingExecuted:         0,
        });
      } catch { /* skip */ }
    }
  }

  // Append new rows
  if (newRows.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    const append = newRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(options.outPath, append, 'utf-8');
  }

  const latestCycleFile = cycleFiles.length > 0
    ? path.basename(cycleFiles[cycleFiles.length - 1]!)
    : null;

  return {
    latestCycleFile,
    cycleFilesRead:         cycleFiles.length,
    approvedAnalyzed,
    enrollmentsAppended:    newRows.length,
    duplicatesSkipped,
    ageGte10mCount,
    liqLt10kCount,
    liqOrAgeCount,
    actualDecisionsChanged: 0,
    outPath:                options.outPath,
    reportOnly:             true,
    readOnly:               true,
    tradingExecuted:        0,
    realTradingLocked:      true,
    paperOnly:              true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderShadowRejectFilterEnrollment(
  result: ShadowRejectFilterEnrollmentResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — SHADOW REJECT FILTER ENROLLMENT');
  lines.push('  SHADOW_ONLY — NO DECISION CHANGES');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE PRODUCTION GATES');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  ENROLLMENT SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Latest cycle file         : ${result.latestCycleFile ?? 'none'}`);
  lines.push(`  Cycle files read          : ${result.cycleFilesRead}`);
  lines.push(`  Approved candidates read  : ${result.approvedAnalyzed}`);
  lines.push(`  Enrollments appended      : ${result.enrollmentsAppended}`);
  lines.push(`  Duplicates skipped        : ${result.duplicatesSkipped}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SHADOW REJECT COUNTS (would-have-been-rejected)');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  age_gte10m  (ageMinutes >= 10)                   : ${result.ageGte10mCount}`);
  lines.push(`  liq_lt10k   (liquidityUsd < $10k)                : ${result.liqLt10kCount}`);
  lines.push(`  liq_OR_age  (best combo — either condition)       : ${result.liqOrAgeCount}`);
  lines.push('');
  lines.push('  These are shadow-only. Actual approved candidates are UNCHANGED.');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY CHECKS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Actual decisions changed  : ${result.actualDecisionsChanged}`);
  lines.push('  * No candidates rejected. No gate logic modified.');
  lines.push('  * No paper-buy triggered. No auto-paper changes.');
  lines.push('  * No wallet access. No real trading.');
  lines.push('  * Output file is append-only enrollment log.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT wire these flags into autopilot or paper gates.');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(`  Output: ${result.outPath}`);
  lines.push(SEP, '');
  return lines.join('\n');
}
