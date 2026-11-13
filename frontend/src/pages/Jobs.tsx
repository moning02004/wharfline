import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Build, Job, JobImage, Run } from "../lib/types";
import { MoreMenu, type MenuItem } from "../components/Menu";
import { ApprovalButtons, PlaybookLine, shortImage, useRun } from "../modals/RunModals";
import { BuildBadge, buildNo, buildState, elapsed } from "../components/BuildBadge";
import { Icon, type IconName } from "../components/Icon";
import { ModalBody, ModalHead } from "../components/Modal";
import { EnvLink } from "../modals/EnvModals";
import { FileHistoryModal } from "../modals/FileHistoryModal";
import { api, errMsg } from "../lib/api";
import { since, stamp } from "../lib/time";
import { ConfirmDelete } from "./Resources";
import { Button, Byline, Card, CardHeader, Chip, Empty, Input, KV, Loading, PageHeader, Dot, Seg, Select, StatusPill, TableWrap, cx } from "../components/ui";

/** The job list, refreshed every few seconds while a CI build or a deploy is in progress. */
function useJobs() {
  const [poll, setPoll] = useState(0);
  const res = useApi<Job[]>("/jobs", poll);
  useEffect(() => {
    setPoll(res.data?.some((j) => jobBuilds(j).some((b) => b.active) || j.last.status === "run" || j.last.status === "approval") ? 3000 : 0);
  }, [res.data]);
  return res.data;
}

/** 실행 and the ⋮ menu of a job, shared by the list and the job page. */
function useJobActions(afterDelete?: () => void) {
  const { openModal, can, withSudo, refresh, toast } = useApp();
  const { confirm, rollbackNow } = useRun();
  const nav = useNavigate();
  const toggleHook = async (j: Job) => {
    try {
      await api.put(`/jobs/${j.id}/hook`, { on: !j.hook });
      refresh();
      toast(j.hook ? `${j.name}의 자동 배포를 껐어요` : `${j.name}의 자동 배포를 켰어요`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const del = (j: Job) =>
    openModal((c) => (
      <ConfirmDelete
        title="배포 작업 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("배포 작업 삭제", async () => {
            await api.del(`/jobs/${j.id}`);
            refresh();
            toast(`${j.name}을(를) 지웠어요`);
            afterDelete?.();
          })
        }
      >
        <span className="font-medium">{j.name}</span>을(를) Wharfline에서 지워요. 서버에서 돌고 있는 컨테이너와 파일은 그대로이고, 실행 기록과 환경 변수도 남아요.
      </ConfirmDelete>
    ));
  const tracksImage = (j: Job) => !!j.image || (j.extraImages ?? []).length > 0;
  const edit = (j: Job) => nav(`/jobs/${j.id}/edit`);
  const menuItems = (j: Job, { withEdit = true, withRuns = true, withRollback = true } = {}): MenuItem[] => [
    ...(withEdit && j.canEdit ? [{ label: "편집", icon: "edit" as const, onClick: () => edit(j) }] : []),
    ...(withRollback && canRollback(j)
      ? [{ label: `이전 배포로 되돌리기 (${j.prevTag})`, icon: "undo" as const, onClick: () => confirm(j, { tag: j.prevTag!, rollback: true }) }]
      : []),
    ...(j.canEdit && can("run_protected") && tracksImage(j)
      ? [{ label: j.hook ? "자동 배포 끄기" : "자동 배포 켜기", icon: "refresh" as const, onClick: () => toggleHook(j) }]
      : []),
    ...(withRuns ? [{ label: "실행 기록", icon: "history" as const, onClick: () => nav(`/runs?job=${encodeURIComponent(j.id)}`) }] : []),
    ...(can("job_create") ? [{ label: "복제", icon: "copy" as const, onClick: () => nav(`/jobs/${j.id}/copy`) }] : []),
    ...(j.canEdit && (!j.protected || can("run_protected"))
      ? [
          {
            label: "삭제",
            icon: "trash" as const,
            danger: true,
            disabled: j.last.status === "run",
            title: j.last.status === "run" ? "실행 중에는 지울 수 없어요" : undefined,
            onClick: () => del(j),
          },
        ]
      : []),
  ];
  const canRollback = (j: Job) => can("run") && !!j.prevTag && j.prevTag !== j.tagNow;
  /** 이전 배포: deploys the version before this one right away (the run log opens). */
  const rollbackButton = (j: Job) =>
    canRollback(j) && (
      <Button size="sm" variant="ghost" icon="undo" title={`${j.prevTag}로 되돌리기`} onClick={() => rollbackNow(j)}>
        이전 배포
      </Button>
    );
  const runButton = (j: Job) =>
    can("run") && (
      <Button size="sm" icon={j.protected && !can("run_protected") ? "lock" : "play"} onClick={() => confirm(j)}>
        {j.protected && !can("run_protected") ? "승인 요청" : "배포하기"}
      </Button>
    );
  return { menuItems, runButton, rollbackButton, edit };
}

