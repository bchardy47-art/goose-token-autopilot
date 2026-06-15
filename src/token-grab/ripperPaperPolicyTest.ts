import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaperPolicyTestRow {
  capturedAt:                string;
  cycleFile:                 string;
  contract:                  string;
  symbol:                    string | null;
  originalBuyGateDecision:   'BUY_APPROVED_PAPER';
  normalPaperWouldProceed:   true;
  policyTestWouldProceed:    boolean;
  blockedByLiqOrAge:         boolean;
  blockReasons:              string[];
  ageMinutes:                number | null;
  liquidityUsd:              number | null;
  ripperScore:               number | null;
  clusterRisk:               string | null;
  launchAgeBucket:           string | null;
  entryDecision:             string | null;
  actualDecisionPreserved:   true;
  reportOnly:                true;
  readOnly:                  true;
  paperOnly:                 true;
  realTradingLocked:         true;
  tradingExecuted:           0;
}

export interface PaperPolicyTestResult {
  latestCycleFile:          string | null;
  cycleFilesRead:           number;
  approvedAnalyzed:         number;
  rowsAppended:             number;
  duplicatesSkipped:        number;
  policyTestWouldProceed:   number;
  blockedByLiqOrAge:        number;
  blockedByLiquidity:       number;
  blockedByAge:             number;
  actualDecisionsChanged:   0;
  outPath:                  string;
  reportOnly:               true;
  readOnly:                 true;
  tradingExecuted:          0;
  realTradingLocked:        true;
  paperOnly:                true;
}

