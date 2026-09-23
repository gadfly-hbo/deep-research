/* 阶段 2 · 采证:运行进度(进行中)或运行记录(空闲);证据快照流;复用资料与使用记录。 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Chip from "../components/Chip";
import Empty from "../components/Empty";
import { api } from "../state/api";
import { useProject } from "../state/projectDetail";
import { snapshotTitle } from "../state/derive";
import { STATUS, STATUS_DOT, TIER_BADGE, stageTitle } from "../state/types";
import type { Run } from "../state/types";

interface ReuseRow {
  bindings: Array<{ bindingId: string; sourceId: string; versionId: string; purpose: string; applicability: string; checkNotes: string[] }>;
  usages: Array<{ usageId: string; step: string; contentVersionId: string }>;
}

export function GatherView() {
  const p = useProject();
  const navigate = useNavigate();
  const focusRunId = p.activeRun?.id ?? p.detail?.runs[p.detail.runs.length - 1]?.id ?? null;
  const [reuse, setReuse] = useState<ReuseRow | null>(null);

  useEffect(() => {
    if (!focusRunId) return;
    void api<ReuseRow>(`/api/library/bindings?runId=${encodeURIComponent(focusRunId)}`)
      .then(setReuse)
      .catch(() => setReuse(null));
  }, [focusRunId]);

  if (!p.detail) {
    return (
      <div className="view">
        <span className="spinner" role="status" aria-label="加载中" />
      </div>
    );
  }

  const { runs, snapshots } = p.detail;
  const publishedRunIds = new Set(p.detail.meta.versions.map((v) => v.runId));
  const run = p.activeRun;

  const runActions = (r: Run) => (
    <div className="actions">
      {r.status === "cancelled" && (
        <button className="btn btn-sm" type="button" onClick={() => void p.resumeRun(r)}>自检查点恢复</button>
      )}
      {(r.status === "published" || r.status === "limited") && !publishedRunIds.has(r.id) && (
        <button className="btn btn-primary btn-sm" type="button" onClick={() => void p.publishRun(r)}>发布为版本</button>
      )}
    </div>
  );

  const usageLine = (r: Run) =>
    `搜索 ${r.usage.searches} · 抓取 ${r.usage.fetches} · 成本≈${r.usage.costEstimate.toFixed(3)} · ${Math.round(r.usage.wallMs / 1000)}s`;

  return (
    <div className="view">
      <h1 className="view-h">
        采证
        {run && <Chip tone="run">进行中 · {stageTitle(run.stage)}</Chip>}
      </h1>
      <p className="view-sub">
        检索与抓取由流水线在本机服务内执行;每个来源页面留存净化文本快照,供逐条核查。
      </p>

      {run ? (
        <div className="card">
          <div className="pstep running">
            <div className="pstep-head">
              <span className="pstep-name">研究运行进行中</span>
              <Chip tone="run">阶段 · {stageTitle(run.stage)}</Chip>
            </div>
            <div className="bar" aria-hidden="true"><span className="bar-fill" /></div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <div><dt>搜索</dt><dd className="num">{run.usage.searches}</dd></div>
              <div><dt>抓取</dt><dd className="num">{run.usage.fetches}</dd></div>
              <div><dt>成本估算</dt><dd className="num">≈{run.usage.costEstimate.toFixed(3)}</dd></div>
              <div><dt>已用时</dt><dd className="num">{Math.round(run.usage.wallMs / 1000)}s</dd></div>
            </dl>
            <p className="fine mono">requestId {run.requestId} · 自动刷新(2.5s)</p>
            <div className="actions">
              <button className="btn btn-danger" type="button" onClick={() => void p.cancelRun(run)}>
                取消(保留已完成阶段)
              </button>
              <span className="fine" style={{ margin: 0 }}>取消后可在运行记录中自检查点恢复</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2 className="card-h">
            运行记录
            <span className="card-h-note">取消的运行可自检查点恢复;完成的运行可发布为不可变版本</span>
          </h2>
          {runs.length === 0 ? (
            <Empty icon="◇" title="还没有运行" hint="从「计划」阶段发起第一次研究运行">
              <button className="btn btn-primary" type="button" onClick={() => navigate(`/project/${p.id}/plan?new=1`)}>
                ＋ 新建研究运行
              </button>
            </Empty>
          ) : (
            <ul className="filelist" style={{ marginBottom: 0 }}>
              {runs.slice().reverse().map((r) => (
                <li className="file" key={r.id}>
                  <span className={`dot ${STATUS_DOT[r.status] ?? "dot-idle"}`} aria-hidden="true" />
                  <span className="file-name mono">{r.requestId}</span>
                  <Chip tone={STATUS[r.status]?.tone ?? "wait"}>{STATUS[r.status]?.label ?? r.status}</Chip>
                  <span className="file-meta num">{usageLine(r)}</span>
                  {runActions(r)}
                  {r.error && <span className="file-sub" style={{ color: "var(--fail)" }}>{r.error.slice(0, 160)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {reuse && reuse.bindings.length > 0 && (
        <div className="card">
          <h2 className="card-h">
            本运行复用的情报
            <span className="card-h-note num">{reuse.bindings.length} 项 · 使用 {reuse.usages.length} 次</span>
          </h2>
          <ul className="filelist">
            {reuse.bindings.map((b) => (
              <li className="file clickable" key={b.bindingId} onClick={() => navigate(`/library/${b.sourceId}`)}>
                <span className="file-name">{b.purpose}</span>
                <span className="file-meta mono">{b.versionId}</span>
                <span className={`chip ${b.applicability === "ELIGIBLE" ? "chip-ok" : b.applicability === "LEAD_ONLY" ? "chip-fork" : "chip-wait"}`}>
                  {b.applicability === "ELIGIBLE" ? "证据候选" : b.applicability === "LEAD_ONLY" ? "仅作线索" : "需复核"}
                </span>
                {b.checkNotes.length > 0 && <div className="fine" style={{ marginTop: 2 }}>{b.checkNotes.join(" · ")}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2 className="card-h">
          证据快照流
          <span className="card-h-note num">{snapshots.length} 个 · 解析成功 {snapshots.filter((s) => s.parseStatus === "ok").length} 个</span>
        </h2>
        {snapshots.length === 0 ? (
          <Empty icon="▦" title="尚无快照" hint={run ? "运行进行中,抓取到的来源会实时出现在这里" : "运行发起后,每个抓取来源都会留存净化文本快照"} />
        ) : (
          <ul className="filelist" style={{ marginBottom: 0 }}>
            {snapshots.slice(-12).reverse().map((s) => (
              <li className="file" key={s.id}>
                <span className="file-icon" aria-hidden="true">▦</span>
                <span className="file-name">{snapshotTitle(s)}</span>
                {s.tier && <Chip tone={TIER_BADGE[s.tier]?.tone ?? "wait"}>{TIER_BADGE[s.tier]?.label ?? s.tier}</Chip>}
                <Chip tone={s.parseStatus === "ok" ? "ok" : "insuf"}>{s.parseStatus === "ok" ? "解析成功" : s.parseStatus}</Chip>
                <span className="file-sub mono">{s.url}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
