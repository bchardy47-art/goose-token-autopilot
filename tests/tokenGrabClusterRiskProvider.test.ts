import { describe, it, expect, vi } from 'vitest';
import {
  classifyClusterRisk,
  extractClusterRiskFromCandidate,
  maybeClusterRiskFromFixture,
  offlineClusterRiskProvider,
  createBubbleMapsClusterProvider,
  createClusterRiskProvider,
  CLUSTER_RISK_THRESHOLDS,
  type ClusterMetrics,
} from '../src/token-grab/clusterRiskProvider';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFixture(rawOverrides: Record<string, unknown> = {}): LiveRipperFixture {
  return {
    id: 'test-id',
    capturedAt: '2026-06-10T10:00:00.000Z',
    source: 'TEST',
    sourceKind: 'DEX',
    raw: rawOverrides,
    normalizedSignal: null,
    ripperInput: null,
    ripperScore: 80,
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
  } as LiveRipperFixture;
}

// ── classifyClusterRisk ───────────────────────────────────────────────────────

describe('classifyClusterRisk', () => {
  it('returns UNKNOWN for null metrics', () => {
    expect(classifyClusterRisk(null)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined metrics', () => {
    expect(classifyClusterRisk(undefined)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for empty metrics object', () => {
    expect(classifyClusterRisk({})).toBe('UNKNOWN');
  });

  it('isRug=true always returns RISKY', () => {
    expect(classifyClusterRisk({ isRug: true })).toBe('RISKY');
    expect(classifyClusterRisk({ isRug: true, riskScore: 5 })).toBe('RISKY');
  });

  it('isRug=false does not force RISKY', () => {
    expect(classifyClusterRisk({ isRug: false, topClusterPct: 10 })).toBe('CLEAN');
  });

  it('riskScore ≥ RISKY threshold returns RISKY', () => {
    expect(classifyClusterRisk({ riskScore: CLUSTER_RISK_THRESHOLDS.RISKY_RISK_SCORE })).toBe('RISKY');
    expect(classifyClusterRisk({ riskScore: 100 })).toBe('RISKY');
  });

  it('riskScore in WATCH range returns WATCH', () => {
    expect(classifyClusterRisk({ riskScore: CLUSTER_RISK_THRESHOLDS.WATCH_RISK_SCORE })).toBe('WATCH');
    expect(classifyClusterRisk({ riskScore: 50 })).toBe('WATCH');
  });

  it('low riskScore without topClusterPct returns CLEAN', () => {
    expect(classifyClusterRisk({ riskScore: 10 })).toBe('CLEAN');
    expect(classifyClusterRisk({ riskScore: 0 })).toBe('CLEAN');
  });

  it('low riskScore with low topClusterPct returns CLEAN', () => {
    expect(classifyClusterRisk({ riskScore: 10, topClusterPct: 5 })).toBe('CLEAN');
  });

  it('low riskScore but high topClusterPct returns RISKY', () => {
    expect(classifyClusterRisk({
      riskScore: 10,
      topClusterPct: CLUSTER_RISK_THRESHOLDS.RISKY_TOP_CLUSTER_PCT,
    })).toBe('RISKY');
  });

  it('topClusterPct ≥ RISKY threshold returns RISKY', () => {
    expect(classifyClusterRisk({ topClusterPct: CLUSTER_RISK_THRESHOLDS.RISKY_TOP_CLUSTER_PCT })).toBe('RISKY');
    expect(classifyClusterRisk({ topClusterPct: 80 })).toBe('RISKY');
  });

  it('topClusterPct in WATCH range returns WATCH', () => {
    expect(classifyClusterRisk({ topClusterPct: CLUSTER_RISK_THRESHOLDS.WATCH_TOP_CLUSTER_PCT })).toBe('WATCH');
    expect(classifyClusterRisk({ topClusterPct: 30 })).toBe('WATCH');
  });

  it('topClusterPct below WATCH threshold returns CLEAN', () => {
    expect(classifyClusterRisk({ topClusterPct: 5 })).toBe('CLEAN');
    expect(classifyClusterRisk({ topClusterPct: 10 })).toBe('CLEAN');
    expect(classifyClusterRisk({ topClusterPct: 0 })).toBe('CLEAN');
  });

  it('high decentralisationScore with no other data returns CLEAN', () => {
    expect(classifyClusterRisk({ decentralisationScore: CLUSTER_RISK_THRESHOLDS.CLEAN_DECENTRALISATION_MIN })).toBe('CLEAN');
    expect(classifyClusterRisk({ decentralisationScore: 90 })).toBe('CLEAN');
  });

  it('low decentralisationScore returns WATCH', () => {
    expect(classifyClusterRisk({ decentralisationScore: 30 })).toBe('WATCH');
  });

  it('never returns CLEAN from missing data alone', () => {
    // No metrics = UNKNOWN, not CLEAN
    expect(classifyClusterRisk({})).toBe('UNKNOWN');
    expect(classifyClusterRisk({ linkedWalletCount: 5 })).toBe('UNKNOWN'); // linkedWalletCount alone isn't enough
  });

  it('thresholds are exposed and correct', () => {
    expect(CLUSTER_RISK_THRESHOLDS.RISKY_TOP_CLUSTER_PCT).toBe(50);
    expect(CLUSTER_RISK_THRESHOLDS.WATCH_TOP_CLUSTER_PCT).toBe(25);
    expect(CLUSTER_RISK_THRESHOLDS.RISKY_RISK_SCORE).toBe(70);
    expect(CLUSTER_RISK_THRESHOLDS.WATCH_RISK_SCORE).toBe(40);
  });
});

// ── extractClusterRiskFromCandidate ───────────────────────────────────────────

describe('extractClusterRiskFromCandidate', () => {
  it('returns null when raw is undefined', () => {
    expect(extractClusterRiskFromCandidate(undefined)).toBeNull();
  });

  it('returns null when raw has no clusterCheckedAt', () => {
    expect(extractClusterRiskFromCandidate({})).toBeNull();
    expect(extractClusterRiskFromCandidate({ clusterRisk: 'CLEAN' })).toBeNull();
  });

  it('returns result when clusterCheckedAt is present', () => {
    const raw: Record<string, unknown> = {
      clusterRisk: 'CLEAN',
      clusterProvider: 'bubblemaps',
      clusterCheckedAt: '2026-06-10T10:00:00Z',
      clusterConfidence: 'HIGH',
      clusterNotes: ['top cluster 5%'],
    };
    const result = extractClusterRiskFromCandidate(raw);
    expect(result).not.toBeNull();
    expect(result!.clusterRisk).toBe('CLEAN');
    expect(result!.clusterProvider).toBe('bubblemaps');
    expect(result!.clusterConfidence).toBe('HIGH');
    expect(result!.clusterNotes).toEqual(['top cluster 5%']);
  });

  it('returns UNKNOWN clusterRisk for invalid value in raw', () => {
    const raw: Record<string, unknown> = {
      clusterCheckedAt: '2026-06-10T10:00:00Z',
      clusterRisk: 'GARBAGE',
    };
    const result = extractClusterRiskFromCandidate(raw);
    expect(result!.clusterRisk).toBe('UNKNOWN');
  });

  it('reads WATCH and RISKY from raw', () => {
    const watchRaw = { clusterRisk: 'WATCH', clusterCheckedAt: '2026-06-10T10:00:00Z', clusterConfidence: 'MEDIUM', clusterProvider: 'test', clusterNotes: [] };
    const riskyRaw = { clusterRisk: 'RISKY', clusterCheckedAt: '2026-06-10T10:00:00Z', clusterConfidence: 'HIGH', clusterProvider: 'test', clusterNotes: [] };
    expect(extractClusterRiskFromCandidate(watchRaw)!.clusterRisk).toBe('WATCH');
    expect(extractClusterRiskFromCandidate(riskyRaw)!.clusterRisk).toBe('RISKY');
  });

  it('reads clusterFetchError from raw', () => {
    const raw = {
      clusterCheckedAt: '2026-06-10T10:00:00Z',
      clusterRisk: 'UNKNOWN',
      clusterProvider: 'bubblemaps',
      clusterConfidence: 'UNKNOWN',
      clusterNotes: [],
      clusterFetchError: 'http 429',
    };
    const result = extractClusterRiskFromCandidate(raw);
    expect(result!.clusterFetchError).toBe('http 429');
  });
});

// ── maybeClusterRiskFromFixture ───────────────────────────────────────────────

describe('maybeClusterRiskFromFixture', () => {
  it('returns null when fixture.raw has no clusterCheckedAt', () => {
    const f = makeFixture({ holderConcentrationStatus: 'CLEAN' });
    expect(maybeClusterRiskFromFixture(f)).toBeNull();
  });

  it('returns CLEAN when raw.clusterRisk=CLEAN and checkedAt present', () => {
    const f = makeFixture({ clusterRisk: 'CLEAN', clusterCheckedAt: '2026-06-10T10:00:00Z', clusterProvider: 'test', clusterConfidence: 'HIGH', clusterNotes: [] });
    expect(maybeClusterRiskFromFixture(f)).toBe('CLEAN');
  });

  it('returns RISKY when raw.clusterRisk=RISKY', () => {
    const f = makeFixture({ clusterRisk: 'RISKY', clusterCheckedAt: '2026-06-10T10:00:00Z', clusterProvider: 'test', clusterConfidence: 'HIGH', clusterNotes: [] });
    expect(maybeClusterRiskFromFixture(f)).toBe('RISKY');
  });

  it('returns null (not UNKNOWN) when cluster data absent — lets caller default to scoreRipper result', () => {
    const f = makeFixture({});
    expect(maybeClusterRiskFromFixture(f)).toBeNull();
  });
});

// ── offlineClusterRiskProvider ────────────────────────────────────────────────

describe('offlineClusterRiskProvider', () => {
  it('has name=offline', () => {
    expect(offlineClusterRiskProvider.name).toBe('offline');
  });

  it('returns clusterRisk=UNKNOWN — never fakes CLEAN', async () => {
    const result = await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });

  it('returns a valid ClusterRiskResult shape', async () => {
    const result = await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(typeof result.clusterProvider).toBe('string');
    expect(typeof result.clusterCheckedAt).toBe('string');
    expect(result.clusterConfidence).toBe('UNKNOWN');
    expect(Array.isArray(result.clusterNotes)).toBe(true);
  });

  it('does not make network calls (offline)', async () => {
    const originalFetch = global.fetch;
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(mockFetch).not.toHaveBeenCalled();

    global.fetch = originalFetch;
  });
});

// ── createBubbleMapsClusterProvider ──────────────────────────────────────────

describe('createBubbleMapsClusterProvider', () => {
  it('has name=bubblemaps', () => {
    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    expect(p.name).toBe('bubblemaps');
  });

  it('returns UNKNOWN on HTTP error', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('429');

    global.fetch = originalFetch;
  });

  it('returns UNKNOWN on network error', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('network error');

    global.fetch = originalFetch;
  });

  it('classifies CLEAN from low riskScore response', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ risk_score: 10, top_cluster_pct: 5 }),
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('CLEAN');

    global.fetch = originalFetch;
  });

  it('classifies RISKY from high riskScore response', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ risk_score: 85 }),
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('RISKY');

    global.fetch = originalFetch;
  });

  it('classifies RISKY from is_rug=true response', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ is_rug: true }),
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('RISKY');

    global.fetch = originalFetch;
  });

  it('returns UNKNOWN when response has no recognisable metrics', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unrecognised_field: 'value' }),
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    const result = await p.fetchClusterRisk('TOKEN_MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');

    global.fetch = originalFetch;
  });

  it('includes Authorization header when apiKey is set', async () => {
    const originalFetch = global.fetch;
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string> ?? {};
      return Promise.resolve({ ok: false, status: 401 });
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1', apiKey: 'my-key' });
    await p.fetchClusterRisk('TOKEN_MINT');
    expect(capturedHeaders['authorization']).toBe('Bearer my-key');

    global.fetch = originalFetch;
  });

  it('queries the token endpoint with contract as path segment', async () => {
    const originalFetch = global.fetch;
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({ ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const p = createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1' });
    await p.fetchClusterRisk('MY_TOKEN_MINT');
    expect(capturedUrl).toContain('MY_TOKEN_MINT');

    global.fetch = originalFetch;
  });
});

