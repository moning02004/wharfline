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
import { api, ApiError, errMsg, setViewAsHeader } from "./api";
import type { Member, Role, Session } from "./types";
import { ModalShell, type ModalSize } from "../components/Modal";
import { SudoModal } from "../modals/SudoModal";

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
  { id: "notes", path: "/notes", label: "설계 노트", icon: "note", grp: "프로토타입" },
] as const;
export type RouteId = (typeof ROUTES)[number]["id"];
export const ROLES: Role[] = ["Owner", "Admin", "Deployer", "Viewer"];

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
}

interface AppCtx {
  session: Session | null;
  setSession: (s: Session) => void;
  sudoActive: boolean;
  endSudo: () => Promise<void>;
  /** Runs fn after a password re-check (skipped while sudo is active). Retries once if the server asks again. */
  withSudo: (reason: string, fn: () => unknown | Promise<unknown>) => void;
  /** Member an Owner is previewing as; null shows my own view. */
  viewAs: Member | null;
  setViewAs: (m: Member | null) => void;
  /** Role of whoever is being shown (me, or the previewed member). */
  role: Role;
  /** Menus from my groups (or the previewed member's); null means all. */
  menus: string[] | null;
  reloadAccess: () => void;
  canSee: (id: string) => boolean;
  toast: (msg: string) => void;
  openModal: (render: ModalRender, size?: ModalSize, onClose?: () => void) => void;
  closeModal: () => void;
  /** Bumped after any mutation so pages refetch. */
  version: number;
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
    api.get<Session>("/auth/me").then(setSession).catch(() => setSession({ loggedIn: false } as Session));
  }, []);

  useEffect(() => {
    if (session?.loggedIn) api.get<{ menus: string[] | null; role: Role | null }>("/access").then(setAccess).catch(() => {});
  }, [session?.loggedIn, session?.me?.email, viewAs, accessSeq]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sudoActive = !!session && now < session.sudoUntil;

  const toast = useCallback((msg: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

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
    (reason: string, fn: () => unknown | Promise<unknown>) => {
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
      if (s && Date.now() < s.sudoUntil) run();
      else ask();
    },
    [openModal, toast],
  );

  const endSudo = useCallback(async () => {
    setSession(await api.del<Session>("/auth/sudo"));
  }, []);

  const role: Role = viewAs?.role ?? access.role ?? session?.me?.role ?? "Viewer";
  const canSee = useCallback((id: string) => id === "dashboard" || access.menus === null || access.menus.includes(id), [access]);

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
      session, setSession, sudoActive, endSudo, withSudo, viewAs, setViewAs, role, menus: access.menus, reloadAccess, canSee,
      toast, openModal, closeModal, version, refresh, runAction,
    }),
    [session, sudoActive, endSudo, withSudo, viewAs, setViewAs, role, access, reloadAccess, canSee, toast, openModal, closeModal, version, refresh, runAction],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {modals.map((m, i) => (
        <ModalShell key={m.id} size={m.size} onClose={closeModal} top={i === modals.length - 1}>
          {m.render(closeModal)}
        </ModalShell>
      ))}
      <div className="fixed right-4 bottom-4 z-[80] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="bg-primary text-primary-fg px-3.5 py-2 rounded-lg text-[13px] font-medium shadow-pop animate-rise max-w-[340px]">
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Fetch helper that refetches whenever the app version bumps, and every `pollMs` while it is set. */
export function useApi<T>(path: string | null, pollMs = 0) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState(0);
  const reload = useCallback(() => setLocal((x) => x + 1), []);
  useEffect(() => {
    if (!path || !pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, reload]);
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
