import { describe, expect, it } from "vitest";
import { markdownToHtml, splitMdSections } from "./markdown.js";

describe("markdown(共享渲染器)", () => {
  it("渲染标题/列表/粗体/行内代码", () => {
    const html = markdownToHtml("# 标题\n\n## 分节\n\n- **重点** 项\n- `code` 项\n\n普通段落");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<h2>分节</h2>");
    expect(html).toContain("<li><strong>重点</strong> 项</li>");
    expect(html).toContain("<li><code>code</code> 项</li>");
    expect(html).toContain("<p>普通段落</p>");
  });

  it("管道表格渲染为 table,带表头", () => {
    const html = markdownToHtml("| 渠道 | 状态 |\n|---|---|\n| 线上 | 增长 |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<th>渠道</th>");
    expect(html).toContain("<td>增长</td>");
    expect(html).not.toContain("|---|");
  });

  it("有序列表与引用块与分隔线", () => {
    const html = markdownToHtml("1. 第一条\n2. 第二条\n\n> 引用说明\n\n---\n\n尾段");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote><p>引用说明</p></blockquote>");
    expect(html).toContain("<hr/>");
  });

  it("来源内容不可信:script 标签全量转义", () => {
    const html = markdownToHtml("# 报告\n\n正文 <script>alert(1)</script> 与 **<img onerror=x>**");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
  });

  it("splitMdSections 按标题切节,保留正文", () => {
    const sections = splitMdSections("# 报告\n\n## 品牌档案\n- 历史 29 年\n\n## 渠道\n- 线上为主\n");
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("报告");
    expect(sections[1].heading).toBe("品牌档案");
    expect(sections[1].html).toContain("历史 29 年");
    expect(sections[2].heading).toBe("渠道");
  });
});
