import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as liveFixtureCaptureModule from '../src/token-grab/liveFixtureCapture';
import {
  buildFixture,
  appendFixtureToJsonl,
  readFixturesFromJsonl,
  resetFixtureFile,
  runLiveFixtureCapture,
  runLiveFixtureReport,
  runLiveFixtureAutopsy,
  renderCaptureResult,
  renderFixtureReport,
  renderAutopsyReport,
  type LiveRipperFixture,
  type CaptureOptions,
} from '../src/token-grab/liveFixtureCapture';
import { DEFAULT_RIPPER_CONFIG } from '../src/token-grab/dexRipperEngine';
import type { RipperEarSignal } from '../src/token-grab/ripperEars';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpJsonl(): string {
  return path.join(tmpDir, 'fixtures.jsonl');
}

function tmpInput(data: object): string {
  const p = path.join(tmpDir, 'input.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

const NOW_MS = 1_700_000_000_000; // fixed epoch for determinism
const NOW_ISO = new Date(NOW_MS).toISOString();

// A prime-window signal (pool created 10 minutes ago)
function primePairSignal(): RipperEarSignal {
  const tenMinAgo = new Date(NOW_MS - 10 * 60_000).toISOString();
  return {
    id: 'test-signal-1',
    source: 'dexscreener',
    sourceKind: 'DEX_NEW_POOL',
    contract: 'So11111111111111111111111111111111111111112',
    poolAddress: 'pool111',
    symbol: 'TEST',
    name: 'Test Token',
    discoveredAt: tenMinAgo,
    observedAt: NOW_ISO,
    confidence: 'MEDIUM',
    signalReasons: ['new-pool'],
    warnings: [],
    liquidityUsd: 20_000,
    volumeUsd: 40_000,
    priceChangePct: 60,
    liquidityChangePct: 15,
    volumeLiquidityRatio: 2.0,
    buys: 120,
    sells: 60,
    txnCount: 180,
  };
}

// A signal with no contract address
function noContractSignal(): RipperEarSignal {
  return {
    id: 'test-signal-no-contract',
    source: 'manual',
    sourceKind: 'MANUAL_WATCH',
    poolAddress: 'pool999',
    discoveredAt: NOW_ISO,
    observedAt: NOW_ISO,
    confidence: 'UNKNOWN',
    signalReasons: [],
    warnings: ['no contract address'],
  };
}

// A DexScreener raw pairs payload
function dexScreenerPayload(pairCreatedAtMsAgo: number): object {
  return {
    pairs: [
      {
        chainId: 'solana',
        dexId: 'raydium',
        pairAddress: 'pairABC',
        url: 'https://dexscreener.com/solana/pairABC',
        baseToken: { address: 'TokenXXX111', name: 'TestX', symbol: 'TESTX' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
        pairCreatedAt: NOW_MS - pairCreatedAtMsAgo,
        priceChange: { m5: 8, h1: 55 },
        volume: { m5: 4000, h1: 50000 },
        liquidity: { usd: 18000 },
        txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 200, sells: 80 } },
      },
    ],
  };
}

// ── buildFixture ──────────────────────────────────────────────────────────────

describe('buildFixture', () => {
  it('produces a fixture with required safety fields', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.realTradingLocked).toBe(true);
    expect(fixture.paperOnly).toBe(true);
    expect(fixture.readOnly).toBe(true);
  });

  it('fills id, capturedAt, source, sourceKind from signal', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.id).toBeTruthy();
    expect(fixture.capturedAt).toBe(NOW_ISO);
    expect(fixture.source).toBe('dexscreener');
    expect(fixture.sourceKind).toBe('DEX_NEW_POOL');
  });

  it('scores a prime-window signal and sets ripperScore', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.ripperScore).toBeTypeOf('number');
    expect(fixture.launchAgeBucket).toBe('PRIME_WINDOW');
    expect(fixture.ageMinutes).toBeGreaterThan(9);
    expect(fixture.ageMinutes).toBeLessThan(11);
  });

  it('sets entryDecision for a prime-window signal', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(['READY_TO_SNIPE_PAPER', 'WATCH', 'IGNORE', 'PAPER_BUY_BLOCKED']).toContain(fixture.entryDecision);
  });

  it('sets buyGateDecision', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(['BUY_APPROVED_PAPER', 'BUY_REJECTED']).toContain(fixture.buyGateDecision);
  });

  it('handles signal with no contract address', () => {
    const signal = noContractSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.ripperInput).toBeNull();
    expect(fixture.blockers.length).toBeGreaterThan(0);
    expect(fixture.buyGateDecision).toBe('BUY_REJECTED');
    expect(fixture.realTradingLocked).toBe(true);
  });

  it('includes signal warnings in fixture warnings', () => {
    const signal = primePairSignal();
    signal.warnings = ['test warning'];
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.warnings).toContain('test warning');
  });

  it('stores the normalizedSignal', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.normalizedSignal).toEqual(signal);
  });

  it('stores the ripperInput if contract present', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(fixture.ripperInput).not.toBeNull();
    expect(fixture.ripperInput!.contract).toBe(signal.contract);
  });
});

