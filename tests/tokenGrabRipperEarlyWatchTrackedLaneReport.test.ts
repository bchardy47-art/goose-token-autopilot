import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  runRipperEarlyWatchTrackedLaneReport,
  renderRipperEarlyWatchTrackedLaneReport,
  type TrackedLaneStatus,
} from '../src/token-grab/ripperEarlyWatchTrackedLaneReport';

// ── Fixture constants ─────────────────────────────────────────────────────────

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeObs(opts: {
  contract?: string;
  capturedAt?: string;
  priceChangePct?: number | null;
  liquidityUsd?: number | null;
  volumeUsd?: number | null;
  symbol?: string;
}) {
  return {
    buyGateDecision: 'WATCH',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct !== undefined ? opts.priceChangePct : 0.1,
      liquidityUsd:   opts.liquidityUsd  !== undefined ? opts.liquidityUsd : 35_000,
      volumeUsd:      opts.volumeUsd     !== undefined ? opts.volumeUsd : 25_000,
      symbol:         opts.symbol,
    },
  };
}

function makeApproval(opts: {
  contract?: string;
  capturedAt?: string;
  priceChangePct?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
}) {
  return {
    buyGateDecision: 'BUY_APPROVED_PAPER',
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    normalizedSignal: {
      contract:       opts.contract      ?? CONTRACT_A,
      priceChangePct: opts.priceChangePct ?? 0.5,
      liquidityUsd:   opts.liquidityUsd  ?? 40_000,
      volumeUsd:      opts.volumeUsd     ?? 25_000,
    },
  };
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewtlr-')); });
afterEach(()  => { fs.rmSync(tmpDir, { recursive: true }); });

function writeJsonl(name: string, fixtures: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return p;
}

// ── Status classification ─────────────────────────────────────────────────────

describe('status classification', () => {
  function statusFor(
    obsFixtures: object[],
    approvalFixtures: object[],
    contract = CONTRACT_A,
    nowMs = BASE_MS + 60_000,
  ): TrackedLaneStatus {
    const op = writeJsonl('o.jsonl', obsFixtures);
    const ap = writeJsonl('a.jsonl', approvalFixtures);
    const r  = runRipperEarlyWatchTrackedLaneReport({
      observationPaths: [op],
      approvalPaths:    [ap],
      nowMs,
    });
    const row = r.rows.find(row => row.contractKey === contract);
    if (!row) throw new Error(`No row found for ${contract}`);
    return row.status;
  }

  it('GRADUATED_APPROVED when later BUY_APPROVED_PAPER exists', () => {
    const s = statusFor(
      [makeObs({ capturedAt: at(0) })],
      [makeApproval({ capturedAt: at(60_000) })],
    );
    expect(s).toBe('GRADUATED_APPROVED');
  });

  it('PRICE_MOVED when best later pct > 0.25 but no approval', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(10_000), priceChangePct: 0.3, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      ],
      [],
    );
    expect(s).toBe('PRICE_MOVED');
  });

  it('FAILED_LIQUIDITY when latest liquidityUsd < 30000', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),     liquidityUsd: 35_000 }),
        makeObs({ capturedAt: at(5_000), liquidityUsd: 10_000, priceChangePct: 0.1, volumeUsd: 25_000 }),
      ],
      [],
    );
    expect(s).toBe('FAILED_LIQUIDITY');
  });

  it('FAILED_VOLUME when latest volumeUsd < 20000', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),     volumeUsd: 25_000 }),
        makeObs({ capturedAt: at(5_000), volumeUsd: 5_000, priceChangePct: 0.1, liquidityUsd: 35_000 }),
      ],
      [],
    );
    expect(s).toBe('FAILED_VOLUME');
  });

  it('STALLED when above floors, no price move, later obs exist', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),     priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
        makeObs({ capturedAt: at(5_000), priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      ],
      [],
    );
    expect(s).toBe('STALLED');
  });

  it('WATCHING when no later observations exist after first watch hit', () => {
    const s = statusFor(
      [makeObs({ capturedAt: at(0), priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 })],
      [],
    );
    expect(s).toBe('WATCHING');
  });

  it('GRADUATED_APPROVED takes priority over PRICE_MOVED', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
        makeObs({ capturedAt: at(10_000), priceChangePct: 0.5, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      ],
      [makeApproval({ capturedAt: at(60_000) })],
    );
    expect(s).toBe('GRADUATED_APPROVED');
  });

  it('PRICE_MOVED takes priority over FAILED_LIQUIDITY', () => {
    const s = statusFor(
      [
        makeObs({ capturedAt: at(0),      priceChangePct: 0.1,  liquidityUsd: 35_000, volumeUsd: 25_000 }),
        makeObs({ capturedAt: at(5_000),  priceChangePct: 0.5,  liquidityUsd: 35_000, volumeUsd: 25_000 }),
        makeObs({ capturedAt: at(10_000), priceChangePct: 0.1,  liquidityUsd: 5_000,  volumeUsd: 25_000 }),
      ],
      [],
    );
    expect(s).toBe('PRICE_MOVED');
  });
});

// ── Row fields ────────────────────────────────────────────────────────────────

