import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovalFollowPaperSession,
  renderRipperApprovalFollowPaperSession,
  type ScenarioRow,
} from '../src/token-grab/ripperApprovalFollowPaperSession';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rafps-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, records: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function outPath(name = 'session.jsonl'): string {
  return path.join(tmpDir, name);
}

function readRows(p: string): ScenarioRow[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as ScenarioRow);
}

function makeObs(opts: {
  contract?:   string;
  capturedAt?: string;
  pct?:        number | null;
  symbol?:     string;
  approved?:   boolean;
}): object {
  const contract = opts.contract ?? 'AAAA';
  const sig: Record<string, unknown> = { contract };
  if (opts.pct    != null) sig['priceChangePct'] = opts.pct;
  if (opts.symbol != null) sig['symbol']         = opts.symbol;
  return {
    id:               `obs-${Math.random()}`,
    capturedAt:       opts.capturedAt ?? '2025-01-01T00:00:00.000Z',
    source:           'test',
    sourceKind:       'test',
    normalizedSignal: sig,
    ripperInput:      {},
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    buyGateDecision:  opts.approved ? 'BUY_APPROVED_PAPER' : 'NOT_APPROVED',
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

const T0    = '2025-01-01T00:00:00.000Z';
const T0MS  = Date.parse(T0);
const HOUR  = 3_600_000;

function atOffset(ms: number): string {
  return new Date(T0MS + ms).toISOString();
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          outPath(),
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────────

describe('empty inputs', () => {
  it('returns zero counts for empty paths', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          outPath(),
    });
    expect(result.approvalsFound).toBe(0);
    expect(result.newRowsAppended).toBe(0);
  });

  it('does not create outPath file when no rows', () => {
    const p = outPath();
    runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          p,
    });
    expect(fs.existsSync(p)).toBe(false);
  });

  it('skips missing input files gracefully', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: ['/no/such/path.jsonl'],
      approvalPaths:    ['/no/such/approval.jsonl'],
      outPath:          outPath(),
    });
    expect(result.approvalsFound).toBe(0);
  });
});

// ── Four scenarios per approval ───────────────────────────────────────────────

describe('four scenarios per approved contract', () => {
  it('appends exactly 4 scenario rows per approval', () => {
    // approval at T0, lots of future obs so all ENTERED_SIM
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,                 pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),   pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000),  pct: 3.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000),  pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(900_000),  pct: 5.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR),     pct: 6.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    expect(rows).toHaveLength(4);
    const scenarios = rows.map(r => r.scenario).sort();
    expect(scenarios).toEqual(['ENTER_NOW', 'WAIT_15M', 'WAIT_3M', 'WAIT_5M']);
  });

  it('scenarios include correct contract and approvedAt', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    for (const r of rows) {
      expect(r.contract).toBe('AAAA');
      expect(r.approvedAt).toBe(T0);
    }
  });
});

// ── Scenario plannedEntryAt ───────────────────────────────────────────────────

describe('plannedEntryAt', () => {
  it('ENTER_NOW plannedEntryAt equals approvedAt', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'ENTER_NOW')!;
    expect(row.plannedEntryAt).toBe(T0);
  });

  it('WAIT_3M plannedEntryAt is approvedAt + 3m', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'WAIT_3M')!;
    expect(row.plannedEntryAt).toBe(atOffset(3 * 60_000));
  });

  it('WAIT_5M plannedEntryAt is approvedAt + 5m', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'WAIT_5M')!;
    expect(row.plannedEntryAt).toBe(atOffset(5 * 60_000));
  });

  it('WAIT_15M plannedEntryAt is approvedAt + 15m', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'WAIT_15M')!;
    expect(row.plannedEntryAt).toBe(atOffset(15 * 60_000));
  });
});

// ── Status: PENDING_ENTRY ─────────────────────────────────────────────────────

