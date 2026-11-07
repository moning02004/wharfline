import { Fragment, useState } from "react";
import { useApi, useApp } from "../lib/app";
import type { Job, Run } from "../lib/types";
import { NewJobModal } from "../modals/NewJobModal";
import { MethodLine, useRun } from "../modals/RunModals";
import { Icon } from "../components/Icon";
import { Button, Card, Chip, Empty, KV, Loading, PageHeader, StatusPill, TableWrap, cx } from "../components/ui";

export function Jobs() {
  const { data } = useApi<Job[]>("/jobs");
  const { openModal, toast } = useApp();
  const { confirm } = useRun();
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader
        title="배포 작업"
        desc="도커 이미지, 배포 방식, 서버 그룹, 환경 변수를 묶은 실행 단위예요. 행을 누르면 자세한 설정이 보여요."
      >
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewJobModal onClose={c} />, "md")}>
          새 배포 작업
        </Button>
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
                        <div className="pl-[22px] text-[12px] text-muted">{j.method === "compose" ? "Docker Compose" : "Ansible 플레이북"}</div>
                      </td>
                      <td>
                        <span className="font-mono text-[12.5px]">
                          {j.image.split("/").pop()}:{j.tagNow}
                        </span>
                        {newer && (
                          <span className="ml-2">
                            <Chip tone="accent" mono>
                              ↑ {j.latestTag}
                            </Chip>
                          </span>
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
                          {j.prevTag && (
                            <Button size="sm" variant="ghost" icon="undo" title={`${j.prevTag}로 되돌리기`} onClick={() => confirm(j, { tag: j.prevTag!, rollback: true })}>
                              되돌리기
                            </Button>
                          )}
                          <Button size="sm" icon="play" onClick={() => confirm(j)}>
                            실행
                          </Button>
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5} className="!bg-surface-2 !py-3.5 !whitespace-normal">
                          <div className="pl-[22px] grid md:grid-cols-2 gap-x-10 gap-y-2 animate-fade">
                            <KV
                              items={[
                                ["이미지", j.image, "font-mono text-[12.5px]"],
                                ["배포 방식", <MethodLine job={j} />],
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
                          <div className="pl-[22px] mt-3">
                            <Button size="sm" variant="ghost" icon="edit" onClick={() => toast("편집 화면은 새 작업 만들기와 같은 양식을 써요")}>
                              편집
                            </Button>
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
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="실행 기록" desc="모든 실행의 로그는 90일 동안 보관돼요. 로그 속 비밀 값은 저장 전에 가려져요." />
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
                  <td>{r.by}</td>
                  <td className="tabular-nums text-muted">{r.duration}</td>
                  <td className="text-muted">{r.time}</td>
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
