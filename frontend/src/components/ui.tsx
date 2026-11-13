import {
  Children,
  forwardRef,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import type { Status } from "../lib/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------- buttons ---------- */

type BtnVariant = "default" | "primary" | "ghost" | "danger" | "dangerGhost";
const btnBase =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none " +
  "transition-[background,box-shadow,transform,color,border-color] duration-150 active:translate-y-px disabled:opacity-40 disabled:pointer-events-none";
const btnVariants: Record<BtnVariant, string> = {
  default: "bg-surface text-fg border border-line-strong shadow-xs hover:bg-surface-2 hover:shadow-[var(--elev-xs),0_2px_6px_-2px_rgba(16,24,40,.08)]",
  primary:
    "text-primary-fg border border-black/5 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_88%,white),var(--primary))] shadow-primary hover:brightness-110 hover:-translate-y-px active:shadow-xs",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger: "bg-surface text-bad border border-line-strong shadow-xs hover:bg-bad-soft hover:border-bad/40",
  dangerGhost: "text-bad hover:bg-bad-soft",
};
const btnSizes = { md: "h-8 px-3 text-[13px]", sm: "h-7 px-2.5 text-[12.5px]", lg: "h-9 px-4 text-[13.5px]" };

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: keyof typeof btnSizes;
  icon?: IconName;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "default", size = "md", icon, iconOnly, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(btnBase, btnVariants[variant], btnSizes[size], iconOnly && (size === "sm" ? "w-7 px-0" : "w-8 px-0"), className)}
      {...rest}
    >
      {icon && <Icon name={icon} className={size === "sm" ? "size-3.5" : "size-[15px]"} />}
      {children}
    </button>
  );
});

/* ---------- surfaces ---------- */

export function Card({ className, children, hover }: { className?: string; children: ReactNode; hover?: boolean }) {
  return (
    <div
      className={cx(
        "bg-surface rounded-xl shadow-soft min-w-0 overflow-hidden", // clip table headers to the rounded corners
        hover && "transition-[box-shadow,transform] duration-200 ease-(--ease-soft) hover:shadow-lift hover:-translate-y-0.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, sub, children, className }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between gap-3 px-5 py-3.5 border-b border-line flex-wrap", className)}>
      <div className="min-w-0">
        <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-1.5 flex-wrap">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.025em] leading-tight">{title}</h1>
        {desc && <p className="mt-1.5 text-muted max-w-[72ch] text-[13px] leading-relaxed">{desc}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  // relative: absolutely positioned children (e.g. sr-only labels) stay inside the scroll box instead of widening the page
  return <div className="relative overflow-x-auto scroll-soft">{children}</div>;
}

export function ListItem({ icon, title, sub, children, className }: { icon?: IconName; title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 min-w-0", className)}>
      {icon && (
        <span className="grid place-items-center size-8 rounded-lg bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)] flex-none">
          <Icon name={icon} className="size-3.5" />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title}</div>
        {sub && <div className="text-[12px] text-muted truncate">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/* ---------- status ---------- */

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";
const dotColor: Record<Tone, string> = {
  neutral: "var(--faint)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  accent: "var(--accent)",
};

/** Text with a small status dot. */
export function Dot({ tone = "neutral", pulse, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium whitespace-nowrap">
      <span className={cx("dot", pulse && "animate-pulse-dot")} style={{ ["--dot" as string]: dotColor[tone] }} />
      {children}
    </span>
  );
}

const chipTone: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  ok: "bg-ok-soft text-ok border-ok/20",
  warn: "bg-warn-soft text-warn border-warn/25",
  bad: "bg-bad-soft text-bad border-bad/20",
  accent: "bg-accent-soft text-accent border-accent/20",
};

/** Small square-ish label. */
export function Chip({ tone = "neutral", mono, icon, children, className }: { tone?: Tone; mono?: boolean; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 h-5 px-1.5 rounded-[5px] border text-[11.5px] font-medium whitespace-nowrap",
        chipTone[tone],
        mono && "font-mono text-[11px]",
        className,
      )}
    >
      {icon && <Icon name={icon} className="size-3" />}
      {children}
    </span>
  );
}

/** A run's or job's state, in the same words everywhere: 대기, 진행중, 완료, 실패 (and 취소, 거절). */
export function StatusPill({ status }: { status: Status }) {
  switch (status) {
    case "ok":
      return <Dot tone="ok">완료</Dot>;
    case "bad":
      return <Dot tone="bad">실패</Dot>;
    case "run":
      return (
        <Dot tone="accent" pulse>
          진행중
        </Dot>
      );
    case "cancel":
      return <Dot>취소</Dot>;
    case "approval":
      return (
        <Dot tone="warn" pulse>
          대기
        </Dot>
      );
    case "rejected":
      return <Dot tone="bad">거절</Dot>;
    default:
      return <Dot tone="warn">주의</Dot>;
  }
}

/* ---------- banner ---------- */

export function Banner({ tone = "info", icon, title, children }: { tone?: "info" | "warn" | "neutral"; icon: IconName; title?: ReactNode; children?: ReactNode }) {
  return (
    <div
      className={cx(
        "flex gap-2.5 items-start px-4 py-3 rounded-xl text-[13px] text-muted",
        tone === "warn" ? "bg-warn-soft shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warn)_28%,transparent),var(--elev-xs)]" : "bg-surface shadow-soft",
      )}
    >
      <Icon name={icon} className={cx("size-4 mt-px flex-none", tone === "warn" ? "text-warn" : "text-accent")} />
      <div className="min-w-0">
        {title && <b className="block font-semibold text-fg mb-0.5">{title}</b>}
        {children}
      </div>
    </div>
  );
}

/* ---------- form ---------- */

const inputBase =
  "w-full min-w-0 rounded-lg bg-surface border border-line-strong shadow-xs " +
  "transition-[border-color,box-shadow] duration-100 hover:border-faint " +
  "focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] " +
  "placeholder:text-faint disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputBase, "h-8 px-2.5", mono && "font-mono text-[12.5px]", className)} {...rest} />;
});

/* ---------- select (div-based "select-only combobox") ---------- */

interface SelectOption {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

/** Plain text of a React node, for type-ahead and for <option> without a value. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Reads <option> children (also inside fragments and arrays) like a native <select> would. */
function readOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)) return;
    if (child.type === Fragment) {
      out.push(...readOptions(child.props.children));
    } else if (child.type === "option") {
      const { value, children: label, disabled } = child.props;
      out.push({ value: value !== undefined ? String(value) : textOf(label), label, text: textOf(label), disabled: !!disabled });
    }
  });
  return out;
}

