import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApp } from "../lib/app";
import type { Job, RunDetail, RunEvent, Status } from "../lib/types";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Chip, Field, Hint, KV, Select, StatusPill, cx } from "../components/ui";

const METHODS = { compose: "Docker Compose", ansible: "Ansible 플레이북" };

export function MethodLine({ job }: { job: Job }) {
  return job.method === "compose" ? (
    <>
      <Chip>Compose</Chip> <span className="font-mono text-muted text-[12.5px]">{job.dir}/compose.yml</span>
    </>
  ) : (
    <>
      <Chip>Ansible</Chip>{" "}
      <span className="font-mono text-muted text-[12.5px]">
        {job.repo} / {job.book}
      </span>
    </>
  );
}

export function useRun() {
  const app = useApp();

  const openLog = useCallback(
    (no: number) => app.openModal((close) => <RunLog no={no} onClose={close} />, "wide", app.refresh),
    [app],
  );

  const confirm = useCallback(
    (job: Job, opt: { tag?: string; rollback?: boolean } = {}) =>
      app.openModal(
        (close) => (
          <ConfirmRun
            job={job}
            opt={opt}
            onClose={close}
            onStarted={(no) => {
              close();
              openLog(no);
            }}
          />
        ),
        "sm",
      ),
    [app, openLog],
  );

  const runById = useCallback(
    async (id: string) => {
      try {
        const jobs = await api.get<Job[]>("/jobs");
        const j = jobs.find((x) => x.id === id);
        if (j) confirm(j);
      } catch (e) {
        app.toast(errMsg(e));
      }
    },
    [app, confirm],
  );

  return { confirm, openLog, runById };
}

/* ---------- "배포하시겠습니까?" ---------- */

