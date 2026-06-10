import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as holderRiskModule from '../src/token-grab/holderRiskProvider';
import {
  classifyHolderRisk,
  extractHolderRiskFromCandidate,
  maybeHolderRiskFromFixture,
  HOLDER_RISK_THRESHOLDS,
} from '../src/token-grab/holderRiskProvider';
import { runHolderRiskAudit, renderHolderRiskAuditReport } from '../src/token-grab/holderRiskAudit';
import { toHolderClusterProfile } from '../src/token-grab/holderClusterAdapter';

const NOW_ISO = '2026-06-10T10:00:00.000Z';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFixture(rawOverrides: Record<string, unknown> = {}, other: Record<string, unknown> = {}) {
  return {
    id: 'test-fixture-001',
    capturedAt: NOW_ISO,
    source: 'dex-winner-candidates-enriched',
    sourceKind: 'DEX_GAINER',
    raw: rawOverrides,
    normalizedSignal: { symbol: 'TEST', contract: 'TestContract111', discoveredAt: NOW_ISO, observedAt: NOW_ISO, confidence: 'MEDIUM', signalReasons: [], warnings: [] },
    ripperInput: { contract: 'TestContract111', symbol: 'TEST', observedAt: NOW_ISO },
    ripperScore: 75,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes: 8,
    entryDecision: 'READY_TO_SNIPE_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: [],
    topReasons: ['prime window (8m old)'],
    warnings: [],
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
    ...other,
  };
}

function writeFixturesJsonl(filePath: string, fixtures: object[]): void {
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n'), 'utf-8');
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrp-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── classifyHolderRisk ────────────────────────────────────────────────────────

describe('classifyHolderRisk — missing data → UNKNOWN (never CLEAN)', () => {
  it('returns UNKNOWN when no fields provided', () => {
    const r = classifyHolderRisk({}, NOW_ISO);
    expect(r.holderRisk).toBe('UNKNOWN');
    expect(r.confidence).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when status is explicitly UNKNOWN', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'UNKNOWN' }, NOW_ISO);
    expect(r.holderRisk).toBe('UNKNOWN');
  });

  it('includes fetch-error in notes when status=UNKNOWN with error', () => {
    const r = classifyHolderRisk({
      holderConcentrationStatus: 'UNKNOWN',
      holderFetchError: 'RPC error (429): Too many requests',
    }, NOW_ISO);
    expect(r.holderRisk).toBe('UNKNOWN');
    expect(r.concentrationNotes.some(n => n.includes('429') || n.includes('fetch failed'))).toBe(true);
  });

  it('never returns CLEAN when no data at all', () => {
    const r = classifyHolderRisk({}, NOW_ISO);
    expect(r.holderRisk).not.toBe('CLEAN');
  });

  it('never returns CLEAN when only numeric data, no status', () => {
    // topHolderPercent=5 with no explicit status → conservative → UNKNOWN (not CLEAN)
    const r = classifyHolderRisk({ topHolderPercent: 5 }, NOW_ISO);
    expect(r.holderRisk).not.toBe('CLEAN');
  });
});

describe('classifyHolderRisk — CLEAN requires explicit status', () => {
  it('returns CLEAN when status=CLEAN', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN' }, NOW_ISO);
    expect(r.holderRisk).toBe('CLEAN');
  });

  it('CLEAN with topHolderPercent gets HIGH confidence', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN', topHolderPercent: 8 }, NOW_ISO);
    expect(r.holderRisk).toBe('CLEAN');
    expect(r.confidence).toBe('HIGH');
    expect(r.topHolderPercent).toBe(8);
  });

  it('CLEAN without numeric data gets MEDIUM confidence', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN' }, NOW_ISO);
    expect(r.confidence).toBe('MEDIUM');
  });

  it('CLEAN with topHolder below WATCH threshold stays CLEAN', () => {
    const r = classifyHolderRisk({
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent: HOLDER_RISK_THRESHOLDS.WATCH_TOP1_PCT - 1,
    }, NOW_ISO);
    expect(r.holderRisk).toBe('CLEAN');
  });

  it('status=CLEAN overridden by RISKY topHolderPercent (numeric wins)', () => {
    // If status says CLEAN but numbers say RISKY, trust numbers (RISKY is more conservative)
    const r = classifyHolderRisk({
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent: HOLDER_RISK_THRESHOLDS.RISKY_TOP1_PCT + 5,
    }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
  });
});

