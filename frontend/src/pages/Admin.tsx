import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import { ROLES, useApi, useApp } from "../lib/app";
import type { Activity as Act, DeviceSession, Group, Login, Member, Policy, Role, Session } from "../lib/types";
import { CodesModal, DisableTfaModal, PasswordModal, ResetPasswordModal, TfaSetupModal } from "../modals/SecurityModals";
import { draftOf, effectiveAccess, GroupDetail, GroupModal, GroupPicker } from "../modals/AccessModals";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Button, Card, CardHeader, Check, Chip, cx, Dot, Field, Input, ListItem, Loading, PageHeader, Seg, Select, StatusPill, TableWrap, Textarea } from "../components/ui";

/* ---------- activity ---------- */

export function Activity() {
  const [tab, setTab] = useState<"act" | "login">("act");
  const [q, setQ] = useState("");
  const act = useApi<{ total: number; items: Act[] }>("/activity").data;
  const logins = useApi<Login[]>(tab === "login" ? "/logins" : null).data;
  if (!act) return <Loading />;
  const match = (o: object) => !q.trim() || Object.values(o).join(" ").toLowerCase().includes(q.trim().toLowerCase());

  return (
    <>
      <PageHeader title="활동 기록" desc="누가 언제 무엇을 했는지 모두 남아요. 기록은 앞 항목의 해시를 이어 붙여 저장하므로 중간에 지우거나 고치면 드러나요.">
        <Dot>기록 {act.total.toLocaleString()}건</Dot>
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

/** Same as the server's role rules (docs/security-hardening.md, B). */
const PERMS: [string, ...(0 | 1 | string)[]][] = [
  ["보기(목록, 실행 기록, 로그)", 1, 1, 1, 1],
  ["일반 작업 실행, 실행 취소", 1, 1, 1, 0],
  ["운영 보호 작업 실행", 1, 1, "승인 요청", 0],
  ["배포 작업 만들기", 1, 1, "운영 보호 켜짐·자동 배포 꺼짐", 0],
  ["배포 작업 편집", 1, 1, "편집 권한이 있을 때만 · 운영 보호·자동 배포 제외", 0],
  ["실행 승인/거절", 1, 1, 0, 0],
  ["환경 변수 값 보기·바꾸기", 1, 1, 0, 0],
  ["키·인벤토리·서버·레지스트리·이미지·Git 연동 설정", 1, 1, 0, 0],
  ["멤버, 그룹, 보안 정책", 1, 0, 0, 0],
];

interface GroupsData {
  groups: Group[];
  repos: string[];
  menus: string[];
}

type AccessTab = "members" | "groups" | "roles";

export function Members() {
  const members = useApi<Member[]>("/members").data;
  const gd = useApi<GroupsData>("/groups").data;
  const { session, viewAs, openModal } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (["members", "groups", "roles"].includes(params.get("tab") ?? "") ? params.get("tab") : "members") as AccessTab;
  const [selected, setSelected] = useState<string | null>(null);
  if (!members || !gd) return <Loading />;

  const canEdit = session?.me.role === "Owner" && !viewAs;
  const setTab = (t: AccessTab) => setParams(t === "members" ? {} : { tab: t }, { replace: true });
  const newGroup = () =>
    openModal(
      (c) => (
        <GroupModal
          repos={gd.repos}
          members={members}
          onClose={c}
          onCreated={(g) => {
            setSelected(g.id);
            setTab("groups");
          }}
        />
      ),
      "md",
    );

  const tabs: { id: AccessTab; label: string; count?: number }[] = [
    { id: "members", label: "멤버", count: members.length },
    { id: "groups", label: "그룹", count: gd.groups.length },
    { id: "roles", label: "역할 권한" },
  ];

  return (
    <>
      <PageHeader title="멤버와 권한" desc="역할은 할 수 있는 일을, 그룹은 보이는 메뉴와 빌드를 정해요. 한 멤버가 여러 그룹에 속하면 그 그룹들의 메뉴와 빌드를 모두 합쳐서 봐요.">
        {tab === "groups" && canEdit ? (
          <Button variant="primary" icon="plus" onClick={newGroup}>
            그룹 만들기
          </Button>
        ) : tab === "members" ? (
          <Button variant="primary" icon="plus" onClick={() => openModal((c) => <InviteNote onClose={c} />)}>
            멤버 초대
          </Button>
        ) : null}
      </PageHeader>

      <div role="tablist" aria-label="멤버와 권한" className="flex gap-1 border-b border-line -mt-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              "h-10 px-3 -mb-px inline-flex items-center gap-1.5 text-[13.5px] transition-colors",
              tab === t.id ? "text-fg font-semibold shadow-[inset_0_-2px_0_var(--primary)]" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cx("text-[11px] tabular-nums px-1.5 rounded-full", tab === t.id ? "bg-primary-soft text-primary" : "bg-hover text-faint")}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "members" && <MembersTab members={members} groups={gd.groups} canEdit={canEdit} />}
      {tab === "groups" && (
        <GroupsTab members={members} gd={gd} canEdit={canEdit} selected={selected ?? gd.groups[0]?.id ?? null} onSelect={setSelected} onNew={newGroup} />
      )}
      {tab === "roles" && <RolesTab />}
    </>
  );
}

