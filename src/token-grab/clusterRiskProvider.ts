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
  httpStatus?:       number;              // HTTP status code for diagnostics
  dataAvailable?:    boolean;             // false when API says map not available (400)
  unknownReason?:    BubbleMapsUnknownReason; // WHY this call returned UNKNOWN
  chain?:            string;              // blockchain targeted ('solana')
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ClusterRiskProvider {
  readonly name: string;
  fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult>;
}

// ── BubbleMaps UNKNOWN reason classification ──────────────────────────────────
//
// Classifies WHY a BubbleMaps call returned UNKNOWN so diagnostics can tell
// apart "fresh token not yet indexed" (NO_MAP_YET — expected and common) from
// config errors (AUTH_ERROR), provider issues (RATE_LIMITED, PROVIDER_ERROR),
// or integration gaps (PARSE_ERROR, UNKNOWN_UNCLASSIFIED).
//
// CAP_REACHED and DISABLED are infrastructure reasons (set by the caching
// layer, not the provider). OFFLINE is for the offline provider fallback.

export type BubbleMapsUnknownReason =
  | 'NO_MAP_YET'           // 400/404 — token not yet indexed by BubbleMaps (normal for fresh tokens)
  | 'UNSUPPORTED_CHAIN'    // 400 — chain not supported by this API endpoint
  | 'INVALID_CONTRACT'     // 400 — contract address format rejected
  | 'RATE_LIMITED'         // 429 — too many requests
  | 'AUTH_ERROR'           // 401/403 — check BUBBLEMAPS_API_KEY
  | 'PROVIDER_ERROR'       // other non-2xx or network-level failure
  | 'PARSE_ERROR'          // 200 — response body is not valid JSON
  | 'EMPTY_RESPONSE'       // 200 — response body is empty
  | 'TIMEOUT'              // request aborted after 10 s
  | 'UNKNOWN_UNCLASSIFIED' // 200 — parsed but no recognisable cluster metrics
  | 'OFFLINE'              // offline provider — no API configured
  | 'CAP_REACHED'          // skipped — per-run call cap exhausted
  | 'DISABLED';            // skipped — TOKEN_GRAB_BUBBLEMAPS_DISABLED=1

// ── Cache stats (optional — surfaced by caching providers only) ───────────────

