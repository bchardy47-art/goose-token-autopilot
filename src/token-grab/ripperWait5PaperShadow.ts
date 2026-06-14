import * as fs from 'fs';
import type { ScenarioRow } from './ripperApprovalFollowPaperSession';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShadowScenarioStats {
  scenario:      'ENTER_NOW' | 'WAIT_5M';
  enteredCount:  number;
  avgUpside:     number | null;
  medianUpside:  number | null;
  winRate:       number | null;
}

export interface RipperWait5PaperShadowResult {
  sessionPath:       string;
  totalApprovals:    number;
  enterNow:          ShadowScenarioStats;
  wait5m:            ShadowScenarioStats;
  deltaAvgUpside:    number | null;
  deltaMedianUpside: number | null;
  recommendation:    string;
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readRows(sessionPath: string): ScenarioRow[] {
  if (!fs.existsSync(sessionPath)) return [];
  const rows: ScenarioRow[] = [];
  for (const line of fs.readFileSync(sessionPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t) as ScenarioRow); } catch { /* skip malformed */ }
  }
  return rows;
}

function avg(vals: number[]): number | null {
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stats(rows: ScenarioRow[], scenario: 'ENTER_NOW' | 'WAIT_5M'): ShadowScenarioStats {
  const entered  = rows.filter(r => r.scenario === scenario && r.status === 'ENTERED_SIM');
  const upsides  = entered.map(r => r.currentUpsidePct).filter((v): v is number => v != null);
  const wins     = upsides.filter(u => u >= 1.0);
  return {
    scenario,
    enteredCount: entered.length,
    avgUpside:    avg(upsides),
    medianUpside: median(upsides),
    winRate:      entered.length > 0 ? wins.length / entered.length : null,
  };
}

function recommend(en: ShadowScenarioStats, w5: ShadowScenarioStats): string {
  const hasData = en.enteredCount > 0 || w5.enteredCount > 0;
  if (!hasData) return 'No ENTERED_SIM rows yet — keep collecting data';

  const avgBetter    = w5.avgUpside    != null && en.avgUpside    != null && w5.avgUpside    > en.avgUpside;
  const medianBetter = w5.medianUpside != null && en.medianUpside != null && w5.medianUpside > en.medianUpside;
  const winDelta     = (w5.winRate ?? 0) - (en.winRate ?? 0);
  const enWinMateriallyBetter = winDelta < -0.1 && (en.winRate ?? 0) > (w5.winRate ?? 0);

  if (avgBetter && medianBetter) {
    return 'WAIT_5M shows better avg and median upside — recommend WAIT_5M paper-shadow next';
  }
  if (enWinMateriallyBetter) {
    return 'ENTER_NOW has materially better win rate — keep ENTER_NOW as comparison shadow';
  }
  return 'Results are close — keep collecting data before acting';
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperWait5PaperShadow(sessionPath: string): RipperWait5PaperShadowResult {
  const rows         = readRows(sessionPath);
  const contracts    = new Set(rows.map(r => `${r.contract}::${r.approvedAt}`));
  const en           = stats(rows, 'ENTER_NOW');
  const w5           = stats(rows, 'WAIT_5M');
  const deltaAvg     = w5.avgUpside    != null && en.avgUpside    != null ? w5.avgUpside    - en.avgUpside    : null;
  const deltaMedian  = w5.medianUpside != null && en.medianUpside != null ? w5.medianUpside - en.medianUpside : null;

  return {
    sessionPath,
    totalApprovals:    contracts.size,
    enterNow:          en,
    wait5m:            w5,
    deltaAvgUpside:    deltaAvg,
    deltaMedianUpside: deltaMedian,
    recommendation:    recommend(en, w5),
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
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtRate(n: number | null): string {
  return n != null ? `${(n * 100).toFixed(0)}%` : 'n/a';
}

export function renderRipperWait5PaperShadow(r: RipperWait5PaperShadowResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER WAIT_5M PAPER SHADOW');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');
  lines.push(`  Session file     : ${r.sessionPath}`);
  lines.push(`  Total approvals  : ${r.totalApprovals}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  COMPARISON');
  lines.push(`  ${SEP2}`, '');

  const col = (label: string, en: string, w5: string) =>
    `  ${label.padEnd(22)}  ${en.padStart(10)}  ${w5.padStart(10)}`;

  lines.push(col('',               'ENTER_NOW', 'WAIT_5M'));
  lines.push(col('Entered sim',    String(r.enterNow.enteredCount), String(r.wait5m.enteredCount)));
  lines.push(col('Avg upside',     fmtPct(r.enterNow.avgUpside),    fmtPct(r.wait5m.avgUpside)));
  lines.push(col('Median upside',  fmtPct(r.enterNow.medianUpside), fmtPct(r.wait5m.medianUpside)));
  lines.push(col('Win rate',       fmtRate(r.enterNow.winRate),     fmtRate(r.wait5m.winRate)));
  lines.push('');
  lines.push(`  Delta avg upside (WAIT_5M − ENTER_NOW)    : ${fmtPct(r.deltaAvgUpside)}`);
  lines.push(`  Delta median upside (WAIT_5M − ENTER_NOW) : ${fmtPct(r.deltaMedianUpside)}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  RECOMMENDATION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  ${r.recommendation}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
