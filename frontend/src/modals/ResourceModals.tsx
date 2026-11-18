import { useEffect, useState, type ReactNode } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Host, Image, Inventory, Key, PublicKeyInfo, Registry } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, Check, ErrorText, Field, Hint, Input, KV, Select, Seg, Textarea, cx } from "../components/ui";
import { Icon } from "../components/Icon";
import { AgentPanel, InstallCommand, PolicyFields, StepsResult, type InitResult } from "./AgentModals";

export function copyText(text: string, toast: (m: string) => void) {
  try {
    navigator.clipboard.writeText(text).then(
      () => toast("복사했어요"),
      () => toast("복사할 수 없어요. 직접 선택해 주세요."),
    );
  } catch {
    toast("복사할 수 없어요. 직접 선택해 주세요.");
  }
}

/* ---------- keys ---------- */

type KeyMode = "gen" | "paste" | "token";
const KEY_NAME: Record<KeyMode, string> = { gen: "batch-deploy", paste: "batch-deploy", token: "gitea-readonly" };
/** Same rule as the server: a Linux login name. */
const LOGIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function NewKeyModal({ onClose, onCreated, initialMode = "gen" }: { onClose: () => void; onCreated?: (k: Key) => void; initialMode?: KeyMode }) {
  const { refresh, toast, openModal, withSudo } = useApp();
  const [mode, setMode] = useState<KeyMode>(initialMode);
  const [name, setName] = useState(KEY_NAME[initialMode]);
  const [touched, setTouched] = useState(false);
  const [priv, setPriv] = useState("");
  const [pass, setPass] = useState("");
  const [user, setUser] = useState("deploy-bot");
  const [tok, setTok] = useState("");
  const [err, setErr] = useState("");

  const changeMode = (m: typeof mode) => {
    setMode(m);
    if (!touched) setName(KEY_NAME[m]);
    setErr("");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    withSudo("키 추가", async () => {
      try {
        const k = await api.post<Key>("/keys", { mode, name, privateKey: priv, passphrase: pass, user, token: tok });
        onClose();
        refresh();
        onCreated?.(k);
        if (k.kind === "token") toast("토큰을 저장했어요. 다시 볼 수 없어요.");
        else if (onCreated) toast(`${k.name} 키를 만들었어요. 서버에 넣는 명령은 서버 준비 단계에 나와요.`);
        else openModal((close) => <PubKeyModal k={k} fresh onClose={close} />);
      } catch (e) {
        if ((e as { sudoRequired?: boolean }).sudoRequired) throw e;
        setErr(errMsg(e));
      }
    });
  };

  return (
    <>
      <ModalHead title="키 추가" sub="서버 접속용 SSH 키나 Git 저장소용 액세스 토큰을 넣어요." onClose={onClose} />
      <form id="keyForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="종류">
            <div>
              <Seg
                options={[
                  { value: "gen", label: "SSH 키 만들기" },
                  { value: "paste", label: "SSH 키 가져오기" },
                  { value: "token", label: "액세스 토큰" },
                ]}
                value={mode}
                onChange={changeMode}
              />
            </div>
          </Field>
          <Field label="이름" htmlFor="kName">
            <Input
              id="kName"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
            />
          </Field>
          {mode === "gen" && <Hint>서버에서 ED25519 키 쌍을 만들어요. 비공개 키는 이 화면에도 나타나지 않고, 공개 키만 보여드려요.</Hint>}
          {mode === "paste" && (
            <div className="flex flex-col gap-4 animate-fade">
              <Field label="비공개 키" htmlFor="kPriv">
                <Textarea id="kPriv" rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={priv} onChange={(e) => setPriv(e.target.value)} />
              </Field>
              <Field label="키 암호 (선택)" htmlFor="kPass" hint="저장 후에는 다시 볼 수 없어요.">
                <Input id="kPass" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
              </Field>
            </div>
          )}
          {mode === "token" && (
            <div className="flex flex-col gap-4 animate-fade">
              <Field label="사용자 이름" htmlFor="kUser">
                <Input id="kUser" mono spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} />
              </Field>
              <Field
                label="토큰"
                htmlFor="kTok"
                hint="Git 저장소를 HTTPS 주소로 읽을 때 써요. GitHub는 Contents 읽기 전용 권한의 fine-grained 토큰, Gitea는 read:repository 권한만 주세요."
              >
                <Input id="kTok" mono type="password" placeholder="github_pat_… 또는 Gitea 토큰" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} />
              </Field>
            </div>
          )}
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="keyForm">
          추가
        </Button>
      </ModalFoot>
    </>
  );
}

export function PubKeyModal({ k, fresh, onClose }: { k: Key; fresh?: boolean; onClose: () => void }) {
  const info = usePublicKey(k.id, k.publicKey);
  return (
    <>
      <ModalHead title={fresh ? "키를 만들었어요" : "공개 키"} sub={`${k.name} · ${k.fingerprint}`} onClose={onClose} />
      <ModalBody>
        <ServerPrepSteps user="deploy" info={info} last="서버 추가에서 이 키를 고르고 연결 확인을 눌러요. 지문과 로그인을 확인해요." />
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          완료
        </Button>
      </ModalFoot>
    </>
  );
}

/** The key's authorized_keys line; right after creating a key, the plain line shows until the request returns. */
function usePublicKey(keyId: string | undefined, fallback?: string | null): PublicKeyInfo | null {
  const { toast } = useApp();
  const [info, setInfo] = useState<PublicKeyInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!keyId) return;
    api
      .get<PublicKeyInfo>(`/keys/${keyId}/public`)
      .then(setInfo)
      .catch((e) => toast(errMsg(e)));
  }, [keyId, toast]);
  if (info) return info;
  return fallback ? { publicKey: fallback, authorizedKeysLine: fallback, restricted: false, accessFrom: [] } : null;
}

