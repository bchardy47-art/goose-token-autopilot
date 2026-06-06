import type {
  TokenGrabAutopsyCandidate,
  TokenGrabAutopsySnapshot,
  TokenGrabAutopsyResult,
} from './autopsy';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BadRejectReviewNote {
  type:
    | 'LIQUIDITY_VELOCITY'
    | 'EARLY_CADENCE'
    | 'ZERO_SCORE_MAJOR_RUN'
    | 'NO_SOCIAL_CONTEXT'
    | 'DUPLICATE_TICKER'
    | 'LIQUIDITY_ARRIVED_LATE';
  note: string;
}

export interface SnapshotTimelineEntry {
  observedAt: string;
  minutesAfterDetection: number;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
}

export interface BadRejectReviewItem {
  candidateId: string;
  tokenName: string;
  ticker: string;
  contractAddress?: string;
  poolAddress?: string;
  lane: string;
  decision: string;
  scoreAtDetection: number;
  detectedAt: string;
  poolCreatedAt?: string;
  reasons: string[];
  redFlags: string[];
  outcome: string;
  maxGainPct?: number;
  maxDrawdownPct?: number;
  liquidityChangePct?: number;
  firstRunAtMinutes?: number;
  snapshotTimeline: SnapshotTimelineEntry[];
  missedSignalNotes: BadRejectReviewNote[];
  recommendations: string[];
  noTradingExecuted: true;
}

