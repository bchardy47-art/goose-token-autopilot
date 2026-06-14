import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovalFollowPaperSessionReport,
  renderRipperApprovalFollowPaperSessionReport,
  type ScenarioStats,
} from '../src/token-grab/ripperApprovalFollowPaperSessionReport';
import type { ScenarioRow, EntryScenario } from '../src/token-grab/ripperApprovalFollowPaperSession';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rafpsr-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeSession(name: string, rows: Partial<ScenarioRow>[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeRow(opts: {
  contract?:           string;
  scenario?:           EntryScenario;
  status?:             ScenarioRow['status'];
  currentUpsidePct?:   number | null;
  approvedAt?:         string;
  approvalSource?:     'obs' | 'file' | 'both';
}): Partial<ScenarioRow> {
  return {
    contract:            opts.contract           ?? 'AAAA',
    symbol:              null,
    approvedAt:          opts.approvedAt          ?? '2025-01-01T00:00:00.000Z',
    approvalSource:      opts.approvalSource      ?? 'obs',
    scenario:            opts.scenario            ?? 'ENTER_NOW',
    plannedEntryAt:      '2025-01-01T00:00:00.000Z',
    observedEntryAt:     null,
    entryPriceChangePct: null,
    currentBestAfterPct: null,
    currentUpsidePct:    opts.currentUpsidePct ?? null,
    status:              opts.status              ?? 'ENTERED_SIM',
    generatedAt:         '2025-01-01T00:00:00.000Z',
  };
}

function statsFor(result: ReturnType<typeof runRipperApprovalFollowPaperSessionReport>, scenario: EntryScenario): ScenarioStats {
  return result.scenarioStats.find(s => s.scenario === scenario)!;
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result has all required safety fields', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/such/file.jsonl' });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });

  it('result has generatedAt', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/such/file.jsonl' });
    expect(typeof result.generatedAt).toBe('string');
    expect(result.generatedAt.length).toBeGreaterThan(0);
  });
});

// ── Empty / missing file ──────────────────────────────────────────────────────

describe('empty / missing file', () => {
  it('missing session file returns zero totalSessionRows', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/such/file.jsonl' });
    expect(result.totalSessionRows).toBe(0);
  });

  it('missing file has four scenario stats rows (all zeros)', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/such/file.jsonl' });
    expect(result.scenarioStats).toHaveLength(4);
    for (const s of result.scenarioStats) {
      expect(s.totalRows).toBe(0);
      expect(s.enteredSimCount).toBe(0);
      expect(s.avgUpside).toBeNull();
      expect(s.winRate).toBeNull();
    }
  });

  it('missing file recommendation mentions collecting data', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/such/file.jsonl' });
    expect(result.recommendation.toLowerCase()).toMatch(/no session data|keep collecting/);
  });

  it('echoes session path', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/my/session.jsonl' });
    expect(result.sessionPath).toBe('/my/session.jsonl');
  });

  it('skips malformed lines in session file', () => {
    const p = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(p, 'not json\n{"scenario":"ENTER_NOW","status":"ENTERED_SIM","currentUpsidePct":2.0}\n');
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    // The valid line won't have all fields but won't crash
    expect(result.totalSessionRows).toBeGreaterThanOrEqual(0);
  });
});

// ── Per-scenario counts ───────────────────────────────────────────────────────

describe('per-scenario counts', () => {
  it('totalRows counts all rows for that scenario', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM' }),
      makeRow({ scenario: 'ENTER_NOW', status: 'PENDING_ENTRY' }),
      makeRow({ scenario: 'WAIT_3M',   status: 'ENTERED_SIM' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'ENTER_NOW').totalRows).toBe(2);
    expect(statsFor(result, 'WAIT_3M').totalRows).toBe(1);
    expect(statsFor(result, 'WAIT_5M').totalRows).toBe(0);
  });

  it('enteredSimCount counts only ENTERED_SIM', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM' }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM' }),
      makeRow({ scenario: 'ENTER_NOW', status: 'PENDING_ENTRY' }),
      makeRow({ scenario: 'ENTER_NOW', status: 'NO_AFTER_DATA' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'ENTER_NOW').enteredSimCount).toBe(2);
  });

  it('pendingCount counts only PENDING_ENTRY', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_15M', status: 'PENDING_ENTRY' }),
      makeRow({ scenario: 'WAIT_15M', status: 'PENDING_ENTRY' }),
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_15M').pendingCount).toBe(2);
  });

  it('noEntryObsYetCount counts only NO_ENTRY_OBS_YET', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_5M', status: 'NO_ENTRY_OBS_YET' }),
      makeRow({ scenario: 'WAIT_5M', status: 'ENTERED_SIM' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_5M').noEntryObsYetCount).toBe(1);
  });

  it('noAfterDataCount counts only NO_AFTER_DATA', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_3M', status: 'NO_AFTER_DATA' }),
      makeRow({ scenario: 'WAIT_3M', status: 'NO_AFTER_DATA' }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_3M').noAfterDataCount).toBe(2);
  });
});

