import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runClusterCoverageAudit,
  renderClusterCoverageAudit,
  type ClusterCoverageAuditResult,
} from '../src/token-grab/ripperClusterCoverageAudit';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj));
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface CycleRowSpec {
  contract?:    string;
  symbol?:      string;
  capturedAt?:  string;
  m5?:          number | null;
  cluster?:     string;
  gate?:        string;
  notes?:       string[];
  fetchError?:  string;
  provider?:    string;
}

function cycleRow(spec: CycleRowSpec): Record<string, unknown> {
  return {
    capturedAt:       spec.capturedAt ?? '2026-06-19T20:00:00.000Z',
    entryMomentumPct: spec.m5 ?? null,
    buyGateDecision:  spec.gate ?? 'BUY_REJECTED',
    normalizedSignal: { contract: spec.contract ?? 'C1', symbol: spec.symbol ?? 'TKN' },
    ripperInput:      { contract: spec.contract ?? 'C1', clusterRisk: spec.cluster ?? 'UNKNOWN' },
    raw: {
      clusterRisk:       spec.cluster ?? 'UNKNOWN',
      clusterProvider:   spec.provider ?? 'bubblemaps-cached',
      clusterConfidence: (spec.cluster ?? 'UNKNOWN') === 'UNKNOWN' ? 'UNKNOWN' : 'HIGH',
      clusterNotes:      spec.notes ?? [],
      ...(spec.fetchError != null ? { clusterFetchError: spec.fetchError } : {}),
    },
  };
}

interface MemRowSpec {
  contract?:   string;
  symbol?:     string;
  m5?:         number | null;
  pnl?:        number | null;
  cluster?:    string;
  gate?:       string;
  liq?:        string;
  vlr?:        string;
  capturedAt?: string;
  observedAt?: string;
  cycleId?:              string;
  clusterUnknownReason?: string;
  clusterNotes?:         string[];
  clusterFetchError?:    string;
}

function memRow(spec: MemRowSpec): Record<string, unknown> {
  const row: Record<string, unknown> = {
    contract:         spec.contract ?? 'M1',
    symbol:           spec.symbol ?? 'TKN',
    capturedAt:       spec.capturedAt ?? '2026-06-19T20:00:00.000Z',
    observedAt:       spec.observedAt ?? '2026-06-19T20:30:00.000Z',
    entryMomentumPct: spec.m5 ?? null,
    priceChangePct:   spec.pnl ?? null,
    clusterRisk:      spec.cluster ?? 'UNKNOWN',
    liquidityBucket:  spec.liq ?? 'LIQ_10K_30K',
    vlrBucket:        spec.vlr ?? 'VLR_LT_0_5',
    gateDecision:     spec.gate ?? 'BUY_APPROVED_PAPER',
  };
  if (spec.cycleId              != null) row['cycleId']              = spec.cycleId;
  if (spec.clusterUnknownReason != null) row['clusterUnknownReason'] = spec.clusterUnknownReason;
  if (spec.clusterNotes         != null) row['clusterNotes']         = spec.clusterNotes;
  if (spec.clusterFetchError    != null) row['clusterFetchError']    = spec.clusterFetchError;
  return row;
}

interface TmpDirs {
  root:             string;
  cyclesDir:        string;
  memoryPath:       string;
  intentsPath:      string;
  observationsPath: string;
}