describe('classifyHolderRisk — WATCH', () => {
  it('returns WATCH when status=WARNING', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'WARNING' }, NOW_ISO);
    expect(r.holderRisk).toBe('WATCH');
  });

  it('returns WATCH when topHolderPercent >= WATCH threshold', () => {
    const r = classifyHolderRisk({ topHolderPercent: HOLDER_RISK_THRESHOLDS.WATCH_TOP1_PCT }, NOW_ISO);
    expect(r.holderRisk).toBe('WATCH');
    expect(r.confidence).toBe('LOW'); // numeric only, no status
  });

  it('returns WATCH when top10 >= WATCH_TOP10_PCT', () => {
    const r = classifyHolderRisk({ top10HolderPercent: HOLDER_RISK_THRESHOLDS.WATCH_TOP10_PCT }, NOW_ISO);
    expect(r.holderRisk).toBe('WATCH');
  });

  it('WATCH with status + numeric gets HIGH confidence', () => {
    const r = classifyHolderRisk({
      holderConcentrationStatus: 'WARNING',
      topHolderPercent: 20,
    }, NOW_ISO);
    expect(r.holderRisk).toBe('WATCH');
    expect(r.confidence).toBe('HIGH');
  });

  it('includes concentration notes for WATCH', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'WARNING' }, NOW_ISO);
    expect(r.concentrationNotes.some(n => n.includes('WARNING'))).toBe(true);
  });
});

describe('classifyHolderRisk — RISKY', () => {
  it('returns RISKY when status=DANGER', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'DANGER' }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
  });

  it('returns RISKY when topHolderPercent >= RISKY threshold (30%)', () => {
    const r = classifyHolderRisk({ topHolderPercent: HOLDER_RISK_THRESHOLDS.RISKY_TOP1_PCT }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
  });

  it('returns RISKY when topHolderPercent is extreme (>50%)', () => {
    const r = classifyHolderRisk({ topHolderPercent: 55 }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
    expect(r.concentrationNotes.some(n => n.includes('55.0%'))).toBe(true);
  });

  it('returns RISKY when top10HolderPercent >= RISKY_TOP10_PCT (70%)', () => {
    const r = classifyHolderRisk({ top10HolderPercent: HOLDER_RISK_THRESHOLDS.RISKY_TOP10_PCT }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
  });

  it('returns RISKY when top10 is extreme (>90%)', () => {
    const r = classifyHolderRisk({ top10HolderPercent: 95 }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
  });

  it('RISKY with status + numeric gets HIGH confidence', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'DANGER', topHolderPercent: 45 }, NOW_ISO);
    expect(r.holderRisk).toBe('RISKY');
    expect(r.confidence).toBe('HIGH');
    expect(r.topHolderPercent).toBe(45);
  });

  it('includes danger notes for RISKY', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'DANGER' }, NOW_ISO);
    expect(r.concentrationNotes.some(n => n.includes('DANGER'))).toBe(true);
  });
});

describe('classifyHolderRisk — output shape', () => {
  it('always returns clusterRisk=UNKNOWN (BubbleMaps not connected)', () => {
    for (const status of ['CLEAN', 'WARNING', 'DANGER', 'UNKNOWN', undefined]) {
      const r = classifyHolderRisk({ holderConcentrationStatus: status }, NOW_ISO);
      expect(r.clusterRisk).toBe('UNKNOWN');
    }
  });

  it('always has concentrationNotes array', () => {
    const r = classifyHolderRisk({}, NOW_ISO);
    expect(Array.isArray(r.concentrationNotes)).toBe(true);
  });

  it('provider defaults to local-enrichment', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN' }, NOW_ISO);
    expect(r.provider).toBe('local-enrichment');
  });

  it('uses custom provider when provided', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN', provider: 'my-provider' }, NOW_ISO);
    expect(r.provider).toBe('my-provider');
  });

  it('uses provided checkedAt', () => {
    const r = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN', checkedAt: NOW_ISO }, NOW_ISO);
    expect(r.checkedAt).toBe(NOW_ISO);
  });
});

// ── Adapter compatibility ─────────────────────────────────────────────────────

