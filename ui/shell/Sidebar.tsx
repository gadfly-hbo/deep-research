/* 左侧栏(U1:类型→项目→任务三级树):⌘K 搜索 / 新建入口 / 树(任务=run,无版本层) / 已归档
   / 底部设置与边界声明;品牌区在顶部 TopBar。契约:.flow/ui-contract.md(S1-S10/CP1-15/N1-N12)。
   数据:GET /api/projects 附带 runs 轻量摘要(D1),ProjectsProvider 档位轮询(G1-3)。 */
import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { errMsg, patch } from "../state/api";
import { useProjects } from "../state/projects";
import { useUI } from "../state/ui";
import { useToast } from "../state/toast";
import { MODULE_LABEL, STATUS, STATUS_DOT } from "../state/types";
import type { Module, ProjectWithRuns, RunSummary } from "../state/types";

const MODULE_ORDER: Module[] = ["brand", "industry"];
const GUARD_TEXT = "运行进行中或待确认,处理后方可再次发起";
const RENAME_RUNNING_TEXT = "运行进行中,处理后方可改名";
const LABEL_MAX = 60;

const labelOf = (p: ProjectWithRuns): string => p.name ?? (p.goal.length > LABEL_MAX ? `${p.goal.slice(0, LABEL_MAX)}…` : p.goal);
const guarded = (p: ProjectWithRuns): boolean =>
  p.runs.some((r) => r.status === "running" || r.status === "awaiting-confirmation");

/** U1(S9):内联改名——Enter 保存 / Esc·blur 取消 / 留空=清除回退;>60 内联错误阻断保存。 */
function RenameEditor(props: { initial: string; onCommit: (name: string | null) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();
  const tooLong = trimmed.length > LABEL_MAX;
  const commit = () => {
    if (tooLong) return; // 内联错误阻断(N6:不静默截断)
    props.onCommit(trimmed === "" ? null : trimmed);
  };
  return (
    <div className="sb-rename">
      <input
        ref={(el) => { if (el) { el.focus(); el.select(); } }}
        value={value}
        aria-label="名称"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); props.onCancel(); }
        }}
        onBlur={() => { if (!tooLong) props.onCancel(); }}
      />
      <p className="sb-rename-hint">
        Enter 保存 · Esc 取消 · 留空恢复默认
        <span className="sb-rename-count" aria-hidden="true">{trimmed.length} / {LABEL_MAX}</span>
      </p>
      {tooLong && <p className="sb-rename-error" role="alert">名称不能超过 {LABEL_MAX} 字</p>}
    </div>
  );
}

type MenuTarget = { kind: "project"; project: ProjectWithRuns } | { kind: "run"; project: ProjectWithRuns; run: RunSummary };

