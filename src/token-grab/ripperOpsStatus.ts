import * as fs from 'fs';
import * as path from 'path';

import {
  runRipperAutopilotStatus,
  type AutopilotDecision,
} from './ripperAutopilotStatus';
import {
  runLiveShadowReport,
  type LiveShadowBankrollReport,
} from './liveShadowReport';
import {
  loadOrCreateLiveShadowState,
  DEFAULT_LIVE_SHADOW_STATE_PATH,
  type LiveShadowPosition,
  type BankrollTier,
} from './liveShadow';
import {
  runResearchShadowReport,
} from './researchShadowReport';
import {
  DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
  DEFAULT_RESEARCH_SHADOW_STATE_PATH,
} from './researchShadow';
import {
  loadBrainPolicyMemory,
  DEFAULT_BRAIN_POLICY_MEMORY_PATH,
  type BrainPolicyMemory,
} from './brainPolicy';

const DEFAULT_CYCLES_DIR = 'data/token-grab/ripper/cycles';
const DEFAULT_INTENTS_PATH = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_TIMING_REPORT = 'data/token-grab/ripper/approved-entry-timing-report.jsonl';
const DEFAULT_EXIT_POLICY_PATH = 'data/token-grab/ripper/paper-exit-policy-report.jsonl';
const DEFAULT_REAL_FAKE_PATH = 'data/token-grab/ripper/real-vs-fake-autopsy.jsonl';
const DEFAULT_RESEARCH_EVENTS_PATH = DEFAULT_RESEARCH_SHADOW_EVENTS_PATH;
const DEFAULT_RESEARCH_STATE_PATH = DEFAULT_RESEARCH_SHADOW_STATE_PATH;
const DEFAULT_LEARNING_LOCK_PATH = '/tmp/token-grab-learning-cron.lock';
const DEFAULT_LIVE_SHADOW_LOCK_PATH = 'data/token-grab/live-shadow/.live-shadow.lock';
const DEFAULT_FRESHNESS_MINUTES = 20;

export interface RunningSource {
  label: string;
  lockPath: string;
  active: boolean;
  pid: string | null;
}

export interface OpenPaperPositionView {
  bankroll: BankrollTier;
  contract: string;
  symbol: string | null;
  lane: string;
  openedAt: string;
  positionSizeUsd: number;
  entryValuation: number | null | undefined;
}

export interface BankrollOpsView {
  bankroll: BankrollTier;
  openPositions: number;
  closedPositions: number;
  todayReturnUsd: number;
  cumulativeRealizedPnlUsd: number;
  cumulativeRealizedBankrollUsd: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
}

export interface BrainDecisionSummary {
  autopilotDecision: AutopilotDecision;
  memoryGeneratedAt: string | null;
  promotedProfiles: number;
  demotedProfiles: number;
  killedProfiles: number;
  promotedGroups: number;
  demotedGroups: number;
  killedGroups: number;
  stickyKilledGroups: number;
  summary: string;
}

export interface LeadingStrategyView {
  lane: string | null;
  valuedClosed: number;
  cappedAveragePnlPct: number | null;
  medianPnlPct: number | null;
  buys: number;
  source: 'RESEARCH_SHADOW' | 'NONE';
}

export interface FeedFreshnessView {
  latestCycleTime: string | null;
  latestShadowCycleTime: string | null;
  cycleAgeMinutes: number | null;
  shadowAgeMinutes: number | null;
  cycleFeedStale: boolean;
  shadowFeedStale: boolean;
  stale: boolean;
  freshnessMinutes: number;
}

export interface SafetyStatusView {
  realTradingLocked: true;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  emergencyPaperKillActive: boolean;
  bankrollKillCount: number;
  stickyBrainKillCount: number;
  triggered: string[];
}

