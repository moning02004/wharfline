import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./ui";

export interface TreeFile {
  path: string;
  /** Shown at the right end of the row (a mark, a button). */
  trailing?: ReactNode;
  /** Shown crossed out and muted (e.g. removed, still restorable). */
  struck?: boolean;
}

type Node = { name: string; path: string; dirs: Map<string, Node>; files: TreeFile[] };

function build(files: TreeFile[]): Node {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    parts.slice(0, -1).forEach((p, i) => {
      if (!at.dirs.has(p)) at.dirs.set(p, { name: p, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      at = at.dirs.get(p)!;
    });
    at.files.push(f);
  }
  return root;
}

/** Files as folders and files, folders first, each folder folded or open (all open at first). */
export function FileTree({ files, selected, onSelect, mono = true, className }: { files: TreeFile[]; selected?: string | null; onSelect?: (path: string) => void; mono?: boolean; className?: string }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (p: string) => setClosed((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s).add(p)));
  const pad = (depth: number) => ({ paddingLeft: 8 + depth * 14 });

  const render = (n: Node, depth: number): ReactNode[] => [
    ...[...n.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((d) => [
        <button
          key={`d:${d.path}`}
          type="button"
          onClick={() => toggle(d.path)}
          aria-expanded={!closed.has(d.path)}
          style={pad(depth)}
          className="flex items-center gap-1.5 w-full rounded-lg pr-2 py-1 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg min-w-0"
        >
          <Icon name="chev" className={cx("size-3 flex-none transition-transform", closed.has(d.path) && "-rotate-90")} />
          <Icon name="folder" className="size-3.5 flex-none text-faint" />
          <span className={cx("truncate", mono && "font-mono")}>{d.name}</span>
        </button>,
        ...(closed.has(d.path) ? [] : render(d, depth + 1)),
      ]),
    ...[...n.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const name = f.path.split("/").pop();
        const on = selected === f.path;
        const inner = (
          <>
            <span className="size-3 flex-none" />
            <Icon name="file" className={cx("size-3.5 flex-none", on ? "text-accent" : "text-faint")} />
            <span className={cx("truncate flex-1", mono && "font-mono", f.struck && "line-through")}>{name}</span>
            {f.trailing}
          </>
        );
        const cls = cx(
          "flex items-center gap-1.5 w-full rounded-lg pr-2 py-1 text-left text-[12.5px] min-w-0",
          f.struck ? "text-faint" : on ? "bg-accent-soft text-fg" : "text-muted",
          onSelect && !f.struck && !on && "hover:bg-hover hover:text-fg",
        );
        return onSelect && !f.struck ? (
          <button key={f.path} type="button" title={f.path} style={pad(depth)} className={cls} onClick={() => onSelect(f.path)}>
            {inner}
          </button>
        ) : (
          <div key={f.path} title={f.path} style={pad(depth)} className={cls}>
            {inner}
          </div>
        );
      }),
  ];

  return <div className={cx("flex flex-col gap-px", className)}>{render(build(files), 0)}</div>;
}
