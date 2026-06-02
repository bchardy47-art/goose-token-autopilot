import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { scoreToken } from '../src/scoring/scoreToken';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { applyEnrichment, getSolanaSafetyEnrichment, type SolanaSafetyEnrichment } from '../src/enrichment/solanaSafety';
import { makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMintAccountBase64(params: { mintAuthorityActive: boolean; freezeAuthorityActive: boolean; supply?: bigint; decimals?: number }): string {
  const buffer = Buffer.alloc(82);
  buffer.writeUInt32LE(params.mintAuthorityActive ? 1 : 0, 0);
  if (params.mintAuthorityActive) {
    Buffer.alloc(32, 1).copy(buffer, 4);
  }
  buffer.writeBigUInt64LE(params.supply ?? 1_000_000_000n, 36);
  buffer.writeUInt8(params.decimals ?? 6, 44);
  buffer.writeUInt8(1, 45);
  buffer.writeUInt32LE(params.freezeAuthorityActive ? 1 : 0, 46);
  if (params.freezeAuthorityActive) {
    Buffer.alloc(32, 2).copy(buffer, 50);
  }
  return buffer.toString('base64');
}

function buildLiveCandidate() {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'LiveMint1111111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/livepair',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }, { type: 'twitter', url: 'https://x.com/example' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/livepair',
        pairAddress: 'LivePair111',
        pairCreatedAt: Date.now() - 60 * 60 * 1000,
        priceUsd: '0.25',
        marketCap: 900000,
        txns: { m5: { buys: 40, sells: 10 } },
        volume: { m5: 5000, h1: 40000, h24: 300000 },
        priceChange: { m5: 10, h1: 28, h24: 40 },
        liquidity: { usd: 80000 },
        info: {
          websites: [{ url: 'https://example.com', label: 'Website' }],
          socials: [{ type: 'twitter', url: 'https://x.com/example' }]
        },
        baseToken: {
          address: 'LiveMint1111111111111111111111111111111111111',
          name: 'Live Token',
          symbol: 'LIVE'
        },
        quoteToken: {
          address: 'So11111111111111111111111111111111111111112',
          name: 'Wrapped SOL',
          symbol: 'SOL'
        }
      }
    ],
    new Date().toISOString()
  );

  if (!candidate) {
    throw new Error('Failed to build live candidate for test');
  }

  return candidate;
}

function safeEnrichment(): SolanaSafetyEnrichment {
  return {
    mintAuthority: 'SAFE',
    freezeAuthority: 'SAFE',
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    supply: '1000000000',
    decimals: 6,
    metadataStatus: 'YES',
    metadataPresent: true,
    holderCount: 20,
    topHolderPct: 5,
    top10HolderPct: 20,
    holderConcentrationLevel: 'LOW',
    holderConcentration: 'SAFE',
    creatorAddress: null,
    creatorStatus: 'SAFE',
    lpOrPoolAddress: 'LivePair111',
    poolAgeMinutes: 60,
    sellQuoteAvailable: 'YES',
    estimatedSlippageBps: 120,
    redFlags: [],
    notes: ['safe enrichment'],
    raw: { kind: 'safe' }
  };
}

