// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Watch-profile enrollment — tags learning-memory rows matching winner-profile
// candidates for out-of-sample outcome tracking.
// Does NOT change any gate, policy, or trading decision.
// Append-only JSONL output. Deduplicates by contract + profileName.

import * as fs from 'fs';
import * as path from 'path';

// ── Profile definitions ───────────────────────────────────────────────────────

export interface WatchProfileDef {
  name:  string;
  label: string;
  matches: (row: MemoryRow) => boolean;
}

interface MemoryRow {
  contract?:       string;
  capturedAt?:     string;
  cycleId?:        string;
  memoryUniverse?: string;
  gateDecision?:   string;
  liquidityBucket?: string | null;
  vlrBucket?:      string | null;
  clusterRisk?:    string | null;
  timingPath?:     string | null;
  ripperScore?:    number | null;
  launchAgeBucket?: string | null;
  [k: string]: unknown;
}

export const WATCH_PROFILE_DEFS: WatchProfileDef[] = [
  {
    name:  'VLR_0_5_TO_2+CLUSTER_UNKNOWN',
    label: 'vlrBucket=VLR_0_5_TO_2 + clusterRisk=UNKNOWN',
    matches: (r) =>
      r.vlrBucket === 'VLR_0_5_TO_2' && r.clusterRisk === 'UNKNOWN',
  },
  {
    name:  'LIQ_30K_100K+VLR_0_5_TO_2',
    label: 'liquidityBucket=LIQ_30K_100K + vlrBucket=VLR_0_5_TO_2',
    matches: (r) =>
      r.liquidityBucket === 'LIQ_30K_100K' && r.vlrBucket === 'VLR_0_5_TO_2',
  },
  {
    name:  'LIQ_30K_100K+VLR_0_5_TO_2+ENTER_NOW',
    label: 'liquidityBucket=LIQ_30K_100K + vlrBucket=VLR_0_5_TO_2 + timingPath=ENTER_NOW',
    matches: (r) =>
      r.liquidityBucket === 'LIQ_30K_100K' &&
      r.vlrBucket      === 'VLR_0_5_TO_2' &&
      r.timingPath     === 'ENTER_NOW',
  },
];

// ── Enrollment row ────────────────────────────────────────────────────────────

export interface WatchProfileEnrollmentRow {
  enrolledAt:      string;
  capturedAt:      string;
  contract:        string;
  profileName:     string;
  profileLabel:    string;
  liquidityBucket: string | null;
  vlrBucket:       string | null;
  clusterRisk:     string | null;
  timingPath:      string | null;
  ripperScore:     number | null;
  launchAgeBucket: string | null;
  cycleId:         string | null;
  memoryUniverse:  string | null;
  gateDecision:    string | null;
  reportOnly:      true;
  readOnly:        true;
  paperOnly:       true;
  realTradingLocked: true;
  tradingExecuted: 0;
}

// ── Result / options ──────────────────────────────────────────────────────────

export interface WatchProfileEnrollmentResult {
  memoryRowsRead:      number;
  profilesChecked:     number;
  enrollmentsAppended: number;
  duplicatesSkipped:   number;
  perProfile: {
    profileName:    string;
    profileLabel:   string;
    newEnrollments: number;
    totalEnrolled:  number;
  }[];
  outPath:          string;
  reportOnly:       true;
  readOnly:         true;
  tradingExecuted:  0;
  realTradingLocked: true;
  paperOnly:        true;
}