interface SelectProps {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  children?: ReactNode;
  id?: string;
  mono?: boolean;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}

/**
 * Dropdown built from divs instead of a native <select>, keeping the same API:
 * <option> children and onChange(e) with e.target.value. The list is portaled to
 * <body> so cards and modals never clip it, and it flips upward near the bottom.
 */
export function Select({ value, onChange, children, id, mono, className, disabled, placeholder, autoFocus, "aria-label": ariaLabel }: SelectProps) {
  const options = readOptions(children);
  const current = String(value ?? "");
  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = options[selectedIndex];
  const listId = useId();
  const trigger = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = Math.min(280, options.length * 34 + 10);
    const up = below < want && above > below;
    setPos({ left: r.left, width: Math.max(r.width, 160), maxHeight: Math.max(120, Math.min(280, up ? above : below)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [options.length]);

  const enabled = (i: number) => i >= 0 && i < options.length && !options[i].disabled;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  };
  const openList = (at = selectedIndex >= 0 ? selectedIndex : step(-1, 1)) => {
    if (disabled || !options.length) return;
    setActive(at);
    place();
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const choose = (i: number) => {
    if (!enabled(i)) return;
    if (options[i].value !== current) onChange?.({ target: { value: options[i].value } });
    close();
  };

  useEffect(() => {
    if (autoFocus) trigger.current?.focus();
  }, [autoFocus]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) close(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // capture: also follows scrolling inside modals
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const typeAhead = (ch: string) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + ch.toLowerCase(), at: now };
    const start = open ? active : selectedIndex;
    const order = [...options.keys()].map((k) => (k + Math.max(start, 0) + (typed.current.text.length === 1 ? 1 : 0)) % options.length);
    const hit = order.find((i) => enabled(i) && options[i].text.toLowerCase().startsWith(typed.current.text));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else choose(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        openList(k === "ArrowUp" && selectedIndex < 0 ? step(options.length, -1) : undefined);
      } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        typeAhead(k);
      }
      return;
    }
    if (k === "ArrowDown") (e.preventDefault(), setActive((a) => step(a, 1)));
    else if (k === "ArrowUp") (e.preventDefault(), setActive((a) => step(a, -1)));
    else if (k === "Home") (e.preventDefault(), setActive(step(-1, 1)));
    else if (k === "End") (e.preventDefault(), setActive(step(options.length, -1)));
    else if (k === "Enter" || k === " ") (e.preventDefault(), choose(active));
    else if (k === "Escape") (e.preventDefault(), e.stopPropagation(), close());
    else if (k === "Tab") close(false);
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeAhead(k);
  };

  return (
    <div className={cx("relative", className ?? "w-full")}>
      <div
        ref={trigger}
        id={id}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && enabled(active) ? `${listId}-${active}` : undefined}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        aria-labelledby={!ariaLabel && id ? `${id}-label` : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={cx(
          inputBase,
          "h-8 pl-2.5 pr-8 flex items-center cursor-pointer select-none outline-none",
          open && "border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]",
          disabled && "opacity-50 cursor-not-allowed hover:border-line-strong",
          mono && "font-mono text-[12.5px]",
        )}
      >
        <span className={cx("truncate", !selected && "text-faint")}>{selected ? selected.label : placeholder ?? "선택하세요"}</span>
      </div>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">
        <Icon name="chev" className={cx("size-3.5 transition-transform duration-150", open && "rotate-180")} />
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-labelledby={id ? `${id}-label` : undefined}
            aria-label={ariaLabel}
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[70] overflow-auto scroll-soft rounded-xl bg-surface shadow-pop p-1 animate-fade"
          >
            {options.map((o, i) => (
              <div
                key={`${o.value}-${i}`}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selectedIndex}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => enabled(i) && setActive(i)}
                onMouseDown={(e) => e.preventDefault()} // keep focus on the trigger
                onClick={() => choose(i)}
                className={cx(
                  "flex items-center gap-2 min-h-[30px] px-2 py-1 rounded-lg text-[13px] cursor-pointer",
                  mono && "font-mono text-[12.5px]",
                  i === active && "bg-hover",
                  i === selectedIndex && "font-medium text-primary",
                  o.disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <span className="flex-1 min-w-0 truncate">{o.label}</span>
                {i === selectedIndex && <Icon name="check" className="size-3.5 flex-none" strokeWidth={2.4} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, "px-2.5 py-2 font-mono text-[12px] leading-[1.65] resize-y", className)} {...rest} />;
});

export function Field({ label, hint, htmlFor, children, right, error }: { label?: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; right?: ReactNode; error?: boolean }) {
  return (
    <div className="field flex flex-col gap-1.5 min-w-0">
      {(label || right) && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {label && (
            <label
              htmlFor={htmlFor}
              id={htmlFor ? `${htmlFor}-label` : undefined}
              className="field-label text-[12.5px] font-medium"
              onClick={() => htmlFor && document.getElementById(htmlFor)?.getAttribute("role") === "combobox" && document.getElementById(htmlFor)?.focus()}
            >
              {label}
            </label>
          )}
          {right}
        </div>
      )}
      {children}
      {hint && <span className={cx("text-[12px]", error ? "text-bad" : "text-muted")}>{hint}</span>}
    </div>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("text-[12px] text-muted", className)}>{children}</span>;
}

