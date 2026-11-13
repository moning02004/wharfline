import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errMsg } from "../lib/api";
import { ROUTES, useApp } from "../lib/app";
import type { Group, Member } from "../lib/types";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Check, ErrorText, Field, Input, Seg, cx } from "../components/ui";

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
// 배포 알림 is Owner-only (the server has no such menu), so groups never grant it.
export const GROUP_MENUS = ROUTES.filter((r) => r.id !== "dashboard" && r.id !== "notify");

/** `short`: just the count, for tight lists. */
export function buildsLabel(g: Group, short = false): string {
  if (g.allBuilds) return "모든 빌드";
  if (!g.repos.length) return "빌드 없음";
  if (short) return `빌드 ${g.repos.length}개`;
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
  const { openModal } = useApp();
  const choices = [...new Set([...repos, ...draft.repos])].sort();
  const byEmail = new Map(members.map((u) => [u.email, u]));
  const isOwner = (email: string) => byEmail.get(email)?.role === "Owner";
  const toggle = (key: "menus", v: string, on: boolean) =>
    set({ ...draft, [key]: on ? [...draft[key], v] : draft[key].filter((x) => x !== v) });

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
            <Picked
              count={`레포 ${draft.repos.length}개`}
              empty={<span className="text-warn">레포를 고르지 않으면 이 그룹으로는 빌드가 하나도 보이지 않아요.</span>}
              chips={draft.repos.map((r) => ({ id: r, label: r }))}
              mono
              button="빌드 고르기"
              onOpen={() =>
                openModal(
                  (c) => (
                    <TransferModal
                      title="볼 수 있는 빌드"
                      sub="눌러서 옮기거나 반대편으로 끌어다 놓아요. 목록에 없는 레포는 검색 칸에 owner/name 으로 적어 추가해요."
                      leftLabel="빌드 레포"
                      rightLabel="이 그룹이 보는 빌드"
                      items={choices.map((r) => ({ id: r, label: r, text: r }))}
                      mono
                      selected={draft.repos}
                      custom={(q) => {
                        const r = q.trim().toLowerCase().replace(/\.git$/, "");
                        return REPO_RE.test(r) ? r : null;
                      }}
                      onApply={(ids) => set({ ...draft, repos: ids })}
                      onClose={c}
                    />
                  ),
                  "md",
                )
              }
            />
          )}
        </div>
      </Field>

      <Field label={<>멤버 <span className="text-faint font-normal">· 한 멤버가 여러 그룹에 속할 수 있어요</span></>}>
        <Picked
          count={`${draft.members.length}명`}
          empty="아직 멤버가 없어요."
          chips={draft.members.map((e) => ({ id: e, label: byEmail.get(e)?.name ?? e, title: e }))}
          button="멤버 고르기"
          onOpen={() =>
            openModal(
              (c) => (
                <TransferModal
                  title="그룹 멤버"
                  sub="눌러서 옮기거나 반대편으로 끌어다 놓아요. 이름이나 이메일로 찾을 수 있어요."
                  leftLabel="전체 멤버"
                  rightLabel="이 그룹의 멤버"
                  items={members
                    .filter((u) => u.role !== "Owner") // Owners see everything whatever their groups
                    .map((u) => ({ id: u.email, label: u.name, text: `${u.name} ${u.email}`, desc: `${u.email} · ${u.role} · 그룹 ${u.groups.length}개` }))}
                  selected={draft.members.filter((e) => !isOwner(e))}
                  onApply={(ids) => set({ ...draft, members: [...draft.members.filter(isOwner), ...ids] })}
                  onClose={c}
                />
              ),
              "md",
            )
          }
        />
      </Field>
    </fieldset>
  );
}

