import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntryClassification = 'WINNER' | 'LOSER' | 'PENDING_PRICE';

export interface CandidateFeatures {
  contractKey:             string;
  symbol?:                 string;
  outcomePctChange:        number | null;
  classification:          EntryClassification;
  // Approval snapshot
  approvalAgeMinutes:      number | null;
  approvalScore:           number | null;
  approvalPriceChangePct:  number | null;
  clusterRisk:             string;
  clusterProvider:         string | null;
  // Market data at approval time
  liquidityUsd:            number | null;
  volumeUsd:               number | null;
  txnCount:                number | null;
  buys:                    number | null;
  sells:                   number | null;
  buySellRatio:            number | null;
  holderRiskHint:          string | null;
  // Ripper pipeline output
  approvalTopReasons:      string[];
  approvalBlockers:        string[];
  approvalWarnings:        string[];
  // Any remaining raw/source fields
  rawFields:               Record<string, unknown>;
  // Latest observation
  latestObsScore:          number | null;
  latestObsAgeMinutes:     number | null;
  latestObsPriceChangePct: number | null;
  scoreDelta:              number | null;
}

export interface PhraseCount {
  phrase: string;
  count:  number;
}

export interface GroupStats {
  count:                    number;
  avgApprovalAge:           number | null;
  avgApprovalScore:         number | null;
  avgApprovalPriceChangePct: number | null;
  avgLiquidityUsd:          number | null;
  avgVolumeUsd:             number | null;
  avgTxnCount:              number | null;
  avgBuySellRatio:          number | null;
  clusterRiskCounts:        Record<string, number>;
  topReasonPhrases:         PhraseCount[];
  warningPhrases:           PhraseCount[];
  blockerPhrases:           PhraseCount[];
}

export interface PossibleSeparator {
  field:        string;
  winnerValue:  string;
  loserValue:   string;
  note:         string;
}

export interface RipperEntryFeatureAutopsyOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outcomePaths:     string[];
  nowMs?:           number;
}

