import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovedAutopsy,
  renderRipperApprovedAutopsy,
  type RipperApprovedAutopsyResult,
} from '../src/token-grab/ripperApprovedAutopsy';

// ── Time anchors ──────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const T1_ISO  = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // 1h before NOW
const T2_ISO  = new Date(NOW_MS - 30 * 60 * 1000).toISOString(); // 30m before NOW
const T3_ISO  = new Date(NOW_MS).toISOString();                    // NOW

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CheckpointFile {
  generatedAt?: string;
  checkpointAt?: string;
  checkpointLabel?: string;
  candidates: CandidateEntry[];
}

interface CandidateEntry {
  contractKey: string;
  symbol?: string;
  entryPriceUsd?: number;
  approvedAt?: string;
  ageMinutes?: number;
  clusterRisk?: string;
  score?: number;
  currentPriceUsd?: number | null;
  pctChangeFromEntry?: number | null;
  multipleFromEntry?: number | null;
  checkpointAt?: string;
  checkpointLabel?: string;
}

function writeCheckpointFile(filePath: string, data: CheckpointFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function makeCandidate(overrides: Partial<CandidateEntry> = {}): CandidateEntry {
  return {
    contractKey:       'ContractAAAABBBBCCCC',
    symbol:            'FRESH',
    entryPriceUsd:     0.0001,
    approvedAt:        T1_ISO,
    ageMinutes:        8.5,
    clusterRisk:       'CLEAN',
    score:             82,
    currentPriceUsd:   null,
    pctChangeFromEntry: null,
    multipleFromEntry:  null,
    ...overrides,
  };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function filePath(name: string): string {
  return path.join(tmpDir, name);
}

// ── grouping ──────────────────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — grouping', () => {
  it('groups same contractKey from multiple checkpoint files', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      generatedAt:     T1_ISO,
      checkpointAt:    T1_ISO,
      checkpointLabel: 'T1',
      candidates:      [makeCandidate({ pctChangeFromEntry: -10, multipleFromEntry: 0.9, currentPriceUsd: 0.00009, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      generatedAt:     T2_ISO,
      checkpointAt:    T2_ISO,
      checkpointLabel: 'T2',
      candidates:      [makeCandidate({ pctChangeFromEntry: 20, multipleFromEntry: 1.2, currentPriceUsd: 0.00012, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.uniqueCandidates).toBe(1);
    expect(result.candidates[0].checkpoints).toHaveLength(2);
  });

  it('keeps distinct contractKeys separate', () => {
    writeCheckpointFile(filePath('chk.json'), {
      generatedAt: T1_ISO,
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'TokenA', pctChangeFromEntry: 10 }),
        makeCandidate({ contractKey: 'TokenB', pctChangeFromEntry: -5 }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.uniqueCandidates).toBe(2);
    const keys = result.candidates.map(c => c.contractKey);
    expect(keys).toContain('TokenA');
    expect(keys).toContain('TokenB');
  });

  it('counts candidatesScanned including all file entries', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ contractKey: 'TokA' }), makeCandidate({ contractKey: 'TokB' })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ contractKey: 'TokA' })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidatesScanned).toBe(3);
    expect(result.uniqueCandidates).toBe(2);
  });

  it('records firstCheckpointAt and latestCheckpointAt in chronological order', () => {
    writeCheckpointFile(filePath('early.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -5, checkpointAt: T2_ISO })],
    });
    writeCheckpointFile(filePath('late.json'), {
      checkpointAt: T3_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 15, checkpointAt: T3_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('early.json'), filePath('late.json')],
      nowMs:      NOW_MS,
    });

    const rec = result.candidates[0];
    expect(rec.firstCheckpointAt).toBe(T2_ISO);
    expect(rec.latestCheckpointAt).toBe(T3_ISO);
  });
});

// ── pctChange computation ─────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — pctChange computation', () => {
  it('finalPctChange comes from the latest checkpoint by time', () => {
    writeCheckpointFile(filePath('chk.json'), {
      candidates: [
        makeCandidate({ pctChangeFromEntry: -20, checkpointAt: T1_ISO }),
        makeCandidate({ pctChangeFromEntry:  30, checkpointAt: T3_ISO }),
        makeCandidate({ pctChangeFromEntry:  10, checkpointAt: T2_ISO }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.candidates[0].finalPctChange).toBe(30);
  });

  it('bestPctChange is the maximum across all checkpoints', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 50, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -10, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidates[0].bestPctChange).toBe(50);
  });

  it('worstPctChange is the minimum across all checkpoints', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 50, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -60, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidates[0].worstPctChange).toBe(-60);
  });

  it('maxMultiple is the maximum multipleFromEntry across all checkpoints', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ multipleFromEntry: 3.5, pctChangeFromEntry: 250, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ multipleFromEntry: 0.8, pctChangeFromEntry: -20, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidates[0].maxMultiple).toBeCloseTo(3.5, 5);
  });

  it('fallsback to file-level checkpointAt when candidate lacks checkpointAt', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 25 })], // no checkpointAt on candidate
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.candidates[0].finalPctChange).toBe(25);
    expect(result.candidates[0].firstCheckpointAt).toBe(T1_ISO);
  });
});

