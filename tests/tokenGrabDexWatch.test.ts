import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePresignals,
  loadPresignals,
  filterContractSignals,
  isSolanaContract,
  parsePairResponse,
  computeChangePct,
  classifyOutcome,
  buildOutcome,
  buildDexWatchReport,
  renderDexWatchReport,
  fetchPairSnapshot,
  runDexWatch,
  WINNER_PCT,
  LOSER_PCT,
  type DexPairSnapshot,
  type DexWatchOutcome,
} from '../src/token-grab/dexWatch';
import type { PreSignal } from '../src/token-grab/xEarsPreSignal';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SOL_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const SOL_B = 'DThksS4X1V6PVtawVub4G9zLMi3Fh1MgPuDGoqM8pump';
const SOL_C = '2gTZL9Qv8jiWgNUt9zGbTFopfEJK2M5AobaWm5Ufpump';
const ETH_ADDR = '0xDeadBeefDeadBeefDeadBeefDeadBeef00000001';

function sig(over: Partial<PreSignal> = {}): PreSignal {
  return {
    id: 'dex-aaa',
    source: 'other',
    text: 'CA test',
    contract: SOL_A,
    seenAt: '2026-06-07T00:00:00.000Z',
    signalType: 'launch_mention',
    confidence: 'high',
    ...over,
  };
}

function snap(over: Partial<DexPairSnapshot> = {}): DexPairSnapshot {
  return {
    contract: SOL_A,
    chainId: 'solana',
    symbol: 'GOOSE',
    priceUsd: 1,
    liquidityUsd: 10_000,
    volumeUsd: 5_000,
    observedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  };
}

function pairBody(opts: { priceUsd?: number; liqUsd?: number; volH1?: number; chainId?: string }) {
  return {
    pairs: [
      {
        chainId: opts.chainId ?? 'solana',
        pairAddress: 'PAIR111',
        url: 'https://dexscreener.com/solana/PAIR111',
        baseToken: { address: SOL_A, symbol: 'GOOSE' },
        priceUsd: String(opts.priceUsd ?? 1),
        liquidity: { usd: opts.liqUsd ?? 10_000 },
        volume: { h1: opts.volH1 ?? 5_000 },
      },
    ],
  };
}

// ── Solana address guard ─────────────────────────────────────────────────────────

describe('isSolanaContract', () => {
  it('accepts base58 solana addresses', () => {
    expect(isSolanaContract(SOL_A)).toBe(true);
  });
  it('rejects 0x ethereum addresses', () => {
    expect(isSolanaContract(ETH_ADDR)).toBe(false);
  });
  it('rejects non-strings and empty', () => {
    expect(isSolanaContract(null)).toBe(false);
    expect(isSolanaContract('')).toBe(false);
    expect(isSolanaContract('short')).toBe(false);
  });
});

// ── Reading presignals ───────────────────────────────────────────────────────────

describe('parsePresignals / loadPresignals', () => {
  it('parses a valid signal array', () => {
    const out = parsePresignals([sig(), sig({ id: 'dex-bbb', contract: SOL_B })]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('dex-aaa');
  });
  it('ignores non-arrays and malformed items', () => {
    expect(parsePresignals(null)).toEqual([]);
    expect(parsePresignals([{ no: 'id' }, 42, null])).toEqual([]);
  });
  it('reads presignals from a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexwatch-'));
    const file = path.join(dir, 'presignals.dex.json');
    fs.writeFileSync(file, JSON.stringify([sig()]), 'utf-8');
    const out = loadPresignals(file);
    expect(out).toHaveLength(1);
    expect(out[0].contract).toBe(SOL_A);
  });
});

// ── Filtering contracts ──────────────────────────────────────────────────────────

describe('filterContractSignals', () => {
  it('keeps solana contracts and drops eth / contract-less', () => {
    const out = filterContractSignals([
      sig({ id: '1', contract: SOL_A }),
      sig({ id: '2', contract: ETH_ADDR }),
      sig({ id: '3', contract: null }),
      sig({ id: '4', contract: '' }),
    ]);
    expect(out.map(s => s.id)).toEqual(['1']);
  });
  it('dedupes by contract address (case-insensitive)', () => {
    const out = filterContractSignals([
      sig({ id: '1', contract: SOL_A }),
      sig({ id: '2', contract: SOL_A.toLowerCase() }),
      sig({ id: '3', contract: SOL_B }),
    ]);
    expect(out.map(s => s.id)).toEqual(['1', '3']);
  });
});