function ConfirmRun({ job, opt, onClose, onStarted }: { job: Job; opt: { tag?: string; rollback?: boolean }; onClose: () => void; onStarted: (no: number) => void }) {
  const { toast } = useApp();
  const [tag, setTag] = useState(opt.tag ?? job.defaultTag ?? "latest");
  const [sel, setSel] = useState<string[]>([...job.targets]);
  const [busy, setBusy] = useState(false);

  const resolved = tag === "latest" ? job.latestTag ?? "latest" : tag;
  const info = job.imageTags.find((t) => t.name === resolved) ?? { name: resolved, digest: "00000000", pushed: "-" };
  const hosts = Object.values(job.groups)
    .flat()
    .filter((h) => !sel.length || sel.includes(h.group));
  const ready = hosts.filter((h) => !h.skip);
  const changed = JSON.stringify([...sel].sort()) !== JSON.stringify([...job.targets].sort());

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ no: number }>(`/jobs/${job.id}/runs`, { tag, groups: sel, rollback: !!opt.rollback });
      onStarted(r.no);
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <ModalHead
        title={opt.rollback ? "이전 버전으로 되돌리시겠습니까?" : "배포하시겠습니까?"}
        sub={opt.rollback ? `${job.name} · 지금 ${job.tagNow} → ${opt.tag}` : job.name}
        onClose={onClose}
      />
      <ModalBody>
        <Field
          label="이미지 태그"
          htmlFor="cTag"
          hint={
            <>
              {tag === "latest" && (
                <>
                  latest는 지금 <span className="font-mono">{resolved}</span>이에요. 이 digest로 고정해서 배포해요 ·{" "}
                </>
              )}
              {info.digest ? <span className="font-mono">sha256:{info.digest}…</span> : "digest는 실행할 때 고정해요"} · {info.pushed}
              {resolved === job.tagNow && " · 지금 배포된 버전과 같아서 다시 배포돼요"}
            </>
          }
        >
          <Select id="cTag" mono value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="latest">latest · 지금 {job.latestTag ?? "-"}</option>
            {job.imageTags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.name === job.tagNow ? "  · 지금 배포됨" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <KV
          items={[
            ["이미지", job.image, "font-mono text-[12.5px]"],
            ["배포 방식", <MethodLine job={job} />],
            ["환경 변수", job.env || "없음", "font-mono text-[12.5px]"],
            ...(job.protected
              ? ([["안전장치", [job.lock && "동시 실행 금지", job.rollback && "실패 시 이전 태그로 롤백"].filter(Boolean).join(" · "), "text-muted"]] as [string, string, string][])
              : []),
          ]}
        />
        <Field
          label={
            <>
              배포 대상 <span className="text-muted font-normal">· {job.inventory}</span>
            </>
          }
        >
          <GroupSelect groups={job.groups} value={sel} onChange={setSel} />
        </Field>
        <div className="rounded-2xl shadow-[inset_0_0_0_1px_var(--border)] overflow-hidden">
          {hosts.map((h) => (
            <div key={h.name} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 animate-fade">
              <Chip tone="accent" mono>
                {h.group}
              </Chip>
              <div className="flex-1 font-medium truncate">{h.name}</div>
              <span className="font-mono text-[12.5px] text-muted">{h.ip}</span>
              {h.skip ? <Chip tone="warn">건너뜀 · {h.skip}</Chip> : <Chip tone="ok">배포</Chip>}
            </div>
          ))}
        </div>
        <Hint className="text-faint text-xs">
          {changed ? "대상을 바꿨어요. 이번 실행에만 적용되고 작업 설정은 그대로예요." : "작업에 저장된 대상이에요. 선택 상자에서 그룹을 더하거나 빼면 이번 실행에만 적용돼요."}
        </Hint>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" icon="play" disabled={!ready.length || busy} onClick={go} autoFocus>
          서버 {ready.length}대에 배포
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- live log ---------- */

type StepState = "" | "run" | "ok" | "bad";
const LINE_COLORS: Record<string, string> = {
  h: "text-[#a5b4fc] font-medium",
  g: "text-[#6ee7a8]",
  y: "text-[#fcd34d]",
  r: "text-[#fca5a5]",
  m: "text-[#c4b5fd]",
};

function RunLog({ no, onClose }: { no: number; onClose: () => void }) {
  const { toast, refresh } = useApp();
  const { runById } = useRun();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const t0 = useRef(Date.now());

  useEffect(() => {
    let es: EventSource | null = null;
    let alive = true;
    api
      .get<RunDetail>(`/runs/${no}`)
      .then((r) => {
        if (!alive) return;
        setRun(r);
        setEvents(r.events);
        if (r.live) {
          es = new EventSource(`/api/runs/${no}/stream?since=${r.events.length}`);
          es.onmessage = (m) => {
            const ev = JSON.parse(m.data) as RunEvent;
            setEvents((prev) => [...prev, ev]);
            if (ev.t === "done") {
              es?.close();
              refresh();
            }
          };
          es.onerror = () => es?.close();
        }
      })
      .catch((e) => toast(errMsg(e)));
    return () => {
      alive = false;
      es?.close();
    };
  }, [no, toast, refresh]);

  const { steps, lines, done } = useMemo(() => {
    const steps: { state: StepState; d?: string }[] = (run?.steps ?? []).map(() => ({ state: "" }));
    const lines: { c: string; text: string; ts: string }[] = [];
    let done: { status: Status; duration: string } | null = null;
    for (const ev of events) {
      if (ev.t === "step" && steps[ev.i]) steps[ev.i] = { state: ev.state, d: ev.d };
      else if (ev.t === "line") lines.push(ev);
      else if (ev.t === "cancel") steps.forEach((s) => s.state === "run" && (s.state = "bad"));
      else if (ev.t === "done") done = { status: ev.status, duration: ev.duration };
    }
    return { steps, lines, done: done as { status: Status; duration: string } | null };
  }, [run, events]);

  useEffect(() => {
    if (done || !run?.live) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [done, run?.live]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const cancel = async () => {
    try {
      await api.post(`/runs/${no}/cancel`);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const status: Status = done?.status ?? (run?.live ? "run" : run?.status ?? "run");
  const short = run?.image?.split("/").pop();

  return (
    <>
      <ModalHead
        border
        onClose={onClose}
        title={
          <>
            {run?.job ?? "실행"} <span className="font-mono text-muted font-normal">#{no}</span>
          </>
        }
        sub={
          run && (
            <>
              <span className="font-mono">
                {short}:{run.tag}
              </span>{" "}
              · {run.method} · {run.inventory} / {run.target}
            </>
          )
        }
        extra={
          <span className="flex items-center gap-2.5">
            <StatusPill status={status} />
            <span className="tabular-nums text-muted text-[13px]">{done ? done.duration : `${elapsed}s`}</span>
          </span>
        }
      />
      <div className="grid md:grid-cols-[220px_minmax(0,1fr)] max-md:grid-rows-[auto_minmax(0,1fr)] flex-1 min-h-0">
        <div className="md:border-r max-md:border-b border-line p-3 flex md:flex-col gap-0.5 overflow-auto scroll-soft">
          {(run?.steps ?? []).map((name, i) => {
            const st = steps[i]?.state ?? "";
            return (
              <div
                key={i}
                className={cx(
                  "flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap transition-all duration-300",
                  st === "" && "text-faint",
                  st === "run" && "text-fg bg-surface-2",
                  (st === "ok" || st === "bad") && "text-fg",
                )}
              >
                <span
                  className={cx(
                    "size-4 rounded-full grid place-items-center flex-none border-[1.5px] transition-colors",
                    st === "" && "border-line-strong",
                    st === "run" && "border-accent border-t-transparent animate-spin",
                    st === "ok" && "bg-ok border-ok text-white",
                    st === "bad" && "bg-bad border-bad text-white",
                  )}
                >
                  {st === "ok" && <Icon name="check" className="size-2.5" strokeWidth={3} />}
                  {st === "bad" && <Icon name="x" className="size-2.5" strokeWidth={3} />}
                </span>
                {name}
                <span className="ml-auto text-[11.5px] text-faint tabular-nums font-normal max-md:hidden">{steps[i]?.d}</span>
              </div>
            );
          })}
        </div>
        <div ref={logRef} aria-live="polite" className="bg-log-bg text-log-fg font-mono text-[12.5px] leading-[1.7] px-5 py-4 overflow-auto scroll-soft min-w-0 md:rounded-br-none">
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all animate-fade">
              <span className="text-log-dim mr-3 select-none">{l.ts}</span>
              <span className={LINE_COLORS[l.c] ?? ""}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
      <ModalFoot between>
        <span className="text-faint text-xs">로그는 실행 기록에 저장돼요. 창을 닫아도 실행은 계속돼요.</span>
        <span className="flex gap-2">
          {run?.live && !done && (
            <Button variant="danger" onClick={cancel}>
              실행 취소
            </Button>
          )}
          {(done || (run && !run.live)) && run?.jobId && (
            <Button
              icon="refresh"
              onClick={() => {
                onClose();
                runById(run.jobId);
              }}
            >
              다시 실행
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </span>
      </ModalFoot>
    </>
  );
}

export { METHODS };
