import type { SocialPost, XEarsReport } from '../social/xEarsAnalyzer';
import type { SocialSignal, SocialSignalExtracted } from './types';

const TICKER_RE_SRC = '\\$([A-Z]{2,10})\\b';
const SOLANA_ADDR_RE_SRC = '\\b([1-9A-HJ-NP-Za-km-z]{32,44})\\b';

const LAUNCH_INTENT_PHRASES: readonly string[] = [
  'launching today', 'launch soon', 'fair launch', 'stealth launch',
  'ca soon', 'contract soon', 'ca:', 'contract:', 'raydium live',
  'lp burned', 'liquidity added', 'pumpfun', 'graduated', 'migration',
  'ticker is', 'presale filled', 'community takeover', 'cto',
];

function extractTickers(text: string): string[] {
  const re = new RegExp(TICKER_RE_SRC, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[1]) out.push(m[1]);
  return [...new Set(out)];
}

function extractContracts(text: string): string[] {
  const re = new RegExp(SOLANA_ADDR_RE_SRC, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[1] && m[1].length >= 32) out.push(m[1]);
  return [...new Set(out)];
}

function extractPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return LAUNCH_INTENT_PHRASES.filter(p => lower.includes(p));
}

function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// FNV-1a 32-bit hash for deterministic ID generation when post.id is absent.
function fnv32a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function stablePostId(post: SocialPost, idx: number): string {
  if (post.id) return `x-${post.id}`;
  return `x-${fnv32a(`${post.author ?? 'anon'}-${post.text.slice(0, 40)}-${idx}`)}`;
}

function buildExtracted(text: string): SocialSignalExtracted {
  return {
    tickers: extractTickers(text),
    tokenNames: [],
    contractAddresses: extractContracts(text),
    urls: [],
    phrases: extractPhrases(text),
  };
}

/**
 * Maps raw SocialPost[] (x-ears input format) to SocialSignal[] for Token Grab Ears.
 *
 * Bot/spam detection:
 * - suspectedBot: young account (authorAgeDays < 30) AND zero engagement
 * - identicalSpamCluster: normalized text appears more than once in the batch
 *
 * Does not set knownCaller or officialProjectAccount — x-ears has no concept of these.
 */
export function mapXEarsPostsToSocialSignals(
  posts: SocialPost[],
  nowIso?: string,
): SocialSignal[] {
  const now = nowIso ?? new Date().toISOString();

  // Count occurrences of each normalized text to detect spam clusters.
  const normCounts = new Map<string, number>();
  for (const p of posts) {
    const n = normText(p.text);
    normCounts.set(n, (normCounts.get(n) ?? 0) + 1);
  }

  return posts.map((post, idx): SocialSignal => {
    const norm = normText(post.text);
    const isSpamCluster = (normCounts.get(norm) ?? 1) > 1;
    const isYoungAccount = post.authorAgeDays != null && post.authorAgeDays < 30;
    const hasZeroEngagement =
      (post.replyCount ?? 0) === 0 &&
      (post.repostCount ?? 0) === 0 &&
      (post.likeCount ?? 0) === 0;
    const isSuspectedBot = isYoungAccount && hasZeroEngagement;

    const flags: SocialSignal['flags'] = {};
    if (isSuspectedBot) flags.suspectedBot = true;
    if (isSpamCluster) flags.identicalSpamCluster = true;

    return {
      id: stablePostId(post, idx),
      source: 'x',
      authorHandle: post.author ?? 'unknown',
      text: post.text,
      url: post.url,
      firstSeenAt: post.createdAt ?? now,
      createdAt: post.createdAt,
      engagement: {
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount,
      },
      extracted: buildExtracted(post.text),
      flags,
    };
  });
}

/**
 * Maps an XEarsReport (post-clustering output) to SocialSignal[] for Token Grab Ears.
 *
 * Uses cluster-level bot/spam metrics to set flags:
 * - suspectedBot: cluster botNoiseRisk >= 70 or repeatedTextRisk >= 80
 * - identicalSpamCluster: cluster repeatedTextRisk >= 80
 *
 * Useful when raw posts are not available but a pre-built report is.
 * Note: only topPosts (up to 3 per cluster) are included.
 */
export function mapXEarsReportToSocialSignals(
  report: XEarsReport,
  nowIso?: string,
): SocialSignal[] {
  const now = nowIso ?? report.timestamp;
  const signals: SocialSignal[] = [];
  let seq = 0;

  for (const cluster of report.clusters) {
    const isBotlike = cluster.botNoiseRisk >= 70 || cluster.repeatedTextRisk >= 80;
    const isSpam = cluster.repeatedTextRisk >= 80;

    for (const post of cluster.topPosts) {
      const extracted: SocialSignalExtracted = {
        tickers:
          cluster.keyType === 'ticker'
            ? [cluster.key]
            : extractTickers(post.text),
        tokenNames: [],
        contractAddresses:
          cluster.keyType === 'contract'
            ? [cluster.key]
            : extractContracts(post.text),
        urls: post.url ? [post.url] : [],
        phrases:
          cluster.keyType === 'narrative'
            ? [cluster.key]
            : extractPhrases(post.text),
      };

      const flags: SocialSignal['flags'] = {};
      if (isBotlike) flags.suspectedBot = true;
      if (isSpam) flags.identicalSpamCluster = true;

      signals.push({
        id: `x-cl-${seq++}`,
        source: 'x',
        authorHandle: post.author ?? 'unknown',
        text: post.text,
        url: post.url,
        firstSeenAt: post.createdAt ?? now,
        createdAt: post.createdAt,
        engagement: {
          likes: post.likeCount,
          reposts: post.repostCount,
          replies: post.replyCount,
        },
        extracted,
        flags,
      });
    }
  }

  return signals;
}
