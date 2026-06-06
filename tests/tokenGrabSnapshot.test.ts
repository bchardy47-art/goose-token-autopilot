import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  fetchCandidateSnapshot,
  fetchSessionSnapshots,
  writeSnapshotFile,
} from '../src/token-grab/snapshot';
import { buildTokenGrabAutopsyReport } from '../src/token-grab/autopsy';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

const DETECTED_AT = '2026-06-06T10:00:00.000Z';
const NOW_ISO     = '2026-06-06T11:00:00.000Z'; // 60 min after detection

function makeCandidate(overrides: Partial<TokenGrabAutopsyCandidate> = {}): TokenGrabAutopsyCandidate {
  return {
    id: 'tg-001',
    tokenName: 'GooseToken',
    ticker: 'GOOSE',
    contractAddress: 'GooseCAFakeAddr111111111111111111111111',
    poolAddress: 'GoosePoolAddr111111111111111111111111111',
    lane: 'FRESH_LAUNCH_CANDIDATE',
    decision: 'ALERT_ONLY',
    scoreAtDetection: 75,
    detectedAt: DETECTED_AT,
    poolCreatedAt: DETECTED_AT,
    reasons: ['Strong signal'],
    redFlags: [],
    ...overrides,
  };
}

function makeFetch(body: unknown, status = 200): typeof fetch {
  return async (_url: unknown, _opts?: unknown) => {
    if (status !== 200) {
      return { ok: false, status, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status, json: async () => body } as unknown as Response;
  };
}

function makeThrowingFetch(message: string): typeof fetch {
  return async () => { throw new Error(message); };
}

function tmpPath(label: string): string {
  return path.join(os.tmpdir(), `tg-snap-${label}-${process.pid}.json`);
}

// ── fetchCandidateSnapshot — pool endpoint ────────────────────────────────────

describe('fetchCandidateSnapshot — pool endpoint (poolAddress preferred)', () => {
  it('uses pool endpoint when poolAddress is set', async () => {
    let calledUrl = '';
    const fetchImpl: typeof fetch = async (url: unknown) => {
      calledUrl = url as string;
      return { ok: true, status: 200, json: async () => ({ data: { attributes: {} } }) } as unknown as Response;
    };
    const candidate = makeCandidate();
    await fetchCandidateSnapshot(candidate, { nowIso: NOW_ISO, fetchImpl });
    expect(calledUrl).toContain('/pools/GoosePoolAddr111111111111111111111111111');
  });

  it('returns snapshot with correct candidateId and source', async () => {
    const poolBody = {
      data: {
        attributes: {
          price_in_usd: '0.000123',
          reserve_in_usd: '45000',
          volume_usd: { h1: '5000' },
          fdv_usd: '120000',
        },
      },
    };
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(poolBody),
    });

    expect(result.skipped).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.candidateId).toBe('tg-001');
    expect(result.snapshot!.source).toBe('geckoterminal');
  });

  it('maps pool attributes to snapshot fields', async () => {
    const poolBody = {
      data: {
        attributes: {
          price_in_usd: '0.000123',
          reserve_in_usd: '45000',
          volume_usd: { h1: '5000' },
          market_cap_usd: '99000',
        },
      },
    };
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(poolBody),
    });

    expect(result.snapshot!.priceUsd).toBeCloseTo(0.000123, 6);
    expect(result.snapshot!.liquidityUsd).toBe(45000);
    expect(result.snapshot!.volumeUsd).toBe(5000);
    expect(result.snapshot!.marketCapUsd).toBe(99000);
  });

  it('computes minutesAfterDetection correctly (60 min gap)', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: {} } }),
    });
    expect(result.snapshot!.minutesAfterDetection).toBe(60);
  });

  it('sets observedAt to nowIso', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: {} } }),
    });
    expect(result.snapshot!.observedAt).toBe(NOW_ISO);
  });
});

// ── fetchCandidateSnapshot — token endpoint fallback ─────────────────────────

