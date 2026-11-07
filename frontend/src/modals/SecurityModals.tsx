import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApp } from "../lib/app";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, ErrorText, Field } from "../components/ui";
import { copyText } from "./ResourceModals";

/** Six single-digit boxes with auto-advance, backspace and paste support. */
export function OtpInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const set = (i: number, d: string) => {
    const arr = [...digits];
    arr[i] = d;
    onChange(arr.join("").slice(0, 6));
  };
  return (
    <div className="flex gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          inputMode="numeric"
          maxLength={1}
          aria-label={`${i + 1}번째 숫자`}
          autoFocus={autoFocus && i === 0}
          value={d}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            set(i, v);
            if (v && refs.current[i + 1]) refs.current[i + 1]!.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && refs.current[i - 1]) refs.current[i - 1]!.focus();
          }}
          onPaste={(e) => {
            const p = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
            if (p) {
              e.preventDefault();
              onChange(p);
              refs.current[Math.min(p.length, 5)]?.focus();
            }
          }}
          className="w-11 h-[52px] min-w-0 text-center text-xl font-mono rounded-lg bg-surface border border-line-strong shadow-[0_1px_2px_rgba(0,0,0,.03)] transition-[border-color,box-shadow,transform] duration-200 focus:outline-none focus:border-accent focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)] focus:-translate-y-px"
        />
      ))}
    </div>
  );
}

/** Decorative QR-like pattern for the prototype. A real build renders the otpauth:// URI. */
function FakeQR() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const n = 25;
    const s = c.width / (n + 4);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#10141b";
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const finder = (x: number, y: number) => {
      for (let i = 0; i < 7; i++)
        for (let j = 0; j < 7; j++) {
          const e = i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          if (e) ctx.fillRect((x + i + 2) * s, (y + j + 2) * s, s, s);
        }
    };
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const inF = (i < 8 && j < 8) || (i > n - 9 && j < 8) || (i < 8 && j > n - 9);
        if (!inF && rnd() > 0.52) ctx.fillRect((i + 2) * s, (j + 2) * s, s, s);
      }
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
  }, []);
  return <canvas ref={ref} width={296} height={296} aria-label="QR 코드 예시" className="rounded-lg border border-line bg-white size-[148px]" />;
}

export function TfaSetupModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { openModal } = useApp();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ codes: string[] }>("/security/tfa/verify", { code });
      onClose();
      openModal((close) => <CodesModal codes={r.codes} onClose={close} />);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <>
      <ModalHead title="인증 앱 연결" sub="다시 설정하면 기존 인증 앱은 더 이상 쓸 수 없어요." onClose={onClose} />
      <form id="tfaForm" onSubmit={submit} className="contents">
        <ModalBody>
          <div className="flex gap-5 items-center flex-wrap">
            <FakeQR />
            <div className="flex-1 min-w-[180px] flex flex-col gap-2">
              <b className="font-semibold">1. 인증 앱으로 QR을 찍으세요</b>
              <span className="text-muted text-[13px]">찍을 수 없다면 이 키를 직접 입력하세요.</span>
              <span className="font-mono bg-surface-2 px-3 py-1.5 rounded-md self-start">{secret}</span>
            </div>
          </div>
          <Field label="2. 앱에 표시된 6자리 숫자">
            <OtpInput value={code} onChange={setCode} autoFocus />
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="tfaForm" disabled={code.length !== 6}>
          확인
        </Button>
      </ModalFoot>
    </>
  );
}

export function CodesModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { toast } = useApp();
  return (
    <>
      <ModalHead title="복구 코드" sub="휴대폰을 잃어버렸을 때 한 번씩 쓸 수 있어요. 이 화면을 닫으면 다시 볼 수 없어요." onClose={onClose} />
      <ModalBody>
        <div className="grid grid-cols-2 gap-2 font-mono text-[13px] bg-surface-2 px-5 py-4 rounded-lg">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <Banner tone="warn" icon="alert">
          비밀번호 관리자 같은 안전한 곳에 저장하세요. 예전 복구 코드는 모두 무효가 됐어요.
        </Banner>
      </ModalBody>
      <ModalFoot>
        <Button icon="copy" onClick={() => copyText(codes.join("\n"), toast)}>
          복사
        </Button>
        <Button variant="primary" onClick={onClose}>
          저장했어요
        </Button>
      </ModalFoot>
    </>
  );
}
