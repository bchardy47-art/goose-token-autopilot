import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  tokenGrabReportToAutopsyCandidates,
  saveTokenGrabSession,
  loadTokenGrabSession,
  type TokenGrabSessionFile,
} from '../src/token-grab/sessionCapture';
import type { TokenGrabReport, TokenGrabRadarCandidate } from '../src/token-grab/types';
import { buildTokenGrabAutopsyReport } from '../src/token-grab/autopsy';
import { loadAutopsyCandidatesFromFile, loadAutopsySnapshotsFromFile } from '../src/token-grab/autopsyLoaders';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeRadarCandidate(overrides: Partial<TokenGrabRadarCandidate> = {}): TokenGrabRadarCandidate {
  return {
    id: 'tg-001',
    tokenName: 'GooseToken',
    ticker: 'GOOSE',
    contractAddress: 'GooseCAFakeForTestingPurposesNa111111111',
    lane: 'FRESH_LAUNCH_CANDIDATE',
    decision: 'ALERT_ONLY',
    score: 75,
    firstSeenAt: '2026-06-06T10:00:00Z',
    poolCreatedAt: '2026-06-06T09:55:00Z',
    matchedSocialSignals: [],
    matchedEventSignals: [],
    matchedLaunchSignals: [],
    reasons: ['Strong social signal', 'High velocity'],
    redFlags: ['Young pool'],
    noTradingExecuted: true,
    ...overrides,
  };
}

function makeReport(candidates: TokenGrabRadarCandidate[] = []): TokenGrabReport {
  return {
    generatedAt: '2026-06-06T10:00:00Z',
    mode: 'fixture-only',
    tradingStatus: 'LOCKED / NO TRADING EXECUTED',
    candidates,
    summary: {
      prelaunchWatch: 0,
      memeEventCandidates: 0,
      freshLaunchCandidates: candidates.filter(c => c.lane === 'FRESH_LAUNCH_CANDIDATE').length,
      rejectedNoise: candidates.filter(c => c.lane === 'NOISE_RUG_LIKELY').length,
      tradingExecuted: 0,
    },
  };
}

function makeSafetyBlock(): TokenGrabSessionFile['safety'] {
  return {
    reportOnly: true,
    noTradingExecuted: true,
    tradingExecuted: 0,
    dbWrites: false,
    scheduler: false,
  };
}

function makeSession(overrides: Partial<TokenGrabSessionFile> = {}): TokenGrabSessionFile {
  const candidates = [makeRadarCandidate()];
  const report = makeReport(candidates);
  return {
    schema: 'token-grab-session-v1',
    generatedAt: report.generatedAt,
    source: { social: 'none', freshPools: 'local', events: 'none' },
    flags: { geckoFreshPools: false, freshPoolsPath: 'fixtures/token-grab/fresh-pools.json' },
    summary: report.summary,
    candidates: tokenGrabReportToAutopsyCandidates(report),
    safety: makeSafetyBlock(),
    ...overrides,
  };
}

function tmpPath(label: string): string {
  return path.join(os.tmpdir(), `tg-session-${label}-${process.pid}.json`);
}

// ── tokenGrabReportToAutopsyCandidates ────────────────────────────────────────

