import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';

// ── Price provider ─────────────────────────────────────────────────────────────

export type RipperPriceProvider = (
  contractKey: string,
  opts?: { poolAddress?: string },
) => Promise<{ priceUsd: number | null; note?: string }>;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperApprovedOutcomesOptions {
  inputPaths: string[];
  outPath: string;
  nowMs?: number;
  checkpointLabel?: string;
  _priceProvider?: RipperPriceProvider;
  delayBetweenFetchesMs?: number;
}

export interface ApprovedCandidate {
  contractKey: string;
  poolAddress?: string;
  symbol?: string;
  approvedAt: string;
  discoveredAt?: string;
  score?: number;
  ageMinutes?: number;
  clusterRisk: string;
  entryPriceUsd: number | null;
  priceChangePct?: number;
  sourceArtifact: string;
  currentPriceUsd: number | null;
  pctChangeFromEntry: number | null;
  multipleFromEntry: number | null;
  checkpointAt?: string;
  priceNote?: string;
}

export interface CandidateSummary {
  contractKey: string;
  symbol?: string;
  pctChangeFromEntry: number;
  multipleFromEntry: number;
}

export interface RipperApprovedOutcomesResult {
  generatedAt: string;
  outPath: string;
  filesRead: number;
  filesMissing: number;
  fixturesScanned: number;
  approvedTotal: number;
  uniqueApproved: number;
  duplicatesSkipped: number;
  malformedSkipped: number;
  priceDataAvailable: boolean;
  priceTrackingNote: string;
  checkpointLabel?: string;
  checkpointAt?: string;
  candidatesWithPrice: number;
  priceUnavailableCount: number;
  winnersCount: number;
  losersCount: number;
  averagePctChange: number | null;
  bestCandidate?: CandidateSummary;
  worstCandidate?: CandidateSummary;
  candidates: ApprovedCandidate[];
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── GeckoTerminal helpers (self-contained, read-only) ─────────────────────────

const GECKO_BASE    = 'https://api.geckoterminal.com/api/v2';
const GECKO_TIMEOUT = 10_000;

function toPositiveNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function geckoFetch(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultPriceProvider(
  contractKey: string,
  opts?: { poolAddress?: string },
): Promise<{ priceUsd: number | null; note?: string }> {
  try {
    const url = `${GECKO_BASE}/networks/solana/tokens/${contractKey}`;
    const res = await geckoFetch(url, GECKO_TIMEOUT);
    if (res.ok) {
      const attrs = (res.body as { data?: { attributes?: { price_usd?: unknown } } })
        ?.data?.attributes;
      const priceUsd = toPositiveNum(attrs?.price_usd);
      if (priceUsd != null) return { priceUsd };
    }
    if (res.status === 429) return { priceUsd: null, note: 'rate limited (429)' };
  } catch (e) {
    return { priceUsd: null, note: `fetch error: ${(e as Error).message}` };
  }

  if (opts?.poolAddress) {
    try {
      const url = `${GECKO_BASE}/networks/solana/pools/${opts.poolAddress}`;
      const res = await geckoFetch(url, GECKO_TIMEOUT);
      if (res.ok) {
        const attrs = (res.body as { data?: { attributes?: { base_token_price_usd?: unknown; price_in_usd?: unknown } } })
          ?.data?.attributes;
        const priceUsd = toPositiveNum(attrs?.base_token_price_usd ?? attrs?.price_in_usd);
        if (priceUsd != null) return { priceUsd };
      }
      if (res.status === 429) return { priceUsd: null, note: 'rate limited (429)' };
    } catch (e) {
      return { priceUsd: null, note: `fetch error: ${(e as Error).message}` };
    }
  }

  return { priceUsd: null, note: 'price not found' };
}

// ── Extraction helpers ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contractKeyFromSignal(signal: Record<string, unknown>): string | null {
  return getString(signal['contract'])
    ?? getString(signal['tokenAddress'])
    ?? getString(signal['poolAddress'])
    ?? getString(signal['id'])
    ?? null;
}

function getClusterRisk(fixture: Record<string, unknown>): string {
  const raw = asRecord(fixture['raw']);
  const v   = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function getEntryPriceUsd(signal: Record<string, unknown>): number | null {
  const raw   = asRecord(signal['raw']);
  const entry = asRecord(raw?.['entry']);
  return getNumber(entry?.['priceUsd']);
}

function toCandidate(
  fixture: Record<string, unknown>,
  signal: Record<string, unknown>,
  artifactPath: string,
): ApprovedCandidate | null {
  const key = contractKeyFromSignal(signal);
  if (!key) return null;

  return {
    contractKey:        key,
    poolAddress:        getString(signal['poolAddress']),
    symbol:             getString(signal['symbol']),
    approvedAt:         getString(fixture['capturedAt']) ?? '',
    discoveredAt:       getString(signal['discoveredAt']) ?? getString(signal['observedAt']),
    score:              getNumber(fixture['ripperScore']) ?? undefined,
    ageMinutes:         getNumber(fixture['ageMinutes']) ?? undefined,
    clusterRisk:        getClusterRisk(fixture),
    entryPriceUsd:      getEntryPriceUsd(signal),
    priceChangePct:     getNumber(signal['priceChangePct']) ?? undefined,
    sourceArtifact:     artifactPath,
    currentPriceUsd:    null,
    pctChangeFromEntry: null,
    multipleFromEntry:  null,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runRipperApprovedOutcomes(
  options: RipperApprovedOutcomesOptions,
): Promise<RipperApprovedOutcomesResult> {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const inputPaths  = Array.isArray(options.inputPaths) ? options.inputPaths : [];

  let filesRead         = 0;
  let filesMissing      = 0;
  let fixturesScanned   = 0;
  let approvedTotal     = 0;
  let duplicatesSkipped = 0;
  let malformedSkipped  = 0;

  const seen: Set<string> = new Set();
  const candidates: ApprovedCandidate[] = [];

  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      filesMissing += 1;
      continue;
    }
    filesRead += 1;
    const fixtures = readFixturesFromJsonl(inputPath) as unknown as unknown[];
    fixturesScanned += fixtures.length;

    for (const fixtureValue of fixtures) {
      const fixture = asRecord(fixtureValue);
      if (!fixture) {
        malformedSkipped += 1;
        continue;
      }
      if (fixture['postApprovalObservation'] === true) continue;
      if (fixture['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;

      const signal = asRecord(fixture['normalizedSignal']);
      if (!signal) {
        approvedTotal += 1;
        malformedSkipped += 1;
        continue;
      }

      approvedTotal += 1;

      const candidate = toCandidate(fixture, signal, inputPath);
      if (!candidate) {
        malformedSkipped += 1;
        continue;
      }

      if (seen.has(candidate.contractKey)) {
        duplicatesSkipped += 1;
        continue;
      }
      seen.add(candidate.contractKey);
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const doFetch      = options._priceProvider !== undefined || options.checkpointLabel !== undefined;
  const priceProvider: RipperPriceProvider | null =
    doFetch ? (options._priceProvider ?? defaultPriceProvider) : null;
  const checkpointAt = doFetch ? generatedAt : undefined;
  const delayMs      = options.delayBetweenFetchesMs ?? 300;

  if (priceProvider && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0 && delayMs > 0) {
        await new Promise<void>(r => setTimeout(r, delayMs));
      }
      const c = candidates[i];
      try {
        const { priceUsd, note } = await priceProvider(c.contractKey, {
          poolAddress: c.poolAddress,
        });
        c.currentPriceUsd = priceUsd;
        c.checkpointAt    = checkpointAt;
        c.priceNote       = note;

        if (c.entryPriceUsd && priceUsd != null) {
          c.pctChangeFromEntry = ((priceUsd - c.entryPriceUsd) / c.entryPriceUsd) * 100;
          c.multipleFromEntry  = priceUsd / c.entryPriceUsd;
        }
      } catch (e) {
        c.priceNote = `provider error: ${(e as Error).message}`;
      }
    }
  }

  const withPrice = candidates.filter(c => c.pctChangeFromEntry != null);
  const winners   = withPrice.filter(c => (c.pctChangeFromEntry ?? 0) > 0);
  const losers    = withPrice.filter(c => (c.pctChangeFromEntry ?? 0) <= 0);
  const avgPct    = withPrice.length > 0
    ? withPrice.reduce((s, c) => s + (c.pctChangeFromEntry ?? 0), 0) / withPrice.length
    : null;
  const sorted    = [...withPrice].sort((a, b) => (b.pctChangeFromEntry ?? 0) - (a.pctChangeFromEntry ?? 0));
  const best      = sorted[0];
  const worst     = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

  const priceDataAvailable = withPrice.length > 0;
  const priceTrackingNote  = doFetch
    ? withPrice.length === candidates.length
      ? 'Live price checkpoints fetched from GeckoTerminal'
      : `Live price checkpoints fetched; ${candidates.filter(c => c.currentPriceUsd == null).length} unavailable`
    : 'V1 extraction-only — live price tracking pending';

  const result: RipperApprovedOutcomesResult = {
    generatedAt,
    outPath:               options.outPath,
    filesRead,
    filesMissing,
    fixturesScanned,
    approvedTotal,
    uniqueApproved:        candidates.length,
    duplicatesSkipped,
    malformedSkipped,
    priceDataAvailable,
    priceTrackingNote,
    checkpointLabel:       options.checkpointLabel,
    checkpointAt,
    candidatesWithPrice:   withPrice.length,
    priceUnavailableCount: doFetch ? candidates.filter(c => c.currentPriceUsd == null).length : 0,
    winnersCount:          winners.length,
    losersCount:           losers.length,
    averagePctChange:      avgPct,
    bestCandidate:         best ? {
      contractKey:        best.contractKey,
      symbol:             best.symbol,
      pctChangeFromEntry: best.pctChangeFromEntry ?? 0,
      multipleFromEntry:  best.multipleFromEntry ?? 0,
    } : undefined,
    worstCandidate:        worst && worst !== best ? {
      contractKey:        worst.contractKey,
      symbol:             worst.symbol,
      pctChangeFromEntry: worst.pctChangeFromEntry ?? 0,
      multipleFromEntry:  worst.multipleFromEntry ?? 0,
    } : undefined,
    candidates,
    realTradingLocked:    true,
    tradingExecuted:      0,
    noRealTradeSent:      true,
    paperOnly:            true,
    readOnly:             true,
  };

  const outDir = path.dirname(options.outPath);
  if (outDir && outDir !== '.') {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(options.outPath, JSON.stringify(result, null, 2), 'utf-8');

  return result;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function fmtScore(s: number | undefined): string {
  return s != null ? String(Math.round(s)).padStart(3) : '  ?';
}

function fmtAge(m: number | undefined): string {
  if (m == null) return '?m';
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtMultiple(n: number | null | undefined): string {
  if (n == null) return '';
  return ` (${n.toFixed(2)}×)`;
}

export function renderRipperApprovedOutcomes(result: RipperApprovedOutcomesResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVED OUTCOME TRACKER');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated       : ${result.generatedAt}`);
  lines.push(
    `  Files read      : ${result.filesRead}` +
    (result.filesMissing > 0 ? `  (${result.filesMissing} missing)` : ''),
  );
  lines.push(`  Fixtures scanned: ${result.fixturesScanned}`);
  lines.push(`  Approved total  : ${result.approvedTotal}`);
  lines.push(`  Unique approved : ${result.uniqueApproved}`);
  if (result.duplicatesSkipped > 0) {
    lines.push(`  Duplicates skip : ${result.duplicatesSkipped}`);
  }
  if (result.malformedSkipped > 0) {
    lines.push(`  Malformed skip  : ${result.malformedSkipped}`);
  }
  lines.push('');

  if (result.checkpointLabel || result.checkpointAt) {
    lines.push(`  Checkpoint      : ${result.checkpointLabel ?? '—'}  (${result.checkpointAt ?? 'n/a'})`);
    lines.push(`  With price      : ${result.candidatesWithPrice}`);
    if (result.priceUnavailableCount > 0) {
      lines.push(`  Price pending   : ${result.priceUnavailableCount}`);
    }
    if (result.candidatesWithPrice > 0) {
      lines.push(`  Winners (+)     : ${result.winnersCount}`);
      lines.push(`  Losers  (-)     : ${result.losersCount}`);
      if (result.averagePctChange != null) {
        lines.push(`  Avg pctChange   : ${fmtPct(result.averagePctChange)}`);
      }
      if (result.bestCandidate) {
        const sym = result.bestCandidate.symbol ? `$${result.bestCandidate.symbol}` : result.bestCandidate.contractKey.slice(0, 8);
        lines.push(`  Best            : ${sym} ${fmtPct(result.bestCandidate.pctChangeFromEntry)}${fmtMultiple(result.bestCandidate.multipleFromEntry)}`);
      }
      if (result.worstCandidate) {
        const sym = result.worstCandidate.symbol ? `$${result.worstCandidate.symbol}` : result.worstCandidate.contractKey.slice(0, 8);
        lines.push(`  Worst           : ${sym} ${fmtPct(result.worstCandidate.pctChangeFromEntry)}${fmtMultiple(result.worstCandidate.multipleFromEntry)}`);
      }
    }
    lines.push('');
  } else {
    lines.push(`  Price data      : ${result.priceDataAvailable ? 'available' : 'pending'}`);
    lines.push(`  Note            : ${result.priceTrackingNote}`);
    lines.push('');
  }

  if (result.candidates.length === 0) {
    lines.push('  (no approved candidates found)');
  } else {
    lines.push('  Approved candidates (ranked by score):');
    lines.push('');
    for (const c of result.candidates.slice(0, 10)) {
      const sym   = c.symbol ? `$${c.symbol}` : '(unknown)';
      const age   = fmtAge(c.ageMinutes);
      const entry = c.entryPriceUsd != null ? `$${c.entryPriceUsd.toFixed(6)}` : 'n/a';
      const addr  = c.contractKey.length > 12
        ? `${c.contractKey.slice(0, 12)}…`
        : c.contractKey;

      let pricePart = `  entry=${entry}`;
      if (c.currentPriceUsd != null) {
        pricePart += `  now=$${c.currentPriceUsd.toFixed(6)}  ${fmtPct(c.pctChangeFromEntry)}${fmtMultiple(c.multipleFromEntry)}`;
      }

      lines.push(
        `  score=${fmtScore(c.score)}  ${sym.padEnd(14)}` +
        `  age=${age.padEnd(6)}  cluster=${c.clusterRisk.padEnd(7)}` + pricePart,
      );
      lines.push(`           ${addr}  approved=${c.approvedAt}`);
    }
    if (result.candidates.length > 10) {
      lines.push(`  … and ${result.candidates.length - 10} more (see output file)`);
    }
  }

  lines.push('');
  lines.push(`  Output          : ${result.outPath}`);
  lines.push('');
  lines.push('  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true');
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperApprovedOutcomesUsage(): string {
  return `
token:ripper-approved-outcomes — extract approved paper candidates from ripper cycle artifacts

Usage:
  npm run token:ripper-approved-outcomes -- --input <paths> [--out <path>] [--checkpoint-label <label>]

Options:
  --input <paths>            one or more cycle JSONL artifact files; shell globs expanded by your shell
  --out <path>               output JSON path (default: data/token-grab/ripper/outcomes/ripper-approved-outcomes.json)
  --checkpoint-label <label> fetch live prices from GeckoTerminal and label this snapshot (e.g. "now", "4h", "24h")
  --help                     show this message

Example:
  npm run token:ripper-approved-outcomes -- --input data/token-grab/ripper/cycles/cycle-*.jsonl
  npm run token:ripper-approved-outcomes -- --input data/token-grab/ripper/cycles/cycle-*.jsonl --checkpoint-label now
  npm run token:ripper-approved-outcomes -- --input data/token-grab/ripper/cycles/cycle-2026-06-12-20*.jsonl --out data/token-grab/ripper/outcomes/ripper-approved-outcomes.json --checkpoint-label 4h

Output:
  JSON file with approved candidates: symbol, score, age, cluster risk, entry/current prices, pctChange.
  Without --checkpoint-label: extraction-only, no live API calls.
  With --checkpoint-label: fetches current prices from GeckoTerminal (read-only).

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No buy logic. No scoring changes. Read-only.
`.trim();
}
