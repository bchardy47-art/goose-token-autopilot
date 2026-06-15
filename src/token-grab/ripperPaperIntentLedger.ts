import * as fs from 'fs';
import * as path from 'path';
import type { PaperIntent, PaperIntentStatus } from './ripperPaperDecisionPolicy';

// ── Dedup key ─────────────────────────────────────────────────────────────────

function intentKey(intent: PaperIntent): string {
  return `${intent.contract}::${intent.targetEntryAt}::${intent.reason}`;
}

// ── Readers ───────────────────────────────────────────────────────────────────

export function readPaperIntents(ledgerPath: string): PaperIntent[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0);
  const intents: PaperIntent[] = [];
  for (const line of lines) {
    try { intents.push(JSON.parse(line) as PaperIntent); } catch { /* skip malformed */ }
  }
  return intents;
}

// ── Append (dedup against existing) ──────────────────────────────────────────

export function appendPaperIntents(
  ledgerPath: string,
  newIntents: PaperIntent[],
): { appended: number; deduped: number } {
  fs.mkdirSync(path.dirname(path.resolve(ledgerPath)), { recursive: true });

  const existing    = readPaperIntents(ledgerPath);
  const existingKeys = new Set(existing.map(intentKey));

  const toAppend = newIntents.filter(i => !existingKeys.has(intentKey(i)));
  const deduped  = newIntents.length - toAppend.length;

  if (toAppend.length > 0) {
    const lines = toAppend.map(i => JSON.stringify(i)).join('\n') + '\n';
    fs.appendFileSync(ledgerPath, lines, 'utf-8');
  }

  return { appended: toAppend.length, deduped };
}

// ── Status update (rewrites file) ─────────────────────────────────────────────

export interface StatusUpdate {
  intentId:      string;
  status:        PaperIntentStatus;
  observedAt?:   string;
  priceChangePct?: number | null;
}

export function updateIntentStatuses(
  ledgerPath: string,
  updates: StatusUpdate[],
): { updated: number } {
  if (!fs.existsSync(ledgerPath)) return { updated: 0 };

  const updateMap = new Map<string, StatusUpdate>();
  for (const u of updates) updateMap.set(u.intentId, u);

  const intents = readPaperIntents(ledgerPath);
  let updated = 0;
  const written = intents.map(intent => {
    const upd = updateMap.get(intent.intentId);
    if (!upd) return intent;
    updated++;
    const next: PaperIntent = { ...intent, status: upd.status };
    if (upd.observedAt    !== undefined) (next as Record<string, unknown>)['observedAt']    = upd.observedAt;
    if (upd.priceChangePct !== undefined) (next as Record<string, unknown>)['priceChangePct'] = upd.priceChangePct;
    return next;
  });

  const content = written.length > 0
    ? written.map(i => JSON.stringify(i)).join('\n') + '\n'
    : '';
  fs.writeFileSync(ledgerPath, content, 'utf-8');
  return { updated };
}
