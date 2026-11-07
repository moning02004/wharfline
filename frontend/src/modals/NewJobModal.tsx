import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet, Inventory, Key, Repo } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { NewKeyModal } from "./ResourceModals";
import { Button, Chip, ErrorText, Field, Hint, Input, Select, Seg, Switch, cx } from "../components/ui";

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

const VARS: [string, string][] = [
  ["image", "이미지 주소 (태그 없이)"],
  ["image_tag", "배포할 태그"],
  ["image_ref", "이미지 주소:태그"],
  ["env_file", "서버에 둔 .env 경로"],
  ["app_name", "작업 이름으로 만든 이름"],
];

export function NewJobModal({ onClose }: { onClose: () => void }) {
  const { toast, refresh, openModal } = useApp();
  const nav = useNavigate();
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const repos = (useApi<Repo[]>("/repos").data ?? []).filter((r) => r.kind === "git");
  const keys = useApi<Key[]>("/keys").data ?? [];
  const envs = useApi<EnvSet[]>("/envs").data ?? [];

  const [name, setName] = useState("");
  const [source, setSource] = useState<"git" | "builtin">("git");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("");
  const [key, setKey] = useState(NO_KEY);
  const [inv, setInv] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [image, setImage] = useState("");
  const [envOn, setEnvOn] = useState(false);
  const [envMode, setEnvMode] = useState<EnvMode>("paste");
  const [envText, setEnvText] = useState("");
  const [envPick, setEnvPick] = useState("");
  const [adv, setAdv] = useState(false);
  const [hook, setHook] = useState(false);
  const [prot, setProt] = useState(true);
  const [lock, setLock] = useState(true);
  const [rb, setRb] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const errRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!inv && inventories[0]) setInv(inventories[0].name);
  }, [inventories, inv]);
  useEffect(() => {
    if (!envPick && envs[0]) setEnvPick(envs[0].name);
  }, [envs, envPick]);

  // Keys that fit the URL: SSH keys for git@/ssh:// (one is required), tokens for https (optional).
  const ssh = isSsh(url);
  const keyOptions = keys.filter((k) => k.kind === (ssh ? "ssh" : "token"));
  useEffect(() => {
    if (key && keyOptions.some((k) => k.name === key)) return;
    setKey(ssh ? keyOptions[0]?.name ?? NO_KEY : NO_KEY);
  }, [ssh, keys.length]); // re-pick when the scheme changes or a key is added

  // Same URL + branch as a connected repo: the server reuses it and ignores the key.
  const reused = repos.find((r) => r.url === url.trim() && r.branch === (branch.trim() || "main"));

  const invObj = inventories.find((i) => i.name === inv);
  const groups = useMemo(() => {
    const m: Record<string, Inventory["hosts"]> = {};
    invObj?.hosts.forEach((h) => (m[h.group] ??= []).push(h));
    return m;
  }, [invObj]);
  const hosts = invObj?.hosts.filter((h) => !targets.length || targets.includes(h.group)) ?? [];

  const parsed = image.trim() ? parseImage(image) : null;
  const envVars = parseEnv(envText);

  /** Client-side check; the server validates everything again. */
  const validate = (): string => {
    if (!name.trim()) return "이름을 넣어 주세요.";
    if (source === "git") {
      if (!/^(git@|ssh:\/\/|https:\/\/)/.test(url.trim()))
        return "저장소 주소를 확인해 주세요. 예: git@github.com:org/ansible.git 또는 https://github.com/org/ansible.git";
      if (!PATH_RE.test(path.trim())) return "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml";
      if (ssh && !reused && !key) return "SSH 주소는 SSH 키가 있어야 해요. 키를 추가하거나 HTTPS 주소를 넣어 주세요.";
    }
    if (source === "builtin" && !image.trim()) return "기본 플레이북은 띄울 이미지가 있어야 해요.";
    if (parsed && "error" in parsed) return parsed.error;
    if (!hosts.length) return "배포할 서버가 없어요. 인벤토리나 그룹을 바꿔 주세요.";
    if (envOn && envMode !== "existing" && !envVars.length) return "인식된 .env 변수가 없어요. 필요 없다면 '없음'을 고르세요.";
    if (envOn && envMode === "existing" && !envPick) return "저장된 환경 변수를 골라 주세요.";
    return "";
  };

  const fail = (m: string) => {
    setErr(m);
    requestAnimationFrame(() => errRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) return fail(v);
    setErr("");
    setBusy(true);
    try {
      await api.post("/jobs", {
        name: name.trim(),
        playbook:
          source === "git"
            ? { source: "git", url: url.trim(), branch: branch.trim() || "main", path: path.trim(), key: reused ? NO_KEY : key }
            : { source: "builtin" },
        inventory: inv,
        targets,
        image: image.trim(),
        envMode: !envOn ? "none" : envMode === "existing" ? "existing" : "paste",
        envName: envOn && envMode === "existing" ? envPick : null,
        envVars: envOn && envMode !== "existing" ? envVars : [],
        hook,
        protected: prot,
        lock,
        rollback: rb,
      });
      onClose();
      refresh();
      nav("/jobs");
      toast("배포 작업을 만들었어요");
    } catch (e) {
      fail(errMsg(e));
      setBusy(false);
    }
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

  return (
    <>
      <ModalHead title="새 배포 작업" sub="플레이북과 배포 대상만 정하면 돼요. 나머지는 필요할 때만 채우세요." onClose={onClose} />
      <form id="jobForm" onSubmit={submit} className="contents" noValidate>
        <ModalBody>
          <Field label="이름" htmlFor="jName">
            <Input id="jName" value={name} onChange={(e) => setName(e.target.value)} placeholder="api-server · production" autoFocus />
          </Field>

          <Field
            label="플레이북"
            hint={
              <span className="block mt-1">
                <span className="block mb-1">플레이북은 아래 변수를 받아요. 이미지나 .env가 없으면 그 변수는 빠져요.</span>
                <span className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {VARS.map(([v, d]) => (
                    <span key={v} className="contents">
                      <code className="font-mono text-[11.5px] text-fg">{`{{ ${v} }}`}</code>
                      <span className="text-faint truncate">{d}</span>
                    </span>
                  ))}
                </span>
              </span>
            }
          >
            <div>
              <Seg
                options={[
                  { value: "git", label: "Git 레포" },
                  { value: "builtin", label: "기본 플레이북" },
                ]}
                value={source}
                onChange={(s) => {
                  setSource(s);
                  setErr("");
                }}
              />
            </div>
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
                              setErr("");
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
                  <Input
                    id="jUrl"
                    mono
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="git@github.com:org/ansible.git"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
                  <Field label="브랜치" htmlFor="jBranch">
                    <Input id="jBranch" mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label="플레이북 경로" htmlFor="jPath">
                    <Input id="jPath" mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="deploy/app.yml" autoComplete="off" spellCheck={false} />
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
                </Field>
              </div>
            ) : (
              <div key="builtin" className="flex gap-2.5 items-start rounded-lg bg-surface-2 border border-line px-3.5 py-3 text-[13px] animate-fade">
                <Icon name="box" className="size-4 mt-px flex-none text-accent" />
                <div className="min-w-0">
                  <b className="block font-semibold mb-0.5">
                    Wharfline 기본 플레이북 <span className="font-mono font-normal text-[12px] text-muted">container.yml</span>
                  </b>
                  <span className="text-muted">이미지 하나를 .env와 함께 컨테이너로 띄워요. 플레이북이 없을 때 쓰세요. 아래에서 이미지를 꼭 넣어 주세요.</span>
                </div>
              </div>
            )}
          </Field>

          <Field
            label="배포 대상"
            hint={
              hosts.length ? (
                <>
                  서버 {hosts.length}대{targets.length ? "" : " · 그룹을 고르지 않으면 전체 서버에 배포해요"}
                </>
              ) : (
                "이 인벤토리와 그룹에 서버가 없어요."
              )
            }
            error={!!invObj && !hosts.length}
          >
            <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
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

          <Field
            label={
              <>
                이미지 {source === "builtin" ? <span className="text-accent font-normal text-[12.5px]">필수</span> : <span className="text-muted font-normal text-[12.5px]">선택</span>}
              </>
            }
            htmlFor="jImage"
            error={!!parsed && "error" in parsed}
            hint={
              parsed && "error" in parsed
                ? parsed.error
                : "레지스트리 주소가 없으면 Docker Hub예요. 비공개 이미지는 레지스트리에 토큰을 등록해 두면 자동으로 써요."
            }
          >
            <Input
              id="jImage"
              mono
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="postgres:15 또는 ghcr.io/acme/api:v1.2"
              autoComplete="off"
              spellCheck={false}
            />
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

          <Field
            label={
              <>
                환경 변수 <span className="text-muted font-normal text-[12.5px]">선택</span>
              </>
            }
            right={
              <Seg
                options={[
                  { value: "on", label: "넣기" },
                  { value: "none", label: "없음" },
                ]}
                value={envOn ? "on" : "none"}
                onChange={(v) => setEnvOn(v === "on")}
              />
            }
            hint={!envOn && "앱이 읽을 .env 없이 배포해요. 필요하면 넣기를 눌러 붙여넣거나 저장된 것을 고르세요."}
          >
            {envOn && (
              <EnvSource text={envText} setText={setEnvText} mode={envMode} setMode={setEnvMode} existing={envs.map((e) => e.name)} picked={envPick} setPicked={setEnvPick} />
            )}
          </Field>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setAdv((a) => !a)}
              aria-expanded={adv}
              className="self-start inline-flex items-center gap-1.5 h-7 -ml-1 px-1 rounded-md text-[13px] font-medium text-muted hover:text-fg transition-colors"
            >
              <Icon name="chev" className={cx("size-3.5 transition-transform", adv ? "" : "-rotate-90")} />
              고급
              {!adv && (
                <span className="text-faint font-normal text-[12px]">
                  · {[prot && "운영 보호", lock && "동시 실행 잠금", rb && "실패 시 되돌리기", hook && "자동 배포"].filter(Boolean).join(", ") || "모두 꺼짐"}
                </span>
              )}
            </button>
            {adv && (
              <div className="flex flex-col rounded-lg border border-line divide-y divide-line animate-fade">
                <Toggle checked={hook} onChange={setHook} title="자동 배포" desc="새 이미지 태그가 올라오면 바로 배포해요. 레지스트리 webhook의 서명을 검증하고, v로 시작하는 릴리스 태그만 받아요." />
                <Toggle checked={prot} onChange={setProt} title="운영 보호" desc="Deployer가 실행하면 Admin의 승인을 받은 뒤 시작돼요." />
                <Toggle checked={lock} onChange={setLock} title="동시 실행 잠금" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
                <Toggle checked={rb} onChange={setRb} title="실패 시 되돌리기" desc="상태 확인이 실패하면 직전에 성공한 태그로 되돌려요." />
              </div>
            )}
          </div>

          {err && (
            <div ref={errRef}>
              <ErrorText>{err}</ErrorText>
            </div>
          )}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" type="submit" form="jobForm" disabled={busy}>
          {busy ? "만드는 중…" : "만들기"}
        </Button>
      </ModalFoot>
    </>
  );
}

function Toggle({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <div className="flex-1 min-w-0 text-[13px]">
        <div className="font-medium">{title}</div>
        <div className="text-[12px] text-muted mt-px">{desc}</div>
      </div>
      <span className="pt-0.5">
        <Switch checked={checked} onChange={onChange} label={title} />
      </span>
    </div>
  );
}
