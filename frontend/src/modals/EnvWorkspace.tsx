import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvHistory, EnvSet, EnvValues } from "../lib/types";
import { ModalFoot, ModalHead } from "../components/Modal";
import { Button, Chip, Input, cx } from "../components/ui";
import { CodeArea, byteSize, fmtSize } from "./FileWorkspace";
import { diffLines } from "./FileHistoryModal";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TEXT = 512 * 1024; // the server's limit (store.ENV_MAX_TEXT)
const MAX_UPLOAD = 64 * 1024;

/** (KEY, value) of one line, like parseEnv: comments, blank lines and lines without "=" are not variables. */
function envLine(raw: string): [string, string] | null {
  const l = raw.trim();
  if (!l || l.startsWith("#") || !l.includes("=")) return null;
  const i = l.indexOf("=");
  return [l.slice(0, i).replace(/^export\s+/, "").trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
}

/** Variables with the line they are on. */
function envVars(text: string): { k: string; v: string; line: number }[] {
  const out: { k: string; v: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const kv = envLine(raw);
    if (kv) out.push({ k: kv[0], v: kv[1], line: i });
  });
  return out;
}

/** What is wrong with the text, for the screen; "" when it can be saved. */
function envError(vars: { k: string }[], text: string): string {
  if (byteSize(text) > MAX_TEXT) return ".env는 512KB까지예요.";
  const seen = new Set<string>();
  for (const { k } of vars) {
    if (!KEY_RE.test(k)) return `"${k || "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요. 영문, 숫자, _만 쓰고 숫자로 시작하지 않게 해 주세요.`;
    if (seen.has(k)) return `${k}이(가) 두 번 들어 있어요. 하나를 지워 주세요.`;
    seen.add(k);
  }
  return "";
}

type Props = {
  /** The saved set this text belongs to: its versions show on the right and can be compared. */
  env?: EnvSet | null;
  /** The text to start from. */
  initial: string;
  /** The saved text, to mark what changed; null for a new set. */
  saved: string | null;
  /** A name field, for a new set. */
  name?: { value: string; onChange: (v: string) => void };
  /** Store the text: save it to the server, or hand it back to a form. Throw to keep the editor open. */
  onSave: (text: string) => Promise<void> | void;
  saveLabel?: string;
  note?: string;
  onClose: () => void;
};

/**
 * A .env as an editor, laid out like the job's file editor: its variables on the left, the text in the middle
 * (comments, blank lines and order are kept), the saved versions on the right to compare and take back.
 */
