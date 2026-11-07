import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./Icon";
import type { Status } from "../lib/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------- buttons ---------- */

type BtnVariant = "default" | "primary" | "ghost" | "danger" | "dangerGhost";
const btnBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none";
const btnVariants: Record<BtnVariant, string> = {
  default: "bg-surface text-fg border border-line-strong shadow-[0_1px_1px_rgba(0,0,0,.03)] hover:bg-hover",
  primary: "bg-primary text-primary-fg border border-primary hover:opacity-90",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger: "bg-surface text-bad border border-line-strong hover:bg-bad-soft hover:border-bad/40",
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
    <div className={cx("bg-surface rounded-lg border border-line min-w-0", hover && "transition-colors duration-100 hover:border-line-strong", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, sub, children, className }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between gap-3 px-4 py-3 border-b border-line flex-wrap", className)}>
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
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.02em] leading-tight">{title}</h1>
        {desc && <p className="mt-1.5 text-muted max-w-[72ch] text-[13px] leading-relaxed">{desc}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto scroll-soft">{children}</div>;
}

export function ListItem({ icon, title, sub, children, className }: { icon?: IconName; title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 min-w-0", className)}>
      {icon && (
        <span className="grid place-items-center size-7 rounded-md border border-line bg-surface-2 text-muted flex-none">
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

export function StatusPill({ status }: { status: Status }) {
  switch (status) {
    case "ok":
      return <Dot tone="ok">성공</Dot>;
    case "bad":
      return <Dot tone="bad">실패</Dot>;
    case "run":
      return (
        <Dot tone="accent" pulse>
          실행 중
        </Dot>
      );
    case "cancel":
      return <Dot>취소됨</Dot>;
    default:
      return <Dot tone="warn">주의</Dot>;
  }
}

/* ---------- banner ---------- */

export function Banner({ tone = "info", icon, title, children }: { tone?: "info" | "warn" | "neutral"; icon: IconName; title?: ReactNode; children?: ReactNode }) {
  return (
    <div
      className={cx(
        "flex gap-2.5 items-start px-3.5 py-3 rounded-lg border text-[13px] text-muted",
        tone === "warn" ? "bg-warn-soft border-warn/25" : "bg-surface border-line",
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
  "w-full min-w-0 rounded-md bg-surface border border-line-strong shadow-[0_1px_1px_rgba(0,0,0,.02)] " +
  "transition-[border-color,box-shadow] duration-100 hover:border-faint " +
  "focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] " +
  "placeholder:text-faint disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputBase, "h-8 px-2.5", mono && "font-mono text-[12.5px]", className)} {...rest} />;
});

export function Select({ className, mono, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { mono?: boolean }) {
  return (
    <div className="relative">
      <select className={cx(inputBase, "h-8 pl-2.5 pr-8 appearance-none", mono && "font-mono text-[12.5px]", className)} {...rest}>
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">
        <Icon name="chev" className="size-3.5" />
      </span>
    </div>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, "px-2.5 py-2 font-mono text-[12px] leading-[1.65] resize-y", className)} {...rest} />;
});

export function Field({ label, hint, htmlFor, children, right, error }: { label?: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; right?: ReactNode; error?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {(label || right) && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {label && (
            <label htmlFor={htmlFor} className="text-[12.5px] font-medium">
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

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div className="text-[12.5px] text-bad bg-bad-soft border border-bad/20 rounded-md px-2.5 py-2 animate-fade">{children}</div>;
}

export function Seg<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-md bg-surface-2 border border-line gap-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "px-2.5 h-6 rounded-[5px] text-[12.5px] font-medium transition-colors duration-100",
            value === o.value ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,.06),0_0_0_1px_var(--border)]" : "text-muted hover:text-fg",
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
      <div className="h-6 w-48 rounded-md bg-surface border border-line" />
      <div className="h-32 rounded-lg bg-surface border border-line" />
      <div className="h-56 rounded-lg bg-surface border border-line" />
    </div>
  );
}
