import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ObservationCheckpoint {
  label:    string;
  targetAt: string;
}

export interface LooseExtraCandidate {
  symbol:          string | null;
  contract:        string;
  contractShort:   string;
  score:           number | null;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
  clusterRisk:     string;
  firstSeenAt:     string;
  policyName:      'LOOSE_60_WATCH';
  status:          'PLANNED_OBSERVATION_ONLY';
  checkpoints:     ObservationCheckpoint[];
}

export interface LooseExtraObservationPlan {
  generatedAt:   string;
  policyName:    'LOOSE_60_WATCH';
  totalExtras:   number;
  candidates:    LooseExtraCandidate[];
  reportOnly:    true;
  readOnly:      true;
  tradingExecuted: 0;
  realTradingLocked: true;
  paperOnly:     true;
}

export interface RipperLooseExtraObservationPlanOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outPath:          string;
}

export interface RipperLooseExtraObservationPlanResult {
  outPath:         string;
  totalExtras:     number;
  written:         boolean;
  reportOnly:      true;
  readOnly:        true;
  tradingExecuted: 0;
  realTradingLocked: true;
  paperOnly:       true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DANGER_TERMS = ['dangerous', 'rug', 'blacklist', 'honeypot', 'freeze', 'mint authority'];

const CHECKPOINTS: Array<{ label: string; offsetMs: number }> = [
  { label: '+5m',   offsetMs:   5 * 60_000 },
  { label: '+15m',  offsetMs:  15 * 60_000 },
  { label: '+30m',  offsetMs:  30 * 60_000 },
  { label: '+60m',  offsetMs:  60 * 60_000 },
  { label: '+120m', offsetMs: 120 * 60_000 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
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

function buildCheckpoints(firstSeenAt: string): ObservationCheckpoint[] {
  const baseMs = Date.parse(firstSeenAt);
  return CHECKPOINTS.map(c => ({
    label:    c.label,
    targetAt: new Date(baseMs + c.offsetMs).toISOString(),
  }));
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperLooseExtraObservationPlan(
  options: RipperLooseExtraObservationPlanOptions,
): RipperLooseExtraObservationPlanResult {
  const generatedAt = new Date().toISOString();

  const currentMap: Map<string, LiveRipperFixture> = new Map();
  const loose60Map: Map<string, LiveRipperFixture> = new Map();

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
  const candidates: LooseExtraCandidate[] = [];

  for (const [key, f] of loose60Map) {
    if (currentKeys.has(key)) continue; // overlap — skip

    candidates.push({
      symbol:          f.normalizedSignal.symbol ?? null,
      contract:        key,
      contractShort:   shortKey(key),
      score:           f.ripperScore ?? null,
      launchAgeBucket: f.launchAgeBucket ?? null,
      entryDecision:   f.entryDecision   ?? null,
      clusterRisk:     getClusterRisk(f),
      firstSeenAt:     f.capturedAt,
      policyName:      'LOOSE_60_WATCH',
      status:          'PLANNED_OBSERVATION_ONLY',
      checkpoints:     buildCheckpoints(f.capturedAt),
    });
  }

  candidates.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));

  const plan: LooseExtraObservationPlan = {
    generatedAt,
    policyName:        'LOOSE_60_WATCH',
    totalExtras:       candidates.length,
    candidates,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };

  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  fs.writeFileSync(options.outPath, JSON.stringify(plan, null, 2), 'utf-8');

  return {
    outPath:           options.outPath,
    totalExtras:       candidates.length,
    written:           true,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperLooseExtraObservationPlan(
  result: RipperLooseExtraObservationPlanResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LOOSE EXTRA OBSERVATION PLAN');
  lines.push('  [OBSERVATION PLAN ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');
  lines.push(`  Output path  : ${result.outPath}`);
  lines.push(`  Extra extras : ${result.totalExtras}`);
  lines.push(`  Written      : ${result.written}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  PLAN STATUS');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Policy       : LOOSE_60_WATCH (extras only)`);
  lines.push(`  Checkpoints  : +5m, +15m, +30m, +60m, +120m per candidate`);
  lines.push(`  Status field : PLANNED_OBSERVATION_ONLY`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Observation plan only — no trades, no paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('  * DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  lines.push('  * DO NOT WIRE INTO RIPPER-AUTOPILOT');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push(SEP, '');
  return lines.join('\n');
}