export interface ClusterRiskCacheStats {
  liveCallsThisRun:  number;
  cacheHitsThisRun:  number;
  skippedDueToCap:   number;
  capLimit:          number;
  mode:              'DISABLED' | 'CACHE_ONLY' | 'LIVE_CAPPED';
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
 * Used by primeGateAudit to override the engine's hardcoded UNKNOWN clusterRisk
 * when real enrichment data is available.
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
      unknownReason:     'OFFLINE',
      chain:             'solana',
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
 * Endpoint: GET {apiUrl}/tokens/map/solana/{tokenMint}
 * Auth:     X-ApiKey: {apiKey}
 *
 * BubbleMaps v0 real response shape:
 *   { metadata, metrics: { supply_stats, scores: { bubblemaps_score, gini_index, ... } }, nodes, relationships }
 *
 * bubblemaps_score is 0–100 where higher = more decentralised/safer.
 * Mapped to decentralisationScore for classifyClusterRisk.
 *
 * Degradation rules:
 *   200            → success; clusterRisk may be UNKNOWN if metrics unrecognised
 *   400 (no data)  → UNKNOWN, no error (API responded; token not yet mapped by BubbleMaps)
 *   400 (other)    → UNKNOWN + clusterFetchError
 *   401/403        → UNKNOWN + clusterFetchError (auth/config failure)
 *   429            → UNKNOWN + clusterFetchError (rate limit)
 *   other non-2xx  → UNKNOWN + clusterFetchError
 *   network error  → UNKNOWN + clusterFetchError
 */
export function createBubbleMapsClusterProvider(
  config: BubbleMapsProviderConfig,
): ClusterRiskProvider {
  function redactKey(msg: string): string {
    if (!config.apiKey || config.apiKey.length < 4) return msg;
    return msg.replaceAll(config.apiKey, '[REDACTED]');
  }

  return {
    name: 'bubblemaps',
    async fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult> {
      const checkedAt = new Date().toISOString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const base = config.apiUrl.replace(/\/$/, '');
        const url = `${base}/tokens/map/solana/${tokenMint}`;
        const headers: Record<string, string> = {
          accept: 'application/json',
          'user-agent': 'goose-token-autopilot/1.0',
        };
        if (config.apiKey) headers['X-ApiKey'] = config.apiKey;

        const response = await fetch(url, { signal: controller.signal, headers });

        if (!response.ok) {
          const status = response.status;

          // 404 — token not found / not yet indexed by BubbleMaps (normal for fresh tokens)
          if (status === 404) {
            return {
              clusterRisk:       'UNKNOWN',
              clusterProvider:   'bubblemaps',
              clusterCheckedAt:  checkedAt,
              clusterConfidence: 'UNKNOWN',
              clusterNotes:      ['BubbleMaps: token not found (404) — not yet indexed'],
              httpStatus:        404,
              dataAvailable:     false,
              unknownReason:     'NO_MAP_YET',
              chain:             'solana',
            };
          }

          // 400 — may mean "not yet mapped" or a bad-format request
          if (status === 400) {
            let bodyText = '';
            try { bodyText = await response.text(); } catch (_) { /* ignore */ }
            const lower = bodyText.toLowerCase();

            const isNoData =
              lower.includes('not available') ||
              lower.includes('no data') ||
              lower.includes('not found') ||
              lower.includes('map data') ||
              bodyText === '';

            const isChain =
              (lower.includes('chain') && (lower.includes('unsupported') || lower.includes('not supported'))) ||
              lower.includes('unsupported chain');

            const isInvalidContract =
              (lower.includes('invalid') && (lower.includes('address') || lower.includes('contract') || lower.includes('token') || lower.includes('mint'))) ||
              (lower.includes('format') && lower.includes('invalid'));

            if (isNoData) {
              return {
                clusterRisk:       'UNKNOWN',
                clusterProvider:   'bubblemaps',
                clusterCheckedAt:  checkedAt,
                clusterConfidence: 'UNKNOWN',
                clusterNotes:      ['BubbleMaps: map data not yet available for this token'],
                httpStatus:        400,
                dataAvailable:     false,
                unknownReason:     'NO_MAP_YET',
                chain:             'solana',
              };
            }
            if (isChain) {
              return {
                clusterRisk:       'UNKNOWN',
                clusterProvider:   'bubblemaps',
                clusterCheckedAt:  checkedAt,
                clusterConfidence: 'UNKNOWN',
                clusterNotes:      ['BubbleMaps: chain not supported for this endpoint'],
                clusterFetchError: 'http 400 (unsupported chain)',
                httpStatus:        400,
                unknownReason:     'UNSUPPORTED_CHAIN',
                chain:             'solana',
              };
            }
            if (isInvalidContract) {
              return {
                clusterRisk:       'UNKNOWN',
                clusterProvider:   'bubblemaps',
                clusterCheckedAt:  checkedAt,
                clusterConfidence: 'UNKNOWN',
                clusterNotes:      ['BubbleMaps: invalid contract address format'],
                clusterFetchError: 'http 400 (invalid contract)',
                httpStatus:        400,
                unknownReason:     'INVALID_CONTRACT',
                chain:             'solana',
              };
            }
            return {
              clusterRisk:       'UNKNOWN',
              clusterProvider:   'bubblemaps',
              clusterCheckedAt:  checkedAt,
              clusterConfidence: 'UNKNOWN',
              clusterNotes:      ['BubbleMaps HTTP 400'],
              clusterFetchError: 'http 400 (bad request)',
              httpStatus:        400,
              unknownReason:     'PROVIDER_ERROR',
              chain:             'solana',
            };
          }

          // 401 / 403 / 429 / other non-2xx
          const unknownReason: BubbleMapsUnknownReason =
            status === 401 || status === 403 ? 'AUTH_ERROR' :
            status === 429                   ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
          const detail =
            status === 401 ? 'http 401 (auth failed — check BUBBLEMAPS_API_KEY)' :
            status === 403 ? 'http 403 (access denied — check API key permissions)' :
            status === 429 ? 'http 429 (rate limited)' :
            `http ${status}`;
          return {
            clusterRisk:       'UNKNOWN',
            clusterProvider:   'bubblemaps',
            clusterCheckedAt:  checkedAt,
            clusterConfidence: 'UNKNOWN',
            clusterNotes:      [`BubbleMaps HTTP ${status}`],
            clusterFetchError: detail,
            httpStatus:        status,
            unknownReason,
            chain:             'solana',
          };
        }

        // 200 — read body text first to detect empty / malformed responses distinctly
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch (textErr) {
          const isTimeout = textErr instanceof Error && textErr.name === 'AbortError';
          return {
            clusterRisk:       'UNKNOWN',
            clusterProvider:   'bubblemaps',
            clusterCheckedAt:  checkedAt,
            clusterConfidence: 'UNKNOWN',
            clusterNotes:      [],
            clusterFetchError: isTimeout ? 'timeout reading response body' : 'failed to read response body',
            httpStatus:        200,
            unknownReason:     isTimeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
            chain:             'solana',
          };
        }

        if (!bodyText.trim()) {
          return {
            clusterRisk:       'UNKNOWN',
            clusterProvider:   'bubblemaps',
            clusterCheckedAt:  checkedAt,
            clusterConfidence: 'UNKNOWN',
            clusterNotes:      ['BubbleMaps: 200 with empty response body'],
            clusterFetchError: 'empty response body',
            httpStatus:        200,
            unknownReason:     'EMPTY_RESPONSE',
            chain:             'solana',
          };
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(bodyText) as Record<string, unknown>;
        } catch (_) {
          return {
            clusterRisk:       'UNKNOWN',
            clusterProvider:   'bubblemaps',
            clusterCheckedAt:  checkedAt,
            clusterConfidence: 'UNKNOWN',
            clusterNotes:      ['BubbleMaps: 200 with malformed JSON response'],
            clusterFetchError: 'malformed JSON response',
            httpStatus:        200,
            unknownReason:     'PARSE_ERROR',
            chain:             'solana',
          };
        }

        const metrics = parseClusterMetrics(data);
        const clusterRisk = classifyClusterRisk(metrics);

        const hasRichMetrics = metrics && (
          metrics.riskScore             !== undefined ||
          metrics.topClusterPct         !== undefined ||
          metrics.decentralisationScore !== undefined
        );
        const confidence: ClusterRiskResult['clusterConfidence'] =
          hasRichMetrics ? 'HIGH' : clusterRisk !== 'UNKNOWN' ? 'MEDIUM' : 'LOW';

        const notes: string[] = [];
        if (clusterRisk === 'UNKNOWN') {
          notes.push('BubbleMaps response did not contain recognisable cluster metrics — integration may need updating');
        }
        if (metrics?.decentralisationScore !== undefined) {
          notes.push(`bubbleMapsScore ${metrics.decentralisationScore.toFixed(1)}`);
        }
        if (metrics?.topClusterPct !== undefined) {
          notes.push(`top cluster ${metrics.topClusterPct.toFixed(1)}%`);
        }
        if (metrics?.riskScore !== undefined) {
          notes.push(`riskScore ${metrics.riskScore.toFixed(1)}`);
        }

        const unknownReason: BubbleMapsUnknownReason | undefined =
          clusterRisk === 'UNKNOWN' ? 'UNKNOWN_UNCLASSIFIED' : undefined;

        return {
          clusterRisk,
          clusterProvider:   'bubblemaps',
          clusterCheckedAt:  checkedAt,
          clusterConfidence: confidence,
          clusterNotes:      notes,
          rawMetrics:        metrics ?? undefined,
          httpStatus:        200,
          unknownReason,
          chain:             'solana',
        };
      } catch (err) {
        // Network error or timeout from fetch() itself
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const rawMsg = err instanceof Error ? err.message : 'cluster fetch failed';
        const msg = redactKey(rawMsg);
        return {
          clusterRisk:       'UNKNOWN',
          clusterProvider:   'bubblemaps',
          clusterCheckedAt:  checkedAt,
          clusterConfidence: 'UNKNOWN',
          clusterNotes:      [],
          clusterFetchError: isTimeout ? 'timeout after 10s' : msg,
          unknownReason:     isTimeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
          chain:             'solana',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse cluster metrics from a BubbleMaps API response.
 *
 * Tries the real BubbleMaps v0 structure first:
 *   data.metrics.scores.bubblemaps_score  (0–100, higher = safer → decentralisationScore)
 *
 * Falls back to flat top-level field names for backward compat with mocks/tests:
 *   risk_score / riskScore, top_cluster_pct / topClusterPct, is_rug / isRug,
 *   decentralization_score / decentralisationScore
 *
 * Returns null when no recognisable fields found — caller classifies as UNKNOWN.
 *
 * Update the "real BubbleMaps structure" block when API shape changes.
 */
function parseClusterMetrics(data: Record<string, unknown>): ClusterMetrics | null {
  const metrics: ClusterMetrics = {};
  let found = false;

  // ── Real BubbleMaps v0 response structure ──────────────────────────────────
  const metricsObj = data['metrics'] as Record<string, unknown> | undefined;
  if (metricsObj) {
    const scoresObj = metricsObj['scores'] as Record<string, unknown> | undefined;
    if (scoresObj) {
      // bubblemaps_score: 0-100, higher = more decentralised/safer
      const bScore = scoresObj['bubblemaps_score'];
      if (typeof bScore === 'number') {
        metrics.decentralisationScore = bScore;
        found = true;
      }
    }
    // Could also check metricsObj.supply_stats for top-holder data in future
  }

  // ── Flat fallback field names (for mocks, tests, and compatible providers) ─
  if (!found) {
    const decScore =
      data['decentralization_score'] ??
      data['decentralisationScore'] ??
      data['decentralization'];
    if (typeof decScore === 'number') { metrics.decentralisationScore = decScore; found = true; }

    const riskScore = data['risk_score'] ?? data['riskScore'] ?? data['score'];
    if (typeof riskScore === 'number') { metrics.riskScore = riskScore; found = true; }

    const topPct = data['top_cluster_pct'] ?? data['topClusterPct'] ?? data['cluster_pct'];
    if (typeof topPct === 'number') { metrics.topClusterPct = topPct; found = true; }

    const isRug = data['is_rug'] ?? data['isRug'] ?? data['flagged'];
    if (typeof isRug === 'boolean') { metrics.isRug = isRug; found = true; }
  }

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
