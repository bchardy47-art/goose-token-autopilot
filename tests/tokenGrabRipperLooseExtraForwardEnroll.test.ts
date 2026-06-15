import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLooseExtraForwardEnroll,
  renderRipperLooseExtraForwardEnroll,
  type ForwardEnrollRow,
} from '../src/token-grab/ripperLooseExtraForwardEnroll';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlefe-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Fixed "now" for deterministic age-filter tests
const NOW_TS = '2025-06-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_TS);
function atNow(ms: number): string { return new Date(NOW_MS + ms).toISOString(); }

const RECENT  = atNow(-60  * 60_000);  // 60 min ago — within 180 min default
const TOO_OLD = atNow(-200 * 60_000);  // 200 min ago — exceeds 180 min default

function makeFixture(opts: {
  contract?:        string;
  capturedAt?:      string;
  symbol?:          string;
  ripperScore?:     number;
  entryDecision?:   string;
  buyGateDecision?: string;
  launchAgeBucket?: string;
  clusterRisk?:     string;
  blockers?:        string[];
  warnings?:        string[];
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.symbol != null) sig['symbol'] = opts.symbol;
  const raw: Record<string, unknown> = {};
  if (opts.clusterRisk != null) raw['clusterRisk'] = opts.clusterRisk;
  return {
    id:               `f-${contract}`,
    capturedAt:       opts.capturedAt      ?? RECENT,
    source:           'test',
    sourceKind:       'test',
    normalizedSignal: sig,
    ripperInput:      null,
    ripperScore:      opts.ripperScore     ?? 65,
    entryDecision:    opts.entryDecision   ?? 'WATCH',
    buyGateDecision:  opts.buyGateDecision ?? 'BUY_REJECTED',
    launchAgeBucket:  opts.launchAgeBucket ?? 'PRIME_WINDOW',
    blockers:         opts.blockers        ?? [],
    topReasons:       [],
    warnings:         opts.warnings        ?? [],
    raw,
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

function loose60(contract: string, capturedAt = RECENT, extra: Partial<Parameters<typeof makeFixture>[0]> = {}): object {
  return makeFixture({ contract, capturedAt, ripperScore: 65, entryDecision: 'WATCH',
    launchAgeBucket: 'PRIME_WINDOW', clusterRisk: 'CLEAN', ...extra });
}

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function outPath(name = 'enroll.jsonl'): string {
  return path.join(tmpDir, name);
}

function readRows(p: string): ForwardEnrollRow[] {
  const content = fs.readFileSync(p, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(l => JSON.parse(l) as ForwardEnrollRow);
}

function writeExistingEnrollment(contract: string, name = 'enroll.jsonl'): string {
  const row: ForwardEnrollRow = {
    symbol: null, contract, score: 70, launchAgeBucket: 'PRIME_WINDOW',
    entryDecision: 'WATCH', clusterRisk: 'CLEAN',
    firstSeenAt: RECENT, enrolledAt: NOW_TS,
    policyName: 'LOOSE_60_WATCH', status: 'FORWARD_OBSERVATION_ENROLLED',
    checkpoints: [],
  };
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(row) + '\n');
  return p;
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('safety fields never absent even with no inputs', () => {
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.reportOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
  });

  it('safety fields present when some inputs are missing files', () => {
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: ['/no/such/cycle.jsonl'],
      observationPaths: ['/no/such/obs.jsonl'],
      outPath: outPath(),
      nowIso: NOW_TS,
    });
    expect(r.reportOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });
});

// ── Empty / missing inputs ────────────────────────────────────────────────────

describe('empty / missing inputs', () => {
  it('writes empty JSONL and returns zero counts for empty inputs', () => {
    const op = outPath();
    const r  = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: op, nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
    expect(r.looseExtrasFound).toBe(0);
    expect(fs.existsSync(op)).toBe(true);
    expect(readRows(op)).toHaveLength(0);
  });

  it('skips missing observation files gracefully', () => {
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths:    [],
      observationPaths: ['/no/such/obs.jsonl'],
      outPath:          outPath(),
      nowIso:           NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('creates output file even when no candidates', () => {
    const op = outPath();
    runRipperLooseExtraForwardEnroll({ approvalPaths: [], observationPaths: [], outPath: op, nowIso: NOW_TS });
    expect(fs.existsSync(op)).toBe(true);
  });
});

// ── LOOSE_60_WATCH filter ─────────────────────────────────────────────────────

describe('LOOSE_60_WATCH filter', () => {
  it('enrolls candidate with score>=60, WATCH entry, PRIME_WINDOW, CLEAN cluster', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
  });

  it('excludes score < 60', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { ripperScore: 59 })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('excludes LATE launchAgeBucket', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { launchAgeBucket: 'LATE' })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('includes TOO_EARLY launchAgeBucket', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { launchAgeBucket: 'TOO_EARLY' })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
  });

  it('excludes RISKY cluster risk', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { clusterRisk: 'RISKY' })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('includes READY_TO_SNIPE_PAPER entryDecision', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { entryDecision: 'READY_TO_SNIPE_PAPER' })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
  });

  it('excludes honeypot in blockers', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { blockers: ['honeypot detected'] })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('excludes rug in warnings', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { warnings: ['possible rug'] })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });

  it('excludes mint authority in warnings', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT, { warnings: ['mint authority not renounced'] })]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
  });
});

