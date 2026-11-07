import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet, Image, Inventory, Repo } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Check, Chip, ErrorText, Field, Hint, Input, Select, Seg, Textarea, cx } from "../components/ui";

const COMPOSE_TPL = `services:
  app:
    image: \${IMAGE}:\${IMAGE_TAG}
    env_file: .env
    restart: unless-stopped
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 10s
`;

const RISKY: [RegExp, string][] = [
  [/privileged:\s*true/, "privileged: true"],
  [/network_mode:\s*["']?host/, "network_mode: host"],
  [/docker\.sock/, "docker.sock 마운트"],
  [/^\s*build:/m, "build:"],
  [/pid:\s*["']?host/, "pid: host"],
  [/cap_add:/, "cap_add"],
];

type StepId = "basic" | "target" | "method" | "env" | "safety" | "review";
const STEPS: { id: StepId; label: string; desc: string; skip?: string }[] = [
  { id: "basic", label: "기본 정보", desc: "작업 이름과 배포할 이미지를 정해요." },
  { id: "target", label: "배포 대상", desc: "어느 서버 묶음의 어떤 그룹에 보낼지 골라요." },
  { id: "method", label: "배포 방식", desc: "Compose로 바로 교체하거나, 연결한 Ansible 플레이북을 실행해요." },
  { id: "env", label: "환경 변수", desc: "앱이 읽을 .env예요. 없어도 배포할 수 있어요.", skip: ".env 없이 진행" },
  { id: "safety", label: "안전장치", desc: "실행 방식과 실패했을 때의 동작이에요.", skip: "기본값 사용" },
  { id: "review", label: "확인", desc: "내용을 확인하고 만들어요." },
];

export function NewJobModal({ onClose }: { onClose: () => void }) {
  const { toast, refresh } = useApp();
  const nav = useNavigate();
  const images = useApi<{ images: Image[] }>("/registries").data?.images ?? [];
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const repos = useApi<Repo[]>("/repos").data ?? [];
  const envs = useApi<EnvSet[]>("/envs").data ?? [];

  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Partial<Record<StepId, "done" | "skipped">>>({});
  const [name, setName] = useState("batch-worker · staging");
  const [image, setImage] = useState("git.acme.kr/acme/batch-worker");
  const [tag, setTag] = useState("latest");
  const [inv, setInv] = useState("staging");
  const [targets, setTargets] = useState<string[]>(["worker"]);
  const [method, setMethod] = useState<"compose" | "ansible">("compose");
  const [dir, setDir] = useState("/srv/batch-worker");
  const [compose, setCompose] = useState(COMPOSE_TPL);
  const [repo, setRepo] = useState("");
  const [book, setBook] = useState("");
  const [envMode, setEnvMode] = useState<EnvMode>("paste");
  const [envText, setEnvText] = useState("NODE_ENV=production\nDATABASE_URL=postgres://user:pass@10.0.3.31:5432/app\nJWT_SECRET=change-me");
  const [envPick, setEnvPick] = useState("");
  const [hook, setHook] = useState(false);
  const [prot, setProt] = useState(true);
  const [lock, setLock] = useState(true);
  const [rb, setRb] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].name);
  }, [repos, repo]);
  const books = repos.find((r) => r.name === repo)?.books ?? [];
  useEffect(() => {
    if (!books.includes(book)) setBook(books[0] ?? "");
  }, [books, book]);
  useEffect(() => {
    if (!envPick && envs[0]) setEnvPick(envs[0].name);
  }, [envs, envPick]);

  const img = images.find((i) => i.ref === image);
  const invObj = inventories.find((i) => i.name === inv);
  const groups = useMemo(() => {
    const m: Record<string, Inventory["hosts"]> = {};
    invObj?.hosts.forEach((h) => (m[h.group] ??= []).push(h));
    return m;
  }, [invObj]);
  const hosts = invObj?.hosts.filter((h) => !targets.length || targets.includes(h.group)) ?? [];
  const envSkipped = status.env === "skipped";
  const cur = STEPS[step];

  /** Client-side check for the current step; the server validates everything again on create. */
  const validate = (id: StepId): string => {
    if (id === "basic") {
      if (!name.trim()) return "이름을 넣어 주세요.";
      if (!image) return "이미지를 골라 주세요.";
    }
    if (id === "target" && !hosts.length) return "배포할 서버가 없어요. 인벤토리나 그룹을 바꿔 주세요.";
    if (id === "method") {
      if (method === "compose") {
        const bad = RISKY.filter(([re]) => re.test(compose)).map((r) => r[1]);
        if (bad.length) return `compose.yml에 서버 권한을 넘기는 설정이 있어요: ${bad.join(", ")}`;
        if (!/^(\/srv\/|~\/|\/home\/deploy\/)/.test(dir) || dir.includes("..")) return "배포 경로는 /srv/ 또는 deploy 사용자의 홈 아래여야 해요.";
      } else if (!repo || !book) return "플레이북 레포와 플레이북을 골라 주세요.";
    }
    if (id === "env" && envMode !== "existing" && !parseEnv(envText).length) return "인식된 변수가 없어요. 필요 없다면 '.env 없이 진행'을 누르세요.";
    return "";
  };

  const go = (i: number) => {
    setErr("");
    setStep(i);
  };
  const next = () => {
    const e = validate(cur.id);
    if (e) return setErr(e);
    setStatus((s) => ({ ...s, [cur.id]: "done" }));
    go(step + 1);
  };
  const skip = () => {
    if (cur.id === "safety") {
      setHook(false);
      setProt(true);
      setLock(true);
      setRb(true);
    }
    setStatus((s) => ({ ...s, [cur.id]: "skipped" }));
    go(step + 1);
  };
  // A step can be opened once every step before it is done or skipped.
  const reachable = (i: number) => STEPS.slice(0, i).every((s) => status[s.id]);

  const create = async () => {
    setErr("");
    setBusy(true);
    try {
      await api.post("/jobs", {
        name, image, defaultTag: tag || "latest", method, inventory: inv, targets,
        dir, compose, repo, book,
        envMode: envSkipped ? "none" : envMode === "existing" ? "existing" : "paste",
        envName: envPick,
        envVars: envSkipped || envMode === "existing" ? [] : parseEnv(envText),
        hook, protected: prot, lock, rollback: rb,
      });
      onClose();
      refresh();
      nav("/jobs");
      toast("배포 작업을 만들었어요");
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (cur.id === "review") create();
    else next();
  };

  return (
    <>
      <ModalHead title="새 배포 작업" sub={cur.desc} onClose={onClose} />
      <Stepper step={step} status={status} reachable={reachable} onPick={go} />
      <form id="jobForm" onSubmit={submit} className="contents">
        <ModalBody className="h-[min(400px,62vh)] flex-none">
          <div key={cur.id} className="flex flex-col gap-4 animate-rise">
            {cur.id === "basic" && (
              <>
                <Field label="이름" htmlFor="jName">
                  <Input id="jName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field label="도커 이미지" htmlFor="jImage" hint={img?.tags[0] && `최신 ${img.tags[0].name} · ${img.tags[0].pushed}`}>
                  <Select id="jImage" mono value={image} onChange={(e) => setImage(e.target.value)}>
                    {images.map((i) => (
                      <option key={i.ref}>{i.ref}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="기본 태그" htmlFor="jTag" hint="latest면 실행할 때 가장 최근 태그를 digest로 고정해서 배포해요. 실행할 때마다 바꿀 수도 있어요.">
                  <Input id="jTag" mono value={tag} onChange={(e) => setTag(e.target.value)} list="jTagList" autoComplete="off" spellCheck={false} />
                  <datalist id="jTagList">
                    {["latest", ...(img?.tags.map((t) => t.name) ?? [])].map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </Field>
              </>
            )}

            {cur.id === "target" && (
              <>
                <Field label="인벤토리" htmlFor="jInv">
                  <Select
                    id="jInv"
                    value={inv}
                    onChange={(e) => {
                      setInv(e.target.value);
                      setTargets([]);
                    }}
                    autoFocus
                  >
                    {inventories.map((i) => (
                      <option key={i.id} value={i.name}>
                        {i.name} · 서버 {i.hosts.length}대
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="배포 대상 그룹" hint={targets.length ? undefined : "그룹을 고르지 않으면 전체 서버에 배포해요."}>
                  <GroupSelect groups={groups} value={targets} onChange={setTargets} />
                </Field>
                <div className="rounded-2xl shadow-[inset_0_0_0_1px_var(--border)] overflow-hidden">
                  {hosts.map((h) => (
                    <div key={h.name} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13px]">
                      <Chip tone="accent" mono>
                        {h.group}
                      </Chip>
                      <span className="flex-1 font-medium truncate">{h.name}</span>
                      <span className="font-mono text-[12.5px] text-muted">{h.ip}</span>
                    </div>
                  ))}
                  {!hosts.length && <div className="px-4 py-6 text-center text-muted text-[13px]">이 인벤토리에 서버가 없어요.</div>}
                </div>
              </>
            )}

            {cur.id === "method" && (
              <>
                <div>
                  <Seg
                    options={[
                      { value: "compose", label: "Docker Compose" },
                      { value: "ansible", label: "Ansible 플레이북" },
                    ]}
                    value={method}
                    onChange={(m) => {
                      setMethod(m);
                      setErr("");
                    }}
                  />
                </div>
                {method === "compose" ? (
                  <>
                    <Field label="서버의 배포 경로" htmlFor="jDir" hint="/srv 아래나 deploy 사용자의 홈 아래만 쓸 수 있어요.">
                      <Input id="jDir" mono value={dir} onChange={(e) => setDir(e.target.value)} />
                    </Field>
                    <Field label="compose.yml" htmlFor="jCompose" hint={<>이미지 자리의 <span className="font-mono">{"${IMAGE}:${IMAGE_TAG}"}</span>는 실행할 때 채워져요.</>}>
                      <Textarea id="jCompose" rows={7} spellCheck={false} value={compose} onChange={(e) => setCompose(e.target.value)} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Hint>연결한 플레이북 레포의 플레이북을 실행해요. 넘기는 변수는 image, image_tag, image_digest, env_file, target_group뿐이에요.</Hint>
                    <Field label="플레이북 레포" htmlFor="jRepo">
                      <Select id="jRepo" mono value={repo} onChange={(e) => setRepo(e.target.value)}>
                        {repos.map((r) => (
                          <option key={r.name}>{r.name}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="플레이북" htmlFor="jBook">
                      <Select id="jBook" mono value={book} onChange={(e) => setBook(e.target.value)}>
                        {books.map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}
              </>
            )}

            {cur.id === "env" && (
              <EnvSource text={envText} setText={setEnvText} mode={envMode} setMode={setEnvMode} existing={envs.map((e) => e.name)} picked={envPick} setPicked={setEnvPick} />
            )}

            {cur.id === "safety" && (
              <div className="flex flex-col">
                <Check checked={prot} onChange={setProt} title="보호된 작업" desc="Deployer가 실행하면 Admin의 승인을 받은 뒤 시작돼요." />
                <Check checked={lock} onChange={setLock} title="동시 실행 금지" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
                <Check checked={rb} onChange={setRb} title="실패하면 이전 이미지 태그로 롤백" desc="상태 확인이 실패하면 직전에 성공한 태그로 되돌려요." />
                <Check checked={hook} onChange={setHook} title="새 이미지 태그가 올라오면 자동 배포" desc="레지스트리 webhook의 서명을 검증하고, v로 시작하는 릴리스 태그만 받아요." />
              </div>
            )}

            {cur.id === "review" && (
              <div className="rounded-[18px] shadow-[inset_0_0_0_1px_var(--border)] overflow-hidden">
                <div className="px-4 py-3 bg-surface-2 border-b border-line font-semibold">{name}</div>
                <Row label="이미지" onEdit={() => go(0)}>
                  <span className="font-mono">
                    {image}:{tag || "latest"}
                  </span>
                </Row>
                <Row label="배포 대상" onEdit={() => go(1)}>
                  {inv} · {targets.length ? targets.join(", ") : "전체"} <span className="text-muted">({hosts.length}대)</span>
                </Row>
                <Row label="배포 방식" onEdit={() => go(2)}>
                  {method === "compose" ? `Docker Compose · ${dir}` : `Ansible · ${repo} / ${book}`}
                </Row>
                <Row label="환경 변수" onEdit={() => go(3)}>
                  {envSkipped ? <span className="text-faint">없음</span> : envMode === "existing" ? envPick : `새로 저장 · 변수 ${parseEnv(envText).length}개`}
                </Row>
                <Row label="안전장치" onEdit={() => go(4)}>
                  {[prot && "보호됨", lock && "동시 실행 금지", rb && "실패 시 롤백", hook && "자동 배포"].filter(Boolean).join(" · ") || "없음"}
                </Row>
              </div>
            )}

            <ErrorText>{err}</ErrorText>
          </div>
        </ModalBody>
      </form>
      <ModalFoot between>
        <span className="flex items-center gap-2">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => go(step - 1)}>
              ← 이전
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              취소
            </Button>
          )}
          <span className="text-[12px] text-faint tabular-nums">
            {step + 1} / {STEPS.length}
          </span>
        </span>
        <span className="flex gap-2">
          {cur.skip && (
            <Button icon="skip" onClick={skip}>
              {cur.skip}
            </Button>
          )}
          <Button variant="primary" type="submit" form="jobForm" disabled={busy}>
            {cur.id === "review" ? (busy ? "만드는 중…" : "만들기") : "다음 →"}
          </Button>
        </span>
      </ModalFoot>
    </>
  );
}

function Stepper({ step, status, reachable, onPick }: { step: number; status: Partial<Record<StepId, "done" | "skipped">>; reachable: (i: number) => boolean; onPick: (i: number) => void }) {
  return (
    <div className="px-6 pb-3">
      <ol className="m-0 p-0 list-none flex items-center gap-1 overflow-x-auto scroll-soft">
        {STEPS.map((s, i) => {
          const st = status[s.id];
          const current = i === step;
          const can = reachable(i);
          return (
            <li key={s.id} className="flex items-center gap-1 flex-none">
              {i > 0 && <span className={cx("w-4 h-px", st || current ? "bg-accent/40" : "bg-line-strong")} />}
              <button
                type="button"
                disabled={!can}
                onClick={() => onPick(i)}
                aria-current={current ? "step" : undefined}
                className={cx(
                  "flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-all duration-200",
                  current ? "bg-accent-soft text-accent" : can ? "text-muted hover:bg-hover hover:text-fg" : "text-faint cursor-not-allowed",
                )}
              >
                <span
                  className={cx(
                    "grid place-items-center size-5 rounded-full text-[10.5px] font-semibold",
                    st === "done" && "bg-ok text-white",
                    st === "skipped" && "bg-surface-2 text-faint shadow-[inset_0_0_0_1px_var(--border-strong)]",
                    !st && current && "bg-accent text-on-accent",
                    !st && !current && "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
                  )}
                >
                  {st === "done" ? <Icon name="check" className="size-2.5" strokeWidth={3.5} /> : st === "skipped" ? "–" : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Row({ label, children, onEdit }: { label: string; children: ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13px]">
      <span className="w-[72px] text-faint flex-none">{label}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        수정
      </Button>
    </div>
  );
}
