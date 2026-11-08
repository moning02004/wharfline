import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { BundleFile, EnvSet, Group, Inventory, Job, Key, Member, Repo } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { ModalFoot, ModalHead } from "../components/Modal";
import { GuideContext, JOB_STEPS, TipSpot, type JobStepId, type TipId } from "./JobGuide";
import { NewHostModal, NewInventoryModal, NewKeyModal, NewRegistryModal } from "./ResourceModals";
import { GroupModal } from "./AccessModals";
import { FileHistoryModal } from "./FileHistoryModal";
import { Button, Check, Chip, Field, Hint, Input, Select, Seg, Switch, Textarea, cx } from "../components/ui";

/* Same rules as the server (docs/deploy-simplify.md). */
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.ya?ml$/;
const IMAGE_RE = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const NO_KEY = "";

/** parse_image from the design doc: "postgres:15" -> docker.io/library/postgres + 15. */
function parseImage(text: string): { ref: string; tag: string } | { error: string } {
  const t = text.trim().replace(/^https:\/\//, "");
  if (t.includes("@")) return { error: "digest(@sha256:…)는 쓸 수 없어요. 태그로 적어 주세요." };
  const slash = t.lastIndexOf("/");
  const colon = t.indexOf(":", slash + 1);
  let ref = (colon >= 0 ? t.slice(0, colon) : t).toLowerCase();
  const tag = colon >= 0 ? t.slice(colon + 1) : "latest";
  const parts = ref.split("/");
  if (!/[.:]/.test(parts[0]) && parts[0] !== "localhost") ref = parts.length === 1 ? `docker.io/library/${ref}` : `docker.io/${ref}`;
  if (!IMAGE_RE.test(ref)) return { error: "이미지 이름을 확인해 주세요. 예: postgres:15, ghcr.io/acme/api:v1.2" };
  if (!TAG_RE.test(tag)) return { error: "태그는 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)으로 적어 주세요." };
  return { ref, tag };
}

const isSsh = (url: string) => /^(git@|ssh:\/\/)/.test(url.trim());

type Mode = "new" | "edit";
type Source = "git" | "builtin" | "script";
interface StepDraft {
  id: number;
  name: string;
  run: string;
}
let stepSeq = 0;
interface ExtraDraft {
  id: number;
  image: string;
  var: string;
  /** The variable name follows the image name until it is typed in. */
  auto?: boolean;
}
const VAR_RE = /^[A-Z][A-Z0-9_]{0,23}$/;
/** Variables Wharfline sets itself, and common shell variables, never asked for in the env step. */
const BUILTIN_VARS = ["SERVICE_PATH", "ENV_FILE", "IMAGE", "IMAGE_TAG", "IMAGE_REF"];
const SHELL_VARS = new Set(["HOME", "PATH", "USER", "PWD", "OLDPWD", "SHELL", "HOSTNAME", "LANG", "TERM", "UID", "PPID", "RANDOM", "IFS"]);

/** "ghcr.io/acme/api-server:v1" -> "API_SERVER": a starting variable name for an extra image. */
function varFromImage(text: string): string {
  const name = text.trim().split("/").pop()?.split(":")[0] ?? "";
  const v = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(v) ? v.slice(0, 24) : "";
}

/** $NAME and ${NAME} in scripts and files (upper case, the env-variable convention). */
function usedVars(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)) out.add(m[1]);
  return [...out];
}

