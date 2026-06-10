import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractReadinessFields,
  classifyReadinessLevel,
  runAutonomyReadinessAudit,
  renderAutonomyReadinessAuditReport,
  type ReadinessLevel,
} from '../src/token-grab/autonomyReadinessAudit';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFixture(overrides: Partial<LiveRipperFixture> = {}): LiveRipperFixture {
  return {
    id: 'test-id',
    capturedAt: '2026-06-10T10:00:00.000Z',
    source: 'TEST',
    sourceKind: 'DEX',
    raw: {},
    normalizedSignal: null,
    ripperInput: null,
    ripperScore: 90,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes: 5,
    entryDecision: 'BUY_APPROVED_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: [],
    topReasons: [],
    warnings: [],
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
    ...overrides,
  } as LiveRipperFixture;
}

/** Build a fixture with specific readiness-relevant raw fields pre-set.
 *  Includes a minimal ripperInput (volumeLiquidityRatio=0.5) so that
 *  scoreRipper produces botRisk=CLEAN and liquidityQuality=GOOD.
 */
function makeReadyFixture(opts: {
  holderConcentrationStatus?: string;
  slippageRisk?: string;
  clusterRisk?: string;
  routeFound?: boolean;
  quoteCheckedAt?: string;
  quoteProvider?: string;
  buyGateDecision?: string;
  entryDecision?: string;
  score?: number;
} = {}): LiveRipperFixture {
  return makeFixture({
    ripperScore: opts.score ?? 90,
    buyGateDecision: opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision:   opts.entryDecision   ?? 'BUY_APPROVED_PAPER',
    // Provide minimal ripperInput so scoreRipper returns botRisk=CLEAN and liquidityQuality=GOOD.
    // volumeLiquidityRatio=0.5: not null (→ not UNKNOWN bot), ≤2 (→ not WATCH/RISKY bot), ≤2 (→ GOOD liq).
    ripperInput: { contract: 'TEST_MINT', volumeLiquidityRatio: 0.5 },
    raw: {
      ...(opts.holderConcentrationStatus !== undefined && {
        holderConcentrationStatus: opts.holderConcentrationStatus,
        topHolderPercent: 10,
        holderProvider: 'test',
        holderCheckedAt: '2026-06-10T10:00:00Z',
      }),
      ...(opts.slippageRisk !== undefined && {
        slippageRisk: opts.slippageRisk,
        quoteCheckedAt: opts.quoteCheckedAt ?? '2026-06-10T10:00:00Z',
        quoteProvider: opts.quoteProvider ?? 'jupiter',
        routeFound: opts.routeFound ?? (opts.slippageRisk !== 'RISKY'),
      }),
      ...(opts.clusterRisk !== undefined && { clusterRisk: opts.clusterRisk }),
      ...(opts.quoteCheckedAt !== undefined && !opts.slippageRisk && {
        quoteCheckedAt: opts.quoteCheckedAt,
        quoteProvider: opts.quoteProvider ?? 'jupiter',
      }),
    },
  });
}

function tmpFixtureFile(fixtures: LiveRipperFixture[]): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-test-'));
  const fPath = path.join(dir, 'fixtures.jsonl');
  fs.writeFileSync(fPath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n');
  return fPath;
}

// ── extractReadinessFields ────────────────────────────────────────────────────

