// DO_NOT_ENABLE_REAL_TRADING  paperOnly=true  tradingExecuted=0

import { describe, it, expect } from 'vitest';
import {
  isBubbleMapsEnabled, bubbleMapsModeLabel, createOperatingClusterProvider,
  ENV_BM_ENABLED, ENV_BM_DISABLED,
} from '../src/token-grab/bubbleMapsMode';

// ── Default OFF / explicit enable / explicit disable ──────────────────────────────────

describe('isBubbleMapsEnabled — OFF by default', () => {
  it('is DISABLED when no env is set (default OFF)', () => {
    expect(isBubbleMapsEnabled({})).toBe(false);
  });
  it('is ENABLED only when TOKEN_GRAB_BUBBLEMAPS_ENABLED is truthy', () => {
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: '1' })).toBe(true);
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: 'true' })).toBe(true);
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: '0' })).toBe(false);
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: 'no' })).toBe(false);
  });
  it('explicit DISABLED always wins over ENABLED', () => {
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: '1', [ENV_BM_DISABLED]: '1' })).toBe(false);
    expect(isBubbleMapsEnabled({ [ENV_BM_ENABLED]: '1', [ENV_BM_DISABLED]: 'true' })).toBe(false);
  });
  it('label reflects the mode and never implies UNKNOWN becomes CLEAN', () => {
    expect(bubbleMapsModeLabel({})).toContain('DISABLED');
    expect(bubbleMapsModeLabel({})).toContain('no paid BubbleMaps calls');
    expect(bubbleMapsModeLabel({})).toContain('UNKNOWN stays UNKNOWN');
    expect(bubbleMapsModeLabel({ [ENV_BM_ENABLED]: '1' })).toContain('ENABLED');
  });
});

// ── Provider: DISABLED means no BM API path and UNKNOWN outcomes ───────────────────────

describe('createOperatingClusterProvider — disabled means no BM calls, UNKNOWN never CLEAN', () => {
  it('when disabled: provider is offline/disabled and returns UNKNOWN (never CLEAN)', async () => {
    const { provider, bmEnabled } = createOperatingClusterProvider({});   // default OFF
    expect(bmEnabled).toBe(false);
    // getStats reports DISABLED mode (no live calls will be made).
    expect(provider.getStats().mode).toBe('DISABLED');
    const result = await provider.fetchClusterRisk('SomeMintAddressThatWouldNormallyHitBubbleMaps');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
    expect(provider.getStats().liveCallsThisRun).toBe(0);   // NO live BubbleMaps API calls
  });

  it('disabled provider makes zero live calls across many lookups', async () => {
    const { provider } = createOperatingClusterProvider({});
    for (let i = 0; i < 5; i++) {
      const r = await provider.fetchClusterRisk(`mint-${i}`);
      expect(r.clusterRisk).toBe('UNKNOWN');
    }
    expect(provider.getStats().liveCallsThisRun).toBe(0);
  });

  it('when enabled (with no API configured): still UNKNOWN via offline fallback, never CLEAN', async () => {
    const { provider, bmEnabled } = createOperatingClusterProvider({ [ENV_BM_ENABLED]: '1' });
    expect(bmEnabled).toBe(true);
    // No BUBBLEMAPS_API_URL in the injected env → offline provider → UNKNOWN.
    const r = await provider.fetchClusterRisk('mint-x');
    expect(r.clusterRisk).toBe('UNKNOWN');
    expect(r.clusterRisk).not.toBe('CLEAN');
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────

describe('module introduces no unsafe behavior', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/bubbleMapsMode.ts'), 'utf-8');
  it('no auto-paper / paper-buy / --live / wallet / signing / swap / keys', () => {
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap/i);
  });
  it('never relabels UNKNOWN to CLEAN', () => {
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
  });
});
