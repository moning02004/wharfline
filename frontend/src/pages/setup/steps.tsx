import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, errMsg, parseEnv } from "../../lib/api";
import { useApi, useApp } from "../../lib/app";
import type { EnvSet, Image, Inventory, Job, Key, Registry, Repo } from "../../lib/types";
import { EnvSource, type EnvMode } from "../../components/EnvSource";
import { GroupSelect } from "../../components/GroupSelect";
import { Icon } from "../../components/Icon";
import { Banner, Button, Check, Chip, ErrorText, Field, Hint, Input, Select, Seg, Textarea, cx } from "../../components/ui";
import { Code } from "./Manual";
import { COMPOSE_TPL, imageShort, STEPS, type HostDraft, type WizardState } from "./model";

export interface StepProps {
  w: WizardState;
  done: (patch: Partial<WizardState>) => void;
  back?: () => void;
  skip?: () => void;
  goTo: (i: number) => void;
}

/* ---------- shared ---------- */

/** Runs an API action, showing errors inline. Sensitive actions go through the password re-check. */
function useAction() {
  const { withSudo } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const wrap = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.sudoRequired) throw e; // withSudo asks for the password, then retries
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    err,
    setErr,
    run: (fn: () => Promise<void>) => wrap(fn)(),
    sudo: (reason: string, fn: () => Promise<void>) => withSudo(reason, wrap(fn)),
  };
}

function Footer({ back, skip, skipOf, primary, busy, disabled, hint }: {
  back?: () => void;
  skip?: () => void;
  skipOf?: string;
  primary: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap pt-5 mt-1 border-t border-line">
      {back && (
        <Button variant="ghost" onClick={back}>
          ← 뒤로
        </Button>
      )}
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
      <span className="flex-1" />
      {skip && (
        <Button icon="skip" onClick={skip}>
          {STEPS.find((st) => st.id === skipOf)?.skip ?? "건너뛰기"}
        </Button>
      )}
      <Button variant="primary" type="submit" disabled={busy || disabled}>
        {busy ? "처리 중…" : primary}
      </Button>
    </div>
  );
}

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

