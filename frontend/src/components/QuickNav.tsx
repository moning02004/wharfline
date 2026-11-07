import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ROUTES, useApi, useApp } from "../lib/app";
import type { Job } from "../lib/types";
import { useRun } from "../modals/RunModals";
import { Icon, type IconName } from "./Icon";
import { cx } from "./ui";

interface Item {
  key: string;
  kind: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

/** ⌘K: jump to a page, open a job's run dialog, or roll a job back. */
export function QuickNav({ onClose }: { onClose: () => void }) {
  const { canSee, role } = useApp();
  const nav = useNavigate();
  const { confirm } = useRun();
  const jobs = useApi<Job[]>("/jobs").data ?? [];
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = ROUTES.filter((r) => canSee(r.id)).map((r) => ({
      key: `page:${r.id}`,
      kind: "이동",
      label: r.label,
      hint: r.grp || undefined,
      icon: r.icon as IconName,
      run: () => {
        onClose();
        nav(r.path);
      },
    }));
    const canRun = canSee("jobs") && role !== "Viewer";
    const actions: Item[] = canRun
      ? jobs.flatMap((j) => [
          {
            key: `run:${j.id}`,
            kind: "배포",
            label: j.name,
            hint: `${j.image.split("/").pop()}:${j.latestTag ?? j.tagNow}`,
            icon: "play" as IconName,
            run: () => {
              onClose();
              confirm(j);
            },
          },
          ...(j.prevTag
            ? [
                {
                  key: `rb:${j.id}`,
                  kind: "되돌리기",
                  label: j.name,
                  hint: `→ ${j.prevTag}`,
                  icon: "undo" as IconName,
                  run: () => {
                    onClose();
                    confirm(j, { tag: j.prevTag!, rollback: true });
                  },
                },
              ]
            : []),
        ])
      : [];
    const all = [...actions, ...pages];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((i) => words.every((w) => `${i.kind} ${i.label} ${i.hint ?? ""}`.toLowerCase().includes(w))) : all;
  }, [jobs, q, canSee, role, nav, confirm, onClose]);

  const active = Math.min(sel, Math.max(0, items.length - 1));

  return (
    <div className="flex flex-col min-h-0">
      <label className="flex items-center gap-2.5 px-4 h-12 border-b border-line flex-none">
        <svg viewBox="0 0 24 24" className="size-4 text-faint" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              items[active]?.run();
            }
          }}
          placeholder="페이지, 배포, 되돌리기… 예: 배포 api"
          aria-label="빠른 이동"
          className="flex-1 min-w-0 bg-transparent outline-none text-[14px] placeholder:text-faint"
        />
        <kbd className="font-mono text-[11px] text-faint border border-line rounded px-1.5">esc</kbd>
      </label>
      <div role="listbox" aria-label="결과" className="max-h-[360px] overflow-auto scroll-soft p-1.5">
        {items.map((i, idx) => (
          <button
            key={i.key}
            type="button"
            role="option"
            aria-selected={idx === active}
            onMouseEnter={() => setSel(idx)}
            onClick={i.run}
            className={cx("w-full flex items-center gap-3 px-2.5 h-9 rounded-md text-left text-[13px]", idx === active ? "bg-accent-soft" : "hover:bg-hover")}
          >
            <Icon name={i.icon} className={cx("size-3.5", idx === active ? "text-accent" : "text-faint")} />
            <span className="w-14 text-[12px] text-muted flex-none">{i.kind}</span>
            <span className="font-medium truncate">{i.label}</span>
            {i.hint && <span className="ml-auto text-[12px] text-faint font-mono truncate">{i.hint}</span>}
          </button>
        ))}
        {!items.length && <div className="px-3 py-6 text-center text-muted text-[13px]">맞는 결과가 없어요.</div>}
      </div>
    </div>
  );
}