/** Shell-quote for a single-quoted argument. */
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function CmdBlock({ cmd, label }: { cmd: string; label: string }) {
  const { toast } = useApp();
  return (
    <div className="relative group">
      <pre className="m-0 rounded-md bg-surface border border-line pl-3 pr-10 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">{cmd}</pre>
      <Button size="sm" variant="ghost" icon="copy" iconOnly aria-label={`${label} 복사`} className="absolute top-1 right-1" onClick={() => copyText(cmd, toast)} />
    </div>
  );
}

function CopyAll({ text }: { text: string }) {
  const { toast } = useApp();
  return (
    <Button size="sm" icon="copy" onClick={() => copyText(text, toast)}>
      전체 복사
    </Button>
  );
}

function Step({ n, title, children }: { n: number | string; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
      <span className="grid place-items-center size-[22px] rounded-full bg-primary-soft text-primary text-[11.5px] font-semibold tabular-nums">{n}</span>
      <span className="text-[13px] font-medium self-center">{title}</span>
      {children && <div className="col-start-2 flex flex-col gap-1.5 min-w-0">{children}</div>}
    </li>
  );
}

/** What to run on the server, in order, with the user and key filled in. */
function ServerPrepSteps({ user, info, last }: { user: string; info: PublicKeyInfo | null; last?: ReactNode }) {
  const u = user.trim() || "deploy";
  const home = `/home/${u}`;
  const line = info?.authorizedKeysLine ?? "";
  const addUser = `id -u ${u} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${u}`;
  const [perm, setPerm] = useState<"group" | "sudo">("group");
  const sudoersFile = `/etc/sudoers.d/wharfline-${u}`;
  const sudoers = `echo '${u} ALL=(root) NOPASSWD: /usr/bin/docker' | sudo tee ${sudoersFile}\nsudo chmod 440 ${sudoersFile} && sudo visudo -cf ${sudoersFile}`;
  const addKey = [
    `sudo mkdir -p ${home}/.ssh`,
    `sudo grep -qxF ${line ? sq(line) : "'…'"} ${home}/.ssh/authorized_keys 2>/dev/null || echo ${line ? sq(line) : "'…'"} | sudo tee -a ${home}/.ssh/authorized_keys >/dev/null`,
    `sudo chown -R ${u}:${u} ${home}/.ssh`,
    `sudo chmod 700 ${home}/.ssh && sudo chmod 600 ${home}/.ssh/authorized_keys`,
  ].join("\n");
  const fingerprintCmd = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub";
  const srvCmd = `sudo mkdir -p /srv && sudo chown ${u}:${u} /srv`;
  const all = [
    `# 1. 배포용 사용자 ${u}`,
    addUser,
    "# 2. 공개 키",
    addKey,
    perm === "group" ? "# 3. docker 그룹" : "# 3. sudoers (sudo docker만)",
    perm === "group" ? `sudo usermod -aG docker ${u}` : sudoers,
    "# 4. 서비스 폴더",
    srvCmd,
    "# 5. 호스트 키 지문 (연결 확인 결과와 비교)",
    fingerprintCmd,
  ].join("\n");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="m-0 text-[13px] text-muted flex-1">대상 서버에 접속해서 차례로 실행해요. 여러 번 실행해도 괜찮아요.</p>
        <CopyAll text={all} />
      </div>
      <ol className="m-0 p-0 list-none flex flex-col gap-3.5">
        <Step n={1} title={<>배포용 사용자 <span className="font-mono">{u}</span> 만들기</>}>
          <CmdBlock cmd={addUser} label="사용자 만들기 명령" />
        </Step>
        <Step n={2} title="공개 키 넣기">
          <CmdBlock cmd={addKey} label="공개 키 넣기 명령" />
          {info &&
            (info.restricted ? (
              <span className="text-[12px] text-faint">
                <span className="font-mono">from=</span>이 붙어 있어 {info.accessFrom.join(", ")}에서 온 접속만 받아요.
              </span>
            ) : (
              <span className="text-[12px] text-warn">
                접속 허용 주소가 없어 어디서든 이 키로 들어올 수 있어요. 키 저장소의 "접속 허용 주소"를 넣어 두는 게 좋아요.
              </span>
            ))}
        </Step>
        <Step
          n={3}
          title={
            <span className="flex items-center gap-2 flex-wrap">
              docker 권한
              <Seg
                options={[
                  { value: "group", label: "docker 그룹" },
                  { value: "sudo", label: "sudoers" },
                ]}
                value={perm}
                onChange={setPerm}
              />
            </span>
          }
        >
          {perm === "group" ? (
            <>
              <CmdBlock cmd={`sudo usermod -aG docker ${u}`} label="docker 그룹 명령" />
              <span className="text-[12px] text-faint">스크립트에서 docker를 그대로 써요.</span>
            </>
          ) : (
            <>
              <CmdBlock cmd={sudoers} label="sudoers 명령" />
              <span className="text-[12px] text-faint">
                스크립트에서 <span className="font-mono">sudo docker …</span>로 써요. 실행한 명령이 서버의 auth.log에 남아요.
              </span>
            </>
          )}
          <span className="text-[12px] text-warn">어느 쪽이든 docker를 쓸 수 있으면 root와 같은 권한이에요. 배포할 서버에만 줘요.</span>
        </Step>
        <Step n={4} title={<>서비스 폴더 <span className="font-mono">/srv</span> 넘겨주기</>}>
          <CmdBlock cmd={srvCmd} label="서비스 폴더 명령" />
          <span className="text-[12px] text-faint">
            앱은 <span className="font-mono">/srv/{"{project_name}"}</span>에 놓여요(작업의 서비스 경로 기본값). 폴더는 첫 배포 때 Wharfline이 만들어요.
          </span>
          <details className="text-[12px] text-muted">
            <summary className="cursor-pointer select-none">이미 root로 만든 앱 폴더가 있으면</summary>
            <p className="mt-1.5 mb-1.5">
              그 폴더에는 <span className="font-mono">{u}</span>가 쓸 수 없어서 배포가 Permission denied로 실패해요. 소유자를 바꿔요.
            </p>
            <CmdBlock cmd={`sudo chown -R ${u}:${u} /srv/{project_name}`} label="앱 폴더 소유자 명령" />
          </details>
        </Step>
        <Step n={5} title="호스트 키 지문 보기">
          <CmdBlock cmd={fingerprintCmd} label="지문 명령" />
          <span className="text-[12px] text-faint">연결 확인에서 나오는 지문과 같아야 해요.</span>
        </Step>
        {last && <Step n={6} title={last} />}
      </ol>
    </div>
  );
}