export interface WatchProfileEnrollmentOptions {
  learningMemoryPath?: string;
  outPath?:            string;
  nowMs?:              number;
  profiles?:           WatchProfileDef[];  // override for testing
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function dupKey(contract: string, profileName: string): string {
  return `${contract}::${profileName}`;
}

function loadExistingKeys(outPath: string): Set<string> {
  const keys = new Set<string>();
  for (const line of readLines(outPath)) {
    try {
      const r = JSON.parse(line) as Partial<WatchProfileEnrollmentRow>;
      if (r.contract && r.profileName) keys.add(dupKey(r.contract, r.profileName));
    } catch { /* skip */ }
  }
  return keys;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runWatchProfileEnrollment(
  options: WatchProfileEnrollmentOptions = {},
): WatchProfileEnrollmentResult {
  const memoryPath = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';
  const outPath = options.outPath
    ?? 'data/token-grab/ripper/watch-profile-enrollments.jsonl';
  const nowMs   = options.nowMs ?? Date.now();
  const profiles = options.profiles ?? WATCH_PROFILE_DEFS;
  const enrolledAt = new Date(nowMs).toISOString();

  const existingKeys = loadExistingKeys(outPath);

  const perProfileNew:   Record<string, number> = {};
  const perProfileTotal: Record<string, number> = {};
  for (const p of profiles) {
    perProfileNew[p.name]   = 0;
    perProfileTotal[p.name] = 0;
  }

  // Pre-count existing totals per profile
  for (const key of existingKeys) {
    const profileName = key.split('::')[1] ?? '';
    if (profileName in perProfileTotal) {
      perProfileTotal[profileName] = (perProfileTotal[profileName] ?? 0) + 1;
    }
  }

  let memoryRowsRead  = 0;
  let enrollmentsAppended = 0;
  let duplicatesSkipped   = 0;
  const newRows: WatchProfileEnrollmentRow[] = [];

  for (const line of readLines(memoryPath)) {
    let row: MemoryRow;
    try {
      row = JSON.parse(line) as MemoryRow;
    } catch { continue; }

    if (typeof row.contract !== 'string' || !row.contract) continue;
    memoryRowsRead++;

    for (const profile of profiles) {
      if (!profile.matches(row)) continue;
      const key = dupKey(row.contract, profile.name);
      if (existingKeys.has(key)) {
        duplicatesSkipped++;
        continue;
      }
      existingKeys.add(key); // prevent double-enroll within this run
      perProfileNew[profile.name]   = (perProfileNew[profile.name] ?? 0) + 1;
      perProfileTotal[profile.name] = (perProfileTotal[profile.name] ?? 0) + 1;
      enrollmentsAppended++;
      newRows.push({
        enrolledAt,
        capturedAt:      typeof row.capturedAt === 'string' ? row.capturedAt : enrolledAt,
        contract:        row.contract,
        profileName:     profile.name,
        profileLabel:    profile.label,
        liquidityBucket: (row.liquidityBucket as string | null | undefined) ?? null,
        vlrBucket:       (row.vlrBucket as string | null | undefined) ?? null,
        clusterRisk:     (row.clusterRisk as string | null | undefined) ?? null,
        timingPath:      (row.timingPath as string | null | undefined) ?? null,
        ripperScore:     typeof row.ripperScore === 'number' ? row.ripperScore : null,
        launchAgeBucket: (row.launchAgeBucket as string | null | undefined) ?? null,
        cycleId:         typeof row.cycleId === 'string' ? row.cycleId : null,
        memoryUniverse:  typeof row.memoryUniverse === 'string' ? row.memoryUniverse : null,
        gateDecision:    typeof row.gateDecision === 'string' ? row.gateDecision : null,
        reportOnly:      true,
        readOnly:        true,
        paperOnly:       true,
        realTradingLocked: true,
        tradingExecuted: 0,
      });
    }
  }

  if (newRows.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.appendFileSync(outPath, newRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  return {
    memoryRowsRead,
    profilesChecked:     profiles.length,
    enrollmentsAppended,
    duplicatesSkipped,
    perProfile: profiles.map(p => ({
      profileName:    p.name,
      profileLabel:   p.label,
      newEnrollments: perProfileNew[p.name] ?? 0,
      totalEnrolled:  perProfileTotal[p.name] ?? 0,
    })),
    outPath,
    reportOnly:       true,
    readOnly:         true,
    tradingExecuted:  0,
    realTradingLocked: true,
    paperOnly:        true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderWatchProfileEnrollment(
  result: WatchProfileEnrollmentResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — WATCH PROFILE ENROLLMENT');
  lines.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  lines.push('  Tagging winner-profile candidates for out-of-sample outcome tracking.');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  ENROLLMENT SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Memory rows read     : ${result.memoryRowsRead}`);
  lines.push(`  Profiles checked     : ${result.profilesChecked}`);
  lines.push(`  New enrollments      : ${result.enrollmentsAppended}`);
  lines.push(`  Duplicates skipped   : ${result.duplicatesSkipped}`);
  lines.push(`  Output               : ${result.outPath}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  PER-PROFILE COUNTS');
  lines.push(`  ${SEP2}`, '');
  for (const p of result.perProfile) {
    lines.push(`  ${p.profileName}`);
    lines.push(`    Label          : ${p.profileLabel}`);
    lines.push(`    New enrollments: ${p.newEnrollments}`);
    lines.push(`    Total enrolled : ${p.totalEnrolled}`);
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0');
  lines.push('  realTradingLocked=true  paperOnly=true');
  lines.push('  HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('  Enrollment is append-only tagging. No gate or decision logic is changed.');
  lines.push(SEP, '');
  return lines.join('\n');
}