function Picked({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-[18px] bg-ok-soft text-[13px] animate-rise">
      <span className="grid place-items-center size-7 rounded-full bg-ok text-white flex-none">
        <Icon name="check" className="size-3.5" strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

/* ---------- 1. SSH key ---------- */

export function KeyStep({ w, done, back }: StepProps) {
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [mode, setMode] = useState<"gen" | "paste" | "existing">(w.key ? "existing" : "gen");
  const [name, setName] = useState("deploy-key");
  const [priv, setPriv] = useState("");
  const [pass, setPass] = useState("");
  const [pick, setPick] = useState(w.key?.name ?? "");
  const [created, setCreated] = useState<{ name: string; publicKey?: string } | null>(null);
  const a = useAction();

  useEffect(() => {
    if (!pick && keys[0]) setPick(keys[0].name);
  }, [keys, pick]);

  const submit = () => {
    if (created) return done({ key: created });
    if (mode === "existing") {
      const k = keys.find((x) => x.name === pick);
      if (!k) return a.setErr("키를 골라 주세요.");
      return a.run(async () => {
        const r = await api.get<{ publicKey: string }>(`/keys/${k.id}/public`).catch(() => ({ publicKey: undefined }));
        done({ key: { name: k.name, publicKey: r.publicKey } });
      });
    }
    a.sudo("SSH 키 등록", async () => {
      const k = await api.post<Key>("/keys", { mode, name, privateKey: priv, passphrase: pass });
      setCreated({ name: k.name, publicKey: k.publicKey });
    });
  };

  if (created)
    return (
      <Form onSubmit={submit}>
        <Picked>
          <b className="block">{created.name} 키를 만들었어요</b>
          <span className="text-muted">아래 공개 키를 배포할 서버의 deploy 사용자에게 넣어 주세요. 오른쪽 매뉴얼 2번에 명령어가 있어요.</span>
        </Picked>
        <Field label="공개 키">
          <Code wrap>{created.publicKey ?? ""}</Code>
        </Field>
        <Footer primary="서버에 넣었어요, 다음" hint="지금 넣지 않아도 돼요. 첫 배포 전에만 넣으면 돼요." />
      </Form>
    );

  return (
    <Form onSubmit={submit}>
      <Field label="어떻게 준비할까요?">
        <div>
          <Seg
            options={[
              { value: "gen", label: "새로 만들기 (추천)" },
              { value: "paste", label: "가져오기" },
              ...(keys.length ? [{ value: "existing" as const, label: `등록된 키 (${keys.length})` }] : []),
            ]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              a.setErr("");
            }}
          />
        </div>
      </Field>
      {mode !== "existing" ? (
        <Field label="이름" htmlFor="wkName" hint="키 저장소에 이 이름으로 보여요.">
          <Input id="wkName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      ) : (
        <Field label="쓸 키" htmlFor="wkPick">
          <Select id="wkPick" value={pick} onChange={(e) => setPick(e.target.value)}>
            {keys.map((k) => (
              <option key={k.id} value={k.name}>
                {k.name} · {k.type} · {k.fingerprint.slice(0, 22)}…
              </option>
            ))}
          </Select>
        </Field>
      )}
      {mode === "gen" && <Hint>ED25519 키 쌍을 만들어요. 비공개 키는 암호화되어 저장되고 화면에 나오지 않아요.</Hint>}
      {mode === "paste" && (
        <div className="flex flex-col gap-4 animate-fade">
          <Field label="비공개 키" htmlFor="wkPriv">
            <Textarea id="wkPriv" rows={6} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"} value={priv} onChange={(e) => setPriv(e.target.value)} />
          </Field>
          <Field label="키 암호 (걸려 있다면)" htmlFor="wkPass">
            <Input id="wkPass" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
        </div>
      )}
      <ErrorText>{a.err}</ErrorText>
      <Footer back={back} primary={mode === "existing" ? "이 키로 다음" : "등록하기"} busy={a.busy} />
    </Form>
  );
}

/* ---------- 2. inventory ---------- */

const emptyHost = (i: number): HostDraft => ({ name: `web-0${i + 1}`, ip: "", port: "22", user: "deploy", group: "web" });

export function InventoryStep({ w, done, back }: StepProps) {
  const inventories = useApi<Inventory[]>("/inventory").data ?? [];
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === "ssh");
  const [mode, setMode] = useState<"new" | "existing">(w.inventory ? "existing" : "new");
  const [name, setName] = useState("production");
  const [key, setKey] = useState(w.key?.name ?? "");
  const [hosts, setHosts] = useState<HostDraft[]>([emptyHost(0)]);
  const [prints, setPrints] = useState<{ fp: string; ok: boolean }[] | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; added: string[] } | null>(null);
  const [pick, setPick] = useState(w.inventory?.id ?? "");
  const a = useAction();

  useEffect(() => {
    if (!pick && inventories[0]) setPick(inventories[0].id);
  }, [inventories, pick]);
  useEffect(() => {
    if (!key && keys[0]) setKey(keys[0].name);
  }, [keys, key]);
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    // Suggest a name that is not taken yet.
    if (nameTouched || !inventories.length) return;
    const taken = new Set(inventories.map((i) => i.name));
    const free = ["production", "staging", "demo"].find((n) => !taken.has(n)) ?? `env-${inventories.length + 1}`;
    if (free !== name) setName(free);
  }, [inventories, nameTouched, name]);

  const setHost = (i: number, f: keyof HostDraft, v: string) => {
    setHosts(hosts.map((h, j) => (j === i ? { ...h, [f]: v } : h)));
    setPrints(null); // host changed: fingerprints must be checked again
  };
  const picked = inventories.find((i) => i.id === pick);

  const submit = () => {
    if (mode === "existing") {
      if (!picked) return a.setErr("인벤토리를 골라 주세요.");
      if (!picked.hosts.length) return a.setErr("서버가 없는 인벤토리예요. 새로 만들거나 인벤토리 메뉴에서 서버를 추가해 주세요.");
      return done({ inventory: { id: picked.id, name: picked.name, added: [] } });
    }
    if (hosts.some((h) => !h.ip.trim())) return a.setErr("모든 서버의 IP 또는 호스트를 넣어 주세요.");
    if (!prints)
      return a.run(async () => {
        const fps = await Promise.all(hosts.map((h) => api.post<{ fingerprint: string }>("/inventory/fingerprint", { ip: h.ip, port: +h.port || 22 })));
        setPrints(fps.map((f) => ({ fp: f.fingerprint, ok: false })));
      });
    if (prints.some((p) => !p.ok)) return a.setErr("모든 서버의 지문을 확인하고 체크해 주세요.");
    a.run(async () => {
      let inv = created;
      if (!inv) {
        const r = await api.post<Inventory>("/inventory", { name, key });
        inv = { id: r.id, name: r.name, added: [] };
        setCreated(inv);
      }
      for (const h of hosts) {
        if (inv.added.includes(h.name)) continue; // already saved on an earlier attempt
        await api.post(`/inventory/${inv.id}/hosts`, h);
        inv = { ...inv, added: [...inv.added, h.name] };
        setCreated(inv);
      }
      done({ inventory: inv });
    });
  };

  return (
    <Form onSubmit={submit}>
      <Field label="어떤 인벤토리에 넣을까요?">
        <div>
          <Seg
            options={[
              { value: "new", label: "새 인벤토리" },
              ...(inventories.length ? [{ value: "existing" as const, label: `기존 인벤토리 (${inventories.length})` }] : []),
            ]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              a.setErr("");
            }}
          />
        </div>
      </Field>

      {mode === "existing" ? (
        <>
          <Field label="인벤토리" htmlFor="wiPick">
            <Select id="wiPick" value={pick} onChange={(e) => setPick(e.target.value)}>
              {inventories.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} · 서버 {i.hosts.length}대 · 키 {i.key}
                </option>
              ))}
            </Select>
          </Field>
          {picked && (
            <div className="flex flex-wrap gap-1.5">
              {picked.hosts.map((h) => (
                <Chip key={h.name} tone="accent" mono>
                  {h.group} · {h.name} · {h.ip}
                </Chip>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="인벤토리 이름" htmlFor="wiName" hint="환경 이름이 좋아요: production, staging">
              <Input
                id="wiName"
                mono
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                disabled={!!created}
              />
            </Field>
            <Field label="접속에 쓸 SSH 키" htmlFor="wiKey">
              <Select id="wiKey" value={key} onChange={(e) => setKey(e.target.value)} disabled={!!created}>
                {keys.map((k) => (
                  <option key={k.id} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="서버">
            <div className="flex flex-col gap-2">
              {hosts.map((h, i) => {
                const saved = created?.added.includes(h.name);
                return (
                  <div key={i} className={cx("rounded-[18px] p-3 shadow-[inset_0_0_0_1px_var(--border)] flex flex-col gap-2 animate-fade", saved && "bg-ok-soft")}>
                    <div className="grid grid-cols-2 sm:grid-cols-[1fr_1.6fr_84px] gap-2 items-end">
                      <Field label={<span className="text-[11.5px] text-muted">이름</span>}>
                        <Input value={h.name} onChange={(e) => setHost(i, "name", e.target.value)} disabled={saved} />
                      </Field>
                      <Field label={<span className="text-[11.5px] text-muted">IP 또는 호스트</span>}>
                        <Input mono value={h.ip} placeholder="10.0.1.15" onChange={(e) => setHost(i, "ip", e.target.value)} disabled={saved} autoFocus={i === 0} />
                      </Field>
                      <Field label={<span className="text-[11.5px] text-muted">포트</span>}>
                        <Input mono value={h.port} inputMode="numeric" onChange={(e) => setHost(i, "port", e.target.value)} disabled={saved} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                      <Field label={<span className="text-[11.5px] text-muted">SSH 사용자</span>}>
                        <Input mono value={h.user} onChange={(e) => setHost(i, "user", e.target.value)} disabled={saved} />
                      </Field>
                      <Field label={<span className="text-[11.5px] text-muted">그룹</span>}>
                        <Input mono value={h.group} onChange={(e) => setHost(i, "group", e.target.value)} disabled={saved} list="wiGroups" />
                      </Field>
                      <Button
                        variant="ghost"
                        iconOnly
                        icon="trash"
                        aria-label={`${h.name} 빼기`}
                        disabled={hosts.length === 1 || saved}
                        onClick={() => {
                          setHosts(hosts.filter((_, j) => j !== i));
                          setPrints(null);
                        }}
                      />
                    </div>
                    {prints?.[i] && (
                      <label className="flex items-center gap-2.5 text-[12.5px] px-1 cursor-pointer animate-fade">
                        <input
                          type="checkbox"
                          className="accent-(--accent) size-4"
                          checked={prints[i].ok || !!saved}
                          disabled={saved}
                          onChange={(e) => setPrints(prints.map((p, j) => (j === i ? { ...p, ok: e.target.checked } : p)))}
                        />
                        <span className="text-muted">
                          서버가 보낸 지문 <span className="font-mono text-fg break-all">{prints[i].fp}</span> 이 서버에서 확인한 값과 같아요
                        </span>
                      </label>
                    )}
                  </div>
                );
              })}
              <datalist id="wiGroups">
                {["web", "worker", "batch", "db"].map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              <Button
                size="sm"
                icon="plus"
                className="self-start"
                onClick={() => {
                  setHosts([...hosts, emptyHost(hosts.length)]);
                  setPrints(null);
                }}
              >
                서버 추가
              </Button>
            </div>
          </Field>
          {prints && <Banner icon="shield" title="지문을 확인해 주세요">대상 서버에서 <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>을 실행한 결과와 같으면 체크하세요. 저장된 지문이 나중에 바뀌면 배포가 자동으로 멈춰요.</Banner>}
        </>
      )}
      <ErrorText>{a.err}</ErrorText>
      <Footer
        back={back}
        busy={a.busy}
        primary={mode === "existing" ? "이 인벤토리로 다음" : prints ? "등록하고 다음" : "연결 확인"}
        hint={mode === "new" && !prints ? "연결 확인을 누르면 서버의 호스트 키 지문을 받아와요." : undefined}
      />
    </Form>
  );
}

/* ---------- 3. registry ---------- */

const PRESETS = [
  { id: "ghcr", label: "GitHub (ghcr.io)", host: "ghcr.io" },
  { id: "gitea", label: "Gitea", host: "" },
  { id: "hub", label: "Docker Hub", host: "docker.io" },
] as const;

export function RegistryStep({ w, done, back, skip }: StepProps) {
  const registries = useApi<{ registries: Registry[] }>("/registries").data?.registries ?? [];
  const [mode, setMode] = useState<"new" | "existing">(w.registry ? "existing" : "new");
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("ghcr");
  const [host, setHost] = useState("ghcr.io");
  const [ns, setNs] = useState("");
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [pick, setPick] = useState(w.registry?.id ?? "");
  const a = useAction();

  useEffect(() => {
    if (!pick && registries[0]) setPick(registries[0].id);
  }, [registries, pick]);

  const submit = () => {
    if (mode === "existing") {
      const r = registries.find((x) => x.id === pick);
      if (!r) return a.setErr("레지스트리를 골라 주세요.");
      return done({ registry: { id: r.id, host: r.host, namespace: r.namespace } });
    }
    if (!token.trim()) return a.setErr("토큰을 넣어 주세요. 공개 이미지라면 '건너뛰기'를 누르세요.");
    a.sudo("레지스트리 토큰 저장", async () => {
      const r = await api.post<Registry>("/registries", { host, namespace: ns, user, token });
      done({ registry: { id: r.id, host: r.host, namespace: r.namespace } });
    });
  };

  return (
    <Form onSubmit={submit}>
      <Field label="이미지가 어디에 있나요?">
        <div>
          <Seg
            options={[{ value: "new", label: "새로 등록" }, ...(registries.length ? [{ value: "existing" as const, label: `등록된 레지스트리 (${registries.length})` }] : [])]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              a.setErr("");
            }}
          />
        </div>
      </Field>
      {mode === "existing" ? (
        <Field label="레지스트리" htmlFor="wrPick">
          <Select id="wrPick" value={pick} onChange={(e) => setPick(e.target.value)}>
            {registries.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.host}/{r.namespace} · {r.auth}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setPreset(p.id);
                  setHost(p.host);
                }}
                className={cx(
                  "px-4 py-2 rounded-full text-[13px] font-medium transition-all duration-200",
                  preset === p.id ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--accent)]" : "bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-hover",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="주소" htmlFor="wrHost">
              <Input id="wrHost" mono value={host} placeholder="git.example.com" onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="조직 또는 사용자" htmlFor="wrNs" hint={`${host || "주소"}/${ns || "조직"}/이미지`}>
              <Input id="wrNs" mono value={ns} placeholder="acme" onChange={(e) => setNs(e.target.value)} />
            </Field>
            <Field label="사용자 이름" htmlFor="wrUser">
              <Input id="wrUser" mono value={user} placeholder="GitHub 또는 Gitea 아이디" onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field label="읽기 전용 토큰" htmlFor="wrTok" hint={preset === "ghcr" ? "read:packages 권한만" : preset === "gitea" ? "package: 읽기 권한만" : "읽기 전용 액세스 토큰"}>
              <Input id="wrTok" mono type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          </div>
        </>
      )}
      <ErrorText>{a.err}</ErrorText>
      <Footer back={back} skip={skip} skipOf="registry" busy={a.busy} primary={mode === "existing" ? "이 레지스트리로 다음" : "등록하고 다음"} />
    </Form>
  );
}

/* ---------- 4. image ---------- */

export function ImageStep({ w, done, back }: StepProps) {
  const images = useApi<{ images: Image[] }>("/registries").data?.images ?? [];
  const prefix = w.registry ? `${w.registry.host}/${w.registry.namespace ? w.registry.namespace + "/" : ""}` : "";
  const [mode, setMode] = useState<"new" | "existing">(w.image ? "existing" : "new");
  const [ref, setRef] = useState(prefix ? `${prefix}my-app` : "");
  const [tags, setTags] = useState("v1.0.0, latest");
  const [pick, setPick] = useState(w.image?.ref ?? "");
  const a = useAction();

  useEffect(() => {
    if (!pick && images[0]) setPick(images[0].ref);
  }, [images, pick]);

  const submit = () => {
    if (mode === "existing") {
      const i = images.find((x) => x.ref === pick);
      if (!i) return a.setErr("이미지를 골라 주세요.");
      return done({ image: { ref: i.ref, tags: i.tags.map((t) => t.name) } });
    }
    a.run(async () => {
      const i = await api.post<Image>("/images", { ref, registry: w.registry?.id ?? null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
      done({ image: { ref: i.ref, tags: i.tags.map((t) => t.name) } });
    });
  };

  return (
    <Form onSubmit={submit}>
      <Field label="무엇을 배포하나요?">
        <div>
          <Seg
            options={[{ value: "new", label: "새 이미지" }, ...(images.length ? [{ value: "existing" as const, label: `등록된 이미지 (${images.length})` }] : [])]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              a.setErr("");
            }}
          />
        </div>
      </Field>
      {mode === "existing" ? (
        <Field label="이미지" htmlFor="wmPick">
          <Select id="wmPick" mono value={pick} onChange={(e) => setPick(e.target.value)}>
            {images.map((i) => (
              <option key={i.ref} value={i.ref}>
                {i.ref} · 최신 {i.tags[0]?.name ?? "-"}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="이미지 주소" htmlFor="wmRef" hint={w.registry ? `${w.registry.host} 레지스트리의 토큰으로 받아와요.` : "공개 이미지로 받아와요."}>
            <Input id="wmRef" mono value={ref} placeholder="ghcr.io/acme/my-app" onChange={(e) => setRef(e.target.value)} autoFocus />
          </Field>
          <Field label="태그" htmlFor="wmTags" hint="쉼표로 여러 개. 맨 앞 태그가 최신으로 보여요. 실제 배포할 태그는 실행할 때 골라요.">
            <Input id="wmTags" mono value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </>
      )}
      <ErrorText>{a.err}</ErrorText>
      <Footer back={back} busy={a.busy} primary={mode === "existing" ? "이 이미지로 다음" : "등록하고 다음"} />
    </Form>
  );
}

/* ---------- 5. playbook repo ---------- */

export function RepoStep({ w, done, back, skip }: StepProps) {
  const repos = useApi<Repo[]>("/repos").data ?? [];
  const keys = useApi<Key[]>("/keys").data ?? [];
  const [mode, setMode] = useState<"new" | "existing">(w.repo ? "existing" : "new");
  const [url, setUrl] = useState("git@github.com:acme/ansible-playbooks.git");
  const [branch, setBranch] = useState("main");
  const [key, setKey] = useState(w.key?.name ?? "");
  const [tokUser, setTokUser] = useState("");
  const [tok, setTok] = useState("");
  const [pick, setPick] = useState(w.repo?.name ?? "");
  const a = useAction();
  const ssh = /^(git@|ssh:\/\/)/.test(url.trim());
  const options = keys.filter((k) => k.kind === (ssh ? "ssh" : "token"));

  useEffect(() => {
    if (!pick && repos[0]) setPick(repos[0].name);
  }, [repos, pick]);
  useEffect(() => {
    setKey(ssh ? (w.key?.name ?? options[0]?.name ?? "") : "");
  }, [ssh, keys.length]); // reset the picked key only when the URL scheme changes

  const submit = () => {
    if (mode === "existing") {
      const r = repos.find((x) => x.name === pick);
      if (!r) return a.setErr("레포를 골라 주세요.");
      return done({ repo: { name: r.name, books: r.books } });
    }
    const connect = async (keyName: string) => {
      const r = await api.post<Repo>("/repos", { kind: "git", url, branch, key: keyName });
      done({ repo: { name: r.name, books: r.books } });
    };
    if (!ssh && key === "__new__") {
      return a.sudo("레포 토큰 저장", async () => {
        const k = await api.post<Key>("/keys", { mode: "token", name: `repo-token-${Date.now().toString(36)}`, user: tokUser, token: tok });
        await connect(k.name);
      });
    }
    a.run(() => connect(key));
  };

  return (
    <Form onSubmit={submit}>
      <Banner icon="info" title="Ansible로 배포할 때만 필요해요">
        Docker Compose로 배포한다면 오른쪽 아래 <b>"레포 없이 Compose로 배포"</b>를 누르세요. 처음이라면 Compose를 권해요.
      </Banner>
      <Field label="플레이북 레포">
        <div>
          <Seg options={[{ value: "new", label: "새로 연결" }, ...(repos.length ? [{ value: "existing" as const, label: `연결된 레포 (${repos.length})` }] : [])]} value={mode} onChange={setMode} />
        </div>
      </Field>
      {mode === "existing" ? (
        <Field label="레포" htmlFor="wpPick">
          <Select id="wpPick" mono value={pick} onChange={(e) => setPick(e.target.value)}>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} · 플레이북 {r.books.length}개
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <div className="grid sm:grid-cols-[1fr_140px] gap-3">
            <Field label="저장소 URL" htmlFor="wpUrl" hint="SSH(git@…) 또는 HTTPS 주소">
              <Input id="wpUrl" mono value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="브랜치" htmlFor="wpBranch">
              <Input id="wpBranch" mono value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
          </div>
          <Field
            label={ssh ? "SSH 키 (배포 키로 등록한 것)" : "액세스 토큰"}
            htmlFor="wpKey"
            hint={ssh ? "레포 Settings → Deploy keys에 이 키의 공개 키를 넣어 주세요." : "공개 저장소면 '없음'으로 두세요."}
          >
            <Select id="wpKey" value={key} onChange={(e) => setKey(e.target.value)}>
              {!ssh && <option value="">없음 · 공개 저장소</option>}
              {options.map((k) => (
                <option key={k.id} value={k.name}>
                  {k.name}
                </option>
              ))}
              {!ssh && <option value="__new__">+ 새 토큰 입력</option>}
            </Select>
          </Field>
          {!ssh && key === "__new__" && (
            <div className="grid sm:grid-cols-2 gap-3 animate-fade">
              <Field label="사용자 이름" htmlFor="wpTu">
                <Input id="wpTu" mono value={tokUser} onChange={(e) => setTokUser(e.target.value)} />
              </Field>
              <Field label="토큰 (Contents: Read-only)" htmlFor="wpTok">
                <Input id="wpTok" mono type="password" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} />
              </Field>
            </div>
          )}
        </>
      )}
      <ErrorText>{a.err}</ErrorText>
      <Footer back={back} skip={skip} skipOf="repo" busy={a.busy} primary={mode === "existing" ? "이 레포로 다음" : "연결하고 다음"} />
    </Form>
  );
}

/* ---------- 6. deploy settings ---------- */

const RISKY: [RegExp, string][] = [
  [/privileged:\s*true/, "privileged: true"],
  [/network_mode:\s*["']?host/, "network_mode: host"],
  [/docker\.sock/, "docker.sock 마운트"],
  [/^\s*build:/m, "build:"],
  [/pid:\s*["']?host/, "pid: host"],
  [/cap_add:/, "cap_add"],
];

export function DeployStep({ w, done, back }: StepProps) {
  const inventories = useApi<Inventory[]>("/inventory").data;
  const inv = inventories?.find((i) => i.id === w.inventory?.id);
  const groups = useMemo(() => {
    const m: Record<string, Inventory["hosts"]> = {};
    inv?.hosts.forEach((h) => (m[h.group] ??= []).push(h));
    return m;
  }, [inv]);
  const short = imageShort(w.image?.ref);
  const d = w.deploy;
  const [name, setName] = useState(d?.name ?? `${short} · ${w.inventory?.name ?? "production"}`);
  const [defaultTag, setDefaultTag] = useState(d?.defaultTag ?? "latest");
  const [targets, setTargets] = useState<string[]>(d?.targets ?? []);
  const [dir, setDir] = useState(d?.dir ?? `/srv/${short}`);
  const [compose, setCompose] = useState(d?.compose ?? COMPOSE_TPL);
  const [book, setBook] = useState(d?.book ?? w.repo?.books[0] ?? "");
  const [hook, setHook] = useState(d?.hook ?? false);
  const [prot, setProt] = useState(d?.protected ?? true);
  const [lock, setLock] = useState(d?.lock ?? true);
  const [rb, setRb] = useState(d?.rollback ?? true);
  const [err, setErr] = useState("");
  const ansible = !!w.repo;
  const hosts = inv?.hosts.filter((h) => !targets.length || targets.includes(h.group)) ?? [];

  const submit = () => {
    if (!name.trim()) return setErr("작업 이름을 넣어 주세요.");
    if (!ansible) {
      const bad = RISKY.filter(([re]) => re.test(compose)).map((r) => r[1]);
      if (bad.length) return setErr(`compose.yml에 서버 권한을 넘기는 설정이 있어요: ${bad.join(", ")}`);
      if (!/^(\/srv\/|~\/|\/home\/deploy\/)/.test(dir) || dir.includes("..")) return setErr("배포 경로는 /srv/ 또는 deploy 사용자의 홈 아래여야 해요.");
    }
    done({ deploy: { name: name.trim(), defaultTag, targets, dir, compose, book, hook, protected: prot, lock, rollback: rb } });
  };

  return (
    <Form onSubmit={submit}>
      <div className="grid sm:grid-cols-[1fr_200px] gap-3">
        <Field label="배포 작업 이름" htmlFor="wdName">
          <Input id="wdName" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="기본 태그" htmlFor="wdTag" hint="실행할 때 바꿀 수 있어요">
          <Select id="wdTag" mono value={defaultTag} onChange={(e) => setDefaultTag(e.target.value)}>
            {["latest", ...(w.image?.tags ?? []).filter((t) => t !== "latest")].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={<>배포 대상 <span className="text-muted font-normal">· {w.inventory?.name}</span></>} hint={`${targets.length ? "" : "그룹을 고르지 않으면 전체 서버에 배포해요. "}서버 ${hosts.length}대: ${hosts.map((h) => h.ip).join(", ")}`}>
        <GroupSelect groups={groups} value={targets} onChange={setTargets} />
      </Field>
      <Field label={<>배포 방식 <Chip className="ml-1">{ansible ? "Ansible 플레이북" : "Docker Compose"}</Chip></>}>
        {ansible ? (
          <Select value={book} onChange={(e) => setBook(e.target.value)} mono>
            {w.repo!.books.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label={<span className="text-[12px] text-muted">서버의 배포 경로</span>} htmlFor="wdDir">
              <Input id="wdDir" mono value={dir} onChange={(e) => setDir(e.target.value)} />
            </Field>
            <Field label={<span className="text-[12px] text-muted">compose.yml</span>} htmlFor="wdCompose" hint={<>이미지 자리의 <span className="font-mono">{"${IMAGE}:${IMAGE_TAG}"}</span>는 그대로 두세요.</>}>
              <Textarea id="wdCompose" rows={10} spellCheck={false} value={compose} onChange={(e) => setCompose(e.target.value)} />
            </Field>
          </div>
        )}
      </Field>
      <Field label="안전장치">
        <div className="flex flex-col">
          <Check checked={prot} onChange={setProt} title="보호된 작업" desc="Deployer가 실행하면 Admin 승인 후 시작돼요." />
          <Check checked={lock} onChange={setLock} title="동시 실행 금지" desc="같은 서버에 다른 배포가 돌고 있으면 기다려요." />
          <Check checked={rb} onChange={setRb} title="실패하면 이전 태그로 롤백" />
          <Check checked={hook} onChange={setHook} title="새 태그가 올라오면 자동 배포" desc="레지스트리 webhook 서명을 검증하고 v로 시작하는 태그만 받아요." />
        </div>
      </Field>
      <ErrorText>{err}</ErrorText>
      <Footer back={back} primary="다음" disabled={!inv} />
    </Form>
  );
}

/* ---------- 7. env ---------- */

export function EnvStep({ w, done, back, skip }: StepProps) {
  const envs = useApi<EnvSet[]>("/envs").data ?? [];
  const [mode, setMode] = useState<EnvMode>(w.env?.mode ?? "paste");
  const [text, setText] = useState(w.env?.text ?? "");
  const [picked, setPicked] = useState(w.env?.picked ?? "");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!picked && envs[0]) setPicked(envs[0].name);
  }, [envs, picked]);

  const submit = () => {
    if (mode !== "existing" && !parseEnv(text).length) return setErr("인식된 변수가 없어요. 필요 없다면 '.env 없이 진행'을 누르세요.");
    done({ env: { mode: mode === "upload" ? "paste" : mode, text, picked } });
  };

  return (
    <Form onSubmit={submit}>
      <EnvSource text={text} setText={setText} mode={mode} setMode={setMode} existing={envs.map((e) => e.name)} picked={picked} setPicked={setPicked} />
      <Hint>값은 완료할 때 봉투 암호화로 저장돼요. 지금은 이 브라우저 탭에만 임시로 들고 있어요.</Hint>
      <ErrorText>{err}</ErrorText>
      <Footer back={back} skip={skip} skipOf="env" primary="저장하고 다음" />
    </Form>
  );
}

/* ---------- 8. review ---------- */

export function ReviewStep({ w, done, back, goTo }: StepProps) {
  const a = useAction();
  const d = w.deploy!;
  const rows: [string, ReactNode, number][] = [
    ["SSH 키", w.key?.name, 0],
    ["서버", `${w.inventory?.name}${d.targets.length ? ` · ${d.targets.join(", ")}` : " · 전체"}`, 1],
    ["레지스트리", w.registry ? `${w.registry.host}/${w.registry.namespace}` : <span className="text-faint">건너뜀 · 공개 이미지</span>, 2],
    ["이미지", <span className="font-mono">{w.image?.ref}:{d.defaultTag}</span>, 3],
    ["배포 방식", w.repo ? `Ansible · ${w.repo.name} / ${d.book}` : `Docker Compose · ${d.dir}`, w.repo ? 4 : 5],
    ["환경 변수", w.env ? (w.env.mode === "existing" ? w.env.picked : `새로 저장 · 변수 ${parseEnv(w.env.text).length}개`) : <span className="text-faint">건너뜀 · 없음</span>, 6],
    ["안전장치", [d.protected && "보호됨", d.lock && "동시 실행 금지", d.rollback && "실패 시 롤백", d.hook && "자동 배포"].filter(Boolean).join(" · ") || "없음", 5],
  ];

  const finish = () =>
    a.run(async () => {
      const job = await api.post<Job>("/jobs", {
        name: d.name,
        image: w.image!.ref,
        defaultTag: d.defaultTag,
        method: w.repo ? "ansible" : "compose",
        inventory: w.inventory!.name,
        targets: d.targets,
        dir: d.dir,
        compose: d.compose,
        repo: w.repo?.name,
        book: d.book,
        envMode: !w.env ? "none" : w.env.mode === "existing" ? "existing" : "paste",
        envName: w.env?.picked,
        envVars: w.env && w.env.mode !== "existing" ? parseEnv(w.env.text) : [],
        hook: d.hook,
        protected: d.protected,
        lock: d.lock,
        rollback: d.rollback,
      });
      done({ job });
    });

  return (
    <Form onSubmit={finish}>
      <div className="rounded-[18px] shadow-[inset_0_0_0_1px_var(--border)] overflow-hidden">
        <div className="px-4 py-3 bg-surface-2 border-b border-line font-semibold">{d.name}</div>
        {rows.map(([label, value, step]) => (
          <div key={label} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13px]">
            <span className="w-[84px] text-faint flex-none">{label}</span>
            <span className="flex-1 min-w-0 truncate">{value}</span>
            <Button size="sm" variant="ghost" onClick={() => goTo(step)}>
              수정
            </Button>
          </div>
        ))}
      </div>
      <ErrorText>{a.err}</ErrorText>
      <Footer back={back} busy={a.busy} primary="완료하고 배포 작업 만들기" />
    </Form>
  );
}
