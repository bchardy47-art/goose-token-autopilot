import fs from 'node:fs';
import type { FreshPool, EventSignal } from './types';

function readJsonArray(filePath: string, label: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`[${label}] Cannot read file: ${filePath} — ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[${label}] Invalid JSON in: ${filePath} — ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[${label}] Expected JSON array in: ${filePath}`);
  }
  return parsed;
}

export function loadFreshPoolsFromFile(filePath: string): FreshPool[] {
  return readJsonArray(filePath, 'loadFreshPools') as FreshPool[];
}

export function loadEventSignalsFromFile(filePath: string): EventSignal[] {
  return readJsonArray(filePath, 'loadEventSignals') as EventSignal[];
}