// ── createClusterRiskProvider ─────────────────────────────────────────────────

describe('createClusterRiskProvider', () => {
  it('returns offline provider with configNote when no URL provided', () => {
    const { provider, configNote } = createClusterRiskProvider({});
    expect(provider.name).toBe('offline');
    expect(configNote).not.toBeNull();
    expect(configNote).toContain('BUBBLEMAPS_API_URL');
  });

  it('returns bubblemaps provider when apiUrl is provided', () => {
    const { provider, configNote } = createClusterRiskProvider({ apiUrl: 'https://test.api/v1' });
    expect(provider.name).toBe('bubblemaps');
    expect(configNote).toBeNull();
  });

  it('returns offline when env vars not set (no side effects on env)', () => {
    const savedEnv = process.env['BUBBLEMAPS_API_URL'];
    delete process.env['BUBBLEMAPS_API_URL'];
    const { provider } = createClusterRiskProvider();
    expect(provider.name).toBe('offline');
    if (savedEnv !== undefined) process.env['BUBBLEMAPS_API_URL'] = savedEnv;
  });

  it('missing config handled safely — offline provider never crashes', async () => {
    const { provider } = createClusterRiskProvider({});
    const result = await provider.fetchClusterRisk('any-mint');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toBeUndefined();
  });
});
