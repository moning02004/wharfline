import { useNavigate } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Dashboard as D } from "../lib/types";
import { NewJobModal } from "../modals/NewJobModal";
import { shortImage, useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { Button, Card, CardHeader, Chip, Dot, ListItem, Loading, PageHeader, StatusPill, TableWrap } from "../components/ui";

/** Dashboard: 바로 실행 on top, then 최근 실행 | 알림. */
export default function Dashboard() {
  const { data } = useApi<D>("/dashboard");
  const { openModal } = useApp();
  const { confirm, openLog } = useRun();
  const nav = useNavigate();
  if (!data) return <Loading />;
  const alert = data.hostKeyAlert;
  const missing2fa = data.security.members - data.security.tfaUsers;

  return (
    <>
      <PageHeader title={`안녕하세요, ${data.me.name}님`}>
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewJobModal onClose={c} />, "md")}>
          새 배포 작업
        </Button>
      </PageHeader>

      <Card>
        <CardHeader title="바로 실행">
          <Button size="sm" variant="ghost" onClick={() => nav("/jobs")}>
            배포 작업 보기
          </Button>
        </CardHeader>
        {data.jobs.length ? (
          <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
            {data.jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{j.name}</div>
                  <div className="font-mono text-[11.5px] text-muted truncate">
                    {shortImage(j) ?? j.playbook.path} → {j.targetLabel} ({j.targetHosts.length}대)
                  </div>
                  {j.build && (
                    <div className="mt-1.5">
                      <BuildBadge build={j.build} />
                    </div>
                  )}
                </div>
                <Button size="sm" icon="play" onClick={() => confirm(j)}>
                  실행
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 px-4 py-6 text-center text-muted">아직 배포 작업이 없어요. 새 배포 작업을 만들어 보세요.</p>
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
                  <th>실행한 사람</th>
                  <th>시간</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRuns.map((r) => (
                  <tr key={r.no} className="click" onClick={() => openLog(r.no)}>
                    <td className="font-mono">#{r.no}</td>
                    <td>{r.job}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="text-muted">{r.by}</td>
                    <td className="text-muted">{r.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card>
          <CardHeader title="알림" />
          {alert && (
            <ListItem icon="alert" title={`${alert.name}의 호스트 키가 바뀌었어요`} sub={`${alert.ip} · 확인 전까지 이 서버로의 배포는 막혀 있어요`}>
              <Button size="sm" variant="ghost" onClick={() => nav("/inventory")}>
                확인
              </Button>
            </ListItem>
          )}
          <ListItem icon="shield" title="2단계 인증" sub={`멤버 ${data.security.members}명 중 ${data.security.tfaUsers}명 사용 중`}>
            {missing2fa > 0 ? <Dot tone="warn">{missing2fa}명 미설정</Dot> : <Dot tone="ok">모두 사용</Dot>}
          </ListItem>
          <ListItem icon="lock" title="로그인 실패 2회" sub="45.148.10.77 · 자동 차단됨">
            <Dot tone="bad">차단</Dot>
          </ListItem>
          <ListItem icon="key" title="오래된 RSA 키" sub="legacy-rsa · 41일 동안 사용 안 함">
            <Chip>정리 권장</Chip>
          </ListItem>
        </Card>
      </div>
    </>
  );
}
