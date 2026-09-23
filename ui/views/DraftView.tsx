/* 阶段 4 · 草稿:报告草稿纸张式阅读(内容以此为准;定稿版式在「发布」阶段生成)。 */
import { useNavigate } from "react-router-dom";
import Chip from "../components/Chip";
import Empty from "../components/Empty";
import LimitsCard from "../components/LimitsCard";
import ReportBody from "../components/ReportBody";
import { useProject } from "../state/projectDetail";

export function DraftView() {
  const p = useProject();
  const navigate = useNavigate();
  const bundle = p.bundle;

  return (
    <div className="view">
      <div className="report-toolbar no-print">
        <h1 className="view-h" style={{ margin: 0 }}>
          报告
          {bundle && <Chip tone="insuf">草稿 v{p.bundleVersion}</Chip>}
        </h1>
        <div className="actions">
          <button className="btn btn-ghost btn-sm" type="button" disabled={!bundle} onClick={() => window.print()}>
            打印
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate(`/project/${p.id}/publish`)}>
            生成正式报告 →
          </button>
        </div>
      </div>

      {!bundle ? (
        <Empty
          icon="▤"
          title="尚无报告草稿"
          hint={p.activeRun ? "运行完成并发布为版本后,草稿会出现在这里" : "发布版本后可在此阅读报告草稿"}
        >
          {!p.activeRun && (
            <button className="btn" type="button" onClick={() => navigate(`/project/${p.id}/publish`)}>前往「发布」阶段</button>
          )}
        </Empty>
      ) : (
        <>
          <LimitsCard limitations={bundle.limitations} />
          <article className="report" id="report-doc">
            <header className="report-head">
              <p className="report-brand">独立深度研究工作台 · 品牌 × 行业</p>
              <h2>
                {p.detail?.meta.goal} <small>草稿 v{p.bundleVersion} · 内容以此为准</small>
              </h2>
              <p className="fine">
                定稿版式(HTML / PDF / PPTX)在「发布」阶段生成;正文中每条关键结论可在「评审」阶段回链原文快照。
              </p>
            </header>
            <ReportBody md={bundle.reportMd} />
          </article>
        </>
      )}
    </div>
  );
}
