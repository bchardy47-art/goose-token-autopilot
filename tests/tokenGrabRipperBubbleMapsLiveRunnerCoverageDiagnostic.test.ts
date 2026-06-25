import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runCoverageDiagnostic,
  renderCoverageDiagnostic,
  type CoverageDiagnosticResult,
} from '../src/token-grab/ripperBubbleMapsLiveRunnerCoverageDiagnostic';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface CycleSpec { contract: string; symbol?: string; gate?: string; cluster?: string; m5?: number | null; }
function cycleRow(s: CycleSpec): Record<string, unknown> {
  return {
    capturedAt: '2026-06-20T12:00:00.000Z',
    buyGateDecision: s.gate ?? 'BUY_APPROVED_PAPER',
    entryMomentumPct: s.m5 ?? null,
    normalizedSignal: { contract: s.contract, symbol: s.symbol ?? s.contract },
    raw: { contract: s.contract, clusterRisk: s.cluster ?? 'UNKNOWN', clusterProvider: 'bubblemaps-cached' },
  };
}
function cacheEntry(contract: string, risk: string, cachedAt: string): Record<string, unknown> {
  return { contract, cachedAt, result: { clusterRisk: risk, clusterProvider: 'bubblemaps' } };
}

let root: string, cyclesDir: string, cachePath: string, memoryPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-diag-'));
  cyclesDir = path.join(root, 'cycles'); fs.mkdirSync(cyclesDir, { recursive: true });
  cachePath = path.join(root, 'bubblemaps-cache.jsonl');
  memoryPath = path.join(root, 'learning-memory.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOW = new Date('2026-06-20T13:00:00.000Z');
function opts(over = {}) {
  return { cyclesDir, cachePath, memoryPath, now: NOW, generatedAt: NOW.toISOString(), ...over };
}

describe('BubbleMaps Live-Runner Coverage Diagnostic v1', () => {
  it('flags candidates not prioritized when calls land on rejected/old rows', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
      cycleRow({ contract: 'REJ1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
    ]);
    // recent calls only went to rejected/old contracts, not the approved candidate
    writeJsonl(cachePath, [
      cacheEntry('REJ1', 'CLEAN', '2026-06-20T12:30:00.000Z'),
      cacheEntry('OLDX', 'CLEAN', '2026-06-20T12:31:00.000Z'),
    ]);
    const r = runCoverageDiagnostic(opts({ approvedFirstImplemented: false }));
    expect(r.diagnoses).toContain('APPROVED_FIRST_ONLY_SIMULATED_NOT_IMPLEMENTED');
    expect(r.diagnoses).toContain('LIVE_RUNNER_CANDIDATES_NOT_PRIORITIZED');
    expect(r.recentCallsOnCurrentApproved).toBe(0);
  });

  it('detects calls spent on rejected rows first', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
      cycleRow({ contract: 'REJ1', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
      cycleRow({ contract: 'REJ2', gate: 'BUY_REJECTED', cluster: 'UNKNOWN' }),
    ]);
    writeJsonl(cachePath, [
      cacheEntry('REJ1', 'CLEAN', '2026-06-20T12:30:00.000Z'),
      cacheEntry('REJ2', 'WATCH', '2026-06-20T12:31:00.000Z'),
    ]);
    const r = runCoverageDiagnostic(opts());
    expect(r.recentCallsOnRejectedOrOld).toBe(2);
    const rej = r.recentCalls.filter(c => c.classification === 'CURRENT_REJECTED');
    expect(rej).toHaveLength(2);
  });

  it('detects cache exists but live runner still sees UNKNOWN (not propagated)', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    // fresh KNOWN cache for the approved candidate, but raw cycle still UNKNOWN
    writeJsonl(cachePath, [cacheEntry('APP1', 'CLEAN', '2026-06-20T12:55:00.000Z')]);
    const r = runCoverageDiagnostic(opts({ liveRunnerReadsRawRows: true }));
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.calledReturnedKnown).toBe(true);
    expect(cand.cacheFresh).toBe(true);
    expect(cand.knownButNotPropagated).toBe(true);
    expect(r.diagnoses).toContain('BUBBLEMAPS_RESULTS_NOT_PROPAGATED');
    expect(r.diagnoses).toContain('CACHE_NOT_REUSED');
  });

  it('shows known result available but propagation missing while runner reads raw', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    writeJsonl(memoryPath, [{ contract: 'APP1', clusterRisk: 'CLEAN', observedAt: '2026-06-20T12:50:00.000Z' }]);
    const r = runCoverageDiagnostic(opts({ liveRunnerReadsRawRows: true }));
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.inMemoryKnown).toBe(true);
    expect(cand.knownButNotPropagated).toBe(true);
    expect(r.diagnoses).toContain('LIVE_RUNNER_READS_RAW_UNENRICHED_ROWS');
  });

  it('detects provider returns UNKNOWN', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    writeJsonl(cachePath, [cacheEntry('APP1', 'UNKNOWN', '2026-06-20T12:55:00.000Z')]);
    const r = runCoverageDiagnostic(opts());
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.calledReturnedUnknown).toBe(true);
    expect(r.diagnoses).toContain('BUBBLEMAPS_CALLS_RETURN_UNKNOWN');
    expect(r.diagnoses).toContain('UNKNOWN_REMAINS_VALID_BLOCKER');
  });

  it('detects cap too low for incoming UNKNOWN volume', () => {
    const rows = Array.from({ length: 8 }, (_, i) => cycleRow({ contract: `A${i}`, gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 5 }));
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), rows);
    const r = runCoverageDiagnostic(opts({ observedPerRunCap: 3 }));
    expect(r.diagnoses).toContain('CAP_TOO_LOW_FOR_INCOMING_UNKNOWN_VOLUME');
    expect(r.approvedUnknownTotal).toBe(8);
  });

  it('marks stale cache as not fresh (cannot clean)', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    writeJsonl(cachePath, [cacheEntry('APP1', 'CLEAN', '2026-06-18T01:00:00.000Z')]);  // ~60h old
    const r = runCoverageDiagnostic(opts());
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.cacheFresh).toBe(false);
    expect(cand.knownButNotPropagated).toBe(false);   // stale → cannot propagate as clean
    expect(r.diagnoses).toContain('UNKNOWN_REMAINS_VALID_BLOCKER');
  });

  it('reports COVERAGE_PATH_WORKING when wired and a candidate resolves', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    writeJsonl(cachePath, [cacheEntry('APP1', 'CLEAN', '2026-06-20T12:55:00.000Z')]);
    const r = runCoverageDiagnostic(opts({ liveRunnerReadsRawRows: false, approvedFirstImplemented: true }));
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.liveRunnerWouldSeeUnknown).toBe(false);  // resolver would see CLEAN
    expect(r.diagnoses).toContain('COVERAGE_PATH_WORKING');
  });

  it('never treats UNKNOWN as CLEAN and is report-only / no mutation / no api', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    const before = fs.readFileSync(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), 'utf-8');
    const r = runCoverageDiagnostic(opts());
    expect(fs.readFileSync(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), 'utf-8')).toBe(before);
    expect(r.noApiCalls).toBe(true);
    expect(r.noMutation).toBe(true);
    expect(r.reportOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    // UNKNOWN candidate with no fresh-known stays a blocker
    const cand = r.topCandidates.find(c => c.contract === 'APP1')!;
    expect(cand.liveRunnerWouldSeeUnknown).toBe(true);
  });

  it('renders the report with sections', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    const text = renderCoverageDiagnostic(runCoverageDiagnostic(opts()));
    expect(text).toContain('COVERAGE DIAGNOSTIC');
    expect(text).toContain('TOP LIVE-RUNNER CANDIDATES');
    expect(text).toContain('DIAGNOSIS');
    expect(text).toContain('UNKNOWN≠CLEAN');
  });

  it('produces valid JSON', () => {
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), [
      cycleRow({ contract: 'APP1', gate: 'BUY_APPROVED_PAPER', cluster: 'UNKNOWN', m5: 10 }),
    ]);
    const r = runCoverageDiagnostic(opts());
    const parsed = JSON.parse(JSON.stringify(r)) as CoverageDiagnosticResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.diagnoses.length).toBeGreaterThan(0);
  });

  it('unknownReasonCounts shows reasons from cached UNKNOWN entries with unknownReason field', () => {
    // Simulates what happens after the cache-persistence fix: UNKNOWN live-call results
    // are written with their unknownReason so the diagnostic can explain coverage failures.
    writeJsonl(cachePath, [
      { contract: 'C1', cachedAt: '2026-06-20T12:30:00.000Z', result: { clusterRisk: 'UNKNOWN', unknownReason: 'NO_MAP_YET',  clusterProvider: 'bubblemaps', chain: 'solana' } },
      { contract: 'C2', cachedAt: '2026-06-20T12:31:00.000Z', result: { clusterRisk: 'UNKNOWN', unknownReason: 'AUTH_ERROR',   clusterProvider: 'bubblemaps' } },
      { contract: 'C3', cachedAt: '2026-06-20T12:32:00.000Z', result: { clusterRisk: 'UNKNOWN', unknownReason: 'NO_MAP_YET',  clusterProvider: 'bubblemaps' } },
      { contract: 'C4', cachedAt: '2026-06-20T12:33:00.000Z', result: { clusterRisk: 'CLEAN',                                 clusterProvider: 'bubblemaps' } }, // CLEAN — not counted
    ]);
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), []);
    const r = runCoverageDiagnostic(opts());
    expect(r.unknownReasonCounts['NO_MAP_YET']).toBe(2);
    expect(r.unknownReasonCounts['AUTH_ERROR']).toBe(1);
    expect(r.unknownWithoutReason).toBe(0);
  });

  it('renders cached UNKNOWN reasons in BUBBLEMAPS UNKNOWN REASONS section', () => {
    writeJsonl(cachePath, [
      { contract: 'D1', cachedAt: '2026-06-20T12:30:00.000Z', result: { clusterRisk: 'UNKNOWN', unknownReason: 'RATE_LIMITED', clusterProvider: 'bubblemaps', httpStatus: 429, clusterFetchError: 'http 429 (rate limited)' } },
      { contract: 'D2', cachedAt: '2026-06-20T12:31:00.000Z', result: { clusterRisk: 'UNKNOWN', unknownReason: 'NO_MAP_YET',   clusterProvider: 'bubblemaps', httpStatus: 404 } },
    ]);
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), []);
    const text = renderCoverageDiagnostic(runCoverageDiagnostic(opts()));
    expect(text).toContain('BUBBLEMAPS UNKNOWN REASONS');
    expect(text).toContain('RATE_LIMITED');
    expect(text).toContain('NO_MAP_YET');
    expect(text).not.toContain('(no UNKNOWN results in cache)');
  });

  it('unknownWithoutReason counts legacy cache entries lacking unknownReason', () => {
    // Legacy entries (pre-fix) have no unknownReason but still have httpStatus/clusterFetchError
    writeJsonl(cachePath, [
      { contract: 'E1', cachedAt: '2026-06-20T12:30:00.000Z', result: { clusterRisk: 'UNKNOWN', httpStatus: 404, clusterProvider: 'bubblemaps' } }, // inferred → NO_MAP_YET
      { contract: 'E2', cachedAt: '2026-06-20T12:31:00.000Z', result: { clusterRisk: 'UNKNOWN', clusterProvider: 'bubblemaps' } }, // no reason, no httpStatus → unknownWithoutReason
    ]);
    writeJsonl(path.join(cyclesDir, 'cycle-2026-06-20-120000.jsonl'), []);
    const r = runCoverageDiagnostic(opts());
    expect(r.unknownReasonCounts['NO_MAP_YET']).toBe(1); // inferred from httpStatus=404
    expect(r.unknownWithoutReason).toBe(1);              // no inference possible
  });
});
