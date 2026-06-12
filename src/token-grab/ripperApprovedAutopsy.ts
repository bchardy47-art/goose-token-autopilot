import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutopsyCheckpointEntry {
  checkpointAt: string;
  checkpointLabel?: string;
  pctChangeFromEntry: number | null;
  multipleFromEntry: number | null;
  currentPriceUsd: number | null;
}

export interface AutopsyCandidateRecord {
  contractKey: string;
  symbol?: string;
  entryPriceUsd: number | null;
  approvedAt: string;
  ageMinutes?: number;
  clusterRisk: string;
  score?: number;
  checkpoints: AutopsyCheckpointEntry[];
  firstCheckpointAt?: string;
  latestCheckpointAt?: string;
  bestPctChange: number | null;
  worstPctChange: number | null;
  finalPctChange: number | null;
  maxMultiple: number | null;
  everPositive: boolean;
}

export interface CandidateSummary {
  contractKey: string;
  symbol?: string;
  pctChange: number;
  multiple: number | null;
}

export interface RipperApprovedAutopsyResult {
  generatedAt: string;
  filesRead: number;
  filesMissing: number;
  candidatesScanned: number;
  uniqueCandidates: number;
  candidatesWithPrice: number;
  winnersAtLatest: number;
  losersAtLatest: number;
  averageFinalPctChange: number | null;
  bestFinalCandidate?: CandidateSummary;
  worstFinalCandidate?: CandidateSummary;
  everPositiveCount: number;
  neverPositiveCount: number;
  avgApprovalAgeWinners: number | null;
  avgApprovalAgeLosers: number | null;
  candidates: AutopsyCandidateRecord[];
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

export interface RipperApprovedAutopsyOptions {
  inputPaths: string[];
  nowMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovedAutopsy(
  options: RipperApprovedAutopsyOptions,
): RipperApprovedAutopsyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  let filesRead        = 0;
  let filesMissing     = 0;
  let candidatesScanned = 0;

  interface AccumRecord {
    symbol?: string;
    entryPriceUsd: number | null;
    approvedAt: string;
    ageMinutes?: number;
    clusterRisk: string;
    score?: number;
    checkpoints: AutopsyCheckpointEntry[];
  }

  const accumMap = new Map<string, AccumRecord>();

  for (const inputPath of options.inputPaths) {
    if (!fs.existsSync(inputPath)) {
      filesMissing++;
      continue;
    }
    filesRead++;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    } catch {
      continue;
    }

    const fileCheckpointLabel = typeof parsed?.checkpointLabel === 'string'
      ? parsed.checkpointLabel
      : undefined;
    const fileCheckpointAt = typeof parsed?.checkpointAt === 'string'
      ? parsed.checkpointAt
      : typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : undefined;

    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    for (const c of candidates as Record<string, unknown>[]) {
      candidatesScanned++;
      const key = typeof c.contractKey === 'string' ? c.contractKey : null;
      if (!key) continue;

      if (!accumMap.has(key)) {
        accumMap.set(key, {
          symbol:       typeof c.symbol === 'string' ? c.symbol : undefined,
          entryPriceUsd: toFiniteNum(c.entryPriceUsd),
          approvedAt:   typeof c.approvedAt === 'string' ? c.approvedAt : generatedAt,
          ageMinutes:   toFiniteNum(c.ageMinutes) ?? undefined,
          clusterRisk:  typeof c.clusterRisk === 'string' ? c.clusterRisk : 'UNKNOWN',
          score:        toFiniteNum(c.score) ?? undefined,
          checkpoints:  [],
        });
      }

      const record = accumMap.get(key)!;
      if (!record.symbol && typeof c.symbol === 'string') record.symbol = c.symbol;
      if (record.entryPriceUsd == null) record.entryPriceUsd = toFiniteNum(c.entryPriceUsd);

      const checkpointAt = typeof c.checkpointAt === 'string'
        ? c.checkpointAt
        : fileCheckpointAt;

      if (checkpointAt != null) {
        record.checkpoints.push({
          checkpointAt,
          checkpointLabel: typeof c.checkpointLabel === 'string'
            ? c.checkpointLabel
            : fileCheckpointLabel,
          pctChangeFromEntry: toFiniteNum(c.pctChangeFromEntry),
          multipleFromEntry:  toFiniteNum(c.multipleFromEntry),
          currentPriceUsd:    toFiniteNum(c.currentPriceUsd),
        });
      }
    }
  }

