import { Link, useNavigate } from "react-router-dom";
import { useApi, useApp } from "../lib/app";
import type { Dashboard as D } from "../lib/types";
import { NewJobModal } from "../modals/NewJobModal";
import { useRun } from "../modals/RunModals";
import { Icon } from "../components/Icon";
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

      <button
        type="button"
        onClick={() => nav("/setup")}
        className="group flex items-center gap-4 text-left p-5 rounded-[20px] bg-gradient-to-r from-primary-soft to-surface shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all duration-300 ease-(--ease-soft)"
      >
        <span className="grid place-items-center size-11 rounded-2xl bg-primary text-primary-fg flex-none">
          <Icon name="wand" className="size-5" />
        </span>
        <span className="flex-1 min-w-0">
          <b className="block text-[15px] font-semibold">배포 마법사로 시작하기</b>
          <span className="text-muted text-[13px]">SSH 키 → 서버 → 이미지 → .env 순서로 등록하면 배포 작업이 만들어지고 바로 시작할 수 있어요. 단계마다 매뉴얼이 있어요.</span>
        </span>
        <Icon name="arrow" className="size-5 text-primary transition-transform group-hover:translate-x-1" />
      </button>

      {alert && (
        <Banner tone="warn" icon="alert" title={`${alert.name} (${alert.ip})의 호스트 키가 바뀌었어요`}>
          서버를 다시 설치한 게 아니라면 중간자 공격일 수 있어요. 확인 전까지 이 서버로의 배포는 자동으로 막혀 있어요.{" "}
          <Link to="/inventory" className="link text-fg">
            인벤토리에서 확인하기
          </Link>
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {[
          ["오늘 배포", stats.today, <span className="text-muted">성공 {stats.todayOk} · 실패 {stats.todayBad}</span>],
          ["최근 30일 성공률", stats.successRate, <span className="text-ok">지난달보다 {stats.successDelta}</span>],
          ["연결된 서버", `${stats.hostsOnline}/${stats.hostsTotal}`, <span className="text-muted">{stats.hostsTotal - stats.hostsOnline}대 응답 없음</span>],
          ["평균 배포 시간", stats.avgDuration, <span className="text-muted">최근 20회 기준</span>],
        ].map(([label, value, sub], i) => (
          <Card key={i} hover className="px-5 py-[18px]">
            <small className="text-muted text-[12.5px] font-medium">{label}</small>
            <b className="block text-[28px] font-semibold tracking-[-0.03em] mt-1 mb-0.5 tabular-nums leading-tight">{value}</b>
            <span className="text-[12.5px]">{sub}</span>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 items-start">
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
