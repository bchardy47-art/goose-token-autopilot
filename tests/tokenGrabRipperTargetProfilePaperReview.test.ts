import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runTargetProfilePaperReview,
  renderTargetProfilePaperReview,
} from '../src/token-grab/ripperTargetProfilePaperReview';
import {
  runTargetProfileReviewLedgerReport,
  renderTargetProfileReviewLedgerReport,
} from '../src/token-grab/ripperTargetProfileReviewLedgerReport';
import {
  runTargetProfileReviewOutcomeUpdate,
  renderTargetProfileReviewOutcomeUpdate,
} from '../src/token-grab/ripperTargetProfileReviewOutcomeUpdate';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tppr-'));
}

function writeCycle(dir: string, name: string, rows: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function readLedger(ledgerPath: string): object[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeCycleRow(o: {
  clusterRisk?: string;
  liquidityUsd?: number | null;
  vlr?: number | null;
  ageMinutes?: number | null;
  symbol?: string;
  contract?: string;
  capturedAt?: string;
  entryDecision?: string;
  gateDecision?: string;
  bubbleMapsScore?: number | null;
  ripperScore?: number | null;
  priceChangePct?: number | null;
  topReasons?: string[];
  blockers?: string[];
} = {}): object {
  const contract      = o.contract   ?? 'CONTRACT_AAAA1111pump';
  const symbol        = o.symbol     ?? 'TEST';
  const liq           = o.liquidityUsd ?? 15_000;
  const vlr           = o.vlr        ?? 0.3;
  const age           = o.ageMinutes ?? 3;
  const cr            = o.clusterRisk ?? 'WATCH';
  const capturedAt    = o.capturedAt ?? '2026-06-18T10:00:00.000Z';
  const priceChangePct = o.priceChangePct ?? 5;

  const clusterNotes = o.bubbleMapsScore != null
    ? [`bubbleMapsScore ${o.bubbleMapsScore}`]
    : [];

  return {
    id:             `dex-watch-run:${contract}:test`,
    capturedAt,
    source:         'dex-watch-run',
    ripperInput: {
      contract, symbol,
      observedAt:          capturedAt,
      priceChangePct,
      liquidityChangePct:   0,
      volumeLiquidityRatio: vlr,
      clusterRisk:          cr,
    },
    normalizedSignal: {
      contract, symbol,
      liquidityUsd:         liq,
      volumeLiquidityRatio: vlr,
      priceChangePct,
    },
    raw: {
      clusterProvider: 'bubblemaps',
      clusterNotes,
    },
    ripperScore:     o.ripperScore ?? 82,
    ageMinutes:      age,
    entryDecision:   o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    buyGateDecision: o.gateDecision  ?? 'BUY_REJECTED',
    blockers:        o.blockers  ?? ['cluster risk WATCH — buy downgraded to review'],
    topReasons:      o.topReasons ?? ['prime window', 'liquidity quality GOOD'],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
  };
}

// ── Paper review tests ─────────────────────────────────────────────────────────
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
    expect(result.candidates.length).toBe(1);
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
      makeCycleRow({ clusterRisk: 'CLEAN', contract: 'CONTRACT_OLD' }),
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'CONTRACT_NEW' }),
    ]);
    fs.writeFileSync(path.join(dir, 'cycle-2026-06-18-120000-feed.json'), '{}');
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.cycleFile).toBe('cycle-2026-06-18-110000.jsonl');
    expect(result.exactMatches).toBe(1);
  });

  // Test 6: --cycle-file option overrides latest-cycle selection
  it('uses specified --cycle-file path instead of latest', () => {
    const older = writeCycle(dir, 'cycle-2026-06-18-090000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN' }),
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

  // Test 8: no files are mutated during report (no --write-ledger)
  it('cycle file and no ledger are mutated without --write-ledger', () => {
    const cyclePath  = writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const cycleBefore = fs.readFileSync(cyclePath, 'utf-8');

    runTargetProfilePaperReview({ cycleFile: cyclePath, ledgerPath });

    expect(fs.readFileSync(cyclePath, 'utf-8')).toBe(cycleBefore);
    expect(fs.existsSync(ledgerPath)).toBe(false);  // ledger NOT created without --write-ledger
  });

  // Test 9: exact matches written to ledger when --write-ledger enabled
  it('writes exact matches to ledger when writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'EXACT_AAAA' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15, contract: 'NEARMISS_1' }),  // near miss
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3, contract: 'REJECT_AAA' }),   // reject
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({
      cycleDir: dir,
      writeLedger: true,
      ledgerPath,
      ledgerReviewedAt: '2026-06-18T12:00:00.000Z',
    });

    expect(result.exactMatchesWritten).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.ledgerWriteEnabled).toBe(true);

    const ledgerRows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]!['contract']).toBe('EXACT_AAAA');
    expect(ledgerRows[0]!['paperReviewLabel']).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(ledgerRows[0]!['status']).toBe('REVIEWED_ONLY');
    expect(ledgerRows[0]!['outcomeStatus']).toBe('UNKNOWN');
    expect(ledgerRows[0]!['targetProfileId']).toBe('LIQ_10K_30K_WATCH_ENTER_NOW');
  });

  // Test 10: near misses are NOT written to ledger
  it('near misses are not written to ledger even with writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15 }),  // near miss
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath });
    expect(result.exactMatchesWritten).toBe(0);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  // Test 11: rejects are NOT written to ledger
  it('rejects are not written to ledger even with writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3 }),  // reject
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath });
    expect(result.exactMatchesWritten).toBe(0);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  // Test 12: dedupe — second run with same cycle skips existing rows
  it('deduplicates by contract+cycleId+capturedAt+targetProfileId', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'EXACT_AAAA' }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const opts = { cycleDir: dir, writeLedger: true, ledgerPath, ledgerReviewedAt: '2026-06-18T12:00:00.000Z' };

    const r1 = runTargetProfilePaperReview(opts);
    expect(r1.exactMatchesWritten).toBe(1);
    expect(r1.duplicatesSkipped).toBe(0);

    const r2 = runTargetProfilePaperReview(opts);
    expect(r2.exactMatchesWritten).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);

    const ledgerRows = readLedger(ledgerPath);
    expect(ledgerRows.length).toBe(1);  // only one row despite two runs
  });

  // Test 13: ledger rows contain all required safety flags
  it('ledger rows include safety flags', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath, ledgerReviewedAt: '2026-06-18T12:00:00.000Z' });
    const rows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(rows[0]!['reportOnly']).toBe(true);
    expect(rows[0]!['readOnly']).toBe(true);
    expect(rows[0]!['paperOnly']).toBe(true);
    expect(rows[0]!['realTradingLocked']).toBe(true);
    expect(rows[0]!['tradingExecuted']).toBe(0);
    expect(rows[0]!['historicalWin5Rate']).toBeCloseTo(0.627);
    expect(rows[0]!['historicalLift']).toBeCloseTo(3.31);
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
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000,  ageMinutes: 3,  contract: 'REJECT111' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15, contract: 'NEARMISS1' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3,  contract: 'EXACT1111' }),
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

