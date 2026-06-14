import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperWait5PaperShadow,
  renderRipperWait5PaperShadow,
} from '../src/token-grab/ripperWait5PaperShadow';
import type { ScenarioRow, EntryScenario } from '../src/token-grab/ripperApprovalFollowPaperSession';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw5-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeSession(rows: Partial<ScenarioRow>[]): string {
  const p = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function row(
  scenario: EntryScenario,
  status: ScenarioRow['status'],
  upside: number | null = null,
  contract = 'AAAA',
  approvedAt = '2025-01-01T00:00:00.000Z',
): Partial<ScenarioRow> {
  return { contract, approvedAt, scenario, status, currentUpsidePct: upside, symbol: null,
           plannedEntryAt: approvedAt, observedEntryAt: null, entryPriceChangePct: null,
           currentBestAfterPct: null, generatedAt: approvedAt, approvalSource: 'obs' };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('has all required safety fields', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
  });
});

// ── Empty / missing ───────────────────────────────────────────────────────────

describe('empty / missing file', () => {
  it('returns zero counts for missing file', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    expect(r.totalApprovals).toBe(0);
    expect(r.enterNow.enteredCount).toBe(0);
    expect(r.wait5m.enteredCount).toBe(0);
  });

  it('returns null upside stats for missing file', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    expect(r.enterNow.avgUpside).toBeNull();
    expect(r.wait5m.medianUpside).toBeNull();
    expect(r.deltaAvgUpside).toBeNull();
    expect(r.deltaMedianUpside).toBeNull();
  });

  it('recommendation prompts collecting data when no rows', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    expect(r.recommendation.toLowerCase()).toContain('keep collecting');
  });
});

// ── totalApprovals ────────────────────────────────────────────────────────────

describe('totalApprovals', () => {
  it('counts distinct contract+approvedAt pairs across all scenarios', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0, 'AAAA', '2025-01-01T00:00:00.000Z'),
      row('WAIT_5M',   'ENTERED_SIM', 3.0, 'AAAA', '2025-01-01T00:00:00.000Z'), // same pair
      row('ENTER_NOW', 'ENTERED_SIM', 1.0, 'BBBB', '2025-01-01T00:00:00.000Z'), // different contract
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.totalApprovals).toBe(2);
  });

  it('counts only WAIT_3M/WAIT_15M rows toward totalApprovals too', () => {
    // totalApprovals is contract+approvedAt pairs regardless of scenario
    const p = writeSession([
      row('WAIT_3M',  'ENTERED_SIM', null, 'CCCC'),
      row('WAIT_15M', 'ENTERED_SIM', null, 'CCCC'),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.totalApprovals).toBe(1);
  });
});

// ── enterNow stats ────────────────────────────────────────────────────────────

describe('ENTER_NOW stats', () => {
  it('enteredCount only counts ENTERED_SIM', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM',   2.0),
      row('ENTER_NOW', 'ENTERED_SIM',   3.0),
      row('ENTER_NOW', 'PENDING_ENTRY', null),
      row('ENTER_NOW', 'NO_AFTER_DATA', null),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.enterNow.enteredCount).toBe(2);
  });

  it('avgUpside averages non-null upside among ENTERED_SIM', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('ENTER_NOW', 'ENTERED_SIM', 4.0),
      row('ENTER_NOW', 'ENTERED_SIM', null), // excluded from avg
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.enterNow.avgUpside).toBeCloseTo(3.0);
  });

  it('medianUpside for odd count', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 1.0),
      row('ENTER_NOW', 'ENTERED_SIM', 3.0),
      row('ENTER_NOW', 'ENTERED_SIM', 5.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.enterNow.medianUpside).toBeCloseTo(3.0);
  });

  it('winRate = wins / enteredCount (upside >= 1.0)', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('ENTER_NOW', 'ENTERED_SIM', 0.5),
      row('ENTER_NOW', 'ENTERED_SIM', 1.0),
      row('ENTER_NOW', 'ENTERED_SIM', -1.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    // wins: 2.0 and 1.0 → 2/4 = 0.5
    expect(r.enterNow.winRate).toBeCloseTo(0.5);
  });

  it('winRate null when enteredCount is 0', () => {
    const p = writeSession([row('ENTER_NOW', 'PENDING_ENTRY')]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.enterNow.winRate).toBeNull();
  });
});

// ── wait5m stats ──────────────────────────────────────────────────────────────

describe('WAIT_5M stats', () => {
  it('only counts WAIT_5M rows, not WAIT_3M', () => {
    const p = writeSession([
      row('WAIT_5M', 'ENTERED_SIM', 3.0),
      row('WAIT_3M', 'ENTERED_SIM', 9.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.wait5m.enteredCount).toBe(1);
    expect(r.wait5m.avgUpside).toBeCloseTo(3.0);
  });

  it('medianUpside for even count', () => {
    const p = writeSession([
      row('WAIT_5M', 'ENTERED_SIM', 2.0),
      row('WAIT_5M', 'ENTERED_SIM', 6.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.wait5m.medianUpside).toBeCloseTo(4.0);
  });
});

// ── Deltas ────────────────────────────────────────────────────────────────────

describe('deltas', () => {
  it('deltaAvgUpside = wait5m.avgUpside - enterNow.avgUpside', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('WAIT_5M',   'ENTERED_SIM', 5.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.deltaAvgUpside).toBeCloseTo(3.0);
  });

  it('deltaMedianUpside = wait5m.medianUpside - enterNow.medianUpside', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 1.0),
      row('ENTER_NOW', 'ENTERED_SIM', 3.0),
      row('WAIT_5M',   'ENTERED_SIM', 4.0),
      row('WAIT_5M',   'ENTERED_SIM', 6.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    // enterNow median=2.0, wait5m median=5.0 → delta=3.0
    expect(r.deltaMedianUpside).toBeCloseTo(3.0);
  });

  it('deltaAvgUpside null when either side has no data', () => {
    const p = writeSession([row('ENTER_NOW', 'ENTERED_SIM', 2.0)]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.deltaAvgUpside).toBeNull();
  });

  it('negative delta when ENTER_NOW outperforms WAIT_5M', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 6.0),
      row('WAIT_5M',   'ENTERED_SIM', 2.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.deltaAvgUpside).toBeCloseTo(-4.0);
  });
});

