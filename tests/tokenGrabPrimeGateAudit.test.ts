import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as primeGateModule from '../src/token-grab/primeGateAudit';
import {
  runPrimeGateAudit,
  renderPrimeGateAuditReport,
} from '../src/token-grab/primeGateAudit';

// ── Time anchor ───────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const FIVE_MIN_AGO = new Date(NOW_MS - 5 * 60_000).toISOString();
const TWO_HR_AGO   = new Date(NOW_MS - 120 * 60_000).toISOString();

// ── Fixture factories ─────────────────────────────────────────────────────────

function makeApprovedFixture(overrides: Partial<{
  id: string;
  symbol: string;
  source: string;
  score: number;
  ageBucket: string;
  ageMinutes: number;
  capturedAt: string;
  topReasons: string[];
  blockers: string[];
  vlr: number | undefined;
  liquidityChangePct: number | undefined;
  liquidityUsd: number;
  priceChangePct: number | undefined;
  observedAt: string;
}> = {}) {
  const observedAt = overrides.observedAt ?? FIVE_MIN_AGO;
  const capturedAt = overrides.capturedAt ?? NOW_ISO;
  const vlr        = overrides.vlr;
  const liqUsd     = overrides.liquidityUsd ?? 25000;
  // Use 'key' in overrides to distinguish "not set" from "set to undefined"
  const price    = 'priceChangePct'    in overrides ? overrides.priceChangePct    : 5;
  const liqChg   = 'liquidityChangePct' in overrides ? overrides.liquidityChangePct : undefined;

  return {
    id: overrides.id ?? `test-approved-${Math.random().toString(36).slice(2)}`,
    capturedAt,
    source: overrides.source ?? 'dex-watch-run',
    sourceKind: 'DEX_NEW_POOL',
    raw: {},
    normalizedSignal: {
      id: 'sig-test',
      source: overrides.source ?? 'dex-watch-run',
      sourceKind: 'DEX_NEW_POOL',
      contract: 'TestContract111222333',
      symbol: overrides.symbol ?? 'FRESH',
      discoveredAt: observedAt,
      observedAt: capturedAt,
      confidence: 'HIGH',
      signalReasons: [],
      warnings: [],
      liquidityUsd: liqUsd,
      priceChangePct: price,
      volumeLiquidityRatio: vlr,
    },
    ripperInput: {
      contract: 'TestContract111222333',
      symbol: overrides.symbol ?? 'FRESH',
      observedAt,
      priceChangePct: price,
      liquidityChangePct: liqChg,
      volumeLiquidityRatio: vlr,
    },
    ripperScore:     overrides.score ?? 95,
    launchAgeBucket: overrides.ageBucket ?? 'PRIME_WINDOW',
    ageMinutes:      overrides.ageMinutes ?? 5,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: overrides.blockers ?? [],
    topReasons: overrides.topReasons ?? ['prime window (5m old)', 'liquidity quality GOOD', 'ripperScore 95'],
    warnings: [],
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
  };
}

function makeRejectedFixture(overrides: Partial<{
  id: string;
  symbol: string;
  score: number;
  ageBucket: string;
  ageMinutes: number;
}> = {}) {
  return {
    id: overrides.id ?? `test-rejected-${Math.random().toString(36).slice(2)}`,
    capturedAt: NOW_ISO,
    source: 'dex-watch-run',
    sourceKind: 'DEX_NEW_POOL',
    raw: {},
    normalizedSignal: {
      id: 'sig-rej',
      source: 'dex-watch-run',
      sourceKind: 'DEX_NEW_POOL',
      contract: 'OldContract999',
      symbol: overrides.symbol ?? 'DEAD',
      discoveredAt: TWO_HR_AGO,
      observedAt: NOW_ISO,
      confidence: 'UNKNOWN',
      signalReasons: [],
      warnings: [],
    },
    ripperInput: {
      contract: 'OldContract999',
      symbol: overrides.symbol ?? 'DEAD',
      observedAt: TWO_HR_AGO,
    },
    ripperScore:     overrides.score ?? 31,
    launchAgeBucket: overrides.ageBucket ?? 'DEAD_WINDOW',
    ageMinutes:      overrides.ageMinutes ?? 120,
    entryDecision:   'IGNORE',
    buyGateDecision: 'BUY_REJECTED',
    blockers: ['dead window (120m)', 'entry decision is IGNORE', 'score 31 below buy threshold 65'],
    topReasons: [],
    warnings: [],
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
  };
}

function writeFixturesJsonl(filePath: string, fixtures: object[]): void {
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n'), 'utf-8');
}

// ── Temp dir ──────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pga-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Missing fixture file ──────────────────────────────────────────────────────