// ── Strict-match gate tests ────────────────────────────────────────────────────
describe('strict exact-match gates', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Test S1: SENDY-like — broad match + VLR_GTE_2 + ripperScore=0 + PAPER_BUY_BLOCKED + bot/pump reason
  it('SENDY-like row (PAPER_BUY_BLOCKED + ripperScore=0 + VLR_GTE_2 + bot/pump) is REJECT with BLOCKED_ENTRY_DECISION', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({
        clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3,
        vlr: 5.0, ripperScore: 0,
        entryDecision: 'PAPER_BUY_BLOCKED',
        topReasons: ['bot/pump risk detected', 'price declining sharply'],
        priceChangePct: -35,
      }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.broadProfileRejects).toBe(1);
    const c = result.candidates[0]!;
    expect(c.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
    expect(c.strictRejectReason).toBe('BLOCKED_ENTRY_DECISION');  // first rule fires
  });

  // Test S2: READY_TO_SNIPE_PAPER + ripperScore>=80 + VLR_LT_0_5 → strict EXACT_MATCH
  it('READY_TO_SNIPE_PAPER + ripperScore=82 + VLR_LT_0_5 is EXACT_MATCH with no strictRejectReason', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, vlr: 0.3, ripperScore: 82 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(1);
    expect(result.broadProfileRejects).toBe(0);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(result.candidates[0]!.strictRejectReason).toBeNull();
  });

  // Test S3: VLR_0_5_TO_2 still matches when other rules pass
  it('VLR_0_5_TO_2 is still EXACT_MATCH when all other strict rules pass', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, vlr: 1.2 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(1);
    expect(result.candidates[0]!.vlrBucket).toBe('VLR_0_5_TO_2');
    expect(result.candidates[0]!.strictRejectReason).toBeNull();
  });

  // Test S4: entryDecision=PAPER_BUY_BLOCKED → BLOCKED_ENTRY_DECISION
  it('entryDecision=PAPER_BUY_BLOCKED rejects with BLOCKED_ENTRY_DECISION', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, entryDecision: 'PAPER_BUY_BLOCKED' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
    expect(result.candidates[0]!.strictRejectReason).toBe('BLOCKED_ENTRY_DECISION');
  });

  // Test S5: ripperScore=50 < 80 → RIPPER_SCORE_TOO_LOW
  it('ripperScore=50 rejects with RIPPER_SCORE_TOO_LOW', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, ripperScore: 50 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.strictRejectReason).toBe('RIPPER_SCORE_TOO_LOW');
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
  });

  // Test S6: reason includes "bot/pump risk" → BOT_PUMP_RISK_EXCLUDED
  it('reason containing "bot/pump risk" rejects with BOT_PUMP_RISK_EXCLUDED', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({
        clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3,
        topReasons: ['bot/pump risk — wallet cluster suspicious'],
      }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.strictRejectReason).toBe('BOT_PUMP_RISK_EXCLUDED');
  });

  // Test S7: reason includes "possible pump" → BOT_PUMP_RISK_EXCLUDED
  it('reason containing "possible pump" rejects with BOT_PUMP_RISK_EXCLUDED', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({
        clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3,
        topReasons: ['possible pump activity detected'],
      }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.strictRejectReason).toBe('BOT_PUMP_RISK_EXCLUDED');
  });

  // Test S8: reason includes "suspicious liquidity" → SUSPICIOUS_LIQUIDITY_EXCLUDED
  it('reason containing "suspicious liquidity" rejects with SUSPICIOUS_LIQUIDITY_EXCLUDED', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({
        clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3,
        topReasons: ['suspicious liquidity pattern observed'],
      }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.strictRejectReason).toBe('SUSPICIOUS_LIQUIDITY_EXCLUDED');
  });

  // Test S9: priceChangePct <= -20 → PRICE_CRASH_EXCLUDED
  it('priceChangePct=-25 rejects with PRICE_CRASH_EXCLUDED', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, priceChangePct: -25 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.strictRejectReason).toBe('PRICE_CRASH_EXCLUDED');
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
  });

  // Test S10: --write-ledger does not write broad-match rows that fail strict gate
  it('--write-ledger does not write broad-rejected matches to ledger', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ contract: 'STRICT_REJECT', entryDecision: 'PAPER_BUY_BLOCKED' }),  // broad+strict reject
      makeCycleRow({ contract: 'STRICT_PASS_1' }),  // passes all strict rules
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({
      cycleDir: dir, writeLedger: true, ledgerPath,
      ledgerReviewedAt: '2026-06-18T12:00:00.000Z',
    });
    expect(result.exactMatchesWritten).toBe(1);
    expect(result.exactMatches).toBe(1);
    expect(result.broadProfileRejects).toBe(1);
    const rows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['contract']).toBe('STRICT_PASS_1');
  });

  // Test S11: VLR_GTE_2 exact row → VLR_GTE_2_EXCLUDED (after READY_TO_SNIPE_PAPER + score>=80)
  it('VLR_GTE_2 rejects with VLR_GTE_2_EXCLUDED', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 15_000, ageMinutes: 3, vlr: 3.5 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.vlrBucket).toBe('VLR_GTE_2');
    expect(result.candidates[0]!.strictRejectReason).toBe('VLR_GTE_2_EXCLUDED');
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
  });
});