// ── JSONL helpers ─────────────────────────────────────────────────────────────

describe('appendFixtureToJsonl / readFixturesFromJsonl', () => {
  it('appends a fixture and reads it back', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const p = tmpJsonl();
    appendFixtureToJsonl(fixture, p);
    const out = readFixturesFromJsonl(p);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(fixture.id);
  });

  it('appends multiple fixtures (append-only)', () => {
    const p = tmpJsonl();
    for (let i = 0; i < 3; i++) {
      const signal = { ...primePairSignal(), id: `signal-${i}` };
      const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
      appendFixtureToJsonl(fixture, p);
    }
    const out = readFixturesFromJsonl(p);
    expect(out).toHaveLength(3);
  });

  it('preserves safety fields through serialization', () => {
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const p = tmpJsonl();
    appendFixtureToJsonl(fixture, p);
    const [recovered] = readFixturesFromJsonl(p);
    expect(recovered.realTradingLocked).toBe(true);
    expect(recovered.paperOnly).toBe(true);
    expect(recovered.readOnly).toBe(true);
  });

  it('returns empty array when file does not exist', () => {
    const out = readFixturesFromJsonl(path.join(tmpDir, 'nonexistent.jsonl'));
    expect(out).toEqual([]);
  });

  it('skips malformed lines without crashing', () => {
    const p = tmpJsonl();
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    fs.writeFileSync(p, 'NOT_JSON\n' + JSON.stringify(fixture) + '\n');
    const out = readFixturesFromJsonl(p);
    expect(out).toHaveLength(1);
  });
});

