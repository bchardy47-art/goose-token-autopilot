import type { AppConfig, AuthorityStatus, AvailabilityStatus, ConcentrationStatus, CreatorStatus, MetadataPresence, TokenCandidate } from '../types';

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
  metadataStatus: MetadataPresence;
  metadataPresent: boolean;
  holderConcentration: ConcentrationStatus;
  creatorStatus: CreatorStatus;
  sellQuoteAvailable: AvailabilityStatus;
  estimatedSlippageBps: number | null;
  notes: string[];
  raw: Record<string, unknown>;
}

export interface SolanaSafetyOptions {
  rpcFetch?: typeof fetch;
  quoteFetch?: typeof fetch;
  rpcUrl?: string;
  quoteBaseUrl?: string;
  enableQuoteCheck?: boolean;
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEFAULT_QUOTE_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

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

export function deriveHolderConcentration(largestHolders: SolanaLargestHolderInfo[] | null, mintInfo: SolanaMintAccountInfo | null): { status: ConcentrationStatus; notes: string[] } {
  if (!largestHolders || largestHolders.length === 0 || !mintInfo?.supply) {
    return { status: 'UNKNOWN', notes: ['holder concentration data unavailable'] };
  }

  const supplyRaw = Number(mintInfo.supply);
  if (!Number.isFinite(supplyRaw) || supplyRaw <= 0) {
    return { status: 'UNKNOWN', notes: ['mint supply unavailable for holder concentration'] };
  }

  const decimals = mintInfo.decimals ?? 0;
  const normalizedSupply = supplyRaw / Math.pow(10, decimals);
  if (!Number.isFinite(normalizedSupply) || normalizedSupply <= 0) {
    return { status: 'UNKNOWN', notes: ['normalized supply unavailable for holder concentration'] };
  }

  const topHolderAmount = largestHolders
    .map((holder) => holder.uiAmount ?? (holder.uiAmountString ? Number(holder.uiAmountString) : Number(holder.amount ?? 0)))
    .find((amount) => Number.isFinite(amount) && amount >= 0);

  if (topHolderAmount === undefined) {
    return { status: 'UNKNOWN', notes: ['largest holder amount unavailable'] };
  }

  const topHolderPct = (topHolderAmount / normalizedSupply) * 100;
  if (topHolderPct >= 25) {
    return { status: 'RISKY', notes: [`top holder concentration high at ${topHolderPct.toFixed(2)}%`] };
  }

  return { status: 'SAFE', notes: [`top holder concentration acceptable at ${topHolderPct.toFixed(2)}%`] };
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

  if (!rpcUrl) {
    return {
      mintAuthority: 'UNKNOWN',
      freezeAuthority: 'UNKNOWN',
      metadataStatus: 'UNKNOWN',
      metadataPresent: false,
      holderConcentration: 'UNKNOWN',
      creatorStatus: 'UNKNOWN',
      sellQuoteAvailable: 'UNKNOWN',
      estimatedSlippageBps: null,
      notes: ['SOLANA_RPC_URL not configured'],
      raw: { reason: 'missing_rpc_url' }
    };
  }

  let mintInfo: SolanaMintAccountInfo | null = null;
  let metadataStatus: MetadataPresence = 'UNKNOWN';
  let holderConcentration: ConcentrationStatus = 'UNKNOWN';
  let creatorStatus: CreatorStatus = 'UNKNOWN';
  let sellQuoteAvailable: AvailabilityStatus = 'UNKNOWN';
  let estimatedSlippageBps: number | null = null;

  try {
    mintInfo = await fetchMintInfo(rpcFetch, rpcUrl, mint);
    raw.mintInfo = mintInfo;
    if (!mintInfo) {
      notes.push('mint account missing or unavailable');
    }
  } catch (error) {
    notes.push(error instanceof Error ? error.message : 'mint info lookup failed');
  }

  try {
    metadataStatus = await fetchMetadataPresence(rpcFetch, rpcUrl, mint);
    raw.metadataStatus = metadataStatus;
  } catch (error) {
    notes.push(error instanceof Error ? error.message : 'metadata lookup failed');
  }

  try {
    const largestHolders = await fetchLargestHolders(rpcFetch, rpcUrl, mint);
    raw.largestHolders = largestHolders;
    const concentration = deriveHolderConcentration(largestHolders, mintInfo);
    holderConcentration = concentration.status;
    notes.push(...concentration.notes);
  } catch (error) {
    notes.push(error instanceof Error ? error.message : 'largest holders lookup failed');
  }

  if (enableQuoteCheck) {
    try {
      const quoteResult = await fetchQuoteAvailability(quoteFetch, quoteBaseUrl, mint);
      sellQuoteAvailable = quoteResult.availability;
      estimatedSlippageBps = quoteResult.slippageBps;
      raw.quote = quoteResult;
    } catch (error) {
      notes.push(error instanceof Error ? error.message : 'quote check failed');
    }
  } else {
    notes.push('quote check disabled');
  }

  return {
    mintAuthority: deriveAuthorityStatus(mintInfo?.mintAuthorityOption, mintInfo?.mintAuthority),
    freezeAuthority: deriveAuthorityStatus(mintInfo?.freezeAuthorityOption, mintInfo?.freezeAuthority),
    metadataStatus,
    metadataPresent: metadataStatus === 'YES',
    holderConcentration,
    creatorStatus,
    sellQuoteAvailable,
    estimatedSlippageBps,
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
      enrichmentNotes: enrichment.notes
    }
  };
}