describe('PENDING_ENTRY status', () => {
  it('all scenarios PENDING_ENTRY when latest obs is at approval time', () => {
    // Only obs is the approval itself — plannedEntry for WAIT_3M/5M/15M is after latest obs
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    // ENTER_NOW: plannedEntryAt=T0, latestObs=T0 → 0 > 0 is false so NOT pending? Actually: T0MS > T0MS is false.
    // WAIT_3M etc: plannedEntryAt = T0+3m > T0 = latestObs → PENDING
    const pending = rows.filter(r => r.status === 'PENDING_ENTRY');
    expect(pending.length).toBeGreaterThanOrEqual(3); // WAIT_3M, WAIT_5M, WAIT_15M
    const wait3 = rows.find(r => r.scenario === 'WAIT_3M')!;
    expect(wait3.status).toBe('PENDING_ENTRY');
    const wait5 = rows.find(r => r.scenario === 'WAIT_5M')!;
    expect(wait5.status).toBe('PENDING_ENTRY');
    const wait15 = rows.find(r => r.scenario === 'WAIT_15M')!;
    expect(wait15.status).toBe('PENDING_ENTRY');
  });

  it('PENDING_ENTRY rows have null entry fields', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.status === 'PENDING_ENTRY')!;
    expect(row.observedEntryAt).toBeNull();
    expect(row.entryPriceChangePct).toBeNull();
    expect(row.currentBestAfterPct).toBeNull();
    expect(row.currentUpsidePct).toBeNull();
  });
});

// ── Status: ENTERED_SIM ───────────────────────────────────────────────────────

describe('ENTERED_SIM status', () => {
  it('ENTER_NOW is ENTERED_SIM when obs exist after approval', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 4.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'ENTER_NOW')!;
    expect(row.status).toBe('ENTERED_SIM');
  });

  it('ENTERED_SIM populates observedEntryAt and entryPriceChangePct', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,               pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000), pct: 2.5 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR),   pct: 6.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'ENTER_NOW')!;
    // firstAtOrAfter T0 in allObs = the T0 obs itself (pct=1.0)
    expect(row.observedEntryAt).toBe(T0);
    expect(row.entryPriceChangePct).toBe(1.0);
  });

  it('ENTERED_SIM computes currentBestAfterPct from obs after entry obs', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 3.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(120_000), pct: 7.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    // ENTER_NOW: entry obs = T0 (pct=1.0), obsAfterEntry = [60s, 120s] → bestAfter=7.0
    const row = readRows(out).find(r => r.scenario === 'ENTER_NOW')!;
    expect(row.currentBestAfterPct).toBe(7.0);
    expect(row.currentUpsidePct).toBeCloseTo(6.0);
  });

  it('WAIT_3M uses first obs at/after T0+3m as entry', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(200_000), pct: 3.5 }), // just after +3m
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR),    pct: 8.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const row = readRows(out).find(r => r.scenario === 'WAIT_3M')!;
    expect(row.status).toBe('ENTERED_SIM');
    expect(row.entryPriceChangePct).toBe(3.5);
  });
});

// ── Status: NO_ENTRY_OBS_YET ─────────────────────────────────────────────────

describe('NO_ENTRY_OBS_YET status', () => {
  it('NO_ENTRY_OBS_YET when plannedEntryAt passed but obs stop before it', () => {
    // AAAA: approved at T0, obs at T0 (entry) and T0+1m (after approval but before +5m)
    // No obs at/after T0+5m for AAAA → WAIT_5M should be NO_ENTRY_OBS_YET
    // latestObsMs is bumped by BBBB at T0+1h so WAIT_5M is NOT PENDING
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,               pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000), pct: 2.0 }), // after approval, before +5m
      // BBBB bumps latestObsMs so WAIT_5M is past "now"
      makeObs({ contract: 'BBBB', capturedAt: atOffset(HOUR),   pct: 5.0, approved: true }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out).filter(r => r.contract === 'AAAA');
    // AAAA WAIT_5M: plannedEntry=T0+5m < latestObsMs=T0+1h → not PENDING
    //               firstAtOrAfter(allObsAAAA, T0+5m) = null → afterObs=[T0+1m] (length>0) → NO_ENTRY_OBS_YET
    const wait5 = rows.find(r => r.scenario === 'WAIT_5M')!;
    expect(wait5.status).toBe('NO_ENTRY_OBS_YET');
  });
});

