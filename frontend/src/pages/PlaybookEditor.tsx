import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { BundleFile, Inventory, Job, Key, PlaybookInfo, PlayVarInfo, Repo } from "../lib/types";
import { GroupSelect } from "../components/GroupSelect";
import { FileTree } from "../components/FileTree";
import { readEntry, skipPath, toBase64 } from "../lib/folder";
import { Icon } from "../components/Icon";
import { NewHostModal, NewInventoryModal, NewKeyModal } from "../modals/ResourceModals";
import { Banner, Button, Card, CardHeader, Chip, ErrorText, Field, Hint, Input, Loading, PageHeader, Select, Seg, Switch, Textarea, cx } from "../components/ui";

/*
 * 플레이북 추가: bring an Ansible playbook (a folder, zip or .yml, or a Git repo), and Wharfline reads what it
 * needs. Every variable the playbook reads but never sets becomes a labelled field: required or not, its
 * default, hidden when it looks like a password, a switch when it is yes/no, with the playbook's own comment
 * as the explanation. Nobody has to know which values are "variables" or "secrets".
 */

type From = "upload" | "git";
type Mode = "new" | "edit" | "copy";
type Dropped = { path: string; reason: string };
type ParseResult = { files: BundleFile[]; dropped: Dropped[]; warnings: { path: string; message: string }[]; playbooks: string[] };
type GitResult = { commit: string; playbooks: string[]; inspect: Record<string, PlaybookInfo> };
/** A variable the member adds by hand (one the playbook reads in a way Wharfline could not see). */
type Extra = { id: number; name: string; value: string; secret: boolean; saved: boolean };

const NO_KEY = "";
const MAX_FOLDER_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const isSsh = (url: string) => /^(git@|ssh:\/\/)/.test(url.trim());
let seq = 0;

const baseName = (p: string) => p.split("/").pop()!.replace(/\.ya?ml$/, "");

