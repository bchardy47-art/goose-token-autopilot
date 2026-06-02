import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { buildSafetyEnrichDebugReport, formatSafetyEnrichDebugTable, renderSafetyEnrichDebug } from '../src/safetyEnrichDebug';
import * as safetyEnrichModule from '../src/safetyEnrich';

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
      tokenAddress: 'DebugMint11111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/debug',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/debug',
        pairAddress: 'DebugPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'DebugMint11111111111111111111111111111111111', name: 'Debug Token', symbol: 'DBG' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('safety enrich debug', () => {
  it('debug report works with empty DB', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect(report).toHaveProperty('summary');
    expect((report as any).finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('debug report shows no enrichment rows found', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).diagnostics.join(' ')).toMatch(/No enrichment rows found/);
    db.close();
  });

  it('debug report counts enrichment rows', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'notes', { sample: true });
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).summary.totalEnrichmentRows).toBe(1);
    db.close();
  });

  it('debug report detects enriched watch-only candidates', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'notes', { sample: true });
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).summary.enrichedWatchOnlyCandidatesCount).toBe(1);
    db.close();
  });

  it('debug report detects missing watch-only enrichment coverage', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    const otherTokenId = db.upsertToken(makeLiveCandidate({ mint: 'OtherMint111', symbol: 'OTH' }));
    db.insertSnapshot(otherTokenId, makeLiveCandidate({ mint: 'OtherMint111', symbol: 'OTH' }));
    db.createSolanaSafetyEnrichment(otherTokenId, 'OtherMint111', new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'notes', { sample: true });
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).diagnostics.join(' ')).toMatch(/do not cover compared watch-only candidates/);
    db.close();
  });

  it('debug report detects rows exist but mostly UNKNOWN', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'UNKNOWN', 'UNKNOWN', null, null, 'Tokenkeg', '100', 6, 10, 5, 20, 'UNKNOWN', 'UNKNOWN', null, 'UNKNOWN', 'Pool111', 10, 'unknown', ['unknown'], 'notes', { sample: true });
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).diagnostics.join(' ')).toMatch(/returned UNKNOWN for most fields/);
    db.close();
  });

  it('debug report includes final safety line', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('debug command never opens paper positions', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    await buildSafetyEnrichDebugReport(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('debug command never records real trade attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    await buildSafetyEnrichDebugReport(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('RUN_ENRICH option calls existing enrichment but still does not trade', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const spy = vi.spyOn(safetyEnrichModule, 'runSafetyEnrich').mockResolvedValue({ checkedCount: 1, finalSafetyStatus: 'Real trading remains locked.' } as any);
    const report = await buildSafetyEnrichDebugReport(db, config, { SAFETY_ENRICH_DEBUG_RUN_ENRICH: 'true' } as NodeJS.ProcessEnv);
    expect(spy).toHaveBeenCalled();
    expect((report as any).finalSafetyStatus).toBe('Real trading remains locked.');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('signal-audit/compare linkage uses enrichment row if implemented', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    db.upsertWatchOnlySignalAnalysis(watchId, tokenId, 'EARLY_RUNNER', new Date().toISOString(), 30, -5, 10, 12000, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'seed', 'note', { sample: true });
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'notes', { sample: true });
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect((report as any).summary.knownSafetyLinkedRows).toBeGreaterThan(0);
    db.close();
  });

  it('table format works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyEnrichDebugReport(db, config);
    expect(formatSafetyEnrichDebugTable(report as any)).toContain('Safety Enrichment Debug Report');
    expect(renderSafetyEnrichDebug(report, { SAFETY_ENRICH_DEBUG_FORMAT: 'table' } as NodeJS.ProcessEnv)).toContain('Safety Enrichment Debug Report');
    db.close();
  });
});
