import * as fs from 'fs';
import { readPaperIntents } from './ripperPaperIntentLedger';
import { isPaperIntentOpen } from './ripperPaperIntentDue';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RipperPaperObservationDiagnosticResult {
  intentsPath:                    string;
  intentsRead:                    number;
  openIntents:                    number;
  dueIntents:                     number;
  observedIntents:                number;
  expiredIntents:                 number;
  obsFilesRead:                   number;
  obsRowsRead:                    number;
  uniqueObsContracts:             number;
  uniqueIntentContracts:          number;
  dueIntentContracts:             number;
  matchingContracts:              number;
  dueIntentsWithAnyObs:           number;
  dueIntentsWithObsAfterTarget:   number;
  approvedCycleCandidates:        number;
  approvedWithAnyObs:             number;
  approvedWithObsAfterApproved:   number;
  topMissingDue:                  string[];
  topMatchingContracts:           string[];
  reportOnly:                     true;
  readOnly:                       true;
  tradingExecuted:                0;
  realTradingLocked:              true;
  paperOnly:                      true;
}

export interface RipperPaperObservationDiagnosticOptions {
  intentsPath:      string;
  observationPaths: string[];
  cyclePaths:       string[];
  nowMs?:           number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

function buildObsMap(paths: string[]): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f          = JSON.parse(line) as Record<string, unknown>;
        const contract   = extractRipperContract(f);
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        const pct  = extractRipperPriceChangePct(f);
        const list = map.get(contract) ?? [];
        list.push({ capturedAt, priceChangePct: pct });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return map;
}

interface ApprovedCandidate {
  contract:    string;
  capturedAt:  string;
}

function readApprovedCandidates(cyclePaths: string[]): ApprovedCandidate[] {
  const seen    = new Set<string>();
  const result: ApprovedCandidate[] = [];
  for (const p of cyclePaths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
        const contract   = extractRipperContract(f);
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        const key = `${contract}::${capturedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ contract, capturedAt });
      } catch { /* skip */ }
    }
  }
  return result;
}

function countObsRows(paths: string[]): number {
  let total = 0;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    total += lines.length;
  }
  return total;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperPaperObservationDiagnostic(
  options: RipperPaperObservationDiagnosticOptions,
): RipperPaperObservationDiagnosticResult {
  const allObsPaths = [...options.observationPaths, ...options.cyclePaths];

  const intents         = readPaperIntents(options.intentsPath);
  const openIntents     = intents.filter(i => isPaperIntentOpen(i.status)).length;
  const dueIntents      = intents.filter(i => i.status === 'ENTRY_DUE');
  const observedIntents = intents.filter(i => i.status === 'OBSERVED').length;
  const expiredIntents  = intents.filter(i => i.status === 'EXPIRED_NO_DATA').length;

  const obsMap      = buildObsMap(allObsPaths);
  const obsRowsRead = countObsRows(allObsPaths);

  const allObsPaths2 = [...options.observationPaths, ...options.cyclePaths];
  const obsFilesRead = allObsPaths2.filter(p => fs.existsSync(p)).length;

  const uniqueObsContracts    = obsMap.size;
  const uniqueIntentContracts = new Set(intents.map(i => i.contract)).size;
  const dueContractSet        = new Set(dueIntents.map(i => i.contract));
  const dueIntentContracts    = dueContractSet.size;

  let dueIntentsWithAnyObs         = 0;
  let dueIntentsWithObsAfterTarget = 0;
  const missingDue: string[]    = [];
  const matchingList: string[]  = [];

  for (const intent of dueIntents) {
    const obs = obsMap.get(intent.contract) ?? [];
    const hasAny = obs.length > 0;
    const hasAfter = obs.some(o => o.capturedAt >= intent.targetEntryAt && o.priceChangePct != null);
    if (hasAny) dueIntentsWithAnyObs++;
    if (hasAfter) {
      dueIntentsWithObsAfterTarget++;
      matchingList.push(intent.contract);
    } else {
      missingDue.push(intent.contract);
    }
  }

  // Unique contracts among due intents that have obs with priceChangePct after targetEntryAt
  const matchingContracts = new Set(matchingList).size;

  const approvedCandidates = readApprovedCandidates(options.cyclePaths);
  let approvedWithAnyObs          = 0;
  let approvedWithObsAfterApproved = 0;
  for (const c of approvedCandidates) {
    const obs = obsMap.get(c.contract) ?? [];
    if (obs.length > 0) approvedWithAnyObs++;
    if (obs.some(o => o.capturedAt >= c.capturedAt)) approvedWithObsAfterApproved++;
  }

  return {
    intentsPath:                    options.intentsPath,
    intentsRead:                    intents.length,
    openIntents,
    dueIntents:                     dueIntents.length,
    observedIntents,
    expiredIntents,
    obsFilesRead,
    obsRowsRead,
    uniqueObsContracts,
    uniqueIntentContracts,
    dueIntentContracts,
    matchingContracts,
    dueIntentsWithAnyObs,
    dueIntentsWithObsAfterTarget,
    approvedCycleCandidates:        approvedCandidates.length,
    approvedWithAnyObs,
    approvedWithObsAfterApproved,
    topMissingDue:                  missingDue.slice(0, 10),
    topMatchingContracts:           matchingList.slice(0, 10),
    reportOnly:                     true,
    readOnly:                       true,
    tradingExecuted:                0,
    realTradingLocked:              true,
    paperOnly:                      true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperPaperObservationDiagnostic(
  result: RipperPaperObservationDiagnosticResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER PAPER OBSERVATION DIAGNOSTIC');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  INTENTS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Intents file          : ${result.intentsPath}`);
  lines.push(`  Intents read          : ${result.intentsRead}`);
  lines.push(`  Open (PLANNED+DUE)    : ${result.openIntents}`);
  lines.push(`  Due (ENTRY_DUE)       : ${result.dueIntents}`);
  lines.push(`  Observed              : ${result.observedIntents}`);
  lines.push(`  Expired / no data     : ${result.expiredIntents}`);
  lines.push(`  Unique intent contracts: ${result.uniqueIntentContracts}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  OBSERVATIONS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Obs files read        : ${result.obsFilesRead}`);
  lines.push(`  Obs rows read         : ${result.obsRowsRead}`);
  lines.push(`  Unique obs contracts  : ${result.uniqueObsContracts}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  MATCHING');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Due intent contracts  : ${result.dueIntentContracts}`);
  lines.push(`  Matching obs contracts: ${result.matchingContracts}`);
  lines.push(`  Due with any obs      : ${result.dueIntentsWithAnyObs}`);
  lines.push(`  Due with obs after target: ${result.dueIntentsWithObsAfterTarget}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  CYCLE CANDIDATES');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Approved candidates   : ${result.approvedCycleCandidates}`);
  lines.push(`  With any obs          : ${result.approvedWithAnyObs}`);
  lines.push(`  With obs after approval: ${result.approvedWithObsAfterApproved}`);
  lines.push('');

  if (result.topMatchingContracts.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  TOP MATCHING CONTRACTS (due intents with obs after targetEntryAt)');
    lines.push(`  ${SEP2}`, '');
    for (const c of result.topMatchingContracts) lines.push(`  ${c}`);
    lines.push('');
  }

  if (result.topMissingDue.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  TOP MISSING DUE CONTRACTS (no obs after targetEntryAt)');
    lines.push(`  ${SEP2}`, '');
    for (const c of result.topMissingDue) lines.push(`  ${c}`);
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * Report only — no trades, no paper positions, no gate changes.');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