// ── Upside stats ──────────────────────────────────────────────────────────────

describe('upside stats', () => {
  it('avgUpside averages currentUpsidePct for ENTERED_SIM rows', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 4.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'PENDING_ENTRY', currentUpsidePct: 99.0 }), // excluded
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'ENTER_NOW').avgUpside).toBeCloseTo(3.0);
  });

  it('avgUpside null when no ENTERED_SIM rows with upside', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: null }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'ENTER_NOW').avgUpside).toBeNull();
  });

  it('medianUpside for odd count', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 1.0 }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 3.0 }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 5.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_3M').medianUpside).toBeCloseTo(3.0);
  });

  it('medianUpside for even count', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_5M', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'WAIT_5M', status: 'ENTERED_SIM', currentUpsidePct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_5M').medianUpside).toBeCloseTo(3.0);
  });

  it('bestUpside is max upside among ENTERED_SIM rows', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM', currentUpsidePct: 1.5 }),
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM', currentUpsidePct: 8.0 }),
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM', currentUpsidePct: 3.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_15M').bestUpside).toBeCloseTo(8.0);
  });

  it('worstUpside is min upside among ENTERED_SIM rows', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 1.5 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: -2.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 3.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'ENTER_NOW').worstUpside).toBeCloseTo(-2.0);
  });

  it('upside stats ignore null currentUpsidePct', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: null }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 5.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_3M').avgUpside).toBeCloseTo(5.0);
    expect(statsFor(result, 'WAIT_3M').bestUpside).toBeCloseTo(5.0);
  });
});

// ── Win count and win rate ────────────────────────────────────────────────────

describe('win count and win rate', () => {
  it('winCount counts ENTERED_SIM rows with upside >= 1.0', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 1.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    // 2.0 >= 1.0, 0.5 < 1.0, 1.0 >= 1.0 → winCount=2
    expect(statsFor(result, 'ENTER_NOW').winCount).toBe(2);
  });

  it('winRate = winCount / enteredSimCount', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 0.0 }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: 1.5 }),
      makeRow({ scenario: 'WAIT_3M', status: 'ENTERED_SIM', currentUpsidePct: null }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    // enteredSim=4, wins where upside>=1.0: 2.0 and 1.5 → winCount=2, winRate=0.5
    expect(statsFor(result, 'WAIT_3M').winCount).toBe(2);
    expect(statsFor(result, 'WAIT_3M').winRate).toBeCloseTo(0.5);
  });

  it('winRate is null when enteredSimCount is 0', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_5M', status: 'PENDING_ENTRY' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(statsFor(result, 'WAIT_5M').winRate).toBeNull();
  });
});

// ── Best scenario selection ───────────────────────────────────────────────────

describe('best scenario selection', () => {
  it('bestByAvgUpside picks scenario with highest avg upside', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 1.0 }),
      makeRow({ scenario: 'WAIT_3M',   status: 'ENTERED_SIM', currentUpsidePct: 5.0 }),
      makeRow({ scenario: 'WAIT_5M',   status: 'ENTERED_SIM', currentUpsidePct: 3.0 }),
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.bestByAvgUpside).toBe('WAIT_3M');
  });

  it('bestByMedianUpside picks scenario with highest median upside', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'WAIT_5M',   status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'WAIT_5M',   status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'WAIT_3M',   status: 'ENTERED_SIM', currentUpsidePct: 4.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.bestByMedianUpside).toBe('WAIT_3M');
  });

  it('bestByWinRate picks scenario with highest win rate', () => {
    const p = writeSession('s.jsonl', [
      // ENTER_NOW: 1/2 = 50%
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 0.0 }),
      // WAIT_15M: 2/2 = 100%
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 3.0 }),
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.bestByWinRate).toBe('WAIT_15M');
  });

  it('best fields are null when no ENTERED_SIM rows', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'PENDING_ENTRY' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.bestByAvgUpside).toBeNull();
    expect(result.bestByMedianUpside).toBeNull();
    expect(result.bestByWinRate).toBeNull();
  });
});

// ── Recommendation ────────────────────────────────────────────────────────────