// ── Ledger report tests ────────────────────────────────────────────────────────
describe('runTargetProfileReviewLedgerReport', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeLedgerRows(ledgerPath: string, rows: object[]): void {
    fs.writeFileSync(ledgerPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function makeLedgerRow(o: Record<string, unknown> = {}): object {
    return {
      reviewId:           'LIQ_10K_30K_WATCH_ENTER_NOW::cycle-test::CONTRACT_A',
      targetProfileId:    'LIQ_10K_30K_WATCH_ENTER_NOW',
      cycleId:            'cycle-2026-06-18-100000',
      cycleFile:          'cycle-2026-06-18-100000.jsonl',
      contract:           'CONTRACT_AAAA',
      symbol:             'TEST',
      capturedAt:         '2026-06-18T10:00:00.000Z',
      reviewedAt:         '2026-06-18T12:00:00.000Z',
      ageMinutes:         3,
      liquidityUsd:       20_000,
      liquidityBucket:    'LIQ_10K_30K',
      vlrBucket:          'VLR_LT_0_5',
      clusterRisk:        'WATCH',
      bubbleMapsScore:    44.4,
      ripperScore:        100,
      timingPath:         'ENTER_NOW',
      paperReviewLabel:   'TARGET_PROFILE_EXACT_MATCH',
      status:             'REVIEWED_ONLY',
      outcomeStatus:      'UNKNOWN',
      historicalWin5Rate: 0.627,
      reportOnly:         true,
      readOnly:           true,
      paperOnly:          true,
      realTradingLocked:  true,
      tradingExecuted:    0,
      ...o,
    };
  }

  // Test 14: ledger report counts rows correctly
  it('counts total reviewed and unique contracts', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [
      makeLedgerRow({ contract: 'CONTRACT_A', symbol: 'AAA' }),
      makeLedgerRow({ contract: 'CONTRACT_B', symbol: 'BBB', cycleId: 'cycle-2026-06-18-110000' }),
      makeLedgerRow({ contract: 'CONTRACT_A', symbol: 'AAA', cycleId: 'cycle-2026-06-18-120000' }),  // dupe contract
    ]);
    const result = runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(result.totalReviewed).toBe(3);
    expect(result.uniqueContracts).toBe(2);
    expect(result.byCycleId['cycle-2026-06-18-100000']).toBe(1);
    expect(result.byCycleId['cycle-2026-06-18-110000']).toBe(1);
    expect(result.bySymbol['AAA']).toBe(2);
    expect(result.bySymbol['BBB']).toBe(1);
    expect(result.outcomeStatusCounts['UNKNOWN']).toBe(3);
    expect(result.targetProfileCounts['LIQ_10K_30K_WATCH_ENTER_NOW']).toBe(3);
  });

  // Test 15: report command does not mutate the ledger
  it('report command does not mutate ledger file', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [makeLedgerRow()]);
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(before);
  });

  // Test 16: render contains safety strings
  it('render contains safety footer strings', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [makeLedgerRow()]);
    const result   = runTargetProfileReviewLedgerReport({ ledgerPath });
    const rendered = renderTargetProfileReviewLedgerReport(result);
    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
  });

  // Test 17: empty ledger returns safe zero state
  it('handles empty or missing ledger gracefully', () => {
    const ledgerPath = path.join(dir, 'ledger-none.jsonl');
    const result = runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(result.totalReviewed).toBe(0);
    expect(result.uniqueContracts).toBe(0);
    expect(result.latestCandidates.length).toBe(0);
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  // Test 18: ledger report computes win5/flatDump from OBSERVED rows
  it('computes win5Rate and flatDumpRate from observed rows', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [
      makeLedgerRow({ contract: 'C1', symbol: 'W1', outcomeStatus: 'OBSERVED', outcomeLabel: 'BIG_WINNER' }),
      makeLedgerRow({ contract: 'C2', symbol: 'W2', outcomeStatus: 'OBSERVED', outcomeLabel: 'FLAT_JUNK' }),
      makeLedgerRow({ contract: 'C3', symbol: 'W3', outcomeStatus: 'OBSERVED', outcomeLabel: 'DUMP' }),
      makeLedgerRow({ contract: 'C4', symbol: 'W4', outcomeStatus: 'UNKNOWN' }),
    ]);
    const result = runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(result.observedCount).toBe(3);
    expect(result.stillUnknownCount).toBe(1);
    expect(result.win5Count).toBe(1);
    expect(result.flatDumpCount).toBe(2);
    expect(result.win5Rate).toBeCloseTo(1 / 3);
    expect(result.flatDumpRate).toBeCloseTo(2 / 3);
    expect(result.outcomeLabelCounts['BIG_WINNER']).toBe(1);
    expect(result.outcomeLabelCounts['FLAT_JUNK']).toBe(1);
    expect(result.outcomeLabelCounts['DUMP']).toBe(1);
  });
});

