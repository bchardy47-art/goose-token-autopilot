import * as fs from 'fs';
import * as path from 'path';
import { readPaperIntents, updateIntentStatuses, type StatusUpdate } from './ripperPaperIntentLedger';
import { extractRipperContract } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CloseoutResolution = 'OBSERVED' | 'EXPIRED_NO_DATA' | 'WAITING_FOR_OBSERVATION';

export interface IntentCloseoutOutcome {
  intentId:      string;
  contract:      string;
  symbol:        string | null;
  targetEntryAt: string;
  resolution:    CloseoutResolution;
  obsFoundAt?:   string;
  expiredReason?: string;
  waitingReason?: string;
  mutated:       boolean;
}

export interface PaperIntentCloseoutResult {
  totalIntents:   number;
  entryDueCount:  number;
  filtered:       number;
  processed:      number;
  observedCount:  number;
  expiredCount:   number;
  waitingCount:   number;
  outcomes:       IntentCloseoutOutcome[];
  dryRun:         boolean;
  reportOnly:     true;
  readOnly:       true;
  paperOnly:      true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface PaperIntentCloseoutOptions {
  intentsPath?:  string;
  memoryPath?:   string;
  obsDir?:       string;
  graceMinutes?: number;
  maxIntents?:   number;
  contract?:     string;
  dryRun?:       boolean;
  nowMs?:        number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_INTENTS_PATH  = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_MEMORY_PATH   = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_OBS_DIR       = 'data/token-grab/ripper/observations';
const DEFAULT_GRACE_MINUTES = 15;

const SAFETY = {
  reportOnly:        true as const,
  readOnly:          true as const,
  paperOnly:         true as const,
  realTradingLocked: true as const,
  tradingExecuted:   0   as const,
};

// ── Observation loading ───────────────────────────────────────────────────────

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

function extractPcp(row: Record<string, unknown>): number | null {
  const ns  = row['normalizedSignal'] as Record<string, unknown> | undefined;
  const raw = row['raw']             as Record<string, unknown> | undefined;
  if (typeof ns?.['priceChangePct']  === 'number') return ns['priceChangePct']  as number;
  if (typeof raw?.['priceChangePct'] === 'number') return raw['priceChangePct'] as number;
  if (typeof row['priceChangePct']   === 'number') return row['priceChangePct'] as number;
  return null;
}

function readJsonlIntoMap(
  filePath: string,
  map: Map<string, ObsEntry[]>,
): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n').filter(l => l.trim().length > 0)) {
    try {
      const row        = JSON.parse(line) as Record<string, unknown>;
      const contract   = extractRipperContract(row);
      const capturedAt = row['capturedAt'] as string | undefined;
      if (!contract || typeof capturedAt !== 'string') continue;
      const list = map.get(contract) ?? [];
      list.push({ capturedAt, priceChangePct: extractPcp(row) });
      map.set(contract, list);
    } catch { /* skip malformed */ }
  }
}

