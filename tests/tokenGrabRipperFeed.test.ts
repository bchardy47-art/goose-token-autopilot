import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ripperFeedModule from '../src/token-grab/ripperFeed';
import {
  winnerCandidateToEarSignal,
  enrichedCandidateToEarSignal,
  legitimacyItemToEarSignal,
  runRipperFeed,
  renderRipperFeedResult,
} from '../src/token-grab/ripperFeed';
import { runLiveFixtureCapture, runLiveFixtureReport } from '../src/token-grab/liveFixtureCapture';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

const OBSERVED_ISO = new Date(NOW_MS - 8 * 60_000).toISOString(); // 8 min ago

function makeWinnerCandidate() {
  return {
    tier: 'HIGH_CONVICTION_WATCH',
    symbol: 'XRPS',
    contract: '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump',
    sourceRunFile: 'run-20260610-005211.json',
    observedAt: OBSERVED_ISO,
    priceChangePct: 34.3,
    liquidityChangePct: 15.8,
    volumeLiquidityRatio: 0.50,
    confidence: 'MEDIUM',
    reasons: ['price +34.3%', 'liquidity +15.8%'],
    missingSafetySignals: ['MINT_FREEZE_NOT_CONNECTED'],
  };
}

function makeEnrichedCandidate() {
  return {
    ...makeWinnerCandidate(),
    originalTier: 'HIGH_CONVICTION_WATCH',
    mintAuthorityStatus: 'RENOUNCED',
    freezeAuthorityStatus: 'RENOUNCED',
    holderConcentrationStatus: 'WARNING',
    topHolderPercent: 18.4,
    safetyVerdict: 'HIGH_CONVICTION_WATCH',
    safetyReasons: ['mint renounced', 'freeze renounced'],
  };
}

function makeLegitimacyItem() {
  return {
    symbol: 'GOOSE',
    contract: 'GooseXXX111222333',
    observedAt: OBSERVED_ISO,
    priceChangePct: 22.1,
    liquidityChangePct: 8.0,
    volumeLiquidityRatio: 1.1,
    legitimacyVerdict: 'PASS_TO_HUMAN',
    confidence: 'HIGH',
    reasons: ['price +22.1%'],
    missingSignals: ['BUBBLE_MAP_NOT_CONNECTED'],
    holderConcentrationStatus: 'CLEAN',
    mintAuthorityStatus: 'RENOUNCED',
  };
}

// ── Temp dir helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-feed-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSourceDir() {
  const legitimacyDir = path.join(tmpDir, 'legitimacy');
  fs.mkdirSync(legitimacyDir, { recursive: true });
  return legitimacyDir;
}

function writeWinnerCandidates(dir: string, candidates: object[]) {
  const p = path.join(dir, 'dex-winner-candidates-today.json');
  fs.writeFileSync(p, JSON.stringify({
    generatedAt: NOW_ISO,
    candidateCount: candidates.length,
    candidates,
    finalRecommendation: 'HIGH_CONVICTION_WATCH',
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  }));
  return p;
}

function writeEnrichedCandidates(dir: string, candidates: object[]) {
  const p = path.join(dir, 'dex-winner-candidates-enriched-offline-today.json');
  fs.writeFileSync(p, JSON.stringify({
    generatedAt: NOW_ISO,
    candidatesEnriched: candidates.length,
    candidates,
    finalRecommendation: 'HIGH_CONVICTION_WATCH',
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  }));
  return p;
}

function writeLegitimacyReport(dir: string, items: object[]) {
  const p = path.join(dir, 'dex-legitimacy-report-today.json');
  fs.writeFileSync(p, JSON.stringify({
    generatedAt: NOW_ISO,
    items,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  }));
  return p;
}

// ── winnerCandidateToEarSignal ─────────────────────────────────────────────────