interface FileImage {
  path: string;
  value: string; // as written after image:
  ref: string;
  tag: string | null;
  var: string; // tracking variable name ("" = main image)
  fixed: boolean; // a literal tag (or none): not following a variable
}
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `image: …` values in compose / Kubernetes files. `${NAME_TAG}` -> track NAME; a literal tag -> suggest a variable. */
function findFileImages(files: BundleFile[]): FileImage[] {
  const out: FileImage[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const m of (f.content ?? "").matchAll(/^\s*-?\s*image:\s*["']?([^\s"'#]+)/gm)) {
      const value = m[1];
      if (seen.has(value) || value.includes("@")) continue;
      seen.add(value);
      const slash = value.lastIndexOf("/");
      const colon = value.indexOf(":", slash + 1);
      const ref = colon >= 0 ? value.slice(0, colon) : value;
      const tag = colon >= 0 ? value.slice(colon + 1) : null;
      if (ref.includes("${")) continue; // the image name itself comes from a variable
      const v = tag?.match(/^\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}$/);
      if (v) out.push({ path: f.path, value, ref, tag: null, var: v[1] === "IMAGE_TAG" ? "" : v[1].replace(/_TAG$/, ""), fixed: false });
      else out.push({ path: f.path, value, ref, tag, var: varFromImage(ref), fixed: true });
    }
  }
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Same as the server's app_slug: "api-server · production" -> "api-server-production". */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A starting point like the usual CI deploy: pull the new image, recreate, clean up. */
const SCRIPT_EXAMPLE: Omit<StepDraft, "id">[] = [
  { name: "이미지 받기", run: 'mkdir -p "$SERVICE_PATH"\ncd "$SERVICE_PATH"\ndocker compose pull' },
  { name: "컨테이너 교체", run: 'cd "$SERVICE_PATH"\ndocker compose up -d --remove-orphans' },
  { name: "정리", run: "docker image prune -f" },
];

/** Same rule as the server: an absolute folder, no "..". */
const SERVICE_PATH_RE = /^\/(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]{1,254}$/;
/** Environment choice: "keep" only exists when editing; "on" means EnvSource decides paste or existing. */
type EnvChoice = "keep" | "none" | "on";

interface GroupsData {
  groups: Group[];
  repos: string[];
}

/** Image text for the form from a job: ref + ":" + defaultTag, or just the ref when the tag is latest. */
function jobImageText(job: Job): string {
  if (!job.image) return "";
  return job.defaultTag && job.defaultTag !== "latest" ? `${job.image}:${job.defaultTag}` : job.image;
}

export function NewJobModal({ onClose, guide = false }: { onClose: () => void; guide?: boolean }) {
  return <JobModal mode="new" onClose={onClose} initialGuide={guide} />;
}

export function EditJobModal({ job, onClose }: { job: Job; onClose: () => void }) {
  return <JobModal mode="edit" job={job} onClose={onClose} initialGuide={false} />;
}

/** Step-by-step deploy job modal for both creating and editing (docs/deploy-edit.md). */
function JobModal({ mode, job, onClose, initialGuide }: { mode: Mode; job?: Job; onClose: () => void; initialGuide: boolean }) {
  const { toast, refresh, openModal, withSudo, session, can } = useApp();
  // Deployers: new jobs are protected with auto-deploy off, and those two can't be changed; .env values can't be pasted.
  const fixedSafety = !can("run_protected");
  const canEnv = can("env");
  const nav = useNavigate();
  const editing = mode === "edit" && !!job;
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const allRepos = (useApi<Repo[]>("/repos").data ?? []).filter((r) => r.kind !== "builtin");
  const repos = allRepos.filter((r) => r.kind === "git");
  const keys = useApi<Key[]>("/keys").data ?? [];
  const envs = useApi<EnvSet[]>("/envs").data ?? [];
  const membersRes = useApi<Member[]>("/members");
  const groupsRes = useApi<GroupsData>("/groups");

  const pb = job?.playbook;
  const [name, setName] = useState(job?.name ?? "");
  const [source, setSource] = useState<Source>(pb?.kind === "builtin" ? "builtin" : pb?.kind === "script" ? "script" : "git");
  const isRepo = pb && (pb.kind === "git" || pb.kind === "local");
  const [url, setUrl] = useState(isRepo ? pb.url : "");
  const [branch, setBranch] = useState(isRepo ? pb.branch : "main");
  const [path, setPath] = useState(isRepo ? pb.path : "");
  const [steps, setSteps] = useState<StepDraft[]>(() => (job?.script ?? []).map((st) => ({ ...st, id: ++stepSeq })));
  const [servicePath, setServicePath] = useState(job?.servicePath ?? "");
  const [files, setFiles] = useState<BundleFile[]>(() => (job?.files ?? []).map((f) => ({ ...f })));
  const [filesTouched, setFilesTouched] = useState(false);
  // Tracked images in one list. The row with an empty variable name is the main image ($IMAGE_TAG).
  const [tracks, setTracks] = useState<ExtraDraft[]>(() => [
    ...(job?.image ? [{ id: ++stepSeq, image: jobImageText(job), var: "" }] : []),
    ...(job?.extraImages ?? []).map((x) => ({ id: ++stepSeq, image: x.defaultTag && x.defaultTag !== "latest" ? `${x.ref}:${x.defaultTag}` : x.ref, var: x.var })),
  ]);
  const image = tracks.find((t) => t.var === "")?.image ?? "";
  const extras = tracks.filter((t) => t.var !== "");
  const [key, setKey] = useState(NO_KEY);
  const [inv, setInv] = useState(job?.inventory ?? "");
  const [targets, setTargets] = useState<string[]>(job ? [...job.targets] : []);
  const [envChoice, setEnvChoice] = useState<EnvChoice>(editing ? "keep" : "none");
  const [envMode, setEnvMode] = useState<EnvMode>(canEnv ? "paste" : "existing");
  const [envText, setEnvText] = useState("");
  const [envPick, setEnvPick] = useState(job?.env ?? "");
  const [hook, setHook] = useState(job ? job.hook : false);
  const [hookRule, setHookRule] = useState(job?.hookRule ?? "v");
  const [prot, setProt] = useState(job ? job.protected : true);
  const [lock, setLock] = useState(job?.lock ?? true);
  const [rb, setRb] = useState(job?.rollback ?? true);
  const [edGroups, setEdGroups] = useState<string[]>(job?.editors?.groups ?? []);
  const [edMembers, setEdMembers] = useState<string[]>(job?.editors?.members ?? []);
  const [cur, setCur] = useState(0);
  const [skipped, setSkipped] = useState<JobStepId[]>([]);
  const [guide, setGuide] = useState(initialGuide);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The 스크립트 step exists only for SSH script jobs.
  const flow = JOB_STEPS.filter((st) => st.id !== "script" || source === "script");
  const step = flow[Math.min(cur, flow.length - 1)].id;
  const last = cur >= flow.length - 1;

  useEffect(() => {
    if (!inv && inventories[0]) setInv(inventories[0].name);
  }, [inventories, inv]);
  useEffect(() => {
    if (!envPick && envs[0]) setEnvPick(envs[0].name);
  }, [envs, envPick]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [cur]);

  // Keys that fit the URL: SSH keys for git@/ssh:// (one is required), tokens for https (optional).
  const ssh = isSsh(url);
  const keyOptions = keys.filter((k) => k.kind === (ssh ? "ssh" : "token"));
  useEffect(() => {
    if (key && keyOptions.some((k) => k.name === key)) return;
    setKey(ssh ? keyOptions[0]?.name ?? NO_KEY : NO_KEY);
  }, [ssh, keys.length]); // re-pick when the scheme changes or a key is added

  // Same URL + branch as a connected repo: the server reuses it and ignores the key.
  const reused = allRepos.find((r) => r.url === url.trim() && r.branch === (branch.trim() || "main"));

  const invObj = inventories.find((i) => i.name === inv);
  const groups = useMemo(() => {
    const m: Record<string, Inventory["hosts"]> = {};
    invObj?.hosts.forEach((h) => (m[h.group] ??= []).push(h));
    return m;
  }, [invObj]);
  const hosts = invObj?.hosts.filter((h) => !targets.length || targets.includes(h.group)) ?? [];

  const envVars = parseEnv(envText);
  const envOn = envChoice === "on";
  // Variables the script and files use: Wharfline's own (자동) and the ones the env step should have.
  const autoVars = [...BUILTIN_VARS, ...extras.flatMap((x) => (x.var ? [`${x.var}_IMAGE`, `${x.var}_TAG`, `${x.var}_IMAGE_REF`] : []))];
  const scriptVars =
    source === "script" ? usedVars([...steps.map((st) => st.run), ...files.map((f) => f.content ?? "")]).filter((v) => !SHELL_VARS.has(v)) : [];
  const neededVars = scriptVars.filter((v) => !autoVars.includes(v));

  // `image:` lines in the job's files: variables can be tracked; a fixed tag can be turned into a variable.
  const fileImages = source === "script" ? findFileImages(files) : [];
  const trackFixed = (fi: FileImage) => {
    const tagVar = `${fi.var}_TAG`;
    setFiles((prev) =>
      prev.map((f) =>
        f.path !== fi.path || f.content === undefined
          ? f
          : { ...f, content: f.content.replace(new RegExp(`(image:\\s*["']?)${escapeRe(fi.value)}`, "g"), `$1${fi.ref}:\${${tagVar}}`) },
      ),
    );
    setFilesTouched(true);
    setTracks((t) => [...t, { id: ++stepSeq, image: fi.tag && fi.tag !== "latest" ? `${fi.ref}:${fi.tag}` : fi.ref, var: fi.var }]);
    toast(`${fi.path}의 이미지를 \${${tagVar}}로 바꿨어요`);
  };

  /** Client-side check of one step; the server validates everything again. */
  const validateStep = (id: JobStepId): string => {
    switch (id) {
      case "name":
        return name.trim() ? "" : "이름을 넣어 주세요.";
      case "playbook":
        if (source === "script") {
          const sp = servicePath.trim().replace(/\/+$/, "");
          if (servicePath.trim() && (!sp || !SERVICE_PATH_RE.test(sp))) return "서비스 경로는 /srv/api-server처럼 /로 시작하는 폴더예요. ..은 쓸 수 없어요.";
          return "";
        }
        if (source !== "git") return "";
        if (!reused && !/^(git@|ssh:\/\/|https:\/\/)/.test(url.trim()))
          return "저장소 주소를 확인해 주세요. 예: git@github.com:org/ansible.git 또는 https://github.com/org/ansible.git";
        if (!PATH_RE.test(path.trim())) return "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml";
        if (ssh && !reused && !key) return "SSH 주소는 SSH 키가 있어야 해요. 키를 추가하거나 HTTPS 주소를 넣어 주세요.";
        return "";
      case "script": {
        if (!steps.length) return "스크립트 단계를 하나 이상 넣어 주세요.";
        const bad = steps.findIndex((st) => !st.name.trim() || !st.run.trim());
        return bad >= 0 ? `${bad + 1}번째 단계의 이름과 명령을 적어 주세요.` : "";
      }
      case "target":
        return hosts.length ? "" : "배포할 서버가 없어요. 인벤토리나 그룹을 바꿔 주세요.";
      case "image": {
        if (source === "builtin" && !image.trim()) return "기본 플레이북은 띄울 이미지가 있어야 해요. 변수 이름을 비운 이미지를 넣어 주세요.";
        const seen = new Set<string>();
        for (const x of tracks) {
          const p = parseImage(x.image);
          if (!x.image.trim() || "error" in p) return `이미지 ${x.image || "(빈 칸)"}를 확인해 주세요.`;
          if (x.var && !VAR_RE.test(x.var)) return `변수 이름 "${x.var}"은(는) 영문 대문자, 숫자, _로 적어 주세요. 예: BACKEND`;
          if (seen.has(x.var)) return x.var ? `변수 이름 ${x.var}이(가) 두 번 쓰였어요.` : "변수 이름을 비운 이미지는 하나만 둘 수 있어요.";
          seen.add(x.var);
        }
        return "";
      }
      case "env":
        if (envOn && envMode !== "existing" && !envVars.length) return "인식된 .env 변수가 없어요. 필요 없다면 '없음'을 고르세요.";
        if (envOn && envMode === "existing" && !envPick) return "저장된 환경 변수를 골라 주세요.";
        return "";
      default:
        return "";
    }
  };

  const fail = (m: string) => {
    toast(m, "error");
  };

  const goto = (i: number) => {
    setCur(i);
  };

  const next = () => {
    const v = validateStep(step);
    if (v) return fail(v);
    setSkipped((s) => s.filter((x) => x !== step));
    goto(cur + 1);
  };

  // Optional steps (new job only): image unless the built-in playbook needs one, and env.
  const skipLabel = mode === "new" ? (step === "image" && source !== "builtin" ? "추적 없이 진행" : step === "env" ? ".env 없이 진행" : null) : null;
  const skip = () => {
    if (step === "image") setTracks([]);
    if (step === "env") setEnvChoice("none");
    setSkipped((s) => (s.includes(step) ? s : [...s, step]));
    goto(cur + 1);
  };

  /** Checks every step; jumps to the first one that fails. */
  const validateAll = (): boolean => {
    for (let i = 0; i < flow.length; i++) {
      const v = validateStep(flow[i].id);
      if (v) {
        setCur(i);
        fail(v);
        return false;
      }
    }
    return true;
  };

  const body = () => ({
    name: name.trim(),
    playbook:
      source === "git"
        ? { source: "git", url: url.trim(), branch: branch.trim() || "main", path: path.trim(), key: reused ? NO_KEY : key }
        : { source },
    script: source === "script" ? steps.map(({ name: n, run }) => ({ name: n.trim(), run })) : [],
    servicePath: source === "script" ? servicePath.trim() : "",
    files: source !== "script" ? [] : mode === "new" || filesTouched ? files.map((f) => ({ path: f.path, content: f.content ?? "" })) : undefined,
    extraImages: extras.map((x) => ({ image: x.image.trim(), var: x.var })),
    inventory: inv,
    targets,
    image: image.trim(),
    envMode: envChoice === "keep" ? "keep" : !envOn ? "none" : envMode === "existing" ? "existing" : "paste",
    envName: envOn && envMode === "existing" ? envPick : null,
    envVars: envOn && envMode !== "existing" ? envVars : [],
    hook,
    hookRule,
    protected: prot,
    lock,
    rollback: rb,
    editors: { groups: edGroups, members: edMembers },
  });

  const create = async () => {
    if (!validateAll()) return;
    setBusy(true);
    try {
      await api.post("/jobs", body());
      onClose();
      refresh();
      nav("/jobs");
      toast("배포 작업을 만들었어요");
    } catch (e) {
      fail(errMsg(e));
      setBusy(false);
    }
  };

  const save = async () => {
    if (!job || !validateAll()) return;
    setBusy(true);
    const payload = body();
    const done = () => {
      onClose();
      refresh();
      toast("작업을 고쳤어요");
    };
    try {
      await api.put(`/jobs/${job.id}`, payload);
      done();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.sudoRequired) {
        // Pasting over an existing set writes a new version of its secrets: re-check the password and retry.
        withSudo("환경 변수 덮어쓰기", async () => {
          try {
            await api.put(`/jobs/${job.id}`, payload);
            done();
          } catch (e2) {
            if (e2 instanceof ApiError && e2.sudoRequired) throw e2;
            fail(errMsg(e2));
          }
        });
        return;
      }
      fail(errMsg(e));
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (editing) save();
    else if (last) create();
    else next();
  };

  const keyHint = reused
    ? `이미 연결된 레포를 그대로 써요 · ${reused.auth}`
    : ssh
      ? key
        ? `${key}의 공개 키를 저장소의 Deploy key(읽기 전용)로 등록해 두세요.`
        : "SSH 주소는 SSH 키가 있어야 해요. 키를 추가하거나 HTTPS 주소를 넣어 주세요."
      : key
        ? "이 토큰으로 저장소를 읽어요. 읽기 전용 권한이면 충분해요."
        : "공개 저장소면 그대로 두고, 비공개 저장소면 토큰을 고르세요.";

  /* ---------- editors (access step) ---------- */

  const creator = editing ? job.createdBy : session?.me?.email ?? null;
  const allGroups = groupsRes.data?.groups ?? [];
  // Owner/Admin can always edit and Viewers never can, so only the other roles are worth picking.
  const pickable = (membersRes.data ?? []).filter((m) => m.role !== "Owner" && m.role !== "Admin" && m.role !== "Viewer" && m.email !== creator);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const safetySummary = [prot && "운영 보호", lock && "동시 실행 잠금", rb && "실패 시 되돌리기", hook && "자동 배포"].filter(Boolean).join(", ") || "모두 꺼짐";
  const editorsSummary = (() => {
    const g = edGroups.map((id) => allGroups.find((x) => x.id === id)?.name ?? id);
    const parts = [g.length ? `그룹 ${g.join(", ")}` : "", edMembers.length ? `멤버 ${edMembers.length}명` : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Owner, Admin, 만든 사람만";
  })();
  const envSummary =
    envChoice === "keep"
      ? `${job?.env || "없음"} (지금 것 유지)`
      : !envOn
        ? "없음"
        : envMode === "existing"
          ? envPick
          : `붙여넣은 변수 ${envVars.length}개${editing && job.env ? ` → ${job.env}의 새 버전` : ""}`;

  /* ---------- guide: a bubble that points at the input to fill ---------- */

  // Inputs of the current step in screen order.
  const tipOrder: TipId[] =
    step === "name"
      ? ["name"]
      : step === "playbook"
        ? source === "git"
          ? ["playbook.source", "playbook.url", "playbook.branch", "playbook.path", "playbook.key"]
          : source === "script"
            ? ["playbook.source"]
            : ["playbook.source", "playbook.builtin"]
        : step === "script"
          ? ["playbook.script"]
          : step === "target"
          ? ["target.inv", "target.groups"]
          : step === "image"
            ? ["image"]
            : step === "env"
              ? envOn && envMode !== "existing"
                ? ["env", "env.vars"]
                : ["env"]
              : step === "access"
                ? ["access.editors", "access.safety"]
                : [];
  // Where the guide starts on a step: the first input that still needs something.
  const firstTip = (): TipId | null => {
    if (step === "script") return "playbook.script";
    if (step === "playbook" && source === "script") return "playbook.source";
    if (step === "playbook") return source === "builtin" ? "playbook.builtin" : !url.trim() ? "playbook.url" : !path.trim() ? "playbook.path" : "playbook.key";
    if (step === "env" && envOn && envMode !== "existing" && !envText.trim()) return "env.vars";
    return tipOrder[0] ?? null;
  };
  const [tip, setTipState] = useState<TipId | null>(null);
  const [tipSeq, setTipSeq] = useState(0);
  const setTip = (id: TipId | null) => {
    setTipState(id);
    setTipSeq((n) => n + 1);
  };
  const focusTip = (id: TipId, textOnly = false) => {
    setTip(id);
    requestAnimationFrame(() => {
      const spot = bodyRef.current?.querySelector<HTMLElement>(`[data-tip="${id}"]`);
      const el = spot?.querySelector<HTMLElement>(textOnly ? "input, textarea, [role=combobox]" : "input, textarea, [role=combobox], button, [tabindex='0']");
      el?.focus({ preventScroll: true });
      spot?.scrollIntoView({ block: "nearest" });
    });
  };
  useEffect(() => {
    const t = firstTip();
    if (!guide) return;
    if (t) focusTip(t, true);
    else setTip(null);
  }, [guide, step, source]); // a new step, or the playbook kind changed

  // Arriving at the env step: put the variables the script uses but nobody set yet, ready to fill in.
  useEffect(() => {
    if (step !== "env" || !canEnv || !neededVars.length) return;
    if (envChoice === "keep" || (envOn && envMode === "existing")) return; // a saved set: just show what it lacks
    const have = new Set(parseEnv(envText).map(([k]) => k));
    const missing = neededVars.filter((v) => !have.has(v));
    if (!missing.length) return;
    setEnvChoice("on");
    setEnvMode("paste");
    setEnvText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n` : "") + missing.map((k) => `${k}=`).join("\n"));
    toast(`스크립트에서 쓰는 변수 ${missing.length}개를 넣어 뒀어요. 값을 채워 주세요.`);
  }, [step]); // only when arriving at the step

  /** Variables from an uploaded .env: added to the env step, names already there are skipped. */
  const mergeEnv = (vars: string[][]) => {
    if (!vars.length || !canEnv) return;
    const have = new Set(parseEnv(envOn && envMode === "paste" ? envText : "").map(([k]) => k));
    const add = vars.filter(([k]) => !have.has(k));
    setEnvChoice("on");
    setEnvMode("paste");
    setEnvText((t) => ((envOn && envMode === "paste" && t.trim() ? `${t.replace(/\s+$/, "")}\n` : "") + add.map(([k, v]) => `${k}=${v}`).join("\n")));
    toast(add.length ? `.env의 변수 ${add.length}개를 환경 변수에 더했어요` : ".env의 변수는 이미 다 들어 있어요");
  };
  const guideState = {
    on: guide,
    tip,
    seq: tipSeq,
    mode,
    builtin: source === "builtin",
    nextOf: (id: TipId) => tipOrder[tipOrder.indexOf(id) + 1] ?? null,
    focus: (id: TipId) => focusTip(id),
  };

  /* ---------- steps ---------- */

  const renderStep = () => {
    switch (step) {
      case "name":
        return (
          <Field label="이름" htmlFor="jName">
            <TipSpot id="name">
              <Input id="jName" value={name} onChange={(e) => setName(e.target.value)} placeholder="api-server · production" autoFocus={!editing} />
            </TipSpot>
          </Field>
        );

      case "playbook":
        return (
          <Field label="배포 방법">
            <TipSpot id="playbook.source">
              <div>
              <Seg
                options={[
                  { value: "git", label: "Git 레포" },
                  { value: "script", label: "SSH 스크립트" },
                  { value: "builtin", label: "기본 플레이북" },
                ]}
                value={source}
                onChange={(s) => {
                  setSource(s);
                }}
              />
              </div>
            </TipSpot>
            {source === "git" ? (
              <div key="git" className="flex flex-col gap-3 animate-fade">
                {repos.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Hint>연결된 레포에서 고르기</Hint>
                    <div className="flex flex-wrap gap-1.5">
                      {repos.map((r) => {
                        const on = reused?.name === r.name;
                        return (
                          <button
                            key={r.name}
                            type="button"
                            onClick={() => {
                              setUrl(r.url);
                              setBranch(r.branch);
                            }}
                            aria-pressed={on}
                            title={r.url}
                            className={cx(
                              "inline-flex items-center gap-1.5 max-w-full h-7 px-2.5 rounded-lg border text-[12.5px] transition-colors",
                              on ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface hover:bg-hover",
                            )}
                          >
                            <Icon name="git" className="size-3.5 flex-none" />
                            <span className="font-medium truncate">{r.name}</span>
                            <span className={cx("font-mono text-[11px] flex-none", on ? "text-accent" : "text-faint")}>{r.branch}</span>
                            <span className={cx("text-[11px] truncate", on ? "text-accent" : "text-muted")}>· {r.auth}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <Field label="저장소 URL" htmlFor="jUrl">
                  <TipSpot id="playbook.url">
                  <Input
                    id="jUrl"
                    mono
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="git@github.com:org/ansible.git"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  </TipSpot>
                </Field>
                <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
                  <Field label="브랜치" htmlFor="jBranch">
                    <TipSpot id="playbook.branch">
                      <Input id="jBranch" mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
                    </TipSpot>
                  </Field>
                  <Field label="플레이북 경로" htmlFor="jPath">
                    <TipSpot id="playbook.path">
                      <Input id="jPath" mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="deploy/app.yml" autoComplete="off" spellCheck={false} />
                    </TipSpot>
                  </Field>
                </div>
                <Field
                  label={ssh ? "SSH 키" : "토큰"}
                  htmlFor="jKey"
                  hint={keyHint}
                  error={!reused && ssh && !key}
                  right={
                    !reused && (
                      <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} />)}>
                        키 추가
                      </Button>
                    )
                  }
                >
                  <TipSpot id="playbook.key">
                  <Select id="jKey" value={reused ? NO_KEY : key} onChange={(e) => setKey(e.target.value)} disabled={!!reused} placeholder={ssh ? "SSH 키를 추가해 주세요" : undefined}>
                    {reused && <option value={NO_KEY}>연결된 레포의 인증을 그대로 써요</option>}
                    {!reused && !ssh && <option value={NO_KEY}>공개 저장소(키 없음)</option>}
                    {!reused &&
                      keyOptions.map((k) => (
                        <option key={k.id} value={k.name}>
                          {k.name} · {k.type}
                        </option>
                      ))}
                  </Select>
                  </TipSpot>
                </Field>
              </div>
            ) : source === "script" ? (
              <div key="script" className="flex flex-col gap-3 animate-fade">
                <Field label="서비스 경로" htmlFor="jServicePath" hint={<>스크립트에서 <span className="font-mono">$SERVICE_PATH</span>로 써요.</>}>
                  <Input id="jServicePath" mono spellCheck={false} placeholder={`/srv/${slug(name) || "app"}`} value={servicePath} onChange={(e) => setServicePath(e.target.value)} />
                </Field>
                <FileBundleField
                  jobId={editing ? job.id : null}
                  jobName={job?.name ?? ""}
                  filesVer={job?.filesVer ?? null}
                  files={files}
                  update={(fn) => {
                    setFiles(fn);
                    setFilesTouched(true);
                  }}
                  onEnv={mergeEnv}
                />
              </div>
            ) : (
              <TipSpot id="playbook.builtin">
              <div key="builtin" className="flex gap-2.5 items-start rounded-lg bg-surface-2 border border-line px-3.5 py-3 text-[13px] animate-fade">
                <Icon name="box" className="size-4 mt-px flex-none text-accent" />
                <div className="min-w-0">
                  <b className="block font-semibold mb-0.5">
                    Wharfline 기본 플레이북 <span className="font-mono font-normal text-[12px] text-muted">container.yml</span>
                  </b>
                  <span className="text-muted">이미지 하나를 .env와 함께 컨테이너로 띄워요.</span>
                </div>
              </div>
              </TipSpot>
            )}
          </Field>
        );

      case "script":
        return (
          <Field label="스크립트">
            <TipSpot id="playbook.script">
              <ScriptEditor steps={steps} onChange={setSteps} />
            </TipSpot>
          </Field>
        );

      case "target":
        return (
          <Field
            label="배포 대상"
            right={
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewInventoryModal onClose={c} onCreated={(i) => setInv(i.name)} />)}>
                  인벤토리 추가
                </Button>
                {inventories.length > 0 && (
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewHostModal inventories={inventories} initialInventory={inv} onClose={c} />)}>
                    서버 추가
                  </Button>
                )}
              </span>
            }
            hint={!inventories.length ? "인벤토리가 없어요. 인벤토리를 먼저 추가하세요." : hosts.length ? `서버 ${hosts.length}대` : "이 인벤토리에 서버가 없어요. 서버를 추가하세요."}
            error={!!invObj && !hosts.length}
          >
            <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
              <TipSpot id="target.inv">
              <Select
                id="jInv"
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
              </TipSpot>
              <TipSpot id="target.groups">
                <GroupSelect groups={groups} value={targets} onChange={setTargets} />
              </TipSpot>
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
        );

      case "image":
        return (
          <Field
            label={
              <>
                버전 추적 {source === "builtin" ? <span className="text-accent font-normal text-[12.5px]">필수</span> : <span className="text-muted font-normal text-[12.5px]">선택</span>}
              </>
            }
            hint="추적하는 이미지에 새 버전이 오면 자동 배포하고, 실행할 때 고른 버전을 변수로 넘겨요."
            right={
              <Button size="sm" variant="ghost" icon="plus" title="비공개 이미지를 받을 토큰을 등록해요" onClick={() => openModal((c) => <NewRegistryModal onClose={c} />)}>
                레지스트리 추가
              </Button>
            }
          >
            {fileImages.length > 0 && (
              <div className="flex flex-col rounded-lg border border-line divide-y divide-line">
                <span className="px-3 py-1.5 text-[12px] text-muted bg-surface-2">파일에 있는 이미지</span>
                {fileImages.map((fi) => {
                  const tracked = tracks.some((t) => t.var === fi.var && parseImage(t.image) && "ref" in parseImage(t.image) && (parseImage(t.image) as { ref: string }).ref === fi.ref);
                  return (
                    <div key={`${fi.path}:${fi.value}`} className="flex items-center gap-2 px-3 py-2 text-[12.5px] min-w-0 flex-wrap">
                      <span className="font-mono truncate min-w-0 flex-1" title={`${fi.path}: image: ${fi.value}`}>
                        {fi.value}
                      </span>
                      {fi.fixed ? (
                        <>
                          <Chip tone="warn">버전이 박혀 있어요</Chip>
                          <Button size="sm" onClick={() => trackFixed(fi)}>
                            변수로 바꾸고 추적
                          </Button>
                        </>
                      ) : tracked ? (
                        <Chip tone="ok">추적 중</Chip>
                      ) : (
                        <Button size="sm" onClick={() => setTracks((t) => [...t, { id: ++stepSeq, image: fi.ref, var: fi.var }])}>
                          추적하기
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <TipSpot id="image">
              <ExtraImagesEditor items={tracks} onChange={setTracks} mainLocked={source === "builtin"} />
            </TipSpot>
          </Field>
        );

      case "env": {
        const opts: { value: EnvChoice; label: string }[] = editing
          ? [
              { value: "keep", label: "지금 것 유지" },
              { value: "on", label: "바꾸기" },
              { value: "none", label: "없음" },
            ]
          : [
              { value: "on", label: "넣기" },
              { value: "none", label: "없음" },
            ];
        const hint =
          envChoice === "keep"
            ? job?.env
              ? null
              : "지금은 환경 변수가 없어요."
            : envChoice === "none"
              ? editing && job?.env
                ? "저장하면 .env 없이 배포해요."
                : null
              : editing && job?.env && envMode !== "existing"
                ? <><span className="font-mono">{job.env}</span>의 새 버전으로 저장해요. 저장할 때 비밀번호를 다시 물어요.</>
                : null;
        return (
          <Field
            label={
              <>
                환경 변수 <span className="text-muted font-normal text-[12.5px]">선택</span>
              </>
            }
            right={
              <span data-tip="env">
                <Seg options={opts} value={envChoice} onChange={setEnvChoice} />
              </span>
            }
            hint={hint}
          >
            <TipSpot id="env" arrow="right" className="contents">
              {null}
            </TipSpot>
            {envChoice === "keep" && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 border border-line px-3.5 py-2.5 text-[13px]">
                <Icon name="file" className="size-4 flex-none text-faint" />
                {job?.env ? <span className="font-mono truncate">{job.env}</span> : <span className="text-muted">없음</span>}
              </div>
            )}
            {envOn && (
              <TipSpot id="env.vars">
                <EnvSource
                  text={envText}
                  setText={setEnvText}
                  mode={envMode}
                  setMode={setEnvMode}
                  existing={envs.map((e) => e.name)}
                  picked={envPick}
                  setPicked={setEnvPick}
                  existingOnly={!canEnv}
                />
              </TipSpot>
            )}
            {scriptVars.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                <span className="text-[12px] text-muted">스크립트와 파일에서 쓰는 변수</span>
                <div className="flex flex-wrap gap-1.5">
                  {scriptVars.map((v) => {
                    const auto = autoVars.includes(v);
                    const set = envOn && envMode === "paste" && envVars.some(([k, val]) => k === v && val !== "");
                    return (
                      <Chip key={v} mono tone={auto || set ? "neutral" : "warn"}>
                        {v} <span className="font-sans text-faint">{auto ? "자동" : set ? "넣음" : "값 필요"}</span>
                      </Chip>
                    );
                  })}
                </div>
              </div>
            )}
          </Field>
        );
      }

      case "access":
        return (
          <>
            <Field
              label="편집할 수 있는 사람"
              hint="Owner, Admin, 만든 사람은 항상 고칠 수 있어요."
            >
              <TipSpot id="access.editors">
              <Field
                label="그룹"
                right={
                  session?.me?.role === "Owner" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="plus"
                      onClick={() =>
                        openModal(
                          (c) => <GroupModal repos={groupsRes.data?.repos ?? []} members={membersRes.data ?? []} onClose={c} onCreated={(g) => setEdGroups((x) => [...x, g.id])} />,
                          "md",
                        )
                      }
                    >
                      그룹 추가
                    </Button>
                  )
                }
              >
                {groupsRes.error ? (
                  <Hint>그룹 목록을 불러오지 못했어요.</Hint>
                ) : !allGroups.length ? (
                  <Hint>{groupsRes.data ? "아직 그룹이 없어요." : "불러오는 중…"}</Hint>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {allGroups.map((g) => {
                      const on = edGroups.includes(g.id);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(edGroups, setEdGroups, g.id)}
                          className={cx(
                            "inline-flex items-center gap-1.5 max-w-full h-7 px-2.5 rounded-lg border text-[12.5px] transition-colors",
                            on ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface hover:bg-hover",
                          )}
                        >
                          <Icon name={on ? "check" : "users"} className="size-3.5 flex-none" />
                          <span className="font-medium truncate">{g.name}</span>
                          <span className={cx("text-[11px] flex-none", on ? "text-accent" : "text-faint")}>{g.members.length}명</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Field>
              </TipSpot>
              <Field label="멤버">
                {membersRes.error ? (
                  <Hint>멤버 목록을 불러오지 못했어요.</Hint>
                ) : !pickable.length ? (
                  <Hint>{membersRes.data ? "따로 고를 멤버가 없어요." : "불러오는 중…"}</Hint>
                ) : (
                  <div className="flex flex-col rounded-lg border border-line px-2 py-1 max-h-[180px] overflow-auto scroll-soft">
                    {pickable.map((m) => (
                      <Check
                        key={m.email}
                        checked={edMembers.includes(m.email)}
                        onChange={() => toggle(edMembers, setEdMembers, m.email)}
                        title={
                          <>
                            <span className="font-medium">{m.name}</span> <span className="text-faint text-[12px]">{m.role}</span>
                          </>
                        }
                        desc={m.email}
                      />
                    ))}
                  </div>
                )}
              </Field>
            </Field>
            <Field label="안전장치">
              <TipSpot id="access.safety">
              <div className="flex flex-col rounded-lg border border-line divide-y divide-line">
                <div>
                  <Toggle
                    checked={hook}
                    onChange={setHook}
                    disabled={fixedSafety}
                    title="자동 배포"
                    desc="고른 규칙에 맞는 새 버전이 올라오면 바로 배포해요."
                  />
                  {hook && <HookRulePicker value={hookRule} onChange={setHookRule} disabled={fixedSafety} />}
                </div>
                <Toggle
                  checked={prot}
                  onChange={setProt}
                  disabled={fixedSafety}
                  title="운영 보호"
                  desc="Deployer는 승인을 받아야 실행돼요."
                />
                {fixedSafety && <div className="px-3.5 py-2 text-[12px] text-muted">운영 보호와 자동 배포는 Owner나 Admin만 바꿀 수 있어요.</div>}
                <Toggle checked={lock} onChange={setLock} title="동시 실행 잠금" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
                <Toggle checked={rb} onChange={setRb} title="실패 시 되돌리기" desc="실패하면 직전 버전으로 되돌려요." />
              </div>
              </TipSpot>
            </Field>
          </>
        );

      case "review": {
        const rows: [JobStepId, string, React.ReactNode][] = [
          ["name", "이름", name.trim() || <span className="text-faint">없음</span>],
          [
            "playbook",
            "배포 방법",
            source === "script" ? (
              <>
                SSH 스크립트 · {steps.length}단계 <span className="text-muted text-[12.5px]">({steps.map((st) => st.name.trim() || "이름 없음").join(" → ")})</span>
                <span className="block font-mono text-[12px] text-muted">{servicePath.trim().replace(/\/+$/, "") || `/srv/${slug(name) || "app"}`}</span>
              </>
            ) : source === "builtin" ? (
              <>
                기본 플레이북 <span className="font-mono text-[12px] text-muted">container.yml</span>
              </>
            ) : (
              <span className="font-mono text-[12.5px] break-all">
                {url.trim() || "-"} <span className="text-faint">·</span> {branch.trim() || "main"} <span className="text-faint">·</span> {path.trim() || "-"}
              </span>
            ),
          ],
          ...(source === "script" && files.length
            ? ([["playbook", "파일", <span className="font-mono text-[12.5px] break-all">{files.map((f) => f.path).join(", ")}</span>]] as [JobStepId, string, React.ReactNode][])
            : []),
          ["target", "배포 대상", `${inv || "-"} · ${targets.length ? targets.join(", ") : "전체"} · 서버 ${hosts.length}대`],

          [
            "image",
            "버전 추적",
            tracks.length ? (
              <span className="font-mono text-[12.5px] break-all">{tracks.map((t) => `${t.var || "IMAGE"}=${t.image}`).join(", ")}</span>
            ) : (
              <span className="text-faint">없음</span>
            ),
          ],
          ["env", "환경 변수", envSummary],
          ["access", "권한과 안전장치", `${editorsSummary} · ${safetySummary}`],
        ];
        return (
          <Field label="확인">
            <div className="flex flex-col rounded-lg border border-line divide-y divide-line">
              {rows.map(([id, label, value]) => (
                <div key={id} className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[112px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 items-center px-3.5 py-2.5 text-[13px]">
                  <span className="text-muted text-[12.5px]">{label}</span>
                  <span className="min-w-0">{value}</span>
                  {editing && (
                    <Button size="sm" variant="ghost" className="justify-self-start sm:justify-self-end -ml-2.5 sm:ml-0" onClick={() => goto(flow.findIndex((s) => s.id === id))}>
                      고치기
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Field>
        );
      }
    }
  };

  return (
    <>
      <ModalHead
        title={editing ? "배포 작업 편집" : "새 배포 작업"}
        sub={editing ? job.name : undefined}
        onClose={onClose}
        extra={
          <Button size="sm" variant={guide ? "default" : "ghost"} icon="wand" aria-pressed={guide} title="배포를 도와드릴까요?" onClick={() => setGuide((g) => !g)}>
            <span className="hidden sm:inline">배포를 도와드릴까요?</span>
          </Button>
        }
      />
      <StepIndex steps={flow} mode={editing ? "edit" : "new"} cur={cur} skipped={skipped} onPick={goto} />
      <form id="jobForm" onSubmit={submit} className="contents" noValidate>
        <div
          ref={bodyRef}
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("[data-tip]")) setTip(null);
          }}
          onFocusCapture={(e) => {
            const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]")?.dataset.tip as TipId | undefined;
            if (t) setTip(t);
          }}
          className="modal-body px-5 pt-4 pb-5 overflow-auto scroll-soft flex flex-col gap-5 flex-[0_1_420px] min-h-[140px]">
          <GuideContext.Provider value={guideState}>
            <div key={step} className="flex flex-col gap-5 animate-fade">
              {renderStep()}
            </div>
          </GuideContext.Provider>
        </div>
      </form>
      <ModalFoot between>
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <span className="flex items-center gap-2 flex-wrap justify-end">
          <Button onClick={() => goto(cur - 1)} disabled={cur === 0}>
            이전
          </Button>
          {editing ? (
            <>
              <Button onClick={next} disabled={last}>
                다음
              </Button>
              <Button variant="primary" type="submit" form="jobForm" disabled={busy}>
                {busy ? "저장하는 중…" : "저장"}
              </Button>
            </>
          ) : (
            <>
              {skipLabel && (
                <Button variant="ghost" icon="skip" onClick={skip}>
                  {skipLabel}
                </Button>
              )}
              <Button variant="primary" type="submit" form="jobForm" disabled={busy}>
                {last ? (busy ? "만드는 중…" : "만들기") : "다음"}
              </Button>
            </>
          )}
        </span>
      </ModalFoot>
    </>
  );
}

/** 목차: step numbers and titles in a row. New job: progress only. Edit: every step is done and clickable. */
function StepIndex({ steps, mode, cur, skipped, onPick }: { steps: typeof JOB_STEPS; mode: Mode; cur: number; skipped: JobStepId[]; onPick: (i: number) => void }) {
  return (
    <nav aria-label="단계" className="flex-none px-5 pb-3 border-b border-line overflow-x-auto scroll-soft">
      <ol className="flex items-center gap-1.5 min-w-max sm:min-w-0">
        {steps.map((s, i) => {
          const now = i === cur;
          const wasSkipped = mode === "new" && skipped.includes(s.id) && !now;
          const done = mode === "edit" || (i < cur && !wasSkipped);
          const mark = wasSkipped ? "–" : done ? <Icon name="check" className="size-3" strokeWidth={2.6} /> : i + 1;
          const inner = (
            <>
              <span
                className={cx(
                  "grid place-items-center size-5 rounded-full text-[11px] font-semibold flex-none tabular-nums transition-colors",
                  now ? "bg-primary text-primary-fg" : done ? "bg-accent-soft text-accent" : "bg-hover text-faint",
                )}
              >
                {mark}
              </span>
              <span className={cx("text-[12px] whitespace-nowrap", now ? "font-semibold text-fg" : "hidden sm:inline text-muted")}>{s.label}</span>
            </>
          );
          return (
            <li key={s.id} className="flex items-center gap-1.5 flex-none sm:flex-auto sm:last:flex-none" aria-current={now ? "step" : undefined}>
              {mode === "edit" ? (
                <button type="button" onClick={() => onPick(i)} title={s.label} className="inline-flex items-center gap-1.5 rounded-md px-1 -mx-1 h-6 hover:bg-hover transition-colors">
                  {inner}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5" title={s.label}>
                  {inner}
                </span>
              )}
              {i < steps.length - 1 && <span aria-hidden="true" className={cx("h-px w-3 sm:w-auto sm:flex-1 sm:min-w-2", done && !now ? "bg-accent/40" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Toggle({ checked, onChange, title, desc, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <div className="flex-1 min-w-0 text-[13px]">
        <div className="font-medium">{title}</div>
        <div className="text-[12px] text-muted mt-px">{desc}</div>
      </div>
      <span className="pt-0.5">
        <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
      </span>
    </div>
  );
}

/** Ordered SSH script steps: each runs on every target server; a failed server skips its remaining steps. */
function ScriptEditor({ steps, onChange }: { steps: StepDraft[]; onChange: (s: StepDraft[]) => void }) {
  const set = (id: number, patch: Partial<StepDraft>) => onChange(steps.map((st) => (st.id === id ? { ...st, ...patch } : st)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = () => onChange([...steps, { id: ++stepSeq, name: "", run: "" }]);
  return (
    <div className="flex flex-col gap-2.5 animate-fade">
      {steps.length === 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-dashed border-line-strong px-3.5 py-3 text-[13px] text-muted">
          아직 단계가 없어요.
          <Button size="sm" onClick={() => onChange(SCRIPT_EXAMPLE.map((st) => ({ ...st, id: ++stepSeq })))}>
            예시로 채우기
          </Button>
        </div>
      )}
      {steps.map((st, i) => (
        <div key={st.id} className="rounded-lg border border-line bg-surface p-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="grid place-items-center size-5 rounded-full bg-accent-soft text-accent text-[11px] font-semibold flex-none tabular-nums">{i + 1}</span>
            <Input aria-label={`${i + 1}번째 단계 이름`} placeholder="단계 이름 (예: 이미지 받기)" value={st.name} onChange={(e) => set(st.id, { name: e.target.value })} />
            <Button size="sm" variant="ghost" iconOnly icon="chev" className="rotate-180" aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)} />
            <Button size="sm" variant="ghost" iconOnly icon="chev" aria-label="아래로" disabled={i === steps.length - 1} onClick={() => move(i, 1)} />
            <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="단계 지우기" onClick={() => onChange(steps.filter((x) => x.id !== st.id))} />
          </div>
          <Textarea
            aria-label={`${i + 1}번째 단계 명령`}
            rows={Math.min(6, Math.max(2, st.run.split("\n").length))}
            className="font-mono text-[12.5px]"
            spellCheck={false}
            placeholder={"docker compose pull"}
            value={st.run}
            onChange={(e) => set(st.id, { run: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button size="sm" icon="plus" onClick={add}>
          단계 추가
        </Button>
        {steps.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange(SCRIPT_EXAMPLE.map((st) => ({ ...st, id: ++stepSeq })))}>
            예시로 바꾸기
          </Button>
        )}
      </div>
      <Hint>
        단계마다 새 셸이에요(<span className="font-mono">cd</span>가 이어지지 않아요).
      </Hint>
    </div>
  );
}

type FileUpdate = (fn: (prev: BundleFile[]) => BundleFile[]) => void;

/** Same rules as the server (app/bundles.py): a relative path inside SERVICE_PATH. */
const FILE_PART_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
function cleanFilePath(raw: string): string | null {
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
const riskyIn = (text: string) => RISKY_FILE.filter(([re]) => re.test(text)).map(([, m]) => m);
const byteSize = (text: string) => new TextEncoder().encode(text).length;
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * Files uploaded to SERVICE_PATH before the script: write one here, or upload a docker-compose.yaml or a
 * zip (a Kubernetes yaml set, a Makefile...). Each file is a card; opening it shows the content to read or edit.
 */
function FileBundleField({
  jobId,
  jobName,
  filesVer,
  files,
  update,
  onEnv,
}: {
  jobId: string | null;
  jobName: string;
  filesVer: number | null;
  files: BundleFile[];
  update: FileUpdate;
  onEnv: (vars: string[][]) => void;
}) {
  const { toast, openModal } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [dropped, setDropped] = useState<{ path: string; reason: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const updateRef = useRef(update);
  updateRef.current = update;

  // Editing: the job list only has names and sizes; load the contents once so they can be opened and saved again.
  useEffect(() => {
    if (!jobId || !files.length || files.every((f) => f.content !== undefined)) return;
    api.get<BundleFile[]>(`/jobs/${jobId}/files`).then(
      (full) => updateRef.current(() => full),
      () => toast("파일 내용을 불러오지 못했어요", "error"),
    );
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.post<{ files: BundleFile[]; env: string[][]; dropped: { path: string; reason: string }[] }>("/bundles/parse", {
        name: file.name,
        data: await fileToBase64(file),
      });
      update((prev) => {
        const byPath = new Map(prev.map((f) => [f.path, f]));
        r.files.forEach((f) => byPath.set(f.path, f)); // same path: the new upload wins
        return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
      });
      setDropped(r.dropped);
      onEnv(r.env);
      toast(`파일 ${r.files.length}개를 올렸어요`);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const edit = (file: BundleFile | null) =>
    openModal(
      (c) => (
        <FileEditorModal
          file={file}
          taken={files.map((f) => f.path).filter((p) => p !== file?.path)}
          onClose={c}
          onSave={(next) =>
            update((prev) =>
              [...prev.filter((f) => f.path !== file?.path && f.path !== next.path), next].sort((a, b) => a.path.localeCompare(b.path)),
            )
          }
          onDelete={file ? () => update((prev) => prev.filter((f) => f.path !== file.path)) : undefined}
        />
      ),
      "wide",
    );

  return (
    <Field
      label={
        <>
          파일 <span className="text-muted font-normal text-[12.5px]">선택</span>
        </>
      }
      right={
        <span className="flex gap-1 flex-wrap">
          {jobId && filesVer && (
            <Button size="sm" variant="ghost" icon="history" onClick={() => openModal((c) => <FileHistoryModal jobId={jobId} jobName={jobName} onClose={c} />, "wide")}>
              기록 · v{filesVer}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "읽는 중…" : "올리기"}
          </Button>
          <Button size="sm" icon="plus" onClick={() => edit(null)}>
            새 파일
          </Button>
        </span>
      }
      hint={<><span className="font-mono">$SERVICE_PATH</span>에 올라가요. zip도 돼요.</>}
    >
      <input ref={input} type="file" hidden accept=".yaml,.yml,.zip,.json,.conf,.sh,Makefile,*" onChange={(e) => pick(e.target.files)} />
      {files.length === 0 ? (
        <button
          type="button"
          onClick={() => edit(null)}
          className="rounded-lg border border-dashed border-line-strong px-3.5 py-4 text-[13px] text-muted text-center hover:bg-hover hover:text-fg transition-colors"
        >
          <span className="text-accent font-medium">새 파일</span> 또는 올리기
        </button>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-2">
          {files.map((f) => {
            const risky = f.content !== undefined ? riskyIn(f.content) : f.warnings ?? [];
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => edit(f)}
                title="눌러서 내용 보기 · 고치기"
                className="group flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-left hover:border-accent/40 hover:bg-hover transition-colors min-w-0"
              >
                <span className="grid place-items-center size-8 rounded-md bg-surface-2 text-faint group-hover:text-accent flex-none">
                  <Icon name="file" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[12.5px] truncate">{f.path}</span>
                  <span className="block text-[11.5px] text-faint">
                    {fmtSize(f.size)}
                    {f.content !== undefined && ` · ${f.content.split("\n").length}줄`}
                  </span>
                </span>
                {risky.length > 0 && <Chip tone="warn">주의</Chip>}
                <Icon name="edit" className="size-3.5 text-faint group-hover:text-accent flex-none" />
              </button>
            );
          })}
        </div>
      )}
      {dropped.length > 0 && <Hint>빠진 파일: {dropped.map((d) => `${d.path} (${d.reason})`).join(", ")}</Hint>}
    </Field>
  );
}

/** Read or edit one file of the bundle: its path and content. A new file starts empty. */
function FileEditorModal({
  file,
  taken,
  onSave,
  onDelete,
  onClose,
}: {
  file: BundleFile | null;
  taken: string[];
  onSave: (f: BundleFile) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const [path, setPath] = useState(file?.path ?? "");
  const [content, setContent] = useState(file?.content ?? "");
  const risky = riskyIn(content);
  const lines = content.split("\n").length;

  const save = () => {
    const p = cleanFilePath(path);
    if (!p) return toast("파일 이름은 docker-compose.yaml이나 k8s/01_namespace.yaml처럼 적어 주세요. /로 시작하거나 ..은 쓸 수 없어요.", "error");
    if (p.split("/").pop() === ".env") return toast(".env는 파일로 두지 않아요. 환경 변수 단계에 넣어 주세요.", "error");
    if (taken.includes(p)) return toast(`${p}이(가) 이미 있어요.`, "error");
    const size = byteSize(content);
    if (size > 512 * 1024) return toast("파일 하나는 512KB까지예요.", "error");
    onSave({ path: p, content, size });
    onClose();
  };

  return (
    <>
      <ModalHead title={file ? "파일" : "새 파일"} sub={file ? undefined : "$SERVICE_PATH에 이 이름으로 올라가요."} onClose={onClose} />
      <div className="flex flex-col gap-3 px-5 pb-4 flex-1 min-h-0">
        <Input mono aria-label="파일 이름" placeholder="docker-compose.yaml" value={path} onChange={(e) => setPath(e.target.value)} autoFocus={!file} />
        <Textarea
          aria-label="파일 내용"
          spellCheck={false}
          className="font-mono text-[12.5px] leading-relaxed flex-1 min-h-[320px] resize-none"
          placeholder={"services:\n  app:\n    image: ghcr.io/acme/api:${API_TAG}\n    env_file: .env\n    restart: unless-stopped"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoFocus={!!file}
        />
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
          <span>
            {lines}줄 · {fmtSize(byteSize(content))}
          </span>
          {risky.length > 0 && <Chip tone="warn">서버 권한을 넘기는 설정: {risky.join(", ")}</Chip>}
        </div>
      </div>
      <ModalFoot between>
        {onDelete ? (
          <Button
            variant="dangerGhost"
            icon="trash"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            파일 빼기
          </Button>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={save}>
            {file ? "저장" : "추가"}
          </Button>
        </span>
      </ModalFoot>
    </>
  );
}

/** Tracked images. VAR -> $VAR_TAG, $VAR_IMAGE; an empty name is the main image -> $IMAGE_TAG, $IMAGE. */
function ExtraImagesEditor({ items, onChange, mainLocked }: { items: ExtraDraft[]; onChange: (x: ExtraDraft[]) => void; mainLocked?: boolean }) {
  const set = (id: number, patch: Partial<ExtraDraft>) => onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const cols = "grid grid-cols-[minmax(0,1fr)_140px_auto] gap-2";
  const hasMain = items.some((x) => x.var === "");
  // With the built-in playbook the first image is the one it runs: its variable name stays empty.
  const locked = (x: ExtraDraft, i: number) => !!mainLocked && i === 0 && x.var === "";
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <div className={cx(cols, "text-[12px] font-medium text-muted")}>
          <span>이미지</span>
          <span>변수 이름</span>
          <span className="w-7" />
        </div>
      )}
      {items.map((x, i) => (
        <div key={x.id} className="flex flex-col gap-1">
          <div className={cx(cols, "items-center")}>
            <Input
              mono
              aria-label="이미지"
              placeholder="ghcr.io/acme/backend:v1.2.0"
              value={x.image}
              onChange={(e) => set(x.id, { image: e.target.value, ...(x.auto && !locked(x, i) ? { var: varFromImage(e.target.value) } : {}) })}
            />
            <Input
              mono
              aria-label="변수 이름"
              placeholder="IMAGE"
              disabled={locked(x, i)}
              value={x.var}
              onChange={(e) => set(x.id, { var: e.target.value.toUpperCase(), auto: false })}
            />
            <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="이미지 빼기" onClick={() => onChange(items.filter((y) => y.id !== x.id))} />
          </div>
          <span className="text-[11.5px] text-faint font-mono">
            ${x.var || "IMAGE"}_TAG · ${x.var || "IMAGE"}
            {x.var ? "_IMAGE" : ""}
          </span>
        </div>
      ))}
      <div>
        <Button size="sm" icon="plus" onClick={() => onChange([...items, { id: ++stepSeq, image: "", var: "", auto: hasMain || items.length > 0 }])}>
          이미지 더하기
        </Button>
      </div>
    </div>
  );
}

const HOOK_PRESETS: { value: string; label: string }[] = [
  { value: "v", label: "v로 시작 · v1.2.0, v2026.11.08-1" },
  { value: "date", label: "날짜 · 2026.11.08-1, v2026.11.08-1" },
  { value: "any", label: "latest 빼고 전부" },
  { value: "re:", label: "직접 입력 (정규식)" },
];

/** Which new tags start an auto-deploy. "re:<regex>" must match the whole tag. */
function HookRulePicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const custom = value.startsWith("re:");
  return (
    <div className="flex flex-col gap-2 px-3.5 pb-3 -mt-1">
      <Select aria-label="자동 배포 규칙" value={custom ? "re:" : value} disabled={disabled} onChange={(e) => onChange(e.target.value === "re:" ? "re:release-\\d+" : e.target.value)}>
        {HOOK_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </Select>
      {custom && (
        <Input mono aria-label="태그 정규식" disabled={disabled} placeholder="release-\\d+" value={value.slice(3)} onChange={(e) => onChange(`re:${e.target.value}`)} />
      )}
    </div>
  );
}