export function EnvWorkspaceModal({ env, initial, saved, name, onSave, saveLabel, note, onClose }: Props) {
  const { withSudo, toast } = useApp();
  const [text, setText] = useState(initial);
  const [ver, setVer] = useState<number | null>(null); // a version being compared, null while editing
  const [verText, setVerText] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const history = useApi<EnvHistory>(env ? `/envs/${env.id}/history` : null);

  const vars = useMemo(() => envVars(text), [text]);
  const orig = useMemo(() => new Map(saved === null ? [] : envVars(saved).map((x) => [x.k, x.v] as const)), [saved]);
  const now = new Map(vars.map((x) => [x.k, x.v] as const));
  const add = vars.filter((x) => !orig.has(x.k)).map((x) => x.k);
  const chg = vars.filter((x) => orig.has(x.k) && orig.get(x.k) !== x.v).map((x) => x.k);
  const del = [...orig.keys()].filter((k) => !now.has(k));
  const n = add.length + chg.length + del.length;
  const textOnly = saved !== null && !n && text.trimEnd() !== saved.trimEnd();
  const changed = saved === null || n > 0 || textOnly;
  const problem =
    envError(vars, text) ||
    (!vars.length ? "변수가 없어요. KEY=VALUE 형식으로 한 줄 이상 적어 주세요." : "") ||
    (name && !name.value.trim() ? "세트 이름을 적어 주세요." : "");
  const size = byteSize(text);

  // An older version's text, fetched when it is picked (values: the password re-check applies, and it is logged).
  useEffect(() => {
    if (!env || ver == null || ver === env.ver || verText[ver] !== undefined) return;
    withSudo("이전 버전 보기", async () => {
      try {
        const r = await api.get<EnvValues>(`/envs/${env.id}/values?ver=${ver}`);
        setVerText((m) => ({ ...m, [ver]: r.text }));
      } catch (e) {
        if (!(e instanceof ApiError && e.sudoRequired)) setVer(null);
        throw e; // withSudo asks for the password again, or shows the error
      }
    });
  }, [env, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const oldText = ver == null ? undefined : env && ver === env.ver ? saved ?? "" : verText[ver];
  const diff = useMemo(() => (oldText === undefined ? null : diffLines(oldText, text)), [oldText, text]);

  const jump = (line: number) => {
    const el = area.current;
    if (!el) return;
    const lines = text.split("\n");
    const start = lines.slice(0, line).reduce((s, l) => s + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line]?.length ?? 0));
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.scrollTop = Math.max(0, line * lh - el.clientHeight / 3);
  };

  const revive = (k: string) => {
    const v = orig.get(k) ?? "";
    setText((t) => (t && !t.endsWith("\n") ? t + "\n" : t) + `${k}=${v}\n`);
    toast(`${k}을(를) 되살렸어요`);
  };

  const read = (f?: File) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD) return toast("64KB보다 큰 파일은 올릴 수 없어요");
    const r = new FileReader();
    r.onload = () => {
      setText(String(r.result));
      setVer(null);
      toast(`${f.name}을(를) 읽었어요`);
    };
    r.readAsText(f);
  };

  const save = async () => {
    if (problem || !changed || busy) return;
    setErr("");
    setBusy(true);
    try {
      await onSave(text);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const items = history.data?.items ?? [];
  const mark = (k: string) => (saved === null ? null : add.includes(k) ? "new" : chg.includes(k) ? "edited" : null);

  return (
    <>
      <ModalHead title="환경 변수 편집기" sub={env ? `${env.name} · 지금 v${env.ver}` : undefined} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-auto lg:overflow-hidden grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)_270px] gap-3 p-3 bg-canvas">
        {/* variables */}
        <aside
          aria-label="변수 목록"
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            read(e.dataTransfer.files[0]);
          }}
          className={cx("relative flex flex-col min-h-0 max-lg:max-h-[280px] rounded-xl bg-surface shadow-soft overflow-hidden", over && "ring-2 ring-accent")}
        >
          <div className="flex items-center gap-0.5 px-3 py-2 border-b border-line">
            <span className="text-[12px] font-semibold text-muted mr-auto">변수 {vars.length}</span>
            <input ref={file} type="file" hidden onChange={() => (read(file.current?.files?.[0]), file.current && (file.current.value = ""))} />
            <Button size="sm" variant="ghost" iconOnly icon="upload" aria-label=".env 파일 불러오기" title=".env 파일 불러오기 (지금 내용을 바꿔요)" onClick={() => file.current?.click()} />
          </div>
          <div className="flex-1 min-h-0 overflow-auto scroll-soft p-1.5 flex flex-col gap-0.5">
            {vars.map((x, i) => {
              const m = mark(x.k);
              return (
                <button
                  key={`${x.k}:${i}`}
                  type="button"
                  onClick={() => (setVer(null), setTimeout(() => jump(x.line), 0))}
                  title={`${x.line + 1}번째 줄`}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-mono hover:bg-hover transition-colors"
                >
                  <span className="truncate flex-1">{x.k}</span>
                  {m && <span className={cx("text-[10.5px] font-sans font-semibold flex-none", m === "new" ? "text-ok" : "text-[var(--mark)]")}>{m === "new" ? "새" : "수정"}</span>}
                </button>
              );
            })}
            {del.map((k) => (
              <span key={k} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-mono text-faint">
                <span className="truncate flex-1 line-through">{k}</span>
                <button type="button" className="font-sans text-[11px] text-accent hover:underline flex-none" onClick={() => revive(k)}>
                  되살리기
                </button>
              </span>
            ))}
            {!vars.length && !del.length && <span className="p-2 text-[12.5px] text-faint">변수가 없어요. .env 파일을 여기로 끌어 놓아도 돼요.</span>}
          </div>
          {over && (
            <div className="absolute inset-0 grid place-items-center bg-accent/10 pointer-events-none">
              <span className="rounded-full bg-accent text-white text-[12.5px] font-semibold px-3.5 py-1.5 shadow-lift">놓으면 불러와요</span>
            </div>
          )}
        </aside>

        {/* editor or comparison */}
        <section className="flex flex-col min-h-[420px] lg:min-h-0 min-w-0 rounded-xl bg-surface shadow-lift overflow-hidden">
          {ver != null ? (
            <>
              <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-b border-line">
                <span className="font-mono text-[12.5px] truncate">.env</span>
                <span className="text-[12px] text-muted">
                  <b className="text-fg">v{ver}</b> → 지금
                </span>
                <span className="ml-auto flex gap-1">
                  {oldText !== undefined && oldText !== text && (
                    <Button size="sm" icon="undo" onClick={() => (setText(oldText), setVer(null), toast(`v${ver} 내용을 편집기에 넣었어요. 저장하면 새 버전이 돼요.`))}>
                      v{ver} 내용으로 되돌리기
                    </Button>
                  )}
                  <Button size="sm" variant="primary" icon="edit" onClick={() => setVer(null)}>
                    편집으로
                  </Button>
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto scroll-soft bg-surface font-code text-[12.5px] leading-[1.7] py-2">
                {oldText === undefined ? (
                  <p className="px-4 text-muted font-sans text-[12.5px]">불러오는 중…</p>
                ) : diff === null ? (
                  <pre className="m-0 px-4 whitespace-pre">{oldText}</pre>
                ) : diff.every((d) => d.t === " ") ? (
                  <p className="px-4 text-muted font-sans text-[12.5px]">v{ver}와 내용이 같아요.</p>
                ) : (
                  diff.map((d, i) => (
                    <div key={i} className={cx("px-4 whitespace-pre", d.t === "+" && "bg-ok-soft text-ok", d.t === "-" && "bg-bad-soft text-bad")}>
                      {d.t} {d.s}
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
                {name ? (
                  <Input
                    mono
                    aria-label="세트 이름"
                    placeholder="api-server.production"
                    className="h-7 max-w-[360px] border-transparent shadow-none bg-transparent hover:border-line focus:border-line-strong"
                    value={name.value}
                    onChange={(e) => name.onChange(e.target.value)}
                  />
                ) : (
                  <span className="font-mono text-[12.5px] truncate">{env?.name ?? ".env"}</span>
                )}
                <span className="ml-auto text-[12px] text-muted truncate">{note ?? (env?.usedBy.length ? `쓰는 작업: ${env.usedBy.join(", ")}` : "")}</span>
              </div>
              <CodeArea
                label=".env 내용"
                areaRef={area}
                value={text}
                onChange={setText}
                autoFocus={!name}
                placeholder={"# 주석과 빈 줄도 그대로 저장돼요\nDATABASE_URL=postgres://user:pass@10.0.3.31:5432/app\nREDIS_URL=redis://10.0.3.32:6379"}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                    e.preventDefault();
                    save();
                  }
                }}
              />
              <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-t border-line bg-surface-2 text-[11.5px] text-muted">
                <span>
                  {text.split("\n").length}줄 · 변수 {vars.length}개 · <span className={cx(size > MAX_TEXT && "text-bad font-semibold")}>{fmtSize(size)}</span>
                </span>
                {problem && vars.length > 0 && <span className="text-bad">{problem}</span>}
                <span className="ml-auto">Ctrl+S 저장 · 값은 활동 기록에 남지 않아요</span>
              </div>
            </>
          )}
        </section>

        {/* versions */}
        <aside aria-label="버전 기록" className="flex flex-col min-h-0 max-lg:max-h-[300px] rounded-xl bg-surface shadow-soft overflow-hidden">
          <div className="px-3 py-2 border-b border-line text-[12px] font-semibold text-muted">버전 기록</div>
          <div className="flex-1 min-h-0 overflow-auto scroll-soft p-1.5 flex flex-col gap-0.5">
            {!env && <p className="p-2 text-[12.5px] text-faint">저장하면 그때부터 버전이 남아요.</p>}
            {env && !history.data && <p className="p-2 text-[12.5px] text-muted">불러오는 중…</p>}
            {env && changed && saved !== null && (
              <button type="button" onClick={() => setVer(null)} className={cx("text-left rounded-lg px-2.5 py-2 text-[12.5px] transition-colors", ver == null ? "bg-accent-soft" : "hover:bg-hover")}>
                <b className={cx("font-semibold", ver == null && "text-accent")}>편집 중</b>
                <span className="block text-[11.5px] text-muted">저장하면 v{env.ver + 1}이 돼요</span>
              </button>
            )}
            {items.map((it) => {
              const d = it.diff;
              const active = it.ver === ver;
              return (
                <button
                  key={it.ver}
                  type="button"
                  onClick={() => setVer(active ? null : it.ver)}
                  className={cx("w-full text-left rounded-lg px-2.5 py-2 text-[12.5px] transition-colors", active ? "bg-accent-soft" : "hover:bg-hover")}
                >
                  <span className="flex items-center gap-1.5">
                    <b className={cx("font-semibold", active && "text-accent")}>v{it.ver}</b>
                    {it.current && <Chip>저장됨</Chip>}
                  </span>
                  <span className="block text-muted truncate">{it.updated}</span>
                  <span className="block text-[11.5px] text-faint truncate">
                    {d
                      ? [d.add.length && `+${d.add.length}`, d.chg.length && `~${d.chg.length}`, d.del.length && `-${d.del.length}`].filter(Boolean).join(" ") || "주석·순서"
                      : "처음 버전"}
                    {" · "}변수 {it.count}개
                  </span>
                </button>
              );
            })}
          </div>
          {env && <p className="px-3 py-2 border-t border-line text-[11.5px] text-faint">버전을 누르면 지금 내용과 비교해요. 예전 값을 열면 활동 기록에 남아요.</p>}
        </aside>
      </div>
      <ModalFoot between>
        <span className={cx("text-[12.5px] truncate", err || (problem && !vars.length) ? "text-bad" : "text-muted")}>
          {err ||
            (problem && !vars.length
              ? problem
              : saved === null
                ? `변수 ${vars.length}개`
                : n
                  ? `추가 ${add.length} · 수정 ${chg.length} · 삭제 ${del.length}${env?.usedBy.length ? " · 다음 배포부터 적용" : ""}`
                  : textOnly
                    ? "주석·빈 줄·순서만 바뀜"
                    : "바뀐 내용 없음")}
        </span>
        <span className="flex gap-2 flex-none">
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={!!problem || !changed || busy} onClick={save}>
            {busy ? "저장 중…" : saveLabel ?? (env && changed ? `저장 · v${env.ver + 1}` : "저장")}
          </Button>
        </span>
      </ModalFoot>
    </>
  );
}

/** Open a saved set in the editor; saving stores a new version. */
export function openEnvWorkspace(
  env: EnvSet,
  values: EnvValues,
  ctx: { openModal: ReturnType<typeof useApp>["openModal"]; withSudo: ReturnType<typeof useApp>["withSudo"]; toast: ReturnType<typeof useApp>["toast"]; refresh: () => void },
  onSaved?: (text: string, set: EnvSet) => void,
) {
  ctx.openModal(
    (c) => (
      <EnvWorkspaceModal
        env={env}
        initial={values.text}
        saved={values.text}
        onClose={c}
        onSave={(text) =>
          // withSudo asks for the password when needed and shows errors; the editor stays open until it is saved.
          ctx.withSudo("환경 변수 저장", async () => {
            const r = await api.put<EnvSet>(`/envs/${env.id}`, { text });
            c();
            ctx.refresh();
            ctx.toast(`${env.name} v${r.ver}으로 저장했어요`);
            onSaved?.(text, r);
          })
        }
      />
    ),
    "full",
  );
}
