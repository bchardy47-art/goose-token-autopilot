import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildPolicyMemory,
  policyProfileKey,
  refreshBrainPolicy,
  resolveBrainDecision,
  type PolicyProfileParts,
} from '../src/token-grab/brainPolicy';
import type { ResearchShadowEvent } from '../src/token-grab/researchShadow';
import { resolveLiveShadowSource, primaryLane } from '../src/token-grab/liveShadow';

const RESEARCH_EVENTS_PATH = path.resolve(__dirname, '../data/token-grab/live-shadow/research-shadow-events.jsonl');
const SOURCE_CYCLE_FILE = path.resolve(__dirname, '../data/token-grab/ripper/cycles/cycle-2026-10-23-201622.jsonl');
const FUTURE_CYCLE_FILE = path.resolve(__dirname, '../data/token-grab/ripper/cycles/cycle-2026-10-23-210946.jsonl');

// Genuine recorded transition: MCRIBINU research buy (cycle 201622) -> sell at EXIT_TS (-5.46%)
// flips its exact profile WATCH -> DEMOTE; ARCTIS in the next cycle (210946) shares that profile.
const ENTRY_TS = '2026-10-23T20:20:01.885Z';
const EXIT_TS = '2026-10-23T20:51:44.396Z';
const BEFORE_EXIT_TS = '2026-10-23T20:51:44.395Z';
const FUTURE_TS = '2026-10-23T21:09:46.000Z';
const ENTRY_CONTRACT = 'AFYC4gSWuRZysQQ7q3Kn9qJEHyjmAegF4KThbAjKpump';
const FUTURE_CONTRACT = '2JSj9dzLQwAi3q1dHYjCPF5Gveg81hBTRy8EeM3Fpump';

const HAVE_REAL_DATA = [RESEARCH_EVENTS_PATH, SOURCE_CYCLE_FILE, FUTURE_CYCLE_FILE].every(f => fs.existsSync(f));

function readEventsBeforeOrAt(ts: string): ResearchShadowEvent[] {
  return fs.readFileSync(RESEARCH_EVENTS_PATH, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as ResearchShadowEvent)
    .filter((e) => (e as { ts?: string }).ts != null && (e as { ts: string }).ts <= ts);
}

function resolveCandidateFromSingleCycle(cyclePath: string, contract: string, nowIso: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-e2e-cycle-'));
  const cyclesDir = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  const name = path.basename(cyclePath);
  fs.writeFileSync(path.join(cyclesDir, name), fs.readFileSync(cyclePath));
  try {
    const resolved = resolveLiveShadowSource({
      cyclesDir,
      statePath: path.join(tmpDir, 'state.json'),
      eventsPath: path.join(tmpDir, 'events.jsonl'),
    }, new Date(nowIso).getTime());
    const candidate = resolved.candidates.find(c => c.contract === contract);
    expect(candidate).toBeTruthy();
    return candidate!;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function partsOfCandidate(contract: string, cyclePath: string, nowIso: string): PolicyProfileParts {
  const candidate = resolveCandidateFromSingleCycle(cyclePath, contract, nowIso);
  const lane = primaryLane(candidate);
  expect(lane).toBeTruthy();
  return {
    lane: lane!,
    productionGateApproved: candidate.productionGateApproved,
    launchAgeBucket: candidate.launchAgeBucket,
    m5Band: candidate.m5Band,
    liquidityBucket: candidate.liquidityBucket,
    vlrBucket: candidate.vlrBucket,
    ripperScoreBand: candidate.ripperScoreBand,
  };
}

describe.skipIf(!HAVE_REAL_DATA)('real-data end-to-end brain refresh', () => {
  it('proves fresh-market entry -> exit -> brain refresh -> later policy suppression with exact cycle attribution', () => {
    const entryParts = partsOfCandidate(ENTRY_CONTRACT, SOURCE_CYCLE_FILE, ENTRY_TS);

    const beforeExitMemory = buildPolicyMemory(readEventsBeforeOrAt(BEFORE_EXIT_TS), {
      generatedAt: BEFORE_EXIT_TS,
    });
    const afterExitMemory = buildPolicyMemory(readEventsBeforeOrAt(EXIT_TS), {
      generatedAt: EXIT_TS,
    });

    const beforeDecision = resolveBrainDecision(beforeExitMemory, entryParts);
    const afterDecision = resolveBrainDecision(afterExitMemory, entryParts);

    expect(beforeDecision.action).toBe('OPEN');
    expect(beforeDecision.status).toBe('WATCH');
    expect(afterDecision.action).toBe('OBSERVE_ONLY');
    expect(afterDecision.status).toBe('DEMOTE');
    expect(afterDecision.source).toBe('EXACT');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-refresh-e2e-'));
    try {
      const subsetEventsPath = path.join(tmpDir, 'research-events.jsonl');
      const memoryPath = path.join(tmpDir, 'policy-memory.json');
      const subsetEvents = readEventsBeforeOrAt(EXIT_TS);
      fs.writeFileSync(subsetEventsPath, subsetEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

      const refresh = refreshBrainPolicy({
        eventsPath: subsetEventsPath,
        memoryPath,
        generatedAt: EXIT_TS,
      });

      const profKey = policyProfileKey(entryParts);

      const profile = refresh.memory.profiles[profKey];
      expect(profile).toBeTruthy();
      expect(profile.valuedClosed).toBe(113);
      expect(profile.unvaluedClosed).toBe(13);
      expect(profile.losses).toBe(68);
      expect(profile.wins).toBe(44);
      expect(profile.policyStatus).toBe('DEMOTE');
      expect(profile.lastUpdated).toBe(EXIT_TS);

      const futureParts = partsOfCandidate(FUTURE_CONTRACT, FUTURE_CYCLE_FILE, FUTURE_TS);
      expect(futureParts).toEqual(entryParts);
      const futureDecision = resolveBrainDecision(refresh.memory, futureParts);
      expect(futureDecision.action).toBe('OBSERVE_ONLY');
      expect(futureDecision.status).toBe('DEMOTE');
      expect(futureDecision.source).toBe('EXACT');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
