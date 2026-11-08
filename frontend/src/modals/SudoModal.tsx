import { useState } from "react";
import { api, errMsg } from "../lib/api";
import type { Session } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, ErrorText, Field, Input } from "../components/ui";

export function SudoModal({ reason, minutes, always, onClose, onDone }: { reason: string; minutes: number; always?: boolean; onClose: () => void; onDone: (s: Session) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    try {
      onDone(await api.post<Session>("/auth/sudo", { password: pw }));
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <ModalHead title="비밀번호 다시 확인" sub="민감 정보를 다루려면 본인 확인이 필요해요." onClose={onClose} />
      <form id="sudoForm" onSubmit={submit} className="contents">
        <ModalBody>
          <Banner icon="lock" title={reason}>
            {always ? (
              "볼 때마다 비밀번호를 물어요. 열람과 수정은 모두 활동 기록에 남아요."
            ) : (
              <>
                확인 후 <span className="tabular-nums">{minutes}</span>분 동안은 다시 묻지 않아요. 이 시간 동안의 열람과 수정은 모두 활동 기록에 남아요.
              </>
            )}
          </Banner>
          <Field label="계정 비밀번호" htmlFor="sudoPw" hint="여러 번 틀리면 계정이 잠시 잠기고 활동 기록에 남아요.">
            <Input id="sudoPw" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <ErrorText>{err}</ErrorText>
        </ModalBody>
      </form>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit" form="sudoForm" disabled={busy || !pw}>
          확인
        </Button>
      </ModalFoot>
    </>
  );
}
