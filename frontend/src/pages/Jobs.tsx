import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Job, Run } from "../lib/types";
import { MoreMenu, type MenuItem } from "../components/Menu";
import { ApprovalButtons, PlaybookLine, shortImage, useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { Icon } from "../components/Icon";
import { EnvLink } from "../modals/EnvModals";
import { FileHistoryModal } from "../modals/FileHistoryModal";
import { api, errMsg } from "../lib/api";
import { since, stamp } from "../lib/time";
import { ConfirmDelete } from "./Resources";
import { Button, Card, CardHeader, Chip, Empty, KV, Loading, PageHeader, StatusPill, TableWrap } from "../components/ui";

/** The job list, refreshed every few seconds while a CI build or a deploy is in progress. */
function useJobs() {
  const [poll, setPoll] = useState(0);
  const res = useApi<Job[]>("/jobs", poll);
  useEffect(() => {
    setPoll(res.data?.some((j) => j.build?.active || j.last.status === "run") ? 3000 : 0);
  }, [res.data]);
  return res.data;
}

/** 실행 and the ⋮ menu of a job, shared by the list and the job page. */
function useJobActions(afterDelete?: () => void) {
  const { openModal, can, withSudo, refresh, toast } = useApp();
  const { confirm } = useRun();
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
  const menuItems = (j: Job, { withEdit = true, withRuns = true } = {}): MenuItem[] => [
    ...(withEdit && j.canEdit ? [{ label: "편집", icon: "edit" as const, onClick: () => edit(j) }] : []),
    ...(can("run") && j.prevTag && j.prevTag !== j.tagNow
      ? [{ label: `이전 버전으로 되돌리기 (${j.prevTag})`, icon: "undo" as const, onClick: () => confirm(j, { tag: j.prevTag!, rollback: true }) }]
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
  const runButton = (j: Job) =>
    can("run") && (
      <Button size="sm" icon={j.protected && !can("run_protected") ? "lock" : "play"} onClick={() => confirm(j)}>
        {j.protected && !can("run_protected") ? "승인 요청" : "실행"}
      </Button>
    );
  return { menuItems, runButton, edit };
}

function methodLine(j: Job) {
  if (j.playbook.kind === "builtin") return "기본 플레이북";
  if (j.playbook.kind === "script") return j.playbook.path;
  return (
    <>
      {j.playbook.repo} · <span className="font-mono">{j.playbook.path}</span>
    </>
  );
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

export function Jobs() {
  const data = useJobs();
  const { can } = useApp();
  const { menuItems, runButton } = useJobActions();
  const nav = useNavigate();
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader title="배포 작업" desc="무엇을, 어느 서버에, 어떻게 배포할지 묶은 실행 단위예요. 작업을 누르면 설정과 실행 기록을 볼 수 있어요.">
        {can("job_create") && (
          <>
            <Button icon="wand" onClick={() => nav("/jobs/new?guide=1")}>
              배포를 도와드릴까요?
            </Button>
            <Button variant="primary" icon="plus" onClick={() => nav("/jobs/new")}>
              새 배포 작업
            </Button>
          </>
        )}
      </PageHeader>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>작업</th>
                <th>이미지 · 버전</th>
                <th>대상</th>
                <th>최근 실행</th>
                <th className="text-right">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((j) => (
                <tr key={j.id} className="click" onClick={() => nav(`/jobs/${encodeURIComponent(j.id)}`)}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Link to={`/jobs/${encodeURIComponent(j.id)}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                        {j.name}
                      </Link>
                      {j.protected && (
                        <Chip tone="warn" icon="lock">
                          보호됨
                        </Chip>
                      )}
                    </div>
                    <div className="text-[12px] text-muted truncate max-w-[320px]">{methodLine(j)}</div>
                  </td>
                  <td>
                    <ImageCell job={j} />
                  </td>
                  <td>
                    <span>{j.inventory}</span>
                    <span className="text-faint mx-1.5">·</span>
                    <Chip mono>{j.targetLabel}</Chip>
                    <span className="text-muted text-[12px] ml-1.5 tabular-nums">{j.targetHosts.length}대</span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <StatusPill status={j.last.status} />
                      <span className="text-muted text-[12px] tabular-nums">
                        <span title={stamp(j.last.at)}>{since(j.last.at, j.last.time)}</span> · {j.last.duration}
                      </span>
                    </div>
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="inline-flex gap-1">
                      {runButton(j)}
                      {menuItems(j).length > 0 && <MoreMenu label={`${j.name} 메뉴`} items={menuItems(j)} />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.length && <Empty>아직 배포 작업이 없어요. 새 배포 작업을 만들어 보세요.</Empty>}
        </TableWrap>
      </Card>
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
                보호됨
              </Chip>
            )}
          </span>
        }
        desc={methodLine(j)}
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
                <th>실행한 사람</th>
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
                  <td className="text-muted">{r.trigger}</td>
                  <td className="font-mono">{r.tag}</td>
                  <td>{r.by}</td>
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
            ? `승인 대기 ${waiting}건이 있어요. 운영 보호 작업은 Owner나 Admin이 승인해야 실행돼요.`
            : "모든 실행의 로그는 90일 동안 보관돼요. 로그 속 비밀 값은 저장 전에 가려져요."
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
                <th>실행한 사람</th>
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
                  </td>
                  <td>
                    <Chip>{r.target || "전체"}</Chip>
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td className="text-muted">{r.trigger}</td>
                  <td className="font-mono">{r.tag}</td>
                  <td>
                    {r.by}
                    {r.decidedByName && (
                      <div className="text-[12px] text-muted">
                        {r.status === "rejected" ? "거절" : "승인"} · {r.decidedByName}
                      </div>
                    )}
                  </td>
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