/** U1(S4/S5):行级「⋯」菜单(重命名);run 且 running 时禁用(N3);Esc 关闭焦点还原,Tab 不出界。 */
function RowMenu(props: { target: MenuTarget; disabled: boolean; disabledTitle?: string; onRename: () => void; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    if (e.key === "Tab") {
      e.preventDefault();
      const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : (idx === items.length - 1 ? 0 : idx + 1);
      items[next]?.focus();
    }
  };
  return (
    <div className="sb-menu" role="menu" ref={(el) => { menuRef.current = el; firstRef.current?.focus?.(); }} onKeyDown={onKeyDown}>
      <button
        type="button"
        role="menuitem"
        ref={firstRef}
        disabled={props.disabled}
        title={props.disabled ? props.disabledTitle : undefined}
        onClick={() => props.onRename()}
      >
        重命名
      </button>
    </div>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const ui = useUI();
  const toast = useToast();
  const { projects, loaded, reload, boostAndReload } = useProjects();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<MenuTarget | null>(null);

  const currentId = location.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null;
  const active = projects.filter((p) => p.status !== "archived");
  const archived = projects.filter((p) => p.status === "archived");
  const currentProject = projects.find((p) => p.id === currentId) ?? null;

  const openProject = (id: string) => navigate(`/project/${id}`);

  const commitRename = async (target: MenuTarget, name: string | null) => {
    setRenaming(null);
    setMenu(null);
    try {
      if (target.kind === "project") {
        await patch(`/api/projects/${target.project.id}`, { name });
        toast.show("项目已重命名");
      } else {
        await patch(`/api/projects/${target.project.id}/runs/${target.run.id}/name`, { name });
        toast.show("任务已重命名");
      }
      await reload();
    } catch (e) {
      const message = errMsg(e);
      toast.show(message);
      if (message.includes(RENAME_RUNNING_TEXT)) void boostAndReload(); // CP-10 竞态兜底
    }
  };

  const taskRow = (p: ProjectWithRuns, r: RunSummary) => {
    const isCurrentTask = p.id === currentId;
    const renamingThis = renaming && renaming.kind === "run" && renaming.run.id === r.id && renaming.project.id === p.id;
    return (
      <li key={r.id} className="sb-task-row">
        <div
          className={`sb-item sb-task${isCurrentTask ? " active" : ""}`}
          role="button"
          tabIndex={0}
          title="查看该项目当前调查流"
          aria-current={isCurrentTask ? "true" : undefined}
          onClick={() => navigate(`/project/${p.id}/gather`)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/project/${p.id}/gather`); } }}
        >
          <span className={`dot ${STATUS_DOT[r.status] ?? "dot-idle"}`} aria-hidden="true" />
          <span className={`sb-label${r.name ? "" : " mono"}`} title={`${r.name ?? r.requestId} · ${STATUS[r.status]?.label ?? r.status}`}>
            {r.name ?? r.requestId}
          </span>
          <span className="sb-meta">{STATUS[r.status]?.label ?? r.status}</span>
          <span className="sb-actions">
            <button
              className="sb-act"
              type="button"
              aria-label={`重命名任务 ${r.name ?? r.requestId}`}
              disabled={r.status === "running"}
              title={r.status === "running" ? RENAME_RUNNING_TEXT : undefined}
              onClick={(e) => { e.stopPropagation(); setMenu({ kind: "run", project: p, run: r }); }}
            >
              ⋯
            </button>
          </span>
        </div>
        {menu && menu.kind === "run" && menu.run.id === r.id && menu.project.id === p.id && !renaming && (
          <RowMenu
            target={menu}
            disabled={r.status === "running"}
            disabledTitle={RENAME_RUNNING_TEXT}
            onRename={() => setRenaming(menu)}
            onClose={() => setMenu(null)}
          />
        )}
        {renamingThis && <RenameEditor initial={r.name ?? ""} onCommit={(name) => void commitRename(menuTargetOf(p, r), name)} onCancel={() => setRenaming(null)} />}
      </li>
    );
  };

  const projectRow = (p: ProjectWithRuns, options?: { archived?: boolean }) => {
    const isCurrent = p.id === currentId;
    const open = expanded[p.id] === true;
    const canExpand = !options?.archived && p.runs.length > 0;
    const guard = guarded(p);
    const renamingThis = renaming && renaming.kind === "project" && renaming.project.id === p.id;
    const label = labelOf(p);
    const toggle = () => { if (canExpand) setExpanded({ ...expanded, [p.id]: !open }); };
    const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProject(p.id); }
      if (e.key === "ArrowRight" && canExpand && !open) { e.preventDefault(); toggle(); }
      if (e.key === "ArrowLeft" && canExpand && open) { e.preventDefault(); toggle(); }
    };
    return (
      <li key={p.id} className="sb-row">
        <div
          className={`sb-item${isCurrent ? " active" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={canExpand ? open : undefined}
          onClick={() => openProject(p.id)}
          onKeyDown={onRowKey}
        >
          <span className="caret" aria-hidden="true" onClick={(e) => { e.stopPropagation(); toggle(); }}>
            {canExpand ? (open ? "▾" : "▸") : "·"}
          </span>
          <span className="sb-label" title={p.name ?? p.goal}>{label}</span>
          {!options?.archived && (
            <span className="sb-actions">
              <button
                className="sb-act"
                type="button"
                aria-label={`在 ${label} 新建任务`}
                disabled={guard}
                title={guard ? GUARD_TEXT : undefined}
                onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/plan?new=1`); }}
              >
                ＋
              </button>
              <button
                className="sb-act"
                type="button"
                aria-label={`重命名项目 ${label}`}
                onClick={(e) => { e.stopPropagation(); setMenu({ kind: "project", project: p }); }}
              >
                ⋯
              </button>
            </span>
          )}
          {options?.archived && (
            <span className="sb-actions">
              <button
                className="sb-act"
                type="button"
                aria-label={`重命名项目 ${label}`}
                onClick={(e) => { e.stopPropagation(); setMenu({ kind: "project", project: p }); }}
              >
                ⋯
              </button>
            </span>
          )}
        </div>
        {!options?.archived && open && (
          <ul className="sb-tasks" aria-label={`${label} 任务`}>
            {p.runs.length === 0 ? (
              <li><p className="sb-empty">尚无任务;悬停项目行「+」发起。</p></li>
            ) : (
              p.runs.map((r) => taskRow(p, r))
            )}
          </ul>
        )}
        {menu && menu.kind === "project" && menu.project.id === p.id && !renaming && (
          <RowMenu target={menu} disabled={false} onRename={() => setRenaming(menu)} onClose={() => setMenu(null)} />
        )}
        {renamingThis && <RenameEditor initial={p.name ?? ""} onCommit={(name) => void commitRename({ kind: "project", project: p }, name)} onCancel={() => setRenaming(null)} />}
      </li>
    );
  };

  const menuTargetOf = (p: ProjectWithRuns, r: RunSummary): MenuTarget => ({ kind: "run", project: p, run: r });

  return (
    <nav className="sidebar" aria-label="项目与任务导航">
      <div className="sb-top">
        <button className="sb-search" type="button" onClick={ui.openPalette}>
          <span aria-hidden="true">⌕</span> 搜索项目与命令 <kbd>⌘K</kbd>
        </button>
        <button
          className={`sb-item${location.pathname === "/library" ? " active" : ""}`}
          type="button"
          onClick={() => navigate("/library")}
        >
          <span aria-hidden="true">▣</span> 外部情报库
        </button>
        {currentId && currentProject ? (
          <button
            className="sb-new"
            type="button"
            disabled={guarded(currentProject)}
            title={guarded(currentProject) ? GUARD_TEXT : undefined}
            onClick={() => navigate(`/project/${currentId}/plan?new=1`)}
          >
            ＋ 新建任务
          </button>
        ) : (
          <button className="sb-new" type="button" onClick={() => navigate("/?new=1")}>＋ 新建项目</button>
        )}
      </div>

      {!loaded ? (
        <div className="sb-section" aria-busy="true">
          <span className="visually-hidden">加载中</span>
          <div className="sb-skel" aria-hidden="true"><span /><span /><span /></div>
        </div>
      ) : (
        MODULE_ORDER.map((mod) => {
          const items = active
            .filter((p) => p.module === mod)
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
          const target = `/?new=1&module=${mod}`;
          return (
            <div className="sb-section" key={mod}>
              <h2 className="sb-h">
                {MODULE_LABEL[mod]}<span className="sb-h-count">{items.length}</span>
                <button
                  className="sb-act sb-h-new"
                  type="button"
                  aria-label={`新建${MODULE_LABEL[mod]}项目`}
                  onClick={() => navigate(target)}
                >
                  ＋
                </button>
              </h2>
              {items.length === 0 ? (
                <p
                  className="sb-empty sb-empty-action"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(target)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(target); } }}
                >
                  暂无项目,+ 新建
                </p>
              ) : (
                <ul className="sb-list" role="list">
                  {items.map((p) => projectRow(p))}
                </ul>
              )}
            </div>
          );
        })
      )}

      {loaded && archived.length > 0 && (
        <div className="sb-section">
          <h2 className="sb-h">
            <button
              className="sb-item"
              type="button"
              style={{ padding: 0, width: "auto" }}
              onClick={() => setArchivedOpen(!archivedOpen)}
              aria-expanded={archivedOpen}
            >
              <span className="caret" aria-hidden="true">{archivedOpen ? "▾" : "▸"}</span>
              已归档<span className="sb-meta">{archived.length}</span>
            </button>
          </h2>
          {archivedOpen && (
            <ul className="sb-list" role="list">
              {archived.map((p) => projectRow(p, { archived: true }))}
            </ul>
          )}
        </div>
      )}

      <div className="sb-foot">
        <button
          className={`sb-item${location.pathname === "/settings" ? " active" : ""}`}
          type="button"
          onClick={() => navigate("/settings")}
        >
          <span aria-hidden="true">⚙</span> 设置
        </button>
        <div className="sb-note">
          <strong>执行完成 ≠ 证据充分</strong>
          资料不足或预算到达上限时有限交付并披露限制,不编造完整答案。
        </div>
      </div>
    </nav>
  );
}