function buildObsMap(opts: {
  intentsPath: string;
  memoryPath:  string;
  obsDir:      string;
}): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();

  // paper-intent-observations.jsonl (same dir as intentsPath)
  const paperObsPath = path.join(
    path.dirname(path.resolve(opts.intentsPath)),
    'paper-intent-observations.jsonl',
  );
  readJsonlIntoMap(paperObsPath, map);

  // learning-memory.jsonl
  readJsonlIntoMap(opts.memoryPath, map);

  // observations/*.jsonl
  if (fs.existsSync(opts.obsDir)) {
    for (const f of fs.readdirSync(opts.obsDir)) {
      if (f.endsWith('.jsonl')) {
        readJsonlIntoMap(path.join(opts.obsDir, f), map);
      }
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return map;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runPaperIntentCloseout(
  options: PaperIntentCloseoutOptions = {},
): PaperIntentCloseoutResult {
  const nowMs        = options.nowMs        ?? Date.now();
  const intentsPath  = options.intentsPath  ?? DEFAULT_INTENTS_PATH;
  const memoryPath   = options.memoryPath   ?? DEFAULT_MEMORY_PATH;
  const obsDir       = options.obsDir ?? DEFAULT_OBS_DIR;
  const graceMinutes = options.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const graceMs      = graceMinutes * 60_000;
  const dryRun       = options.dryRun ?? true;

  const allIntents   = readPaperIntents(intentsPath);
  const totalIntents = allIntents.length;

  let dueIntents     = allIntents.filter(i => i.status === 'ENTRY_DUE');
  const entryDueCount = dueIntents.length;

  if (options.contract != null) {
    dueIntents = dueIntents.filter(i => i.contract === options.contract);
  }

  const filtered = dueIntents.length;

  if (options.maxIntents != null && options.maxIntents > 0) {
    dueIntents = dueIntents.slice(0, options.maxIntents);
  }

  const processed = dueIntents.length;

  const obsMap   = buildObsMap({ intentsPath, memoryPath, obsDir });
  const outcomes: IntentCloseoutOutcome[] = [];
  const updates:  StatusUpdate[]          = [];

  for (const intent of dueIntents) {
    const targetMs       = Date.parse(intent.targetEntryAt);
    const obsForContract = obsMap.get(intent.contract) ?? [];
    const postTargetObs  = obsForContract.find(o => o.capturedAt >= intent.targetEntryAt);

    if (postTargetObs) {
      outcomes.push({
        intentId:      intent.intentId,
        contract:      intent.contract,
        symbol:        intent.symbol,
        targetEntryAt: intent.targetEntryAt,
        resolution:    'OBSERVED',
        obsFoundAt:    postTargetObs.capturedAt,
        mutated:       !dryRun,
      });
      updates.push({
        intentId:       intent.intentId,
        status:         'OBSERVED',
        observedAt:     postTargetObs.capturedAt,
        priceChangePct: postTargetObs.priceChangePct ?? null,
      });
    } else if (nowMs > targetMs + graceMs) {
      outcomes.push({
        intentId:      intent.intentId,
        contract:      intent.contract,
        symbol:        intent.symbol,
        targetEntryAt: intent.targetEntryAt,
        resolution:    'EXPIRED_NO_DATA',
        expiredReason: 'NO_POST_TARGET_OBSERVATION',
        mutated:       !dryRun,
      });
      updates.push({
        intentId:      intent.intentId,
        status:        'EXPIRED_NO_DATA',
        expiredReason: 'NO_POST_TARGET_OBSERVATION',
      });
    } else {
      const msLeft      = targetMs + graceMs - nowMs;
      const minutesLeft = Math.ceil(msLeft / 60_000);
      outcomes.push({
        intentId:      intent.intentId,
        contract:      intent.contract,
        symbol:        intent.symbol,
        targetEntryAt: intent.targetEntryAt,
        resolution:    'WAITING_FOR_OBSERVATION',
        waitingReason: `Within ${graceMinutes}m grace window (${minutesLeft}m left)`,
        mutated:       false,
      });
    }
  }

  if (!dryRun && updates.length > 0) {
    updateIntentStatuses(intentsPath, updates);
  }

  const observedCount = outcomes.filter(o => o.resolution === 'OBSERVED').length;
  const expiredCount  = outcomes.filter(o => o.resolution === 'EXPIRED_NO_DATA').length;
  const waitingCount  = outcomes.filter(o => o.resolution === 'WAITING_FOR_OBSERVATION').length;

  return {
    totalIntents,
    entryDueCount,
    filtered,
    processed,
    observedCount,
    expiredCount,
    waitingCount,
    outcomes,
    dryRun,
    ...SAFETY,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderPaperIntentCloseout(result: PaperIntentCloseoutResult): string {
  const lines: string[] = [];

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  PAPER INTENT CLOSEOUT — REPORT');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('');

  lines.push('§1 SAFETY FLAGS');
  lines.push(`  reportOnly=${result.reportOnly}  readOnly=${result.readOnly}  paperOnly=${result.paperOnly}`);
  lines.push(`  realTradingLocked=${result.realTradingLocked}  tradingExecuted=${result.tradingExecuted}`);
  lines.push(`  dryRun=${result.dryRun}`);
  lines.push('');

  lines.push('§2 INTENT SUMMARY');
  lines.push(`  Total intents in ledger : ${result.totalIntents}`);
  lines.push(`  ENTRY_DUE count         : ${result.entryDueCount}`);
  lines.push(`  Filtered for processing : ${result.filtered}`);
  lines.push(`  Processed               : ${result.processed}`);
  lines.push('');

  lines.push('§3 RESOLUTION COUNTS');
  lines.push(`  OBSERVED              : ${result.observedCount}`);
  lines.push(`  EXPIRED_NO_DATA       : ${result.expiredCount}`);
  lines.push(`  WAITING_FOR_OBS       : ${result.waitingCount}`);
  lines.push('');

  lines.push('§4 OUTCOMES');
  if (result.outcomes.length === 0) {
    lines.push('  (no ENTRY_DUE intents to process)');
  } else {
    for (const o of result.outcomes) {
      lines.push(`  [${o.resolution}] ${o.symbol ?? o.contract}`);
      lines.push(`    intentId      : ${o.intentId}`);
      lines.push(`    contract      : ${o.contract}`);
      lines.push(`    targetEntryAt : ${o.targetEntryAt}`);
      if (o.resolution === 'OBSERVED') {
        lines.push(`    obsFoundAt    : ${o.obsFoundAt}`);
      }
      if (o.resolution === 'EXPIRED_NO_DATA') {
        lines.push(`    expiredReason : ${o.expiredReason}`);
      }
      if (o.resolution === 'WAITING_FOR_OBSERVATION') {
        lines.push(`    waitingReason : ${o.waitingReason}`);
      }
      lines.push(`    mutated       : ${o.mutated}`);
      lines.push('');
    }
  }

  lines.push('══════════════════════════════════════════════════════════');
  return lines.join('\n');
}
