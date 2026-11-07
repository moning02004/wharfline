import { useEffect, type ReactNode } from "react";
import { Button, cx } from "./ui";

export type ModalSize = "sm" | "md" | "wide";

const sizes: Record<ModalSize, string> = {
  sm: "max-w-[520px]",
  md: "max-w-[680px]",
  wide: "max-w-[1000px] h-[min(720px,100%)]",
};

export function ModalShell({ size = "sm", onClose, children, top }: { size?: ModalSize; onClose: () => void; children: ReactNode; top: boolean }) {
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [top, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade bg-[rgba(10,12,20,.42)] backdrop-blur-[3px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx("bg-surface rounded-2xl shadow-pop w-full max-h-full flex flex-col min-h-0 animate-rise overflow-hidden", sizes[size])}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHead({ title, sub, onClose, border, extra }: { title: ReactNode; sub?: ReactNode; onClose: () => void; border?: boolean; extra?: ReactNode }) {
  return (
    <div className={cx("flex items-start gap-3 px-5 pt-4 pb-3", border && "border-b border-line")}>
      <div className="min-w-0">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
        {sub && <p className="mt-0.5 text-muted text-[12.5px]">{sub}</p>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {extra}
        <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="닫기" onClick={onClose} />
      </div>
    </div>
  );
}

export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("modal-body px-5 pt-1 pb-5 overflow-auto scroll-soft flex flex-col gap-5 min-h-0 flex-1", className)}>{children}</div>;
}

export function ModalFoot({ children, between }: { children: ReactNode; between?: boolean }) {
  return (
    <div className={cx("flex items-center gap-2 px-5 py-3 border-t border-line bg-surface-2 flex-wrap", between ? "justify-between" : "justify-end")}>
      {children}
    </div>
  );
}
