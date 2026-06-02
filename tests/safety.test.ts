import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AppLogger } from '../src/logger';
import { executeBuy, executeSell, quoteSwap } from '../src/trading/real';
import { createTopProposal } from '../src/proposals/createProposal';
import { scoreToken } from '../src/scoring/scoreToken';
import { evaluateSafety } from '../src/safety/checks';
import { activateKillSwitch } from '../src/kill';
import { seedScoredDb, makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('safety guards', () => {
  it('real buys are blocked by default', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const proposal = createTopProposal(db, config)!;
    const result = executeBuy(db, config, proposal.tokenId, proposal.id, proposal.amountUsd);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/TOKEN_RADAR_DRY_RUN=true/);
    db.close();
  });

  it('real sells are blocked by default', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeSell(db, config, safe.id, null, 1);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/TOKEN_RADAR_DRY_RUN=true/);
    db.close();
  });

  it('TRADING_DISABLED blocks trades', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'true', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/TRADING_DISABLED=true/);
    db.close();
  });

  it('TOKEN_RADAR_DRY_RUN=true blocks trades', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'true', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/TOKEN_RADAR_DRY_RUN=true/);
    db.close();
  });

  it('ENABLE_REAL_BUYS=false blocks buys', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'false', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/ENABLE_REAL_BUYS=false/);
    db.close();
  });

  it('ENABLE_REAL_SELLS=false blocks sells', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'false', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeSell(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/ENABLE_REAL_SELLS=false/);
    db.close();
  });

  it('missing burner wallet blocks trades', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/burner wallet config missing/);
    db.close();
  });

  it('max buy cap is enforced', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, config.maxBuyUsd + 0.01);
    expect(result.reason).toMatch(/amount exceeds MAX_BUY_USD/);
    db.close();
  });

  it('bankroll cap is enforced', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv', MAX_BANKROLL_USD: '1', MAX_BUY_USD: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createPosition(safe.id, 'PAPER', 'OPEN', 1, 1, 1, 'filled bankroll');
    const result = executeBuy(db, config, safe.id, null, 1);
    expect(result.reason).toMatch(/bankroll cap exceeded/);
    db.close();
  });

  it('daily loss cap is enforced', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv', MAX_DAILY_LOSS_USD: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const positionId = db.createPosition(safe.id, 'PAPER', 'OPEN', 1, 1, 1, 'loss case');
    db.closePosition(positionId, 0, -2, 'loss booked');
    const result = executeBuy(db, config, safe.id, null, 0.5);
    expect(result.reason).toMatch(/daily loss cap exceeded/);
    db.close();
  });

  it('open position cap is enforced', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv', MAX_OPEN_POSITIONS: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createPosition(safe.id, 'PAPER', 'OPEN', 1, 1, 1, 'open cap');
    const result = executeBuy(db, config, safe.id, null, 0.5);
    expect(result.reason).toMatch(/open position cap exceeded/);
    db.close();
  });

  it('daily buy cap is enforced', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv', MAX_DAILY_BUYS: '0' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 0.5);
    expect(result.reason).toMatch(/daily buy cap exceeded/);
    db.close();
  });

  it('high-risk tokens are rejected', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    const score = db.getLatestScore(rug.id)!;
    expect(score.verdict).toBe('AVOID');
    expect(score.redFlags.length).toBeGreaterThan(0);
    db.close();
  });

  it('missing authority data rejects autopilot', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(rug.id)!;
    const safety = evaluateSafety(snapshot, config);
    expect(safety.hardRedFlags).toContain('freeze authority unknown');
    expect(safety.hardRedFlags).toContain('mint authority active');
    expect(safety.autopilotBlockers).toContain('unknown freeze authority blocks autopilot');
    expect(safety.autopilotBlockers).toContain('mint authority active blocks autopilot');
    db.close();
  });

  it('freeze authority UNSAFE creates hard red flag and blocks paper/autopilot', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      chain: 'solana', mint: 'F111', symbol: 'F', name: 'Freeze', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'UNSAFE' as const, mintAuthority: 'SAFE' as const, sellQuoteAvailable: 'YES' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, holderConcentration: 'SAFE' as const, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('freeze authority active');
    expect(score.autopilotBlockers).toContain('freeze authority active blocks autopilot');
    expect(score.verdict).toBe('AVOID');
  });

  it('mint authority UNSAFE creates hard red flag and blocks paper/autopilot', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      chain: 'solana', mint: 'M111', symbol: 'M', name: 'Mint', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'SAFE' as const, mintAuthority: 'UNSAFE' as const, sellQuoteAvailable: 'YES' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, holderConcentration: 'SAFE' as const, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('mint authority active');
    expect(score.autopilotBlockers).toContain('mint authority active blocks autopilot');
    expect(score.verdict).toBe('AVOID');
  });

  it('holder concentration RISKY reduces safety score compared to SAFE', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const base = {
      chain: 'solana', mint: 'H111', symbol: 'H', name: 'Holder', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'SAFE' as const, mintAuthority: 'SAFE' as const, sellQuoteAvailable: 'YES' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const safeScore = scoreToken(1, { ...base, holderConcentration: 'SAFE' as const }, config);
    const riskyScore = scoreToken(1, { ...base, holderConcentration: 'RISKY' as const }, config);
    expect(riskyScore.safetyScore).toBeLessThan(safeScore.safetyScore);
    expect(riskyScore.reasons).toContain('holder concentration risky');
  });

  it('holder concentration UNKNOWN remains conservative/unsafe', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      chain: 'solana', mint: 'HU111', symbol: 'HU', name: 'HolderUnknown', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'SAFE' as const, mintAuthority: 'SAFE' as const, sellQuoteAvailable: 'YES' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, holderConcentration: 'UNKNOWN' as const, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const score = scoreToken(1, candidate, config);
    expect(score.redFlags).toContain('holder concentration unknown');
    expect(score.autopilotBlockers).toContain('unknown holder concentration blocks autopilot');
    expect(score.verdict).toBe('AVOID');
  });

  it('low liquidity rejects token', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    expect(db.getLatestScore(rug.id)!.redFlags).toContain('liquidity below MIN_LIQUIDITY_USD');
    db.close();
  });

  it('sell quote failure rejects token', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    const quote = quoteSwap(db, rug.id, 'BUY', 1);
    expect(quote.ok).toBe(false);
    expect(quote.reason).toMatch(/sell quote unavailable/);
    db.close();
  });

  it('sell quote UNKNOWN or unavailable blocks readiness', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const base = {
      chain: 'solana', mint: 'SQ111', symbol: 'SQ', name: 'Sellability', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'SAFE' as const, mintAuthority: 'SAFE' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, holderConcentration: 'SAFE' as const, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const unknownScore = scoreToken(1, { ...base, sellQuoteAvailable: 'UNKNOWN' as const }, config);
    const noScore = scoreToken(2, { ...base, sellQuoteAvailable: 'NO' as const }, config);
    expect(unknownScore.redFlags).toContain('sell quote unknown');
    expect(unknownScore.autopilotBlockers).toContain('unknown sellability blocks autopilot');
    expect(noScore.redFlags).toContain('sell quote unavailable');
    expect(noScore.autopilotBlockers).toContain('sell quote unavailable blocks autopilot');
  });

  it('missing enrichment is conservative', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = {
      chain: 'solana', mint: 'ME111', symbol: 'ME', name: 'MissingEnrichment', source: 'dexscreener', sourceUrl: null,
      discoveredAt: new Date().toISOString(), tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      priceUsd: 1, liquidityUsd: 25000, marketCapUsd: 100000, volume5mUsd: 6000, volume1hUsd: 25000, volume24hUsd: 50000,
      priceChange5mPct: 10, priceChange1hPct: 20, buys5m: 20, sells5m: 10, liquidityGrowthPct: 10,
      freezeAuthority: 'UNKNOWN' as const, mintAuthority: 'UNKNOWN' as const, sellQuoteAvailable: 'UNKNOWN' as const, estimatedSlippageBps: 100,
      metadataPresent: true, websitePresent: true, socialsPresent: true, holderConcentration: 'UNKNOWN' as const, creatorStatus: 'SAFE' as const,
      movedBeforeDiscoveryPct: 10, dataUpdatedAt: new Date().toISOString(), raw: {}
    };
    const score = scoreToken(1, candidate, config);
    expect(score.reasons).toContain('safety enrichment missing');
    expect(score.autopilotBlocked).toBe(true);
  });

  it('slippage above max rejects token', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    expect(db.getLatestScore(rug.id)!.redFlags).toContain('slippage above MAX_SLIPPAGE_BPS');
    db.close();
  });

  it('token over chase threshold rejects token', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    expect(db.getLatestScore(rug.id)!.redFlags).toContain('token moved above MAX_CHASE_PCT before discovery');
    db.close();
  });

  it('kill switch blocks trades', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'priv' });
    cleanup.push(dir);
    activateKillSwitch(config);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const result = executeBuy(db, config, safe.id, null, 0.5);
    expect(result.reason).toMatch(/kill switch is active/);
    db.close();
  });

  it('no private key is printed to logs', async () => {
    const { dir, config, db } = await seedScoredDb({ TOKEN_RADAR_DRY_RUN: 'false', TRADING_DISABLED: 'false', ENABLE_REAL_BUYS: 'true', ENABLE_REAL_SELLS: 'true', BURNER_WALLET_PUBLIC_KEY: 'pub', BURNER_WALLET_PRIVATE_KEY: 'super-secret-private-key' });
    cleanup.push(dir);
    const logger = new AppLogger(false);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    executeBuy(db, config, safe.id, null, 0.5, logger);
    expect(logger.entries.join('\n')).not.toContain('super-secret-private-key');
    db.close();
  });
});
