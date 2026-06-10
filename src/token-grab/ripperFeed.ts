import * as fs from 'fs';
import * as path from 'path';
import type { RipperEarSignal } from './ripperEars';

// ── Source priority list ──────────────────────────────────────────────────────

const DEFAULT_SOURCES = [
  {
    filePath:  'data/token-grab/legitimacy/dex-winner-candidates-enriched-offline-today.json',
    kind:      'enriched-candidates' as const,
    nextStep:  'npm run token:dex-candidate-safety-enrich',
  },
  {
    filePath:  'data/token-grab/legitimacy/dex-winner-candidates-today.json',
    kind:      'winner-candidates' as const,
    nextStep:  'npm run token:dex-winner-candidates',
  },
  {
    filePath:  'data/token-grab/legitimacy/dex-legitimacy-report-today.json',
    kind:      'legitimacy-items' as const,
    nextStep:  'npm run token:dex-legitimacy-report',
  },
];

type SourceKind = (typeof DEFAULT_SOURCES)[number]['kind'];

const GENERATE_STEPS = [
  '  1. npm run token:dex-day-watch        (collect pool signals)',
  '  2. npm run token:dex-legitimacy-report (score legitimacy)',
  '  3. npm run token:dex-winner-candidates (pick candidates)',
  '  4. npm run token:dex-candidate-safety-enrich (safety check)',
  '  5. npm run token:ripper-feed          (this command)',
  '  6. npm run token:live-fixture-capture (capture to JSONL)',
];

// ── Thin source types (only what we read) ────────────────────────────────────

interface WinnerCandidateRaw {
  tier?: string;
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  paperExitReason?: string;
  confidence?: string;
  reasons?: string[];
  missingSafetySignals?: string[];
  [key: string]: unknown;
}

interface EnrichedCandidateRaw extends WinnerCandidateRaw {
  originalTier?: string;
  mintAuthorityStatus?: string;
  freezeAuthorityStatus?: string;
  holderConcentrationStatus?: string;
  topHolderPercent?: number;
  holderFetchError?: string;
  safetyVerdict?: string;
  safetyReasons?: string[];
}

interface LegitimacyItemRaw {
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  legitimacyVerdict?: string;
  confidence?: string;
  reasons?: string[];
  missingSignals?: string[];
  holderConcentrationStatus?: string;
  mintAuthorityStatus?: string;
  freezeAuthorityStatus?: string;
  [key: string]: unknown;
}

// ── Confidence normalizer ─────────────────────────────────────────────────────

function normalizeConfidence(raw: string | undefined): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  if (raw === 'HIGH')   return 'HIGH';
  if (raw === 'MEDIUM') return 'MEDIUM';
  if (raw === 'LOW')    return 'LOW';
  return 'UNKNOWN';
}

function holderHintFromStatus(status: string | undefined): string | undefined {
  if (status === 'CLEAN')   return 'CLEAN';
  if (status === 'WARNING') return 'WATCH';
  if (status === 'DANGER')  return 'RISKY';
  return undefined;
}

// ── Converters (pure) ─────────────────────────────────────────────────────────

export function winnerCandidateToEarSignal(
  candidate: WinnerCandidateRaw,
  nowIso: string,
): RipperEarSignal {
  const id = `winner:${candidate.contract}:${(candidate.observedAt ?? nowIso).slice(0, 13).replace('T', '-')}`;
  const warnings: string[] = [];

  if (!candidate.observedAt) {
    warnings.push('observedAt missing — using capture time as discoveredAt (age may be inaccurate)');
  }

  const signalReasons = candidate.reasons?.slice() ?? [];
  if (candidate.tier) signalReasons.unshift(`tier:${candidate.tier}`);

  return {
    id,
    source: 'dex-winner-candidates',
    sourceKind: 'DEX_GAINER',
    contract: candidate.contract,
    symbol: candidate.symbol,
    // discoveredAt: best available proxy for when token was first seen (pool launch)
    discoveredAt: candidate.observedAt ?? nowIso,
    observedAt: nowIso,
    launchHint: candidate.tier,
    confidence: normalizeConfidence(candidate.confidence),
    signalReasons,
    warnings: [...warnings, ...(candidate.missingSafetySignals ?? [])],
    priceChangePct: candidate.priceChangePct,
    liquidityChangePct: candidate.liquidityChangePct,
    volumeLiquidityRatio: candidate.volumeLiquidityRatio,
    raw: candidate,
  };
}

