import type { AppConfig, TokenCandidate } from '../types';
import type { AppDb } from '../db';
import { getSolanaSafetyEnrichment, type SolanaSafetyEnrichment, applyEnrichment } from './solanaSafety';

export async function enrichCandidate(db: AppDb, config: AppConfig, candidate: TokenCandidate): Promise<{ candidate: TokenCandidate; enrichment: SolanaSafetyEnrichment | null }> {
  if (!config.enableSolanaSafetyEnrichment || candidate.chain !== 'solana' || candidate.source !== 'dexscreener') {
    return { candidate, enrichment: null };
  }

  try {
    const enrichment = await getSolanaSafetyEnrichment(candidate.mint, config);
    if (
      enrichment.mintAuthority === 'UNKNOWN' ||
      enrichment.freezeAuthority === 'UNKNOWN' ||
      enrichment.holderConcentration === 'UNKNOWN' ||
      enrichment.sellQuoteAvailable === 'UNKNOWN'
    ) {
      db.logSafetyEvent(null, 'WARN', 'safety_enrichment_unknown', 'Safety enrichment returned UNKNOWN fields that keep autopilot blocked', {
        mint: candidate.mint,
        source: candidate.source,
        notes: enrichment.notes
      });
    }
    return { candidate: applyEnrichment(candidate, enrichment), enrichment };
  } catch (error) {
    db.logSafetyEvent(null, 'WARN', 'safety_enrichment_failed', 'Safety enrichment failed; keeping UNKNOWN values', {
      mint: candidate.mint,
      source: candidate.source,
      error: error instanceof Error ? error.message : 'unknown enrichment error'
    });
    return { candidate, enrichment: null };
  }
}
