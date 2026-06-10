import type { RipperInput } from './dexRipperEngine';

// ── Source kinds ──────────────────────────────────────────────────────────────────────────

export type RipperEarSourceKind =
  | 'DEX_NEW_POOL'
  | 'DEX_TRENDING'
  | 'DEX_GAINER'
  | 'SOCIAL_PRELAUNCH'
  | 'SOCIAL_TRENDING'
  | 'MANUAL_WATCH'
  | 'UNKNOWN';

// ── Core signal type ──────────────────────────────────────────────────────────────────────

export interface RipperEarSignal {
  id: string;
  source: string;               // "dexscreener" | "geckoterminal" | "twitter" | etc.
  sourceKind: RipperEarSourceKind;

  // Identity
  contract?: string;            // token mint address (primary key for on-chain ops)
  tokenAddress?: string;        // alias for contract — use whichever is set
  poolAddress?: string;
  symbol?: string;
  name?: string;
  url?: string;

  // Timing
  discoveredAt: string;         // ISO — when this token/pool was first detected (pairCreatedAt if known)
  observedAt: string;           // ISO — when we processed/saw this signal (usually nowMs)
  launchHint?: string;          // raw launch timestamp string, if different from discoveredAt

  // Confidence and notes
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  signalReasons: string[];      // why flagged as interesting
  warnings: string[];           // non-fatal data quality issues

  // Normalized market data
  liquidityUsd?: number;
  volumeUsd?: number;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  txnCount?: number;
  buys?: number;
  sells?: number;

  // Enrichment hints (optional — from holder/cluster providers)
  holderRiskHint?: string;
  clusterRiskHint?: string;

  raw?: unknown;                // original raw payload, for debug
}

// ── Wrapper format (used in input JSON files) ─────────────────────────────────────────────

export interface RipperEarsInputFile {
  generatedAt?: string;
  source?: string;
  sourceKind?: RipperEarSourceKind;
  signals: RipperEarSignal[];
}

// ── Bridge: RipperEarSignal → RipperInput ─────────────────────────────────────────────────

/**
 * Converts a RipperEarSignal into the RipperInput shape consumed by the ripper engine.
 *
 * Age mapping: uses `discoveredAt` (pool creation / first detection time) as the
 * `observedAt` for the engine so age is measured from launch, not from ingestion.
 *
 * VLR is computed from volumeUsd / liquidityUsd if not already normalized.
 */
export function earSignalToRipperInput(signal: RipperEarSignal): RipperInput | null {
  const contract = signal.contract ?? signal.tokenAddress;
  if (!contract) return null;

  // Prefer discoveredAt as the launch-age anchor; fall back to observedAt.
  const observedAt = signal.discoveredAt || signal.observedAt;

  // Compute VLR if not already set
  let vlr = signal.volumeLiquidityRatio;
  if (vlr == null && signal.volumeUsd != null && signal.liquidityUsd != null && signal.liquidityUsd > 0) {
    vlr = signal.volumeUsd / signal.liquidityUsd;
  }

  // Map holderRiskHint → holderConcentrationStatus so the ripper engine can score holder risk.
  // hint values: 'CLEAN' | 'WATCH' | 'RISKY' (set by ripperFeed.ts from enriched candidates)
  // engine values: 'CLEAN' | 'WARNING' | 'DANGER' | 'UNKNOWN'
  const holderConcentrationStatus = (() => {
    if (signal.holderRiskHint === 'CLEAN') return 'CLEAN'  as const;
    if (signal.holderRiskHint === 'WATCH') return 'WARNING' as const;
    if (signal.holderRiskHint === 'RISKY') return 'DANGER'  as const;
    return undefined;
  })();

  return {
    contract,
    symbol: signal.symbol,
    observedAt,
    priceChangePct: signal.priceChangePct,
    liquidityChangePct: signal.liquidityChangePct,
    volumeLiquidityRatio: vlr,
    holderConcentrationStatus,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

export function getContractAddress(signal: RipperEarSignal): string | undefined {
  return signal.contract ?? signal.tokenAddress;
}

export function hasMarketData(signal: RipperEarSignal): boolean {
  return (
    signal.liquidityUsd != null ||
    signal.volumeUsd != null ||
    signal.priceChangePct != null
  );
}