export function enrichedCandidateToEarSignal(
  candidate: EnrichedCandidateRaw,
  nowIso: string,
): RipperEarSignal {
  const base = winnerCandidateToEarSignal(candidate, nowIso);
  return {
    ...base,
    id: `enriched:${candidate.contract}:${(candidate.observedAt ?? nowIso).slice(0, 13).replace('T', '-')}`,
    source: 'dex-winner-candidates-enriched',
    holderRiskHint: holderHintFromStatus(candidate.holderConcentrationStatus),
    warnings: [
      ...base.warnings,
      ...(candidate.holderFetchError ? [`holder fetch error: ${candidate.holderFetchError}`] : []),
    ],
  };
}

export function legitimacyItemToEarSignal(
  item: LegitimacyItemRaw,
  nowIso: string,
): RipperEarSignal | null {
  if (!item.contract) return null;

  const id = `legitimacy:${item.contract}:${(item.observedAt ?? nowIso).slice(0, 13).replace('T', '-')}`;
  const warnings: string[] = [];
  if (!item.observedAt) {
    warnings.push('observedAt missing — using capture time as discoveredAt (age may be inaccurate)');
  }

  const signalReasons = item.reasons?.slice() ?? [];
  if (item.legitimacyVerdict) signalReasons.unshift(`verdict:${item.legitimacyVerdict}`);

  return {
    id,
    source: 'dex-legitimacy-report',
    sourceKind: 'DEX_GAINER',
    contract: item.contract,
    symbol: item.symbol,
    discoveredAt: item.observedAt ?? nowIso,
    observedAt: nowIso,
    launchHint: item.legitimacyVerdict,
    confidence: normalizeConfidence(item.confidence),
    signalReasons,
    warnings: [...warnings, ...(item.missingSignals ?? [])],
    priceChangePct: item.priceChangePct,
    liquidityChangePct: item.liquidityChangePct,
    volumeLiquidityRatio: item.volumeLiquidityRatio,
    holderRiskHint: holderHintFromStatus(item.holderConcentrationStatus),
    raw: item,
  };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

function readJsonSafe(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadSignalsFromSource(
  filePath: string,
  kind: SourceKind,
  nowIso: string,
): { signals: RipperEarSignal[]; warnings: string[] } {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') {
    return { signals: [], warnings: [`could not parse ${filePath}`] };
  }

  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];

  if (kind === 'enriched-candidates') {
    const candidates = (obj['candidates'] as EnrichedCandidateRaw[] | undefined) ?? [];
    return {
      signals: candidates.map(c => enrichedCandidateToEarSignal(c, nowIso)),
      warnings,
    };
  }

  if (kind === 'winner-candidates') {
    const candidates = (obj['candidates'] as WinnerCandidateRaw[] | undefined) ?? [];
    return {
      signals: candidates.map(c => winnerCandidateToEarSignal(c, nowIso)),
      warnings,
    };
  }

  if (kind === 'legitimacy-items') {
    const items = (obj['items'] as LegitimacyItemRaw[] | undefined) ?? [];
    const converted = items
      .filter(item => item.legitimacyVerdict !== 'IGNORE' && item.legitimacyVerdict !== 'DANGER')
      .map(item => legitimacyItemToEarSignal(item, nowIso))
      .filter((s): s is RipperEarSignal => s !== null);
    return { signals: converted, warnings };
  }

  return { signals: [], warnings: [`unknown source kind: ${kind}`] };
}

// ── Feed orchestrator ─────────────────────────────────────────────────────────

export interface RipperFeedOptions {
  sources?: Array<{ filePath: string; kind: SourceKind; nextStep: string }>;
  outputPath?: string;
  nowMs?: number;
}