// ── Outcome updater tests ──────────────────────────────────────────────────────
describe('runTargetProfileReviewOutcomeUpdate', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeLedger(ledgerPath: string, rows: object[]): void {
    fs.writeFileSync(ledgerPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function writeMemory(memoryPath: string, rows: object[]): void {
    fs.writeFileSync(memoryPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function makeOutcomeLedgerRow(o: Record<string, unknown> = {}): object {
    return {
      reviewId:        'LIQ_10K_30K_WATCH_ENTER_NOW::cycle-test::CONTRACT_A',
      targetProfileId: 'LIQ_10K_30K_WATCH_ENTER_NOW',
      cycleId:         'cycle-2026-06-18-100000',
      contract:        'CONTRACT_AAAA',
      symbol:          'TEST',
      capturedAt:      '2026-06-18T10:00:00.000Z',
      reviewedAt:      '2026-06-18T12:00:00.000Z',
      status:          'REVIEWED_ONLY',
      outcomeStatus:   'UNKNOWN',
      reportOnly:      true, readOnly: true, paperOnly: true,
      realTradingLocked: true, tradingExecuted: 0,
      ...o,
    };
  }

  function makeMemoryRow(o: Record<string, unknown> = {}): object {
    return {
      contract:      'CONTRACT_AAAA',
      cycleId:       'cycle-2026-06-18-100000',
      capturedAt:    '2026-06-18T10:00:00.000Z',
      observedAt:    '2026-06-18T09:55:00.000Z',
      outcomeLabel:  'BIG_WINNER',
      priceChangePct: 12.5,
      outcomeSource: 'paper-observation',
      gateDecision:  'BUY_REJECTED',
      ...o,
    };
  }

  // Test 19: dry-run finds match but does not write ledger
  it('dry-run reports match without writing ledger', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow()]);
    writeMemory(memoryPath, [makeMemoryRow()]);

    const before = fs.readFileSync(ledgerPath, 'utf-8');
    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });

    expect(result.dryRun).toBe(true);
    expect(result.writeEnabled).toBe(false);
    expect(result.matchedOutcomes).toBe(1);
    expect(result.updatedRows).toBe(0);  // 0 on dry-run
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(before);  // not mutated
  });

  // Test 20: --write applies the update
  it('write=true applies outcome to ledger rows', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow()]);
    writeMemory(memoryPath, [makeMemoryRow({ outcomeLabel: 'BIG_WINNER', priceChangePct: 8.0 })]);

    const result = runTargetProfileReviewOutcomeUpdate({
      ledgerPath, memoryPath, write: true,
      updatedAt: '2026-06-18T13:00:00.000Z',
    });

    expect(result.updatedRows).toBe(1);
    expect(result.matchedOutcomes).toBe(1);
    expect(result.writeEnabled).toBe(true);

    const rows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['outcomeStatus']).toBe('OBSERVED');
    expect(rows[0]!['outcomeLabel']).toBe('BIG_WINNER');
    expect(rows[0]!['priceChangePct']).toBeCloseTo(8.0);
    expect(rows[0]!['updatedAt']).toBe('2026-06-18T13:00:00.000Z');
  });

  // Test 21: CONTRACT_AND_TIME match (capturedAt >= ledger capturedAt)
  it('uses CONTRACT_AND_TIME when memory capturedAt >= ledger capturedAt', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow({ capturedAt: '2026-06-18T10:00:00.000Z' })]);
    writeMemory(memoryPath, [
      makeMemoryRow({ capturedAt: '2026-06-18T10:00:00.000Z', outcomeLabel: 'BIG_WINNER' }),
    ]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.updatedCandidates[0]!.matchQuality).toBe('CONTRACT_AND_TIME');
    expect(result.updatedCandidates[0]!.outcomeLabel).toBe('BIG_WINNER');
  });

  // Test 22: CONTRACT_ONLY_FALLBACK when no memory row has capturedAt >= ledger capturedAt
  it('falls back to CONTRACT_ONLY_FALLBACK when no after-capturedAt match exists', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow({ capturedAt: '2026-06-18T10:00:00.000Z' })]);
    writeMemory(memoryPath, [
      makeMemoryRow({ capturedAt: '2026-06-18T09:00:00.000Z', outcomeLabel: 'FLAT_JUNK' }),
      makeMemoryRow({ capturedAt: '2026-06-18T08:00:00.000Z', outcomeLabel: 'FLAT_JUNK' }),
    ]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.matchedOutcomes).toBe(1);
    expect(result.updatedCandidates[0]!.matchQuality).toBe('CONTRACT_ONLY_FALLBACK');
  });

  // Test 23: no match when no memory rows exist for contract
  it('leaves row UNKNOWN when no memory rows exist for contract', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow({ contract: 'CONTRACT_NO_MEMORY' })]);
    writeMemory(memoryPath, [makeMemoryRow({ contract: 'DIFFERENT_CONTRACT' })]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.matchedOutcomes).toBe(0);
    expect(result.stillUnknown).toBe(1);
    expect(result.updatedCandidates.length).toBe(0);
  });

  // Test 24: no match when all memory rows for contract have outcomeLabel=UNKNOWN
  it('leaves row UNKNOWN when all memory rows have outcomeLabel UNKNOWN', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow()]);
    writeMemory(memoryPath, [makeMemoryRow({ outcomeLabel: 'UNKNOWN' })]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.matchedOutcomes).toBe(0);
    expect(result.stillUnknown).toBe(1);
  });

  // Test 25: already-OBSERVED rows are skipped
  it('skips rows that are already OBSERVED', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [
      makeOutcomeLedgerRow({ outcomeStatus: 'OBSERVED', outcomeLabel: 'BIG_WINNER' }),
    ]);
    writeMemory(memoryPath, [makeMemoryRow()]);

    const before = fs.readFileSync(ledgerPath, 'utf-8');
    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath, write: true });
    expect(result.unknownBefore).toBe(0);
    expect(result.matchedOutcomes).toBe(0);
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(before);
  });

  // Test 26: multiple contracts updated in a single run
  it('updates multiple contracts in one pass', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [
      makeOutcomeLedgerRow({ contract: 'CONTRACT_A', symbol: 'AAA' }),
      makeOutcomeLedgerRow({ contract: 'CONTRACT_B', symbol: 'BBB' }),
    ]);
    writeMemory(memoryPath, [
      makeMemoryRow({ contract: 'CONTRACT_A', outcomeLabel: 'BIG_WINNER' }),
      makeMemoryRow({ contract: 'CONTRACT_B', outcomeLabel: 'FLAT_JUNK' }),
    ]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.matchedOutcomes).toBe(2);
    expect(result.outcomeLabelCounts['BIG_WINNER']).toBe(1);
    expect(result.outcomeLabelCounts['FLAT_JUNK']).toBe(1);
    expect(result.stillUnknown).toBe(0);
  });

  // Test 27: outcomeLabelCounts aggregated correctly
  it('reports outcomeLabelCounts across all matched rows', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [
      makeOutcomeLedgerRow({ contract: 'C1' }),
      makeOutcomeLedgerRow({ contract: 'C2' }),
      makeOutcomeLedgerRow({ contract: 'C3' }),
    ]);
    writeMemory(memoryPath, [
      makeMemoryRow({ contract: 'C1', outcomeLabel: 'BIG_WINNER' }),
      makeMemoryRow({ contract: 'C2', outcomeLabel: 'FLAT_JUNK' }),
      makeMemoryRow({ contract: 'C3', outcomeLabel: 'FLAT_JUNK' }),
    ]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.outcomeLabelCounts['BIG_WINNER']).toBe(1);
    expect(result.outcomeLabelCounts['FLAT_JUNK']).toBe(2);
  });

  // Test 28: result safety flags locked
  it('result includes all safety flags', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow()]);
    writeMemory(memoryPath, [makeMemoryRow()]);

    const result = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  // Test 29: render output contains safety strings
  it('render output contains safety strings', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const memoryPath = path.join(dir, 'memory.jsonl');
    writeLedger(ledgerPath, [makeOutcomeLedgerRow()]);
    writeMemory(memoryPath, [makeMemoryRow()]);

    const result   = runTargetProfileReviewOutcomeUpdate({ ledgerPath, memoryPath });
    const rendered = renderTargetProfileReviewOutcomeUpdate(result);
    expect(rendered).toContain('PAPER ONLY');
    expect(rendered).toContain('NO WALLET');
    expect(rendered).toContain('NO REAL TRADING');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
  });
});
