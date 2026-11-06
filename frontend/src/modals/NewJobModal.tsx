import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet, Image, Inventory, Repo } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { GroupSelect } from "../components/GroupSelect";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Check, ErrorText, Field, Input, Select, Seg, Textarea } from "../components/ui";

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

export function NewJobModal({ onClose }: { onClose: () => void }) {
  const { toast, refresh } = useApp();
  const nav = useNavigate();
  const images = useApi<{ images: Image[] }>("/registries").data?.images ?? [];
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const repos = useApi<Repo[]>("/repos").data ?? [];
  const envs = useApi<EnvSet[]>("/envs").data ?? [];

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/jobs", {
        name, image, defaultTag: tag || "latest", method, inventory: inv, targets,
        dir, compose, repo, book,
        envMode: envMode === "existing" ? "existing" : "paste",
        envName: envPick,
        envVars: parseEnv(envText),
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

  return (
    <>
      <ModalHead title="새 배포 작업" sub="이미지, 서버 그룹, 배포 방식, 환경 변수를 고르면 실행 버튼 하나로 배포할 수 있어요." onClose={onClose} />
      <form id="jobForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="jName">
            <Input id="jName" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </Field>
          <Field label="도커 이미지" htmlFor="jImage" hint={img?.tags[0] && `최신 ${img.tags[0].name} · ${img.tags[0].pushed} 올라옴`}>
            <Select id="jImage" mono value={image} onChange={(e) => setImage(e.target.value)}>
              {images.map((i) => (
                <option key={i.ref}>{i.ref}</option>
              ))}
            </Select>
          </Field>
          <Field label="이미지 태그" htmlFor="jTag" hint="latest면 실행할 때 가장 최근 태그를 digest로 고정해서 배포해요. v1.8.2처럼 특정 태그로 정해 둘 수도 있어요.">
            <Input id="jTag" mono value={tag} onChange={(e) => setTag(e.target.value)} list="jTagList" autoComplete="off" spellCheck={false} />
            <datalist id="jTagList">
              {["latest", ...(img?.tags.map((t) => t.name) ?? [])].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="인벤토리" htmlFor="jInv">
            <Select
              id="jInv"
              value={inv}
              onChange={(e) => {
                setInv(e.target.value);
                setTargets([]);
              }}
            >
              {inventories.map((i) => (
                <option key={i.id} value={i.name}>
                  {i.name} · 서버 {i.hosts.length}대
                </option>
              ))}
            </Select>
          </Field>
          <Field label="배포 대상" hint={`${targets.length ? "" : "그룹을 고르지 않으면 전체 서버에 배포해요. "}서버 ${hosts.length}대: ${hosts.map((h) => h.ip).join(", ")}`}>
            <GroupSelect groups={groups} value={targets} onChange={setTargets} />
          </Field>

          <Field
            label="배포 방식"
            right={
              <Seg
                options={[
                  { value: "compose", label: "Docker Compose" },
                  { value: "ansible", label: "Ansible 플레이북" },
                ]}
                value={method}
                onChange={setMethod}
              />
            }
          >
            {method === "compose" ? (
              <div className="flex flex-col gap-3 animate-fade">
                <span className="text-[12.5px] text-muted">
                  서버에 compose.yml과 .env를 올리고 <span className="font-mono">docker compose up -d</span>로 교체해요. 플레이북 없이 바로 쓸 수 있는 일반적인 방식이에요.
                </span>
                <Field label="서버의 배포 경로" htmlFor="jDir" hint="deploy 사용자의 홈 또는 /srv 아래만 허용돼요.">
                  <Input id="jDir" mono value={dir} onChange={(e) => setDir(e.target.value)} />
                </Field>
                <Field
                  label="compose.yml"
                  htmlFor="jCompose"
                  hint={
                    <>
                      이미지 주소와 태그는 실행할 때 <span className="font-mono">IMAGE</span>, <span className="font-mono">IMAGE_TAG</span>로 채워져요.
                    </>
                  }
                >
                  <Textarea id="jCompose" rows={9} spellCheck={false} value={compose} onChange={(e) => setCompose(e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="flex flex-col gap-3 animate-fade">
                <span className="text-[12.5px] text-muted">연결한 플레이북 레포의 플레이북을 실행해요. Semaphore와 같은 방식이에요.</span>
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
              </div>
            )}
          </Field>

          <EnvSource text={envText} setText={setEnvText} mode={envMode} setMode={setEnvMode} existing={envs.map((e) => e.name)} picked={envPick} setPicked={setEnvPick} />

          <Field label="실행과 안전장치">
            <div className="flex flex-col">
              <Check checked={hook} onChange={setHook} title="새 이미지 태그가 올라오면 자동 배포" desc="레지스트리 webhook의 서명을 검증하고, v로 시작하는 릴리스 태그만 받아요." />
              <Check checked={prot} onChange={setProt} title="보호된 작업" desc="Deployer가 실행하면 Admin의 승인을 받은 뒤 시작돼요." />
              <Check checked={lock} onChange={setLock} title="동시 실행 금지" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
              <Check checked={rb} onChange={setRb} title="실패하면 이전 이미지 태그로 롤백" />
            </div>
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="jobForm" disabled={busy}>
          만들기
        </Button>
      </ModalFoot>
    </>
  );
}
