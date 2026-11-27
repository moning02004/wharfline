import { useEffect, useState, type ReactNode } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Host, Inventory } from "../lib/types";
import { since, stamp } from "../lib/time";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, Chip, Dot, ErrorText, Field, Hint, Input, KV, Switch, Textarea, cx } from "../components/ui";
import { Icon } from "../components/Icon";
import { copyText } from "./ResourceModals";

/*
 * Servers deploy through a Wharfline agent (a container on the server that connects out to Wharfline).
 * Wharfline keeps no SSH key: these modals install the agent, show what it reports, and change the few
 * things Wharfline may change on the server (password-less sudo for an allowed account, the agent version).
 * Which accounts and folders an agent accepts is fixed on the server when it is installed.
 */

export interface InitStep {
  name: string;
  status: "ok" | "fail" | "skip";
}

export interface InitResult {
  ok: boolean;
  steps: InitStep[];
  log: string[];
  error: string | null;
  host?: Host | null;
}

export interface AgentSettings {
  url: string;
  saved: string;
  image: string;
  /** Internal addresses written into the servers' /etc/hosts, one "IP name name…" per line */
  hosts: string;
}

/** An agent counts as connected when it polled in the last minute. */
export const agentOnline = (h: Host) => !!h.agent?.seen && Date.now() / 1000 - h.agent.seen < 60;

export function AgentState({ h }: { h: Host }) {
  if (h.mode === "pending") return <Dot tone="warn">등록 대기</Dot>;
  if (h.mode !== "agent") return <Dot tone="bad">SSH · 전환 필요</Dot>;
  if (h.agent?.version === "simulated") return <Dot tone="ok">연결됨</Dot>;
  return agentOnline(h) ? (
    <Dot tone="ok">연결됨</Dot>
  ) : (
    <span title={stamp(h.agent?.seen)}>
      <Dot>{h.agent?.seen ? `${since(h.agent.seen)} 마지막 연결` : "연결 안 됨"}</Dot>
    </span>
  );
}

/** Users and folders, as shown and sent: "deploy, ubuntu" → "deploy,ubuntu". */
const list = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(",");

/** The agent's accounts and folders, asked when it is installed. */
export function PolicyFields({ invUser, users, setUsers, paths, setPaths }: { invUser: string; users: string; setUsers: (v: string) => void; paths: string; setPaths: (v: string) => void }) {
  return (
    <>
      <Field
        label="실행 계정"
        htmlFor="agUsers"
        hint={
          <>
            에이전트가 명령을 실행할 수 있는 서버 계정이에요. <span className="font-mono">{invUser}</span>(인벤토리 계정)은 늘 들어가요. 다른 계정으로 배포하는 작업이 있으면 더해 주세요. root는 안 돼요.
          </>
        }
      >
        <Input id="agUsers" mono spellCheck={false} placeholder="ubuntu" value={users} onChange={(e) => setUsers(e.target.value)} />
      </Field>
      <Field label="허용 경로" htmlFor="agPaths" hint="에이전트가 파일을 쓸 수 있는 폴더예요. 여러 개는 쉼표로 적어요. 예: /srv, /home/ubuntu/apps">
        <Input id="agPaths" mono spellCheck={false} placeholder="/srv" value={paths} onChange={(e) => setPaths(e.target.value)} />
      </Field>
    </>
  );
}

export function StepsResult({ r }: { r: InitResult }) {
  return (
    <>
      {r.error && <ErrorText>{r.error}</ErrorText>}
      <ol className="m-0 p-0 list-none flex flex-col rounded-lg border border-line divide-y divide-line">
        {r.steps.map((st) => (
          <li key={st.name} className="flex items-center gap-2 px-3.5 py-2 text-[13px]">
            <Icon name={st.status === "ok" ? "check" : st.status === "fail" ? "x" : "skip"} className={`size-4 flex-none ${st.status === "ok" ? "text-accent" : st.status === "fail" ? "text-bad" : "text-faint"}`} />
            <span className={st.status === "skip" ? "text-muted" : undefined}>{st.name}</span>
          </li>
        ))}
      </ol>
      {!r.ok && r.log.length > 0 && (
        <pre className="m-0 max-h-[220px] overflow-auto scroll-soft rounded-lg bg-surface-2 border border-line p-3 font-mono text-[12px] whitespace-pre-wrap break-all">{r.log.join("\n")}</pre>
      )}
    </>
  );
}

function Command({ cmd }: { cmd: string }) {
  const { toast } = useApp();
  return (
    <div className="relative">
      <pre className="m-0 rounded-lg bg-surface-2 border border-line pl-3.5 pr-11 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{cmd}</pre>
      <Button size="sm" variant="ghost" icon="copy" iconOnly aria-label="설치 명령 복사" className="absolute top-1.5 right-1.5" onClick={() => copyText(cmd, toast)} />
    </div>
  );
}

