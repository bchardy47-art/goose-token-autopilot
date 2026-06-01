import { AppLogger } from '../logger';
import type { AppConfig } from '../types';
import type { AppDb } from '../db';
import { runScan } from '../scanner';
import { scoreAllTokens } from '../scoring/scoreToken';
import { createTopProposal } from '../proposals/createProposal';
import { executeBuy } from '../trading/real';

export async function runAutopilot(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<Record<string, unknown>> {
  const runLogId = db.createRunLog('token:autopilot');
  try {
    const scan = await runScan(db, config, logger);
    const scores = scoreAllTokens(db, config);
    const proposal = createTopProposal(db, config);

    let execution: Record<string, unknown> | null = null;
    if (proposal) {
      const result = executeBuy(db, config, proposal.tokenId, proposal.id, proposal.amountUsd, logger);
      execution = result;
      logger.info('Autopilot attempted guarded execution', { proposalId: proposal.id, blocked: result.blocked, reason: result.reason });
    } else {
      logger.info('Autopilot found no eligible proposal to attempt');
    }

    const summary = {
      scan,
      scored: scores.length,
      proposalId: proposal?.id ?? null,
      attemptedExecution: execution,
      safeByDefault: true
    };
    db.finishRunLog(runLogId, 'SUCCESS', summary);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown autopilot error';
    db.finishRunLog(runLogId, 'FAILED', { error: message });
    logger.error('Autopilot failed', { error: message });
    throw error;
  }
}
