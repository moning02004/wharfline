import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import { ROLES, ROUTES, useApi, useApp } from "../lib/app";
import type { Activity as Act, Group, Login, Member, Policy, Role, Session } from "../lib/types";
import { CodesModal, TfaSetupModal } from "../modals/SecurityModals";
import { buildsLabel, DeleteGroupModal, GroupModal, MemberGroupsModal } from "../modals/AccessModals";
import { Icon, type IconName } from "../components/Icon";
import { Button, Card, CardHeader, Check, Chip, Dot, Field, Input, ListItem, Loading, PageHeader, Seg, Select, StatusPill, Switch, TableWrap, Textarea } from "../components/ui";

/* ---------- activity ---------- */

export function Activity() {
  const [tab, setTab] = useState<"act" | "login">("act");
  const [q, setQ] = useState("");
  const act = useApi<{ chainVerified: boolean; total: number; items: Act[] }>("/activity").data;
  const logins = useApi<Login[]>(tab === "login" ? "/logins" : null).data;
  if (!act) return <Loading />;
  const match = (o: object) => !q.trim() || Object.values(o).join(" ").toLowerCase().includes(q.trim().toLowerCase());

  return (
    <>
      <PageHeader title="활동 기록" desc="누가 언제 무엇을 했는지 모두 남아요. 기록은 앞 항목의 해시를 이어 붙여 저장하므로 중간에 지우거나 고치면 드러나요.">
        <Dot tone="ok">해시 체인 검증됨 · {act.total.toLocaleString()}건</Dot>
      </PageHeader>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Seg
          options={[
            { value: "act", label: "활동" },
            { value: "login", label: "로그인 이력" },
          ]}
          value={tab}
          onChange={setTab}
        />
        <Input placeholder="사용자, 작업, IP로 찾기" className="max-w-[260px]" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card>
        <TableWrap>
          {tab === "act" ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>시간</th>
                  <th>사용자</th>
                  <th>작업</th>
                  <th>대상</th>
                  <th>IP</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {act.items.filter(match).map((a, i) => (
                  <tr key={i}>
                    <td className="font-mono">{a.time}</td>
                    <td>{a.user}</td>
                    <td>{a.action}</td>
                    <td className="text-muted">{a.object}</td>
                    <td className="font-mono">{a.ip}</td>
                    <td>
                      <StatusPill status={a.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>시간</th>
                  <th>계정</th>
                  <th>방식</th>
                  <th>IP</th>
                  <th>위치</th>
                  <th>기기</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {(logins ?? []).filter(match).map((l, i) => (
                  <tr key={i}>
                    <td>{l.time}</td>
                    <td>{l.user}</td>
                    <td className="text-muted">{l.method}</td>
                    <td className="font-mono">{l.ip}</td>
                    <td className="text-muted">{l.location}</td>
                    <td className="text-muted">{l.agent}</td>
                    <td>{l.result === "ok" ? <Dot tone="ok">성공</Dot> : l.result === "bad" ? <Dot tone="bad">실패</Dot> : <Dot tone="warn">복구 코드 사용</Dot>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      </Card>
    </>
  );
}

/* ---------- members ---------- */

const MENU_DESC: Record<string, string> = {
  dashboard: "항상 보여요", jobs: "배포 작업 목록과 실행", runs: "실행 기록과 로그", registries: "GitHub, Gitea 컨테이너 이미지",
  repos: "Ansible 플레이북 레포", inventory: "서버와 그룹", keys: "SSH 키", envs: ".env 열람과 수정", activity: "활동 기록, 로그인 이력",
  members: "멤버, 역할, 그룹", security: "내 계정 보안, 워크스페이스 정책", notes: "프로토타입 안내",
};

const PERMS: [string, ...(0 | 1 | string)[]][] = [
  ["실행 기록과 로그 보기", 1, 1, 1, 1],
  ["일반 작업 실행", 1, 1, 1, 0],
  ["보호된 작업(production) 실행", 1, 1, "승인 필요", 0],
  ["환경 변수 값 열람", 1, 1, 0, 0],
  ["키·인벤토리·레포 수정", 1, 1, 0, 0],
  ["멤버, 역할, 그룹 관리", 1, 0, 0, 0],
];

interface GroupsData {
  groups: Group[];
  repos: string[];
  menus: string[];
}

export function Members() {
  const members = useApi<Member[]>("/members").data;
  const gd = useApi<GroupsData>("/groups").data;
  const { session, setSession, viewAs, setViewAs, toast, openModal, refresh, reloadAccess } = useApp();
  if (!members || !gd) return <Loading />;

  const isOwner = session?.me.role === "Owner";
  const canEdit = isOwner && !viewAs;
  const groupById = Object.fromEntries(gd.groups.map((g) => [g.id, g]));

  const preview = (u: Member) => {
    setViewAs(u);
    document.getElementById("content")?.scrollTo({ top: 0 });
    toast(`${u.name}님 화면으로 미리 보는 중이에요`);
  };
  const changeRole = async (u: Member, role: Role) => {
    try {
      await api.put(`/members/${encodeURIComponent(u.email)}/role`, { role });
      toast(`${u.name}님의 역할을 ${role}(으)로 바꿨어요`);
      if (u.email === session?.me.email) setSession(await api.get<Session>("/auth/me"));
      refresh();
      reloadAccess();
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const toggleMenu = async (g: Group, menu: string, label: string, on: boolean) => {
    const menus = on ? [...g.menus, menu] : g.menus.filter((x) => x !== menu);
    try {
      await api.put(`/groups/${g.id}`, { name: g.name, menus, allBuilds: g.allBuilds, repos: g.repos });
      toast(`${g.name}에 "${label}" 메뉴를 ${on ? "보여줘요" : "숨겼어요"}`);
      refresh();
      reloadAccess();
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const editGroup = (g?: Group) => openModal((c) => <GroupModal group={g} repos={gd.repos} members={members} onClose={c} />, "md");

  return (
    <>
      <PageHeader title="멤버와 권한" desc="역할은 할 수 있는 일을, 그룹은 보이는 메뉴와 빌드를 정해요. 멤버는 속한 그룹들의 메뉴와 빌드를 모두 합쳐서 봐요.">
        <Button variant="primary" icon="plus" onClick={() => toast("초대 메일은 24시간 동안 유효한 일회용 링크로 보내져요")}>
          멤버 초대
        </Button>
      </PageHeader>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>이메일</th>
                <th>역할</th>
                <th>그룹</th>
                <th>2단계 인증</th>
                <th>마지막 접속</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {members.map((u) => (
                <tr key={u.email}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <span className="grid place-items-center size-7 rounded-full bg-surface-2 border border-line text-[11px] font-semibold">{u.name[0]}</span>
                      {u.name}
                      {u.email === session?.me.email && <span className="text-faint text-xs">나</span>}
                    </span>
                  </td>
                  <td className="text-muted">{u.email}</td>
                  <td>
                    {canEdit ? (
                      <Select aria-label={`${u.name} 역할`} className="w-[120px]" value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </Select>
                    ) : (
                      <Chip>{u.role}</Chip>
                    )}
                  </td>
                  <td>
                    <span className="flex items-center gap-1 flex-wrap">
                      {u.role === "Owner" ? (
                        <span className="text-faint text-xs">전체 (Owner)</span>
                      ) : u.groups.length ? (
                        u.groups.map((id) => groupById[id] && <Chip key={id}>{groupById[id].name}</Chip>)
                      ) : (
                        <Dot tone="warn">그룹 없음</Dot>
                      )}
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="edit"
                          aria-label={`${u.name} 그룹 변경`}
                          title="그룹 변경"
                          onClick={() => openModal((c) => <MemberGroupsModal member={u} groups={gd.groups} onClose={c} />)}
                        />
                      )}
                    </span>
                  </td>
                  <td>{u.tfa ? <Dot tone="ok">사용</Dot> : <Dot tone="warn">미설정 · 다음 로그인 때 강제</Dot>}</td>
                  <td className="text-muted">{u.last}</td>
                  <td className="text-right">
                    {isOwner && u.email !== session?.me.email && (
                      <Button size="sm" variant="ghost" icon="eye" onClick={() => preview(u)} disabled={viewAs?.email === u.email}>
                        미리보기
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader title="그룹" sub="그룹마다 보이는 메뉴와 볼 수 있는 빌드 레포를 정해요. 로그인하면 내 그룹에 허용된 빌드만 보여요.">
          {canEdit ? (
            <Button size="sm" icon="plus" onClick={() => editGroup()}>
              그룹 만들기
            </Button>
          ) : (
            <Chip>Owner만 수정</Chip>
          )}
        </CardHeader>
        {gd.groups.map((g) => (
          <ListItem
            key={g.id}
            icon="users"
            title={g.name}
            sub={`멤버 ${g.members.length}명${g.members.length ? ` (${g.members.map((e) => members.find((x) => x.email === e)?.name ?? e).join(", ")})` : ""} · 메뉴 ${g.menus.length}개 · ${buildsLabel(g)}`}
          >
            {canEdit && (
              <span className="flex gap-1">
                <Button size="sm" icon="edit" onClick={() => editGroup(g)}>
                  수정
                </Button>
                <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`${g.name} 삭제`} title="삭제" onClick={() => openModal((c) => <DeleteGroupModal group={g} onClose={c} />)} />
              </span>
            )}
          </ListItem>
        ))}
        {!gd.groups.length && <div className="px-5 py-6 text-center text-muted">아직 그룹이 없어요.</div>}
      </Card>

      <Card>
        <CardHeader title="그룹별 메뉴" sub="끄면 그 그룹 멤버의 메뉴에서 사라지고, 주소로 직접 들어와도 막혀요. 여러 그룹에 속한 멤버는 하나라도 켜져 있으면 보여요." />
        <TableWrap>
          <table className="tbl center">
            <thead>
              <tr>
                <th>메뉴</th>
                <th>
                  <div>Owner</div>
                  <span className="text-faint text-[11px] font-normal">항상 전체</span>
                </th>
                {gd.groups.map((g) => (
                  <th key={g.id}>
                    <div>{g.name}</div>
                    <span className="text-faint text-[11px] font-normal">멤버 {g.members.length}명</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <span className="grid place-items-center size-8 rounded-md bg-surface-2 text-muted">
                        <Icon name={r.icon as IconName} />
                      </span>
                      <div>
                        <div className="font-medium">{r.label}</div>
                        <div className="text-faint text-xs">{MENU_DESC[r.id]}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="inline-flex text-faint" title="바꿀 수 없어요">
                      <Icon name="lock" />
                    </span>
                  </td>
                  {gd.groups.map((g) => (
                    <td key={g.id}>
                      {r.id === "dashboard" ? (
                        <span className="inline-flex text-faint" title="바꿀 수 없어요">
                          <Icon name="lock" />
                        </span>
                      ) : (
                        <span className="inline-flex">
                          <Switch label={`${g.name} · ${r.label}`} checked={g.menus.includes(r.id)} disabled={!canEdit} onChange={(v) => toggleMenu(g, r.id, r.label, v)} />
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader title="역할별 작업 권한" sub="역할은 할 수 있는 일만 정해요. 무엇이 보이는지는 그룹이 정해요." />
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>할 수 있는 일</th>
                {ROLES.map((r) => (
                  <th key={r}>{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMS.map(([label, ...vals]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {vals.map((v, i) => (
                    <td key={i}>
                      {v === 1 ? (
                        <span className="text-ok">
                          <Icon name="check" />
                        </span>
                      ) : v === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Chip tone="warn">{v}</Chip>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

/* ---------- security ---------- */

export function Security() {
  const data = useApi<{ sessions: { agent: string; ip: string; location: string; time: string; current: boolean }[]; policy: Policy }>("/security").data;
  const { toast, withSudo, openModal, setSession, session, refresh } = useApp();
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => {
    if (data && !p) setP(data.policy);
  }, [data, p]);
  if (!data || !p) return <Loading />;

  const save = async () => {
    try {
      const r = await api.put<Policy>("/security/policy", p);
      setP(r);
      if (session) setSession({ ...session, sudoMinutes: r.sudoMinutes });
      refresh();
      toast("정책을 저장했어요. 활동 기록에 남았어요.");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  return (
    <>
      <PageHeader title="보안" desc="내 계정 보호 수단과 워크스페이스 보안 정책이에요." />
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 items-start">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="2단계 인증">
              <Dot tone="ok">사용 중</Dot>
            </CardHeader>
            <ListItem icon="shield" title="인증 앱 (TOTP)" sub="2026-09-14에 등록 · Google Authenticator, 1Password 등">
              <Button
                size="sm"
                onClick={() =>
                  withSudo("2단계 인증 다시 설정", async () => {
                    const r = await api.post<{ secret: string }>("/security/tfa");
                    openModal((c) => <TfaSetupModal secret={r.secret} onClose={c} />);
                  })
                }
              >
                다시 설정
              </Button>
            </ListItem>
            <ListItem icon="key" title="복구 코드" sub="10개 중 9개 남음 · 어제 1개 사용">
              <Button
                size="sm"
                onClick={() =>
                  withSudo("복구 코드 새로 발급", async () => {
                    const r = await api.post<{ codes: string[] }>("/security/codes");
                    openModal((c) => <CodesModal codes={r.codes} onClose={c} />);
                  })
                }
              >
                새로 발급
              </Button>
            </ListItem>
            <ListItem icon="lock" title="패스키 (WebAuthn)" sub="지문, Face ID, 보안 키로 로그인">
              <Button size="sm" onClick={() => toast("패스키 등록은 브라우저 인증 창으로 진행돼요")}>
                추가
              </Button>
            </ListItem>
          </Card>
          <Card>
            <CardHeader title="로그인된 기기">
              <Button size="sm" variant="danger" onClick={() => toast("현재 기기를 제외한 세션을 모두 끊었어요")}>
                다른 기기 모두 로그아웃
              </Button>
            </CardHeader>
            {data.sessions.map((s) => (
              <ListItem key={s.agent} title={s.agent} sub={`${s.ip} · ${s.location} · ${s.time}`}>
                {s.current ? (
                  <Dot tone="ok">이 기기</Dot>
                ) : (
                  <Button size="sm" onClick={() => toast("세션을 끊었어요")}>
                    로그아웃
                  </Button>
                )}
              </ListItem>
            ))}
          </Card>
        </div>
        <Card>
          <CardHeader title="워크스페이스 정책">
            <Chip>Owner만 수정</Chip>
          </CardHeader>
          <div className="p-5 flex flex-col gap-4">
            <Check
              checked={p.enforce2fa}
              onChange={(v) => setP({ ...p, enforce2fa: v })}
              title="모든 멤버에게 2단계 인증 강제"
              desc="설정하지 않은 멤버는 로그인 직후 설정 화면으로 이동해요."
            />
            <Field label="민감 정보 열람 유지 시간" htmlFor="p2" hint="비밀번호 재확인 후 환경 변수 열람, 키 추가·삭제를 다시 묻지 않는 시간이에요.">
              <Select id="p2" value={p.sudoMinutes} onChange={(e) => setP({ ...p, sudoMinutes: +e.target.value })}>
                {[1, 5, 10, 15].map((m) => (
                  <option key={m} value={m}>
                    {m}분
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="세션 만료" htmlFor="p3">
              <Select id="p3" value={p.session} onChange={(e) => setP({ ...p, session: e.target.value })}>
                <option>8시간 (활동 없으면 30분)</option>
                <option>12시간 (활동 없으면 1시간)</option>
              </Select>
            </Field>
            <Field label="로그인 실패 잠금" htmlFor="p4">
              <Select id="p4" value={p.lockout} onChange={(e) => setP({ ...p, lockout: e.target.value })}>
                <option>5회 실패 시 15분 잠금</option>
                <option>10회 실패 시 1시간 잠금</option>
              </Select>
            </Field>
            <Field label="접속 허용 IP (선택)" htmlFor="p5" hint="한 줄에 하나씩 CIDR로 적어요. 내 IP가 빠지면 저장되지 않아요.">
              <Textarea id="p5" rows={3} placeholder="비워 두면 모든 IP 허용" value={p.allowIps} onChange={(e) => setP({ ...p, allowIps: e.target.value })} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" onClick={save}>
                저장
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
