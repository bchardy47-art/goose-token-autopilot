import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { verifySafety } from '../src/verifySafety';

describe('verifySafety redaction', () => {
  it('redacts Solana RPC URL while showing configured status', () => {
    const config = loadConfig({
      SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=secret123',
      ENABLE_SOLANA_SAFETY_ENRICHMENT: 'true'
    });

    const status = verifySafety(config);
    const rendered = JSON.stringify(status);

    expect(status).toHaveProperty('solanaRpcUrlConfigured', true);
    expect(status).toHaveProperty('solanaRpcUrl', '[CONFIGURED]');
    expect(rendered).not.toContain('https://mainnet.helius-rpc.com/?api-key=secret123');
    expect(rendered).not.toContain('secret123');
    expect((status as Record<string, unknown>).realTradingLockedByDefault).toBe(true);
  });

  it('shows rpc not configured when missing', () => {
    const config = loadConfig({});
    const status = verifySafety(config);
    expect(status).toHaveProperty('solanaRpcUrlConfigured', false);
    expect((status as Record<string, unknown>).solanaRpcUrl).toBeUndefined();
  });
});
