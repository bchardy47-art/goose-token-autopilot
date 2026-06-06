export type XEarsDecision =
  | 'IGNORE'
  | 'WATCH_SOCIAL'
  | 'WAIT_FOR_POOL'
  | 'POOL_LIVE_VALIDATE_NOW'
  | 'RADAR_HIT_START_CAPTURE'
  | 'IGNORE_UNSAFE_OR_BOTLIKE';

export type XEarsSourceMode = 'fixture' | 'api_unavailable' | 'api';

export interface SocialPost {
  id?: string;
  author?: string;
  authorAgeDays?: number;
  text: string;
  createdAt?: string;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  url?: string;
}

export interface XEarsCluster {
  key: string;
  keyType: 'contract' | 'ticker' | 'narrative';
  postCount: number;
  independentAuthorCount: number;
  launchIntentScore: number;
  botNoiseRisk: number;
  hasContract: boolean;
  hasTicker: boolean;
  repeatedTextRisk: number;
  staleRisk: number;
  decision: XEarsDecision;
  oneLineReason: string;
  topPosts: Array<{
    author?: string;
    text: string;
    createdAt?: string;
    replyCount?: number;
    repostCount?: number;
    likeCount?: number;
    url?: string;
  }>;
}

export interface XEarsReport {
  timestamp: string;
  sourceMode: XEarsSourceMode;
  totalPostsInspected: number;
  windowMinutes: number;
  clusters: XEarsCluster[];
}

// Launch-intent phrase list (lowercase for matching)
const LAUNCH_INTENT_PHRASES: readonly string[] = [
  'launching today', 'launch soon', 'fair launch', 'stealth launch',
  'ca soon', 'contract soon', 'ca:', 'contract:', 'raydium live',
  'lp burned', 'liquidity added', 'pumpfun', 'graduated', 'migration',
  'ticker is', 'presale filled', 'community takeover', 'cto',
];

// $TICKER: 2-10 uppercase letters after $
const TICKER_PATTERN = '\\$([A-Z]{2,10})\\b';
// Solana base58 address: 32-44 chars, no 0/O/I/l
const SOLANA_ADDR_PATTERN = '\\b([1-9A-HJ-NP-Za-km-z]{32,44})\\b';

