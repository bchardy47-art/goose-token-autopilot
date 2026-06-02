import type { AppConfig, SafetyEvaluation, TokenCandidate } from '../types';

function ageMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.tokenCreatedAt).getTime()) / 60_000;
}

function dataAgeMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.dataUpdatedAt).getTime()) / 60_000;
}

export function evaluateSafety(candidate: TokenCandidate, config: AppConfig): SafetyEvaluation {
  const hardRedFlags: string[] = [];
  const autopilotBlockers: string[] = [];
  const reasons: string[] = [];

  const pushUnique = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };

  const addRedFlag = (flag: string): void => {
    pushUnique(hardRedFlags, flag);
    pushUnique(reasons, flag);
  };

  const addReason = (reason: string): void => {
    pushUnique(reasons, reason);
  };

  const addBlocker = (blocker: string): void => {
    pushUnique(autopilotBlockers, blocker);
    addReason(blocker);
  };

  if (candidate.freezeAuthority === 'UNSAFE') {
    addRedFlag('freeze authority active');
    addBlocker('freeze authority active blocks autopilot');
  }
  if (candidate.freezeAuthority === 'UNKNOWN') {
    addRedFlag('freeze authority unknown');
    addBlocker('unknown freeze authority blocks autopilot');
  }

  if (candidate.mintAuthority === 'UNSAFE') {
    addRedFlag('mint authority active');
    addBlocker('mint authority active blocks autopilot');
  }
  if (candidate.mintAuthority === 'UNKNOWN') {
    addRedFlag('mint authority unknown');
    addBlocker('unknown mint authority blocks autopilot');
  }

  if (candidate.liquidityUsd === null || candidate.priceUsd === null) addRedFlag('missing price/liquidity data');
  if ((candidate.liquidityUsd ?? 0) < config.minLiquidityUsd) addRedFlag('liquidity below MIN_LIQUIDITY_USD');
  if (candidate.sellQuoteAvailable === 'NO') {
    addRedFlag('sell quote unavailable');
    addBlocker('sell quote unavailable blocks autopilot');
  }
  if (candidate.sellQuoteAvailable === 'UNKNOWN') {
    addRedFlag('sell quote unavailable');
    addRedFlag('sell quote unknown');
    addBlocker('unknown sellability blocks autopilot');
  }
  if ((candidate.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps) addRedFlag('slippage above MAX_SLIPPAGE_BPS');
  if (dataAgeMinutes(candidate) > 15) addRedFlag('data stale');
  if (!candidate.metadataPresent) addRedFlag('token metadata missing');
  if ((candidate.movedBeforeDiscoveryPct ?? Number.POSITIVE_INFINITY) > config.maxChasePct) addRedFlag('token moved above MAX_CHASE_PCT before discovery');
  if (candidate.holderConcentration === 'RISKY') {
    addRedFlag('holder concentration risky');
    addRedFlag('holder concentration high');
  }
  if (candidate.holderConcentration === 'UNKNOWN') {
    addRedFlag('holder concentration unknown');
    addBlocker('unknown holder concentration blocks autopilot');
  }
  if (
    candidate.chain === 'solana' &&
    candidate.mintAuthority === 'UNKNOWN' &&
    candidate.freezeAuthority === 'UNKNOWN' &&
    candidate.holderConcentration === 'UNKNOWN'
  ) {
    addReason('safety enrichment missing');
  }
  if (candidate.creatorStatus === 'RISKY') addRedFlag('creator risk flagged');
  if (candidate.creatorStatus === 'UNKNOWN') addRedFlag('creator status unknown');

  const age = ageMinutes(candidate);
  if (age < config.minTokenAgeMin) addBlocker('token is younger than MIN_TOKEN_AGE_MIN');
  if (age > config.maxTokenAgeHours * 60) addBlocker('token is older than MAX_TOKEN_AGE_HOURS');

  if (hardRedFlags.length === 0) {
    addReason('no hard red flags detected in current V1 checks');
  }

  return { hardRedFlags, autopilotBlockers, reasons };
}
