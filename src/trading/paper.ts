import type { AppConfig, PaperPositionView } from '../types';
import type { AppDb } from '../db';

function latestPriceOrThrow(db: AppDb, tokenId: number): number {
  const snapshot = db.getLatestSnapshot(tokenId);
  if (!snapshot?.priceUsd) {
    throw new Error('Latest token snapshot price is unavailable');
  }
  return snapshot.priceUsd;
}

function resolveTokenId(db: AppDb, input: { proposalId?: number; mint?: string; positionId?: number }): { tokenId: number; proposalId: number | null; positionId: number | null } {
  if (input.proposalId) {
    const proposal = db.getProposal(input.proposalId);
    if (!proposal) throw new Error(`Proposal ${input.proposalId} not found`);
    return { tokenId: proposal.token_id, proposalId: proposal.id, positionId: null };
  }

  if (input.mint) {
    const token = db.findTokenByMint(input.mint);
    if (!token) throw new Error(`Token mint ${input.mint} not found`);
    return { tokenId: token.id, proposalId: null, positionId: null };
  }

  if (input.positionId) {
    const positions = db.listPositions('PAPER');
    const position = positions.find((item) => item.id === input.positionId);
    if (!position) throw new Error(`Position ${input.positionId} not found`);
    return { tokenId: position.tokenId, proposalId: null, positionId: position.id };
  }

  throw new Error('Must provide proposal id, mint, or position id');
}

export function paperBuy(db: AppDb, config: AppConfig, input: { proposalId?: number; mint?: string }): { tradeId: number; positionId: number } {
  const { tokenId, proposalId } = resolveTokenId(db, input);
  const score = db.getLatestScore(tokenId);

  if (!score || (score.verdict !== 'PAPER_BUY' && score.verdict !== 'AUTOPILOT_ELIGIBLE')) {
    db.logSafetyEvent(tokenId, 'WARN', 'paper_buy_blocked', 'Paper buy blocked because token is not eligible for paper buy', { tokenId, verdict: score?.verdict ?? null });
    throw new Error('Token is not eligible for paper buy');
  }

  const openPositions = db.getOpenPositionCount('PAPER');
  if (openPositions >= config.maxOpenPositions) {
    db.logSafetyEvent(tokenId, 'WARN', 'paper_buy_blocked', 'Paper buy blocked by max open positions cap', { openPositions, maxOpenPositions: config.maxOpenPositions });
    throw new Error('Max open positions cap reached');
  }

  const priceUsd = latestPriceOrThrow(db, tokenId);
  const amountUsd = Math.min(config.maxBuyUsd, config.maxBankrollUsd - db.getOpenExposureUsd('PAPER'));
  if (amountUsd <= 0) {
    db.logSafetyEvent(tokenId, 'WARN', 'paper_buy_blocked', 'Paper buy blocked by bankroll cap', { amountUsd });
    throw new Error('No remaining bankroll available');
  }

  const quantity = amountUsd / priceUsd;
  const tradeId = db.createPaperTrade(tokenId, proposalId, 'BUY', amountUsd, priceUsd, quantity, 'paper buy executed');
  const positionId = db.createPosition(tokenId, 'PAPER', 'OPEN', priceUsd, quantity, amountUsd, 'opened from paper buy');
  if (proposalId) db.updateProposalStatus(proposalId, 'EXECUTED');
  return { tradeId, positionId };
}

export function paperSell(db: AppDb, input: { positionId?: number; mint?: string }): { tradeId: number; positionId: number; realizedPnlUsd: number } {
  const { tokenId, positionId } = resolveTokenId(db, input);
  const position = positionId ? db.listPositions('PAPER').find((item) => item.id === positionId) : db.listPositions('PAPER').find((item) => item.tokenId === tokenId && item.status === 'OPEN');
  if (!position || position.status !== 'OPEN') {
    db.logSafetyEvent(tokenId, 'WARN', 'paper_sell_blocked', 'Paper sell blocked because open position was not found', { tokenId, positionId });
    throw new Error('Open paper position not found');
  }

  const priceUsd = latestPriceOrThrow(db, tokenId);
  const amountUsd = position.quantity * priceUsd;
  const realizedPnlUsd = amountUsd - position.amountUsd;
  const tradeId = db.createPaperTrade(tokenId, null, 'SELL', amountUsd, priceUsd, position.quantity, 'paper sell executed');
  db.closePosition(position.id, priceUsd, realizedPnlUsd, 'closed from paper sell');
  return { tradeId, positionId: position.id, realizedPnlUsd: Number(realizedPnlUsd.toFixed(6)) };
}

export function getPositionsSummary(db: AppDb): { open: PaperPositionView[]; closed: PaperPositionView[]; realizedPnlUsd: number; unrealizedPnlUsd: number } {
  const positions = db.listPositions('PAPER');
  const open = positions.filter((item) => item.status === 'OPEN');
  const closed = positions.filter((item) => item.status === 'CLOSED');
  const realizedPnlUsd = closed.reduce((sum, item) => sum + (item.realizedPnlUsd ?? 0), 0);
  const unrealizedPnlUsd = open.reduce((sum, item) => sum + (item.unrealizedPnlUsd ?? 0), 0);
  return {
    open,
    closed,
    realizedPnlUsd: Number(realizedPnlUsd.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(6))
  };
}
