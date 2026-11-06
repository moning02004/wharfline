import { useRef, useState } from "react";
import { parseEnv } from "../lib/api";
import { useApp } from "../lib/app";
import { Icon } from "./Icon";
import { Field, Select, Seg, Textarea, cx } from "./ui";

export type EnvMode = "paste" | "upload" | "existing";

/** .env input: paste text, upload a file (read in the browser), or pick a saved set. */
export function EnvSource({
  text,
  setText,
  mode,
  setMode,
  existing,
  picked,
  setPicked,
}: {
  text: string;
  setText: (v: string) => void;
  mode: EnvMode;
  setMode: (m: EnvMode) => void;
  existing?: string[];
  picked?: string;
  setPicked?: (v: string) => void;
}) {
  const { toast } = useApp();
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

  const opts: { value: EnvMode; label: string }[] = [
    { value: "paste", label: "붙여넣기" },
    { value: "upload", label: "파일 올리기" },
  ];
  if (existing) opts.push({ value: "existing", label: "저장된 것 쓰기" });

  return (
    <Field
      label=".env"
      right={<Seg options={opts} value={mode} onChange={setMode} />}
      hint={mode !== "existing" && (vars.length ? `변수 ${vars.length}개 인식: ${vars.map((v) => v[0]).join(", ")}` : "인식된 변수가 없어요. KEY=VALUE 형식으로 적어 주세요.")}
    >
      {mode === "paste" && (
        <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"DATABASE_URL=postgres://...\nREDIS_URL=redis://..."} spellCheck={false} />
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
            "flex flex-col items-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed p-7 text-center text-[13px] cursor-pointer transition-all duration-200",
            over ? "border-accent bg-accent-soft text-accent scale-[1.01]" : "border-line-strong bg-surface-2 text-muted hover:border-accent hover:bg-accent-soft hover:text-accent",
          )}
        >
          <span className="grid place-items-center size-10 rounded-full bg-surface shadow-soft mb-1">
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