describe('recommendation', () => {
  it('no session data message for empty file', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    expect(result.recommendation.toLowerCase()).toContain('no session data');
  });

  it('keep collecting when no ENTERED_SIM rows', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'PENDING_ENTRY' }),
      makeRow({ scenario: 'WAIT_3M',   status: 'PENDING_ENTRY' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.recommendation.toLowerCase()).toContain('keep collecting');
  });

  it('too much NO_AFTER_DATA message', () => {
    // >50% NO_AFTER_DATA across all rows
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'NO_AFTER_DATA' }),
      makeRow({ scenario: 'WAIT_3M',   status: 'NO_AFTER_DATA' }),
      makeRow({ scenario: 'WAIT_5M',   status: 'NO_AFTER_DATA' }),
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 2.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.recommendation.toLowerCase()).toContain('keep collecting observations');
  });

  it('immediate simulated entry when ENTER_NOW leads all metrics', () => {
    const p = writeSession('s.jsonl', [
      // ENTER_NOW: high upside, high win rate
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 8.0 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 6.0 }),
      // others: low upside
      makeRow({ scenario: 'WAIT_3M',  status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'WAIT_5M',  status: 'ENTERED_SIM', currentUpsidePct: 0.2 }),
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM', currentUpsidePct: 0.1 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.recommendation.toLowerCase()).toContain('immediate simulated entry');
  });

  it('delayed simulated entry when WAIT_3M leads', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'WAIT_3M',  status: 'ENTERED_SIM', currentUpsidePct: 5.0 }),
      makeRow({ scenario: 'WAIT_3M',  status: 'ENTERED_SIM', currentUpsidePct: 4.0 }),
      makeRow({ scenario: 'WAIT_5M',  status: 'ENTERED_SIM', currentUpsidePct: 1.0 }),
      makeRow({ scenario: 'WAIT_15M', status: 'ENTERED_SIM', currentUpsidePct: 0.3 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.recommendation.toLowerCase()).toContain('delayed simulated entry');
    expect(result.recommendation).toContain('3m');
  });

  it('delayed simulated entry when WAIT_15M leads', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 0.5 }),
      makeRow({ scenario: 'WAIT_3M',   status: 'ENTERED_SIM', currentUpsidePct: 1.0 }),
      makeRow({ scenario: 'WAIT_5M',   status: 'ENTERED_SIM', currentUpsidePct: 1.5 }),
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 9.0 }),
      makeRow({ scenario: 'WAIT_15M',  status: 'ENTERED_SIM', currentUpsidePct: 8.0 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.recommendation.toLowerCase()).toContain('delayed simulated entry');
    expect(result.recommendation).toContain('15m');
  });
});

// ── totalSessionRows ──────────────────────────────────────────────────────────

describe('totalSessionRows', () => {
  it('counts all rows in session file regardless of scenario', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW' }),
      makeRow({ scenario: 'WAIT_3M' }),
      makeRow({ scenario: 'WAIT_5M' }),
      makeRow({ scenario: 'WAIT_15M' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    expect(result.totalSessionRows).toBe(4);
  });
});

// ── Scenario stats ordering ───────────────────────────────────────────────────

describe('scenario stats ordering', () => {
  it('scenarioStats has exactly 4 entries in canonical order', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    expect(result.scenarioStats.map(s => s.scenario)).toEqual([
      'ENTER_NOW', 'WAIT_3M', 'WAIT_5M', 'WAIT_15M',
    ]);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes title and safety header', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('RIPPER APPROVAL FOLLOW PAPER SESSION REPORT');
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
  });

  it('includes safety footer', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('DO NOT CALL AUTO-PAPER');
    expect(output).toContain('DO NOT CALL PAPER-BUY');
  });

  it('includes SCENARIO STATS header', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('SCENARIO STATS');
    expect(output).toContain('ENTER_NOW');
    expect(output).toContain('WAIT_15M');
  });

  it('includes BEST SCENARIO section', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('BEST SCENARIO');
    expect(output).toContain('Best by avg upside');
    expect(output).toContain('Best by win rate');
  });

  it('includes recommendation in output', () => {
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: '/no/file.jsonl' });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('Recommendation:');
  });

  it('renders numeric stats in table', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 3.5 }),
      makeRow({ scenario: 'ENTER_NOW', status: 'ENTERED_SIM', currentUpsidePct: 1.5 }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('ENTER_NOW');
    expect(output).toContain('+2.50%'); // avg of 3.5 and 1.5
  });

  it('shows n/a for null stats', () => {
    const p = writeSession('s.jsonl', [
      makeRow({ scenario: 'WAIT_3M', status: 'PENDING_ENTRY' }),
    ]);
    const result = runRipperApprovalFollowPaperSessionReport({ sessionPath: p });
    const output = renderRipperApprovalFollowPaperSessionReport(result);
    expect(output).toContain('n/a');
  });
});
