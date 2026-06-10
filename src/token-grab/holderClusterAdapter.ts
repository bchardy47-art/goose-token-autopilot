import type { HolderClusterProfile, HolderRisk, ClusterRisk } from './dexRipperEngine';

// ── Provider result ───────────────────────────────────────────────────────────────────────

export interface HolderClusterResult {
  holderRisk: HolderRisk;
  clusterRisk: ClusterRisk;
  concentrationNotes: string[];
  provider: string;
  checkedAt: string;            // ISO timestamp when the check ran
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  topHolderPercent?: number;
}

// ── Provider interface ────────────────────────────────────────────────────────────────────

export interface HolderClusterProvider {
  readonly name: string;
  fetchClusterProfile(contractAddress: string): Promise<HolderClusterResult>;
}

// ── Offline / stub provider ───────────────────────────────────────────────────────────────

export const offlineHolderClusterProvider: HolderClusterProvider = {
  name: 'offline',
  async fetchClusterProfile(_contract) {
    return {
      holderRisk: 'UNKNOWN',
      clusterRisk: 'UNKNOWN',
      concentrationNotes: ['holder/cluster data not available (offline provider)'],
      provider: 'offline',
      checkedAt: new Date().toISOString(),
      confidence: 'UNKNOWN',
    };
  },
};

// ── Adapter: HolderClusterResult → HolderClusterProfile (for ripper engine) ───────────────

/**
 * Converts a HolderClusterResult into the HolderClusterProfile shape the
 * ripper engine expects. Safe to call with any provider output.
 */
export function toHolderClusterProfile(result: HolderClusterResult): HolderClusterProfile {
  return {
    holderRisk: result.holderRisk,
    clusterRisk: result.clusterRisk,
    concentrationNotes: result.concentrationNotes,
  };
}

// ── Convenience: fetch and convert in one step ────────────────────────────────────────────

export async function fetchHolderClusterProfile(
  contract: string,
  provider: HolderClusterProvider = offlineHolderClusterProvider,
): Promise<HolderClusterProfile> {
  try {
    const result = await provider.fetchClusterProfile(contract);
    return toHolderClusterProfile(result);
  } catch {
    return {
      holderRisk: 'UNKNOWN',
      clusterRisk: 'UNKNOWN',
      concentrationNotes: [`holder/cluster fetch failed for ${contract.slice(0, 12)}…`],
    };
  }
}