describe('runPrimeGateAudit — missing fixture file', () => {
  it('does not crash when fixture file is missing', () => {
    const result = runPrimeGateAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl') });
    expect(result.inputMissing).toBe(true);
    expect(result.totalFixtures).toBe(0);
    expect(result.approvedCount).toBe(0);
  });

  it('returns safety flags even when file is missing', () => {
    const result = runPrimeGateAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl') });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('strictPreview is null when file is missing', () => {
    const result = runPrimeGateAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl'), strictPreview: true });
    expect(result.strictPreview).toBeNull();
  });
});

// ── Counting approvals ────────────────────────────────────────────────────────

describe('runPrimeGateAudit — approval counting', () => {
  it('counts only BUY_APPROVED_PAPER fixtures', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture({ id: 'a1' }),
      makeApprovedFixture({ id: 'a2' }),
      makeRejectedFixture({ id: 'r1' }),
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.totalFixtures).toBe(3);
    expect(result.approvedCount).toBe(2);
  });

  it('approval rate is 0 when no approvals', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeRejectedFixture(), makeRejectedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvedCount).toBe(0);
    expect(result.approvalRate).toBe(0);
  });

  it('computes approval rate correctly', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture(), makeApprovedFixture(), makeApprovedFixture(),
      makeRejectedFixture(), makeRejectedFixture(), makeRejectedFixture(),
      makeRejectedFixture(),
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvalRate).toBeCloseTo(42.86, 1);
  });

  it('groups approvals by age bucket', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture({ ageBucket: 'PRIME_WINDOW' }),
      makeApprovedFixture({ ageBucket: 'PRIME_WINDOW' }),
      makeApprovedFixture({ ageBucket: 'LATE' }),
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.byAgeBucket['PRIME_WINDOW']).toBe(2);
    expect(result.byAgeBucket['LATE']).toBe(1);
  });

  it('groups approvals by score band', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture({ score: 100 }),
      makeApprovedFixture({ score: 92 }),
      makeApprovedFixture({ score: 83 }),
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.byScoreBand['100']).toBe(1);
    expect(result.byScoreBand['90-99']).toBe(1);
    expect(result.byScoreBand['80-89']).toBe(1);
  });
});

// ── Safety data inference ─────────────────────────────────────────────────────

describe('runPrimeGateAudit — safety data inference', () => {
  it('UNKNOWN holderRisk when no holder concentration data in ripperInput', () => {
    // No mintAuthorityStatus/freezeAuthorityStatus/holderConcentrationStatus
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.holderRisk).toBe('UNKNOWN');
    expect(result.unknownHolderCount).toBe(1);
  });

  it('UNKNOWN clusterRisk in V1 (BubbleMaps not connected)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.clusterRisk).toBe('UNKNOWN');
    expect(result.unknownClusterCount).toBe(1);
  });

  it('UNKNOWN botRisk when all market data is absent', () => {
    // scoreBotRisk returns UNKNOWN only when vlr AND liq AND price are all undefined
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({
      vlr: undefined, liquidityChangePct: undefined, priceChangePct: undefined,
    })]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.botRisk).toBe('UNKNOWN');
    expect(result.unknownBotRiskCount).toBe(1);
  });

  it('CLEAN botRisk when VLR is low (≤ 2)', () => {
    // scoreBotRisk: vlr ≤ 2 → CLEAN (vlr > 5 → RISKY, vlr > 2 → WATCH)
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({ vlr: 1.5 })]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.botRisk).toBe('CLEAN');
  });

  it('WATCH botRisk when VLR is between 2 and 5', () => {
    // scoreBotRisk: vlr > 2 → WATCH; vlr > 5 → RISKY
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({ vlr: 3.0, priceChangePct: 10 })]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.botRisk).toBe('WATCH');
  });

  it('GOOD liquidityQuality when VLR is ≤ 2', () => {
    // scoreLiquidityProfile: vlr > 2 → THIN, vlr ≤ 2 with normal liq → GOOD
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({ vlr: 1.5, liquidityChangePct: 5 })]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.liquidityQuality).toBe('GOOD');
    expect(result.unknownLiquidityCount).toBe(0);
  });

  it('UNKNOWN liquidityQuality when both VLR and liquidityChangePct are absent', () => {
    // scoreLiquidityProfile: UNKNOWN only when BOTH vlr AND liq are null
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({
      vlr: undefined, liquidityChangePct: undefined, priceChangePct: undefined,
    })]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.liquidityQuality).toBe('UNKNOWN');
    expect(result.unknownLiquidityCount).toBe(1);
  });

  it('hasSlippage is always false in V1', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].inferredSafety.hasSlippage).toBe(false);
  });

  it('counts UNKNOWN safety fields across multiple approvals', () => {
    // All-absent market data → UNKNOWN botRisk and UNKNOWN liquidityQuality
    const allAbsent = { vlr: undefined, liquidityChangePct: undefined, priceChangePct: undefined };
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture(allAbsent),    // UNKNOWN botRisk + liqQuality
      makeApprovedFixture({ vlr: 1.5, liquidityChangePct: 5 }), // CLEAN botRisk, GOOD liqQuality
      makeApprovedFixture(allAbsent),    // UNKNOWN botRisk + liqQuality
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.unknownBotRiskCount).toBe(2);
    expect(result.unknownLiquidityCount).toBe(2);
    // All 3 have UNKNOWN holder and cluster (no safety enrichment data)
    expect(result.unknownHolderCount).toBe(3);
    expect(result.unknownClusterCount).toBe(3);
  });
});

