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
import { isPaperIntentOpen } from './ripperPaperIntentDue';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperAutopilotCycleOptions {
  cyclesDir?:       string;
  observationsDir?: string;
  dexWatchDir?:     string;
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
  totalIntentsInLedger: number;
  openIntentsCount:     number;
  dueBeforeUpdate:      number;
  newlyMarkedDue:       number;
  dueIntentsCount:      number;
  observationsCaptured: number;
  expiredNoDataCount:   number;
  paperObsPath:         string;
  paperObsWritten:      number;
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
const DEFAULT_DEX_WATCH_DIR    = 'data/token-grab/dex-watch-runs';
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

function listAllCyclePaths(cyclesDir: string): string[] {
  if (!fs.existsSync(cyclesDir)) return [];
  return fs.readdirSync(cyclesDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl') && !f.includes('-feed'))
    .map(f => path.join(cyclesDir, f));
}

function listObsPaths(observationsDir: string): string[] {
  if (!fs.existsSync(observationsDir)) return [];
  return fs.readdirSync(observationsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(observationsDir, f));
}

function listDexWatchPaths(dexWatchDir: string): string[] {
  if (!fs.existsSync(dexWatchDir)) return [];
  return fs.readdirSync(dexWatchDir)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .map(f => path.join(dexWatchDir, f));
}

// Extract obs entries from a dex-watch run JSON file (winners/losers/flat/topMovers arrays).
// Uses final.observedAt as capturedAt so the timestamp is after the watch period.
function extractDexWatchObs(
  content: string,
): Array<{ contract: string; capturedAt: string; priceChangePct: number | null }> {
  try {
    const d          = JSON.parse(content) as Record<string, unknown>;
    const fallbackAt = d['generatedAt'] as string | undefined;
    const result: Array<{ contract: string; capturedAt: string; priceChangePct: number | null }> = [];
    for (const key of ['winners', 'losers', 'flat', 'topMovers']) {
      const arr = d[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr as Record<string, unknown>[]) {
        const contract = typeof item['contract'] === 'string' ? item['contract'] : null;
        if (!contract) continue;
        const pct        = typeof item['priceChangePct'] === 'number' ? (item['priceChangePct'] as number) : null;
        const finalSnap  = item['final'] as Record<string, unknown> | undefined;
        const capturedAt = (typeof finalSnap?.['observedAt'] === 'string' ? finalSnap['observedAt'] : null)
          ?? fallbackAt;
        if (!capturedAt) continue;
        result.push({ contract, capturedAt, priceChangePct: pct });
      }
    }
    return result;
  } catch { return []; }
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
    const contract = extractRipperContract(f);
    if (!contract) continue;
    const capturedAt = f['capturedAt'] as string | undefined;
    if (!capturedAt) continue;
    const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
    const raw = f['raw']             as Record<string, unknown> | undefined;
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

// Build observation map from JSONL paths and/or dex-watch run JSON paths.
function buildObsFromPaths(filePaths: string[]): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();

  function addEntry(contract: string, capturedAt: string, priceChangePct: number | null) {
    const list = map.get(contract) ?? [];
    list.push({ capturedAt, priceChangePct });
    map.set(contract, list);
  }

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.json')) {
      // dex-watch run JSON format
      for (const e of extractDexWatchObs(content)) {
        addEntry(e.contract, e.capturedAt, e.priceChangePct);
      }
    } else {
      // Standard JSONL observation format
      for (const line of content.split('\n').filter(l => l.trim().length > 0)) {
        try {
          const f          = JSON.parse(line) as Record<string, unknown>;
          const contract   = extractRipperContract(f);
          const capturedAt = f['capturedAt'] as string | undefined;
          if (!contract || !capturedAt) continue;
          addEntry(contract, capturedAt, extractRipperPriceChangePct(f));
        } catch { /* skip */ }
      }
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
  const nowMs           = options.nowMs ?? Date.now();
  const cyclesDir       = options.cyclesDir       ?? DEFAULT_CYCLES_DIR;
  const observationsDir = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR;
  const dexWatchDir     = options.dexWatchDir     ?? DEFAULT_DEX_WATCH_DIR;
  const intentsPath     = options.intentsPath     ?? DEFAULT_INTENTS_PATH;
  const maxAgeMinutes   = options.maxAgeMinutes   ?? DEFAULT_MAX_AGE_MINUTES;
  const dryRun          = options.dryRun ?? false;

  const paperObsPath = path.join(
    path.dirname(path.resolve(intentsPath)),
    'paper-intent-observations.jsonl',
  );

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
      totalIntentsInLedger: 0,
      openIntentsCount:     0,
      dueBeforeUpdate:      0,
      newlyMarkedDue:       0,
      dueIntentsCount:      0,
      observationsCaptured: 0,
      expiredNoDataCount:   0,
      paperObsPath,
      paperObsWritten:      0,
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
  const allFixtures      = readFixturesFromCycle(latestCycleFile);
  const approved         = extractApproved(allFixtures, cycleSlug);
  const fixturesRead     = allFixtures.length;
  const buyApprovedPaper = approved.length;

  // Step 3: Apply policy
  const newIntents    = approved.map(f => applyPaperDecisionPolicy(f));
  const enterNowCount = newIntents.filter(i => i.paperEntryTiming === 'ENTER_NOW').length;
  const wait10mCount  = newIntents.filter(i => i.paperEntryTiming === 'WAIT_10M').length;

  // Step 4 & 5: Append new intents (deduped)
  let intentsCreated      = 0;
  let intentsDeduplicated = 0;
  if (!dryRun && newIntents.length > 0) {
    const appendResult  = appendPaperIntents(intentsPath, newIntents);
    intentsCreated      = appendResult.appended;
    intentsDeduplicated = appendResult.deduped;
  } else {
    const existing     = readPaperIntents(intentsPath);
    const existingKeys = new Set(existing.map(i => `${i.contract}::${i.targetEntryAt}::${i.reason}`));
    intentsCreated      = newIntents.filter(i => !existingKeys.has(`${i.contract}::${i.targetEntryAt}::${i.reason}`)).length;
    intentsDeduplicated = newIntents.length - intentsCreated;
  }

  // Step 6: Transition PLANNED intents to ENTRY_DUE or EXPIRED_NO_DATA.
  // ENTRY_DUE intents are handled in Step 7 (obs capture first, then expire if no obs).
  const allIntents           = readPaperIntents(intentsPath);
  const maxAgeMs             = maxAgeMinutes * 60_000;
  const totalIntentsInLedger = allIntents.length;
  const openIntentsCount     = allIntents.filter(i => isPaperIntentOpen(i.status)).length;
  const dueBeforeUpdate      = allIntents.filter(i => i.status === 'ENTRY_DUE').length;

  const dueUpdates:            StatusUpdate[] = [];
  const plannedExpiredUpdates: StatusUpdate[] = [];

  for (const intent of allIntents) {
    if (intent.status !== 'PLANNED') continue;
    const targetMs = Date.parse(intent.targetEntryAt);
    if (targetMs > nowMs) continue;
    if (nowMs - targetMs > maxAgeMs) {
      plannedExpiredUpdates.push({ intentId: intent.intentId, status: 'EXPIRED_NO_DATA' });
    } else {
      dueUpdates.push({ intentId: intent.intentId, status: 'ENTRY_DUE' });
    }
  }

  if (!dryRun && (dueUpdates.length > 0 || plannedExpiredUpdates.length > 0)) {
    updateIntentStatuses(intentsPath, [...dueUpdates, ...plannedExpiredUpdates]);
  }

  const newlyMarkedDue = dueUpdates.length;

  // Step 7: Capture observations for ALL ENTRY_DUE intents (pre-existing + newly-marked).
  // Scan obs dir AND all cycle files — cycle files contain real priceChangePct data.
  // ENTRY_DUE intents past maxAge get one chance to find obs; if none found, they expire.
  const allObsPaths    = listObsPaths(observationsDir);
  const dexWatchPaths  = listDexWatchPaths(dexWatchDir);
  const allCyclePaths  = listAllCyclePaths(cyclesDir);
  const obsByContract  = buildObsFromPaths([...allObsPaths, ...dexWatchPaths, ...allCyclePaths]);

  let observationsCaptured = 0;
  const observedUpdates:       StatusUpdate[] = [];
  const dueExpiredUpdates:     StatusUpdate[] = [];

  // Re-read after Step 6 to include newly-marked ENTRY_DUE
  const postUpdateIntents = dryRun ? allIntents : readPaperIntents(intentsPath);
  const dueIntents        = postUpdateIntents.filter(i => i.status === 'ENTRY_DUE');
  const dueIntentsCount   = dueIntents.length;

  for (const intent of dueIntents) {
    const obsForContract = obsByContract.get(intent.contract) ?? [];
    const obs = obsForContract.find(o => o.capturedAt >= intent.targetEntryAt && o.priceChangePct != null);
    if (obs) {
      observationsCaptured++;
      observedUpdates.push({
        intentId:       intent.intentId,
        status:         'OBSERVED',
        observedAt:     obs.capturedAt,
        priceChangePct: obs.priceChangePct,
      });
    } else {
      const targetMs = Date.parse(intent.targetEntryAt);
      if (nowMs - targetMs > maxAgeMs) {
        dueExpiredUpdates.push({ intentId: intent.intentId, status: 'EXPIRED_NO_DATA' });
      }
    }
  }

  const expiredNoDataCount = plannedExpiredUpdates.length + dueExpiredUpdates.length;

  let paperObsWritten = 0;
  if (!dryRun && (observedUpdates.length > 0 || dueExpiredUpdates.length > 0)) {
    updateIntentStatuses(intentsPath, [...observedUpdates, ...dueExpiredUpdates]);

    // Write paper observation artifacts so downstream reports can use them
    const paperObsLines: string[] = [];
    for (const u of observedUpdates) {
      const intent = dueIntents.find(i => i.intentId === u.intentId);
      if (!intent || !u.observedAt) continue;
      paperObsLines.push(JSON.stringify({
        capturedAt:        u.observedAt,
        source:            'paper-intent-obs',
        sourceKind:        'PAPER_INTENT_OBS',
        intentId:          u.intentId,
        normalizedSignal:  { contract: intent.contract, priceChangePct: u.priceChangePct ?? null },
        raw:               { contract: intent.contract, priceChangePct: u.priceChangePct ?? null },
        realTradingLocked: true,
        paperOnly:         true,
        readOnly:          true,
      }));
    }
    if (paperObsLines.length > 0) {
      fs.mkdirSync(path.dirname(path.resolve(paperObsPath)), { recursive: true });
      fs.appendFileSync(paperObsPath, paperObsLines.join('\n') + '\n', 'utf-8');
      paperObsWritten = paperObsLines.length;
    }
  }

  return {
    latestCycleFile,
    fixturesRead,
    buyApprovedPaper,
    intentsCreated,
    intentsDeduplicated,
    enterNowCount,
    wait10mCount,
    totalIntentsInLedger,
    openIntentsCount,
    dueBeforeUpdate,
    newlyMarkedDue,
    dueIntentsCount,
    observationsCaptured,
    expiredNoDataCount,
    paperObsPath,
    paperObsWritten,
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
  lines.push(`  Total in ledger       : ${result.totalIntentsInLedger}`);
  lines.push(`  Open (PLANNED+DUE)    : ${result.openIntentsCount}`);
  lines.push(`  Due before this run   : ${result.dueBeforeUpdate}`);
  lines.push(`  Newly marked due      : ${result.newlyMarkedDue}`);
  lines.push(`  Due intents total     : ${result.dueIntentsCount}`);
  lines.push(`  Observations captured : ${result.observationsCaptured}`);
  lines.push(`  Expired / no data     : ${result.expiredNoDataCount}`);
  lines.push(`  Paper obs written     : ${result.paperObsWritten}`);
  lines.push(`  Paper obs path        : ${result.paperObsPath}`);
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