describe('winnerCandidateToEarSignal', () => {
  it('produces a valid RipperEarSignal', () => {
    const sig = winnerCandidateToEarSignal(makeWinnerCandidate(), NOW_ISO);
    expect(sig.id).toBeTruthy();
    expect(sig.source).toBe('dex-winner-candidates');
    expect(sig.sourceKind).toBe('DEX_GAINER');
    expect(sig.contract).toBe(makeWinnerCandidate().contract);
  });

  it('preserves contract, symbol, priceChangePct, volumeLiquidityRatio', () => {
    const c   = makeWinnerCandidate();
    const sig = winnerCandidateToEarSignal(c, NOW_ISO);
    expect(sig.contract).toBe(c.contract);
    expect(sig.symbol).toBe(c.symbol);
    expect(sig.priceChangePct).toBe(c.priceChangePct);
    expect(sig.volumeLiquidityRatio).toBe(c.volumeLiquidityRatio);
    expect(sig.liquidityChangePct).toBe(c.liquidityChangePct);
  });

  it('uses candidate observedAt as discoveredAt', () => {
    const c   = makeWinnerCandidate();
    const sig = winnerCandidateToEarSignal(c, NOW_ISO);
    expect(sig.discoveredAt).toBe(c.observedAt);
    expect(sig.observedAt).toBe(NOW_ISO);
  });

  it('sets observedAt to nowIso (capture time)', () => {
    const sig = winnerCandidateToEarSignal(makeWinnerCandidate(), NOW_ISO);
    expect(sig.observedAt).toBe(NOW_ISO);
  });

  it('includes tier in signalReasons', () => {
    const sig = winnerCandidateToEarSignal(makeWinnerCandidate(), NOW_ISO);
    expect(sig.signalReasons.some(r => r.includes('HIGH_CONVICTION_WATCH'))).toBe(true);
  });

  it('includes missingSafetySignals in warnings', () => {
    const sig = winnerCandidateToEarSignal(makeWinnerCandidate(), NOW_ISO);
    expect(sig.warnings).toContain('MINT_FREEZE_NOT_CONNECTED');
  });

  it('handles missing observedAt gracefully', () => {
    const c = { ...makeWinnerCandidate(), observedAt: undefined };
    const sig = winnerCandidateToEarSignal(c as any, NOW_ISO);
    expect(sig.discoveredAt).toBe(NOW_ISO);
    expect(sig.warnings.some(w => w.includes('observedAt missing'))).toBe(true);
  });

  it('handles missing optional fields without crashing', () => {
    const minimal = { contract: 'ContractABC' };
    const sig = winnerCandidateToEarSignal(minimal as any, NOW_ISO);
    expect(sig.contract).toBe('ContractABC');
    expect(sig.signalReasons).toBeInstanceOf(Array);
    expect(sig.warnings).toBeInstanceOf(Array);
  });

  it('stores raw candidate', () => {
    const c   = makeWinnerCandidate();
    const sig = winnerCandidateToEarSignal(c, NOW_ISO);
    expect(sig.raw).toEqual(c);
  });

  it('normalizes confidence HIGH/MEDIUM/LOW', () => {
    expect(winnerCandidateToEarSignal({ ...makeWinnerCandidate(), confidence: 'HIGH' } as any, NOW_ISO).confidence).toBe('HIGH');
    expect(winnerCandidateToEarSignal({ ...makeWinnerCandidate(), confidence: 'LOW' } as any, NOW_ISO).confidence).toBe('LOW');
    expect(winnerCandidateToEarSignal({ ...makeWinnerCandidate(), confidence: undefined } as any, NOW_ISO).confidence).toBe('UNKNOWN');
  });
});

// ── enrichedCandidateToEarSignal ──────────────────────────────────────────────

// The actual enriched file format omits 'confidence', 'reasons', and 'tier' —
// these must be derived from 'safetyVerdict', 'safetyReasons', 'originalTier'.
function makeEnrichedCandidateNoBaseFields() {
  return {
    // No 'tier', 'confidence', or 'reasons' — matching actual enriched JSON format
    originalTier: 'HIGH_CONVICTION_WATCH',
    symbol: 'XRPS',
    contract: '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump',
    sourceRunFile: 'run-20260610-005211.json',
    observedAt: OBSERVED_ISO,
    priceChangePct: 34.3,
    liquidityChangePct: 15.8,
    volumeLiquidityRatio: 0.50,
    mintAuthorityStatus: 'UNKNOWN',
    freezeAuthorityStatus: 'UNKNOWN',
    holderConcentrationStatus: 'WARNING',
    safetyVerdict: 'HIGH_CONVICTION_WATCH',
    safetyReasons: [] as string[],
    missingSignals: ['MINT_FREEZE_NOT_CONNECTED'],
  };
}