// ── ever-positive / never-positive ───────────────────────────────────────────

describe('runRipperApprovedAutopsy — ever-positive tracking', () => {
  it('everPositive=true when any checkpoint was positive', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry:  5, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -50, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidates[0].everPositive).toBe(true);
    expect(result.everPositiveCount).toBe(1);
    expect(result.neverPositiveCount).toBe(0);
  });

  it('everPositive=false when all checkpoints are negative', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -10, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: -20, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    expect(result.candidates[0].everPositive).toBe(false);
    expect(result.neverPositiveCount).toBe(1);
    expect(result.everPositiveCount).toBe(0);
  });

  it('counts ever-positive and never-positive correctly across multiple candidates', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'Winner',     pctChangeFromEntry:  30 }),
        makeCandidate({ contractKey: 'EverLoss',   pctChangeFromEntry: -20 }),
        makeCandidate({ contractKey: 'EverLoss2',  pctChangeFromEntry: -5  }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.everPositiveCount).toBe(1);
    expect(result.neverPositiveCount).toBe(2);
  });
});

// ── aggregates ────────────────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — aggregates', () => {
  it('computes averageFinalPctChange across candidates with price', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'A', pctChangeFromEntry:  50 }),
        makeCandidate({ contractKey: 'B', pctChangeFromEntry: -10 }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.averageFinalPctChange).toBeCloseTo(20, 5);
  });

  it('identifies bestFinalCandidate and worstFinalCandidate', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'Best',  symbol: 'BEST',  pctChangeFromEntry:  80 }),
        makeCandidate({ contractKey: 'Mid',   symbol: 'MID',   pctChangeFromEntry:  10 }),
        makeCandidate({ contractKey: 'Worst', symbol: 'WORST', pctChangeFromEntry: -50 }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.bestFinalCandidate?.contractKey).toBe('Best');
    expect(result.worstFinalCandidate?.contractKey).toBe('Worst');
  });

  it('counts winnersAtLatest and losersAtLatest from final checkpoint', () => {
    writeCheckpointFile(filePath('chk1.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ contractKey: 'Tok', pctChangeFromEntry: 100, checkpointAt: T1_ISO })],
    });
    writeCheckpointFile(filePath('chk2.json'), {
      checkpointAt: T2_ISO,
      candidates:   [makeCandidate({ contractKey: 'Tok', pctChangeFromEntry:  -5, checkpointAt: T2_ISO })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('chk1.json'), filePath('chk2.json')],
      nowMs:      NOW_MS,
    });

    // Latest checkpoint is T2 where pctChange = -5
    expect(result.winnersAtLatest).toBe(0);
    expect(result.losersAtLatest).toBe(1);
  });

  it('sorts candidates with price first, descending by finalPctChange', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'NoPx',  pctChangeFromEntry: null }),
        makeCandidate({ contractKey: 'Low',   pctChangeFromEntry: -20  }),
        makeCandidate({ contractKey: 'High',  pctChangeFromEntry:  80  }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.candidates[0].contractKey).toBe('High');
    expect(result.candidates[1].contractKey).toBe('Low');
    expect(result.candidates[2].contractKey).toBe('NoPx');
  });

  it('computes age-bucket averages for winners and losers', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'W1', ageMinutes: 10, pctChangeFromEntry:  30 }),
        makeCandidate({ contractKey: 'W2', ageMinutes: 20, pctChangeFromEntry:  50 }),
        makeCandidate({ contractKey: 'L1', ageMinutes: 15, pctChangeFromEntry: -10 }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.avgApprovalAgeWinners).toBeCloseTo(15, 5); // (10+20)/2
    expect(result.avgApprovalAgeLosers).toBeCloseTo(15, 5);  // (15)/1
  });
});

// ── missing price ─────────────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — missing price handling', () => {
  it('finalPctChange is null when no checkpoint has price data', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: null, checkpointAt: T1_ISO })],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.candidates[0].finalPctChange).toBeNull();
    expect(result.candidatesWithPrice).toBe(0);
  });

  it('candidatesWithPrice counts only candidates with non-null finalPctChange', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates: [
        makeCandidate({ contractKey: 'WithPx',    pctChangeFromEntry:  20 }),
        makeCandidate({ contractKey: 'WithoutPx', pctChangeFromEntry: null }),
      ],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.candidatesWithPrice).toBe(1);
  });

  it('averageFinalPctChange is null when no candidates have price', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: null })],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.averageFinalPctChange).toBeNull();
  });
});