describe('extractReadinessFields', () => {
  it('returns UNKNOWN for all fields when raw is empty and ripperInput is null', () => {
    const f = makeFixture({ raw: {}, ripperInput: null });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('UNKNOWN');
    expect(fields.clusterRisk).toBe('UNKNOWN');
    expect(fields.slippageRisk).toBe('UNKNOWN');
    expect(fields.routeFound).toBeNull();
    expect(fields.hasQuoteData).toBe(false);
  });

  it('reads holderRisk from raw.holderConcentrationStatus via holderRiskProvider', () => {
    const f = makeFixture({
      raw: { holderConcentrationStatus: 'DANGER', topHolderPercent: 40, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test' },
    });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('RISKY');
  });

  it('reads holderRisk CLEAN from raw.holderConcentrationStatus', () => {
    const f = makeFixture({
      raw: { holderConcentrationStatus: 'CLEAN', topHolderPercent: 5, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test' },
    });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('CLEAN');
  });

  it('reads holderRisk WATCH from WARNING status', () => {
    const f = makeFixture({
      raw: { holderConcentrationStatus: 'WARNING', topHolderPercent: 20, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test' },
    });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('WATCH');
  });

  it('reads slippageRisk from raw', () => {
    const f = makeFixture({ raw: { slippageRisk: 'CLEAN', quoteCheckedAt: '2026-06-10T10:00:00Z', quoteProvider: 'jupiter' } });
    const fields = extractReadinessFields(f);
    expect(fields.slippageRisk).toBe('CLEAN');
    expect(fields.hasQuoteData).toBe(true);
  });

  it('reads slippageRisk RISKY from raw', () => {
    const f = makeFixture({ raw: { slippageRisk: 'RISKY', quoteCheckedAt: '2026-06-10T10:00:00Z', routeFound: false, quoteProvider: 'jupiter' } });
    const fields = extractReadinessFields(f);
    expect(fields.slippageRisk).toBe('RISKY');
    expect(fields.routeFound).toBe(false);
  });

  it('reads clusterRisk override from raw.clusterRisk', () => {
    const f = makeFixture({ raw: { clusterRisk: 'CLEAN' } });
    const fields = extractReadinessFields(f);
    expect(fields.clusterRisk).toBe('CLEAN');
  });

  it('clusterRisk defaults to UNKNOWN when raw.clusterRisk not set', () => {
    const f = makeFixture({ raw: {} });
    const fields = extractReadinessFields(f);
    expect(fields.clusterRisk).toBe('UNKNOWN');
  });

  it('reads buyGateDecision from fixture', () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    const fields = extractReadinessFields(f);
    expect(fields.buyGateDecision).toBe('BUY_REJECTED');
  });
});

// ── classifyReadinessLevel ────────────────────────────────────────────────────

describe('classifyReadinessLevel', () => {
  function fields(overrides: Partial<ReturnType<typeof extractReadinessFields>>): ReturnType<typeof extractReadinessFields> {
    return {
      holderRisk:       'CLEAN',
      clusterRisk:      'UNKNOWN',
      botRisk:          'CLEAN',
      liquidityQuality: 'GOOD',
      slippageRisk:     'CLEAN',
      routeFound:       true,
      hasQuoteData:     true,
      buyGateDecision:  'BUY_APPROVED_PAPER',
      entryDecision:    'BUY_APPROVED_PAPER',
      ...overrides,
    };
  }

  it('holderRisk RISKY → HARD_REJECT', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({ holderRisk: 'RISKY' }));
    expect(level).toBe('HARD_REJECT');
    expect(levelReasons.some(r => r.includes('holderRisk RISKY'))).toBe(true);
  });

  it('slippageRisk RISKY → HARD_REJECT', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({ slippageRisk: 'RISKY', routeFound: true }));
    expect(level).toBe('HARD_REJECT');
    expect(levelReasons.some(r => r.includes('slippageRisk RISKY') || r.includes('price impact'))).toBe(true);
  });

  it('routeFound false with slippageRisk RISKY → HARD_REJECT with "no buy route" reason', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({ slippageRisk: 'RISKY', routeFound: false }));
    expect(level).toBe('HARD_REJECT');
    expect(levelReasons.some(r => r.includes('no buy route'))).toBe(true);
  });

  it('buyGateDecision BUY_REJECTED → HARD_REJECT', () => {
    const { level } = classifyReadinessLevel(fields({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' }));
    expect(level).toBe('HARD_REJECT');
  });

  it('entryDecision IGNORE → HARD_REJECT', () => {
    const { level } = classifyReadinessLevel(fields({ entryDecision: 'IGNORE', buyGateDecision: 'IGNORE' }));
    expect(level).toBe('HARD_REJECT');
  });

  it('all CLEAN + cluster CLEAN → FUTURE_AUTONOMY_CANDIDATE', () => {
    const { level } = classifyReadinessLevel(fields({ clusterRisk: 'CLEAN' }));
    expect(level).toBe('FUTURE_AUTONOMY_CANDIDATE');
  });

  it('FUTURE_AUTONOMY_CANDIDATE has no level reasons', () => {
    const { levelReasons } = classifyReadinessLevel(fields({ clusterRisk: 'CLEAN' }));
    expect(levelReasons).toHaveLength(0);
  });

  it('all CLEAN + cluster UNKNOWN → AUTONOMY_BLOCKED_CLUSTER_UNKNOWN', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({ clusterRisk: 'UNKNOWN' }));
    expect(level).toBe('AUTONOMY_BLOCKED_CLUSTER_UNKNOWN');
    expect(levelReasons.some(r => r.includes('clusterRisk UNKNOWN'))).toBe(true);
    expect(levelReasons.some(r => r.includes('BubbleMaps') || r.includes('cluster provider'))).toBe(true);
  });

  it('cluster UNKNOWN + holder WATCH → REVIEW_READY_PAPER (not AUTONOMY_BLOCKED)', () => {
    const { level } = classifyReadinessLevel(fields({ holderRisk: 'WATCH' }));
    expect(level).toBe('REVIEW_READY_PAPER');
  });

  it('cluster UNKNOWN + slippage WATCH → REVIEW_READY_PAPER', () => {
    const { level } = classifyReadinessLevel(fields({ slippageRisk: 'WATCH' }));
    expect(level).toBe('REVIEW_READY_PAPER');
  });

  it('cluster UNKNOWN + liq UNKNOWN → REVIEW_READY_PAPER', () => {
    const { level } = classifyReadinessLevel(fields({ liquidityQuality: 'UNKNOWN' }));
    expect(level).toBe('REVIEW_READY_PAPER');
  });

  it('approved + missing slippage → REVIEW_READY_PAPER', () => {
    const { level } = classifyReadinessLevel(fields({ slippageRisk: 'UNKNOWN', hasQuoteData: false, routeFound: null }));
    expect(level).toBe('REVIEW_READY_PAPER');
  });

  it('not approved (SKIP) → PAPER_WATCH', () => {
    const { level } = classifyReadinessLevel(fields({ buyGateDecision: 'SKIP', entryDecision: 'SKIP' }));
    expect(level).toBe('PAPER_WATCH');
  });

  it('not approved (WATCH gate) → PAPER_WATCH', () => {
    const { level } = classifyReadinessLevel(fields({ buyGateDecision: 'WATCH', entryDecision: 'WATCH' }));
    expect(level).toBe('PAPER_WATCH');
  });

  it('REVIEW_READY_PAPER includes level reasons about gaps', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({ holderRisk: 'WATCH', slippageRisk: 'WATCH' }));
    expect(level).toBe('REVIEW_READY_PAPER');
    expect(levelReasons.some(r => r.includes('holderRisk WATCH'))).toBe(true);
    expect(levelReasons.some(r => r.includes('slippageRisk WATCH'))).toBe(true);
  });

  it('HARD_REJECT can have multiple reasons (both holder and slippage RISKY)', () => {
    const { level, levelReasons } = classifyReadinessLevel(fields({
      holderRisk: 'RISKY', slippageRisk: 'RISKY', routeFound: false,
    }));
    expect(level).toBe('HARD_REJECT');
    expect(levelReasons.length).toBeGreaterThanOrEqual(2);
    expect(levelReasons.some(r => r.includes('holderRisk RISKY'))).toBe(true);
  });
});

