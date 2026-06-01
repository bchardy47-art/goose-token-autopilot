import { AppLogger } from '../logger';
import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { enrichCandidate } from '../enrichment/enrichCandidate';
import { DexScreenerTokenSource } from './dexscreenerSource';
import { FixtureTokenSource } from './fixtureSource';
import type { TokenSource } from './source';

export function createTokenSource(config: AppConfig): TokenSource {
  return config.tokenSource === 'dexscreener' ? new DexScreenerTokenSource() : new FixtureTokenSource();
}

export async function runScan(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ scanned: number; source: string; tokenIds: number[] }> {
  const runLogId = db.createRunLog('token:scan');
  try {
    const source = createTokenSource(config);
    const candidates = await source.fetchCandidates();
    const tokenIds: number[] = [];

    for (const candidate of candidates) {
      const enriched = await enrichCandidate(db, config, candidate);
      const tokenId = db.upsertToken(enriched.candidate);
      db.insertSnapshot(tokenId, enriched.candidate);
      tokenIds.push(tokenId);
    }

    const summary = { scanned: candidates.length, source: source.name, tokenIds };
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
