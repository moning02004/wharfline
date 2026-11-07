import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Group, Member } from "../lib/types";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Check, ErrorText, Field, Input, Seg, cx } from "../components/ui";

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
export const GROUP_MENUS = ROUTES.filter((r) => r.id !== "dashboard");

export function buildsLabel(g: Group): string {
  if (g.allBuilds) return "모든 빌드";
  if (!g.repos.length) return "빌드 없음";
  return g.repos.length <= 2 ? `빌드: ${g.repos.join(", ")}` : `빌드: ${g.repos.slice(0, 2).join(", ")} 외 ${g.repos.length - 2}개`;
}

/** What a member actually sees: the union of their groups' menus and builds. */
export function effectiveAccess(member: Member, groups: Group[]): { menus: number; builds: string } {
  if (member.role === "Owner") return { menus: GROUP_MENUS.length, builds: "모든 빌드" };
  const mine = groups.filter((g) => member.groups.includes(g.id));
  const menus = new Set(mine.flatMap((g) => g.menus));
  if (mine.some((g) => g.allBuilds)) return { menus: menus.size, builds: "모든 빌드" };
  const repos = new Set(mine.flatMap((g) => g.repos));
  return { menus: menus.size, builds: repos.size ? `빌드 레포 ${repos.size}개` : "빌드 없음" };
}

/* ---------- group form (shared by the create dialog and the detail panel) ---------- */

export interface GroupDraft {
  name: string;
  menus: string[];
  allBuilds: boolean;
  repos: string[];
  members: string[];
}

export const draftOf = (g?: Group): GroupDraft => ({
  name: g?.name ?? "",
  menus: g?.menus ?? ["jobs", "runs", "security"],
  allBuilds: g?.allBuilds ?? false,
  repos: g?.repos ?? [],
  members: g?.members ?? [],
});

