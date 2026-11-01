import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'run-token-grab-learning-cron.sh');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-brain-refresh-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeStub(binDir: string, name: string, body: string): void {
  const filePath = path.join(binDir, name);
  fs.writeFileSync(filePath, body, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

describe('run-token-grab-learning-cron brain-refresh integration', () => {
  it('calls brain-refresh in the scheduled code path after learning-memory', () => {
    const binDir = path.join(tmpDir, 'bin');
    const callsPath = path.join(tmpDir, 'calls.log');
    const lockDir = path.join(tmpDir, 'lock');
    fs.mkdirSync(binDir, { recursive: true });

    writeStub(binDir, 'npm', `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${callsPath}"
case "$*" in
  *token:ripper-paper-learning-loop*) exit 0 ;;
  *token:ripper-learning-memory*) exit 0 ;;
  *token:brain-refresh*) exit 0 ;;
  *token:ripper-learning-summary*) exit 0 ;;
  *token:ripper-shadow-filter-candidate-comparison*) exit 0 ;;
  *token:ripper-autopilot-status*) exit 0 ;;
  *) exit 0 ;;
esac
`);

    execFileSync('bash', [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        TOKEN_GRAB_LEARNING_LOCK_DIR: lockDir,
      },
      stdio: 'pipe',
    });

    const calls = fs.readFileSync(callsPath, 'utf-8').trim().split('\n');
    const memoryIdx = calls.findIndex(c => c.includes('token:ripper-learning-memory'));
    const brainIdx = calls.findIndex(c => c.includes('token:brain-refresh'));
    const summaryIdx = calls.findIndex(c => c.includes('token:ripper-learning-summary'));

    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(brainIdx).toBeGreaterThan(memoryIdx);
    expect(summaryIdx).toBeGreaterThan(brainIdx);
  });
});
