// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  liveDefaultsOff=true  unlockRequired=true
//
// Live Trading Config v1 — resolves and validates the env-driven configuration that
// controls whether the app is allowed to place REAL trades. Live trading is OFF by
// default and unlockable only with explicit, deliberate env confirmation.
//
// This module NEVER prints secrets, NEVER stores private keys, and NEVER trades. It
// only reads env, validates limits, and reports a readiness state. Secret-shaped
// values are redacted before they can appear in any output.

// ── Env var names (single source of truth) ─────────────────────────────────────

export const ENV = {
  ENABLED:        'TOKEN_GRAB_LIVE_TRADING_ENABLED',
  CONFIRM:        'TOKEN_GRAB_LIVE_TRADING_CONFIRM',
  KILL_SWITCH:    'TOKEN_GRAB_REAL_KILL_SWITCH',
  MAX_POSITION:   'TOKEN_GRAB_REAL_MAX_POSITION_USD',
  MAX_DAILY_LOSS: 'TOKEN_GRAB_REAL_MAX_DAILY_LOSS_USD',
  MAX_OPEN:       'TOKEN_GRAB_REAL_MAX_OPEN_POSITIONS',
  MAX_TRADES:     'TOKEN_GRAB_REAL_MAX_TRADES_PER_DAY',
  MAX_SLIPPAGE:   'TOKEN_GRAB_REAL_MAX_SLIPPAGE_BPS',
  MIN_LIQUIDITY:  'TOKEN_GRAB_REAL_MIN_LIQUIDITY_USD',
  RPC_URL:        'TOKEN_GRAB_RPC_URL',
  WALLET_PUBKEY:  'TOKEN_GRAB_WALLET_PUBLIC_KEY',
  SWAP_PROVIDER:  'TOKEN_GRAB_SWAP_PROVIDER',
  EXECUTION_MODE: 'TOKEN_GRAB_EXECUTION_MODE',
} as const;

// Fallback RPC env used by the rest of the repo (raw Solana JSON-RPC).
const FALLBACK_RPC_ENV = 'SOLANA_RPC_URL';

// The exact phrase the operator must set to confirm they accept real-money risk.
export const CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_CAN_LOSE_REAL_MONEY';

export type LiveConfigState =
  | 'LIVE_LOCKED_BY_DEFAULT'
  | 'LIVE_CONFIG_READY'
  | 'LIVE_CONFIG_MISSING_RPC'
  | 'LIVE_CONFIG_MISSING_WALLET'
  | 'LIVE_CONFIG_MISSING_LIMITS'
  | 'LIVE_CONFIG_KILL_SWITCH_ON'
  | 'LIVE_CONFIG_SECRET_REDACTED';

export type ExecutionMode = 'dry-run' | 'mock' | 'live';

export interface RealLimits {
  maxPositionUsd:   number | null;
  maxDailyLossUsd:  number | null;
  maxOpenPositions: number | null;
  maxTradesPerDay:  number | null;
  maxSlippageBps:   number | null;
  minLiquidityUsd:  number | null;
}

export interface LiveTradingConfig {
  // raw resolution
  enabled:          boolean;
  confirmValid:     boolean;
  killSwitchOn:     boolean;
  rpcUrlPresent:    boolean;
  walletPublicKey:  string | null;   // public key only — safe to display (still validated as non-secret)
  swapProvider:     string | null;
  executionMode:    ExecutionMode;
  limits:           RealLimits;

  // derived
  limitsComplete:   boolean;
  liveUnlocked:     boolean;          // true ONLY when every condition for real trading is met
  states:           LiveConfigState[];
  primaryState:     LiveConfigState;
  blockReasons:     string[];
  redactedEnvKeys:  string[];         // env keys that looked secret-shaped and were withheld
  secretRedacted:   boolean;

  // safety
  liveDefaultsOff:  true;
  unlockRequired:   true;
}

