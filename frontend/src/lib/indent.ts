import type { KeyboardEvent } from "react";

/** Two spaces: YAML forbids tabs, and scripts read fine with spaces. */
const UNIT = "  ";

/** Replaces [from, to) the way typing would, so the change reaches React and stays in undo history. */
function replace(ta: HTMLTextAreaElement, from: number, to: number, text: string) {
  ta.setSelectionRange(from, to);
  if (!document.execCommand("insertText", false, text)) {
    ta.setRangeText(text, from, to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Editor-style Tab for a textarea: Tab indents, Shift+Tab outdents.
 * With a selection, the whole selected lines move; with a caret, Tab inserts the indent.
 */
export function indentOnTab(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  const ta = e.currentTarget;
  const { value, selectionStart: start, selectionEnd: end } = ta;

  if (!e.shiftKey && start === end) {
    replace(ta, start, end, UNIT);
    return;
  }

  // The selected lines; a selection ending right after a newline doesn't take the next line.
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", last);
  const to = nl === -1 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");

  let firstDelta = 0;
  let total = 0;
  const next = lines.map((line, i) => {
    let out: string;
    if (e.shiftKey) {
      const cut = line.startsWith("\t") ? 1 : line.match(/^ {0,2}/)![0].length;
      out = line.slice(cut);
    } else {
      out = line ? UNIT + line : line;
    }
    const d = out.length - line.length;
    if (i === 0) firstDelta = d;
    total += d;
    return out;
  });
  if (!total) return;

  replace(ta, from, to, next.join("\n"));
  // A selection starting at a line's beginning keeps starting there, as in editors.
  const s = start === from && start !== end ? from : Math.max(from, start + firstDelta);
  ta.setSelectionRange(s, start === end ? s : end + total);
}
