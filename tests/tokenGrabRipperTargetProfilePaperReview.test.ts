import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runTargetProfilePaperReview,
  renderTargetProfilePaperReview,
} from '../src/token-grab/ripperTargetProfilePaperReview';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tppr-'));
}

function writeCycle(dir: string, name: string, rows: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeCycleRow(o: {
  clusterRisk?: string;
  liquidityUsd?: number | null;
  vlr?: number | null;
  ageMinutes?: number | null;
  symbol?: string;
  contract?: string;
  entryDecision?: string;
  gateDecision?: string;
  bubbleMapsScore?: number | null;
  ripperScore?: number | null;
} = {}): object {
  const contract = o.contract ?? 'CONTRACT_AAAA1111pump';
  const symbol   = o.symbol ?? 'TEST';
  const liq      = o.liquidityUsd ?? 15_000;
  const vlr      = o.vlr ?? 0.3;
  const age      = o.ageMinutes ?? 3;
  const cr       = o.clusterRisk ?? 'WATCH';

  const clusterNotes = o.bubbleMapsScore != null
    ? [`bubbleMapsScore ${o.bubbleMapsScore}`]
    : [];

  return {
    id:             `dex-watch-run:${contract}:test`,
    capturedAt:     '2026-06-18T10:00:00.000Z',
    source:         'dex-watch-run',
    ripperInput: {
      contract, symbol,
      observedAt:             '2026-06-18T10:00:00.000Z',
      priceChangePct:          5,
      liquidityChangePct:      0,
      volumeLiquidityRatio:    vlr,
      clusterRisk:             cr,
    },
    normalizedSignal: {
      contract, symbol,
      liquidityUsd:            liq,
      volumeLiquidityRatio:    vlr,
      priceChangePct:          5,
    },
    raw: {
      clusterProvider: 'bubblemaps',
      clusterNotes,
    },
    ripperScore:     o.ripperScore ?? 0.82,
    ageMinutes:      age,
    entryDecision:   o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    buyGateDecision: o.gateDecision  ?? 'BUY_REJECTED',
    blockers:        ['cluster risk WATCH — buy downgraded to review'],
    topReasons:      ['prime window', 'liquidity quality GOOD'],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('runTargetProfilePaperReview', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Test 1: exact target match (WATCH + LIQ_10K_30K + ENTER_NOW)
  it('classifies WATCH + LIQ_10K_30K + ageMinutes<10 as TARGET_PROFILE_EXACT_MATCH', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(1);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(result.candidates[0]!.liquidityBucket).toBe('LIQ_10K_30K');
    expect(result.candidates[0]!.timingPath).toBe('ENTER_NOW');
    expect(result.recommendation).toBe('TARGET_PROFILE_MANUAL_PAPER_REVIEW');
  });

  // Test 2: near miss — correct liq bucket but timing is WAIT_10M (ageMinutes >= 10)
  it('classifies WATCH + LIQ_10K_30K + ageMinutes>=10 as TARGET_PROFILE_NEAR_MISS_WAIT', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.nearMisses).toBe(1);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_NEAR_MISS_WAIT');
    expect(result.candidates[0]!.timingPath).toBe('WAIT_10M');
    expect(result.recommendation).toBe('TARGET_PROFILE_KEEP_WATCHING');
  });

  // Test 3: non-WATCH rows excluded from candidates table
  it('excludes non-WATCH rows from candidates table', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN', liquidityUsd: 20_000, ageMinutes: 3 }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'CONTRACT_BBBB' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.totalRowsScanned).toBe(2);
    expect(result.candidates.length).toBe(1);  // only the WATCH row
    expect(result.candidates[0]!.clusterRisk).toBe('WATCH');
  });

  // Test 4: wrong liquidity bucket (WATCH but liq too low) → REJECT_NOT_TARGET
  it('labels WATCH + LIQ_LT_10K as TARGET_PROFILE_REJECT_NOT_TARGET', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.nearMisses).toBe(0);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
    expect(result.recommendation).toBe('TARGET_PROFILE_NO_MATCHES');
  });

  // Test 5: latest cycle file is selected automatically (highest lexicographic filename)
  it('selects the latest cycle file by filename when cycleDir provided', () => {
    writeCycle(dir, 'cycle-2026-06-18-090000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN', contract: 'CONTRACT_OLD' }),  // no WATCH
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'CONTRACT_NEW' }),
    ]);
    // Also put a feed file to ensure it's ignored
    fs.writeFileSync(path.join(dir, 'cycle-2026-06-18-120000-feed.json'), '{}');

    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.cycleFile).toBe('cycle-2026-06-18-110000.jsonl');  // latest .jsonl
    expect(result.exactMatches).toBe(1);
  });

  // Test 6: --cycle-file option overrides latest-cycle selection
  it('uses specified --cycle-file path instead of latest', () => {
    const older = writeCycle(dir, 'cycle-2026-06-18-090000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN' }),  // newer but no WATCH
    ]);
    const result = runTargetProfilePaperReview({ cycleFile: older });
    expect(result.cycleFile).toBe('cycle-2026-06-18-090000.jsonl');
    expect(result.exactMatches).toBe(1);
  });

  // Test 7: safety footer in rendered output
  it('render output contains safety strings', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    const rendered = renderTargetProfilePaperReview(result);
    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('NO TRADES');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
    expect(rendered).toContain('No gate');
  });

  // Test 8: no files are mutated during report
  it('cycle file is not mutated during report run', () => {
    const p = writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const before = fs.readFileSync(p, 'utf-8');
    runTargetProfilePaperReview({ cycleFile: p });
    expect(fs.readFileSync(p, 'utf-8')).toBe(before);
  });

  // Bonus: bubbleMapsScore parsed correctly
  it('parses bubbleMapsScore from raw.clusterNotes', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, bubbleMapsScore: 80.3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.bubbleMapsScore).toBeCloseTo(80.3);
  });

  // Bonus: VLR bucket derived correctly
  it('derives vlrBucket from volumeLiquidityRatio', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 0.2, ageMinutes: 3 }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 1.5, ageMinutes: 3, contract: 'CONTRACT_B2' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 3.0, ageMinutes: 3, contract: 'CONTRACT_C3' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    const vlrBuckets = result.candidates.map(c => c.vlrBucket);
    expect(vlrBuckets).toContain('VLR_LT_0_5');
    expect(vlrBuckets).toContain('VLR_0_5_TO_2');
    expect(vlrBuckets).toContain('VLR_GTE_2');
  });

  // Bonus: candidates sorted EXACT first, then NEAR_MISS, then REJECT
  it('candidates are sorted EXACT_MATCH first, then NEAR_MISS_WAIT, then REJECT_NOT_TARGET', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000,  ageMinutes: 3, contract: 'REJECT111' }),  // reject
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15, contract: 'NEARMISS1' }), // near miss
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'EXACT1111' }),  // exact
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(result.candidates[1]!.paperReviewLabel).toBe('TARGET_PROFILE_NEAR_MISS_WAIT');
    expect(result.candidates[2]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
  });

  // Bonus: result safety flags
  it('result includes all safety flags locked', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', []);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});
