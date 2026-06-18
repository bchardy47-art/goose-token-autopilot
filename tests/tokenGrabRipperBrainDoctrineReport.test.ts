import { describe, it, expect } from 'vitest';
import {
  runBrainDoctrineReport,
  renderBrainDoctrineReport,
  DOCTRINE_VERSION,
  DOCTRINE_DATE,
} from '../src/token-grab/ripperBrainDoctrineReport';

// ── Tests: runBrainDoctrineReport ─────────────────────────────────────────────

describe('runBrainDoctrineReport — structure', () => {
  it('returns the correct doctrine version', () => {
    const r = runBrainDoctrineReport({});
    expect(r.version).toBe(DOCTRINE_VERSION);
    expect(r.version).toBe('v1');
  });

  it('returns the correct doctrine date', () => {
    const r = runBrainDoctrineReport({});
    expect(r.doctrineDate).toBe(DOCTRINE_DATE);
  });

  it('generates a deterministic generatedAt when nowMs is provided', () => {
    const nowMs = Date.parse('2026-06-18T10:00:00.000Z');
    const r = runBrainDoctrineReport({ nowMs });
    expect(r.generatedAt).toBe('2026-06-18T10:00:00.000Z');
  });

  it('returns active research priorities (non-empty array)', () => {
    const r = runBrainDoctrineReport({});
    expect(Array.isArray(r.activeResearchPriorities)).toBe(true);
    expect(r.activeResearchPriorities.length).toBeGreaterThan(0);
  });
});

