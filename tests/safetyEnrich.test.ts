import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { runSafetyEnrich } from '../src/safetyEnrich';
import { verifySafety } from '../src/verifySafety';
import * as solanaSafety from '../src/enrichment/solanaSafety';
import { scoreToken } from '../src/scoring/scoreToken';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLiveCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'SafetyMint1111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/safety',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/safety',
        pairAddress: 'SafetyPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'SafetyMint1111111111111111111111111111111111', name: 'Safety Token', symbol: 'SAFEX' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

function makeEnrichment(overrides: Record<string, unknown> = {}): solanaSafety.SolanaSafetyEnrichment {
  return {
    mintAuthority: 'SAFE',
    freezeAuthority: 'SAFE',
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    supply: '1000000000',
    decimals: 6,
    metadataStatus: 'UNKNOWN',
    metadataPresent: true,
    holderCount: 20,
    topHolderPct: 8,
    top10HolderPct: 35,
    holderConcentrationLevel: 'LOW',
    holderConcentration: 'SAFE',
    creatorAddress: null,
    creatorStatus: 'UNKNOWN',
    lpOrPoolAddress: 'Pool111',
    poolAgeMinutes: 120,
    sellQuoteAvailable: 'UNKNOWN',
    estimatedSlippageBps: null,
    redFlags: [],
    notes: ['test enrichment'],
    raw: { mocked: true },
    ...overrides
  };
}

describe('read-only safety enrich', () => {
  it('enrichment disabled by default', () => {
    const config = loadConfig({});
    expect(config.enableSolanaSafetyEnrichment).toBe(false);
    expect(config.safetyEnrichmentTimeoutMs).toBe(8000);
    expect(config.safetyEnrichmentMaxTokensPerRun).toBe(25);
    expect(config.safetyEnrichmentCacheMinutes).toBe(60);
  });

  it('verify-safety still reports real trading locked', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    expect(status.enrichmentEnabled).toBe(false);
  });

  it('safety-enrich never opens paper positions', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment());
    await runSafetyEnrich(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('safety-enrich never records real trade attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment());
    await runSafetyEnrich(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('safety-enrich never requires wallet/private key', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment());
    await runSafetyEnrich(db, config);
    expect(config.burnerWalletPrivateKey).toBeUndefined();
    expect(config.mainWalletPresent).toBe(false);
    db.close();
  });

  it('mint authority present becomes unsafe/red flag', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = solanaSafety.applyEnrichment(makeLiveCandidate(), makeEnrichment({ mintAuthority: 'UNSAFE', mintAuthorityRenounced: false, redFlags: ['mint authority active'] }));
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('mint authority active');
  });

  it('freeze authority present becomes unsafe/red flag', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = solanaSafety.applyEnrichment(makeLiveCandidate(), makeEnrichment({ freezeAuthority: 'UNSAFE', freezeAuthorityRenounced: false, redFlags: ['freeze authority active'] }));
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('freeze authority active');
  });

  it('mint authority none/renounced is recorded correctly', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment({ mintAuthority: 'SAFE', mintAuthorityRenounced: true }));
    await runSafetyEnrich(db, config);
    expect(db.getLatestSolanaSafetyEnrichment(tokenId)?.mintAuthorityRenounced).toBe(true);
    db.close();
  });

  it('freeze authority none/renounced is recorded correctly', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment({ freezeAuthority: 'SAFE', freezeAuthorityRenounced: true }));
    await runSafetyEnrich(db, config);
    expect(db.getLatestSolanaSafetyEnrichment(tokenId)?.freezeAuthorityRenounced).toBe(true);
    db.close();
  });

  it('holder concentration high becomes unsafe/red flag', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = solanaSafety.applyEnrichment(makeLiveCandidate(), makeEnrichment({ holderConcentration: 'RISKY', holderConcentrationLevel: 'HIGH', redFlags: ['high holder concentration'] }));
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('holder concentration high');
  });

  it('UNKNOWN fields remain unsafe for autopilot/paper readiness', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = solanaSafety.applyEnrichment(makeLiveCandidate(), makeEnrichment({ mintAuthority: 'UNKNOWN', freezeAuthority: 'UNKNOWN', holderConcentration: 'UNKNOWN', sellQuoteAvailable: 'UNKNOWN', redFlags: ['mint authority unknown'] }));
    const score = scoreToken(1, candidate, config);
    expect(score.autopilotBlocked).toBe(true);
    expect(score.verdict).toBe('AVOID');
  });

  it('cache skip works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SAFETY_ENRICHMENT_CACHE_MINUTES: '60' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'cached', { cached: true });
    const spy = vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment');
    const result = await runSafetyEnrich(db, config);
    expect((result as any).skippedCachedCount).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    db.close();
  });

  it('max tokens per run works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SAFETY_ENRICHMENT_MAX_TOKENS_PER_RUN: '1' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId1 = db.upsertToken(makeLiveCandidate({ mint: 'SafetyMint1', symbol: 'S1' }));
    const tokenId2 = db.upsertToken(makeLiveCandidate({ mint: 'SafetyMint2', symbol: 'S2' }));
    db.insertSnapshot(tokenId1, makeLiveCandidate({ mint: 'SafetyMint1', symbol: 'S1' }));
    db.insertSnapshot(tokenId2, makeLiveCandidate({ mint: 'SafetyMint2', symbol: 'S2' }));
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockResolvedValue(makeEnrichment());
    const result = await runSafetyEnrich(db, config);
    expect((result as any).checkedCount).toBeLessThanOrEqual(1);
    db.close();
  });

  it('RPC failure is handled safely as UNKNOWN/error, not safe', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.spyOn(solanaSafety, 'getSolanaSafetyEnrichment').mockRejectedValue(new Error('rpc down'));
    const result = await runSafetyEnrich(db, config);
    expect((result as any).errorsCount).toBeGreaterThan(0);
    expect(db.getLatestSolanaSafetyEnrichment(tokenId)).toBeNull();
    db.close();
  });
});
