import * as fs from 'fs';
import type { EntryScenario, ScenarioRow, ScenarioStatus } from './ripperApprovalFollowPaperSession';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScenarioStats {
  scenario:          EntryScenario;
  totalRows:         number;
  enteredSimCount:   number;
  pendingCount:      number;
  noEntryObsYetCount: number;
  noAfterDataCount:  number;
  avgUpside:         number | null;
  medianUpside:      number | null;
  winCount:          number;
  winRate:           number | null;
  bestUpside:        number | null;
  worstUpside:       number | null;
}

export interface RipperApprovalFollowPaperSessionReportOptions {
  sessionPath: string;
}

export interface RipperApprovalFollowPaperSessionReportResult {
  generatedAt:            string;
  sessionPath:            string;
  totalSessionRows:       number;
  scenarioStats:          ScenarioStats[];
  bestByAvgUpside:        EntryScenario | null;
  bestByMedianUpside:     EntryScenario | null;
  bestByWinRate:          EntryScenario | null;
  recommendation:         string;
  reportOnly:             true;
  readOnly:               true;
  tradingExecuted:        0;
  realTradingLocked:      true;
  paperOnly:              true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_SCENARIOS: EntryScenario[] = ['ENTER_NOW', 'WAIT_3M', 'WAIT_5M', 'WAIT_15M'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcAvg(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function calcMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readSessionRows(sessionPath: string): ScenarioRow[] {
  if (!fs.existsSync(sessionPath)) return [];
  const rows: ScenarioRow[] = [];
  const lines = fs.readFileSync(sessionPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed) as ScenarioRow); } catch { /* skip malformed */ }
  }
  return rows;
}

function buildStats(scenario: EntryScenario, rows: ScenarioRow[]): ScenarioStats {
  const mine       = rows.filter(r => r.scenario === scenario);
  const entered    = mine.filter(r => r.status === 'ENTERED_SIM');
  const upsides    = entered.map(r => r.currentUpsidePct).filter((v): v is number => v != null);
  const wins       = upsides.filter(u => u >= 1.0);
  const winRate    = entered.length > 0 ? wins.length / entered.length : null;
  const bestUpside  = upsides.length > 0 ? Math.max(...upsides) : null;
  const worstUpside = upsides.length > 0 ? Math.min(...upsides) : null;

  return {
    scenario,
    totalRows:          mine.length,
    enteredSimCount:    entered.length,
    pendingCount:       mine.filter(r => r.status === 'PENDING_ENTRY').length,
    noEntryObsYetCount: mine.filter(r => r.status === 'NO_ENTRY_OBS_YET').length,
    noAfterDataCount:   mine.filter(r => r.status === 'NO_AFTER_DATA').length,
    avgUpside:          calcAvg(upsides),
    medianUpside:       calcMedian(upsides),
    winCount:           wins.length,
    winRate,
    bestUpside,
    worstUpside,
  };
}

function pickBest<K extends keyof ScenarioStats>(
  stats:    ScenarioStats[],
  field:    K,
): EntryScenario | null {
  let best: ScenarioStats | null = null;
  for (const s of stats) {
    const v = s[field];
    if (v == null) continue;
    if (best == null || (v as number) > (best[field] as number)) best = s;
  }
  return best?.scenario ?? null;
}

function buildRecommendation(
  bestAvg:    EntryScenario | null,
  bestMedian: EntryScenario | null,
  bestWin:    EntryScenario | null,
  stats:      ScenarioStats[],
  totalRows:  number,
): string {
  if (totalRows === 0) return 'No session data — run token:ripper-approval-follow-paper-session first';

  const entered = stats.reduce((n, s) => n + s.enteredSimCount, 0);
  if (entered === 0) return 'No ENTERED_SIM rows yet — keep collecting data';

  const noDataFrac = stats.reduce((n, s) => n + s.noAfterDataCount, 0) / totalRows;
  if (noDataFrac > 0.5) return 'Too much NO_AFTER_DATA — keep collecting observations';

  // Consensus: count how many of the three metrics agree on a winner
  const candidates = [bestAvg, bestMedian, bestWin].filter((v): v is EntryScenario => v != null);
  const tally = new Map<EntryScenario, number>();
  for (const c of candidates) tally.set(c, (tally.get(c) ?? 0) + 1);

  let topScenario: EntryScenario | null = null;
  let topVotes    = 0;
  for (const [scenario, votes] of tally) {
    if (votes > topVotes) { topVotes = votes; topScenario = scenario; }
  }

  if (topScenario == null) return 'Mixed signal — review scenario rows individually';

  const winnerStats = stats.find(s => s.scenario === topScenario)!;
  const avgStr      = winnerStats.avgUpside != null ? `avg upside ${winnerStats.avgUpside.toFixed(2)}%` : 'limited upside data';

  if (topScenario === 'ENTER_NOW') {
    return `Immediate simulated entry is favored (${avgStr}, win rate ${fmtRate(winnerStats.winRate)})`;
  }
  if (topScenario === 'WAIT_3M' || topScenario === 'WAIT_5M' || topScenario === 'WAIT_15M') {
    const label = topScenario === 'WAIT_3M' ? '3m' : topScenario === 'WAIT_5M' ? '5m' : '15m';
    return `Delayed simulated entry is favored — wait ${label} after approval (${avgStr}, win rate ${fmtRate(winnerStats.winRate)})`;
  }
  return 'Mixed signal — review scenario rows individually';
}

