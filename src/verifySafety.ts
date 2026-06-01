import { getConfigSafetyStatus } from './config';
import type { AppConfig } from './types';
import { isKillSwitchActive } from './trading/guards';

export function verifySafety(config: AppConfig): Record<string, unknown> {
  return {
    ...getConfigSafetyStatus(config),
    killSwitchActive: isKillSwitchActive(config),
    realTradingLockedByDefault: config.tokenRadarDryRun || config.tradingDisabled || !config.enableRealBuys || !config.enableRealSells,
    enrichmentEnabled: config.enableSolanaSafetyEnrichment,
    quoteCheckEnabled: config.enableQuoteCheck,
    notes: [
      'Real trading must remain impossible by default.',
      'Solana safety enrichment is read-only and does not unlock trading.',
      'UNKNOWN safety-critical fields remain unsafe for autopilot.',
      'Burner wallet and all caps must be configured before any future live enablement.',
      'This command does not unlock trading.'
    ]
  };
}
