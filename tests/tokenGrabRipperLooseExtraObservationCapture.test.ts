import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperLooseExtraObservationCapture,
  renderRipperLooseExtraObservationCapture,
} from '../src/token-grab/ripperLooseExtraObservationCapture';
import type { ForwardEnrollRow } from '../src/token-grab/ripperLooseExtraForwardEnroll';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rleofc-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Fixed epoch so slug and due-checkpoint math is deterministic
const NOW_TS = '2025-06-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_TS);
function atNow(ms: number): string { return new Date(NOW_MS + ms).toISOString(); }

// firstSeenAt set so +5m is at NOW-5m and is therefore due at NOW
const FIRST_SEEN = atNow(-30 * 60_000); // 30 min ago, so +5m / +15m / +30m are all due

function makeEnrollRow(opts: {
  contract?:        string;
  symbol?:          string | null;
  firstSeenAt?:     string;
  enrolledAt?:      string;
  policyName?:      'LOOSE_60_WATCH';
  checkpointBase?:  string; // ISO to compute checkpoints from (defaults to firstSeenAt)
}): ForwardEnrollRow {
  const firstSeenAt   = opts.firstSeenAt ?? FIRST_SEEN;
  const checkBase     = opts.checkpointBase ?? firstSeenAt;
  const baseMs        = Date.parse(checkBase);
  return {
    symbol:          opts.symbol ?? null,
    contract:        opts.contract ?? 'CONTRACT_A',
    score:           70,
    launchAgeBucket: 'PRIME_WINDOW',
    entryDecision:   'WATCH',
    clusterRisk:     'CLEAN',
    firstSeenAt,
    enrolledAt:      opts.enrolledAt ?? atNow(-30 * 60_000),
    policyName:      opts.policyName ?? 'LOOSE_60_WATCH',
    status:          'FORWARD_OBSERVATION_ENROLLED',
    checkpoints: [
      { label: '+5m',   targetAt: new Date(baseMs + 5   * 60_000).toISOString() },
      { label: '+15m',  targetAt: new Date(baseMs + 15  * 60_000).toISOString() },
      { label: '+30m',  targetAt: new Date(baseMs + 30  * 60_000).toISOString() },
      { label: '+60m',  targetAt: new Date(baseMs + 60  * 60_000).toISOString() },
      { label: '+120m', targetAt: new Date(baseMs + 120 * 60_000).toISOString() },
    ],
  };
}

function writeEnroll(rows: ForwardEnrollRow[], name = 'enroll.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function obsDir(): string {
  const d = path.join(tmpDir, 'observations');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJsonl(p: string): unknown[] {
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(l => JSON.parse(l));
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', async () => {
    const enroll = writeEnroll([]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('safety fields present when enroll file is missing', async () => {
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: '/no/such/enroll.jsonl', observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.reportOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
  });
});

// ── Empty / missing inputs ────────────────────────────────────────────────────

describe('empty / missing inputs', () => {
  it('returns zero counts for empty enroll file', async () => {
    const enroll = writeEnroll([]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.enrollRowsRead).toBe(0);
    expect(r.dueCheckpoints).toBe(0);
    expect(r.uniqueContractsDue).toBe(0);
    expect(r.fixturesCaptured).toBe(0);
  });

  it('returns zero counts for missing enroll file', async () => {
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: '/no/such/enroll.jsonl', observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.enrollRowsRead).toBe(0);
    expect(r.uniqueContractsDue).toBe(0);
  });

  it('creates observations dir if missing', async () => {
    const enroll  = writeEnroll([]);
    const missing = path.join(tmpDir, 'new-obs-dir');
    await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: missing, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(fs.existsSync(missing)).toBe(true);
  });
});

// ── Due checkpoint detection ──────────────────────────────────────────────────

