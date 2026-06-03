import { getConfigSafetyStatus } from './config';
import type { AppConfig } from './types';
import { isKillSwitchActive } from './trading/guards';

export function verifySafety(config: AppConfig): Record<string, unknown> {
  return {
    ...getConfigSafetyStatus(config),
    killSwitchActive: isKillSwitchActive(config),
    realTradingLockedByDefault: config.tokenRadarDryRun || config.tradingDisabled || !config.enableRealBuys || !config.enableRealSells,
    autoPaperEnabled: config.enableAutoPaperTrading,
    enrichmentEnabled: config.enableSolanaSafetyEnrichment,
    safetyEnrichmentTimeoutMs: config.safetyEnrichmentTimeoutMs,
    safetyEnrichmentMaxTokensPerRun: config.safetyEnrichmentMaxTokensPerRun,
    safetyEnrichmentCacheMinutes: config.safetyEnrichmentCacheMinutes,
    quoteCheckEnabled: config.enableQuoteCheck,
    quoteCheckTimeoutMs: config.quoteCheckTimeoutMs,
    quoteCheckMaxTokensPerRun: config.quoteCheckMaxTokensPerRun,
    quoteCheckCacheMinutes: config.quoteCheckCacheMinutes,
    quoteCheckSellAmountUsd: config.quoteCheckSellAmountUsd,
    quoteCheckSlippageBps: config.quoteCheckSlippageBps,
    paperTrailingStopEnabled: config.paperTrailingStopEnabled,
    paperTrailingActivationPct: config.paperTrailingActivationPct,
    paperTrailingStopPct: config.paperTrailingStopPct,
    paperEarlyFadeExitEnabled: config.paperEarlyFadeExitEnabled,
    paperEarlyFadeMinHoldMinutes: config.paperEarlyFadeMinHoldMinutes,
    paperEarlyFadeMaxBestGainPct: config.paperEarlyFadeMaxBestGainPct,
    paperEarlyFadeExitBelowPnlPct: config.paperEarlyFadeExitBelowPnlPct,
    paperRequireHighWatchPriority: config.paperRequireHighWatchPriority,
    paperTradingSimulatedOnly: true,
    watchOnlyResearchOnly: true,
    walletSigningConfigured: false,
    notes: [
      'Real trading must remain impossible by default.',
      'Auto-paper trading is simulated only and never executes real buys.',
      'Solana safety enrichment is read-only and does not unlock trading.',
      'UNKNOWN safety-critical fields remain unsafe for autopilot.',
      'No wallet signing is configured in V1.3.',
      'This command does not unlock trading.'
    ]
  };
}
