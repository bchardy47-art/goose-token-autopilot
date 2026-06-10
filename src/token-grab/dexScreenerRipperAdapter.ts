import type { RipperEarSignal, RipperEarSourceKind } from './ripperEars';

// ── Raw DexScreener pair shape ────────────────────────────────────────────────────────────

export interface DexPairRaw {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  txns?: {
    m5?:  { buys?: number; sells?: number };
    h1?:  { buys?: number; sells?: number };
    h6?:  { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number; h1?: number; h6?: number; h24?: number;
  };
  priceChange?: {
    m5?: number; h1?: number; h6?: number; h24?: number;
  };
  liquidity?: { usd?: number; base?: number; quote?: number };
  pairCreatedAt?: number;   // epoch ms
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
}

export interface DexScreenerPairsResponse {
  schemaVersion?: string;
  pairs?: DexPairRaw[];
  pair?: DexPairRaw;          // single-pair endpoint returns this
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

function safeNum(v: number | undefined | null): number | undefined {
  return v != null && Number.isFinite(v) && v > 0 ? v : undefined;
}

function epochMsToIso(ms: number | undefined | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

// Detect likely source kind from the pair metadata
function inferSourceKind(pair: DexPairRaw): RipperEarSourceKind {
  if (pair.pairCreatedAt != null) return 'DEX_NEW_POOL';
  return 'DEX_GAINER';
}

// ── Core normalization ────────────────────────────────────────────────────────────────────

/**
 * Normalizes a single raw DexScreener pair record into a RipperEarSignal.
 *
 * Returns null if the record is missing the base token address or pair address
 * (both are required to identify the token later).
 *
 * Never throws — data quality issues are captured in `warnings`.
 */
export function normalizeDexPair(
  pair: DexPairRaw,
  nowIso: string,
  overrideSourceKind?: RipperEarSourceKind,
): RipperEarSignal | null {
  const contract   = pair.baseToken?.address?.trim();
  const poolAddr   = pair.pairAddress?.trim();
  const warnings: string[] = [];
  const signalReasons: string[] = [];

  // Both required
  if (!contract) { return null; }
  if (!poolAddr)  { return null; }

  const symbol   = pair.baseToken?.symbol?.trim().slice(0, 20).toUpperCase();
  const name     = pair.baseToken?.name?.trim();
  const url      = pair.url;
  const sourceKind = overrideSourceKind ?? inferSourceKind(pair);

  // Timing: prefer pairCreatedAt as the authoritative launch time
  const discoveredIso = epochMsToIso(pair.pairCreatedAt) ?? nowIso;
  if (!epochMsToIso(pair.pairCreatedAt)) {
    warnings.push('pairCreatedAt missing — using now as discoveredAt (age may be inaccurate)');
  }

  // Market data
  const liquidityUsd   = safeNum(pair.liquidity?.usd);
  const volumeUsd      = safeNum(pair.volume?.m5 ?? pair.volume?.h1);
  const priceChangePct = pair.priceChange?.m5 ?? pair.priceChange?.h1;
  const buys           = pair.txns?.m5?.buys;
  const sells          = pair.txns?.m5?.sells;
  const txnCount       = (buys != null && sells != null) ? buys + sells : undefined;

  if (liquidityUsd == null) {
    warnings.push('liquidity.usd missing or zero');
  }
  if (volumeUsd == null) {
    warnings.push('volume missing or zero');
  }

  // VLR
  let vlr: number | undefined;
  if (volumeUsd != null && liquidityUsd != null && liquidityUsd > 0) {
    vlr = volumeUsd / liquidityUsd;
  }

  // Signal reasons
  if (priceChangePct != null && priceChangePct > 20) {
    signalReasons.push(`price +${priceChangePct.toFixed(1)}% (m5)`);
  }
  if (buys != null && sells != null && buys > sells * 2) {
    signalReasons.push(`buy-heavy: ${buys} buys vs ${sells} sells`);
  }
  if (liquidityUsd != null && liquidityUsd > 5000) {
    signalReasons.push(`liquidity $${Math.round(liquidityUsd).toLocaleString()}`);
  }
  if (pair.pairCreatedAt != null) {
    signalReasons.push('new pool detected');
  }

  // Confidence
  const confidence =
    liquidityUsd != null && priceChangePct != null && buys != null
      ? 'HIGH'
      : liquidityUsd != null || priceChangePct != null
      ? 'MEDIUM'
      : 'LOW';

  const id = `dexscreener:${poolAddr}`;

  return {
    id,
    source: 'dexscreener',
    sourceKind,
    contract,
    tokenAddress: contract,
    poolAddress: poolAddr,
    symbol,
    name,
    url,
    discoveredAt: discoveredIso,
    observedAt: nowIso,
    launchHint: pair.pairCreatedAt != null ? String(pair.pairCreatedAt) : undefined,
    confidence,
    signalReasons,
    warnings,
    liquidityUsd,
    volumeUsd,
    priceChangePct,
    volumeLiquidityRatio: vlr,
    txnCount,
    buys,
    sells,
    raw: pair,
  };
}

// ── Batch normalization ───────────────────────────────────────────────────────────────────

export interface NormalizeDexPairsResult {
  signals: RipperEarSignal[];
  skippedCount: number;         // records rejected (missing required fields)
  warningCount: number;         // warnings across all signals
}

/**
 * Normalizes an array of raw DexScreener pair records.
 * Null results (missing required fields) are counted as skipped.
 */
export function normalizeDexPairs(
  pairs: DexPairRaw[],
  nowIso: string,
  overrideSourceKind?: RipperEarSourceKind,
): NormalizeDexPairsResult {
  let skippedCount = 0;
  let warningCount = 0;
  const signals: RipperEarSignal[] = [];

  for (const pair of pairs) {
    const signal = normalizeDexPair(pair, nowIso, overrideSourceKind);
    if (!signal) {
      skippedCount += 1;
      continue;
    }
    warningCount += signal.warnings.length;
    signals.push(signal);
  }

  return { signals, skippedCount, warningCount };
}

/**
 * Extracts pairs from a DexScreener API response and normalizes them.
 * Handles both the `pairs` (search/trending) and `pair` (single) shapes.
 */
export function normalizeDexScreenerResponse(
  body: DexScreenerPairsResponse,
  nowIso: string,
): NormalizeDexPairsResult {
  let rawPairs: DexPairRaw[] = [];
  if (Array.isArray(body.pairs)) rawPairs = body.pairs;
  else if (body.pair) rawPairs = [body.pair];

  return normalizeDexPairs(rawPairs, nowIso);
}
