import { AppLogger } from '../logger';
import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';
import { enrichCandidate } from '../enrichment/enrichCandidate';
import { DexScreenerTokenSource, createDexScreenerSourceFromConfig } from './dexscreenerSource';
import { FixtureTokenSource } from './fixtureSource';
import type { TokenSource } from './source';

export function createTokenSource(config: AppConfig): TokenSource {
  return config.tokenSource === 'dexscreener' ? createDexScreenerSourceFromConfig(config) : new FixtureTokenSource();
}

async function persistCandidates(db: AppDb, config: AppConfig, candidates: TokenCandidate[]): Promise<number[]> {
  const tokenIds: number[] = [];
  for (const candidate of candidates) {
    const enriched = await enrichCandidate(db, config, candidate);
    const tokenId = db.upsertToken(enriched.candidate);
    db.insertSnapshot(tokenId, enriched.candidate);
    tokenIds.push(tokenId);
  }
  return tokenIds;
}

export async function refreshSnapshotsForTokenAddresses(db: AppDb, config: AppConfig, tokenAddresses: string[], logger = new AppLogger()): Promise<{ refreshed: number; tokenIds: number[] }> {
  if (config.tokenSource !== 'dexscreener') {
    return { refreshed: 0, tokenIds: [] };
  }
  const source = createTokenSource(config) as DexScreenerTokenSource;
  const candidates = await source.fetchCandidatesByTokenAddresses(tokenAddresses);
  const tokenIds = await persistCandidates(db, config, candidates);
  const summary = { refreshed: candidates.length, tokenIds };
  logger.info('Open-position snapshot refresh completed', summary);
  return summary;
}

export async function runScan(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ scanned: number; source: string; tokenIds: number[]; sourceSummary?: Record<string, unknown> | null }> {
  const runLogId = db.createRunLog('token:scan');
  try {
    const source = createTokenSource(config);
    const candidates = await source.fetchCandidates();
    const tokenIds = await persistCandidates(db, config, candidates);
    const sourceSummary = source instanceof DexScreenerTokenSource ? source.getLastFetchSummary() : null;

    const summary = { scanned: candidates.length, source: source.name, tokenIds, sourceSummary };
    db.finishRunLog(runLogId, 'SUCCESS', summary);
    logger.info('Token scan completed', summary);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scan error';
    db.finishRunLog(runLogId, 'FAILED', { error: message });
    logger.error('Token scan failed', { error: message });
    throw error;
  }
}
