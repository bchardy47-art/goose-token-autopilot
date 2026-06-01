import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { runScan } from '../src/scanner';
import { scoreAllTokens } from '../src/scoring/scoreToken';

export function makeTestConfig(overrides: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-token-autopilot-'));
  const config = loadConfig({
    DATABASE_FILE: path.join(dir, 'test.sqlite'),
    KILL_SWITCH_FILE: path.join(dir, '.kill-switch'),
    TOKEN_SOURCE: 'fixture',
    ...overrides
  });
  return { dir, config };
}

export async function seedScoredDb(overrides: Record<string, string> = {}) {
  const { dir, config } = makeTestConfig(overrides);
  const db = createDb(config);
  await runScan(db, config);
  scoreAllTokens(db, config);
  return { dir, config, db };
}