  // ── Build per-candidate records ───────────────────────────────────────────

  const records: AutopsyCandidateRecord[] = [];

  for (const [contractKey, data] of accumMap) {
    const sorted = [...data.checkpoints].sort(
      (a, b) => a.checkpointAt.localeCompare(b.checkpointAt),
    );

    const withPct  = sorted.filter(c => c.pctChangeFromEntry != null);
    const withMult = sorted.filter(c => c.multipleFromEntry != null);
    const pcts     = withPct.map(c => c.pctChangeFromEntry!);
    const mults    = withMult.map(c => c.multipleFromEntry!);

    records.push({
      contractKey,
      symbol:           data.symbol,
      entryPriceUsd:    data.entryPriceUsd,
      approvedAt:       data.approvedAt,
      ageMinutes:       data.ageMinutes,
      clusterRisk:      data.clusterRisk,
      score:            data.score,
      checkpoints:      sorted,
      firstCheckpointAt:  sorted.length > 0 ? sorted[0].checkpointAt : undefined,
      latestCheckpointAt: sorted.length > 0 ? sorted[sorted.length - 1].checkpointAt : undefined,
      bestPctChange:  pcts.length > 0 ? Math.max(...pcts) : null,
      worstPctChange: pcts.length > 0 ? Math.min(...pcts) : null,
      finalPctChange: withPct.length > 0 ? withPct[withPct.length - 1].pctChangeFromEntry : null,
      maxMultiple:    mults.length > 0 ? Math.max(...mults) : null,
      everPositive:   pcts.some(p => p > 0),
    });
  }

  // Sort: with price first (desc by finalPctChange), then no-price
  records.sort((a, b) => {
    if (a.finalPctChange == null && b.finalPctChange == null) return 0;
    if (a.finalPctChange == null) return 1;
    if (b.finalPctChange == null) return -1;
    return b.finalPctChange - a.finalPctChange;
  });

  // ── Aggregates ────────────────────────────────────────────────────────────

  const withPrice = records.filter(r => r.finalPctChange != null);
  const winners   = withPrice.filter(r => r.finalPctChange! > 0);
  const losers    = withPrice.filter(r => r.finalPctChange! <= 0);

  const avgFinal = withPrice.length > 0
    ? withPrice.reduce((s, r) => s + r.finalPctChange!, 0) / withPrice.length
    : null;

  const byFinal    = [...withPrice].sort((a, b) => b.finalPctChange! - a.finalPctChange!);
  const bestFinal  = byFinal[0];
  const worstFinal = byFinal[byFinal.length - 1];

  const everPositiveCount  = records.filter(r => r.everPositive).length;
  const neverPositiveCount = withPrice.filter(r => !r.everPositive).length;

  const winnersWithAge = winners.filter(r => r.ageMinutes != null);
  const losersWithAge  = losers.filter(r => r.ageMinutes != null);

  const avgApprovalAgeWinners = winnersWithAge.length > 0
    ? winnersWithAge.reduce((s, r) => s + r.ageMinutes!, 0) / winnersWithAge.length
    : null;
  const avgApprovalAgeLosers = losersWithAge.length > 0
    ? losersWithAge.reduce((s, r) => s + r.ageMinutes!, 0) / losersWithAge.length
    : null;

