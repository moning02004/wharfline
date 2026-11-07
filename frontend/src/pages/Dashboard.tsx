import { Link, useNavigate } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Dashboard as D } from "../lib/types";
import { NewJobModal } from "../modals/NewJobModal";
import { useRun } from "../modals/RunModals";
import { BuildBadge } from "../components/BuildBadge";
import { Banner, Button, Card, CardHeader, Chip, Dot, ListItem, Loading, PageHeader, StatusPill, TableWrap } from "../components/ui";

export default function Dashboard() {
  const { data } = useApi<D>("/dashboard");
  const { openModal } = useApp();
  const { confirm, openLog } = useRun();
  const nav = useNavigate();
  if (!data) return <Loading />;
  const { stats, hostKeyAlert: alert } = data;
  const missing2fa = data.security.members - data.security.tfaUsers;

  return (
    <>
      <PageHeader title={`안녕하세요, ${data.me.name}님`} desc="오늘 배포 상태와 확인이 필요한 항목이에요.">
        <Button icon="list" onClick={() => nav("/activity")}>
          활동 기록
        </Button>
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewJobModal onClose={c} />, "md")}>
          새 배포 작업
        </Button>
      </PageHeader>

      {alert && (
        <Banner tone="warn" icon="alert" title={`${alert.name} (${alert.ip})의 호스트 키가 바뀌었어요`}>
          서버를 다시 설치한 게 아니라면 중간자 공격일 수 있어요. 확인 전까지 이 서버로의 배포는 자동으로 막혀 있어요.{" "}
          <Link to="/inventory" className="link text-fg">
            인벤토리에서 확인하기
          </Link>
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ["오늘 배포", stats.today, <span className="text-muted">성공 {stats.todayOk} · 실패 {stats.todayBad}</span>],
          ["최근 30일 성공률", stats.successRate, <span className="text-ok">지난달보다 {stats.successDelta}</span>],
          ["연결된 서버", `${stats.hostsOnline}/${stats.hostsTotal}`, <span className="text-muted">{stats.hostsTotal - stats.hostsOnline}대 응답 없음</span>],
          ["평균 배포 시간", stats.avgDuration, <span className="text-muted">최근 20회 기준</span>],
        ].map(([label, value, sub], i) => (
          <Card key={i} className="px-4 py-3.5">
            <small className="text-muted text-[12.5px] font-medium">{label}</small>
            <b className="block text-[22px] font-semibold tracking-[-0.02em] mt-0.5 tabular-nums leading-tight">{value}</b>
            <span className="text-[12.5px]">{sub}</span>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 items-start">
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

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="바로 실행" />
            {data.jobs.map((j) => (
              <ListItem
                key={j.id}
                title={j.name}
                sub={
                  <span className="font-mono text-xs">
                    {j.image.split("/").pop()}:{j.tagNow} → {j.targetLabel} ({j.targetHosts.length}대)
                  </span>
                }
              >
                <BuildBadge build={j.build} />
                <Button size="sm" icon="play" onClick={() => confirm(j)}>
                  실행
                </Button>
              </ListItem>
            ))}
          </Card>
          <Card>
            <CardHeader title="보안 상태">
              <Button size="sm" variant="ghost" onClick={() => nav("/security")}>
                설정
              </Button>
            </CardHeader>
            <ListItem icon="shield" title="2단계 인증" sub={`멤버 ${data.security.members}명 중 ${data.security.tfaUsers}명 사용 중`}>
              {missing2fa > 0 ? <Dot tone="warn">{missing2fa}명 미설정</Dot> : <Dot tone="ok">모두 사용</Dot>}
            </ListItem>
            <ListItem icon="alert" title="로그인 실패 2회" sub="45.148.10.77 · 자동 차단됨">
              <Dot tone="bad">차단</Dot>
            </ListItem>
            <ListItem icon="key" title="오래된 RSA 키" sub="legacy-rsa · 41일 동안 사용 안 함">
              <Chip>정리 권장</Chip>
            </ListItem>
          </Card>
        </div>
      </div>
    </>
  );
}
