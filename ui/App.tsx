import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HashRouter, NavLink, Outlet, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Drawer, Empty, Input, Select, Spin, Steps, message } from "antd";
import Badge from "./components/Badge";
import MetricCard from "./components/MetricCard";
import Section from "./components/Section";

/* ————— 数据类型 ————— */
type Module = "brand" | "industry";
interface VersionEntry { version: number; runId: string; publishedAt: string; diffSummary?: { addedClaims: string[]; removedClaims: string[]; evidenceDelta: number } }
interface ProjectMeta { id: string; module: Module; goal: string; scope: { summary: string; queries: string[] }; updatedAt: string; versions: VersionEntry[] }
interface Run { id: string; requestId: string; stage: string; status: "running" | "cancelled" | "failed" | "published" | "limited"; usage: { searches: number; fetches: number; costEstimate: number; wallMs: number }; error?: string }
interface Snapshot { id: string; url: string; title: string; fetchedAt: string; parseStatus: string }
interface Claim { id: string; statement: string; kind: string; evidenceIds: string[]; calibration?: { entity: string; period: string; unit: string; value?: number } }
interface Bundle { runId: string; version: number; reportMd: string; claims: Claim[]; evidence: { id: string; snapshotId: string; quote: string }[]; snapshots: Snapshot[]; limitations: string[]; unresolved: string[]; verdicts: { evidenceId: string; verdict: string }[] }
interface ProjectDetail { meta: ProjectMeta; runs: Run[]; snapshots: Snapshot[] }

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<T>;
};
const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const MODULE_LABEL: Record<Module, string> = { brand: "品牌研究", industry: "行业研究" };
const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  running: { label: "进行中", tone: "warn" },
  cancelled: { label: "已取消", tone: "neutral" },
  failed: { label: "已失败", tone: "bad" },
  published: { label: "已发布", tone: "good" },
  limited: { label: "有限交付", tone: "warn" },
};
const KIND: Record<string, { label: string; tone: "info" | "warn" | "bad" }> = {
  fact: { label: "事实", tone: "info" },
  inference: { label: "推断", tone: "warn" },
  unverified: { label: "未验证", tone: "bad" },
};
const VERDICT: Record<string, { label: string; tone: "good" | "bad" | "warn" }> = {
  "quote-hit": { label: "已核实", tone: "good" },
  "quote-mismatch": { label: "未通过", tone: "bad" },
  "snapshot-missing": { label: "快照缺失", tone: "warn" },
};
const STAGE_STEPS = [
  { key: "plan", title: "计划" },
  { key: "gather", title: "采证" },
  { key: "analyze", title: "分析" },
  { key: "draft", title: "草稿" },
  { key: "review", title: "评审" },
  { key: "publish", title: "发布" },
];

/** 报告正文安全渲染:逐段构建元素,不走 HTML 注入。 */
function ReportBody({ md }: { md: string }) {
  const blocks = useMemo(() => md.split("\n"), [md]);
  return (
    <div className="report-body">
      {blocks.map((line, i) => {
        if (line.startsWith("## ")) return <h3 key={i}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h2 key={i}>{line.slice(2)}</h2>;
        if (line.startsWith("- ")) return <li key={i}>{line.slice(2)}</li>;
        if (line.trim() === "") return <br key={i} />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

/* ————— 外壳 ————— */
function Layout() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    api<{ projects: unknown[] }>("/api/projects").then((r) => setCount(r.projects.length)).catch(() => {});
  }, []);
  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="主导航">
        <div className="brand">
          <div className="mark">深</div>
          <div>
            <strong>独立深度研究</strong>
            <small>品牌 × 行业研究工作台</small>
          </div>
        </div>
        <div className="nav-group">
          <div className="nav-group-label">工作台</div>
          <nav className="app-nav">
            <NavLink to="/" className={({ isActive }) => (isActive ? "active" : undefined)}>
              <span className="num">01</span>研究项目
              {count !== null && <span className="nav-count">{count}</span>}
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : undefined)}>
              <span className="num">02</span>设置
            </NavLink>
          </nav>
        </div>
        <div className="side-note">
          <strong>执行完成 ≠ 证据充分</strong>
          资料不足或预算到达上限时有限交付并披露限制,不编造完整答案。
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
        <footer className="page-footer">
          仅在本机运行(127.0.0.1),不连接 JuanerAI;关键结论逐条绑定原文快照,可核查。
        </footer>
      </main>
    </div>
  );
}

