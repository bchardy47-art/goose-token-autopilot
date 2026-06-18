// ── Constants ──────────────────────────────────────────────────────────────────

export const DOCTRINE_VERSION = 'v1';
export const DOCTRINE_DATE    = '2026-06-18';

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface M5Band {
  label:       string;
  description: string;
}

export interface SignalInteraction {
  field:  string;
  status: 'TRUSTED_CAPTURE_TIME' | 'CONTAMINATED_OUTCOME' | 'RISK_FILTER' | 'CONTEXT_SIGNAL' | 'TIMING_SIGNAL';
  notes:  string[];
}

export interface EvidenceThreshold {
  n:       number;
  label:   string;
  meaning: string;
}

export interface ResearchQuestion {
  id:       number;
  question: string;
  requires: string;
}

export interface BrainDoctrineResult {
  version:                 string;
  doctrineDate:            string;
  generatedAt:             string;

  // §1 — active research priorities
  activeResearchPriorities: string[];

  // §2 — contamination
  contaminatedFields:  string[];
  contaminationReason: string;

  // §3 — trusted entry-time fields
  trustedEntryTimeFields:   string[];
  preferredMomentumSource:  string;
  preferredMomentumWindow:  string;

  // §4 — M5 bands
  m5Bands:    M5Band[];
  m5BandNote: string;

  // §5 — signal interaction map
  signalInteractionMap: SignalInteraction[];

  // §6 — reject-first principles
  rejectFirstPrinciples: string[];

  // §7 — evidence thresholds
  evidenceThresholds: EvidenceThreshold[];

  // §8 — next questions
  nextQuestions: ResearchQuestion[];

  // safety lock
  reportOnly:           true;
  readOnly:             true;
  paperOnly:            true;
  realTradingLocked:    true;
  tradingExecuted:      0;
  noGateChanges:        true;
  noScoringChanges:     true;
  noBuyApprovalChanges: true;
}

export interface BrainDoctrineOptions {
  nowMs?: number;
}

// ── Builder ────────────────────────────────────────────────────────────────────