describe('holderClusterAdapter compatibility', () => {
  it('toHolderClusterProfile accepts classifyHolderRisk output', () => {
    const result = classifyHolderRisk({ holderConcentrationStatus: 'CLEAN' }, NOW_ISO);
    const profile = toHolderClusterProfile(result);
    expect(profile.holderRisk).toBe('CLEAN');
    expect(profile.clusterRisk).toBe('UNKNOWN');
    expect(Array.isArray(profile.concentrationNotes)).toBe(true);
  });

  it('RISKY result converts to correct profile', () => {
    const result = classifyHolderRisk({ holderConcentrationStatus: 'DANGER' }, NOW_ISO);
    const profile = toHolderClusterProfile(result);
    expect(profile.holderRisk).toBe('RISKY');
  });

  it('UNKNOWN result converts to correct profile', () => {
    const result = classifyHolderRisk({}, NOW_ISO);
    const profile = toHolderClusterProfile(result);
    expect(profile.holderRisk).toBe('UNKNOWN');
  });
});

// ── extractHolderRiskFromCandidate ────────────────────────────────────────────

describe('extractHolderRiskFromCandidate', () => {
  it('returns null when no holder fields present', () => {
    expect(extractHolderRiskFromCandidate({ symbol: 'FOO', contract: 'abc' })).toBeNull();
  });

  it('extracts CLEAN from enriched candidate raw', () => {
    const r = extractHolderRiskFromCandidate({ holderConcentrationStatus: 'CLEAN' });
    expect(r?.holderRisk).toBe('CLEAN');
  });

  it('extracts RISKY from DANGER status', () => {
    const r = extractHolderRiskFromCandidate({ holderConcentrationStatus: 'DANGER', topHolderPercent: 45 });
    expect(r?.holderRisk).toBe('RISKY');
    expect(r?.topHolderPercent).toBe(45);
  });

  it('extracts WATCH from WARNING status', () => {
    const r = extractHolderRiskFromCandidate({ holderConcentrationStatus: 'WARNING' });
    expect(r?.holderRisk).toBe('WATCH');
  });

  it('returns UNKNOWN (not null) when status=UNKNOWN with fetch error', () => {
    const r = extractHolderRiskFromCandidate({
      holderConcentrationStatus: 'UNKNOWN',
      holderFetchError: 'RPC error (429)',
    });
    expect(r).not.toBeNull();
    expect(r?.holderRisk).toBe('UNKNOWN');
    expect(r?.concentrationNotes.some(n => n.includes('429') || n.includes('fetch failed'))).toBe(true);
  });

  it('ignores non-numeric topHolderPercent', () => {
    const r = extractHolderRiskFromCandidate({
      holderConcentrationStatus: 'UNKNOWN',
      topHolderPercent: 'not a number' as unknown as number,
    });
    expect(r?.holderRisk).toBe('UNKNOWN');
  });
});

// ── maybeHolderRiskFromFixture ────────────────────────────────────────────────

describe('maybeHolderRiskFromFixture', () => {
  it('returns null for null/undefined input', () => {
    expect(maybeHolderRiskFromFixture(null)).toBeNull();
    expect(maybeHolderRiskFromFixture(undefined)).toBeNull();
  });

  it('returns null when fixture has no raw field', () => {
    expect(maybeHolderRiskFromFixture({ id: 'x', capturedAt: NOW_ISO })).toBeNull();
  });

  it('returns null when raw has no holder data', () => {
    expect(maybeHolderRiskFromFixture(makeFixture({}))).toBeNull();
  });

  it('extracts holder risk from fixture with raw.holderConcentrationStatus', () => {
    const r = maybeHolderRiskFromFixture(makeFixture({ holderConcentrationStatus: 'CLEAN' }));
    expect(r?.holderRisk).toBe('CLEAN');
  });

  it('extracts RISKY from fixture with DANGER status', () => {
    const r = maybeHolderRiskFromFixture(makeFixture({
      holderConcentrationStatus: 'DANGER', topHolderPercent: 55,
    }));
    expect(r?.holderRisk).toBe('RISKY');
  });

  it('returns UNKNOWN (not null) from fixture with UNKNOWN status and error', () => {
    const r = maybeHolderRiskFromFixture(makeFixture({
      holderConcentrationStatus: 'UNKNOWN',
      holderFetchError: 'RPC 429',
    }));
    expect(r).not.toBeNull();
    expect(r?.holderRisk).toBe('UNKNOWN');
  });

  it('returns null for dex-watch-run fixture (no holder fields)', () => {
    const dexWatchFixture = makeFixture({
      // dex-watch-run raw has no holder fields
      signalId: 'dex-abc123', contract: 'TestContract', symbol: 'FRESH',
      classification: 'winner', priceChangePct: 45,
    });
    expect(maybeHolderRiskFromFixture(dexWatchFixture)).toBeNull();
  });
});

// ── runHolderRiskAudit ────────────────────────────────────────────────────────