  return {
    generatedAt,
    filesRead,
    filesMissing,
    candidatesScanned,
    uniqueCandidates:      records.length,
    candidatesWithPrice:   withPrice.length,
    winnersAtLatest:       winners.length,
    losersAtLatest:        losers.length,
    averageFinalPctChange: avgFinal,
    bestFinalCandidate: bestFinal ? {
      contractKey: bestFinal.contractKey,
      symbol:      bestFinal.symbol,
      pctChange:   bestFinal.finalPctChange!,
      multiple:    bestFinal.maxMultiple,
    } : undefined,
    worstFinalCandidate: worstFinal && worstFinal !== bestFinal ? {
      contractKey: worstFinal.contractKey,
      symbol:      worstFinal.symbol,
      pctChange:   worstFinal.finalPctChange!,
      multiple:    worstFinal.maxMultiple,
    } : undefined,
    everPositiveCount,
    neverPositiveCount,
    avgApprovalAgeWinners,
    avgApprovalAgeLosers,
    candidates:        records,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtMultiple(n: number | null | undefined): string {
  if (n == null) return '';
  return ` (${n.toFixed(2)}×)`;
}

function fmtAge(m: number | undefined): string {
  if (m == null) return '?m';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function fmtScore(s: number | undefined): string {
  return s != null ? String(Math.round(s)).padStart(3) : '  ?';
}

export function renderRipperApprovedAutopsy(result: RipperApprovedAutopsyResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVED CHECKPOINT AUTOPSY');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated         : ${result.generatedAt}`);
  lines.push(
    `  Files read        : ${result.filesRead}` +
    (result.filesMissing > 0 ? `  (${result.filesMissing} missing)` : ''),
  );
  lines.push(`  Candidates scanned: ${result.candidatesScanned}`);
  lines.push(`  Unique candidates : ${result.uniqueCandidates}`);
  lines.push(`  With price data   : ${result.candidatesWithPrice}`);
  lines.push('');

  if (result.candidatesWithPrice > 0) {
    lines.push(`  Winners (latest)  : ${result.winnersAtLatest}`);
    lines.push(`  Losers  (latest)  : ${result.losersAtLatest}`);
    if (result.averageFinalPctChange != null) {
      lines.push(`  Avg final pct     : ${fmtPct(result.averageFinalPctChange)}`);
    }
    if (result.bestFinalCandidate) {
      const sym = result.bestFinalCandidate.symbol
        ? `$${result.bestFinalCandidate.symbol}`
        : result.bestFinalCandidate.contractKey.slice(0, 8);
      lines.push(`  Best final        : ${sym} ${fmtPct(result.bestFinalCandidate.pctChange)}${fmtMultiple(result.bestFinalCandidate.multiple)}`);
    }
    if (result.worstFinalCandidate) {
      const sym = result.worstFinalCandidate.symbol
        ? `$${result.worstFinalCandidate.symbol}`
        : result.worstFinalCandidate.contractKey.slice(0, 8);
      lines.push(`  Worst final       : ${sym} ${fmtPct(result.worstFinalCandidate.pctChange)}${fmtMultiple(result.worstFinalCandidate.multiple)}`);
    }
    lines.push(`  Ever positive     : ${result.everPositiveCount}`);
    lines.push(`  Never positive    : ${result.neverPositiveCount}`);
    lines.push('');
  }

  if (result.avgApprovalAgeWinners != null || result.avgApprovalAgeLosers != null) {
    lines.push('  Age-bucket insight:');
    if (result.avgApprovalAgeWinners != null) {
      lines.push(`    Avg age winners : ${fmtAge(result.avgApprovalAgeWinners)}`);
    }
    if (result.avgApprovalAgeLosers != null) {
      lines.push(`    Avg age losers  : ${fmtAge(result.avgApprovalAgeLosers)}`);
    }
    lines.push('');
  }

  if (result.candidates.length === 0) {
    lines.push('  (no candidates found)');
  } else {
    lines.push('  Candidates (ranked by final pctChange):');
    lines.push('');
    for (const c of result.candidates) {
      const sym   = c.symbol ? `$${c.symbol}` : '(unknown)';
      const addr  = c.contractKey.length > 14
        ? `${c.contractKey.slice(0, 14)}…`
        : c.contractKey;
      const final = fmtPct(c.finalPctChange);
      const best  = c.bestPctChange != null ? fmtPct(c.bestPctChange) : 'n/a';
      const worst = c.worstPctChange != null ? fmtPct(c.worstPctChange) : 'n/a';
      const chkN  = c.checkpoints.length;

      lines.push(
        `  score=${fmtScore(c.score)}  ${sym.padEnd(14)}  age=${fmtAge(c.ageMinutes).padEnd(6)}  ` +
        `cluster=${c.clusterRisk.padEnd(7)}  final=${final.padEnd(9)}  ` +
        `best=${best.padEnd(9)}  worst=${worst}  chk=${chkN}`,
      );
      lines.push(`           ${addr}  entry=${c.entryPriceUsd != null ? `$${c.entryPriceUsd.toFixed(8)}` : 'n/a'}  approved=${c.approvedAt}`);
    }
  }

  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}