export function runBrainDoctrineReport(opts: BrainDoctrineOptions = {}): BrainDoctrineResult {
  const generatedAt = new Date(opts.nowMs ?? Date.now()).toISOString();

  return {
    version:     DOCTRINE_VERSION,
    doctrineDate: DOCTRINE_DATE,
    generatedAt,

    activeResearchPriorities: [
      'Prove DEX_SCREENER_M5 separates winners from junk before using in any signal',
      'Identify which M5 band produces best forward paper outcomes',
      'Determine whether high M5 fails reliably with thin liquidity',
      'Determine whether high M5 fails reliably with bad holder concentration',
      'Study VLR_GTE_2 behavior split by M5 band, liquidity, and cluster risk',
      'Characterize false-approved junk tokens (common entry-time features)',
      'Characterize rejected winners that were catchable at entry time',
    ],

    contaminatedFields: [
      'priceChangePct (outcome field — computed from entry.priceUsd → final.priceUsd observation window)',
      'priceBucket=PRICE_PUMP (derived from priceChangePct > 20 — 100% win rate is circular)',
    ],
    contaminationReason:
      'priceChangePct and PRICE_PUMP are measured over the same 1-minute observation window that ' +
      'determines the outcomeLabel. A token scoring PRICE_PUMP is BIG_WINNER by definition. ' +
      'The 100% win rate is a mathematical artifact, not a predictive signal.',

    trustedEntryTimeFields: [
      'entryMomentumPct (source=DEX_SCREENER_M5, window=M5) — capture-time, independent of observation window',
      'liquidityUsd / liquidityBucket — capture-time liquidity amount',
      'vlrBucket — volume-to-liquidity ratio at capture time',
      'ageMinutes — pool age at capture time',
      'clusterRisk — DEX/BubbleMaps cluster risk at capture time',
      'ripperScore — composite gate score at capture time',
      'bubbleMapsScore — holder concentration score at capture time',
    ],
    preferredMomentumSource: 'DEX_SCREENER_M5',
    preferredMomentumWindow: 'M5',

    m5Bands: [
      { label: 'M5 <= -20',     description: 'Strong downward momentum — likely panic or rug in progress' },
      { label: '-20 to -5',     description: 'Mild decline — cooling off or sell pressure' },
      { label: '-5 to +5',      description: 'Flat/neutral — no clear momentum signal' },
      { label: '+5 to +20',     description: 'Moderate positive — possible early runner, study carefully' },
      { label: '+20 to +50',    description: 'Strong positive — real attention or fake spike, needs qualification' },
      { label: '> +50',         description: 'Extreme spike — high exhaustion risk, likely already moved' },
    ],
    m5BandNote:
      'Moderate positive M5 (+5 to +20) may outperform extreme positive M5 (> +50) because ' +
      'extreme spikes often represent exhaustion rather than early entry opportunity. ' +
      'This must be proven by forward paper data before any gate change.',

    signalInteractionMap: [
      {
        field:  'entryMomentumPct (M5)',
        status: 'TRUSTED_CAPTURE_TIME',
        notes: [
          'Source: DEX_SCREENER_M5 (priceChange.m5 from DexScreener API at capture time)',
          'Independent of the 1-minute observation window — not contaminated',
          'Research-only: MUST NOT affect buy approval until forward paper evidence confirms',
          'Study in bands: <= -20 / -20 to -5 / -5 to +5 / +5 to +20 / +20 to +50 / > +50',
        ],
      },
      {
        field:  'priceChangePct / PRICE_PUMP',
        status: 'CONTAMINATED_OUTCOME',
        notes: [
          'CONTAMINATED — priceChangePct is the observation OUTCOME, not a capture-time predictor',
          'PRICE_PUMP (pcp > 20) has 100% historical win rate because it IS BIG_WINNER by definition',
          'Do not treat PRICE_PUMP win rate as predictive — it is circular by construction',
          'Cannot be used as entry signal without a true capture-time substitute (entryMomentumPct)',
        ],
      },
      {
        field:  'liquidityUsd / liquidityBucket',
        status: 'TRUSTED_CAPTURE_TIME',
        notes: [
          'Liquidity amount alone is insufficient — pair with liquidity trend/quality',
          'Low liquidity + high M5 = possible exhaustion trap',
          'Medium liquidity + positive M5 + clean holders = profile worth studying',
          'Suspicious liquidity remains a risk flag regardless of M5',
        ],
      },
      {
        field:  'vlrBucket / VLR_GTE_2',
        status: 'TRUSTED_CAPTURE_TIME',
        notes: [
          'VLR_GTE_2 should NOT be automatically rejected',
          'High VLR can mean real attention, bot churn, or exhaustion',
          'Study VLR_GTE_2 split by: M5 band, liquidity bucket, clusterRisk, holder concentration',
          'VLR_GTE_2 + positive M5 + enough liquidity may be useful',
          'VLR_GTE_2 + extreme M5 + thin liquidity + bad holders is likely dangerous',
        ],
      },
      {
        field:  'clusterRisk / bubbleMapsScore',
        status: 'RISK_FILTER',
        notes: [
          'Holder concentration and bundle behavior are primary risk filters',
          'Top holder %, creator/dev holdings, bundled wallets, coordinated snipers — all override momentum',
          'Do not trust clean price action if holder structure is predatory',
          'CLEAN cluster + adequate liquidity + moderate M5 is the profile worth forward-testing',
        ],
      },
      {
        field:  'timingPath (ENTER_NOW / WAIT_10M)',
        status: 'TIMING_SIGNAL',
        notes: [
          'ENTER_NOW vs WAIT_10M should eventually be context-sensitive to M5 and holder quality',
          'Strong clean M5 + clean holders + enough liquidity may support ENTER_NOW research',
          'Weak or uncertain M5 may support WAIT_10M research',
          'Negative M5 or extreme spike should be studied as reject/watch candidates',
          'Do NOT change timing gates until forward paper evidence confirms the split',
        ],
      },
      {
        field:  'social/narrative signals',
        status: 'CONTEXT_SIGNAL',
        notes: [
          'Confidence enhancers only — not primary entry triggers',
          'Useful context: socials, token profile, logo/image, DexScreener boosts, community takeover',
          'Active narrative fit adds context but must not override bad liquidity or holder structure',
          'Social hype with predatory holder structure is a trap signal, not a buy signal',
        ],
      },
    ],

    rejectFirstPrinciples: [
      'Holder concentration or bundle risk detected → reject regardless of M5 or VLR',
      'Thin liquidity (below threshold) + extreme M5 spike → likely exhaustion trap',
      'LATE_CHASE timing (age > 5m, already pumped) + no independent M5 confirmation → reject',
      'High VLR + negative M5 + suspicious cluster → likely bot churn on a failing token',
      'Social hype + predatory holder structure → do not override risk filters',
      'Contaminated outcome field (priceChangePct / PRICE_PUMP) → never treat as predictor',
    ],

    evidenceThresholds: [
      { n: 20,  label: 'IGNORE',           meaning: 'Sample too small — no conclusions' },
      { n: 50,  label: 'INTERESTING_ONLY', meaning: 'Directional hint only — not actionable' },
      { n: 100, label: 'EARLY_EVIDENCE',   meaning: 'Pattern worth tracking but not gate-ready' },
      { n: 200, label: 'USABLE_SIGNAL',    meaning: 'Research signal usable for gate proposals' },
      { n: 500, label: 'STRONGER',         meaning: 'Stronger confidence — forward paper test warranted' },
    ],

    nextQuestions: [
      {
        id:       1,
        question: 'Does DEX_SCREENER_M5 separate winners from junk?',
        requires: 'n >= 100 cycle rows with non-null entryMomentumPct matched to learning-memory outcomes',
      },
      {
        id:       2,
        question: 'Which M5 band performs best?',
        requires: 'n >= 20 per band across outcome-labeled cycle rows',
      },
      {
        id:       3,
        question: 'Does high M5 fail with thin liquidity?',
        requires: 'Cross-tab of M5 band vs liquidity bucket vs outcomeLabel, n >= 50 per cell',
      },
      {
        id:       4,
        question: 'Does high M5 fail with bad holder concentration?',
        requires: 'Cross-tab of M5 band vs bubbleMapsScore/clusterRisk vs outcomeLabel, n >= 50 per cell',
      },
      {
        id:       5,
        question: 'Does VLR_GTE_2 become useful only with positive M5?',
        requires: 'VLR_GTE_2 subset split by M5 band, n >= 20 per band',
      },
      {
        id:       6,
        question: 'Does WAIT_10M beat ENTER_NOW for uncertain M5 (-5 to +5 band)?',
        requires: 'Timing path split by M5 band, n >= 50 per timingPath per band',
      },
      {
        id:       7,
        question: 'What do false-approved junk tokens have in common?',
        requires: 'False-approve review from fingerprint report, n >= 20 false approves',
      },
      {
        id:       8,
        question: 'What rejected winners were actually catchable at entry time?',
        requires: 'False-reject review from fingerprint report, n >= 20 false rejects',
      },
    ],

    reportOnly:           true,
    readOnly:             true,
    paperOnly:            true,
    realTradingLocked:    true,
    tradingExecuted:      0,
    noGateChanges:        true,
    noScoringChanges:     true,
    noBuyApprovalChanges: true,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────

export function renderBrainDoctrineReport(result: BrainDoctrineResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER BRAIN DOCTRINE REPORT');
  L.push('  [REPORT ONLY — NO TRADES — NO GATE CHANGES — READ ONLY]');
  L.push(SEP, '');
  L.push(`  Doctrine version : ${result.version}`);
  L.push(`  Doctrine date    : ${result.doctrineDate}`);
  L.push(`  Generated at     : ${result.generatedAt}`);
  L.push('');

  // §1 — Active research priorities
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — ACTIVE RESEARCH PRIORITIES');
  L.push(`  ${SEP2}`, '');
  for (const p of result.activeResearchPriorities) {
    L.push(`  • ${p}`);
  }
  L.push('');

  // §2 — Contaminated fields
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — CONTAMINATED FIELDS WARNING');
  L.push(`  ${SEP2}`, '');
  L.push('  ⚠ The following fields are CONTAMINATED and MUST NOT be used as entry predictors:');
  L.push('');
  for (const f of result.contaminatedFields) {
    L.push(`    ✗ ${f}`);
  }
  L.push('');
  L.push(`  Reason: ${result.contaminationReason}`);
  L.push('');
  L.push('  Action required: Use entryMomentumPct (source=DEX_SCREENER_M5) as the');
  L.push('  capture-time momentum proxy. This field is independent of the observation window.');
  L.push('');

  // §3 — Trusted entry-time fields
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — TRUSTED ENTRY-TIME FIELDS');
  L.push(`  ${SEP2}`, '');
  L.push('  These fields are available at capture time, before the observation window closes:');
  L.push('');
  for (const f of result.trustedEntryTimeFields) {
    L.push(`  ✓ ${f}`);
  }
  L.push('');
  L.push(`  Preferred momentum source : ${result.preferredMomentumSource}`);
  L.push(`  Preferred momentum window : ${result.preferredMomentumWindow}`);
  L.push('');

  // §4 — M5 bands
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — M5 MOMENTUM BANDS');
  L.push(`  ${SEP2}`, '');
  L.push('  Study entryMomentumPct in the following bands:');
  L.push('');
  for (const b of result.m5Bands) {
    L.push(`  ${b.label.padEnd(20)} ${b.description}`);
  }
  L.push('');
  L.push(`  Note: ${result.m5BandNote}`);
  L.push('');

  // §5 — Signal interaction map
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — SIGNAL INTERACTION MAP');
  L.push(`  ${SEP2}`, '');
  for (const s of result.signalInteractionMap) {
    const statusTag = `[${s.status}]`;
    L.push(`  ${s.field}`);
    L.push(`    Status: ${statusTag}`);
    for (const n of s.notes) {
      L.push(`    • ${n}`);
    }
    L.push('');
  }

  // §6 — Reject-first principles
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — REJECT-FIRST PRINCIPLES');
  L.push(`  ${SEP2}`, '');
  L.push('  Apply these in order before evaluating positive signals:');
  L.push('');
  for (const p of result.rejectFirstPrinciples) {
    L.push(`  ✗ ${p}`);
  }
  L.push('');

  // §7 — Evidence thresholds
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — REQUIRED EVIDENCE THRESHOLDS');
  L.push(`  ${SEP2}`, '');
  L.push('  No production gate changes until forward paper evidence confirms the signal.');
  L.push('');
  for (const t of result.evidenceThresholds) {
    L.push(`  n >= ${String(t.n).padStart(4)}  [${t.label.padEnd(18)}]  ${t.meaning}`);
  }
  L.push('');

  // §8 — Next questions
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — CURRENT BRAIN RESEARCH QUESTIONS');
  L.push(`  ${SEP2}`, '');
  L.push('  These questions must be answered by forward paper data before any gate change:');
  L.push('');
  for (const q of result.nextQuestions) {
    L.push(`  Q${q.id}: ${q.question}`);
    L.push(`    Requires: ${q.requires}`);
    L.push('');
  }

  // §9 — Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    NO_GATE_CHANGES=true');
  L.push('  NO_SCORING_CHANGES=true    NO_BUY_APPROVAL_CHANGES=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  paperOnly=true    No data files mutated.    No autopilot wiring.');
  L.push('');
  L.push('  This report encodes research doctrine only. It does not change gates,');
  L.push('  scoring, buy approvals, autopilot decisions, or any trading behavior.');
  L.push('  entryMomentumPct MUST NOT affect buy approval until forward evidence confirms.');
  L.push('  Do not call token:auto-paper or token:paper-buy from this report.');
  L.push(SEP, '');

  return L.join('\n');
}
