import fs from 'node:fs';
import path from 'node:path';
import type { SocialSignal, EventSignal, FreshPool, TokenGrabFixtures } from './types';

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/token-grab');

export function loadTokenGrabFixtures(fixturesDir?: string): TokenGrabFixtures {
  const dir = fixturesDir ?? FIXTURES_DIR;
  const socialSignals = JSON.parse(
    fs.readFileSync(path.join(dir, 'social-signals.json'), 'utf-8'),
  ) as SocialSignal[];
  const eventSignals = JSON.parse(
    fs.readFileSync(path.join(dir, 'event-signals.json'), 'utf-8'),
  ) as EventSignal[];
  const freshPools = JSON.parse(
    fs.readFileSync(path.join(dir, 'fresh-pools.json'), 'utf-8'),
  ) as FreshPool[];
  return { socialSignals, eventSignals, freshPools };
}