export const TOAST_ERROR_EVENT = "wharfline:error-toast";

/**
 * Form errors are easy to miss at the bottom of a form, so they show as an error toast instead.
 * The toast shows when the message changes, and again on each submit of the same dialog while the
 * message is still there (otherwise a repeated mistake would look like the button does nothing).
 */
export function ErrorText({ children }: { children?: ReactNode }) {
  const text = typeof children === "string" ? children : "";
  const latest = useRef(text);
  latest.current = text;
  const shownAt = useRef(0);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!text) return;
    window.dispatchEvent(new CustomEvent(TOAST_ERROR_EVENT, { detail: text }));
    shownAt.current = Date.now();
  }, [text]);
  useEffect(() => {
    const onSubmit = (e: Event) => {
      const mine = anchor.current?.closest("[role=dialog]");
      const theirs = (e.target as HTMLElement).closest?.("[role=dialog]");
      if (mine && theirs && mine !== theirs) return;
      setTimeout(() => {
        if (latest.current && Date.now() - shownAt.current > 400) {
          window.dispatchEvent(new CustomEvent(TOAST_ERROR_EVENT, { detail: latest.current }));
          shownAt.current = Date.now();
        }
      }, 0);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);
  if (children && !text) return <div className="text-[12.5px] text-bad bg-bad-soft border border-bad/20 rounded-md px-2.5 py-2 animate-fade">{children}</div>;
  return <span ref={anchor} hidden />;
}

export function Seg<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-[3px] rounded-lg bg-hover shadow-[inset_0_1px_2px_rgba(16,24,40,.06)] gap-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "px-2.5 h-6 rounded-md text-[12.5px] font-medium transition-all duration-150",
            value === o.value ? "bg-surface text-fg shadow-[0_0_0_1px_rgba(16,24,40,.06),0_1px_3px_rgba(16,24,40,.12)]" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-[18px] w-[30px] flex-none rounded-full transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span className={cx("absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-transform duration-150", checked && "translate-x-3")} />
    </button>
  );
}

export function Check({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: ReactNode; desc?: ReactNode }) {
  return (
    <label className="flex gap-2.5 items-start text-[13px] cursor-pointer rounded-md -mx-2 px-2 py-1.5 hover:bg-hover transition-colors">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-[2px] accent-(--accent) size-3.5" />
      <span>
        {title}
        {desc && <small className="block text-muted text-[12px] mt-px">{desc}</small>}
      </span>
    </label>
  );
}

export function KV({ items, labelWidth = 84 }: { items: [ReactNode, ReactNode, string?][]; labelWidth?: number }) {
  return (
    <dl className="grid gap-x-3 gap-y-1.5 text-[13px] m-0" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      {items.map(([k, v, cls], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className={cx("m-0 min-w-0 truncate", cls)}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-muted text-[13px]">{children}</div>;
}

export function Loading() {
  return (
    <div className="flex flex-col gap-4 animate-fade">
      <div className="h-6 w-48 rounded-md bg-surface shadow-soft" />
      <div className="h-32 rounded-xl bg-surface shadow-soft" />
      <div className="h-56 rounded-xl bg-surface shadow-soft" />
    </div>
  );
}