// ── Integration via extractReadinessFields + classifyReadinessLevel ───────────

describe('end-to-end fixture classification', () => {
  it('holderRisk RISKY from raw → HARD_REJECT', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'DANGER', slippageRisk: 'CLEAN' });
    const fields = extractReadinessFields(f);
    const { level } = classifyReadinessLevel(fields);
    expect(level).toBe('HARD_REJECT');
  });

  it('slippageRisk RISKY from raw → HARD_REJECT', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'RISKY', routeFound: false });
    const fields = extractReadinessFields(f);
    const { level } = classifyReadinessLevel(fields);
    expect(level).toBe('HARD_REJECT');
  });

  it('no route found (routeFound=false, slippageRisk=RISKY) → HARD_REJECT', () => {
    const f = makeFixture({
      raw: { slippageRisk: 'RISKY', routeFound: false, quoteCheckedAt: '2026-06-10T10:00:00Z', quoteProvider: 'jupiter',
             holderConcentrationStatus: 'CLEAN', topHolderPercent: 5, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test' },
    });
    const fields = extractReadinessFields(f);
    expect(fields.routeFound).toBe(false);
    const { level, levelReasons } = classifyReadinessLevel(fields);
    expect(level).toBe('HARD_REJECT');
    expect(levelReasons.some(r => r.includes('no buy route'))).toBe(true);
  });

  it('holder CLEAN + quote CLEAN + cluster UNKNOWN → AUTONOMY_BLOCKED_CLUSTER_UNKNOWN', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true });
    // clusterRisk not set → UNKNOWN from scoreRipper (hardcoded in V1)
    const fields = extractReadinessFields(f);
    expect(fields.clusterRisk).toBe('UNKNOWN');
    const { level } = classifyReadinessLevel(fields);
    expect(level).toBe('AUTONOMY_BLOCKED_CLUSTER_UNKNOWN');
    // Must make clear it is NOT autonomous
    expect(level).not.toBe('FUTURE_AUTONOMY_CANDIDATE');
  });

  it('cluster CLEAN + holder CLEAN + quote CLEAN → FUTURE_AUTONOMY_CANDIDATE', () => {
    const f = makeFixture({
      ripperInput: { contract: 'TEST_MINT', volumeLiquidityRatio: 0.5 },
      raw: {
        clusterRisk: 'CLEAN',
        holderConcentrationStatus: 'CLEAN', topHolderPercent: 5, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test',
        slippageRisk: 'CLEAN', quoteCheckedAt: '2026-06-10T10:00:00Z', quoteProvider: 'jupiter', routeFound: true,
      },
    });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('CLEAN');
    expect(fields.slippageRisk).toBe('CLEAN');
    expect(fields.clusterRisk).toBe('CLEAN');
    expect(fields.botRisk).toBe('CLEAN');
    expect(fields.liquidityQuality).toBe('GOOD');
    const { level } = classifyReadinessLevel(fields);
    expect(level).toBe('FUTURE_AUTONOMY_CANDIDATE');
  });

  it('BUY_APPROVED_PAPER with holder WATCH → REVIEW_READY_PAPER (non-autonomy status)', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'WARNING', slippageRisk: 'CLEAN', routeFound: true });
    const fields = extractReadinessFields(f);
    expect(fields.holderRisk).toBe('WATCH');
    const { level } = classifyReadinessLevel(fields);
    // Per spec: PAPER_WATCH or non-autonomy status. REVIEW_READY_PAPER is non-autonomy.
    expect(['PAPER_WATCH', 'REVIEW_READY_PAPER'].includes(level)).toBe(true);
    expect(level).not.toBe('FUTURE_AUTONOMY_CANDIDATE');
    expect(level).not.toBe('AUTONOMY_BLOCKED_CLUSTER_UNKNOWN');
  });
});