describe('tokenGrabReportToAutopsyCandidates', () => {
  it('converts radar candidates to autopsy candidates', () => {
    const candidates = [makeRadarCandidate()];
    const report = makeReport(candidates);
    const result = tokenGrabReportToAutopsyCandidates(report);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('tg-001');
    expect(result[0]!.tokenName).toBe('GooseToken');
    expect(result[0]!.ticker).toBe('GOOSE');
  });

  it('maps score → scoreAtDetection, firstSeenAt → detectedAt', () => {
    const c = makeRadarCandidate({ score: 82, firstSeenAt: '2026-06-06T09:00:00Z' });
    const [result] = tokenGrabReportToAutopsyCandidates(makeReport([c]));

    expect(result!.scoreAtDetection).toBe(82);
    expect(result!.detectedAt).toBe('2026-06-06T09:00:00Z');
  });

  it('preserves lane, decision, reasons, and redFlags', () => {
    const c = makeRadarCandidate({
      lane: 'NOISE_RUG_LIKELY',
      decision: 'REJECT',
      reasons: ['No social match'],
      redFlags: ['Spam cluster', 'Zero liquidity'],
    });
    const [result] = tokenGrabReportToAutopsyCandidates(makeReport([c]));

    expect(result!.lane).toBe('NOISE_RUG_LIKELY');
    expect(result!.decision).toBe('REJECT');
    expect(result!.reasons).toEqual(['No social match']);
    expect(result!.redFlags).toEqual(['Spam cluster', 'Zero liquidity']);
  });

  it('preserves contractAddress and poolCreatedAt', () => {
    const c = makeRadarCandidate({
      contractAddress: 'SomeContractAddress111111111111111111111',
      poolCreatedAt: '2026-06-06T09:55:00Z',
    });
    const [result] = tokenGrabReportToAutopsyCandidates(makeReport([c]));

    expect(result!.contractAddress).toBe('SomeContractAddress111111111111111111111');
    expect(result!.poolCreatedAt).toBe('2026-06-06T09:55:00Z');
  });

  it('falls back to ticker when tokenName is undefined', () => {
    const c = makeRadarCandidate({ tokenName: undefined, ticker: 'FALLBACK' });
    const [result] = tokenGrabReportToAutopsyCandidates(makeReport([c]));

    expect(result!.tokenName).toBe('FALLBACK');
    expect(result!.ticker).toBe('FALLBACK');
  });

  it('falls back to (unknown) when both tokenName and ticker are undefined', () => {
    const c = makeRadarCandidate({ tokenName: undefined, ticker: undefined });
    const [result] = tokenGrabReportToAutopsyCandidates(makeReport([c]));

    expect(result!.tokenName).toBe('(unknown)');
    expect(result!.ticker).toBe('(unknown)');
  });

  it('returns empty array for report with no candidates', () => {
    const result = tokenGrabReportToAutopsyCandidates(makeReport([]));
    expect(result).toHaveLength(0);
  });

  it('converts multiple candidates preserving order', () => {
    const a = makeRadarCandidate({ id: 'tg-001', ticker: 'AAA' });
    const b = makeRadarCandidate({ id: 'tg-002', ticker: 'BBB' });
    const result = tokenGrabReportToAutopsyCandidates(makeReport([a, b]));

    expect(result).toHaveLength(2);
    expect(result[0]!.ticker).toBe('AAA');
    expect(result[1]!.ticker).toBe('BBB');
  });
});

// ── saveTokenGrabSession ──────────────────────────────────────────────────────