export interface RipperOpsStatusResult {
  generatedAt: string;
  runningNow: boolean;
  runningSources: RunningSource[];
  latestSuccessfulCycle: string | null;
  latestSuccessfulShadowCycle: string | null;
  tokensDiscoveredLatestCycle: number;
  approvedLatestCycle: number;
  rejectedLatestCycle: number;
  openPositions: OpenPaperPositionView[];
  bankrolls: BankrollOpsView[];
  todaySimulatedReturnUsd: number;
  cumulativeRealizedPnlUsd: number;
  brain: BrainDecisionSummary;
  leadingStrategy: LeadingStrategyView;
  feedFreshness: FeedFreshnessView;
  safety: SafetyStatusView;
  paperOnly: true;
  tradingExecuted: 0;
  realTradingLocked: true;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  reportOnly: true;
  readOnly: true;
}

export interface RipperOpsStatusOptions {
  cyclesDir?: string;
  intentsPath?: string;
  timingReportPath?: string;
  exitPolicyPath?: string;
  realVsFakePath?: string;
  liveShadowStatePath?: string;
  researchEventsPath?: string;
  researchStatePath?: string;
  brainMemoryPath?: string;
  learningLockPath?: string;
  liveShadowLockPath?: string;
  freshnessMinutes?: number;
  generatedAt?: string;
  nowMs?: number;
}

function readPid(lockPath: string): string | null {
  const pidPath = fs.existsSync(lockPath) && fs.statSync(lockPath).isDirectory()
    ? path.join(lockPath, 'pid')
    : path.join(lockPath, 'pid');
  if (!fs.existsSync(pidPath)) return null;
  try {
    const pid = fs.readFileSync(pidPath, 'utf-8').trim();
    return pid || null;
  } catch {
    return null;
  }
}

function activeLock(label: string, lockPath: string): RunningSource {
  const active = fs.existsSync(lockPath);
  return {
    label,
    lockPath,
    active,
    pid: active ? readPid(lockPath) : null,
  };
}

function minutesSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / 60_000);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function listOpenPositions(statePath: string, nowIso: string): OpenPaperPositionView[] {
  const state = loadOrCreateLiveShadowState(statePath, nowIso);
  const out: OpenPaperPositionView[] = [];
  for (const tier of Object.keys(state.bankrolls) as unknown as BankrollTier[]) {
    for (const p of state.bankrolls[tier].openPositions) {
      out.push({
        bankroll: tier,
        contract: p.contract,
        symbol: p.symbol ?? null,
        lane: p.lane,
        openedAt: p.openedAt,
        positionSizeUsd: p.positionSizeUsd,
        entryValuation: p.entryValuation,
      });
    }
  }
  out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  return out;
}

function todayReturnUsd(positions: LiveShadowPosition[], today: string): number {
  return round2(
    positions
      .filter(p => p.closedAt?.slice(0, 10) === today && p.pnlUsd != null)
      .reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0),
  );
}

function bankrollViews(report: LiveShadowBankrollReport[], statePath: string, nowIso: string): BankrollOpsView[] {
  const state = loadOrCreateLiveShadowState(statePath, nowIso);
  const today = nowIso.slice(0, 10);
  return report.map(b => {
    const closed = state.bankrolls[b.bankroll]?.closedPositions ?? [];
    const todayUsd = todayReturnUsd(closed, today);
    return {
      bankroll: b.bankroll,
      openPositions: b.openPositions,
      closedPositions: b.closedPositions,
      todayReturnUsd: todayUsd,
      cumulativeRealizedPnlUsd: round2(b.simulatedPnlUsd),
      cumulativeRealizedBankrollUsd: round2(b.bankroll + b.simulatedPnlUsd),
      killSwitchActive: b.killSwitchActive,
      killSwitchReason: b.killSwitchReason,
    };
  }).sort((a, b) => a.bankroll - b.bankroll);
}