/* ————— 项目列表 ————— */
function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ module: "brand" as Module, goal: "", summary: "", attachments: "" });
  const load = useCallback(() => api<{ projects: ProjectMeta[] }>("/api/projects").then((r) => setProjects(r.projects)), []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    try {
      const { id } = await post<{ id: string }>("/api/projects", {
        module: form.module,
        goal: form.goal,
        scope: { summary: form.summary, queries: [] },
      });
      message.success("项目已创建");
      navigate(`/project/${id}`);
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e).slice(0, 160));
    }
  };

  return (
    <>
      <header className="app-top">
        <h1>研究项目</h1>
        <p className="page-desc">创建品牌/行业研究项目;下一步:新建项目,或打开已有项目继续研究与导出。</p>
      </header>
      <Section
        title="项目列表"
        desc="点击进入项目:发起运行、确认计划、查看证据与版本"
        extra={<Button type="primary" onClick={() => setCreating(!creating)}>新建项目</Button>}
      >
        {creating && (
          <div className="form-pad" style={{ marginBottom: 14 }}>
            <div className="two-col">
              <div>
                <p className="sec-desc">研究模块</p>
                <Select value={form.module} style={{ width: "100%" }} onChange={(v) => setForm({ ...form, module: v })}
                  options={[{ value: "brand", label: "品牌研究" }, { value: "industry", label: "行业研究" }]} />
                <p className="sec-desc" style={{ marginTop: 8 }}>研究目标</p>
                <Input value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder="如:森马在中国市场的品牌定位、价格与竞品格局" />
                <p className="sec-desc" style={{ marginTop: 8 }}>范围说明</p>
                <Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="对象、时间、单位等边界" />
              </div>
              <div>
                <p className="sec-desc">附件(本机文件路径,文本/PDF,每行一个,可空)</p>
                <Input.TextArea rows={5} value={form.attachments} onChange={(e) => setForm({ ...form, attachments: e.target.value })} />
              </div>
            </div>
            <div className="actions-row" style={{ marginTop: 12 }}>
              <Button type="primary" disabled={!form.goal || !form.summary} onClick={() => void create()}>创建项目</Button>
              <Button onClick={() => setCreating(false)}>取消</Button>
            </div>
          </div>
        )}
        {projects.length === 0 && <Empty description="还没有项目,点击右上角「新建项目」开始第一项研究" />}
        {projects.map((p) => (
          <div key={p.id} className="runline" style={{ cursor: "pointer" }} onClick={() => navigate(`/project/${p.id}`)}>
            <div>
              <Badge tone="brand" noDot>{MODULE_LABEL[p.module]}</Badge> <strong>{p.goal}</strong>
              <div style={{ color: "var(--soft)", fontSize: 11.5, marginTop: 2 }}>
                更新于 {new Date(p.updatedAt).toLocaleString("zh-CN")}
              </div>
            </div>
            <Badge tone="neutral" noDot>{p.versions.length} 个版本</Badge>
          </div>
        ))}
      </Section>
    </>
  );
}