function extractTickers(text: string): string[] {
  const re = new RegExp(TICKER_PATTERN, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

function extractContracts(text: string): string[] {
  const re = new RegExp(SOLANA_ADDR_PATTERN, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[1].length >= 32) out.push(m[1]);
  }
  return [...new Set(out)];
}

function countLaunchPhrases(text: string): number {
  const lower = text.toLowerCase();
  return LAUNCH_INTENT_PHRASES.filter(p => lower.includes(p)).length;
}

function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function calcLaunchIntentScore(posts: SocialPost[]): number {
  if (posts.length === 0) return 0;
  const totalPhrases = posts.reduce((s, p) => s + countLaunchPhrases(p.text), 0);
  const hasContract = posts.some(p => extractContracts(p.text).length > 0);
  const hasTicker = posts.some(p => extractTickers(p.text).length > 0);
  let score = Math.min(40, totalPhrases * 8);
  if (hasTicker) score += 20;
  if (hasContract) score += 40;
  return Math.min(100, score);
}

function calcBotNoiseRisk(posts: SocialPost[]): number {
  if (posts.length === 0) return 0;
  const texts = posts.map(p => normText(p.text));
  const dupRatio = posts.length > 1 ? 1 - new Set(texts).size / texts.length : 0;
  const youngRatio = posts.filter(p => p.authorAgeDays != null && p.authorAgeDays < 30).length / posts.length;
  const zeroEngRatio = posts.filter(
    p => (p.replyCount ?? 0) === 0 && (p.repostCount ?? 0) === 0 && (p.likeCount ?? 0) === 0
  ).length / posts.length;
  return Math.round(Math.min(100, dupRatio * 50 + youngRatio * 30 + zeroEngRatio * 20));
}

function calcRepeatedTextRisk(posts: SocialPost[]): number {
  if (posts.length <= 1) return 0;
  const texts = posts.map(p => normText(p.text));
  return Math.round((1 - new Set(texts).size / texts.length) * 100);
}

function calcStaleRisk(posts: SocialPost[], windowMinutes: number): number {
  if (posts.length === 0) return 100;
  const cutoff = Date.now() - windowMinutes * 60_000;
  const fresh = posts.filter(p => {
    if (!p.createdAt) return true;
    return new Date(p.createdAt).getTime() >= cutoff;
  });
  return Math.round((1 - fresh.length / posts.length) * 100);
}

function calcIndependentAuthorCount(posts: SocialPost[]): number {
  const known = new Set(posts.map(p => p.author).filter((a): a is string => !!a));
  const hasUnknown = posts.some(p => !p.author);
  return known.size + (hasUnknown ? 1 : 0);
}

type ClusterBase = Omit<XEarsCluster, 'decision' | 'oneLineReason' | 'topPosts'>;

function decide(c: ClusterBase): Pick<XEarsCluster, 'decision' | 'oneLineReason'> {
  if (c.botNoiseRisk >= 70 || c.repeatedTextRisk >= 80) {
    return { decision: 'IGNORE_UNSAFE_OR_BOTLIKE', oneLineReason: 'High bot/spam indicators, likely coordinated noise' };
  }
  if (c.staleRisk >= 80) {
    return { decision: 'IGNORE', oneLineReason: 'Posts mostly outside time window, signal likely stale' };
  }
  if (c.launchIntentScore === 0 && !c.hasContract && !c.hasTicker) {
    return { decision: 'IGNORE', oneLineReason: 'No launch-intent phrases or identifiers found' };
  }
  if (c.hasContract && c.independentAuthorCount >= 2 && c.launchIntentScore >= 50) {
    return { decision: 'WAIT_FOR_POOL', oneLineReason: 'Contract address + launch-intent across multiple authors — await pool' };
  }
  if (c.hasContract && c.launchIntentScore >= 20) {
    return { decision: 'WAIT_FOR_POOL', oneLineReason: 'Contract found with launch-intent signal' };
  }
  if (c.hasTicker && c.independentAuthorCount >= 3 && c.launchIntentScore >= 50) {
    return { decision: 'WAIT_FOR_POOL', oneLineReason: 'Ticker with strong multi-author launch intent' };
  }
  if (c.launchIntentScore >= 30 && c.independentAuthorCount >= 2) {
    return { decision: 'WATCH_SOCIAL', oneLineReason: 'Moderate launch-intent from multiple authors, no contract yet' };
  }
  if (c.launchIntentScore >= 10 || c.hasTicker) {
    return { decision: 'WATCH_SOCIAL', oneLineReason: 'Weak signal, monitor for contract or broader adoption' };
  }
  return { decision: 'IGNORE', oneLineReason: 'Insufficient signal to act on' };
}

function makeCluster(
  key: string,
  keyType: XEarsCluster['keyType'],
  posts: SocialPost[],
  windowMinutes: number,
): XEarsCluster {
  const allContracts = new Set(posts.flatMap(p => extractContracts(p.text)));
  const allTickers = new Set(posts.flatMap(p => extractTickers(p.text)));
  const base: ClusterBase = {
    key,
    keyType,
    postCount: posts.length,
    independentAuthorCount: calcIndependentAuthorCount(posts),
    launchIntentScore: calcLaunchIntentScore(posts),
    botNoiseRisk: calcBotNoiseRisk(posts),
    hasContract: allContracts.size > 0,
    hasTicker: allTickers.size > 0,
    repeatedTextRisk: calcRepeatedTextRisk(posts),
    staleRisk: calcStaleRisk(posts, windowMinutes),
  };
  const topPosts = posts.slice(0, 3).map(({ author, text, createdAt, replyCount, repostCount, likeCount, url }) => ({
    author, text, createdAt, replyCount, repostCount, likeCount, url,
  }));
  return { ...base, ...decide(base), topPosts };
}

export function buildXEarsReport(
  posts: SocialPost[],
  options: { windowMinutes: number; sourceMode: XEarsSourceMode },
): XEarsReport {
  const { windowMinutes, sourceMode } = options;
  const timestamp = new Date().toISOString();

  // Pass 1: cluster by contract address (highest priority)
  const contractMap = new Map<string, SocialPost[]>();
  const inContract = new Set<number>();
  posts.forEach((post, idx) => {
    for (const ca of extractContracts(post.text)) {
      if (!contractMap.has(ca)) contractMap.set(ca, []);
      contractMap.get(ca)!.push(post);
      inContract.add(idx);
    }
  });

  // Pass 2: cluster remaining posts by ticker
  const tickerMap = new Map<string, SocialPost[]>();
  const inTicker = new Set<number>();
  posts.forEach((post, idx) => {
    if (inContract.has(idx)) return;
    for (const ticker of extractTickers(post.text)) {
      if (!tickerMap.has(ticker)) tickerMap.set(ticker, []);
      tickerMap.get(ticker)!.push(post);
      inTicker.add(idx);
    }
  });

  // Pass 3: cluster remaining posts by first matching launch-intent phrase
  const narrativeMap = new Map<string, SocialPost[]>();
  posts.forEach((post, idx) => {
    if (inContract.has(idx) || inTicker.has(idx)) return;
    const lower = post.text.toLowerCase();
    for (const phrase of LAUNCH_INTENT_PHRASES) {
      if (lower.includes(phrase)) {
        if (!narrativeMap.has(phrase)) narrativeMap.set(phrase, []);
        narrativeMap.get(phrase)!.push(post);
        break;
      }
    }
  });

  const clusters: XEarsCluster[] = [
    ...[...contractMap.entries()].map(([ca, p]) => makeCluster(ca, 'contract', p, windowMinutes)),
    ...[...tickerMap.entries()].map(([t, p]) => makeCluster(t, 'ticker', p, windowMinutes)),
    ...[...narrativeMap.entries()].map(([phrase, p]) => makeCluster(phrase, 'narrative', p, windowMinutes)),
  ];

  clusters.sort((a, b) => b.launchIntentScore - a.launchIntentScore || b.postCount - a.postCount);

  return { timestamp, sourceMode, totalPostsInspected: posts.length, windowMinutes, clusters };
}

function col(s: string, w: number): string {
  return s.slice(0, w).padEnd(w);
}

export function renderXEarsReport(report: XEarsReport): string {
  const SEP = '─'.repeat(82);
  const lines: string[] = [];

  lines.push(SEP);
  lines.push('X / Social Early-Warning Radar  ─  X-Ears Report');
  lines.push(SEP);
  lines.push(`  Timestamp      : ${report.timestamp}`);
  lines.push(`  Source mode    : ${report.sourceMode}`);
  lines.push(`  Posts inspected: ${report.totalPostsInspected}`);
  lines.push(`  Window         : ${report.windowMinutes} min`);
  lines.push(`  Clusters found : ${report.clusters.length}`);
  lines.push('');

  if (report.sourceMode === 'api_unavailable') {
    lines.push('  [!] X API not configured.');
    lines.push('      Set X_BEARER_TOKEN in .env to enable live social data.');
    lines.push('      Run with --fixture=<path> to test with local sample posts.');
    lines.push('');
  }

  if (report.clusters.length === 0) {
    lines.push('  No clusters detected in this window.');
    lines.push('');
  } else {
    lines.push(SEP);
    lines.push('Clusters');
    lines.push(SEP);

    const W = { key: 18, type: 9, posts: 6, authors: 8, intent: 7, bot: 8, pool: 13, dec: 28 };
    const hdr = [
      col('Key', W.key),
      col('Type', W.type),
      col('#Posts', W.posts),
      col('#Auth', W.authors),
      col('Intent', W.intent),
      col('BotRisk', W.bot),
      col('Pool', W.pool),
      col('Decision', W.dec),
      'Reason',
    ].join(' ');
    lines.push('  ' + hdr);
    lines.push('  ' + '─'.repeat(hdr.length));

    for (const c of report.clusters) {
      const displayKey = c.keyType === 'contract'
        ? `${c.key.slice(0, 8)}…${c.key.slice(-4)}`
        : c.key;
      const row = [
        col(displayKey, W.key),
        col(c.keyType, W.type),
        col(String(c.postCount), W.posts),
        col(String(c.independentAuthorCount), W.authors),
        col(String(c.launchIntentScore), W.intent),
        col(String(c.botNoiseRisk), W.bot),
        col('not checked', W.pool),
        col(c.decision, W.dec),
        c.oneLineReason,
      ].join(' ');
      lines.push('  ' + row);
    }
    lines.push('');
  }

  lines.push(SEP);
  lines.push('Safety');
  lines.push(SEP);
  lines.push('  Report only. No DB writes. No network calls. No positions opened.');
  lines.push('  Real trading locked. Paper execution not touched.');
  lines.push('  Social signal is NOT a buy signal. This command does not start capture.');

  return lines.join('\n');
}
