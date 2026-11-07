import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApp } from "../lib/app";
import type { Member, Session } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, Check, ErrorText, Field, Input } from "../components/ui";
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

/** Step 1 of 2FA setup: the new secret as a key to type in, and as an otpauth:// link for phones. */
function TfaSecret({ secret, uri }: { secret: string; uri: string }) {
  const { toast } = useApp();
  return (
    <div className="flex flex-col gap-2">
      <b className="font-semibold">1. 인증 앱에 계정을 추가하세요</b>
      <span className="text-muted text-[13px]">
        Google Authenticator, 1Password 같은 앱에서 "설정 키 입력"을 고르고 이 키를 넣어요. 휴대폰에서 보고 있다면 링크를 눌러도 돼요.
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono bg-surface-2 px-3 py-1.5 rounded-md break-all">{secret}</span>
        <Button size="sm" icon="copy" onClick={() => copyText(secret.replace(/ /g, ""), toast)}>
          키 복사
        </Button>
        <a href={uri} className="text-[12.5px] text-accent hover:underline">
          인증 앱으로 열기
        </a>
      </div>
      <span className="text-[12px] text-faint">시간 기반(TOTP) · 30초 · 6자리</span>
    </div>
  );
}

/** 2FA setup (new secret → a code from it → recovery codes). Used in the modal and right after login. */
export function useTfaSetup(onDone: (codes: string[], s: Session) => void) {
  const [begun, setBegun] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.post<{ secret: string; uri: string }>("/auth/tfa/begin").then(setBegun, (e) => setErr(errMsg(e)));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ codes: string[]; session: Session }>("/auth/tfa/verify", { code });
      onDone(r.codes, r.session);
    } catch (e) {
      setErr(errMsg(e));
      setCode("");
      setBusy(false);
    }
  };
  const fields = (
    <>
      {begun ? <TfaSecret {...begun} /> : !err && <span className="text-muted">키를 만드는 중이에요…</span>}
      <Field label="2. 앱에 표시된 6자리 숫자">
        <OtpInput value={code} onChange={setCode} autoFocus />
      </Field>
      <ErrorText>{err}</ErrorText>
    </>
  );
  return { fields, submit, ready: !!begun && code.length === 6 && !busy };
}

export function TfaSetupModal({ again, onClose }: { again?: boolean; onClose: () => void }) {
  const { openModal, setSession } = useApp();
  const { fields, submit, ready } = useTfaSetup((codes, s) => {
    setSession(s);
    onClose();
    openModal((close) => <CodesModal codes={codes} onClose={close} />);
  });
  return (
    <>
      <ModalHead
        title="인증 앱 연결"
        sub={again ? "새 앱을 확인하면 기존 인증 앱과 복구 코드는 더 이상 쓸 수 없어요." : "다음 로그인부터 비밀번호 다음에 인증 앱의 숫자를 물어요."}
        onClose={onClose}
      />
      <form id="tfaForm" onSubmit={submit} className="contents">
        <ModalBody>{fields}</ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="tfaForm" disabled={!ready}>
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
        <RecoveryCodes codes={codes} />
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

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 font-mono text-[13px] bg-surface-2 px-5 py-4 rounded-lg">
      {codes.map((c) => (
        <span key={c}>{c}</span>
      ))}
    </div>
  );
}

/** New-password form. The current password is asked unless this is the forced change after a reset. */
export function usePasswordForm(askCurrent: boolean, onDone: (s: Session) => void) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) return setErr("새 비밀번호 두 칸이 서로 달라요.");
    setBusy(true);
    try {
      onDone(await api.post<Session>("/auth/password", { current, new: next }));
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };
  const fields = (
    <>
      {askCurrent && (
        <Field label="지금 비밀번호" htmlFor="pwCur">
          <Input id="pwCur" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
      )}
      <Field label="새 비밀번호" htmlFor="pwNew" hint="10자 이상. 다른 곳에서 쓰지 않는 비밀번호로 정해 주세요.">
        <Input id="pwNew" type="password" autoComplete="new-password" autoFocus={!askCurrent} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="새 비밀번호 확인" htmlFor="pwAgain">
        <Input id="pwAgain" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <ErrorText>{err}</ErrorText>
    </>
  );
  return { fields, submit, ready: !!next && !!again && (!askCurrent || !!current) && !busy };
}

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const { setSession, toast } = useApp();
  const { fields, submit, ready } = usePasswordForm(true, (s) => {
    setSession(s);
    onClose();
    toast("비밀번호를 바꿨어요. 다른 기기는 모두 로그아웃됐어요.");
  });
  return (
    <>
      <ModalHead title="비밀번호 바꾸기" sub="바꾸면 이 기기를 뺀 다른 기기는 모두 로그아웃돼요." onClose={onClose} />
      <form id="pwForm" onSubmit={submit} className="contents">
        <ModalBody>{fields}</ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="pwForm" disabled={!ready}>
          바꾸기
        </Button>
      </ModalFoot>
    </>
  );
}

export function DisableTfaModal({ onClose }: { onClose: () => void }) {
  const { setSession, toast } = useApp();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSession(await api.post<Session>("/auth/tfa/disable", { password: pw }));
      onClose();
      toast("2단계 인증을 껐어요");
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <>
      <ModalHead title="2단계 인증 끄기" sub="끄면 비밀번호만으로 로그인돼요. 복구 코드도 모두 무효가 돼요." onClose={onClose} />
      <form id="tfaOffForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Field label="계정 비밀번호" htmlFor="tfaOffPw">
            <Input id="tfaOffPw" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="danger" type="submit" form="tfaOffForm" disabled={!pw}>
          끄기
        </Button>
      </ModalFoot>
    </>
  );
}

/** Owner: give a member a temporary password, shown once. They must change it at the next login. */
export function ResetPasswordModal({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: () => void }) {
  const { toast, withSudo } = useApp();
  const [clearTfa, setClearTfa] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const reset = () =>
    withSudo("비밀번호 재설정", async () => {
      const r = await api.post<{ password: string }>(`/members/${encodeURIComponent(member.email)}/password`, { clearTfa });
      setTemp(r.password);
      onDone();
    });
  if (temp)
    return (
      <>
        <ModalHead title="임시 비밀번호" sub="이 화면을 닫으면 다시 볼 수 없어요." onClose={onClose} />
        <ModalBody>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[15px] bg-surface-2 px-3 py-2 rounded-md select-all">{temp}</span>
            <Button size="sm" icon="copy" onClick={() => copyText(temp, toast)}>
              복사
            </Button>
          </div>
          <Banner icon="info">{member.name}님에게 안전한 방법으로 전해 주세요. 이 비밀번호로 로그인하면 바로 새 비밀번호를 정해야 해요.</Banner>
        </ModalBody>
        <ModalFoot>
          <Button variant="primary" onClick={onClose}>
            전달했어요
          </Button>
        </ModalFoot>
      </>
    );
  return (
    <>
      <ModalHead title={`${member.name}님 비밀번호 재설정`} sub={member.email} onClose={onClose} />
      <ModalBody>
        <Banner tone="warn" icon="alert">
          지금 비밀번호는 바로 못 쓰게 되고, {member.name}님의 모든 기기가 로그아웃돼요. 로그인 잠금도 풀려요.
        </Banner>
        {member.tfa && <Check checked={clearTfa} onChange={setClearTfa} title="2단계 인증도 해제" desc="휴대폰과 복구 코드를 모두 잃어버렸을 때만 켜세요." />}
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="danger" onClick={reset}>
          임시 비밀번호 만들기
        </Button>
      </ModalFoot>
    </>
  );
}
