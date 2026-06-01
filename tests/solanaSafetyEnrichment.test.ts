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
    metadataStatus: 'YES',
    metadataPresent: true,
    holderConcentration: 'SAFE',
    creatorStatus: 'SAFE',
    sellQuoteAvailable: 'YES',
    estimatedSlippageBps: 120,
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
    expect(unsafeResult.mintAuthority).toBe('UNSAFE');
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
    expect(unsafeResult.freezeAuthority).toBe('UNSAFE');
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
      metadataStatus: 'NO',
      metadataPresent: false,
      holderConcentration: 'RISKY',
      creatorStatus: 'RISKY',
      sellQuoteAvailable: 'NO',
      estimatedSlippageBps: 1200,
      notes: ['risky enrichment'],
      raw: { kind: 'risky' }
    });

    const score = scoreToken(1, riskyCandidate, config);
    expect(score.verdict).toBe('AVOID');
    expect(score.redFlags).toContain('mint authority active');
    expect(score.redFlags).toContain('freeze authority active');
    expect(score.redFlags).toContain('sell quote unavailable');
  });
});