function makeTmpDirs(): TmpDirs {
  const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-test-'));
  const cyclesDir = path.join(root, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  return {
    root,
    cyclesDir,
    memoryPath:       path.join(root, 'learning-memory.jsonl'),
    intentsPath:      path.join(root, 'paper-intents.jsonl'),
    observationsPath: path.join(root, 'paper-intent-observations.jsonl'),
  };
}

function opts(dirs: TmpDirs) {
  return {
    cyclesDir:        dirs.cyclesDir,
    memoryPath:       dirs.memoryPath,
    intentsPath:      dirs.intentsPath,
    observationsPath: dirs.observationsPath,
    generatedAt:      '2026-06-19T21:00:00.000Z',
  };
}

let dirs: TmpDirs;
beforeEach(() => { dirs = makeTmpDirs(); });
afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runClusterCoverageAudit', () => {
  it('handles missing files safely', () => {
    const r = runClusterCoverageAudit({
      cyclesDir:        path.join(dirs.root, 'nope'),
      memoryPath:       path.join(dirs.root, 'nope.jsonl'),
      intentsPath:      path.join(dirs.root, 'nope2.jsonl'),
      observationsPath: path.join(dirs.root, 'nope3.jsonl'),
      generatedAt:      '2026-06-19T21:00:00.000Z',
    });
    expect(r.totalCycleRowsScanned).toBe(0);
    expect(r.totalMemoryRowsScanned).toBe(0);
    expect(r.latestCycleFile).toBeNull();
    expect(r.recentCycles).toEqual([]);
    expect(() => renderClusterCoverageAudit(r)).not.toThrow();
  });

  it('computes cluster coverage from cycle rows', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ cluster: 'CLEAN' }),
      cycleRow({ cluster: 'WATCH' }),
      cycleRow({ cluster: 'UNKNOWN' }),
      cycleRow({ cluster: 'RISKY' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    const cyc = r.stageCoverage.find(s => s.stage === 'cycle-rows')!;
    expect(cyc.total).toBe(4);
    expect(cyc.counts.CLEAN).toBe(1);
    expect(cyc.counts.WATCH).toBe(1);
    expect(cyc.counts.RISKY).toBe(1);
    expect(cyc.counts.UNKNOWN).toBe(1);
    // known = CLEAN+WATCH+RISKY = 3/4 = 75%
    expect(cyc.knownCoveragePct).toBeCloseTo(75, 5);
    expect(r.cycleUnknownPct).toBeCloseTo(25, 5);
  });

  it('computes cluster coverage from learning memory', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ cluster: 'CLEAN' }),
      memRow({ cluster: 'CLEAN' }),
      memRow({ cluster: 'UNKNOWN' }),
      memRow({ cluster: 'WATCH' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    const mem = r.stageCoverage.find(s => s.stage === 'learning-memory')!;
    expect(mem.total).toBe(4);
    expect(mem.counts.CLEAN).toBe(2);
    expect(mem.knownCoveragePct).toBeCloseTo(75, 5);
    expect(r.memoryUnknownPct).toBeCloseTo(25, 5);
  });

  it('computes stage coverage across all four stages', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [cycleRow({ cluster: 'CLEAN' })]);
    writeJsonl(dirs.memoryPath, [memRow({ cluster: 'UNKNOWN' })]);
    writeJsonl(dirs.intentsPath, [{ clusterRisk: 'CLEAN' }, { clusterRisk: 'UNKNOWN' }]);
    writeJsonl(dirs.observationsPath, [{ intentId: 'x' }, { intentId: 'y' }]); // no cluster field
    const r = runClusterCoverageAudit(opts(dirs));
    const stages = r.stageCoverage.map(s => s.stage);
    expect(stages).toEqual(['cycle-rows', 'paper-intents', 'observations', 'learning-memory']);
    const obs = r.stageCoverage.find(s => s.stage === 'observations')!;
    expect(obs.hasClusterField).toBe(false);
    expect(obs.counts.MISSING).toBe(2);
    const intents = r.stageCoverage.find(s => s.stage === 'paper-intents')!;
    expect(intents.hasClusterField).toBe(true);
    expect(intents.counts.UNKNOWN).toBe(1);
  });

  it('computes UNKNOWN percentage', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ cluster: 'UNKNOWN' }),
      cycleRow({ cluster: 'UNKNOWN' }),
      cycleRow({ cluster: 'UNKNOWN' }),
      cycleRow({ cluster: 'CLEAN' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.cycleUnknownPct).toBeCloseTo(75, 5);
  });

  it('detects UNKNOWN_REASON_NOT_RECORDED when no reason fields exist', () => {
    // UNKNOWN rows with empty notes and no fetch error → reason not recorded
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ cluster: 'UNKNOWN', notes: [] }),
      cycleRow({ cluster: 'UNKNOWN', notes: [] }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.unknownReasons.counts.UNKNOWN_REASON_NOT_RECORDED).toBe(2);
    expect(r.unknownReasons.reasonFieldExists).toBe(false);
  });

  it('detects API_CAP_SKIPPED when reason fields exist', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ cluster: 'UNKNOWN', notes: ['BubbleMaps call skipped: per-run cap of 20 reached'] }),
      cycleRow({ cluster: 'UNKNOWN', notes: ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'] }),
      cycleRow({ cluster: 'UNKNOWN', notes: ['BubbleMaps HTTP 429'], fetchError: 'HTTP 429' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.unknownReasons.counts.API_CAP_SKIPPED).toBe(1);
    expect(r.unknownReasons.counts.NOT_REQUESTED).toBe(1);
    expect(r.unknownReasons.counts.API_ERROR).toBe(1);
    expect(r.unknownReasons.reasonFieldExists).toBe(true);
  });

  it('detects BubbleMaps cap pressure from available metadata', () => {
    // one cap-hit cycle (live calls), others not disabled
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ cluster: 'UNKNOWN', provider: 'bubblemaps',
        notes: ['BubbleMaps call skipped: per-run cap of 20 reached', 'Set TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN to raise cap (current: 20)'] }),
      cycleRow({ cluster: 'CLEAN', provider: 'bubblemaps', notes: ['bubbleMapsScore 80'] }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.capPressure.skippedDueToCap).toBe(1);
    expect(r.capPressure.liveCallCap).toBe(20);
    expect(r.capPressure.capLikelyLimiting).toBe(true);
    expect(r.diagnoses).toContain('BUBBLEMAPS_CAP_LIMITING_COVERAGE');
  });

  it('computes M5 band × clusterRisk cross-tab', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ m5: 0, pnl: 10, cluster: 'CLEAN' }),     // M5_NEUTRAL
      memRow({ m5: 2, pnl: -5, cluster: 'UNKNOWN' }),   // M5_NEUTRAL
      memRow({ m5: 30, pnl: 50, cluster: 'UNKNOWN' }),  // M5_STRONG
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    const neutralClean = r.crossTab.find(c => c.m5Band === 'M5_NEUTRAL' && c.clusterRisk === 'CLEAN');
    const neutralUnknown = r.crossTab.find(c => c.m5Band === 'M5_NEUTRAL' && c.clusterRisk === 'UNKNOWN');
    const strong = r.crossTab.find(c => c.m5Band === 'M5_STRONG' && c.clusterRisk === 'UNKNOWN');
    expect(neutralClean?.n).toBe(1);
    expect(neutralUnknown?.n).toBe(1);
    expect(strong?.n).toBe(1);
  });

  it('detects M5_NEUTRAL_UNKNOWN_ARTIFACT', () => {
    const rows: Record<string, unknown>[] = [];
    // 60 UNKNOWN neutral winners (strong edge), 5 CLEAN neutral weak/negative
    for (let i = 0; i < 60; i++) rows.push(memRow({ contract: `U${i}`, m5: 0, pnl: 30, cluster: 'UNKNOWN' }));
    for (let i = 0; i < 5; i++)  rows.push(memRow({ contract: `C${i}`, m5: 0, pnl: -5, cluster: 'CLEAN' }));
    writeJsonl(dirs.memoryPath, rows);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.neutralReview.conclusion).toBe('M5_NEUTRAL_UNKNOWN_ARTIFACT');
    expect(r.neutralReview.artifactContaminated).toBe(true);
    expect(r.diagnoses).toContain('M5_NEUTRAL_UNKNOWN_ARTIFACT');
    expect(r.neutralReview.unknownPctOfPnlRows).toBeGreaterThan(50);
  });

  it('detects CLEAN_CLUSTER_SAMPLE_TOO_SMALL', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) rows.push(memRow({ contract: `U${i}`, m5: 0, pnl: 10, cluster: 'UNKNOWN' }));
    for (let i = 0; i < 10; i++) rows.push(memRow({ contract: `C${i}`, m5: 0, pnl: 5, cluster: 'CLEAN' })); // <50 CLEAN
    writeJsonl(dirs.memoryPath, rows);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.diagnoses).toContain('CLEAN_CLUSTER_SAMPLE_TOO_SMALL');
  });

  it('compares approved vs rejected cluster coverage', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN' }),
      cycleRow({ gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN' }),
      cycleRow({ gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ gate: 'BUY_REJECTED', cluster: 'WATCH' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.approvedVsRejected.approvedTotal).toBe(2);
    expect(r.approvedVsRejected.approvedUnknown).toBe(1);
    expect(r.approvedVsRejected.approvedUnknownPct).toBeCloseTo(50, 5);
    expect(r.approvedVsRejected.rejectedTotal).toBe(2);
    expect(r.approvedVsRejected.approvedSufficientlyCovered).toBe(false);
    expect(r.diagnoses).toContain('APPROVED_ROWS_LACK_CLUSTER_COVERAGE');
  });

  it('renders contract samples needing resolution', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'NEEDS1', m5: 1, cluster: 'UNKNOWN', gate: 'BUY_APPROVED_PAPER', pnl: 5 }),
      memRow({ contract: 'CLEAN1', m5: 1, cluster: 'CLEAN', gate: 'BUY_APPROVED_PAPER', pnl: 5 }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.samplesNeedingResolution.length).toBe(1);
    expect(r.samplesNeedingResolution[0].contractPrefix).toContain('NEEDS1');
    expect(r.samplesNeedingResolution[0].unknownReason).toContain('NOT_RECORDED');
  });

  it('never treats UNKNOWN as CLEAN (MISSING for unrecognized values)', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ cluster: 'unknown_garbage_value' }),
      memRow({ cluster: '' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    const mem = r.stageCoverage.find(s => s.stage === 'learning-memory')!;
    expect(mem.counts.CLEAN).toBe(0);
    expect(mem.counts.UNKNOWN).toBe(0);
    expect(mem.counts.MISSING).toBe(2);
  });

  it('renders all report sections', () => {
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 0, notes: ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'] }),
    ]);
    writeJsonl(dirs.memoryPath, [memRow({ m5: 0, pnl: 10, cluster: 'UNKNOWN' })]);
    const text = renderClusterCoverageAudit(runClusterCoverageAudit(opts(dirs)));
    for (const heading of [
      'SECTION 1 — OVERVIEW',
      'SECTION 2 — RECENT CYCLE CLUSTER COVERAGE',
      'SECTION 3 — CLUSTER COVERAGE BY STAGE',
      'SECTION 4 — UNKNOWN REASON BREAKDOWN',
      'SECTION 5 — BUBBLEMAPS CAP PRESSURE',
      'SECTION 6 — M5 BAND × CLUSTER RISK',
      'SECTION 7 — M5_NEUTRAL CLUSTER ARTIFACT REVIEW',
      'SECTION 8 — APPROVED vs REJECTED CLUSTER COVERAGE',
      'SECTION 9 — CONTRACT SAMPLES NEEDING CLUSTER RESOLUTION',
      'SECTION 10 — DIAGNOSIS',
      'SECTION 11 — RECOMMENDED NEXT ACTIONS',
      'SECTION 12 — SAFETY',
    ]) {
      expect(text).toContain(heading);
    }
  });

  it('renders safety footer with all required flags', () => {
    const text = renderClusterCoverageAudit(runClusterCoverageAudit(opts(dirs)));
    for (const flag of [
      'REPORT_ONLY=true', 'READ_ONLY=true', 'PAPER_ONLY=true', 'NO_MUTATION=true',
      'NO_REAL_TRADING=true', 'NO_GATE_CHANGES=true', 'NO_POLICY_CHANGE=true',
      'NO_WALLET=true', 'NO_SWAP=true', 'NO_SIGNING=true',
      'DO_NOT_ENABLE_REAL_TRADING', 'tradingExecuted=0', 'realTradingLocked=true',
    ]) {
      expect(text).toContain(flag);
    }
  });

  it('sets all safety flags on the result object', () => {
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.noMutation).toBe(true);
    expect(r.noRealTrading).toBe(true);
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });

  it('does not mutate input files', () => {
    const cycleFile = path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl');
    writeJsonl(cycleFile, [cycleRow({ cluster: 'UNKNOWN' })]);
    writeJsonl(dirs.memoryPath, [memRow({ m5: 0, pnl: 1, cluster: 'UNKNOWN' })]);
    const cycleBefore = fs.readFileSync(cycleFile, 'utf-8');
    const memBefore   = fs.readFileSync(dirs.memoryPath, 'utf-8');
    const filesBefore = fs.readdirSync(dirs.root).sort();
    runClusterCoverageAudit(opts(dirs));
    expect(fs.readFileSync(cycleFile, 'utf-8')).toBe(cycleBefore);
    expect(fs.readFileSync(dirs.memoryPath, 'utf-8')).toBe(memBefore);
    expect(fs.readdirSync(dirs.root).sort()).toEqual(filesBefore);
  });

  it('json-shaped result is serializable', () => {
    writeJsonl(dirs.memoryPath, [memRow({ m5: 0, pnl: 1, cluster: 'UNKNOWN' })]);
    const r = runClusterCoverageAudit(opts(dirs));
    const json = JSON.stringify(r);
    const parsed = JSON.parse(json) as ClusterCoverageAuditResult;
    expect(parsed.generatedAt).toBe('2026-06-19T21:00:00.000Z');
    expect(parsed.diagnoses.length).toBeGreaterThan(0);
  });

  it('reports CLUSTER_COVERAGE_HEALTHY when coverage is strong and clean', () => {
    const rows: Record<string, unknown>[] = [];
    // Strong CLEAN sample, no UNKNOWN dominance
    for (let i = 0; i < 60; i++) rows.push(memRow({ contract: `C${i}`, m5: 0, pnl: 10, cluster: 'CLEAN' }));
    writeJsonl(dirs.memoryPath, rows);
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ gate: 'BUY_APPROVED_PAPER', cluster: 'CLEAN', m5: 0, provider: 'bubblemaps', notes: ['bubbleMapsScore 80'] }),
      cycleRow({ gate: 'BUY_REJECTED', cluster: 'CLEAN', provider: 'bubblemaps', notes: ['bubbleMapsScore 70'] }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    // No UNKNOWN rows at all → no cycle-join gap → UNKNOWN_REASON_NOT_PERSISTED absent.
    expect(r.diagnoses).not.toContain('M5_NEUTRAL_UNKNOWN_ARTIFACT');
    expect(r.diagnoses).not.toContain('UNKNOWN_CLUSTER_DOMINATES_M5');
    expect(r.diagnoses).not.toContain('UNKNOWN_REASON_NOT_PERSISTED');
    expect(r.neutralReview.conclusion).toBe('M5_NEUTRAL_CLEAN_SUPPORTED');
  });

  it('UNKNOWN_REASON_NOT_PERSISTED fires only when old rows still need a cycle join', () => {
    // Old UNKNOWN row (no reason fields, no matching cycle) → still needs a join.
    writeJsonl(dirs.memoryPath, [memRow({ contract: 'OLD', cluster: 'UNKNOWN', cycleId: 'cycle-gone' })]);
    expect(runClusterCoverageAudit(opts(dirs)).diagnoses).toContain('UNKNOWN_REASON_NOT_PERSISTED');

    // All UNKNOWN rows carry a persisted reason → diagnosis absent.
    writeJsonl(dirs.memoryPath, [memRow({ contract: 'NEW', cluster: 'UNKNOWN', clusterUnknownReason: 'NOT_REQUESTED' })]);
    expect(runClusterCoverageAudit(opts(dirs)).diagnoses).not.toContain('UNKNOWN_REASON_NOT_PERSISTED');
  });

  // ── Cluster Reason Persistence v1 — memory-preferred reason + cycle join ──────

  it('prefers persisted memory clusterUnknownReason when present', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'A', cluster: 'UNKNOWN', clusterUnknownReason: 'API_CAP_SKIPPED' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.memoryReasonCoverage.totalUnknownMemoryRows).toBe(1);
    expect(r.memoryReasonCoverage.withReasonFieldDirect).toBe(1);
    expect(r.memoryReasonCoverage.requiringCycleJoin).toBe(0);
    expect(r.memoryReasonCoverage.counts.API_CAP_SKIPPED).toBe(1);
  });

  it('classifies from persisted memory notes/fetchError when no explicit reason', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'A', cluster: 'UNKNOWN', clusterNotes: ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'] }),
      memRow({ contract: 'B', cluster: 'UNKNOWN', clusterFetchError: 'HTTP 429' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.memoryReasonCoverage.withNotesOrFetchError).toBe(2);
    expect(r.memoryReasonCoverage.counts.NOT_REQUESTED).toBe(1);
    expect(r.memoryReasonCoverage.counts.API_ERROR).toBe(1);
  });

  it('falls back to cycle join for old memory rows lacking reason fields', () => {
    // Old memory row: UNKNOWN, no reason/notes, but has cycleId+contract for join.
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'JOINME', cluster: 'UNKNOWN', cycleId: 'cycle-2026-06-19-200000' }),
    ]);
    // Cycle file supplies the reason via clusterNotes.
    writeJsonl(path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'), [
      cycleRow({ contract: 'JOINME', cluster: 'UNKNOWN', notes: ['BubbleMaps call skipped: per-run cap of 20 reached'] }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.memoryReasonCoverage.withReasonFieldDirect).toBe(0);
    expect(r.memoryReasonCoverage.requiringCycleJoin).toBe(1);
    expect(r.memoryReasonCoverage.resolvedViaCycleJoin).toBe(1);
    expect(r.memoryReasonCoverage.counts.API_CAP_SKIPPED).toBe(1);
    expect(r.memoryReasonCoverage.reasonNotRecorded).toBe(0);
  });

  it('counts UNKNOWN_REASON_NOT_RECORDED when neither memory nor cycle has a reason', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'NOPE', cluster: 'UNKNOWN', cycleId: 'cycle-missing' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.memoryReasonCoverage.requiringCycleJoin).toBe(1);
    expect(r.memoryReasonCoverage.resolvedViaCycleJoin).toBe(0);
    expect(r.memoryReasonCoverage.reasonNotRecorded).toBe(1);
    expect(r.memoryReasonCoverage.counts.UNKNOWN_REASON_NOT_RECORDED).toBe(1);
  });

  it('samples surface the resolved reason and its source', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'DIRECT', m5: 0, cluster: 'UNKNOWN', gate: 'BUY_APPROVED_PAPER', clusterUnknownReason: 'NOT_REQUESTED' }),
    ]);
    const r = runClusterCoverageAudit(opts(dirs));
    expect(r.samplesNeedingResolution.length).toBe(1);
    expect(r.samplesNeedingResolution[0].unknownReason).toBe('NOT_REQUESTED (memory)');
  });

  it('renders the memory-layer reason breakdown in section 4', () => {
    writeJsonl(dirs.memoryPath, [
      memRow({ contract: 'A', cluster: 'UNKNOWN', clusterUnknownReason: 'API_ERROR' }),
    ]);
    const text = renderClusterCoverageAudit(runClusterCoverageAudit(opts(dirs)));
    expect(text).toContain('Memory-layer reasons');
    expect(text).toContain('With persisted clusterUnknownReason');
    expect(text).toContain('Requiring cycle join');
  });
});
