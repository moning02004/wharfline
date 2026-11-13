import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, errMsg, setViewAsHeader, SIGNED_OUT_EVENT } from "./api";
import type { Member, Role, Session } from "./types";
import { ModalShell, type ModalSize } from "../components/Modal";
import { SudoModal } from "../modals/SudoModal";
import { Icon } from "../components/Icon";
import { TOAST_ERROR_EVENT, cx } from "../components/ui";

export const ROUTES = [
  { id: "dashboard", path: "/", label: "대시보드", icon: "home", grp: "" },
  { id: "jobs", path: "/jobs", label: "배포 작업", icon: "rocket", grp: "배포" },
  { id: "runs", path: "/runs", label: "실행 기록", icon: "history", grp: "배포" },
  { id: "registries", path: "/registries", label: "이미지 레지스트리", icon: "box", grp: "리소스" },
  { id: "repos", path: "/repos", label: "플레이북 레포", icon: "git", grp: "리소스" },
  { id: "inventory", path: "/inventory", label: "인벤토리", icon: "server", grp: "리소스" },
  { id: "keys", path: "/keys", label: "키 저장소", icon: "key", grp: "리소스" },
  { id: "envs", path: "/envs", label: "환경 변수", icon: "file", grp: "리소스" },
  { id: "activity", path: "/activity", label: "활동 기록", icon: "list", grp: "관리" },
  { id: "members", path: "/members", label: "멤버와 권한", icon: "users", grp: "관리" },
  { id: "security", path: "/security", label: "보안", icon: "shield", grp: "관리" },
  { id: "notify", path: "/notify", label: "배포 알림", icon: "bell", grp: "관리" },
  { id: "notes", path: "/notes", label: "설계 노트", icon: "note", grp: "프로토타입" },
] as const;
export type RouteId = (typeof ROUTES)[number]["id"];
export const ROLES: Role[] = ["Owner", "Admin", "Deployer", "Viewer"];

/** What each role may do. Mirrors the server's store.PERMS; the server is what enforces it. */
const PERMS = {
  run: ["Owner", "Admin", "Deployer"],
  run_protected: ["Owner", "Admin"],
  job_create: ["Owner", "Admin", "Deployer"],
  job_edit: ["Owner", "Admin", "Deployer"],
  approve: ["Owner", "Admin"],
  env: ["Owner", "Admin"],
  resources: ["Owner", "Admin"],
  admin: ["Owner"],
} satisfies Record<string, Role[]>;
export type Action = keyof typeof PERMS;
export const roleCan = (role: Role, action: Action) => (PERMS[action] as Role[]).includes(role);

type ModalRender = (close: () => void) => ReactNode;
interface ModalEntry {
  id: number;
  size: ModalSize;
  render: ModalRender;
  onClose?: () => void;
}

interface Toast {
  id: number;
  msg: string;
  tone: ToastTone;
}
export type ToastTone = "info" | "error";

interface AppCtx {
  session: Session | null;
  setSession: (s: Session) => void;
  sudoActive: boolean;
  endSudo: () => Promise<void>;
  /** Runs fn after a password re-check (skipped while sudo is active). Retries once if the server asks again. */
  /** Runs fn after the password re-check. `always` asks even while a recent check is still valid. */
  withSudo: (reason: string, fn: () => unknown | Promise<unknown>, opts?: { always?: boolean }) => void;
  /** Member an Owner is previewing as; null shows my own view. */
  viewAs: Member | null;
  setViewAs: (m: Member | null) => void;
  /** Role of whoever is being shown (me, or the previewed member). */
  role: Role;
  /** Menus from my groups (or the previewed member's); null means all. */
  menus: string[] | null;
  reloadAccess: () => void;
  canSee: (id: string) => boolean;
  /** Whether the shown role (mine, or the previewed member's) may do `action`. Buttons follow this. */
  can: (action: Action) => boolean;
  toast: (msg: string, tone?: ToastTone) => void;
  openModal: (render: ModalRender, size?: ModalSize, onClose?: () => void) => void;
  closeModal: () => void;
  /** Bumped after any mutation, and when the server says data changed (/api/events), so pages refetch. */
  version: number;
  /** The change stream is connected: polls only re-render (for "N초째"), the stream brings new data. */
  live: boolean;
  refresh: () => void;
  runAction: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}

