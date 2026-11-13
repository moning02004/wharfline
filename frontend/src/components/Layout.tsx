import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import { since } from "../lib/time";
import type { Job, Run, Session } from "../lib/types";
import { Icon } from "./Icon";
import { QuickNav } from "./QuickNav";
import { Button, cx } from "./ui";

function useTheme() {
  const isDark = () =>
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const [dark, setDark] = useState(isDark);
  const toggle = () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("wharfline-theme", next);
    } catch {
      /* storage unavailable */
    }
    setDark(next === "dark");
  };
  return { dark, toggle };
}

function SudoTimer() {
  const { session, sudoActive, endSudo, toast } = useApp();
  if (!sudoActive || !session) return null;
  const s = Math.max(0, Math.round((session.sudoUntil - Date.now()) / 1000));
  return (
    <span
      title="민감 정보 열람 가능 시간"
      className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-0.5 rounded-md whitespace-nowrap flex-none bg-warn-soft text-warn text-xs font-medium border border-warn/25 animate-fade"
    >
      <Icon name="unlock" className="size-3.5" />
      <span className="tabular-nums">
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <button
        className="px-2 h-6 rounded-[5px] text-[11.5px] hover:bg-warn/15 transition-colors"
        onClick={async () => {
          await endSudo();
          toast("잠갔어요. 다시 보려면 비밀번호가 필요해요.");
        }}
      >
        지금 잠그기
      </button>
    </span>
  );
}

