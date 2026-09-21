/** Prism 状态徽标:圆点 + 文字(状态绝不只用颜色表达) */

import type { ReactNode } from "react";

export type BadgeTone = "good" | "warn" | "bad" | "info" | "violet" | "brand" | "neutral";

export default function Badge({
  tone = "neutral",
  children,
  noDot = false,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  noDot?: boolean;
}) {
  return <span className={`pill ${tone}${noDot ? " no-dot" : ""}`}>{children}</span>;
}
