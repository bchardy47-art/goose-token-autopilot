import * as fs from 'fs';
import * as path from 'path';
import {
  applyPaperDecisionPolicy,
  type ApprovedFixtureInput,
  type PaperIntent,
} from './ripperPaperDecisionPolicy';
import {
  readPaperIntents,
  appendPaperIntents,
  updateIntentStatuses,
  type StatusUpdate,
} from './ripperPaperIntentLedger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperAutopilotCycleOptions {
  cyclesDir?:       string;
  observationsDir?: string;
  intentsPath?:     string;
  maxAgeMinutes?:   number;
  nowMs?:           number;
  dryRun?:          boolean;
}

export interface RipperPaperAutopilotCycleResult {
  latestCycleFile:      string | null;
  fixturesRead:         number;
  buyApprovedPaper:     number;
  intentsCreated:       number;
  intentsDeduplicated:  number;
  enterNowCount:        number;
  wait10mCount:         number;
  dueIntentsCount:      number;
  observationsCaptured: number;
  expiredNoDataCount:   number;
  dryRun:               boolean;
  reportOnly:           true;
  readOnly:             true;
  tradingExecuted:      0;
  realTradingLocked:    true;
  paperOnly:            true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_CYCLES_DIR       = 'data/token-grab/ripper/cycles';
const DEFAULT_OBSERVATIONS_DIR = 'data/token-grab/ripper/observations';
const DEFAULT_INTENTS_PATH     = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_MAX_AGE_MINUTES  = 20;

function findLatestCycleFile(cyclesDir: string): string | null {
  if (!fs.existsSync(cyclesDir)) return null;
  const files = fs.readdirSync(cyclesDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl') && !f.includes('-feed'))
    .sort();
  if (files.length === 0) return null;
  return path.join(cyclesDir, files[files.length - 1]);
}

function readFixturesFromCycle(cycleFile: string): Record<string, unknown>[] {
  if (!fs.existsSync(cycleFile)) return [];
  const lines = fs.readFileSync(cycleFile, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  const fixtures: Record<string, unknown>[] = [];
  for (const line of lines) {
    try { fixtures.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
  }
  return fixtures;
}

function extractApproved(fixtures: Record<string, unknown>[], sourceCycle: string): ApprovedFixtureInput[] {
  const approved: ApprovedFixtureInput[] = [];
  for (const f of fixtures) {
    if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
    const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
    const raw = f['raw']             as Record<string, unknown> | undefined;
    const contract = (ns?.['contract'] ?? raw?.['contract']) as string | undefined;
    if (!contract) continue;
    const capturedAt = f['capturedAt'] as string | undefined;
    if (!capturedAt) continue;

    const clusterV = raw?.['clusterRisk'];
    const clusterRisk = (clusterV === 'CLEAN' || clusterV === 'WATCH' || clusterV === 'RISKY')
      ? clusterV : 'UNKNOWN';

    approved.push({
      contract,
      symbol:          (ns?.['symbol'] as string | undefined) ?? null,
      approvedAt:      capturedAt,
      clusterRisk,
      ripperScore:     typeof f['ripperScore'] === 'number'     ? f['ripperScore']     : null,
      launchAgeBucket: typeof f['launchAgeBucket'] === 'string' ? f['launchAgeBucket'] : null,
      entryDecision:   typeof f['entryDecision']   === 'string' ? f['entryDecision']   : null,
      sourceCycle,
    });
  }
  return approved;
}

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

function buildObsByContract(observationsDir: string): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();
  if (!fs.existsSync(observationsDir)) return map;

  const files = fs.readdirSync(observationsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(observationsDir, f));

  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f   = JSON.parse(line) as Record<string, unknown>;
        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const contract   = (ns?.['contract'] ?? raw?.['contract']) as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        let pct: number | null = null;
        if (typeof ns?.['priceChangePct'] === 'number')       pct = ns['priceChangePct']  as number;
        else if (typeof raw?.['priceChangePct'] === 'number') pct = raw['priceChangePct'] as number;
        const list = map.get(contract) ?? [];
        list.push({ capturedAt, priceChangePct: pct });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return map;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperPaperAutopilotCycle(
  options: RipperPaperAutopilotCycleOptions = {},
): RipperPaperAutopilotCycleResult {
  const nowMs          = options.nowMs ?? Date.now();
  const cyclesDir      = options.cyclesDir      ?? DEFAULT_CYCLES_DIR;
  const observationsDir = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR;
  const intentsPath    = options.intentsPath    ?? DEFAULT_INTENTS_PATH;
  const maxAgeMinutes  = options.maxAgeMinutes  ?? DEFAULT_MAX_AGE_MINUTES;
  const dryRun         = options.dryRun ?? false;

  // Step 1: Find latest cycle file
  const latestCycleFile = findLatestCycleFile(cyclesDir);
  if (!latestCycleFile) {
    return {
      latestCycleFile:      null,
      fixturesRead:         0,
      buyApprovedPaper:     0,
      intentsCreated:       0,
      intentsDeduplicated:  0,
      enterNowCount:        0,
      wait10mCount:         0,
      dueIntentsCount:      0,
      observationsCaptured: 0,
      expiredNoDataCount:   0,
      dryRun,
      reportOnly:           true,
      readOnly:             true,
      tradingExecuted:      0,
      realTradingLocked:    true,
      paperOnly:            true,
    };
  }

  const cycleSlug = path.basename(latestCycleFile, '.jsonl');

  // Step 2: Read and filter fixtures
  const allFixtures     = readFixturesFromCycle(latestCycleFile);
  const approved        = extractApproved(allFixtures, cycleSlug);
  const fixturesRead    = allFixtures.length;
  const buyApprovedPaper = approved.length;

  // Step 3: Apply policy
  const newIntents      = approved.map(f => applyPaperDecisionPolicy(f));
  const enterNowCount   = newIntents.filter(i => i.paperEntryTiming === 'ENTER_NOW').length;
  const wait10mCount    = newIntents.filter(i => i.paperEntryTiming === 'WAIT_10M').length;

  // Step 4 & 5: Append new intents (deduped)
  let intentsCreated = 0;
  let intentsDeduplicated = 0;
  if (!dryRun && newIntents.length > 0) {
    const appendResult = appendPaperIntents(intentsPath, newIntents);
    intentsCreated     = appendResult.appended;
    intentsDeduplicated = appendResult.deduped;
  } else {
    // In dry-run or no new intents, compute what would happen
    const existing      = readPaperIntents(intentsPath);
    const existingKeys  = new Set(existing.map(i => `${i.contract}::${i.targetEntryAt}::${i.reason}`));
    intentsCreated      = newIntents.filter(i => !existingKeys.has(`${i.contract}::${i.targetEntryAt}::${i.reason}`)).length;
    intentsDeduplicated = newIntents.length - intentsCreated;
  }

  // Step 6: Mark due intents as ENTRY_DUE
  const allIntents = readPaperIntents(intentsPath);
  const nowIso     = new Date(nowMs).toISOString();
  const maxAgeMs   = maxAgeMinutes * 60_000;

  const dueUpdates: StatusUpdate[] = [];
  const expiredUpdates: StatusUpdate[] = [];

  for (const intent of allIntents) {
    if (intent.status !== 'PLANNED') continue;
    const targetMs = Date.parse(intent.targetEntryAt);
    if (targetMs <= nowMs) {
      // Check if expired (too old)
      if (nowMs - targetMs > maxAgeMs) {
        expiredUpdates.push({ intentId: intent.intentId, status: 'EXPIRED_NO_DATA' });
      } else {
        dueUpdates.push({ intentId: intent.intentId, status: 'ENTRY_DUE' });
      }
    }
  }

  if (!dryRun && (dueUpdates.length > 0 || expiredUpdates.length > 0)) {
    updateIntentStatuses(intentsPath, [...dueUpdates, ...expiredUpdates]);
  }

  const dueIntentsCount    = dueUpdates.length;
  const expiredNoDataCount = expiredUpdates.length;

  // Step 7: Capture observations for due intents (read-only lookup)
  const obsByContract = buildObsByContract(observationsDir);
  let observationsCaptured = 0;
  const observedUpdates: StatusUpdate[] = [];

  // Re-read after status update
  const postUpdateIntents = dryRun ? allIntents : readPaperIntents(intentsPath);
  const dueIntents = postUpdateIntents.filter(i => i.status === 'ENTRY_DUE');

  for (const intent of dueIntents) {
    const obsForContract = obsByContract.get(intent.contract) ?? [];
    const obs = obsForContract.find(o => o.capturedAt >= intent.targetEntryAt);
    if (obs) {
      observationsCaptured++;
      observedUpdates.push({
        intentId:      intent.intentId,
        status:        'OBSERVED',
        observedAt:    obs.capturedAt,
        priceChangePct: obs.priceChangePct,
      });
    }
  }

  if (!dryRun && observedUpdates.length > 0) {
    updateIntentStatuses(intentsPath, observedUpdates);
  }

  return {
    latestCycleFile,
    fixturesRead,
    buyApprovedPaper,
    intentsCreated,
    intentsDeduplicated,
    enterNowCount,
    wait10mCount,
    dueIntentsCount,
    observationsCaptured,
    expiredNoDataCount,
    dryRun,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperPaperAutopilotCycle(
  result: RipperPaperAutopilotCycleResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER PAPER AUTOPILOT CYCLE');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  if (result.dryRun) lines.push('  MODE: DRY-RUN (no writes)', '');

  lines.push(`  ${SEP2}`);
  lines.push('  CYCLE SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Latest cycle file     : ${result.latestCycleFile ?? 'NONE'}`);
  lines.push(`  Fixtures read         : ${result.fixturesRead}`);
  lines.push(`  BUY_APPROVED_PAPER    : ${result.buyApprovedPaper}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  PAPER INTENTS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Intents created       : ${result.intentsCreated}`);
  lines.push(`  Duplicate skipped     : ${result.intentsDeduplicated}`);
  lines.push(`  ENTER_NOW             : ${result.enterNowCount}`);
  lines.push(`  WAIT_10M              : ${result.wait10mCount}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  OBSERVATIONS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Due intents           : ${result.dueIntentsCount}`);
  lines.push(`  Observations captured : ${result.observationsCaptured}`);
  lines.push(`  Expired / no data     : ${result.expiredNoDataCount}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