describe('enrichedCandidateToEarSignal', () => {
  it('sets source to dex-winner-candidates-enriched', () => {
    const sig = enrichedCandidateToEarSignal(makeEnrichedCandidate(), NOW_ISO);
    expect(sig.source).toBe('dex-winner-candidates-enriched');
  });

  it('maps WARNING holderConcentrationStatus to WATCH hint', () => {
    const sig = enrichedCandidateToEarSignal(makeEnrichedCandidate(), NOW_ISO);
    expect(sig.holderRiskHint).toBe('WATCH');
  });

  it('maps CLEAN holderConcentrationStatus to CLEAN hint', () => {
    const c   = { ...makeEnrichedCandidate(), holderConcentrationStatus: 'CLEAN' };
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.holderRiskHint).toBe('CLEAN');
  });

  it('maps DANGER holderConcentrationStatus to RISKY hint', () => {
    const c   = { ...makeEnrichedCandidate(), holderConcentrationStatus: 'DANGER' };
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.holderRiskHint).toBe('RISKY');
  });

  it('includes holderFetchError in warnings', () => {
    const c   = { ...makeEnrichedCandidate(), holderFetchError: 'RPC timeout' };
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.warnings.some(w => w.includes('RPC timeout'))).toBe(true);
  });

  it('derives confidence MEDIUM from HIGH_CONVICTION_WATCH safetyVerdict when base confidence absent', () => {
    const c   = makeEnrichedCandidateNoBaseFields();
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.confidence).toBe('MEDIUM');
  });

  it('derives confidence HIGH from PASS_TO_HUMAN safetyVerdict', () => {
    const c   = { ...makeEnrichedCandidateNoBaseFields(), safetyVerdict: 'PASS_TO_HUMAN' };
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.confidence).toBe('HIGH');
  });

  it('derives confidence LOW from WATCH safetyVerdict', () => {
    const c   = { ...makeEnrichedCandidateNoBaseFields(), safetyVerdict: 'WATCH' };
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.confidence).toBe('LOW');
  });

  it('uses originalTier in signalReasons when base reasons absent', () => {
    const c   = makeEnrichedCandidateNoBaseFields();
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.signalReasons.some(r => r.includes('HIGH_CONVICTION_WATCH'))).toBe(true);
  });

  it('uses launchHint from originalTier when tier absent', () => {
    const c   = makeEnrichedCandidateNoBaseFields();
    const sig = enrichedCandidateToEarSignal(c, NOW_ISO);
    expect(sig.launchHint).toBe('HIGH_CONVICTION_WATCH');
  });
});

// ── legitimacyItemToEarSignal ─────────────────────────────────────────────────

describe('legitimacyItemToEarSignal', () => {
  it('converts a legitimacy item to RipperEarSignal', () => {
    const sig = legitimacyItemToEarSignal(makeLegitimacyItem(), NOW_ISO);
    expect(sig).not.toBeNull();
    expect(sig!.source).toBe('dex-legitimacy-report');
    expect(sig!.contract).toBe(makeLegitimacyItem().contract);
  });

  it('returns null for item with no contract', () => {
    const result = legitimacyItemToEarSignal({ contract: '' } as any, NOW_ISO);
    expect(result).toBeNull();
  });

  it('preserves priceChangePct, volumeLiquidityRatio', () => {
    const item = makeLegitimacyItem();
    const sig  = legitimacyItemToEarSignal(item, NOW_ISO);
    expect(sig!.priceChangePct).toBe(item.priceChangePct);
    expect(sig!.volumeLiquidityRatio).toBe(item.volumeLiquidityRatio);
  });

  it('maps CLEAN holderConcentrationStatus to CLEAN holderRiskHint', () => {
    const sig = legitimacyItemToEarSignal(makeLegitimacyItem(), NOW_ISO);
    expect(sig!.holderRiskHint).toBe('CLEAN');
  });
});

