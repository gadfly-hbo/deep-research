import { useEffect, useMemo, useState } from "react";

type Module = "brand" | "industry";

interface ProjectMeta {
  id: string;
  module: Module;
  goal: string;
  scope: { summary: string; queries: string[] };
  updatedAt: string;
  versions: { version: number; runId: string; publishedAt: string; diffSummary?: { addedClaims: string[]; removedClaims: string[]; evidenceDelta: number } }[];
}
interface Run {
  id: string;
  requestId: string;
  stage: string;
  status: "running" | "cancelled" | "failed" | "published" | "limited";
  usage: { searches: number; fetches: number; costEstimate: number; wallMs: number };
}
interface Snapshot { id: string; url: string; title: string; fetchedAt: string; parseStatus: string }
interface Claim { id: string; statement: string; kind: string; evidenceIds: string[]; calibration?: { entity: string; period: string; unit: string; value?: number } }
interface Bundle {
  runId: string; version: number; reportMd: string;
  claims: Claim[];
  evidence: { id: string; snapshotId: string; quote: string }[];
  snapshots: Snapshot[];
  limitations: string[]; unresolved: string[];
  verdicts: { evidenceId: string; verdict: string }[];
}
interface ProjectDetail { meta: ProjectMeta; runs: Run[]; snapshots: Snapshot[] }

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
};
const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  running: { label: "进行中", cls: "badge-amber" },
  cancelled: { label: "已取消", cls: "badge-neutral" },
  failed: { label: "已失败", cls: "badge-red" },
  published: { label: "已发布", cls: "badge-green" },
  limited: { label: "有限交付", cls: "badge-amber" },
};
const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  fact: { label: "事实", cls: "badge-teal" },
  inference: { label: "推断", cls: "badge-amber" },
  unverified: { label: "未验证", cls: "badge-red" },
};
const VERDICT_LABEL: Record<string, { label: string; cls: string }> = {
  "quote-hit": { label: "已核实", cls: "badge-green" },
  "quote-mismatch": { label: "未通过", cls: "badge-red" },
  "snapshot-missing": { label: "快照缺失", cls: "badge-amber" },
};

function Badge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const item = map[value] ?? { label: value, cls: "badge-neutral" };
  return <span className={`badge ${item.cls}`}>{item.label}</span>;
}

/** 报告正文的安全渲染:逐段构建 React 元素,不走 HTML 注入。 */
function ReportBody({ md }: { md: string }) {
  const blocks = useMemo(() => md.split("\n"), [md]);
  return (
    <div>
      {blocks.map((line, i) => {
        if (line.startsWith("## ")) return <h3 key={i}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h2 key={i} style={{ fontSize: 17 }}>{line.slice(2)}</h2>;
        if (line.startsWith("- ")) return <li key={i} style={{ marginLeft: 18 }}>{line.slice(2)}</li>;
        if (line.trim() === "") return <br key={i} />;
        return <p key={i} style={{ margin: "6px 0" }}>{line}</p>;
      })}
    </div>
  );
}