export interface RipperEntryFeatureAutopsyResult {
  generatedAt:              string;
  approvalFilesRead:        number;
  approvalFilesMissing:     number;
  observationFilesRead:     number;
  observationFilesMissing:  number;
  outcomeFilesRead:         number;
  outcomeFilesMissing:      number;
  approvalsRead:            number;
  observationsRead:         number;
  outcomesRead:             number;
  totalCandidates:          number;
  winnersCount:             number;
  losersCount:              number;
  pendingCount:             number;
  candidates:               CandidateFeatures[];
  winnerStats:              GroupStats;
  loserStats:               GroupStats;
  possibleSeparators:       PossibleSeparator[];
  realTradingLocked:        true;
  tradingExecuted:          0;
  noRealTradeSent:          true;
  paperOnly:                true;
  readOnly:                 true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function safeRecord(v: unknown): Record<string, unknown> {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function safeStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function safeStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = safeRecord(f.raw);
  const v   = raw['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function getClusterProvider(f: LiveRipperFixture): string | null {
  const raw = safeRecord(f.raw);
  return safeStr(raw['clusterProvider']);
}

function extractRawFields(f: LiveRipperFixture): Record<string, unknown> {
  const raw = safeRecord(f.raw);
  // Exclude fields already captured at the top level
  const excluded = new Set(['clusterRisk', 'clusterProvider']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!excluded.has(k)) result[k] = v;
  }
  return result;
}

function countPhrases(phraseArrays: string[][]): PhraseCount[] {
  const counts = new Map<string, number>();
  for (const arr of phraseArrays) {
    for (const phrase of arr) {
      if (phrase) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

function buildGroupStats(candidates: CandidateFeatures[]): GroupStats {
  if (candidates.length === 0) {
    return {
      count: 0,
      avgApprovalAge: null,
      avgApprovalScore: null,
      avgApprovalPriceChangePct: null,
      avgLiquidityUsd: null,
      avgVolumeUsd: null,
      avgTxnCount: null,
      avgBuySellRatio: null,
      clusterRiskCounts: {},
      topReasonPhrases: [],
      warningPhrases: [],
      blockerPhrases: [],
    };
  }

  const clusterRiskCounts: Record<string, number> = {};
  for (const c of candidates) {
    clusterRiskCounts[c.clusterRisk] = (clusterRiskCounts[c.clusterRisk] ?? 0) + 1;
  }

  return {
    count:                    candidates.length,
    avgApprovalAge:           avgOf(candidates.map(c => c.approvalAgeMinutes)),
    avgApprovalScore:         avgOf(candidates.map(c => c.approvalScore)),
    avgApprovalPriceChangePct: avgOf(candidates.map(c => c.approvalPriceChangePct)),
    avgLiquidityUsd:          avgOf(candidates.map(c => c.liquidityUsd)),
    avgVolumeUsd:             avgOf(candidates.map(c => c.volumeUsd)),
    avgTxnCount:              avgOf(candidates.map(c => c.txnCount)),
    avgBuySellRatio:          avgOf(candidates.map(c => c.buySellRatio)),
    clusterRiskCounts,
    topReasonPhrases:         countPhrases(candidates.map(c => c.approvalTopReasons)),
    warningPhrases:           countPhrases(candidates.map(c => c.approvalWarnings)),
    blockerPhrases:           countPhrases(candidates.map(c => c.approvalBlockers)),
  };
}

function computePossibleSeparators(
  winners: CandidateFeatures[],
  losers:  CandidateFeatures[],
  ws:      GroupStats,
  ls:      GroupStats,
): PossibleSeparator[] {
  const seps: PossibleSeparator[] = [];
  const wn = winners.length;
  const ln = losers.length;
  const sampleNote = `(n=${wn} winners, n=${ln} losers — research only)`;

  function addNumeric(field: string, wVal: number | null, lVal: number | null) {
    if (wVal == null || lVal == null) return;
    const diff = Math.abs(wVal - lVal);
    const denom = Math.max(Math.abs(wVal), Math.abs(lVal), 1);
    if (diff / denom < 0.05) return;  // skip if < 5% relative difference
    seps.push({
      field,
      winnerValue: wVal.toFixed(2),
      loserValue:  lVal.toFixed(2),
      note: sampleNote,
    });
  }

  addNumeric('approvalAgeMinutes',      ws.avgApprovalAge,           ls.avgApprovalAge);
  addNumeric('approvalScore',           ws.avgApprovalScore,         ls.avgApprovalScore);
  addNumeric('approvalPriceChangePct',  ws.avgApprovalPriceChangePct, ls.avgApprovalPriceChangePct);
  addNumeric('liquidityUsd',            ws.avgLiquidityUsd,          ls.avgLiquidityUsd);
  addNumeric('volumeUsd',               ws.avgVolumeUsd,             ls.avgVolumeUsd);
  addNumeric('txnCount',                ws.avgTxnCount,              ls.avgTxnCount);
  addNumeric('buySellRatio',            ws.avgBuySellRatio,          ls.avgBuySellRatio);

  // clusterRisk distribution differences
  const allRisks = new Set([
    ...Object.keys(ws.clusterRiskCounts),
    ...Object.keys(ls.clusterRiskCounts),
  ]);
  for (const risk of allRisks) {
    const wc = ws.clusterRiskCounts[risk] ?? 0;
    const lc = ls.clusterRiskCounts[risk] ?? 0;
    const wRate = wn > 0 ? wc / wn : 0;
    const lRate = ln > 0 ? lc / ln : 0;
    if (Math.abs(wRate - lRate) >= 0.3) {
      seps.push({
        field:       `clusterRisk=${risk}`,
        winnerValue: `${wc}/${wn} (${(wRate * 100).toFixed(0)}%)`,
        loserValue:  `${lc}/${ln} (${(lRate * 100).toFixed(0)}%)`,
        note:        sampleNote,
      });
    }
  }

  // Phrases exclusive to one group (appear in ≥50% of one group but 0% of the other)
  function addPhraseSeps(
    label: string,
    wPhrases: PhraseCount[],
    lPhrases: PhraseCount[],
  ) {
    const wMap = new Map(wPhrases.map(p => [p.phrase, p.count]));
    const lMap = new Map(lPhrases.map(p => [p.phrase, p.count]));
    const all  = new Set([...wMap.keys(), ...lMap.keys()]);
    for (const phrase of all) {
      const wc  = wMap.get(phrase) ?? 0;
      const lc  = lMap.get(phrase) ?? 0;
      const wok = wn > 0 && wc / wn >= 0.5;
      const lok = ln > 0 && lc / ln >= 0.5;
      if (wok && !lok) {
        seps.push({
          field:       `${label} phrase`,
          winnerValue: `"${phrase}" (${wc}/${wn} winners)`,
          loserValue:  `absent in losers`,
          note:        sampleNote,
        });
      } else if (lok && !wok) {
        seps.push({
          field:       `${label} phrase`,
          winnerValue: `absent in winners`,
          loserValue:  `"${phrase}" (${lc}/${ln} losers)`,
          note:        sampleNote,
        });
      }
    }
  }

  addPhraseSeps('topReason',  ws.topReasonPhrases, ls.topReasonPhrases);
  addPhraseSeps('warning',    ws.warningPhrases,   ls.warningPhrases);
  addPhraseSeps('blocker',    ws.blockerPhrases,   ls.blockerPhrases);

  return seps;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEntryFeatureAutopsy(
  options: RipperEntryFeatureAutopsyOptions,
): RipperEntryFeatureAutopsyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures (earliest per key) ──────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  const approvalMap        = new Map<string, LiveRipperFixture>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const key = signalKey(f.normalizedSignal);
      const ex  = approvalMap.get(key);
      if (!ex || f.capturedAt < ex.capturedAt) approvalMap.set(key, f);
    }
  }

  // ── Step 2: Read observation fixtures (all, then pick latest per key) ───────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsRead        = 0;

  interface ObsEntry {
    ageMinutes:     number | null;
    score:          number | null;
    priceChangePct: number | null;
    capturedAt:     string;
  }

  const obsListMap = new Map<string, ObsEntry[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      observationsRead++;
      const key   = signalKey(f.normalizedSignal);
      const entry: ObsEntry = {
        ageMinutes:     typeof f.ageMinutes  === 'number' ? f.ageMinutes  : null,
        score:          typeof f.ripperScore  === 'number' ? f.ripperScore  : null,
        priceChangePct: toFiniteNum(f.normalizedSignal.priceChangePct),
        capturedAt:     f.capturedAt,
      };
      const list = obsListMap.get(key);
      if (list) list.push(entry); else obsListMap.set(key, [entry]);
    }
  }

  const latestObsMap = new Map<string, ObsEntry>();
  for (const [key, list] of obsListMap) {
    list.sort((a, b) => {
      if (a.ageMinutes != null && b.ageMinutes != null) return b.ageMinutes - a.ageMinutes;
      if (a.ageMinutes != null) return -1;
      if (b.ageMinutes != null) return  1;
      return b.capturedAt.localeCompare(a.capturedAt);
    });
    latestObsMap.set(key, list[0]);
  }

  // ── Step 3: Read outcome data (latest checkpointAt per key) ─────────────────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;
  let outcomesRead        = 0;

  interface OutcomeEntry { pctChangeFromEntry: number | null; checkpointAt: string }
  const outcomeMap = new Map<string, OutcomeEntry>();

  for (const p of options.outcomePaths) {
    if (!fs.existsSync(p)) { outcomeFilesMissing++; continue; }
    outcomeFilesRead++;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }
    const rec = safeRecord(parsed);
    const fileCheckpointAt =
      safeStr(rec['checkpointAt']) ?? safeStr(rec['generatedAt']) ?? '';
    const cands = Array.isArray(rec['candidates'])
      ? rec['candidates'] as unknown[]
      : [];
    for (const c of cands) {
      const cr  = safeRecord(c);
      const key = safeStr(cr['contractKey']);
      if (!key) continue;
      outcomesRead++;
      const ckAt   = safeStr(cr['checkpointAt']) ?? fileCheckpointAt;
      const exists = outcomeMap.get(key);
      if (!exists || ckAt >= exists.checkpointAt) {
        outcomeMap.set(key, { pctChangeFromEntry: toFiniteNum(cr['pctChangeFromEntry']), checkpointAt: ckAt });
      }
    }
  }

