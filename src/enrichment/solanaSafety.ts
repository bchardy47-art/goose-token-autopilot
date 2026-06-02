import type { AppConfig, AuthorityStatus, AvailabilityStatus, ConcentrationStatus, CreatorStatus, HolderConcentrationLevel, MetadataPresence, TokenCandidate } from '../types';

export interface SolanaMintAccountInfo {
  mintAuthorityOption?: number;
  mintAuthority?: string | null;
  supply?: string;
  decimals?: number;
  isInitialized?: boolean;
  freezeAuthorityOption?: number;
  freezeAuthority?: string | null;
}

export interface SolanaLargestHolderInfo {
  address?: string;
  amount?: string;
  uiAmount?: number | null;
  uiAmountString?: string;
}

export interface SolanaSafetyEnrichment {
  mintAuthority: AuthorityStatus;
  freezeAuthority: AuthorityStatus;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  tokenProgram: string | null;
  supply: string | null;
  decimals: number | null;
  metadataStatus: MetadataPresence;
  metadataPresent: boolean;
  holderCount: number | null;
  topHolderPct: number | null;
  top10HolderPct: number | null;
  holderConcentrationLevel: HolderConcentrationLevel;
  holderConcentration: ConcentrationStatus;
  creatorAddress: string | null;
  creatorStatus: CreatorStatus;
  lpOrPoolAddress: string | null;
  poolAgeMinutes: number | null;
  sellQuoteAvailable: AvailabilityStatus;
  estimatedSlippageBps: number | null;
  redFlags: string[];
  notes: string[];
  raw: Record<string, unknown>;
}