// ── Parsing DEX Screener response ────────────────────────────────────────────────

describe('parsePairResponse', () => {
  it('parses a pair into a snapshot', () => {
    const s = parsePairResponse(pairBody({ priceUsd: 2, liqUsd: 9999, volH1: 4321 }), SOL_A, 'T');
    expect(s).not.toBeNull();
    expect(s!.priceUsd).toBe(2);
    expect(s!.liquidityUsd).toBe(9999);
    expect(s!.volumeUsd).toBe(4321);
    expect(s!.symbol).toBe('GOOSE');
    expect(s!.pairUrl).toBe('https://dexscreener.com/solana/PAIR111');
  });
  it('picks the highest-liquidity pair', () => {
    const body = {
      pairs: [
        { chainId: 'solana', priceUsd: '1', liquidity: { usd: 100 }, baseToken: { symbol: 'LOW' } },
        { chainId: 'solana', priceUsd: '3', liquidity: { usd: 9000 }, baseToken: { symbol: 'HIGH' } },
      ],
    };
    const s = parsePairResponse(body, SOL_A, 'T');
    expect(s!.symbol).toBe('HIGH');
    expect(s!.priceUsd).toBe(3);
  });
  it('filters out other chains', () => {
    const body = { pairs: [{ chainId: 'ethereum', priceUsd: '1', liquidity: { usd: 100 } }] };
    expect(parsePairResponse(body, SOL_A, 'T', 'solana')).toBeNull();
  });
  it('returns null for missing / empty pairs (missing pair handling)', () => {
    expect(parsePairResponse(null, SOL_A, 'T')).toBeNull();
    expect(parsePairResponse({}, SOL_A, 'T')).toBeNull();
    expect(parsePairResponse({ pairs: [] }, SOL_A, 'T')).toBeNull();
  });
});

// ── Change math ──────────────────────────────────────────────────────────────────

describe('computeChangePct', () => {
  it('computes a positive price change %', () => {
    expect(computeChangePct(1, 1.5)).toBeCloseTo(50);
  });
  it('computes a negative price change %', () => {
    expect(computeChangePct(2, 1)).toBeCloseTo(-50);
  });
  it('returns undefined for missing or zero base', () => {
    expect(computeChangePct(undefined, 1)).toBeUndefined();
    expect(computeChangePct(0, 1)).toBeUndefined();
  });
});

describe('classifyOutcome', () => {
  it('flags winners, losers and flat by threshold', () => {
    expect(classifyOutcome(WINNER_PCT + 5)).toBe('winner');
    expect(classifyOutcome(LOSER_PCT - 5)).toBe('loser');
    expect(classifyOutcome(0)).toBe('flat');
    expect(classifyOutcome(undefined)).toBe('flat');
  });
});

// ── Outcome building ─────────────────────────────────────────────────────────────

describe('buildOutcome', () => {
  it('scores price/liquidity change and v/l ratio', () => {
    const o = buildOutcome(
      sig(),
      snap({ priceUsd: 1, liquidityUsd: 10_000 }),
      snap({ priceUsd: 1.5, liquidityUsd: 12_000, volumeUsd: 6_000 }),
    );
    expect(o.priceChangePct).toBeCloseTo(50);
    expect(o.liquidityChangePct).toBeCloseTo(20);
    expect(o.volumeToLiquidityRatio).toBeCloseTo(0.5);
    expect(o.classification).toBe('winner');
  });
  it('marks missing when entry or final snapshot absent', () => {
    expect(buildOutcome(sig(), null, snap()).classification).toBe('missing');
    expect(buildOutcome(sig(), snap(), null).classification).toBe('missing');
  });
});

// ── Report ───────────────────────────────────────────────────────────────────────

function makeReport() {
  const winner = buildOutcome(sig({ id: 'w' }), snap({ priceUsd: 1 }), snap({ priceUsd: 2 }));
  const loser = buildOutcome(sig({ id: 'l' }), snap({ priceUsd: 1 }), snap({ priceUsd: 0.5 }));
  const flat = buildOutcome(sig({ id: 'f' }), snap({ priceUsd: 1 }), snap({ priceUsd: 1.05 }));
  const missing = buildOutcome(sig({ id: 'm' }), null, snap());
  return buildDexWatchReport({
    signalsRead: 5,
    outcomes: [winner, loser, flat, missing],
    chain: 'solana',
    minutes: 10,
    intervalSeconds: 60,
    dryRun: false,
  });
}