  // ── Step 4: Build per-candidate feature records ────────────────────────────
  const candidates: CandidateFeatures[] = [];

  for (const [key, f] of approvalMap) {
    const sig    = f.normalizedSignal;
    const latObs = latestObsMap.get(key);
    const out    = outcomeMap.get(key);

    const outcomePctChange = out?.pctChangeFromEntry ?? null;
    const classification: EntryClassification =
      outcomePctChange == null ? 'PENDING_PRICE'
      : outcomePctChange > 0  ? 'WINNER'
      : 'LOSER';

    const approvalScore         = typeof f.ripperScore === 'number' ? f.ripperScore : null;
    const approvalAgeMinutes    = typeof f.ageMinutes  === 'number' ? f.ageMinutes  : null;
    const approvalPriceChangePct = toFiniteNum(sig.priceChangePct);
    const liquidityUsd          = toFiniteNum((sig as Record<string, unknown>)['liquidityUsd']);
    const volumeUsd             = toFiniteNum((sig as Record<string, unknown>)['volumeUsd']);
    const txnCount              = toFiniteNum((sig as Record<string, unknown>)['txnCount']);
    const buys                  = toFiniteNum((sig as Record<string, unknown>)['buys']);
    const sells                 = toFiniteNum((sig as Record<string, unknown>)['sells']);
    const buySellRatio          = buys != null && sells != null && (buys + sells) > 0
      ? buys / (buys + sells)
      : null;
    const holderRiskHint        = safeStr((sig as Record<string, unknown>)['holderRiskHint']);

    const latestObsScore          = latObs?.score          ?? null;
    const latestObsAgeMinutes     = latObs?.ageMinutes     ?? null;
    const latestObsPriceChangePct = latObs?.priceChangePct ?? null;
    const scoreDelta              = approvalScore != null && latestObsScore != null
      ? latestObsScore - approvalScore
      : null;

    candidates.push({
      contractKey:            key,
      symbol:                 sig.symbol,
      outcomePctChange,
      classification,
      approvalAgeMinutes,
      approvalScore,
      approvalPriceChangePct,
      clusterRisk:            getClusterRisk(f),
      clusterProvider:        getClusterProvider(f),
      liquidityUsd,
      volumeUsd,
      txnCount,
      buys,
      sells,
      buySellRatio,
      holderRiskHint,
      approvalTopReasons:     safeStrArr(f.topReasons),
      approvalBlockers:       safeStrArr(f.blockers),
      approvalWarnings:       safeStrArr((f as unknown as Record<string, unknown>)['warnings']),
      rawFields:              extractRawFields(f),
      latestObsScore,
      latestObsAgeMinutes,
      latestObsPriceChangePct,
      scoreDelta,
    });
  }

