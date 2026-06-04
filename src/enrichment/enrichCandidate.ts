import type { AppConfig, TokenCandidate } from '../types';
import type { AppDb } from '../db';
import { getSolanaSafetyEnrichment, type SolanaSafetyEnrichment, applyEnrichment } from './solanaSafety';

function parsePoolDetails(candidate: TokenCandidate): { lpOrPoolAddress: string | null; poolAgeMinutes: number | null } {
  const selectedPair = (candidate.raw?.selectedPair as Record<string, unknown> | undefined)
    ?? (((candidate.raw as any)?.profile?.selectedPair) as Record<string, unknown> | undefined)
    ?? ((candidate.raw as any)?.selectedPair as Record<string, unknown> | undefined);
  const lpOrPoolAddress = typeof selectedPair?.pairAddress === 'string' ? selectedPair.pairAddress : null;
  const pairCreatedAt = typeof selectedPair?.pairCreatedAt === 'number' ? selectedPair.pairCreatedAt : null;
  const poolAgeMinutes = pairCreatedAt ? Number(((Date.now() - pairCreatedAt) / 60_000).toFixed(2)) : null;
  return { lpOrPoolAddress, poolAgeMinutes };
}

export async function enrichCandidate(db: AppDb, config: AppConfig, candidate: TokenCandidate): Promise<{ candidate: TokenCandidate; enrichment: SolanaSafetyEnrichment | null }> {
  if (!config.enableSolanaSafetyEnrichment || candidate.chain !== 'solana' || !['dexscreener', 'geckoterminal'].includes(candidate.source)) {
    return { candidate, enrichment: null };
  }

  try {
    const poolDetails = parsePoolDetails(candidate);
    const enrichment = await getSolanaSafetyEnrichment(candidate.mint, config, { timeoutMs: config.safetyEnrichmentTimeoutMs });
    const enrichedWithPool = { ...enrichment, ...poolDetails };
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
    return { candidate: applyEnrichment(candidate, enrichedWithPool), enrichment: enrichedWithPool };
  } catch (error) {
    db.logSafetyEvent(null, 'WARN', 'safety_enrichment_failed', 'Safety enrichment failed; keeping UNKNOWN values', {
      mint: candidate.mint,
      source: candidate.source,
      error: error instanceof Error ? error.message : 'unknown enrichment error'
    });
    return { candidate, enrichment: null };
  }
}
