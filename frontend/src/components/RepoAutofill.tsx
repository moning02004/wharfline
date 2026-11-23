import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Key, Repo } from "../lib/types";
import { Icon } from "./Icon";
import { ModalBody, ModalFoot, ModalHead } from "./Modal";
import { Button, Chip, Field, Hint, Input, Select, cx } from "./ui";

/** What the server drafted from a repo (POST /repos/detect): rules over its files, no AI. */
export interface RepoDraft {
  commit: string;
  kind: "compose" | "kubernetes" | "playbook" | "dockerfile" | "none";
  name: string;
  composePath: string | null;
  composeFiles: string[];
  files: { path: string; size: number; content: string }[];
  env: [string, string][];
  guide: "compose" | "rollout" | "kubernetes" | null;
  steps: { name: string; run: string }[] | null;
  rollout: string[];
  own: string[];
  warnings: { path: string; message: string }[];
  notes: string[];
  playbooks: string[];
}

const KIND_LABEL: Record<RepoDraft["kind"], string> = {
  compose: "Docker Compose",
  kubernetes: "Kubernetes",
  playbook: "Ansible 플레이북",
  dockerfile: "Dockerfile만 있음",
  none: "찾지 못함",
};
const GUIDE_LABEL = { compose: "Docker Compose로 배포", rollout: "docker rollout으로 무중단 교체", kubernetes: "kubectl apply" };
const isSsh = (url: string) => /^(git@|ssh:\/\/)/.test(url.trim());

/**
 * 저장소에서 자동으로 채우기: pick a Git repo, Wharfline reads it and drafts the job (files, script, .env names, the
 * images to follow). Nothing is saved until the job is; the draft only fills the form.
 */
