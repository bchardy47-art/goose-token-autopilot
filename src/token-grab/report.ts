import type {
  SocialSignal,
  EventSignal,
  LaunchSignal,
  FreshPool,
  TokenGrabRadarCandidate,
  TokenGrabReport,
  TokenGrabFixtures,
} from './types';
import { matchPoolToSignals, deriveLaunchSignalsFromSocial } from './matching';
import { scoreFreshPoolCandidate, scorePrelaunchCandidate, scoreEventCandidate } from './scoring';

const MIN_FRESH_LAUNCH_SCORE = 40;

const LANE_ORDER: Record<TokenGrabRadarCandidate['lane'], number> = {
  FRESH_LAUNCH_CANDIDATE: 0,
  PRE_LAUNCH_WATCH: 1,
  MEME_EVENT_CANDIDATE: 2,
  EARLY_VELOCITY_WATCH: 3,
  NOISE_RUG_LIKELY: 4,
};

const VELOCITY_MIN_LIQUIDITY = 1_000;
const VELOCITY_MAX_LIQUIDITY = 20_000;
const VELOCITY_MIN_RATIO = 0.5;

export function buildTokenGrabReport(fixtures: TokenGrabFixtures): TokenGrabReport {
  const { socialSignals, eventSignals, freshPools } = fixtures;
  const now = new Date().toISOString();

  const launchSignals: LaunchSignal[] = deriveLaunchSignalsFromSocial(socialSignals);

  const candidates: TokenGrabRadarCandidate[] = [];
  let seq = 0;
  const nextId = (): string => `tg-${String(++seq).padStart(3, '0')}`;

  // Track which tickers/events are claimed by a fresh pool match
  const claimedTickers = new Set<string>();
  const claimedEventIds = new Set<string>();

  // ── Process fresh pools ──────────────────────────────────────────────
  for (const pool of freshPools) {
    const match = matchPoolToSignals(pool, socialSignals, eventSignals, launchSignals);
    const hasAnyMatch =
      match.matchedSocialSignalIds.length > 0 ||
      match.matchedEventSignalIds.length > 0 ||
      match.matchedLaunchSignalIds.length > 0;

    const matchedSocial = socialSignals.filter(s => match.matchedSocialSignalIds.includes(s.id));
    const matchedEvents = eventSignals.filter(e => match.matchedEventSignalIds.includes(e.id));
    const matchedLaunch = launchSignals.filter(l => match.matchedLaunchSignalIds.includes(l.id));

    const result = scoreFreshPoolCandidate(pool, match, socialSignals, eventSignals, launchSignals);

    const allBotOrSpam =
      matchedSocial.length > 0 &&
      matchedSocial.every(s => s.flags.suspectedBot || s.flags.identicalSpamCluster);

    let lane: TokenGrabRadarCandidate['lane'];
    let decision: TokenGrabRadarCandidate['decision'];
    const velocityReasons: string[] = [];

    if (!hasAnyMatch || allBotOrSpam || result.score < MIN_FRESH_LAUNCH_SCORE) {
      // Check for early velocity signal on no-context pools only
      const isNoContext = !hasAnyMatch;
      const liq = pool.liquidityUsd ?? 0;
      const vol = pool.volume5mUsd ?? 0;
      const meetsVelocityRule =
        isNoContext &&
        liq >= VELOCITY_MIN_LIQUIDITY &&
        liq <= VELOCITY_MAX_LIQUIDITY &&
        vol > 0 &&
        vol / liq >= VELOCITY_MIN_RATIO;

      if (meetsVelocityRule) {
        lane = 'EARLY_VELOCITY_WATCH';
        decision = 'WATCH';
        const ratio = (vol / liq).toFixed(2);
        velocityReasons.push(
          `Early volume/liquidity ratio ${ratio} (≥${VELOCITY_MIN_RATIO}) suggests unusual activity`,
        );
        velocityReasons.push('WATCH ONLY — not a buy signal. No social/event context confirmed.');
        velocityReasons.push('Needs snapshot follow-up to assess outcome.');
      } else {
        lane = 'NOISE_RUG_LIKELY';
        decision = 'REJECT';
      }
    } else {
      lane = 'FRESH_LAUNCH_CANDIDATE';
      decision = 'ALERT_ONLY';
      claimedTickers.add(pool.ticker.toUpperCase());
      match.matchedEventSignalIds.forEach(id => claimedEventIds.add(id));
    }

    const poolAgeMinutes = pool.createdAt
      ? Math.round((Date.now() - new Date(pool.createdAt).getTime()) / 60_000)
      : undefined;

    const firstSeenAt =
      matchedSocial.length > 0
        ? matchedSocial.reduce(
            (min, s) => (s.firstSeenAt < min ? s.firstSeenAt : min),
            matchedSocial[0]!.firstSeenAt,
          )
        : pool.createdAt;

    candidates.push({
      id: nextId(),
      tokenName: pool.tokenName,
      ticker: pool.ticker,
      contractAddress: pool.contractAddress,
      poolAddress: pool.poolAddress,
      lane,
      decision,
      score: result.score,
      firstSeenAt,
      poolCreatedAt: pool.createdAt,
      poolAgeMinutes,
      matchedSocialSignals: matchedSocial,
      matchedEventSignals: matchedEvents,
      matchedLaunchSignals: matchedLaunch,
      reasons: [...result.reasons, ...velocityReasons],
      redFlags: result.redFlags,
      noTradingExecuted: true,
    });
  }

  // ── Process pre-launch signals (ticker has no pool yet) ──────────────
  for (const launch of launchSignals) {
    if (launch.ticker && claimedTickers.has(launch.ticker.toUpperCase())) continue;

    const signals = socialSignals.filter(s => launch.sourceSignalIds.includes(s.id));
    const result = scorePrelaunchCandidate(signals, launch);

    candidates.push({
      id: nextId(),
      tokenName: launch.projectName,
      ticker: launch.ticker,
      lane: 'PRE_LAUNCH_WATCH',
      decision: 'WATCH',
      score: result.score,
      firstSeenAt: launch.firstSeenAt,
      matchedSocialSignals: signals,
      matchedEventSignals: [],
      matchedLaunchSignals: [launch],
      reasons: result.reasons,
      redFlags: result.redFlags,
      noTradingExecuted: true,
    });
  }

  // ── Process event signals (no matching pool yet) ─────────────────────
  for (const event of eventSignals) {
    if (claimedEventIds.has(event.id)) continue;

    const result = scoreEventCandidate(event);

    candidates.push({
      id: nextId(),
      tokenName: event.phrase,
      lane: 'MEME_EVENT_CANDIDATE',
      decision: 'WATCH',
      score: result.score,
      firstSeenAt: event.firstSeenAt,
      matchedSocialSignals: [],
      matchedEventSignals: [event],
      matchedLaunchSignals: [],
      reasons: result.reasons,
      redFlags: result.redFlags,
      noTradingExecuted: true,
    });
  }

  candidates.sort(
    (a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || b.score - a.score,
  );

  return {
    generatedAt: now,
    mode: 'fixture-only',
    tradingStatus: 'LOCKED / NO TRADING EXECUTED',
    candidates,
    summary: {
      prelaunchWatch: candidates.filter(c => c.lane === 'PRE_LAUNCH_WATCH').length,
      memeEventCandidates: candidates.filter(c => c.lane === 'MEME_EVENT_CANDIDATE').length,
      freshLaunchCandidates: candidates.filter(c => c.lane === 'FRESH_LAUNCH_CANDIDATE').length,
      earlyVelocityWatch: candidates.filter(c => c.lane === 'EARLY_VELOCITY_WATCH').length,
      rejectedNoise: candidates.filter(c => c.lane === 'NOISE_RUG_LIKELY').length,
      tradingExecuted: 0,
    },
  };
}

export function renderTokenGrabReport(report: TokenGrabReport): string {
  const WIDE = '═'.repeat(62);
  const THIN = '─'.repeat(62);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  Token Grab Ears Demo');
  lines.push(`  Mode    : ${report.mode}`);
  lines.push(`  Trading : ${report.tradingStatus}`);
  lines.push(`  Time    : ${report.generatedAt}`);
  lines.push(WIDE);
  lines.push('');

  for (let i = 0; i < report.candidates.length; i++) {
    const c = report.candidates[i]!;
    lines.push(THIN);
    lines.push(`Candidate ${i + 1}  [${c.lane}]`);
    lines.push(THIN);

    const nameDisplay = [c.ticker ? `$${c.ticker}` : null, c.tokenName]
      .filter(Boolean)
      .join(' — ');
    lines.push(`Name/Ticker    : ${nameDisplay || '(unknown)'}`);
    lines.push(`Lane           : ${c.lane}`);
    lines.push(`Decision       : ${c.decision}`);
    lines.push(`Score          : ${c.score}/100`);
    lines.push(`First seen     : ${c.firstSeenAt}`);
    if (c.poolCreatedAt) lines.push(`Pool created   : ${c.poolCreatedAt}`);
    if (c.poolAgeMinutes != null) lines.push(`Pool age       : ${c.poolAgeMinutes} min`);
    if (c.contractAddress) lines.push(`Contract       : ${c.contractAddress}`);

    if (c.matchedSocialSignals.length > 0) {
      lines.push(
        `Social signals : ${c.matchedSocialSignals.map(s => `@${s.authorHandle}`).join(', ')} (${c.matchedSocialSignals.length})`,
      );
    } else {
      lines.push('Social signals : none');
    }
    if (c.matchedEventSignals.length > 0) {
      lines.push(
        `Event signals  : ${c.matchedEventSignals.map(e => `"${e.phrase}"`).join(', ')}`,
      );
    }

    if (c.reasons.length > 0) {
      lines.push('Why matched:');
      for (const r of c.reasons) lines.push(`  • ${r}`);
    }
    if (c.redFlags.length > 0) {
      lines.push('Red flags:');
      for (const f of c.redFlags) lines.push(`  ! ${f}`);
    }

    if (c.lane === 'EARLY_VELOCITY_WATCH') {
      lines.push('  !! WATCH ONLY — Not a buy signal. No social context confirmed. !!');
    }
    lines.push('');
    lines.push('  NO TRADING EXECUTED');
    lines.push('');
  }

  lines.push(WIDE);
  lines.push('Summary');
  lines.push(WIDE);
  lines.push(`  Pre-launch watch      : ${report.summary.prelaunchWatch}`);
  lines.push(`  Meme event candidates : ${report.summary.memeEventCandidates}`);
  lines.push(`  Fresh launch cands    : ${report.summary.freshLaunchCandidates}`);
  lines.push(`  Early velocity watch  : ${report.summary.earlyVelocityWatch}`);
  lines.push(`  Rejected / noise      : ${report.summary.rejectedNoise}`);
  lines.push(`  Trading executed      : ${report.summary.tradingExecuted}`);
  lines.push('');
  lines.push('  NO TRADING EXECUTED. Report only. No positions opened.');
  lines.push(WIDE);

  return lines.join('\n');
}