// ── CURRENT_APPROVAL exclusion ────────────────────────────────────────────────

describe('CURRENT_APPROVAL exclusion', () => {
  it('excludes contracts already in CURRENT_APPROVAL', () => {
    const cycles = writeJsonl('cycles.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);
    const obs = writeJsonl('obs.jsonl', [
      loose60('AAAA'), // passes loose60 but is current
      loose60('BBBB'), // new extra
    ]);
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: [cycles], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
    expect(r.enrolledRows[0].contract).toBe('BBBB');
  });

  it('detects BUY_APPROVED_PAPER from obs fixtures (dual-source)', () => {
    const obs = writeJsonl('obs.jsonl', [
      makeFixture({ contract: 'AAAA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      loose60('AAAA'), // same contract, also passes loose60 — but excluded
      loose60('BBBB'),
    ]);
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    const contracts = r.enrolledRows.map(e => e.contract);
    expect(contracts).not.toContain('AAAA');
    expect(contracts).toContain('BBBB');
  });
});

// ── Max age filter ────────────────────────────────────────────────────────────

describe('max age filter', () => {
  it('enrolls candidate within default 180-minute window', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
    expect(r.tooOldSkipped).toBe(0);
  });

  it('skips candidate older than 180 minutes (default)', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', TOO_OLD)]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(0);
    expect(r.tooOldSkipped).toBe(1);
  });

  it('respects custom --max-age-minutes', () => {
    const justUnder30 = atNow(-29 * 60_000); // 29 min ago
    const justOver30  = atNow(-31 * 60_000); // 31 min ago
    const obs = writeJsonl('obs.jsonl', [
      loose60('AAAA', justUnder30),
      loose60('BBBB', justOver30),
    ]);
    const r = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(),
      maxAgeMinutes: 30, nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
    expect(r.tooOldSkipped).toBe(1);
    expect(r.enrolledRows[0].contract).toBe('AAAA');
  });

  it('enrolls candidate at exactly the age boundary', () => {
    const exactBoundary = atNow(-180 * 60_000); // exactly 180 min ago
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', exactBoundary)]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    // ageMs === maxAgeMs → not > maxAgeMs → enrolled
    expect(r.newlyEnrolled).toBe(1);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('deduplication against existing --out', () => {
  it('skips already-enrolled contracts', () => {
    const op  = writeExistingEnrollment('AAAA');
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(r.alreadyEnrolledSkipped).toBe(1);
    expect(r.newlyEnrolled).toBe(0);
  });

  it('enrolls new contracts even when some already enrolled', () => {
    const op  = writeExistingEnrollment('AAAA');
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA'), loose60('BBBB')]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(r.alreadyEnrolledSkipped).toBe(1);
    expect(r.newlyEnrolled).toBe(1);
    expect(r.enrolledRows[0].contract).toBe('BBBB');
  });

  it('preserves existing rows in output when adding new ones', () => {
    const op  = writeExistingEnrollment('AAAA');
    const obs = writeJsonl('obs.jsonl', [loose60('BBBB')]);
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const rows = readRows(op);
    expect(rows.map(r => r.contract)).toContain('AAAA');
    expect(rows.map(r => r.contract)).toContain('BBBB');
  });

  it('rerun with same inputs does not duplicate', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const r2 = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(r2.newlyEnrolled).toBe(0);
    expect(r2.alreadyEnrolledSkipped).toBe(1);
    const rows = readRows(op);
    expect(rows.filter(r => r.contract === 'AAAA')).toHaveLength(1);
  });
});

// ── Enrolled row fields ───────────────────────────────────────────────────────

describe('enrolled row fields', () => {
  it('row has all required identity fields', () => {
    const obs = writeJsonl('obs.jsonl', [
      loose60('AAAA', RECENT, { symbol: 'TOKEN', ripperScore: 72,
        launchAgeBucket: 'PRIME_WINDOW', entryDecision: 'WATCH', clusterRisk: 'CLEAN' }),
    ]);
    const op = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const row = readRows(op)[0];
    expect(row.contract).toBe('AAAA');
    expect(row.symbol).toBe('TOKEN');
    expect(row.score).toBe(72);
    expect(row.launchAgeBucket).toBe('PRIME_WINDOW');
    expect(row.entryDecision).toBe('WATCH');
    expect(row.clusterRisk).toBe('CLEAN');
    expect(row.policyName).toBe('LOOSE_60_WATCH');
    expect(row.status).toBe('FORWARD_OBSERVATION_ENROLLED');
  });

  it('enrolledAt matches nowIso', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)[0].enrolledAt).toBe(NOW_TS);
  });

  it('firstSeenAt matches fixture capturedAt', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)[0].firstSeenAt).toBe(RECENT);
  });

  it('symbol is null when not present in fixture', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA')]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)[0].symbol).toBeNull();
  });
});

