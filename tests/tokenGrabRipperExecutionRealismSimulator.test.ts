import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runExecutionRealismSimulator,
  renderExecutionRealismSimulator,
  adjustExecutionPnl,
  type ExecutionParams,
  type ExecutionRealismResult,
} from '../src/token-grab/ripperExecutionRealismSimulator';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface MemSpec {
  contract?: string; pnl?: number; m5?: number | null; liq?: string; vlr?: string; cluster?: string;
}
function memRow(spec: MemSpec): Record<string, unknown> {
  return {
    contract:         spec.contract ?? 'C1',
    symbol:           'TKN',
    gateDecision:     'BUY_APPROVED_PAPER',
    priceChangePct:   spec.pnl ?? 0,
    entryMomentumPct: spec.m5 ?? null,
    liquidityBucket:  spec.liq ?? 'LIQ_30K_100K',
    vlrBucket:        spec.vlr ?? 'VLR_LT_0_5',
    clusterRisk:      spec.cluster ?? 'CLEAN',
  };
}

const BASE_PARAMS: ExecutionParams = {
  slippageBps: 100, feeBps: 30, latencySeconds: 5, maxPnlCap: 300, thinLiqPenalty: 5, failedExitHaircut: 0.2,
};

let root: string;
let memoryPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ers-test-'));
  memoryPath = path.join(root, 'learning-memory.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function opts(extra: Record<string, unknown> = {}) {
  return { memoryPath, generatedAt: '2026-06-19T21:00:00.000Z', ...extra };
}

describe('Execution Realism Simulator v1', () => {
  it('applies slippage (more slippage → lower adjusted P/L)', () => {
    const row = { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 0 };
    const low  = adjustExecutionPnl(0, row, { ...BASE_PARAMS, slippageBps: 50 });
    const high = adjustExecutionPnl(0, row, { ...BASE_PARAMS, slippageBps: 200 });
    expect(high).toBeLessThan(low);
    // 0 baseline minus costs → strictly negative
    expect(low).toBeLessThan(0);
  });

  it('applies fees (more fees → lower adjusted P/L)', () => {
    const row = { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 0 };
    const low  = adjustExecutionPnl(0, row, { ...BASE_PARAMS, feeBps: 0 });
    const high = adjustExecutionPnl(0, row, { ...BASE_PARAMS, feeBps: 100 });
    expect(high).toBeLessThan(low);
  });

  it('applies latency chase penalty on strong M5', () => {
    const strongRow = { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 60 };
    const noLatency  = adjustExecutionPnl(100, strongRow, { ...BASE_PARAMS, latencySeconds: 0 });
    const highLatency = adjustExecutionPnl(100, strongRow, { ...BASE_PARAMS, latencySeconds: 30 });
    expect(highLatency).toBeLessThan(noLatency);
  });

  it('applies thin-liquidity and failed-exit haircuts', () => {
    const deep = { liquidityBucket: 'LIQ_GTE_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 0 };
    const thin = { liquidityBucket: 'LIQ_LT_10K',   vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 0 };
    const deepAdj = adjustExecutionPnl(50, deep, BASE_PARAMS);
    const thinAdj = adjustExecutionPnl(50, thin, BASE_PARAMS);
    expect(thinAdj).toBeLessThan(deepAdj);     // thin liquidity penalized harder
    // higher failed-exit haircut reduces positive gains
    const lowHair  = adjustExecutionPnl(50, deep, { ...BASE_PARAMS, failedExitHaircut: 0.0 });
    const highHair = adjustExecutionPnl(50, deep, { ...BASE_PARAMS, failedExitHaircut: 0.5 });
    expect(highHair).toBeLessThan(lowHair);
  });

  it('treats UNKNOWN cluster as execution risk (extra haircut vs CLEAN)', () => {
    const clean   = { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN',   entryMomentumPct: 0 };
    const unknown = { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'UNKNOWN', entryMomentumPct: 0 };
    const cleanAdj   = adjustExecutionPnl(50, clean, BASE_PARAMS);
    const unknownAdj = adjustExecutionPnl(50, unknown, BASE_PARAMS);
    expect(unknownAdj).toBeLessThan(cleanAdj);
  });

  it('caps outliers at maxPnlCap', () => {
    const row = { liquidityBucket: 'LIQ_GTE_100K', vlrBucket: 'VLR_LT_0_5', clusterRisk: 'CLEAN', entryMomentumPct: 0 };
    const adj = adjustExecutionPnl(99999, row, BASE_PARAMS);
    expect(adj).toBeLessThanOrEqual(BASE_PARAMS.maxPnlCap);
    const adjNeg = adjustExecutionPnl(-99999, row, BASE_PARAMS);
    expect(adjNeg).toBeGreaterThanOrEqual(-BASE_PARAMS.maxPnlCap);
  });

  it('computes adjusted metrics and detects overstatement', () => {
    const rows: Record<string, unknown>[] = [];
    // All small "winners" that fall below the cost line after adjustment.
    for (let i = 0; i < 40; i++) rows.push(memRow({ contract: `W${i}`, pnl: 1, liq: 'LIQ_LT_10K' }));
    writeJsonl(memoryPath, rows);
    const r = runExecutionRealismSimulator(opts());
    expect(r.overall.baselineAvg).toBeGreaterThan(0);
    expect(r.overall.adjustedAvg).toBeLessThan(r.overall.baselineAvg!);
    expect(r.diagnoses).toContain('PAPER_PNL_OVERSTATED');
    expect(r.diagnoses).toContain('NO_REAL_TRADING');
    expect(r.diagnoses).toContain('EXECUTION_MODEL_READY_FOR_STUDY');
  });

  it('does not mutate the input file', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 50 })]);
    const before = fs.readFileSync(memoryPath, 'utf-8');
    runExecutionRealismSimulator(opts());
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe(before);
  });

  it('sets safety flags and renders all sections', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 50 }), memRow({ contract: 'B', pnl: -10 })]);
    const r = runExecutionRealismSimulator(opts());
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    const text = renderExecutionRealismSimulator(r);
    expect(text).toContain('SECTION 8 — WORST EXECUTION-RISK CASES');
    expect(text).toContain('SECTION 9 — PAPER PROFIT ILLUSION WARNINGS');
    expect(text).toContain('SECTION 11 — SAFETY');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('respects CLI-style params via options', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 50 })]);
    const r = runExecutionRealismSimulator(opts({ slippageBps: 250, feeBps: 50, maxPnlCap: 100 }));
    expect(r.params.slippageBps).toBe(250);
    expect(r.params.feeBps).toBe(50);
    expect(r.params.maxPnlCap).toBe(100);
  });

  it('produces valid JSON output', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 50 })]);
    const r = runExecutionRealismSimulator(opts());
    const parsed = JSON.parse(JSON.stringify(r)) as ExecutionRealismResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.overall.n).toBe(1);
  });
});
