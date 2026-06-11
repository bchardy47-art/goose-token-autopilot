import * as fs from 'fs';
import * as path from 'path';
import {
  runOutcomeTrackerV2,
  type CandidateCheckpointRecord,
  type CheckpointStatus,
  type ExitSimulations,
} from './outcomeTrackerV2';
import { classifyOutcomeStatus, type OutcomeStatus } from './outcomeTracker';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { extractReadinessFields, classifyReadinessLevel } from './autonomyReadinessAudit';
import { fetchPairSnapshot, type DexPairSnapshot } from './dexWatch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LedgerRow {
  firstSeenAt:               string;
  lastUpdatedAt:             string;
  symbol:                    string;
  contract:                  string;
  pairUrl:                   string | null;
  chainId:                   string;
  entryPriceUsd:             number | null;
  latestPriceUsd:            number | null;
  latestReturnPct:           number | null;
  maxKnownReturnPct:         number | null;
  minKnownReturnPct:         number | null;
  checkpointStatus:          CheckpointStatus;
  outcomeStatus:             OutcomeStatus;
  resolved:                  boolean;
  snapshotCount:             number;
  hit25:                     boolean;
  hit50:                     boolean;
  hit100:                    boolean;
  hitSL15:                   boolean;
  bestSimulatedExit:         string;
  bestSimulatedExitPct:      number | null;
  holdLatestPct:             number | null;
  tp25Pct:                   number | null;
  tp50Pct:                   number | null;
  sl15Pct:                   number | null;
  sl25Pct:                   number | null;
  trail20Pct:                number | null;
  holderConcentrationStatus: string;
  topHolderPercent:          number | null;
  clusterRisk:               string;
  bubbleMapsScore:           number | null;
  entryLiquidityUsd:         number | null;
  entryVolumeUsd:            number | null;
  volumeToLiquidityRatio:    number | null;
  liquidityChangePct:        number | null;
  priceChangePct:            number | null;
  estimatedSlippagePct:      number | null;
  source:                    'resolved-ledger-v1';
}

export interface ResolvedLedgerOptions {
  inputPath?:      string;
  watchInputPath?: string;
  ledgerPath?:     string;
  generatedAt?:    string;
  fetch?:          (contract: string, chain: string, observedAt: string) => Promise<DexPairSnapshot | null>;
}