describe('fetchCandidateSnapshot — token endpoint fallback (no poolAddress)', () => {
  it('falls back to token endpoint when no poolAddress', async () => {
    let calledUrl = '';
    const fetchImpl: typeof fetch = async (url: unknown) => {
      calledUrl = url as string;
      return { ok: true, status: 200, json: async () => ({ data: { attributes: {} } }) } as unknown as Response;
    };
    const candidate = makeCandidate({ poolAddress: undefined });
    await fetchCandidateSnapshot(candidate, { nowIso: NOW_ISO, fetchImpl });
    expect(calledUrl).toContain('/tokens/GooseCAFakeAddr111111111111111111111111');
  });

  it('maps token attributes to snapshot fields', async () => {
    const tokenBody = {
      data: {
        attributes: {
          price_usd: '0.000555',
          total_reserve_in_usd: '30000',
          volume_usd: { h1: '8000' },
          market_cap_usd: null,
          fdv_usd: '200000',
        },
      },
    };
    const candidate = makeCandidate({ poolAddress: undefined });
    const result = await fetchCandidateSnapshot(candidate, {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(tokenBody),
    });

    expect(result.skipped).toBe(false);
    expect(result.snapshot!.priceUsd).toBeCloseTo(0.000555, 6);
    expect(result.snapshot!.liquidityUsd).toBe(30000);
    expect(result.snapshot!.volumeUsd).toBe(8000);
    expect(result.snapshot!.marketCapUsd).toBe(200000);
  });
});

// ── fetchCandidateSnapshot — skip / error cases ───────────────────────────────

describe('fetchCandidateSnapshot — skip and error handling', () => {
  it('skips if neither poolAddress nor contractAddress', async () => {
    const candidate = makeCandidate({ poolAddress: undefined, contractAddress: undefined });
    const result = await fetchCandidateSnapshot(candidate, { nowIso: NOW_ISO, fetchImpl: makeFetch({}) });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('no poolAddress or contractAddress');
  });

  it('skips on 404 with readable reason', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(null, 404),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('404');
  });

  it('skips on 429 with readable reason', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(null, 429),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('429');
  });

  it('skips on non-200 HTTP status', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch(null, 500),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('500');
  });

  it('skips on fetch throw without crashing', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeThrowingFetch('network timeout'),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('network timeout');
  });

  it('handles empty attributes gracefully — snapshot fields are undefined', async () => {
    const result = await fetchCandidateSnapshot(makeCandidate(), {
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: {} } }),
    });
    expect(result.skipped).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.priceUsd).toBeUndefined();
    expect(result.snapshot!.liquidityUsd).toBeUndefined();
  });
});

// ── fetchSessionSnapshots — batch behavior ────────────────────────────────────

describe('fetchSessionSnapshots', () => {
  it('returns snapshot for each successful candidate', async () => {
    const candidates = [
      makeCandidate({ id: 'tg-001', ticker: 'AAA' }),
      makeCandidate({ id: 'tg-002', ticker: 'BBB' }),
    ];
    const result = await fetchSessionSnapshots({
      candidates,
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: { price_in_usd: '0.001' } } }),
    });

    expect(result.snapshots).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(result.skipReasons).toHaveLength(0);
  });

  it('failed fetch for one candidate does not fail others', async () => {
    const candidates = [
      makeCandidate({ id: 'tg-001', ticker: 'FAILS', poolAddress: undefined, contractAddress: undefined }),
      makeCandidate({ id: 'tg-002', ticker: 'WORKS' }),
    ];
    const result = await fetchSessionSnapshots({
      candidates,
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: { price_in_usd: '0.001' } } }),
    });

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]!.candidateId).toBe('tg-002');
    expect(result.skipped).toBe(1);
    expect(result.skipReasons[0]!.ticker).toBe('FAILS');
  });

  it('respects the limit option', async () => {
    const candidates = [
      makeCandidate({ id: 'tg-001', ticker: 'A' }),
      makeCandidate({ id: 'tg-002', ticker: 'B' }),
      makeCandidate({ id: 'tg-003', ticker: 'C' }),
    ];
    const result = await fetchSessionSnapshots({
      candidates,
      limit: 2,
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({ data: { attributes: {} } }),
    });

    expect(result.snapshots).toHaveLength(2);
  });

  it('skipReasons include candidateId and ticker', async () => {
    const candidate = makeCandidate({
      id: 'tg-fail',
      ticker: 'NOPE',
      poolAddress: undefined,
      contractAddress: undefined,
    });
    const result = await fetchSessionSnapshots({
      candidates: [candidate],
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({}),
    });

    expect(result.skipReasons[0]!.candidateId).toBe('tg-fail');
    expect(result.skipReasons[0]!.ticker).toBe('NOPE');
    expect(result.skipReasons[0]!.reason).toBeTruthy();
  });

  it('empty candidates returns empty result', async () => {
    const result = await fetchSessionSnapshots({
      candidates: [],
      nowIso: NOW_ISO,
      fetchImpl: makeFetch({}),
    });
    expect(result.snapshots).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });
});