export interface PaperPolicyTestOptions {
  cyclesDir: string;
  outPath:   string;
  nowMs?:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function policyTestKey(contract: string, cycleFile: string, capturedAt: string): string {
  return `${contract}::${cycleFile}::${capturedAt}`;
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
      const r = JSON.parse(line) as Partial<PaperPolicyTestRow>;
      if (r.contract && r.cycleFile && r.capturedAt) {
        keys.add(policyTestKey(r.contract, r.cycleFile, r.capturedAt));
      }
    } catch { /* skip */ }
  }
  return keys;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runPaperPolicyTest(options: PaperPolicyTestOptions): PaperPolicyTestResult {
  const cycleFiles   = listCycleFiles(options.cyclesDir);
  const existingKeys = readExistingKeys(options.outPath);
  const newRows: PaperPolicyTestRow[] = [];

  let approvedAnalyzed    = 0;
  let duplicatesSkipped   = 0;
  let policyTestProceed   = 0;
  let blockedByLiqOrAge   = 0;
  let blockedByLiquidity  = 0;
  let blockedByAge        = 0;

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

        const key = policyTestKey(contract, cycleFile, capturedAt);
        if (existingKeys.has(key)) { duplicatesSkipped++; continue; }
        existingKeys.add(key);

        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;

        const symbol:          string | null = typeof ns?.['symbol']       === 'string' ? ns['symbol'] as string       : null;
        const ripperScore:     number | null = typeof f['ripperScore']     === 'number' ? f['ripperScore'] as number    : null;
        const clusterRisk:     string | null = typeof raw?.['clusterRisk'] === 'string' ? raw['clusterRisk'] as string  : null;
        const launchAgeBucket: string | null = typeof f['launchAgeBucket'] === 'string' ? f['launchAgeBucket'] as string: null;
        const entryDecision:   string | null = typeof f['entryDecision']   === 'string' ? f['entryDecision'] as string  : null;
        const ageMinutes:      number | null = typeof f['ageMinutes']      === 'number' ? f['ageMinutes'] as number      : null;
        const liquidityUsd:    number | null = typeof ns?.['liquidityUsd'] === 'number' ? ns['liquidityUsd'] as number   : null;

        const liqLt10k  = liquidityUsd != null && liquidityUsd < 10_000;
        const ageGte10m = ageMinutes   != null && ageMinutes   >= 10;
        const blocked   = liqLt10k || ageGte10m;

        const blockReasons: string[] = [];
        if (liqLt10k)  blockReasons.push('liquidityUsd < $10k');
        if (ageGte10m) blockReasons.push('ageMinutes >= 10');

        if (blocked) {
          blockedByLiqOrAge++;
          if (liqLt10k)  blockedByLiquidity++;
          if (ageGte10m) blockedByAge++;
        } else {
          policyTestProceed++;
        }

        newRows.push({
          capturedAt,
          cycleFile,
          contract,
          symbol,
          originalBuyGateDecision: 'BUY_APPROVED_PAPER',
          normalPaperWouldProceed:  true,
          policyTestWouldProceed:   !blocked,
          blockedByLiqOrAge:        blocked,
          blockReasons,
          ageMinutes,
          liquidityUsd,
          ripperScore,
          clusterRisk,
          launchAgeBucket,
          entryDecision,
          actualDecisionPreserved:  true,
          reportOnly:               true,
          readOnly:                 true,
          paperOnly:                true,
          realTradingLocked:        true,
          tradingExecuted:          0,
        });
      } catch { /* skip */ }
    }
  }

  if (newRows.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    fs.appendFileSync(options.outPath, newRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  const latestCycleFile = cycleFiles.length > 0
    ? path.basename(cycleFiles[cycleFiles.length - 1]!)
    : null;

  return {
    latestCycleFile,
    cycleFilesRead:          cycleFiles.length,
    approvedAnalyzed,
    rowsAppended:            newRows.length,
    duplicatesSkipped,
    policyTestWouldProceed:  policyTestProceed,
    blockedByLiqOrAge,
    blockedByLiquidity,
    blockedByAge,
    actualDecisionsChanged:  0,
    outPath:                 options.outPath,
    reportOnly:              true,
    readOnly:                true,
    tradingExecuted:         0,
    realTradingLocked:       true,
    paperOnly:               true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderPaperPolicyTest(result: PaperPolicyTestResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — PAPER POLICY TEST  [liq_OR_age filter]');
  lines.push('  PAPER POLICY TEST ONLY — NORMAL PAPER FLOW UNCHANGED');
  lines.push('  [REPORT ONLY — NO TRADES — NO REAL PAPER POSITIONS CHANGED]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE PRODUCTION GATES');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Latest cycle file              : ${result.latestCycleFile ?? 'none'}`);
  lines.push(`  Cycle files read               : ${result.cycleFilesRead}`);
  lines.push(`  Approved candidates analyzed   : ${result.approvedAnalyzed}`);
  lines.push(`  Rows appended                  : ${result.rowsAppended}`);
  lines.push(`  Duplicates skipped             : ${result.duplicatesSkipped}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  POLICY TEST SPLIT  (liq_OR_age = liquidityUsd < $10k OR ageMinutes >= 10)');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Would proceed in policy test   : ${result.policyTestWouldProceed}`);
  lines.push(`  Blocked by liq_OR_age          : ${result.blockedByLiqOrAge}`);
  lines.push(`    └─ blocked by low liquidity  : ${result.blockedByLiquidity}`);
  lines.push(`    └─ blocked by age >= 10m     : ${result.blockedByAge}`);
  lines.push('');
  lines.push('  Normal paper flow is UNCHANGED. This is a shadow comparison only.');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY CHECKS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Actual decisions changed       : ${result.actualDecisionsChanged}`);
  lines.push('  * Normal BUY_APPROVED_PAPER flow is NOT modified.');
  lines.push('  * No paper-buy triggered. No auto-paper changes.');
  lines.push('  * No wallet access. No real trading.');
  lines.push('  * Output file is append-only policy test log.');
  lines.push('  * DO NOT wire into ripper-autopilot or production gates.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(`  Output: ${result.outPath}`);
  lines.push(SEP, '');
  return lines.join('\n');
}
