import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Session } from "../lib/types";
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
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [loc.pathname]);

  const sections = useMemo(
    () => SECTIONS.map((s) => ({ ...s, pages: ROUTES.filter((r) => r.grp === s.grp && canSee(r.id)) })).filter((s) => s.pages.length),
    [canSee],
  );

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
    <div className="min-h-full flex bg-canvas">
      {/* sidebar: brand, search, every page by section, then theme and account */}
      <aside
        aria-label="사이드 메뉴"
        className={cx(
          "fixed inset-y-0 left-0 z-40 w-[232px] flex-none bg-surface border-r border-line flex flex-col transition-transform duration-200",
          "md:sticky md:top-0 md:h-screen md:translate-x-0",
          menuOpen ? "translate-x-0 shadow-xl" : "-translate-x-full",
        )}
      >
        <div className="h-14 flex-none flex items-center gap-2 px-4">
          <div className="grid place-items-center size-[28px] rounded-lg text-primary-fg bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_85%,white),var(--primary))] shadow-primary">
            <Icon name="arrow" className="size-3.5" strokeWidth={2.6} />
          </div>
          <b className="font-semibold tracking-[-0.01em] text-[15px]">Wharfline</b>
          <span className="ml-auto h-6 px-2 rounded-md bg-surface-2 border border-line text-[12px] font-medium inline-flex items-center">acme</span>
        </div>
        <div className="px-3 pb-2 flex-none">
          <button
            type="button"
            onClick={openQuick}
            className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface-2 text-faint text-[13px] hover:border-line-strong transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span className="flex-1 text-left">이동하거나 실행하기</span>
            <kbd className="font-mono text-[11px] border border-line rounded px-1.5">⌘K</kbd>
          </button>
        </div>
        <nav aria-label="주 메뉴" className="flex-1 overflow-y-auto scroll-soft px-3 py-2 flex flex-col gap-4">
          {sections.map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5">
              {s.grp && <div className="px-2.5 pb-1 text-[11.5px] font-semibold text-faint tracking-[0.02em]">{s.label}</div>}
              {s.pages.map((r) => (
                <NavLink
                  key={r.id}
                  to={r.path}
                  end={r.path === "/"}
                  className={({ isActive }) =>
                    cx(
                      "h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors",
                      isActive ? "bg-primary-soft text-primary font-semibold" : "text-muted hover:text-fg hover:bg-hover",
                    )
                  }
                >
                  <Icon name={r.icon} className="size-4 flex-none" />
                  <span className="flex-1 truncate">{r.label}</span>
                  {counts[r.id] ? <span className="text-[11px] text-faint tabular-nums">{counts[r.id]}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex-none border-t border-line px-3 py-3 flex flex-col gap-2">
          <SudoTimer />
          <div className="flex items-center gap-2">
            <span
              className="grid place-items-center size-[30px] flex-none rounded-full bg-primary-soft text-primary font-semibold text-[11px]"
              title={`${session?.me.name} · ${session?.me.role}${session?.me.groups.length ? ` · ${session.me.groups.join(", ")}` : ""}${session?.tfa ? " · 2단계 인증 사용 중" : ""}`}
            >
              {session?.me.name.slice(0, 2)}
            </span>
            <span className="flex-1 min-w-0 leading-tight">
              <span className="block text-[13px] font-medium truncate">{session?.me.name}</span>
              <span className="block text-[11.5px] text-faint truncate">{session?.me.role}</span>
            </span>
            <Button variant="ghost" size="sm" iconOnly icon={dark ? "sun" : "moon"} title="테마 전환" aria-label="테마 전환" onClick={toggle} />
            <Button variant="ghost" size="sm" iconOnly icon="logout" title="로그아웃" aria-label="로그아웃" onClick={logout} />
          </div>
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* narrow screens: a bar that opens the sidebar */}
        <header className="md:hidden sticky top-0 z-20 h-14 bg-surface/95 backdrop-blur-md shadow-bar flex items-center gap-3 px-4">
          <Button variant="ghost" size="sm" iconOnly icon="menu" aria-label="메뉴 열기" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} />
          <b className="font-semibold text-[15px]">{route.label}</b>
          <span className="flex-1" />
          <SudoTimer />
        </header>
        <main className="flex-1" id="content">
          <div className="max-w-[1280px] mx-auto flex flex-col gap-6 px-4 md:px-8 pt-7 pb-14">
            {viewAs && <PreviewBar />}
            {canSee(route.id) ? children : <Denied label={route.label} />}
          </div>
        </main>
      </div>
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
