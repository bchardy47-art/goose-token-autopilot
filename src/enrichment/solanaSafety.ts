import type {
  AppConfig,
  AuthorityStatus,
  AvailabilityStatus,
  ConcentrationStatus,
  CreatorStatus,
  HolderConcentrationLevel,
  MetadataPresence,
  TokenCandidate
} from '../types';

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

export interface SolanaAuthorityNormalization {
  status: AuthorityStatus;
  renounced: boolean | null;
}

export interface ParsedMintAccountInfoFromRpc {
  success: boolean;
  error: string | null;
  accountExists: boolean;
  ownerProgram: string | null;
  executable: boolean | null;
  lamports: number | null;
  parsedType: string | null;
  accountDataShape: 'parsed-object' | 'encoded-array' | 'unknown';
  topLevelKeys: string[];
  rawMintAuthorityOption: number | null;
  rawMintAuthority: string | null;
  rawFreezeAuthorityOption: number | null;
  rawFreezeAuthority: string | null;
  rawSupply: string | null;
  rawDecimals: number | null;
  tokenProgram: string | null;
  mintInfo: SolanaMintAccountInfo | null;
  raw: Record<string, unknown>;
}

export interface ParsedLargestTokenAccountsFromRpc {
  success: boolean;
  error: string | null;
  holderCount: number | null;
  topHolderPct: number | null;
  top10HolderPct: number | null;
  holderConcentrationLevel: HolderConcentrationLevel;
  holderConcentrationStatus: ConcentrationStatus;
  accounts: SolanaLargestHolderInfo[];
  raw: Record<string, unknown>;
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
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
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

export function normalizeMintAuthority(mintInfo: SolanaMintAccountInfo | null): SolanaAuthorityNormalization {
  if (!mintInfo) return { status: 'UNKNOWN', renounced: null };
  if (mintInfo.mintAuthorityOption === 0 || mintInfo.mintAuthority === null) return { status: 'SAFE', renounced: true };
  if (typeof mintInfo.mintAuthority === 'string' && mintInfo.mintAuthority.length > 0) return { status: 'UNSAFE', renounced: false };
  return { status: 'UNKNOWN', renounced: null };
}

export function normalizeFreezeAuthority(mintInfo: SolanaMintAccountInfo | null): SolanaAuthorityNormalization {
  if (!mintInfo) return { status: 'UNKNOWN', renounced: null };
  if (mintInfo.freezeAuthorityOption === 0 || mintInfo.freezeAuthority === null) return { status: 'SAFE', renounced: true };
  if (typeof mintInfo.freezeAuthority === 'string' && mintInfo.freezeAuthority.length > 0) return { status: 'UNSAFE', renounced: false };
  return { status: 'UNKNOWN', renounced: null };
}

export function computeHolderConcentration(topHolderPct: number | null, top10HolderPct: number | null): { level: HolderConcentrationLevel; status: ConcentrationStatus; notes: string[] } {
  if (topHolderPct === null || top10HolderPct === null) {
    return { level: 'UNKNOWN', status: 'UNKNOWN', notes: ['holder concentration data unavailable'] };
  }
  if (top10HolderPct >= 80 || topHolderPct >= 50) {
    return {
      level: 'HIGH',
      status: 'RISKY',
      notes: [`holder concentration high: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
    };
  }
  if (top10HolderPct >= 50 || topHolderPct >= 20) {
    return {
      level: 'MEDIUM',
      status: 'RISKY',
      notes: [`holder concentration medium: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
    };
  }
  return {
    level: 'LOW',
    status: 'SAFE',
    notes: [`holder concentration low: top holder ${topHolderPct.toFixed(2)}%, top 10 ${top10HolderPct.toFixed(2)}%`]
  };
}

function nestedInfoCandidates(info: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [info];
  for (const key of ['extensions', 'parsed', 'base', 'mintInfo', 'info']) {
    const value = info[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push(value as Record<string, unknown>);
    }
  }
  return candidates;
}

function ownerSupportsRawBinary(ownerProgram: string | null): boolean {
  return ownerProgram === TOKEN_PROGRAM;
}

function toParsedMintInfoFromInfo(info: Record<string, unknown>): SolanaMintAccountInfo | null {
  for (const candidate of nestedInfoCandidates(info)) {
    const supplyValue = candidate.supply as string | number | undefined;
    const decimalsValue = candidate.decimals as number | undefined;
    const mintAuthority = typeof candidate.mintAuthority === 'string' ? candidate.mintAuthority : null;
    const freezeAuthority = typeof candidate.freezeAuthority === 'string' ? candidate.freezeAuthority : null;
    const hasMintAuthorityKey = Object.prototype.hasOwnProperty.call(candidate, 'mintAuthority');
    const hasFreezeAuthorityKey = Object.prototype.hasOwnProperty.call(candidate, 'freezeAuthority');

    if (!hasMintAuthorityKey && !hasFreezeAuthorityKey && supplyValue === undefined && decimalsValue === undefined) {
      continue;
    }

    return {
      mintAuthorityOption: hasMintAuthorityKey ? (mintAuthority === null ? 0 : 1) : undefined,
      mintAuthority,
      supply: supplyValue === undefined ? undefined : String(supplyValue),
      decimals: typeof decimalsValue === 'number' ? decimalsValue : undefined,
      isInitialized: typeof candidate.isInitialized === 'boolean' ? candidate.isInitialized : undefined,
      freezeAuthorityOption: hasFreezeAuthorityKey ? (freezeAuthority === null ? 0 : 1) : undefined,
      freezeAuthority
    };
  }
  return null;
}

export function parseMintAccountInfoFromRpcResult(result: any): ParsedMintAccountInfoFromRpc {
  const value = result?.value ?? null;
  if (!value) {
    return {
      success: true,
      error: null,
      accountExists: false,
      ownerProgram: null,
      executable: null,
      lamports: null,
      parsedType: null,
      accountDataShape: 'unknown',
      topLevelKeys: [],
      rawMintAuthorityOption: null,
      rawMintAuthority: null,
      rawFreezeAuthorityOption: null,
      rawFreezeAuthority: null,
      rawSupply: null,
      rawDecimals: null,
      tokenProgram: null,
      mintInfo: null,
      raw: { result }
    };
  }

  const ownerProgram = typeof value.owner === 'string' ? value.owner : null;
  const executable = typeof value.executable === 'boolean' ? value.executable : null;
  const lamports = typeof value.lamports === 'number' ? value.lamports : null;
  const data = value.data;
  const topLevelKeys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data as Record<string, unknown>).slice(0, 20) : [];

  try {
    const isSupportedProgram = ownerProgram === TOKEN_PROGRAM || ownerProgram === TOKEN_2022_PROGRAM;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const program = typeof (data as any).program === 'string' ? (data as any).program : null;
      const parsed = (data as any).parsed;
      const parsedType = typeof parsed?.type === 'string' ? parsed.type : null;
      const parsedInfo = parsed?.info && typeof parsed.info === 'object' && !Array.isArray(parsed.info)
        ? parsed.info as Record<string, unknown>
        : null;

      if (isSupportedProgram && parsedInfo) {
        const mintInfo = toParsedMintInfoFromInfo(parsedInfo);
        if (mintInfo) {
          return {
            success: true,
            error: null,
            accountExists: true,
            ownerProgram,
            executable,
            lamports,
            parsedType,
            accountDataShape: 'parsed-object',
            topLevelKeys,
            rawMintAuthorityOption: mintInfo.mintAuthorityOption ?? null,
            rawMintAuthority: mintInfo.mintAuthority ?? null,
            rawFreezeAuthorityOption: mintInfo.freezeAuthorityOption ?? null,
            rawFreezeAuthority: mintInfo.freezeAuthority ?? null,
            rawSupply: mintInfo.supply ?? null,
            rawDecimals: mintInfo.decimals ?? null,
            tokenProgram: ownerProgram ?? program,
            mintInfo,
            raw: { ownerProgram, topLevelKeys, parsedType, program }
          };
        }
      }

      return {
        success: false,
        error: isSupportedProgram ? 'encoded mint data not parsed by RPC' : 'unsupported mint rpc data shape',
        accountExists: true,
        ownerProgram,
        executable,
        lamports,
        parsedType,
        accountDataShape: 'parsed-object',
        topLevelKeys,
        rawMintAuthorityOption: null,
        rawMintAuthority: null,
        rawFreezeAuthorityOption: null,
        rawFreezeAuthority: null,
        rawSupply: null,
        rawDecimals: null,
        tokenProgram: ownerProgram,
        mintInfo: null,
        raw: { ownerProgram, topLevelKeys, parsedType, program }
      };
    }

    if (Array.isArray(data) && typeof data[0] === 'string') {
      if (ownerSupportsRawBinary(ownerProgram)) {
        const mintInfo = parseMintAccountData(data[0]);
        return {
          success: true,
          error: null,
          accountExists: true,
          ownerProgram,
          executable,
          lamports,
          parsedType: null,
          accountDataShape: 'encoded-array',
          topLevelKeys,
          rawMintAuthorityOption: mintInfo.mintAuthorityOption ?? null,
          rawMintAuthority: mintInfo.mintAuthority ?? null,
          rawFreezeAuthorityOption: mintInfo.freezeAuthorityOption ?? null,
          rawFreezeAuthority: mintInfo.freezeAuthority ?? null,
          rawSupply: mintInfo.supply ?? null,
          rawDecimals: mintInfo.decimals ?? null,
          tokenProgram: ownerProgram,
          mintInfo,
          raw: { ownerProgram, encoding: data[1] ?? null }
        };
      }
      return {
        success: false,
        error: 'encoded mint data not parsed by RPC',
        accountExists: true,
        ownerProgram,
        executable,
        lamports,
        parsedType: null,
        accountDataShape: 'encoded-array',
        topLevelKeys,
        rawMintAuthorityOption: null,
        rawMintAuthority: null,
        rawFreezeAuthorityOption: null,
        rawFreezeAuthority: null,
        rawSupply: null,
        rawDecimals: null,
        tokenProgram: ownerProgram,
        mintInfo: null,
        raw: { ownerProgram, encoding: data[1] ?? null }
      };
    }

    return {
      success: false,
      error: 'unsupported mint rpc data shape',
      accountExists: true,
      ownerProgram,
      executable,
      lamports,
      parsedType: null,
      accountDataShape: 'unknown',
      topLevelKeys,
      rawMintAuthorityOption: null,
      rawMintAuthority: null,
      rawFreezeAuthorityOption: null,
      rawFreezeAuthority: null,
      rawSupply: null,
      rawDecimals: null,
      tokenProgram: ownerProgram,
      mintInfo: null,
      raw: { ownerProgram, topLevelKeys }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'mint rpc parse failed',
      accountExists: true,
      ownerProgram,
      executable,
      lamports,
      parsedType: null,
      accountDataShape: 'unknown',
      topLevelKeys,
      rawMintAuthorityOption: null,
      rawMintAuthority: null,
      rawFreezeAuthorityOption: null,
      rawFreezeAuthority: null,
      rawSupply: null,
      rawDecimals: null,
      tokenProgram: ownerProgram,
      mintInfo: null,
      raw: { ownerProgram, topLevelKeys }
    };
  }
}