describe('runBrainDoctrineReport — contamination', () => {
  it('lists priceChangePct as contaminated', () => {
    const r = runBrainDoctrineReport({});
    const joined = r.contaminatedFields.join(' ');
    expect(joined).toContain('priceChangePct');
  });

  it('lists PRICE_PUMP as contaminated', () => {
    const r = runBrainDoctrineReport({});
    const joined = r.contaminatedFields.join(' ');
    expect(joined).toContain('PRICE_PUMP');
  });

  it('contamination reason mentions circular/artifact', () => {
    const r = runBrainDoctrineReport({});
    const reason = r.contaminationReason.toLowerCase();
    expect(reason.includes('artifact') || reason.includes('circular')).toBe(true);
  });

  it('lists at least 2 contaminated fields', () => {
    const r = runBrainDoctrineReport({});
    expect(r.contaminatedFields.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runBrainDoctrineReport — trusted fields', () => {
  it('lists entryMomentumPct as a trusted entry-time field', () => {
    const r = runBrainDoctrineReport({});
    const joined = r.trustedEntryTimeFields.join(' ');
    expect(joined).toContain('entryMomentumPct');
  });

  it('preferred momentum source is DEX_SCREENER_M5', () => {
    const r = runBrainDoctrineReport({});
    expect(r.preferredMomentumSource).toBe('DEX_SCREENER_M5');
  });

  it('preferred momentum window is M5', () => {
    const r = runBrainDoctrineReport({});
    expect(r.preferredMomentumWindow).toBe('M5');
  });
});

describe('runBrainDoctrineReport — M5 bands', () => {
  it('defines 6 M5 bands', () => {
    const r = runBrainDoctrineReport({});
    expect(r.m5Bands.length).toBe(6);
  });

  it('includes a band for <= -20', () => {
    const r = runBrainDoctrineReport({});
    expect(r.m5Bands.some(b => b.label.includes('-20'))).toBe(true);
  });

  it('includes a band for > +50', () => {
    const r = runBrainDoctrineReport({});
    expect(r.m5Bands.some(b => b.label.includes('+50') || b.label.includes('50'))).toBe(true);
  });

  it('M5 band note mentions moderate vs extreme', () => {
    const r = runBrainDoctrineReport({});
    const note = r.m5BandNote.toLowerCase();
    expect(note.includes('moderate') || note.includes('extreme')).toBe(true);
  });
});

describe('runBrainDoctrineReport — signal interaction map', () => {
  it('includes entryMomentumPct as TRUSTED_CAPTURE_TIME', () => {
    const r = runBrainDoctrineReport({});
    const entry = r.signalInteractionMap.find(s => s.field.includes('entryMomentumPct'));
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('TRUSTED_CAPTURE_TIME');
  });

  it('includes priceChangePct/PRICE_PUMP as CONTAMINATED_OUTCOME', () => {
    const r = runBrainDoctrineReport({});
    const entry = r.signalInteractionMap.find(s =>
      s.field.includes('priceChangePct') || s.field.includes('PRICE_PUMP')
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('CONTAMINATED_OUTCOME');
  });

  it('includes clusterRisk as RISK_FILTER', () => {
    const r = runBrainDoctrineReport({});
    const entry = r.signalInteractionMap.find(s => s.field.includes('clusterRisk'));
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('RISK_FILTER');
  });

  it('includes timingPath as TIMING_SIGNAL', () => {
    const r = runBrainDoctrineReport({});
    const entry = r.signalInteractionMap.find(s => s.field.includes('timingPath'));
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('TIMING_SIGNAL');
  });

  it('includes social/narrative as CONTEXT_SIGNAL', () => {
    const r = runBrainDoctrineReport({});
    const entry = r.signalInteractionMap.find(s => s.field.toLowerCase().includes('social'));
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('CONTEXT_SIGNAL');
  });

  it('has at least 5 entries in the map', () => {
    const r = runBrainDoctrineReport({});
    expect(r.signalInteractionMap.length).toBeGreaterThanOrEqual(5);
  });
});

describe('runBrainDoctrineReport — reject-first principles', () => {
  it('lists at least 3 reject-first principles', () => {
    const r = runBrainDoctrineReport({});
    expect(r.rejectFirstPrinciples.length).toBeGreaterThanOrEqual(3);
  });

  it('mentions holder concentration/bundle risk', () => {
    const r = runBrainDoctrineReport({});
    const joined = r.rejectFirstPrinciples.join(' ').toLowerCase();
    expect(joined.includes('holder') || joined.includes('bundle')).toBe(true);
  });
});

describe('runBrainDoctrineReport — evidence thresholds', () => {
  it('defines evidence thresholds', () => {
    const r = runBrainDoctrineReport({});
    expect(r.evidenceThresholds.length).toBeGreaterThan(0);
  });

  it('n < 20 maps to an ignore/too-small threshold', () => {
    const r = runBrainDoctrineReport({});
    const small = r.evidenceThresholds.find(t => t.n <= 20);
    expect(small).toBeDefined();
    const label = small!.label.toUpperCase();
    expect(label.includes('IGNORE') || label.includes('TOO_SMALL')).toBe(true);
  });

  it('includes a threshold for n >= 100', () => {
    const r = runBrainDoctrineReport({});
    expect(r.evidenceThresholds.some(t => t.n >= 100)).toBe(true);
  });
});

describe('runBrainDoctrineReport — next questions', () => {
  it('lists exactly 8 research questions', () => {
    const r = runBrainDoctrineReport({});
    expect(r.nextQuestions.length).toBe(8);
  });

  it('Q1 is about DEX_SCREENER_M5 separating winners from junk', () => {
    const r = runBrainDoctrineReport({});
    const q1 = r.nextQuestions.find(q => q.id === 1);
    expect(q1).toBeDefined();
    const qText = q1!.question.toLowerCase();
    expect(qText.includes('m5') || qText.includes('winner') || qText.includes('dex')).toBe(true);
  });

  it('all questions have id, question, and requires fields', () => {
    const r = runBrainDoctrineReport({});
    for (const q of r.nextQuestions) {
      expect(typeof q.id).toBe('number');
      expect(typeof q.question).toBe('string');
      expect(typeof q.requires).toBe('string');
      expect(q.question.length).toBeGreaterThan(5);
    }
  });

  it('question IDs are 1 through 8', () => {
    const r = runBrainDoctrineReport({});
    const ids = r.nextQuestions.map(q => q.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('runBrainDoctrineReport — safety flags', () => {
  it('reportOnly=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.reportOnly).toBe(true);
  });

  it('readOnly=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.readOnly).toBe(true);
  });

  it('paperOnly=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.paperOnly).toBe(true);
  });

  it('realTradingLocked=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.realTradingLocked).toBe(true);
  });

  it('tradingExecuted=0', () => {
    const r = runBrainDoctrineReport({});
    expect(r.tradingExecuted).toBe(0);
  });

  it('noGateChanges=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.noGateChanges).toBe(true);
  });

  it('noScoringChanges=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.noScoringChanges).toBe(true);
  });

  it('noBuyApprovalChanges=true', () => {
    const r = runBrainDoctrineReport({});
    expect(r.noBuyApprovalChanges).toBe(true);
  });
});

// ── Tests: renderBrainDoctrineReport ─────────────────────────────────────────

describe('renderBrainDoctrineReport — section headers', () => {
  it('contains all 9 section headers', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('SECTION 1 — ACTIVE RESEARCH PRIORITIES');
    expect(rendered).toContain('SECTION 2 — CONTAMINATED FIELDS WARNING');
    expect(rendered).toContain('SECTION 3 — TRUSTED ENTRY-TIME FIELDS');
    expect(rendered).toContain('SECTION 4 — M5 MOMENTUM BANDS');
    expect(rendered).toContain('SECTION 5 — SIGNAL INTERACTION MAP');
    expect(rendered).toContain('SECTION 6 — REJECT-FIRST PRINCIPLES');
    expect(rendered).toContain('SECTION 7 — REQUIRED EVIDENCE THRESHOLDS');
    expect(rendered).toContain('SECTION 8 — CURRENT BRAIN RESEARCH QUESTIONS');
    expect(rendered).toContain('SECTION 9 — SAFETY');
  });
});

describe('renderBrainDoctrineReport — contamination warning', () => {
  it('contains CONTAMINATED warning for PRICE_PUMP', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('CONTAMINATED');
    expect(rendered).toContain('PRICE_PUMP');
  });

  it('contains priceChangePct in contamination section', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('priceChangePct');
  });
});