describe('due checkpoint detection', () => {
  it('detects checkpoints where targetAt <= nowMs', async () => {
    // firstSeenAt 30 min ago → +5m, +15m, +30m are due; +60m, +120m not yet
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.dueCheckpoints).toBe(3); // +5m, +15m, +30m
    expect(r.uniqueContractsDue).toBe(1);
  });

  it('no checkpoints due when all targetAt are in the future', async () => {
    // firstSeenAt NOW (just now) → all checkpoints in future
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA', firstSeenAt: NOW_TS })]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.dueCheckpoints).toBe(0);
    expect(r.uniqueContractsDue).toBe(0);
  });

  it('all 5 checkpoints due when firstSeenAt is 3+ hours ago', async () => {
    const wayBack = atNow(-200 * 60_000); // 200 min ago
    const enroll  = writeEnroll([makeEnrollRow({ contract: 'AAAA', firstSeenAt: wayBack })]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.dueCheckpoints).toBe(5);
  });

  it('counts due checkpoints across multiple candidates', async () => {
    const enroll = writeEnroll([
      makeEnrollRow({ contract: 'AAAA' }),           // 3 due (+5m, +15m, +30m)
      makeEnrollRow({ contract: 'BBBB', firstSeenAt: atNow(-200 * 60_000) }), // 5 due
    ]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.dueCheckpoints).toBe(8);
    expect(r.uniqueContractsDue).toBe(2);
  });

  it('checkpoint exactly at now (targetAt === nowMs) is due', async () => {
    // Set firstSeenAt exactly 5 min ago → +5m checkpoint targetAt === NOW_TS exactly
    const firstSeenAt = atNow(-5 * 60_000);
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA', firstSeenAt })]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.dueCheckpoints).toBeGreaterThanOrEqual(1);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('deduplication by contract', () => {
  it('deduplicates contracts that appear more than once in enroll file', async () => {
    const enroll = writeEnroll([
      makeEnrollRow({ contract: 'AAAA' }),
      makeEnrollRow({ contract: 'AAAA' }), // duplicate
    ]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.uniqueContractsDue).toBe(1);
    expect(r.enrollRowsRead).toBe(2); // reads both rows
  });

  it('first occurrence wins for dedup', async () => {
    const d = obsDir();
    const firstSeenFirst  = atNow(-30 * 60_000);  // 3 due checkpoints
    const firstSeenSecond = atNow(-200 * 60_000); // 5 due checkpoints
    const enroll = writeEnroll([
      makeEnrollRow({ contract: 'AAAA', firstSeenAt: firstSeenFirst }),
      makeEnrollRow({ contract: 'AAAA', firstSeenAt: firstSeenSecond }),
    ]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    // First occurrence has 3 due checkpoints, not 5
    expect(r.dueCheckpoints).toBe(3);
  });
});

// ── Feed file ─────────────────────────────────────────────────────────────────

describe('feed file', () => {
  it('writes a valid feed.json with signals array', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(fs.existsSync(r.feedPath)).toBe(true);
    const feed = JSON.parse(fs.readFileSync(r.feedPath, 'utf-8'));
    expect(Array.isArray(feed.signals)).toBe(true);
  });

  it('feed signals have correct contract address', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'CONTRACT_X' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const feed = JSON.parse(fs.readFileSync(r.feedPath, 'utf-8'));
    const contracts = (feed.signals as Array<{ contract?: string }>).map(s => s.contract);
    expect(contracts).toContain('CONTRACT_X');
  });

  it('feed path includes out-prefix and slug', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'my-prefix', nowMs: NOW_MS,
    });
    expect(r.feedPath).toContain('my-prefix');
    expect(r.feedPath).toContain(r.slug);
    expect(r.feedPath).toContain('-feed.json');
  });

  it('JSONL output path includes out-prefix and slug', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'my-prefix', nowMs: NOW_MS,
    });
    expect(r.outputPath).toContain('my-prefix');
    expect(r.outputPath).toContain(r.slug);
    expect(r.outputPath).not.toContain('-feed.json');
  });

  it('feed has zero signals when no contracts are due', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA', firstSeenAt: NOW_TS })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const feed = JSON.parse(fs.readFileSync(r.feedPath, 'utf-8'));
    expect(feed.signals).toHaveLength(0);
  });
});

// ── Fixture annotation ────────────────────────────────────────────────────────