// ── missing / no files ────────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — missing files', () => {
  it('counts missing files without throwing', () => {
    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('no-such.json')],
      nowMs:      NOW_MS,
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(0);
    expect(result.uniqueCandidates).toBe(0);
  });

  it('processes present files when others are missing', () => {
    writeCheckpointFile(filePath('present.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 10 })],
    });

    const result = runRipperApprovedAutopsy({
      inputPaths: [filePath('ghost.json'), filePath('present.json')],
      nowMs:      NOW_MS,
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(1);
    expect(result.uniqueCandidates).toBe(1);
  });

  it('returns zero counts when no files provided', () => {
    const result = runRipperApprovedAutopsy({ inputPaths: [], nowMs: NOW_MS });

    expect(result.uniqueCandidates).toBe(0);
    expect(result.candidatesWithPrice).toBe(0);
    expect(result.averageFinalPctChange).toBeNull();
  });

  it('handles malformed JSON file without throwing', () => {
    const bad = filePath('bad.json');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, '{ not valid json', 'utf-8');

    const result = runRipperApprovedAutopsy({ inputPaths: [bad], nowMs: NOW_MS });

    expect(result.filesRead).toBe(1);  // file exists, counted as read
    expect(result.uniqueCandidates).toBe(0); // but nothing extracted
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperApprovedAutopsy — safety fields', () => {
  it('result always has realTradingLocked=true tradingExecuted=0', () => {
    const result = runRipperApprovedAutopsy({ inputPaths: [], nowMs: NOW_MS });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields unchanged when price data is present', () => {
    writeCheckpointFile(filePath('chk.json'), {
      checkpointAt: T1_ISO,
      candidates:   [makeCandidate({ pctChangeFromEntry: 100 })],
    });

    const result = runRipperApprovedAutopsy({ inputPaths: [filePath('chk.json')], nowMs: NOW_MS });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperApprovedAutopsy', () => {
  function makeResult(overrides: Partial<RipperApprovedAutopsyResult> = {}): RipperApprovedAutopsyResult {
    return {
      generatedAt:           NOW_ISO,
      filesRead:             2,
      filesMissing:          0,
      candidatesScanned:     10,
      uniqueCandidates:      4,
      candidatesWithPrice:   3,
      winnersAtLatest:       1,
      losersAtLatest:        2,
      averageFinalPctChange: -15.0,
      bestFinalCandidate: {
        contractKey: 'BestToken',
        symbol:      'BEST',
        pctChange:   10.5,
        multiple:    1.1,
      },
      worstFinalCandidate: {
        contractKey: 'WorstToken',
        symbol:      'WORST',
        pctChange:   -45.0,
        multiple:    0.55,
      },
      everPositiveCount:    1,
      neverPositiveCount:   2,
      avgApprovalAgeWinners: 8.5,
      avgApprovalAgeLosers:  12.0,
      candidates:            [],
      realTradingLocked:     true,
      tradingExecuted:       0,
      noRealTradeSent:       true,
      paperOnly:             true,
      readOnly:              true,
      ...overrides,
    };
  }

  it('contains REAL TRADING LOCKED header', () => {
    expect(renderRipperApprovedAutopsy(makeResult())).toContain('REAL TRADING LOCKED');
  });

  it('contains safety footer', () => {
    const out = renderRipperApprovedAutopsy(makeResult());
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows summary stats', () => {
    const out = renderRipperApprovedAutopsy(makeResult());
    expect(out).toContain('4');   // uniqueCandidates
    expect(out).toContain('3');   // candidatesWithPrice
    expect(out).toContain('-15.0%');
  });

  it('shows best and worst candidates', () => {
    const out = renderRipperApprovedAutopsy(makeResult());
    expect(out).toContain('$BEST');
    expect(out).toContain('+10.5%');
    expect(out).toContain('$WORST');
    expect(out).toContain('-45.0%');
  });

  it('shows ever-positive and never-positive counts', () => {
    const out = renderRipperApprovedAutopsy(makeResult());
    expect(out).toContain('1'); // everPositiveCount
    expect(out).toContain('2'); // neverPositiveCount
  });

  it('shows age-bucket insight when present', () => {
    const out = renderRipperApprovedAutopsy(makeResult());
    expect(out).toContain('8.5m');
    expect(out).toContain('12.0m');
  });

  it('shows no candidates message when list is empty', () => {
    expect(renderRipperApprovedAutopsy(makeResult({ candidates: [] }))).toContain('no candidates found');
  });

  it('shows candidate rows when present', () => {
    const result = makeResult({
      candidates: [{
        contractKey:       'MyCoolToken12345',
        symbol:            'MOON',
        entryPriceUsd:     0.0001,
        approvedAt:        T1_ISO,
        ageMinutes:        9.2,
        clusterRisk:       'CLEAN',
        score:             88,
        checkpoints:       [],
        firstCheckpointAt:  T1_ISO,
        latestCheckpointAt: T2_ISO,
        bestPctChange:     120,
        worstPctChange:    -15,
        finalPctChange:    -15,
        maxMultiple:       2.2,
        everPositive:      true,
      }],
    });
    const out = renderRipperApprovedAutopsy(result);
    expect(out).toContain('$MOON');
    expect(out).toContain('CLEAN');
    expect(out).toContain('+120.0%');
    expect(out).toContain('-15.0%');
  });

  it('shows missing files count when > 0', () => {
    expect(renderRipperApprovedAutopsy(makeResult({ filesMissing: 3 }))).toContain('3 missing');
  });
});