/** Top-level sections, derived from each route's group. */
const SECTIONS = [
  { grp: "", label: "대시보드" },
  { grp: "배포", label: "배포" },
  { grp: "리소스", label: "리소스" },
  { grp: "관리", label: "관리" },
  { grp: "프로토타입", label: "설계 노트" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { session, setSession, canSee, viewAs, version, openModal } = useApp();
  const { dark, toggle } = useTheme();
  const loc = useLocation();
  // A detail page (/jobs/abc) belongs to its list's menu.
  const route = ROUTES.find((r) => r.path === loc.pathname) ?? ROUTES.find((r) => r.path !== "/" && loc.pathname.startsWith(r.path + "/")) ?? ROUTES[0];

  const sections = useMemo(
    () => SECTIONS.map((s) => ({ ...s, pages: ROUTES.filter((r) => r.grp === s.grp && canSee(r.id)) })).filter((s) => s.pages.length),
    [canSee],
  );
  const section = sections.find((s) => s.grp === route.grp);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    Promise.all([api.get<Job[]>("/jobs"), api.get<{ hosts: unknown[] }[]>("/inventory"), api.get<unknown[]>("/keys")])
      .then(([j, i, k]) => {
        setJobs(j);
        setCounts({ jobs: j.length, inventory: i.reduce((a, x) => a + x.hosts.length, 0), keys: k.length });
      })
      .catch(() => {});
  }, [loc.pathname, version]);
  // 지금 (the deploy section's side panel): runs playing or waiting; refetched on every live update.
  const inDeploy = route.grp === "배포";
  useEffect(() => {
    if (!inDeploy) return;
    api.get<Run[]>("/runs").then(setRuns, () => {});
  }, [inDeploy, loc.pathname, version]);

  const openQuick = () => openModal((c) => <QuickNav onClose={c} />, "sm");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openQuick();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []); // openModal is stable, so the shortcut is registered once

  const logout = async () => setSession(await api.post<Session>("/auth/logout"));
  // The side menu: the pages of the current section (and 지금 in the deploy section).
  const side = !!section && (section.pages.length > 1 || inDeploy);

  return (
    <div className="min-h-full flex flex-col bg-canvas">
      {/* top: brand, the sections as big tabs, search, theme and account */}
      <header className="sticky top-0 z-30 bg-surface shadow-bar">
        <div className="max-w-[1320px] mx-auto px-4 md:px-7 min-h-16 flex items-center gap-3 md:gap-5">
          <NavLink to="/" className="flex items-center gap-2 flex-none font-extrabold text-[16px] tracking-[-0.02em] text-fg">
            <span className="grid place-items-center size-[26px] rounded-[7px] bg-primary text-primary-fg">
              <Icon name="arrow" className="size-3.5" strokeWidth={2.6} />
            </span>
            <span className="max-sm:hidden">wharfline</span>
          </NavLink>
          <nav aria-label="주 메뉴" className="flex self-stretch overflow-x-auto scroll-soft min-w-0">
            {sections.map((s) => {
              const on = s.grp === route.grp;
              return (
                <NavLink
                  key={s.label}
                  to={s.pages[0].path}
                  className={cx(
                    "flex items-center px-3 md:px-3.5 text-[15px] whitespace-nowrap transition-colors",
                    on ? "font-bold text-fg shadow-[inset_0_-3px_0_var(--mark)]" : "font-medium text-faint hover:text-fg",
                  )}
                >
                  {s.label}
                </NavLink>
              );
            })}
          </nav>
          <span className="flex-1" />
          <button
            type="button"
            onClick={openQuick}
            className="max-md:hidden flex items-center gap-2 h-9 w-[240px] px-3 rounded-full bg-surface-2 text-faint text-[13px] shadow-[inset_0_1px_2px_rgba(23,24,28,.07)] hover:text-muted transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span className="flex-1 text-left">이동하거나 실행하기</span>
            <kbd className="font-mono text-[11px]">⌘K</kbd>
          </button>
          <Button variant="ghost" size="sm" iconOnly icon="search" className="md:hidden" aria-label="이동하거나 실행하기" onClick={openQuick} />
          <SudoTimer />
          <Button variant="ghost" size="sm" iconOnly icon={dark ? "sun" : "moon"} title="테마 전환" aria-label="테마 전환" onClick={toggle} />
          <span
            className="grid place-items-center size-[34px] flex-none rounded-full bg-primary text-primary-fg font-bold text-[11px] shadow-[0_0_0_3px_var(--surface),0_0_0_4px_var(--border)]"
            title={`${session?.me.name} · ${session?.me.role}${session?.me.groups.length ? ` · ${session.me.groups.join(", ")}` : ""}${session?.tfa ? " · 2단계 인증 사용 중" : ""}`}
          >
            {session?.me.name.slice(0, 2)}
          </span>
          <Button variant="ghost" size="sm" iconOnly icon="logout" title="로그아웃" aria-label="로그아웃" onClick={logout} />
        </div>
      </header>

      <div className="flex-1 w-full max-w-[1320px] mx-auto px-4 md:px-7 pt-7 pb-14 flex flex-col md:flex-row gap-6 md:gap-7">
        {side && section && (
          <aside aria-label="보조 메뉴" className="md:w-[220px] flex-none flex flex-col gap-5 md:gap-6">
            <nav aria-label={`${section.label} 메뉴`} className="flex md:flex-col gap-x-4 gap-y-0.5 overflow-x-auto scroll-soft">
              {section.pages.map((r) => (
                <NavLink
                  key={r.id}
                  to={r.path}
                  end={r.path === "/"}
                  className={() =>
                    cx(
                      "py-1.5 text-[15px] whitespace-nowrap transition-colors",
                      r.id === route.id ? "font-bold text-fg" : "font-medium text-faint hover:text-fg",
                    )
                  }
                >
                  {r.label}
                  {counts[r.id] ? <span className="ml-1.5 font-medium text-faint">{counts[r.id]}</span> : null}
                </NavLink>
              ))}
            </nav>
            {route.grp === "배포" && <NowPanel jobs={jobs} runs={runs} />}
          </aside>
        )}
        <main id="content" className="flex-1 min-w-0 flex flex-col gap-6">
          {viewAs && <PreviewBar />}
          {canSee(route.id) ? children : <Denied label={route.label} />}
        </main>
      </div>
    </div>
  );
}