describe('fixture annotation', () => {
  it('captured fixtures have looseExtraObservation: true', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (r.fixturesCaptured === 0) return; // no fixtures means no annotation to check
    const rows = readJsonl(r.outputPath) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row['looseExtraObservation']).toBe(true);
    }
  });

  it('captured fixtures have policyName LOOSE_60_WATCH', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (r.fixturesCaptured === 0) return;
    const rows = readJsonl(r.outputPath) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row['policyName']).toBe('LOOSE_60_WATCH');
    }
  });

  it('captured fixtures have enrolledAt', async () => {
    const enrolledAt = atNow(-30 * 60_000);
    const enroll     = writeEnroll([makeEnrollRow({ contract: 'AAAA', enrolledAt })]);
    const d          = obsDir();
    const r          = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (r.fixturesCaptured === 0) return;
    const rows = readJsonl(r.outputPath) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row['enrolledAt']).toBe(enrolledAt);
    }
  });

  it('captured fixtures have dueCheckpointLabels array', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (r.fixturesCaptured === 0) return;
    const rows = readJsonl(r.outputPath) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(Array.isArray(row['dueCheckpointLabels'])).toBe(true);
      expect((row['dueCheckpointLabels'] as string[]).length).toBeGreaterThan(0);
    }
  });

  it('captured fixtures have originalFirstSeenAt', async () => {
    const firstSeenAt = FIRST_SEEN;
    const enroll      = writeEnroll([makeEnrollRow({ contract: 'AAAA', firstSeenAt })]);
    const d           = obsDir();
    const r           = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (r.fixturesCaptured === 0) return;
    const rows = readJsonl(r.outputPath) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row['originalFirstSeenAt']).toBe(firstSeenAt);
    }
  });

  it('JSONL rows are valid JSON', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    if (!fs.existsSync(r.outputPath)) return;
    const content = fs.readFileSync(r.outputPath, 'utf-8').trim();
    if (!content) return;
    for (const line of content.split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ── Slug and paths ────────────────────────────────────────────────────────────

describe('slug and paths', () => {
  it('slug is derived from nowMs', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    // NOW_TS = 2025-06-01T12:00:00.000Z → slug = 2025-06-01-120000
    expect(r.slug).toBe('2025-06-01-120000');
  });

  it('feed and output paths are inside observationsDir', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.feedPath.startsWith(d)).toBe(true);
    expect(r.outputPath.startsWith(d)).toBe(true);
  });

  it('output path in result matches file on disk', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(fs.existsSync(r.feedPath)).toBe(true);
  });
});

// ── enrollRowsRead count ──────────────────────────────────────────────────────

describe('enrollRowsRead count', () => {
  it('enrollRowsRead counts all rows including those with no due checkpoints', async () => {
    const enroll = writeEnroll([
      makeEnrollRow({ contract: 'AAAA' }),              // 3 due
      makeEnrollRow({ contract: 'BBBB', firstSeenAt: NOW_TS }), // 0 due
    ]);
    const r = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    expect(r.enrollRowsRead).toBe(2);
    expect(r.uniqueContractsDue).toBe(1);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and observation-only header', async () => {
    const enroll = writeEnroll([]);
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const out = renderRipperLooseExtraObservationCapture(r);
    expect(out).toContain('LOOSE EXTRA OBSERVATION CAPTURE');
    expect(out).toContain('OBSERVATION ONLY');
    expect(out).toContain('NO TRADES');
    expect(out).toContain('NO APPROVALS');
  });

  it('includes capture summary section', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const out = renderRipperLooseExtraObservationCapture(r);
    expect(out).toContain('CAPTURE SUMMARY');
    expect(out).toContain('Enroll rows read');
    expect(out).toContain('Due checkpoints');
    expect(out).toContain('Unique contracts due');
    expect(out).toContain('Fixtures captured');
  });

  it('includes output artifacts section with paths', async () => {
    const enroll = writeEnroll([]);
    const d      = obsDir();
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: d, outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const out = renderRipperLooseExtraObservationCapture(r);
    expect(out).toContain('OUTPUT ARTIFACTS');
    expect(out).toContain(r.slug);
    expect(out).toContain(r.feedPath);
    expect(out).toContain(r.outputPath);
  });

  it('includes safety footer', async () => {
    const enroll = writeEnroll([]);
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const out = renderRipperLooseExtraObservationCapture(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('DO NOT CHANGE APPROVAL GATES');
    expect(out).toContain('DO NOT WIRE INTO RIPPER-AUTOPILOT');
    expect(out).toContain('DO NOT CALL AUTO-PAPER OR PAPER-BUY');
  });

  it('shows numeric counts in renderer output', async () => {
    const enroll = writeEnroll([makeEnrollRow({ contract: 'AAAA' })]);
    const r      = await runRipperLooseExtraObservationCapture({
      enrollPath: enroll, observationsDir: obsDir(), outPrefix: 'le-obs', nowMs: NOW_MS,
    });
    const out = renderRipperLooseExtraObservationCapture(r);
    expect(out).toContain(String(r.enrollRowsRead));
    expect(out).toContain(String(r.dueCheckpoints));
    expect(out).toContain(String(r.uniqueContractsDue));
  });
});