function fmtRate(r: number | null): string {
  return r != null ? `${(r * 100).toFixed(0)}%` : 'n/a';
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovalFollowPaperSessionReport(
  options: RipperApprovalFollowPaperSessionReportOptions,
): RipperApprovalFollowPaperSessionReportResult {
  const generatedAt = new Date().toISOString();
  const rows        = readSessionRows(options.sessionPath);

  const scenarioStats  = ALL_SCENARIOS.map(s => buildStats(s, rows));
  const bestByAvg      = pickBest(scenarioStats, 'avgUpside');
  const bestByMedian   = pickBest(scenarioStats, 'medianUpside');
  const bestByWinRate  = pickBest(scenarioStats, 'winRate');
  const recommendation = buildRecommendation(bestByAvg, bestByMedian, bestByWinRate, scenarioStats, rows.length);

  return {
    generatedAt,
    sessionPath:      options.sessionPath,
    totalSessionRows: rows.length,
    scenarioStats,
    bestByAvgUpside:    bestByAvg,
    bestByMedianUpside: bestByMedian,
    bestByWinRate,
    recommendation,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function renderRipperApprovalFollowPaperSessionReport(
  result: RipperApprovalFollowPaperSessionReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVAL FOLLOW PAPER SESSION REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated        : ${result.generatedAt}`);
  lines.push(`  Session file     : ${result.sessionPath}`);
  lines.push(`  Total session rows: ${result.totalSessionRows}`);
  lines.push('');

  // ── Per-scenario table ─────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SCENARIO STATS');
  lines.push(`  ${SEP2}`);
  lines.push('');

  const hdr = [
    'scenario'.padEnd(10),
    'total'.padStart(6),
    'entered'.padStart(8),
    'pending'.padStart(8),
    'noObsYet'.padStart(9),
    'noAfter'.padStart(8),
    'avgUp'.padStart(8),
    'medUp'.padStart(8),
    'wins'.padStart(5),
    'winRate'.padStart(8),
    'best'.padStart(8),
    'worst'.padStart(8),
  ].join('  ');
  lines.push(`  ${hdr}`);
  lines.push(`  ${'─'.repeat(hdr.length)}`);

  for (const s of result.scenarioStats) {
    const row = [
      s.scenario.padEnd(10),
      String(s.totalRows).padStart(6),
      String(s.enteredSimCount).padStart(8),
      String(s.pendingCount).padStart(8),
      String(s.noEntryObsYetCount).padStart(9),
      String(s.noAfterDataCount).padStart(8),
      fmtPct(s.avgUpside).padStart(8),
      fmtPct(s.medianUpside).padStart(8),
      String(s.winCount).padStart(5),
      fmtRate(s.winRate).padStart(8),
      fmtPct(s.bestUpside).padStart(8),
      fmtPct(s.worstUpside).padStart(8),
    ].join('  ');
    lines.push(`  ${row}`);
  }
  lines.push('');

  // ── Best scenario summary ──────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  BEST SCENARIO');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push(`  Best by avg upside    : ${result.bestByAvgUpside    ?? 'n/a'}`);
  lines.push(`  Best by median upside : ${result.bestByMedianUpside ?? 'n/a'}`);
  lines.push(`  Best by win rate      : ${result.bestByWinRate      ?? 'n/a'}`);
  lines.push('');
  lines.push(`  Recommendation: ${result.recommendation}`);
  lines.push('');

  // ── Safety ─────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Report-only — no real or paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CALL AUTO-PAPER');
  lines.push('  * DO NOT CALL PAPER-BUY');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
