import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Host, Inventory, Key } from "../lib/types";
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

/* ---------- playbook repo ---------- */

const LOCAL_ROOT = "/var/lib/wharfline/playbooks/";

export function NewRepoModal({ onClose }: { onClose: () => void }) {
  const { runAction } = useApp();
  const keys = useApi<Key[]>("/keys").data ?? [];
  const [name, setName] = useState("ansible-monitoring");
  const [kind, setKind] = useState<"git" | "local">("git");
  const [url, setUrl] = useState("git@git.acme.kr:ops/ansible-monitoring.git");
  const [branch, setBranch] = useState("main");
  const [key, setKey] = useState("");
  const [path, setPath] = useState(LOCAL_ROOT + "monitoring");
  const [err, setErr] = useState("");

  const scheme = /^(git@|ssh:\/\/)/.test(url.trim()) ? "ssh" : "https";
  const options = keys.filter((k) => k.kind === (scheme === "ssh" ? "ssh" : "token"));
  useEffect(() => {
    setKey(options[0]?.name ?? "");
  }, [scheme, keys.length]); // reset the picked key when the URL scheme changes

  const hint =
    scheme === "ssh"
      ? key
        ? `SSH 주소예요. ${key}의 공개 키를 저장소의 Deploy key(읽기 전용)로 등록하세요.`
        : "SSH 주소는 SSH 키가 있어야 해요. 키 저장소에서 추가하거나 HTTPS 주소를 넣어 주세요."
      : key
        ? "HTTPS 주소예요. 이 토큰으로 저장소를 읽어요. 읽기 전용 권한이면 충분해요."
        : "HTTPS 주소예요. 공개 저장소면 그대로 두고, 비공개 저장소면 토큰을 고르세요.";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/repos", { name, kind, url, branch, key, path });
      onClose();
      runAction(async () => {}, "연결했어요. 플레이북 2개를 찾았어요.");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <>
      <ModalHead title="플레이북 레포 연결" sub="Git 저장소나 배포 서버의 폴더를 연결해요." onClose={onClose} />
      <form id="repoForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="rName">
            <Input id="rName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="종류">
            <div>
              <Seg
                options={[
                  { value: "git", label: "Git 저장소" },
                  { value: "local", label: "서버 경로" },
                ]}
                value={kind}
                onChange={(k) => {
                  setKind(k);
                  setErr("");
                }}
              />
            </div>
          </Field>
          {kind === "git" ? (
            <div className="flex flex-col gap-4 animate-fade">
              <Field label="저장소 URL" htmlFor="rUrl" hint="SSH(git@…) 또는 HTTPS 주소. GitHub와 Gitea 모두 돼요.">
                <Input id="rUrl" mono spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="브랜치" htmlFor="rBranch">
                <Input id="rBranch" mono spellCheck={false} value={branch} onChange={(e) => setBranch(e.target.value)} />
              </Field>
              <Field label={scheme === "ssh" ? "SSH 키" : "액세스 토큰"} htmlFor="rKey" hint={hint} error={scheme === "ssh" && !key}>
                <Select id="rKey" value={key} onChange={(e) => setKey(e.target.value)}>
                  {scheme === "https" && <option value="">없음 · 공개 저장소</option>}
                  {scheme === "ssh" && !options.length && <option value="">저장된 SSH 키가 없어요</option>}
                  {options.map((k) => (
                    <option key={k.id} value={k.name}>
                      {k.name} · {scheme === "ssh" ? `SSH ${k.type}` : k.fingerprint}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : (
            <Field
              label="서버 경로"
              htmlFor="rPath"
              hint={
                <>
                  Wharfline이 돌아가는 서버의 폴더예요. <span className="font-mono">{LOCAL_ROOT}</span> 아래만 쓸 수 있어요. 실행할 때마다 읽기 전용으로 복사해서 써요.
                </>
              }
            >
              <Input id="rPath" mono spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
            </Field>
          )}
          <ErrorText>{err}</ErrorText>
          <Banner icon="info" title="연결하면 플레이북 파일을 찾아요">
            최상위와 playbooks/ 아래의 .yml 중 hosts가 있는 파일만 배포 작업에서 고를 수 있어요.
          </Banner>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="repoForm">
          연결
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
            hint={isGh ? "GitHub Container Registry예요. 토큰에는 read:packages 권한만 주세요." : "Gitea 레지스트리로 연결해요. 토큰에는 read:package 권한만 주세요."}
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

/* ---------- hosts ---------- */

export function NewHostModal({ inventories, onClose }: { inventories: Inventory[]; onClose: () => void }) {
  const { openModal, closeModal, runAction } = useApp();
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [inv, setInv] = useState(inventories[0]?.id ?? "");
  const [group, setGroup] = useState("worker");
  const [name, setName] = useState("worker-02");
  const [ip, setIp] = useState("10.0.1.18");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("deploy");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const allGroups = [...new Set(inventories.flatMap((i) => i.hosts.map((h) => h.group)))];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (user.trim() === "root") return setErr("root로는 접속할 수 없어요. 권한이 제한된 deploy 사용자를 만들어 주세요.");
    if (!/^\d+$/.test(port.trim())) return setErr("포트는 숫자여야 해요.");
    setErr("");
    const fp = await api.post<{ type: string; fingerprint: string }>("/inventory/fingerprint", { ip, port: +port });
    openModal((close) => (
      <>
        <ModalHead title="호스트 키 지문 확인" sub={`${ip}:${port}`} onClose={close} />
        <ModalBody>
          <Field label={`서버가 보낸 지문 (${fp.type})`}>
            <div className="font-mono p-3 bg-surface-2 rounded-xl break-all text-[12.5px]">{fp.fingerprint}</div>
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
              const ok = await runAction(() => api.post(`/inventory/${inv}/hosts`, { name, ip, port, user, group, key }), "서버를 추가했어요");
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
            <Input id="hGroup" mono value={group} onChange={(e) => setGroup(e.target.value)} list="hGroups" />
            <datalist id="hGroups">
              {allGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="이름" htmlFor="hName">
            <Input id="hName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2.5">
            <Field label="IP 또는 호스트" htmlFor="hIp">
              <Input id="hIp" mono value={ip} onChange={(e) => setIp(e.target.value)} />
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
