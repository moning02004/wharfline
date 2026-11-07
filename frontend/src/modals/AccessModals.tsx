import { useState } from "react";
import { api, errMsg } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Group, Member } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, Check, ErrorText, Field, Input, Seg } from "../components/ui";

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const GROUP_MENUS = ROUTES.filter((r) => r.id !== "dashboard");

/** Create or edit a group: its name, menus, build repos and members. */
export function GroupModal({ group, repos, members, onClose }: { group?: Group; repos: string[]; members: Member[]; onClose: () => void }) {
  const { refresh, reloadAccess, toast } = useApp();
  const [name, setName] = useState(group?.name ?? "");
  const [menus, setMenus] = useState<string[]>(group?.menus ?? ["jobs", "runs", "security"]);
  const [allBuilds, setAllBuilds] = useState(group?.allBuilds ?? false);
  const [picked, setPicked] = useState<string[]>(group?.repos ?? []);
  const [extra, setExtra] = useState("");
  const [emails, setEmails] = useState<string[]>(group?.members ?? []);
  const [err, setErr] = useState("");
  const choices = [...new Set([...repos, ...picked])].sort();

  const toggle = (list: string[], set: (v: string[]) => void, v: string, on: boolean) => set(on ? [...list, v] : list.filter((x) => x !== v));

  const addRepo = () => {
    const r = extra.trim().toLowerCase().replace(/\.git$/, "");
    if (!REPO_RE.test(r)) {
      setErr("레포는 owner/name 형식으로 넣어 주세요. 예: acme/batch-worker");
      return;
    }
    if (!picked.includes(r)) setPicked([...picked, r]);
    setExtra("");
    setErr("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, menus, allBuilds, repos: picked, members: emails };
    try {
      if (group) await api.put(`/groups/${group.id}`, body);
      else await api.post("/groups", body);
      onClose();
      refresh();
      reloadAccess();
      toast(group ? `${name} 그룹을 저장했어요` : `${name} 그룹을 만들었어요`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <>
      <ModalHead title={group ? "그룹 수정" : "그룹 만들기"} sub="이 그룹의 멤버에게 보일 메뉴와 빌드를 골라요." onClose={onClose} />
      <form id="groupForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="이름" htmlFor="grpName">
            <Input id="grpName" autoFocus={!group} placeholder="예: 배치팀" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="보이는 메뉴" hint="대시보드는 항상 보여요.">
            <div className="grid grid-cols-2 gap-x-3">
              {GROUP_MENUS.map((r) => (
                <Check key={r.id} checked={menus.includes(r.id)} onChange={(v) => toggle(menus, setMenus, r.id, v)} title={r.label} />
              ))}
            </div>
          </Field>

          <Field label="볼 수 있는 빌드">
            <div className="flex flex-col gap-2">
              <Seg
                options={[
                  { value: "some", label: "선택한 레포만" },
                  { value: "all", label: "모든 빌드" },
                ]}
                value={allBuilds ? "all" : "some"}
                onChange={(v) => setAllBuilds(v === "all")}
              />
              {allBuilds ? (
                <p className="m-0 text-muted text-[12.5px]">나중에 연결되는 레포의 빌드도 모두 보여요.</p>
              ) : (
                <>
                  {choices.length ? (
                    <div className="grid grid-cols-2 gap-x-3">
                      {choices.map((r) => (
                        <Check key={r} checked={picked.includes(r)} onChange={(v) => toggle(picked, setPicked, r, v)} title={<span className="font-mono">{r}</span>} />
                      ))}
                    </div>
                  ) : (
                    <p className="m-0 text-muted text-[12.5px]">아직 연결된 빌드 레포가 없어요. 아래에 직접 넣을 수 있어요.</p>
                  )}
                  <div className="flex gap-1.5">
                    <Input
                      mono
                      placeholder="owner/name"
                      aria-label="레포 추가"
                      value={extra}
                      onChange={(e) => setExtra(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addRepo();
                        }
                      }}
                    />
                    <Button icon="plus" onClick={addRepo}>
                      추가
                    </Button>
                  </div>
                  {!picked.length && <p className="m-0 text-warn text-[12.5px]">레포를 고르지 않으면 이 그룹으로는 빌드가 하나도 보이지 않아요.</p>}
                </>
              )}
            </div>
          </Field>

          <Field label="멤버">
            <div className="grid grid-cols-2 gap-x-3">
              {members.map((u) => (
                <Check
                  key={u.email}
                  checked={emails.includes(u.email)}
                  onChange={(v) => toggle(emails, setEmails, u.email, v)}
                  title={u.name}
                  desc={u.role === "Owner" ? "Owner · 그룹과 관계없이 전체" : `${u.role} · ${u.email}`}
                />
              ))}
            </div>
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="groupForm">
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

/** Pick which groups one member belongs to. */
export function MemberGroupsModal({ member, groups, onClose }: { member: Member; groups: Group[]; onClose: () => void }) {
  const { refresh, reloadAccess, toast } = useApp();
  const [ids, setIds] = useState<string[]>(member.groups);
  const [err, setErr] = useState("");

  const save = async () => {
    try {
      await api.put(`/members/${encodeURIComponent(member.email)}/groups`, { groups: ids });
      onClose();
      refresh();
      reloadAccess();
      toast(`${member.name}님의 그룹을 바꿨어요`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <>
      <ModalHead title={`${member.name}님의 그룹`} sub="속한 그룹들의 메뉴와 빌드를 모두 합쳐서 볼 수 있어요." onClose={onClose} />
      <ModalBody>
        {member.role === "Owner" && (
          <Banner icon="info" title="Owner는 그룹과 관계없이 모든 메뉴와 빌드를 봐요">
            그룹은 역할을 바꿨을 때를 위해 미리 정해 둘 수 있어요.
          </Banner>
        )}
        <div className="flex flex-col">
          {groups.map((g) => (
            <Check
              key={g.id}
              checked={ids.includes(g.id)}
              onChange={(v) => setIds(v ? [...ids, g.id] : ids.filter((x) => x !== g.id))}
              title={g.name}
              desc={`메뉴 ${g.menus.length}개 · ${buildsLabel(g)}`}
            />
          ))}
          {!groups.length && <p className="m-0 text-muted">아직 그룹이 없어요. 먼저 그룹을 만들어 주세요.</p>}
        </div>
        {!ids.length && member.role !== "Owner" && <p className="m-0 text-warn text-[12.5px]">그룹이 없으면 대시보드만 보이고 빌드는 하나도 보이지 않아요.</p>}
        <ErrorText>{err}</ErrorText>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

export function DeleteGroupModal({ group, onClose }: { group: Group; onClose: () => void }) {
  const { refresh, reloadAccess, toast } = useApp();
  const [err, setErr] = useState("");
  const remove = async () => {
    try {
      await api.del(`/groups/${group.id}`);
      onClose();
      refresh();
      reloadAccess();
      toast(`${group.name} 그룹을 지웠어요`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <>
      <ModalHead title={`${group.name} 그룹 삭제`} onClose={onClose} />
      <ModalBody>
        <p className="m-0">
          멤버 {group.members.length}명이 이 그룹에서 빠져요. 다른 그룹에 속하지 않은 멤버는 이 그룹으로 보던 메뉴와 빌드를 더 이상 볼 수 없어요.
        </p>
        <ErrorText>{err}</ErrorText>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="danger" onClick={remove}>
          삭제
        </Button>
      </ModalFoot>
    </>
  );
}

export function buildsLabel(g: Group): string {
  if (g.allBuilds) return "모든 빌드";
  if (!g.repos.length) return "빌드 없음";
  return g.repos.length <= 2 ? `빌드: ${g.repos.join(", ")}` : `빌드: ${g.repos.slice(0, 2).join(", ")} 외 ${g.repos.length - 2}개`;
}
