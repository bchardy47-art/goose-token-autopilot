import { AppLogger } from '../logger';
import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';
import { enrichCandidate } from '../enrichment/enrichCandidate';
import { DexScreenerTokenSource, createDexScreenerSourceFromConfig } from './dexscreenerSource';
import { FixtureTokenSource } from './fixtureSource';
import { GeckoTerminalTokenSource, createGeckoTerminalSourceFromConfig } from './geckoTerminalSource';
import type { TokenSource } from './source';

export function createTokenSource(config: AppConfig): TokenSource {
  if (config.tokenSource === 'dexscreener') return createDexScreenerSourceFromConfig(config);
  if (config.tokenSource === 'geckoterminal') return createGeckoTerminalSourceFromConfig(config);
  return new FixtureTokenSource();
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

export async function refreshSnapshotsForTokenAddresses(db: AppDb, config: AppConfig, tokenAddresses: string[], logger = new AppLogger()): Promise<{ refreshed: number; tokenIds: number[]; geckoRefreshSummary?: Record<string, unknown> | null }> {
  if (config.tokenSource === 'dexscreener') {
    const source = createTokenSource(config) as DexScreenerTokenSource;
    const candidates = await source.fetchCandidatesByTokenAddresses(tokenAddresses);
    const tokenIds = await persistCandidates(db, config, candidates);
    const summary = { refreshed: candidates.length, tokenIds, geckoRefreshSummary: null };
    logger.info('Open-position snapshot refresh completed', summary);
    return summary;
  }

  if (config.tokenSource === 'geckoterminal') {
    const source = createTokenSource(config) as GeckoTerminalTokenSource;
    const states = db.listLatestTokenStates(100)
      .filter((state) => tokenAddresses.includes(state.mint) && state.snapshot?.source === 'geckoterminal' && state.snapshot)
      .map((state) => state.snapshot!)
      .slice(0, 20);
    const refresh = await source.refreshCandidatesByPoolAddresses(states, 60, 20);
    const tokenIds = await persistCandidates(db, config, refresh.refreshed);
    const summary = { refreshed: refresh.refreshed.length, tokenIds, geckoRefreshSummary: refresh.summary };
    logger.info('Open-position snapshot refresh completed', summary);
    return summary;
  }

  return { refreshed: 0, tokenIds: [], geckoRefreshSummary: null };
}

export async function runScan(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ scanned: number; source: string; tokenIds: number[]; sourceSummary?: Record<string, unknown> | null }> {
  const runLogId = db.createRunLog('token:scan');
  try {
    const source = createTokenSource(config);
    const candidates = await source.fetchCandidates();
    const tokenIds = await persistCandidates(db, config, candidates);
    const sourceSummary = source instanceof DexScreenerTokenSource || source instanceof GeckoTerminalTokenSource ? source.getLastFetchSummary() : null;

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