export function PlaybookEditor({ mode, job, onClose }: { mode: Mode; job?: Job; onClose: () => void }) {
  const { toast, refresh, openModal, withSudo, can } = useApp();
  const nav = useNavigate();
  const editing = mode === "edit" && !!job;
  const copying = mode === "copy" && !!job;
  const fixedSafety = !can("run_protected");
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const keys = useApi<Key[]>("/keys").data ?? [];
  const reposRes = useApi<Repo[]>("/repos");
  const repos = (reposRes.data ?? []).filter((r) => r.kind === "git");

  const pb = job?.playbook;
  const [from, setFrom] = useState<From>(pb && pb.kind !== "upload" ? "git" : "upload");
  // upload
  const [files, setFiles] = useState<BundleFile[] | null>(job ? null : []);
  const [filesChanged, setFilesChanged] = useState(false);
  const [dropped, setDropped] = useState<Dropped[]>([]);
  const [books, setBooks] = useState<string[]>(pb ? [pb.path] : []);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // git
  const [url, setUrl] = useState(pb && pb.kind !== "upload" ? pb.url : "");
  const [branch, setBranch] = useState(pb && pb.kind !== "upload" ? pb.branch : "main");
  const [key, setKey] = useState(NO_KEY);
  const [git, setGit] = useState<GitResult | null>(null);
  // both
  const [book, setBook] = useState(pb?.path ?? "");
  const [info, setInfo] = useState<PlaybookInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(job?.playVars ?? []));
  const savedSecrets = useMemo(() => new Set(editing || copying ? job!.secretVarNames : []), [editing, copying, job]);
  const [cleared, setCleared] = useState<Set<string>>(new Set()); // saved secrets the member chose to remove
  const [extras, setExtras] = useState<Extra[]>([]);
  const [gitFailed, setGitFailed] = useState(false); // a saved Git job whose repo couldn't be read just now
  const [showAuto, setShowAuto] = useState(false);
  const [inv, setInv] = useState(job?.inventory ?? "");
  const [targets, setTargets] = useState<string[]>(job ? [...job.targets] : []);
  const [name, setName] = useState(copying ? `${job!.name} 복사본` : job?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!job);
  const [prot, setProt] = useState(job ? job.protected : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!inv && inventories[0]) setInv(inventories[0].name);
  }, [inventories, inv]);
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, [from]);

  // Editing or copying an uploaded playbook: load its files once, then read what it needs.
  useEffect(() => {
    if (!job || pb?.kind !== "upload" || files !== null) return;
    api.get<BundleFile[]>(`/jobs/${job.id}/files`).then(
      (fs) => setFiles(fs),
      (e) => setErr(`파일을 불러오지 못했어요: ${errMsg(e)}`),
    );
  }, [job, pb, files]);

  // Read the chosen playbook: from the upload (server reads the files we send) or from the Git result.
  useEffect(() => {
    if (!book) return setInfo(null);
    if (from === "git") return setInfo(git?.inspect[book] ?? null);
    if (!files?.length) return;
    let live = true;
    setInspecting(true);
    api.post<PlaybookInfo>("/playbooks/inspect", { files: files.map((f) => ({ path: f.path, content: f.content ?? "" })), book }).then(
      (r) => live && setInfo(r),
      (e) => live && toast(errMsg(e), "error"),
    ).finally(() => live && setInspecting(false));
    return () => {
      live = false;
    };
  }, [book, from, files, git]); // eslint-disable-line react-hooks/exhaustive-deps

  // Variables saved on the job that the playbook doesn't name (added by hand before): keep them as extra rows.
  useEffect(() => {
    if (!job || extras.length || (!info && !gitFailed)) return;
    const known = new Set(info?.vars.map((v) => v.name) ?? []);
    const rows: Extra[] = [
      ...job.playVars.filter(([n]) => !known.has(n)).map(([n, v]) => ({ id: ++seq, name: n, value: v, secret: false, saved: false })),
      ...job.secretVarNames.filter((n) => !known.has(n)).map((n) => ({ id: ++seq, name: n, value: "", secret: true, saved: true })),
    ];
    if (rows.length) setExtras(rows);
  }, [info, gitFailed]); // eslint-disable-line react-hooks/exhaustive-deps

  // The name follows the playbook and the inventory until the member types one.
  useEffect(() => {
    if (!nameTouched && book) setName(inv ? `${baseName(book)} · ${inv}` : baseName(book));
  }, [book, inv, nameTouched]);

  const ssh = isSsh(url);
  const keyOptions = keys.filter((k) => k.kind === (ssh ? "ssh" : "token"));
  useEffect(() => {
    if (key && keyOptions.some((k) => k.name === key)) return;
    setKey(ssh ? keyOptions[0]?.name ?? NO_KEY : NO_KEY);
  }, [ssh, keys.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const reused = repos.find((r) => r.url === url.trim() && r.branch === (branch.trim() || "main"));

  const invObj = inventories.find((i) => i.name === inv);
  const groups = useMemo(() => {
    const m: Record<string, Inventory["hosts"]> = {};
    invObj?.hosts.forEach((h) => (m[h.group] ??= []).push(h));
    return m;
  }, [invObj]);
  const hosts = invObj?.hosts.filter((h) => !targets.length || targets.includes(h.group)) ?? [];

  /* ---------- bringing the playbook ---------- */

  const applyParsed = (r: ParseResult) => {
    setFiles(r.files);
    setFilesChanged(true);
    setDropped(r.dropped);
    setBooks(r.playbooks);
    setBook(r.playbooks.includes(book) ? book : r.playbooks[0] ?? "");
    if (!r.playbooks.length) toast("올린 파일에서 플레이북(.yml)을 찾지 못했어요", "error");
    else toast(`파일 ${r.files.length}개를 읽었어요`);
  };

  const sendFiles = async (picked: { path: string; file: File }[]) => {
    const list = picked.filter((p) => !skipPath(p.path));
    if (!list.length) return;
    setReading(true);
    try {
      // One zip or .yml: the server reads it. Several files (a folder): sent one by one.
      if (list.length === 1 && !list[0].path.includes("/")) {
        const f = list[0].file;
        if (f.size > MAX_FOLDER_BYTES) throw new Error("파일이 너무 커요. 5MB까지 올릴 수 있어요.");
        applyParsed(await api.post<ParseResult>("/playbooks/parse", { name: f.name, data: toBase64(await f.arrayBuffer()) }));
        return;
      }
      const small = list.filter((p) => p.file.size <= MAX_FILE_BYTES);
      const total = small.reduce((n, p) => n + p.file.size, 0);
      if (total > MAX_FOLDER_BYTES) throw new Error("폴더가 너무 커요. 모두 합쳐 5MB까지 올릴 수 있어요. 플레이북에 필요한 폴더만 골라 주세요.");
      const entries = await Promise.all(small.map(async (p) => ({ path: p.path, content: toBase64(await p.file.arrayBuffer()) })));
      const r = await api.post<ParseResult>("/playbooks/parse", { entries });
      r.dropped = [...list.filter((p) => p.file.size > MAX_FILE_BYTES).map((p) => ({ path: p.path, reason: "512KB가 넘는 파일이에요" })), ...r.dropped];
      applyParsed(r);
    } catch (e) {
      toast(e instanceof Error && !(e instanceof ApiError) ? e.message : errMsg(e), "error");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  const onPick = (list: FileList | null) =>
    list && sendFiles([...list].map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file })));

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (!items.length) return onPick(e.dataTransfer.files);
    const out: { path: string; file: File }[] = [];
    try {
      for (const it of items) await readEntry(it, out);
    } catch {
      return toast("끌어 놓은 파일을 읽지 못했어요. 폴더 선택 버튼을 써 주세요.", "error");
    }
    // A single dropped file keeps its plain name (zip / yml); a folder keeps its paths.
    sendFiles(out.length === 1 && items[0].isFile ? [{ path: out[0].file.name, file: out[0].file }] : out);
  };

  const [missingBook, setMissingBook] = useState("");
  const findInGit = async (first = false) => {
    if (!url.trim()) return toast("저장소 주소를 넣어 주세요", "error");
    setReading(true);
    try {
      const r = await api.post<GitResult>("/playbooks/git", { url: url.trim(), branch: branch.trim() || "main", key: reused ? NO_KEY : key });
      setGit(r);
      setBooks(r.playbooks);
      // Opening a saved job whose playbook is gone from the repo: pick nothing rather than silently another one.
      const gone = first && !!book && !r.playbooks.includes(book);
      setMissingBook(gone ? book : "");
      setBook(r.playbooks.includes(book) ? book : gone ? "" : r.playbooks[0] ?? "");
      setGitFailed(false);
      if (!r.playbooks.length) toast("저장소에서 플레이북(.yml)을 찾지 못했어요", "error");
    } catch (e) {
      if (job && !git) setGitFailed(true);
      toast(errMsg(e), "error");
    } finally {
      setReading(false);
    }
  };

  // Editing or copying a Git playbook: read the repo once (its saved key), so the values show as when it was made.
  const gitLoaded = useRef(false);
  useEffect(() => {
    if (!job || pb?.kind !== "git" || gitLoaded.current || !reposRes.data) return;
    gitLoaded.current = true;
    findInGit(true);
  }, [job, pb, reposRes.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- the values ---------- */

  const vars = info?.vars ?? [];
  const setVal = (n: string, v: string) => setValues((p) => ({ ...p, [n]: v }));

  const problems = (): string | null => {
    if (from === "upload" && !files?.length) return "플레이북 파일을 올려 주세요.";
    if (from === "git" && !git && !editing) return "저장소에서 플레이북을 찾아 주세요.";
    if (!book) return "실행할 플레이북을 골라 주세요.";
    // Without the playbook read, the saved values can't be shown or kept.
    if (!info && !(from === "git" && gitFailed)) return from === "git" ? "저장소에서 플레이북을 다시 읽어 주세요." : "플레이북을 읽는 중이에요. 잠시 뒤 다시 눌러 주세요.";
    for (const v of vars) {
      const val = (values[v.name] ?? "").trim();
      const saved = v.secret && savedSecrets.has(v.name) && !cleared.has(v.name);
      if (v.required && !val && !saved && !v.bool) return `${v.name} 값을 넣어 주세요.`;
    }
    const names = new Set(vars.map((v) => v.name));
    for (const x of extras) {
      if (!x.name.trim() && !x.value) continue;
      if (!NAME_RE.test(x.name.trim())) return `"${x.name || "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요. 영문, 숫자, _로 적어 주세요.`;
      if (names.has(x.name.trim())) return `${x.name}은(는) 위에 이미 있어요.`;
      names.add(x.name.trim());
    }
    if (!inv) return "배포할 서버의 인벤토리를 골라 주세요.";
    if (!hosts.length) return "이 인벤토리에 서버가 없어요. 서버를 추가해 주세요.";
    if (!name.trim()) return "작업 이름을 넣어 주세요.";
    return null;
  };

  const payload = () => {
    const play: [string, string][] = [];
    const secret: [string, string][] = [];
    const keep: string[] = [];
    const add = (n: string, v: string, isSecret: boolean, hadSaved: boolean) => {
      if (isSecret) {
        if (v) secret.push([n, v]);
        else if (hadSaved && !cleared.has(n)) keep.push(n);
      } else if (v.trim()) play.push([n, v]);
    };
    for (const v of vars) {
      const val = values[v.name] ?? "";
      // A switch only sends a value that differs from the playbook's default.
      if (v.bool) {
        const def = (v.default ?? "false").toLowerCase() === "true";
        const on = val ? val === "true" : def;
        if (on !== def || val) play.push([v.name, on ? "true" : "false"]);
        continue;
      }
      add(v.name, val, v.secret, savedSecrets.has(v.name));
    }
    for (const x of extras) if (x.name.trim()) add(x.name.trim(), x.value, x.secret, x.saved);
    const imageText = job?.image ? (job.defaultTag && job.defaultTag !== "latest" ? `${job.image}:${job.defaultTag}` : job.image) : "";
    return {
      name: name.trim(),
      playbook:
        from === "upload"
          ? { source: "upload", path: book }
          : { source: "git", url: url.trim(), branch: branch.trim() || "main", path: book, key: reused ? NO_KEY : key },
      // Edit without a new upload: null keeps the saved files.
      files: from === "upload" && (!editing || filesChanged) ? (files ?? []).map((f) => ({ path: f.path, content: f.content ?? "" })) : undefined,
      inventory: inv,
      targets,
      image: editing ? imageText : "",
      extraImages: editing ? job!.extraImages.map((x) => ({ image: x.defaultTag && x.defaultTag !== "latest" ? `${x.ref}:${x.defaultTag}` : x.ref, var: x.var, sourceRepo: null })) : [],
      envMode: editing ? "keep" : copying && job!.env ? "copy" : "none",
      envName: copying && job!.env ? job!.env : null,
      envVars: [],
      playVars: play,
      secretVars: secret,
      keepSecretVars: keep,
      ...(copying ? { copySecretVarsFrom: job!.id } : {}),
      hook: editing ? job!.hook : false,
      hookRule: job?.hookRule ?? "v",
      protected: prot,
      lock: job?.lock ?? true,
      rollback: job?.rollback ?? false,
      editors: job?.editors ?? { groups: [], members: [] },
    };
  };

  const submit = async () => {
    const p = problems();
    if (p) return setErr(p);
    setErr("");
    setBusy(true);
    const body = payload();
    const done = (saved: Job) => {
      refresh();
      if (editing) {
        onClose();
        toast("작업을 고쳤어요");
      } else {
        nav(`/jobs/${saved.id}`, { replace: true });
        toast("작업을 만들었어요. 실행을 누르면 서버에 배포해요");
      }
    };
    const send = () => (editing ? api.put<Job>(`/jobs/${job!.id}`, body) : api.post<Job>("/jobs", body));
    try {
      done(await send());
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.sudoRequired) {
        // Changing saved secret values asks for the password again.
        withSudo("비밀 값 바꾸기", async () => {
          try {
            done(await send());
          } catch (e2) {
            if (e2 instanceof ApiError && e2.sudoRequired) throw e2;
            setErr(errMsg(e2));
          }
        });
        return;
      }
      setErr(errMsg(e));
    }
  };

  if (job && pb?.kind === "upload" && files === null && !err) return <Loading />;

  const title = editing ? "플레이북 작업 편집" : copying ? "플레이북 작업 복제" : "플레이북 추가";
  const required = vars.filter((v) => v.required);
  // The chosen playbook's own optional values; those of playbooks it imports (01-base.yaml …) are shown apart.
  const optional = vars.filter((v) => !v.required && !v.from);
  // (plain values, not hooks: this runs after the early return above)
  const optionalGroups = byRole(optional);
  const importedMap = new Map<string, PlayVarInfo[]>();
  for (const v of vars) if (!v.required && v.from) (importedMap.get(v.from) ?? importedMap.set(v.from, []).get(v.from)!).push(v);
  const imported = [...importedMap.entries()];
  const isChanged = (v: PlayVarInfo) => (values[v.name] ?? "") !== "" || (savedSecrets.has(v.name) && !cleared.has(v.name));
  const invKey = keys.find((k) => k.kind === "ssh" && k.name === invObj?.key);
  const field = (v: PlayVarInfo) => (
    <VarField key={v.name} v={v} value={values[v.name] ?? ""} onChange={(x) => setVal(v.name, x)} saved={savedSecrets.has(v.name) && !cleared.has(v.name)} onClear={() => setCleared((s) => new Set(s).add(v.name))} invKey={invKey} />
  );
  const roleGroups = (groups: [string, PlayVarInfo[]][]) =>
    groups.map(([role, list]) =>
      !role ? (
        list.map(field)
      ) : (
        <RoleGroup key={role} role={role} count={list.length} changed={list.filter(isChanged).length}>
          {list.map(field)}
        </RoleGroup>
      ),
    );

  return (
    <>
      <BackLink onClick={onClose} />
      <PageHeader
        title={title}
        desc="플레이북을 올리면 필요한 값을 입력칸으로 보여 드려요."
      />

      <div className="flex flex-col gap-5 max-w-[880px]">
        {/* 1. the playbook */}
        <Section no={1} title="플레이북" sub="실행할 플레이북과, 플레이북이 함께 쓰는 파일이에요.">
          {!editing && (
            <div>
            <Seg<From>
              options={[
                { value: "upload", label: "파일 올리기" },
                { value: "git", label: "Git 저장소" },
              ]}
              value={from}
              onChange={(v) => {
                setFrom(v);
                setBook("");
                setBooks([]);
                setInfo(null);
              }}
            />
            </div>
          )}

          {from === "upload" ? (
            <>
              <input ref={fileInput} type="file" hidden accept=".zip,.yml,.yaml" onChange={(e) => onPick(e.target.files)} />
              <input ref={folderInput} type="file" hidden multiple onChange={(e) => onPick(e.target.files)} />
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={cx(
                  "rounded-xl border border-dashed px-4 py-5 flex flex-col items-center gap-3 text-center transition-colors",
                  dragOver ? "border-accent bg-accent/5" : "border-line-strong",
                )}
              >
                <span className="grid place-items-center size-10 rounded-full bg-surface-2 text-accent">
                  <Icon name="upload" className="size-5" />
                </span>
                <div className="text-[13px]">
                  <b className="font-semibold">플레이북 폴더</b>를 여기로 끌어 놓거나 골라 주세요
                  <div className="text-muted text-[12.5px] mt-0.5">zip 파일이나 .yml 하나만 올려도 돼요</div>
                </div>
                <div className="flex gap-2 flex-wrap justify-center">
                  <Button variant="primary" size="sm" icon="box" disabled={reading} onClick={() => folderInput.current?.click()}>
                    {reading ? "읽는 중…" : "폴더 선택"}
                  </Button>
                  <Button size="sm" icon="file" disabled={reading} onClick={() => fileInput.current?.click()}>
                    zip · yml 선택
                  </Button>
                </div>
              </div>
              <Hint>
                플레이북이 다른 파일(템플릿, 설정 폴더…)을 쓰면 <b>폴더째</b> 올려 주세요. 개인키, <span className="font-mono">.env</span>, .git 폴더는
                자동으로 빼요. 비밀번호 같은 값은 아래 칸에 따로 넣어요.
              </Hint>
              {files && files.length > 0 && <FileSummary files={files} dropped={dropped} />}
            </>
          ) : (
            <>
              <Field label="저장소 주소" htmlFor="pbUrl">
                <RepoUrlInput
                  id="pbUrl"
                  value={url}
                  onChange={setUrl}
                  repos={repos}
                  onPick={(r) => {
                    setUrl(r.url);
                    setBranch(r.branch);
                  }}
                />
              </Field>
              <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
                <Field label="브랜치" htmlFor="pbBranch">
                  <Input id="pbBranch" mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
                </Field>
                <Field
                  label={ssh ? "SSH 키" : "토큰"}
                  htmlFor="pbKey"
                  hint={reused ? `이미 연결된 저장소의 인증을 그대로 써요 · ${reused.auth}` : ssh ? "git@ 주소는 SSH 키가 필요해요" : "비공개 저장소면 읽기 토큰을 골라요"}
                  right={
                    !reused && (
                      <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} />)}>
                        키 추가
                      </Button>
                    )
                  }
                >
                  <Select id="pbKey" value={reused ? NO_KEY : key} onChange={(e) => setKey(e.target.value)} disabled={!!reused}>
                    {reused && <option value={NO_KEY}>연결된 저장소의 인증</option>}
                    {!reused && !ssh && <option value={NO_KEY}>공개 저장소(키 없음)</option>}
                    {!reused &&
                      keyOptions.map((k) => (
                        <option key={k.id} value={k.name}>
                          {k.name} · {k.type}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              <div>
                <Button icon="refresh" disabled={reading} onClick={() => findInGit()}>
                  {reading ? "저장소 읽는 중…" : git ? "다시 찾기" : "플레이북 찾기"}
                </Button>
                {git && <span className="ml-2 text-muted text-[12.5px]">커밋 {git.commit} · 플레이북 {git.playbooks.length}개</span>}
              </div>
            </>
          )}

          {missingBook && !book && (
            <Banner tone="warn" icon="alert" title={`저장된 플레이북 ${missingBook}이(가) 저장소에 없어요`}>
              이름이 바뀌었거나 지워졌어요. 아래에서 실행할 플레이북을 다시 골라 주세요.
            </Banner>
          )}
          {books.length > 1 && (
            <Field label="실행할 플레이북">
              <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-2">
                {books.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBook(b)}
                    className={cx(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                      b === book ? "border-accent bg-accent/5" : "border-line hover:bg-hover",
                    )}
                  >
                    <span className={cx("size-3.5 rounded-full border flex-none", b === book ? "border-accent border-[4px]" : "border-line-strong")} />
                    <span className="font-mono text-[12.5px] truncate">{b}</span>
                  </button>
                ))}
              </div>
            </Field>
          )}
          {books.length === 1 && book && (
            <div className="text-[13px]">
              실행할 플레이북 <Chip mono>{book}</Chip>
            </div>
          )}
        </Section>

        {/* 2. the values */}
        {book && (
          <Section no={2} title="입력할 값">
            {inspecting && !info ? (
              <Loading />
            ) : !info ? (
              <Hint>플레이북을 읽지 못했어요. 아래 "값 직접 더하기"로 넣을 수 있어요.</Hint>
            ) : (
              <>
                {info.warnings.length > 0 && (
                  <Banner tone="warn" icon="alert" title="빠진 파일이 있어요">
                    <ul className="m-0 pl-4 list-disc">
                      {info.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                    {from === "upload" && <div className="mt-1">플레이북이 들어 있는 폴더를 통째로 다시 올려 주세요.</div>}
                  </Banner>
                )}
                {info.notes.map((n) => (
                  <Banner key={n} tone="info" icon="info">
                    {n}
                  </Banner>
                ))}
                {vars.length === 0 ? (
                  <Hint>이 플레이북은 따로 넣을 값이 없어요.</Hint>
                ) : (
                  <>
                    {required.length > 0 && (
                      <VarGroup title="필수" count={required.length}>
                        {required.map(field)}
                      </VarGroup>
                    )}
                    {optional.length > 0 && (
                      <VarGroup title="선택" count={optional.length}>
                        {/* the playbook's own values first, then each role's defaults folded under its name */}
                        {roleGroups(optionalGroups)}
                      </VarGroup>
                    )}
                    {imported.length > 0 && (
                      <VarGroup title="불러온 플레이북" count={imported.reduce((n, [, l]) => n + l.length, 0)}>
                        {imported.map(([src, list]) => (
                          <RoleGroup key={src} role={src} count={list.length} changed={list.filter(isChanged).length}>
                            {roleGroups(byRole(list))}
                          </RoleGroup>
                        ))}
                      </VarGroup>
                    )}
                  </>
                )}
                {info.auto.length > 0 && (
                  <div className="text-[12.5px] text-muted">
                    <button type="button" className="underline decoration-dotted" onClick={() => setShowAuto((x) => !x)}>
                      Wharfline이 알아서 넣는 값 {info.auto.length}개
                    </button>
                    {showAuto && <span className="font-mono ml-2">{info.auto.join(", ")}</span>}
                  </div>
                )}
              </>
            )}
            <ExtraVars items={extras} onChange={setExtras} />
          </Section>
        )}

        {/* 3. servers */}
        {book && (
          <Section no={3} title="배포할 서버" sub="플레이북을 실행할 서버예요.">
            <Field
              label="인벤토리"
              right={
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewInventoryModal onClose={c} onCreated={(i) => setInv(i.name)} />)}>
                    인벤토리 추가
                  </Button>
                  {invObj && (
                    <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewHostModal inventory={invObj} onClose={c} />)}>
                      서버 추가
                    </Button>
                  )}
                </span>
              }
              hint={!inventories.length ? "인벤토리가 없어요. 인벤토리를 먼저 추가하세요." : hosts.length ? `서버 ${hosts.length}대에 실행해요` : "이 인벤토리에 서버가 없어요. 서버를 추가하세요."}
              error={!!invObj && !hosts.length}
            >
              <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                <Select
                  aria-label="인벤토리"
                  value={inv}
                  onChange={(e) => {
                    setInv(e.target.value);
                    setTargets([]);
                  }}
                  placeholder="인벤토리 선택"
                >
                  {inventories.map((i) => (
                    <option key={i.id} value={i.name}>
                      {i.name} · 서버 {i.hosts.length}대
                    </option>
                  ))}
                </Select>
                <GroupSelect groups={groups} value={targets} onChange={setTargets} />
              </div>
              {hosts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {hosts.slice(0, 8).map((h) => (
                    <Chip key={h.name} mono>
                      {h.name} <span className="text-faint">{h.ip}</span>
                    </Chip>
                  ))}
                  {hosts.length > 8 && <Chip>+{hosts.length - 8}대</Chip>}
                </div>
              )}
            </Field>
          </Section>
        )}

        {/* 4. name */}
        {book && (
          <Section no={4} title="작업 이름" sub="배포 작업 목록에 이 이름으로 보여요. 실행은 만든 뒤 작업 화면에서 해요.">
            <Field label="이름" htmlFor="pbName">
              <Input
                id="pbName"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="stack · production"
              />
            </Field>
            <label className="flex items-center gap-2.5 text-[13px]">
              <Switch checked={prot} onChange={setProt} disabled={fixedSafety} label="운영 보호" />
              <span>
                운영 보호 <span className="text-muted text-[12.5px]">· 켜면 Deployer는 승인을 받아야 실행할 수 있어요</span>
              </span>
            </label>
          </Section>
        )}

        <ErrorText>{err}</ErrorText>
        <div className="flex gap-2 justify-end">
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" icon={editing ? "check" : "plus"} disabled={busy || !book} onClick={submit}>
            {busy ? "저장 중…" : editing ? "저장" : "작업 만들기"}
          </Button>
        </div>
      </div>
    </>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  const loc = useLocation();
  return loc.key !== "default" ? (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg w-fit -mb-3">
      <Icon name="chev" className="size-3.5 rotate-90" />
      배포 작업
    </button>
  ) : (
    <Link to="/jobs" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg w-fit -mb-3">
      <Icon name="chev" className="size-3.5 rotate-90" />
      배포 작업
    </Link>
  );
}

