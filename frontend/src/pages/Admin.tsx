import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import { ROLES, useApi, useApp } from "../lib/app";
import type { Activity as Act, DeviceSession, Group, Login, Member, NotifyChannel, NotifyConfig, NotifyEvent, NotifySecretKey, NotifySettings, Policy, Role, Session } from "../lib/types";
import { CodesModal, DisableTfaModal, PasswordModal, ResetPasswordModal, TfaSetupModal } from "../modals/SecurityModals";
import { buildsLabel, draftOf, effectiveAccess, GroupDetail, GroupModal, GroupPicker } from "../modals/AccessModals";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Banner, Button, Card, CardHeader, Check, Chip, cx, Dot, Field, Hint, Input, ListItem, Loading, PageHeader, Seg, Select, StatusPill, Switch, TableWrap, Textarea } from "../components/ui";

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
      <PageHeader title="활동 기록" desc="누가 언제 무엇을 했는지 남아요.">
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
      <PageHeader title="멤버와 권한" desc="역할은 할 수 있는 일을, 그룹은 보이는 메뉴와 빌드를 정해요.">
        {tab === "groups" && canEdit ? (
          <Button variant="primary" icon="plus" onClick={newGroup}>
            그룹 만들기
          </Button>
        ) : tab === "members" && canEdit ? (
          <Button variant="primary" icon="plus" onClick={() => openModal((c) => <ImportMembersModal onClose={c} />, "md")}>
            멤버 일괄 추가
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

interface ImportResult {
  rows: number;
  newMembers: string[];
  existingMembers: string[];
  newGroups: string[];
  joins: number;
  errors: { line: number; text: string; reason: string }[];
  applied: boolean;
}

const IMPORT_EXAMPLE = `marketing2 user1@a.com
marketing2 user2@a.com
ifdo hong@ermore.co.kr`;

/** Owner only: add accounts and group memberships from "그룹 계정" lines (typed, pasted or a .txt). */
function ImportMembersModal({ onClose }: { onClose: () => void }) {
  const { toast, withSudo, refresh, reloadAccess } = useApp();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ text: string; result: ImportResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const fresh = checked && checked.text === text ? checked.result : null;

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1024 * 1024) return toast("파일이 너무 커요 (최대 1MB)", "error");
    setText(await f.text());
  };
  /** Check the lines first (no password needed); add only when every line reads as 그룹 계정. */
  const add = async () => {
    setBusy(true);
    let r: ImportResult;
    try {
      r = await api.post<ImportResult>("/members/import", { text });
    } catch (e) {
      return toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
    setChecked({ text, result: r });
    if (r.errors.length) return;
    if (!r.newMembers.length && !r.joins) return toast("모두 이미 그룹에 들어 있어요. 추가할 게 없어요.");
    withSudo("멤버 일괄 추가", async () => {
      const done = await api.post<ImportResult>("/members/import", { text, apply: true });
      toast(`새 멤버 ${done.newMembers.length}명, 새 그룹 ${done.newGroups.length}개, 그룹 추가 ${done.joins}건을 반영했어요`);
      refresh();
      reloadAccess();
      onClose();
    });
  };

  return (
    <>
      <ModalHead title="멤버 일괄 추가" sub="한 줄에 하나씩 그룹 계정 순서로 적어요. .txt 파일을 올려도 돼요." onClose={onClose} />
      <ModalBody>
        <Banner icon="info">
          새 계정은 <b>Viewer</b>, 비밀번호 <b className="font-mono">0000</b> 으로 만들어지고 처음 로그인할 때 새 비밀번호를 정해요. 이미 있는 계정은 역할과 비밀번호를 그대로 두고 그룹만 더해요. 없는 그룹은 새로 만들어요(작업·실행 기록·보안 메뉴만 보여요. 그룹 탭에서 넓혀 주세요).
        </Banner>
        <Field label=".txt 파일" htmlFor="impFile">
          <input id="impFile" type="file" accept=".txt,.md,text/plain" className="text-[13px]" onChange={(e) => readFile(e.target.files?.[0])} />
        </Field>
        <Field label="그룹 계정" htmlFor="impText">
          <Textarea id="impText" rows={10} className="font-mono" placeholder={IMPORT_EXAMPLE} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {fresh && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex gap-2 flex-wrap">
              <Chip tone="ok">새 멤버 {fresh.newMembers.length}명</Chip>
              <Chip>이미 있음 {fresh.existingMembers.length}명</Chip>
              <Chip tone="ok">새 그룹 {fresh.newGroups.length}개</Chip>
              <Chip>그룹 추가 {fresh.joins}건</Chip>
              {fresh.errors.length > 0 && <Chip tone="bad">틀린 줄 {fresh.errors.length}개</Chip>}
            </div>
            {fresh.newGroups.length > 0 && <p className="m-0 text-muted">새 그룹: {fresh.newGroups.join(", ")}</p>}
            {fresh.newMembers.length > 0 && <p className="m-0 text-muted break-all">새 멤버: {fresh.newMembers.join(", ")}</p>}
            {fresh.errors.map((x, i) => (
              <p key={i} className="m-0 text-bad">
                {x.line > 0 && <span className="font-mono">{x.line}줄 </span>}
                {x.reason}
                {x.text && <span className="font-mono text-faint"> · {x.text}</span>}
              </p>
            ))}
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" onClick={add} disabled={!text.trim() || busy}>
          추가하기
        </Button>
      </ModalFoot>
    </>
  );
}

/** Owner or Admin: rename a member (themselves included). The server allows no one else. */
function RenameModal({ member, onClose }: { member: { email: string; name: string }; onClose: () => void }) {
  const { session, setSession, toast, refresh } = useApp();
  const [name, setName] = useState(member.name);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = name.trim().split(/\s+/).join(" ");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.put(`/members/${encodeURIComponent(member.email)}/name`, { name: clean });
      if (member.email === session?.me.email) setSession(await api.get<Session>("/auth/me"));
      refresh();
      toast(`이름을 ${clean}(으)로 바꿨어요`);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ModalHead title="이름 바꾸기" sub={member.email} onClose={onClose} />
      <form id="renameForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="renameName" hint="배포 작업의 생성자, 실행한 사람 등 곳곳에 이 이름으로 보여요. 64자까지 돼요.">
            <Input id="renameName" autoFocus maxLength={64} placeholder="예: 브랜드마케팅2팀 이미지 대리" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {err && <p className="m-0 text-bad text-[12.5px]">{err}</p>}
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="renameForm" disabled={busy || !clean || clean === member.name}>
          바꾸기
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
  const canRename = (session?.me.role === "Owner" || session?.me.role === "Admin") && !viewAs;

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
                  {canRename && (
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => openModal((c) => <RenameModal member={u} onClose={c} />)}>
                      이름 바꾸기
                    </Button>
                  )}
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
      <Card>
        <nav aria-label="그룹 목록" className="p-1.5 flex flex-col gap-0.5 max-h-[560px] overflow-auto scroll-soft">
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
                  멤버 {g.members.length}명 · 메뉴 {g.menus.length} · {buildsLabel(g, true)}
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
            {(session.me.role === "Owner" || session.me.role === "Admin") && (
              <ListItem icon="users" title="이름" sub={session.me.name}>
                <Button size="sm" onClick={() => openModal((c) => <RenameModal member={{ email: session.me.email, name: session.me.name }} onClose={c} />)}>
                  바꾸기
                </Button>
              </ListItem>
            )}
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
                <option>6시간</option>
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

/* ---------- deploy notifications ---------- */

const NOTIFY_EVENTS: [NotifyEvent, string][] = [
  ["ok", "배포 성공"],
  ["bad", "배포 실패"],
  ["cancel", "배포 취소"],
  ["approval", "승인 대기"],
];

/** Typed secrets: undefined keeps the saved value, "" clears it. */
type SecretDraft = Partial<Record<NotifySecretKey, string>>;

export function Notify() {
  const data = useApi<NotifySettings>("/notify");
  const { toast, withSudo, can } = useApp();
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  const [sec, setSec] = useState<SecretDraft>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (data.data && !cfg) {
      const { secrets: _s, status: _st, ...c } = data.data;
      setCfg({ ...c, baseUrl: c.baseUrl || window.location.origin });
    }
  }, [data.data, cfg]);
  if (!can("admin")) return <Banner icon="lock">배포 알림은 Owner만 설정할 수 있어요.</Banner>;
  if (!data.data || !cfg) return <Loading />;
  const saved = data.data;
  const body = () => ({ ...cfg, secrets: sec });
  const secretChanged = Object.values(sec).some((v) => v !== undefined);

  const save = () => {
    const run = async () => {
      setBusy("save");
      try {
        await api.put<NotifySettings>("/notify", body());
        setSec({});
        data.reload();
        toast("알림 설정을 저장했어요");
      } finally {
        setBusy(null);
      }
    };
    if (secretChanged) withSudo("알림 비밀값 저장", run);
    else run().catch((e) => toast(errMsg(e), "error"));
  };
  const test = async (channel: NotifyChannel) => {
    setBusy(channel);
    try {
      await api.post("/notify/test", { channel, draft: body() });
      toast("시험 메시지를 보냈어요");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
      data.reload();
    }
  };

  const secretInput = (key: NotifySecretKey, id: string, placeholder: string) => {
    const s = saved.secrets[key];
    const cleared = sec[key] === "";
    return (
      <div className="flex gap-1.5">
        <Input
          id={id}
          type="password"
          mono
          autoComplete="off"
          className="flex-1"
          value={sec[key] ?? ""}
          placeholder={s.set && !cleared ? `저장됨 · ••••${s.last4}` : placeholder}
          onChange={(e) => setSec({ ...sec, [key]: e.target.value || undefined })}
        />
        {s.set && !sec[key] && (
          <Button size="md" variant="ghost" onClick={() => setSec({ ...sec, [key]: cleared ? undefined : "" })}>
            {cleared ? "되돌리기" : "지우기"}
          </Button>
        )}
      </div>
    );
  };

  const channel = (ch: NotifyChannel, title: string, fields: ReactNode) => {
    const st = saved.status[ch];
    const on = cfg[ch].on;
    return (
      <Card>
        <CardHeader title={title}>
          <Switch checked={on} onChange={(v) => setCfg({ ...cfg, [ch]: { ...cfg[ch], on: v } })} label={`${title} 알림`} />
        </CardHeader>
        <div className="p-5 flex flex-col gap-4">
          {fields}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {st && !st.ok ? (
              <Hint className="text-bad! min-w-0 break-all">마지막 전송 실패: {st.error}</Hint>
            ) : st ? (
              <Hint>마지막 전송 {ago(st.at * 1000)}</Hint>
            ) : (
              <span />
            )}
            <Button size="sm" icon="play" disabled={busy !== null} onClick={() => test(ch)}>
              {busy === ch ? "보내는 중…" : "시험 보내기"}
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <>
      <PageHeader title="배포 알림" desc="배포가 끝나면 휴대폰이나 메신저로 알려 드려요." />
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 items-start">
        <div className="flex flex-col gap-4">
          {channel(
            "ntfy",
            "ntfy",
            <>
              <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-3">
                <Field label="서버" htmlFor="n-server">
                  <Input id="n-server" mono value={cfg.ntfy.server} placeholder="https://ntfy.sh" onChange={(e) => setCfg({ ...cfg, ntfy: { ...cfg.ntfy, server: e.target.value } })} />
                </Field>
                <Field label="토픽" htmlFor="n-topic" hint="ntfy.sh에선 남이 못 맞힐 이름으로 지어 주세요.">
                  <Input id="n-topic" mono value={cfg.ntfy.topic} placeholder="acme-deploys-7f3k" onChange={(e) => setCfg({ ...cfg, ntfy: { ...cfg.ntfy, topic: e.target.value } })} />
                </Field>
              </div>
              <Field label="액세스 토큰 (선택)" htmlFor="n-token">
                {secretInput("ntfyToken", "n-token", "tk_…")}
              </Field>
            </>,
          )}
          {channel(
            "slack",
            "Slack",
            <Field label="웹훅 주소" htmlFor="s-url" hint="Slack 앱의 Incoming Webhooks에서 만들어요.">
              {secretInput("slackUrl", "s-url", "https://hooks.slack.com/services/…")}
            </Field>,
          )}
          {channel(
            "discord",
            "Discord",
            <Field label="웹훅 주소" htmlFor="d-url" hint="채널 설정 › 연동 › 웹후크에서 만들어요.">
              {secretInput("discordUrl", "d-url", "https://discord.com/api/webhooks/…")}
            </Field>,
          )}
        </div>
        <Card>
          <CardHeader title="보낼 때">
            <Chip>Owner만 수정</Chip>
          </CardHeader>
          <div className="p-5 flex flex-col gap-4">
            <div className="flex flex-col">
              {NOTIFY_EVENTS.map(([k, label]) => (
                <Check key={k} checked={cfg.events[k]} onChange={(v) => setCfg({ ...cfg, events: { ...cfg.events, [k]: v } })} title={label} />
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 text-[13px]">
              <span>
                자동 배포만
                <small className="block text-muted text-[12px] mt-px">새 이미지 push로 시작한 실행만 알려요.</small>
              </span>
              <Switch checked={cfg.autoOnly} onChange={(v) => setCfg({ ...cfg, autoOnly: v })} label="자동 배포만" />
            </label>
            <Field label="Wharfline 주소" htmlFor="n-base" hint="알림 속 실행 링크에 써요.">
              <Input id="n-base" mono value={cfg.baseUrl} placeholder="https://deploy.example.com" onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" disabled={busy !== null} onClick={save}>
                저장
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
