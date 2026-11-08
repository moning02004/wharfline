import { useMemo, useRef, useState } from "react";
import { api, errMsg, parseEnv } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvHistory, EnvSet } from "../lib/types";
import { EnvSource, type EnvMode } from "../components/EnvSource";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Chip, ErrorText, Field, Hint, Input, Seg, Textarea, cx } from "../components/ui";

/* ---------- new .env ---------- */

export function NewEnvModal({ onClose }: { onClose: () => void }) {
  const { runAction } = useApp();
  const [name, setName] = useState("batch-jobs.production");
  const [mode, setMode] = useState<EnvMode>("paste");
  const [text, setText] = useState("NODE_ENV=production\nDATABASE_URL=postgres://user:pass@10.0.3.31:5432/app\nJWT_SECRET=change-me");
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/envs", { name, vars: parseEnv(text) });
      onClose();
      runAction(async () => {}, "저장했어요");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <>
      <ModalHead title=".env 추가" sub="값은 암호화되어 저장되고, 열람할 때마다 기록돼요." onClose={onClose} />
      <form id="envForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="eName">
            <Input id="eName" mono value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <EnvSource text={text} setText={setText} mode={mode} setMode={setMode} />
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="envForm">
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- edit (add / change / delete) ---------- */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function EditEnvModal({ env, values, onClose }: { env: EnvSet; values: [string, string][]; onClose: () => void }) {
  const { withSudo, toast, refresh } = useApp();
  const orig = useMemo(() => new Map(values), [values]);
  const [rows, setRows] = useState(values.map(([k, v]) => ({ k, v })));
  const [mode, setMode] = useState<"list" | "raw">("list");
  const [raw, setRaw] = useState("");
  const lastRow = useRef<HTMLInputElement>(null);

  const current: [string, string][] = mode === "list" ? rows.filter((r) => r.k.trim() || r.v).map((r) => [r.k.trim(), r.v]) : parseEnv(raw);
  const nm = new Map(current);
  const add = [...nm.keys()].filter((k) => !orig.has(k));
  const chg = [...nm.keys()].filter((k) => orig.has(k) && orig.get(k) !== nm.get(k));
  const del = [...orig.keys()].filter((k) => !nm.has(k));
  const n = add.length + chg.length + del.length;

  let err = "";
  const seen = new Set<string>();
  for (const [k] of current) {
    if (!KEY_RE.test(k)) {
      err = `"${k || "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요. 영문, 숫자, _만 쓰고 숫자로 시작하지 않게 해 주세요.`;
      break;
    }
    if (seen.has(k)) {
      err = `${k}이(가) 두 번 들어 있어요. 하나를 지워 주세요.`;
      break;
    }
    seen.add(k);
  }

  const switchMode = (m: "list" | "raw") => {
    if (m === mode) return;
    if (m === "raw") setRaw(rows.filter((r) => r.k || r.v).map((r) => `${r.k}=${r.v}`).join("\n"));
    else setRows(parseEnv(raw).map(([k, v]) => ({ k, v })));
    setMode(m);
  };

  const save = () =>
    withSudo("환경 변수 저장", async () => {
      const r = await api.put<EnvSet>(`/envs/${env.id}`, { vars: current });
      onClose();
      refresh();
      toast(`v${r.ver}으로 저장했어요`);
    });

  const rowState = (r: { k: string; v: string }) => {
    const k = r.k.trim();
    if (!k && !r.v) return "";
    if (!orig.has(k)) return "new";
    return orig.get(k) !== r.v ? "chg" : "";
  };

  return (
    <>
      <ModalHead title="환경 변수 수정" sub={`${env.name} · 현재 v${env.ver}`} onClose={onClose} />
      <ModalBody>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Seg
            options={[
              { value: "list", label: "목록" },
              { value: "raw", label: ".env 텍스트" },
            ]}
            value={mode}
            onChange={switchMode}
          />
          <span className="text-faint text-xs">{env.usedBy.length ? "사용 중인 작업: " + env.usedBy.join(", ") : "사용하는 작업 없음"}</span>
        </div>
        {mode === "list" ? (
          <div className="flex flex-col gap-1.5">
            {rows.map((r, i) => {
              const st = rowState(r);
              return (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-1.5 items-center pl-3 relative animate-fade">
                  <span
                    className={cx(
                      "absolute left-0 top-2 bottom-2 w-[3px] rounded-full transition-colors",
                      st === "new" ? "bg-ok" : st === "chg" ? "bg-warn" : "bg-transparent",
                    )}
                  />
                  <Input
                    ref={i === rows.length - 1 ? lastRow : undefined}
                    mono
                    value={r.k}
                    placeholder="KEY"
                    aria-label="변수 이름"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                  />
                  <Input
                    mono
                    value={r.v}
                    placeholder="값"
                    aria-label={`${r.k} 값`}
                    autoComplete="off"
                    spellCheck={false}
                    className="max-sm:col-span-2 max-sm:row-start-2"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                  />
                  <Button variant="ghost" iconOnly icon="trash" aria-label={`${r.k} 삭제`} title="삭제" onClick={() => setRows(rows.filter((_, j) => j !== i))} />
                </div>
              );
            })}
            <Button
              size="sm"
              icon="plus"
              className="self-start mt-2"
              onClick={() => {
                setRows([...rows, { k: "", v: "" }]);
                setTimeout(() => lastRow.current?.focus(), 0);
              }}
            >
              변수 추가
            </Button>
          </div>
        ) : (
          <Textarea rows={12} spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
        )}
        <ErrorText>{err}</ErrorText>
        <div className="flex items-center gap-3.5 flex-wrap text-faint text-xs">
          <span className="inline-flex items-center gap-1.5">
            <i className="w-[3px] h-3 rounded-full bg-ok" />
            새로 추가
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="w-[3px] h-3 rounded-full bg-warn" />값 바뀜
          </span>
          <span>값은 활동 기록에 남지 않고, 바뀐 변수 이름만 남아요.</span>
        </div>
      </ModalBody>
      <ModalFoot between>
        <span className="text-muted text-[12.5px]">
          {n ? `추가 ${add.length} · 수정 ${chg.length} · 삭제 ${del.length}${env.usedBy.length ? " · 다음 배포부터 적용" : ""}` : "바뀐 내용 없음"}
        </span>
        <span className="flex gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={!!err || !n} onClick={save}>
            {n ? `저장 · v${env.ver + 1}` : "저장"}
          </Button>
        </span>
      </ModalFoot>
    </>
  );
}

/* ---------- version history & restore ---------- */

export function EnvHistoryModal({ env, onClose }: { env: EnvSet; onClose: () => void }) {
  const { withSudo, toast, refresh } = useApp();
  const { data } = useApi<EnvHistory>(`/envs/${env.id}/history`);
  const [openDiff, setOpenDiff] = useState<Record<number, boolean>>({});
  const [armed, setArmed] = useState<number | null>(null);

  const restore = (ver: number) => {
    if (armed !== ver) {
      setArmed(ver);
      setTimeout(() => setArmed((a) => (a === ver ? null : a)), 4000);
      return;
    }
    withSudo("환경 변수 되돌리기", async () => {
      const r = await api.post<EnvSet>(`/envs/${env.id}/restore`, { ver });
      onClose();
      refresh();
      toast(`v${ver} 내용으로 되돌렸어요. 지금은 v${r.ver}이에요.`);
    });
  };

  return (
    <>
      <ModalHead title="버전 기록" sub={env.name} onClose={onClose} />
      <ModalBody>
        <div className="rounded-lg border border-line overflow-hidden">
          {data?.items.map((it) => {
            const d = it.diff;
            const changes = d ? d.add.length + d.chg.length + d.del.length : 0;
            return (
              <div key={it.ver} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <span className="font-mono font-semibold text-[12.5px] min-w-[34px]">v{it.ver}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{it.current ? "지금 버전" : it.updated.split(" · ")[0]}</div>
                    <div className="text-[12.5px] text-muted truncate">
                      {it.updated} · 변수 {it.count}개
                    </div>
                  </div>
                  <span className="text-muted text-[12.5px]">{d ? `추가 ${d.add.length} · 수정 ${d.chg.length} · 삭제 ${d.del.length}` : "처음 버전"}</span>
                  {changes > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setOpenDiff({ ...openDiff, [it.ver]: !openDiff[it.ver] })}>
                      {openDiff[it.ver] ? "접기" : "변경 보기"}
                    </Button>
                  )}
                  {it.current ? (
                    <Chip tone="ok">사용 중</Chip>
                  ) : (
                    <Button size="sm" variant={armed === it.ver ? "danger" : "default"} icon={armed === it.ver ? undefined : "undo"} onClick={() => restore(it.ver)}>
                      {armed === it.ver ? "한 번 더 눌러 확인" : "되돌리기"}
                    </Button>
                  )}
                </div>
                {d && openDiff[it.ver] && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3.5 pl-[62px] animate-fade">
                    {d.add.map((k) => (
                      <Chip key={k} tone="ok" mono>
                        + {k}
                      </Chip>
                    ))}
                    {d.chg.map((k) => (
                      <Chip key={k} tone="warn" mono>
                        ~ {k}
                      </Chip>
                    ))}
                    {d.del.map((k) => (
                      <Chip key={k} tone="bad" mono>
                        − {k}
                      </Chip>
                    ))}
                    <span className="text-faint text-xs w-full">
                      v{it.prevVer} → v{it.ver}에서 바뀐 변수예요. 값은 보여주지 않아요.
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Hint>
          되돌리면 그 버전의 내용으로 새 버전(v{env.ver + 1})이 만들어져요. 지금 버전도 기록에 그대로 남아서 다시 되돌릴 수 있어요.
        </Hint>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- open a set by name (from deploy screens) ---------- */

/**
 * An env set's name that opens it: after the password re-check, its values show in the editor to read or change.
 * Members who can't see values (not Owner/Admin) just get a short note.
 */
export function EnvLink({ name }: { name: string }) {
  const { withSudo, openModal, toast, can } = useApp();
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!can("env")) return toast("환경 변수 값은 Owner와 Admin만 볼 수 있어요");
    withSudo("환경 변수 보기·수정", async () => {
      const sets = await api.get<EnvSet[]>("/envs");
      const env = sets.find((x) => x.name === name);
      if (!env) return toast(`${name} 세트를 찾지 못했어요`, "error");
      const r = await api.get<{ vars: [string, string][] }>(`/envs/${env.id}/values?purpose=edit`);
      openModal((c) => <EditEnvModal env={env} values={r.vars} onClose={c} />, "md");
    }, { always: true });
  };
  return (
    <button type="button" onClick={open} className="link font-mono text-[12.5px]" title="비밀번호를 확인하고 값을 보거나 고쳐요">
      {name}
    </button>
  );
}