describe('resetFixtureFile', () => {
  it('clears file content when reset is called', () => {
    const p = tmpJsonl();
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    appendFixtureToJsonl(fixture, p);
    expect(readFixturesFromJsonl(p)).toHaveLength(1);

    resetFixtureFile(p);
    expect(readFixturesFromJsonl(p)).toHaveLength(0);
    expect(fs.readFileSync(p, 'utf-8')).toBe('');
  });

  it('creates file and directory if they do not exist', () => {
    const nested = path.join(tmpDir, 'nested', 'dir', 'fixtures.jsonl');
    resetFixtureFile(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ── runLiveFixtureCapture ─────────────────────────────────────────────────────

describe('runLiveFixtureCapture', () => {
  it('returns inputMissing=true when input file does not exist', () => {
    const result = runLiveFixtureCapture({
      inputPath: path.join(tmpDir, 'no-such-file.json'),
      outputPath: tmpJsonl(),
      format: 'ear-signals',
    });
    expect(result.inputMissing).toBe(true);
    expect(result.capturedCount).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('captures ear-signals from input file', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({
      inputPath: input,
      outputPath: output,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.capturedCount).toBe(1);
    expect(result.appendedCount).toBe(1);
    expect(result.inputMissing).toBe(false);
    expect(readFixturesFromJsonl(output)).toHaveLength(1);
  });

  it('captures dexscreener format', () => {
    const input = tmpInput(dexScreenerPayload(5 * 60_000)); // 5 min ago
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({
      inputPath: input,
      outputPath: output,
      format: 'dexscreener',
      nowMs: NOW_MS,
    });
    expect(result.capturedCount).toBe(1);
    expect(result.appendedCount).toBe(1);
  });

  it('appends on successive calls without reset', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    const opts: CaptureOptions = { inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS };
    runLiveFixtureCapture(opts);
    runLiveFixtureCapture(opts);
    expect(readFixturesFromJsonl(output)).toHaveLength(2);
  });

  it('resets file when reset=true', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    const opts: CaptureOptions = { inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS };
    runLiveFixtureCapture(opts);
    runLiveFixtureCapture({ ...opts, reset: true });
    // After reset run, only the 1 from the second call remains
    expect(readFixturesFromJsonl(output)).toHaveLength(1);
  });

  it('all safety fields set on result', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const result = runLiveFixtureCapture({
      inputPath: input,
      outputPath: tmpJsonl(),
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('handles signal with no contract as skipped but still writes', () => {
    const input = tmpInput({ signals: [noContractSignal()] });
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({
      inputPath: input,
      outputPath: output,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.appendedCount).toBe(1);
    const fixtures = readFixturesFromJsonl(output);
    expect(fixtures[0].buyGateDecision).toBe('BUY_REJECTED');
  });

  it('captures multiple signals', () => {
    const signals = [
      primePairSignal(),
      { ...primePairSignal(), id: 'signal-2', contract: 'ContractYYY', symbol: 'YYY' },
    ];
    const input = tmpInput({ signals });
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({
      inputPath: input,
      outputPath: output,
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.capturedCount).toBe(2);
    expect(readFixturesFromJsonl(output)).toHaveLength(2);
  });
});

// ── runLiveFixtureReport ──────────────────────────────────────────────────────

describe('runLiveFixtureReport', () => {
  it('returns fileMissing=true when file does not exist', () => {
    const result = runLiveFixtureReport(path.join(tmpDir, 'no-such.jsonl'));
    expect(result.fileMissing).toBe(true);
    expect(result.totalFixtures).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });

  it('returns zero counts for empty file', () => {
    const p = tmpJsonl();
    fs.writeFileSync(p, '');
    const result = runLiveFixtureReport(p);
    expect(result.totalFixtures).toBe(0);
    expect(result.sourcesFound).toEqual([]);
    expect(result.newestCaptureAt).toBeNull();
  });

  it('summarizes captured fixtures', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    runLiveFixtureCapture({ inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS });

    const result = runLiveFixtureReport(output);
    expect(result.totalFixtures).toBe(1);
    expect(result.sourcesFound).toContain('dexscreener');
    expect(result.newestCaptureAt).toBeTruthy();
    expect(result.primeWindowCount).toBe(1);
  });

  it('counts ready-to-snipe and buy-approved fixtures', () => {
    const output = tmpJsonl();
    // Write fixtures with known decisions directly
    const signal = primePairSignal();
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const readyFixture: LiveRipperFixture = {
      ...fixture,
      entryDecision: 'READY_TO_SNIPE_PAPER',
      buyGateDecision: 'BUY_APPROVED_PAPER',
    };
    appendFixtureToJsonl(readyFixture, output);

    const result = runLiveFixtureReport(output);
    expect(result.readyToSnipeCount).toBe(1);
    expect(result.paperBuyApprovedCount).toBe(1);
  });

  it('collects top blockers', () => {
    const output = tmpJsonl();
    const signal = primePairSignal();
    const base = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const blocked: LiveRipperFixture = {
      ...base,
      buyGateDecision: 'BUY_REJECTED',
      blockers: ['score below minScoreToBuy'],
    };
    for (let i = 0; i < 3; i++) appendFixtureToJsonl(blocked, output);

    const result = runLiveFixtureReport(output);
    expect(result.topBlockers.some(b => b.includes('score below minScoreToBuy'))).toBe(true);
  });
});

// ── runLiveFixtureAutopsy ─────────────────────────────────────────────────────

describe('runLiveFixtureAutopsy', () => {
  it('returns fileMissing=true when file does not exist', () => {
    const result = runLiveFixtureAutopsy(path.join(tmpDir, 'no-such.jsonl'));
    expect(result.fileMissing).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });

  it('returns zero entries for empty file', () => {
    const p = tmpJsonl();
    fs.writeFileSync(p, '');
    const result = runLiveFixtureAutopsy(p);
    expect(result.autopsiedCount).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it('includes non-approved fixtures in autopsy', () => {
    const output = tmpJsonl();
    const signal = primePairSignal();
    const base = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const blocked: LiveRipperFixture = {
      ...base,
      buyGateDecision: 'BUY_REJECTED',
      entryDecision: 'IGNORE',
      blockers: ['score below minScoreToBuy'],
    };
    appendFixtureToJsonl(blocked, output);

    const result = runLiveFixtureAutopsy(output);
    expect(result.autopsiedCount).toBe(1);
    expect(result.entries[0].autopsyNote).toBeTruthy();
  });

  it('excludes BUY_APPROVED_PAPER fixtures from autopsy', () => {
    const output = tmpJsonl();
    const signal = primePairSignal();
    const base = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const approved: LiveRipperFixture = {
      ...base,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      entryDecision: 'READY_TO_SNIPE_PAPER',
      blockers: [],
    };
    appendFixtureToJsonl(approved, output);

    const result = runLiveFixtureAutopsy(output);
    expect(result.autopsiedCount).toBe(0);
  });

  it('provides a meaningful autopsyNote for DEAD_WINDOW', () => {
    const output = tmpJsonl();
    const signal = primePairSignal();
    const base = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const dead: LiveRipperFixture = {
      ...base,
      buyGateDecision: 'BUY_REJECTED',
      entryDecision: 'IGNORE',
      launchAgeBucket: 'DEAD_WINDOW',
      blockers: [],
    };
    appendFixtureToJsonl(dead, output);

    const result = runLiveFixtureAutopsy(output);
    expect(result.entries[0].autopsyNote).toContain('dead window');
  });
});

// ── renderers ─────────────────────────────────────────────────────────────────

describe('renderCaptureResult', () => {
  it('renders inputMissing state without crashing', () => {
    const result = runLiveFixtureCapture({
      inputPath: path.join(tmpDir, 'no-such.json'),
      outputPath: tmpJsonl(),
      format: 'ear-signals',
    });
    const out = renderCaptureResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders capture summary', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({ inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS });
    const out = renderCaptureResult(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('1 signals');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows per-fixture debug info with debug=true', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    const result = runLiveFixtureCapture({ inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS });
    const out = renderCaptureResult(result, true);
    expect(out).toContain('DEBUG');
  });
});

describe('renderFixtureReport', () => {
  it('renders empty report without crashing', () => {
    const result = runLiveFixtureReport(path.join(tmpDir, 'no-such.jsonl'));
    const out = renderFixtureReport(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders populated report', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    runLiveFixtureCapture({ inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS });
    const result = runLiveFixtureReport(output);
    const out = renderFixtureReport(result);
    expect(out).toContain('Total fixtures');
    expect(out).toContain('dexscreener');
  });
});

describe('renderAutopsyReport', () => {
  it('renders empty autopsy without crashing', () => {
    const result = runLiveFixtureAutopsy(path.join(tmpDir, 'no-such.jsonl'));
    const out = renderAutopsyReport(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('renders populated autopsy', () => {
    const output = tmpJsonl();
    const signal = primePairSignal();
    const base = buildFixture(signal, DEFAULT_RIPPER_CONFIG, NOW_MS);
    const blocked: LiveRipperFixture = { ...base, buyGateDecision: 'BUY_REJECTED', entryDecision: 'IGNORE', blockers: ['test blocker'] };
    appendFixtureToJsonl(blocked, output);
    const result = runLiveFixtureAutopsy(output);
    const out = renderAutopsyReport(result);
    expect(out).toContain('Autopsied');
  });
});

// ── Safety ─────────────────────────────────────────────────────────────────────

describe('safety — no live trading', () => {
  it('liveFixtureCapture.ts exports do not contain transaction/swap signing names', () => {
    const keys = Object.keys(liveFixtureCaptureModule);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) {
      expect(forbidden.test(key)).toBe(false);
    }
  });

  it('every captured fixture has tradingExecuted=0 and realTradingLocked=true', () => {
    const input = tmpInput({ signals: [primePairSignal()] });
    const output = tmpJsonl();
    runLiveFixtureCapture({ inputPath: input, outputPath: output, format: 'ear-signals', nowMs: NOW_MS });
    const fixtures = readFixturesFromJsonl(output);
    for (const f of fixtures) {
      expect(f.realTradingLocked).toBe(true);
      expect(f.paperOnly).toBe(true);
      expect(f.readOnly).toBe(true);
    }
  });

  it('capture result always has tradingExecuted=0', () => {
    const result = runLiveFixtureCapture({
      inputPath: path.join(tmpDir, 'missing.json'),
      outputPath: tmpJsonl(),
      format: 'ear-signals',
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('report result always has tradingExecuted=0', () => {
    const result = runLiveFixtureReport(path.join(tmpDir, 'missing.jsonl'));
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });

  it('autopsy result always has tradingExecuted=0', () => {
    const result = runLiveFixtureAutopsy(path.join(tmpDir, 'missing.jsonl'));
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });
});
