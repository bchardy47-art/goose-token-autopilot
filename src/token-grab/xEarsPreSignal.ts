import fs from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PreSignalSource =
  | 'x_manual'
  | 'x_api_future'
  | 'news_manual'
  | 'telegram_manual'
  | 'discord_manual'
  | 'other';

export type PreSignalType =
  | 'launch_mention'
  | 'contract_posted'
  | 'ticker_repetition'
  | 'influencer_mention'
  | 'meme_event'
  | 'breaking_news'
  | 'community_raid'
  | 'unknown';

export type PreSignalConfidence = 'low' | 'medium' | 'high';

export interface PreSignal {
  id: string;
  source: PreSignalSource;
  text: string;
  symbol?: string;
  name?: string;
  contract?: string | null;
  url?: string;
  seenAt: string;
  signalType: PreSignalType;
  confidence: PreSignalConfidence;
  notes?: string;
}

export type PreSignalMatchReason =
  | 'EXACT_CONTRACT'
  | 'SYMBOL_MATCH'
  | 'NAME_MATCH'
  | 'TEXT_WEAK';

export type PreSignalMatchStrength = 'STRONG' | 'MEDIUM' | 'WEAK';

export interface PreSignalAnnotation {
  preSignalMatch: true;
  preSignalReason: PreSignalMatchReason;
  preSignalConfidence: PreSignalConfidence;
  preSignalSource: PreSignalSource;
  laneLabel: 'PRE_SIGNAL_MATCH';
  watchOnly: true;
  planOnlyNotGranted: true;
}

export interface PreSignalCandidate {
  symbol?: string;
  name?: string;
  contract?: string;
}

export interface PreSignalMatchResult {
  signalId: string;
  signalSymbol?: string;
  signalName?: string;
  candidateSymbol?: string;
  candidateName?: string;
  candidateContract?: string;
  reason: PreSignalMatchReason;
  strength: PreSignalMatchStrength;
  confidence: PreSignalConfidence;
  source: PreSignalSource;
  annotation: PreSignalAnnotation;
}

export interface BuildPreSignalReportInput {
  signalsPath?: string;
  rawSignals?: unknown;
  freshCandidates?: PreSignalCandidate[];
  limit?: number;
  generatedAt: string;
}

export interface PreSignalReport {
  readOnly: true;
  tradingExecuted: 0;
  generatedAt: string;
  signalsPath?: string;
  totalSignals: number;
  malformedCount: number;
  bySource: Record<string, number>;
  bySignalType: Record<string, number>;
  byConfidence: Record<string, number>;
  recentSignals: PreSignal[];
  matchResults: PreSignalMatchResult[];
  matchCount: number;
  freshCandidateCount: number;
}

// ── Validation sets ───────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<string>([
  'x_manual', 'x_api_future', 'news_manual', 'telegram_manual', 'discord_manual', 'other',
]);

const VALID_TYPES = new Set<string>([
  'launch_mention', 'contract_posted', 'ticker_repetition', 'influencer_mention',
  'meme_event', 'breaking_news', 'community_raid', 'unknown',
]);

const VALID_CONFIDENCES = new Set<string>(['low', 'medium', 'high']);

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Strips leading `$`, uppercases, and trims. Pure.
 */
export function normalizeSymbol(s: string): string {
  return s.trim().replace(/^\$/, '').toUpperCase().trim();
}

/**
 * Lowercases and removes all non-alphanumeric characters. Pure.
 */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function isValidPreSignal(x: unknown): x is PreSignal {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return false;
  if (!VALID_SOURCES.has(o.source as string)) return false;
  if (typeof o.text !== 'string') return false;
  if (typeof o.seenAt !== 'string') return false;
  if (!VALID_TYPES.has(o.signalType as string)) return false;
  if (!VALID_CONFIDENCES.has(o.confidence as string)) return false;
  return true;
}

/**
 * Parses a raw unknown value into valid PreSignal records, tolerating malformed entries.
 * Pure — no I/O.
 */
export function parsePreSignals(raw: unknown): { valid: PreSignal[]; malformedCount: number } {
  if (!Array.isArray(raw)) {
    if (isValidPreSignal(raw)) return { valid: [raw], malformedCount: 0 };
    return { valid: [], malformedCount: 1 };
  }
  const valid: PreSignal[] = [];
  let malformedCount = 0;
  for (const item of raw) {
    if (isValidPreSignal(item)) valid.push(item);
    else malformedCount++;
  }
  return { valid, malformedCount };
}