/** What a group was given, as chips in a small scrolling box, with the button that opens the picker. */
function Picked({ count, empty, chips, mono, button, onOpen }: {
  count: string;
  empty: ReactNode;
  chips: { id: string; label: string; title?: string }[];
  mono?: boolean;
  button: string;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface-2 rounded-t-lg">
        <span className="text-[12.5px] text-muted tabular-nums">{count}</span>
        <Button size="sm" className="ml-auto" icon="edit" onClick={onOpen}>
          {button}
        </Button>
      </div>
      <div className="p-2.5 max-h-[132px] overflow-auto scroll-soft">
        {chips.length ? (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <span
                key={c.id}
                title={c.title}
                className={cx("inline-flex items-center h-[22px] px-2 rounded-md bg-primary-soft text-primary text-[12px] font-medium", mono && "font-mono text-[11.5px]")}
              >
                {c.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="m-0 text-[12.5px] text-muted">{empty}</p>
        )}
      </div>
    </div>
  );
}

interface TransferItem {
  id: string;
  label: string;
  text: string; // what the search matches
  desc?: string;
}

const LIST_CAP = 300; // longer lists ask for a search instead of rendering every row

/** Two lists: everything on the left, what is given on the right. Click a row to move it; 적용 hands back the ids.
 *  `custom` turns a search the left list doesn't contain into a new id (e.g. a repo typed as owner/name). */
export function TransferModal({ title, sub, leftLabel, rightLabel, items, mono, selected, custom, onApply, onClose }: {
  title: string;
  sub: string;
  leftLabel: string;
  rightLabel: string;
  items: TransferItem[];
  mono?: boolean;
  selected: string[];
  custom?: (q: string) => string | null;
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [extra, setExtra] = useState<TransferItem[]>([]);
  const [qa, setQa] = useState("");
  const [qb, setQb] = useState("");
  const [drag, setDrag] = useState<{ id: string; from: "left" | "right" } | null>(null);
  const [over, setOver] = useState<"left" | "right" | null>(null);
  const plain = (id: string): TransferItem => ({ id, label: id, text: id });
  const all: TransferItem[] = [...items, ...extra, ...selected.filter((id) => !items.some((x) => x.id === id)).map(plain)];
  const byId = new Map(all.map((x) => [x.id, x]));
  const on = new Set(picked);
  const match = (x: TransferItem, q: string) => x.text.toLowerCase().includes(q.trim().toLowerCase());
  const left = all.filter((x) => !on.has(x.id) && match(x, qa));
  const right = picked.map((id) => byId.get(id) ?? plain(id)).filter((x) => match(x, qb));
  const newId = custom && qa.trim() ? custom(qa) : null;
  const canAdd = newId !== null && !byId.has(newId);
  const added = picked.filter((id) => !selected.includes(id)).length;
  const removed = selected.filter((id) => !on.has(id)).length;

  const add = (ids: string[]) => setPicked((p) => [...p, ...ids.filter((id) => !p.includes(id))]);
  const drop = (ids: string[]) => setPicked((p) => p.filter((id) => !ids.includes(id)));
  const addCustom = () => {
    if (!canAdd || !newId) return;
    setExtra((e) => [...e, { id: newId, label: newId, text: newId }]);
    add([newId]);
    setQa("");
  };

  const pane = (side: "left" | "right") => {
    const rows = side === "left" ? left : right;
    const q = side === "left" ? qa : qb;
    const setQ = side === "left" ? setQa : setQb;
    const total = side === "left" ? all.length - picked.length : picked.length;
    const target = drag !== null && drag.from !== side; // a row from the other side may be dropped here
    return (
      <div
        className={cx(
          "flex flex-col min-h-0 rounded-xl border overflow-hidden transition-colors",
          target && over === side ? "border-primary ring-2 ring-primary/30 bg-primary-soft/40" : target ? "border-dashed border-primary/60" : "border-line",
        )}
        onDragOver={(e) => {
          if (!target) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (over !== side) setOver(side);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (target && drag) (side === "left" ? drop : add)([drag.id]);
          setDrag(null);
          setOver(null);
        }}
      >
        <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-surface-2">
          <span className="text-[12.5px] font-semibold">{side === "left" ? leftLabel : rightLabel}</span>
          <span className="text-[11.5px] text-faint tabular-nums">{total}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={!rows.length}
            onClick={() => (side === "left" ? add : drop)(rows.map((r) => r.id))}
          >
            {side === "left" ? (q ? "찾은 것 모두 추가" : "모두 추가") : q ? "찾은 것 모두 빼기" : "모두 빼기"}
          </Button>
        </div>
        <div className="p-2 border-b border-line">
          <Input
            mono={mono && side === "left" && !!custom}
            placeholder={side === "left" ? (custom ? "찾기 또는 owner/name 입력" : "이름이나 이메일로 찾기") : "찾기"}
            aria-label={`${side === "left" ? leftLabel : rightLabel} 찾기`}
            value={q}
            autoFocus={side === "left"}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (side === "left" && canAdd) addCustom();
              else if (rows.length === 1) (side === "left" ? add : drop)([rows[0].id]);
            }}
          />
        </div>
        <ul className="m-0 p-1.5 list-none h-[320px] overflow-auto scroll-soft">
          {side === "left" && canAdd && (
            <li>
              <button type="button" onClick={addCustom} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-primary hover:bg-hover">
                <Icon name="plus" className="size-3.5 flex-none" />
                <span className="font-mono text-[12.5px] truncate">{newId}</span>
                <span className="ml-auto text-[11.5px] text-faint flex-none">새로 추가</span>
              </button>
            </li>
          )}
          {rows.slice(0, LIST_CAP).map((x) => (
            <li key={x.id}>
              <button
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", x.id); // Firefox starts a drag only with data set
                  setDrag({ id: x.id, from: side });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onClick={() => (side === "left" ? add : drop)([x.id])}
                className={cx(
                  "group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-hover cursor-grab active:cursor-grabbing",
                  drag?.id === x.id && "opacity-40",
                )}
                title={side === "left" ? "눌러서 추가 · 오른쪽으로 끌어도 돼요" : "눌러서 빼기 · 왼쪽으로 끌어도 돼요"}
              >
                <span className="min-w-0 flex-1">
                  <span className={cx("block truncate text-[13px]", mono && "font-mono text-[12.5px]")}>{x.label}</span>
                  {x.desc && <span className="block truncate text-[11.5px] text-muted">{x.desc}</span>}
                </span>
                <Icon
                  name={side === "left" ? "plus" : "x"}
                  className={cx("size-3.5 flex-none opacity-0 group-hover:opacity-100", side === "left" ? "text-primary" : "text-bad")}
                />
              </button>
            </li>
          ))}
          {rows.length > LIST_CAP && <li className="px-2.5 py-2 text-[12px] text-faint">{rows.length - LIST_CAP}개 더 있어요. 찾기로 좁혀 주세요.</li>}
          {!rows.length && !(side === "left" && canAdd) && (
            <li className="px-2.5 py-6 text-center text-[12.5px] text-muted">
              {q ? "맞는 항목이 없어요." : side === "left" ? "모두 추가했어요." : "아직 아무것도 없어요. 왼쪽에서 골라 주세요."}
            </li>
          )}
        </ul>
      </div>
    );
  };

  return (
    <>
      <ModalHead title={title} sub={sub} onClose={onClose} />
      <ModalBody>
        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-3">
          {pane("left")}
          {pane("right")}
        </div>
      </ModalBody>
      <ModalFoot>
        {(added > 0 || removed > 0) && (
          <span className="mr-auto text-[12px] text-muted tabular-nums">
            {added > 0 && `${added}개 추가`}
            {added > 0 && removed > 0 && " · "}
            {removed > 0 && `${removed}개 빼기`}
          </span>
        )}
        <Button onClick={onClose}>취소</Button>
        <Button
          variant="primary"
          onClick={() => {
            onApply(picked);
            onClose();
          }}
        >
          적용
        </Button>
      </ModalFoot>
    </>
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