function Section({ no, title, sub, children }: { no: number; title: string; sub?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="grid place-items-center size-5 rounded-full bg-accent/10 text-accent text-[11.5px] font-semibold">{no}</span>
            {title}
          </span>
        }
        sub={sub}
      />
      <div className="px-5 pb-5 pt-1 flex flex-col gap-4">{children}</div>
    </Card>
  );
}

function FileSummary({ files, dropped }: { files: BundleFile[]; dropped: Dropped[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] flex flex-col gap-1.5">
      <button type="button" className="flex items-center gap-1.5 text-left" onClick={() => setOpen((x) => !x)}>
        <Icon name="check" className="size-3.5 text-ok" />
        올린 파일 {files.length}개
        <Icon name="chev" className={cx("size-3 text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="max-h-72 overflow-auto scroll-soft -mx-1">
          <FileTree files={files.map((f) => ({ path: f.path }))} />
        </div>
      )}
      {dropped.length > 0 && (
        <div className="text-muted">
          <span className="text-fg">뺀 파일 {dropped.length}개</span>
          {dropped.slice(0, 6).map((d) => (
            <div key={d.path} className="truncate">
              <span className="font-mono">{d.path}</span> · {d.reason}
            </div>
          ))}
          {dropped.length > 6 && <div>외 {dropped.length - 6}개</div>}
        </div>
      )}
    </div>
  );
}

function VarGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 pb-2 border-b border-line">
        <h3 className="m-0 text-[16px] font-bold text-fg">{title}</h3>
        <span className="text-[12.5px] text-faint">{count}개</span>
      </div>
      {children}
    </div>
  );
}

/** [role, values] in the order roles first appear; "" holds what the playbook reads itself. */
function byRole(list: PlayVarInfo[]): [string, PlayVarInfo[]][] {
  const m = new Map<string, PlayVarInfo[]>([["", []]]);
  for (const v of list) {
    const k = v.role ?? "";
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(v);
  }
  return [...m.entries()].filter(([, l]) => l.length > 0);
}

/** One role's optional values, folded until opened (opened from the start when one of them is already set). */
function RoleGroup({ role, count, changed, children }: { role: string; count: number; changed: number; children: ReactNode }) {
  const [open, setOpen] = useState(changed > 0);
  const id = `rg-${role}`;
  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((x) => !x)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-surface-2 rounded-lg"
      >
        <Icon name="chev" className={cx("size-3.5 text-faint transition-transform duration-150", !open && "-rotate-90")} />
        <span className="font-mono font-medium">{role}</span>
        <span className="text-[12.5px] text-faint">{count}개</span>
        {changed > 0 && <Chip tone="accent">바꾼 값 {changed}</Chip>}
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-3 px-3 pb-3 pt-1 border-t border-line">
          {children}
        </div>
      )}
    </div>
  );
}