export interface ResolvedLedgerResult {
  inputPath:           string;
  watchInputPath:      string;
  ledgerPath:          string;
  inputMissing:        boolean;
  generatedAt:         string;
  totalRows:           number;
  resolvedRows:        number;
  unresolvedRows:      number;
  winnerCount:         number;
  loserCount:          number;
  flatCount:           number;
  hit25Count:          number;
  hit50Count:          number;
  hit100Count:         number;
  hitSL15Count:        number;
  avgLatestReturn:     number | null;
  avgBestSimExit:      number | null;
  bestRow:             LedgerRow | null;
  worstRow:            LedgerRow | null;
  rows:                LedgerRow[];
  tradingExecuted:     0;
  noRealTradeSent:     true;
  paperOnly:           true;
  readOnly:            true;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_INPUT       = 'data/token-grab/ripper/live-fixtures.jsonl';
const DEFAULT_WATCH_INPUT = 'data/token-grab/outcomes/outcome-watch-snapshots.jsonl';
const DEFAULT_LEDGER      = 'data/token-grab/outcomes/resolved-candidate-ledger.jsonl';

const DEFAULT_FETCH = (contract: string, chain: string, observedAt: string) =>
  fetchPairSnapshot(contract, { chain, observedAt });

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPositiveNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function avgOf(values: (number | null)[]): number | null {
  const ns = values.filter((v): v is number => v !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

function bestExitName(sims: ExitSimulations): string {
  const strategies: Array<{ name: string; pct: number | null }> = [
    { name: 'hold',    pct: sims.hold_to_latest },
    { name: 'tp25',    pct: sims.take_profit_25 },
    { name: 'tp50',    pct: sims.take_profit_50 },
    { name: 'sl15',    pct: sims.stop_loss_15 },
    { name: 'sl25',    pct: sims.stop_loss_25 },
    { name: 'trail20', pct: sims.trailing_stop_20 },
  ];
  let best = strategies[0]!;
  for (const s of strategies) {
    if (s.pct !== null && (best.pct === null || s.pct > best.pct)) best = s;
  }
  return best.name;
}

// ── Existing ledger loader ────────────────────────────────────────────────────

function loadLedger(ledgerPath: string): Map<string, LedgerRow> {
  const map = new Map<string, LedgerRow>();
  if (!fs.existsSync(ledgerPath)) return map;
  let content: string;
  try { content = fs.readFileSync(ledgerPath, 'utf-8'); } catch { return map; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as LedgerRow;
      if (typeof row.contract === 'string') map.set(row.contract, row);
    } catch { /* skip malformed */ }
  }
  return map;
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRow(
  record:          CandidateCheckpointRecord,
  fixture:         LiveRipperFixture | undefined,
  firstSeenAt:     string,
  lastUpdatedAt:   string,
  generatedAt:     string,
): LedgerRow {
  const raw      = fixture?.raw as Record<string, unknown> | undefined;
  const ri       = fixture?.ripperInput as Record<string, unknown> | null | undefined;
  const rawEntry = raw?.['entry'] as Record<string, unknown> | undefined;
  const rawFinal = raw?.['final'] as Record<string, unknown> | undefined;
  const clMet    = raw?.['clusterRawMetrics'] as Record<string, unknown> | undefined;

  const holderConcentrationStatus =
    (raw?.['holderConcentrationStatus'] as string | undefined) ?? 'UNKNOWN';
  const bubbleMapsScore = toNum(clMet?.['decentralisationScore']);
  const estimatedSlippagePct = toNum(raw?.['estimatedSlippagePct']);

  const entryLiquidityUsd = toPositiveNum(rawEntry?.['liquidityUsd']);
  const entryVolumeUsd    = toPositiveNum(rawEntry?.['volumeUsd']);

  const volumeToLiquidityRatio =
    entryVolumeUsd !== null && entryLiquidityUsd !== null && entryLiquidityUsd > 0
      ? entryVolumeUsd / entryLiquidityUsd
      : toPositiveNum(ri?.['volumeLiquidityRatio']) ?? null;

  const entryLiq = toPositiveNum(rawEntry?.['liquidityUsd']);
  const finalLiq = toPositiveNum(rawFinal?.['liquidityUsd']);
  const liquidityChangePct =
    entryLiq !== null && finalLiq !== null
      ? ((finalLiq - entryLiq) / entryLiq) * 100
      : null;

  const entryPrice = toPositiveNum(rawEntry?.['priceUsd']);
  const finalPrice = toPositiveNum(rawFinal?.['priceUsd']);
  const priceChangePct =
    entryPrice !== null && finalPrice !== null
      ? ((finalPrice - entryPrice) / entryPrice) * 100
      : null;

  const sims = record.exitSimulations;
  const detectedAt = record.detectedAt;
  const ageMs = new Date(generatedAt).getTime() - new Date(detectedAt).getTime();
  const ageMinutes = Number.isFinite(ageMs) ? ageMs / 60_000 : 0;
  const resolved = record.snapshotCount >= 4 || ageMinutes >= 30;

  const maxKnown = record.maxKnownReturnPct;
  const minKnown = record.minKnownReturnPct;

  return {
    firstSeenAt,
    lastUpdatedAt,
    symbol:                    record.symbol,
    contract:                  record.contract,
    pairUrl:                   record.pairUrl,
    chainId:                   record.chainId,
    entryPriceUsd:             record.detectedPriceUsd,
    latestPriceUsd:            record.latestPriceUsd,
    latestReturnPct:           record.latestReturnPct,
    maxKnownReturnPct:         maxKnown,
    minKnownReturnPct:         minKnown,
    checkpointStatus:          record.checkpointStatus,
    outcomeStatus:             classifyOutcomeStatus(record.latestReturnPct),
    resolved,
    snapshotCount:             record.snapshotCount,
    hit25:                     maxKnown !== null && maxKnown >= 25,
    hit50:                     maxKnown !== null && maxKnown >= 50,
    hit100:                    maxKnown !== null && maxKnown >= 100,
    hitSL15:                   minKnown !== null && minKnown <= -15,
    bestSimulatedExit:         bestExitName(sims),
    bestSimulatedExitPct:      sims.bestSimulatedReturn,
    holdLatestPct:             sims.hold_to_latest,
    tp25Pct:                   sims.take_profit_25,
    tp50Pct:                   sims.take_profit_50,
    sl15Pct:                   sims.stop_loss_15,
    sl25Pct:                   sims.stop_loss_25,
    trail20Pct:                sims.trailing_stop_20,
    holderConcentrationStatus,
    topHolderPercent:          record.topHolderPercent,
    clusterRisk:               record.clusterRisk,
    bubbleMapsScore,
    entryLiquidityUsd,
    entryVolumeUsd,
    volumeToLiquidityRatio,
    liquidityChangePct,
    priceChangePct,
    estimatedSlippagePct,
    source:                    'resolved-ledger-v1',
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runResolvedLedger(
  options: ResolvedLedgerOptions = {},
): Promise<ResolvedLedgerResult> {
  const inputPath      = options.inputPath      ?? DEFAULT_INPUT;
  const watchInputPath = options.watchInputPath ?? DEFAULT_WATCH_INPUT;
  const ledgerPath     = options.ledgerPath     ?? DEFAULT_LEDGER;
  const generatedAt    = options.generatedAt    ?? new Date().toISOString();
  const doFetch        = options.fetch          ?? DEFAULT_FETCH;

  const empty: ResolvedLedgerResult = {
    inputPath, watchInputPath, ledgerPath, inputMissing: true, generatedAt,
    totalRows: 0, resolvedRows: 0, unresolvedRows: 0,
    winnerCount: 0, loserCount: 0, flatCount: 0,
    hit25Count: 0, hit50Count: 0, hit100Count: 0, hitSL15Count: 0,
    avgLatestReturn: null, avgBestSimExit: null, bestRow: null, worstRow: null,
    rows: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  // 1. Run V2 tracker (handles watch snapshot merging)
  const v2 = await runOutcomeTrackerV2({ inputPath, watchInputPath, generatedAt, fetch: doFetch });
  if (v2.inputMissing) return empty;

  // 2. Re-read fixtures for enrichment fields
  let fixtures: LiveRipperFixture[];
  try { fixtures = readFixturesFromJsonl(inputPath); } catch { return empty; }

  const fixtureByContract = new Map<string, LiveRipperFixture>();
  for (const fixture of fixtures) {
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    if (level !== 'FUTURE_AUTONOMY_CANDIDATE') continue;
    const raw  = fixture.raw as Record<string, unknown> | undefined;
    const ri   = fixture.ripperInput as Record<string, unknown> | null | undefined;
    const ent  = raw?.['entry'] as Record<string, unknown> | undefined;
    const cont = (ent?.['contract'] as string | undefined) ??
                 (raw?.['contract'] as string | undefined) ??
                 (ri?.['contract']  as string | undefined) ?? null;
    if (!cont) continue;
    const ex = fixtureByContract.get(cont);
    if (!ex || fixture.capturedAt < ex.capturedAt) fixtureByContract.set(cont, fixture);
  }

  // 3. Load existing ledger and build updated map
  const existing = loadLedger(ledgerPath);

  const updatedRows = new Map<string, LedgerRow>();
  for (const record of v2.records) {
    const fixture    = fixtureByContract.get(record.contract);
    const prev       = existing.get(record.contract);
    const firstSeenAt  = prev?.firstSeenAt ?? record.detectedAt;
    const row = buildRow(record, fixture, firstSeenAt, generatedAt, generatedAt);
    updatedRows.set(record.contract, row);
  }

  // Preserve rows for contracts not in this run (they stay in ledger as-is)
  for (const [contract, row] of existing) {
    if (!updatedRows.has(contract)) updatedRows.set(contract, row);
  }

  const rows = [...updatedRows.values()];

  // 4. Write ledger
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  } catch { /* non-fatal */ }

  // 5. Aggregate
  let resolvedRows = 0, unresolvedRows = 0;
  let winnerCount = 0, loserCount = 0, flatCount = 0;
  let hit25Count = 0, hit50Count = 0, hit100Count = 0, hitSL15Count = 0;
  let bestRow: LedgerRow | null = null;
  let worstRow: LedgerRow | null = null;

  for (const row of rows) {
    if (row.resolved) resolvedRows++; else unresolvedRows++;

    const s = row.outcomeStatus;
    if (s === 'RIPPED' || s === 'MOVED') winnerCount++;
    else if (s === 'DUMPED') loserCount++;
    else if (s === 'FLAT')   flatCount++;

    if (row.hit25)  hit25Count++;
    if (row.hit50)  hit50Count++;
    if (row.hit100) hit100Count++;
    if (row.hitSL15) hitSL15Count++;

    const ret = row.latestReturnPct;
    if (ret !== null) {
      if (!bestRow  || ret > (bestRow.latestReturnPct  ?? -Infinity)) bestRow  = row;
      if (!worstRow || ret < (worstRow.latestReturnPct ?? Infinity))  worstRow = row;
    }
  }

  return {
    inputPath, watchInputPath, ledgerPath, inputMissing: false, generatedAt,
    totalRows: rows.length,
    resolvedRows, unresolvedRows,
    winnerCount, loserCount, flatCount,
    hit25Count, hit50Count, hit100Count, hitSL15Count,
    avgLatestReturn: avgOf(rows.map(r => r.latestReturnPct)),
    avgBestSimExit:  avgOf(rows.map(r => r.bestSimulatedExitPct)),
    bestRow, worstRow, rows,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fp(n: number | null, d = 1, sign = false): string {
  if (n === null) return '—';
  const s = sign && n >= 0 ? '+' : '';
  return `${s}${n.toFixed(d)}%`;
}

function fn(n: number | null, d = 2): string {
  if (n === null) return '—';
  return n.toFixed(d);
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderResolvedLedgerReport(result: ResolvedLedgerResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RESOLVED CANDIDATE LEDGER V1');
  lines.push('  [REAL TRADING LOCKED — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const {
    totalRows, resolvedRows, unresolvedRows,
    winnerCount, loserCount, flatCount,
    hit25Count, hit50Count, hit100Count, hitSL15Count,
    avgLatestReturn, avgBestSimExit, bestRow, worstRow,
    rows, generatedAt, ledgerPath,
  } = result;

  // ── Section 1: Summary ────────────────────────────────────────────────────
  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Generated        : ${generatedAt}`);
  lines.push(`     Ledger path      : ${ledgerPath}`);
  lines.push(`     Total rows       : ${totalRows}`);
  lines.push(`     Resolved         : ${resolvedRows}`);
  lines.push(`     Unresolved       : ${unresolvedRows}`);
  lines.push(`     Winners (RIPPED/MOVED): ${winnerCount}`);
  lines.push(`     Losers  (DUMPED) : ${loserCount}`);
  lines.push(`     Flat             : ${flatCount}`);
  lines.push(`     Hit ≥25%         : ${hit25Count}`);
  lines.push(`     Hit ≥50%         : ${hit50Count}`);
  lines.push(`     Hit ≥100%        : ${hit100Count}`);
  lines.push(`     Hit SL15         : ${hitSL15Count}`);
  lines.push(`     Avg latest rtn   : ${fp(avgLatestReturn, 1, true)}`);
  lines.push(`     Avg best sim exit: ${fp(avgBestSimExit, 1, true)}`);
  if (bestRow)  lines.push(`     Best             : $${bestRow.symbol}  (${fp(bestRow.latestReturnPct, 1, true)})`);
  if (worstRow) lines.push(`     Worst            : $${worstRow.symbol} (${fp(worstRow.latestReturnPct, 1, true)})`);
  lines.push('');

  if (totalRows === 0) {
    lines.push('  No rows in ledger yet.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  // ── Section 2: Ledger Table ───────────────────────────────────────────────
  lines.push('  2. LEDGER TABLE');
  const hdr = [
    'Symbol'.padEnd(14),
    'Latest%'.padStart(8),
    'Max%'.padStart(7),
    'Min%'.padStart(7),
    'Status'.padEnd(8),
    'Checkpoint'.padEnd(12),
    'Snaps'.padStart(5),
    'BestExit'.padEnd(9),
    'BestExit%'.padStart(9),
    'Vol/Liq'.padStart(7),
    'Bubble'.padStart(7),
    'Res?',
  ].join('  ');
  lines.push(`     ${hdr}`);
  lines.push(`     ${'─'.repeat(hdr.length)}`);

  for (const row of rows) {
    const sym  = `$${row.symbol}`.padEnd(14);
    const lat  = fp(row.latestReturnPct,    1, true).padStart(8);
    const mx   = fp(row.maxKnownReturnPct,  1, true).padStart(7);
    const mn   = fp(row.minKnownReturnPct,  1, true).padStart(7);
    const stat = row.outcomeStatus.padEnd(8);
    const ckpt = row.checkpointStatus.padEnd(12);
    const snps = String(row.snapshotCount).padStart(5);
    const be   = row.bestSimulatedExit.padEnd(9);
    const bepct = fp(row.bestSimulatedExitPct, 1, true).padStart(9);
    const vliq = fn(row.volumeToLiquidityRatio, 3).padStart(7);
    const bub  = fn(row.bubbleMapsScore, 1).padStart(7);
    const res  = row.resolved ? 'YES' : 'no';
    lines.push(`     ${sym}  ${lat}  ${mx}  ${mn}  ${stat}  ${ckpt}  ${snps}  ${be}  ${bepct}  ${vliq}  ${bub}  ${res}`);
  }
  lines.push('');

  // ── Section 3: Early Signal Board ────────────────────────────────────────
  lines.push('  3. EARLY SIGNAL BOARD (informational only)');
  lines.push('  ─────────────────────────────────────────────────────────────────');

  const winners = rows.filter(r => r.outcomeStatus === 'RIPPED' || r.outcomeStatus === 'MOVED');
  const losers  = rows.filter(r => r.outcomeStatus === 'DUMPED');

  if (resolvedRows < 20) {
    lines.push(`  ⚠  Do not change gates until >=20 resolved rows  (currently ${resolvedRows})`);
  }

  if (winners.length > 0 && losers.length > 0) {
    const wVL = avgOf(winners.map(r => r.volumeToLiquidityRatio));
    const lVL = avgOf(losers.map(r => r.volumeToLiquidityRatio));
    lines.push(`  Avg Vol/Liq    — winners: ${fn(wVL, 3)}   losers: ${fn(lVL, 3)}`);

    const wBM = avgOf(winners.map(r => r.bubbleMapsScore));
    const lBM = avgOf(losers.map(r => r.bubbleMapsScore));
    lines.push(`  Avg BubbleMaps — winners: ${fn(wBM, 1)}   losers: ${fn(lBM, 1)}`);

    const wHP = avgOf(winners.map(r => r.topHolderPercent));
    const lHP = avgOf(losers.map(r => r.topHolderPercent));
    lines.push(`  Avg Holder%    — winners: ${fp(wHP)}   losers: ${fp(lHP)}`);
  } else if (resolvedRows > 0) {
    lines.push(`  Need both winners and losers for comparison`);
    lines.push(`  (${winnerCount} winner${winnerCount === 1 ? '' : 's'}, ${loserCount} loser${loserCount === 1 ? '' : 's'} so far)`);
  }

  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  Gate changes require >=20 resolved candidates with consistent signal.');
  lines.push('  Real trading remains locked. This is a read-only reporting tool.');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
