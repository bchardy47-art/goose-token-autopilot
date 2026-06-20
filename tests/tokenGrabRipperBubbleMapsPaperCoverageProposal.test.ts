import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runPaperCoverageProposal,
  renderPaperCoverageProposal,
  type PaperCoverageProposalResult,
} from '../src/token-grab/ripperBubbleMapsPaperCoverageProposal';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

const DISABLED_NOTES = ['BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)'];

interface CycleRowSpec {
  contract?: string; gate?: string; cluster?: string; m5?: number | null; notes?: string[];
}
function cycleRow(spec: CycleRowSpec): Record<string, unknown> {
  return {
    capturedAt:       '2026-06-19T20:00:00.000Z',
    entryMomentumPct: spec.m5 ?? null,
    buyGateDecision:  spec.gate ?? 'BUY_REJECTED',
    normalizedSignal: { contract: spec.contract ?? 'C1', symbol: 'TKN' },
    ripperInput:      { contract: spec.contract ?? 'C1', clusterRisk: spec.cluster ?? 'UNKNOWN' },
    raw: { clusterRisk: spec.cluster ?? 'UNKNOWN', clusterProvider: 'bubblemaps-cached', clusterNotes: spec.notes ?? [] },
  };
}

interface TmpDirs { root: string; cyclesDir: string; memoryPath: string; intentsPath: string; cachePath: string; }
function makeTmpDirs(): TmpDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-test-'));
  const cyclesDir = path.join(root, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  return {
    root, cyclesDir,
    memoryPath:  path.join(root, 'learning-memory.jsonl'),
    intentsPath: path.join(root, 'paper-intents.jsonl'),
    cachePath:   path.join(root, 'bubblemaps-cache.jsonl'),
  };
}
function writeCycle(dirs: TmpDirs, name: string, rows: Record<string, unknown>[]): string {
  const file = path.join(dirs.cyclesDir, name);
  writeJsonl(file, rows);
  return file;
}
// A scenario where approved rows are badly under-covered and BubbleMaps is disabled.
function seedDisabledGap(dirs: TmpDirs): void {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push(cycleRow({ contract: `A${i}`, gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: i % 2 === 0 ? 8 : null, notes: DISABLED_NOTES }));
  }
  for (let i = 0; i < 4; i++) {
    rows.push(cycleRow({ contract: `RA${i}`, gate: 'BUY_REJECTED', cluster: 'CLEAN', notes: DISABLED_NOTES }));
  }
  rows.push(cycleRow({ contract: 'RU', gate: 'BUY_REJECTED', cluster: 'UNKNOWN', notes: DISABLED_NOTES }));
  writeCycle(dirs, 'cycle-2026-06-19-200000.jsonl', rows);
}
function opts(dirs: TmpDirs, extra: Record<string, unknown> = {}) {
  return {
    cyclesDir:   dirs.cyclesDir,
    memoryPath:  dirs.memoryPath,
    intentsPath: dirs.intentsPath,
    cachePath:   dirs.cachePath,
    disabledEnv: '1',          // simulate disabled by default in tests
    capEnv:      null,
    generatedAt: '2026-06-19T21:00:00.000Z',
    ...extra,
  };
}

