import { Fragment, useEffect, useState } from "react";
import { useApi, useApp } from "../lib/app";
import type { Job, Run } from "../lib/types";
import { EditJobModal, NewJobModal } from "../modals/NewJobModal";
import { ApprovalButtons, PlaybookLine, shortImage, useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { Icon } from "../components/Icon";
import { FileHistoryModal } from "../modals/FileHistoryModal";
import { Button, Card, Chip, Empty, KV, Loading, PageHeader, StatusPill, TableWrap, cx } from "../components/ui";

export function Jobs() {
  // Refresh every few seconds while a CI build or a deploy is in progress.
  const [poll, setPoll] = useState(0);
  const { data } = useApi<Job[]>("/jobs", poll);
  useEffect(() => {
    setPoll(data?.some((j) => j.build?.active || j.last.status === "run") ? 3000 : 0);
  }, [data]);
  const { openModal, can } = useApp();
  const { confirm } = useRun();
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
                            {(j.extraImages ?? []).map((x) => (x.build ? <BuildBadge key={x.var} build={x.build} /> : null))}
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
                            {j.last.time} · {j.last.duration}
                          </span>
                        </div>
                      </td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <span className="inline-flex gap-1">
                          {j.canEdit && (
                            <Button size="sm" variant="ghost" icon="edit" onClick={() => openModal((c) => <EditJobModal job={j} onClose={c} />, "md")}>
                              편집
                            </Button>
                          )}
                          {can("run") && (
                            <Button size="sm" icon={j.protected && !can("run_protected") ? "lock" : "play"} onClick={() => confirm(j)}>
                              {j.protected && !can("run_protected") ? "승인 요청" : "실행"}
                            </Button>
                          )}
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
                                ["환경 변수", j.env || <span className="text-faint">없음</span>, "font-mono text-[12.5px]"],
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
  const { data } = useApi<Run[]>("/runs");
  const { openLog } = useRun();
  const { can } = useApp();
  if (!data) return <Loading />;
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
                  <td className="text-muted">{r.time}</td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.status === "approval" && can("approve") && <ApprovalButtons no={r.no} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.length && <Empty>아직 실행 기록이 없어요.</Empty>}
        </TableWrap>
      </Card>
    </>
  );
}