function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ module: "brand" as Module, goal: "", summary: "", queries: "", attachments: "" });
  const [error, setError] = useState("");

  const load = () => api<{ projects: ProjectMeta[] }>("/api/projects").then((r) => setProjects(r.projects));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError("");
    try {
      const { id } = await post<{ id: string }>("/api/projects", {
        module: form.module,
        goal: form.goal,
        scope: { summary: form.summary, queries: form.queries.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) },
      });
      setCreating(false);
      onOpen(id);
    } catch (e) { setError(String(e)); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">研究项目</h1>
          <p className="page-desc">创建并管理品牌/行业研究项目;下一步:新建项目或打开已有项目继续研究。</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(!creating)}>新建项目</button>
      </div>

      {creating && (
        <div className="card">
          <h3>新建研究项目</h3>
          <label>研究模块</label>
          <select value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value as Module })}>
            <option value="brand">品牌研究</option>
            <option value="industry">行业研究</option>
          </select>
          <label>研究目标</label>
          <input value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          <label>范围说明</label>
          <input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="对象、时间、单位等边界" />
          <label>附件(本机文件路径,文本/PDF,每行一个,可空)</label>
          <textarea rows={2} value={form.attachments} onChange={(e) => setForm({ ...form, attachments: e.target.value })} />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn-primary" disabled={!form.goal || !form.summary} onClick={() => void create()}>创建</button>
            <button onClick={() => setCreating(false)}>取消</button>
          </div>
          {error && <p className="badge badge-red" style={{ marginTop: 8 }}>{error}</p>}
        </div>
      )}

      {projects.map((p) => (
        <div className="card" key={p.id} style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <div>
              <span className="badge badge-brand">{p.module === "brand" ? "品牌研究" : "行业研究"}</span>{" "}
              <strong>{p.goal}</strong>
              <div className="meta">更新于 {new Date(p.updatedAt).toLocaleString("zh-CN")}</div>
            </div>
            <span className="badge badge-neutral">{p.versions.length} 个版本</span>
          </div>
        </div>
      ))}
      {projects.length === 0 && !creating && <p className="muted">还没有项目。点击「新建项目」开始第一项研究。</p>}
      <p className="footer-note">本工作台仅在本机运行(127.0.0.1),不连接 JuanerAI;所有研究结论须可追溯到证据。</p>
    </div>
  );
}