/** A list default ([a, b]) is typed one item per line and sent as a list. */
const isListDefault = (d: string | null) => !!d && d.trim().startsWith("[");
function listLines(value: string): string {
  if (!value.trim()) return "";
  try {
    const x = JSON.parse(value);
    if (Array.isArray(x)) return x.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n");
  } catch {
    /* typed by hand before: show as is */
  }
  return value;
}
const linesToList = (text: string) => {
  const items = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return items.length ? JSON.stringify(items) : "";
};
/** A list of SSH public keys (authorized_keys): offer the inventory's key. */
const SSH_KEY_LIST = /(ssh|authorized)_?(pub(lic)?_?)?keys?$|pubkeys?$/i;

/** One value the playbook asks for: a text box, a hidden box for secrets, a switch for yes/no, lines for a list. */
function VarField({ v, value, onChange, saved, onClear, invKey }: { v: PlayVarInfo; value: string; onChange: (x: string) => void; saved: boolean; onClear: () => void; invKey?: Key }) {
  const { toast } = useApp();
  const [show, setShow] = useState(false);
  const id = `pv-${v.name}`;
  const label = (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="font-mono">{v.name}</span>
      {v.secret && (
        <span title="암호화해서 저장하고, 실행 기록에는 가려져요">
          <Chip tone="warn" icon="lock">
            비밀
          </Chip>
        </span>
      )}
    </span>
  );
  const def = v.default !== null && v.default !== "" ? v.default : null;
  const list = isListDefault(def) || (!def && SSH_KEY_LIST.test(v.name));
  const shownDef = list && def ? listLines(def) : def;
  const defLine = !v.required && (
    <span className="block">
      기본값 {shownDef ? <span className="font-mono text-fg">{list ? (shownDef.includes("\n") ? `${shownDef.split("\n").length}줄` : shownDef) : shownDef}</span> : "없음"}
    </span>
  );
  // the playbook's own example of how to fill it in a terminal (lookup('file', '~/.ssh/…')) means nothing here
  const desc = v.desc.replace(/예\)?\s*"?\{\{\s*lookup\([^}]*\}\}"?/g, "").trim();
  if (v.bool) {
    const on = value ? value === "true" : (v.default ?? "false").toLowerCase() === "true";
    return (
      <Field label={label} hint={desc || defLine ? <>{desc}{defLine}</> : undefined}>
        <label className="flex items-center gap-2.5 text-[13px]">
          <Switch checked={on} onChange={(x) => onChange(x ? "true" : "false")} label={v.name} />
          {on ? "켜기 (true)" : "끄기 (false)"}
        </label>
      </Field>
    );
  }
  if (list) {
    const sshKeys = SSH_KEY_LIST.test(v.name);
    const addInvKey = async () => {
      if (!invKey) return toast("배포할 서버(3번)에서 인벤토리를 먼저 골라 주세요.", "error");
      try {
        const r = await api.get<{ publicKey: string }>(`/keys/${invKey.id}/public`);
        const lines = listLines(value).split("\n").filter(Boolean);
        if (lines.includes(r.publicKey)) return toast("이미 들어 있어요.");
        onChange(linesToList([...lines, r.publicKey].join("\n")));
      } catch (e) {
        toast(errMsg(e), "error");
      }
    };
    return (
      <Field
        label={label}
        htmlFor={id}
        hint={
          <>
            {sshKeys ? "이 서버에 로그인할 수 있게 등록할 SSH 공개키예요. 한 줄에 하나 (ssh-ed25519 AAAA… 형식)." : desc || "한 줄에 하나씩 적어요."}
            {sshKeys && desc && !/lookup/.test(v.desc) && <span className="block">{desc}</span>}
            {defLine}
          </>
        }
        right={
          sshKeys ? (
            <Button size="sm" variant="ghost" icon="key" onClick={addInvKey} title={invKey ? `${invKey.name}의 공개키` : "인벤토리를 먼저 골라 주세요"}>
              인벤토리 키 넣기
            </Button>
          ) : undefined
        }
      >
        <Textarea
          id={id}
          rows={Math.min(6, Math.max(2, listLines(value).split("\n").length + 1))}
          spellCheck={false}
          className="font-mono text-[12px] break-all"
          value={listLines(value)}
          onChange={(e) => onChange(e.target.value.trim() ? JSON.stringify(e.target.value.split("\n")) : "")}
          onBlur={(e) => onChange(linesToList(e.target.value))}
          placeholder={shownDef || (sshKeys ? "ssh-ed25519 AAAAC3Nza… you@laptop" : "한 줄에 하나")}
        />
      </Field>
    );
  }
  return (
    <Field label={label} htmlFor={id} hint={desc || defLine ? <>{desc}{defLine}</> : undefined} right={saved && !value ? <Chip tone="ok">저장된 값 있음</Chip> : undefined}>
      <div className="flex gap-1.5">
        <Input
          id={id}
          className="flex-1"
          mono={v.secret}
          type={v.secret && !show ? "password" : "text"}
          autoComplete={v.secret ? "new-password" : "off"}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={saved ? "그대로 두면 저장된 값을 써요" : def ?? (v.required ? "넣어 주세요" : "")}
        />
        {v.secret && <Button variant="ghost" iconOnly icon="eye" aria-label={show ? "가리기" : "보기"} onClick={() => setShow((x) => !x)} />}
        {saved && !v.required && (
          <Button variant="ghost" iconOnly icon="trash" aria-label="저장된 값 지우기" title="저장된 값 지우기" onClick={onClear} />
        )}
      </div>
    </Field>
  );
}

