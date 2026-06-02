import { redactString } from './redact';
import type { AppDb } from './db';
import type { AppConfig, WatchOnlySignalClass } from './types';
import {
  fetchLargestTokenAccountsRpcResult,
  fetchMintAccountRpcResult,
  normalizeFreezeAuthority,
  normalizeMintAuthority,
  parseLargestTokenAccountsFromRpcResult,
  parseMintAccountInfoFromRpcResult,
  solanaSafetyRpcHelpers
} from './enrichment/solanaSafety';

const DEFAULT_LIMIT = 5;

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return fallback;
  return value;
}

function parseFormat(raw: string | undefined): 'json' | 'table' {
  return raw === 'table' ? 'table' : 'json';
}

function parseClass(raw: string | undefined): WatchOnlySignalClass | null {
  const allowed: WatchOnlySignalClass[] = ['EARLY_RUNNER', 'LATE_RUNNER', 'INSTANT_DUMP', 'DEAD_NOISE', 'TOO_DANGEROUS'];
  return allowed.includes(raw as WatchOnlySignalClass) ? (raw as WatchOnlySignalClass) : null;
}

function redactRpcUrlConfigured(rpcUrl: string | undefined): { rpcUrlConfigured: boolean; rpcUrlDisplay: string | null } {
  if (!rpcUrl) return { rpcUrlConfigured: false, rpcUrlDisplay: null };
  return { rpcUrlConfigured: true, rpcUrlDisplay: redactString(rpcUrl) === rpcUrl ? '[CONFIGURED]' : redactString(rpcUrl) };
}

function selectTokenIds(db: AppDb, env: NodeJS.ProcessEnv): number[] {
  const tokenIdOverride = env.SAFETY_RPC_PROOF_TOKEN_ID ? Number(env.SAFETY_RPC_PROOF_TOKEN_ID) : null;
  if (tokenIdOverride && Number.isFinite(tokenIdOverride)) return [tokenIdOverride];

  const mintOverride = env.SAFETY_RPC_PROOF_MINT?.trim();
  if (mintOverride) {
    const found = db.findTokenByMint(mintOverride);
    return found ? [found.id] : [];
  }

  const classFilter = parseClass(env.SAFETY_RPC_PROOF_CLASS);
  const analyses = new Map(db.listWatchOnlySignalAnalyses().map((row) => [row.tokenId, row.signalClass]));
  const candidates = db.listWatchOnlyCandidates();
  const filtered = classFilter
    ? candidates.filter((candidate) => analyses.get(candidate.tokenId) === classFilter)
    : candidates;
  return filtered.slice(0, parsePositiveInteger(env.SAFETY_RPC_PROOF_LIMIT, DEFAULT_LIMIT)).map((candidate) => candidate.tokenId);
}