/**
 * Loads and parses a pre-signals JSON file. Returns valid signals and malformed count.
 * Returns empty on missing/unreadable file.
 */
export function loadPreSignals(filePath: string): { valid: PreSignal[]; malformedCount: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsePreSignals(raw);
  } catch {
    return { valid: [], malformedCount: 0 };
  }
}

/**
 * Attempts to match a single pre-signal against a single candidate.
 * Returns the strongest match found, or null. Pure.
 *
 * Priority:
 *   1. EXACT_CONTRACT — STRONG
 *   2. SYMBOL_MATCH  — MEDIUM
 *   3. NAME_MATCH    — MEDIUM
 *   4. TEXT_WEAK     — WEAK (signal text contains candidate symbol/name)
 */
export function matchPreSignalToCandidate(
  signal: PreSignal,
  candidate: PreSignalCandidate,
): PreSignalMatchResult | null {
  // 1. Exact contract
  if (
    signal.contract != null &&
    signal.contract.length > 0 &&
    candidate.contract != null &&
    candidate.contract.length > 0 &&
    signal.contract === candidate.contract
  ) {
    return makeMatchResult(signal, candidate, 'EXACT_CONTRACT', 'STRONG');
  }

  // 2. Symbol match
  if (signal.symbol != null && signal.symbol.length > 0 && candidate.symbol != null && candidate.symbol.length > 0) {
    if (normalizeSymbol(signal.symbol) === normalizeSymbol(candidate.symbol)) {
      return makeMatchResult(signal, candidate, 'SYMBOL_MATCH', 'MEDIUM');
    }
  }

  // 3. Name match
  if (signal.name != null && signal.name.length > 0 && candidate.name != null && candidate.name.length > 0) {
    if (normalizeName(signal.name) === normalizeName(candidate.name)) {
      return makeMatchResult(signal, candidate, 'NAME_MATCH', 'MEDIUM');
    }
  }

  // 4. Weak text match — signal text contains candidate symbol or name (min 3 chars to avoid false positives)
  const lowerText = signal.text.toLowerCase();
  if (candidate.symbol != null && candidate.symbol.length >= 3) {
    const normSym = normalizeSymbol(candidate.symbol).toLowerCase();
    if (normSym.length >= 3 && lowerText.includes(normSym)) {
      return makeMatchResult(signal, candidate, 'TEXT_WEAK', 'WEAK');
    }
  }
  if (candidate.name != null && candidate.name.length >= 3) {
    const normNm = normalizeName(candidate.name);
    if (normNm.length >= 3 && lowerText.replace(/[^a-z0-9]/g, '').includes(normNm)) {
      return makeMatchResult(signal, candidate, 'TEXT_WEAK', 'WEAK');
    }
  }

  return null;
}

function makeMatchResult(
  signal: PreSignal,
  candidate: PreSignalCandidate,
  reason: PreSignalMatchReason,
  strength: PreSignalMatchStrength,
): PreSignalMatchResult {
  return {
    signalId: signal.id,
    signalSymbol: signal.symbol,
    signalName: signal.name,
    candidateSymbol: candidate.symbol,
    candidateName: candidate.name,
    candidateContract: candidate.contract,
    reason,
    strength,
    confidence: signal.confidence,
    source: signal.source,
    annotation: {
      preSignalMatch: true,
      preSignalReason: reason,
      preSignalConfidence: signal.confidence,
      preSignalSource: signal.source,
      laneLabel: 'PRE_SIGNAL_MATCH',
      watchOnly: true,
      planOnlyNotGranted: true,
    },
  };
}

/**
 * Matches all pre-signals against all candidates. Returns every match found. Pure.
 */
export function matchAllPreSignals(
  signals: PreSignal[],
  candidates: PreSignalCandidate[],
): PreSignalMatchResult[] {
  const results: PreSignalMatchResult[] = [];
  for (const signal of signals) {
    for (const candidate of candidates) {
      const m = matchPreSignalToCandidate(signal, candidate);
      if (m != null) results.push(m);
    }
  }
  return results;
}

/**
 * Builds the full pre-signal intake report. Pure — accepts rawSignals so I/O
 * is the caller's responsibility.
 */