function summarizeBrain(memory: BrainPolicyMemory | null, autopilotDecision: AutopilotDecision): BrainDecisionSummary {
  const profiles = Object.values(memory?.profiles ?? {});
  const groups = Object.values(memory?.globalGroups ?? {});
  const promotedProfiles = profiles.filter(p => p.policyStatus === 'PROMOTE').length;
  const demotedProfiles = profiles.filter(p => p.policyStatus === 'DEMOTE').length;
  const killedProfiles = profiles.filter(p => p.policyStatus === 'KILL').length;
  const promotedGroups = groups.filter(g => g.policyStatus === 'PROMOTE' || g.policyStatus === 'PROMOTE_LIGHT').length;
  const demotedGroups = groups.filter(g => g.policyStatus === 'DEMOTE').length;
  const killedGroups = groups.filter(g => g.policyStatus === 'KILL').length;
  const stickyKilledGroups = groups.filter(g => g.policyStatus === 'KILL' && g.killedAt != null).length;

  const parts = [autopilotDecision];
  if (stickyKilledGroups > 0) parts.push(`${stickyKilledGroups} sticky brain kill group(s)`);
  if (promotedGroups > 0 || promotedProfiles > 0) parts.push(`promote ${promotedGroups + promotedProfiles}`);
  if (demotedGroups > 0 || demotedProfiles > 0) parts.push(`demote ${demotedGroups + demotedProfiles}`);

  return {
    autopilotDecision,
    memoryGeneratedAt: memory?.generatedAt ?? null,
    promotedProfiles,
    demotedProfiles,
    killedProfiles,
    promotedGroups,
    demotedGroups,
    killedGroups,
    stickyKilledGroups,
    summary: parts.join(' | '),
  };
}

function leadingStrategy(eventsPath: string, statePath: string, generatedAt: string): LeadingStrategyView {
  const report = runResearchShadowReport({ eventsPath, statePath, generatedAt });
  const valued = report.laneStats.filter(l => l.valuedClosed > 0);
  if (valued.length === 0) {
    return {
      lane: null,
      valuedClosed: 0,
      cappedAveragePnlPct: null,
      medianPnlPct: null,
      buys: 0,
      source: 'NONE',
    };
  }
  const best = [...valued].sort((a, b) => {
    const aAvg = a.cappedAveragePnlPct ?? Number.NEGATIVE_INFINITY;
    const bAvg = b.cappedAveragePnlPct ?? Number.NEGATIVE_INFINITY;
    if (bAvg !== aAvg) return bAvg - aAvg;
    const aMed = a.medianPnlPct ?? Number.NEGATIVE_INFINITY;
    const bMed = b.medianPnlPct ?? Number.NEGATIVE_INFINITY;
    if (bMed !== aMed) return bMed - aMed;
    if (b.valuedClosed !== a.valuedClosed) return b.valuedClosed - a.valuedClosed;
    return b.buys - a.buys;
  })[0];
  return {
    lane: best.lane,
    valuedClosed: best.valuedClosed,
    cappedAveragePnlPct: best.cappedAveragePnlPct,
    medianPnlPct: best.medianPnlPct,
    buys: best.buys,
    source: 'RESEARCH_SHADOW',
  };
}