export function GroupFields({ draft, set, repos, members, disabled, autoFocus }: {
  draft: GroupDraft;
  set: (d: GroupDraft) => void;
  repos: string[];
  members: Member[];
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [extra, setExtra] = useState("");
  const [err, setErr] = useState("");
  const choices = [...new Set([...repos, ...draft.repos])].sort();
  const toggle = (key: "menus" | "repos" | "members", v: string, on: boolean) =>
    set({ ...draft, [key]: on ? [...draft[key], v] : draft[key].filter((x) => x !== v) });

  const addRepo = () => {
    const r = extra.trim().toLowerCase().replace(/\.git$/, "");
    if (!REPO_RE.test(r)) return setErr("레포는 owner/name 형식으로 넣어 주세요. 예: acme/batch-worker");
    if (!draft.repos.includes(r)) set({ ...draft, repos: [...draft.repos, r] });
    setExtra("");
    setErr("");
  };

  return (
    <fieldset disabled={disabled} className="contents">
      <Field label="이름" htmlFor="grpName">
        <Input id="grpName" autoFocus={autoFocus} placeholder="예: 배치팀" value={draft.name} onChange={(e) => set({ ...draft, name: e.target.value })} />
      </Field>

      <Field label={<>보이는 메뉴 <span className="text-faint font-normal">· {draft.menus.length}개</span></>} hint="대시보드는 항상 보여요.">
        <div className="grid grid-cols-2 gap-x-3">
          {GROUP_MENUS.map((r) => (
            <Check key={r.id} checked={draft.menus.includes(r.id)} onChange={(v) => toggle("menus", r.id, v)} title={r.label} />
          ))}
        </div>
      </Field>

      <Field label="볼 수 있는 빌드">
        <div className="flex flex-col gap-2">
          <div>
            <Seg
              options={[
                { value: "some", label: "선택한 레포만" },
                { value: "all", label: "모든 빌드" },
              ]}
              value={draft.allBuilds ? "all" : "some"}
              onChange={(v) => set({ ...draft, allBuilds: v === "all" })}
            />
          </div>
          {draft.allBuilds ? (
            <p className="m-0 text-muted text-[12.5px]">나중에 연결되는 레포의 빌드도 모두 보여요.</p>
          ) : (
            <>
              {choices.length ? (
                <div className="grid grid-cols-2 gap-x-3">
                  {choices.map((r) => (
                    <Check key={r} checked={draft.repos.includes(r)} onChange={(v) => toggle("repos", r, v)} title={<span className="font-mono text-[12.5px]">{r}</span>} />
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
              {!draft.repos.length && <p className="m-0 text-warn text-[12.5px]">레포를 고르지 않으면 이 그룹으로는 빌드가 하나도 보이지 않아요.</p>}
            </>
          )}
          <ErrorText>{err}</ErrorText>
        </div>
      </Field>

      <Field label={<>멤버 <span className="text-faint font-normal">· {draft.members.length}명 · 한 멤버가 여러 그룹에 속할 수 있어요</span></>}>
        <div className="grid grid-cols-2 gap-x-3">
          {members.map((u) => (
            <Check
              key={u.email}
              checked={draft.members.includes(u.email)}
              onChange={(v) => toggle("members", u.email, v)}
              title={u.name}
              desc={u.role === "Owner" ? "Owner · 그룹과 관계없이 전체" : `${u.role} · 다른 그룹 ${u.groups.length}개`}
            />
          ))}
        </div>
      </Field>
    </fieldset>
  );
}

async function saveGroup(group: Group | undefined, d: GroupDraft) {
  const body = { name: d.name, menus: d.menus, allBuilds: d.allBuilds, repos: d.repos, members: d.members };
  return group ? api.put<Group>(`/groups/${group.id}`, body) : api.post<Group>("/groups", body);
}

/** Create a group. */
export function GroupModal({ repos, members, onClose, onCreated }: { repos: string[]; members: Member[]; onClose: () => void; onCreated?: (g: Group) => void }) {
  const { refresh, reloadAccess, toast } = useApp();
  const [draft, setDraft] = useState(draftOf());
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const g = await saveGroup(undefined, draft);
      onClose();
      refresh();
      reloadAccess();
      onCreated?.(g);
      toast(`${draft.name} 그룹을 만들었어요`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <>
      <ModalHead title="그룹 만들기" sub="이 그룹의 멤버에게 보일 메뉴와 빌드를 골라요." onClose={onClose} />
      <form id="groupForm" onSubmit={submit} className="contents">
        <ModalBody>
          <GroupFields draft={draft} set={setDraft} repos={repos} members={members} autoFocus />
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="groupForm">
          만들기
        </Button>
      </ModalFoot>
    </>
  );
}

/** Edit the selected group in place (right side of the groups tab). */
export function GroupDetail({ group, repos, members, canEdit }: { group: Group; repos: string[]; members: Member[]; canEdit: boolean }) {
  const { refresh, reloadAccess, toast, openModal } = useApp();
  const [draft, setDraft] = useState(draftOf(group));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(group));

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await saveGroup(group, draft);
      refresh();
      reloadAccess();
      toast(`${draft.name} 그룹을 저장했어요`);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line">
        <span className="grid place-items-center size-9 rounded-lg bg-primary-soft text-primary flex-none">
          <Icon name="users" className="size-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px] font-semibold truncate">{group.name}</h2>
          <p className="m-0 text-[12px] text-muted">
            멤버 {group.members.length}명 · 메뉴 {group.menus.length}개 · {buildsLabel(group)}
          </p>
        </div>
        {canEdit && (
          <Button size="sm" variant="dangerGhost" icon="trash" onClick={() => openModal((c) => <DeleteGroupModal group={group} onClose={c} />)}>
            삭제
          </Button>
        )}
      </div>
      <div className="p-5 flex flex-col gap-5">
        <GroupFields draft={draft} set={setDraft} repos={repos} members={members} disabled={!canEdit} />
        <ErrorText>{err}</ErrorText>
      </div>
      {canEdit && (
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-surface-2">
          {dirty && <span className="mr-auto text-[12px] text-warn">저장하지 않은 변경이 있어요</span>}
          <Button disabled={!dirty || busy} onClick={() => setDraft(draftOf(group))}>
            되돌리기
          </Button>
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            저장
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------- member's groups: multi-select that opens in place ---------- */

export function GroupPicker({ member, groups, canEdit }: { member: Member; groups: Group[]; canEdit: boolean }) {
  const { refresh, reloadAccess, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState(member.groups);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => setIds(member.groups), [member.groups]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async (gid: string, on: boolean) => {
    const next = on ? [...ids, gid] : ids.filter((x) => x !== gid);
    setIds(next); // optimistic
    try {
      await api.put(`/members/${encodeURIComponent(member.email)}/groups`, { groups: next });
      refresh();
      reloadAccess();
    } catch (e) {
      setIds(ids);
      toast(errMsg(e));
    }
  };

  const names = groups.filter((g) => ids.includes(g.id));
  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${member.name} 그룹`}
        className={cx(
          "group flex items-center gap-1 flex-wrap min-h-8 max-w-[300px] py-1 pl-1.5 pr-7 rounded-lg text-left relative transition-colors",
          canEdit ? "hover:bg-hover" : "cursor-default",
          open && "bg-hover",
        )}
      >
        {names.length ? (
          names.map((g) => (
            <span key={g.id} className="inline-flex items-center h-[22px] px-2 rounded-md bg-primary-soft text-primary text-[12px] font-medium">
              {g.name}
            </span>
          ))
        ) : (
          <span className="text-warn text-[12.5px] px-1">그룹 없음</span>
        )}
        {canEdit && <Icon name="chev" className="size-3.5 text-faint absolute right-2 top-1/2 -translate-y-1/2 opacity-60 group-hover:opacity-100" />}
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" className="absolute left-0 top-[calc(100%+4px)] z-20 w-[300px] rounded-xl bg-surface shadow-pop p-1.5 animate-rise">
          <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-faint">여러 그룹을 고를 수 있어요 · 바로 저장돼요</div>
          {groups.map((g) => {
            const on = ids.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => toggle(g.id, !on)}
                className="w-full flex items-start gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-hover"
              >
                <span className={cx("mt-0.5 grid place-items-center size-4 rounded-[5px] border flex-none transition-colors", on ? "bg-primary border-primary text-primary-fg" : "border-line-strong bg-surface")}>
                  {on && <Icon name="check" className="size-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{g.name}</span>
                  <span className="block text-[11.5px] text-muted truncate">
                    메뉴 {g.menus.length}개 · {buildsLabel(g)}
                  </span>
                </span>
              </button>
            );
          })}
          {!groups.length && <div className="px-2 py-3 text-muted text-[12.5px]">아직 그룹이 없어요. 그룹 탭에서 먼저 만들어 주세요.</div>}
        </div>
      )}
    </div>
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
