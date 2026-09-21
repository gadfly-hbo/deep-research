import type { CitationVerdict } from "../contracts.js";

export interface SpikeQuestionResult {
  question: string;
  verdicts: CitationVerdict[];
  fetched: number;
  parsedOk: number;
  costEstimate: number;
  wallMs: number;
}

export interface SpikeQuestionReport extends SpikeQuestionResult {
  verifiability: number;
  reachability: number;
}

export interface SpikeReport {
  questions: SpikeQuestionReport[];
  overallVerifiability: number;
  overallReachability: number;
  killCriteriaTriggered: boolean;
}

export const KILL_VERIFIABILITY = 0.8;
export const KILL_REACHABILITY = 0.6;

const rate = (hit: number, total: number): number => (total > 0 ? hit / total : 0);

export function buildSpikeReport(results: SpikeQuestionResult[]): SpikeReport {
  const questions = results.map((r) => ({
    ...r,
    verifiability: rate(r.verdicts.filter((x) => x.verdict === "quote-hit").length, r.verdicts.length),
    reachability: rate(r.parsedOk, r.fetched),
  }));
  const totalVerdicts = results.reduce((n, r) => n + r.verdicts.length, 0);
  const totalHits = results.reduce(
    (n, r) => n + r.verdicts.filter((x) => x.verdict === "quote-hit").length,
    0,
  );
  const totalFetched = results.reduce((n, r) => n + r.fetched, 0);
  const totalParsedOk = results.reduce((n, r) => n + r.parsedOk, 0);
  const overallVerifiability = rate(totalHits, totalVerdicts);
  const overallReachability = rate(totalParsedOk, totalFetched);
  return {
    questions,
    overallVerifiability,
    overallReachability,
    killCriteriaTriggered:
      overallVerifiability < KILL_VERIFIABILITY || overallReachability < KILL_REACHABILITY,
  };
}
