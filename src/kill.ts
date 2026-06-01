import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types';
import { isKillSwitchActive } from './trading/guards';

export function activateKillSwitch(config: AppConfig): { file: string; active: boolean } {
  fs.mkdirSync(path.dirname(config.killSwitchFile), { recursive: true });
  fs.writeFileSync(config.killSwitchFile, JSON.stringify({ activatedAt: new Date().toISOString(), reason: 'manual kill switch activation' }, null, 2));
  return { file: config.killSwitchFile, active: isKillSwitchActive(config) };
}