export function runRipperOpsStatus(
  options: RipperOpsStatusOptions = {},
): RipperOpsStatusResult {
  const nowMs = options.nowMs ?? Date.now();
  const generatedAt = options.generatedAt ?? new Date(nowMs).toISOString();
  const cyclesDir = options.cyclesDir ?? DEFAULT_CYCLES_DIR;
  const intentsPath = options.intentsPath ?? DEFAULT_INTENTS_PATH;
  const timingReportPath = options.timingReportPath ?? DEFAULT_TIMING_REPORT;
  const exitPolicyPath = options.exitPolicyPath ?? DEFAULT_EXIT_POLICY_PATH;
  const realVsFakePath = options.realVsFakePath ?? DEFAULT_REAL_FAKE_PATH;
  const liveShadowStatePath = options.liveShadowStatePath ?? DEFAULT_LIVE_SHADOW_STATE_PATH;
  const researchEventsPath = options.researchEventsPath ?? DEFAULT_RESEARCH_EVENTS_PATH;
  const researchStatePath = options.researchStatePath ?? DEFAULT_RESEARCH_STATE_PATH;
  const brainMemoryPath = options.brainMemoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH;
  const learningLockPath = options.learningLockPath ?? DEFAULT_LEARNING_LOCK_PATH;
  const liveShadowLockPath = options.liveShadowLockPath ?? DEFAULT_LIVE_SHADOW_LOCK_PATH;
  const freshnessMinutes = options.freshnessMinutes ?? DEFAULT_FRESHNESS_MINUTES;

  const autopilot = runRipperAutopilotStatus({
    cyclesDir,
    intentsPath,
    timingReportPath,
    exitPolicyPath,
    realVsFakePath,
    nowMs,
  });
  const liveShadow = runLiveShadowReport({ statePath: liveShadowStatePath, generatedAt, nowMs });
  const liveShadowState = loadOrCreateLiveShadowState(liveShadowStatePath, generatedAt);
  const brainMemory = loadBrainPolicyMemory(brainMemoryPath);

  const runningSources = [
    activeLock('learning-cron', learningLockPath),
    activeLock('live-shadow', liveShadowLockPath),
  ];
  const runningNow = runningSources.some(s => s.active);

  const bankrolls = bankrollViews(liveShadow.bankrolls, liveShadowStatePath, generatedAt);
  const openPositions = listOpenPositions(liveShadowStatePath, generatedAt);
  const todaySimulatedReturnUsd = round2(bankrolls.reduce((sum, b) => sum + b.todayReturnUsd, 0));
  const cumulativeRealizedPnlUsd = round2(bankrolls.reduce((sum, b) => sum + b.cumulativeRealizedPnlUsd, 0));

  const brain = summarizeBrain(brainMemory, autopilot.decision);
  const leader = leadingStrategy(researchEventsPath, researchStatePath, generatedAt);

  const cycleAgeMinutes = minutesSince(autopilot.latestCycleTime, nowMs);
  const shadowAgeMinutes = minutesSince(liveShadowState.lastCycleAt, nowMs);
  const cycleFeedStale = cycleAgeMinutes != null ? cycleAgeMinutes >= freshnessMinutes : true;
  const shadowFeedStale = shadowAgeMinutes != null ? shadowAgeMinutes >= freshnessMinutes : true;

  const bankrollKillCount = bankrolls.filter(b => b.killSwitchActive).length;
  const stickyBrainKillCount = brain.stickyKilledGroups;
  const triggered: string[] = [];
  if (cycleFeedStale) triggered.push('STALE_RIPPER_CYCLE_FEED');
  if (shadowFeedStale) triggered.push('STALE_LIVE_SHADOW_FEED');
  if (bankrollKillCount > 0) triggered.push(`PAPER_KILL_SWITCH_ACTIVE:${bankrollKillCount}`);
  if (stickyBrainKillCount > 0) triggered.push(`BRAIN_STICKY_KILL_GROUPS:${stickyBrainKillCount}`);

  return {
    generatedAt,
    runningNow,
    runningSources,
    latestSuccessfulCycle: autopilot.latestCycleTime,
    latestSuccessfulShadowCycle: liveShadowState.lastCycleAt,
    tokensDiscoveredLatestCycle: autopilot.approvedCount + autopilot.rejectedCount,
    approvedLatestCycle: autopilot.approvedCount,
    rejectedLatestCycle: autopilot.rejectedCount,
    openPositions,
    bankrolls,
    todaySimulatedReturnUsd,
    cumulativeRealizedPnlUsd,
    brain,
    leadingStrategy: leader,
    feedFreshness: {
      latestCycleTime: autopilot.latestCycleTime,
      latestShadowCycleTime: liveShadowState.lastCycleAt,
      cycleAgeMinutes,
      shadowAgeMinutes,
      cycleFeedStale,
      shadowFeedStale,
      stale: cycleFeedStale || shadowFeedStale,
      freshnessMinutes,
    },
    safety: {
      realTradingLocked: true,
      noWallet: true,
      noSwap: true,
      noSigning: true,
      emergencyPaperKillActive: bankrollKillCount > 0,
      bankrollKillCount,
      stickyBrainKillCount,
      triggered,
    },
    paperOnly: true,
    tradingExecuted: 0,
    realTradingLocked: true,
    noWallet: true,
    noSwap: true,
    noSigning: true,
    reportOnly: true,
    readOnly: true,
  };
}

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  return v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtMinutes(v: number | null): string {
  return v == null ? 'n/a' : `${v.toFixed(1)}m`;
}

