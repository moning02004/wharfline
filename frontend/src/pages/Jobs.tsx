import { useApi, useApp } from "../lib/app";
import type { Job, Run } from "../lib/types";
import { NewJobModal } from "../modals/NewJobModal";
import { MethodLine, useRun } from "../modals/RunModals";
import { Button, Card, Chip, Empty, KV, Loading, PageHeader, StatusPill, TableWrap } from "../components/ui";

export function Jobs() {
  const { data } = useApi<Job[]>("/jobs");
  const { openModal, toast } = useApp();
  const { confirm } = useRun();
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader
        title="배포 작업"
        desc="도커 이미지, Ansible 플레이북, 서버 그룹, 환경 변수를 묶은 실행 단위예요. 실행할 때 이미지 태그를 고르고, 로그는 실시간으로 보여요."
      >
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewJobModal onClose={c} />, "md")}>
          새 배포 작업
        </Button>
      </PageHeader>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4">
        {data.map((j) => (
          <Card key={j.id} hover className="flex flex-col">
            <div className="p-5 flex flex-col gap-4 flex-1">
              <h3 className="m-0 text-[15px] font-semibold tracking-[-0.015em] flex items-center gap-2 flex-wrap">
                {j.name}
                {j.protected && (
                  <Chip tone="warn" icon="lock">
                    보호됨
                  </Chip>
                )}
              </h3>
              <KV
                items={[
                  ["이미지", j.image, "font-mono text-[12.5px]"],
                  [
                    "현재 버전",
                    <>
                      <span className="font-mono">{j.tagNow}</span> <span className="text-muted">· 최신 {j.latestTag ?? "-"}</span>
                    </>,
                  ],
                  ["배포 방식", <MethodLine job={j} />],
                  [
                    "인벤토리",
                    <>
                      {j.inventory} <span className="text-muted">· 서버 {j.inventoryHostCount}대</span>
                    </>,
                  ],
                  [
                    "배포 대상",
                    <>
                      <Chip tone="accent" mono>
                        {j.targetLabel}
                      </Chip>{" "}
                      <span className="font-mono text-muted text-[12.5px]">{j.targetHosts.map((h) => h.ip).join(", ")}</span>
                    </>,
                  ],
                  ["환경 변수", j.env, "font-mono text-[12.5px]"],
                  ["자동 배포", j.hook ? "새 이미지 태그가 올라오면 바로 배포" : <span className="text-muted">수동 실행만</span>],
                  ["안전장치", [j.protected && "실행 전 확인", j.lock && "동시 실행 금지", j.rollback && "실패 시 롤백"].filter(Boolean).join(" · ") || "없음", "text-muted"],
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-line flex-wrap">
              <span className="flex items-center gap-2">
                <StatusPill status={j.last.status} />
                <span className="text-muted text-xs">
                  {j.last.time} · {j.last.duration}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => toast("편집 화면은 새 작업 만들기와 같은 양식을 써요")}>
                  편집
                </Button>
                {j.prevTag && (
                  <Button size="sm" icon="undo" title={`${j.prevTag}로 되돌리기`} onClick={() => confirm(j, { tag: j.prevTag!, rollback: true })}>
                    되돌리기
                  </Button>
                )}
                <Button size="sm" variant="primary" icon="play" onClick={() => confirm(j)}>
                  실행
                </Button>
              </span>
            </div>
          </Card>
        ))}
      </div>
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
