import type { AppDb } from './db';
import type { AppConfig, TokenCandidate } from './types';
import { AppLogger } from './logger';
import { getSolanaSafetyEnrichment, applyEnrichment } from './enrichment/solanaSafety';

function minutesSince(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / 60_000;
}

function parseSafetyEnrichmentMeta(snapshot: TokenCandidate | null): Record<string, unknown> | null {
  return (snapshot?.raw?.safetyEnrichment as Record<string, unknown> | undefined) ?? null;
}

function buildPriorityTokenIds(db: AppDb, maxTokens: number): number[] {
  const watchIds = db.listWatchOnlyCandidates().map((candidate) => candidate.tokenId);
  const recentStateIds = db.listLatestTokenStates(100).map((state) => state.tokenId);
  return [...new Set([...watchIds, ...recentStateIds])].slice(0, maxTokens);
}

export async function runSafetyEnrich(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<Record<string, unknown>> {
  const runLogId = db.createRunLog('token:safety-enrich');
  try {
    if (!config.enableSolanaSafetyEnrichment) {
      const summary = {
        checkedCount: 0,
        skippedCachedCount: 0,
        mintAuthorityRenouncedCount: 0,
        freezeAuthorityRenouncedCount: 0,
        unknownCount: 0,
        highHolderConcentrationCount: 0,
        errorsCount: 0,
        finalSafetyStatus: 'Real trading remains locked.'
      };
      db.finishRunLog(runLogId, 'SUCCESS', summary);
      return summary;
    }

    const tokenIds = buildPriorityTokenIds(db, config.safetyEnrichmentMaxTokensPerRun);
    let checkedCount = 0;
    let skippedCachedCount = 0;
    let mintAuthorityRenouncedCount = 0;
    let freezeAuthorityRenouncedCount = 0;
    let unknownCount = 0;
    let highHolderConcentrationCount = 0;
    let errorsCount = 0;

    for (const tokenId of tokenIds) {
      const token = db.getTokenRecord(tokenId);
      const snapshot = db.getLatestSnapshot(tokenId);
      if (!token || !snapshot || snapshot.chain !== 'solana') continue;

      const cached = db.getLatestSolanaSafetyEnrichment(tokenId);
      if (cached && minutesSince(cached.checkedAt) < config.safetyEnrichmentCacheMinutes) {
        skippedCachedCount += 1;
        continue;
      }

      try {
        const enrichment = await getSolanaSafetyEnrichment(snapshot.mint, config, {
          rpcUrl: config.solanaRpcUrl,
          enableQuoteCheck: config.enableQuoteCheck
        });

        const poolAddress = (() => {
          const selectedPair = (snapshot.raw?.selectedPair as Record<string, unknown> | undefined)
            ?? ((snapshot.raw?.profile as any)?.selectedPair as Record<string, unknown> | undefined)
            ?? ((snapshot.raw as any)?.selectedPair as Record<string, unknown> | undefined);
          return typeof selectedPair?.pairAddress === 'string' ? selectedPair.pairAddress : null;
        })();
        const poolAgeMinutes = (() => {
          const selectedPair = (snapshot.raw?.selectedPair as Record<string, unknown> | undefined)
            ?? ((snapshot.raw as any)?.selectedPair as Record<string, unknown> | undefined);
          const pairCreatedAt = typeof selectedPair?.pairCreatedAt === 'number' ? selectedPair.pairCreatedAt : null;
          return pairCreatedAt ? Number(((Date.now() - pairCreatedAt) / 60_000).toFixed(2)) : null;
        })();

        db.createSolanaSafetyEnrichment(
          tokenId,
          snapshot.mint,
          new Date().toISOString(),
          enrichment.freezeAuthority,
          enrichment.mintAuthority,
          enrichment.mintAuthorityRenounced,
          enrichment.freezeAuthorityRenounced,
          enrichment.tokenProgram,
          enrichment.supply,
          enrichment.decimals,
          enrichment.holderCount,
          enrichment.topHolderPct,
          enrichment.top10HolderPct,
          enrichment.holderConcentrationLevel,
          enrichment.holderConcentration,
          enrichment.creatorAddress,
          enrichment.creatorStatus,
          poolAddress,
          poolAgeMinutes,
          enrichment.redFlags.length > 0 ? 'RISKY_OR_UNKNOWN' : 'INCOMPLETE_BUT_READ_ONLY',
          enrichment.redFlags,
          enrichment.notes.join('; '),
          {
            ...enrichment.raw,
            poolAddress,
            poolAgeMinutes
          }
        );

        const enrichedSnapshot = applyEnrichment(snapshot, {
          ...enrichment,
          lpOrPoolAddress: poolAddress,
          poolAgeMinutes
        });
        db.insertSnapshot(tokenId, { ...enrichedSnapshot, dataUpdatedAt: new Date().toISOString() });

        checkedCount += 1;
        if (enrichment.mintAuthorityRenounced === true) mintAuthorityRenouncedCount += 1;
        if (enrichment.freezeAuthorityRenounced === true) freezeAuthorityRenouncedCount += 1;
        if (
          enrichment.mintAuthority === 'UNKNOWN' ||
          enrichment.freezeAuthority === 'UNKNOWN' ||
          enrichment.holderConcentration === 'UNKNOWN'
        ) unknownCount += 1;
        if (enrichment.holderConcentrationLevel === 'HIGH') highHolderConcentrationCount += 1;
      } catch (error) {
        errorsCount += 1;
        db.logSafetyEvent(tokenId, 'WARN', 'safety_enrichment_failed', 'Read-only Solana safety enrichment failed safely', {
          tokenId,
          mint: snapshot.mint,
          error: error instanceof Error ? error.message : 'unknown safety enrichment error'
        });
      }
    }

    const summary = {
      checkedCount,
      skippedCachedCount,
      mintAuthorityRenouncedCount,
      freezeAuthorityRenouncedCount,
      unknownCount,
      highHolderConcentrationCount,
      errorsCount,
      finalSafetyStatus: 'Real trading remains locked.'
    };
    db.finishRunLog(runLogId, 'SUCCESS', summary);
    logger.info('Solana safety enrichment completed', summary);
    return summary;
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown safety enrich error' });
    throw error;
  }
}
