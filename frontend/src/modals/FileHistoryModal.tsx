import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../lib/api";
import type { BundleFile } from "../lib/types";
import { ModalFoot, ModalHead } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Button, Chip, cx } from "../components/ui";

interface Version {
  ver: number;
  createdAt: number;
  createdBy: string;
  changes: { added: string[]; changed: string[]; removed: string[] };
  count: number;
}

type Mark = "added" | "changed" | "removed" | "same";
const MARK: Record<Mark, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  added: { label: "추가", tone: "ok" },
  changed: { label: "변경", tone: "warn" },
  removed: { label: "삭제", tone: "bad" },
  same: { label: "그대로", tone: "neutral" },
};

/** Line diff (longest common subsequence). Big files fall back to showing the new text only. */
function diffLines(a: string, b: string): { t: " " | "+" | "-"; s: string }[] | null {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return null;
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: " " | "+" | "-"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push({ t: " ", s: x[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: x[i++] });
    else out.push({ t: "+", s: y[j++] });
  }
  while (i < x.length) out.push({ t: "-", s: x[i++] });
  while (j < y.length) out.push({ t: "+", s: y[j++] });
  return out;
}

const when = (t: number) => new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Every saved version of a job's files: who and when, what changed, and the content (or diff) of each file. */
export function FileHistoryModal({ jobId, jobName, initialVer, onClose }: { jobId: string; jobName: string; initialVer?: number | null; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [ver, setVer] = useState<number | null>(initialVer ?? null);
  const [files, setFiles] = useState<BundleFile[]>([]);
  const [prev, setPrev] = useState<BundleFile[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<Version[]>(`/jobs/${jobId}/files/history`).then((v) => {
      setVersions(v);
      setVer((cur) => cur ?? v[0]?.ver ?? null);
    }, (e) => setErr(errMsg(e)));
  }, [jobId]);

  const current = versions?.find((v) => v.ver === ver);
  const hasPrev = !!versions?.some((v) => v.ver === (ver ?? 0) - 1);
  useEffect(() => {
    if (ver == null) return;
    setOpen(null);
    setErr("");
    api.get<BundleFile[]>(`/jobs/${jobId}/files?ver=${ver}`).then(setFiles, (e) => (setFiles([]), setErr(errMsg(e))));
    if (hasPrev) api.get<BundleFile[]>(`/jobs/${jobId}/files?ver=${ver - 1}`).then(setPrev, () => setPrev([]));
    else setPrev([]);
  }, [jobId, ver, hasPrev]);

  // Files of this version plus the ones it removed, each marked against the previous version.
  const rows = useMemo(() => {
    const ch = current?.changes;
    const mark = (p: string): Mark => (ch?.added.includes(p) ? "added" : ch?.changed.includes(p) ? "changed" : "same");
    const list: { path: string; mark: Mark; content?: string; before?: string }[] = files.map((f) => ({
      path: f.path,
      mark: mark(f.path),
      content: f.content,
      before: prev.find((p) => p.path === f.path)?.content,
    }));
    for (const p of ch?.removed ?? []) list.push({ path: p, mark: "removed", before: prev.find((x) => x.path === p)?.content });
    return list;
  }, [files, prev, current]);

  return (
    <>
      <ModalHead title="파일 기록" sub={`${jobName} · 저장할 때마다 바뀐 내용을 버전으로 남겨요`} onClose={onClose} />
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)] flex-1 min-h-0 border-t border-line">
        <div className="md:border-r max-md:border-b border-line overflow-auto scroll-soft p-2 flex md:flex-col gap-1 max-md:max-h-[160px]">
          {versions === null && <span className="p-2 text-muted text-[12.5px]">불러오는 중…</span>}
          {versions?.length === 0 && <span className="p-2 text-muted text-[12.5px]">아직 저장된 파일이 없어요.</span>}
          {versions?.map((v) => (
            <button
              key={v.ver}
              type="button"
              onClick={() => setVer(v.ver)}
              className={cx("text-left rounded-lg px-2.5 py-2 text-[12.5px] flex-none md:w-full transition-colors", v.ver === ver ? "bg-accent-soft" : "hover:bg-hover")}
            >
              <div className="flex items-center gap-1.5">
                <b className={cx("font-semibold", v.ver === ver && "text-accent")}>v{v.ver}</b>
                {v.ver === versions[0].ver && <Chip>지금</Chip>}
              </div>
              <div className="text-muted">
                {when(v.createdAt)} · {v.createdBy}
              </div>
              <div className="text-[11.5px] text-faint">
                {[v.changes.added.length && `+${v.changes.added.length}`, v.changes.changed.length && `~${v.changes.changed.length}`, v.changes.removed.length && `-${v.changes.removed.length}`]
                  .filter(Boolean)
                  .join(" ")}{" "}
                · 파일 {v.count}개
              </div>
            </button>
          ))}
        </div>
        <div className="overflow-auto scroll-soft p-3 flex flex-col gap-1.5 min-h-[280px]">
          {err && <span className="text-bad text-[12.5px]">{err}</span>}
          {rows.map((r) => {
            const diff = r.mark === "changed" && r.before !== undefined && r.content !== undefined ? diffLines(r.before, r.content) : null;
            return (
              <div key={r.path} className="rounded-lg border border-line overflow-hidden">
                <button type="button" onClick={() => setOpen(open === r.path ? null : r.path)} className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-left hover:bg-hover">
                  <Icon name="chev" className={cx("size-3 text-faint transition-transform", open === r.path ? "" : "-rotate-90")} />
                  <span className={cx("font-mono truncate", r.mark === "removed" && "line-through text-muted")}>{r.path}</span>
                  <Chip tone={MARK[r.mark].tone} className="ml-auto">
                    {MARK[r.mark].label}
                  </Chip>
                </button>
                {open === r.path && (
                  <pre className="m-0 border-t border-line bg-surface-2 text-[11.5px] font-mono max-h-[340px] overflow-auto scroll-soft">
                    {diff
                      ? diff.map((d, i) => (
                          <div key={i} className={cx("px-3 whitespace-pre", d.t === "+" && "bg-ok-soft text-ok", d.t === "-" && "bg-bad-soft text-bad")}>
                            {d.t} {d.s}
                          </div>
                        ))
                      : <div className="px-3 py-2 whitespace-pre">{r.mark === "removed" ? r.before ?? "(내용 없음)" : r.content}</div>}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ModalFoot>
        <Button onClick={onClose}>닫기</Button>
      </ModalFoot>
    </>
  );
}