/** The job list's 상태: the same words as everywhere else; a job that never ran says 배포 전. */
/** The builds of a job's images, one per build repo (images built by the same repo share it). */
function jobBuilds(j: Job): Build[] {
  const all = [j.build, ...(j.extraImages ?? []).map((x) => x.build)].filter((b): b is Build => !!b);
  return all.filter((b, i) => all.findIndex((o) => o.id === b.id) === i);
}

/** Under 상태: what the image builds are doing. Running beats finished; several at once are counted, not listed. */
function BuildLine({ job }: { job: Job }) {
  const builds = jobBuilds(job);
  if (!builds.length) return null;
  const running = builds.filter((b) => b.active);
  const failed = builds.filter((b) => b.status === "failure");
  const done = builds.filter((b) => b.status === "success");
  let tone: "accent" | "ok" | "bad", text: string, title: string | undefined;
  if (running.length) {
    const count = running.reduce((n, b) => n + Math.max(1, b.activeCount ?? 1), 0);
    const b = running.reduce((a, x) => (x.startedAt > a.startedAt ? x : a));
    tone = "accent";
    text = running.length > 1 ? `빌드 중 ${count}개` : count > 1 ? `빌드 중 ${buildNo(b)} 외 ${count - 1}건` : `빌드 중 ${buildNo(b)} · ${elapsed(b.startedAt)}`;
    title = running.map((x) => `${x.repo} ${buildNo(x)}${x.step ? ` · ${x.step}` : ""}`).join("\n");
  } else if (failed.length) {
    tone = "bad";
    text = failed.length > 1 ? `빌드 실패 ${failed.length}개` : `빌드 실패 ${buildNo(failed[0])}`;
    title = failed.map((x) => `${x.repo} ${buildNo(x)}`).join("\n");
  } else if (done.length) {
    tone = "ok";
    text = done.length > 1 ? "빌드 성공 · 새 버전 있음" : `빌드 성공 ${buildNo(done[0])}${done[0].tag ? ` → ${done[0].tag}` : ""}`;
    title = done.map((x) => `${x.repo} ${buildNo(x)}${x.tag ? ` → ${x.tag}` : ""}`).join("\n");
  } else return null;
  const color = { accent: "text-accent", ok: "text-ok", bad: "text-bad" }[tone];
  const dot = { accent: "bg-accent animate-pulse-dot", ok: "bg-ok", bad: "bg-bad" }[tone];
  return (
    <div className={cx("mt-1 flex items-center justify-center gap-1.5 text-[11.5px] whitespace-nowrap", color)} title={title}>
      <span className={cx("size-1.5 rounded-full flex-none", dot)} />
      {text}
    </div>
  );
}

/** 권한 column: both switches always shown, colored when on and faded when off, so rows line up. */
function JobFlags({ job: j }: { job: Job }) {
  const flags: { on: boolean; tone: "warn" | "accent"; icon: IconName; label: string; title: string }[] = [
    { on: j.protected, tone: "warn", icon: "lock", label: "승인 필요", title: j.protected ? "Owner·Admin이 아니면 승인을 받아야 배포돼요" : "승인 없이 배포돼요" },
    {
      on: j.hook,
      tone: "accent",
      icon: "refresh",
      label: "자동 배포",
      title: j.hook ? `새 태그가 올라오면 바로 배포 (${j.hookRule || "모든 태그"})` : "자동 배포 꺼짐 · 직접 실행만",
    },
  ];
  return (
    <span className="inline-flex flex-col items-center gap-1">
      {flags.map((f) => (
        <span key={f.label} title={f.title} aria-label={`${f.label} ${f.on ? "켜짐" : "꺼짐"}`}>
          <Chip tone={f.on ? f.tone : "neutral"} icon={f.icon} className={f.on ? undefined : "opacity-40"}>
            {f.label}
          </Chip>
        </span>
      ))}
    </span>
  );
}