export function renderRipperOpsStatus(result: RipperOpsStatusResult): string {
  const SEP = '━'.repeat(64);
  const SEP2 = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(SEP);
  lines.push('  TOKEN GRAB — OPERATIONS STATUS');
  lines.push('  [PAPER ONLY — READ ONLY — NO WALLET — NO REAL TRADING]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Running now             : ${result.runningNow ? 'YES' : 'no'}`);
  lines.push(`  Generated at            : ${result.generatedAt}`);
  lines.push(`  Latest successful cycle : ${result.latestSuccessfulCycle ?? 'none'}`);
  lines.push(`  Latest shadow cycle     : ${result.latestSuccessfulShadowCycle ?? 'none'}`);
  lines.push('');

  lines.push(SEP2);
  lines.push('  CURRENT MARKET PIPELINE');
  lines.push(SEP2);
  lines.push(`  Tokens discovered       : ${result.tokensDiscoveredLatestCycle}`);
  lines.push(`  Approved / Rejected     : ${result.approvedLatestCycle} / ${result.rejectedLatestCycle}`);
  lines.push(`  Feed stale              : ${result.feedFreshness.stale ? 'YES' : 'no'}` +
    `  (cycle age ${fmtMinutes(result.feedFreshness.cycleAgeMinutes)}, shadow age ${fmtMinutes(result.feedFreshness.shadowAgeMinutes)}, threshold ${result.feedFreshness.freshnessMinutes}m)`);
  lines.push('');

  lines.push(SEP2);
  lines.push('  OPEN SIMULATED POSITIONS');
  lines.push(SEP2);
  if (result.openPositions.length === 0) {
    lines.push('  none');
  } else {
    for (const p of result.openPositions) {
      lines.push(`  $${p.bankroll}  ${(p.symbol ?? '-').padEnd(10)} ${p.contract}  lane=${p.lane}  opened=${p.openedAt}  size=$${p.positionSizeUsd.toFixed(2)}`);
    }
  }
  lines.push('');

  lines.push(SEP2);
  lines.push('  BANKROLLS');
  lines.push(SEP2);
  for (const b of result.bankrolls) {
    lines.push(`  $${b.bankroll} bankroll  open=${b.openPositions}  closed=${b.closedPositions}  today=${fmtUsd(b.todayReturnUsd)}  realizedPnL=${fmtUsd(b.cumulativeRealizedPnlUsd)}  bankrollNow=${fmtUsd(b.cumulativeRealizedBankrollUsd)}${b.killSwitchActive ? `  KILL=${b.killSwitchReason ?? 'ACTIVE'}` : ''}`);
  }
  lines.push(`  Today simulated return  : ${fmtUsd(result.todaySimulatedReturnUsd)}`);
  lines.push(`  Cumulative realized P/L : ${fmtUsd(result.cumulativeRealizedPnlUsd)}`);
  lines.push('');

  lines.push(SEP2);
  lines.push('  BRAIN / STRATEGY');
  lines.push(SEP2);
  lines.push(`  Brain decided           : ${result.brain.summary}`);
  lines.push(`  Brain memory updated    : ${result.brain.memoryGeneratedAt ?? 'none'}`);
  lines.push(`  Leading strategy        : ${result.leadingStrategy.lane ?? 'none'}  ` +
    `[source=${result.leadingStrategy.source}  valued=${result.leadingStrategy.valuedClosed}  avg=${fmtPct(result.leadingStrategy.cappedAveragePnlPct)}  median=${fmtPct(result.leadingStrategy.medianPnlPct)}  buys=${result.leadingStrategy.buys}]`);
  lines.push('');

  lines.push(SEP2);
  lines.push('  PROCESS / SAFETY');
  lines.push(SEP2);
  for (const s of result.runningSources) {
    lines.push(`  ${s.label.padEnd(22)} : ${s.active ? 'ACTIVE' : 'idle'}${s.pid ? `  pid=${s.pid}` : ''}  lock=${s.lockPath}`);
  }
  lines.push(`  Safety triggers         : ${result.safety.triggered.length ? result.safety.triggered.join(', ') : 'none'}`);
  lines.push('');

  lines.push('  REAL_TRADING=false  READY_FOR_REAL_TRADING=false');
  lines.push('  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  lines.push('  UNKNOWN remains UNKNOWN  tradingExecuted=0');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