/* ---------- registry ---------- */

/** Add a registry, or edit one (`reg`): user, namespace and token. An empty token keeps the saved one. */
export function NewRegistryModal({ onClose, reg }: { onClose: () => void; reg?: Registry }) {
  const { withSudo, refresh, toast } = useApp();
  const [host, setHost] = useState(reg?.host ?? "");
  const [ns, setNs] = useState(reg?.namespace ?? "");
  const [user, setUser] = useState(reg?.user ?? "");
  const [tok, setTok] = useState("");
  const [err, setErr] = useState("");
  const isGh = /(^|\.)ghcr\.io$/.test(host.trim());
  const isGl = /gitlab/.test(host.trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    withSudo("레지스트리 토큰 저장", async () => {
      try {
        if (reg) await api.put(`/registries/${reg.id}`, { host: reg.host, namespace: ns, user, token: tok });
        else await api.post("/registries", { host, namespace: ns, user, token: tok });
        onClose();
        refresh();
        toast(reg ? (tok ? "토큰을 바꿨어요" : "저장했어요") : "레지스트리를 추가했어요");
      } catch (e) {
        if ((e as { sudoRequired?: boolean }).sudoRequired) throw e;
        setErr(errMsg(e));
      }
    });
  };

  return (
    <>
      <ModalHead
        title={reg ? "레지스트리 편집" : "레지스트리 추가"}
        sub={reg ? `${reg.host}/${reg.namespace}` : "이미지를 받을 때만 쓰는 읽기 전용 토큰을 넣어 주세요."}
        onClose={onClose}
      />
      <form id="regForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="주소" htmlFor="gHost" hint={reg ? "주소는 바꿀 수 없어요. 다른 주소라면 레지스트리를 새로 추가해 주세요." : "이미지 주소의 맨 앞부분이에요. 예: ghcr.io, registry.gitlab.com, git.example.com"}>
            <Input id="gHost" mono spellCheck={false} placeholder="ghcr.io" disabled={!!reg} value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field
            label="이미지 소유자 (조직 또는 사용자)"
            htmlFor="gNs"
            hint="이미지가 들어 있는 곳이에요. 이미지 주소에서 주소 바로 다음 부분이에요. 예: ghcr.io/ermore/app → ermore. 같은 주소에 레지스트리가 여럿이면 이걸로 골라요."
          >
            <Input id="gNs" mono spellCheck={false} placeholder="ermore" value={ns} onChange={(e) => setNs(e.target.value)} />
          </Field>
          <Field label="로그인 계정" htmlFor="gUser" hint="토큰을 만든 계정이에요. docker login -u 에 들어가요. 조직 이미지라도 로그인은 사람이나 봇 계정으로 해요.">
            <Input id="gUser" mono spellCheck={false} placeholder="deploy-bot" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field
            label="토큰"
            htmlFor="gTok"
            hint={
              isGh
                ? "GitHub Container Registry예요. 토큰에는 read:packages 권한만 주세요."
                : isGl
                  ? "GitLab Container Registry예요. 토큰에는 read_registry 권한만 주세요."
                  : host.trim()
                    ? "Gitea 레지스트리로 연결해요. 토큰에는 read:package 권한만 주세요."
                    : "이미지를 받는 읽기 권한만 준 토큰을 넣어 주세요."
            }
          >
            <Input
              id="gTok"
              mono
              type="password"
              placeholder={reg?.hasSecret ? "비워 두면 저장된 토큰을 그대로 써요" : "ghp_…, glpat-… 또는 Gitea 토큰"}
              autoComplete="off"
              value={tok}
              onChange={(e) => setTok(e.target.value)}
            />
          </Field>
          <ErrorText>{err}</ErrorText>
          <Banner icon="lock" title="토큰은 암호화해 저장하고 다시 보여주지 않아요">
            배포할 때 대상 서버에서 로그인한 뒤 바로 로그아웃해요. 서버 디스크에는 남기지 않아요.
          </Banner>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="regForm">
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- images ---------- */

// Same checks as the server's IMAGE_RE / TAG_RE, so the preview never promises something it will reject.
const IMAGE_RE = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Mirror of the server's parse_image: Docker Hub names get docker.io/(library/), no tag means latest. */
export function parseImage(text: string): { ref: string; tag: string } | { error: string } | null {
  const t = text.trim().replace(/^https:\/\//, "");
  if (!t) return null;
  if (t.includes("@")) return { error: "digest(@sha256:…)는 넣을 수 없어요. 태그로 적어 주세요." };
  const slash = t.lastIndexOf("/");
  const colon = t.indexOf(":", slash + 1);
  let ref = (colon >= 0 ? t.slice(0, colon) : t).toLowerCase();
  const tag = colon >= 0 ? t.slice(colon + 1) : "latest";
  const parts = ref.split("/");
  if (!/[.:]/.test(parts[0]) && parts[0] !== "localhost") ref = parts.length === 1 ? `docker.io/library/${ref}` : `docker.io/${ref}`;
  if (!IMAGE_RE.test(ref)) return { error: "이미지 이름을 알아볼 수 없어요. 예: postgres:15, ghcr.io/acme/api:v1.2" };
  if (!TAG_RE.test(tag)) return { error: "버전(태그)에는 영문, 숫자, . _ - 만 쓸 수 있어요." };
  return { ref, tag };
}

/** The registered registry whose token pulls this ref, like the server's registry_for: the host, then the longest
 *  namespace that starts the image path, then one without a namespace, then the first on the host. */
export function registryFor(ref: string, registries: Registry[]): Registry | undefined {
  const [host, ...rest] = ref.split("/");
  const path = rest.join("/") + "/";
  const same = registries.filter((r) => r.host.trim().toLowerCase() === host);
  const owned = same.filter((r) => r.namespace && path.startsWith(r.namespace.replace(/^\/+|\/+$/g, "") + "/"));
  if (owned.length) return owned.reduce((a, b) => (b.namespace.length > a.namespace.length ? b : a));
  return same.find((r) => !r.namespace) ?? same[0];
}

/** Register an image by typing it the way you would for docker pull. */
export function NewImageModal({ registries, onClose }: { registries: Registry[]; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = parseImage(text);
  const bad = parsed && "error" in parsed ? parsed.error : "";
  const ok = parsed && !("error" in parsed) ? parsed : null;
  const reg = ok ? registryFor(ok.ref, registries) : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return setErr(bad || "이미지를 넣어 주세요.");
    setBusy(true);
    setErr("");
    try {
      const r = await api.post<Image & { created: boolean; addedTags: string[] }>("/images", { image: text.trim() });
      onClose();
      refresh();
      toast(r.created ? "이미지를 등록했어요" : r.addedTags.length ? `이미 있는 이미지라 태그 ${r.addedTags.length}개만 더했어요` : "이미 등록된 이미지예요");
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <ModalHead title="이미지 추가" sub="docker pull 할 때처럼 적어 주세요. 배포 작업에 이미지를 적으면 여기에도 저절로 들어와요." onClose={onClose} />
      <form id="imgForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이미지" htmlFor="iImage" hint="버전을 빼면 latest예요. latest는 늘 바뀌는 이름이라 버전 목록에는 남기지 않아요." error={!!bad}>
            <Input
              id="iImage"
              mono
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="postgres:15 또는 ghcr.io/acme/api:v1.2"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setErr("");
              }}
            />
          </Field>
          {ok && (
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 animate-fade">
              <KV
                labelWidth={72}
                items={[
                  ["이미지", <span className="break-all">{ok.ref}</span>, "font-mono !whitespace-normal"],
                  ["버전", ok.tag === "latest" ? <span className="text-muted"><span className="font-mono">latest</span> · 버전으로 저장하지 않아요</span> : ok.tag, ok.tag === "latest" ? "!whitespace-normal" : "font-mono"],
                  [
                    "받는 방법",
                    reg ? (
                      <>
                        <span className="font-mono">{reg.name}</span> 레지스트리의 토큰으로 받아요
                      </>
                    ) : (
                      "공개 이미지로 받아요"
                    ),
                    "!whitespace-normal",
                  ],
                ]}
              />
            </div>
          )}
          <ErrorText>{err || bad}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="imgForm" disabled={busy || !ok}>
          등록
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- hosts ---------- */

/** A server list (inventory) with the SSH key used to reach its servers. */

/** Make an inventory: its name, deploy user and SSH key (made here when there is none). Its servers are added next. */
export function NewInventoryModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (inv: Inventory) => void }) {
  const { openModal, refresh, toast } = useApp();
  const all = useApi<Inventory[]>("/inventory").data ?? [];
  const [name, setName] = useState("");
  const [user, setUser] = useState("deploy");
  const [busy, setBusy] = useState(false);

  const basicError = (): string => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.trim())) return "인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.";
    if (all.some((i) => i.name === name.trim())) return "같은 이름의 인벤토리가 있어요.";
    return userError(user);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const bad = basicError();
    if (bad) return toast(bad, "error");
    setBusy(true);
    try {
      const inv = await api.post<Inventory>("/inventory", { name: name.trim(), user: user.trim() });
      refresh();
      onCreated?.(inv);
      onClose();
      toast("인벤토리를 만들었어요. 이제 서버를 추가해요.");
      openModal((c) => <NewHostModal inventory={inv} onClose={c} />);
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ModalHead title="인벤토리 추가" sub="함께 배포하는 서버 묶음이에요. 만든 뒤 바로 서버를 추가해요." onClose={onClose} />
      <form id="invForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="iName" hint="영문 소문자, 숫자, -, _">
            <Input id="iName" mono autoFocus placeholder="production" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="실행 계정" htmlFor="iUser" hint="서버의 에이전트가 배포 명령을 이 계정으로 실행해요. 없으면 서버를 추가할 때 만들어요. root는 안 돼요.">
            <Input id="iUser" mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Hint>SSH 키는 필요 없어요. 서버마다 에이전트가 Wharfline에 접속해서 배포해요.</Hint>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="invForm" disabled={busy}>
          {busy ? "만드는 중…" : "만들기"}
        </Button>
      </ModalFoot>
    </>
  );
}

