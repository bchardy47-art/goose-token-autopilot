import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('config', () => {
  it('loads safe defaults', () => {
    const config = loadConfig({});
    expect(config.tokenRadarDryRun).toBe(true);
    expect(config.tradingDisabled).toBe(true);
    expect(config.enableRealBuys).toBe(false);
    expect(config.enableRealSells).toBe(false);
  });

  it('rejects invalid numeric values', () => {
    expect(() => loadConfig({ MAX_BUY_USD: 'abc' })).toThrow(/Invalid numeric value/);
  });
});
