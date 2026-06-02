import type { AppDb } from './db';
import type { AppConfig, WatchOnlySignalClass } from './types';
import { buildSignalAuditReport } from './signalAudit';
import { runSafetyEnrich } from './safetyEnrich';

const DEFAULT_LIMIT = 50;

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return fallback;
  return value;
}

function parseBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true';
}

function parseFormat(raw: string | undefined): 'json' | 'table' {
  return raw === 'table' ? 'table' : 'json';
}

function parseClassFilter(raw: string | undefined): WatchOnlySignalClass[] | null {
  if (!raw) return null;
  const allowed: WatchOnlySignalClass[] = ['EARLY_RUNNER', 'LATE_RUNNER', 'INSTANT_DUMP', 'DEAD_NOISE', 'TOO_DANGEROUS'];
  const values = raw.split(',').map((value) => value.trim()).filter((value): value is WatchOnlySignalClass => allowed.includes(value as WatchOnlySignalClass));
  return values.length > 0 ? values : null;
}

function topItems(items: string[], limit = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function minutesSince(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / 60_000;
}

function buildDiagnosis(report: ReturnType<typeof buildSafetyEnrichDebugReport>): string[] {
  const messages: string[] = [];
  if (report.summary.totalEnrichmentRows === 0) {
    messages.push('No enrichment rows found. Run token:safety-enrich with ENABLE_SOLANA_SAFETY_ENRICHMENT=true.');
    return messages;
  }
  if (report.summary.totalEnrichmentRows > 0 && report.summary.knownSafetyLinkedRows === 0) {
    messages.push('Enrichment rows exist but audit/compare linkage appears incomplete.');
  }
  if (report.summary.enrichedWatchOnlyCandidatesCount === 0) {
    messages.push('Enrichment rows exist but do not cover compared watch-only candidates.');
  }
  if ((report.summary.mostlyUnknownEnrichmentRows as boolean) === true) {
    messages.push('Enrichment rows exist but RPC/parser returned UNKNOWN for most fields.');
  }
  return messages;
}

export async function buildSafetyEnrichDebugReport(db: AppDb, config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const limit = parsePositiveInteger(env.SAFETY_ENRICH_DEBUG_LIMIT, DEFAULT_LIMIT);
  const onlyMissing = parseBoolean(env.SAFETY_ENRICH_DEBUG_ONLY_MISSING, false);
  const runEnrich = parseBoolean(env.SAFETY_ENRICH_DEBUG_RUN_ENRICH, false);
  const classFilter = parseClassFilter(env.SAFETY_ENRICH_DEBUG_CLASS);

  let enrichRunSummary: Record<string, unknown> | null = null;
  if (runEnrich) {
    enrichRunSummary = await runSafetyEnrich(db, config);
  }

  const watchCandidates = db.listWatchOnlyCandidates();
  const analyses = db.listWatchOnlySignalAnalyses();
  const enrichments = db.listSolanaSafetyEnrichments();
  const audit = buildSignalAuditReport(db, config, { ...env, SIGNAL_AUDIT_LIMIT: '5000' });
  const analysisByCandidate = new Map(analyses.map((row) => [row.watchCandidateId, row]));
  const enrichmentByToken = new Map<number, ReturnType<AppDb['getLatestSolanaSafetyEnrichment']>>();
  for (const row of enrichments) {
    if (!enrichmentByToken.has(row.tokenId)) enrichmentByToken.set(row.tokenId, row);
  }

  let candidateRows = watchCandidates.map((candidate) => {
    const token = db.getTokenRecord(candidate.tokenId);
    const analysis = analysisByCandidate.get(candidate.id) ?? null;
    const enrichment = db.getLatestSolanaSafetyEnrichment(candidate.tokenId);
    const auditRow = audit.candidateRows.find((row) => row.watchCandidateId === candidate.id) ?? null;
    const rawRpcErrorSummary = (() => {
      if (!enrichment?.notes) return null;
      return /failed|timeout|rpc|missing/i.test(enrichment.notes) ? enrichment.notes : null;
    })();
    return {
      watchCandidateId: candidate.id,
      tokenId: candidate.tokenId,
      symbol: token?.symbol ?? null,
      signalClass: analysis?.signalClass ?? null,
      mint: token?.mint ?? null,
      sourceUrl: token?.source_url ?? null,
      hasEnrichmentRow: enrichment !== null,
      enrichmentCheckedAt: enrichment?.checkedAt ?? null,
      mintAuthority: enrichment?.mintAuthority ?? null,
      freezeAuthority: enrichment?.freezeAuthority ?? null,
      mintAuthorityRenounced: enrichment?.mintAuthorityRenounced ?? null,
      freezeAuthorityRenounced: enrichment?.freezeAuthorityRenounced ?? null,
      holderConcentrationStatus: enrichment?.holderConcentrationStatus ?? null,
      topHolderPct: enrichment?.topHolderPct ?? null,
      top10HolderPct: enrichment?.top10HolderPct ?? null,
      safetyStatus: enrichment?.safetyStatus ?? null,
      notes: enrichment?.notes ?? null,
      rawRpcErrorSummary,
      signalAuditRowUsesEnrichment: auditRow !== null && (
        auditRow.mintAuthority === enrichment?.mintAuthority ||
        auditRow.freezeAuthority === enrichment?.freezeAuthority ||
        auditRow.holderConcentration === enrichment?.holderConcentrationStatus
      )
    };
  });

  if (classFilter) {
    candidateRows = candidateRows.filter((row) => row.signalClass !== null && classFilter.includes(row.signalClass));
  }
  if (onlyMissing) {
    candidateRows = candidateRows.filter((row) => !row.hasEnrichmentRow);
  }
  candidateRows = candidateRows.slice(0, limit);

  const newest = enrichments[0]?.checkedAt ?? null;
  const oldest = enrichments.length > 0 ? enrichments[enrichments.length - 1].checkedAt : null;
  const ages = enrichments.map((row) => minutesSince(row.checkedAt));
  const mostlyUnknownEnrichmentRows = enrichments.length > 0 && enrichments.filter((row) => row.mintAuthority === 'UNKNOWN' || row.freezeAuthority === 'UNKNOWN' || row.holderConcentrationStatus === 'UNKNOWN').length / enrichments.length >= 0.5;
  const knownSafetyLinkedRows = audit.candidateRows.filter((row) => row.mintAuthority !== 'UNKNOWN' || row.freezeAuthority !== 'UNKNOWN' || row.holderConcentration !== 'UNKNOWN').length;

  const report = {
    summary: {
      totalTokens: db.getTokenCount(),
      totalWatchOnlyCandidates: watchCandidates.length,
      totalSignalAnalysisRows: analyses.length,
      totalEnrichmentRows: enrichments.length,
      enrichedWatchOnlyCandidatesCount: watchCandidates.filter((candidate) => enrichmentByToken.has(candidate.tokenId)).length,
      enrichedAnalyzedCandidatesCount: analyses.filter((analysis) => enrichmentByToken.has(analysis.tokenId)).length,
      enrichmentRowsBySafetyStatus: topItems(enrichments.map((row) => row.safetyStatus ?? 'UNKNOWN'), 20),
      enrichmentRowsByMintAuthority: topItems(enrichments.map((row) => row.mintAuthority ?? 'UNKNOWN'), 10),
      enrichmentRowsByFreezeAuthority: topItems(enrichments.map((row) => row.freezeAuthority ?? 'UNKNOWN'), 10),
      enrichmentRowsByHolderConcentrationStatus: topItems(enrichments.map((row) => row.holderConcentrationStatus ?? 'UNKNOWN'), 10),
      cacheAgeSummary: {
        minMinutes: ages.length > 0 ? Number(Math.min(...ages).toFixed(2)) : null,
        maxMinutes: ages.length > 0 ? Number(Math.max(...ages).toFixed(2)) : null,
        averageMinutes: ages.length > 0 ? Number((ages.reduce((sum, value) => sum + value, 0) / ages.length).toFixed(2)) : null
      },
      newestEnrichmentCheckedAt: newest,
      oldestEnrichmentCheckedAt: oldest,
      mostlyUnknownEnrichmentRows,
      knownSafetyLinkedRows,
      finalSafetyStatus: 'Real trading remains locked.'
    },
    enrichRunSummary,
    candidateRows,
    diagnostics: [] as string[],
    finalSafetyStatus: 'Real trading remains locked.'
  };

  report.diagnostics = buildDiagnosis(report);
  return report;
}

export function formatSafetyEnrichDebugTable(report: Record<string, any>): string {
  const header = 'watchId | tokenId | symbol | class | hasEnrich | mintAuth | freezeAuth | holder | checkedAt';
  const rows = ((report.candidateRows as Array<Record<string, unknown>>) ?? []).map((row) => {
    return String(row.watchCandidateId)
      + ' | ' + String(row.tokenId)
      + ' | ' + String(row.symbol ?? '-')
      + ' | ' + String(row.signalClass ?? '-')
      + ' | ' + String(row.hasEnrichmentRow)
      + ' | ' + String(row.mintAuthority ?? '-')
      + ' | ' + String(row.freezeAuthority ?? '-')
      + ' | ' + String(row.holderConcentrationStatus ?? '-')
      + ' | ' + String(row.enrichmentCheckedAt ?? '-');
  });
  const diagnostics = Array.isArray(report.diagnostics) ? (report.diagnostics as string[]) : [];
  const lines = [
    'Safety Enrichment Debug Report',
    JSON.stringify(report.summary, null, 2)
  ];
  if (diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics: ' + diagnostics.join(' | '));
  }
  lines.push('');
  lines.push(header);
  lines.push('-'.repeat(header.length));
  lines.push(...rows);
  lines.push('');
  lines.push(String(report.finalSafetyStatus));
  return lines.join('\n');
}

export function renderSafetyEnrichDebug(report: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  return parseFormat(env.SAFETY_ENRICH_DEBUG_FORMAT) === 'table'
    ? formatSafetyEnrichDebugTable(report as Record<string, any>)
    : JSON.stringify(report, null, 2);
}
