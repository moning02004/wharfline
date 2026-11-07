import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Host, Image, Inventory, Key, Registry } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, ErrorText, Field, Hint, Input, KV, Select, Seg, Textarea } from "../components/ui";

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

export function NewKeyModal({ onClose }: { onClose: () => void }) {
  const { refresh, toast, openModal, withSudo } = useApp();
  const [mode, setMode] = useState<"gen" | "paste" | "token">("gen");
  const [name, setName] = useState("batch-deploy");
  const [touched, setTouched] = useState(false);
  const [priv, setPriv] = useState("");
  const [pass, setPass] = useState("");
  const [user, setUser] = useState("deploy-bot");
  const [tok, setTok] = useState("");
  const [err, setErr] = useState("");

  const changeMode = (m: typeof mode) => {
    setMode(m);
    if (!touched) setName(m === "token" ? "gitea-readonly" : "batch-deploy");
    setErr("");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    withSudo("키 추가", async () => {
      try {
        const k = await api.post<Key>("/keys", { mode, name, privateKey: priv, passphrase: pass, user, token: tok });
        onClose();
        refresh();
        if (k.kind === "token") toast("토큰을 저장했어요. 다시 볼 수 없어요.");
        else openModal((close) => <PubKeyModal k={k} fresh onClose={close} />);
      } catch (e) {
        if ((e as { sudoRequired?: boolean }).sudoRequired) throw e;
        setErr(errMsg(e));
      }
    });
  };

  return (
    <>
      <ModalHead title="키 추가" sub="서버 접속용 SSH 키나 Git 저장소용 액세스 토큰을 저장해요." onClose={onClose} />
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
  const { toast } = useApp();
  const [pub, setPub] = useState(k.publicKey ?? "");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!pub) api.get<{ publicKey: string }>(`/keys/${k.id}/public`).then((r) => setPub(r.publicKey));
  }, [k.id, pub]);

  return (
    <>
      <ModalHead title={fresh ? "키를 만들었어요" : "공개 키"} sub={`${k.name} · ${k.fingerprint}`} onClose={onClose} />
      <ModalBody>
        <Field label="대상 서버의 ~/.ssh/authorized_keys에 추가하세요">
          <Textarea ref={ta} rows={3} readOnly value={pub} />
        </Field>
        <Banner icon="info">
          더 안전하게 하려면 앞에 <span className="font-mono">from="배포서버IP",no-pty,no-port-forwarding</span> 옵션을 붙여 이 서버에서만, 터미널 없이 쓰이게 하세요.
        </Banner>
      </ModalBody>
      <ModalFoot>
        <Button
          icon="copy"
          onClick={() => {
            copyText(pub, toast);
            ta.current?.select();
          }}
        >
          복사
        </Button>
        <Button variant="primary" onClick={onClose}>
          완료
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- registry ---------- */

export function NewRegistryModal({ onClose }: { onClose: () => void }) {
  const { withSudo, refresh, toast } = useApp();
  const [host, setHost] = useState("ghcr.io");
  const [ns, setNs] = useState("acme-labs");
  const [user, setUser] = useState("deploy-bot");
  const [tok, setTok] = useState("");
  const [err, setErr] = useState("");
  const isGh = /(^|\.)ghcr\.io$/.test(host.trim());
  const isGl = /gitlab/.test(host.trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    withSudo("레지스트리 토큰 저장", async () => {
      try {
        await api.post("/registries", { host, namespace: ns, user, token: tok });
        onClose();
        refresh();
        toast("연결을 확인하고 저장했어요");
      } catch (e) {
        if ((e as { sudoRequired?: boolean }).sudoRequired) throw e;
        setErr(errMsg(e));
      }
    });
  };

  return (
    <>
      <ModalHead title="레지스트리 추가" sub="이미지를 받을 때만 쓰는 읽기 전용 토큰을 넣어 주세요." onClose={onClose} />
      <form id="regForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="주소" htmlFor="gHost">
            <Input id="gHost" mono spellCheck={false} value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="조직 또는 사용자" htmlFor="gNs">
            <Input id="gNs" mono value={ns} onChange={(e) => setNs(e.target.value)} />
          </Field>
          <Field label="사용자 이름" htmlFor="gUser">
            <Input id="gUser" mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field
            label="토큰"
            htmlFor="gTok"
            hint={
              isGh
                ? "GitHub Container Registry예요. 토큰에는 read:packages 권한만 주세요."
                : isGl
                  ? "GitLab Container Registry예요. 토큰에는 read_registry 권한만 주세요."
                  : "Gitea 레지스트리로 연결해요. 토큰에는 read:package 권한만 주세요."
            }
          >
            <Input id="gTok" mono type="password" placeholder="ghp_… 또는 Gitea 토큰" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} />
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
          연결 테스트 후 저장
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

/** The registered registry whose token pulls this ref, matched by host like the server does. */
export function registryFor(ref: string, registries: Registry[]): Registry | undefined {
  const host = ref.split("/")[0];
  return registries.find((r) => r.host.trim().toLowerCase() === host);
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
export function NewInventoryModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (inv: Inventory) => void }) {
  const { openModal, refresh, toast } = useApp();
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!key && keys[0]) setKey(keys[0].name);
  }, [keys, key]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const inv = await api.post<Inventory>("/inventory", { name: name.trim(), key });
      refresh();
      toast("인벤토리를 만들었어요");
      onCreated?.(inv);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <>
      <ModalHead title="인벤토리 추가" onClose={onClose} />
      <form id="invForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="iName" hint="영문 소문자, 숫자, -, _">
            <Input id="iName" mono autoFocus placeholder="staging" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="SSH 키"
            htmlFor="iKey"
            right={
              <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} />)}>
                키 추가
              </Button>
            }
          >
            <Select id="iKey" value={key} onChange={(e) => setKey(e.target.value)} placeholder="SSH 키를 추가해 주세요">
              {keys.map((k) => (
                <option key={k.id} value={k.name}>
                  {k.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="invForm" disabled={!name.trim() || !key}>
          만들기
        </Button>
      </ModalFoot>
    </>
  );
}

export function NewHostModal({ inventories, onClose, initialInventory }: { inventories: Inventory[]; onClose: () => void; initialInventory?: string }) {
  const { openModal, closeModal, runAction } = useApp();
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [inv, setInv] = useState(inventories.find((i) => i.name === initialInventory)?.id ?? inventories[0]?.id ?? "");
  const [group, setGroup] = useState(() => inventories.flatMap((i) => i.hosts.map((h) => h.group))[0] ?? "");
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("deploy");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const allGroups = [...new Set(inventories.flatMap((i) => i.hosts.map((h) => h.group)))];

  useEffect(() => {
    if (!key && keys[0]) setKey(keys[0].name);
  }, [keys, key]);

  /** Same checks as the server, so mistakes show before the fingerprint step. */
  const check = (): string => {
    if (!inv) return "인벤토리를 먼저 추가해 주세요.";
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(group.trim())) return "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.";
    if (!name.trim()) return "서버 이름을 넣어 주세요.";
    if (inventories.find((i) => i.id === inv)?.hosts.some((h) => h.name === name.trim())) return "이 인벤토리에 같은 이름의 서버가 있어요.";
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(ip.trim())) return "IP 또는 호스트 이름을 확인해 주세요.";
    if (!/^\d+$/.test(port.trim()) || +port < 1 || +port > 65535) return "포트는 1~65535 사이 숫자여야 해요.";
    if (user.trim() === "root") return "root로는 접속할 수 없어요. 권한이 제한된 deploy 사용자를 만들어 주세요.";
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user.trim())) return "SSH 사용자 이름을 확인해 주세요. 예: deploy";
    return "";
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = check();
    if (bad) return setErr(bad);
    setErr("");
    let fp: { type: string; fingerprint: string };
    try {
      fp = await api.post<{ type: string; fingerprint: string }>("/inventory/fingerprint", { ip: ip.trim(), port: +port });
    } catch (e) {
      return setErr(errMsg(e));
    }
    openModal((close) => (
      <>
        <ModalHead title="호스트 키 지문 확인" sub={`${ip}:${port}`} onClose={close} />
        <ModalBody>
          <Field label={`서버가 보낸 지문 (${fp.type})`}>
            <div className="font-mono p-3 bg-surface-2 rounded-md break-all text-[12.5px]">{fp.fingerprint}</div>
          </Field>
          <Hint className="text-[13px]">
            서버에서 <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> 결과와 같은지 확인하세요. 저장하면 이후 지문이 바뀔 때 배포가 멈춰요.
          </Hint>
        </ModalBody>
        <ModalFoot>
          <Button onClick={close}>다르면 취소</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const ok = await runAction(() => api.post(`/inventory/${inv}/hosts`, { name: name.trim(), ip: ip.trim(), port: port.trim(), user: user.trim(), group: group.trim(), key }), "서버를 추가했어요");
              if (ok) {
                closeModal();
                closeModal();
              }
            }}
          >
            일치해요, 저장
          </Button>
        </ModalFoot>
      </>
    ));
  };

  return (
    <>
      <ModalHead title="서버 추가" sub="처음 연결할 때 호스트 키 지문을 보여드려요. 서버에서 확인한 값과 같은지 비교하세요." onClose={onClose} />
      <form id="hostForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="인벤토리" htmlFor="hInv">
            <Select id="hInv" value={inv} onChange={(e) => setInv(e.target.value)}>
              {inventories.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="그룹" htmlFor="hGroup">
            <Input id="hGroup" mono placeholder="web" value={group} onChange={(e) => setGroup(e.target.value)} list="hGroups" />
            <datalist id="hGroups">
              {allGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="이름" htmlFor="hName">
            <Input id="hName" placeholder="web-03" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2.5">
            <Field label="IP 또는 호스트" htmlFor="hIp">
              <Input id="hIp" mono placeholder="10.0.1.18" value={ip} onChange={(e) => setIp(e.target.value)} />
            </Field>
            <Field label="포트" htmlFor="hPort">
              <Input id="hPort" mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>
          <Field label="SSH 사용자" htmlFor="hUser">
            <Input id="hUser" mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="키" htmlFor="hKey" hint="그룹은 배포 작업에서 대상을 고를 때 쓰여요. 같은 그룹 서버에는 함께 배포돼요.">
            <Select id="hKey" value={key} onChange={(e) => setKey(e.target.value)}>
              {keys.map((k) => (
                <option key={k.id}>{k.name}</option>
              ))}
            </Select>
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="hostForm">
          연결하고 지문 확인
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
