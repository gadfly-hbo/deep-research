import type { CitationVerdict, Evidence, SourceSnapshot } from "../contracts.js";

// 忽略全部空白:去空白后连续子串仍是连续子串,不会引入假命中,且对中英文引句一视同仁。
const normalize = (text: string): string => text.replace(/\s+/g, "");

export function verifyCitations(
  evidence: Evidence[],
  snapshots: SourceSnapshot[],
): CitationVerdict[] {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  return evidence.map((e) => {
    const snapshot = byId.get(e.snapshotId);
    if (!snapshot) {
      return { evidenceId: e.id, verdict: "snapshot-missing" as const };
    }
    const quote = normalize(e.quote);
    const hit = quote.length > 0 && normalize(snapshot.bodyText).includes(quote);
    return { evidenceId: e.id, verdict: hit ? ("quote-hit" as const) : ("quote-mismatch" as const) };
  });
}
