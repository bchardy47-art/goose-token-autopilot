// DO_NOT_ENABLE_REAL_TRADING  paperOnly=true  tradingExecuted=0  HOLD_CURRENT_GATES
//
// BubbleMaps operating mode — single source of truth for whether BubbleMaps is used.
//
// The paid BubbleMaps subscription is canceled. BubbleMaps is now OFF BY DEFAULT and is a purely
// OPTIONAL diagnostic. It is enabled ONLY when explicitly requested via env, and can be force-
// disabled. When disabled, NO BubbleMaps API is called (an offline provider is used AND the
// cached wrapper is set to disabled), so there are no paid calls and no rate-limit cooldowns.
//
// UNKNOWN cluster risk always stays UNKNOWN — disabling BubbleMaps NEVER relabels UNKNOWN as
// CLEAN (the offline/disabled providers return UNKNOWN, and downstream gates keep UNKNOWN strict).
// This module changes NO production gate and enables NO real trading.

import {
  createClusterRiskProvider, offlineClusterRiskProvider, type ClusterRiskProvider,
} from './clusterRiskProvider';
import { createBubbleMapsCachedProvider, type BubbleMapsCache } from './bubbleMapsCache';

export const ENV_BM_ENABLED  = 'TOKEN_GRAB_BUBBLEMAPS_ENABLED';
export const ENV_BM_DISABLED = 'TOKEN_GRAB_BUBBLEMAPS_DISABLED';

function truthy(v: string | undefined): boolean {
  return v === '1' || (v?.toLowerCase() === 'true');
}

/**
 * BubbleMaps is OFF by default. It is enabled ONLY when TOKEN_GRAB_BUBBLEMAPS_ENABLED is truthy
 * AND TOKEN_GRAB_BUBBLEMAPS_DISABLED is not set (explicit disable always wins).
 */
export function isBubbleMapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (truthy(env[ENV_BM_DISABLED])) return false;   // explicit off wins
  return truthy(env[ENV_BM_ENABLED]);                // default OFF
}

export function bubbleMapsModeLabel(env: NodeJS.ProcessEnv = process.env): string {
  return isBubbleMapsEnabled(env)
    ? 'ENABLED (optional cluster enrichment; UNKNOWN stays UNKNOWN)'
    : 'DISABLED (research-only; no paid BubbleMaps calls; UNKNOWN stays UNKNOWN)';
}

export interface OperatingClusterProvider {
  provider:  BubbleMapsCache;    // cluster provider the paper cycle / learning loop should use
  bmEnabled: boolean;
  note:      string;
}

/**
 * Build the cluster-risk provider the operating loops should use, honoring the BM mode.
 *
 * When DISABLED (the default): the raw provider is the OFFLINE provider (never makes HTTP calls),
 * AND the cached wrapper is set disabled — a belt-and-braces guarantee that NO BubbleMaps API is
 * called and no rate-limit cooldown is written. Result is always UNKNOWN, never CLEAN.
 *
 * When ENABLED: uses the configured BubbleMaps HTTP provider (or offline fallback if unconfigured),
 * wrapped in the cache exactly as before.
 */
export function createOperatingClusterProvider(
  env: NodeJS.ProcessEnv = process.env,
): OperatingClusterProvider {
  const bmEnabled = isBubbleMapsEnabled(env);
  if (!bmEnabled) {
    const provider = createBubbleMapsCachedProvider(offlineClusterRiskProvider, { disabled: true });
    return { provider, bmEnabled: false, note: bubbleMapsModeLabel(env) };
  }
  const { provider: raw, configNote } = createClusterRiskProvider();
  const provider = createBubbleMapsCachedProvider(raw as ClusterRiskProvider, { disabled: false });
  return { provider, bmEnabled: true, note: configNote ?? bubbleMapsModeLabel(env) };
}
