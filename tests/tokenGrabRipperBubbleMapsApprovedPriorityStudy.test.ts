import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runApprovedPriorityStudy,
  renderApprovedPriorityStudy,
  prioritizeCandidates,
  type PriorityCandidate,
  type ApprovedPriorityStudyResult,
} from '../src/token-grab/ripperBubbleMapsApprovedPriorityStudy';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface CycleRowSpec {
  contract?:   string;
  symbol?:     string;
  m5?:         number | null;
  cluster?:    string;
  gate?:       string;
  notes?:      string[];
  provider?:   string;
}

function cycleRow(spec: CycleRowSpec): Record<string, unknown> {
  return {
    capturedAt:       '2026-06-19T20:00:00.000Z',
    entryMomentumPct: spec.m5 ?? null,
    buyGateDecision:  spec.gate ?? 'BUY_REJECTED',
    normalizedSignal: { contract: spec.contract ?? 'C1', symbol: spec.symbol ?? 'TKN' },
    ripperInput:      { contract: spec.contract ?? 'C1', clusterRisk: spec.cluster ?? 'UNKNOWN' },
    raw: {
      clusterRisk:     spec.cluster ?? 'UNKNOWN',
      clusterProvider: spec.provider ?? 'bubblemaps-cached',
      clusterNotes:    spec.notes ?? [],
    },
  };
}

const DISABLED_NOTES = ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'];
const CAP_NOTES      = ['BubbleMaps live cap of 3 reached'];

interface TmpDirs {
  root:        string;
  cyclesDir:   string;
  memoryPath:  string;
  intentsPath: string;
}