  // Sort: priced first (winners desc, then losers asc), then pending
  candidates.sort((a, b) => {
    if (a.outcomePctChange != null && b.outcomePctChange != null) {
      return b.outcomePctChange - a.outcomePctChange;
    }
    if (a.outcomePctChange != null) return -1;
    if (b.outcomePctChange != null) return  1;
    return 0;
  });

  // ── Step 5: Group stats ────────────────────────────────────────────────────
  const winners = candidates.filter(c => c.classification === 'WINNER');
  const losers  = candidates.filter(c => c.classification === 'LOSER');
  const pending = candidates.filter(c => c.classification === 'PENDING_PRICE');

  const winnerStats = buildGroupStats(winners);
  const loserStats  = buildGroupStats(losers);

  const possibleSeparators = computePossibleSeparators(winners, losers, winnerStats, loserStats);

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalsRead,
    observationsRead,
    outcomesRead,
    totalCandidates:  candidates.length,
    winnersCount:     winners.length,
    losersCount:      losers.length,
    pendingCount:     pending.length,
    candidates,
    winnerStats,
    loserStats,
    possibleSeparators,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined, decimals = 1): string {
  if (n == null) return 'n/a';
  return n.toFixed(decimals);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtScore(n: number | null | undefined): string {
  return n != null ? String(Math.round(n)).padStart(3) : '  ?';
}

function fmtAge(m: number | null | undefined): string {
  if (m == null) return 'n/a';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function shortKey(k: string): string {
  return k.length > 16 ? `${k.slice(0, 16)}…` : k;
}

function fmtGroupStats(label: string, gs: GroupStats): string[] {
  const lines: string[] = [];
  lines.push(`  ${label} (n=${gs.count}):`);
  if (gs.count === 0) { lines.push('    (no candidates)'); return lines; }
  lines.push(`    avg approval age  : ${fmtAge(gs.avgApprovalAge)}`);
  lines.push(`    avg approval score: ${fmtNum(gs.avgApprovalScore, 1)}`);
  lines.push(`    avg priceChangePct: ${fmtPct(gs.avgApprovalPriceChangePct)}`);
  if (gs.avgLiquidityUsd != null) lines.push(`    avg liquidityUsd  : $${gs.avgLiquidityUsd.toFixed(0)}`);
  if (gs.avgVolumeUsd    != null) lines.push(`    avg volumeUsd     : $${gs.avgVolumeUsd.toFixed(0)}`);
  if (gs.avgTxnCount     != null) lines.push(`    avg txnCount      : ${gs.avgTxnCount.toFixed(1)}`);
  if (gs.avgBuySellRatio != null) lines.push(`    avg buySellRatio  : ${(gs.avgBuySellRatio * 100).toFixed(1)}%`);
  // clusterRisk counts
  const riskStr = Object.entries(gs.clusterRiskCounts)
    .map(([k, v]) => `${k}:${v}`).join(' ');
  if (riskStr) lines.push(`    clusterRisk       : ${riskStr}`);
  // top reason phrases
  if (gs.topReasonPhrases.length > 0) {
    lines.push(`    top reasons       : ${gs.topReasonPhrases.slice(0, 5).map(p => `"${p.phrase}"(${p.count})`).join(', ')}`);
  }
  // warning phrases
  if (gs.warningPhrases.length > 0) {
    lines.push(`    warnings          : ${gs.warningPhrases.slice(0, 5).map(p => `"${p.phrase}"(${p.count})`).join(', ')}`);
  }
  // blocker phrases
  if (gs.blockerPhrases.length > 0) {
    lines.push(`    blockers          : ${gs.blockerPhrases.slice(0, 5).map(p => `"${p.phrase}"(${p.count})`).join(', ')}`);
  }
  return lines;
}

export function renderRipperEntryFeatureAutopsy(
  result: RipperEntryFeatureAutopsyResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER ENTRY FEATURE AUTOPSY');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — NO GATE CHANGES]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated           : ${result.generatedAt}`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files    : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Observation files : ${result.observationFilesRead}${result.observationFilesMissing > 0 ? ` (${result.observationFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files     : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  lines.push(`    Approvals read    : ${result.approvalsRead}`);
  lines.push(`    Observations read : ${result.observationsRead}`);
  lines.push(`    Outcomes read     : ${result.outcomesRead}`);
  lines.push('');
  lines.push('  Candidates:');
  lines.push(`    Total             : ${result.totalCandidates}`);
  lines.push(`    Winners           : ${result.winnersCount}`);
  lines.push(`    Losers            : ${result.losersCount}`);
  lines.push(`    Pending price     : ${result.pendingCount}`);
  lines.push('');

  if (result.totalCandidates === 0) {
    lines.push('  (no candidates — check --approvals paths)');
    lines.push('');
  } else {
    // ── Per-candidate table ─────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  PER-CANDIDATE FEATURES');
    lines.push(`  ${SEP2}`);

    for (const c of result.candidates) {
      const sym = c.symbol ? `$${c.symbol}` : shortKey(c.contractKey);
      lines.push('');
      lines.push(`  ${sym}  [${c.classification}]  outcome: ${fmtPct(c.outcomePctChange)}  key: ${shortKey(c.contractKey)}`);
      lines.push(`    approval age: ${fmtAge(c.approvalAgeMinutes)}  score: ${fmtScore(c.approvalScore)}  priceChangePct: ${fmtPct(c.approvalPriceChangePct)}`);
      lines.push(`    clusterRisk: ${c.clusterRisk}${c.clusterProvider ? `  provider: ${c.clusterProvider}` : ''}`);
      if (c.liquidityUsd != null) lines.push(`    liquidityUsd: $${c.liquidityUsd.toFixed(0)}`);
      if (c.volumeUsd    != null) lines.push(`    volumeUsd: $${c.volumeUsd.toFixed(0)}`);
      if (c.txnCount     != null) lines.push(`    txnCount: ${c.txnCount}`);
      if (c.buys != null || c.sells != null) {
        lines.push(`    buys: ${c.buys ?? 'n/a'}  sells: ${c.sells ?? 'n/a'}  buySellRatio: ${c.buySellRatio != null ? (c.buySellRatio * 100).toFixed(1) + '%' : 'n/a'}`);
      }
      if (c.holderRiskHint) lines.push(`    holderRiskHint: ${c.holderRiskHint}`);
      if (c.latestObsScore != null || c.latestObsAgeMinutes != null) {
        lines.push(`    latest obs — age: ${fmtAge(c.latestObsAgeMinutes)}  score: ${fmtScore(c.latestObsScore)}  scoreDelta: ${c.scoreDelta != null ? (c.scoreDelta >= 0 ? '+' : '') + c.scoreDelta.toFixed(0) : 'n/a'}  priceChangePct: ${fmtPct(c.latestObsPriceChangePct)}`);
      }
      if (c.approvalTopReasons.length > 0) {
        lines.push(`    top reasons: ${c.approvalTopReasons.slice(0, 5).join(' | ')}`);
      }
      if (c.approvalBlockers.length > 0) {
        lines.push(`    blockers: ${c.approvalBlockers.slice(0, 5).join(' | ')}`);
      }
      if (c.approvalWarnings.length > 0) {
        lines.push(`    warnings: ${c.approvalWarnings.slice(0, 5).join(' | ')}`);
      }
      const rawKeys = Object.keys(c.rawFields);
      if (rawKeys.length > 0) {
        lines.push(`    raw: ${rawKeys.slice(0, 8).map(k => `${k}=${JSON.stringify(c.rawFields[k])}`).join('  ')}`);
      }
    }

    lines.push('');
    lines.push(`  ${SEP2}`);
    lines.push('  GROUP COMPARISON');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push(...fmtGroupStats('WINNERS', result.winnerStats));
    lines.push('');
    lines.push(...fmtGroupStats('LOSERS', result.loserStats));
    lines.push('');

    // ── Possible separators ─────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  POSSIBLE SEPARATORS');
    lines.push('  ⚠ Exploratory only. Tiny sample. Do not build gates from this.');
    lines.push(`  ${SEP2}`);
    lines.push('');
    if (result.possibleSeparators.length === 0) {
      lines.push('  (no meaningful differences detected in this sample)');
    } else {
      for (const sep of result.possibleSeparators) {
        lines.push(`  ${sep.field}`);
        lines.push(`    winners: ${sep.winnerValue}`);
        lines.push(`    losers : ${sep.loserValue}`);
        lines.push(`    ${sep.note}`);
        lines.push('');
      }
    }
    lines.push('');

    // ── Do Not Build Yet ────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  DO NOT BUILD YET');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  * Do not create gates from this sample.');
    lines.push('  * Do not enable real trading.');
    lines.push('  * Do not change scoring weights.');
    lines.push('  * Do not change BubbleMaps gate behavior.');
    lines.push('  * Need a much larger priced sample before any rule changes.');
    lines.push('  * Current sample size is too small to distinguish signal from noise.');
    lines.push('');
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperEntryFeatureAutopsyUsage(): string {
  return `
token:ripper-entry-feature-autopsy — compare approval features for winners vs losers

Usage:
  npm run token:ripper-entry-feature-autopsy -- \\
    --approvals    <cycle-jsonl...>   \\
    --observations <obs-jsonl...>     \\
    --outcomes     <outcome-json...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (from data/token-grab/ripper/observations/)
  --outcomes     <paths>   approved outcome JSON checkpoint files
  --help                   show this message

Output:
  Per-candidate: approval features (age, score, priceChangePct, clusterRisk, liquidity, volume,
    txns, buy/sell ratio, holder hint, top reasons, blockers, warnings, raw fields).
  Group comparison: winner vs loser averages for all numeric features.
  ClusterRisk distributions by group.
  Possible separators: fields where groups differ (exploratory — tiny sample warning).
  "Do Not Build Yet" section.

Classification:
  WINNER       — outcomePctChange > 0
  LOSER        — outcomePctChange <= 0
  PENDING_PRICE — no outcome price available yet

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