// ── Checkpoints ───────────────────────────────────────────────────────────────

describe('checkpoints', () => {
  it('each enrolled row has exactly 5 checkpoints', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)[0].checkpoints).toHaveLength(5);
  });

  it('checkpoint labels are +5m, +15m, +30m, +60m, +120m', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)[0].checkpoints.map(c => c.label)).toEqual([
      '+5m', '+15m', '+30m', '+60m', '+120m',
    ]);
  });

  it('+5m targetAt is firstSeenAt + 5 minutes', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const row  = readRows(op)[0];
    const base = Date.parse(row.firstSeenAt);
    expect(row.checkpoints[0].targetAt).toBe(new Date(base + 5 * 60_000).toISOString());
  });

  it('+120m targetAt is firstSeenAt + 120 minutes', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA', RECENT)]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const row  = readRows(op)[0];
    const base = Date.parse(row.firstSeenAt);
    expect(row.checkpoints[4].targetAt).toBe(new Date(base + 120 * 60_000).toISOString());
  });
});

// ── Output JSONL ──────────────────────────────────────────────────────────────

describe('output JSONL', () => {
  it('each line is valid JSON', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA'), loose60('BBBB')]);
    const op  = outPath();
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const lines = fs.readFileSync(op, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('totalEnrolled matches rows in output file', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA'), loose60('BBBB')]);
    const op  = outPath();
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(readRows(op)).toHaveLength(r.totalEnrolled);
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'dir', 'enroll.jsonl');
    runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: nested, nowIso: NOW_TS,
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('deduplicates by contract within a single run', () => {
    // Same contract appears twice in observations — only one enrollment
    const obs = writeJsonl('obs.jsonl', [
      loose60('AAAA', RECENT, { ripperScore: 65 }),
      loose60('AAAA', atNow(-30 * 60_000), { ripperScore: 70 }), // duplicate contract
    ]);
    const op = outPath();
    const r  = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    expect(r.newlyEnrolled).toBe(1);
    expect(readRows(op).filter(row => row.contract === 'AAAA')).toHaveLength(1);
  });
});

// ── Result counts ─────────────────────────────────────────────────────────────

describe('result counts', () => {
  it('looseExtrasFound counts extras not in current approval', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA'), loose60('BBBB')]);
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: outPath(), nowIso: NOW_TS,
    });
    expect(r.looseExtrasFound).toBe(2);
  });

  it('totalEnrolled includes previously enrolled + newly enrolled', () => {
    const existing = writeExistingEnrollment('AAAA');
    const obs      = writeJsonl('obs.jsonl', [loose60('BBBB')]);
    const r        = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: existing, nowIso: NOW_TS,
    });
    expect(r.totalEnrolled).toBe(2); // 1 existing + 1 new
    expect(r.newlyEnrolled).toBe(1);
  });

  it('outPath in result matches provided path', () => {
    const op = outPath('my-enroll.jsonl');
    const r  = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: op, nowIso: NOW_TS,
    });
    expect(r.outPath).toBe(op);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and experiment-only header', () => {
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowIso: NOW_TS,
    });
    const out = renderRipperLooseExtraForwardEnroll(r);
    expect(out).toContain('LOOSE EXTRA FORWARD ENROLL');
    expect(out).toContain('EXPERIMENT ONLY');
    expect(out).toContain('NO TRADES');
  });

  it('includes enrollment summary section', () => {
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowIso: NOW_TS,
    });
    const out = renderRipperLooseExtraForwardEnroll(r);
    expect(out).toContain('ENROLLMENT SUMMARY');
    expect(out).toContain('Loose extras found');
    expect(out).toContain('Newly enrolled');
    expect(out).toContain('Too old skipped');
    expect(out).toContain('Already enrolled skip');
  });

  it('shows top newly enrolled candidates when enrollments exist', () => {
    const obs = writeJsonl('obs.jsonl', [
      loose60('AAAA', RECENT, { symbol: 'WINNER', ripperScore: 80 }),
    ]);
    const op  = outPath();
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const out = renderRipperLooseExtraForwardEnroll(r);
    expect(out).toContain('TOP NEWLY ENROLLED CANDIDATES');
    expect(out).toContain('WINNER');
  });

  it('includes safety footer', () => {
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [], outPath: outPath(), nowIso: NOW_TS,
    });
    const out = renderRipperLooseExtraForwardEnroll(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('DO NOT CHANGE APPROVAL GATES');
    expect(out).toContain('DO NOT WIRE INTO RIPPER-AUTOPILOT');
    expect(out).toContain('DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  });

  it('shows total enrolled count', () => {
    const obs = writeJsonl('obs.jsonl', [loose60('AAAA'), loose60('BBBB')]);
    const op  = outPath();
    const r   = runRipperLooseExtraForwardEnroll({
      approvalPaths: [], observationPaths: [obs], outPath: op, nowIso: NOW_TS,
    });
    const out = renderRipperLooseExtraForwardEnroll(r);
    expect(out).toContain('2');
    expect(out).toContain(op);
  });
});
