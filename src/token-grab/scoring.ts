import type { SocialSignal, EventSignal, LaunchSignal, FreshPool, FreshPoolMatch } from './types';

export interface ScoreResult {
  score: number;
  reasons: string[];
  redFlags: string[];
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function credibleSignals(signals: SocialSignal[]): SocialSignal[] {
  return signals.filter(s => !s.flags.suspectedBot && !s.flags.identicalSpamCluster);
}

export function scoreFreshPoolCandidate(
  pool: FreshPool,
  match: FreshPoolMatch,
  allSocialSignals: SocialSignal[],
  allEventSignals: EventSignal[],
  allLaunchSignals: LaunchSignal[],
): ScoreResult {
  let score = 0;
  const reasons: string[] = [...match.reasons];
  const redFlags: string[] = [...match.redFlags];

  const matchedSocial = allSocialSignals.filter(s => match.matchedSocialSignalIds.includes(s.id));
  const matchedEvents = allEventSignals.filter(e => match.matchedEventSignalIds.includes(e.id));
  const matchedLaunch = allLaunchSignals.filter(l => match.matchedLaunchSignalIds.includes(l.id));

  // Only count credible (non-bot, non-spam) signals for positive scoring
  const credible = credibleSignals(matchedSocial);
  const preLaunchCredible = credible.filter(
    s => !s.createdAt || s.createdAt < pool.createdAt,
  );

  if (preLaunchCredible.length > 0) {
    score += 25;
    reasons.push(`+25: ${preLaunchCredible.length} credible pre-launch signal(s) before pool creation`);
  } else if (matchedSocial.length > 0) {
    score -= 25;
    redFlags.push('-25: Matched social signals are post-launch or all bot/spam');
  }

  const uniqueCredibleAuthors = new Set(credible.map(s => s.authorHandle));
  if (uniqueCredibleAuthors.size >= 2) {
    score += 20;
    reasons.push(`+20: ${uniqueCredibleAuthors.size} independent credible authors`);
  }

  const hasHighCred = credible.some(
    s => s.flags.knownCaller || s.flags.officialProjectAccount || (s.authorCredibility ?? 0) >= 70,
  );
  if (hasHighCred) {
    score += 15;
    reasons.push('+15: Known caller or official project account involved');
  }

  if (matchedLaunch.length > 0) {
    score += 10;
    reasons.push(`+10: ${matchedLaunch.length} pre-launch signal(s) match this pool`);
  }

  if (matchedEvents.length > 0) {
    const maxVelocity = Math.max(...matchedEvents.map(e => e.velocityScore));
    if (maxVelocity >= 50) {
      score += 15;
      reasons.push(`+15: Pool matches viral event phrase (velocity=${maxVelocity})`);
    } else {
      score += 5;
      reasons.push(`+5: Pool matches event phrase (velocity=${maxVelocity})`);
    }
  }

  if (pool.metadata?.x || pool.metadata?.website) {
    score += 10;
    reasons.push('+10: Social/website metadata present on pool');
  } else {
    score -= 15;
    redFlags.push('-15: No social/website metadata on pool');
  }

  if ((pool.liquidityUsd ?? 0) >= 20_000) {
    score += 10;
    reasons.push('+10: Liquidity above $20k');
  } else {
    score -= 10;
    redFlags.push('-10: Liquidity missing or below $20k');
  }

  const hasGoodEngagement = credible.some(
    s => s.engagement && ((s.engagement.likes ?? 0) + (s.engagement.reposts ?? 0)) > 10,
  );
  if (hasGoodEngagement) {
    score += 5;
    reasons.push('+5: Organic engagement visible on social signals');
  }

  // Spam / bot penalties (applied on top of the above)
  const spamCount = matchedSocial.filter(s => s.flags.identicalSpamCluster).length;
  if (spamCount > 0) {
    score -= 20;
    redFlags.push(`-20: ${spamCount} identical spam cluster signal(s)`);
  }

  const botCount = matchedSocial.filter(s => s.flags.suspectedBot).length;
  if (botCount > 0 && botCount === matchedSocial.length) {
    score -= 20;
    redFlags.push('-20: All matched social signals are suspected bots');
  }

  if (matchedSocial.length === 0 && matchedEvents.length === 0 && matchedLaunch.length === 0) {
    score -= 15;
    redFlags.push('-15: No social/event/pre-launch context found for this pool');
  }

  return { score: clamp(score), reasons, redFlags };
}

export function scorePrelaunchCandidate(
  signals: SocialSignal[],
  launch: LaunchSignal,
): ScoreResult {
  let score = 50;
  const reasons: string[] = [];
  const redFlags: string[] = [];

  const credible = credibleSignals(signals);
  const hasOfficial = credible.some(s => s.flags.officialProjectAccount || s.flags.knownCaller);
  if (hasOfficial) {
    score += 20;
    reasons.push('+20: Official project account or known caller involved');
  }

  const uniqueAuthors = new Set(credible.map(s => s.authorHandle));
  if (uniqueAuthors.size >= 2) {
    score += 15;
    reasons.push(`+15: ${uniqueAuthors.size} independent credible authors`);
  }

  const confidenceBonus = Math.round(launch.confidence * 0.15);
  score += confidenceBonus;
  reasons.push(`+${confidenceBonus}: Launch confidence factor (${launch.confidence}/100)`);

  const hasSpam = signals.some(s => s.flags.suspectedBot || s.flags.identicalSpamCluster);
  if (hasSpam) {
    score -= 20;
    redFlags.push('-20: Spam/bot signals detected in pre-launch chatter');
  }

  return { score: clamp(score), reasons, redFlags };
}

export function scoreEventCandidate(event: EventSignal): ScoreResult {
  const score = clamp(Math.round(40 + event.velocityScore * 0.5));
  return {
    score,
    reasons: [
      `Event velocity ${event.velocityScore}/100, evidence count ${event.evidenceCount}`,
    ],
    redFlags: [],
  };
}
