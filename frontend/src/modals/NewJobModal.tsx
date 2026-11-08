import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet, Group, Inventory, Job, Key, Member, Repo } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { ModalFoot, ModalHead } from "../components/Modal";
import { GuideContext, JOB_STEPS, TipSpot, type JobStepId, type TipId } from "./JobGuide";
import { NewHostModal, NewInventoryModal, NewKeyModal, NewRegistryModal } from "./ResourceModals";
import { GroupModal } from "./AccessModals";
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

/** A starting point like the usual CI deploy: pull the new image, recreate, clean up. */
const SCRIPT_EXAMPLE: Omit<StepDraft, "id">[] = [
  { name: "이미지 받기", run: "cd /srv/$APP_NAME\ndocker compose pull" },
  { name: "컨테이너 교체", run: "cd /srv/$APP_NAME\ndocker compose up -d --remove-orphans" },
  { name: "정리", run: "docker image prune -f" },
];
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
  const [key, setKey] = useState(NO_KEY);
  const [inv, setInv] = useState(job?.inventory ?? "");
  const [targets, setTargets] = useState<string[]>(job ? [...job.targets] : []);
  const [image, setImage] = useState(job ? jobImageText(job) : "");
  const [envChoice, setEnvChoice] = useState<EnvChoice>(editing ? "keep" : "none");
  const [envMode, setEnvMode] = useState<EnvMode>(canEnv ? "paste" : "existing");
  const [envText, setEnvText] = useState("");
  const [envPick, setEnvPick] = useState(job?.env ?? "");
  const [hook, setHook] = useState(job ? job.hook : false);
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

  const step = JOB_STEPS[cur].id;
  const last = cur === JOB_STEPS.length - 1;

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

  const parsed = image.trim() ? parseImage(image) : null;
  const envVars = parseEnv(envText);
  const envOn = envChoice === "on";

  /** Client-side check of one step; the server validates everything again. */
  const validateStep = (id: JobStepId): string => {
    switch (id) {
      case "name":
        return name.trim() ? "" : "이름을 넣어 주세요.";
      case "playbook":
        if (source === "script") {
          if (!steps.length) return "스크립트 단계를 하나 이상 넣어 주세요.";
          const bad = steps.findIndex((st) => !st.name.trim() || !st.run.trim());
          return bad >= 0 ? `${bad + 1}번째 단계의 이름과 명령을 적어 주세요.` : "";
        }
        if (source !== "git") return "";
        if (!reused && !/^(git@|ssh:\/\/|https:\/\/)/.test(url.trim()))
          return "저장소 주소를 확인해 주세요. 예: git@github.com:org/ansible.git 또는 https://github.com/org/ansible.git";
        if (!PATH_RE.test(path.trim())) return "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml";
        if (ssh && !reused && !key) return "SSH 주소는 SSH 키가 있어야 해요. 키를 추가하거나 HTTPS 주소를 넣어 주세요.";
        return "";
      case "target":
        return hosts.length ? "" : "배포할 서버가 없어요. 인벤토리나 그룹을 바꿔 주세요.";
      case "image":
        if (source === "builtin" && !image.trim()) return "기본 플레이북은 띄울 이미지가 있어야 해요.";
        return parsed && "error" in parsed ? parsed.error : "";
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
  const skipLabel = mode === "new" ? (step === "image" && source !== "builtin" ? "이미지 없이 진행" : step === "env" ? ".env 없이 진행" : null) : null;
  const skip = () => {
    if (step === "image") setImage("");
    if (step === "env") setEnvChoice("none");
    setSkipped((s) => (s.includes(step) ? s : [...s, step]));
    goto(cur + 1);
  };

  /** Checks every step; jumps to the first one that fails. */
  const validateAll = (): boolean => {
    for (let i = 0; i < JOB_STEPS.length; i++) {
      const v = validateStep(JOB_STEPS[i].id);
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
    inventory: inv,
    targets,
    image: image.trim(),
    envMode: envChoice === "keep" ? "keep" : !envOn ? "none" : envMode === "existing" ? "existing" : "paste",
    envName: envOn && envMode === "existing" ? envPick : null,
    envVars: envOn && envMode !== "existing" ? envVars : [],
    hook,
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
            ? ["playbook.source", "playbook.script"]
            : ["playbook.source", "playbook.builtin"]
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
    if (step === "playbook" && source === "script") return "playbook.script";
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
              <TipSpot id="playbook.script">
                <ScriptEditor steps={steps} onChange={setSteps} />
              </TipSpot>
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
                배포할 이미지 {source === "builtin" ? <span className="text-accent font-normal text-[12.5px]">필수</span> : <span className="text-muted font-normal text-[12.5px]">선택</span>}
              </>
            }
            htmlFor="jImage"
            error={!!parsed && "error" in parsed}
            hint={parsed && "error" in parsed ? parsed.error : "서버에서 컨테이너로 실행할 이미지예요."}
            right={
              <Button size="sm" variant="ghost" icon="plus" title="비공개 이미지를 받을 토큰을 등록해요" onClick={() => openModal((c) => <NewRegistryModal onClose={c} />)}>
                레지스트리 추가
              </Button>
            }
          >
            <TipSpot id="image">
            <Input
              id="jImage"
              mono
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="postgres:15 또는 ghcr.io/acme/api:v1.2"
              autoComplete="off"
              spellCheck={false}
            />
            </TipSpot>
            {parsed && "ref" in parsed && (
              <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0 animate-fade">
                <Icon name="check" className="size-3 flex-none text-ok" strokeWidth={2.6} />
                <span className="font-mono truncate">{parsed.ref}</span>
                <span className="text-faint">·</span>
                <span className="font-mono flex-none">{parsed.tag}</span>
                {parsed.tag === "latest" && <span className="text-faint truncate">실행할 때 가장 최근 태그로 고정해요</span>}
              </div>
            )}
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
              ? <>지금 쓰는 <span className="font-mono">{job.env}</span>을(를) 그대로 둬요.</>
              : "지금은 환경 변수가 없어요. 그대로 둬요."
            : envChoice === "none"
              ? editing && job?.env
                ? "저장하면 이 작업은 .env 없이 배포해요. 저장된 세트는 지워지지 않아요."
                : "앱이 읽을 .env 없이 배포해요. 필요하면 넣기를 눌러 붙여넣거나 저장된 것을 고르세요."
              : editing && job?.env && envMode !== "existing"
                ? <>붙여넣은 내용은 <span className="font-mono">{job.env}</span>의 새 버전으로 저장돼요. 비밀 값을 바꾸는 일이라 저장할 때 비밀번호를 다시 확인해요.</>
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
                <Toggle
                  checked={hook}
                  onChange={setHook}
                  disabled={fixedSafety}
                  title="자동 배포"
                  desc="새 이미지 태그가 올라오면 바로 배포해요. 레지스트리 webhook의 서명을 검증하고, v로 시작하는 릴리스 태그만 받아요. 운영 보호가 켜져 있으면 승인을 받은 뒤 배포해요."
                />
                <Toggle
                  checked={prot}
                  onChange={setProt}
                  disabled={fixedSafety}
                  title="운영 보호"
                  desc="Deployer가 실행하면 Owner나 Admin의 승인을 받은 뒤 시작돼요."
                />
                {fixedSafety && <div className="px-3.5 py-2 text-[12px] text-muted">운영 보호와 자동 배포는 Owner나 Admin만 바꿀 수 있어요.</div>}
                <Toggle checked={lock} onChange={setLock} title="동시 실행 잠금" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
                <Toggle checked={rb} onChange={setRb} title="실패 시 되돌리기" desc="상태 확인이 실패하면 직전에 성공한 태그로 되돌려요." />
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
          ["target", "배포 대상", `${inv || "-"} · ${targets.length ? targets.join(", ") : "전체"} · 서버 ${hosts.length}대`],
          [
            "image",
            "이미지",
            parsed && "ref" in parsed ? <span className="font-mono text-[12.5px] break-all">{`${parsed.ref}:${parsed.tag}`}</span> : <span className="text-faint">없음</span>,
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
                    <Button size="sm" variant="ghost" className="justify-self-start sm:justify-self-end -ml-2.5 sm:ml-0" onClick={() => goto(JOB_STEPS.findIndex((s) => s.id === id))}>
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
      <StepIndex mode={editing ? "edit" : "new"} cur={cur} skipped={skipped} onPick={goto} />
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
function StepIndex({ mode, cur, skipped, onPick }: { mode: Mode; cur: number; skipped: JobStepId[]; onPick: (i: number) => void }) {
  return (
    <nav aria-label="단계" className="flex-none px-5 pb-3 border-b border-line overflow-x-auto scroll-soft">
      <ol className="flex items-center gap-1.5 min-w-max sm:min-w-0">
        {JOB_STEPS.map((s, i) => {
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
              {i < JOB_STEPS.length - 1 && <span aria-hidden="true" className={cx("h-px w-3 sm:w-auto sm:flex-1 sm:min-w-2", done && !now ? "bg-accent/40" : "bg-line")} />}
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
        단계마다 따로 셸이 열려요(앞 단계의 <span className="font-mono">cd</span>는 이어지지 않아요). 쓸 수 있는 변수:{" "}
        <span className="font-mono">$IMAGE $IMAGE_TAG $IMAGE_REF $APP_NAME $ENV_FILE</span>. 비공개 이미지면 Wharfline이 앞뒤로 레지스트리 로그인·로그아웃을 해요.
      </Hint>
    </div>
  );
}