// ── Soft approvals ────────────────────────────────────────────────────────────

describe('runPrimeGateAudit — soft approvals', () => {
  it('marks approval as soft when holderRisk is UNKNOWN', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals[0].isSoftApproval).toBe(true);
    expect(result.softApprovalCount).toBe(1);
  });

  it('soft approval reasons include UNKNOWN holderRisk explanation', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const reasons = result.approvals[0].softApprovalReasons;
    expect(reasons.some(r => r.includes('holderRisk') && r.includes('UNKNOWN'))).toBe(true);
  });

  it('soft approval reasons include UNKNOWN clusterRisk explanation', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const reasons = result.approvals[0].softApprovalReasons;
    expect(reasons.some(r => r.includes('clusterRisk') && r.includes('UNKNOWN'))).toBe(true);
  });

  it('soft approval reasons mention missing slippage', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const reasons = result.approvals[0].softApprovalReasons;
    expect(reasons.some(r => r.includes('slippage'))).toBe(true);
  });

  it('soft approval list matches approvals where isSoftApproval=true', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture(), makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.softApprovals.length).toBe(result.approvals.filter(a => a.isSoftApproval).length);
  });

  it('marks as fresh-only when topReasons only has prime window', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({
      topReasons: ['prime window (5m old)', 'ripperScore 95'],
      vlr: 2.0, // GOOD liq, CLEAN bot — but only prime+score in reasons
    })]);
    const result = runPrimeGateAudit({ inputPath: f });
    const reasons = result.approvals[0].softApprovalReasons;
    expect(reasons.some(r => r.includes('prime window freshness'))).toBe(true);
  });

  it('rejected fixtures are not included in approvals or softApprovals', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture({ id: 'approved' }),
      makeRejectedFixture({ id: 'rejected' }),
    ]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0].id).toBe('approved');
  });
});

// ── Strict preview ────────────────────────────────────────────────────────────

describe('runPrimeGateAudit — strict preview', () => {
  it('strictPreview is null when strictPreview option is false', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: false });
    expect(result.strictPreview).toBeNull();
  });

  it('strictPreview is computed when strictPreview option is true', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    expect(result.strictPreview).not.toBeNull();
  });

  it('strict preview rejects approval with UNKNOWN holderRisk', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    // No holder data → holderRisk=UNKNOWN → fails strict
    writeFixturesJsonl(f, [makeApprovedFixture({ vlr: 2.0 })]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    expect(result.strictPreview!.wouldApproveCount).toBe(0);
    expect(result.strictPreview!.rejectedByStrictGate).toBe(1);
  });

  it('strict preview rejects approval with UNKNOWN clusterRisk (V1 always UNKNOWN)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const reasons = result.strictPreview!.strictRejectionReasons;
    const hasClusterReason = Object.keys(reasons).some(r => r.includes('clusterRisk') && r.includes('UNKNOWN'));
    expect(hasClusterReason).toBe(true);
  });

  it('strict preview rejects approval with UNKNOWN botRisk', () => {
    // All market data absent → botRisk=UNKNOWN → fails strict (requires CLEAN or WATCH)
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({
      vlr: undefined, liquidityChangePct: undefined, priceChangePct: undefined,
    })]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const reasons = result.strictPreview!.strictRejectionReasons;
    const hasBotReason = Object.keys(reasons).some(r => r.includes('botRisk') && r.includes('UNKNOWN'));
    expect(hasBotReason).toBe(true);
  });

  it('strict preview rejects approval with UNKNOWN liquidityQuality', () => {
    // All market data absent → liquidityQuality=UNKNOWN → fails strict (requires GOOD)
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({
      vlr: undefined, liquidityChangePct: undefined, priceChangePct: undefined,
    })]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const reasons = result.strictPreview!.strictRejectionReasons;
    const hasLiqReason = Object.keys(reasons).some(r => r.includes('liquidityQuality') && r.includes('UNKNOWN'));
    expect(hasLiqReason).toBe(true);
  });

  it('strict preview rejects when slippage is missing (always in V1)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const reasons = result.strictPreview!.strictRejectionReasons;
    const hasSlippageReason = Object.keys(reasons).some(r => r.includes('slippage'));
    expect(hasSlippageReason).toBe(true);
  });

  it('strict preview reduces approval count compared to current gate', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeApprovedFixture({ id: 'a1' }),
      makeApprovedFixture({ id: 'a2' }),
      makeApprovedFixture({ id: 'a3' }),
    ]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    expect(result.strictPreview!.wouldApproveCount).toBeLessThanOrEqual(result.approvedCount);
  });

  it('strict rejection reason counts sum to at least rejectedByStrictGate', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture(), makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const sp = result.strictPreview!;
    const totalCounts = Object.values(sp.strictRejectionReasons).reduce((a, b) => a + b, 0);
    // Each rejected fixture can have multiple reasons, so sum >= rejectedCount
    expect(totalCounts).toBeGreaterThanOrEqual(sp.rejectedByStrictGate);
  });

  it('strict preview does NOT modify existing gate behavior (buyGateDecision unchanged)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    const fixture = makeApprovedFixture({ id: 'a1' });
    writeFixturesJsonl(f, [fixture]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    // The fixture's buyGateDecision should still be BUY_APPROVED_PAPER
    // (strict preview only reports, does not change stored data)
    expect(result.approvals[0].id).toBe('a1');
    // Original file is unchanged
    const raw = fs.readFileSync(f, 'utf-8');
    expect(raw).toContain('BUY_APPROVED_PAPER');
    // approvedCount reflects current gate, not strict gate
    expect(result.approvedCount).toBe(1);
    expect(result.strictPreview!.wouldApproveCount).toBeLessThanOrEqual(1);
  });
});