// ── Recommendation ────────────────────────────────────────────────────────────

describe('recommendation', () => {
  it('recommends WAIT_5M when both avg and median better', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 1.0),
      row('ENTER_NOW', 'ENTERED_SIM', 1.0),
      row('WAIT_5M',   'ENTERED_SIM', 4.0),
      row('WAIT_5M',   'ENTERED_SIM', 4.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    expect(r.recommendation.toLowerCase()).toContain('wait_5m');
    expect(r.recommendation.toLowerCase()).toContain('better');
  });

  it('recommends keeping ENTER_NOW when its win rate is materially better', () => {
    const p = writeSession([
      // ENTER_NOW: 4/4 wins = 100%
      row('ENTER_NOW', 'ENTERED_SIM', 2.0, 'A1'),
      row('ENTER_NOW', 'ENTERED_SIM', 2.0, 'A2'),
      row('ENTER_NOW', 'ENTERED_SIM', 2.0, 'A3'),
      row('ENTER_NOW', 'ENTERED_SIM', 2.0, 'A4'),
      // WAIT_5M: 0/4 wins = 0% (win rate delta > 10pp in ENTER_NOW's favour)
      row('WAIT_5M', 'ENTERED_SIM', 3.0, 'A1'), // avg/median higher for WAIT_5M
      row('WAIT_5M', 'ENTERED_SIM', 3.0, 'A2'),
      row('WAIT_5M', 'ENTERED_SIM', -1.0, 'A3'),
      row('WAIT_5M', 'ENTERED_SIM', -1.0, 'A4'),
    ]);
    // wait5m avg=1.0 = enterNow avg=2.0 — actually let me check:
    // ENTER_NOW: all 2.0 → avg=2.0, median=2.0, wins=4, winRate=1.0
    // WAIT_5M: 3,3,-1,-1 → avg=1.0, median=1.0, wins=2(3.0,3.0), winRate=0.5
    // avgBetter: 1.0 > 2.0? No. medianBetter: 1.0 > 2.0? No.
    // enWinMateriallyBetter: delta = 0.5-1.0 = -0.5 < -0.1, en.winRate(1.0) > w5.winRate(0.5) → yes
    const r = runRipperWait5PaperShadow(p);
    expect(r.recommendation.toLowerCase()).toContain('enter_now');
    expect(r.recommendation.toLowerCase()).toContain('win rate');
  });

  it('recommends collecting data when results are close', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('WAIT_5M',   'ENTERED_SIM', 2.1), // avgBetter but not medianBetter (same sample count median)
    ]);
    // avg: WAIT_5M=2.1 > ENTER_NOW=2.0 → avgBetter=true
    // median: WAIT_5M=2.1 > ENTER_NOW=2.0 → medianBetter=true
    // So this actually hits WAIT_5M recommend. Use truly close numbers:
    const p2 = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('ENTER_NOW', 'ENTERED_SIM', 3.0),
      row('WAIT_5M',   'ENTERED_SIM', 2.5), // avg=2.5 < enterNow avg=2.5? Equal
      row('WAIT_5M',   'ENTERED_SIM', 2.5),
    ]);
    // ENTER_NOW avg=2.5, WAIT_5M avg=2.5 → not strictly greater → no WAIT_5M lead
    // winRate both 50%? wins(>=1.0): EN: 2.0,3.0 → 2 wins, rate=1.0; W5: 2.5,2.5 → 2 wins, rate=1.0
    // enWinMateriallyBetter: delta=0, not < -0.1 → false
    // → falls to "close"
    const r2 = runRipperWait5PaperShadow(p2);
    expect(r2.recommendation.toLowerCase()).toContain('close');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and safety markers', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    const out = renderRipperWait5PaperShadow(r);
    expect(out).toContain('WAIT_5M PAPER SHADOW');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('reportOnly=true');
  });

  it('includes comparison table with both scenarios', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    const out = renderRipperWait5PaperShadow(r);
    expect(out).toContain('ENTER_NOW');
    expect(out).toContain('WAIT_5M');
    expect(out).toContain('Avg upside');
    expect(out).toContain('Win rate');
  });

  it('includes delta lines', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    const out = renderRipperWait5PaperShadow(r);
    expect(out).toContain('Delta avg upside');
    expect(out).toContain('Delta median upside');
  });

  it('includes recommendation section', () => {
    const r = runRipperWait5PaperShadow('/no/file.jsonl');
    const out = renderRipperWait5PaperShadow(r);
    expect(out).toContain('RECOMMENDATION');
  });

  it('renders numeric values', () => {
    const p = writeSession([
      row('ENTER_NOW', 'ENTERED_SIM', 2.0),
      row('WAIT_5M',   'ENTERED_SIM', 5.0),
    ]);
    const r = runRipperWait5PaperShadow(p);
    const out = renderRipperWait5PaperShadow(r);
    expect(out).toContain('+2.00%');
    expect(out).toContain('+5.00%');
    expect(out).toContain('+3.00%'); // delta
  });
});