export interface SolanaSafetyOptions {
  rpcFetch?: typeof fetch;
  quoteFetch?: typeof fetch;
  rpcUrl?: string;
  quoteBaseUrl?: string;
  enableQuoteCheck?: boolean;
  timeoutMs?: number;
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEFAULT_QUOTE_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function readPubkey(bytes: Uint8Array, start: number): string | null {
  const slice = bytes.slice(start, start + 32);
  if (slice.length < 32) return null;
  return Array.from(slice).every((value) => value === 0) ? null : Buffer.from(slice).toString('hex');
}

export function parseMintAccountData(base64Data: string): SolanaMintAccountInfo {
  const bytes = decodeBase64(base64Data);
  if (bytes.length < 82) {
    throw new Error('Mint account data too short');
  }

  const mintAuthorityOption = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  const mintAuthority = mintAuthorityOption === 0 ? null : readPubkey(bytes, 4);
  const supply = bytes.slice(36, 44).reduceRight((accumulator, value) => (accumulator << 8n) + BigInt(value), 0n).toString(10);
  const decimals = bytes[44];
  const isInitialized = bytes[45] === 1;
  const freezeAuthorityOption = bytes[46] | (bytes[47] << 8) | (bytes[48] << 16) | (bytes[49] << 24);
  const freezeAuthority = freezeAuthorityOption === 0 ? null : readPubkey(bytes, 50);

  return {
    mintAuthorityOption,
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthorityOption,
    freezeAuthority
  };
}

export function deriveAuthorityStatus(option: number | undefined, authority: string | null | undefined): AuthorityStatus {
  if (option === undefined) return 'UNKNOWN';
  if (option === 0 || authority === null) return 'SAFE';
  return 'UNSAFE';
}

export function deriveHolderConcentration(
  largestHolders: SolanaLargestHolderInfo[] | null,
  mintInfo: SolanaMintAccountInfo | null
): { status: ConcentrationStatus; level: HolderConcentrationLevel; holderCount: number | null; topHolderPct: number | null; top10HolderPct: number | null; notes: string[] } {
  if (!largestHolders || largestHolders.length === 0 || !mintInfo?.supply) {
    return { status: 'UNKNOWN', level: 'UNKNOWN', holderCount: null, topHolderPct: null, top10HolderPct: null, notes: ['holder concentration data unavailable'] };
  }

  const supplyRaw = Number(mintInfo.supply);
  if (!Number.isFinite(supplyRaw) || supplyRaw <= 0) {
    return { status: 'UNKNOWN', level: 'UNKNOWN', holderCount: largestHolders.length, topHolderPct: null, top10HolderPct: null, notes: ['mint supply unavailable for holder concentration'] };
  }

  const decimals = mintInfo.decimals ?? 0;
  const normalizedSupply = supplyRaw / Math.pow(10, decimals);
  if (!Number.isFinite(normalizedSupply) || normalizedSupply <= 0) {
    return { status: 'UNKNOWN', level: 'UNKNOWN', holderCount: largestHolders.length, topHolderPct: null, top10HolderPct: null, notes: ['normalized supply unavailable for holder concentration'] };
  }

  const amounts = largestHolders
    .map((holder) => holder.uiAmount ?? (holder.uiAmountString ? Number(holder.uiAmountString) : Number(holder.amount ?? 0)))
    .filter((amount): amount is number => Number.isFinite(amount) && amount >= 0);

  if (amounts.length === 0) {
    return { status: 'UNKNOWN', level: 'UNKNOWN', holderCount: largestHolders.length, topHolderPct: null, top10HolderPct: null, notes: ['largest holder amount unavailable'] };
  }

  const topHolderPct = Number(((amounts[0] / normalizedSupply) * 100).toFixed(4));
  const top10HolderPct = Number(((amounts.slice(0, 10).reduce((sum, value) => sum + value, 0) / normalizedSupply) * 100).toFixed(4));

  if (top10HolderPct >= 80 || topHolderPct >= 50) {
    return {
      status: 'RISKY',
      level: 'HIGH',
      holderCount: largestHolders.length,
      topHolderPct,
      top10HolderPct,
      notes: [`holder concentration high: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
    };
  }
  if (top10HolderPct >= 50 || topHolderPct >= 20) {
    return {
      status: 'RISKY',
      level: 'MEDIUM',
      holderCount: largestHolders.length,
      topHolderPct,
      top10HolderPct,
      notes: [`holder concentration medium: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
    };
  }

  return {
    status: 'SAFE',
    level: 'LOW',
    holderCount: largestHolders.length,
    topHolderPct,
    top10HolderPct,
    notes: [`holder concentration low: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
  };
}

async function rpcRequest(fetchImpl: typeof fetch, rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });

  if (!response.ok) {
    throw new Error(`RPC request failed with status ${response.status}`);
  }

  const data = await response.json();
  if (data?.error) {
    throw new Error(`RPC error: ${data.error.message ?? 'unknown rpc error'}`);
  }

  return data?.result;
}

async function fetchMintInfo(fetchImpl: typeof fetch, rpcUrl: string, mint: string): Promise<SolanaMintAccountInfo | null> {
  const result = await rpcRequest(fetchImpl, rpcUrl, 'getAccountInfo', [mint, { encoding: 'base64' }]);
  const value = result?.value;
  const owner = value?.owner as string | undefined;
  if (!value || owner !== TOKEN_PROGRAM) {
    return null;
  }
  const data = value?.data;
  if (!Array.isArray(data) || typeof data[0] !== 'string') {
    return null;
  }
  return parseMintAccountData(data[0]);
}

async function fetchMetadataPresence(_fetchImpl: typeof fetch, _rpcUrl: string, _mint: string): Promise<MetadataPresence> {
  return 'UNKNOWN';
}

async function fetchLargestHolders(fetchImpl: typeof fetch, rpcUrl: string, mint: string): Promise<SolanaLargestHolderInfo[] | null> {
  const result = await rpcRequest(fetchImpl, rpcUrl, 'getTokenLargestAccounts', [mint]);
  if (!Array.isArray(result?.value)) {
    return null;
  }
  return result.value as SolanaLargestHolderInfo[];
}

async function fetchQuoteAvailability(fetchImpl: typeof fetch, quoteBaseUrl: string, mint: string): Promise<{ availability: AvailabilityStatus; slippageBps: number | null }> {
  const response = await fetchImpl(`${quoteBaseUrl}/${mint}`, {
    headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' }
  });

  if (response.status === 429) {
    return { availability: 'UNKNOWN', slippageBps: null };
  }
  if (!response.ok) {
    return { availability: 'NO', slippageBps: null };
  }

  const data = await response.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const solanaPairs = pairs.filter((pair: any) => pair?.chainId === 'solana' && pair?.baseToken?.address === mint);
  if (solanaPairs.length === 0) {
    return { availability: 'NO', slippageBps: null };
  }

  const best = solanaPairs.sort((a: any, b: any) => (Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0)))[0];
  const liquidityUsd = Number(best?.liquidity?.usd ?? 0);
  let slippageBps: number | null = null;
  if (Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
    slippageBps = Math.min(5000, Math.max(25, Math.round((10000 * 1000) / liquidityUsd)));
  }

  return { availability: 'YES', slippageBps };
}

export async function getSolanaSafetyEnrichment(mint: string, config: AppConfig, options: SolanaSafetyOptions = {}): Promise<SolanaSafetyEnrichment> {
  const notes: string[] = [];
  const raw: Record<string, unknown> = {};
  const rpcFetch = options.rpcFetch ?? fetch;
  const quoteFetch = options.quoteFetch ?? fetch;
  const rpcUrl = options.rpcUrl ?? config.solanaRpcUrl;
  const quoteBaseUrl = options.quoteBaseUrl ?? DEFAULT_QUOTE_BASE_URL;
  const enableQuoteCheck = options.enableQuoteCheck ?? config.enableQuoteCheck;
  const timeoutMs = options.timeoutMs ?? config.safetyEnrichmentTimeoutMs;
  raw.timeoutMs = timeoutMs;

  if (!rpcUrl) {
    return {
      mintAuthority: 'UNKNOWN',
      freezeAuthority: 'UNKNOWN',
      mintAuthorityRenounced: null,
      freezeAuthorityRenounced: null,
      tokenProgram: null,
      supply: null,
      decimals: null,
      metadataStatus: 'UNKNOWN',
      metadataPresent: false,
      holderCount: null,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentration: 'UNKNOWN',
      creatorAddress: null,
      creatorStatus: 'UNKNOWN',
      lpOrPoolAddress: null,
      poolAgeMinutes: null,
      sellQuoteAvailable: 'UNKNOWN',
      estimatedSlippageBps: null,
      redFlags: ['rpc url missing'],
      notes: ['SOLANA_RPC_URL not configured'],
      raw: { reason: 'missing_rpc_url' }
    };
  }

  let mintInfo: SolanaMintAccountInfo | null = null;
  let metadataStatus: MetadataPresence = 'UNKNOWN';
  let holderConcentration: ConcentrationStatus = 'UNKNOWN';
  let holderConcentrationLevel: HolderConcentrationLevel = 'UNKNOWN';
  let holderCount: number | null = null;
  let topHolderPct: number | null = null;
  let top10HolderPct: number | null = null;
  let creatorAddress: string | null = null;
  let creatorStatus: CreatorStatus = 'UNKNOWN';
  let lpOrPoolAddress: string | null = null;
  let poolAgeMinutes: number | null = null;
  notes.push('creator/deployer not determined reliably from current read-only data');
  let sellQuoteAvailable: AvailabilityStatus = 'UNKNOWN';
  let estimatedSlippageBps: number | null = null;
  const redFlags: string[] = [];

  try {
    mintInfo = await withTimeout(fetchMintInfo(rpcFetch, rpcUrl, mint), timeoutMs);
    raw.mintInfo = mintInfo;
    if (!mintInfo) {
      notes.push('mint account missing or unavailable');
      redFlags.push('mint account missing or unavailable');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'mint info lookup failed';
    notes.push(message);
    redFlags.push('mint info lookup failed');
  }

  try {
    metadataStatus = await withTimeout(fetchMetadataPresence(rpcFetch, rpcUrl, mint), timeoutMs);
    raw.metadataStatus = metadataStatus;
  } catch (error) {
    notes.push(error instanceof Error ? error.message : 'metadata lookup failed');
  }

  try {
    const largestHolders = await withTimeout(fetchLargestHolders(rpcFetch, rpcUrl, mint), timeoutMs);
    raw.largestHolders = largestHolders;
    const concentration = deriveHolderConcentration(largestHolders, mintInfo);
    holderConcentration = concentration.status;
    holderConcentrationLevel = concentration.level;
    holderCount = concentration.holderCount;
    topHolderPct = concentration.topHolderPct;
    top10HolderPct = concentration.top10HolderPct;
    notes.push(...concentration.notes);
    if (concentration.level === 'HIGH') redFlags.push('high holder concentration');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'largest holders lookup failed';
    notes.push(message);
    redFlags.push('holder concentration lookup failed');
  }

  if (enableQuoteCheck) {
    try {
      const quoteResult = await withTimeout(fetchQuoteAvailability(quoteFetch, quoteBaseUrl, mint), timeoutMs);
      sellQuoteAvailable = quoteResult.availability;
      estimatedSlippageBps = quoteResult.slippageBps;
      raw.quote = quoteResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'quote check failed';
      notes.push(message);
      redFlags.push('quote check failed');
    }
  } else {
    notes.push('quote check disabled');
  }

  const mintAuthority = deriveAuthorityStatus(mintInfo?.mintAuthorityOption, mintInfo?.mintAuthority);
  const freezeAuthority = deriveAuthorityStatus(mintInfo?.freezeAuthorityOption, mintInfo?.freezeAuthority);
  if (mintAuthority === 'UNSAFE') redFlags.push('mint authority active');
  if (freezeAuthority === 'UNSAFE') redFlags.push('freeze authority active');
  if (mintAuthority === 'UNKNOWN') redFlags.push('mint authority unknown');
  if (freezeAuthority === 'UNKNOWN') redFlags.push('freeze authority unknown');
  if (holderConcentration === 'UNKNOWN') redFlags.push('holder concentration unknown');
  if (sellQuoteAvailable === 'UNKNOWN') redFlags.push('sellability unknown');

  return {
    mintAuthority,
    freezeAuthority,
    mintAuthorityRenounced: mintInfo?.mintAuthorityOption === undefined ? null : mintInfo.mintAuthorityOption === 0,
    freezeAuthorityRenounced: mintInfo?.freezeAuthorityOption === undefined ? null : mintInfo.freezeAuthorityOption === 0,
    tokenProgram: TOKEN_PROGRAM,
    supply: mintInfo?.supply ?? null,
    decimals: mintInfo?.decimals ?? null,
    metadataStatus,
    metadataPresent: metadataStatus === 'YES',
    holderCount,
    topHolderPct,
    top10HolderPct,
    holderConcentrationLevel,
    holderConcentration,
    creatorAddress,
    creatorStatus,
    lpOrPoolAddress,
    poolAgeMinutes,
    sellQuoteAvailable,
    estimatedSlippageBps,
    redFlags,
    notes,
    raw
  };
}

export function applyEnrichment(candidate: TokenCandidate, enrichment: SolanaSafetyEnrichment): TokenCandidate {
  return {
    ...candidate,
    mintAuthority: enrichment.mintAuthority,
    freezeAuthority: enrichment.freezeAuthority,
    metadataPresent: enrichment.metadataStatus === 'UNKNOWN' ? candidate.metadataPresent : enrichment.metadataPresent,
    metadataStatus: enrichment.metadataStatus,
    holderConcentration: enrichment.holderConcentration,
    creatorStatus: enrichment.creatorStatus,
    sellQuoteAvailable: enrichment.sellQuoteAvailable,
    estimatedSlippageBps: enrichment.estimatedSlippageBps,
    raw: {
      ...candidate.raw,
      enrichment: enrichment.raw,
      enrichmentNotes: enrichment.notes,
      safetyEnrichment: {
        mintAuthorityRenounced: enrichment.mintAuthorityRenounced,
        freezeAuthorityRenounced: enrichment.freezeAuthorityRenounced,
        tokenProgram: enrichment.tokenProgram,
        supply: enrichment.supply,
        decimals: enrichment.decimals,
        holderCount: enrichment.holderCount,
        topHolderPct: enrichment.topHolderPct,
        top10HolderPct: enrichment.top10HolderPct,
        holderConcentrationLevel: enrichment.holderConcentrationLevel,
        creatorAddress: enrichment.creatorAddress,
        lpOrPoolAddress: enrichment.lpOrPoolAddress,
        poolAgeMinutes: enrichment.poolAgeMinutes,
        redFlags: enrichment.redFlags
      }
    }
  };
}
