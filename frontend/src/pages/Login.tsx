import { useState, type ReactNode } from "react";
import { api, errMsg } from "../lib/api";
import { useApp } from "../lib/app";
import type { Session } from "../lib/types";
import { Icon } from "../components/Icon";
import { Banner, Button, ErrorText, Field, Input } from "../components/ui";
import { OtpInput, RecoveryCodes, usePasswordForm, useTfaSetup } from "../modals/SecurityModals";
import { copyText } from "../modals/ResourceModals";

/** Sign-in. The server decides the next step (session.step), so a reload mid-login comes back to the same step. */
export default function Login() {
  const { session, setSession, toast, refresh } = useApp();
  const done = (s: Session) => {
    setSession(s);
    if (s.loggedIn) {
      refresh();
      toast("로그인했어요");
    }
  };
  const cancel = async () => setSession(await api.post<Session>("/auth/logout"));

  const step = session?.step ?? null;
  return (
    <div className="fixed inset-0 grid place-items-center p-6 overflow-auto bg-bg">
      <div key={step ?? "pw"} className="relative w-full max-w-[420px] flex flex-col gap-5 bg-surface rounded-2xl px-7 py-8 shadow-pop animate-rise">
        {step === "totp" ? (
          <TotpStep onDone={done} onBack={cancel} />
        ) : step === "password" ? (
          <NewPasswordStep onDone={done} onBack={cancel} />
        ) : step === "tfa_setup" ? (
          <TfaSetupStep onDone={done} onBack={cancel} />
        ) : (
          <PasswordStep onDone={done} samples={!!session?.sampleData} />
        )}
      </div>
    </div>
  );
}

function Title({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div>
      <h1 className="m-0 text-[23px] tracking-[-0.03em] font-semibold">{title}</h1>
      {sub && <p className="mt-1 text-muted">{sub}</p>}
    </div>
  );
}

function PasswordStep({ onDone, samples }: { onDone: (s: Session) => void; samples: boolean }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await api.post<Session>("/auth/login", { email, password: pw }));
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="contents">
      <div className="grid place-items-center size-9 rounded-md bg-primary text-primary-fg">
        <Icon name="arrow" className="size-5" strokeWidth={2.4} />
      </div>
      <Title title="Wharfline에 로그인" />
      <Field label="이메일" htmlFor="lEmail">
        <Input id="lEmail" type="email" autoComplete="username" autoFocus placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="비밀번호" htmlFor="lPw">
        <Input id="lPw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
      <ErrorText>{err}</ErrorText>
      <Button variant="primary" size="lg" type="submit" disabled={busy || !email || !pw}>
        계속
      </Button>
      <div className="text-xs text-faint text-center leading-relaxed">
        회원가입은 없어요. 관리자의 초대로만 계정이 만들어져요.
        <br />
        여러 번 틀리면 계정이 잠시 잠겨요. 비밀번호를 잊었다면 Owner에게 재설정을 부탁하세요.
      </div>
      {samples && (
      <div className="text-xs text-muted rounded-md border border-line bg-surface-2 px-3 py-2.5 leading-relaxed">
        <b className="text-fg font-medium">예시 계정</b> · 비밀번호는 서버의 <span className="font-mono">WHARFLINE_SEED_PASSWORD</span>예요 (README 참고)
        {[
          ["jeonghoon@acme.kr", "Owner · 전체"],
          ["minji@acme.kr", "Deployer · 모든 빌드"],
          ["seojun@acme.kr", "Viewer · 배치팀, batch-worker 빌드만"],
        ].map(([e, d]) => (
          <button key={e} type="button" className="flex w-full justify-between gap-2 mt-1 text-left hover:text-fg" onClick={() => setEmail(e)}>
            <span className="font-mono">{e}</span>
            <span className="text-faint">{d}</span>
          </button>
        ))}
      </div>
      )}
    </form>
  );
}

function TotpStep({ onDone, onBack }: { onDone: (s: Session) => void; onBack: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api.post<Session>("/auth/totp", { code }));
    } catch (e) {
      setErr(errMsg(e));
      setCode("");
    }
  };
  const ready = recovery ? code.trim().length >= 10 : code.length === 6;
  return (
    <form onSubmit={submit} className="contents">
      {recovery ? (
        <>
          <Title title="복구 코드로 로그인" sub="저장해 둔 복구 코드 중 하나를 입력하세요. 쓴 코드는 다시 쓸 수 없어요." />
          <Input aria-label="복구 코드" mono autoFocus placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} />
        </>
      ) : (
        <>
          <Title title="2단계 인증" sub="인증 앱에 표시된 6자리 숫자를 입력하세요." />
          <OtpInput value={code} onChange={setCode} autoFocus />
        </>
      )}
      <ErrorText>{err}</ErrorText>
      <Button variant="primary" size="lg" type="submit" disabled={!ready}>
        로그인
      </Button>
      <div className="flex justify-between">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← 처음으로
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setErr("");
          }}
        >
          {recovery ? "인증 앱 숫자 입력" : "복구 코드 사용"}
        </Button>
      </div>
    </form>
  );
}

function NewPasswordStep({ onDone, onBack }: { onDone: (s: Session) => void; onBack: () => void }) {
  const { fields, submit, ready } = usePasswordForm(false, onDone);
  return (
    <form onSubmit={submit} className="contents">
      <Title title="새 비밀번호 정하기" sub="임시 비밀번호로 로그인했어요. 계속하려면 새 비밀번호를 정해 주세요." />
      {fields}
      <Button variant="primary" size="lg" type="submit" disabled={!ready}>
        저장하고 계속
      </Button>
      <Button size="sm" variant="ghost" className="self-start" onClick={onBack}>
        ← 처음으로
      </Button>
    </form>
  );
}

function TfaSetupStep({ onDone, onBack }: { onDone: (s: Session) => void; onBack: () => void }) {
  const { toast } = useApp();
  const [result, setResult] = useState<{ codes: string[]; session: Session } | null>(null);
  const { fields, submit, ready } = useTfaSetup((codes, session) => setResult({ codes, session }));
  if (result)
    return (
      <>
        <Title title="복구 코드" sub="휴대폰을 잃어버렸을 때 한 번씩 쓸 수 있어요. 이 화면을 지나면 다시 볼 수 없어요." />
        <RecoveryCodes codes={result.codes} />
        <Banner tone="warn" icon="alert">
          비밀번호 관리자 같은 안전한 곳에 저장하세요.
        </Banner>
        <div className="flex gap-2">
          <Button icon="copy" onClick={() => copyText(result.codes.join("\n"), toast)}>
            복사
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => onDone(result.session)}>
            저장했어요, 계속
          </Button>
        </div>
      </>
    );
  return (
    <form onSubmit={submit} className="contents">
      <Title title="2단계 인증 설정" sub="이 워크스페이스는 모든 멤버에게 2단계 인증을 요구해요. 설정을 마치면 바로 들어가요." />
      {fields}
      <Button variant="primary" size="lg" type="submit" disabled={!ready}>
        확인
      </Button>
      <Button size="sm" variant="ghost" className="self-start" onClick={onBack}>
        ← 처음으로
      </Button>
    </form>
  );
}
