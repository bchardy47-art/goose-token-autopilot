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
import { runLiveFixtureCapture } from '../src/token-grab/liveFixtureCapture';

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
  it('output can be consumed by runLiveFixtureCapture', () => {
    const dir     = makeSourceDir();
    const srcPath = writeWinnerCandidates(dir, [makeWinnerCandidate()]);
    const outputPath = path.join(tmpDir, 'ripper-ears-input.json');
    const fixturesPath = path.join(tmpDir, 'live-fixtures.jsonl');

    // Step 1: feed
    const feedResult = runRipperFeed({
      sources: [{ filePath: srcPath, kind: 'winner-candidates', nextStep: 'npm run token:dex-winner-candidates' }],
      outputPath,
      nowMs: NOW_MS,
    });
    expect(feedResult.signalCount).toBe(1);

    // Step 2: capture from the feed output
    const captureResult = runLiveFixtureCapture({
      inputPath: outputPath,
      outputPath: fixturesPath,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(captureResult.inputMissing).toBe(false);
    expect(captureResult.capturedCount).toBe(1);
    expect(captureResult.tradingExecuted).toBe(0);
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

  it('renders populated result', () => {
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
