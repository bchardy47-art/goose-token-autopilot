import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runBubbleMapsObservationReport,
  renderBubbleMapsObservationReport,
  type BubbleMapsObservationReportResult,
} from '../src/token-grab/bubbleMapsObservationReport';
import { appendFixtureToJsonl, type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpJsonl(): string {
  return path.join(tmpDir, 'fixtures.jsonl');
}

function makeFixture(overrides: Partial<LiveRipperFixture> = {}, rawOverrides: Record<string, unknown> = {}): LiveRipperFixture {
  return {
    id: overrides.id ?? 'fixture-1',
    capturedAt: overrides.capturedAt ?? '2026-06-12T03:00:00Z',
    source: overrides.source ?? 'dexscreener',
    sourceKind: overrides.sourceKind ?? 'DEX_NEW_POOL',
    raw: {
      contract: rawOverrides['contract'] ?? 'So11111111111111111111111111111111111111112',
      clusterRisk: rawOverrides['clusterRisk'] ?? 'CLEAN',
      clusterProvider: rawOverrides['clusterProvider'] ?? 'bubblemaps',
      clusterCheckedAt: rawOverrides['clusterCheckedAt'] ?? '2026-06-12T03:01:00Z',
      clusterNotes: rawOverrides['clusterNotes'] ?? ['bubbleMapsScore 83.2'],
      ...(rawOverrides['clusterFetchError'] !== undefined ? { clusterFetchError: rawOverrides['clusterFetchError'] } : {}),
    },
    normalizedSignal: {
      id: 'sig-1',
      source: 'dexscreener',
      sourceKind: 'DEX_NEW_POOL',
      contract: 'So11111111111111111111111111111111111111112',
      poolAddress: 'pool-1',
      symbol: 'TEST',
      discoveredAt: '2026-06-12T02:50:00Z',
      observedAt: '2026-06-12T03:00:00Z',
      confidence: 'MEDIUM',
      signalReasons: [],
      warnings: [],
    },
    ripperInput: { contract: 'So11111111111111111111111111111111111111112', symbol: 'TEST' },
    ripperScore: 78,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes: 10,
    entryDecision: 'READY_TO_SNIPE_PAPER',
    buyGateDecision: overrides.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers: [],
    topReasons: [],
    warnings: [],
    realTradingLocked: true,
    paperOnly: true,
    readOnly: true,
  };
}

describe('runBubbleMapsObservationReport', () => {
  it('handles missing file safely', () => {
    const result = runBubbleMapsObservationReport({ inputPath: path.join(tmpDir, 'missing.jsonl') });
    expect(result.inputMissing).toBe(true);
    expect(result.totalFixtures).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('counts providers, risks, fetch errors, and latest checkedAt', () => {
    const p = tmpJsonl();
    appendFixtureToJsonl(makeFixture({ id: 'a' }, {
      clusterProvider: 'bubblemaps',
      clusterRisk: 'CLEAN',
      clusterCheckedAt: '2026-06-12T03:01:00Z',
      clusterNotes: ['bubbleMapsScore 83.2'],
    }), p);
    appendFixtureToJsonl(makeFixture({ id: 'b', buyGateDecision: 'BUY_REJECTED' }, {
      contract: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      clusterProvider: 'offline',
      clusterRisk: 'UNKNOWN',
      clusterCheckedAt: '2026-06-12T03:02:00Z',
      clusterNotes: ['cluster data not available (offline provider)'],
    }), p);
    appendFixtureToJsonl(makeFixture({ id: 'c' }, {
      contract: 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      clusterProvider: 'bubblemaps',
      clusterRisk: 'WATCH',
      clusterCheckedAt: '2026-06-12T03:03:00Z',
      clusterNotes: ['BubbleMaps HTTP 404'],
      clusterFetchError: 'http 404',
    }), p);

    const result = runBubbleMapsObservationReport({ inputPath: p, generatedAt: '2026-06-12T04:00:00Z' });
    expect(result.inputMissing).toBe(false);
    expect(result.totalFixtures).toBe(3);
    expect(result.bubblemapsProviderCount).toBe(2);
    expect(result.offlineProviderCount).toBe(1);
    expect(result.clusterRiskCounts.CLEAN).toBe(1);
    expect(result.clusterRiskCounts.WATCH).toBe(1);
    expect(result.clusterRiskCounts.UNKNOWN).toBe(1);
    expect(result.clusterFetchErrorCount).toBe(1);
    expect(result.latestClusterCheckedAt).toBe('2026-06-12T03:03:00Z');
    expect(result.sampleRecentRows).toHaveLength(3);
    expect(result.sampleRecentRows[0].clusterProvider).toBe('bubblemaps');
    expect(result.sampleRecentRows[0].clusterNotesSummary).toContain('BubbleMaps HTTP 404');
  });

  it('shortens contract and preserves safety flags in sample rows', () => {
    const p = tmpJsonl();
    appendFixtureToJsonl(makeFixture({}, {
      contract: 'So11111111111111111111111111111111111111112',
      clusterProvider: 'bubblemaps',
      clusterRisk: 'CLEAN',
      clusterCheckedAt: '2026-06-12T03:01:00Z',
    }), p);
    const result = runBubbleMapsObservationReport({ inputPath: p });
    expect(result.sampleRecentRows[0].contractShort).toContain('…');
    expect(result.sampleRecentRows[0].realTradingLocked).toBe(true);
    expect(result.sampleRecentRows[0].tradingExecuted).toBe(0);
  });
});

describe('renderBubbleMapsObservationReport', () => {
  function makeResult(overrides: Partial<BubbleMapsObservationReportResult> = {}): BubbleMapsObservationReportResult {
    return {
      inputPath: 'data/token-grab/ripper/live-fixtures.jsonl',
      inputMissing: false,
      generatedAt: '2026-06-12T04:00:00Z',
      totalFixtures: 3,
      bubblemapsProviderCount: 2,
      offlineProviderCount: 1,
      clusterRiskCounts: { CLEAN: 1, WATCH: 1, RISKY: 0, UNKNOWN: 1 },
      clusterFetchErrorCount: 1,
      latestClusterCheckedAt: '2026-06-12T03:03:00Z',
      sampleRecentRows: [
        {
          symbol: 'TEST',
          contractShort: 'So11…1112',
          clusterProvider: 'bubblemaps',
          clusterRisk: 'CLEAN',
          clusterNotesSummary: 'bubbleMapsScore 83.2',
          buyGateDecision: 'BUY_APPROVED_PAPER',
          realTradingLocked: true,
          tradingExecuted: 0,
        },
      ],
      tradingExecuted: 0,
      noRealTradeSent: true,
      paperOnly: true,
      readOnly: true,
      ...overrides,
    };
  }

  it('renders missing-file state safely', () => {
    const out = renderBubbleMapsObservationReport(makeResult({ inputMissing: true }));
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('Run token:live-fixture-capture first');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders summary counts and sample rows', () => {
    const out = renderBubbleMapsObservationReport(makeResult());
    expect(out).toContain('BUBBLEMAPS OBSERVATION REPORT');
    expect(out).toContain('Provider=bubblemaps');
    expect(out).toContain('CLEAN');
    expect(out).toContain('bubbleMapsScore 83.2');
    expect(out).toContain('BUY_APPROVED_PAPER');
  });

  it('includes safety footer confirming no trading', () => {
    const out = renderBubbleMapsObservationReport(makeResult());
    expect(out).toContain('makes no API calls');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('noRealTradeSent=true');
  });
});
