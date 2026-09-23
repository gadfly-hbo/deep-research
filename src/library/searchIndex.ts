/**
 * 可重建关键词索引(§10.1/G4):中文 bigram + 英文整词 + 数字口径。
 * 纯函数核:buildInvertedIndex / searchIndex 无 IO,便于冻结夹具测召回。
 */

export interface IndexDoc {
  docId: string;
  text: string;
}

export interface TermOccurrence {
  term: string;
  offset: number;
}

export interface InvertedIndex {
  /** term -> docId -> 命中位置(字符偏移) */
  postings: Record<string, Record<string, number[]>>;
  docCount: number;
}

export interface SearchHitDoc {
  docId: string;
  matchedTerms: string[];
  positions: number[];
}

const CJK = /[㐀-鿿]/;

/** 带偏移的词元切分:中文 bigram、英文整词(小写)、数字(去千分位) */
export function tokenizeWithOffsets(text: string): TermOccurrence[] {
  const out: TermOccurrence[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (CJK.test(ch)) {
      // CJK 连续段:逐字符出 bigram(单字段也出 unigram 兜底)
      let j = i;
      while (j < text.length && CJK.test(text[j])) j++;
      const run = text.slice(i, j);
      if (run.length === 1) {
        out.push({ term: run, offset: i });
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          out.push({ term: run.slice(k, k + 2), offset: i + k });
        }
      }
      i = j;
      continue;
    }
    const wordMatch = /^[A-Za-z]+/.exec(text.slice(i));
    if (wordMatch) {
      out.push({ term: wordMatch[0].toLowerCase(), offset: i });
      i += wordMatch[0].length;
      continue;
    }
    const numMatch = /^\d[\d,]*/.exec(text.slice(i));
    if (numMatch) {
      out.push({ term: numMatch[0].replace(/,/g, ""), offset: i });
      i += numMatch[0].length;
      continue;
    }
    i += 1;
  }
  return out;
}

export function tokenize(text: string): string[] {
  return tokenizeWithOffsets(text).map((t) => t.term);
}

export function buildInvertedIndex(docs: IndexDoc[]): InvertedIndex {
  const postings: Record<string, Record<string, number[]>> = {};
  for (const doc of docs) {
    for (const occ of tokenizeWithOffsets(doc.text)) {
      const perDoc = (postings[occ.term] ??= {});
      const positions = (perDoc[doc.docId] ??= []);
      if (positions[positions.length - 1] !== occ.offset) positions.push(occ.offset);
    }
  }
  return { postings, docCount: docs.length };
}

/** 检索:命中词元越多越靠前;返回位置供片段预览截断说明 */
export function searchIndex(index: InvertedIndex, query: string): SearchHitDoc[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const byDoc = new Map<string, SearchHitDoc>();
  for (const term of terms) {
    const perDoc = index.postings[term];
    if (!perDoc) continue;
    for (const [docId, positions] of Object.entries(perDoc)) {
      const hit = byDoc.get(docId) ?? { docId, matchedTerms: [], positions: [] };
      hit.matchedTerms.push(term);
      hit.positions.push(...positions);
      byDoc.set(docId, hit);
    }
  }
  return [...byDoc.values()]
    .map((hit) => ({ ...hit, positions: [...new Set(hit.positions)].sort((a, b) => a - b) }))
    .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.positions.length - a.positions.length);
}

/** 片段预览:以首个命中位置为中心截取,保留截断标记(§10.2) */
export function makeSnippet(text: string, position: number, radius = 60): string {
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}
