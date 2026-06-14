import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionApprovalSource = 'obs' | 'file' | 'both';

export type EntryScenario = 'ENTER_NOW' | 'WAIT_3M' | 'WAIT_5M' | 'WAIT_15M';

export type ScenarioStatus =
  | 'PENDING_ENTRY'
  | 'ENTERED_SIM'
  | 'NO_ENTRY_OBS_YET'
  | 'NO_AFTER_DATA';

export interface ScenarioRow {
  contract:              string;
  symbol:                string | null;
  approvedAt:            string;
  approvalSource:        SessionApprovalSource;
  scenario:              EntryScenario;
  plannedEntryAt:        string;
  observedEntryAt:       string | null;
  entryPriceChangePct:   number | null;
  currentBestAfterPct:   number | null;
  currentUpsidePct:      number | null;
  status:                ScenarioStatus;
  generatedAt:           string;
}

export interface RipperApprovalFollowPaperSessionOptions {
  observationPaths: string[];
  approvalPaths:    string[];
  outPath:          string;
}

export interface RipperApprovalFollowPaperSessionResult {
  approvalsFound:           number;
  newRowsAppended:          number;
  existingRowsSkipped:      number;
  pendingEntryCount:        number;
  enteredSimCount:          number;
  noEntryObsYetCount:       number;
  noAfterDataCount:         number;
  outPath:                  string;
  reportOnly:               true;
  readOnly:                 true;
  tradingExecuted:          0;
  realTradingLocked:        true;
  paperOnly:                true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SCENARIO_DELAYS_MS: Record<EntryScenario, number> = {
  ENTER_NOW: 0,
  WAIT_3M:   3 * 60_000,
  WAIT_5M:   5 * 60_000,
  WAIT_15M:  15 * 60_000,
};

const ALL_SCENARIOS: EntryScenario[] = ['ENTER_NOW', 'WAIT_3M', 'WAIT_5M', 'WAIT_15M'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface ObsRecord {
  capturedAtMs:   number;
  capturedAt:     string;
  priceChangePct: number | null;
}

function firstAtOrAfter(sorted: ObsRecord[], targetMs: number): ObsRecord | null {
  for (const o of sorted) {
    if (o.capturedAtMs >= targetMs) return o;
  }
  return null;
}

function maxPct(obs: ObsRecord[]): number | null {
  let best: number | null = null;
  for (const o of obs) {
    if (o.priceChangePct != null && (best == null || o.priceChangePct > best)) best = o.priceChangePct;
  }
  return best;
}

function rowKey(contract: string, approvedAt: string, scenario: EntryScenario): string {
  return `${contract}::${approvedAt}::${scenario}`;
}

function readExistingRows(outPath: string): ScenarioRow[] {
  if (!fs.existsSync(outPath)) return [];
  const rows: ScenarioRow[] = [];
  const lines = fs.readFileSync(outPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed) as ScenarioRow); } catch { /* skip malformed */ }
  }
  return rows;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovalFollowPaperSession(
  options: RipperApprovalFollowPaperSessionOptions,
): RipperApprovalFollowPaperSessionResult {
  const generatedAt = new Date().toISOString();

  // ── Load observations ──────────────────────────────────────────────────────
  const allObsMap       = new Map<string, ObsRecord[]>();
  const symbolMap       = new Map<string, string>();
  const obsApprovalsMap = new Map<string, number[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const contractKey  = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;

      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      const pct = toFiniteNum(sig['priceChangePct']);
      const sym = f.normalizedSignal.symbol;

      if (sym && !symbolMap.has(contractKey)) symbolMap.set(contractKey, sym);

      const rec: ObsRecord = { capturedAtMs, capturedAt: f.capturedAt, priceChangePct: pct };
      const list = allObsMap.get(contractKey);
      if (list) list.push(rec);
      else allObsMap.set(contractKey, [rec]);

      if (f.buyGateDecision === 'BUY_APPROVED_PAPER') {
        const list2 = obsApprovalsMap.get(contractKey);
        if (list2) list2.push(capturedAtMs);
        else obsApprovalsMap.set(contractKey, [capturedAtMs]);
      }
    }
  }

  for (const list of allObsMap.values()) {
    list.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  }

  // Latest obs timestamp across all contracts — used to determine PENDING_ENTRY
  let latestObsMs = 0;
  for (const list of allObsMap.values()) {
    if (list.length > 0) {
      const last = list[list.length - 1].capturedAtMs;
      if (last > latestObsMs) latestObsMs = last;
    }
  }

  // ── Load file approvals ────────────────────────────────────────────────────
  const instanceKeySet   = new Set<string>();
  const fileApprovalsMap = new Map<string, number[]>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey  = signalKey(f.normalizedSignal);
      const instanceKey  = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) continue;
      instanceKeySet.add(instanceKey);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      const list = fileApprovalsMap.get(contractKey);
      if (list) list.push(capturedAtMs);
      else fileApprovalsMap.set(contractKey, [capturedAtMs]);
      const sym = f.normalizedSignal.symbol;
      if (sym && !symbolMap.has(contractKey)) symbolMap.set(contractKey, sym);
    }
  }

  // ── Load existing rows to detect duplicates ────────────────────────────────
  const existingKeys = new Set<string>();
  const existingRows = readExistingRows(options.outPath);
  for (const row of existingRows) {
    existingKeys.add(rowKey(row.contract, row.approvedAt, row.scenario));
  }

  // ── Build new scenario rows ────────────────────────────────────────────────
  const allApprovedKeys = new Set([...obsApprovalsMap.keys(), ...fileApprovalsMap.keys()]);
  const newRows: ScenarioRow[] = [];
  let existingRowsSkipped = 0;

  for (const contractKey of allApprovedKeys) {
    const obsApprTimes  = obsApprovalsMap.get(contractKey)  ?? [];
    const fileApprTimes = fileApprovalsMap.get(contractKey) ?? [];
    const obsApproved   = obsApprTimes.length  > 0;
    const fileApproved  = fileApprTimes.length > 0;

    const earliestObs  = obsApproved  ? Math.min(...obsApprTimes)  : Infinity;
    const earliestFile = fileApproved ? Math.min(...fileApprTimes) : Infinity;
    const approvedAtMs = Math.min(earliestObs, earliestFile);
    const approvedAt   = new Date(approvedAtMs).toISOString();
    const approvalSource: SessionApprovalSource =
      obsApproved && fileApproved ? 'both' : obsApproved ? 'obs' : 'file';

    const allObs  = allObsMap.get(contractKey) ?? [];
    const afterObs = allObs.filter(o => o.capturedAtMs > approvedAtMs);

    for (const scenario of ALL_SCENARIOS) {
      const key = rowKey(contractKey, approvedAt, scenario);
      if (existingKeys.has(key)) {
        existingRowsSkipped++;
        continue;
      }

      const delayMs        = SCENARIO_DELAYS_MS[scenario];
      const plannedEntryMs = approvedAtMs + delayMs;
      const plannedEntryAt = new Date(plannedEntryMs).toISOString();

      let observedEntryAt:     string | null = null;
      let entryPriceChangePct: number | null = null;
      let currentBestAfterPct: number | null = null;
      let currentUpsidePct:    number | null = null;
      let status:              ScenarioStatus;

      if (plannedEntryMs > latestObsMs) {
        // The planned entry time is in the future relative to latest observation
        status = 'PENDING_ENTRY';
      } else {
        const entryObs = firstAtOrAfter(allObs, plannedEntryMs);
        if (entryObs == null) {
          // plannedEntryAt has passed but no obs at or after it
          if (afterObs.length === 0) {
            status = 'NO_AFTER_DATA';
          } else {
            status = 'NO_ENTRY_OBS_YET';
          }
        } else {
          observedEntryAt     = entryObs.capturedAt;
          entryPriceChangePct = entryObs.priceChangePct;
          const obsAfterEntry = allObs.filter(o => o.capturedAtMs > entryObs.capturedAtMs);
          currentBestAfterPct = maxPct(obsAfterEntry);
          currentUpsidePct    = currentBestAfterPct != null && entryPriceChangePct != null
            ? currentBestAfterPct - entryPriceChangePct
            : null;
          status = 'ENTERED_SIM';
        }
      }

      newRows.push({
        contract:            contractKey,
        symbol:              symbolMap.get(contractKey) ?? null,
        approvedAt,
        approvalSource,
        scenario,
        plannedEntryAt,
        observedEntryAt,
        entryPriceChangePct,
        currentBestAfterPct,
        currentUpsidePct,
        status,
        generatedAt,
      });
    }
  }

  // ── Append new rows to output file ─────────────────────────────────────────
  if (newRows.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    const lines = newRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(options.outPath, lines, 'utf-8');
  }

  // ── Summary counts ─────────────────────────────────────────────────────────
  const allRows         = [...existingRows, ...newRows];
  const pendingCount    = allRows.filter(r => r.status === 'PENDING_ENTRY').length;
  const enteredCount    = allRows.filter(r => r.status === 'ENTERED_SIM').length;
  const noObsYetCount   = allRows.filter(r => r.status === 'NO_ENTRY_OBS_YET').length;
  const noAfterCount    = allRows.filter(r => r.status === 'NO_AFTER_DATA').length;

  return {
    approvalsFound:      allApprovedKeys.size,
    newRowsAppended:     newRows.length,
    existingRowsSkipped,
    pendingEntryCount:   pendingCount,
    enteredSimCount:     enteredCount,
    noEntryObsYetCount:  noObsYetCount,
    noAfterDataCount:    noAfterCount,
    outPath:             options.outPath,
    reportOnly:          true,
    readOnly:            true,
    tradingExecuted:     0,
    realTradingLocked:   true,
    paperOnly:           true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperApprovalFollowPaperSession(
  result: RipperApprovalFollowPaperSessionResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVAL FOLLOW PAPER SESSION');
  lines.push('  [SIMULATION ONLY — NO REAL TRADES — NO REAL POSITIONS — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Output path          : ${result.outPath}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  RUN SUMMARY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push(`  Approvals found      : ${result.approvalsFound}`);
  lines.push(`  New rows appended    : ${result.newRowsAppended}`);
  lines.push(`  Existing rows skipped: ${result.existingRowsSkipped}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  SESSION STATUS (all rows including prior)');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push(`  PENDING_ENTRY        : ${result.pendingEntryCount}`);
  lines.push(`  ENTERED_SIM          : ${result.enteredSimCount}`);
  lines.push(`  NO_ENTRY_OBS_YET     : ${result.noEntryObsYetCount}`);
  lines.push(`  NO_AFTER_DATA        : ${result.noAfterDataCount}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  STATUS KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  PENDING_ENTRY     plannedEntryAt is after the latest observation — not yet reached');
  lines.push('  ENTERED_SIM       entry observation found — entryPriceChangePct and upside recorded');
  lines.push('  NO_ENTRY_OBS_YET  plannedEntryAt passed but no observation found at/after that time');
  lines.push('  NO_AFTER_DATA     no observations at all after approval time');
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Simulation journal only — no real or paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CALL AUTO-PAPER');
  lines.push('  * DO NOT CALL PAPER-BUY');
  lines.push('');
  lines.push(`  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
