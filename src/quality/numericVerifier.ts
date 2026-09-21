/**
 * 数值复算(受控数值计算第一刀):主张口径值与引句中的数字做一致性复算。
 * 主张携带 calibration { entity, period, unit, value };引句是原文逐字片段。
 * 把两边都换算到基准量纲后比对,容差 1%(容忍四舍五入表述)。
 * 不命中即"数值与引句不一致"——这是"模型心算出错"的确定性兜底。
 */
import type { Claim } from "../contracts.js";
import { normalizeUnit } from "./calibrationChecker.js";

export type NumericCheck = "ok" | "mismatch" | "na";

const UNIT_SCALE: [RegExp, number][] = [
  [/^万亿/, 1e12],
  [/^亿/, 1e8],
  [/^万/, 1e4],
  [/^千/, 1e3],
];

export function scaleOf(unit: string): number {
  const u = normalizeUnit(unit);
  for (const [re, scale] of UNIT_SCALE) if (re.test(u)) return scale;
  return 1;
}

interface ScaledNumber {
  raw: string;
  scaled: number;
}

/** 从文本抽取数字并按紧邻量纲换算:"1,200 亿元" → 1.2e11;"29.6%" → 29.6;"15至35美元" → [15, 35] */
export function extractScaledNumbers(text: string): ScaledNumber[] {
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(万亿|亿|万|千)?\s*(%|元人民币|人民币|美元|港元|欧元|元|家|个|人|门店|平方米|平米|mm|m2)?/g;
  const out: ScaledNumber[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const magnitude = m[2] === "万亿" ? 1e12 : m[2] === "亿" ? 1e8 : m[2] === "万" ? 1e4 : m[2] === "千" ? 1e3 : 1;
    out.push({ raw, scaled: value * magnitude });
  }
  return out;
}

export function checkNumericConsistency(claim: Claim, quote: string): NumericCheck {
  const cal = claim.calibration;
  if (!cal || typeof cal.value !== "number") return "na";
  const target = cal.value * scaleOf(cal.unit);
  const candidates = extractScaledNumbers(quote);
  if (candidates.length === 0) return "mismatch"; // 有口径值但引句无任何数字
  const ok = candidates.some((c) => {
    if (target === 0) return c.scaled === 0;
    return Math.abs(c.scaled - target) / Math.abs(target) <= 0.01;
  });
  return ok ? "ok" : "mismatch";
}