function ProjectView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [bundleVersion, setBundleVersion] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<{ claim: Claim; text: string } | null>(null);
  const [runForm, setRunForm] = useState<{ open: boolean; goal: string; summary: string; queries: string; attachments: string }>({ open: false, goal: "", summary: "", queries: "", attachments: "" });
  const [plan, setPlan] = useState<{ id: string; question: string }[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    const d = await api<ProjectDetail>(`/api/projects/${id}`);
    setDetail(d);
    const latest = d.meta.versions[d.meta.versions.length - 1];
    if (latest && bundleVersion === null) {
      setBundleVersion(latest.version);
      setBundle(await api<Bundle>(`/api/projects/${id}/versions/${latest.version}/bundle`));
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!detail) return <p className="muted">加载中…</p>;
  const { meta, runs } = detail;
  const publishedRunIds = new Set(meta.versions.map((v) => v.runId));
  const template = { goal: meta.goal, summary: meta.scope.summary, queries: meta.scope.queries.join("\n") };

  const previewPlan = async () => {
    setBusy("生成计划中…"); setError("");
    try {
      const r = await post<{ plan: { questions: { id: string; question: string }[] } }>(`/api/projects/${id}/plan-preview`, {
        module: meta.module,
        goal: runForm.goal,
        scope: { summary: runForm.summary, queries: runForm.queries.split("\n").filter(Boolean) },
      });
      setPlan(r.plan.questions);
    } catch (e) { setError(String(e)); } finally { setBusy(""); }
  };

  const startRun = async () => {
    if (!plan) return;
    setBusy("启动中…"); setError("");
    try {
      await post(`/api/projects/${id}/runs`, {
        request: {
          id: `req-${Date.now().toString(36)}`,
          module: meta.module,
          goal: runForm.goal,
          scope: { summary: runForm.summary, queries: plan.map((q) => q.question) },
          attachments: runForm.attachments.split("\n").map((s) => s.trim()).filter(Boolean),
        },
        plan: { questions: plan.map((q) => ({ ...q, status: "open" })) },
      });
      setPlan(null);
      setRunForm({ ...runForm, open: false });
      await load();
    } catch (e) { setError(String(e)); } finally { setBusy(""); }
  };

  const act = async (path: string, body: unknown) => {
    setError("");
    try { await post(path, body); await load(); } catch (e) { setError(String(e)); }
  };

  const viewVersion = async (v: number) => {
    setBundleVersion(v);
    setBundle(await api<Bundle>(`/api/projects/${id}/versions/${v}/bundle`));
  };

  const openDrawer = async (claim: Claim) => {
    const ev = bundle?.evidence.find((e) => e.id === claim.evidenceIds[0]);
    if (!ev || !bundle) return;
    const snap = bundle.snapshots.find((s) => s.id === ev.snapshotId);
    let text = "";
    if (snap) {
      const res = await fetch(`/api/projects/${id}/snapshots?sid=${encodeURIComponent(snap.id)}`);
      text = res.ok ? await res.text() : "(快照不可用)";
    }
    setDrawer({ claim, text });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{meta.goal}</h1>
          <p className="page-desc">{meta.module === "brand" ? "品牌研究" : "行业研究"} · {meta.scope.summary};下一步:发起运行、查看证据或导出版本。</p>
        </div>
        <div className="btn-row">
          <button onClick={onBack}>返回列表</button>
          <button className="btn-primary" onClick={() => setRunForm({ open: true, ...template, attachments: "" })}>新建研究运行</button>
        </div>
      </div>

      {error && <div className="notice amber">{error}</div>}

      {runForm.open && (
        <div className="card">
          <h3>新建研究运行</h3>
          <label>研究目标</label>
          <input value={runForm.goal} onChange={(e) => setRunForm({ ...runForm, goal: e.target.value })} />
          <label>范围说明</label>
          <input value={runForm.summary} onChange={(e) => setRunForm({ ...runForm, summary: e.target.value })} />
          <label>附件(本机文件路径,每行一个,可空)</label>
          <textarea rows={2} value={runForm.attachments} onChange={(e) => setRunForm({ ...runForm, attachments: e.target.value })} />
          {!plan ? (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" disabled={!runForm.goal || busy !== ""} onClick={() => void previewPlan()}>{busy || "生成研究计划"}</button>
              <button onClick={() => setRunForm({ ...runForm, open: false })}>取消</button>
            </div>
          ) : (
            <div>
              <label>研究计划(可编辑问题清单,确认后开始执行)</label>
              {plan.map((q, i) => (
                <input key={q.id} style={{ marginBottom: 6 }} value={q.question}
                  onChange={(e) => setPlan(plan.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
              ))}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn-primary" disabled={busy !== ""} onClick={() => void startRun()}>{busy || "确认计划并开始研究"}</button>
                <button onClick={() => setPlan(null)}>重新生成</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="card">
            <h3>运行记录</h3>
            {runs.length === 0 && <p className="muted">还没有运行。</p>}
            {runs.map((r) => (
              <div className="sub" key={r.id}>
                <div className="btn-row" style={{ justifyContent: "space-between" }}>
                  <span><Badge map={STATUS_LABEL} value={r.status} /> <span className="meta mono">{r.requestId}</span></span>
                  <span className="meta mono">搜索 {r.usage.searches} · 抓取 {r.usage.fetches} · 成本≈{r.usage.costEstimate.toFixed(3)} · {(r.usage.wallMs / 1000).toFixed(0)}s</span>
                </div>
                <div className="btn-row" style={{ marginTop: 8 }}>
                  {r.status === "running" && (
                    <button className="btn-danger" onClick={() => void act(`/api/projects/${id}/runs/cancel`, { requestId: r.requestId })}>取消(保留已完成阶段)</button>
                  )}
                  {r.status === "cancelled" && (
                    <button onClick={() => void act(`/api/projects/${id}/runs/resume`, { requestId: r.requestId })}>自检查点恢复</button>
                  )}
                  {(r.status === "published" || r.status === "limited") && !publishedRunIds.has(r.id) && (
                    <button onClick={() => void act(`/api/projects/${id}/publish`, { runId: r.id })}>发布为版本</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>版本</h3>
            {meta.versions.length === 0 && <p className="muted">尚未发布版本。</p>}
            {meta.versions.map((v) => (
              <div className="sub" key={v.version}>
                <div className="btn-row" style={{ justifyContent: "space-between" }}>
                  <strong>v{v.version}</strong>
                  <span className="btn-row">
                    <button onClick={() => void viewVersion(v.version)}>查看</button>
                    <a className="btn" href={`/api/projects/${id}/versions/${v.version}/export`} download>导出成果包(zip)</a>
                  </span>
                </div>
                {v.diffSummary && (
                  <p className="meta">较上版:新增主张 {v.diffSummary.addedClaims.length} · 删除 {v.diffSummary.removedClaims.length} · 证据 {v.diffSummary.evidenceDelta >= 0 ? "+" : ""}{v.diffSummary.evidenceDelta}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>报告{bundleVersion ? ` v${bundleVersion}` : ""}</h3>
          {!bundle && <p className="muted">发布版本后可在此阅读报告。</p>}
          {bundle && (
            <>
              {bundle.limitations.length > 0 && (
                <div className="notice amber">有限交付:{bundle.limitations.join(";")}</div>
              )}
              <ReportBody md={bundle.reportMd} />
              <h3>主张与证据</h3>
              <table>
                <thead><tr><th>主张</th><th>类型</th><th>核查</th></tr></thead>
                <tbody>
                  {bundle.claims.map((c) => (
                    <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => void openDrawer(c)}>
                      <td>{c.statement}{c.calibration && <div className="meta">{c.calibration.entity} · {c.calibration.period} · {c.calibration.unit}</div>}</td>
                      <td><Badge map={KIND_LABEL} value={c.kind} /></td>
                      <td><Badge map={VERDICT_LABEL} value={bundle.verdicts.find((v) => v.evidenceId === c.evidenceIds[0])?.verdict ?? "snapshot-missing"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {drawer && (
        <div className="card" style={{ position: "fixed", right: 24, bottom: 24, width: 420, maxHeight: "70vh", overflow: "auto", boxShadow: "0 10px 28px rgba(23,32,42,.12)" }}>
          <h3>证据抽屉</h3>
          <p><Badge map={KIND_LABEL} value={drawer.claim.kind} /> {drawer.claim.statement}</p>
          <p className="meta">快照原文(净化纯文本,来源内容不执行):</p>
          <pre className="plain">{drawer.text}</pre>
          <div className="btn-row"><button onClick={() => setDrawer(null)}>关闭</button></div>
        </div>
      )}
      <p className="footer-note">执行完成 ≠ 证据充分:有限交付会披露限制,不会编造完整答案。</p>
    </div>
  );
}

function SettingsView() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [budget, setBudget] = useState<Record<string, number>>({});
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<{ config: Record<string, unknown>; budgetDefaults: Record<string, number> }>("/api/settings").then((r) => {
      setConfig(r.config);
      setBudget(r.budgetDefaults);
      const model = r.config.model as { provider?: string; modelId?: string } | undefined;
      setProvider(model?.provider ?? "");
      setModelId(model?.modelId ?? "");
    });
  }, []);
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-desc">配置模型与搜索供应商;密钥只走环境变量(如 MINIMAX_API_KEY),不经过本页面。</p>
        </div>
      </div>
      <div className="card">
        <h3>模型供应商</h3>
        <label>provider(pi-ai 内置名,如 minimax-cn / moonshotai / zai)</label>
        <input value={provider} onChange={(e) => setProvider(e.target.value)} />
        <label>modelId(如 MiniMax-M2.7)</label>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} />
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => {
            void post("/api/settings", { ...config, model: { provider, modelId } }).then(() => setSaved(true));
          }}>保存</button>
          {saved && <span className="badge badge-green">已保存</span>}
        </div>
      </div>
      <div className="card">
        <h3>默认预算上限</h3>
        <table>
          <tbody>
            {Object.entries(budget).map(([k, v]) => (
              <tr key={k}><td className="muted">{k}</td><td className="mono">{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footer-note">密钥不进入项目文件、日志与报告;配置文件仅存于本机数据目录(0600 权限)。</p>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<string>(location.hash || "#/projects");
  useEffect(() => {
    const onHash = () => setRoute(location.hash || "#/projects");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const projectMatch = route.match(/^#\/project\/(.+)$/);
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">独立深度研究工作台</div>
        <a className={`nav-item ${route.startsWith("#/project") ? "active" : ""}`} href="#/projects">研究项目</a>
        <a className={`nav-item ${route === "#/settings" ? "active" : ""}`} href="#/settings">设置</a>
      </nav>
      <main className="main">
        {projectMatch ? (
          <ProjectView id={projectMatch[1]} onBack={() => (location.hash = "#/projects")} />
        ) : route === "#/settings" ? (
          <SettingsView />
        ) : (
          <ProjectsView onOpen={(id) => (location.hash = `#/project/${id}`)} />
        )}
      </main>
    </div>
  );
}
