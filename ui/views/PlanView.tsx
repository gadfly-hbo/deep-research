/* 阶段 1 · 计划:研究语境 + 新建运行三步向导(计划确认 → 框架确认 → 开始研究)。 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Chip from "../components/Chip";
import Empty from "../components/Empty";
import { useProject } from "../state/projectDetail";
import { errMsg, post } from "../state/api";
import { useToast } from "../state/toast";
import { MODULE_LABEL, stageTitle } from "../state/types";
import type { Outline } from "../state/types";

interface PlanQuestion { id: string; question: string }

export function PlanView() {
  const p = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [wizard, setWizard] = useState(false);
  const [form, setForm] = useState({ goal: "", summary: "", attachments: "" });
  const [plan, setPlan] = useState<PlanQuestion[] | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [busy, setBusy] = useState("");

  const meta = p.detail?.meta;

  const openWizard = () => {
    if (!meta) return;
    setPlan(null);
    setOutline(null);
    setForm({ goal: meta.goal, summary: meta.scope.summary, attachments: "" });
    setWizard(true);
  };

  // ?new=1(侧栏/命令面板入口)在详情就绪后自动打开向导
  useEffect(() => {
    if (params.get("new") === "1" && meta) {
      params.delete("new");
      setParams(params, { replace: true });
      openWizard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, meta]);

  if (!p.detail || !meta) {
    return (
      <div className="view">
        <span className="spinner" role="status" aria-label="加载中" />
      </div>
    );
  }

  const previewPlan = async () => {
    setBusy("生成计划中…通常 1-2 分钟");
    try {
      const r = await post<{ plan: { questions: PlanQuestion[] } }>(`/api/projects/${p.id}/plan-preview`, {
        module: meta.module,
        goal: form.goal,
        scope: { summary: form.summary, queries: [] },
      });
      setPlan(r.plan.questions);
      setOutline(null);
    } catch (e) {
      toast.show(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const previewOutline = async () => {
    if (!plan) return;
    setBusy("生成报告框架中…通常 1-2 分钟");
    try {
      const r = await post<{ outline: Outline }>(`/api/projects/${p.id}/outline-preview`, {
        module: meta.module,
        goal: form.goal,
        scope: { summary: form.summary, queries: plan.map((q) => q.question) },
        questions: plan.map((q) => ({ id: q.id, question: q.question })),
      });
      setOutline(r.outline);
    } catch (e) {
      toast.show(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const start = async () => {
    if (!plan || !outline) return;
    setBusy("启动中…");
    const ok = await p.startRun({
      goal: form.goal,
      summary: form.summary,
      attachments: form.attachments,
      plan,
      outline,
    });
    setBusy("");
    if (ok) {
      setWizard(false);
      setPlan(null);
      setOutline(null);
      navigate(`/project/${p.id}/gather`);
    }
  };

  return (
    <div className="view">
      <h1 className="view-h">
        计划
        <Chip tone={meta.module === "brand" ? "agg" : "fork"}>{MODULE_LABEL[meta.module]}</Chip>
      </h1>
      <p className="view-sub">{meta.goal} — 研究计划与报告框架都经你确认后才会执行。</p>

      {p.activeRun && (
        <div className="trust-banner" role="note">
          <strong>研究运行进行中</strong>(阶段:{stageTitle(p.activeRun.stage)})。完成或取消后可再发起新运行。
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate(`/project/${p.id}/gather`)}>
            查看进度
          </button>
        </div>
      )}

      {!wizard ? (
        <>
          <div className="card">
            <h2 className="card-h">研究语境</h2>
            <dl className="kv">
              <div><dt>研究目标</dt><dd>{meta.goal}</dd></div>
              <div><dt>研究模块</dt><dd>{MODULE_LABEL[meta.module]}</dd></div>
              <div><dt>范围说明</dt><dd>{meta.scope.summary}</dd></div>
              <div><dt>研究问题</dt><dd className="num">{meta.scope.queries.length} 个(最近一次运行确认)</dd></div>
            </dl>
            <div className="actions">
              <button className="btn btn-primary" type="button" disabled={p.activeRun !== null} onClick={openWizard}>
                ＋ 新建研究运行
              </button>
              <span className="fine" style={{ margin: 0 }}>
                三步:研究计划(可编辑)→ 报告框架(可编辑、确认后执行)→ 开始研究
              </span>
            </div>
          </div>

          <div className="card">
            <h2 className="card-h">
              已确认的研究问题
              <span className="card-h-note">发起运行时逐条确认过;调整请发起新运行</span>
            </h2>
            {meta.scope.queries.length === 0 ? (
              <Empty icon="◇" title="尚无已确认的研究问题" hint="点击「新建研究运行」,先生成计划再逐条编辑确认" />
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {meta.scope.queries.map((q, i) => (
                  <li key={i} style={{ margin: "4px 0" }}>{q}</li>
                ))}
              </ol>
            )}
          </div>
        </>
      ) : (
        <div className="card">
          <h2 className="card-h">
            新建研究运行
            {!plan ? <span className="step-tag">第一步 · 研究目标</span> : !outline ? <span className="step-tag">第二步 · 确认研究计划</span> : <span className="step-tag">第三步 · 确认报告框架</span>}
          </h2>

          {!plan && (
            <>
              <label className="fld">
                <span className="fld-label">研究目标</span>
                <input value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder="研究目标" />
              </label>
              <label className="fld">
                <span className="fld-label">范围说明</span>
                <input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="对象、时间、单位等边界" />
              </label>
              <label className="fld">
                <span className="fld-label">附件(本机文件路径,文本 / PDF,每行一个,可空)</span>
                <textarea rows={3} value={form.attachments} onChange={(e) => setForm({ ...form, attachments: e.target.value })} />
              </label>
              <div className="actions">
                <button className="btn btn-primary" type="button" disabled={!form.goal || busy !== ""} onClick={() => void previewPlan()}>
                  {busy || "生成研究计划"}
                </button>
                <button className="btn btn-ghost" type="button" disabled={busy !== ""} onClick={() => setWizard(false)}>取消</button>
              </div>
            </>
          )}

          {plan && !outline && (
            <>
              <p className="fine">可编辑问题清单;确认后才生成报告框架。请保持本页打开以跟踪进度。</p>
              {plan.map((q, i) => (
                <label className="fld plan-item" key={q.id}>
                  <span className="fld-label">问题 {i + 1}</span>
                  <input
                    value={q.question}
                    onChange={(e) => setPlan(plan.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))}
                  />
                </label>
              ))}
              <div className="actions">
                <button className="btn btn-primary" type="button" disabled={busy !== ""} onClick={() => void previewOutline()}>
                  {busy || "下一步:生成报告框架"}
                </button>
                <button className="btn" type="button" disabled={busy !== ""} onClick={() => void previewPlan()}>
                  {busy ? busy : "重新生成计划"}
                </button>
                <button className="btn btn-ghost" type="button" disabled={busy !== ""} onClick={() => setPlan(null)}>返回上一步</button>
              </div>
            </>
          )}

          {plan && outline && (
            <>
              <p className="fine">此框架决定草稿与正式报告的章节结构;确认后开始执行,不可中途更改。</p>
              <label className="fld">
                <span className="fld-label">报告标题</span>
                <input value={outline.title} onChange={(e) => setOutline({ ...outline, title: e.target.value })} placeholder="报告标题" />
              </label>
              <label className="fld">
                <span className="fld-label">副标题(可空)</span>
                <input
                  value={outline.subtitle ?? ""}
                  onChange={(e) => setOutline({ ...outline, subtitle: e.target.value })}
                  placeholder="副标题"
                />
              </label>
              {outline.sections.map((s, i) => (
                <div className="outline-card" key={s.id}>
                  <div className="fld-row">
                    <label className="fld">
                      <span className="fld-label">章节 {i + 1} 标题</span>
                      <input
                        value={s.title}
                        placeholder="章节标题"
                        onChange={(e) => setOutline({ ...outline, sections: outline.sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                      />
                    </label>
                    <div className="actions" style={{ marginTop: 0, alignSelf: "flex-end" }}>
                      <button
                        className="btn btn-danger btn-sm"
                        type="button"
                        disabled={outline.sections.length <= 1}
                        onClick={() => setOutline({ ...outline, sections: outline.sections.filter((_, j) => j !== i) })}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <label className="fld">
                    <span className="fld-label">本节目的(可空)</span>
                    <input
                      value={s.purpose ?? ""}
                      placeholder="本节目的"
                      onChange={(e) => setOutline({ ...outline, sections: outline.sections.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)) })}
                    />
                  </label>
                  <label className="fld">
                    <span className="fld-label">内容要点(每行一条)</span>
                    <textarea
                      rows={3}
                      value={s.bullets.join("\n")}
                      placeholder="内容要点,每行一条"
                      onChange={(e) => setOutline({
                        ...outline,
                        sections: outline.sections.map((x, j) => (j === i
                          ? { ...x, bullets: e.target.value.split("\n").map((t) => t.trim()).filter(Boolean) }
                          : x)),
                      })}
                    />
                  </label>
                </div>
              ))}
              <button
                className="btn btn-sm"
                type="button"
                style={{ marginTop: 10 }}
                onClick={() => setOutline({ ...outline, sections: [...outline.sections, { id: `s${outline.sections.length + 1}`, title: "", bullets: [] }] })}
              >
                ＋ 添加章节
              </button>
              <div className="actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!outline.title || outline.sections.some((s) => !s.title) || busy !== ""}
                  onClick={() => void start()}
                >
                  {busy || "确认框架并开始研究"}
                </button>
                <button className="btn" type="button" disabled={busy !== ""} onClick={() => void previewOutline()}>
                  {busy ? busy : "重新生成框架"}
                </button>
                <button className="btn btn-ghost" type="button" disabled={busy !== ""} onClick={() => setOutline(null)}>返回计划</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
