import fs from 'node:fs';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from './autopsy';

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

export function loadAutopsyCandidatesFromFile(filePath: string): TokenGrabAutopsyCandidate[] {
  return readJsonArray(filePath, 'loadAutopsyCandidates') as TokenGrabAutopsyCandidate[];
}

export function loadAutopsySnapshotsFromFile(filePath: string): TokenGrabAutopsySnapshot[] {
  return readJsonArray(filePath, 'loadAutopsySnapshots') as TokenGrabAutopsySnapshot[];
}

export function loadAutopsySnapshotsFromFiles(filePaths: string[]): TokenGrabAutopsySnapshot[] {
  const all: TokenGrabAutopsySnapshot[] = [];
  for (const filePath of filePaths) {
    all.push(...loadAutopsySnapshotsFromFile(filePath));
  }
  return all.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}