/** 지금: what needs eyes in the deploy section — runs playing, runs waiting for approval, jobs whose last deploy failed. */
function NowPanel({ jobs, runs }: { jobs: Job[]; runs: Run[] }) {
  const playing = runs.filter((r) => r.status === "run");
  const waiting = runs.filter((r) => r.status === "approval");
  const failed = jobs.filter((j) => j.last?.status === "bad");
  const group = (label: string, tone: string, count: number, rows: ReactNode) => (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 px-1 text-[13px] font-semibold">
        <span className="size-2 rounded-full flex-none" style={{ background: tone }} />
        <span className="flex-1">{label}</span>
        <span className="font-mono text-[12px] text-faint">{count}</span>
      </span>
      {rows}
    </div>
  );
  const row = (key: string | number, to: string, title: string, sub: string) => (
    <Link key={key} to={to} className="block pl-5 pr-2 py-1.5 rounded-lg hover:bg-hover transition-colors" title={title}>
      <span className="block text-[13px] truncate">{title}</span>
      <span className="block text-[11.5px] text-faint truncate">{sub}</span>
    </Link>
  );
  const quiet = !playing.length && !waiting.length && !failed.length;
  return (
    <div className="flex flex-col gap-3 min-w-0 max-md:hidden">
      <span className="text-[11.5px] font-bold tracking-[0.08em] text-faint">지금</span>
      {quiet && <span className="px-1 text-[13px] text-faint">진행 중인 일이 없어요</span>}
      {playing.length > 0 && group("배포중", "var(--accent)", playing.length, playing.slice(0, 3).map((r) => row(r.no, `/runs?run=${r.no}`, r.job, `#${r.no} · ${r.trigger}`)))}
      {waiting.length > 0 &&
        group("승인 대기", "var(--mark)", waiting.length, waiting.slice(0, 3).map((r) => row(r.no, `/runs?run=${r.no}`, r.job, `#${r.no} · ${r.requestedByName ?? r.by} 요청`)))}
      {failed.length > 0 &&
        group(
          "최근 실패",
          "var(--bad)",
          failed.length,
          <>
            {failed.slice(0, 3).map((j) => row(j.id, `/jobs/${encodeURIComponent(j.id)}`, j.name, since(j.last.at, j.last.time)))}
            {failed.length > 3 && <span className="pl-5 text-[12px] text-faint">외 {failed.length - 3}개</span>}
          </>,
        )}
    </div>
  );
}

function PreviewBar() {
  const { viewAs, setViewAs, toast } = useApp();
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pl-3.5 pr-1.5 py-1.5 rounded-lg border border-accent/25 bg-accent-soft text-accent text-[13px] font-medium animate-fade">
      <span>
        {viewAs?.name}님({viewAs?.role})으로 미리 보는 중이에요. 메뉴와 빌드가 이 멤버의 그룹 기준으로 보여요.
      </span>
      <Button
        size="sm"
        onClick={() => {
          setViewAs(null);
          toast("내 권한으로 돌아왔어요");
        }}
      >
        내 권한으로 돌아가기
      </Button>
    </div>
  );
}

function Denied({ label }: { label: string }) {
  const { viewAs } = useApp();
  const nav = useNavigate();
  return (
    <div className="bg-surface rounded-lg border border-line py-16 px-6 text-center flex flex-col items-center gap-2">
      <div className="grid place-items-center size-10 rounded-lg border border-line bg-surface-2 text-faint mb-2">
        <Icon name="lock" className="size-5" />
      </div>
      <h2 className="m-0 text-[15px] font-semibold">이 메뉴를 볼 권한이 없어요</h2>
      <p className="m-0 text-muted max-w-[44ch]">
        {viewAs ? `${viewAs.name}님의 그룹` : "내 그룹"}에는 "{label}" 메뉴가 없어요. 필요하면 워크스페이스 Owner에게 그룹 추가를 요청하세요.
      </p>
      <Button size="sm" className="mt-2" onClick={() => nav("/")}>
        대시보드로 가기
      </Button>
    </div>
  );
}