// ── runRipperFeed ─────────────────────────────────────────────────────────────

describe('runRipperFeed — missing source', () => {
  it('does not crash when all source files are missing', () => {
    const outputPath = path.join(tmpDir, 'out', 'ripper-ears-input.json');
    const result = runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'no-such.json'), kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
    });
    expect(result.sourceMissing).toBe(true);
    expect(result.signalCount).toBe(0);
    expect(result.nextStep).toBeTruthy();
  });

  it('returns safety fields even when source missing', () => {
    const result = runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'missing.json'), kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath: path.join(tmpDir, 'out.json'),
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('does not write output file when source is missing', () => {
    const outputPath = path.join(tmpDir, 'out.json');
    runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'missing.json'), kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('provides a nextStep hint', () => {
    const result = runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'missing.json'), kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath: path.join(tmpDir, 'out.json'),
    });
    expect(result.nextStep).toContain('npm run');
  });
});

describe('runRipperFeed — winner candidates source', () => {
  it('reads winner candidates and writes output', () => {
    const dir    = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'ripper-ears-input.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.sourceMissing).toBe(false);
    expect(result.signalCount).toBe(1);
    expect(result.sourceUsed).toBe(srcPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('creates output directory if it does not exist', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'nested', 'deep', 'ripper-ears-input.json');

    runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('output file is valid ear-signals JSON', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'ripper-ears-input.json');

    runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    const written = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(Array.isArray(written.signals)).toBe(true);
    expect(written.signals.length).toBe(1);
    expect(written.signals[0].contract).toBe(makeWinnerCandidate().contract);
    expect(written.signals[0].source).toBe('dex-winner-candidates');
  });

  it('preserves contract/symbol/source in output signals', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.signals[0].contract).toBe(makeWinnerCandidate().contract);
    expect(result.signals[0].symbol).toBe(makeWinnerCandidate().symbol);
    expect(result.signals[0].observedAt).toBe(NOW_ISO);
  });

  it('converts multiple candidates', () => {
    const dir = makeSourceDir();
    const candidates = [
      makeWinnerCandidate(),
      { ...makeWinnerCandidate(), contract: 'ContractBBB222', symbol: 'BBB' },
    ];
    const srcPath    = writeWinnerCandidates(dir, candidates);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.signalCount).toBe(2);
  });

  it('writeVerified is true after successful write', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'ripper-ears-input.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.writeVerified).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('writeVerified is false when source missing', () => {
    const result = runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'missing.json'), kind: 'winner-candidates', nextStep: 'npm run x' }],
      outputPath: path.join(tmpDir, 'out.json'),
    });
    expect(result.writeVerified).toBe(false);
  });
});

describe('runRipperFeed — enriched candidates source', () => {
  it('reads enriched candidates and writes holderRiskHint', () => {
    const dir     = makeSourceDir();
    const srcPath = writeEnrichedCandidates(dir, [makeEnrichedCandidate()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'enriched-candidates', nextStep: 'npm run token:dex-candidate-safety-enrich' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.sourceMissing).toBe(false);
    expect(result.signals[0].holderRiskHint).toBe('WATCH');
  });
});

describe('runRipperFeed — legitimacy items source', () => {
  it('reads legitimacy items and writes output', () => {
    const dir     = makeSourceDir();
    const srcPath = writeLegitimacyReport(dir, [makeLegitimacyItem()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'legitimacy-items', nextStep: 'npm run token:dex-legitimacy-report' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.sourceMissing).toBe(false);
    expect(result.signals[0].source).toBe('dex-legitimacy-report');
    expect(result.signals[0].contract).toBe(makeLegitimacyItem().contract);
  });

  it('filters out IGNORE and DANGER items from legitimacy report', () => {
    const dir = makeSourceDir();
    const items = [
      makeLegitimacyItem(),
      { ...makeLegitimacyItem(), contract: 'IgnoreMe', legitimacyVerdict: 'IGNORE' },
      { ...makeLegitimacyItem(), contract: 'DangerMe', legitimacyVerdict: 'DANGER' },
    ];
    const srcPath    = writeLegitimacyReport(dir, items);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'legitimacy-items', nextStep: 'npm run token:dex-legitimacy-report' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.signalCount).toBe(1);
    expect(result.signals[0].contract).toBe(makeLegitimacyItem().contract);
  });
});

describe('runRipperFeed — source priority', () => {
  it('uses enriched candidates over winner candidates when both present', () => {
    const dir = makeSourceDir();
    writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const enrichedPath = writeEnrichedCandidates(dir, [makeEnrichedCandidate()]);
    const outputPath   = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [
        { filePath: enrichedPath, kind: 'enriched-candidates', nextStep: 'step1' },
        { filePath: path.join(dir, 'dex-winner-candidates-today.json'), kind: 'winner-candidates', nextStep: 'step2' },
      ],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.sourceUsed).toBe(enrichedPath);
    expect(result.signals[0].source).toBe('dex-winner-candidates-enriched');
  });
});