function DeployState({ status }: { status: Job["last"]["status"] }) {
  return status === "warn" ? <span className="text-faint text-[12.5px]">배포 전</span> : <StatusPill status={status} />;
}

function ImageCell({ job: j }: { job: Job }) {
  const newer = j.latestTag && j.latestTag !== j.tagNow;
  return (
    <>
      {j.image ? <span className="font-mono text-[12.5px]">{shortImage(j)}</span> : <span className="text-faint text-[12.5px]">이미지 없음</span>}
      {newer && (
        <span className="ml-2">
          <Chip tone="accent" mono>
            ↑ {j.latestTag}
          </Chip>
        </span>
      )}
      {(j.build || (j.extraImages ?? []).some((x) => x.build)) && (
        <div className="mt-1 flex flex-wrap gap-1">
          <BuildBadge build={j.build} />
          {(j.extraImages ?? []).map((x) => (x.build ? <BuildBadge key={x.var || x.ref} build={x.build} /> : null))}
        </div>
      )}
    </>
  );
}

/** 작업 추가: pick what to add, then go to its page. 배포 추가 is the deploy job editor as it was. */
export function AddJobModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const go = (to: string) => {
    onClose();
    nav(to);
  };
  const choices: { to: string; icon: IconName; title: string; desc: string; eg: string }[] = [
    {
      to: "/jobs/new",
      icon: "rocket",
      title: "배포 추가",
      desc: "이미지나 docker-compose 파일로 앱을 서버에 띄워요.",
      eg: "예: API 서버, 웹 프런트, docker-compose.yml",
    },
    {
      to: "/jobs/new-playbook",
      icon: "book",
      title: "플레이북 추가",
      desc: "Ansible 플레이북을 올려 서버를 설치·설정해요. 필요한 값은 칸으로 물어봐요.",
      eg: "예: stack.yml, 서버 초기 설정, nginx 설치",
    },
  ];
  return (
    <>
      <ModalHead title="작업 추가" sub="무엇을 추가할지 골라 주세요." onClose={onClose} />
      <ModalBody>
        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-3">
          {choices.map((c, i) => (
            <button
              key={c.to}
              type="button"
              autoFocus={i === 0}
              onClick={() => go(c.to)}
              className="group flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left hover:border-accent/50 hover:bg-hover focus-visible:border-accent transition-colors"
            >
              <span className="grid place-items-center size-9 rounded-lg bg-accent/10 text-accent">
                <Icon name={c.icon} className="size-[18px]" />
              </span>
              <span className="text-[14px] font-semibold">{c.title}</span>
              <span className="text-[12.5px] text-muted">{c.desc}</span>
              <span className="text-[12px] text-faint">{c.eg}</span>
            </button>
          ))}
        </div>
      </ModalBody>
    </>
  );
}

type JobSort = "deployed" | "created" | "name";
type JobLayout = "table" | "cards";

/** A per-browser preference (view, sort); falls back when storage is unavailable. */
function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const got = localStorage.getItem(key) as T | null;
      return got && allowed.includes(got) ? got : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* storage unavailable */
    }
  };
  return [v, set];
}

