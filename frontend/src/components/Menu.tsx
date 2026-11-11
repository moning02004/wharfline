import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { cx } from "./ui";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown as the item's tooltip, e.g. why it is disabled. */
  title?: string;
}

/** A "⋮" button that opens a small list of actions. Fixed-positioned, so table scrolling never clips it. */
export function MoreMenu({ items, label = "더 보기" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = menu.current?.offsetHeight ?? 0;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    setPos({ top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h), right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx("grid place-items-center size-7 rounded-md text-muted hover:bg-hover hover:text-fg transition-colors", open && "bg-hover text-fg")}
      >
        <Icon name="dots" className="size-4" />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          style={pos ? { top: pos.top, right: pos.right } : { visibility: "hidden" }}
          className="fixed z-50 min-w-[148px] rounded-xl bg-surface shadow-pop p-1 flex flex-col animate-rise"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={cx(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-[13px] transition-colors",
                it.disabled ? "text-faint cursor-not-allowed" : it.danger ? "text-bad hover:bg-bad-soft" : "hover:bg-hover",
              )}
            >
              {it.icon && <Icon name={it.icon} className="size-3.5" />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