export function parseLargestTokenAccountsFromRpcResult(result: any, mintInfo: SolanaMintAccountInfo | null): ParsedLargestTokenAccountsFromRpc {
  const values = Array.isArray(result?.value) ? (result.value as SolanaLargestHolderInfo[]) : null;
  if (!values) {
    return {
      success: false,
      error: 'largest accounts missing',
      holderCount: null,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentrationStatus: 'UNKNOWN',
      accounts: [],
      raw: { result }
    };
  }

  if (!mintInfo?.supply) {
    return {
      success: false,
      error: 'mint supply unavailable for holder concentration',
      holderCount: values.length,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentrationStatus: 'UNKNOWN',
      accounts: values,
      raw: { result }
    };
  }

  const supplyRaw = Number(mintInfo.supply);
  const decimals = mintInfo.decimals ?? 0;
  const normalizedSupply = supplyRaw / Math.pow(10, decimals);
  if (!Number.isFinite(normalizedSupply) || normalizedSupply <= 0) {
    return {
      success: false,
      error: 'normalized supply unavailable for holder concentration',
      holderCount: values.length,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentrationStatus: 'UNKNOWN',
      accounts: values,
      raw: { result }
    };
  }

  const amounts = values
    .map((holder) => holder.uiAmount ?? (holder.uiAmountString ? Number(holder.uiAmountString) : Number(holder.amount ?? 0) / Math.pow(10, decimals)))
    .filter((amount): amount is number => Number.isFinite(amount) && amount >= 0);

  if (amounts.length === 0) {
    return {
      success: false,
      error: 'largest holder amount unavailable',
      holderCount: values.length,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentrationStatus: 'UNKNOWN',
      accounts: values,
      raw: { result }
    };
  }

  const topHolderPct = Number(((amounts[0] / normalizedSupply) * 100).toFixed(4));
  const top10HolderPct = Number(((amounts.slice(0, 10).reduce((sum, value) => sum + value, 0) / normalizedSupply) * 100).toFixed(4));
  const concentration = computeHolderConcentration(topHolderPct, top10HolderPct);

  return {
    success: true,
    error: null,
    holderCount: values.length,
    topHolderPct,
    top10HolderPct,
    holderConcentrationLevel: concentration.level,
    holderConcentrationStatus: concentration.status,
    accounts: values,
    raw: { result }
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

export async function fetchMintAccountRpcResult(fetchImpl: typeof fetch, rpcUrl: string, mint: string): Promise<any> {
  return rpcRequest(fetchImpl, rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
}

export async function fetchLargestTokenAccountsRpcResult(fetchImpl: typeof fetch, rpcUrl: string, mint: string): Promise<any> {
  return rpcRequest(fetchImpl, rpcUrl, 'getTokenLargestAccounts', [mint]);
}

export const solanaSafetyRpcHelpers = {
  fetchMintAccountRpcResult,
  fetchLargestTokenAccountsRpcResult,
  parseMintAccountInfoFromRpcResult,
  parseLargestTokenAccountsFromRpcResult,
  normalizeMintAuthority,
  normalizeFreezeAuthority,
  computeHolderConcentration
};

async function fetchMetadataPresence(_fetchImpl: typeof fetch, _rpcUrl: string, _mint: string): Promise<MetadataPresence> {
  return 'UNKNOWN';
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

  let parsedMint: ParsedMintAccountInfoFromRpc = {
    success: false,
    error: null,
    accountExists: false,
    ownerProgram: null,
    executable: null,
    lamports: null,
    parsedType: null,
    rawMintAuthorityOption: null,
    rawMintAuthority: null,
    rawFreezeAuthorityOption: null,
    rawFreezeAuthority: null,
    rawSupply: null,
    rawDecimals: null,
    tokenProgram: null,
    mintInfo: null,
    raw: {}
  };
  let metadataStatus: MetadataPresence = 'UNKNOWN';
  let parsedLargest: ParsedLargestTokenAccountsFromRpc = {
    success: false,
    error: null,
    holderCount: null,
    topHolderPct: null,
    top10HolderPct: null,
    holderConcentrationLevel: 'UNKNOWN',
    holderConcentrationStatus: 'UNKNOWN',
    accounts: [],
    raw: {}
  };
  let creatorAddress: string | null = null;
  let creatorStatus: CreatorStatus = 'UNKNOWN';
  let sellQuoteAvailable: AvailabilityStatus = 'UNKNOWN';
  let estimatedSlippageBps: number | null = null;
  const redFlags: string[] = [];
  notes.push('creator/deployer not determined reliably from current read-only data');

  try {
    const mintRpcResult = await withTimeout(solanaSafetyRpcHelpers.fetchMintAccountRpcResult(rpcFetch, rpcUrl, mint), timeoutMs);
    parsedMint = solanaSafetyRpcHelpers.parseMintAccountInfoFromRpcResult(mintRpcResult);
    raw.mintRpcResult = parsedMint.raw;
    if (!parsedMint.success && parsedMint.error) {
      notes.push(parsedMint.error);
      redFlags.push('mint info lookup failed');
    }
    if (!parsedMint.accountExists) {
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
    const largestRpcResult = await withTimeout(solanaSafetyRpcHelpers.fetchLargestTokenAccountsRpcResult(rpcFetch, rpcUrl, mint), timeoutMs);
    parsedLargest = solanaSafetyRpcHelpers.parseLargestTokenAccountsFromRpcResult(largestRpcResult, parsedMint.mintInfo);
    raw.largestAccountsRpcResult = parsedLargest.raw;
    if (!parsedLargest.success && parsedLargest.error) {
      notes.push(parsedLargest.error);
      redFlags.push('holder concentration lookup failed');
    }
    const concentrationNotes = computeHolderConcentration(parsedLargest.topHolderPct, parsedLargest.top10HolderPct).notes;
    notes.push(...concentrationNotes);
    if (parsedLargest.holderConcentrationLevel === 'HIGH') redFlags.push('high holder concentration');
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

  const mintAuthority = normalizeMintAuthority(parsedMint.mintInfo);
  const freezeAuthority = normalizeFreezeAuthority(parsedMint.mintInfo);
  if (mintAuthority.status === 'UNSAFE') redFlags.push('mint authority active');
  if (freezeAuthority.status === 'UNSAFE') redFlags.push('freeze authority active');
  if (mintAuthority.status === 'UNKNOWN') redFlags.push('mint authority unknown');
  if (freezeAuthority.status === 'UNKNOWN') redFlags.push('freeze authority unknown');
  if (parsedLargest.holderConcentrationStatus === 'UNKNOWN') redFlags.push('holder concentration unknown');
  if (sellQuoteAvailable === 'UNKNOWN') redFlags.push('sellability unknown');

  return {
    mintAuthority: mintAuthority.status,
    freezeAuthority: freezeAuthority.status,
    mintAuthorityRenounced: mintAuthority.renounced,
    freezeAuthorityRenounced: freezeAuthority.renounced,
    tokenProgram: parsedMint.tokenProgram,
    supply: parsedMint.rawSupply,
    decimals: parsedMint.rawDecimals,
    metadataStatus,
    metadataPresent: metadataStatus === 'YES',
    holderCount: parsedLargest.holderCount,
    topHolderPct: parsedLargest.topHolderPct,
    top10HolderPct: parsedLargest.top10HolderPct,
    holderConcentrationLevel: parsedLargest.holderConcentrationLevel,
    holderConcentration: parsedLargest.holderConcentrationStatus,
    creatorAddress,
    creatorStatus,
    lpOrPoolAddress: null,
    poolAgeMinutes: null,
    sellQuoteAvailable,
    estimatedSlippageBps,
    redFlags: [...new Set(redFlags)],
    notes,
    raw: {
      ...raw,
      parsedMint,
      parsedLargest
    }
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
