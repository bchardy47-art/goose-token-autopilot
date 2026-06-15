import * as fs from 'fs';
import * as path from 'path';
import type { LooseExtraObservationPlan } from './ripperLooseExtraObservationPlan';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FollowupStatus   = 'OBSERVED' | 'MISSING_OBSERVATION';
export type FollowupDecision = 'INSUFFICIENT_COVERAGE' | 'HOLD_CURRENT_GATES' | 'LOOSE_EXTRA_SHADOW_PROMISING';

export interface FollowupRow {
  symbol:          string | null;
  contract:        string;
  score:           number | null;
  clusterRisk:     string;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
  policyName:      string;
  checkpointLabel: string;
  targetAt:        string;
  observedAt?:     string;
  priceChangePct?: number | null;
  status:          FollowupStatus;
}

export interface FollowupSummary {
  candidatesInPlan:     number;
  checkpointsPlanned:   number;
  checkpointsObserved:  number;
  checkpointsMissing:   number;
  coveragePct:          number;
  observedMovedPlus1:   number;
  observedMovedPlus3:   number;
  observedMovedPlus5:   number;
  observedDumpedMinus3: number;
  top15Winners:         FollowupRow[];
  top15DumpRisks:       FollowupRow[];
  decision:             FollowupDecision;
  reportOnly:           true;
  readOnly:             true;
  tradingExecuted:      0;
  realTradingLocked:    true;
  paperOnly:            true;
}

export interface RipperLooseExtraObservationFollowupOptions {
  planPath:         string;
  observationPaths: string[];
  outPath:          string;
}

export interface RipperLooseExtraObservationFollowupResult {
  outPath:           string;
  rowsWritten:       number;
  summary:           FollowupSummary;
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

// ── Internal observation row ───────────────────────────────────────────────────

interface ObsRow {
  contract:      string;
  capturedAt:    string;
  priceChangePct: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readObservationRows(paths: string[]): ObsRow[] {
  const rows: ObsRow[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f   = JSON.parse(line) as Record<string, unknown>;
        const ns  = (f['normalizedSignal'] as Record<string, unknown> | undefined) ?? {};
        const raw = (f['raw'] as Record<string, unknown> | undefined) ?? {};
        const contract   = (ns['contract'] ?? raw['contract']) as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        let pricePct: number | null = null;
        if (typeof ns['priceChangePct'] === 'number') pricePct = ns['priceChangePct'];
        else if (typeof raw['priceChangePct'] === 'number') pricePct = raw['priceChangePct'];
        rows.push({ contract, capturedAt, priceChangePct: pricePct });
      } catch {
        // skip malformed lines
      }
    }
  }
  return rows;
}

