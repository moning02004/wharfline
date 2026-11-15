import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Host } from "../lib/types";
import { Icon } from "./Icon";
import { Chip, cx } from "./ui";

/** Expandable multi-select of inventory groups. Empty selection means "all servers". */
export function GroupSelect({ groups, value, onChange }: { groups: Record<string, Host[]>; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all = Object.keys(groups);
  const total = Object.values(groups).reduce((a, h) => a + h.length, 0);
  const rest = all.filter((g) => !value.includes(g));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The list floats over the page (outside cards that clip their content) and opens upward when there is no room below.
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      if (!wrap.current) return;
      const r = wrap.current.getBoundingClientRect();
      const h = menu.current?.offsetHeight ?? 0;
      const up = r.bottom + h + 8 > window.innerHeight && r.top - h - 8 > 0;
      setPos(up ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6 } : { left: r.left, width: r.width, top: r.bottom + 6 });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
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
      {open && createPortal(
        <div
          ref={menu}
          role="listbox"
          style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
          className="fixed z-[60] max-h-[260px] overflow-auto scroll-soft rounded-xl bg-surface shadow-pop p-1 flex flex-col animate-rise"
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
        </div>,
        document.body,
      )}
    </div>
  );
}
