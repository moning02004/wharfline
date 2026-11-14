import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApp, type ModalGuard } from "../lib/app";
import { indentOnTab } from "../lib/indent";
import type { BundleFile } from "../lib/types";
import { ModalFoot, ModalHead, YesNoModal } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Button, Chip, Input, cx } from "../components/ui";
import { diffLines } from "./FileHistoryModal";

export type FileUpdate = (fn: (prev: BundleFile[]) => BundleFile[]) => void;
export type Dropped = { path: string; reason: string }[];

/** Same rules as the server (app/bundles.py): a relative path inside SERVICE_PATH. */
const FILE_PART_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
export function cleanFilePath(raw: string): string | null {
  let p = raw.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("/")) return null;
  const parts = p.split("/").filter(Boolean);
  if (!parts.length || parts.some((x) => x === "." || x === ".." || !FILE_PART_RE.test(x))) return null;
  return parts.join("/");
}
const RISKY_FILE: [RegExp, string][] = [
  [/privileged:\s*true/, "privileged: true"],
  [/docker\.sock/, "docker.sock 마운트"],
  [/network_mode:\s*["']?host/, "network_mode: host"],
  [/pid:\s*["']?host/, "pid: host"],
  [/cap_add:/, "cap_add"],
  [/hostPath:/, "hostPath"],
  [/hostNetwork:\s*true/, "hostNetwork: true"],
  [/hostPID:\s*true/, "hostPID: true"],
];
export const riskyIn = (text: string) => RISKY_FILE.filter(([re]) => re.test(text)).map(([, m]) => m);
export const byteSize = (text: string) => new TextEncoder().encode(text).length;
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const MAX_FILE = 512 * 1024;
const sortFiles = (list: BundleFile[]) => [...list].sort((a, b) => a.path.localeCompare(b.path));

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Upload a single file or a zip: the server unpacks it, a .env inside goes to the env step. */
export function useBundleUpload(update: FileUpdate, onEnv: (vars: string[][]) => void, onDone?: (paths: string[]) => void) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dropped, setDropped] = useState<Dropped>([]);
  const pick = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.post<{ files: BundleFile[]; env: string[][]; dropped: Dropped }>("/bundles/parse", { name: file.name, data: await fileToBase64(file) });
      update((prev) => {
        const byPath = new Map(prev.map((f) => [f.path, f]));
        r.files.forEach((f) => byPath.set(f.path, f)); // same path: the new upload wins
        return sortFiles([...byPath.values()]);
      });
      setDropped(r.dropped);
      onEnv(r.env);
      onDone?.(r.files.map((f) => f.path));
      toast(`파일 ${r.files.length}개를 올렸어요`);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const el = <input ref={input} type="file" hidden accept=".yaml,.yml,.zip,.json,.conf,.sh,Makefile,*" onChange={(e) => pick(e.target.files)} />;
  return { el, busy, dropped, open: () => input.current?.click() };
}

interface Version {
  ver: number;
  createdAt: number;
  createdBy: string;
  changes: { added: string[]; changed: string[]; removed: string[] };
  count: number;
}
const when = (t: number) => new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const NEW = "\u0000new";

/** Textarea with line numbers. No wrapping, so each number stays beside its line. */
function CodeArea({ value, onChange, placeholder, autoFocus, label }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; label: string }) {
  const gutter = useRef<HTMLDivElement>(null);
  const n = value.split("\n").length;
  return (
    <div className="flex flex-1 min-h-0 font-code text-[13px] leading-[1.7]">
      <div ref={gutter} aria-hidden className="select-none overflow-hidden text-right text-faint py-3 pl-3 pr-2.5 pb-10 bg-surface-2 border-r border-line tabular-nums min-w-[3.4em]">
        {Array.from({ length: n }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        aria-label={label}
        wrap="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="flex-1 min-w-0 resize-none outline-none bg-surface text-fg placeholder:text-faint p-3 whitespace-pre overflow-auto scroll-soft"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={indentOnTab}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

/**
 * The job's files as an editor: file list on the left, the open file in the middle, saved versions on the right.
 * Changes go straight into the job form (they reach the server when the job is saved).
 */
export function FileWorkspaceModal({
  jobId,
  initial,
  start,
  update,
  onEnv,
  onSaveJob,
  guard,
  onClose,
}: {
  jobId: string | null;
  initial: BundleFile[];
  start: string | null; // a path to open, NEW for a new file, null for the first file
  update: FileUpdate;
  onEnv: (vars: string[][]) => void;
  onSaveJob?: () => void; // editing a saved job: saves the whole job
  guard?: ModalGuard;
  onClose: () => void;
}) {
  const { toast, openModal } = useApp();
  const [files, setFiles] = useState<BundleFile[]>(initial);
  const mutate: FileUpdate = (fn) => {
    setFiles(fn);
    update(fn);
  };
  const [sel, setSel] = useState<string | null>(start ?? initial[0]?.path ?? NEW);
  const [fresh, setFresh] = useState({ path: "", content: "" });
  const [pathDraft, setPathDraft] = useState("");
  const [pathErr, setPathErr] = useState("");
  const [saved, setSaved] = useState<Map<string, string> | null>(null); // the last saved version, to mark edits
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [ver, setVer] = useState<number | null>(null); // a version being compared, null while editing
  const [verFiles, setVerFiles] = useState<Record<number, BundleFile[]>>({});

  const current = sel === NEW ? fresh : files.find((f) => f.path === sel);
  const pathInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPathDraft(sel === NEW ? fresh.path : sel ?? "");
    setPathErr("");
    if (sel === NEW) pathInput.current?.focus();
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // The saved files: marks what changed, and fills in contents the form hasn't loaded yet.
  useEffect(() => {
    if (!jobId) return;
    api.get<BundleFile[]>(`/jobs/${jobId}/files`).then(
      (full) => {
        setSaved(new Map(full.map((f) => [f.path, f.content ?? ""])));
        if (files.some((f) => f.content === undefined)) {
          const fill = (prev: BundleFile[]) => prev.map((f) => (f.content === undefined ? full.find((x) => x.path === f.path) ?? f : f));
          mutate(fill);
        }
      },
      () => toast("파일 내용을 불러오지 못했어요", "error"),
    );
    api.get<Version[]>(`/jobs/${jobId}/files/history`).then(setVersions, () => setVersions([]));
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobId || ver == null || verFiles[ver]) return;
    api.get<BundleFile[]>(`/jobs/${jobId}/files?ver=${ver}`).then(
      (list) => setVerFiles((m) => ({ ...m, [ver]: list })),
      (e) => toast(errMsg(e), "error"),
    );
  }, [jobId, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useBundleUpload(mutate, onEnv, (paths) => {
    if (paths[0]) {
      setVer(null);
      setSel(paths[0]);
    }
  });

  const mark = (f: BundleFile): "new" | "edited" | null => {
    if (!saved) return jobId ? null : "new";
    if (!saved.has(f.path)) return "new";
    return f.content !== undefined && saved.get(f.path) !== f.content ? "edited" : null;
  };
  const removed = saved ? [...saved.keys()].filter((p) => !files.some((f) => f.path === p)) : [];
  const dirty = !!saved && (removed.length > 0 || files.some((f) => mark(f)));

  // Editing a saved job: closing with unsaved file edits asks whether to save the job now.
  const requestClose = () => {
    if (!jobId || !onSaveJob || !dirty) return onClose();
    openModal(
      (c) => (
        <YesNoModal
          title="수정된 파일이 있습니다. 저장하시겠습니까?"
          onYes={() => {
            c();
            onClose();
            onSaveJob();
          }}
          onNo={() => {
            c();
            onClose();
          }}
        />
      ),
      "sm",
    );
  };
  if (guard) guard.current = requestClose;

  const setContent = (content: string) => {
    if (sel === NEW) return setFresh((f) => ({ ...f, content }));
    mutate((prev) => prev.map((f) => (f.path === sel ? { ...f, content, size: byteSize(content), warnings: undefined } : f)));
  };

  // Rename (or name a new file) when the name field is left or Enter is pressed.
  const commitPath = () => {
    const raw = pathDraft.trim();
    if (sel === NEW && !raw) return;
    const p = cleanFilePath(raw);
    if (!p) return setPathErr("docker-compose.yaml이나 k8s/01_namespace.yaml처럼 적어 주세요. /로 시작하거나 ..은 쓸 수 없어요.");
    if (p.split("/").pop() === ".env") return setPathErr(".env는 파일로 두지 않아요. 환경 변수 단계에 넣어 주세요.");
    if (p === sel) return (setPathDraft(p), setPathErr(""));
    if (files.some((f) => f.path === p)) return setPathErr(`${p}이(가) 이미 있어요.`);
    setPathErr("");
    if (sel === NEW) {
      mutate((prev) => sortFiles([...prev, { path: p, content: fresh.content, size: byteSize(fresh.content) }]));
      setFresh({ path: "", content: "" });
    } else {
      mutate((prev) => sortFiles(prev.map((f) => (f.path === sel ? { ...f, path: p } : f))));
    }
    setSel(p);
  };

  const remove = () => {
    if (sel === NEW) {
      setFresh({ path: "", content: "" });
      setSel(files[0]?.path ?? NEW);
      return;
    }
    const idx = files.findIndex((f) => f.path === sel);
    const rest = files.filter((f) => f.path !== sel);
    mutate((prev) => prev.filter((f) => f.path !== sel));
    setSel(rest[Math.min(idx, rest.length - 1)]?.path ?? NEW);
  };

  const restore = (path: string, content: string) => {
    mutate((prev) => sortFiles([...prev.filter((f) => f.path !== path), { path, content, size: byteSize(content) }]));
    setVer(null);
    setSel(path);
    toast(`${path}을(를) 되돌렸어요`);
  };

  const content = current?.content ?? "";
  const risky = riskyIn(content);
  const size = byteSize(content);
  const compare = ver != null ? verFiles[ver] : undefined;
  const oldFile = compare?.find((f) => f.path === sel);
  const verOnly = compare?.filter((f) => !files.some((x) => x.path === f.path)) ?? [];
  const diff = useMemo(() => (oldFile && current ? diffLines(oldFile.content ?? "", current.content ?? "") : null), [oldFile, current]);

  return (
    <>
      <ModalHead title="파일 편집기" onClose={requestClose} />
      <div className="flex-1 min-h-0 overflow-auto lg:overflow-hidden grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)_270px] gap-3 p-3 bg-canvas">
        {/* files */}
        <aside aria-label="파일 목록" className="flex flex-col min-h-0 max-lg:max-h-[240px] rounded-xl bg-surface shadow-soft overflow-hidden">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-line">
            <span className="text-[12px] font-semibold text-muted mr-auto">파일 {files.length}</span>
            {upload.el}
            <Button size="sm" variant="ghost" iconOnly icon="upload" aria-label="올리기" title="올리기 (zip도 돼요)" disabled={upload.busy} onClick={upload.open} />
            <Button size="sm" variant="ghost" iconOnly icon="plus" aria-label="새 파일" title="새 파일" onClick={() => (setVer(null), setSel(NEW))} />
          </div>
          <div className="flex-1 min-h-0 overflow-auto scroll-soft p-1.5 flex flex-col gap-0.5">
            {files.map((f) => {
              const m = mark(f);
              const warn = f.content !== undefined ? riskyIn(f.content).length > 0 : !!f.warnings?.length;
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setSel(f.path)}
                  title={f.path}
                  className={cx(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-mono transition-colors min-w-0",
                    sel === f.path ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  <Icon name="file" className={cx("size-3.5 flex-none", sel === f.path ? "text-accent" : "text-faint")} />
                  <span className="truncate flex-1">{f.path}</span>
                  {warn && <span title="서버 권한을 넘기는 설정" className="size-1.5 rounded-full bg-warn flex-none" />}
                  {m && <span className={cx("text-[10.5px] font-sans font-semibold flex-none", m === "new" ? "text-ok" : "text-[var(--mark)]")}>{m === "new" ? "새" : "수정"}</span>}
                </button>
              );
            })}
            {sel === NEW && (
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-mono bg-accent-soft">
                <Icon name="file" className="size-3.5 flex-none text-accent" />
                <span className="truncate flex-1 text-faint">{fresh.path || pathDraft || "새 파일"}</span>
              </div>
            )}
            {removed.map((p) => (
              <div key={p} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-mono text-faint">
                <Icon name="file" className="size-3.5 flex-none" />
                <span className="truncate flex-1 line-through">{p}</span>
                <button type="button" className="font-sans text-[11px] text-accent hover:underline" onClick={() => restore(p, saved!.get(p) ?? "")}>
                  되돌리기
                </button>
              </div>
            ))}
            {files.length === 0 && sel !== NEW && <span className="p-2 text-[12.5px] text-faint">파일이 없어요.</span>}
          </div>
          {upload.dropped.length > 0 && <p className="px-3 py-2 border-t border-line text-[11.5px] text-muted">빠진 파일: {upload.dropped.map((d) => `${d.path} (${d.reason})`).join(", ")}</p>}
        </aside>

        {/* editor or comparison */}
        <section className="flex flex-col min-h-[420px] lg:min-h-0 min-w-0 rounded-xl bg-surface shadow-lift overflow-hidden">
          {ver != null ? (
            <>
              <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-b border-line">
                <span className="font-mono text-[12.5px] truncate">{sel === NEW ? "새 파일" : sel}</span>
                <span className="text-[12px] text-muted">
                  <b className="text-fg">v{ver}</b> → 지금
                </span>
                <span className="ml-auto flex gap-1">
                  {oldFile && sel !== NEW && oldFile.content !== content && (
                    <Button size="sm" icon="undo" onClick={() => restore(oldFile.path, oldFile.content ?? "")}>
                      v{ver} 내용으로 되돌리기
                    </Button>
                  )}
                  <Button size="sm" variant="primary" icon="edit" onClick={() => setVer(null)}>
                    편집으로
                  </Button>
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto scroll-soft bg-surface font-code text-[12.5px] leading-[1.7] py-2">
                {!compare ? (
                  <p className="px-4 text-muted font-sans text-[12.5px]">불러오는 중…</p>
                ) : !oldFile ? (
                  <p className="px-4 text-muted font-sans text-[12.5px]">v{ver}에는 이 파일이 없어요.</p>
                ) : diff === null ? (
                  <pre className="m-0 px-4 whitespace-pre">{oldFile.content}</pre>
                ) : diff.every((d) => d.t === " ") ? (
                  <p className="px-4 text-muted font-sans text-[12.5px]">v{ver}와 내용이 같아요.</p>
                ) : (
                  diff.map((d, i) => (
                    <div key={i} className={cx("px-4 whitespace-pre", d.t === "+" && "bg-ok-soft text-ok", d.t === "-" && "bg-bad-soft text-bad")}>
                      {d.t} {d.s}
                    </div>
                  ))
                )}
              </div>
            </>
          ) : current ? (
            <>
              <div className="flex items-start gap-2 px-4 py-2 border-b border-line">
                <div className="flex-1 min-w-0">
                  <Input
                    ref={pathInput}
                    mono
                    aria-label="파일 이름"
                    placeholder="docker-compose.yaml"
                    className="h-7 border-transparent shadow-none bg-transparent hover:border-line focus:border-line-strong"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    onBlur={commitPath}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commitPath())}
                  />
                  {pathErr && <p className="mt-1 text-[11.5px] text-bad">{pathErr}</p>}
                  {sel === NEW && !pathErr && <p className="mt-1 text-[11.5px] text-muted">이름을 적고 Enter를 누르면 목록에 들어가요.</p>}
                </div>
                <Button size="sm" variant="dangerGhost" icon="trash" onClick={remove}>
                  {sel === NEW ? "취소" : "제거"}
                </Button>
              </div>
              <CodeArea
                key={sel ?? ""}
                label="파일 내용"
                value={content}
                onChange={setContent}
                autoFocus={sel !== NEW}
                placeholder={"services:\n  app:\n    image: ghcr.io/acme/api:${API_TAG}\n    env_file: .env\n    restart: unless-stopped"}
              />
              <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-t border-line bg-surface-2 text-[11.5px] text-muted">
                <span>
                  {content.split("\n").length}줄 · <span className={cx(size > MAX_FILE && "text-bad font-semibold")}>{fmtSize(size)}</span>
                  {size > MAX_FILE && " · 512KB까지예요"}
                </span>
                {risky.length > 0 && <Chip tone="warn">서버 권한을 넘기는 설정: {risky.join(", ")}</Chip>}
                <span className="ml-auto">Tab 들여쓰기 · Shift+Tab 내어쓰기</span>
              </div>
            </>
          ) : null}
        </section>

        {/* versions */}
        <aside aria-label="버전 기록" className="flex flex-col min-h-0 max-lg:max-h-[300px] rounded-xl bg-surface shadow-soft overflow-hidden">
          <div className="px-3 py-2 border-b border-line text-[12px] font-semibold text-muted">버전 기록</div>
          <div className="flex-1 min-h-0 overflow-auto scroll-soft p-1.5 flex flex-col gap-0.5">
            {!jobId && <p className="p-2 text-[12.5px] text-faint">작업을 저장하면 그때부터 버전이 남아요.</p>}
            {jobId && versions === null && <p className="p-2 text-[12.5px] text-muted">불러오는 중…</p>}
            {jobId && versions?.length === 0 && <p className="p-2 text-[12.5px] text-faint">아직 저장된 버전이 없어요.</p>}
            {dirty && (
              <button type="button" onClick={() => setVer(null)} className={cx("text-left rounded-lg px-2.5 py-2 text-[12.5px] transition-colors", ver == null ? "bg-accent-soft" : "hover:bg-hover")}>
                <b className={cx("font-semibold", ver == null && "text-accent")}>편집 중</b>
                <span className="block text-[11.5px] text-muted">작업을 저장하면 새 버전이 돼요</span>
              </button>
            )}
            {versions?.map((v, i) => {
              const c = v.changes;
              const touch = sel && sel !== NEW ? (c.added.includes(sel) ? "추가" : c.changed.includes(sel) ? "변경" : c.removed.includes(sel) ? "삭제" : null) : null;
              const active = v.ver === ver;
              return (
                <div key={v.ver} className={cx("rounded-lg transition-colors", active ? "bg-accent-soft" : "hover:bg-hover")}>
                  <button type="button" onClick={() => setVer(active ? null : v.ver)} className="w-full text-left px-2.5 py-2 text-[12.5px]">
                    <span className="flex items-center gap-1.5">
                      <b className={cx("font-semibold", active && "text-accent")}>v{v.ver}</b>
                      {i === 0 && <Chip>저장됨</Chip>}
                      {touch && (
                        <Chip tone={touch === "추가" ? "ok" : touch === "삭제" ? "bad" : "warn"} className="ml-auto">
                          {touch}
                        </Chip>
                      )}
                    </span>
                    <span className="block text-muted truncate">
                      {when(v.createdAt)} · {v.createdBy}
                    </span>
                    <span className="block text-[11.5px] text-faint">
                      {[c.added.length && `+${c.added.length}`, c.changed.length && `~${c.changed.length}`, c.removed.length && `-${c.removed.length}`].filter(Boolean).join(" ")}
                      {(c.added.length || c.changed.length || c.removed.length) ? " · " : ""}파일 {v.count}개
                    </span>
                  </button>
                  {active && verOnly.length > 0 && (
                    <div className="px-2.5 pb-2 flex flex-col gap-1">
                      <span className="text-[11px] text-muted">지금은 없는 파일</span>
                      {verOnly.map((f) => (
                        <span key={f.path} className="flex items-center gap-2 text-[12px] font-mono">
                          <span className="truncate flex-1">{f.path}</span>
                          <button type="button" className="font-sans text-[11px] text-accent hover:underline flex-none" onClick={() => restore(f.path, f.content ?? "")}>
                            되살리기
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      </div>
      <ModalFoot>
        <Button variant="primary" onClick={requestClose}>
          완료
        </Button>
      </ModalFoot>
    </>
  );
}

export { NEW as NEW_FILE };