const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [now, setNow] = useState(Date.now());
  const [viewAs, setViewAsState] = useState<Member | null>(null);
  const [access, setAccess] = useState<{ menus: string[] | null; role: Role | null }>({ menus: [], role: null });
  const [accessSeq, setAccessSeq] = useState(0);
  const reloadAccess = useCallback(() => setAccessSeq((x) => x + 1), []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modals, setModals] = useState<ModalEntry[]>([]);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const load = () => api.get<Session>("/auth/me").then(setSession).catch(() => setSession({ loggedIn: false } as Session));
    load();
    window.addEventListener(SIGNED_OUT_EVENT, load);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, load);
  }, []);

  useEffect(() => {
    if (session?.loggedIn) api.get<{ menus: string[] | null; role: Role | null }>("/access").then(setAccess).catch(() => {});
  }, [session?.loggedIn, session?.me?.email, viewAs, accessSeq]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sudoActive = !!session && now < session.sudoUntil;

  const toast = useCallback((msg: string, tone: ToastTone = "info") => {
    const id = ++seq.current;
    // Only the latest error stays: an older one is usually already fixed.
    setToasts((t) => [...t.filter((x) => x.msg !== msg && !(tone === "error" && x.tone === "error")), { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 4500 : 2800);
  }, []);
  // <ErrorText> anywhere shows its message as an error toast (see components/ui.tsx).
  useEffect(() => {
    const on = (e: Event) => toast((e as CustomEvent<string>).detail, "error");
    window.addEventListener(TOAST_ERROR_EVENT, on);
    return () => window.removeEventListener(TOAST_ERROR_EVENT, on);
  }, [toast]);

  const openModal = useCallback((render: ModalRender, size: ModalSize = "sm", onClose?: () => void) => {
    setModals((m) => [...m, { id: ++seq.current, size, render, onClose }]);
  }, []);

  const modalsRef = useRef(modals);
  modalsRef.current = modals;
  const closeModal = useCallback(() => {
    modalsRef.current[modalsRef.current.length - 1]?.onClose?.();
    setModals((m) => m.slice(0, -1));
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Webhooks, runs and other members' edits arrive as notices; the page refetches through the normal API.
  // Notices close together refetch once; a hidden tab refetches when it is shown again.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!session?.loggedIn || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let timer = 0;
    let retry = 0;
    let missed = false;
    const kick = () => {
      if (document.hidden) {
        missed = true;
        return;
      }
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 250);
    };
    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setLive(true);
      es.onmessage = (e) => {
        try {
          if ((JSON.parse(e.data) as { topics?: string[] }).topics?.length) kick();
        } catch {
          /* not a notice */
        }
      };
      es.onerror = () => {
        setLive(false);
        // The browser reconnects by itself after a dropped connection; a refused one (signed out, server down) is
        // closed for good, so try again later.
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = window.setTimeout(open, 15000);
        }
      };
    };
    const onShow = () => {
      if (!document.hidden && missed) {
        missed = false;
        refresh();
      }
    };
    open();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearTimeout(timer);
      clearTimeout(retry);
      es?.close();
      setLive(false);
    };
  }, [session?.loggedIn, session?.me?.email, refresh]);

  const setViewAs = useCallback(
    (m: Member | null) => {
      setViewAsHeader(m?.email ?? null);
      setViewAsState(m);
      refresh(); // pages refetch, so builds follow the previewed member's groups
    },
    [refresh],
  );

  // Leaving the session (logout, another member signs in) ends any preview.
  useEffect(() => {
    setViewAsHeader(null);
    setViewAsState(null);
  }, [session?.me?.email]);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const withSudo = useCallback(
    (reason: string, fn: () => unknown | Promise<unknown>, opts?: { always?: boolean }) => {
      const run = async () => {
        try {
          await fn();
        } catch (e) {
          if (e instanceof ApiError && e.sudoRequired) ask();
          else toast(errMsg(e));
        }
      };
      const ask = () =>
        openModal(
          (close) => (
            <SudoModal
              reason={reason}
              minutes={sessionRef.current?.sudoMinutes ?? 5}
              always={opts?.always}
              onClose={close}
              onDone={(s) => {
                setSession(s);
                close();
                run();
              }}
            />
          ),
          "sm",
        );
      const s = sessionRef.current;
      if (s && Date.now() < s.sudoUntil && !opts?.always) run();
      else ask();
    },
    [openModal, toast],
  );

  const endSudo = useCallback(async () => {
    setSession(await api.del<Session>("/auth/sudo"));
  }, []);

  const role: Role = viewAs?.role ?? access.role ?? session?.me?.role ?? "Viewer";
  const canSee = useCallback((id: string) => id === "dashboard" || access.menus === null || access.menus.includes(id), [access]);
  const can = useCallback((action: Action) => roleCan(role, action), [role]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) toast(ok);
        refresh();
        return true;
      } catch (e) {
        toast(errMsg(e));
        return false;
      }
    },
    [refresh, toast],
  );

  const value = useMemo<AppCtx>(
    () => ({
      session, setSession, sudoActive, endSudo, withSudo, viewAs, setViewAs, role, menus: access.menus, reloadAccess, canSee, can,
      toast, openModal, closeModal, version, live, refresh, runAction,
    }),
    [session, sudoActive, endSudo, withSudo, viewAs, setViewAs, role, access, reloadAccess, canSee, can, toast, openModal, closeModal, version, live, refresh, runAction],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {modals.map((m, i) => (
        <ModalShell key={m.id} size={m.size} onClose={closeModal} top={i === modals.length - 1}>
          {m.render(closeModal)}
        </ModalShell>
      ))}
      <div className="fixed inset-x-0 bottom-[max(16px,env(safe-area-inset-bottom))] z-[80] flex flex-col items-center gap-2 px-4 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cx(
              "flex items-start gap-2 px-3.5 py-2.5 rounded-lg text-[13px] font-medium shadow-pop animate-rise max-w-[360px]",
              t.tone === "error" ? "bg-bad text-white" : "bg-primary text-primary-fg",
            )}
          >
            {t.tone === "error" && <Icon name="alert" className="size-4 flex-none mt-px" />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Fetch helper that refetches whenever the app version bumps. While `pollMs` is set it refetches that often, or,
 * with the change stream connected (new data comes through it), only re-renders so times like "N초째" move. */
export function useApi<T>(path: string | null, pollMs = 0) {
  const { version, live } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState(0);
  const [, setTick] = useState(0);
  const reload = useCallback(() => setLocal((x) => x + 1), []);
  useEffect(() => {
    if (!path || !pollMs) return;
    const t = setInterval(live ? () => setTick((x) => x + 1) : reload, live ? Math.min(pollMs, 1000) : pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, live, reload]);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api
      .get<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [path, version, local]);
  return { data, error, reload, setData };
}
