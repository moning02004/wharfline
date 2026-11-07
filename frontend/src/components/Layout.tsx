import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Session } from "../lib/types";
import { Icon } from "./Icon";
import { QuickNav } from "./QuickNav";
import { Button, cx } from "./ui";
import { useRun } from "../modals/RunModals";

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
  const { runById } = useRun();
  const { dark, toggle } = useTheme();
  const loc = useLocation();
  const nav = useNavigate();
  const route = ROUTES.find((r) => r.path === loc.pathname) ?? ROUTES[0];

  const sections = useMemo(
    () => SECTIONS.map((s) => ({ ...s, pages: ROUTES.filter((r) => r.grp === s.grp && canSee(r.id)) })).filter((s) => s.pages.length),
    [canSee],
  );
  const current = sections.find((s) => s.grp === route.grp);

  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    Promise.all([api.get<unknown[]>("/jobs"), api.get<{ hosts: unknown[] }[]>("/inventory"), api.get<unknown[]>("/keys")])
      .then(([j, i, k]) => setCounts({ jobs: j.length, inventory: i.reduce((a, x) => a + x.hosts.length, 0), keys: k.length }))
      .catch(() => {});
  }, [loc.pathname, version]);

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

  return (
    <div className="min-h-full flex flex-col bg-canvas">
      <header className="sticky top-0 z-30 bg-surface/95 backdrop-blur-md shadow-bar">
        {/* row 1: brand, sections, tools */}
        <div className="max-w-[1280px] mx-auto px-4 md:px-8 h-14 flex items-center gap-3 md:gap-6">
          <div className="flex items-center gap-2 flex-none">
            <div className="grid place-items-center size-[28px] rounded-lg text-primary-fg bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_85%,white),var(--primary))] shadow-primary">
              <Icon name="arrow" className="size-3.5" strokeWidth={2.6} />
            </div>
            <b className="font-semibold tracking-[-0.01em] text-[15px] max-sm:hidden">Wharfline</b>
            <span className="text-line-strong max-sm:hidden">/</span>
            <span className="h-7 px-2 rounded-md bg-surface-2 border border-line text-[12.5px] font-medium inline-flex items-center max-sm:hidden">acme</span>
          </div>
          <nav aria-label="주 메뉴" className="flex items-stretch h-14 gap-0.5 overflow-x-auto scroll-soft min-w-0">
            {sections.map((s) => {
              const active = s.grp === route.grp;
              return (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => nav(s.pages[0].path)}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "px-3 text-[13.5px] whitespace-nowrap transition-colors",
                    active ? "text-fg font-semibold shadow-[inset_0_-2px_0_var(--primary)]" : "text-muted hover:text-fg",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </nav>
          <div className="flex-1" />
          <button
            type="button"
            onClick={openQuick}
            className="max-md:hidden flex items-center gap-2 h-8 w-[220px] px-2.5 rounded-lg border border-line bg-surface-2 text-faint text-[13px] shadow-[inset_0_1px_2px_rgba(16,24,40,.05)] hover:border-line-strong transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span className="flex-1 text-left">이동하거나 실행하기</span>
            <kbd className="font-mono text-[11px] border border-line rounded px-1.5">⌘K</kbd>
          </button>
          <SudoTimer />
          <Button variant="ghost" size="sm" iconOnly icon={dark ? "sun" : "moon"} title="테마 전환" aria-label="테마 전환" onClick={toggle} />
          {canSee("jobs") && viewAs !== "Viewer" && (
            <Button variant="primary" size="sm" icon="play" className="max-sm:hidden" onClick={() => runById("j1")}>
              배포 실행
            </Button>
          )}
          <div className="flex items-center gap-1 flex-none">
            <span
              className="grid place-items-center size-[30px] rounded-full bg-primary-soft text-primary font-semibold text-[11px] shadow-[0_0_0_2px_var(--surface),0_0_0_3px_color-mix(in_srgb,var(--primary)_25%,transparent)]"
              title={`${session?.me.name} · ${session?.me.role} · 2FA 사용 중`}
            >
              JY
            </span>
            <Button variant="ghost" size="sm" iconOnly icon="logout" title="로그아웃" aria-label="로그아웃" onClick={logout} />
          </div>
        </div>
        {/* row 2: pages of the current section */}
        {current && current.pages.length > 1 && (
          <div className="max-w-[1280px] mx-auto px-4 md:px-8 h-11 flex items-center gap-1 overflow-x-auto scroll-soft">
            {current.pages.map((r) => (
              <NavLink
                key={r.id}
                to={r.path}
                end
                className={({ isActive }) =>
                  cx(
                    "h-[30px] px-3 rounded-lg inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap transition-all duration-150",
                    isActive ? "bg-surface text-fg font-medium shadow-[0_0_0_1px_rgba(16,24,40,.06),0_1px_3px_rgba(16,24,40,.1)]" : "text-muted hover:text-fg hover:bg-hover",
                  )
                }
              >
                {r.label}
                {counts[r.id] ? <span className="text-[11px] text-faint tabular-nums">{counts[r.id]}</span> : null}
              </NavLink>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1" id="content">
        <div className="max-w-[1280px] mx-auto flex flex-col gap-6 px-4 md:px-8 pt-7 pb-14">
          {viewAs !== "Owner" && <PreviewBar />}
          {canSee(route.id) ? children : <Denied label={route.label} />}
        </div>
      </main>
    </div>
  );
}

function PreviewBar() {
  const { viewAs, setViewAs, toast } = useApp();
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pl-3.5 pr-1.5 py-1.5 rounded-lg border border-accent/25 bg-accent-soft text-accent text-[13px] font-medium animate-fade">
      <span>{viewAs} 역할로 미리 보는 중이에요. 메뉴와 화면이 이 역할 기준으로 보여요.</span>
      <Button
        size="sm"
        onClick={() => {
          setViewAs("Owner");
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
        {viewAs} 역할에는 "{label}" 메뉴가 꺼져 있어요. 필요하면 워크스페이스 관리자에게 요청하세요.
      </p>
      <Button size="sm" className="mt-2" onClick={() => nav("/")}>
        대시보드로 가기
      </Button>
    </div>
  );
}
