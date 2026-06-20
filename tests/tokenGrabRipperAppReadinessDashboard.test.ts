import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runAppReadinessDashboard,
  renderAppReadinessDashboard,
  type AppReadinessResult,
} from '../src/token-grab/ripperAppReadinessDashboard';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface TmpDirs { root: string; cyclesDir: string; memoryPath: string; intentsPath: string; observationsPath: string; }
function makeTmpDirs(): TmpDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ard-test-'));
  const cyclesDir = path.join(root, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  return {
    root, cyclesDir,
    memoryPath:       path.join(root, 'learning-memory.jsonl'),
    intentsPath:      path.join(root, 'paper-intents.jsonl'),
    observationsPath: path.join(root, 'paper-intent-observations.jsonl'),
  };
}

// Seed a small but valid memory + cycle so children produce signals without throwing.
function seed(dirs: TmpDirs): void {
  const mem: Record<string, unknown>[] = [];
  for (let i = 0; i < 30; i++) {
    mem.push({
      contract: `A${i}`, gateDecision: 'BUY_APPROVED_PAPER', priceChangePct: i % 2 ? 5 : -5,
      entryMomentumPct: 0, liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5',
      clusterRisk: 'UNKNOWN', observedAt: '2026-06-19T20:30:00.000Z', capturedAt: '2026-06-19T20:00:00.000Z',
    });
    mem.push({
      contract: `R${i}`, gateDecision: 'BUY_REJECTED', priceChangePct: i % 3 ? -10 : 40,
      entryMomentumPct: 0, liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5',
      clusterRisk: 'UNKNOWN', observedAt: '2026-06-19T20:30:00.000Z', capturedAt: '2026-06-19T20:00:00.000Z',
    });
  }
  writeJsonl(dirs.memoryPath, mem);
  writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
    { capturedAt: '2026-06-19T20:00:00.000Z', buyGateDecision: 'BUY_APPROVED_PAPER',
      entryMomentumPct: 0, normalizedSignal: { contract: 'A0' },
      raw: { clusterRisk: 'UNKNOWN', clusterProvider: 'bubblemaps-cached',
             clusterNotes: ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'] } },
  ]);
}

function opts(dirs: TmpDirs) {
  return {
    memoryPath: dirs.memoryPath, cyclesDir: dirs.cyclesDir,
    intentsPath: dirs.intentsPath, observationsPath: dirs.observationsPath,
    generatedAt: '2026-06-19T21:00:00.000Z',
  };
}

let dirs: TmpDirs;
beforeEach(() => { dirs = makeTmpDirs(); });
afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

describe('App Readiness Dashboard v1', () => {
  it('aggregates child reports into nine dimensions', () => {
    seed(dirs);
    const r = runAppReadinessDashboard(opts(dirs));
    expect(r.dimensions.length).toBe(9);
    const names = r.dimensions.map(d => d.name);
    expect(names).toContain('Data plumbing');
    expect(names).toContain('Execution realism');
    expect(names).toContain('Real-trading readiness');
  });

  it('reports safety locks OK', () => {
    seed(dirs);
    const r = runAppReadinessDashboard(opts(dirs));
    const safety = r.dimensions.find(d => d.name === 'Safety locks')!;
    expect(safety.labels).toContain('SAFETY_LOCKS_OK');
    expect(r.signals.realTradingLocked).toBe(true);
    expect(r.signals.tradingExecuted).toBe(0);
  });

  it('always blocks real trading and never says enable it', () => {
    seed(dirs);
    const r = runAppReadinessDashboard(opts(dirs));
    expect(r.readinessLabels).toContain('NOT_READY_FOR_REAL_TRADING');
    const realtr = r.dimensions.find(d => d.name === 'Real-trading readiness')!;
    expect(realtr.status).toBe('LOCKED');
    const text = renderAppReadinessDashboard(r).toLowerCase();
    // Must never contain an affirmative instruction to enable real trading.
    expect(text).not.toMatch(/enable real trading(?!\.)/);
    expect(text).toContain('do_not_enable_real_trading');
    expect(text).toContain('never recommends enabling real trading');
  });

  it('identifies blockers (cluster coverage + execution realism on the seeded data)', () => {
    seed(dirs);
    const r = runAppReadinessDashboard(opts(dirs));
    // Seeded approved rows are all UNKNOWN cluster → coverage blocked.
    expect(r.blockers).toContain('BLOCKED_BY_CLUSTER_COVERAGE');
    // Execution realism likely flags overstatement on these small/thin rows.
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it('renders all twelve sections', () => {
    seed(dirs);
    const text = renderAppReadinessDashboard(runAppReadinessDashboard(opts(dirs)));
    for (const s of [
      'SECTION 1 — EXECUTIVE SUMMARY',
      'SECTION 2 — CURRENT MODE',
      'SECTION 3 — LEARNING LOOP HEALTH',
      'SECTION 4 — EVIDENCE MATURITY',
      'SECTION 5 — HOLDER / CLUSTER COVERAGE',
      'SECTION 6 — EXECUTION REALISM',
      'SECTION 7 — REJECTED OUTCOME LEARNING',
      'SECTION 8 — SHADOW POLICY RESULTS',
      'SECTION 9 — SAFETY LOCKS',
      'SECTION 10 — BLOCKERS',
      'SECTION 11 — NEXT BEST ACTION',
      'SECTION 12 — FINAL READINESS VERDICT',
    ]) {
      expect(text).toContain(s);
    }
  });

  it('does not mutate any input file', () => {
    seed(dirs);
    const memBefore = fs.readFileSync(dirs.memoryPath, 'utf-8');
    const cycleFile = path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl');
    const cycleBefore = fs.readFileSync(cycleFile, 'utf-8');
    runAppReadinessDashboard(opts(dirs));
    expect(fs.readFileSync(dirs.memoryPath, 'utf-8')).toBe(memBefore);
    expect(fs.readFileSync(cycleFile, 'utf-8')).toBe(cycleBefore);
  });

  it('sets safety flags and produces valid JSON', () => {
    seed(dirs);
    const r = runAppReadinessDashboard(opts(dirs));
    expect(r.reportOnly).toBe(true);
    expect(r.noGateChanges).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    const parsed = JSON.parse(JSON.stringify(r)) as AppReadinessResult;
    expect(parsed.dimensions.length).toBe(9);
    expect(parsed.finalVerdict).toMatch(/NOT_READY_FOR_REAL_TRADING/);
  });

  it('handles empty data without throwing', () => {
    const r = runAppReadinessDashboard(opts(dirs));   // no seed
    expect(() => renderAppReadinessDashboard(r)).not.toThrow();
    expect(r.readinessLabels).toContain('NOT_READY_FOR_REAL_TRADING');
  });
});
