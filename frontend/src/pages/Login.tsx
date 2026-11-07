import { useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApp } from "../lib/app";
import type { Session } from "../lib/types";
import { Icon } from "../components/Icon";
import { Button, Check, ErrorText, Field, Input } from "../components/ui";
import { OtpInput } from "../modals/SecurityModals";

export default function Login() {
  const { setSession, toast, refresh } = useApp();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("jeonghoon@acme.kr");
  const [pw, setPw] = useState("demo-password");
  const [code, setCode] = useState("482913");
  const [trust, setTrust] = useState(false);
  const [err, setErr] = useState("");

  const first = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/auth/login", { email, password: pw });
      setErr("");
      setStep(2);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const second = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSession(await api.post<Session>("/auth/totp", { code, trust }));
      refresh();
      toast("로그인했어요");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <div className="fixed inset-0 grid place-items-center p-6 overflow-auto bg-bg">
      <form
        key={step}
        onSubmit={step === 1 ? first : second}
        className="relative w-full max-w-[390px] flex flex-col gap-5 bg-surface rounded-2xl px-7 py-8 shadow-pop animate-rise"
      >
        {step === 1 ? (
          <>
            <div className="grid place-items-center size-9 rounded-md bg-primary text-primary-fg">
              <Icon name="arrow" className="size-5" strokeWidth={2.4} />
            </div>
            <div>
              <h1 className="m-0 text-[23px] tracking-[-0.03em] font-semibold">Wharfline에 로그인</h1>
              <p className="mt-1 text-muted">acme 워크스페이스</p>
            </div>
            <Field label="이메일" htmlFor="lEmail">
              <Input id="lEmail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="비밀번호" htmlFor="lPw">
              <Input id="lPw" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <ErrorText>{err}</ErrorText>
            <Button variant="primary" size="lg" type="submit">
              계속
            </Button>
            <Button size="lg" icon="key" onClick={() => toast("패스키 로그인은 브라우저 인증 창으로 진행돼요")}>
              패스키로 로그인
            </Button>
            <div className="text-xs text-faint text-center leading-relaxed">
              회원가입은 없어요. 관리자의 초대로만 계정이 만들어져요.
              <br />
              5회 실패하면 15분 동안 잠겨요.
            </div>
          </>
        ) : (
          <>
            <div>
              <h1 className="m-0 text-[23px] tracking-[-0.03em] font-semibold">2단계 인증</h1>
              <p className="mt-1 text-muted">인증 앱에 표시된 6자리 숫자를 입력하세요.</p>
            </div>
            <OtpInput value={code} onChange={setCode} autoFocus />
            <Check checked={trust} onChange={setTrust} title="이 기기를 30일 동안 기억" desc="공용 컴퓨터에서는 켜지 마세요." />
            <ErrorText>{err}</ErrorText>
            <Button variant="primary" size="lg" type="submit" disabled={code.length !== 6}>
              로그인
            </Button>
            <div className="flex justify-between">
              <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
                ← 뒤로
              </Button>
              <Button size="sm" variant="ghost" onClick={() => toast("복구 코드로 로그인하면 다른 관리자에게 알림이 가요")}>
                복구 코드 사용
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
