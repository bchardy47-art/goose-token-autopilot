import { describe, it, expect } from 'vitest';
import {
  resolveLiveTradingConfig,
  renderLiveConfigDoctor,
  CONFIRM_PHRASE,
  ENV,
} from '../src/token-grab/ripperLiveTradingConfig';

// A fully valid live-unlock env (public key only — no secrets anywhere).
function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [ENV.ENABLED]:        '1',
    [ENV.CONFIRM]:        CONFIRM_PHRASE,
    [ENV.KILL_SWITCH]:    '0',
    [ENV.MAX_POSITION]:   '50',
    [ENV.MAX_DAILY_LOSS]: '100',
    [ENV.MAX_OPEN]:       '3',
    [ENV.MAX_TRADES]:     '10',
    [ENV.MAX_SLIPPAGE]:   '150',
    [ENV.MIN_LIQUIDITY]:  '20000',
    [ENV.RPC_URL]:        'https://rpc.example.com',
    [ENV.WALLET_PUBKEY]:  '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv',
    [ENV.SWAP_PROVIDER]:  'jupiter',
    [ENV.EXECUTION_MODE]: 'dry-run',
    ...over,
  };
}

describe('Live Trading Config v1', () => {
  it('is locked by default with empty env', () => {
    const cfg = resolveLiveTradingConfig({ env: {} });
    expect(cfg.liveUnlocked).toBe(false);
    expect(cfg.liveDefaultsOff).toBe(true);
    expect(cfg.unlockRequired).toBe(true);
    expect(cfg.states).toContain('LIVE_LOCKED_BY_DEFAULT');
  });

  it('is ready only with all env present and valid', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv() });
    expect(cfg.liveUnlocked).toBe(true);
    expect(cfg.primaryState).toBe('LIVE_CONFIG_READY');
    expect(cfg.states).toContain('LIVE_CONFIG_READY');
    expect(cfg.blockReasons).toHaveLength(0);
  });

  it('kill switch blocks even with full config', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv({ [ENV.KILL_SWITCH]: '1' }) });
    expect(cfg.liveUnlocked).toBe(false);
    expect(cfg.killSwitchOn).toBe(true);
    expect(cfg.states).toContain('LIVE_CONFIG_KILL_SWITCH_ON');
    expect(cfg.primaryState).toBe('LIVE_CONFIG_KILL_SWITCH_ON');
  });

  it('blocks when the confirm phrase is wrong', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv({ [ENV.CONFIRM]: 'i-am-sure' }) });
    expect(cfg.liveUnlocked).toBe(false);
    expect(cfg.confirmValid).toBe(false);
  });

  it('blocks when a limit is missing or non-positive', () => {
    const missing = resolveLiveTradingConfig({ env: fullEnv({ [ENV.MAX_POSITION]: undefined }) });
    expect(missing.liveUnlocked).toBe(false);
    expect(missing.states).toContain('LIVE_CONFIG_MISSING_LIMITS');

    const zero = resolveLiveTradingConfig({ env: fullEnv({ [ENV.MAX_DAILY_LOSS]: '0' }) });
    expect(zero.liveUnlocked).toBe(false);
    expect(zero.limitsComplete).toBe(false);
  });

  it('blocks when RPC or wallet missing', () => {
    const noRpc = resolveLiveTradingConfig({ env: fullEnv({ [ENV.RPC_URL]: undefined }) });
    expect(noRpc.primaryState).toBe('LIVE_CONFIG_MISSING_RPC');
    const noWallet = resolveLiveTradingConfig({ env: fullEnv({ [ENV.WALLET_PUBKEY]: undefined }) });
    expect(noWallet.primaryState).toBe('LIVE_CONFIG_MISSING_WALLET');
  });

  it('falls back to SOLANA_RPC_URL for RPC presence', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv({ [ENV.RPC_URL]: undefined, SOLANA_RPC_URL: 'https://x' }) });
    expect(cfg.rpcUrlPresent).toBe(true);
  });

  it('redacts private-key-like env and never reads it as wallet', () => {
    // A secret-shaped value in a PRIVATE key env, plus a secret-shaped wallet value.
    const secretArray = '[' + Array.from({ length: 64 }, () => '12').join(',') + ']';
    const cfg = resolveLiveTradingConfig({ env: fullEnv({
      TOKEN_GRAB_WALLET_PRIVATE_KEY: secretArray,
      [ENV.WALLET_PUBKEY]: secretArray,   // secret-shaped → must be redacted, not trusted
    }) });
    expect(cfg.secretRedacted).toBe(true);
    expect(cfg.redactedEnvKeys).toContain('TOKEN_GRAB_WALLET_PRIVATE_KEY');
    expect(cfg.walletPublicKey).toBeNull();        // never trusted a secret-shaped key
    expect(cfg.states).toContain('LIVE_CONFIG_SECRET_REDACTED');
    // And the rendered doctor never prints the secret value.
    const text = renderLiveConfigDoctor(cfg);
    expect(text).not.toContain(secretArray);
    expect(text).not.toContain('12,12,12');
  });

  it('does not mutate the provided env object', () => {
    const env = fullEnv();
    const snapshot = JSON.stringify(env);
    resolveLiveTradingConfig({ env });
    expect(JSON.stringify(env)).toBe(snapshot);
  });

  it('doctor never prints full wallet key and shows unlock state', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv() });
    const text = renderLiveConfigDoctor(cfg);
    expect(text).toContain('LIVE TRADING CONFIG DOCTOR');
    expect(text).toContain('Live unlocked    : YES');
    expect(text).not.toContain('7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv');  // full key not echoed
    expect(text).toContain('(public)');
  });

  it('mode override forces execution mode', () => {
    const cfg = resolveLiveTradingConfig({ env: fullEnv(), modeOverride: 'live' });
    expect(cfg.executionMode).toBe('live');
  });
});
