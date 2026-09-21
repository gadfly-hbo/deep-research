/** 面板区块:分区标题(15px/600)+ 说明 + 右侧附加内容 */

import type { CSSProperties, ReactNode } from "react";

export default function Section({
  title,
  desc,
  extra,
  children,
  style,
}: {
  title?: string;
  desc?: string;
  extra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const hasHead = title || desc || extra;
  return (
    <section className="panel" style={style}>
      {hasHead && (
        <header className="sec-head">
          <div>
            {title && <h2>{title}</h2>}
            {desc && <p className="sec-desc">{desc}</p>}
          </div>
          {extra}
        </header>
      )}
      {children}
    </section>
  );
}