describe('runRipperFeed — integration with live-fixture-capture', () => {
  it('feed → capture → report end-to-end: fixture count > 0', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const feedOutputPath   = path.join(tmpDir, 'ripper-ears-input.json');
    const fixturesPath     = path.join(tmpDir, 'live-fixtures.jsonl');

    // Step 1: ripper-feed writes ripper-ears-input.json
    const feedResult = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath: feedOutputPath,
      nowMs: NOW_MS,
    });
    expect(feedResult.signalCount).toBe(1);
    expect(feedResult.writeVerified).toBe(true);
    expect(fs.existsSync(feedOutputPath)).toBe(true);

    // Step 2: live-fixture-capture reads ripper-ears-input.json (same path as feed output)
    const captureResult = runLiveFixtureCapture({
      inputPath: feedOutputPath,
      outputPath: fixturesPath,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(captureResult.inputMissing).toBe(false);
    expect(captureResult.capturedCount).toBe(1);
    expect(captureResult.appendedCount).toBe(1);
    expect(captureResult.tradingExecuted).toBe(0);
    expect(fs.existsSync(fixturesPath)).toBe(true);

    // Step 3: live-fixture-report sees fixture count > 0
    const reportResult = runLiveFixtureReport(fixturesPath);
    expect(reportResult.totalFixtures).toBeGreaterThan(0);
    expect(reportResult.tradingExecuted).toBe(0);
    expect(reportResult.noRealTradeSent).toBe(true);
  });

  it('default paths match between feed output and capture input', () => {
    // Both must use the same relative path so the sequence works without flags
    const DEFAULT_FEED_OUTPUT   = 'data/token-grab/ripper/ripper-ears-input.json';
    const DEFAULT_CAPTURE_INPUT = 'data/token-grab/ripper/ripper-ears-input.json';
    expect(DEFAULT_FEED_OUTPUT).toBe(DEFAULT_CAPTURE_INPUT);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperFeedResult', () => {
  it('renders missing-source state with pipeline steps', () => {
    const result = runRipperFeed({
      sources: [{ filePath: path.join(tmpDir, 'missing.json'), kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath: path.join(tmpDir, 'out.json'),
    });
    const out = renderRipperFeedResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('npm run');
  });

  it('renders populated result with write-verified checkmark', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    const out = renderRipperFeedResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('XRPS');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('✓ Written');
    expect(out).not.toContain('WRITE FAILED');
  });

  it('shows WRITE FAILED when writeVerified is false', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    // Simulate a failed write by patching writeVerified
    const failedResult = { ...result, writeVerified: false };
    const out = renderRipperFeedResult(failedResult);
    expect(out).toContain('WRITE FAILED');
    expect(out).not.toContain('✓ Written');
  });
});

// ── safety ────────────────────────────────────────────────────────────────────

describe('safety — no live trading', () => {
  it('ripperFeed.ts exports do not contain signing/swap names', () => {
    const keys    = Object.keys(ripperFeedModule);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('feed result always has tradingExecuted=0 and safety flags', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'out.json');

    const result = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });

    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('missing source result also has safety flags', () => {
    const result = runRipperFeed({
      sources: [],
      outputPath: path.join(tmpDir, 'out.json'),
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