// ── Gate tightening notes ─────────────────────────────────────────────────────

describe('runPrimeGateAudit — gate tightening notes', () => {
  it('includes note about UNKNOWN holderRisk when present', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.gateTighteningNotes.some(n => n.includes('holderRisk'))).toBe(true);
  });

  it('includes note about BubbleMaps/clusterRisk', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.gateTighteningNotes.some(n => n.includes('clusterRisk') || n.includes('BubbleMaps'))).toBe(true);
  });

  it('includes note about missing slippage', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.gateTighteningNotes.some(n => n.includes('slippage'))).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderPrimeGateAuditReport', () => {
  it('shows missing-file message when inputMissing=true', () => {
    const result = runPrimeGateAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl') });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('No fixture file found');
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows summary section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture(), makeRejectedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('SUMMARY');
    expect(out).toContain('BUY_APPROVED_PAPER');
    expect(out).toContain('Approval rate');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows safety coverage section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('SAFETY DATA COVERAGE');
    expect(out).toContain('UNKNOWN holderRisk');
    expect(out).toContain('UNKNOWN clusterRisk');
  });

  it('shows top candidates section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture({ symbol: 'GOOSE' })]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('TOP APPROVED CANDIDATES');
    expect(out).toContain('GOOSE');
  });

  it('shows soft approvals section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('SOFT APPROVALS');
  });

  it('shows gate tightening section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('GATE TIGHTENING');
  });

  it('shows strict preview section when strictPreview is computed', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('STRICT PREVIEW');
    expect(out).toContain('Would approve');
    expect(out).toContain('Would reject');
    expect(out).toContain('gate unchanged');
  });

  it('does not show strict preview section when strictPreview=false', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f, strictPreview: false });
    const out = renderPrimeGateAuditReport(result);
    expect(out).not.toContain('STRICT PREVIEW');
  });

  it('always shows REAL TRADING LOCKED', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    const out = renderPrimeGateAuditReport(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });
});

// ── Safety — no live trading ──────────────────────────────────────────────────

describe('safety — no live trading', () => {
  it('primeGateAudit.ts exports do not contain signing/swap names', () => {
    const keys    = Object.keys(primeGateModule);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('result safety fields are always set correctly', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const result = runPrimeGateAudit({ inputPath: f });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('does not write any files (read-only)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeApprovedFixture()]);
    const beforeFiles = fs.readdirSync(tmpDir);
    runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const afterFiles = fs.readdirSync(tmpDir);
    expect(afterFiles.sort()).toEqual(beforeFiles.sort());
  });

  it('does not modify the fixture file (read-only)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    const content = JSON.stringify(makeApprovedFixture()) + '\n';
    fs.writeFileSync(f, content);
    runPrimeGateAudit({ inputPath: f, strictPreview: true });
    const after = fs.readFileSync(f, 'utf-8');
    expect(after).toBe(content);
  });
});