// ── runAutonomyReadinessAudit ─────────────────────────────────────────────────

describe('runAutonomyReadinessAudit', () => {
  it('handles missing file safely', () => {
    const result = runAutonomyReadinessAudit({ inputPath: '/nonexistent/path.jsonl' });
    expect(result.inputMissing).toBe(true);
    expect(result.totalFixtures).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('returns all safety flags locked', () => {
    const result = runAutonomyReadinessAudit({ inputPath: '/nonexistent.jsonl' });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('classifies holderRisk RISKY fixture as HARD_REJECT and counts it', () => {
    const risky = makeReadyFixture({ holderConcentrationStatus: 'DANGER', slippageRisk: 'CLEAN' });
    const clean = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true });
    const fPath = tmpFixtureFile([risky, clean]);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    expect(result.totalFixtures).toBe(2);
    expect(result.levelCounts['HARD_REJECT']).toBeGreaterThanOrEqual(1);
    expect(result.hardRejectHolderRiskyCount).toBeGreaterThanOrEqual(1);
  });

  it('classifies slippageRisk RISKY fixture as HARD_REJECT', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'RISKY', routeFound: false });
    const fPath = tmpFixtureFile([f]);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    expect(result.levelCounts['HARD_REJECT']).toBe(1);
    expect(result.hardRejectSlippageRiskyCount).toBe(1);
  });

  it('classifies CLEAN holder + CLEAN slippage + UNKNOWN cluster as AUTONOMY_BLOCKED_CLUSTER_UNKNOWN', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true });
    const fPath = tmpFixtureFile([f]);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    expect(result.autonomyBlockedClusterUnknownCount).toBe(1);
    expect(result.futureAutonomyCandidateCount).toBe(0);
  });

  it('classifies CLEAN holder + CLEAN slippage + CLEAN cluster as FUTURE_AUTONOMY_CANDIDATE', () => {
    const f = makeFixture({
      ripperInput: { contract: 'TEST_MINT', volumeLiquidityRatio: 0.5 },
      raw: {
        clusterRisk: 'CLEAN',
        holderConcentrationStatus: 'CLEAN', topHolderPercent: 5, holderCheckedAt: '2026-06-10T10:00:00Z', holderProvider: 'test',
        slippageRisk: 'CLEAN', quoteCheckedAt: '2026-06-10T10:00:00Z', quoteProvider: 'jupiter', routeFound: true,
      },
    });
    const fPath = tmpFixtureFile([f]);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    expect(result.futureAutonomyCandidateCount).toBe(1);
    expect(result.autonomyBlockedClusterUnknownCount).toBe(0);
  });

  it('FUTURE_AUTONOMY_CANDIDATE count is 0 for typical V1 fixture set (cluster always UNKNOWN)', () => {
    const fixtures = [
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true }),
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true }),
    ];
    const fPath = tmpFixtureFile(fixtures);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    // In V1, clusterRisk is always UNKNOWN from scoreRipper (no BubbleMaps)
    expect(result.futureAutonomyCandidateCount).toBe(0);
  });

  it('does not mutate fixture file', () => {
    const f = makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true });
    const fPath = tmpFixtureFile([f]);
    const originalStat = fs.statSync(fPath).mtimeMs;

    runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    const afterStat = fs.statSync(fPath).mtimeMs;
    expect(afterStat).toBe(originalStat);
    // Content should be unchanged
    const content = fs.readFileSync(fPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect((parsed.raw as Record<string, unknown>)['clusterRisk']).toBeUndefined();
  });

  it('no live trading/signing/swap execution', () => {
    const result = runAutonomyReadinessAudit({ inputPath: '/nonexistent.jsonl' });
    expect(result.tradingExecuted).toBe(0);
    // The function only reads — no sendTransaction, signTransaction, or swap exists
    expect(result.noRealTradeSent).toBe(true);
  });

  it('level counts sum to total fixtures', () => {
    const fixtures = [
      makeReadyFixture({ holderConcentrationStatus: 'DANGER', slippageRisk: 'CLEAN' }), // HARD_REJECT
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'RISKY', routeFound: false }), // HARD_REJECT
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true }), // AUTONOMY_BLOCKED
      makeFixture({ buyGateDecision: 'SKIP', entryDecision: 'SKIP', raw: {} }), // PAPER_WATCH
    ];
    const fPath = tmpFixtureFile(fixtures);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    const total = Object.values(result.levelCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.totalFixtures);
  });

  it('populates topReviewReadyPaper with sorted candidates', () => {
    const fixtures = [
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true, score: 80 }),
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true, score: 100 }),
    ];
    const fPath = tmpFixtureFile(fixtures);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });

    // Both should be AUTONOMY_BLOCKED_CLUSTER_UNKNOWN — in topReviewReadyPaper display list
    expect(result.topReviewReadyPaper.length).toBeGreaterThanOrEqual(1);
    // Should be sorted descending by score
    const scores = result.topReviewReadyPaper.map(a => a.ripperScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('allAudited contains all fixtures', () => {
    const fixtures = [
      makeReadyFixture({ holderConcentrationStatus: 'CLEAN', slippageRisk: 'CLEAN', routeFound: true }),
      makeReadyFixture({ holderConcentrationStatus: 'DANGER', slippageRisk: 'CLEAN' }),
    ];
    const fPath = tmpFixtureFile(fixtures);
    const result = runAutonomyReadinessAudit({ inputPath: fPath, generatedAt: '2026-06-10T10:00:00Z' });
    expect(result.allAudited.length).toBe(2);
  });
});