function InviteNote({ onClose }: { onClose: () => void }) {
  return (
    <>
      <ModalHead title="멤버 초대" sub="초대 메일은 24시간 동안 유효한 일회용 링크로 보내져요." onClose={onClose} />
      <ModalBody>
        <p className="m-0 text-muted">초대한 멤버는 처음 로그인할 때 2단계 인증을 설정하고, 여기서 역할과 그룹을 정해 주면 돼요.</p>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          확인
        </Button>
      </ModalFoot>
    </>
  );
}

function MembersTab({ members, groups, canEdit }: { members: Member[]; groups: Group[]; canEdit: boolean }) {
  const { session, setSession, viewAs, setViewAs, toast, refresh, reloadAccess, openModal } = useApp();
  const [q, setQ] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const isOwner = session?.me.role === "Owner";

  const shown = members.filter((u) => {
    const text = `${u.name} ${u.email} ${u.role} ${groups.filter((g) => u.groups.includes(g.id)).map((g) => g.name).join(" ")}`.toLowerCase();
    return (!q.trim() || text.includes(q.trim().toLowerCase())) && (!groupFilter || u.groups.includes(groupFilter));
  });

  const preview = (u: Member) => {
    setViewAs(u);
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

  return (
    <Card className="!overflow-visible">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-wrap">
        <Input placeholder="이름, 이메일, 그룹으로 찾기" aria-label="멤버 찾기" className="max-w-[260px]" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="그룹으로 거르기" className="w-[180px]" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="">모든 그룹</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-[12px] text-faint">{canEdit ? "그룹 칸을 누르면 여러 그룹을 고를 수 있어요" : "Owner만 바꿀 수 있어요"}</span>
      </div>
      {/* scrolls sideways on phones; on wider screens it stays visible so the group picker is never clipped */}
      <div className="relative overflow-x-auto md:overflow-visible">
      <table className="tbl">
        <thead>
          <tr>
            <th>멤버</th>
            <th>역할</th>
            <th>그룹</th>
            <th>보이는 것</th>
            <th>2단계 인증</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {shown.map((u) => {
            const eff = effectiveAccess(u, groups);
            return (
              <tr key={u.email}>
                <td>
                  <span className="flex items-center gap-2.5">
                    <span className="grid place-items-center size-8 rounded-full bg-primary-soft text-primary text-[12px] font-semibold flex-none">{u.name[0]}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium">
                        {u.name}
                        {u.email === session?.me.email && <span className="text-[10.5px] text-faint border border-line rounded px-1">나</span>}
                      </span>
                      <span className="block text-[12px] text-muted">
                        {u.email} · {u.last}
                      </span>
                    </span>
                  </span>
                </td>
                <td>
                  {canEdit ? (
                    <Select aria-label={`${u.name} 역할`} className="w-[118px]" value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                      {ROLES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                  ) : (
                    <Chip>{u.role}</Chip>
                  )}
                </td>
                <td className="!whitespace-normal">
                  {u.role === "Owner" ? <span className="text-faint text-[12.5px] px-1.5">전체 (Owner)</span> : <GroupPicker member={u} groups={groups} canEdit={canEdit} />}
                </td>
                <td className="text-[12.5px] text-muted">
                  메뉴 {eff.menus}개 · {eff.builds}
                </td>
                <td>
                  <span className="flex items-center gap-1.5 flex-wrap">
                    {u.tfa ? <Dot tone="ok">사용</Dot> : <Dot tone="neutral">안 씀</Dot>}
                    {u.locked && <Chip tone="bad">잠김</Chip>}
                    {u.mustChangePassword && <Chip tone="warn">새 비밀번호 대기</Chip>}
                  </span>
                </td>
                <td className="text-right whitespace-nowrap">
                  {isOwner && u.email !== session?.me.email && (
                    <>
                      <Button size="sm" variant="ghost" icon="eye" onClick={() => preview(u)} disabled={viewAs?.email === u.email}>
                        미리보기
                      </Button>
                      {canEdit && (
                        <Button size="sm" variant="ghost" icon="key" onClick={() => openModal((c) => <ResetPasswordModal member={u} onClose={c} onDone={refresh} />)}>
                          비밀번호 재설정
                        </Button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {!shown.length && <div className="px-4 py-8 text-center text-muted">맞는 멤버가 없어요.</div>}
    </Card>
  );
}

function GroupsTab({ members, gd, canEdit, selected, onSelect, onNew }: {
  members: Member[];
  gd: GroupsData;
  canEdit: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const group = gd.groups.find((g) => g.id === selected) ?? gd.groups[0];
  const nameOf = (email: string) => members.find((m) => m.email === email)?.name ?? email;

  if (!gd.groups.length)
    return (
      <Card className="py-14 px-6 text-center flex flex-col items-center gap-2">
        <span className="grid place-items-center size-10 rounded-lg bg-primary-soft text-primary mb-1">
          <Icon name="users" />
        </span>
        <b className="font-semibold">아직 그룹이 없어요</b>
        <p className="m-0 text-muted">그룹을 만들어 멤버마다 보일 메뉴와 빌드를 정해요.</p>
        {canEdit && (
          <Button variant="primary" icon="plus" className="mt-2" onClick={onNew}>
            그룹 만들기
          </Button>
        )}
      </Card>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)] gap-4 items-start">
      <Card className="lg:sticky lg:top-[120px]">
        <nav aria-label="그룹 목록" className="p-1.5 flex flex-col gap-0.5 max-h-[calc(100vh-180px)] overflow-auto scroll-soft">
          {gd.groups.map((g) => {
            const active = g.id === group?.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelect(g.id)}
                aria-current={active ? "true" : undefined}
                className={cx("w-full text-left px-3 py-2.5 rounded-lg transition-colors", active ? "bg-primary-soft" : "hover:bg-hover")}
              >
                <div className={cx("text-[13px] font-medium truncate", active && "text-primary")}>{g.name}</div>
                <div className="text-[11.5px] text-muted truncate">
                  {g.members.length ? g.members.map(nameOf).join(", ") : "멤버 없음"} · 메뉴 {g.menus.length}
                </div>
              </button>
            );
          })}
        </nav>
      </Card>
      {group && (
        <Card>
          <GroupDetail key={`${group.id}:${JSON.stringify(draftOf(group))}`} group={group} repos={gd.repos} members={members} canEdit={canEdit} />
        </Card>
      )}
    </div>
  );
}

function RolesTab() {
  return (
    <Card>
      <CardHeader title="역할별 작업 권한" sub="역할은 할 수 있는 일만 정해요. 무엇이 보이는지는 멤버가 속한 그룹이 정해요." />
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
  );
}

/* ---------- security ---------- */

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

export function Security() {
  const data = useApi<{ sessions: DeviceSession[]; policy: Policy }>("/security");
  const { toast, withSudo, openModal, setSession, session, refresh, can } = useApp();
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => {
    if (data.data && !p) setP(data.data.policy);
  }, [data.data, p]);
  if (!data.data || !p || !session) return <Loading />;
  const sessions = data.data.sessions;

  const save = async () => {
    try {
      const r = await api.put<Policy>("/security/policy", p);
      setP(r);
      setSession({ ...session, sudoMinutes: r.sudoMinutes, enforce2fa: r.enforce2fa });
      refresh();
      toast("정책을 저장했어요. 활동 기록에 남았어요.");
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const endSession = async (id?: string) => {
    try {
      if (id) await api.del(`/auth/sessions/${id}`);
      else await api.post("/auth/sessions/logout-others");
      toast(id ? "그 기기를 로그아웃했어요" : "이 기기를 뺀 모든 기기를 로그아웃했어요");
      data.reload();
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
            <CardHeader title="로그인">
              {session.tfa ? <Dot tone="ok">2단계 인증 사용 중</Dot> : <Dot tone="warn">비밀번호만 사용</Dot>}
            </CardHeader>
            <ListItem icon="lock" title="비밀번호" sub="바꾸면 이 기기를 뺀 다른 기기는 모두 로그아웃돼요.">
              <Button size="sm" onClick={() => openModal((c) => <PasswordModal onClose={c} />)}>
                바꾸기
              </Button>
            </ListItem>
            <ListItem
              icon="shield"
              title="인증 앱 (TOTP)"
              sub={session.tfa ? "로그인할 때 비밀번호 다음에 6자리 숫자를 물어요." : "켜면 비밀번호가 새도 휴대폰 없이는 로그인할 수 없어요. 선택 사항이에요."}
            >
              <span className="flex gap-1.5">
                {session.tfa && !session.enforce2fa && (
                  <Button size="sm" variant="dangerGhost" onClick={() => openModal((c) => <DisableTfaModal onClose={c} />)}>
                    끄기
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={session.tfa ? "default" : "primary"}
                  onClick={() =>
                    withSudo(session.tfa ? "2단계 인증 다시 설정" : "2단계 인증 켜기", () => openModal((c) => <TfaSetupModal again={session.tfa} onClose={c} />))
                  }
                >
                  {session.tfa ? "다시 설정" : "켜기"}
                </Button>
              </span>
            </ListItem>
            {session.tfa && (
              <ListItem icon="key" title="복구 코드" sub={`10개 중 ${session.recoveryCodes}개 남음 · 휴대폰을 잃어버렸을 때 한 번씩 써요`}>
                <Button
                  size="sm"
                  onClick={() =>
                    withSudo("복구 코드 새로 발급", async () => {
                      const r = await api.post<{ codes: string[]; session: Session }>("/auth/tfa/codes");
                      setSession(r.session);
                      openModal((c) => <CodesModal codes={r.codes} onClose={c} />);
                    })
                  }
                >
                  새로 발급
                </Button>
              </ListItem>
            )}
          </Card>
          <Card>
            <CardHeader title="로그인된 기기">
              <Button size="sm" variant="danger" disabled={sessions.length < 2} onClick={() => endSession()}>
                다른 기기 모두 로그아웃
              </Button>
            </CardHeader>
            {sessions.map((s) => (
              <ListItem key={s.id} title={s.agent} sub={`${s.ip} · 마지막 활동 ${ago(s.lastSeen)} · 로그인 ${ago(s.createdAt)}`}>
                {s.current ? (
                  <Dot tone="ok">이 기기</Dot>
                ) : (
                  <Button size="sm" onClick={() => endSession(s.id)}>
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
              <Button variant="primary" onClick={save} disabled={!can("admin")} title={can("admin") ? undefined : "보안 정책은 Owner만 바꿀 수 있어요"}>
                저장
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
