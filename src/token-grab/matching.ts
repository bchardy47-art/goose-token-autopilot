import type { SocialSignal, EventSignal, LaunchSignal, FreshPool, FreshPoolMatch } from './types';

export function matchPoolToSignals(
  pool: FreshPool,
  socialSignals: SocialSignal[],
  eventSignals: EventSignal[],
  launchSignals: LaunchSignal[],
): FreshPoolMatch {
  const matchedSocialIds = new Set<string>();
  const matchedEventIds = new Set<string>();
  const matchedLaunchIds = new Set<string>();
  const reasons: string[] = [];
  const redFlags: string[] = [];

  const poolTicker = pool.ticker.toUpperCase();
  const poolName = pool.tokenName.toLowerCase();

  for (const sig of socialSignals) {
    let hit = false;
    if (pool.contractAddress && sig.extracted.contractAddresses.includes(pool.contractAddress)) {
      hit = true;
      reasons.push(`@${sig.authorHandle} posted contract address`);
    } else if (sig.extracted.tickers.includes(poolTicker)) {
      hit = true;
      reasons.push(`@${sig.authorHandle} mentioned $${poolTicker}`);
    }
    if (hit) {
      matchedSocialIds.add(sig.id);
      if (sig.flags.suspectedBot) redFlags.push(`Signal ${sig.id} is from suspected bot`);
      if (sig.flags.identicalSpamCluster) redFlags.push(`Signal ${sig.id} is part of identical spam cluster`);
    }
  }

  for (const launch of launchSignals) {
    const tickerMatch = launch.ticker && launch.ticker.toUpperCase() === poolTicker;
    const nameMatch = launch.projectName && launch.projectName.toLowerCase() === poolName;
    if (tickerMatch || nameMatch) {
      matchedLaunchIds.add(launch.id);
      reasons.push(`Pre-launch signal predicted ${launch.ticker ?? launch.projectName ?? '?'}`);
    }
  }

  for (const event of eventSignals) {
    const terms = [event.normalizedPhrase, ...event.relatedTerms].map(t => t.toLowerCase());
    if (terms.some(t => poolName.includes(t) || poolTicker.toLowerCase().includes(t))) {
      matchedEventIds.add(event.id);
      reasons.push(`Pool name/ticker matches viral event phrase: "${event.phrase}"`);
    }
  }

  return {
    poolId: pool.id,
    matchedSocialSignalIds: [...matchedSocialIds],
    matchedEventSignalIds: [...matchedEventIds],
    matchedLaunchSignalIds: [...matchedLaunchIds],
    reasons,
    redFlags,
  };
}

export function deriveLaunchSignalsFromSocial(socialSignals: SocialSignal[]): LaunchSignal[] {
  const byTicker = new Map<string, SocialSignal[]>();

  for (const sig of socialSignals) {
    for (const ticker of sig.extracted.tickers) {
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker)!.push(sig);
    }
  }

  const launches: LaunchSignal[] = [];
  for (const [ticker, signals] of byTicker) {
    // Exclude bot/spam signals when assessing whether a real launch signal exists
    const credibleSignals = signals.filter(
      s => !s.flags.suspectedBot && !s.flags.identicalSpamCluster,
    );
    const hasOfficial = credibleSignals.some(
      s => s.flags.knownCaller || s.flags.officialProjectAccount,
    );
    const uniqueCredibleAuthors = new Set(credibleSignals.map(s => s.authorHandle));
    if (uniqueCredibleAuthors.size < 2 && !hasOfficial) continue;

    const earliest = signals.reduce(
      (min, s) => (s.firstSeenAt < min ? s.firstSeenAt : min),
      signals[0]!.firstSeenAt,
    );
    launches.push({
      id: `derived-${ticker}`,
      ticker,
      chain: 'solana',
      firstSeenAt: earliest,
      sourceSignalIds: signals.map(s => s.id),
      officialLinks: credibleSignals.flatMap(s => (s.url ? [s.url] : [])),
      confidence: hasOfficial ? 75 : 50,
    });
  }
  return launches;
}