export function Jobs() {
  const data = useJobs();
  const { can, openModal } = useApp();
  const { menuItems, runButton, rollbackButton } = useJobActions();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sort, setSort] = useStored<JobSort>("wharfline-jobs-sort", "deployed", ["deployed", "created", "name"]);
  const [layout, setLayout] = useStored<JobLayout>("wharfline-jobs-layout", "table", ["table", "cards"]);
  if (!data) return <Loading />;

  const needle = q.trim().toLowerCase();
  const found = data.filter(
    (j) =>
      !needle ||
      [j.name, j.createdByName ?? "", j.image ?? "", j.inventory].some((t) => t.toLowerCase().includes(needle)),
  );
  // The API lists jobs in the order they were made.
  const order = new Map(data.map((j, i) => [j.id, i]));
  // When the last deploy ended, in epoch seconds; older records only keep text like "12분 전" or "어제".
  const deployedAt = (j: Job): number => {
    if (j.last.status === "warn") return -1;
    if (j.last.at) return j.last.at;
    const t = j.last.time ?? "";
    const n = parseInt(t, 10) || 1;
    const ago = t === "방금" ? 0 : t.includes("분") ? n * 60 : t.includes("시간") ? n * 3600 : t === "어제" ? 86400 : t.includes("일") ? n * 86400 : null;
    return ago === null ? 0 : Date.now() / 1000 - ago;
  };
  const rows = [...found].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name, "ko")
      : sort === "created"
        ? (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)
        : deployedAt(b) - deployedAt(a),
  );
  const actions = (j: Job) => (
    <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
      {rollbackButton(j)}
      {runButton(j)}
      {menuItems(j, { withRollback: false }).length > 0 && <MoreMenu label={`${j.name} 메뉴`} items={menuItems(j, { withRollback: false })} />}
    </span>
  );
  const when = (j: Job) =>
    j.last.status === "warn" ? "-" : <span title={`${stamp(j.last.at)} · ${j.last.duration}`}>{since(j.last.at, j.last.time)}</span>;
  const empty = needle ? "찾는 작업이 없어요." : "아직 배포 작업이 없어요.";

  return (
    <>
      <PageHeader title="배포 작업" desc="무엇을, 어디에, 어떻게 배포할지 묶은 단위예요.">
        {can("job_create") && (
          <>
            <Button icon="wand" onClick={() => nav("/jobs/new?guide=1")}>
              배포를 도와드릴까요?
            </Button>
            <Button variant="primary" icon="plus" onClick={() => openModal((c) => <AddJobModal onClose={c} />)}>
              작업 추가
            </Button>
          </>
        )}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-[380px]">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-faint pointer-events-none" />
          <Input aria-label="배포 작업 검색" placeholder="작업, 생성자, 이미지, 인벤토리로 찾기" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="flex-1" />
        <Select aria-label="정렬" className="w-[140px]" value={sort} onChange={(e) => setSort(e.target.value as JobSort)}>
          <option value="deployed">최근 배포순</option>
          <option value="created">최근 생성순</option>
          <option value="name">이름순</option>
        </Select>
        <Seg
          options={[
            { value: "table", label: "표" },
            { value: "cards", label: "카드" },
          ]}
          value={layout}
          onChange={setLayout}
        />
      </div>
      {layout === "cards" ? (
        rows.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {rows.map((j) => (
              <Card key={j.id} hover className="!overflow-visible">
                <div className="flex flex-col gap-3 p-4 cursor-pointer h-full" onClick={() => nav(`/jobs/${encodeURIComponent(j.id)}`)}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <Link to={`/jobs/${encodeURIComponent(j.id)}`} className="font-semibold text-[14.5px] text-fg hover:underline break-keep" onClick={(e) => e.stopPropagation()}>
                        {j.name}
                      </Link>
                      <Byline label="생성자" name={j.createdByName} />
                    </div>
                    <DeployState status={j.last.status} />
                  </div>
                  <div className="flex flex-col gap-1 text-[12.5px] text-muted">
                    <span className="truncate">
                      <ImageCell job={j} />
                    </span>
                    <span>
                      {j.inventory} · {j.targets.length ? j.targets.join(", ") : "전체"} · {when(j)}
                    </span>
                  </div>
                  {(j.protected || j.hook) && (
                    <span className="flex gap-1.5">
                      {j.protected && <Chip tone="warn" icon="lock">승인 필요</Chip>}
                      {j.hook && <Chip tone="accent" icon="refresh">자동 배포</Chip>}
                    </span>
                  )}
                  <div className="mt-auto pt-1 flex justify-end">{actions(j)}</div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <Empty>{empty}</Empty>
          </Card>
        )
      ) : (
        <Card>
          <TableWrap>
            <table className="tbl center">
              <thead>
                <tr>
                  <th className="w-[30%]">작업</th>
                  <th>권한</th>
                  <th>상태</th>
                  <th>최근 배포</th>
                  <th>실행</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="!text-center text-muted py-10">
                      {empty}
                    </td>
                  </tr>
                )}
                {rows.map((j) => (
                  <tr key={j.id} className="click" onClick={() => nav(`/jobs/${encodeURIComponent(j.id)}`)}>
                    <td>
                      <Link to={`/jobs/${encodeURIComponent(j.id)}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                        {j.name}
                      </Link>
                      <Byline label="생성자" name={j.createdByName} />
                    </td>
                    <td>
                      <JobFlags job={j} />
                    </td>
                    <td>
                      <DeployState status={j.last.status} />
                      <BuildLine job={j} />
                    </td>
                    <td>
                      <span className="text-muted text-[12px] tabular-nums">{when(j)}</span>
                    </td>
                    <td className="!text-right">{actions(j)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </>
  );
}

/** /jobs/:id — one job: what it deploys and where, its safety settings, and its recent runs. */
export function JobDetail() {
  const { id = "" } = useParams();
  const data = useJobs();
  const nav = useNavigate();
  const { openModal, can } = useApp();
  const { openLog } = useRun();
  const { menuItems, runButton, edit } = useJobActions(() => nav("/jobs"));
  const job = data?.find((j) => j.id === id);
  const running = job?.last.status === "run";
  const { data: runs } = useApi<Run[]>("/runs", running ? 3000 : 0);
  if (!data) return <Loading />;
  if (!job) {
    return (
      <>
        <BackLink />
        <Card>
          <Empty>이 배포 작업을 찾을 수 없어요. 지워졌거나 볼 권한이 없어요.</Empty>
        </Card>
      </>
    );
  }
  const j = job;
  const mine = (runs ?? []).filter((r) => r.jobId === j.id);
  const more = menuItems(j, { withEdit: false, withRuns: false });
  return (
    <>
      <BackLink />
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2 flex-wrap">
            {j.name}
            {j.protected && (
              <Chip tone="warn" icon="lock">
                승인 필요
              </Chip>
            )}
          </span>
        }
      >
        {runButton(j)}
        {j.canEdit && (
          <Button size="sm" icon="edit" onClick={() => edit(j)}>
            편집
          </Button>
        )}
        {more.length > 0 && <MoreMenu label={`${j.name} 메뉴`} items={more} />}
      </PageHeader>

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader title="배포" />
          <div className="px-5 py-4">
            <KV
              labelWidth={96}
              items={[
                ["방법", <PlaybookLine job={j} />],
                ["이미지", <ImageCell job={j} />],
                [
                  "대상",
                  <>
                    {j.inventory} <span className="text-faint mx-1">·</span>
                    <Chip mono>{j.targetLabel}</Chip>
                  </>,
                ],
                ["서버", <span className="font-mono text-[12.5px]">{j.targetHosts.map((h) => h.ip).join(", ") || "-"}</span>],
                ...(j.servicePath ? ([["배포 폴더", <span className="font-mono text-[12.5px]">{j.servicePath}</span>]] as [string, React.ReactNode][]) : []),
                ...(j.filesVer
                  ? ([
                      [
                        "파일",
                        <span className="inline-flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[12.5px]">v{j.filesVer}</span>
                          <span className="text-muted">{j.files.map((f) => f.path).join(", ")}</span>
                          <Button size="sm" variant="ghost" icon="history" onClick={() => openModal((c) => <FileHistoryModal jobId={j.id} jobName={j.name} onClose={c} />, "wide")}>
                            기록
                          </Button>
                        </span>,
                      ],
                    ] as [string, React.ReactNode][])
                  : []),
                ["환경 변수", j.env ? <EnvLink name={j.env} /> : <span className="text-faint">없음</span>],
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="설정" />
          <div className="px-5 py-4">
            <KV
              labelWidth={96}
              items={[
                [
                  "최근 실행",
                  <span className="inline-flex items-center gap-2">
                    <StatusPill status={j.last.status} />
                    <span className="text-muted text-[12px] tabular-nums">
                      <span title={stamp(j.last.at)}>{since(j.last.at, j.last.time)}</span> · {j.last.duration}
                    </span>
                  </span>,
                ],
                ["지금 버전", <span className="font-mono text-[12.5px]">{j.tagNow || "-"}</span>],
                ["생성자", j.createdByName ?? <span className="text-muted">기록 없음</span>],
                ["자동 배포", j.hook ? `새 태그가 올라오면 바로 배포 (${j.hookRule || "모든 태그"})` : <span className="text-muted">수동 실행만</span>],
                ["안전장치", [j.protected && "운영 보호", j.lock && "동시 실행 잠금", j.rollback && "실패 시 되돌리기"].filter(Boolean).join(" · ") || "없음"],
                [
                  "권한",
                  j.editors.groups.length || j.editors.members.length
                    ? `그룹 ${j.editors.groups.length}개 · 멤버 ${j.editors.members.length}명이 고칠 수 있어요`
                    : <span className="text-muted">Owner, Admin, 만든 사람만 고칠 수 있어요</span>,
                ],
              ]}
            />
          </div>
        </Card>
      </div>

      <ImageBuilds job={j} />

      <Card>
        <CardHeader title="실행 기록" sub={mine.length ? `최근 ${Math.min(mine.length, 20)}건` : undefined}>
          {mine.length > 20 && (
            <Button size="sm" variant="ghost" onClick={() => nav(`/runs?job=${encodeURIComponent(j.id)}`)}>
              전체 보기
            </Button>
          )}
        </CardHeader>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>실행</th>
                <th>상태</th>
                <th>트리거</th>
                <th>이미지 태그</th>
                <th>소요</th>
                <th>시간</th>
                <th className="text-right">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {mine.slice(0, 20).map((r) => (
                <tr key={r.no} className="click" onClick={() => openLog(r.no)}>
                  <td className="font-mono">#{r.no}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td className="text-muted">
                    {r.trigger}
                    <Byline label="실행" name={r.by} />
                  </td>
                  <td className="font-mono">{r.tag}</td>
                  <td className="tabular-nums text-muted">{r.duration}</td>
                  <td className="text-muted" title={stamp(r.at)}>
                    {since(r.at, r.time)}
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.status === "approval" && can("approve") && <ApprovalButtons no={r.no} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!runs ? <Loading /> : !mine.length && <Empty>아직 실행한 적이 없어요.</Empty>}
        </TableWrap>
      </Card>
    </>
  );
}

/** A build date for the table: "11월 13일 14:05". */
const buildDate = (at: number) => {
  const d = new Date(at * 1000);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 이미지 빌드 on the job page: a tab per image the job follows, then its builds as 빌드 번호 | 태그 | 상태 | 날짜 (running first). */
function ImageBuilds({ job }: { job: Job }) {
  const [poll, setPoll] = useState(0);
  const { data } = useApi<JobImage[]>(`/jobs/${encodeURIComponent(job.id)}/images`, poll);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    setPoll(data?.some((im) => im.builds.some((b) => b.active)) ? 3000 : 0);
  }, [data]);
  if (!data?.length) return null;
  const cur = data.find((im) => im.ref === pick) ?? data[0];
  const builds = [...cur.builds].sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt);
  const name = (im: JobImage) => (im.var ? im.var.toLowerCase() : im.ref.slice(im.ref.lastIndexOf("/") + 1));
  return (
    <Card>
      <CardHeader title="이미지 빌드" />
      <div role="tablist" aria-label="이미지" className="flex flex-wrap gap-1.5 px-5 pt-3 pb-3 border-b border-line">
        {data.map((im) => (
          <button
            key={im.ref}
            type="button"
            role="tab"
            aria-selected={im.ref === cur.ref}
            title={im.ref}
            onClick={() => setPick(im.ref)}
            className={cx(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-md border text-[12.5px] transition-colors",
              im.ref === cur.ref ? "border-accent/40 bg-accent-soft text-accent font-medium" : "border-line text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {im.builds.some((b) => b.active) && <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" />}
            {name(im)}
          </button>
        ))}
      </div>
      <div className="max-h-[360px] overflow-y-auto scroll-soft">
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>빌드 번호</th>
                <th>태그</th>
                <th>상태</th>
                <th>날짜</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((b) => {
                const { tone, label } = buildState(b);
                return (
                  <tr key={b.id}>
                    <td className="font-mono">
                      {b.url ? (
                        <a href={b.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                          {buildNo(b)}
                        </a>
                      ) : (
                        buildNo(b)
                      )}
                    </td>
                    <td className="font-mono">{b.tag ?? <span className="text-faint">-</span>}</td>
                    <td>
                      <Dot tone={tone === "neutral" ? undefined : tone} pulse={b.active}>
                        {label}
                        {b.active && <span className="text-muted font-normal"> · {elapsed(b.startedAt)}</span>}
                      </Dot>
                    </td>
                    <td className="text-muted tabular-nums whitespace-nowrap" title={since(b.startedAt)}>
                      {buildDate(b.startedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!builds.length && <Empty>{cur.sourceRepo ? "아직 받은 빌드가 없어요." : "빌드 레포를 연결하면 이 이미지의 빌드가 여기에 모여요."}</Empty>}
        </TableWrap>
      </div>
    </Card>
  );
}

function BackLink() {
  return (
    <Link to="/jobs" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg w-fit -mb-3">
      <Icon name="chev" className="size-3.5 rotate-90" />
      배포 작업
    </Link>
  );
}

export function Runs() {
  const { data: all } = useApi<Run[]>("/runs");
  const { openLog } = useRun();
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const jobId = params.get("job");
  // /runs?run=123 (the link in a deploy notification) opens that run's log.
  const openNo = Number(params.get("run")) || 0;
  useEffect(() => {
    if (!openNo) return;
    openLog(openNo);
    const next = new URLSearchParams(params);
    next.delete("run");
    setParams(next, { replace: true });
  }, [openNo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!all) return <Loading />;
  const data = jobId ? all.filter((r) => r.jobId === jobId) : all;
  const jobName = jobId ? data[0]?.job ?? null : null;
  const waiting = data.filter((r) => r.status === "approval").length;
  return (
    <>
      <PageHeader
        title="실행 기록"
        desc={
          waiting
            ? `승인 대기 ${waiting}건이 있어요.`
            : "로그는 90일 보관하고, 비밀 값은 가려서 저장해요."
        }
      />
      {jobId && (
        <div className="flex items-center gap-2 text-[13px]">
          <Chip tone="accent">작업: {jobName ?? "기록 없음"}</Chip>
          <Button size="sm" variant="ghost" icon="x" onClick={() => setParams({})}>
            전체 보기
          </Button>
        </div>
      )}
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>실행</th>
                <th>작업</th>
                <th>대상</th>
                <th>상태</th>
                <th>트리거</th>
                <th>이미지 태그</th>
                <th>소요</th>
                <th>시간</th>
                <th className="text-right">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.no} className="click" onClick={() => openLog(r.no)}>
                  <td className="font-mono">#{r.no}</td>
                  <td>
                    <Link to={`/jobs/${encodeURIComponent(r.jobId)}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.job}
                    </Link>
                    <Byline label="실행" name={r.by}>
                      {r.decidedByName && <> · {r.status === "rejected" ? "거절" : "승인"} <span className="text-muted">{r.decidedByName}</span></>}
                    </Byline>
                  </td>
                  <td>
                    <Chip>{r.target || "전체"}</Chip>
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td className="text-muted">{r.trigger}</td>
                  <td className="font-mono">{r.tag}</td>
                  <td className="tabular-nums text-muted">{r.duration}</td>
                  <td className="text-muted" title={stamp(r.at)}>
                    {since(r.at, r.time)}
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.status === "approval" && can("approve") && <ApprovalButtons no={r.no} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.length && <Empty>{jobId ? "이 작업은 아직 실행한 적이 없어요." : "아직 실행 기록이 없어요."}</Empty>}
        </TableWrap>
      </Card>
    </>
  );
}
