import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import {
  buildSafetyRpcProofReport,
  formatSafetyRpcProofTable,
  renderSafetyRpcProof
} from '../src/safetyRpcProof';
import * as solanaSafety from '../src/enrichment/solanaSafety';
import { runSafetyEnrich } from '../src/safetyEnrich';
import { buildSafetyEnrichDebugReport } from '../src/safetyEnrichDebug';
import { buildSignalAuditReport } from '../src/signalAudit';
import { buildSignalCompareReport } from '../src/signalCompare';

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
      tokenAddress: 'RpcMint111111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/rpcproof',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/rpcproof',
        pairAddress: 'RpcPair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'RpcMint111111111111111111111111111111111111', name: 'RPC Token', symbol: 'RPC' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('safety rpc proof', () => {
  it('missing SOLANA_RPC_URL exits safely and says no RPC configured', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyRpcProofReport(db, config);
    expect((report as any).message).toMatch(/No SOLANA_RPC_URL configured/);
    expect((report as any).finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('proof command never opens paper positions', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyRpcProofReport(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect((report as any).finalSafetyStatus).toBe('Real trading remains locked.');
    db.close();
  });

  it('proof command never records real trade attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const db = createDb(config);
    await buildSafetyRpcProofReport(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('parser handles null mint/freeze authority as SAFE + renounced', () => {
    const parsed = solanaSafety.parseMintAccountInfoFromRpcResult({
      value: {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        lamports: 123,
        data: {
          program: 'spl-token',
          parsed: {
            type: 'mint',
            info: {
              mintAuthority: null,
              freezeAuthority: null,
              supply: '1000000',
              decimals: 6,
              isInitialized: true
            }
          }
        }
      }
    });
    const mint = solanaSafety.normalizeMintAuthority(parsed.mintInfo);
    const freeze = solanaSafety.normalizeFreezeAuthority(parsed.mintInfo);
    expect(mint.status).toBe('SAFE');
    expect(mint.renounced).toBe(true);
    expect(freeze.status).toBe('SAFE');
    expect(freeze.renounced).toBe(true);
  });

  it('parser handles present mint/freeze authority as unsafe', () => {
    const parsed = solanaSafety.parseMintAccountInfoFromRpcResult({
      value: {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        lamports: 123,
        data: {
          program: 'spl-token',
          parsed: {
            type: 'mint',
            info: {
              mintAuthority: 'MintAuthority111',
              freezeAuthority: 'FreezeAuthority111',
              supply: '1000000',
              decimals: 6,
              isInitialized: true
            }
          }
        }
      }
    });
    expect(solanaSafety.normalizeMintAuthority(parsed.mintInfo).status).toBe('UNSAFE');
    expect(solanaSafety.normalizeFreezeAuthority(parsed.mintInfo).status).toBe('UNSAFE');
  });

  it('parser handles malformed RPC as unknown', () => {
    const parsed = solanaSafety.parseMintAccountInfoFromRpcResult({ value: { owner: 'Tokenkeg', data: { weird: true } } });
    expect(parsed.success).toBe(false);
    expect(solanaSafety.normalizeMintAuthority(parsed.mintInfo).status).toBe('UNKNOWN');
    expect(solanaSafety.normalizeFreezeAuthority(parsed.mintInfo).status).toBe('UNKNOWN');
  });

  it('largest accounts parser computes holder concentration', () => {
    const parsedLargest = solanaSafety.parseLargestTokenAccountsFromRpcResult(
      { value: [{ uiAmount: 700 }, { uiAmount: 80 }, { uiAmount: 60 }, { uiAmount: 50 }, { uiAmount: 40 }] },
      { supply: '1000000000', decimals: 6 }
    );
    expect(parsedLargest.topHolderPct).toBeGreaterThan(50);
    expect(parsedLargest.top10HolderPct).toBeGreaterThan(80);
    expect(parsedLargest.holderConcentrationLevel).toBe('HIGH');
    expect(parsedLargest.holderConcentrationStatus).toBe('RISKY');
  });

  it('safety-enrich uses parser helpers', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());

    vi.spyOn(solanaSafety.solanaSafetyRpcHelpers, 'fetchMintAccountRpcResult').mockResolvedValue({
      value: {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        lamports: 1,
        data: { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, supply: '1000000', decimals: 6, isInitialized: true } } }
      }
    });
    vi.spyOn(solanaSafety.solanaSafetyRpcHelpers, 'fetchLargestTokenAccountsRpcResult').mockResolvedValue({ value: [{ uiAmount: 10 }, { uiAmount: 5 }] });

    const result = await runSafetyEnrich(db, config);
    expect((result as any).checkedCount).toBeGreaterThan(0);
    expect(db.getLatestSolanaSafetyEnrichment(tokenId)?.mintAuthority).toBe('SAFE');
    db.close();
  });

  it('debug report shows known safety fields when parser returns known data', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });

    vi.spyOn(solanaSafety.solanaSafetyRpcHelpers, 'fetchMintAccountRpcResult').mockResolvedValue({
      value: {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        lamports: 1,
        data: { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, supply: '1000000', decimals: 6, isInitialized: true } } }
      }
    });
    vi.spyOn(solanaSafety.solanaSafetyRpcHelpers, 'fetchLargestTokenAccountsRpcResult').mockResolvedValue({ value: [{ uiAmount: 10 }, { uiAmount: 5 }] });

    await runSafetyEnrich(db, config);
    const debug = await buildSafetyEnrichDebugReport(db, config);
    expect((debug as any).summary.mostlyUnknownEnrichmentRows).toBe(false);
    db.close();
  });

  it('signal-audit/compare linkage reflects known enrichment rows if implemented', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'track', 1, 1, 12000, 7000, 25000, { snapshot: makeLiveCandidate() });
    db.upsertWatchOnlySignalAnalysis(watchId, tokenId, 'EARLY_RUNNER', new Date().toISOString(), 30, -5, 10, 12000, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'seed', 'note', { sample: true });
    db.createSolanaSafetyEnrichment(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'SAFE', 'SAFE', true, true, 'Tokenkeg', '100', 6, 10, 5, 20, 'LOW', 'SAFE', null, 'UNKNOWN', 'Pool111', 10, 'ok', [], 'notes', { sample: true });
    const audit = buildSignalAuditReport(db, config);
    const compare = buildSignalCompareReport(db, config);
    expect(audit.candidateRows[0].mintAuthority).toBe('SAFE');
    expect((compare.summary as any).knownSafetyFieldComparison.mintAuthorityKnownPct.left).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('table format works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const report = await buildSafetyRpcProofReport(db, config);
    expect(formatSafetyRpcProofTable(report as any)).toContain('Safety RPC Proof');
    expect(renderSafetyRpcProof(report, { SAFETY_RPC_PROOF_FORMAT: 'table' } as NodeJS.ProcessEnv)).toContain('Safety RPC Proof');
    db.close();
  });
});