function makeTmpDirs(): TmpDirs {
  const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-test-'));
  const cyclesDir = path.join(root, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  return {
    root,
    cyclesDir,
    memoryPath:  path.join(root, 'learning-memory.jsonl'),
    intentsPath: path.join(root, 'paper-intents.jsonl'),
  };
}

function writeCycle(dirs: TmpDirs, name: string, rows: Record<string, unknown>[]): string {
  const file = path.join(dirs.cyclesDir, name);
  writeJsonl(file, rows);
  return file;
}

function opts(dirs: TmpDirs, extra: Record<string, unknown> = {}) {
  return {
    cyclesDir:   dirs.cyclesDir,
    memoryPath:  dirs.memoryPath,
    intentsPath: dirs.intentsPath,
    generatedAt: '2026-06-19T21:00:00.000Z',
    ...extra,
  };
}

let dirs: TmpDirs;
beforeEach(() => { dirs = makeTmpDirs(); });
afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BubbleMaps Approved Priority Study v1', () => {
  it('counts approved UNKNOWN rows', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'A2', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'A3', gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN',   notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.coverageAll.approvedTotal).toBe(3);
    expect(r.coverageAll.approvedUnknown).toBe(2);
  });

  it('counts rejected UNKNOWN rows', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'R2', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'R3', gate: 'BUY_REJECTED', cluster: 'RISKY' }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.coverageAll.rejectedTotal).toBe(3);
    expect(r.coverageAll.rejectedUnknown).toBe(2);
  });

  it('calculates approved known coverage %', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN' }),
      cycleRow({ contract: 'A2', gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN' }),
      cycleRow({ contract: 'A3', gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN' }),
      cycleRow({ contract: 'A4', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN' }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    // 3 of 4 known → 75%
    expect(r.coverageAll.approvedKnownCoveragePct).toBeCloseTo(75, 5);
  });

  it('calculates rejected known coverage %', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED', cluster: 'CLEAN' }),
      cycleRow({ contract: 'R2', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'R3', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'R4', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    // 1 of 4 known → 25%
    expect(r.coverageAll.rejectedKnownCoveragePct).toBeCloseTo(25, 5);
  });

  it('sorts approved-first before rejected (priority sort)', () => {
    const cands: PriorityCandidate[] = [
      { contract: 'R', symbol: null, gate: 'BUY_REJECTED',       hasM5: false, priorityTier: 4 },
      { contract: 'A', symbol: null, gate: 'BUY_APPROVED_PAPER', hasM5: false, priorityTier: 2 },
      { contract: 'RM', symbol: null, gate: 'BUY_REJECTED',      hasM5: true,  priorityTier: 3 },
      { contract: 'AM', symbol: null, gate: 'BUY_APPROVED_PAPER', hasM5: true, priorityTier: 1 },
    ];
    const sorted = prioritizeCandidates(cands);
    expect(sorted.map(c => c.contract)).toEqual(['AM', 'A', 'RM', 'R']);
    // Every approved row precedes every rejected row.
    const firstRejected = sorted.findIndex(c => c.gate === 'BUY_REJECTED');
    const lastApproved  = sorted.map(c => c.gate).lastIndexOf('BUY_APPROVED_PAPER');
    expect(lastApproved).toBeLessThan(firstRejected);
  });

  it('sorts M5 approved UNKNOWN before non-M5 approved UNKNOWN', () => {
    const cands: PriorityCandidate[] = [
      { contract: 'A-noM5', symbol: null, gate: 'BUY_APPROVED_PAPER', hasM5: false, priorityTier: 2 },
      { contract: 'A-M5',   symbol: null, gate: 'BUY_APPROVED_PAPER', hasM5: true,  priorityTier: 1 },
    ];
    const sorted = prioritizeCandidates(cands);
    expect(sorted[0].contract).toBe('A-M5');
    expect(sorted[1].contract).toBe('A-noM5');
  });

  it('observed cap simulation allocates approved rows first', () => {
    // Cap of 3 (parsed from notes), live calls present (not disabled).
    // 2 approved UNKNOWN (1 with M5) + 4 rejected UNKNOWN. With cap=3, approved-first
    // should cover BOTH approved rows first, leaving 1 call for a rejected row.
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 12, provider: 'bubblemaps', notes: CAP_NOTES }),
      cycleRow({ contract: 'A2', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', provider: 'bubblemaps', notes: CAP_NOTES }),
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', provider: 'bubblemaps', notes: CAP_NOTES }),
      cycleRow({ contract: 'R2', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', provider: 'bubblemaps', notes: CAP_NOTES }),
      cycleRow({ contract: 'R3', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', provider: 'bubblemaps', notes: CAP_NOTES }),
      cycleRow({ contract: 'R4', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', provider: 'bubblemaps', notes: CAP_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    const sim = r.observedSimulation;
    expect(sim.totalCap).toBe(3);
    expect(sim.approvedCoveredFirst).toBe(2);          // both approved covered first
    expect(sim.approvedM5CoveredFirst).toBe(1);        // 1 of them is M5
    expect(sim.rejectedCovered).toBe(1);               // 1 remaining call → rejected
    expect(sim.rejectedDeferred).toBe(3);              // 3 rejected deferred
    expect(sim.approvedStillUncovered).toBe(0);
  });

  it('reports disabled cycles as disabled, not cap-limited', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED',       cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.bubbleMapsUsage.bubbleMapsDisabledCycles).toBe(1);
    expect(r.bubbleMapsUsage.liveCallsUsed).toBe(0);
    // observed sim has zero budget (disabled) and cannot help
    expect(r.observedSimulation.totalCap).toBe(0);
    expect(r.observedSimulation.cyclesWithZeroCap).toBe(1);
    expect(r.observedSimulation.note).toMatch(/disabled|enabled/i);
    expect(r.diagnoses).toContain('BUBBLEMAPS_DISABLED_DOMINATES');
  });

  it('hypothetical-enabled sim shows priority would help when approved under-covered', () => {
    // Disabled cycle, but hypothetical assumes a cap → approved-first helps.
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 8, notes: DISABLED_NOTES }),
      cycleRow({ contract: 'A2', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'R2', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'R3', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs, { assumedCap: 2 }));
    const hypo = r.hypotheticalSimulation;
    expect(hypo.totalCap).toBe(2);
    expect(hypo.approvedCoveredFirst).toBe(2);          // both approved before any rejected
    expect(hypo.approvedCoverageImprovementRows).toBeGreaterThan(0);
    expect(r.diagnoses).toContain('CAP_PRIORITY_WOULD_HELP');
  });

  it('does not claim behavior changed', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.behaviorChanged).toBe(false);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    const text = renderApprovedPriorityStudy(r);
    expect(text).not.toMatch(/behavior changed|gate changed|policy changed/i);
    expect(text).toMatch(/Does NOT change behavior/i);
  });

  it('includes STUDY_ONLY_NO_POLICY_CHANGE diagnosis', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.diagnoses).toContain('STUDY_ONLY_NO_POLICY_CHANGE');
  });

  it('produces valid JSON output', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED',       cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    const json = JSON.stringify(r, null, 2);
    const parsed = JSON.parse(json) as ApprovedPriorityStudyResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.coverageAll.approvedUnknown).toBe(1);
    expect(parsed.diagnoses.length).toBeGreaterThan(0);
  });

  it('handles old rows with missing optional fields', () => {
    // Minimal rows: no raw, no normalizedSignal, no m5, no notes.
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      { buyGateDecision: 'BUY_APPROVED_PAPER', ripperInput: { clusterRisk: 'UNKNOWN' } },
      { buyGateDecision: 'BUY_REJECTED' },                       // cluster MISSING → not a candidate
      { ripperInput: { clusterRisk: 'UNKNOWN' } },              // no gate → ignored
    ]);
    expect(() => runApprovedPriorityStudy(opts(dirs))).not.toThrow();
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.coverageAll.approvedUnknown).toBe(1);
    expect(r.coverageAll.rejectedUnknown).toBe(0);               // rejected row had MISSING cluster
  });

  it('does not mutate input files', () => {
    const cycleFile = writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    writeJsonl(dirs.memoryPath, [{ clusterRisk: 'UNKNOWN', gateDecision: 'BUY_APPROVED_PAPER' }]);
    writeJsonl(dirs.intentsPath, [{ contract: 'A1' }]);
    const before = {
      cycle:   fs.readFileSync(cycleFile, 'utf-8'),
      memory:  fs.readFileSync(dirs.memoryPath, 'utf-8'),
      intents: fs.readFileSync(dirs.intentsPath, 'utf-8'),
    };
    runApprovedPriorityStudy(opts(dirs));
    expect(fs.readFileSync(cycleFile, 'utf-8')).toBe(before.cycle);
    expect(fs.readFileSync(dirs.memoryPath, 'utf-8')).toBe(before.memory);
    expect(fs.readFileSync(dirs.intentsPath, 'utf-8')).toBe(before.intents);
  });

  it('asserts no gate / policy / trading changes via safety flags', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.noMutation).toBe(true);
    expect(r.noRealTrading).toBe(true);
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.noFilterChange).toBe(true);
    expect(r.noApiCalls).toBe(true);
    expect(r.noBubbleMapsCall).toBe(true);
    expect(r.noBubbleMapsReEnable).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });

  it('flags approved rows under-covered when approved UNKNOWN exceeds rejected', () => {
    // 4 approved (3 UNKNOWN = 75%), 4 rejected (1 UNKNOWN = 25%) → approved worse.
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 5 }),
      cycleRow({ contract: 'A2', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 6 }),
      cycleRow({ contract: 'A3', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'A4', gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN' }),
      cycleRow({ contract: 'R1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'R2', gate: 'BUY_REJECTED', cluster: 'CLEAN' }),
      cycleRow({ contract: 'R3', gate: 'BUY_REJECTED', cluster: 'CLEAN' }),
      cycleRow({ contract: 'R4', gate: 'BUY_REJECTED', cluster: 'CLEAN' }),
    ]);
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.diagnoses).toContain('APPROVED_ROWS_UNDER_COVERED');
    expect(r.diagnoses).toContain('M5_APPROVED_UNKNOWN_DOMINATES');
  });

  it('renders all required report sections', () => {
    writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', [
      cycleRow({ contract: 'A1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', notes: DISABLED_NOTES }),
    ]);
    const text = renderApprovedPriorityStudy(runApprovedPriorityStudy(opts(dirs)));
    expect(text).toContain('SECTION 1 — OVERVIEW');
    expect(text).toContain('SECTION 2 — CURRENT APPROVED vs REJECTED HOLDER COVERAGE');
    expect(text).toContain('SECTION 3 — BUBBLEMAPS DISABLED / CAP PRESSURE');
    expect(text).toContain('SECTION 4 — SIMULATED APPROVED-FIRST ALLOCATION');
    expect(text).toContain('SECTION 5 — M5-SPECIFIC IMPACT');
    expect(text).toContain('SECTION 6 — WHAT PRIORITY WOULD NOT FIX');
    expect(text).toContain('SECTION 7 — DIAGNOSIS');
    expect(text).toContain('SECTION 8 — RECOMMENDATION');
    expect(text).toContain('SECTION 9 — SAFETY');
    expect(text).toContain('no automatic BubbleMaps re-enable');
  });

  it('handles empty cycles dir without throwing', () => {
    const r = runApprovedPriorityStudy(opts(dirs));
    expect(r.totalCycleFiles).toBe(0);
    expect(r.coverageAll.approvedTotal).toBe(0);
    expect(r.diagnoses).toContain('STUDY_ONLY_NO_POLICY_CHANGE');
    expect(() => renderApprovedPriorityStudy(r)).not.toThrow();
  });
});
