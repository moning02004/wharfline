import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Build, Job, RunDetail, RunEvent, Status } from "../lib/types";
import { BuildBadge, PROVIDER_NAME, buildNo, buildState, elapsed } from "../components/BuildBadge";
import { GroupSelect } from "../components/GroupSelect";
import { Icon } from "../components/Icon";
import { EnvLink } from "./EnvModals";
import { FileHistoryModal } from "./FileHistoryModal";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Chip, Field, Hint, Input, KV, Select, StatusPill, cx } from "../components/ui";

/** Same rule as the server's TAG_RE. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const CUSTOM_TAG = "\u0000custom";

/** Where a job's playbook comes from: the repo and the path inside it, or the built-in one. */
export function PlaybookLine({ job }: { job: Job }) {
  const pb = job.playbook;
  if (pb.kind === "script")
    return (
      <>
        <Chip>SSH 스크립트</Chip> <span className="text-muted text-[12.5px]">{job.script?.map((st) => st.name).join(" → ")}</span>
      </>
    );
  if (pb.kind === "builtin")
    return (
      <>
        <Chip>기본 플레이북</Chip> <span className="font-mono text-muted text-[12.5px]">{pb.path}</span>
      </>
    );
  return (
    <>
      {pb.repo} <span className="text-faint">·</span> <span className="font-mono text-muted text-[12.5px]">{pb.path}</span>
    </>
  );
}

/** Short "name:tag" for lists, or null when the job runs without an image. */
export function shortImage(job: Job, tag = job.tagNow): string | null {
  return job.image ? `${job.image.split("/").pop()}:${tag}` : null;
}

