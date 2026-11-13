import { useNavigate } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Dashboard as D, DashboardAlert } from "../lib/types";
import type { IconName } from "../components/Icon";
import { since, stamp } from "../lib/time";
import { ApprovalButtons, shortImage, useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { AddJobModal } from "./Jobs";
import { Button, Byline, Card, CardHeader, Chip, Dot, ListItem, Loading, PageHeader, StatusPill, TableWrap } from "../components/ui";

const ALERT_ICON: Record<DashboardAlert["kind"], IconName> = {
  hostKey: "alert",
  failed: "x",
  approval: "lock",
  offline: "server",
  tfa: "shield",
};

/** Dashboard: 바로 실행 on top, then 최근 실행 | 알림. */
export default function Dashboard() {
  const { data } = useApi<D>("/dashboard");
  const { can, openModal } = useApp();
  const { confirm, openLog } = useRun();
  const nav = useNavigate();
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader title={`안녕하세요, ${data.me.name}님`}>
        {can("job_create") && (
          <Button variant="primary" icon="plus" onClick={() => openModal((c) => <AddJobModal onClose={c} />)}>
            작업 추가
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardHeader title="바로 실행">
          <Button size="sm" variant="ghost" onClick={() => nav("/jobs")}>
            배포 작업 보기
          </Button>
        </CardHeader>
        {data.jobs.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-4">
            {data.jobs.map((j) => (
              <div key={j.id} className="flex flex-col gap-2.5 p-3.5 rounded-2xl bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] min-w-0">
                <div className="min-w-0">
                  <b className="block text-[14px] font-semibold truncate" title={j.name}>
                    {j.name}
                  </b>
                  <span className="block mt-0.5 font-mono text-[11.5px] text-muted truncate" title={`${shortImage(j) ?? j.playbook.path} → ${j.targetLabel}`}>
                    {shortImage(j) ?? j.playbook.path} → {j.targetLabel} ({j.targetHosts.length}대)
                  </span>
                </div>
                {(j.build || (j.extraImages ?? []).some((x) => x.build)) && (
                  <span className="flex flex-wrap gap-1">
                    <BuildBadge build={j.build} />
                    {(j.extraImages ?? []).map((x) => (x.build ? <BuildBadge key={x.var || x.ref} build={x.build} /> : null))}
                  </span>
                )}
                {can("run") && (
                  <Button size="sm" className="mt-auto self-start" icon={j.protected && !can("run_protected") ? "lock" : "play"} onClick={() => confirm(j)}>
                    {j.protected && !can("run_protected") ? "승인 요청" : "실행"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 px-4 py-6 text-center text-muted">아직 배포 작업이 없어요.</p>
        )}
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 items-start">
        <Card>
          <CardHeader title="최근 실행">
            <Button size="sm" variant="ghost" onClick={() => nav("/runs")}>
              전체 보기
            </Button>
          </CardHeader>
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>실행</th>
                  <th>작업</th>
                  <th>상태</th>
                  <th>시간</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRuns.map((r) => (
                  <tr key={r.no} className="click" onClick={() => openLog(r.no)}>
                    <td className="font-mono">#{r.no}</td>
                    <td>
                      {r.job}
                      <Byline label="실행" name={r.by} />
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="text-muted" title={stamp(r.at)}>{since(r.at, r.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card>
          {/* min-h: as tall as 최근 실행's header, which has a button */}
          <CardHeader title="알림" className="min-h-[57px]">
            {data.alertsMore > 0 && <Chip>+{data.alertsMore}</Chip>}
          </CardHeader>
          {data.alerts.length ? (
            data.alerts.map((a) => {
              const open = () => (a.run ? openLog(a.run) : a.to && nav(a.to));
              return (
                <ListItem
                  key={`${a.kind}-${a.run ?? a.title}`}
                  icon={ALERT_ICON[a.kind]}
                  title={
                    <button type="button" className="text-left hover:underline" onClick={open}>
                      {a.title}
                    </button>
                  }
                  sub={a.sub}
                >
                  {a.kind === "approval" && a.run && can("approve") ? (
                    <ApprovalButtons no={a.run} />
                  ) : a.run ? (
                    <Button size="sm" variant="ghost" onClick={open}>
                      로그
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={open}>
                      확인
                    </Button>
                  )}
                </ListItem>
              );
            })
          ) : (
            <p className="m-0 px-4 py-6 text-center text-muted">
              <Dot tone="ok">확인할 것이 없어요</Dot>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
