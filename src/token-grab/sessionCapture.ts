import fs from 'node:fs';
import path from 'node:path';
import type { TokenGrabReport } from './types';
import type { TokenGrabAutopsyCandidate } from './autopsy';

// ── Session file shape ────────────────────────────────────────────────────────

export interface TokenGrabSessionFile {
  schema: 'token-grab-session-v1';
  generatedAt: string;
  source: {
    social: 'none' | 'fixture' | 'x-ears';
    freshPools: 'none' | 'local' | 'geckoterminal' | 'mixed';
    events: 'none' | 'local';
  };
  flags: {
    geckoFreshPools: boolean;
    geckoLimit?: number;
    freshPoolsPath?: string;
    eventsPath?: string;
    fixturePath?: string;
  };
  summary: TokenGrabReport['summary'];
  candidates: TokenGrabAutopsyCandidate[];
  safety: {
    reportOnly: true;
    noTradingExecuted: true;
    tradingExecuted: 0;
    dbWrites: false;
    scheduler: false;
  };
}

// ── Converter ─────────────────────────────────────────────────────────────────

export function tokenGrabReportToAutopsyCandidates(
  report: TokenGrabReport,
): TokenGrabAutopsyCandidate[] {
  return report.candidates.map((c): TokenGrabAutopsyCandidate => ({
    id: c.id,
    tokenName: c.tokenName ?? c.ticker ?? '(unknown)',
    ticker: c.ticker ?? c.tokenName ?? '(unknown)',
    contractAddress: c.contractAddress,
    poolAddress: c.poolAddress,
    lane: c.lane,
    decision: c.decision,
    scoreAtDetection: c.score,
    detectedAt: c.firstSeenAt,
    poolCreatedAt: c.poolCreatedAt,
    reasons: c.reasons,
    redFlags: c.redFlags,
  }));
}

// ── Save ──────────────────────────────────────────────────────────────────────

export function saveTokenGrabSession(filePath: string, session: TokenGrabSessionFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

// ── Load ──────────────────────────────────────────────────────────────────────

export function loadTokenGrabSession(filePath: string): TokenGrabSessionFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(
      `[loadTokenGrabSession] Cannot read file: ${filePath} — ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `[loadTokenGrabSession] Invalid JSON in: ${filePath} — ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`[loadTokenGrabSession] Expected a JSON object in: ${filePath}`);
  }

  const session = parsed as Record<string, unknown>;
  if (session['schema'] !== 'token-grab-session-v1') {
    throw new Error(
      `[loadTokenGrabSession] Invalid schema: expected 'token-grab-session-v1', got '${String(session['schema'])}' in: ${filePath}`,
    );
  }

  if (!Array.isArray(session['candidates'])) {
    throw new Error(
      `[loadTokenGrabSession] Missing or invalid 'candidates' array in: ${filePath}`,
    );
  }

  return parsed as TokenGrabSessionFile;
}