// ── Status: NO_AFTER_DATA ─────────────────────────────────────────────────────

describe('NO_AFTER_DATA status', () => {
  it('ENTER_NOW is ENTERED_SIM even when obs exist only at approval time', () => {
    // ENTER_NOW calls firstAtOrAfter(allObs, approvedAtMs) which finds T0 itself
    // obsAfterEntry (strictly after T0) is empty → currentBestAfterPct null, still ENTERED_SIM
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(HOUR), pct: 5.0, approved: true }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out).filter(r => r.contract === 'AAAA');
    const enterNow = rows.find(r => r.scenario === 'ENTER_NOW')!;
    // entry at T0 itself, no obs strictly after → currentBestAfterPct null, still ENTERED_SIM
    expect(enterNow.status).toBe('ENTERED_SIM');
    expect(enterNow.currentBestAfterPct).toBeNull();
  });
});

// ── Duplicate deduplication ───────────────────────────────────────────────────

describe('duplicate deduplication', () => {
  it('does not append duplicate rows on second run', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();

    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });

    const rows = readRows(out);
    expect(rows).toHaveLength(4); // not 8
  });

  it('existingRowsSkipped reflects duplicates', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();

    const first  = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const second = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });

    expect(first.existingRowsSkipped).toBe(0);
    expect(second.existingRowsSkipped).toBe(4);
    expect(second.newRowsAppended).toBe(0);
  });

  it('new contract on second run is appended', () => {
    const obs1 = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const obs2 = [
      ...obs1,
      makeObs({ contract: 'BBBB', capturedAt: T0,             pct: 2.0, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(HOUR), pct: 6.0 }),
    ];
    const p1  = writeJsonl('obs1.jsonl', obs1);
    const p2  = writeJsonl('obs2.jsonl', obs2);
    const out = outPath();

    runRipperApprovalFollowPaperSession({ observationPaths: [p1], approvalPaths: [], outPath: out });
    const second = runRipperApprovalFollowPaperSession({ observationPaths: [p2], approvalPaths: [], outPath: out });

    expect(second.existingRowsSkipped).toBe(4);
    expect(second.newRowsAppended).toBe(4); // BBBB's 4 scenarios
    expect(readRows(out)).toHaveLength(8);
  });
});

// ── Dual-source approval detection ───────────────────────────────────────────

describe('dual-source approval detection', () => {
  it('detects obs-only approval', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    expect(rows[0].approvalSource).toBe('obs');
  });

  it('detects file-only approval', () => {
    const obsP = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const out = outPath();
    runRipperApprovalFollowPaperSession({
      observationPaths: [obsP],
      approvalPaths:    [apprP],
      outPath:          out,
    });
    const rows = readRows(out);
    expect(rows[0].approvalSource).toBe('file');
  });

  it('detects both-source approval', () => {
    const obsP = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const out = outPath();
    runRipperApprovalFollowPaperSession({
      observationPaths: [obsP],
      approvalPaths:    [apprP],
      outPath:          out,
    });
    const rows = readRows(out);
    expect(rows[0].approvalSource).toBe('both');
  });

  it('uses earliest approval timestamp', () => {
    // obs approved at +30s, file approved at T0 → should use T0
    const obsP = writeJsonl('obs.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: atOffset(30_000), pct: 1.5, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR),   pct: 5.0 }),
    ]);
    const apprP = writeJsonl('appr.jsonl', [
      makeObs({ contract: 'AAAA', capturedAt: T0, approved: true }),
    ]);
    const out = outPath();
    runRipperApprovalFollowPaperSession({
      observationPaths: [obsP],
      approvalPaths:    [apprP],
      outPath:          out,
    });
    const rows = readRows(out);
    expect(rows[0].approvedAt).toBe(T0);
  });
});

// ── Symbol propagation ────────────────────────────────────────────────────────

describe('symbol propagation', () => {
  it('records symbol from obs', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, symbol: 'MYTOKEN', approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    for (const r of rows) {
      expect(r.symbol).toBe('MYTOKEN');
    }
  });

  it('symbol is null when not present', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    expect(rows[0].symbol).toBeNull();
  });
});

