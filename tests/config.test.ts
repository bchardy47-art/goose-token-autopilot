import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('config', () => {
  it('loads safe defaults', () => {
    const config = loadConfig({});
    expect(config.tokenRadarDryRun).toBe(true);
    expect(config.tradingDisabled).toBe(true);
    expect(config.enableRealBuys).toBe(false);
    expect(config.enableRealSells).toBe(false);
    expect(config.enableSolanaSafetyEnrichment).toBe(false);
    expect(config.safetyEnrichmentTimeoutMs).toBe(8000);
    expect(config.safetyEnrichmentMaxTokensPerRun).toBe(25);
    expect(config.safetyEnrichmentCacheMinutes).toBe(60);
  });

  it('rejects invalid numeric values', () => {
    expect(() => loadConfig({ MAX_BUY_USD: 'abc' })).toThrow(/Invalid numeric value/);
  });
});