export interface LiveTradingConfigOptions {
  // Inject env for testability; defaults to process.env. Never mutated.
  env?: Record<string, string | undefined>;
  // Override execution mode (e.g. from a CLI flag). Env still gates whether live is allowed.
  modeOverride?: ExecutionMode;
}

// ── Secret detection / redaction ─────────────────────────────────────────────────

// Heuristic: env keys that look like they could hold a private key / secret. We NEVER
// read these into the config; we only record that they were present-and-withheld.
const SECRET_KEY_PATTERN = /(PRIVATE|SECRET|KEYPAIR|MNEMONIC|SEED|PASSPHRASE|SIGNER_KEY|PRIV_KEY)/i;

// A value that looks like a base58/base64 secret blob or a JSON byte array.
function looksLikeSecretValue(v: string): boolean {
  const t = v.trim();
  if (/^\[\s*\d+\s*(,\s*\d+\s*){31,}\]$/.test(t)) return true;     // JSON byte array (>=32 bytes)
  if (/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(t)) return true;           // long base58 blob
  if (/^[A-Za-z0-9+/=]{80,}$/.test(t)) return true;                 // long base64 blob
  return false;
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isTrue(v: string | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

// A wallet public key must be a plausible Solana base58 address (32–44 chars) and must
// NOT look like a secret blob. If it looks secret-shaped, we redact rather than trust it.
function sanitizeWalletPubkey(v: string | undefined): { value: string | null; redacted: boolean } {
  if (v == null || v.trim() === '') return { value: null, redacted: false };
  const t = v.trim();
  if (looksLikeSecretValue(t)) return { value: null, redacted: true };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return { value: t, redacted: false };
  // Unrecognized shape — treat as missing (do not echo arbitrary env back).
  return { value: null, redacted: false };
}

// ── Resolver ─────────────────────────────────────────────────────────────────────

export function resolveLiveTradingConfig(opts: LiveTradingConfigOptions = {}): LiveTradingConfig {
  const env = opts.env ?? process.env;

  // Scan for secret-shaped env keys we should never surface.
  const redactedEnvKeys: string[] = [];
  for (const [k, val] of Object.entries(env)) {
    if (!k.startsWith('TOKEN_GRAB_')) continue;
    if (SECRET_KEY_PATTERN.test(k) || (typeof val === 'string' && looksLikeSecretValue(val))) {
      redactedEnvKeys.push(k);
    }
  }

  const enabled      = isTrue(env[ENV.ENABLED]);
  const confirmValid = (env[ENV.CONFIRM] ?? '').trim() === CONFIRM_PHRASE;
  const killSwitchOn = isTrue(env[ENV.KILL_SWITCH]);
  const rpcUrlPresent = ((env[ENV.RPC_URL] ?? env[FALLBACK_RPC_ENV] ?? '').trim().length > 0);

  const wallet = sanitizeWalletPubkey(env[ENV.WALLET_PUBKEY]);
  const swapProvider = (env[ENV.SWAP_PROVIDER] ?? '').trim() || null;

  const modeRaw = (opts.modeOverride ?? (env[ENV.EXECUTION_MODE] ?? '').trim().toLowerCase()) as string;
  const executionMode: ExecutionMode =
    modeRaw === 'live' ? 'live' : modeRaw === 'mock' ? 'mock' : 'dry-run';

  const limits: RealLimits = {
    maxPositionUsd:   num(env[ENV.MAX_POSITION]),
    maxDailyLossUsd:  num(env[ENV.MAX_DAILY_LOSS]),
    maxOpenPositions: num(env[ENV.MAX_OPEN]),
    maxTradesPerDay:  num(env[ENV.MAX_TRADES]),
    maxSlippageBps:   num(env[ENV.MAX_SLIPPAGE]),
    minLiquidityUsd:  num(env[ENV.MIN_LIQUIDITY]),
  };
  const limitsComplete = Object.values(limits).every(v => v != null && v > 0);

  // ── Determine states + block reasons ────────────────────────────────────────
  const states: LiveConfigState[] = [];
  const blockReasons: string[] = [];

  if (killSwitchOn) {
    states.push('LIVE_CONFIG_KILL_SWITCH_ON');
    blockReasons.push(`${ENV.KILL_SWITCH} is ON — all live trading is hard-blocked.`);
  }
  if (!rpcUrlPresent) {
    states.push('LIVE_CONFIG_MISSING_RPC');
    blockReasons.push(`${ENV.RPC_URL} (or ${FALLBACK_RPC_ENV}) is not set.`);
  }
  if (wallet.value == null) {
    states.push('LIVE_CONFIG_MISSING_WALLET');
    blockReasons.push(wallet.redacted
      ? `${ENV.WALLET_PUBKEY} looked secret-shaped and was redacted — set a PUBLIC key only.`
      : `${ENV.WALLET_PUBKEY} is not set to a valid Solana public key.`);
  }
  if (!limitsComplete) {
    states.push('LIVE_CONFIG_MISSING_LIMITS');
    blockReasons.push('One or more real-trading limits is missing or not positive ' +
      `(${ENV.MAX_POSITION}, ${ENV.MAX_DAILY_LOSS}, ${ENV.MAX_OPEN}, ${ENV.MAX_TRADES}, ${ENV.MAX_SLIPPAGE}, ${ENV.MIN_LIQUIDITY}).`);
  }
  if (!swapProvider) {
    blockReasons.push(`${ENV.SWAP_PROVIDER} is not set.`);
  }
  if (!enabled) {
    blockReasons.push(`${ENV.ENABLED} is not 1 — live trading is locked by default.`);
  }
  if (!confirmValid) {
    blockReasons.push(`${ENV.CONFIRM} must equal the exact confirmation phrase.`);
  }
  if (redactedEnvKeys.length > 0) {
    states.push('LIVE_CONFIG_SECRET_REDACTED');
  }

  // Live is unlocked ONLY when every condition holds.
  const liveUnlocked =
    enabled && confirmValid && !killSwitchOn &&
    rpcUrlPresent && wallet.value != null && !!swapProvider && limitsComplete;

  if (liveUnlocked) {
    states.push('LIVE_CONFIG_READY');
  }
  if (!enabled && !killSwitchOn) {
    // Default posture when not explicitly enabled.
    states.unshift('LIVE_LOCKED_BY_DEFAULT');
  }
  if (states.length === 0) states.push('LIVE_LOCKED_BY_DEFAULT');

  const primaryState: LiveConfigState =
    liveUnlocked ? 'LIVE_CONFIG_READY' :
    killSwitchOn ? 'LIVE_CONFIG_KILL_SWITCH_ON' :
    !rpcUrlPresent ? 'LIVE_CONFIG_MISSING_RPC' :
    wallet.value == null ? 'LIVE_CONFIG_MISSING_WALLET' :
    !limitsComplete ? 'LIVE_CONFIG_MISSING_LIMITS' :
    'LIVE_LOCKED_BY_DEFAULT';

  return {
    enabled,
    confirmValid,
    killSwitchOn,
    rpcUrlPresent,
    walletPublicKey: wallet.value,
    swapProvider,
    executionMode,
    limits,
    limitsComplete,
    liveUnlocked,
    states: dedupe(states),
    primaryState,
    blockReasons,
    redactedEnvKeys,
    secretRedacted: redactedEnvKeys.length > 0,
    liveDefaultsOff: true,
    unlockRequired:  true,
  };
}

function dedupe<T>(arr: T[]): T[] { return [...new Set(arr)]; }

// ── Doctor report (human-readable, secret-safe) ─────────────────────────────────

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

export function renderLiveConfigDoctor(cfg: LiveTradingConfig): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — LIVE TRADING CONFIG DOCTOR');
  L.push('  [REAL TRADING DEFAULTS OFF — UNLOCK REQUIRED — NO SECRETS PRINTED]');
  L.push(SEP, '');

  const capable = cfg.rpcUrlPresent && cfg.walletPublicKey != null && cfg.swapProvider != null && cfg.limitsComplete;
  const headline = cfg.liveUnlocked
    ? 'LIVE_CONFIG_READY — live trading is UNLOCKED (will execute real orders only when run in --live).'
    : capable
      ? 'LIVE CAPABLE BUT NOT CONFIRMED — config present but unlock phrase / enable flag missing.'
      : 'LIVE CAPABLE BUT NOT CONFIGURED — required RPC/wallet/limits/provider not fully set.';
  L.push(`  Primary state    : ${cfg.primaryState}`);
  L.push(`  Headline         : ${headline}`);
  L.push(`  Live unlocked    : ${cfg.liveUnlocked ? 'YES' : 'NO'}`);
  L.push(`  Execution mode   : ${cfg.executionMode}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  ENV STATUS (values redacted where sensitive)');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${ENV.ENABLED.padEnd(40)} : ${cfg.enabled ? '1 (enabled)' : 'not enabled'}`);
  L.push(`  ${ENV.CONFIRM.padEnd(40)} : ${cfg.confirmValid ? 'valid phrase ✓' : 'missing/invalid'}`);
  L.push(`  ${ENV.KILL_SWITCH.padEnd(40)} : ${cfg.killSwitchOn ? 'ON (blocks live)' : 'off'}`);
  L.push(`  ${ENV.RPC_URL.padEnd(40)} : ${cfg.rpcUrlPresent ? 'present' : 'MISSING'}`);
  L.push(`  ${ENV.WALLET_PUBKEY.padEnd(40)} : ${cfg.walletPublicKey ? maskPubkey(cfg.walletPublicKey) : 'MISSING/invalid'}`);
  L.push(`  ${ENV.SWAP_PROVIDER.padEnd(40)} : ${cfg.swapProvider ?? 'MISSING'}`);
  L.push('');
  L.push('  LIMITS:');
  L.push(`    maxPositionUsd   : ${fmtLimit(cfg.limits.maxPositionUsd)}`);
  L.push(`    maxDailyLossUsd  : ${fmtLimit(cfg.limits.maxDailyLossUsd)}`);
  L.push(`    maxOpenPositions : ${fmtLimit(cfg.limits.maxOpenPositions)}`);
  L.push(`    maxTradesPerDay  : ${fmtLimit(cfg.limits.maxTradesPerDay)}`);
  L.push(`    maxSlippageBps   : ${fmtLimit(cfg.limits.maxSlippageBps)}`);
  L.push(`    minLiquidityUsd  : ${fmtLimit(cfg.limits.minLiquidityUsd)}`);
  L.push('');

  if (cfg.secretRedacted) {
    L.push(`  ⚠ ${cfg.redactedEnvKeys.length} secret-shaped env key(s) detected and WITHHELD (never read/printed):`);
    L.push(`     ${cfg.redactedEnvKeys.join(', ')}`);
    L.push('');
  }

  if (cfg.blockReasons.length > 0) {
    L.push('  WHY LIVE IS NOT UNLOCKED:');
    for (const r of cfg.blockReasons) L.push(`    • ${r}`);
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  liveDefaultsOff=true   unlockRequired=true   killSwitchRespected=true');
  L.push('  No private keys are read or printed. Wallet PUBLIC key only. Real trading stays OFF until unlocked.');
  L.push(SEP, '');
  return L.join('\n');
}

// Show only the ends of a public key (still public, but avoids full echo in logs).
function maskPubkey(pk: string): string {
  if (pk.length <= 10) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)} (public)`;
}
function fmtLimit(v: number | null): string {
  return v == null ? 'MISSING' : v > 0 ? String(v) : `${v} (INVALID — must be > 0)`;
}