// ── Summary counts ────────────────────────────────────────────────────────────

describe('summary counts', () => {
  it('approvalsFound matches distinct approved contracts', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
      makeObs({ contract: 'BBBB', capturedAt: T0,             pct: 2.0, approved: true }),
      makeObs({ contract: 'BBBB', capturedAt: atOffset(HOUR), pct: 6.0 }),
    ];
    const p      = writeJsonl('obs.jsonl', obs);
    const out    = outPath();
    const result = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    expect(result.approvalsFound).toBe(2);
  });

  it('newRowsAppended = 4 per contract on first run', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p      = writeJsonl('obs.jsonl', obs);
    const out    = outPath();
    const result = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    expect(result.newRowsAppended).toBe(4);
  });

  it('pendingEntryCount reflects PENDING_ENTRY rows in file', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0, pct: 1.0, approved: true }),
    ];
    const p      = writeJsonl('obs.jsonl', obs);
    const out    = outPath();
    const result = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    // WAIT_3M, WAIT_5M, WAIT_15M should be PENDING
    expect(result.pendingEntryCount).toBeGreaterThanOrEqual(3);
  });

  it('enteredSimCount reflects ENTERED_SIM rows in file', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,                pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(60_000),  pct: 2.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(180_000), pct: 3.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(300_000), pct: 4.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(900_000), pct: 5.0 }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR),    pct: 6.0 }),
    ];
    const p      = writeJsonl('obs.jsonl', obs);
    const out    = outPath();
    const result = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    expect(result.enteredSimCount).toBe(4); // all 4 scenarios entered
  });

  it('outPath is echoed in result', () => {
    const out    = outPath('my-session.jsonl');
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          out,
    });
    expect(result.outPath).toBe(out);
  });
});

// ── Output file format ────────────────────────────────────────────────────────

describe('output file format', () => {
  it('each line is valid JSON', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const lines = fs.readFileSync(out, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('each row has generatedAt field', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const rows = readRows(out);
    for (const r of rows) {
      expect(typeof r.generatedAt).toBe('string');
      expect(r.generatedAt.length).toBeGreaterThan(0);
    }
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          outPath(),
    });
    const output = renderRipperApprovalFollowPaperSession(result);
    expect(output).toContain('RIPPER APPROVAL FOLLOW PAPER SESSION');
    expect(output).toContain('SIMULATION ONLY');
  });

  it('includes safety footer', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          outPath(),
    });
    const output = renderRipperApprovalFollowPaperSession(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('DO NOT CALL AUTO-PAPER');
    expect(output).toContain('DO NOT CALL PAPER-BUY');
  });

  it('includes run summary counts', () => {
    const obs = [
      makeObs({ contract: 'AAAA', capturedAt: T0,             pct: 1.0, approved: true }),
      makeObs({ contract: 'AAAA', capturedAt: atOffset(HOUR), pct: 5.0 }),
    ];
    const p   = writeJsonl('obs.jsonl', obs);
    const out = outPath();
    const result = runRipperApprovalFollowPaperSession({ observationPaths: [p], approvalPaths: [], outPath: out });
    const output = renderRipperApprovalFollowPaperSession(result);
    expect(output).toContain('Approvals found');
    expect(output).toContain('New rows appended');
  });

  it('includes status key section', () => {
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          outPath(),
    });
    const output = renderRipperApprovalFollowPaperSession(result);
    expect(output).toContain('STATUS KEY');
    expect(output).toContain('PENDING_ENTRY');
    expect(output).toContain('ENTERED_SIM');
    expect(output).toContain('NO_ENTRY_OBS_YET');
    expect(output).toContain('NO_AFTER_DATA');
  });

  it('includes output path in render', () => {
    const out    = outPath('custom-path.jsonl');
    const result = runRipperApprovalFollowPaperSession({
      observationPaths: [],
      approvalPaths:    [],
      outPath:          out,
    });
    const output = renderRipperApprovalFollowPaperSession(result);
    expect(output).toContain('custom-path.jsonl');
  });
});