export interface BadRejectReviewReport {
  generatedAt: string;
  mode: 'session-file';
  tradingStatus: 'LOCKED / NO TRADING EXECUTED';
  badRejectCount: number;
  items: BadRejectReviewItem[];
  summary: {
    candidatesReviewed: number;
    badRejectCount: number;
    largestMissedGainPct?: number;
    earliestMissedRunMinutes?: number;
    commonRejectionReasons: string[];
    tradingExecuted: 0;
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function inferMissedSignalNotes(
  candidate: TokenGrabAutopsyCandidate,
  result: TokenGrabAutopsyResult,
  candidateSnapshots: TokenGrabAutopsySnapshot[],
  allCandidates: TokenGrabAutopsyCandidate[],
): BadRejectReviewNote[] {
  const notes: BadRejectReviewNote[] = [];

  if (result.liquidityChangePct != null && result.liquidityChangePct > 200) {
    notes.push({
      type: 'LIQUIDITY_VELOCITY',
      note: 'Liquidity velocity after detection was strong; consider monitoring early liquidity growth.',
    });
  }

  if (result.firstRunAtMinutes != null && result.firstRunAtMinutes <= 30) {
    notes.push({
      type: 'EARLY_CADENCE',
      note: 'Run began quickly after detection; consider earlier second snapshot cadence.',
    });
  }

  if (candidate.scoreAtDetection === 0 && (result.maxGainPct ?? 0) > 500) {
    notes.push({
      type: 'ZERO_SCORE_MAJOR_RUN',
      note: 'Zero-score reject produced major run; inspect whether no-context pools need a separate watch lane, not a buy lane.',
    });
  }

  const hasNoContext = candidate.redFlags.some(
    f =>
      f.toLowerCase().includes('no social') ||
      f.toLowerCase().includes('no context') ||
      f.toLowerCase().includes('no social/event'),
  );
  if (hasNoContext) {
    notes.push({
      type: 'NO_SOCIAL_CONTEXT',
      note: 'No social/event context was available at detection; this may be random pump noise unless repeated.',
    });
  }

  const tickerLower = candidate.ticker.toLowerCase();
  const nameLower = candidate.tokenName.toLowerCase();
  const hasDuplicate = allCandidates.some(
    c =>
      c.id !== candidate.id &&
      (c.ticker.toLowerCase() === tickerLower || c.tokenName.toLowerCase() === nameLower),
  );
  if (hasDuplicate) {
    notes.push({
      type: 'DUPLICATE_TICKER',
      note: 'Duplicate ticker/name present in session; inspect duplicate-name clusters.',
    });
  }

  const sorted = [...candidateSnapshots].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const firstSnap = sorted[0];
  const hasLateArrivalLiquidity =
    firstSnap != null &&
    firstSnap.liquidityUsd == null &&
    sorted.some(s => s !== firstSnap && s.liquidityUsd != null);
  if (hasLateArrivalLiquidity) {
    notes.push({
      type: 'LIQUIDITY_ARRIVED_LATE',
      note: 'Liquidity may have arrived after detection; inspect whether liquidity growth should trigger a watch-only lane.',
    });
  }

  return notes;
}

function generateRecommendations(notes: BadRejectReviewNote[]): string[] {
  const recs: string[] = [];

  recs.push('DO_NOT_LOOSEN_YET: Single BAD_REJECT is not enough to change gates.');
  recs.push('NEEDS_MORE_SESSIONS: Gather more examples before scoring changes.');

  for (const note of notes) {
    switch (note.type) {
      case 'LIQUIDITY_VELOCITY':
        recs.push(
          'REVIEW_ONLY: Consider adding a watch-only liquidity velocity lane after repeated evidence.',
        );
        break;
      case 'EARLY_CADENCE':
        recs.push(
          'REVIEW_ONLY: Consider tighter snapshot scheduling (e.g. 15m cadence) for top candidates.',
        );
        break;
      case 'ZERO_SCORE_MAJOR_RUN':
        recs.push(
          'REVIEW_ONLY: A zero-score no-context pool later ran; inspect whether a watch-only unknown lane is warranted.',
        );
        break;
      case 'NO_SOCIAL_CONTEXT':
        recs.push(
          'REVIEW_ONLY: No-context pumps may be noise or stealth launches; do not add a buy gate without more evidence.',
        );
        break;
      case 'DUPLICATE_TICKER':
        recs.push(
          'REVIEW_ONLY: Duplicate ticker clusters may indicate coordinated launch activity; inspect for patterns.',
        );
        break;
      case 'LIQUIDITY_ARRIVED_LATE':
        recs.push(
          'REVIEW_ONLY: Late-arriving liquidity may be a signal; consider post-detection liquidity monitoring.',
        );
        break;
    }
  }

  return recs;
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Builds a BAD_REJECT review from autopsy results joined with session candidate data.
 * Pure function — no network calls, no DB writes, no scoring changes.
 */
export function buildBadRejectReview(
  candidates: TokenGrabAutopsyCandidate[],
  snapshots: TokenGrabAutopsySnapshot[],
  autopsyResults: TokenGrabAutopsyResult[],
): BadRejectReviewReport {
  const candidateMap = new Map(candidates.map(c => [c.id, c]));
  const badRejectResults = autopsyResults.filter(r => r.verdict === 'BAD_REJECT');

  const items: BadRejectReviewItem[] = badRejectResults.map(result => {
    const candidate = candidateMap.get(result.candidateId);
    if (!candidate) {
      throw new Error(
        `[buildBadRejectReview] No candidate found for BAD_REJECT candidateId: ${result.candidateId}`,
      );
    }

    const candidateSnapshots = snapshots
      .filter(s => s.candidateId === candidate.id)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

    const notes = inferMissedSignalNotes(candidate, result, candidateSnapshots, candidates);
    const recommendations = generateRecommendations(notes);

    return {
      candidateId: candidate.id,
      tokenName: candidate.tokenName,
      ticker: candidate.ticker,
      contractAddress: candidate.contractAddress,
      poolAddress: candidate.poolAddress,
      lane: candidate.lane,
      decision: candidate.decision,
      scoreAtDetection: candidate.scoreAtDetection,
      detectedAt: candidate.detectedAt,
      poolCreatedAt: candidate.poolCreatedAt,
      reasons: [...candidate.reasons],
      redFlags: [...candidate.redFlags],
      outcome: result.outcome,
      maxGainPct: result.maxGainPct,
      maxDrawdownPct: result.maxDrawdownPct,
      liquidityChangePct: result.liquidityChangePct,
      firstRunAtMinutes: result.firstRunAtMinutes,
      snapshotTimeline: candidateSnapshots.map(s => ({
        observedAt: s.observedAt,
        minutesAfterDetection: s.minutesAfterDetection,
        priceUsd: s.priceUsd,
        liquidityUsd: s.liquidityUsd,
        volumeUsd: s.volumeUsd,
      })),
      missedSignalNotes: notes,
      recommendations,
      noTradingExecuted: true,
    };
  });

  const gains = items.map(i => i.maxGainPct ?? 0).filter(n => n > 0);
  const largestMissedGainPct = gains.length > 0 ? Math.max(...gains) : undefined;

  const runs = items
    .map(i => i.firstRunAtMinutes)
    .filter((n): n is number => n != null);
  const earliestMissedRunMinutes = runs.length > 0 ? Math.min(...runs) : undefined;

  const allRedFlags = items.flatMap(i => i.redFlags);
  const flagCounts = new Map<string, number>();
  for (const f of allRedFlags) {
    flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  }
  const commonRejectionReasons =
    items.length > 1
      ? [...flagCounts.entries()].filter(([, n]) => n > 1).map(([f]) => f)
      : [...flagCounts.keys()];

  return {
    generatedAt: new Date().toISOString(),
    mode: 'session-file',
    tradingStatus: 'LOCKED / NO TRADING EXECUTED',
    badRejectCount: items.length,
    items,
    summary: {
      candidatesReviewed: autopsyResults.length,
      badRejectCount: items.length,
      largestMissedGainPct,
      earliestMissedRunMinutes,
      commonRejectionReasons,
      tradingExecuted: 0,
    },
  };
}

export function renderBadRejectReview(report: BadRejectReviewReport): string {
  const WIDE = '═'.repeat(62);
  const THIN = '─'.repeat(62);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  Token Grab BAD_REJECT Inspector');
  lines.push(`  Mode    : ${report.mode}`);
  lines.push(`  Trading : ${report.tradingStatus}`);
  lines.push(`  Time    : ${report.generatedAt}`);
  lines.push(WIDE);
  lines.push('');

  if (report.items.length === 0) {
    lines.push('  No BAD_REJECT candidates found in this session + snapshot set.');
    lines.push('  All rejects were confirmed correct or had insufficient data.');
    lines.push('');
    lines.push('  NO TRADING EXECUTED');
    lines.push('');
    lines.push(WIDE);
    lines.push('Summary');
    lines.push(WIDE);
    lines.push(`  Candidates reviewed : ${report.summary.candidatesReviewed}`);
    lines.push(`  Bad rejects         : 0`);
    lines.push(`  Trading executed    : 0`);
    lines.push('');
    lines.push('  NO TRADING EXECUTED. Report only. No positions opened.');
    lines.push(WIDE);
    return lines.join('\n');
  }

  for (const item of report.items) {
    lines.push(THIN);
    lines.push(`BAD_REJECT: ${item.ticker} (${item.candidateId})`);
    lines.push(THIN);

    lines.push(`Token name            : ${item.tokenName}`);
    lines.push(`Ticker                : ${item.ticker}`);
    lines.push(`Candidate ID          : ${item.candidateId}`);
    if (item.contractAddress) lines.push(`Contract address      : ${item.contractAddress}`);
    if (item.poolAddress) lines.push(`Pool address          : ${item.poolAddress}`);
    lines.push(`Lane at detection     : ${item.lane}`);
    lines.push(`Decision at detection : ${item.decision}`);
    lines.push(`Score at detection    : ${item.scoreAtDetection}`);
    lines.push(`Detected at           : ${item.detectedAt}`);
    if (item.poolCreatedAt) lines.push(`Pool created at       : ${item.poolCreatedAt}`);

    if (item.reasons.length > 0) {
      lines.push('Detection reasons:');
      for (const r of item.reasons) lines.push(`  • ${r}`);
    } else {
      lines.push('Detection reasons     : none');
    }

    if (item.redFlags.length > 0) {
      lines.push('Detection red flags:');
      for (const f of item.redFlags) lines.push(`  ! ${f}`);
    } else {
      lines.push('Detection red flags   : none');
    }

    lines.push('');
    lines.push(`Outcome               : ${item.outcome}`);
    if (item.maxGainPct != null) {
      lines.push(`Max gain              : +${item.maxGainPct.toFixed(0)}%`);
    }
    if (item.maxDrawdownPct != null) {
      lines.push(`Max drawdown          : ${item.maxDrawdownPct.toFixed(0)}%`);
    }
    if (item.liquidityChangePct != null) {
      const sign = item.liquidityChangePct > 0 ? '+' : '';
      lines.push(`Liquidity change      : ${sign}${item.liquidityChangePct.toFixed(0)}%`);
    }
    if (item.firstRunAtMinutes != null) {
      lines.push(`First run             : ${item.firstRunAtMinutes} minutes after detection`);
    }

    lines.push('');
    lines.push('Snapshot timeline:');
    if (item.snapshotTimeline.length === 0) {
      lines.push('  (no snapshots for this candidate)');
    } else {
      for (const s of item.snapshotTimeline) {
        const price = s.priceUsd != null ? `$${s.priceUsd.toPrecision(4)}` : 'n/a';
        const liq = s.liquidityUsd != null ? `$${s.liquidityUsd.toFixed(0)}` : 'n/a';
        const vol = s.volumeUsd != null ? `$${s.volumeUsd.toFixed(0)}` : 'n/a';
        lines.push(
          `  +${s.minutesAfterDetection}min | price=${price} | liq=${liq} | vol=${vol}`,
        );
      }
    }

    if (item.missedSignalNotes.length > 0) {
      lines.push('');
      lines.push('Missed-signal review notes:');
      for (const n of item.missedSignalNotes) lines.push(`  [${n.type}] ${n.note}`);
    }

    lines.push('');
    lines.push('Scoring review recommendations:');
    for (const r of item.recommendations) lines.push(`  → ${r}`);

    lines.push('');
    lines.push('  NO TRADING EXECUTED');
    lines.push('');
  }

  lines.push(WIDE);
  lines.push('Summary');
  lines.push(WIDE);
  lines.push(`  Candidates reviewed   : ${report.summary.candidatesReviewed}`);
  lines.push(`  Bad rejects           : ${report.summary.badRejectCount}`);
  if (report.summary.largestMissedGainPct != null) {
    lines.push(`  Largest missed gain   : +${report.summary.largestMissedGainPct.toFixed(0)}%`);
  }
  if (report.summary.earliestMissedRunMinutes != null) {
    lines.push(
      `  Earliest run          : ${report.summary.earliestMissedRunMinutes} min after detection`,
    );
  }
  if (report.summary.commonRejectionReasons.length > 0) {
    lines.push('  Common reject reasons :');
    for (const r of report.summary.commonRejectionReasons) lines.push(`    ! ${r}`);
  }
  lines.push(`  Trading executed      : 0`);
  lines.push('');
  lines.push('  NO TRADING EXECUTED. Report only. No positions opened.');
  lines.push(WIDE);

  return lines.join('\n');
}