/** Shows an install command and waits until the server's agent shows up as connected. */
export function InstallCommand({ inventoryId, hostName, command, expiresIn, onDone }: { inventoryId: string; hostName: string; command: string; expiresIn: number; onDone?: () => void }) {
  const { refresh } = useApp();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (connected) return;
    const t = window.setInterval(async () => {
      try {
        const invs = await api.get<Inventory[]>("/inventory");
        const h = invs.find((i) => i.id === inventoryId)?.hosts.find((x) => x.name === hostName);
        if (h?.mode === "agent" && h.agent?.seen && Date.now() / 1000 - h.agent.seen < 120) {
          setConnected(true);
          refresh();
          onDone?.();
        }
      } catch {
        /* keep waiting */
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [connected, inventoryId, hostName, refresh, onDone]);
  return (
    <>
      <Field label="서버에서 실행할 명령" hint={`root 권한으로 한 번 실행해요. 명령에 든 토큰은 ${Math.round(expiresIn / 60)}분 동안 한 번만 쓸 수 있어요.`}>
        <Command cmd={command} />
      </Field>
      <Hint>Docker와 docker rollout이 없으면 설치하고, 실행 계정과 허용 경로를 만든 뒤 에이전트를 띄워요. 서버에서 Wharfline으로 나가는 연결만 있으면 돼요.</Hint>
      {connected ? (
        <Banner tone="info" icon="check" title="에이전트가 연결됐어요">
          이제 이 서버로 배포할 수 있어요.
        </Banner>
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className="size-2 rounded-full bg-warn animate-pulse" />
          서버에서 명령을 실행하면 여기에 연결됐다고 떠요…
        </div>
      )}
    </>
  );
}

/** A new install command for a server (first install, re-install, or after rebuilding the server). */
export function AgentTokenModal({ inventory: inv, ix, onClose }: { inventory: Inventory; ix: number; onClose: () => void }) {
  const { withSudo, toast } = useApp();
  const h = inv.hosts[ix];
  const [users, setUsers] = useState((h.agent?.policy.users ?? []).filter((u) => u !== inv.user).join(", "));
  const [paths, setPaths] = useState((h.agent?.policy.paths ?? ["/srv"]).join(", "));
  const [made, setMade] = useState<{ command: string; expiresIn: number } | null>(null);
  const make = (e: React.FormEvent) => {
    e.preventDefault();
    withSudo("에이전트 설치 명령", async () => {
      try {
        setMade(await api.post(`/inventory/${inv.id}/hosts/${ix}/agent-token`, { users: list(users), paths: list(paths) }));
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      }
    });
  };
  return (
    <>
      <ModalHead title="에이전트 설치 명령" sub={`${inv.name} · ${h.name}`} onClose={onClose} />
      {made ? (
        <>
          <ModalBody>
            <InstallCommand inventoryId={inv.id} hostName={h.name} command={made.command} expiresIn={made.expiresIn} />
            {h.mode === "agent" && <Hint>지금 에이전트가 있는 서버에서 실행하면 새로 등록하고, 이전 에이전트 정보는 버려요.</Hint>}
          </ModalBody>
          <ModalFoot>
            <Button variant="primary" onClick={onClose}>
              닫기
            </Button>
          </ModalFoot>
        </>
      ) : (
        <>
          <form id="agTok" onSubmit={make} className="contents">
            <ModalBody>
              <PolicyFields invUser={inv.user} users={users} setUsers={setUsers} paths={paths} setPaths={setPaths} />
            </ModalBody>
          </form>
          <ModalFoot>
            <Button onClick={onClose}>취소</Button>
            <Button variant="primary" type="submit" form="agTok">
              명령 만들기
            </Button>
          </ModalFoot>
        </>
      )}
    </>
  );
}

/** A server that still deploys over SSH: one last login with the inventory's key starts its agent. */
export function ConvertHostModal({ inventory: inv, ix, onClose }: { inventory: Inventory; ix: number; onClose: () => void }) {
  const { withSudo, toast, refresh, openModal } = useApp();
  const h = inv.hosts[ix];
  const [users, setUsers] = useState("");
  const [paths, setPaths] = useState("/srv");
  const [running, setRunning] = useState(false);
  const [r, setR] = useState<InitResult | null>(null);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    withSudo("에이전트로 전환", async () => {
      setRunning(true);
      try {
        const res = await api.post<InitResult>(`/inventory/${inv.id}/hosts/${ix}/convert`, { users: list(users), paths: list(paths) });
        setR(res);
        if (res.ok) refresh();
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      } finally {
        setRunning(false);
      }
    });
  };
  if (r)
    return (
      <>
        <ModalHead title={r.ok ? "에이전트로 바꿨어요" : "전환하지 못했어요"} sub={`${inv.name} · ${h.name}`} onClose={onClose} />
        <ModalBody>
          <StepsResult r={r} />
          {r.ok && inv.key && (
            <Hint>
              이 인벤토리의 서버가 모두 에이전트로 바뀌면 인벤토리 수정에서 SSH 키 <span className="font-mono">{inv.key}</span>를 빼고, 서버의 authorized_keys에서도 지워 주세요.
            </Hint>
          )}
        </ModalBody>
        <ModalFoot>
          {!r.ok && (
            <Button onClick={() => (onClose(), openModal((c) => <AgentTokenModal inventory={inv} ix={ix} onClose={c} />))}>설치 명령으로 하기</Button>
          )}
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </ModalFoot>
      </>
    );
  return (
    <>
      <ModalHead title="에이전트로 전환" sub={`${inv.name} · ${h.name} (${h.ip})`} onClose={onClose} />
      <form id="agConv" onSubmit={go} className="contents">
        <ModalBody>
          <Banner tone="neutral" icon="server" title="이 일을 해요">
            인벤토리의 SSH 키로 <span className="font-mono">{h.user}</span>@{h.ip}에 마지막으로 한 번 접속해서 에이전트 컨테이너를 띄워요. 그다음부터 이 서버는 키 없이 에이전트로 배포해요. 몇 분 걸릴 수 있어요.
          </Banner>
          <PolicyFields invUser={inv.user} users={users} setUsers={setUsers} paths={paths} setPaths={setPaths} />
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="agConv" disabled={running}>
          {running ? "바꾸는 중…" : "전환"}
        </Button>
      </ModalFoot>
    </>
  );
}

/** Where agents reach Wharfline. Browsers may use another address (a public domain vs a LAN address). */
export function AgentSettingsModal({ onClose }: { onClose: () => void }) {
  const { withSudo, toast } = useApp();
  const { data } = useApi<AgentSettings>("/agent-settings");
  const [url, setUrl] = useState<string | null>(null);
  const [hosts, setHosts] = useState<string | null>(null);
  const value = url ?? data?.saved ?? "";
  const hostsValue = hosts ?? data?.hosts ?? "";
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    withSudo("에이전트 설정", async () => {
      try {
        await api.put("/agent-settings", { url: value.trim(), hosts: hostsValue });
        toast("에이전트 설정을 저장했어요");
        onClose();
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      }
    });
  };
  return (
    <>
      <ModalHead title="에이전트 설정" onClose={onClose} />
      <form id="agSet" onSubmit={save} className="contents">
        <ModalBody>
          <Field
            label="에이전트 접속 주소"
            htmlFor="agUrl"
            hint={<>서버의 에이전트가 Wharfline에 접속할 주소예요. 비우면 {data?.url ? <span className="font-mono">{data.url}</span> : "Wharfline 주소"}를 써요. 이미 설치된 에이전트는 설치할 때의 주소를 계속 써요.</>}
          >
            <Input id="agUrl" mono spellCheck={false} placeholder={data?.url || "https://deploy.example.com"} value={value} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field
            label="내부 주소"
            htmlFor="agHosts"
            hint={
              <>
                서버에서 공인 주소로는 닿지 않는 도메인(같은 사설망의 Wharfline, 레지스트리)을 사설 IP로 적어요. /etc/hosts 형식으로 한 줄에 <span className="font-mono">IP 도메인 …</span>.
                설치·초기화할 때 서버의 /etc/hosts에 넣고, Wharfline 주소가 있으면 설치 명령의 curl도 그 IP로 바로 접속해요. 이미 설치된 서버는 설치 명령을 다시 실행하면 바뀐 내용이 들어가요.
              </>
            }
          >
            <Textarea
              id="agHosts"
              rows={4}
              spellCheck={false}
              placeholder={"10.0.1.6 deploy.example.com git.example.com"}
              value={hostsValue}
              onChange={(e) => setHosts(e.target.value)}
            />
          </Field>
          {data && <KV items={[["에이전트 이미지", <span className="font-mono break-all">{data.image}</span>, "!whitespace-normal"]]} labelWidth={96} />}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="agSet">
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-[13px] py-1">
      <span className="text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Inside 서버 수정: what the agent reports, password-less sudo per account, the agent version. */
export function AgentPanel({ inventory: inv, ix }: { inventory: Inventory; ix: number }) {
  const { withSudo, toast, refresh, openModal } = useApp();
  const h = inv.hosts[ix];
  const a = h.agent;
  const [sudo, setSudo] = useState<Record<string, boolean>>(a?.sudo ?? {});
  const [updating, setUpdating] = useState(false);
  if (!a) return null;
  const users = a.policy.users ?? [];
  const toggle = (user: string, enable: boolean) =>
    withSudo(enable ? "sudo 권한 부여" : "sudo 권한 회수", async () => {
      try {
        const r = await api.put<Host>(`/inventory/${inv.id}/hosts/${ix}/sudo`, { user, enable });
        setSudo(r.agent?.sudo ?? {});
        refresh();
        toast(`${user}: 비밀번호 없는 sudo ${enable ? "켰어요" : "껐어요"}`);
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      }
    });
  const update = () =>
    withSudo("에이전트 업데이트", async () => {
      setUpdating(true);
      try {
        const r = await api.post<{ image: string }>(`/inventory/${inv.id}/hosts/${ix}/agent-update`);
        toast(`${r.image}(으)로 바꾸는 중이에요. 잠시 뒤 다시 연결돼요.`);
      } catch (err) {
        if ((err as { sudoRequired?: boolean }).sudoRequired) throw err;
        toast(errMsg(err), "error");
      } finally {
        setUpdating(false);
      }
    });
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[13px] font-semibold">에이전트</span>
        <AgentState h={h} />
      </div>
      <div className="flex flex-col">
        <Row label="버전">
          <span className="font-mono">{a.version ?? "-"}</span>
        </Row>
        <Row label="서버 이름">
          <span className="font-mono">{a.hostname ?? "-"}</span>
        </Row>
        <Row label="허용 경로">
          <span className="font-mono">{(a.policy.paths ?? []).join(", ") || "-"}</span>
        </Row>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted">실행 계정 · 비밀번호 없는 sudo (become: true 플레이북에 필요해요)</span>
        {users.map((u) => (
          <label key={u} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
            <span className="font-mono text-[13px]">{u}</span>
            <Switch checked={!!sudo[u]} onChange={(v) => toggle(u, v)} label={`${u} 비밀번호 없는 sudo`} />
          </label>
        ))}
        <Hint>계정과 허용 경로는 서버에서 정해요. 바꾸려면 '설치 명령'을 다시 받아 서버에서 실행해 주세요.</Hint>
      </div>
      {a.containers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-muted">떠 있는 컨테이너</span>
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line rounded-lg border border-line max-h-[180px] overflow-auto scroll-soft">
            {a.containers.map((c) => (
              <li key={c.name} className="px-3 py-1.5 text-[12.5px] flex flex-col min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="font-mono font-medium truncate">{c.name}</span>
                  {c.state !== "running" && <Chip tone="warn">{c.state}</Chip>}
                </span>
                <span className="font-mono text-muted truncate" title={c.digests.join("\n")}>
                  {c.image}
                  {c.digests[0] && <span className="text-faint"> · {c.digests[0].split("@")[1]?.slice(0, 19)}…</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={cx("flex gap-1.5 flex-wrap")}>
        <Button size="sm" icon="refresh" disabled={updating} onClick={update}>
          {updating ? "업데이트 중…" : "에이전트 업데이트"}
        </Button>
        <Button size="sm" icon="key" onClick={() => openModal((c) => <AgentTokenModal inventory={inv} ix={ix} onClose={c} />)}>
          설치 명령 다시 받기
        </Button>
      </div>
    </div>
  );
}

/** The server account a job runs as. Empty: the inventory's. Lists what every agent in the inventory allows. */
export function RunUserField({ value, onChange, inventory }: { value: string; onChange: (v: string) => void; inventory?: Inventory }) {
  const agents = (inventory?.hosts ?? []).filter((h) => h.mode === "agent" && h.agent?.policy.users?.length);
  const allowed = agents.length ? agents.map((h) => h.agent!.policy.users!).reduce((a, b) => a.filter((u) => b.includes(u))) : [];
  const wanted = value.trim() || inventory?.user || "";
  const refused = agents.filter((h) => wanted && !(h.agent!.policy.users ?? []).includes(wanted)).map((h) => h.name);
  return (
    <Field
      label="실행 계정"
      htmlFor="jRunUser"
      hint={
        <>
          서버에서 명령과 파일을 이 계정으로 실행해요. 비우면 인벤토리 계정 <span className="font-mono">{inventory?.user ?? "deploy"}</span>이에요.
          {allowed.length > 0 && (
            <>
              {" "}
              모든 서버가 허용하는 계정: <span className="font-mono">{allowed.join(", ")}</span>
            </>
          )}
        </>
      }
      error={refused.length > 0}
    >
      <Input id="jRunUser" mono spellCheck={false} placeholder={inventory?.user ?? "deploy"} value={value} onChange={(e) => onChange(e.target.value)} />
      {refused.length > 0 && (
        <span className="text-[12.5px] text-bad">
          {refused.join(", ")}의 에이전트가 <span className="font-mono">{wanted}</span>을(를) 허용하지 않아요. 그 서버의 설치 명령을 다시 받아 계정을 더해 주세요.
        </span>
      )}
    </Field>
  );
}