let dirs: TmpDirs;
beforeEach(() => { dirs = makeTmpDirs(); });
afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BubbleMaps Paper Coverage Proposal v1', () => {
  it('detects disabled BubbleMaps', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs, { disabledEnv: '1' }));
    expect(r.configState.disabledActive).toBe(true);
    expect(r.configState.mode).toBe('DISABLED');
  });

  it('detects approved UNKNOWN coverage gap', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs));
    // 8 approved, all UNKNOWN → 100% approved UNKNOWN; rejected mostly CLEAN.
    expect(r.approvedUnknownPct).toBeGreaterThan(50);
    expect(r.approvedUnknownGapVsRejected).toBeGreaterThan(0);
  });

  it('computes a cap / call estimate', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs));
    expect(r.capPlan.recommendedInitialCap).toBeGreaterThanOrEqual(r.capPlan.minInitialCap);
    expect(r.capPlan.recommendedInitialCap).toBeLessThanOrEqual(r.capPlan.maxInitialCap);
    expect(r.expectedImprovement.approvedUnknownResolvedEstimate).toBeGreaterThan(0);
    expect(r.expectedImprovement.m5ApprovedUnknownResolvedEstimate).toBeGreaterThanOrEqual(0);
  });

  it('recommends paper-only proposal only (never enables)', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs));
    expect(r.recommendations).toContain('DO_NOT_ENABLE_YET');
    expect(r.recommendations).toContain('PAPER_COVERAGE_PROPOSAL_READY');
    expect(r.configState.supportsSafePaperMode).toBe(true);
    // Exact config change is DESCRIBED, not applied.
    expect(r.configChanged).toBe(false);
    expect(r.noConfigApplied).toBe(true);
    expect(r.exactConfigChange.join('\n')).toMatch(/DO NOT APPLY/i);
  });

  it('does not mutate config (no env write, no file write)', () => {
    seedDisabledGap(dirs);
    const before = process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
    runPaperCoverageProposal(opts(dirs));
    expect(process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED']).toBe(before);
    // No cache file was created by the proposal.
    expect(fs.existsSync(dirs.cachePath)).toBe(false);
  });

  it('does not change gates / data files (no mutation)', () => {
    const cycleFile = (() => { seedDisabledGap(dirs); return path.join(dirs.cyclesDir, 'cycle-2026-06-19-200000.jsonl'); })();
    const before = fs.readFileSync(cycleFile, 'utf-8');
    runPaperCoverageProposal(opts(dirs));
    expect(fs.readFileSync(cycleFile, 'utf-8')).toBe(before);
    const r = runPaperCoverageProposal(opts(dirs));
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });

  it('renders the safety footer and all sections', () => {
    seedDisabledGap(dirs);
    const text = renderPaperCoverageProposal(runPaperCoverageProposal(opts(dirs)));
    expect(text).toContain('SECTION 12 — SAFETY');
    expect(text).toContain('NO_CONFIG_APPLIED=true');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('SECTION 4 — PROPOSED PAPER-ONLY COVERAGE MODE');
    expect(text).toContain('SECTION 8 — FAILURE / ROLLBACK PLAN');
    expect(text).toMatch(/DO NOT APPLY/i);
  });

  it('reflects cache entry count and cache-first plan', () => {
    seedDisabledGap(dirs);
    writeJsonl(dirs.cachePath, [
      { contract: 'A0', cachedAt: '2026-06-19T20:00:00.000Z', result: { clusterRisk: 'CLEAN' } },
      { contract: 'A1', cachedAt: '2026-06-19T20:00:00.000Z', result: { clusterRisk: 'WATCH' } },
    ]);
    const r = runPaperCoverageProposal(opts(dirs));
    expect(r.configState.cacheEntryCount).toBe(2);
    expect(r.cacheFirstPlan.cacheEntryCount).toBe(2);
    expect(r.cacheFirstPlan.approvedRowsMaybeCached).toBeGreaterThan(0);
  });

  it('recognizes LIVE_CAPPED mode when not disabled', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs, { disabledEnv: '0', capEnv: '10' }));
    expect(r.configState.disabledActive).toBe(false);
    expect(r.configState.mode).toBe('LIVE_CAPPED');
    expect(r.configState.effectiveCap).toBe(10);
  });

  it('produces valid JSON output', () => {
    seedDisabledGap(dirs);
    const r = runPaperCoverageProposal(opts(dirs));
    const parsed = JSON.parse(JSON.stringify(r)) as PaperCoverageProposalResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.recommendations.length).toBeGreaterThan(0);
  });
});