/* ————— 项目详情 ————— */
function ProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [bundleVersion, setBundleVersion] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<{ claim: Claim; text: string } | null>(null);
  const [runForm, setRunForm] = useState({ open: false, goal: "", summary: "", attachments: "" });
  const [plan, setPlan] = useState<{ id: string; question: string }[] | null>(null);
  const [busy, setBusy] = useState("");
  const runPanelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<ProjectDetail>(`/api/projects/${id}`);
      setDetail(d);
      const latest = d.meta.versions[d.meta.versions.length - 1];
      if (latest && bundleVersion === null) {
        setBundleVersion(latest.version);
        setBundle(await api<Bundle>(`/api/projects/${id}/versions/${latest.version}/bundle`));
      }
    } catch { /* 项目可能被删除 */ }
  }, [id, bundleVersion]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [load]);

  if (!detail) return <Spin style={{ margin: "80px auto", display: "block" }} />;
  const { meta, runs } = detail;
  const publishedRunIds = new Set(meta.versions.map((v) => v.runId));
  const activeRun = runs.find((r) => r.status === "running");
  const verdictOf = (c: Claim) =>
    bundle?.verdicts.find((v) => v.evidenceId === c.evidenceIds[0])?.verdict ?? "snapshot-missing";

  const openRunForm = () =>
    setRunForm({ open: true, goal: meta.goal, summary: meta.scope.summary, attachments: "" });

  const previewPlan = async () => {
    setBusy("生成计划中…通常 1-2 分钟");
    try {
      const r = await post<{ plan: { questions: { id: string; question: string }[] } }>(`/api/projects/${id}/plan-preview`, {
        module: meta.module, goal: runForm.goal,
        scope: { summary: runForm.summary, queries: [] },
      });
      setPlan(r.plan.questions);
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally { setBusy(""); }
  };

  const startRun = async () => {
    if (!plan) return;
    setBusy("启动中…");
    try {
      await post(`/api/projects/${id}/runs`, {
        request: {
          id: `req-${Date.now().toString(36)}`,
          module: meta.module, goal: runForm.goal,
          scope: { summary: runForm.summary, queries: plan.map((q) => q.question) },
          attachments: runForm.attachments.split("\n").map((s) => s.trim()).filter(Boolean),
          // 交互运行用适中预算:约 10 分钟内出结果;更深的重跑走 CLI 自定义预算
          budget: { maxSearches: 8, maxFetches: 12 },
        },
        plan: { questions: plan.map((q) => ({ ...q, status: "open" })) },
      });
      message.success("研究运行已启动,可在下方跟踪进度");
      setPlan(null);
      setRunForm({ ...runForm, open: false });
      await load();
      runPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally { setBusy(""); }
  };

  const act = async (path: string, body: unknown, ok: string) => {
    try {
      await post(path, body);
      if (ok) message.success(ok);
      await load();
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    }
  };

  const viewVersion = async (v: number) => {
    setBundleVersion(v);
    setBundle(await api<Bundle>(`/api/projects/${id}/versions/${v}/bundle`));
  };

  const openDrawer = async (claim: Claim) => {
    const ev = bundle?.evidence.find((e) => e.id === claim.evidenceIds[0]);
    if (!ev || !bundle) return;
    const snap = bundle.snapshots.find((s) => s.id === ev.snapshotId);
    let text = "(快照不可用)";
    if (snap) {
      const res = await fetch(`/api/projects/${id}/snapshots?sid=${encodeURIComponent(snap.id)}`);
      if (res.ok) text = await res.text();
    }
    setDrawer({ claim, text });
  };

  const stageIndex = (stage: string) => Math.max(0, STAGE_STEPS.findIndex((s) => s.key === stage));

  return (
    <>
      <header className="app-top">
        <h1>{meta.goal}</h1>
        <p className="page-desc">{MODULE_LABEL[meta.module]} · {meta.scope.summary};下一步:发起研究运行,或查看下方证据与版本。</p>
        <div className="actions-row" style={{ marginTop: 10 }}>
          <Button onClick={() => navigate("/")}>返回列表</Button>
          <Button type="primary" disabled={activeRun !== undefined} onClick={openRunForm}>
            {activeRun ? "运行进行中…" : "新建研究运行"}
          </Button>
        </div>
      </header>

      <div className="metrics-grid">
        <MetricCard label="状态" value={activeRun ? "进行中" : meta.versions.length ? "已有版本" : "未运行"} note={activeRun ? `阶段:${activeRun.stage}` : undefined} />
        <MetricCard label="版本" value={meta.versions.length} note="不可变,含差异摘要" />
        <MetricCard label="运行次数" value={runs.length} />
        <MetricCard label="证据快照" value={detail.snapshots.length} note={`${detail.snapshots.filter((s) => s.parseStatus === "ok").length} 个解析成功`} />
      </div>

      {runForm.open && (
        <Section title="新建研究运行" desc="生成计划后可编辑问题清单,确认才开始执行">
          <Input value={runForm.goal} onChange={(e) => setRunForm({ ...runForm, goal: e.target.value })} placeholder="研究目标" />
          <Input style={{ marginTop: 8 }} value={runForm.summary} onChange={(e) => setRunForm({ ...runForm, summary: e.target.value })} placeholder="范围说明" />
          <Input.TextArea style={{ marginTop: 8 }} rows={2} value={runForm.attachments} onChange={(e) => setRunForm({ ...runForm, attachments: e.target.value })} placeholder="附件(本机文件路径,每行一个,可空)" />
          {!plan ? (
            <div className="actions-row" style={{ marginTop: 12 }}>
              <Button type="primary" loading={busy !== ""} disabled={!runForm.goal} onClick={() => void previewPlan()}>
                {busy || "生成研究计划"}
              </Button>
              <Button onClick={() => setRunForm({ ...runForm, open: false })}>取消</Button>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <p className="sec-desc">研究计划(可编辑,确认后开始执行;请保持本页打开以跟踪进度)</p>
              {plan.map((q, i) => (
                <Input key={q.id} className="plan-item" value={q.question}
                  onChange={(e) => setPlan(plan.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
              ))}
              <div className="actions-row" style={{ marginTop: 10 }}>
                <Button type="primary" loading={busy !== ""} onClick={() => void startRun()}>{busy || "确认计划并开始研究"}</Button>
                <Button onClick={() => void previewPlan()}>重新生成</Button>
                <Button onClick={() => setPlan(null)}>返回上一步</Button>
              </div>
            </div>
          )}
        </Section>
      )}

      <div ref={runPanelRef}>
        {activeRun ? (
          <Section title="当前运行" desc={`requestId ${activeRun.requestId} · 自动刷新中`}>
            <Steps size="small" current={stageIndex(activeRun.stage)} items={STAGE_STEPS.map((s) => ({ title: s.title }))} style={{ margin: "6px 0 14px" }} />
            <div className="runline">
              <span className="num" style={{ color: "var(--muted)", fontSize: 12.5 }}>
                搜索 {activeRun.usage.searches} · 抓取 {activeRun.usage.fetches} · 成本≈{activeRun.usage.costEstimate.toFixed(3)} · {Math.round(activeRun.usage.wallMs / 1000)}s
              </span>
              <Button danger onClick={() => void act(`/api/projects/${id}/runs/cancel`, { requestId: activeRun.requestId }, "已取消,已完成阶段保留")}>
                取消(保留已完成阶段)
              </Button>
            </div>
          </Section>
        ) : (
          <Section title="运行记录" desc="取消的运行可自检查点恢复;完成后的运行可发布为版本">
            {runs.length === 0 && <Empty description="还没有运行。点击右上角「新建研究运行」开始" />}
            {runs.map((r) => (
              <div className="runline" key={r.id}>
                <div>
                  <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>{" "}
                  <span className="num" style={{ color: "var(--muted)", fontSize: 12.5 }}>{r.requestId}</span>
                  {r.error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 2 }}>{r.error.slice(0, 120)}</div>}
                  <div style={{ color: "var(--soft)", fontSize: 11.5, marginTop: 2 }} className="num">
                    搜索 {r.usage.searches} · 抓取 {r.usage.fetches} · 成本≈{r.usage.costEstimate.toFixed(3)} · {Math.round(r.usage.wallMs / 1000)}s
                  </div>
                </div>
                <div className="actions-row">
                  {(r.status === "published" || r.status === "limited") && !publishedRunIds.has(r.id) && (
                    <Button size="small" onClick={() => void act(`/api/projects/${id}/publish`, { runId: r.id }, "已发布为新版本")}>发布为版本</Button>
                  )}
                  {r.status === "cancelled" && (
                    <Button size="small" onClick={() => void act(`/api/projects/${id}/runs/resume`, { requestId: r.requestId }, "已恢复运行")}>自检查点恢复</Button>
                  )}
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>

      <div className="two-col" style={{ alignItems: "start" }}>
        <Section title={`报告${bundleVersion ? ` v${bundleVersion}` : ""}`} desc="报告 + 主张核查表;点击任一主张打开证据抽屉">
          {!bundle && <Empty description="发布版本后可在此阅读报告" />}
          {bundle && (
            <>
              {bundle.limitations.length > 0 && (
                <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                  message="有限交付" description={bundle.limitations.slice(0, 4).join(";") + (bundle.limitations.length > 4 ? " …" : "")} />
              )}
              <ReportBody md={bundle.reportMd} />
              <h2 style={{ margin: "16px 0 8px" }}>主张与证据</h2>
              <table className="cmp-table">
                <thead><tr><th>主张</th><th>类型</th><th>核查</th></tr></thead>
                <tbody>
                  {bundle.claims.map((c) => (
                    <tr key={c.id} className="claim-row" onClick={() => void openDrawer(c)}>
                      <td>{c.statement}{c.calibration && <div style={{ color: "var(--soft)", fontSize: 11.5 }}>{c.calibration.entity} · {c.calibration.period} · {c.calibration.unit}</div>}</td>
                      <td><Badge tone={KIND[c.kind]?.tone ?? "neutral"}>{KIND[c.kind]?.label ?? c.kind}</Badge></td>
                      <td><Badge tone={VERDICT[verdictOf(c)]?.tone ?? "neutral"}>{VERDICT[verdictOf(c)]?.label ?? verdictOf(c)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Section>

        <div>
          <Section title="版本" desc="发布即不可变;差异摘要对比上一版">
            {meta.versions.length === 0 && <Empty description="尚未发布版本" />}
            {meta.versions.slice().reverse().map((v) => (
              <div className="version-line" key={v.version}>
                <div>
                  <strong>v{v.version}</strong>
                  {v.diffSummary && (
                    <div style={{ color: "var(--soft)", fontSize: 11.5 }} className="num">
                      新增主张 {v.diffSummary.addedClaims.length} · 删除 {v.diffSummary.removedClaims.length} · 证据 {v.diffSummary.evidenceDelta >= 0 ? "+" : ""}{v.diffSummary.evidenceDelta}
                    </div>
                  )}
                </div>
                <div className="actions-row">
                  <Button size="small" type={bundleVersion === v.version ? "primary" : "default"} onClick={() => void viewVersion(v.version)}>查看</Button>
                  <a className="ant-btn ant-btn-sm" href={`/api/projects/${id}/versions/${v.version}/export`} download>导出 zip</a>
                </div>
              </div>
            ))}
          </Section>
        </div>
      </div>

      <Drawer title="证据抽屉" placement="right" width={460} open={drawer !== null} onClose={() => setDrawer(null)}>
        {drawer && (
          <>
            <p><Badge tone={KIND[drawer.claim.kind]?.tone ?? "neutral"}>{KIND[drawer.claim.kind]?.label ?? drawer.claim.kind}</Badge> {drawer.claim.statement}</p>
            <div className="quote-block">引句(须在原文逐字命中):{bundle?.evidence.find((e) => e.id === drawer.claim.evidenceIds[0])?.quote}</div>
            <p className="sec-desc">快照原文(净化纯文本,来源内容不执行):</p>
            <pre className="snap-text">{drawer.text}</pre>
          </>
        )}
      </Drawer>
    </>
  );
}

/* ————— 设置 ————— */
function SettingsPage() {
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [budget, setBudget] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<{ config: Record<string, unknown>; budgetDefaults: Record<string, number> }>("/api/settings").then((r) => {
      setBudget(r.budgetDefaults);
      const m = r.config.model as { provider?: string; modelId?: string } | undefined;
      setProvider(m?.provider ?? "");
      setModelId(m?.modelId ?? "");
    });
  }, []);
  return (
    <>
      <header className="app-top">
        <h1>设置</h1>
        <p className="page-desc">配置模型与搜索供应商;密钥只走环境变量(由启动脚本从本机凭据注入),不经过本页面。</p>
      </header>
      <Section title="模型供应商(主备链路首位)" desc="如 minimax-cn / MiniMax-M2.7;备用链在服务端配置文件维护">
        <div className="two-col">
          <div>
            <p className="sec-desc">provider</p>
            <Input value={provider} onChange={(e) => { setProvider(e.target.value); setSaved(false); }} placeholder="minimax-cn" />
          </div>
          <div>
            <p className="sec-desc">modelId</p>
            <Input value={modelId} onChange={(e) => { setModelId(e.target.value); setSaved(false); }} placeholder="MiniMax-M2.7" />
          </div>
        </div>
        <div className="actions-row" style={{ marginTop: 12 }}>
          <Button type="primary" disabled={!provider || !modelId}
            onClick={() => void post("/api/settings", { model: { provider, modelId } }).then(() => { setSaved(true); message.success("已保存"); })}>
            保存
          </Button>
          {saved && <Badge tone="good">已保存</Badge>}
        </div>
      </Section>
      <Section title="默认预算上限" desc="每 run 可在请求级覆盖;token plan 供应商成本记 0">
        <table className="cmp-table">
          <tbody>
            {Object.entries(budget).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/project/:id" element={<ProjectPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<ProjectsPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