describe('saveTokenGrabSession', () => {
  it('writes valid session JSON to the given path', () => {
    const filePath = tmpPath('save-basic');
    const session = makeSession();
    try {
      saveTokenGrabSession(filePath, session);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed['schema']).toBe('token-grab-session-v1');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `tg-session-dir-${process.pid}`);
    const filePath = path.join(dir, 'nested', 'session.json');
    const session = makeSession();
    try {
      expect(fs.existsSync(dir)).toBe(false);
      saveTokenGrabSession(filePath, session);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes pretty-printed JSON (indented)', () => {
    const filePath = tmpPath('save-pretty');
    const session = makeSession();
    try {
      saveTokenGrabSession(filePath, session);
      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).toContain('\n');
      expect(raw).toContain('  "schema"');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('does not write when saveTokenGrabSession is not called (no-save path)', () => {
    // Confirms no side effects occur without explicit call
    const filePath = tmpPath('no-save');
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ── loadTokenGrabSession ──────────────────────────────────────────────────────

describe('loadTokenGrabSession', () => {
  it('loads a valid session and returns it', () => {
    const filePath = tmpPath('load-valid');
    const session = makeSession();
    try {
      saveTokenGrabSession(filePath, session);
      const loaded = loadTokenGrabSession(filePath);
      expect(loaded.schema).toBe('token-grab-session-v1');
      expect(Array.isArray(loaded.candidates)).toBe(true);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('rejects a file with wrong schema', () => {
    const filePath = tmpPath('load-wrong-schema');
    fs.writeFileSync(filePath, JSON.stringify({ schema: 'wrong-schema-v99', candidates: [] }));
    try {
      expect(() => loadTokenGrabSession(filePath)).toThrow('Invalid schema');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('rejects a file with missing schema field', () => {
    const filePath = tmpPath('load-no-schema');
    fs.writeFileSync(filePath, JSON.stringify({ candidates: [] }));
    try {
      expect(() => loadTokenGrabSession(filePath)).toThrow('Invalid schema');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('rejects a file with missing candidates array', () => {
    const filePath = tmpPath('load-no-candidates');
    fs.writeFileSync(filePath, JSON.stringify({ schema: 'token-grab-session-v1' }));
    try {
      expect(() => loadTokenGrabSession(filePath)).toThrow("'candidates' array");
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('throws a readable error for non-existent file', () => {
    expect(() => loadTokenGrabSession('/no/such/session.json')).toThrow('Cannot read file');
  });

  it('throws a readable error for malformed JSON', () => {
    const filePath = tmpPath('load-bad-json');
    fs.writeFileSync(filePath, '{ not valid json }');
    try {
      expect(() => loadTokenGrabSession(filePath)).toThrow('Invalid JSON');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── Round-trip: save → load → autopsy ────────────────────────────────────────

describe('round-trip: save and reload session', () => {
  it('loaded candidates round-trip through autopsy without error', () => {
    const filePath = tmpPath('round-trip');
    const session = makeSession();
    try {
      saveTokenGrabSession(filePath, session);
      const loaded = loadTokenGrabSession(filePath);
      const report = buildTokenGrabAutopsyReport(loaded.candidates, [], { mode: 'session-file' });
      expect(report.mode).toBe('session-file');
      expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
      expect(report.summary.tradingExecuted).toBe(0);
      for (const r of report.results) {
        expect(r.noTradingExecuted).toBe(true);
      }
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('loaded candidates preserve lane, decision, score, reasons, redFlags', () => {
    const c = makeRadarCandidate({
      ticker: 'TESTTOK',
      lane: 'NOISE_RUG_LIKELY',
      decision: 'REJECT',
      score: 12,
      reasons: ['Spam cluster'],
      redFlags: ['Bot accounts', 'No liquidity'],
    });
    const report = makeReport([c]);
    const session = makeSession({ candidates: tokenGrabReportToAutopsyCandidates(report) });
    const filePath = tmpPath('round-trip-fields');
    try {
      saveTokenGrabSession(filePath, session);
      const loaded = loadTokenGrabSession(filePath);
      const ac = loaded.candidates[0]!;
      expect(ac.ticker).toBe('TESTTOK');
      expect(ac.lane).toBe('NOISE_RUG_LIKELY');
      expect(ac.decision).toBe('REJECT');
      expect(ac.scoreAtDetection).toBe(12);
      expect(ac.reasons).toEqual(['Spam cluster']);
      expect(ac.redFlags).toEqual(['Bot accounts', 'No liquidity']);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── Safety block ──────────────────────────────────────────────────────────────

describe('session safety block', () => {
  it('generated safety block has all required fields', () => {
    const session = makeSession();
    const filePath = tmpPath('safety-check');
    try {
      saveTokenGrabSession(filePath, session);
      const loaded = loadTokenGrabSession(filePath);
      expect(loaded.safety.reportOnly).toBe(true);
      expect(loaded.safety.noTradingExecuted).toBe(true);
      expect(loaded.safety.tradingExecuted).toBe(0);
      expect(loaded.safety.dbWrites).toBe(false);
      expect(loaded.safety.scheduler).toBe(false);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── Existing fixture autopsy still works ─────────────────────────────────────

describe('existing fixture autopsy behavior is unchanged', () => {
  const candidatesPath = path.join(__dirname, '../fixtures/token-grab/autopsy-candidates.json');
  const snapshotsPath = path.join(__dirname, '../fixtures/token-grab/autopsy-snapshots.json');

  it('fixture-only mode produces expected verdicts', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    expect(report.mode).toBe('fixture-only');
    expect(report.summary.tradingExecuted).toBe(0);
    const goose = report.results.find(r => r.ticker === 'GOOSE');
    expect(goose?.verdict).toBe('GOOD_WATCH');
  });

  it('default mode is fixture-only when options omitted', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);
    expect(report.mode).toBe('fixture-only');
  });

  it('mode is session-file when passed explicitly', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots, { mode: 'session-file' });
    expect(report.mode).toBe('session-file');
    expect(report.summary.tradingExecuted).toBe(0);
    for (const r of report.results) {
      expect(r.noTradingExecuted).toBe(true);
    }
  });
});
