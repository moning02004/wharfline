import { Fragment, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Job, Run } from "../lib/types";
import { CopyJobModal, EditJobModal, NewJobModal } from "../modals/NewJobModal";
import { MoreMenu, type MenuItem } from "../components/Menu";
import { ApprovalButtons, PlaybookLine, shortImage, useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { Icon } from "../components/Icon";
import { EnvLink } from "../modals/EnvModals";
import { FileHistoryModal } from "../modals/FileHistoryModal";
import { api, errMsg } from "../lib/api";
import { since, stamp } from "../lib/time";
import { ConfirmDelete } from "./Resources";
import { Button, Card, Chip, Empty, KV, Loading, PageHeader, StatusPill, TableWrap, cx } from "../components/ui";

export function Jobs() {
  // Refresh every few seconds while a CI build or a deploy is in progress.
  const [poll, setPoll] = useState(0);
  const { data } = useApi<Job[]>("/jobs", poll);
  useEffect(() => {
    setPoll(data?.some((j) => j.build?.active || j.last.status === "run") ? 3000 : 0);
  }, [data]);
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
  const tracksImage = (j: Job) => !!j.image || (j.extraImages ?? []).length > 0;
  const menuItems = (j: Job): MenuItem[] => [
    ...(j.canEdit ? [{ label: "편집", icon: "edit" as const, onClick: () => openModal((c) => <EditJobModal job={j} onClose={c} />, "md") }] : []),
    ...(can("run") && j.prevTag && j.prevTag !== j.tagNow
      ? [{ label: `이전 버전으로 되돌리기 (${j.prevTag})`, icon: "undo" as const, onClick: () => confirm(j, { tag: j.prevTag!, rollback: true }) }]
      : []),
    ...(j.canEdit && can("run_protected") && tracksImage(j)
      ? [{ label: j.hook ? "자동 배포 끄기" : "자동 배포 켜기", icon: "refresh" as const, onClick: () => toggleHook(j) }]
      : []),
    { label: "실행 기록", icon: "history" as const, onClick: () => nav(`/runs?job=${encodeURIComponent(j.id)}`) },
    ...(can("job_create") ? [{ label: "복제", icon: "copy" as const, onClick: () => openModal((c) => <CopyJobModal job={j} onClose={c} />, "md") }] : []),
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
          })
        }
      >
        <span className="font-medium">{j.name}</span>을(를) Wharfline에서 지워요. 서버에서 돌고 있는 컨테이너와 파일은 그대로이고, 실행 기록과 환경 변수도 남아요.
      </ConfirmDelete>
    ));
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader
        title="배포 작업"
        desc="플레이북, 서버 그룹, 도커 이미지, 환경 변수를 묶은 실행 단위예요. 행을 누르면 자세한 설정이 보여요."
      >
        {can("job_create") && (
          <>
            <Button icon="wand" onClick={() => openModal((c) => <NewJobModal onClose={c} guide />, "md")}>
              배포를 도와드릴까요?
            </Button>
            <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewJobModal onClose={c} />, "md")}>
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
              {data.map((j) => {
                const expanded = open === j.id;
                const newer = j.latestTag && j.latestTag !== j.tagNow;
                return (
                  <Fragment key={j.id}>
                    <tr className="click" onClick={() => setOpen(expanded ? null : j.id)} aria-expanded={expanded}>
                      <td>
                        <div className="flex items-center gap-2">
                          <Icon name="chev" className={cx("size-3.5 text-faint transition-transform", expanded ? "" : "-rotate-90")} />
                          <span className="font-medium">{j.name}</span>
                          {j.protected && (
                            <Chip tone="warn" icon="lock">
                              보호됨
                            </Chip>
                          )}
                        </div>
                        <div className="pl-[22px] text-[12px] text-muted truncate max-w-[320px]">
                          {j.playbook.kind === "builtin" ? (
                            "기본 플레이북"
                          ) : j.playbook.kind === "script" ? (
                            j.playbook.path
                          ) : (
                            <>
                              {j.playbook.repo} · <span className="font-mono">{j.playbook.path}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
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
                          {can("run") && (
                            <Button size="sm" icon={j.protected && !can("run_protected") ? "lock" : "play"} onClick={() => confirm(j)}>
                              {j.protected && !can("run_protected") ? "승인 요청" : "실행"}
                            </Button>
                          )}
                          {menuItems(j).length > 0 && <MoreMenu label={`${j.name} 메뉴`} items={menuItems(j)} />}
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5} className="!bg-surface-2 !py-3.5 !whitespace-normal">
                          <div className="pl-[22px] grid grid-cols-[minmax(0,1fr)] md:grid-cols-2 gap-x-10 gap-y-2 animate-fade">
                            <KV
                              items={[
                                ["이미지", j.image ?? <span className="text-faint">없음</span>, "font-mono text-[12.5px]"],
                                ["배포 방법", <PlaybookLine job={j} />],
                                ...(j.filesVer
                                  ? ([
                                      [
                                        "파일",
                                        <span className="inline-flex items-center gap-2">
                                          <span className="font-mono text-[12.5px]">v{j.filesVer}</span>
                                          <span className="text-muted">{j.files.length}개</span>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            icon="history"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              openModal((c) => <FileHistoryModal jobId={j.id} jobName={j.name} onClose={c} />, "wide");
                                            }}
                                          >
                                            기록
                                          </Button>
                                        </span>,
                                      ],
                                    ] as [string, React.ReactNode][])
                                  : []),
                                ["환경 변수", j.env ? <EnvLink name={j.env} /> : <span className="text-faint">없음</span>],
                              ]}
                            />
                            <KV
                              items={[
                                ["서버", <span className="font-mono text-[12.5px]">{j.targetHosts.map((h) => h.ip).join(", ")}</span>],
                                ["자동 배포", j.hook ? "새 태그가 올라오면 바로 배포" : <span className="text-muted">수동 실행만</span>],
                                ["안전장치", [j.protected && "실행 전 확인", j.lock && "동시 실행 금지", j.rollback && "실패 시 롤백"].filter(Boolean).join(" · ") || "없음", "text-muted"],
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!data.length && <Empty>아직 배포 작업이 없어요. 새 배포 작업을 만들어 보세요.</Empty>}
        </TableWrap>
      </Card>
    </>
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
                  <td>{r.job}</td>
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
                  <td className="text-muted" title={stamp(r.at)}>{since(r.at, r.time)}</td>
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