describe('Solana safety enrichment', () => {
  it('disabled mint authority becomes SAFE and active mint authority becomes UNSAFE', async () => {
    const { dir, config } = makeTestConfig({ ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);

    const safeResult = await getSolanaSafetyEnrichment('MintSafe', config, {
      rpcUrl: 'https://rpc.example.test',
      enableQuoteCheck: false,
      rpcFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getAccountInfo') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [createMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false }), 'base64'] } } }), { status: 200 });
        }
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ uiAmount: 10_000 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      }
    });

    const unsafeResult = await getSolanaSafetyEnrichment('MintUnsafe', config, {
      rpcUrl: 'https://rpc.example.test',
      enableQuoteCheck: false,
      rpcFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getAccountInfo') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [createMintAccountBase64({ mintAuthorityActive: true, freezeAuthorityActive: false }), 'base64'] } } }), { status: 200 });
        }
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ uiAmount: 10_000 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      }
    });

    expect(safeResult.mintAuthority).toBe('SAFE');
    expect(safeResult.mintAuthorityRenounced).toBe(true);
    expect(unsafeResult.mintAuthority).toBe('UNSAFE');
    expect(unsafeResult.mintAuthorityRenounced).toBe(false);
  });

  it('disabled freeze authority becomes SAFE and active freeze authority becomes UNSAFE', async () => {
    const { dir, config } = makeTestConfig({ ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);

    const safeResult = await getSolanaSafetyEnrichment('FreezeSafe', config, {
      rpcUrl: 'https://rpc.example.test',
      enableQuoteCheck: false,
      rpcFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getAccountInfo') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [createMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false }), 'base64'] } } }), { status: 200 });
        }
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ uiAmount: 10_000 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      }
    });

    const unsafeResult = await getSolanaSafetyEnrichment('FreezeUnsafe', config, {
      rpcUrl: 'https://rpc.example.test',
      enableQuoteCheck: false,
      rpcFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getAccountInfo') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [createMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: true }), 'base64'] } } }), { status: 200 });
        }
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ uiAmount: 10_000 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      }
    });

    expect(safeResult.freezeAuthority).toBe('SAFE');
    expect(safeResult.freezeAuthorityRenounced).toBe(true);
    expect(unsafeResult.freezeAuthority).toBe('UNSAFE');
    expect(unsafeResult.freezeAuthorityRenounced).toBe(false);
  });

  it('RPC failure returns UNKNOWN and blocks autopilot', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);
    const enrichment = await getSolanaSafetyEnrichment('FailMint', config, {
      rpcUrl: 'https://rpc.example.test',
      rpcFetch: async () => {
        throw new Error('rpc down');
      }
    });

    expect(enrichment.mintAuthority).toBe('UNKNOWN');
    expect(enrichment.freezeAuthority).toBe('UNKNOWN');
    expect(enrichment.holderConcentration).toBe('UNKNOWN');

    const candidate = applyEnrichment(buildLiveCandidate(), enrichment);
    const score = scoreToken(1, candidate, config);
    expect(score.verdict).toBe('AVOID');
    expect(score.autopilotBlocked).toBe(true);
  });

  it('enriched safe live candidate can score higher', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const baseCandidate = buildLiveCandidate();
    const baseScore = scoreToken(1, baseCandidate, config);
    const enrichedCandidate = applyEnrichment(baseCandidate, safeEnrichment());
    const enrichedScore = scoreToken(1, enrichedCandidate, config);

    expect(enrichedScore.safetyScore).toBeGreaterThan(baseScore.safetyScore);
    expect(enrichedScore.totalScore).toBeGreaterThan(baseScore.totalScore);
    expect(enrichedScore.redFlags.length).toBe(0);
  });

  it('high-risk enriched token is AVOID', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const riskyCandidate = applyEnrichment(buildLiveCandidate(), {
      mintAuthority: 'UNSAFE',
      freezeAuthority: 'UNSAFE',
      mintAuthorityRenounced: false,
      freezeAuthorityRenounced: false,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      supply: '1000000000',
      decimals: 6,
      metadataStatus: 'NO',
      metadataPresent: false,
      holderCount: 4,
      topHolderPct: 60,
      top10HolderPct: 95,
      holderConcentrationLevel: 'HIGH',
      holderConcentration: 'RISKY',
      creatorAddress: null,
      creatorStatus: 'RISKY',
      lpOrPoolAddress: 'LivePair111',
      poolAgeMinutes: 60,
      sellQuoteAvailable: 'NO',
      estimatedSlippageBps: 1200,
      redFlags: ['mint authority active', 'freeze authority active', 'high holder concentration'],
      notes: ['risky enrichment'],
      raw: { kind: 'risky' }
    });

    const score = scoreToken(1, riskyCandidate, config);
    expect(score.verdict).toBe('AVOID');
    expect(score.redFlags).toContain('mint authority active');
    expect(score.redFlags).toContain('freeze authority active');
    expect(score.redFlags).toContain('sell quote unavailable');
    expect(score.redFlags).toContain('holder concentration high');
  });

  it('holder concentration high is derived as risky', async () => {
    const { dir, config } = makeTestConfig({ ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true', SOLANA_RPC_URL: 'https://rpc.example.test' });
    cleanup.push(dir);

    const result = await getSolanaSafetyEnrichment('HighHolderMint', config, {
      rpcUrl: 'https://rpc.example.test',
      enableQuoteCheck: false,
      rpcFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getAccountInfo') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [createMintAccountBase64({ mintAuthorityActive: false, freezeAuthorityActive: false, supply: 1_000_000_000n, decimals: 6 }), 'base64'] } } }), { status: 200 });
        }
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ uiAmount: 700 }, { uiAmount: 80 }, { uiAmount: 60 }, { uiAmount: 50 }, { uiAmount: 40 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      }
    });

    expect(result.holderConcentrationLevel).toBe('HIGH');
    expect(result.holderConcentration).toBe('RISKY');
    expect(result.topHolderPct).toBeGreaterThan(50);
    expect(result.top10HolderPct).toBeGreaterThan(80);
  });
});