export interface RipperFeedResult {
  sourceUsed: string | null;
  sourceKind: SourceKind | null;
  sourceMissing: boolean;
  nextStep: string | null;
  outputPath: string;
  signalCount: number;
  signals: RipperEarSignal[];
  warnings: string[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

export function runRipperFeed(options: RipperFeedOptions = {}): RipperFeedResult {
  const nowMs     = options.nowMs ?? Date.now();
  const nowIso    = new Date(nowMs).toISOString();
  const outputPath = options.outputPath ?? 'data/token-grab/ripper/ripper-ears-input.json';
  const sources   = options.sources ?? DEFAULT_SOURCES;

  // Try sources in priority order
  for (const src of sources) {
    if (!fs.existsSync(src.filePath)) continue;

    const { signals, warnings } = loadSignalsFromSource(src.filePath, src.kind, nowIso);

    if (signals.length === 0) {
      // File exists but has no usable signals — keep trying
      continue;
    }

    // Write output
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ signals }, null, 2), 'utf-8');

    return {
      sourceUsed: src.filePath,
      sourceKind: src.kind,
      sourceMissing: false,
      nextStep: null,
      outputPath,
      signalCount: signals.length,
      signals,
      warnings,
      tradingExecuted: 0,
      noRealTradeSent: true,
      paperOnly: true,
      readOnly: true,
    };
  }

  // No source found — return helpful guidance without crashing
  return {
    sourceUsed: null,
    sourceKind: null,
    sourceMissing: true,
    nextStep: sources[0]?.nextStep ?? 'npm run token:dex-winner-candidates',
    outputPath,
    signalCount: 0,
    signals: [],
    warnings: ['no source file found — run the pipeline steps below first'],
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperFeedResult(result: RipperFeedResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RIPPER FEED');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.sourceMissing) {
    lines.push('  No source file found. Run the pipeline to generate one:');
    lines.push('');
    for (const step of GENERATE_STEPS) lines.push(step);
    lines.push('');
    lines.push(`  Tried sources:`);
    for (const src of DEFAULT_SOURCES) lines.push(`    • ${src.filePath}`);
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Source : ${result.sourceUsed}`);
  lines.push(`  Kind   : ${result.sourceKind}`);
  lines.push(`  Output : ${result.outputPath}`);
  lines.push(`  Signals: ${result.signalCount}`);
  lines.push('');

  if (result.warnings.length > 0) {
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
    lines.push('');
  }

  for (const sig of result.signals.slice(0, 10)) {
    const sym = sig.symbol ? `$${sig.symbol}` : sig.contract.slice(0, 12) + '…';
    const age = sig.discoveredAt
      ? (() => {
          const ms = Date.now() - new Date(sig.discoveredAt).getTime();
          const m  = Math.round(ms / 60_000);
          return m < 60 ? `${m}m ago` : `${(m / 60).toFixed(1)}h ago`;
        })()
      : 'age?';
    lines.push(`  ${sym.padEnd(14)} ${(sig.confidence).padEnd(8)} age≈${age}`);
    for (const r of sig.signalReasons.slice(0, 2)) lines.push(`    → ${r}`);
  }

  if (result.signals.length > 10) {
    lines.push(`  … and ${result.signals.length - 10} more`);
  }

  lines.push('');
  lines.push('  Next: npm run token:live-fixture-capture');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderRipperFeedUsage(): string {
  return `
token:ripper-feed — convert existing local pipeline output to ripper-ears-input.json

Usage:
  npm run token:ripper-feed [options]

Options:
  --output <path>   output path (default: data/token-grab/ripper/ripper-ears-input.json)
  --help            show this message

Source priority (first found wins):
  1. data/token-grab/legitimacy/dex-winner-candidates-enriched-offline-today.json
  2. data/token-grab/legitimacy/dex-winner-candidates-today.json
  3. data/token-grab/legitimacy/dex-legitimacy-report-today.json

Full pipeline sequence:
${GENERATE_STEPS.join('\n')}

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
