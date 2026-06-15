import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MINUTES = 180;
const DANGER_TERMS = ['dangerous', 'rug', 'blacklist', 'honeypot', 'freeze', 'mint authority'];
const CHECKPOINTS: Array<{ label: string; offsetMs: number }> = [
  { label: '+5m',   offsetMs:   5 * 60_000 },
  { label: '+15m',  offsetMs:  15 * 60_000 },
  { label: '+30m',  offsetMs:  30 * 60_000 },
  { label: '+60m',  offsetMs:  60 * 60_000 },
  { label: '+120m', offsetMs: 120 * 60_000 },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ForwardEnrollCheckpoint {
  label:    string;
  targetAt: string;
}

export interface ForwardEnrollRow {
  symbol:          string | null;
  contract:        string;
  score:           number | null;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
  clusterRisk:     string;
  firstSeenAt:     string;
  enrolledAt:      string;
  policyName:      'LOOSE_60_WATCH';
  status:          'FORWARD_OBSERVATION_ENROLLED';
  checkpoints:     ForwardEnrollCheckpoint[];
}

export interface RipperLooseExtraForwardEnrollOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outPath:          string;
  maxAgeMinutes?:   number;
  nowIso?:          string; // injectable for deterministic testing
}

export interface RipperLooseExtraForwardEnrollResult {
  outPath:                string;
  looseExtrasFound:       number;
  alreadyEnrolledSkipped: number;
  tooOldSkipped:          number;
  newlyEnrolled:          number;
  totalEnrolled:          number;
  enrolledRows:           ForwardEnrollRow[]; // newly enrolled only
  reportOnly:             true;
  readOnly:               true;
  tradingExecuted:        0;
  realTradingLocked:      true;
  paperOnly:              true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function getRaw(f: LiveRipperFixture): Record<string, unknown> {
  return (f.raw as Record<string, unknown> | undefined) ?? {};
}

function getClusterRisk(f: LiveRipperFixture): string {
  const v = getRaw(f)['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' || v === 'UNKNOWN') return v as string;
  const ri = f.ripperInput as Record<string, unknown> | null;
  if (ri) {
    const rv = ri['clusterRisk'];
    if (rv === 'CLEAN' || rv === 'WATCH' || rv === 'RISKY' || rv === 'UNKNOWN') return rv as string;
  }
  return 'UNKNOWN';
}

function hasDanger(f: LiveRipperFixture): boolean {
  const combined = [...(f.blockers ?? []), ...(f.warnings ?? [])].map(s => s.toLowerCase());
  return DANGER_TERMS.some(term => combined.some(s => s.includes(term)));
}

function passesLoose60(f: LiveRipperFixture): boolean {
  const score = f.ripperScore ?? 0;
  if (score < 60) return false;
  const ed = f.entryDecision ?? '';
  if (ed !== 'READY_TO_SNIPE_PAPER' && ed !== 'WATCH') return false;
  const lab = f.launchAgeBucket ?? '';
  if (lab !== 'TOO_EARLY' && lab !== 'PRIME_WINDOW') return false;
  const cr = getClusterRisk(f);
  if (cr !== 'WATCH' && cr !== 'CLEAN' && cr !== 'LOW' && cr !== 'UNKNOWN') return false;
  if (hasDanger(f)) return false;
  return true;
}

function buildCheckpoints(firstSeenAt: string): ForwardEnrollCheckpoint[] {
  const baseMs = Date.parse(firstSeenAt);
  return CHECKPOINTS.map(c => ({
    label:    c.label,
    targetAt: new Date(baseMs + c.offsetMs).toISOString(),
  }));
}

function readExistingEnrollments(outPath: string): ForwardEnrollRow[] {
  if (!fs.existsSync(outPath)) return [];
  const lines = fs.readFileSync(outPath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  const rows: ForwardEnrollRow[] = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line) as ForwardEnrollRow); } catch { /* skip malformed */ }
  }
  return rows;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperLooseExtraForwardEnroll(
  options: RipperLooseExtraForwardEnrollOptions,
): RipperLooseExtraForwardEnrollResult {
  const nowIso     = options.nowIso ?? new Date().toISOString();
  const nowMs      = Date.parse(nowIso);
  const maxAgeMs   = (options.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES) * 60_000;
  const enrolledAt = nowIso;

  // Build current-approval and loose-60 maps
  const currentMap: Map<string, LiveRipperFixture> = new Map();
  const loose60Map: Map<string, LiveRipperFixture>  = new Map();

  for (const p of [...options.approvalPaths, ...options.observationPaths]) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const key = signalKey(f.normalizedSignal);
      if (f.buyGateDecision === 'BUY_APPROVED_PAPER' && !currentMap.has(key)) {
        currentMap.set(key, f);
      }
      if (passesLoose60(f) && !loose60Map.has(key)) {
        loose60Map.set(key, f);
      }
    }
  }

  const currentKeys = new Set(currentMap.keys());

  // Collect loose extras not in current approval
  const looseExtras: Array<{ key: string; fixture: LiveRipperFixture }> = [];
  for (const [key, f] of loose60Map) {
    if (!currentKeys.has(key)) looseExtras.push({ key, fixture: f });
  }

  // Read existing enrollments from --out for dedup
  const existingEnrollments = readExistingEnrollments(options.outPath);
  const existingKeys        = new Set(existingEnrollments.map(r => r.contract));

  // Enroll new candidates
  let alreadyEnrolledSkipped = 0;
  let tooOldSkipped          = 0;
  const newRows: ForwardEnrollRow[] = [];

  for (const { key, fixture: f } of looseExtras) {
    if (existingKeys.has(key)) {
      alreadyEnrolledSkipped++;
      continue;
    }
    const ageMs = nowMs - Date.parse(f.capturedAt);
    if (ageMs > maxAgeMs) {
      tooOldSkipped++;
      continue;
    }
    newRows.push({
      symbol:          f.normalizedSignal.symbol ?? null,
      contract:        key,
      score:           f.ripperScore ?? null,
      launchAgeBucket: f.launchAgeBucket ?? null,
      entryDecision:   f.entryDecision   ?? null,
      clusterRisk:     getClusterRisk(f),
      firstSeenAt:     f.capturedAt,
      enrolledAt,
      policyName:      'LOOSE_60_WATCH',
      status:          'FORWARD_OBSERVATION_ENROLLED',
      checkpoints:     buildCheckpoints(f.capturedAt),
    });
  }

  // Write existing + new to --out
  const allRows = [...existingEnrollments, ...newRows];
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const content = allRows.length > 0
    ? allRows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    outPath:                options.outPath,
    looseExtrasFound:       looseExtras.length,
    alreadyEnrolledSkipped,
    tooOldSkipped,
    newlyEnrolled:          newRows.length,
    totalEnrolled:          allRows.length,
    enrolledRows:           newRows,
    reportOnly:             true,
    readOnly:               true,
    tradingExecuted:        0,
    realTradingLocked:      true,
    paperOnly:              true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperLooseExtraForwardEnroll(
  result: RipperLooseExtraForwardEnrollResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LOOSE EXTRA FORWARD ENROLL');
  lines.push('  [EXPERIMENT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  Output path           : ${result.outPath}`);
  lines.push(`  Total enrolled        : ${result.totalEnrolled}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  ENROLLMENT SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Loose extras found    : ${result.looseExtrasFound}`);
  lines.push(`  Already enrolled skip : ${result.alreadyEnrolledSkipped}`);
  lines.push(`  Too old skipped       : ${result.tooOldSkipped}`);
  lines.push(`  Newly enrolled        : ${result.newlyEnrolled}`);
  lines.push('');

  if (result.enrolledRows.length > 0) {
    const top = [...result.enrolledRows]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 15);
    lines.push(`  ${SEP2}`);
    lines.push('  TOP NEWLY ENROLLED CANDIDATES');
    lines.push(`  ${SEP2}`, '');
    for (const r of top) {
      const sym = (r.symbol ?? '—').padEnd(12);
      const sc  = String(r.score ?? '—').padEnd(4);
      const age = (r.launchAgeBucket ?? '—').padEnd(14);
      const cr  = r.clusterRisk;
      lines.push(`  ${sym} score=${sc} ${age} ${cr}`);
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Enrollment only — no trades, no paper positions, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