// ── renderAutonomyReadinessAuditReport ────────────────────────────────────────

describe('renderAutonomyReadinessAuditReport', () => {
  function makeResult(overrides: Partial<ReturnType<typeof runAutonomyReadinessAudit>> = {}): ReturnType<typeof runAutonomyReadinessAudit> {
    return {
      inputPath: '/test/fixtures.jsonl',
      inputMissing: false,
      generatedAt: '2026-06-10T10:00:00Z',
      totalFixtures: 10,
      approvedCount: 5,
      levelCounts: {
        FUTURE_AUTONOMY_CANDIDATE: 0,
        AUTONOMY_BLOCKED_CLUSTER_UNKNOWN: 3,
        REVIEW_READY_PAPER: 2,
        PAPER_WATCH: 3,
        HARD_REJECT: 2,
      },
      futureAutonomyCandidateCount: 0,
      autonomyBlockedClusterUnknownCount: 3,
      reviewReadyPaperCount: 2,
      paperWatchCount: 3,
      hardRejectCount: 2,
      hardRejectHolderRiskyCount: 2,
      hardRejectSlippageRiskyCount: 0,
      topReviewReadyPaper: [],
      topHardRejects: [],
      allAudited: [],
      tradingExecuted: 0,
      noRealTradeSent: true,
      paperOnly: true,
      readOnly: true,
      ...overrides,
    };
  }

  it('shows missing file message when inputMissing', () => {
    const result = makeResult({ inputMissing: true, totalFixtures: 0, approvedCount: 0 });
    const output = renderAutonomyReadinessAuditReport(result);
    expect(output).toContain('No fixture file found');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('REAL TRADING LOCKED');
  });

  it('shows readiness ladder', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    expect(output).toContain('READINESS LADDER');
    expect(output).toContain('FUTURE_AUTONOMY_CANDIDATE');
    expect(output).toContain('AUTONOMY_BLOCKED_CLUSTER_UNKNOWN');
    expect(output).toContain('REVIEW_READY_PAPER');
    expect(output).toContain('PAPER_WATCH');
    expect(output).toContain('HARD_REJECT');
  });

  it('shows hard reject breakdown', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    expect(output).toContain('HARD REJECT BREAKDOWN');
    expect(output).toContain('holderRisk RISKY');
  });

  it('shows recommended next step for AUTONOMY_BLOCKED', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    expect(output).toContain('BubbleMaps');
    expect(output).toContain('cluster');
  });

  it('always shows autonomy gate reminder', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    expect(output).toContain('AUTONOMY GATE');
    expect(output).toContain('locked');
  });

  it('always shows safety footer', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('noRealTradeSent=true');
    expect(output).toContain('paperOnly=true');
    expect(output).toContain('readOnly=true');
  });

  it('shows 0 FUTURE_AUTONOMY_CANDIDATE in the ladder', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult());
    // Should show the 0 count next to FUTURE_AUTONOMY_CANDIDATE
    expect(output).toContain('FUTURE_AUTONOMY_CANDIDATE');
    expect(output).toContain('0');
  });

  it('makes clear AUTONOMY_BLOCKED is not autonomous', () => {
    const output = renderAutonomyReadinessAuditReport(makeResult({ autonomyBlockedClusterUnknownCount: 5 }));
    // The note column should indicate it's blocked
    expect(output).toContain('blocked');
  });

  it('shows FUTURE_AUTONOMY_CANDIDATE next-step when count > 0', () => {
    const result = makeResult({ futureAutonomyCandidateCount: 2, autonomyBlockedClusterUnknownCount: 0 });
    const output = renderAutonomyReadinessAuditReport(result);
    expect(output).toContain('FUTURE_AUTONOMY_CANDIDATE');
    expect(output).toContain('locked');
  });
});