describe('runHolderRiskAudit — missing file', () => {
  it('does not crash when fixture file missing', () => {
    const result = runHolderRiskAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl') });
    expect(result.inputMissing).toBe(true);
    expect(result.totalFixtures).toBe(0);
  });

  it('has correct safety flags when file missing', () => {
    const result = runHolderRiskAudit({ inputPath: path.join(tmpDir, 'no-such.jsonl') });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

describe('runHolderRiskAudit — fixture analysis', () => {
  it('counts fixtures with and without holder data', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeFixture({ holderConcentrationStatus: 'CLEAN' }),               // has holder data
      makeFixture({ signalId: 'abc', classification: 'winner' }),         // no holder data
      makeFixture({ holderConcentrationStatus: 'UNKNOWN', holderFetchError: 'rpc err' }), // has holder data
    ]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.withHolderData).toBe(2);
    expect(result.withoutHolderData).toBe(1);
  });

  it('counts holderRisk distribution', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [
      makeFixture({ holderConcentrationStatus: 'CLEAN' }),
      makeFixture({ holderConcentrationStatus: 'DANGER' }),
      makeFixture({ holderConcentrationStatus: 'WARNING' }),
      makeFixture({ signalId: 'no-holder' }),  // UNKNOWN (no data)
    ]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.holderRiskCounts['CLEAN']).toBe(1);
    expect(result.holderRiskCounts['RISKY']).toBe(1);
    expect(result.holderRiskCounts['WATCH']).toBe(1);
    expect(result.holderRiskCounts['UNKNOWN']).toBe(1);
  });

  it('counts approved breakdown by holder risk', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    const approvedClean = makeFixture({ holderConcentrationStatus: 'CLEAN' });
    const approvedUnknown = makeFixture({ signalId: 'no-data' }); // no holder data
    const rejectedRisky = { ...makeFixture({ holderConcentrationStatus: 'DANGER' }), buyGateDecision: 'BUY_REJECTED' };
    writeFixturesJsonl(f, [approvedClean, approvedUnknown, rejectedRisky]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.approvedCount).toBe(2);
    expect(result.approvedCleanHolder).toBe(1);
    expect(result.approvedUnknownHolder).toBe(1);
    expect(result.approvedRiskyHolder).toBe(0);  // rejected, not approved
  });

  it('flags approved RISKY entries in riskyApprovedEntries', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    // Approved with RISKY holder — should be flagged
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'DANGER' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.approvedRiskyHolder).toBe(1);
    expect(result.riskyApprovedEntries).toHaveLength(1);
    expect(result.riskyApprovedEntries[0].holderRisk).toBe('RISKY');
  });

  it('recommendedNextStep mentions reviewing when risky approved found', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'DANGER' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.recommendedNextStep.toLowerCase()).toMatch(/risky|review/);
  });

  it('recommendedNextStep mentions enrichment when all approved are UNKNOWN', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ signalId: 'no-data' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.recommendedNextStep.toLowerCase()).toMatch(/holder|enrich|unknown/);
  });

  it('all safety flags always present', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'CLEAN' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderHolderRiskAuditReport', () => {
  it('shows missing-file guidance when inputMissing=true', () => {
    const result = runHolderRiskAudit({ inputPath: path.join(tmpDir, 'no.jsonl') });
    const out = renderHolderRiskAuditReport(result);
    expect(out).toContain('No fixture file found');
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows fixture coverage section', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'CLEAN' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    const out = renderHolderRiskAuditReport(result);
    expect(out).toContain('FIXTURE COVERAGE');
    expect(out).toContain('HOLDER RISK DISTRIBUTION');
    expect(out).toContain('APPROVED CANDIDATES');
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('flags RISKY candidates prominently', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'DANGER' })]);
    const result = runHolderRiskAudit({ inputPath: f });
    const out = renderHolderRiskAuditReport(result);
    expect(out).toContain('REVIEW');
  });
});

// ── Safety ────────────────────────────────────────────────────────────────────

describe('safety — no live trading', () => {
  it('module exports do not contain signing/swap names', () => {
    const keys = Object.keys(holderRiskModule);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('does not write files (read-only)', () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeFixturesJsonl(f, [makeFixture({ holderConcentrationStatus: 'CLEAN' })]);
    const before = fs.readdirSync(tmpDir);
    runHolderRiskAudit({ inputPath: f });
    expect(fs.readdirSync(tmpDir).sort()).toEqual(before.sort());
  });
});