describe('buildDexWatchReport', () => {
  it('groups winners / losers / flat / missing', () => {
    const r = makeReport();
    expect(r.winners.map(o => o.signalId)).toEqual(['w']);
    expect(r.losers.map(o => o.signalId)).toEqual(['l']);
    expect(r.flat.map(o => o.signalId)).toEqual(['f']);
    expect(r.missing.map(o => o.signalId)).toEqual(['m']);
  });
  it('counts found vs missing snapshots', () => {
    const r = makeReport();
    expect(r.snapshotsFound).toBe(3);
    expect(r.snapshotsMissing).toBe(1);
  });
  it('orders top movers by absolute price change', () => {
    const r = makeReport();
    expect(r.topMovers[0].signalId).toBe('w'); // +100% has greatest magnitude vs -50%
    expect(r.topMovers.length).toBeLessThanOrEqual(10);
  });
  it('always reports no real trading', () => {
    const r = makeReport();
    expect(r.tradingExecuted).toBe(0);
    expect(r.noRealTradeSent).toBe(true);
  });
});

describe('renderDexWatchReport', () => {
  it('shows winners / losers / flat counts and read-only banner', () => {
    const out = renderDexWatchReport(makeReport());
    expect(out).toContain('Winners');
    expect(out).toContain('Losers');
    expect(out).toContain('Flat');
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('tradingExecuted: 0');
  });

  it('contains no trading / swap / signing / wallet strings beyond explicit negations', () => {
    const out = renderDexWatchReport(makeReport());
    // No execution verbs that would imply real trading happened.
    expect(out).not.toMatch(/LIVE_EXECUTED/);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toMatch(/sign(ing)? transaction/i);
    // The only mentions of swap/wallet/signing are inside the negation banner.
    for (const word of ['swap', 'wallet', 'signing']) {
      const lines = out.split('\n').filter(l => l.toLowerCase().includes(word));
      for (const l of lines) expect(l.toLowerCase()).toMatch(/no /);
    }
  });
});

// ── Source contains no trading primitives ─────────────────────────────────────────

describe('dexWatch source safety', () => {
  it('module exposes no trading / swap / signing functions', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexWatch.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|jupiter\.swap|executeSwap|LIVE_EXECUTED/);
  });
});

// ── fetchPairSnapshot (mocked fetch) ──────────────────────────────────────────────

describe('fetchPairSnapshot', () => {
  it('returns a snapshot on a 200 response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(pairBody({ priceUsd: 7 })), { status: 200 })) as unknown as typeof fetch;
    const s = await fetchPairSnapshot(SOL_A, { observedAt: 'T', fetchImpl });
    expect(s!.priceUsd).toBe(7);
  });
  it('returns null on non-ok status', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    expect(await fetchPairSnapshot(SOL_A, { observedAt: 'T', fetchImpl })).toBeNull();
  });
  it('returns null when fetch throws (never throws)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchPairSnapshot(SOL_A, { observedAt: 'T', fetchImpl })).toBeNull();
  });
});

// ── runDexWatch end-to-end (mocked fetch + sleep) ─────────────────────────────────

describe('runDexWatch', () => {
  it('reads, watches, captures entry+final and scores a winner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexwatch-run-'));
    const file = path.join(dir, 'presignals.dex.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        sig({ id: 'a', contract: SOL_A }),
        sig({ id: 'b', contract: ETH_ADDR }), // filtered out
      ]),
      'utf-8',
    );

    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      // first call = entry (price 1), second = final (price 2)
      const price = call === 1 ? 1 : 2;
      return new Response(JSON.stringify(pairBody({ priceUsd: price })), { status: 200 });
    }) as unknown as typeof fetch;

    let slept = 0;
    const report = await runDexWatch({
      signalsPath: file,
      minutes: 1,
      intervalSeconds: 30,
      fetchImpl,
      sleepImpl: async (ms: number) => {
        slept += ms;
      },
    });

    expect(report.signalsRead).toBe(2);
    expect(report.signalsWatched).toBe(1); // eth filtered
    expect(report.winners).toHaveLength(1);
    expect(report.winners[0].priceChangePct).toBeCloseTo(100);
    expect(slept).toBe(60_000); // full 1 minute window
    expect(report.tradingExecuted).toBe(0);
  });
});
