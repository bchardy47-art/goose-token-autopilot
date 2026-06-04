import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { createTokenSource, runScan, refreshSnapshotsForTokenAddresses } from '../src/scanner';
import { normalizeGeckoTerminalPool, GeckoTerminalTokenSource } from '../src/scanner/geckoTerminalSource';
import { enrichCandidate } from '../src/enrichment/enrichCandidate';
import * as solanaSafety from '../src/enrichment/solanaSafety';
import { makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

function makePool(mint: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `solana_${String(overrides.address ?? 'Pool111')}`,
    type: 'pool',
    attributes: {
      address: String(overrides.address ?? 'Pool111'),
      name: String(overrides.name ?? 'TEST / SOL'),
      pool_created_at: overrides.pool_created_at ?? new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      reserve_in_usd: overrides.reserve_in_usd ?? '45000',
      fdv_usd: overrides.fdv_usd ?? '500000',
      market_cap_usd: overrides.market_cap_usd ?? null,
      price_change_percentage: overrides.price_change_percentage ?? { m5: '5', h1: '10', h24: '12' },
      transactions: overrides.transactions ?? { m5: { buys: 10, sells: 3 } },
      volume_usd: overrides.volume_usd ?? { m5: '1000', h1: '12000', h24: '50000' },
      base_token_price_usd: overrides.base_token_price_usd ?? '0.1234',
      quote_token_price_usd: overrides.quote_token_price_usd ?? '73.00'
    },
    relationships: {
      base_token: { data: { id: `solana_${mint}`, type: 'token' } },
      quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112', type: 'token' } },
      dex: { data: { id: String(overrides.dexId ?? 'pump-fun'), type: 'dex' } }
    }
  };
}