/** Values Wharfline could not see in the playbook (built from other variables, read from a role, …). */
function ExtraVars({ items, onChange }: { items: Extra[]; onChange: (x: Extra[]) => void }) {
  const [open, setOpen] = useState(items.length > 0);
  useEffect(() => {
    if (items.length) setOpen(true);
  }, [items.length]);
  const set = (id: number, patch: Partial<Extra>) => onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  if (!open)
    return (
      <div>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen(true)}>
          값 직접 더하기
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <div className="text-[12.5px] font-semibold text-muted">
        직접 더한 값 <span className="font-normal text-faint">· 위에 없는 값이 플레이북에 필요할 때만 써요</span>
      </div>
      {items.map((x) => (
        <div key={x.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] gap-1.5 items-center">
          <Input mono aria-label="이름" value={x.name} onChange={(e) => set(x.id, { name: e.target.value })} placeholder="이름 (예: app_port)" spellCheck={false} />
          <Input
            mono
            aria-label="값"
            type={x.secret ? "password" : "text"}
            autoComplete={x.secret ? "new-password" : "off"}
            value={x.value}
            onChange={(e) => set(x.id, { value: e.target.value })}
            placeholder={x.saved && x.secret ? "그대로 두면 저장된 값" : "값"}
            spellCheck={false}
          />
          <label className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap">
            <Switch checked={x.secret} onChange={(s) => set(x.id, { secret: s, saved: s && x.saved })} label="비밀" />
            비밀
          </label>
          <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="지우기" onClick={() => onChange(items.filter((y) => y.id !== x.id))} />
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange([...items, { id: ++seq, name: "", value: "", secret: false, saved: false }])}>
          한 줄 더하기
        </Button>
      </div>
    </div>
  );
}

/** /jobs/new-playbook */
export function NewPlaybookPage() {
  const nav = useNavigate();
  const loc = useLocation();
  return <PlaybookEditor mode="new" onClose={() => (loc.key !== "default" ? nav(-1) : nav("/jobs"))} />;
}

/**
 * The repo address: typed by hand, or picked from the Git repos already registered (shown when the field is
 * clicked, narrowed as you type). Picking one fills the branch too, and the repo's saved access is reused.
 */
function RepoUrlInput({ id, value, onChange, repos, onPick }: { id: string; value: string; onChange: (v: string) => void; repos: Repo[]; onPick: (r: Repo) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const q = value.trim().toLowerCase();
  // the whole list while the field holds a registered address (to switch), otherwise the ones matching the text
  const exact = repos.some((r) => r.url.toLowerCase() === q);
  const shown = exact || !q ? repos : repos.filter((r) => `${r.url} ${r.name} ${r.branch}`.toLowerCase().includes(q));
  const visible = open && shown.length > 0;

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 200 && above > below;
    setPos({ left: r.left, width: r.width, maxHeight: Math.max(120, Math.min(300, up ? above : below)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  };
  useLayoutEffect(() => {
    if (!visible) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (visible) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visible, active]);

  const choose = (r: Repo | undefined) => {
    if (r) onPick(r);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return (setOpen(true), setActive(0));
      setActive((a) => Math.max(0, Math.min(shown.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && visible) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === "Escape" && visible) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <Input
        id={id}
        mono
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        placeholder={repos.length ? "눌러서 등록된 저장소를 고르거나 주소를 붙여넣어요" : "https://git.example.com/org/infra.git"}
        autoComplete="off"
        spellCheck={false}
        className={cx(repos.length > 0 && "pr-8", "placeholder:font-sans")}
      />
      {repos.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="등록된 저장소"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center size-6 rounded-md text-faint hover:text-primary"
        >
          <Icon name="chev" className={cx("size-3.5 transition-transform duration-150", visible && "rotate-180")} />
        </button>
      )}
      {visible &&
        pos &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[70] overflow-auto scroll-soft rounded-xl bg-surface shadow-pop p-1 animate-fade"
          >
            <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-faint">등록된 저장소 {shown.length}개</div>
            {shown.map((r, i) => {
              const on = r.url === value.trim();
              return (
                <div
                  key={r.id}
                  data-index={i}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                  className={cx("flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer", i === active && "bg-hover")}
                >
                  <Icon name="git" className="size-3.5 flex-none text-muted" />
                  <div className="flex-1 min-w-0">
                    <div className={cx("font-mono text-[12.5px] truncate", on && "font-medium text-primary")}>{r.url}</div>
                    <div className="text-[11.5px] text-muted truncate">
                      {r.name} · {r.branch} · {r.auth}
                      {r.usedBy.length > 0 && ` · 작업 ${r.usedBy.length}개`}
                    </div>
                  </div>
                  {on && <Icon name="check" className="size-3.5 flex-none" strokeWidth={2.4} />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
