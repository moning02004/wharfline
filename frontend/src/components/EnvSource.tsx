import { useRef, useState, type KeyboardEvent } from "react";
import { parseEnv } from "../lib/api";
import { useApp } from "../lib/app";
import { Icon } from "./Icon";
import { Button, Field, Select, Seg, cx } from "./ui";
import { EnvWorkspaceModal } from "../modals/EnvWorkspace";

export type EnvMode = "paste" | "upload" | "existing";

/**
 * A .env editor: the text as it is (comments, blank lines and order are saved with it), line numbers, no wrapping.
 * Grows with the text from minRows to maxRows, then scrolls.
 */
export function EnvEditor({
  value,
  onChange,
  minRows = 8,
  maxRows = 24,
  label = ".env 내용",
  placeholder = "# 주석도 그대로 저장돼요\nDATABASE_URL=postgres://...\nREDIS_URL=redis://...",
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
  maxRows?: number;
  label?: string;
  placeholder?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split("\n").length;
  const rows = Math.min(maxRows, Math.max(minRows, lines + 1));
  return (
    <div
      className={cx(
        "flex rounded-lg bg-surface border border-line-strong shadow-xs overflow-hidden transition-[border-color,box-shadow] duration-100",
        "hover:border-faint focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]",
      )}
    >
      {/* The numbers sit in an absolute layer, so only the textarea sets the height; scrolling moves both. */}
      <div aria-hidden className="relative shrink-0 bg-surface-2 border-r border-line" style={{ width: `calc(${String(lines).length}ch + 1.25rem)` }}>
        <div
          ref={gutter}
          className="absolute inset-0 select-none overflow-hidden py-2 px-2 text-right font-mono text-[12px] leading-[1.65] text-faint tabular-nums"
        >
          {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
      </div>
      <textarea
        aria-label={label}
        rows={rows}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={onKeyDown}
        className="flex-1 min-w-0 bg-transparent px-2.5 py-2 font-mono text-[12px] leading-[1.65] resize-none outline-none overflow-auto scroll-soft placeholder:text-faint"
      />
    </div>
  );
}

/** .env input: paste text, upload a file (read in the browser), or pick a saved set. */
export function EnvSource({
  text,
  setText,
  mode,
  setMode,
  existing,
  picked,
  setPicked,
  existingOnly,
}: {
  text: string;
  setText: (v: string) => void;
  mode: EnvMode;
  setMode: (m: EnvMode) => void;
  existing?: string[];
  picked?: string;
  setPicked?: (v: string) => void;
  /** Only "저장된 것 쓰기": for members who may not write .env values */
  existingOnly?: boolean;
}) {
  const { toast, openModal } = useApp();
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const vars = parseEnv(text);

  const read = (f?: File) => {
    if (!f) return;
    if (f.size > 64 * 1024) return toast("64KB보다 큰 파일은 올릴 수 없어요");
    const r = new FileReader();
    r.onload = () => {
      setText(String(r.result));
      setMode("paste");
      toast(`${f.name}을(를) 읽었어요`);
    };
    r.readAsText(f);
  };

  // The same text in the big .env editor; 적용 puts it back here (it is saved with the form).
  const openEditor = () =>
    openModal(
      (c) => (
        <EnvWorkspaceModal
          initial={text}
          saved={null}
          saveLabel="적용"
          note="적용하면 이 화면에 들어가고, 저장할 때 함께 저장돼요."
          onClose={c}
          onSave={(t) => {
            setText(t);
            c();
          }}
        />
      ),
      "full",
    );

  const opts: { value: EnvMode; label: string }[] = existingOnly
    ? []
    : [
        { value: "paste", label: "붙여넣기" },
        { value: "upload", label: "파일 올리기" },
      ];
  if (existing) opts.push({ value: "existing", label: "저장된 것 쓰기" });

  return (
    <Field
      label=".env"
      right={
        <span className="flex items-center gap-1.5 flex-wrap justify-end">
          {mode === "paste" && (
            <Button size="sm" icon="edit" onClick={openEditor}>
              편집기
            </Button>
          )}
          <Seg options={opts} value={mode} onChange={setMode} />
        </span>
      }
      hint={
        mode !== "existing" &&
        (vars.length
          ? `변수 ${vars.length}개 인식: ${vars.map((v) => v[0]).join(", ")} · # 주석과 빈 줄도 그대로 저장돼요`
          : "인식된 변수가 없어요. KEY=VALUE 형식으로 적어 주세요.")
      }
    >
      {mode === "paste" && (
        <EnvEditor value={text} onChange={setText} minRows={6} maxRows={18} />
      )}
      {mode === "upload" && (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            read(e.dataTransfer.files[0]);
          }}
          className={cx(
            "flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-6 text-center text-[13px] cursor-pointer transition-all duration-200",
            over ? "border-accent bg-accent-soft text-accent " : "border-line-strong bg-surface-2 text-muted hover:border-accent hover:bg-accent-soft hover:text-accent",
          )}
        >
          <span className="grid place-items-center size-9 rounded-md bg-surface border border-line mb-1">
            <Icon name="upload" />
          </span>
          <div>.env 파일을 끌어다 놓거나 눌러서 고르세요</div>
          <div className="text-faint text-xs">파일은 브라우저에서 읽은 뒤 암호화되어 저장돼요</div>
          <input ref={file} type="file" hidden onChange={() => read(file.current?.files?.[0])} />
        </label>
      )}
      {mode === "existing" && existing && (
        <Select value={picked} onChange={(e) => setPicked?.(e.target.value)}>
          {existing.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </Select>
      )}
    </Field>
  );
}
