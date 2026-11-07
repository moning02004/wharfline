import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Host } from "../lib/types";
import { Icon } from "./Icon";
import { Chip, cx } from "./ui";

/** Expandable multi-select of inventory groups. Empty selection means "all servers". */
export function GroupSelect({ groups, value, onChange }: { groups: Record<string, Host[]>; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all = Object.keys(groups);
  const total = Object.values(groups).reduce((a, h) => a + h.length, 0);
  const rest = all.filter((g) => !value.includes(g));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Open upward when there is no room below (e.g. near the bottom of a modal).
  useLayoutEffect(() => {
    if (!open || !menu.current || !wrap.current) return;
    const scroller = wrap.current.closest(".overflow-auto") ?? document.documentElement;
    const box = scroller.getBoundingClientRect();
    const r = wrap.current.getBoundingClientRect();
    const h = menu.current.offsetHeight;
    setUp(r.bottom + h + 8 > box.bottom && r.top - h - 8 > box.top);
  }, [open, value.length]);

  const add = (g: string) => {
    const next = [...value, g];
    onChange(next.length === all.length ? [] : next);
    if (next.length === all.length) setOpen(false);
  };

  return (
    <div className="relative" ref={wrap}>
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cx(
          "flex flex-wrap items-center gap-1.5 min-h-8 py-[3px] pl-1 pr-10 rounded-md bg-surface border relative transition-[border-color,box-shadow] duration-200",
          open ? "border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]" : "border-line-strong hover:border-faint",
        )}
      >
        {value.length ? (
          value.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5 h-6 pl-2 pr-0.5 rounded-[5px] border border-accent/20 bg-accent-soft text-accent font-mono text-xs font-medium animate-fade">
              {g}
              <small className="text-muted font-sans text-[11px] font-normal">{groups[g]?.length ?? 0}대</small>
              <button
                type="button"
                aria-label={`${g} 빼기`}
                className="grid place-items-center size-5 rounded hover:bg-accent/20"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((x) => x !== g));
                }}
              >
                <Icon name="x" className="size-3" />
              </button>
            </span>
          ))
        ) : (
          <span className="text-muted px-2 text-[13.5px]">전체 서버 · {total}대</span>
        )}
        <span className={cx("absolute right-3 top-1/2 -translate-y-1/2 text-faint transition-transform duration-200", open && "rotate-180")}>
          <Icon name="chev" />
        </span>
      </div>
      {open && (
        <div
          ref={menu}
          role="listbox"
          className={cx(
            "absolute inset-x-0 z-20 max-h-[260px] overflow-auto scroll-soft rounded-xl bg-surface shadow-pop p-1 flex flex-col animate-rise",
            up ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
          )}
        >
          {rest.length ? (
            rest.map((g) => (
              <button key={g} type="button" role="option" onClick={() => add(g)} className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[13px] hover:bg-hover transition-colors min-w-0">
                <Chip tone="accent" mono>
                  {g}
                </Chip>
                <span className="font-mono text-[12.5px] text-muted flex-1 truncate">{groups[g].map((h) => h.ip).join(", ")}</span>
                <span className="text-faint tabular-nums">{groups[g].length}대</span>
              </button>
            ))
          ) : (
            <div className="p-2.5 text-muted text-[12.5px]">모든 그룹을 골랐어요.</div>
          )}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[13px] hover:bg-hover transition-colors"
            >
              <Icon name="server" className="text-faint" />
              전체 서버로 되돌리기
            </button>
          )}
        </div>
      )}
    </div>
  );
}