function userError(user: string): string {
  if (user.trim() === "root") return "root로는 접속할 수 없어요. 권한이 제한된 배포용 사용자를 만들어 주세요.";
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(user.trim()) ? "" : "배포 사용자 이름은 영문 소문자, 숫자, -, _ 로 넣어 주세요. 예: deploy";
}

type ServerDraft = { name: string; group: string; ip: string; port: string };

/** Same checks as the server, so mistakes show before going on. Name and group may be empty (the server fills them in). */
function serverError(v: ServerDraft, taken: string[]): string {
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(v.ip.trim())) return "IP 또는 호스트 이름을 확인해 주세요.";
  if (!/^\d+$/.test(v.port.trim()) || +v.port < 1 || +v.port > 65535) return "포트는 1~65535 사이 숫자여야 해요.";
  if (v.name.trim() && taken.includes(v.name.trim())) return "이 인벤토리에 같은 이름의 서버가 있어요.";
  if (v.group.trim() && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v.group.trim())) return "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.";
  return "";
}

const NEW_GROUP = "\u0000new";

function ServerFields({ value: v, onChange, groups }: { value: ServerDraft; onChange: (v: ServerDraft) => void; groups: string[] }) {
  const set = (patch: Partial<ServerDraft>) => onChange({ ...v, ...patch });
  const optional = <span className="text-muted font-normal text-[12.5px]">선택</span>;
  return (
    <>
      <Field label="IP 또는 호스트" htmlFor="hIp">
        <Input id="hIp" mono placeholder="10.0.1.18" value={v.ip} onChange={(e) => set({ ip: e.target.value })} autoFocus />
      </Field>
      <Field label="포트" htmlFor="hPort">
        <Input id="hPort" mono inputMode="numeric" value={v.port} onChange={(e) => set({ port: e.target.value })} />
      </Field>
      <Field label={<>이름 {optional}</>} htmlFor="hName" hint="화면과 실행 기록에서 부르는 이름이에요. 비우면 IP로 해요.">
        <Input id="hName" placeholder={v.ip.trim() || "web-03"} value={v.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <GroupField value={v.group} onChange={(group) => set({ group })} groups={groups} />
    </>
  );
}

/** A group of the inventory from the list, or a new one typed in. Empty = default. */
function GroupField({ value, onChange, groups }: { value: string; onChange: (g: string) => void; groups: string[] }) {
  const [typing, setTyping] = useState(false);
  return (
    <Field label={<>그룹 <span className="text-muted font-normal text-[12.5px]">선택</span></>} htmlFor="hGroup" hint="배포 대상을 고를 때 써요.">
      {groups.length && !typing ? (
        <Select
          id="hGroup"
          mono
          value={value.trim() || "default"}
          onChange={(e) => {
            if (e.target.value === NEW_GROUP) {
              setTyping(true);
              onChange("");
            } else onChange(e.target.value === "default" ? "" : e.target.value);
          }}
        >
          {[...new Set([...groups, "default"])].map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
          <option value={NEW_GROUP}>새 그룹 입력…</option>
        </Select>
      ) : (
        <Input id="hGroup" mono placeholder="default" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={typing} />
      )}
    </Field>
  );
}

/** Add a server to an inventory. Either Wharfline sets it up once over SSH with its first account and password, or
 *  someone runs an install command on it. Both end with the server's agent connected; Wharfline keeps no SSH key. */
export function NewHostModal({ inventory: inv, onClose }: { inventory: Inventory; onClose: () => void }) {
  const { toast, withSudo, refresh } = useApp();
  const [how, setHow] = useState<"init" | "install">("init");
  const [step, setStep] = useState<"info" | "confirm" | "running" | "done" | "command">("info");
  const [srv, setSrv] = useState<ServerDraft>({ name: "", group: "", ip: "", port: "22" });
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [fullSudo, setFullSudo] = useState(false);
  const [users, setUsers] = useState("");
  const [paths, setPaths] = useState("/srv");
  const [hostKey, setHostKey] = useState<{ type: string; fingerprint: string } | null>(null);
  const [outcome, setOutcome] = useState<InitResult | null>(null);
  const [made, setMade] = useState<{ host: Host; command: string; expiresIn: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const user = inv.user || "deploy";
  const listOf = (t: string) => t.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).join(",");

  const next = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (how === "install") {
      if (!srv.name.trim()) return toast("서버 이름을 넣어 주세요.", "error");
      if (inv.hosts.some((h) => h.name === srv.name.trim())) return toast("이 인벤토리에 같은 이름의 서버가 있어요.", "error");
      return withSudo("서버 추가", async () => {
        try {
          setMade(await api.post(`/inventory/${inv.id}/hosts/pending`, { name: srv.name.trim(), group: srv.group.trim(), users: listOf(users), paths: listOf(paths) }));
          setStep("command");
          refresh();
        } catch (err) {
          if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
          toast(errMsg(err), "error");
        }
      });
    }
    const bad = serverError(srv, inv.hosts.map((h) => h.name));
    if (bad) return toast(bad, "error");
    if (!LOGIN_USER_RE.test(account.trim())) return toast("서버에 이미 있는 계정 이름을 넣어 주세요. 예: ubuntu", "error");
    if (!password) return toast("비밀번호를 넣어 주세요.", "error");
    setBusy(true);
    try {
      setHostKey(await api.post<{ type: string; fingerprint: string }>("/inventory/fingerprint", { ip: srv.ip.trim(), port: +srv.port }));
      setStep("confirm");
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const init = () =>
    withSudo("서버 초기화", async () => {
      setStep("running");
      try {
        const r = await api.post<InitResult>(`/inventory/${inv.id}/hosts/init`, {
          name: srv.name.trim(),
          ip: srv.ip.trim(),
          port: srv.port.trim(),
          group: srv.group.trim(),
          fingerprint: hostKey?.fingerprint ?? "",
          account: account.trim(),
          password,
          fullSudo,
          users: listOf(users),
          paths: listOf(paths),
        });
        setOutcome(r);
        setStep("done");
        if (r.ok) {
          setPassword("");
          refresh();
        }
      } catch (e) {
        setStep("confirm");
        if ((e as { sudoRequired?: boolean }).sudoRequired) throw e;
        toast(errMsg(e), "error");
      }
    });

  const sub = `${inv.name} · 실행 계정 ${user}`;
  if (step === "command" && made)
    return (
      <>
        <ModalHead title="설치 명령" sub={`${inv.name} · ${made.host.name}`} onClose={onClose} />
        <ModalBody>
          <InstallCommand inventoryId={inv.id} hostName={made.host.name} command={made.command} expiresIn={made.expiresIn} />
        </ModalBody>
        <ModalFoot>
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </ModalFoot>
      </>
    );

  if (step === "confirm" && hostKey)
    return (
      <>
        <ModalHead title="서버 확인" sub={`${srv.ip.trim()}:${srv.port.trim()}`} onClose={onClose} />
        <ModalBody>
          <Field label={`호스트 키 지문 · ${hostKey.type}`} hint="이 서버가 맞는지 확인하는 값이에요. 맞다고 확인해야 비밀번호를 보내요.">
            <div className="rounded-lg bg-surface-2 border border-line px-3.5 py-2.5 font-mono text-[12.5px] break-all">{hostKey.fingerprint}</div>
          </Field>
          <Hint>
            서버 콘솔에서 비교할 수 있어요: <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>
          </Hint>
          <Banner tone="neutral" icon="server" title="이 일을 해요">
            실행 계정(<span className="font-mono">{[user, ...listOf(users).split(",").filter((u) => u && u !== user)].join(", ")}</span>)을 만들고 Docker와 docker rollout을 설치한 뒤, 에이전트를 띄워요. 몇 분 걸릴 수 있고, 다시 실행해도 괜찮아요.
            비밀번호는 저장하지 않고, SSH 키도 남기지 않아요.
          </Banner>
        </ModalBody>
        <ModalFoot between>
          <Button variant="ghost" onClick={() => setStep("info")}>
            이전
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>취소</Button>
            <Button variant="primary" onClick={init}>
              지문이 맞아요, 초기화
            </Button>
          </div>
        </ModalFoot>
      </>
    );

  if (step === "running")
    return (
      <>
        <ModalHead title="서버 초기화" sub={`${srv.ip.trim()}:${srv.port.trim()}`} onClose={onClose} />
        <ModalBody>
          <p className="m-0 text-[13px] text-muted">서버를 설정하고 에이전트를 띄우고 있어요. Docker를 새로 설치하면 몇 분 걸려요. 창을 닫지 말아 주세요.</p>
        </ModalBody>
      </>
    );

  if (step === "done" && outcome)
    return (
      <>
        <ModalHead title={outcome.ok ? "서버를 준비했어요" : "초기화하지 못했어요"} sub={`${srv.ip.trim()}:${srv.port.trim()}`} onClose={onClose} />
        <ModalBody>
          <StepsResult r={outcome} />
          {outcome.ok && <Hint>이제 이 서버는 에이전트로 배포해요. 서버의 SSH 포트를 Wharfline에 열어 둘 필요가 없어요.</Hint>}
        </ModalBody>
        <ModalFoot>
          {outcome.ok ? (
            <Button variant="primary" onClick={onClose}>
              닫기
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>닫기</Button>
              <Button variant="primary" onClick={() => setStep("info")}>
                다시 시도
              </Button>
            </>
          )}
        </ModalFoot>
      </>
    );

  return (
    <>
      <ModalHead title="서버 추가" sub={sub} onClose={onClose} />
      <form id="hostForm" onSubmit={next} className="contents">
        <ModalBody>
          <Field label="추가 방법">
            <div>
              <Seg
                options={[
                  { value: "init", label: "새 서버 초기화" },
                  { value: "install", label: "설치 명령으로 추가" },
                ]}
                value={how}
                onChange={setHow}
              />
            </div>
          </Field>
          {how === "init" ? (
            <ServerFields value={srv} onChange={setSrv} groups={[...new Set(inv.hosts.map((h) => h.group))]} />
          ) : (
            <>
              <Field label="이름" htmlFor="hName" hint="화면과 실행 기록에서 부르는 이름이에요.">
                <Input id="hName" autoFocus placeholder="web-1" value={srv.name} onChange={(e) => setSrv({ ...srv, name: e.target.value })} />
              </Field>
              <GroupField value={srv.group} onChange={(g) => setSrv({ ...srv, group: g })} groups={[...new Set(inv.hosts.map((h) => h.group))]} />
              <Hint>Wharfline이 서버에 SSH로 들어갈 수 없을 때 써요. 명령을 서버에서 직접 실행하면 에이전트가 연결돼요.</Hint>
            </>
          )}
          {how === "init" && (
            <>
              <Field label="서버의 기존 계정" htmlFor="hAccount" hint="서버를 받을 때 있던 계정이에요. root여도 돼요. 초기화에 한 번만 써요.">
                <Input id="hAccount" mono spellCheck={false} autoComplete="off" placeholder="ubuntu" value={account} onChange={(e) => setAccount(e.target.value)} />
              </Field>
              <Field label="비밀번호" htmlFor="hPassword" hint="저장하지 않아요. sudo가 비밀번호를 물으면 이 값을 써요.">
                <Input id="hPassword" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </>
          )}
          <PolicyFields invUser={user} users={users} setUsers={setUsers} paths={paths} setPaths={setPaths} />
          {how === "init" && (
            <Check
              checked={fullSudo}
              onChange={setFullSudo}
              title={
                <>
                  <span className="font-mono">{user}</span>에게 비밀번호 없는 sudo 주기
                </>
              }
              desc="become: true를 쓰는 플레이북을 돌릴 때만 켜요. Compose 배포에는 필요 없어요. 나중에 서버 수정에서 바꿀 수 있어요."
            />
          )}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="hostForm" disabled={busy}>
          {busy ? "확인하는 중…" : how === "install" ? "설치 명령 만들기" : "다음"}
        </Button>
      </ModalFoot>
    </>
  );
}


export function HostKeyModal({ invId, ix, host, onClose }: { invId: string; ix: number; host: Host; onClose: () => void }) {
  const { withSudo, refresh, toast } = useApp();
  return (
    <>
      <ModalHead title="호스트 키가 바뀌었어요" sub={`${host.name} · ${host.ip}:${host.port}`} onClose={onClose} />
      <ModalBody>
        <Banner tone="warn" icon="alert" title="서버를 다시 설치했거나 SSH 키를 새로 만든 적이 없다면 승인하지 마세요.">
          누군가 이 주소로 오는 접속을 가로채고 있을 수 있어요.
        </Banner>
        <KV
          labelWidth={90}
          items={[
            ["저장된 지문", <span className="whitespace-normal break-all">SHA256:Ln2Tq8Vx1Rb5Kc9Wm3Yh7Pz0Ja4Sd6Fe</span>, "font-mono !whitespace-normal"],
            ["지금 지문", <span className="whitespace-normal break-all text-bad">SHA256:Mf7Ua3Qy9Ec1Xn5Bv8Hk2Lr6Wt0Jp4Zs</span>, "font-mono !whitespace-normal"],
            ["처음 감지", "오늘 12:10:47"],
          ]}
        />
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>나중에</Button>
        <Button
          variant="danger"
          onClick={() =>
            withSudo("호스트 키 변경 승인", async () => {
              await api.post(`/inventory/${invId}/hosts/${ix}/accept-key`);
              onClose();
              refresh();
              toast("새 지문을 저장했어요");
            })
          }
        >
          새 지문으로 바꾸기
        </Button>
      </ModalFoot>
    </>
  );
}

/** A server's name and group. Address, port and user stay: those would make it a different server. */
export function EditHostModal({ inventory: inv, ix, onClose }: { inventory: Inventory; ix: number; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const h = inv.hosts[ix];
  const [name, setName] = useState(h.name);
  const [group, setGroup] = useState(h.group === "default" ? "" : h.group);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(inv.hosts.map((x) => x.group))];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (group.trim() && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(group.trim())) return toast("그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.", "error");
    setBusy(true);
    try {
      await api.put(`/inventory/${inv.id}/hosts/${ix}`, { name: name.trim(), group: group.trim() });
      refresh();
      onClose();
      toast("서버를 고쳤어요");
    } catch (err) {
      toast(errMsg(err), "error");
      setBusy(false);
    }
  };
  return (
    <>
      <ModalHead title="서버 수정" sub={`${inv.name} · ${h.ip || "주소 대기"}`} onClose={onClose} />
      <form id="hostEdit" onSubmit={save} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="hName" hint="화면과 실행 기록에서 부르는 이름이에요. 비우면 IP로 해요.">
            <Input id="hName" autoFocus placeholder={h.ip} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <GroupField value={group} onChange={setGroup} groups={groups} />
          {h.mode === "agent" && <AgentPanel inventory={inv} ix={ix} />}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="hostEdit" disabled={busy}>
          {busy ? "저장하는 중…" : "저장"}
        </Button>
      </ModalFoot>
    </>
  );
}

/** An inventory's name, deploy user and key. A new user or key is applied only when every server logs in with it. */
export function EditInventoryModal({ inventory: inv, onClose }: { inventory: Inventory; onClose: () => void }) {
  const { refresh, toast, withSudo, openModal } = useApp();
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [name, setName] = useState(inv.name);
  const [user, setUser] = useState(inv.user);
  const [key, setKey] = useState(inv.key);
  const [busy, setBusy] = useState(false);
  const loginChange = user.trim() !== inv.user || key !== inv.key;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.trim())) return toast("인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.", "error");
    const bad = userError(user);
    if (bad) return toast(bad, "error");
    withSudo("인벤토리 수정", async () => {
      setBusy(true);
      try {
        await api.put(`/inventory/${inv.id}`, { name: name.trim(), user: user.trim(), key });
        refresh();
        onClose();
        toast(loginChange ? "서버마다 새 설정을 확인하고 바꿨어요" : "인벤토리를 고쳤어요");
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <>
      <ModalHead title="인벤토리 수정" sub={`서버 ${inv.hosts.length}대`} onClose={onClose} />
      <form id="invEdit" onSubmit={save} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="ieName" hint="바꾸면 이 인벤토리를 쓰는 배포 작업도 따라 바뀌어요.">
            <Input id="ieName" mono value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="실행 계정" htmlFor="ieUser" hint="작업이 따로 정하지 않으면 이 계정으로 실행해요. 서버마다 에이전트가 이 계정을 허용해야 해요.">
            <Input id="ieUser" mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          {(inv.key || inv.hosts.some((h) => h.mode === "ssh")) && (
            <Field
              label="SSH 키 (전환 전 서버용)"
              htmlFor="ieKey"
              hint="아직 SSH로 배포하는 서버를 에이전트로 바꿀 때 한 번 써요. 모두 바꾼 뒤에는 '없음'으로 두세요."
              right={
                <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} onCreated={(k) => setKey(k.name)} />)}>
                  키 추가
                </Button>
              }
            >
              <Select id="ieKey" value={key} onChange={(e) => setKey(e.target.value)}>
                <option value="">없음</option>
                {key && !keys.some((k) => k.name === key) && <option value={key}>{key}</option>}
                {keys.map((k) => (
                  <option key={k.id} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {loginChange && inv.hosts.length > 0 && (
            <Banner tone="info" icon="info" title="저장할 때 서버마다 확인해요">
              에이전트 서버는 새 계정을 허용하는지, 아직 SSH로 배포하는 서버는 새 계정·키로 로그인되는지 확인하고, 하나라도 안 되면 그대로 둬요.
            </Banner>
          )}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="invEdit" disabled={busy}>
          {busy ? (loginChange ? "접속 확인 중…" : "저장하는 중…") : "저장"}
        </Button>
      </ModalFoot>
    </>
  );
}

type MoveCheck = { key: string; label: string; ok: boolean; detail: string };

/** One line of the move checklist: spinner while checking, then a check mark or an X with the reason. */
function CheckLine({ label, state, detail }: { label: string; state: "wait" | "ok" | "bad"; detail?: string }) {
  return (
    <li className="flex items-start gap-2.5 py-2.5 border-b border-line last:border-b-0">
      <span className={cx("grid place-items-center size-5 rounded-full flex-none mt-px", state === "ok" ? "bg-ok-soft text-ok" : state === "bad" ? "bg-bad-soft text-bad" : "text-faint")}>
        {state === "wait" ? (
          <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-label="확인 중" />
        ) : (
          <Icon name={state === "ok" ? "check" : "x"} className="size-3" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className={cx("block text-[12px]", state === "bad" ? "text-bad" : "text-muted")}>{state === "wait" ? "확인하는 중…" : detail}</span>
      </span>
    </li>
  );
}

/**
 * "옮기겠습니까?" with a checklist: same name there, jobs left without servers, deploys going, and a login with
 * the target's user and key. Moving is possible only when every line has a check mark.
 * `to` is fixed after a drag; from the menu, the person picks the inventory here.
 */
export function MoveHostModal({ from, ix, all, to: fixedTo, onClose }: { from: Inventory; ix: number; all: Inventory[]; to?: Inventory; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const others = all.filter((i) => i.id !== from.id);
  const [toId, setToId] = useState(fixedTo?.id ?? others[0]?.id ?? "");
  const [checks, setChecks] = useState<MoveCheck[] | null>(null);
  const [login, setLogin] = useState<MoveCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const target = others.find((i) => i.id === toId);
  const h = from.hosts[ix];

  useEffect(() => {
    if (!target) return;
    let live = true;
    setChecks(null);
    setLogin(null);
    const body = { to: target.id };
    api.post<{ checks: MoveCheck[] }>(`/inventory/${from.id}/hosts/${ix}/move/check`, body).then(
      (r) => live && setChecks(r.checks),
      (e) => live && setChecks([{ key: "err", label: "확인", ok: false, detail: errMsg(e) }]),
    );
    api.post<MoveCheck>(`/inventory/${from.id}/hosts/${ix}/move/login`, body).then(
      (r) => live && setLogin(r),
      (e) => live && setLogin({ key: "login", label: "서버 연결", ok: false, detail: errMsg(e) }),
    );
    return () => {
      live = false;
    };
  }, [toId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines: { key: string; label: string; state: "wait" | "ok" | "bad"; detail?: string }[] = [
    ...(checks ?? [{ key: "name", label: "같은 이름의 서버" }, { key: "jobs", label: "배포 작업 영향" }, { key: "busy", label: "진행 중인 배포" }]).map((c) => ({
      key: c.key,
      label: c.label,
      state: !checks ? ("wait" as const) : (c as MoveCheck).ok ? ("ok" as const) : ("bad" as const),
      detail: (c as MoveCheck).detail,
    })),
    { key: "login", label: "서버 연결", state: !login ? "wait" : login.ok ? "ok" : "bad", detail: login?.detail },
  ];
  const done = !!checks && !!login;
  const allOk = done && lines.every((l) => l.state === "ok");

  const move = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/inventory/${from.id}/hosts/${ix}/move`, { to: target.id });
      refresh();
      onClose();
      toast(`${h.name}을(를) ${target.name}(으)로 옮겼어요`);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };

  return (
    <>
      <ModalHead title="서버를 옮기겠습니까?" onClose={onClose} />
      <ModalBody>
        <div className="flex items-center gap-2 flex-wrap text-[13px]">
          <span className="font-mono font-medium">{h.name}</span>
          <span className="text-muted font-mono text-[12px]">{h.ip}</span>
          <span className="text-muted">·</span>
          <span className="font-mono">{from.name}</span>
          <Icon name="arrow" className="size-3.5 text-faint" />
          {fixedTo ? (
            <span className="font-mono font-semibold text-accent">{fixedTo.name}</span>
          ) : (
            <Select aria-label="옮길 인벤토리" mono className="w-auto" value={toId} onChange={(e) => setToId(e.target.value)}>
              {others.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <ul className="rounded-xl border border-line px-3.5">
          {lines.map((l) => (
            <CheckLine key={l.key} label={l.label} state={l.state} detail={l.detail} />
          ))}
        </ul>
        {done && !allOk && (
          <Banner tone="warn" icon="alert" title="옮길 수 없어요">
            X 표시된 항목을 정리한 뒤 다시 옮겨 주세요.
          </Banner>
        )}
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" disabled={!allOk || busy} onClick={move}>
          {busy ? "옮기는 중…" : done ? "옮기기" : "확인하는 중…"}
        </Button>
      </ModalFoot>
    </>
  );
}