function buildObsByContract(paths: string[]): Map<string, ObsRow[]> {
  const byContract = new Map<string, ObsRow[]>();
  for (const row of readObservationRows(paths)) {
    const list = byContract.get(row.contract) ?? [];
    list.push(row);
    byContract.set(row.contract, list);
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return byContract;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperLooseExtraObservationFollowup(
  options: RipperLooseExtraObservationFollowupOptions,
): RipperLooseExtraObservationFollowupResult {
  let plan: LooseExtraObservationPlan | null = null;
  if (fs.existsSync(options.planPath)) {
    plan = JSON.parse(fs.readFileSync(options.planPath, 'utf-8')) as LooseExtraObservationPlan;
  }

  const candidates   = plan?.candidates ?? [];
  const byContract   = buildObsByContract(options.observationPaths);
  const followupRows: FollowupRow[] = [];

  for (const candidate of candidates) {
    const obsForContract = byContract.get(candidate.contract) ?? [];

    for (const checkpoint of candidate.checkpoints) {
      const obs = obsForContract.find(o => o.capturedAt >= checkpoint.targetAt);

      if (obs) {
        followupRows.push({
          symbol:          candidate.symbol,
          contract:        candidate.contract,
          score:           candidate.score,
          clusterRisk:     candidate.clusterRisk,
          launchAgeBucket: candidate.launchAgeBucket,
          entryDecision:   candidate.entryDecision,
          policyName:      candidate.policyName,
          checkpointLabel: checkpoint.label,
          targetAt:        checkpoint.targetAt,
          observedAt:      obs.capturedAt,
          priceChangePct:  obs.priceChangePct,
          status:          'OBSERVED',
        });
      } else {
        followupRows.push({
          symbol:          candidate.symbol,
          contract:        candidate.contract,
          score:           candidate.score,
          clusterRisk:     candidate.clusterRisk,
          launchAgeBucket: candidate.launchAgeBucket,
          entryDecision:   candidate.entryDecision,
          policyName:      candidate.policyName,
          checkpointLabel: checkpoint.label,
          targetAt:        checkpoint.targetAt,
          status:          'MISSING_OBSERVATION',
        });
      }
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const jsonlContent = followupRows.length > 0
    ? followupRows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, jsonlContent, 'utf-8');

  // ── Summary ──────────────────────────────────────────────────────────────
  const checkpointsPlanned   = followupRows.length;
  const observed             = followupRows.filter(r => r.status === 'OBSERVED');
  const checkpointsObserved  = observed.length;
  const checkpointsMissing   = checkpointsPlanned - checkpointsObserved;
  const coveragePct          = checkpointsPlanned > 0
    ? Math.round((checkpointsObserved / checkpointsPlanned) * 100)
    : 0;

  const withPrice            = observed.filter(r => typeof r.priceChangePct === 'number');
  const observedMovedPlus1   = withPrice.filter(r => (r.priceChangePct as number) >= 1).length;
  const observedMovedPlus3   = withPrice.filter(r => (r.priceChangePct as number) >= 3).length;
  const observedMovedPlus5   = withPrice.filter(r => (r.priceChangePct as number) >= 5).length;
  const observedDumpedMinus3 = withPrice.filter(r => (r.priceChangePct as number) <= -3).length;

  const top15Winners    = [...withPrice]
    .sort((a, b) => (b.priceChangePct as number) - (a.priceChangePct as number))
    .slice(0, 15);

  const top15DumpRisks  = [...withPrice]
    .sort((a, b) => (a.priceChangePct as number) - (b.priceChangePct as number))
    .slice(0, 15);

  let decision: FollowupDecision;
  if (coveragePct < 70) {
    decision = 'INSUFFICIENT_COVERAGE';
  } else {
    const dumpRatePct     = checkpointsObserved > 0
      ? (observedDumpedMinus3 / checkpointsObserved) * 100
      : 0;
    const dumpRiskBad        = dumpRatePct > 30;
    const noMeaningfulMovers = observedMovedPlus5 === 0;
    decision = (dumpRiskBad || noMeaningfulMovers) ? 'HOLD_CURRENT_GATES' : 'LOOSE_EXTRA_SHADOW_PROMISING';
  }

  const summary: FollowupSummary = {
    candidatesInPlan:    candidates.length,
    checkpointsPlanned,
    checkpointsObserved,
    checkpointsMissing,
    coveragePct,
    observedMovedPlus1,
    observedMovedPlus3,
    observedMovedPlus5,
    observedDumpedMinus3,
    top15Winners,
    top15DumpRisks,
    decision,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };

  return {
    outPath:           options.outPath,
    rowsWritten:       followupRows.length,
    summary,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperLooseExtraObservationFollowup(
  result: RipperLooseExtraObservationFollowupResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const { summary } = result;
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LOOSE EXTRA OBSERVATION FOLLOWUP');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  Output path           : ${result.outPath}`);
  lines.push(`  Rows written          : ${result.rowsWritten}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  COVERAGE SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Candidates in plan    : ${summary.candidatesInPlan}`);
  lines.push(`  Checkpoints planned   : ${summary.checkpointsPlanned}`);
  lines.push(`  Checkpoints observed  : ${summary.checkpointsObserved}`);
  lines.push(`  Checkpoints missing   : ${summary.checkpointsMissing}`);
  lines.push(`  Coverage              : ${summary.coveragePct}%`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  MOVE DISTRIBUTION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Observed moved >= +1% : ${summary.observedMovedPlus1}`);
  lines.push(`  Observed moved >= +3% : ${summary.observedMovedPlus3}`);
  lines.push(`  Observed moved >= +5% : ${summary.observedMovedPlus5}`);
  lines.push(`  Observed dumped <=-3% : ${summary.observedDumpedMinus3}`);
  lines.push('');

  if (summary.top15Winners.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  TOP 15 OBSERVED WINNERS');
    lines.push(`  ${SEP2}`, '');
    for (const r of summary.top15Winners) {
      const sym = (r.symbol ?? r.contract.slice(0, 8)).padEnd(12);
      const lbl = r.checkpointLabel.padEnd(6);
      const pct = typeof r.priceChangePct === 'number'
        ? (r.priceChangePct >= 0 ? `+${r.priceChangePct.toFixed(1)}%` : `${r.priceChangePct.toFixed(1)}%`)
        : 'n/a';
      lines.push(`  ${sym} ${lbl} ${pct}`);
    }
    lines.push('');
  }

  if (summary.top15DumpRisks.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  TOP 15 OBSERVED DUMP RISKS');
    lines.push(`  ${SEP2}`, '');
    for (const r of summary.top15DumpRisks) {
      const sym = (r.symbol ?? r.contract.slice(0, 8)).padEnd(12);
      const lbl = r.checkpointLabel.padEnd(6);
      const pct = typeof r.priceChangePct === 'number'
        ? (r.priceChangePct >= 0 ? `+${r.priceChangePct.toFixed(1)}%` : `${r.priceChangePct.toFixed(1)}%`)
        : 'n/a';
      lines.push(`  ${sym} ${lbl} ${pct}`);
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  DECISION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  ${summary.decision}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Report only — no trades, no paper positions, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
