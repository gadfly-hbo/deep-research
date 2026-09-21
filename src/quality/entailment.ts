/**
 * 语义蕴涵检查(确定性版):主张的转述是否被引句支撑。
 * 引文核查只证明"引句存在于原文";本检查进一步问"主张说的话和引句是不是一回事"。
 * 两道确定性信号:数字必须对齐(主张中的数字须原样出现在引句中)+ 文本二元组重合度。
 * 不做语义模型判断——fail 即降级,weak 标弱核查留痕。
 */

export type Entailment = "strong" | "weak" | "fail" | "na";

const norm = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/** 提取数字 token(去千分位逗号):如 "1,200" → "1200"、"29.6%" → "29.6%" */
export function numericTokens(text: string): string[] {
  const tokens = text.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  return tokens.map((t) => t.replace(/,/g, ""));
}

/** 年份(如 2025 / 2025年)是期间口径,由口径检查负责;短引句常省略年份,不纳入蕴涵硬判定。 */
export const isYear = (token: string): boolean => /^(19|20)\d{2}年?$/.test(token);

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, "");
  const set = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i++) set.add(clean.slice(i, i + 2));
  return set;
}

export function checkEntailment(statement: string, quote: string): Entailment {
  const s = norm(statement);
  const q = norm(quote);
  if (!s || !q) return "na";

  // 硬信号:主张中的数字须能在引句中找到(两边都去千分位逗号;年份豁免,理由见上)
  const qNum = q.replace(/,/g, "");
  for (const token of numericTokens(statement)) {
    if (isYear(token)) continue;
    if (!qNum.includes(token)) return "fail";
  }

  const bs = bigrams(statement);
  if (bs.size === 0) return "na";
  const qs = bigrams(quote);
  let hit = 0;
  for (const b of bs) if (qs.has(b)) hit += 1;
  const ratio = hit / bs.size;
  if (ratio >= 0.6) return "strong";
  if (ratio >= 0.35) return "weak";
  return "fail";
}