export function useRun() {
  const app = useApp();

  const openLog = useCallback(
    (no: number) => app.openModal((close) => <RunLog no={no} onClose={close} />, "wide", app.refresh),
    [app],
  );

  const confirm = useCallback(
    (job: Job, opt: { tag?: string } = {}) =>
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
            onRequested={() => {
              close();
              app.toast("승인을 요청했어요");
              app.refresh();
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

  /** Owner/Admin: approve (starts the run and shows its log) or reject a run waiting for approval. */
  const decide = useCallback(
    async (no: number, how: "approve" | "reject") => {
      try {
        await api.post(`/runs/${no}/${how}`);
        app.refresh();
        if (how === "approve") openLog(no);
        else app.toast("실행을 거절했어요");
      } catch (e) {
        app.toast(errMsg(e));
        app.refresh();
      }
    },
    [app, openLog],
  );

  return { confirm, openLog, runById, decide };
}

/** 승인 / 거절 buttons for a run waiting for approval. */
export function ApprovalButtons({ no, after }: { no: number; after?: () => void }) {
  const { decide } = useRun();
  const [busy, setBusy] = useState(false);
  const act = async (how: "approve" | "reject") => {
    setBusy(true);
    after?.();
    await decide(no, how);
    setBusy(false);
  };
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="dangerGhost" disabled={busy} onClick={() => act("reject")}>
        거절
      </Button>
      <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => act("approve")}>
        승인
      </Button>
    </span>
  );
}

/* ---------- "배포하시겠습니까?" ---------- */

function ConfirmRun({
  job,
  opt,
  onClose,
  onStarted,
  onRequested,
}: {
  job: Job;
  opt: { tag?: string };
  onClose: () => void;
  onStarted: (no: number) => void;
  onRequested: () => void;
}) {
  const { toast, can } = useApp();
  // A Deployer can't start a protected job: the run waits for an Owner/Admin to approve it.
  const needsApproval = job.protected && !can("run_protected");
  const hasImage = job.image !== null;
  const [tag, setTag] = useState(opt.tag ?? job.defaultTag ?? "latest");
  // "직접 입력…": type a tag the image list doesn't know yet (the server records it on the image).
  const [custom, setCustom] = useState(() => tag !== "latest" && !job.imageTags.some((t) => t.name === tag));
  const [sel, setSel] = useState<string[]>([...job.targets]);
  // Extra watched images: each keeps the version running now unless picked here.
  const extras = job.extraImages ?? [];
  const [extraTags, setExtraTags] = useState<Record<string, string>>(() =>
    Object.fromEntries(extras.filter((x) => x.var).map((x) => [x.var, x.tagNow && x.tagNow !== "-" ? x.tagNow : x.defaultTag])),
  );
  const [busy, setBusy] = useState(false);

  // Latest CI build of every tracked image ("" = the main image), polled while any runs,
  // so a deploy can wait for the fresh tags.
  const [poll, setPoll] = useState(2500);
  const jobBuilds = useApi<Record<string, Build | null>>(hasImage || extras.length ? `/jobs/${job.id}/builds` : null, poll).data;
  const latest = jobBuilds?.[""] ?? undefined;
  const showBuild = !!latest && (latest.active || Date.now() / 1000 - latest.updatedAt < 3600);
  const activeVars = Object.entries(jobBuilds ?? {})
    .filter(([, b]) => b?.active)
    .map(([v]) => v);
  // Images whose builds a deploy is waiting for; null when not waiting.
  const [waiting, setWaiting] = useState<string[] | null>(null);
  const waitForBuild = waiting !== null;
  const setWaitForBuild = (on: boolean) => setWaiting(on ? (activeVars.length ? activeVars : [""]) : null);
  useEffect(() => {
    if (jobBuilds) setPoll(activeVars.length ? 2500 : 0);
  }, [jobBuilds, activeVars.length]);

  const freshTag = latest?.status === "success" && latest.tag && !job.imageTags.some((t) => t.name === latest.tag) ? latest.tag : null;
  const tagOptions = freshTag ? [{ name: freshTag, digest: "", pushed: "방금" }, ...job.imageTags] : job.imageTags;
  const latestTag = freshTag ?? job.latestTag;
  const resolved = tag === "latest" ? latestTag ?? "latest" : tag;
  const hosts = Object.values(job.groups)
    .flat()
    .filter((h) => !sel.length || sel.includes(h.group));
  const ready = hosts.filter((h) => !h.skip);
  const changed = JSON.stringify([...sel].sort()) !== JSON.stringify([...job.targets].sort());
  const tagOk = !hasImage || !tag || tag === "latest" || TAG_RE.test(tag); // empty only disables the button

  const go = async (useTag = tag, useExtra = extraTags) => {
    setBusy(true);
    try {
      const r = await api.post<{ no: number; status: string }>(`/jobs/${job.id}/runs`, { tag: useTag, groups: sel, extraTags: useExtra });
      if (r.status === "approval") onRequested();
      else onStarted(r.no);
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  };

  // "Deploy when the builds finish": once every awaited build is done, deploy with the tags they pushed; stop on a failure.
  useEffect(() => {
    if (!waiting || !jobBuilds) return;
    const awaited = waiting.map((v) => [v, jobBuilds[v] ?? null] as const);
    if (awaited.some(([, b]) => b?.active)) return;
    setWaiting(null);
    const bad = awaited.filter(([, b]) => !b || b.status !== "success" || !b.tag);
    if (bad.length) {
      const names = bad.map(([v, b]) => `${v || "이미지"}${b ? ` #${b.runNumber ?? b.runId}` : ""}`).join(", ");
      toast(`빌드(${names})가 실패했거나 새 태그가 없어서 배포하지 않았어요`, "error");
      return;
    }
    let mainTag = tag;
    const nextExtra = { ...extraTags };
    for (const [v, b] of awaited) {
      if (!b?.tag) continue;
      if (v === "") mainTag = b.tag;
      else nextExtra[v] = b.tag;
    }
    setTag(mainTag);
    setExtraTags(nextExtra);
    go(mainTag, nextExtra);
  }, [waiting, jobBuilds]); // react to build state changes

  return (
    <>
      <ModalHead
        title="배포하시겠습니까?"
        sub={job.name}
        onClose={onClose}
      />
      <ModalBody>
        {needsApproval && (
          <Hint className="flex items-center gap-1.5">
            <Icon name="lock" className="size-3.5 flex-none text-warn" />
            운영 보호 작업이에요. Owner나 Admin이 승인하면 실행돼요.
          </Hint>
        )}
        {hasImage && showBuild && latest && (
          <BuildPanel
            build={latest}
            selected={resolved === latest.tag}
            waiting={waitForBuild}
            onUseTag={() => {
              if (!latest.tag) return;
              setCustom(false);
              setTag(latest.tag);
            }}
            onWait={setWaitForBuild}
          />
        )}
        {hasImage ? (
          <Field
            label={
              <span className="flex items-baseline gap-2 min-w-0 flex-wrap">
                <span>{imageName(job.image!)}</span>
                <span className="font-mono font-normal text-[12px] text-muted break-all">{job.image}</span>
              </span>
            }
            htmlFor="cTag"
            error={!tagOk}
            right={
              custom && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCustom(false);
                    setTag("latest");
                  }}
                >
                  목록에서 고르기
                </Button>
              )
            }
            hint={!tagOk ? "태그는 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요." : undefined}
          >
            <VersionLine newest={latestTag} now={job.tagNow}>
            {custom ? (
              <Input
                id="cTag"
                mono
                value={tag}
                onChange={(e) => setTag(e.target.value.trim())}
                placeholder="예: v1.8.3"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            ) : (
              <Select
                id="cTag"
                mono
                value={tag}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_TAG) {
                    setCustom(true);
                    setTag("");
                  } else setTag(e.target.value);
                }}
              >
                <option value="latest">latest</option>
                {tagOptions.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
                <option value={CUSTOM_TAG}>직접 입력…</option>
              </Select>
            )}
            </VersionLine>
          </Field>
        ) : (job.extraImages ?? []).length ? null : (
          <Hint className="flex items-center gap-1.5">
            <Icon name="info" className="size-3.5 flex-none text-accent" />
            {job.playbook.kind === "script" ? "이미지 없이 스크립트만 실행해요." : "이미지 없이 플레이북만 실행해요."}
          </Hint>
        )}
        {extras.length > 0 && (
          <Field
            label={hasImage ? "추가 이미지" : "이미지"}
            right={
              activeVars.some((v) => v !== "") && !(hasImage && showBuild && latest?.active) ? (
                <Button size="sm" variant={waitForBuild ? "primary" : "default"} onClick={() => setWaitForBuild(!waitForBuild)}>
                  {waitForBuild ? "기다리는 중 · 취소" : "빌드 끝나면 배포"}
                </Button>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3">
              {extras.map((x) => (
                <div key={x.var || x.ref} className="flex flex-col gap-1.5 min-w-0">
                  <span className="flex items-baseline gap-2 min-w-0 flex-wrap text-[13px]">
                    <span className="font-medium">{x.var ? x.var.replace(/_TAG$/, "").toLowerCase() : imageName(x.ref)}</span>
                    <span className="font-mono text-[12px] text-muted break-all">{x.ref}</span>
                    {jobBuilds?.[x.var || x.ref]?.active && <BuildBadge build={jobBuilds[x.var || x.ref]!} />}
                  </span>
                  {!x.var ? (
                    <div className="w-[240px] max-w-full h-9 px-3 flex items-center rounded-lg border border-line bg-surface-2 font-mono text-[13px] text-muted" title="파일에 적힌 버전">
                      {x.literal ?? "latest"}
                    </div>
                  ) : (
                    <VersionLine newest={x.latestTag} now={x.tagNow}>
                      <Select mono aria-label={`${x.var} 태그`} value={extraTags[x.var]} onChange={(e) => setExtraTags({ ...extraTags, [x.var]: e.target.value })}>
                        {[...new Set([extraTags[x.var], "latest", ...(x.tags ?? [])])].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </VersionLine>
                  )}
                </div>
              ))}
            </div>
          </Field>
        )}
        <KV
          items={[
            ["배포 방법", <PlaybookLine job={job} />],
            ["환경 변수", job.env ? <EnvLink name={job.env} /> : "없음"],
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
        <div className="rounded-lg border border-line overflow-hidden">
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
        {changed && <Hint className="text-faint text-xs">이번 실행에만 적용돼요.</Hint>}
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button
          variant="primary"
          icon={needsApproval ? "lock" : "play"}
          disabled={!ready.length || busy || waitForBuild || !tagOk || (hasImage && !tag)}
          onClick={() => go()}
          autoFocus
        >
          {waitForBuild ? "빌드 끝나길 기다리는 중…" : needsApproval ? "승인 요청" : `서버 ${ready.length}대에 배포`}
        </Button>
      </ModalFoot>
    </>
  );
}

/** Short name of an image: the last part of its ref (ghcr.io/acme/api-server → api-server). */
function imageName(ref: string) {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** A version picker with what runs now and the newest build beside it, easy to tell apart. */
function VersionLine({ newest, now, children }: { newest?: string | null; now?: string | null; children: React.ReactNode }) {
  const running = now && now !== "-" ? now : null;
  const tag = (label: string, cls: string) => <span className={cx("inline-block w-[30px] text-center rounded px-1 py-px text-[11px] font-semibold", cls)}>{label}</span>;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-[150px] max-w-[220px]">{children}</div>
      <div className="flex flex-col gap-1 text-[12.5px] font-mono whitespace-nowrap min-w-0">
        {running && newest && running === newest ? (
          <span className="flex items-center gap-1.5 text-ok">
            {tag("최신", "bg-ok-soft text-ok")}
            {newest}
            <span className="font-sans text-[11.5px]">떠 있음</span>
          </span>
        ) : (
          <>
            {running && (
              <span className="flex items-center gap-1.5 text-muted">
                {tag("지금", "bg-surface-2 border border-line text-muted")}
                {running}
              </span>
            )}
            {newest && (
              <span className="flex items-center gap-1.5 text-primary font-semibold">
                {tag("최신", "bg-primary-soft text-primary")}
                {newest}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The image's latest CI build inside the deploy dialog: number, step, result, and what to do with it. */
function BuildPanel({ build, selected, waiting, onUseTag, onWait }: { build: Build; selected: boolean; waiting: boolean; onUseTag: () => void; onWait: (v: boolean) => void }) {
  const { tone, label } = buildState(build);
  const color = { accent: "border-accent/30 bg-accent-soft", ok: "border-ok/25 bg-ok-soft", bad: "border-bad/25 bg-bad-soft", neutral: "border-line bg-surface-2" }[tone];
  const text = { accent: "text-accent", ok: "text-ok", bad: "text-bad", neutral: "text-muted" }[tone];
  return (
    <div className={cx("rounded-lg border p-3 flex flex-col gap-2 animate-fade", color)}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cx("size-2 rounded-full", { accent: "bg-accent animate-pulse-dot", ok: "bg-ok", bad: "bg-bad", neutral: "bg-faint" }[tone])} />
        <b className={cx("font-semibold", text)}>
          {label} <span className="font-mono">{buildNo(build)}</span>
        </b>
        <span className="text-muted text-[12px]">
          {build.repo} · {build.branch ?? "-"}
          {build.sha ? `@${build.sha.slice(0, 7)}` : ""}
        </span>
        {build.url && (
          <a href={build.url} target="_blank" rel="noreferrer noopener" className="ml-auto text-[12px] text-accent hover:underline">
            {PROVIDER_NAME[build.provider] ?? "Git"}에서 보기
          </a>
        )}
      </div>
      {build.active && (
        <>
          <div className="text-[12.5px] text-muted">
            {build.step ? `지금 단계: ${build.step}` : "러너를 기다리는 중"} · {elapsed(build.startedAt)}
          </div>
          <div className="h-1 rounded-full bg-surface overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-accent animate-[indeterminate_1.4s_ease-in-out_infinite]" />
          </div>
          <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
            <input type="checkbox" className="accent-(--accent) size-3.5" checked={waiting} onChange={(e) => onWait(e.target.checked)} />
            빌드가 성공하면 새 태그로 바로 배포 <span className="text-faint">(이 창을 열어 두세요)</span>
          </label>
        </>
      )}
      {build.status === "success" && build.tag && (
        <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
          <span>
            새 이미지 <span className="font-mono font-medium">{build.tag}</span>가 올라왔어요.
          </span>
          {selected ? (
            <span className="text-ok font-medium">이 태그로 배포해요</span>
          ) : (
            <Button size="sm" onClick={onUseTag}>
              {build.tag}로 배포
            </Button>
          )}
        </div>
      )}
      {build.status === "success" && !build.tag && <div className="text-[12.5px] text-muted">빌드는 성공했지만 아직 이미지 푸시 알림이 오지 않았어요.</div>}
      {build.status === "failure" && <div className="text-[12.5px] text-bad">이 빌드는 실패했어요. 이미 올라와 있는 태그만 배포할 수 있어요.</div>}
    </div>
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
  const { toast, refresh, can, openModal } = useApp();
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
  const waiting = run?.status === "approval";
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
              {short ? (
                <span className="font-mono">
                  {short}:{run.tag}
                </span>
              ) : Object.keys(run.extraTags ?? {}).length ? null : (
                "이미지 없음"
              )}
              {Object.entries(run.extraTags ?? {}).map(([v, t], i) => (
                <span key={v} className="font-mono">
                  {short || i ? " · " : ""}
                  {v}:{t}
                </span>
              ))}{" "}
              {run.method && <>· {run.method} </>}· {run.inventory} / {run.target}
              {run.filesVer ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="link font-mono"
                    title="이 실행에 쓴 파일 보기"
                    onClick={() => openModal((c) => <FileHistoryModal jobId={run.jobId} jobName={run.job} initialVer={run.filesVer} onClose={c} />, "wide")}
                  >
                    파일 v{run.filesVer}
                  </button>
                </>
              ) : null}
              {run.build && (
                <span className="block mt-1 text-[12px]">
                  <span className={run.build.status === "success" ? "text-ok" : "text-muted"}>
                    {buildState(run.build).label} <span className="font-mono">{buildNo(run.build)}</span>
                  </span>{" "}
                  · {run.build.repo} · {run.build.branch ?? "-"}
                  {run.build.sha ? `@${run.build.sha.slice(0, 7)}` : ""} → <span className="font-mono">{run.build.tag}</span>
                </span>
              )}
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
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] max-md:grid-rows-[auto_minmax(0,1fr)] flex-1 min-h-0">
        <div className="md:border-r max-md:border-b border-line p-3 flex md:flex-col gap-0.5 overflow-auto scroll-soft">
          {(run?.steps ?? []).map((name, i) => {
            const st = steps[i]?.state ?? "";
            return (
              <div
                key={i}
                className={cx(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium whitespace-nowrap transition-all duration-300",
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
          {waiting && (
            <div className="text-[#fcd34d]">
              ⏸ 승인 대기 · {run?.requestedByName ?? run?.by ?? "자동 배포"}님이 요청했어요. Owner나 Admin이 승인하면 실행돼요.
            </div>
          )}
          {run?.status === "rejected" && (
            <div className="text-[#fca5a5]">✗ {run.decidedByName ?? "관리자"}님이 실행을 거절했어요. 서버에는 아무것도 바뀌지 않았어요.</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all animate-fade">
              <span className="text-log-dim mr-3 select-none">{l.ts}</span>
              <span className={LINE_COLORS[l.c] ?? ""}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
      <ModalFoot between>
        <span className="text-faint text-xs">
          {waiting ? "승인되기 전에는 서버에 접속하지 않아요." : "로그는 실행 기록에 저장돼요. 창을 닫아도 실행은 계속돼요."}
        </span>
        <span className="flex gap-2">
          {run?.live && !done && can("run") && (
            <Button variant="danger" onClick={cancel}>
              실행 취소
            </Button>
          )}
          {waiting && can("approve") && <ApprovalButtons no={no} after={onClose} />}
          {(done || (run && !run.live)) && !waiting && run?.jobId && can("run") && (
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
