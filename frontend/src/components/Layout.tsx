import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Session } from "../lib/types";
import { Icon, type IconName } from "./Icon";
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

export function Layout({ children }: { children: ReactNode }) {
  const { session, setSession, canSee, viewAs, version } = useApp();
  const { runById } = useRun();
  const [open, setOpen] = useState(false);
  const { dark, toggle } = useTheme();
  const loc = useLocation();
  const route = ROUTES.find((r) => r.path === loc.pathname) ?? ROUTES[0];

  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  let lastGrp: string | null = null;
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    Promise.all([api.get<unknown[]>("/jobs"), api.get<{ hosts: unknown[] }[]>("/inventory"), api.get<unknown[]>("/keys")])
      .then(([j, i, k]) => setCounts({ jobs: j.length, inventory: i.reduce((a, x) => a + x.hosts.length, 0), keys: k.length }))
      .catch(() => {});
  }, [loc.pathname, version]);

  const logout = async () => {
    const s = await api.post<Session>("/auth/logout");
    setSession(s);
  };

  return (
    <div className="grid h-full md:grid-cols-[232px_minmax(0,1fr)]">
      {/* sidebar */}
      <aside
        className={cx(
          "flex flex-col min-h-0 bg-bg border-r border-line z-30",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[260px] max-md:shadow-pop max-md:transition-transform max-md:duration-200",
          !open && "max-md:-translate-x-full",
        )}
      >
        <div className="h-12 flex items-center gap-2 px-4 border-b border-line flex-none">
          <div className="grid place-items-center size-6 rounded-md bg-primary text-primary-fg">
            <Icon name="arrow" className="size-3.5" strokeWidth={2.6} />
          </div>
          <b className="font-semibold tracking-[-0.01em] text-[14px]">Wharfline</b>
          <span className="ml-auto text-[10.5px] text-faint border border-line rounded px-1.5 h-[18px] inline-flex items-center">beta</span>
        </div>
        <div className="mx-2 mt-2 mb-1 px-2.5 h-8 rounded-md flex items-center justify-between text-[13px] font-medium hover:bg-hover transition-colors cursor-default">
          <span className="flex items-center gap-2">
            <span className="grid place-items-center size-5 rounded bg-surface border border-line text-[10px] font-semibold">A</span>
            acme
          </span>
          <Icon name="chev" className="size-3.5 text-faint" />
        </div>
        <nav className="flex-1 overflow-auto scroll-soft px-2 pb-3 flex flex-col gap-px">
          {ROUTES.filter((r) => canSee(r.id)).map((r) => {
            const head = r.grp !== lastGrp && r.grp ? <h6 className="mt-4 mb-1 mx-2.5 text-[11px] font-medium text-faint">{r.grp}</h6> : null;
            lastGrp = r.grp;
            return (
              <div key={r.id} className="contents">
                {head}
                <NavLink
                  to={r.path}
                  end
                  className={({ isActive }) =>
                    cx(
                      "group flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] font-medium transition-colors duration-100",
                      isActive ? "bg-surface text-fg border border-line shadow-[0_1px_1px_rgba(0,0,0,.03)]" : "text-muted border border-transparent hover:bg-hover hover:text-fg",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon name={r.icon as IconName} className={cx("size-[15px]", isActive ? "text-accent" : "text-faint group-hover:text-muted")} />
                      {r.label}
                      {counts[r.id] ? <span className="ml-auto text-[11px] text-faint tabular-nums">{counts[r.id]}</span> : null}
                    </>
                  )}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="px-3 py-2.5 flex items-center gap-2.5 border-t border-line">
          <div className="grid place-items-center size-7 rounded-full bg-surface border border-line font-semibold text-[10.5px]">JY</div>
          <div className="flex-1 min-w-0">
            <b className="block font-medium text-[12.5px] leading-tight">
              {session?.me.name} <span className="text-faint font-normal">· {session?.me.role}</span>
            </b>
            <small className="block text-faint text-[11px] truncate">2FA 사용 중</small>
          </div>
          <Button variant="ghost" size="sm" iconOnly icon="logout" title="로그아웃" aria-label="로그아웃" onClick={logout} />
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/30 md:hidden animate-fade" onClick={() => setOpen(false)} />}

      {/* main panel */}
      <div className="flex flex-col min-w-0 min-h-0 bg-canvas">
        <header className="h-12 flex-none flex items-center gap-2 px-4 md:px-6 border-b border-line bg-surface">
          <Button variant="ghost" size="sm" iconOnly icon="menu" aria-label="메뉴" className="md:hidden" onClick={() => setOpen(true)} />
          <div className="text-[13px] text-muted truncate min-w-0">
            acme <span className="text-faint mx-1">/</span> <b className="text-fg font-medium">{route.label}</b>
          </div>
          <div className="flex-1" />
          <SudoTimer />
          <Button variant="ghost" size="sm" iconOnly icon={dark ? "sun" : "moon"} title="테마 전환" aria-label="테마 전환" onClick={toggle} />
          {canSee("jobs") && viewAs !== "Viewer" && (
            <Button
              variant="primary"
              size="sm"
              icon="play"
              className="max-sm:hidden"
              onClick={() => runById("j1")}
            >
              배포 실행
            </Button>
          )}
        </header>
        <main className="flex-1 overflow-auto scroll-soft relative" id="content">
          <div className="max-w-[1180px] mx-auto flex flex-col gap-5 px-4 md:px-8 pt-6 pb-12">
            {viewAs !== "Owner" && <PreviewBar />}
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
      <span>{viewAs} 역할로 미리 보는 중이에요. 사이드바와 화면이 이 역할 기준으로 보여요.</span>
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