describe('renderBrainDoctrineReport — M5 bands', () => {
  it('renders all 6 M5 bands', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    for (const b of r.m5Bands) {
      expect(rendered).toContain(b.label);
    }
  });
});

describe('renderBrainDoctrineReport — evidence thresholds', () => {
  it('shows evidence thresholds table', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('REQUIRED EVIDENCE THRESHOLDS');
    expect(rendered).toContain('No production gate changes');
  });
});

describe('renderBrainDoctrineReport — research questions', () => {
  it('shows all 8 questions numbered Q1 through Q8', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    for (let i = 1; i <= 8; i++) {
      expect(rendered).toContain(`Q${i}:`);
    }
  });
});

describe('renderBrainDoctrineReport — safety footer', () => {
  it('shows safety footer with all key flags', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('REPORT_ONLY=true');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(rendered).toContain('NO_GATE_CHANGES=true');
    expect(rendered).toContain('NO_SCORING_CHANGES=true');
    expect(rendered).toContain('NO_BUY_APPROVAL_CHANGES=true');
  });

  it('contains entryMomentumPct buy-approval prohibition', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('entryMomentumPct MUST NOT affect buy approval');
  });

  it('does not mention token:auto-paper or token:paper-buy as actions to take', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    // Only mention as "do not call"
    expect(rendered).toContain('Do not call token:auto-paper');
  });
});

describe('renderBrainDoctrineReport — doctrine version header', () => {
  it('shows doctrine version in header', () => {
    const r = runBrainDoctrineReport({});
    const rendered = renderBrainDoctrineReport(r);
    expect(rendered).toContain('v1');
    expect(rendered).toContain('BRAIN DOCTRINE REPORT');
  });
});