// ── writeSnapshotFile ─────────────────────────────────────────────────────────

describe('writeSnapshotFile', () => {
  it('writes JSON array to the given path', () => {
    const filePath = tmpPath('write-basic');
    const snapshots: TokenGrabAutopsySnapshot[] = [
      {
        candidateId: 'tg-001',
        observedAt: NOW_ISO,
        minutesAfterDetection: 60,
        priceUsd: 0.000123,
        source: 'geckoterminal',
      },
    ];
    try {
      writeSnapshotFile(filePath, snapshots);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `tg-snap-dir-${process.pid}`);
    const filePath = path.join(dir, 'nested', 'snapshots.json');
    try {
      expect(fs.existsSync(dir)).toBe(false);
      writeSnapshotFile(filePath, []);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes pretty-printed JSON (indented, with newlines)', () => {
    const filePath = tmpPath('write-pretty');
    const snapshots: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'tg-001', observedAt: NOW_ISO, minutesAfterDetection: 60, source: 'geckoterminal' },
    ];
    try {
      writeSnapshotFile(filePath, snapshots);
      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).toContain('\n');
      expect(raw).toContain('  "candidateId"');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── Round-trip: snapshots → autopsy ──────────────────────────────────────────

describe('round-trip: written snapshots can be consumed by autopsy', () => {
  it('snapshot written to file is loadable and produces autopsy results', () => {
    const filePath = tmpPath('round-trip');
    const candidate = makeCandidate({ id: 'tg-rt', ticker: 'RT' });
    const snapshots: TokenGrabAutopsySnapshot[] = [
      {
        candidateId: 'tg-rt',
        observedAt: NOW_ISO,
        minutesAfterDetection: 60,
        priceUsd: 0.0001,
        liquidityUsd: 50000,
        source: 'geckoterminal',
      },
      {
        candidateId: 'tg-rt',
        observedAt: '2026-06-06T12:00:00.000Z',
        minutesAfterDetection: 120,
        priceUsd: 0.00034,
        liquidityUsd: 140000,
        source: 'geckoterminal',
      },
    ];
    try {
      writeSnapshotFile(filePath, snapshots);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenGrabAutopsySnapshot[];
      const report = buildTokenGrabAutopsyReport([candidate], loaded, { mode: 'session-file' });

      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.outcome).toBe('RAN');
      expect(report.results[0]!.verdict).toBe('GOOD_WATCH');
      expect(report.results[0]!.noTradingExecuted).toBe(true);
      expect(report.summary.tradingExecuted).toBe(0);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('snapshot file produces no-trading report', () => {
    const filePath = tmpPath('round-trip-safety');
    const candidate = makeCandidate({ id: 'tg-safety' });
    const snapshots: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'tg-safety', observedAt: NOW_ISO, minutesAfterDetection: 60, source: 'geckoterminal' },
    ];
    try {
      writeSnapshotFile(filePath, snapshots);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenGrabAutopsySnapshot[];
      const report = buildTokenGrabAutopsyReport([candidate], loaded);
      expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
      expect(report.summary.tradingExecuted).toBe(0);
      for (const r of report.results) {
        expect(r.noTradingExecuted).toBe(true);
      }
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

// ── poolAddress threading ─────────────────────────────────────────────────────

describe('poolAddress available after report→session conversion', () => {
  it('candidate with poolAddress uses pool endpoint over token endpoint', async () => {
    let calledUrl = '';
    const fetchImpl: typeof fetch = async (url: unknown) => {
      calledUrl = url as string;
      return { ok: true, status: 200, json: async () => ({ data: { attributes: {} } }) } as unknown as Response;
    };
    const candidate = makeCandidate({
      contractAddress: 'ContractAddr11111111111111111111111111111',
      poolAddress: 'PoolAddr1111111111111111111111111111111111',
    });
    await fetchCandidateSnapshot(candidate, { nowIso: NOW_ISO, fetchImpl });
    expect(calledUrl).toContain('/pools/PoolAddr1111111111111111111111111111111111');
    expect(calledUrl).not.toContain('/tokens/');
  });
});
