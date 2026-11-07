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
      className="inline-flex items-center gap-1.5 h-[30px] pl-3 pr-1 rounded-full whitespace-nowrap flex-none bg-warn-soft text-warn text-xs font-medium shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warn)_28%,transparent)] animate-fade"
    >
      <Icon name="unlock" className="size-[14px]" />
      <span className="tabular-nums">
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <button
        className="px-2.5 py-1 rounded-full text-[11.5px] hover:bg-warn/15 transition-colors"
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
    <div className="grid h-full md:grid-cols-[248px_minmax(0,1fr)]">
      {/* sidebar */}
      <aside
        className={cx(
          "flex flex-col min-h-0 bg-bg z-30",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[272px] max-md:shadow-pop max-md:transition-transform max-md:duration-300 max-md:ease-(--ease-soft)",
          !open && "max-md:-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3.5">
          <div className="grid place-items-center size-8 rounded-[11px] bg-primary text-primary-fg shadow-[0_4px_12px_-4px_rgba(0,0,0,.4)]">
            <Icon name="arrow" className="size-4" strokeWidth={2.4} />
          </div>
          <div>
            <b className="font-semibold tracking-[-0.02em] text-[15px]">Wharfline</b>
            <small className="block text-faint text-[11px] leading-tight">셀프호스팅 배포 · 프로토타입</small>
          </div>
        </div>
        <div className="mx-3 mb-2 px-3 py-2 rounded-xl flex items-center justify-between text-[13px] font-medium text-muted hover:bg-hover transition-colors">
          <span>acme 워크스페이스</span>
          <Icon name="chev" className="size-3.5 text-faint" />
        </div>
        <nav className="flex-1 overflow-auto scroll-soft px-3 pb-3 flex flex-col gap-0.5">
          {ROUTES.filter((r) => canSee(r.id)).map((r) => {
            const head = r.grp !== lastGrp && r.grp ? <h6 className="mt-4 mb-1.5 mx-3 text-[11px] font-medium text-faint tracking-wide">{r.grp}</h6> : null;
            lastGrp = r.grp;
            return (
              <div key={r.id} className="contents">
                {head}
                <NavLink
                  to={r.path}
                  end
                  className={({ isActive }) =>
                    cx(
                      "group flex items-center gap-2.5 px-3 py-[7px] rounded-xl text-[13.5px] font-medium transition-all duration-200 ease-(--ease-soft)",
                      isActive ? "bg-surface text-fg shadow-soft" : "text-muted hover:bg-hover hover:text-fg hover:translate-x-0.5",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon name={r.icon as IconName} className={cx("size-4", isActive && "text-accent")} />
                      {r.label}
                      {counts[r.id] ? <span className="ml-auto text-[11.5px] text-faint tabular-nums">{counts[r.id]}</span> : null}
                    </>
                  )}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="m-2 mt-0 px-3 py-3 flex items-center gap-2.5 rounded-2xl">
          <div className="grid place-items-center size-8 rounded-full bg-gradient-to-br from-accent-soft to-surface-2 shadow-[inset_0_0_0_1px_var(--border)] font-semibold text-[11px]">JY</div>
          <div className="flex-1 min-w-0">
            <b className="block font-medium text-[13px]">
              {session?.me.name} ({session?.me.role})
            </b>
            <small className="block text-faint text-[11.5px] truncate">moning·· · 2FA 사용 중</small>
          </div>
          <Button variant="ghost" iconOnly icon="logout" title="로그아웃" aria-label="로그아웃" onClick={logout} />
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/20 backdrop-blur-[2px] md:hidden animate-fade" onClick={() => setOpen(false)} />}

      {/* main panel */}
      <div className="flex flex-col min-w-0 min-h-0 bg-canvas md:my-2 md:mr-2 md:rounded-[22px] md:shadow-soft overflow-hidden relative">
        <div className="pointer-events-none absolute -top-40 right-0 size-[520px] rounded-full bg-accent/[.05] blur-3xl" />
        <header className="h-14 flex-none flex items-center gap-2.5 px-4 md:px-6 border-b border-line bg-canvas/80 backdrop-blur-md relative z-10">
          <Button variant="ghost" iconOnly icon="menu" aria-label="메뉴" className="md:hidden" onClick={() => setOpen(true)} />
          <div className="text-sm font-medium text-muted truncate min-w-0">
            acme <span className="text-faint">/</span> <b className="text-fg font-semibold">{route.label}</b>
          </div>
          <div className="flex-1" />
          <SudoTimer />
          <Button variant="ghost" iconOnly icon={dark ? "sun" : "moon"} title="테마 전환" aria-label="테마 전환" onClick={toggle} />
          {canSee("jobs") && viewAs !== "Viewer" && (
            <Button
              variant="primary"
              icon="play"
              className="max-sm:hidden"
              onClick={() => runById("j1")}
            >
              배포 실행
            </Button>
          )}
        </header>
        <main className="flex-1 overflow-auto scroll-soft relative" id="content">
          <div className="max-w-[1120px] mx-auto flex flex-col gap-6 px-4 md:px-8 pt-6 md:pt-8 pb-12">
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
    <div className="flex items-center justify-between gap-3 flex-wrap pl-5 pr-2 py-2 rounded-full bg-accent-soft text-accent text-[13px] font-medium animate-rise">
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
    <div className="bg-surface rounded-[20px] shadow-soft py-20 px-6 text-center flex flex-col items-center gap-2">
      <div className="grid place-items-center size-12 rounded-2xl bg-surface-2 text-faint mb-2">
        <Icon name="lock" className="size-5" />
      </div>
      <h2 className="m-0 text-[17px] font-semibold tracking-[-0.02em]">이 메뉴를 볼 권한이 없어요</h2>
      <p className="m-0 text-muted max-w-[44ch]">
        {viewAs} 역할에는 "{label}" 메뉴가 꺼져 있어요. 필요하면 워크스페이스 관리자에게 요청하세요.
      </p>
      <Button size="sm" className="mt-2" onClick={() => nav("/")}>
        대시보드로 가기
      </Button>
    </div>
  );
}