export function RepoAutofill({ onApply }: { onApply: (d: RepoDraft) => void }) {
  const { toast, openModal } = useApp();
  const rules = (
    <button
      type="button"
      aria-label="자동으로 채우는 규칙"
      title="자동으로 채우는 규칙"
      onClick={() => openModal((c) => <AutofillRulesModal onClose={c} />, "md")}
      className="inline-flex items-center justify-center size-6 rounded-md text-muted hover:text-fg hover:bg-hover flex-none"
    >
      <Icon name="info" className="size-4" />
    </button>
  );
  const repos = (useApi<Repo[]>("/repos").data ?? []).filter((r) => r.kind === "git");
  const keys = useApi<Key[]>("/keys").data ?? [];
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RepoDraft | null>(null);
  const ssh = isSsh(url);
  const keyOptions = keys.filter((k) => k.kind === (ssh ? "ssh" : "token"));
  const reused = repos.find((r) => r.url === url.trim() && r.branch === (branch.trim() || "main"));
  useEffect(() => {
    if (key && keyOptions.some((k) => k.name === key)) return;
    setKey(ssh ? keyOptions[0]?.name ?? "" : "");
  }, [ssh, keys.length]);
  useEffect(() => setDraft(null), [url, branch, key]);

  const detect = async (compose = "") => {
    if (!/^(git@|ssh:\/\/|https:\/\/)/.test(url.trim())) return toast("저장소 주소를 확인해 주세요. 예: https://github.com/org/app.git", "error");
    if (ssh && !reused && !key) return toast("SSH 주소는 SSH 키가 있어야 해요. 키를 고르거나 HTTPS 주소를 넣어 주세요.", "error");
    setBusy(true);
    try {
      setDraft(await api.post<RepoDraft>("/repos/detect", { url: url.trim(), branch: branch.trim() || "main", key: reused ? "" : key, compose }));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-3.5 py-3">
        <Icon name="wand" className="size-4 flex-none text-accent" />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="inline-flex items-center gap-1">
            <b className="font-semibold">Git 저장소에서 자동으로 채우기</b>
            {rules}
          </span>
          <span className="block text-muted text-[12.5px]">저장소의 compose 파일이나 Kubernetes yaml을 읽어 파일, 스크립트, 환경 변수를 채워요.</span>
        </div>
        <Button size="sm" icon="git" onClick={() => setOpen(true)}>
          저장소 고르기
        </Button>
      </div>
    );

  const usable = draft && draft.files.length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Icon name="wand" className="size-4 flex-none text-accent" />
        <b className="font-semibold text-[13px]">Git 저장소에서 자동으로 채우기</b>
        {rules}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon="x" onClick={() => setOpen(false)} aria-label="닫기" />
      </div>
      {repos.length > 0 && (
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
              </button>
            );
          })}
        </div>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-2">
        <Input mono aria-label="저장소 URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/app.git" autoComplete="off" spellCheck={false} />
        <Input mono aria-label="브랜치" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {!reused && (
          <div className="min-w-[220px] flex-1">
            <Select aria-label={ssh ? "SSH 키" : "토큰"} value={key} onChange={(e) => setKey(e.target.value)} placeholder={ssh ? "SSH 키를 추가해 주세요" : undefined}>
              {!ssh && <option value="">공개 저장소(키 없음)</option>}
              {keyOptions.map((k) => (
                <option key={k.id} value={k.name}>
                  {k.name} · {k.type}
                </option>
              ))}
            </Select>
          </div>
        )}
        {reused && <Hint className="flex-1">연결된 레포 {reused.name}의 인증으로 읽어요.</Hint>}
        <Button variant="primary" icon="search" disabled={busy || !url.trim()} onClick={() => detect()}>
          {busy ? "읽는 중…" : "찾기"}
        </Button>
      </div>

      {draft && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3 text-[12.5px] animate-fade">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={usable ? "ok" : "warn"}>{KIND_LABEL[draft.kind]}</Chip>
            <span className="text-muted">
              커밋 <span className="font-mono">{draft.commit}</span>
            </span>
          </div>
          {draft.composeFiles.length > 1 && (
            <Field label="compose 파일">
              <Select aria-label="compose 파일" value={draft.composePath ?? ""} onChange={(e) => detect(e.target.value)}>
                {draft.composeFiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {usable && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 m-0">
              <dt className="text-muted">이름</dt>
              <dd className="m-0 font-mono">{draft.name}</dd>
              <dt className="text-muted">파일 {draft.files.length}개</dt>
              <dd className="m-0 flex flex-wrap gap-1">
                {draft.files.slice(0, 12).map((x) => (
                  <Chip key={x.path} mono>
                    {x.path}
                  </Chip>
                ))}
                {draft.files.length > 12 && <Chip>+{draft.files.length - 12}개</Chip>}
              </dd>
              <dt className="text-muted">스크립트</dt>
              <dd className="m-0">
                {draft.guide && GUIDE_LABEL[draft.guide]}
                {draft.rollout.length > 0 && <span className="text-muted"> · 무중단: {draft.rollout.join(", ")}</span>}
              </dd>
              {draft.env.length > 0 && (
                <>
                  <dt className="text-muted">환경 변수</dt>
                  <dd className="m-0 font-mono break-all">{draft.env.map(([k]) => k).join(", ")}</dd>
                </>
              )}
              {draft.own.length > 0 && (
                <>
                  <dt className="text-muted">버전 추적</dt>
                  <dd className="m-0 font-mono break-all">{draft.own.join(", ")}</dd>
                </>
              )}
            </dl>
          )}
          {(draft.notes.length > 0 || draft.warnings.length > 0) && (
            <ul className="m-0 pl-4 flex flex-col gap-1 text-muted list-disc">
              {draft.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {draft.warnings.map((w) => (
                <li key={w.path + w.message} className="text-warn">
                  <span className="font-mono">{w.path}</span>: {w.message}
                </li>
              ))}
            </ul>
          )}
          {usable && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="primary"
                icon="check"
                onClick={() => {
                  onApply(draft);
                  setOpen(false);
                  setDraft(null);
                }}
              >
                이대로 채우기
              </Button>
              <Hint>지금 올린 파일과 스크립트를 바꿔요. 저장하기 전에 다음 단계에서 고칠 수 있어요.</Hint>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** How the draft is made, so a wrong guess can be spotted and fixed by hand. Same rules as backend/app/repodetect.py. */
function AutofillRulesModal({ onClose }: { onClose: () => void }) {
  const section = (title: string, items: React.ReactNode[]) => (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      <ul className="m-0 pl-4 flex flex-col gap-1 list-disc text-[12.5px] text-muted">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
  const m = (t: string) => <span className="font-mono text-fg">{t}</span>;
  return (
    <>
      <ModalHead title="자동으로 채우는 규칙" onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[12.5px]">
            AI 없이 저장소 파일을 정해진 규칙으로 읽어요. 같은 저장소면 늘 같은 결과가 나오지만, 저장소 구조에 따라 틀리게 짐작할 수 있어요. 채운 뒤 파일, 스크립트, 환경 변수를 꼭 확인하고 고쳐 주세요.
          </p>
          {section("어떤 파일로 배포할지", [
            <>compose 파일({m("compose.yaml")}, {m("compose.yml")}, {m("docker-compose.yaml")}, {m("docker-compose.yml")})이 있으면 Docker Compose로 만들어요.</>,
            <>
              운영용 이름({m("compose.prod.yaml")}, {m("docker-compose.production.yml")}, {m("compose-live.yml")} 등: prod, production, prd, live, release, deploy)이 있으면
              그 파일을 가장 먼저 골라요. 같은 폴더의 그냥 compose 파일은 개발용인 경우가 많아서예요.
            </>,
            <>
              서버에서는 docker compose가 기본 이름만 읽어서, 운영용 파일은 {m("compose.yaml")}(또는 {m("docker-compose.yml")})로 이름을 바꿔 저장해요. 운영용 파일에 image도 build도
              없는 서비스가 있으면 그냥 compose 파일 위에 덧씌우는 파일로 보고, 둘 다 넣은 뒤 운영용 파일을 {m("compose.override.yaml")}로 저장해요. 이때 원래 있던 override 파일은 개발용으로 보고 빼요.
            </>,
            <>그다음은 얕은 폴더가 먼저이고, 같은 깊이면 저장소 맨 위 → {m("deploy/")} → {m("deployment/")} → {m("docker/")} → {m("infra/")} → {m("ops/")} 순서예요. 다른 파일은 결과의 목록에서 고를 수 있어요.</>,
            <>{m("examples/")}, {m("test/")}, {m("docs/")}, {m("node_modules/")} 같은 폴더의 파일은 고르지 않아요.</>,
            <>compose 파일이 없고 {m("apiVersion:")}과 {m("kind: Deployment")} 같은 줄이 있는 yaml이 있으면 Kubernetes로 만들어요. {m("k8s/")}, {m("manifests/")} 같은 폴더가 먼저예요.</>,
            "플레이북만 있거나 Dockerfile만 있으면 초안을 만들지 않고 어떤 작업이 맞는지 알려 줘요.",
          ])}
          {section("함께 올리는 파일", [
            "compose 파일이 있는 폴더가 배포 폴더가 돼요. 파일 경로도 그 폴더 기준으로 바뀌어요.",
            <>같은 폴더의 override 파일({m("compose.override.yaml")} 등)과, compose 파일이 가리키는 파일을 함께 넣어요: {m("./")}로 시작하는 바인드 마운트, {m("env_file")}, configs/secrets의 {m("file:")}.</>,
            "마운트가 폴더를 가리키면 그 안의 파일을 최대 60개까지 넣어요. 소스 폴더를 마운트하는 개발용 compose면 소스까지 들어오니 지워 주세요.",
            "배포 폴더 밖(../)을 가리키는 경로는 넣지 않고, 저장소에 없는 경로(./data 등)는 서버에서 생긴다고 보고 넘어가요.",
            <>{m("build:")}가 있는 서비스의 소스는 올리지 않아요. 서버에서 빌드가 실패할 수 있으니 CI에서 이미지를 만들어 {m("image:")}로 바꾸는 걸 권해요.</>,
          ])}
          {section("환경 변수", [
            <>배포 폴더에 {m(".env")}가 있으면 파일로 올리지 않고 그 값을 환경 변수로 옮겨요.</>,
            <>{m(".env.example")}, {m(".env.sample")}, {m(".env.template")} 등이 있으면 그 변수 이름과 예시 값을 더해요. 예시 값이니 실제 값으로 바꿔 주세요.</>,
          ])}
          {section("스크립트", [
            "무중단으로 바꿀 수 있는 서비스가 하나라도 있으면 docker rollout 예시를, 없으면 일반 Docker Compose 예시를 넣어요.",
            <>무중단에서 빠지는 서비스: {m("container_name")}이 있거나, 호스트 포트를 고정했거나({m('"8080:80"')}), 프로필이 있거나, DB처럼 데이터를 가진 서비스(db, postgres, redis …). 라벨 {m("wharfline.rollout")}으로 바꿀 수 있어요.</>,
            <>Kubernetes는 파일마다 {m("envsubst < 파일 | kubectl apply -f -")}, Deployment·StatefulSet마다 {m("kubectl rollout status")}를 넣어요.</>,
          ])}
          {section("이름과 버전 추적", [
            <>이름은 compose 파일의 {m("name:")}, 없으면 compose 파일이 있는 폴더 이름(deploy/ 같은 폴더면 저장소 이름)이에요.</>,
            <>이미지 경로가 저장소 경로와 같으면(github.com/acme/shop → {m("ghcr.io/acme/shop")}) 이 저장소가 만드는 이미지로 보고, 고정 태그를 {m("${SHOP_TAG}")} 변수로 바꿔 버전을 추적해요. 레지스트리 경로가 다르면 설정 단계에서 직접 체크해 주세요.</>,
          ])}
          {section("저장소 읽기", [
            "작업이 배포할 때 쓰는 것과 같은 인증(연결된 레포, 또는 고른 키)으로 브랜치의 최신 커밋을 한 번 받아 읽고 바로 지워요. 저장은 작업을 저장할 때만 돼요.",
            "512KB가 넘는 파일, 바이너리 파일은 읽지 않고, 파일은 최대 400개까지 읽어요. 큰 저장소면 일부를 못 볼 수 있어요.",
          ])}
        </div>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      </ModalFoot>
    </>
  );
}
