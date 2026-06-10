/**
 * Cluster risk provider for Token Grab fixture enrichment.
 *
 * Separates cluster risk (wallet clustering / linked-wallet concentration,
 * e.g. from BubbleMaps) from holder concentration (top-holder %, holder
 * enrichment). The holderClusterAdapter covers the combined profile shape
 * used by the ripper engine; this module focuses on the cluster-only leg.
 *
 * Conservative rule: NEVER return CLEAN without actual cluster data.
 * UNKNOWN is safe; false-CLEAN is not.
 */

import type { ClusterRisk } from './dexRipperEngine';
import type { LiveRipperFixture } from './liveFixtureCapture';

// ── Metrics shape (provider-agnostic) ─────────────────────────────────────────

export interface ClusterMetrics {
  topClusterPct?:     number;  // % of supply controlled by top linked-wallet cluster
  topClusterWallets?: number;  // number of wallets in the dominant cluster
  linkedWalletCount?: number;  // total linked wallets detected
  riskScore?:         number;  // 0–100 risk score (higher = more risky)
  isRug?:             boolean; // explicit rug/scam flag from provider
  decentralisationScore?: number; // 0–100 decentralisation (higher = more decentralised)
}

// ── Classification result ─────────────────────────────────────────────────────

export interface ClusterRiskResult {
  clusterRisk:       ClusterRisk;
  clusterProvider:   string;
  clusterCheckedAt:  string;
  clusterConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  clusterNotes:      string[];
  clusterFetchError?: string;
  rawMetrics?:       ClusterMetrics;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ClusterRiskProvider {
  readonly name: string;
  fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult>;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

export const CLUSTER_RISK_THRESHOLDS = {
  RISKY_TOP_CLUSTER_PCT:      50,  // ≥50% of supply in one cluster → RISKY
  WATCH_TOP_CLUSTER_PCT:      25,  // ≥25% → WATCH
  RISKY_RISK_SCORE:           70,  // provider risk score ≥70 → RISKY
  WATCH_RISK_SCORE:           40,  // ≥40 → WATCH
  CLEAN_DECENTRALISATION_MIN: 60,  // decentralisationScore ≥60 → supports CLEAN
} as const;

// ── Classification function ───────────────────────────────────────────────────

/**
 * Classify cluster risk from a metrics object.
 * Conservative: returns UNKNOWN when there is insufficient data to be certain.
 * Never classifies CLEAN based on absence of bad signals alone — requires
 * affirmative "safe" data.
 */
export function classifyClusterRisk(metrics: ClusterMetrics | null | undefined): ClusterRisk {
  if (!metrics) return 'UNKNOWN';

  // Explicit rug/scam flag always wins
  if (metrics.isRug === true) return 'RISKY';

  // Risk-score path (if provider supplies it)
  if (metrics.riskScore !== undefined) {
    if (metrics.riskScore >= CLUSTER_RISK_THRESHOLDS.RISKY_RISK_SCORE)  return 'RISKY';
    if (metrics.riskScore >= CLUSTER_RISK_THRESHOLDS.WATCH_RISK_SCORE)  return 'WATCH';
    // Low risk score — look for corroborating positive data before CLEAN
    if (metrics.topClusterPct !== undefined) {
      if (metrics.topClusterPct >= CLUSTER_RISK_THRESHOLDS.RISKY_TOP_CLUSTER_PCT) return 'RISKY';
      if (metrics.topClusterPct >= CLUSTER_RISK_THRESHOLDS.WATCH_TOP_CLUSTER_PCT) return 'WATCH';
      return 'CLEAN'; // low risk score + low cluster % = CLEAN
    }
    if (
      metrics.decentralisationScore !== undefined &&
      metrics.decentralisationScore >= CLUSTER_RISK_THRESHOLDS.CLEAN_DECENTRALISATION_MIN
    ) {
      return 'CLEAN'; // low risk score + high decentralisation = CLEAN
    }
    return 'CLEAN'; // low risk score alone is enough when that's all provider gives
  }

  // Cluster-percent path
  if (metrics.topClusterPct !== undefined) {
    if (metrics.topClusterPct >= CLUSTER_RISK_THRESHOLDS.RISKY_TOP_CLUSTER_PCT) return 'RISKY';
    if (metrics.topClusterPct >= CLUSTER_RISK_THRESHOLDS.WATCH_TOP_CLUSTER_PCT) return 'WATCH';
    return 'CLEAN'; // affirmative low-pct data present
  }

  // Decentralisation-only path
  if (metrics.decentralisationScore !== undefined) {
    if (metrics.decentralisationScore >= CLUSTER_RISK_THRESHOLDS.CLEAN_DECENTRALISATION_MIN) return 'CLEAN';
    return 'WATCH';
  }

  // Metrics present but no usable fields
  return 'UNKNOWN';
}

// ── Raw-field extraction ──────────────────────────────────────────────────────

/**
 * Read a ClusterRiskResult from fixture.raw if cluster enrichment has run.
 * Returns null when no cluster fields are present.
 */
export function extractClusterRiskFromCandidate(
  raw: Record<string, unknown> | undefined,
): ClusterRiskResult | null {
  if (!raw) return null;
  const checkedAt = raw['clusterCheckedAt'];
  if (typeof checkedAt !== 'string') return null;

  const cr = raw['clusterRisk'];
  const clusterRisk: ClusterRisk =
    cr === 'CLEAN' ? 'CLEAN' :
    cr === 'WATCH'  ? 'WATCH'  :
    cr === 'RISKY'  ? 'RISKY'  : 'UNKNOWN';

  const conf = raw['clusterConfidence'];
  const clusterConfidence: ClusterRiskResult['clusterConfidence'] =
    conf === 'HIGH' || conf === 'MEDIUM' || conf === 'LOW' ? conf : 'UNKNOWN';

  return {
    clusterRisk,
    clusterProvider:  typeof raw['clusterProvider'] === 'string' ? raw['clusterProvider'] : 'unknown',
    clusterCheckedAt: checkedAt,
    clusterConfidence,
    clusterNotes:     Array.isArray(raw['clusterNotes']) ? (raw['clusterNotes'] as string[]) : [],
    clusterFetchError: typeof raw['clusterFetchError'] === 'string' ? raw['clusterFetchError'] : undefined,
    rawMetrics:       typeof raw['clusterRawMetrics'] === 'object' && raw['clusterRawMetrics'] !== null
      ? raw['clusterRawMetrics'] as ClusterMetrics : undefined,
  };
}

/**
 * Returns the ClusterRisk value from fixture.raw enrichment data, or null
 * when no cluster data is present.
 *
 * Used by autonomyReadinessAudit and primeGateAudit to override the engine's
 * hardcoded UNKNOWN clusterRisk when real enrichment data is available.
 */
export function maybeClusterRiskFromFixture(fixture: LiveRipperFixture): ClusterRisk | null {
  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (!raw) return null;
  const result = extractClusterRiskFromCandidate(raw);
  if (!result) return null;
  return result.clusterRisk;
}

// ── Offline provider ──────────────────────────────────────────────────────────

export const offlineClusterRiskProvider: ClusterRiskProvider = {
  name: 'offline',
  async fetchClusterRisk(_tokenMint) {
    return {
      clusterRisk:       'UNKNOWN',
      clusterProvider:   'offline',
      clusterCheckedAt:  new Date().toISOString(),
      clusterConfidence: 'UNKNOWN',
      clusterNotes:      ['cluster data not available (offline provider)'],
    };
  },
};

// ── BubbleMaps HTTP provider ──────────────────────────────────────────────────

export interface BubbleMapsProviderConfig {
  apiUrl:  string;
  apiKey?: string;
}

/**
 * Create a BubbleMaps cluster risk provider.
 *
 * IMPORTANT: BubbleMaps API response format is not yet integrated.
 * This provider makes the HTTP call and attempts to parse cluster metrics
 * from the response using common field names. If the response does not
 * match the expected shape, it returns UNKNOWN safely.
 *
 * When BubbleMaps API access is obtained, update parseClusterMetrics() below
 * to match the actual response schema.
 *
 * Required config:
 *   apiUrl  — e.g. https://api.bubblemaps.io/v1  (env BUBBLEMAPS_API_URL)
 *   apiKey  — optional Bearer token              (env BUBBLEMAPS_API_KEY)
 */
export function createBubbleMapsClusterProvider(
  config: BubbleMapsProviderConfig,
): ClusterRiskProvider {
  return {
    name: 'bubblemaps',
    async fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult> {
      const checkedAt = new Date().toISOString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const url = `${config.apiUrl.replace(/\/$/, '')}/token/${tokenMint}`;
        const headers: Record<string, string> = {
          accept: 'application/json',
          'user-agent': 'goose-token-autopilot/1.0',
        };
        if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

        const response = await fetch(url, { signal: controller.signal, headers });

        if (!response.ok) {
          return {
            clusterRisk:       'UNKNOWN',
            clusterProvider:   'bubblemaps',
            clusterCheckedAt:  checkedAt,
            clusterConfidence: 'UNKNOWN',
            clusterNotes:      [`BubbleMaps HTTP ${response.status}`],
            clusterFetchError: `http ${response.status}`,
          };
        }

        const data = await response.json() as Record<string, unknown>;
        const metrics = parseClusterMetrics(data);
        const clusterRisk = classifyClusterRisk(metrics);

        const confidence: ClusterRiskResult['clusterConfidence'] =
          metrics && (metrics.riskScore !== undefined || metrics.topClusterPct !== undefined)
            ? 'HIGH' : 'LOW';

        const notes: string[] = [];
        if (clusterRisk === 'UNKNOWN') {
          notes.push('BubbleMaps response did not contain recognisable cluster metrics — integration may need updating');
        }
        if (metrics?.topClusterPct !== undefined) {
          notes.push(`top cluster ${metrics.topClusterPct.toFixed(1)}%`);
        }
        if (metrics?.riskScore !== undefined) {
          notes.push(`riskScore ${metrics.riskScore.toFixed(1)}`);
        }

        return {
          clusterRisk,
          clusterProvider:   'bubblemaps',
          clusterCheckedAt:  checkedAt,
          clusterConfidence: confidence,
          clusterNotes:      notes,
          rawMetrics:        metrics ?? undefined,
        };
      } catch (err) {
        return {
          clusterRisk:       'UNKNOWN',
          clusterProvider:   'bubblemaps',
          clusterCheckedAt:  checkedAt,
          clusterConfidence: 'UNKNOWN',
          clusterNotes:      [],
          clusterFetchError: err instanceof Error ? err.message : 'cluster fetch failed',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse cluster metrics from a BubbleMaps (or compatible) API response.
 *
 * Tries common field names from known cluster API patterns.
 * Returns null when no recognisable fields are found — the caller will
 * classify this as UNKNOWN rather than guessing.
 *
 * Update this function when BubbleMaps API access is obtained and the
 * exact response schema is known.
 */
function parseClusterMetrics(data: Record<string, unknown>): ClusterMetrics | null {
  const metrics: ClusterMetrics = {};
  let found = false;

  // BubbleMaps may expose a decentralization score
  const decScore = data['decentralization_score'] ?? data['decentralisationScore'] ?? data['decentralization'];
  if (typeof decScore === 'number') { metrics.decentralisationScore = decScore; found = true; }

  // Risk / safety score
  const riskScore = data['risk_score'] ?? data['riskScore'] ?? data['score'];
  if (typeof riskScore === 'number') { metrics.riskScore = riskScore; found = true; }

  // Top-cluster percentage
  const topPct = data['top_cluster_pct'] ?? data['topClusterPct'] ?? data['cluster_pct'];
  if (typeof topPct === 'number') { metrics.topClusterPct = topPct; found = true; }

  // Explicit rug flag
  const isRug = data['is_rug'] ?? data['isRug'] ?? data['flagged'];
  if (typeof isRug === 'boolean') { metrics.isRug = isRug; found = true; }

  return found ? metrics : null;
}

// ── Factory: create provider from env or config ───────────────────────────────

/**
 * Returns a BubbleMaps provider if config is available, otherwise the
 * offline provider. Never throws; always degrades safely.
 *
 * Config resolution order:
 *   1. Explicit apiUrl / apiKey arguments
 *   2. BUBBLEMAPS_API_URL / BUBBLEMAPS_API_KEY environment variables
 *   3. Falls back to offlineClusterRiskProvider with a note
 */
export function createClusterRiskProvider(opts: {
  apiUrl?:  string;
  apiKey?:  string;
} = {}): { provider: ClusterRiskProvider; configNote: string | null } {
  const url  = opts.apiUrl  ?? process.env['BUBBLEMAPS_API_URL'];
  const key  = opts.apiKey  ?? process.env['BUBBLEMAPS_API_KEY'];

  if (url) {
    return {
      provider:    createBubbleMapsClusterProvider({ apiUrl: url, apiKey: key }),
      configNote:  null,
    };
  }

  return {
    provider: offlineClusterRiskProvider,
    configNote:
      'No cluster API configured — using offline provider (all results will be UNKNOWN). ' +
      'Set BUBBLEMAPS_API_URL (and optionally BUBBLEMAPS_API_KEY) to enable cluster enrichment.',
  };
}