export function buildPreSignalReport(input: BuildPreSignalReportInput): PreSignalReport {
  const rawData = input.rawSignals ?? [];
  const { valid, malformedCount } = parsePreSignals(rawData);

  const limit = input.limit ?? 20;
  const recentSignals = valid.slice(-limit);

  const bySource: Record<string, number> = {};
  const bySignalType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const s of valid) {
    bySource[s.source] = (bySource[s.source] ?? 0) + 1;
    bySignalType[s.signalType] = (bySignalType[s.signalType] ?? 0) + 1;
    byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
  }

  const freshCandidates = input.freshCandidates ?? [];
  const matchResults = matchAllPreSignals(valid, freshCandidates);

  return {
    readOnly: true,
    tradingExecuted: 0,
    generatedAt: input.generatedAt,
    signalsPath: input.signalsPath,
    totalSignals: valid.length,
    malformedCount,
    bySource,
    bySignalType,
    byConfidence,
    recentSignals,
    matchResults,
    matchCount: matchResults.length,
    freshCandidateCount: freshCandidates.length,
  };
}

/**
 * Renders a human-readable text report. Pure — no I/O.
 */
export function renderPreSignalReport(report: PreSignalReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB X EARS PRE-SIGNAL INTAKE V1');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Generated at  : ${report.generatedAt}`);
  if (report.signalsPath) lines.push(`  Signals file  : ${report.signalsPath}`);
  lines.push(`  Total signals : ${report.totalSignals}`);
  lines.push(`  Malformed     : ${report.malformedCount}`);
  lines.push('');

  lines.push(THIN);
  lines.push('By Source');
  lines.push(THIN);
  if (Object.keys(report.bySource).length === 0) {
    lines.push('  (no signals)');
  } else {
    for (const [k, v] of Object.entries(report.bySource)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(THIN);
  lines.push('By Signal Type');
  lines.push(THIN);
  if (Object.keys(report.bySignalType).length === 0) {
    lines.push('  (no signals)');
  } else {
    for (const [k, v] of Object.entries(report.bySignalType)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(THIN);
  lines.push('By Confidence');
  lines.push(THIN);
  if (Object.keys(report.byConfidence).length === 0) {
    lines.push('  (no signals)');
  } else {
    for (const [k, v] of Object.entries(report.byConfidence)) {
      lines.push(`  ${k.padEnd(24)} : ${v}`);
    }
  }
  lines.push('');

  lines.push(THIN);
  lines.push('Recent Signals');
  lines.push(THIN);
  if (report.recentSignals.length === 0) {
    lines.push('  (no signals)');
  } else {
    for (const sig of report.recentSignals) {
      const symLabel = sig.symbol ? `$${normalizeSymbol(sig.symbol)}` : '(no symbol)';
      lines.push(`  [${sig.id}] ${symLabel} | ${sig.signalType} | ${sig.confidence} | ${sig.source}`);
      lines.push(`    seenAt   : ${sig.seenAt}`);
      const preview = sig.text.length > 80 ? sig.text.slice(0, 80) + '…' : sig.text;
      lines.push(`    text     : ${preview}`);
      if (sig.contract) lines.push(`    contract : ${sig.contract}`);
      if (sig.notes) lines.push(`    notes    : ${sig.notes}`);
      lines.push('');
    }
  }

  lines.push(THIN);
  lines.push(`Fresh Candidate Matches (${report.freshCandidateCount} candidate${report.freshCandidateCount === 1 ? '' : 's'} checked)`);
  lines.push(THIN);
  if (report.matchResults.length === 0) {
    lines.push('  No matches found.');
    lines.push('  (PRE_SIGNAL_MATCH is WATCH ONLY — does not create PLAN_ONLY)');
  } else {
    for (const m of report.matchResults) {
      const candLabel = m.candidateSymbol ? `$${m.candidateSymbol}` : m.candidateName ?? '(unknown)';
      lines.push(`  Signal ${m.signalId} → Candidate ${candLabel}`);
      lines.push(`    Match reason  : ${m.reason}`);
      lines.push(`    Strength      : ${m.strength}`);
      lines.push(`    Confidence    : ${m.confidence}`);
      lines.push(`    Source        : ${m.source}`);
      lines.push(`    Lane label    : ${m.annotation.laneLabel} / WATCH ONLY`);
      lines.push(`    PLAN_ONLY     : NOT GRANTED — existing confirmation gates still required`);
      lines.push('');
    }
  }

  lines.push(WIDE);
  lines.push('  READ-ONLY REPORT — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  PRE_SIGNAL_MATCH is WATCH ONLY — not a buy signal');
  lines.push('  Existing confirmation gates still required for PLAN_ONLY');
  lines.push('  token:auto-paper was NOT run');
  lines.push(WIDE);

  return lines.join('\n');
}