describe('row fields', () => {
  it('uses earliest WATCH_EARLY_RIP hit as firstWatchAt', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(5_000), priceChangePct: 0.2 }),
      makeObs({ capturedAt: at(0),     priceChangePct: 0.1 }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].firstWatchAt).toBe(at(0));
    expect(r.rows[0].watchPriceChangePct).toBeCloseTo(0.1, 5);
  });

  it('latestPriceChangePct, latestLiquidityUsd, latestVolumeUsd come from most recent obs', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.15, liquidityUsd: 40_000, volumeUsd: 30_000 }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    const row = r.rows[0];
    expect(row.latestPriceChangePct).toBeCloseTo(0.15, 5);
    expect(row.latestLiquidityUsd).toBe(40_000);
    expect(row.latestVolumeUsd).toBe(30_000);
  });

  it('bestLaterPriceChangePct is max priceChangePct strictly after firstWatchAt', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      priceChangePct: 0.1 }),
      makeObs({ capturedAt: at(5_000),  priceChangePct: 0.18, liquidityUsd: 35_000, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(10_000), priceChangePct: 0.22, liquidityUsd: 35_000, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].bestLaterPriceChangePct).toBeCloseTo(0.22, 5);
  });

  it('bestLaterPriceChangePct is null when no later observations', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].bestLaterPriceChangePct).toBeNull();
  });

  it('minutesSinceFirstWatch computed from nowMs', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0) })]);
    const nowMs = BASE_MS + 120_000; // 2 minutes later
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs });
    expect(r.rows[0].minutesSinceFirstWatch).toBeCloseTo(2.0, 5);
  });

  it('liquidityHeld true when latest liq >= 30000', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0), liquidityUsd: 30_000 })]);
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].liquidityHeld).toBe(true);
  });

  it('liquidityHeld false when latest liq < 30000', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),     liquidityUsd: 35_000 }),
      makeObs({ capturedAt: at(5_000), liquidityUsd: 29_999, priceChangePct: 0.1, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].liquidityHeld).toBe(false);
  });

  it('volumeHeld true when latest vol >= 20000', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0), volumeUsd: 20_000 })]);
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].volumeHeld).toBe(true);
  });

  it('laterBuyApproved true when BUY_APPROVED_PAPER at or after firstWatchAt', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0) })]);
    const ap = writeJsonl('a.jsonl', [makeApproval({ capturedAt: at(60_000) })]);
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [ap], nowMs: BASE_MS + 120_000 });
    expect(r.rows[0].laterBuyApproved).toBe(true);
  });

  it('laterBuyApproved false when approval before firstWatchAt', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(60_000) })]);
    const ap = writeJsonl('a.jsonl', [makeApproval({ capturedAt: at(0) })]);
    const r  = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [ap], nowMs: BASE_MS + 120_000 });
    expect(r.rows[0].laterBuyApproved).toBe(false);
  });
});

// ── Multi-contract and sorting ────────────────────────────────────────────────

describe('multi-contract and sorting', () => {
  it('produces one row per unique WATCH_EARLY_RIP contract', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A }),
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_A }),
      makeObs({ capturedAt: at(0),      contract: CONTRACT_B }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows.length).toBe(2);
    expect(r.totalCandidates).toBe(2);
  });

  it('rows sorted by firstWatchAt ascending', () => {
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(10_000), contract: CONTRACT_B }),
      makeObs({ capturedAt: at(0),      contract: CONTRACT_A }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].contractKey).toBe(CONTRACT_A);
    expect(r.rows[1].contractKey).toBe(CONTRACT_B);
  });

  it('non-policy observations for a candidate contract still tracked for latest obs', () => {
    // Contract passes policy at t=0, then drops liquidity at t=5000
    const op = writeJsonl('o.jsonl', [
      makeObs({ capturedAt: at(0),     liquidityUsd: 35_000, priceChangePct: 0.1, volumeUsd: 25_000 }),
      makeObs({ capturedAt: at(5_000), liquidityUsd: 5_000,  priceChangePct: 0.1, volumeUsd: 25_000 }),
    ]);
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    expect(r.rows[0].latestLiquidityUsd).toBe(5_000);
    expect(r.rows[0].status).toBe('FAILED_LIQUIDITY');
  });
});

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('reportOnly is true', () => {
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    expect(r.reportOnly).toBe(true);
  });

  it('readOnly is true', () => {
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    expect(r.readOnly).toBe(true);
  });

  it('tradingExecuted is 0', () => {
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    expect(r.tradingExecuted).toBe(0);
  });

  it('realTradingLocked is true', () => {
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    expect(r.realTradingLocked).toBe(true);
  });

  it('paperOnly is true', () => {
    const r = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    expect(r.paperOnly).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('contains REPORT ONLY header', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('REPORT ONLY');
  });

  it('contains TRACKED LANE ROWS section', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('TRACKED LANE ROWS');
  });

  it('shows (no WATCH_EARLY_RIP candidates) when empty', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('no WATCH_EARLY_RIP candidates');
  });

  it('contains safety footer with all required flags', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('readOnly=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('paperOnly=true');
  });

  it('contains DO NOT ENABLE REAL TRADING warning', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('contains DO NOT CALL AUTO-PAPER warning', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('DO NOT CALL AUTO-PAPER');
  });

  it('renders candidate row with status', () => {
    const op = writeJsonl('o.jsonl', [makeObs({ capturedAt: at(0), symbol: 'TKNA' })]);
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [op], approvalPaths: [], nowMs: BASE_MS + 60_000 });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('$TKNA');
    expect(out).toContain('WATCHING');
  });

  it('renders STATUS KEY section', () => {
    const r   = runRipperEarlyWatchTrackedLaneReport({ observationPaths: [], approvalPaths: [] });
    const out = renderRipperEarlyWatchTrackedLaneReport(r);
    expect(out).toContain('STATUS KEY');
    expect(out).toContain('GRADUATED_APPROVED');
    expect(out).toContain('PRICE_MOVED');
    expect(out).toContain('FAILED_LIQUIDITY');
    expect(out).toContain('FAILED_VOLUME');
    expect(out).toContain('STALLED');
  });
});
