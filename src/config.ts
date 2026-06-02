import path from 'node:path';
import dotenv from 'dotenv';
import { redactValue } from './redact';
import type { AppConfig, TokenSourceName } from './types';

dotenv.config();

const DEFAULTS = {
  TOKEN_RADAR_DRY_RUN: true,
  TRADING_DISABLED: true,
  ENABLE_REAL_BUYS: false,
  ENABLE_REAL_SELLS: false,
  ENABLE_AUTO_PAPER_TRADING: true,
  MAX_BANKROLL_USD: 20,
  MAX_BUY_USD: 2,
  MAX_DAILY_LOSS_USD: 6,
  MAX_OPEN_POSITIONS: 3,
  MAX_DAILY_BUYS: 5,
  MAX_DAILY_PAPER_BUYS: 10,
  MAX_AUTO_PAPER_BUY_USD: 2,
  PAPER_MIN_TOTAL_SCORE: 60,
  PAPER_MIN_SAFETY_SCORE: 20,
  PAPER_MIN_MOMENTUM_SCORE: 15,
  PAPER_TAKE_PROFIT_PCT: 50,
  PAPER_STOP_LOSS_PCT: -35,
  PAPER_MAX_HOLD_MINUTES: 360,
  PAPER_TRAILING_STOP_ENABLED: false,
  PAPER_TRAILING_STOP_PCT: 25,
  MAX_SLIPPAGE_BPS: 500,
  MIN_LIQUIDITY_USD: 20000,
  MAX_CHASE_PCT: 150,
  MIN_TOKEN_AGE_MIN: 10,
  MAX_TOKEN_AGE_HOURS: 24,
  MIN_SAFETY_SCORE_FOR_AUTOPILOT: 32,
  MIN_MOMENTUM_SCORE_FOR_AUTOPILOT: 25,
  MIN_TOTAL_SCORE_FOR_AUTOPILOT: 75,
  DATABASE_FILE: './data/token-autopilot.sqlite',
  TOKEN_SOURCE: 'fixture' as TokenSourceName,
  KILL_SWITCH_FILE: './data/.kill-switch',
  ENABLE_SOLANA_SAFETY_ENRICHMENT: false,
  SAFETY_ENRICHMENT_TIMEOUT_MS: 8000,
  SAFETY_ENRICHMENT_MAX_TOKENS_PER_RUN: 25,
  SAFETY_ENRICHMENT_CACHE_MINUTES: 60,
  ENABLE_QUOTE_CHECK: false,
  QUOTE_CHECK_TIMEOUT_MS: 8000,
  QUOTE_CHECK_MAX_TOKENS_PER_RUN: 25,
  QUOTE_CHECK_CACHE_MINUTES: 30,
  QUOTE_CHECK_SELL_AMOUNT_USD: 2
};

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid boolean for ${name}`);
}

function parseNumber(name: string, raw: string | undefined, fallback: number, opts?: { integer?: boolean; min?: number }): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${name}`);
  }
  if (opts?.integer && !Number.isInteger(value)) {
    throw new Error(`Expected integer for ${name}`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new Error(`Value for ${name} must be >= ${opts.min}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tokenSource = (env.TOKEN_SOURCE ?? DEFAULTS.TOKEN_SOURCE) as TokenSourceName;
  if (!['fixture', 'dexscreener'].includes(tokenSource)) {
    throw new Error('TOKEN_SOURCE must be fixture or dexscreener');
  }

  const config: AppConfig = {
    tokenRadarDryRun: parseBoolean('TOKEN_RADAR_DRY_RUN', env.TOKEN_RADAR_DRY_RUN, DEFAULTS.TOKEN_RADAR_DRY_RUN),
    tradingDisabled: parseBoolean('TRADING_DISABLED', env.TRADING_DISABLED, DEFAULTS.TRADING_DISABLED),
    enableRealBuys: parseBoolean('ENABLE_REAL_BUYS', env.ENABLE_REAL_BUYS, DEFAULTS.ENABLE_REAL_BUYS),
    enableRealSells: parseBoolean('ENABLE_REAL_SELLS', env.ENABLE_REAL_SELLS, DEFAULTS.ENABLE_REAL_SELLS),
    enableAutoPaperTrading: parseBoolean('ENABLE_AUTO_PAPER_TRADING', env.ENABLE_AUTO_PAPER_TRADING, DEFAULTS.ENABLE_AUTO_PAPER_TRADING),
    maxBankrollUsd: parseNumber('MAX_BANKROLL_USD', env.MAX_BANKROLL_USD, DEFAULTS.MAX_BANKROLL_USD, { min: 0 }),
    maxBuyUsd: parseNumber('MAX_BUY_USD', env.MAX_BUY_USD, DEFAULTS.MAX_BUY_USD, { min: 0 }),
    maxDailyLossUsd: parseNumber('MAX_DAILY_LOSS_USD', env.MAX_DAILY_LOSS_USD, DEFAULTS.MAX_DAILY_LOSS_USD, { min: 0 }),
    maxOpenPositions: parseNumber('MAX_OPEN_POSITIONS', env.MAX_OPEN_POSITIONS, DEFAULTS.MAX_OPEN_POSITIONS, { integer: true, min: 0 }),
    maxDailyBuys: parseNumber('MAX_DAILY_BUYS', env.MAX_DAILY_BUYS, DEFAULTS.MAX_DAILY_BUYS, { integer: true, min: 0 }),
    maxDailyPaperBuys: parseNumber('MAX_DAILY_PAPER_BUYS', env.MAX_DAILY_PAPER_BUYS, DEFAULTS.MAX_DAILY_PAPER_BUYS, { integer: true, min: 0 }),
    maxAutoPaperBuyUsd: parseNumber('MAX_AUTO_PAPER_BUY_USD', env.MAX_AUTO_PAPER_BUY_USD, DEFAULTS.MAX_AUTO_PAPER_BUY_USD, { min: 0 }),
    paperMinTotalScore: parseNumber('PAPER_MIN_TOTAL_SCORE', env.PAPER_MIN_TOTAL_SCORE, DEFAULTS.PAPER_MIN_TOTAL_SCORE, { min: 0 }),
    paperMinSafetyScore: parseNumber('PAPER_MIN_SAFETY_SCORE', env.PAPER_MIN_SAFETY_SCORE, DEFAULTS.PAPER_MIN_SAFETY_SCORE, { min: 0 }),
    paperMinMomentumScore: parseNumber('PAPER_MIN_MOMENTUM_SCORE', env.PAPER_MIN_MOMENTUM_SCORE, DEFAULTS.PAPER_MIN_MOMENTUM_SCORE, { min: 0 }),
    paperTakeProfitPct: parseNumber('PAPER_TAKE_PROFIT_PCT', env.PAPER_TAKE_PROFIT_PCT, DEFAULTS.PAPER_TAKE_PROFIT_PCT),
    paperStopLossPct: parseNumber('PAPER_STOP_LOSS_PCT', env.PAPER_STOP_LOSS_PCT, DEFAULTS.PAPER_STOP_LOSS_PCT),
    paperMaxHoldMinutes: parseNumber('PAPER_MAX_HOLD_MINUTES', env.PAPER_MAX_HOLD_MINUTES, DEFAULTS.PAPER_MAX_HOLD_MINUTES, { min: 1 }),
    paperTrailingStopEnabled: parseBoolean('PAPER_TRAILING_STOP_ENABLED', env.PAPER_TRAILING_STOP_ENABLED, DEFAULTS.PAPER_TRAILING_STOP_ENABLED),
    paperTrailingStopPct: parseNumber('PAPER_TRAILING_STOP_PCT', env.PAPER_TRAILING_STOP_PCT, DEFAULTS.PAPER_TRAILING_STOP_PCT, { min: 0 }),
    maxSlippageBps: parseNumber('MAX_SLIPPAGE_BPS', env.MAX_SLIPPAGE_BPS, DEFAULTS.MAX_SLIPPAGE_BPS, { min: 0 }),
    minLiquidityUsd: parseNumber('MIN_LIQUIDITY_USD', env.MIN_LIQUIDITY_USD, DEFAULTS.MIN_LIQUIDITY_USD, { min: 0 }),
    maxChasePct: parseNumber('MAX_CHASE_PCT', env.MAX_CHASE_PCT, DEFAULTS.MAX_CHASE_PCT, { min: 0 }),
    minTokenAgeMin: parseNumber('MIN_TOKEN_AGE_MIN', env.MIN_TOKEN_AGE_MIN, DEFAULTS.MIN_TOKEN_AGE_MIN, { min: 0 }),
    maxTokenAgeHours: parseNumber('MAX_TOKEN_AGE_HOURS', env.MAX_TOKEN_AGE_HOURS, DEFAULTS.MAX_TOKEN_AGE_HOURS, { min: 1 }),
    minSafetyScoreForAutopilot: parseNumber('MIN_SAFETY_SCORE_FOR_AUTOPILOT', env.MIN_SAFETY_SCORE_FOR_AUTOPILOT, DEFAULTS.MIN_SAFETY_SCORE_FOR_AUTOPILOT, { min: 0 }),
    minMomentumScoreForAutopilot: parseNumber('MIN_MOMENTUM_SCORE_FOR_AUTOPILOT', env.MIN_MOMENTUM_SCORE_FOR_AUTOPILOT, DEFAULTS.MIN_MOMENTUM_SCORE_FOR_AUTOPILOT, { min: 0 }),
    minTotalScoreForAutopilot: parseNumber('MIN_TOTAL_SCORE_FOR_AUTOPILOT', env.MIN_TOTAL_SCORE_FOR_AUTOPILOT, DEFAULTS.MIN_TOTAL_SCORE_FOR_AUTOPILOT, { min: 0 }),
    databaseFile: path.resolve(env.DATABASE_FILE ?? DEFAULTS.DATABASE_FILE),
    tokenSource,
    killSwitchFile: path.resolve(env.KILL_SWITCH_FILE ?? DEFAULTS.KILL_SWITCH_FILE),
    enableSolanaSafetyEnrichment: parseBoolean('ENABLE_SOLANA_SAFETY_ENRICHMENT', env.ENABLE_SOLANA_SAFETY_ENRICHMENT, DEFAULTS.ENABLE_SOLANA_SAFETY_ENRICHMENT),
    solanaRpcUrl: env.SOLANA_RPC_URL || undefined,
    safetyEnrichmentTimeoutMs: parseNumber('SAFETY_ENRICHMENT_TIMEOUT_MS', env.SAFETY_ENRICHMENT_TIMEOUT_MS, DEFAULTS.SAFETY_ENRICHMENT_TIMEOUT_MS, { integer: true, min: 1 }),
    safetyEnrichmentMaxTokensPerRun: parseNumber('SAFETY_ENRICHMENT_MAX_TOKENS_PER_RUN', env.SAFETY_ENRICHMENT_MAX_TOKENS_PER_RUN, DEFAULTS.SAFETY_ENRICHMENT_MAX_TOKENS_PER_RUN, { integer: true, min: 1 }),
    safetyEnrichmentCacheMinutes: parseNumber('SAFETY_ENRICHMENT_CACHE_MINUTES', env.SAFETY_ENRICHMENT_CACHE_MINUTES, DEFAULTS.SAFETY_ENRICHMENT_CACHE_MINUTES, { integer: true, min: 1 }),
    enableQuoteCheck: parseBoolean('ENABLE_QUOTE_CHECK', env.ENABLE_QUOTE_CHECK, DEFAULTS.ENABLE_QUOTE_CHECK),
    quoteCheckTimeoutMs: parseNumber('QUOTE_CHECK_TIMEOUT_MS', env.QUOTE_CHECK_TIMEOUT_MS, DEFAULTS.QUOTE_CHECK_TIMEOUT_MS, { integer: true, min: 1 }),
    quoteCheckMaxTokensPerRun: parseNumber('QUOTE_CHECK_MAX_TOKENS_PER_RUN', env.QUOTE_CHECK_MAX_TOKENS_PER_RUN, DEFAULTS.QUOTE_CHECK_MAX_TOKENS_PER_RUN, { integer: true, min: 1 }),
    quoteCheckCacheMinutes: parseNumber('QUOTE_CHECK_CACHE_MINUTES', env.QUOTE_CHECK_CACHE_MINUTES, DEFAULTS.QUOTE_CHECK_CACHE_MINUTES, { integer: true, min: 1 }),
    quoteCheckSellAmountUsd: parseNumber('QUOTE_CHECK_SELL_AMOUNT_USD', env.QUOTE_CHECK_SELL_AMOUNT_USD, DEFAULTS.QUOTE_CHECK_SELL_AMOUNT_USD, { min: 0.000001 }),
    quoteCheckSlippageBps: parseNumber('QUOTE_CHECK_SLIPPAGE_BPS', env.QUOTE_CHECK_SLIPPAGE_BPS, parseNumber('MAX_SLIPPAGE_BPS', env.MAX_SLIPPAGE_BPS, DEFAULTS.MAX_SLIPPAGE_BPS, { min: 0 }), { min: 0 }),
    burnerWalletPublicKey: env.BURNER_WALLET_PUBLIC_KEY || undefined,
    burnerWalletPrivateKey: env.BURNER_WALLET_PRIVATE_KEY || undefined,
    mainWalletPresent: parseBoolean('MAIN_WALLET_PRESENT', env.MAIN_WALLET_PRESENT, false)
  };

  if (config.maxBuyUsd > config.maxBankrollUsd) {
    throw new Error('MAX_BUY_USD cannot exceed MAX_BANKROLL_USD');
  }

  return config;
}

export function getConfigSafetyStatus(config: AppConfig): Record<string, unknown> {
  return redactValue({
    dryRun: config.tokenRadarDryRun,
    tradingDisabled: config.tradingDisabled,
    enableRealBuys: config.enableRealBuys,
    enableRealSells: config.enableRealSells,
    enableAutoPaperTrading: config.enableAutoPaperTrading,
    maxBankrollUsd: config.maxBankrollUsd,
    maxBuyUsd: config.maxBuyUsd,
    maxDailyLossUsd: config.maxDailyLossUsd,
    maxOpenPositions: config.maxOpenPositions,
    maxDailyBuys: config.maxDailyBuys,
    maxDailyPaperBuys: config.maxDailyPaperBuys,
    maxAutoPaperBuyUsd: config.maxAutoPaperBuyUsd,
    paperMinTotalScore: config.paperMinTotalScore,
    paperMinSafetyScore: config.paperMinSafetyScore,
    paperMinMomentumScore: config.paperMinMomentumScore,
    paperTakeProfitPct: config.paperTakeProfitPct,
    paperStopLossPct: config.paperStopLossPct,
    paperMaxHoldMinutes: config.paperMaxHoldMinutes,
    paperTrailingStopEnabled: config.paperTrailingStopEnabled,
    paperTrailingStopPct: config.paperTrailingStopPct,
    maxSlippageBps: config.maxSlippageBps,
    minLiquidityUsd: config.minLiquidityUsd,
    maxChasePct: config.maxChasePct,
    minTokenAgeMin: config.minTokenAgeMin,
    maxTokenAgeHours: config.maxTokenAgeHours,
    minSafetyScoreForAutopilot: config.minSafetyScoreForAutopilot,
    minMomentumScoreForAutopilot: config.minMomentumScoreForAutopilot,
    minTotalScoreForAutopilot: config.minTotalScoreForAutopilot,
    databaseFile: config.databaseFile,
    tokenSource: config.tokenSource,
    killSwitchFile: config.killSwitchFile,
    enableSolanaSafetyEnrichment: config.enableSolanaSafetyEnrichment,
    solanaRpcUrlConfigured: Boolean(config.solanaRpcUrl),
    solanaRpcUrl: config.solanaRpcUrl ? '[CONFIGURED]' : undefined,
    safetyEnrichmentTimeoutMs: config.safetyEnrichmentTimeoutMs,
    safetyEnrichmentMaxTokensPerRun: config.safetyEnrichmentMaxTokensPerRun,
    safetyEnrichmentCacheMinutes: config.safetyEnrichmentCacheMinutes,
    enableQuoteCheck: config.enableQuoteCheck,
    quoteCheckTimeoutMs: config.quoteCheckTimeoutMs,
    quoteCheckMaxTokensPerRun: config.quoteCheckMaxTokensPerRun,
    quoteCheckCacheMinutes: config.quoteCheckCacheMinutes,
    quoteCheckSellAmountUsd: config.quoteCheckSellAmountUsd,
    quoteCheckSlippageBps: config.quoteCheckSlippageBps,
    burnerWalletPublicKey: config.burnerWalletPublicKey,
    burnerWalletPrivateKey: config.burnerWalletPrivateKey,
    mainWalletPresent: config.mainWalletPresent
  });
}