describe('GeckoTerminal source', () => {
  it('parses base token mint from solana_<mint> and maps core fields', () => {
    const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const candidate = normalizeGeckoTerminalPool(makePool('MintABC11111111111111111111111111111111111', { pool_created_at: createdAt, reserve_in_usd: '12345', base_token_price_usd: '0.42', address: 'PoolXYZ111' }), new Date().toISOString())!;
    expect(candidate.mint).toBe('MintABC11111111111111111111111111111111111');
    expect(candidate.tokenCreatedAt).toBe(createdAt);
    expect((candidate.raw.selectedPair as any).pairCreatedAt).toBe(createdAt);
    expect(candidate.liquidityUsd).toBe(12345);
    expect(candidate.priceUsd).toBe(0.42);
    expect(candidate.source).toBe('geckoterminal');
    expect(candidate.sourceUrl).toBe('https://www.geckoterminal.com/solana/pools/PoolXYZ111');
    expect((candidate.raw.discovery as any).discoveryLane).toBe('geckoterminal-new-pools');
  });

  it('rejects missing mint and missing pool address in fetch pipeline', async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse({
      data: [
        makePool('MintGood111111111111111111111111111111111111'),
        { ...makePool('MintMissingAddress11111111111111111111111111111'), attributes: { ...makePool('x').attributes, address: null } },
        { ...makePool('MintMissingMint1111111111111111111111111111111'), relationships: { ...makePool('x').relationships, base_token: { data: { id: null, type: 'token' } } } }
      ]
    }));
    const source = new GeckoTerminalTokenSource({ fetchImpl, limit: 20, minReserveUsd: 0, maxPoolAgeMinutes: 60, maxDataAgeMinutes: 30 });
    const candidates = await source.fetchCandidates();
    expect(candidates).toHaveLength(1);
    expect(source.getLastFetchSummary()).toMatchObject({ missingMintRejectedCount: 1, missingPoolRejectedCount: 1 });
  });

  it('rejects old pool and low reserve/liquidity', async () => {
    const oldCreated = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const fetchImpl = vi.fn(async () => makeJsonResponse({
      data: [
        makePool('MintOld1111111111111111111111111111111111111', { pool_created_at: oldCreated, reserve_in_usd: '50000' }),
        makePool('MintLow1111111111111111111111111111111111111', { reserve_in_usd: '5000' })
      ]
    }));
    const source = new GeckoTerminalTokenSource({ fetchImpl, limit: 20, minReserveUsd: 20000, maxPoolAgeMinutes: 60, maxDataAgeMinutes: 30 });
    const candidates = await source.fetchCandidates();
    expect(candidates).toHaveLength(0);
    expect(source.getLastFetchSummary()).toMatchObject({ staleRejectedCount: 1, lowLiquidityRejectedCount: 1 });
  });

  it('createTokenSource uses GeckoTerminal adapter when TOKEN_SOURCE=geckoterminal', () => {
    const config = loadConfig({ TOKEN_SOURCE: 'geckoterminal' });
    expect(createTokenSource(config)).toBeInstanceOf(GeckoTerminalTokenSource);
  });

  it('runScan inserts GeckoTerminal candidates and includes source summary', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal' });
    cleanup.push(dir);
    const db = createDb(config);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => makeJsonResponse({ data: [makePool('MintScan111111111111111111111111111111111111')] }));
    const result = await runScan(db, config);
    expect(result.scanned).toBe(1);
    expect(result.source).toBe('geckoterminal');
    expect(result.sourceSummary).toMatchObject({ poolsFetched: 1, candidatesAccepted: 1 });
    expect(db.findTokenByMint('MintScan111111111111111111111111111111111111')).not.toBeNull();
    db.close();
  });

  it('refresh uses GeckoTerminal pool endpoint by pool address and updates dataUpdatedAt', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal' });
    cleanup.push(dir);
    const db = createDb(config);
    const stale = normalizeGeckoTerminalPool(makePool('MintRefresh111111111111111111111111111111111', { address: 'RefreshPool111' }), new Date(Date.now() - 20 * 60 * 1000).toISOString())!;
    stale.dataUpdatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const tokenId = db.upsertToken(stale);
    db.insertSnapshot(tokenId, stale);

    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v2/networks/solana/pools/RefreshPool111')) {
        return makeJsonResponse({ data: makePool('MintRefresh111111111111111111111111111111111', { address: 'RefreshPool111', reserve_in_usd: '55000' }) });
      }
      return makeJsonResponse({ data: [] });
    });

    const refresh = await refreshSnapshotsForTokenAddresses(db, config, [stale.mint]);
    const refreshed = db.getLatestSnapshot(tokenId)!;
    expect(fetchImpl).toHaveBeenCalled();
    expect(refresh.refreshed).toBe(1);
    expect(refresh.geckoRefreshSummary).toMatchObject({ geckoRefreshAttempted: 1, geckoRefreshSucceeded: 1 });
    expect(new Date(refreshed.dataUpdatedAt).getTime()).toBeGreaterThan(new Date(stale.dataUpdatedAt).getTime());
    expect(refreshed.mint).toBe(stale.mint);
    expect(refreshed.source).toBe('geckoterminal');
    expect(refreshed.sourceUrl).toBe(stale.sourceUrl);
    expect(refreshed.liquidityUsd).toBe(55000);
    db.close();
  });

  it('missing pool address is skipped safely during refresh', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal' });
    cleanup.push(dir);
    const db = createDb(config);
    const candidate = normalizeGeckoTerminalPool(makePool('MintNoPool11111111111111111111111111111111111', { address: 'NoPool111' }))!;
    delete (candidate.raw as any).selectedPair;
    const tokenId = db.upsertToken(candidate);
    db.insertSnapshot(tokenId, candidate);

    const refresh = await refreshSnapshotsForTokenAddresses(db, config, [candidate.mint]);
    expect(refresh.refreshed).toBe(0);
    expect(refresh.geckoRefreshSummary).toMatchObject({ geckoRefreshMissingPoolAddress: 1 });
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('stale GeckoTerminal candidate can become non-stale after refresh', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'false' });
    cleanup.push(dir);
    const db = createDb(config);
    const stale = normalizeGeckoTerminalPool(makePool('MintFreshen111111111111111111111111111111111', { address: 'FreshenPool111' }), new Date(Date.now() - 20 * 60 * 1000).toISOString())!;
    stale.dataUpdatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const tokenId = db.upsertToken(stale);
    db.insertSnapshot(tokenId, stale);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v2/networks/solana/pools/FreshenPool111')) {
        return makeJsonResponse({ data: makePool('MintFreshen111111111111111111111111111111111', { address: 'FreshenPool111', reserve_in_usd: '60000' }) });
      }
      return makeJsonResponse({ data: [] });
    });

    await refreshSnapshotsForTokenAddresses(db, config, [stale.mint]);
    const refreshed = db.getLatestSnapshot(tokenId)!;
    const ageMinutes = (Date.now() - new Date(refreshed.dataUpdatedAt).getTime()) / 60_000;
    expect(ageMinutes).toBeLessThan(1);
    db.close();
  });

  it('enrichCandidate runs safety enrichment for geckoterminal Solana candidate', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const candidate = normalizeGeckoTerminalPool(makePool('MintEnrich11111111111111111111111111111111111'))!;
    const spy = vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue({
      mintAuthority: 'SAFE',
      freezeAuthority: 'SAFE',
      mintAuthorityRenounced: true,
      freezeAuthorityRenounced: true,
      tokenProgram: 'Tokenkeg',
      supply: '1000',
      decimals: 6,
      metadataStatus: 'YES',
      metadataPresent: true,
      holderCount: 10,
      topHolderPct: 5,
      top10HolderPct: 20,
      holderConcentrationLevel: 'LOW',
      holderConcentration: 'SAFE',
      creatorAddress: null,
      creatorStatus: 'SAFE',
      lpOrPoolAddress: 'Pool111',
      poolAgeMinutes: 10,
      sellQuoteAvailable: 'UNKNOWN',
      estimatedSlippageBps: null,
      redFlags: [],
      notes: [],
      raw: {}
    } as any);
    const result = await enrichCandidate(db, config, candidate);
    expect(spy).toHaveBeenCalled();
    expect(result.candidate.mintAuthority).toBe('SAFE');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });
});
