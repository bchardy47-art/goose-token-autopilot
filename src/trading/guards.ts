import fs from 'node:fs';
import type { AppConfig, QuoteResult, TokenCandidate, TokenScoreResult, TradeSide } from '../types';
import type { AppDb } from '../db';

export function isKillSwitchActive(config: AppConfig): boolean {
  return fs.existsSync(config.killSwitchFile);
}

export function getGuardFailures(params: {
  db: AppDb;
  config: AppConfig;
  side: TradeSide;
  amountUsd: number;
  tokenId: number;
  score: TokenScoreResult | null;
  snapshot: TokenCandidate | null;
  quote: QuoteResult | null;
}): string[] {
  const { db, config, side, amountUsd, tokenId, score, snapshot, quote } = params;
  const failures: string[] = [];

  if (isKillSwitchActive(config)) failures.push('kill switch is active');
  if (config.tokenRadarDryRun) failures.push('TOKEN_RADAR_DRY_RUN=true');
  if (config.tradingDisabled) failures.push('TRADING_DISABLED=true');
  if (side === 'BUY' && !config.enableRealBuys) failures.push('ENABLE_REAL_BUYS=false');
  if (side === 'SELL' && !config.enableRealSells) failures.push('ENABLE_REAL_SELLS=false');
  if (!config.burnerWalletPublicKey || !config.burnerWalletPrivateKey) failures.push('burner wallet config missing');
  if (config.mainWalletPresent) failures.push('main wallet flag present');
  if (amountUsd > config.maxBuyUsd) failures.push('amount exceeds MAX_BUY_USD');
  if (db.getOpenExposureUsd('PAPER') + amountUsd > config.maxBankrollUsd) failures.push('bankroll cap exceeded');
  if (db.getClosedRealizedLossToday('PAPER') >= config.maxDailyLossUsd) failures.push('daily loss cap exceeded');
  if (db.getOpenPositionCount('PAPER') >= config.maxOpenPositions) failures.push('open position cap exceeded');
  if (db.getDailyRealBuyCount() >= config.maxDailyBuys) failures.push('daily buy cap exceeded');
  if (!score) failures.push('token score missing');
  if (!snapshot) failures.push('token snapshot missing');
  if (score && score.verdict !== 'AUTOPILOT_ELIGIBLE') failures.push('token verdict is not AUTOPILOT_ELIGIBLE');
  if (score && score.safetyScore < config.minSafetyScoreForAutopilot) failures.push('safety score below threshold');
  if (score && score.redFlags.length > 0) failures.push('token has hard red flags');
  if (score && score.autopilotBlockers.length > 0) failures.push('token has autopilot blockers');
  if (!quote?.ok) failures.push('quote exists=false');
  if (snapshot && snapshot.sellQuoteAvailable !== 'YES') failures.push('sellability check failed');
  if ((quote?.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps) failures.push('slippage exceeds MAX_SLIPPAGE_BPS');
  if (snapshot && (snapshot.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps) failures.push('snapshot slippage exceeds MAX_SLIPPAGE_BPS');
  if (tokenId <= 0) failures.push('token id invalid');

  return failures;
}
