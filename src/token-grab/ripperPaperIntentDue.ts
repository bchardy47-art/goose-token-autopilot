import type { PaperIntent, PaperIntentStatus } from './ripperPaperDecisionPolicy';

export function isPaperIntentOpen(status: PaperIntentStatus): boolean {
  return status === 'PLANNED' || status === 'ENTRY_DUE';
}

export function isPaperIntentDue(intent: PaperIntent, nowMs: number): boolean {
  if (!isPaperIntentOpen(intent.status)) return false;
  return Date.parse(intent.targetEntryAt) <= nowMs;
}

export function getDuePaperIntents(intents: PaperIntent[], nowMs: number): PaperIntent[] {
  return intents.filter(i => isPaperIntentDue(i, nowMs));
}