export async function buildSafetyRpcProofReport(db: AppDb, config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const { rpcUrlConfigured, rpcUrlDisplay } = redactRpcUrlConfigured(config.solanaRpcUrl);
  if (!config.solanaRpcUrl) {
    return {
      message: 'No SOLANA_RPC_URL configured. Cannot prove RPC parser.',
      rpcUrlConfigured: false,
      rpcUrlDisplay,
      rows: [],
      finalSafetyStatus: 'Real trading remains locked.'
    };
  }

  const tokenIds = selectTokenIds(db, env);
  const analysesByToken = new Map(db.listWatchOnlySignalAnalyses().map((row) => [row.tokenId, row.signalClass]));
  const rows = [] as Array<Record<string, unknown>>;

  for (const tokenId of tokenIds) {
    const token = db.getTokenRecord(tokenId);
    const snapshot = db.getLatestSnapshot(tokenId);
    if (!token || !snapshot) continue;

    let mintParsed = {
      success: false,
      error: 'not-run',
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
      raw: {}
    } as ReturnType<typeof parseMintAccountInfoFromRpcResult>;
    let largestParsed = {
      success: false,
      error: 'not-run',
      holderCount: null,
      topHolderPct: null,
      top10HolderPct: null,
      holderConcentrationLevel: 'UNKNOWN',
      holderConcentrationStatus: 'UNKNOWN',
      accounts: [],
      raw: {}
    } as ReturnType<typeof parseLargestTokenAccountsFromRpcResult>;
    let rawErrorSummary: string | null = null;

    try {
      const mintRpcResult = await solanaSafetyRpcHelpers.fetchMintAccountRpcResult(fetch, config.solanaRpcUrl, snapshot.mint);
      mintParsed = solanaSafetyRpcHelpers.parseMintAccountInfoFromRpcResult(mintRpcResult);
    } catch (error) {
      rawErrorSummary = error instanceof Error ? error.message : 'mint rpc failed';
    }

    try {
      const largestRpcResult = await solanaSafetyRpcHelpers.fetchLargestTokenAccountsRpcResult(fetch, config.solanaRpcUrl, snapshot.mint);
      largestParsed = solanaSafetyRpcHelpers.parseLargestTokenAccountsFromRpcResult(largestRpcResult, mintParsed.mintInfo);
    } catch (error) {
      rawErrorSummary = [rawErrorSummary, error instanceof Error ? error.message : 'largest accounts rpc failed'].filter(Boolean).join('; ');
    }

    const normalizedMint = normalizeMintAuthority(mintParsed.mintInfo);
    const normalizedFreeze = normalizeFreezeAuthority(mintParsed.mintInfo);
    const latestEnrichment = db.getLatestSolanaSafetyEnrichment(tokenId);
    const auditUsesEnrichment = latestEnrichment !== null && (
      latestEnrichment.mintAuthority !== 'UNKNOWN' ||
      latestEnrichment.freezeAuthority !== 'UNKNOWN' ||
      latestEnrichment.holderConcentrationStatus !== 'UNKNOWN'
    );

    rows.push({
      tokenId,
      symbol: token.symbol,
      mint: token.mint,
      signalClass: analysesByToken.get(tokenId) ?? null,
      sourceUrl: token.source_url,
      rpcUrlConfigured,
      rpcUrlDisplay,
      getParsedAccountInfo: {
        status: mintParsed.success ? 'success' : 'error',
        accountExists: mintParsed.accountExists,
        ownerProgram: mintParsed.ownerProgram,
        executable: mintParsed.executable,
        lamports: mintParsed.lamports,
        parsedType: mintParsed.parsedType,
        accountDataShape: mintParsed.accountDataShape,
        topLevelKeys: mintParsed.topLevelKeys,
        rawMintAuthorityOption: mintParsed.rawMintAuthorityOption,
        rawMintAuthority: mintParsed.rawMintAuthority,
        rawFreezeAuthorityOption: mintParsed.rawFreezeAuthorityOption,
        rawFreezeAuthority: mintParsed.rawFreezeAuthority,
        rawSupply: mintParsed.rawSupply,
        rawDecimals: mintParsed.rawDecimals
      },
      normalizedMintAuthority: normalizedMint,
      normalizedFreezeAuthority: normalizedFreeze,
      getTokenLargestAccounts: {
        status: largestParsed.success ? 'success' : 'error',
        holderCount: largestParsed.holderCount,
        topHolderPct: largestParsed.topHolderPct,
        top10HolderPct: largestParsed.top10HolderPct,
        holderConcentrationStatus: largestParsed.holderConcentrationStatus
      },
      parserNotes: [mintParsed.error, largestParsed.error].filter(Boolean),
      parserNoteShort: mintParsed.error ?? largestParsed.error ?? null,
      rawErrorSummary,
      signalAuditRowUsesEnrichment: auditUsesEnrichment,
      finalSafetyStatus: 'Real trading remains locked.'
    });
  }

  return {
    rpcUrlConfigured,
    rpcUrlDisplay,
    selectedTokenCount: rows.length,
    rows,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}

export function formatSafetyRpcProofTable(report: Record<string, any>): string {
  if (report.message) {
    return ['Safety RPC Proof', String(report.message), String(report.finalSafetyStatus)].join('\n');
  }
  const header = 'tokenId | symbol | class | ownerProgram | parsedType | dataShape | mintAuth | freezeAuth | holderStatus | top10Pct | note';
  const rows = ((report.rows as Array<Record<string, any>>) ?? []).map((row) => (
    `${row.tokenId} | ${row.symbol ?? '-'} | ${row.signalClass ?? '-'} | ${row.getParsedAccountInfo?.ownerProgram ?? '-'} | ${row.getParsedAccountInfo?.parsedType ?? '-'} | ${row.getParsedAccountInfo?.accountDataShape ?? '-'} | ${row.normalizedMintAuthority?.status ?? '-'} | ${row.normalizedFreezeAuthority?.status ?? '-'} | ${row.getTokenLargestAccounts?.holderConcentrationStatus ?? '-'} | ${row.getTokenLargestAccounts?.top10HolderPct ?? '-'} | ${row.parserNoteShort ?? '-'}`
  ));
  return [
    'Safety RPC Proof',
    JSON.stringify({ rpcUrlConfigured: report.rpcUrlConfigured, selectedTokenCount: report.selectedTokenCount }, null, 2),
    '',
    header,
    '-'.repeat(header.length),
    ...rows,
    '',
    String(report.finalSafetyStatus)
  ].join('\n');
}

export function renderSafetyRpcProof(report: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  return parseFormat(env.SAFETY_RPC_PROOF_FORMAT) === 'table'
    ? formatSafetyRpcProofTable(report as Record<string, any>)
    : JSON.stringify(report, null, 2);
}
