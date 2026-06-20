import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runShadowPolicyBacktester,
  renderShadowPolicyBacktester,
  buildPolicies,
  type ShadowPolicyBacktestResult,
} from '../src/token-grab/ripperShadowPolicyBacktester';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface MemSpec {
  contract?: string; gate?: string; pnl?: number; m5?: number | null;
  liq?: string; vlr?: string; cluster?: string;
}
function memRow(spec: MemSpec): Record<string, unknown> {
  return {
    contract:         spec.contract ?? 'C1',
    gateDecision:     spec.gate ?? 'BUY_APPROVED_PAPER',
    priceChangePct:   spec.pnl ?? 0,
    entryMomentumPct: spec.m5 ?? null,
    liquidityBucket:  spec.liq ?? 'LIQ_30K_100K',
    vlrBucket:        spec.vlr ?? 'VLR_LT_0_5',
    clusterRisk:      spec.cluster ?? 'CLEAN',
  };
}

let root: string;
let memoryPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spb-test-'));
  memoryPath = path.join(root, 'learning-memory.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function opts(extra: Record<string, unknown> = {}) {
  return { memoryPath, generatedAt: '2026-06-19T21:00:00.000Z', ...extra };
}

describe('Shadow Policy Backtester v1', () => {
  it('builds the full policy set including baseline', () => {
    const policies = buildPolicies();
    expect(policies.some(p => p.kind === 'BASELINE')).toBe(true);
    expect(policies.length).toBeGreaterThanOrEqual(7);
    expect(policies.some(p => p.id === 'neutral_nonthin')).toBe(true);
    expect(policies.some(p => p.kind === 'INFORMATIONAL')).toBe(true);
  });

  it('baseline policy reproduces current approvals', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'A', gate: 'BUY_APPROVED_PAPER', pnl: 5 }),
      memRow({ contract: 'B', gate: 'BUY_APPROVED_PAPER', pnl: -5 }),
      memRow({ contract: 'R', gate: 'BUY_REJECTED', pnl: 10 }),
    ]);
    const r = runShadowPolicyBacktester(opts());
    const baseline = r.policies.find(p => p.id === 'baseline')!;
    expect(baseline.wouldApprove).toBe(2);     // 2 currently approved
    expect(baseline.wouldReject).toBe(1);
    expect(baseline.overlapCurrentApproved).toBe(2);
  });

  it('computes candidate policies and selection sets', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'N1', gate: 'BUY_REJECTED', m5: 0, liq: 'LIQ_30K_100K', pnl: 5 }),   // M5_NEUTRAL non-thin
      memRow({ contract: 'N2', gate: 'BUY_REJECTED', m5: 0, liq: 'LIQ_LT_10K',   pnl: 5 }),   // M5_NEUTRAL thin
      memRow({ contract: 'P1', gate: 'BUY_APPROVED_PAPER', m5: 30, pnl: 5 }),                 // not neutral
    ]);
    const r = runShadowPolicyBacktester(opts());
    const neutralNonThin = r.policies.find(p => p.id === 'neutral_nonthin')!;
    // Only N1 qualifies (neutral + non-thin)
    expect(neutralNonThin.wouldApprove).toBe(1);
  });

  it('counts missed winners and avoided losers', () => {
    writeJsonl(memoryPath, [
      // currently rejected; neutral_nonthin would also reject these (thin/non-neutral)
      memRow({ contract: 'W', gate: 'BUY_REJECTED', m5: 30, liq: 'LIQ_LT_10K', pnl: 80 }),    // winner we'd miss
      memRow({ contract: 'L', gate: 'BUY_REJECTED', m5: 30, liq: 'LIQ_LT_10K', pnl: -60 }),   // big loser we'd avoid
    ]);
    const r = runShadowPolicyBacktester(opts());
    const neutral = r.policies.find(p => p.id === 'neutral_nonthin')!;
    expect(neutral.missedWinners).toBe(1);
    expect(neutral.avoidedLosers).toBe(1);
    expect(neutral.bigLosersAvoided).toBe(1);
  });

  it('blocks promotion under a weak (small) sample', () => {
    writeJsonl(memoryPath, [
      memRow({ contract: 'N1', gate: 'BUY_REJECTED', m5: 0, liq: 'LIQ_30K_100K', pnl: 50 }),
    ]);
    const r = runShadowPolicyBacktester(opts());
    const neutral = r.policies.find(p => p.id === 'neutral_nonthin')!;
    expect(neutral.promotion).toBe('NEEDS_MORE_DATA');
  });

  it('never promotes informational policy beyond STUDY_ONLY', () => {
    writeJsonl(memoryPath, Array.from({ length: 300 }, (_, i) =>
      memRow({ contract: `A${i}`, gate: 'BUY_APPROVED_PAPER', m5: 0, pnl: 100 })));
    const r = runShadowPolicyBacktester(opts());
    const info = r.policies.find(p => p.kind === 'INFORMATIONAL')!;
    expect(info.promotion).toBe('STUDY_ONLY');
  });

  it('can mark a strong policy ready for separate gate proposal review', () => {
    // 250 neutral non-thin rows with large raw P/L that survives execution costs,
    // and a baseline that is poor (thin, negative) so the candidate clearly beats it.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 250; i++) {
      rows.push(memRow({ contract: `G${i}`, gate: 'BUY_REJECTED', m5: 0, liq: 'LIQ_GTE_100K', cluster: 'CLEAN', pnl: 120 }));
    }
    for (let i = 0; i < 250; i++) {
      rows.push(memRow({ contract: `B${i}`, gate: 'BUY_APPROVED_PAPER', m5: 30, liq: 'LIQ_LT_10K', cluster: 'UNKNOWN', pnl: -30 }));
    }
    writeJsonl(memoryPath, rows);
    const r = runShadowPolicyBacktester(opts());
    const neutral = r.policies.find(p => p.id === 'neutral_nonthin')!;
    expect(neutral.sampleTier === 'USABLE_SIGNAL' || neutral.sampleTier === 'STRONGER').toBe(true);
    expect(neutral.promotion).toBe('READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW');
  });

  it('rejects a policy that is worse than baseline', () => {
    const rows: Record<string, unknown>[] = [];
    // Baseline (currently approved) is great; candidate neutral set is terrible.
    for (let i = 0; i < 250; i++) {
      rows.push(memRow({ contract: `OK${i}`, gate: 'BUY_APPROVED_PAPER', m5: 30, liq: 'LIQ_GTE_100K', cluster: 'CLEAN', pnl: 150 }));
    }
    for (let i = 0; i < 250; i++) {
      rows.push(memRow({ contract: `BAD${i}`, gate: 'BUY_REJECTED', m5: 0, liq: 'LIQ_30K_100K', cluster: 'CLEAN', pnl: -40 }));
    }
    writeJsonl(memoryPath, rows);
    const r = runShadowPolicyBacktester(opts());
    const neutral = r.policies.find(p => p.id === 'neutral_nonthin')!;
    expect(neutral.promotion).toBe('REJECT_POLICY');
  });

  it('does not mutate the input file', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 50 })]);
    const before = fs.readFileSync(memoryPath, 'utf-8');
    runShadowPolicyBacktester(opts());
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe(before);
  });

  it('renders the safety footer and sets flags', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 5 })]);
    const r = runShadowPolicyBacktester(opts());
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.noFilterChange).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    const text = renderShadowPolicyBacktester(r);
    expect(text).toContain('SECTION 4 — SAFETY');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('NO_GATE_CHANGES=true');
  });

  it('produces valid JSON output', () => {
    writeJsonl(memoryPath, [memRow({ contract: 'A', pnl: 5 }), memRow({ contract: 'B', gate: 'BUY_REJECTED', pnl: -5 })]);
    const r = runShadowPolicyBacktester(opts());
    const parsed = JSON.parse(JSON.stringify(r)) as ShadowPolicyBacktestResult;
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.policies.length).toBeGreaterThanOrEqual(7);
  });
});
