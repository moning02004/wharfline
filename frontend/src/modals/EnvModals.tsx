import { useState } from "react";
import { api } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvHistory, EnvSet, EnvValues } from "../lib/types";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Chip, Hint } from "../components/ui";
import { EnvWorkspaceModal, openEnvWorkspace } from "./EnvWorkspace";

/* ---------- new .env ---------- */

/** A new set in the .env editor, with its name above the text. Open it with the "full" size. */
export function NewEnvModal({ onClose }: { onClose: () => void }) {
  const { runAction } = useApp();
  const [name, setName] = useState("batch-jobs.production");
  return (
    <EnvWorkspaceModal
      initial={"# 주석과 빈 줄도 그대로 저장돼요\nNODE_ENV=production\nDATABASE_URL=postgres://user:pass@10.0.3.31:5432/app\nJWT_SECRET=change-me\n"}
      saved={null}
      name={{ value: name, onChange: setName }}
      note="값은 암호화되어 저장되고, 열람할 때마다 기록돼요."
      onClose={onClose}
      onSave={async (text) => {
        await api.post("/envs", { name: name.trim(), text });
        onClose();
        runAction(async () => {}, "저장했어요");
      }}
    />
  );
}

/* ---------- version history & restore ---------- */

export function EnvHistoryModal({ env, onClose }: { env: EnvSet; onClose: () => void }) {
  const { withSudo, toast, refresh } = useApp();
  const { data } = useApi<EnvHistory>(`/envs/${env.id}/history`);
  const [openDiff, setOpenDiff] = useState<Record<number, boolean>>({});
  const [armed, setArmed] = useState<number | null>(null);

  const restore = (ver: number) => {
    if (armed !== ver) {
      setArmed(ver);
      setTimeout(() => setArmed((a) => (a === ver ? null : a)), 4000);
      return;
    }
    withSudo("환경 변수 되돌리기", async () => {
      const r = await api.post<EnvSet>(`/envs/${env.id}/restore`, { ver });
      onClose();
      refresh();
      toast(`v${ver} 내용으로 되돌렸어요. 지금은 v${r.ver}이에요.`);
    });
  };

  return (
    <>
      <ModalHead title="버전 기록" sub={env.name} onClose={onClose} />
      <ModalBody>
        <div className="rounded-lg border border-line overflow-hidden">
          {data?.items.map((it) => {
            const d = it.diff;
            const changes = d ? d.add.length + d.chg.length + d.del.length : 0;
            return (
              <div key={it.ver} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <span className="font-mono font-semibold text-[12.5px] min-w-[34px]">v{it.ver}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{it.current ? "지금 버전" : it.updated.split(" · ")[0]}</div>
                    <div className="text-[12.5px] text-muted truncate">
                      {it.updated} · 변수 {it.count}개
                    </div>
                  </div>
                  <span className="text-muted text-[12.5px]">{d ? `추가 ${d.add.length} · 수정 ${d.chg.length} · 삭제 ${d.del.length}` : "처음 버전"}</span>
                  {changes > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setOpenDiff({ ...openDiff, [it.ver]: !openDiff[it.ver] })}>
                      {openDiff[it.ver] ? "접기" : "변경 보기"}
                    </Button>
                  )}
                  {it.current ? (
                    <Chip tone="ok">사용 중</Chip>
                  ) : (
                    <Button size="sm" variant={armed === it.ver ? "danger" : "default"} icon={armed === it.ver ? undefined : "undo"} onClick={() => restore(it.ver)}>
                      {armed === it.ver ? "한 번 더 눌러 확인" : "되돌리기"}
                    </Button>
                  )}
                </div>
                {d && openDiff[it.ver] && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3.5 pl-[62px] animate-fade">
                    {d.add.map((k) => (
                      <Chip key={k} tone="ok" mono>
                        + {k}
                      </Chip>
                    ))}
                    {d.chg.map((k) => (
                      <Chip key={k} tone="warn" mono>
                        ~ {k}
                      </Chip>
                    ))}
                    {d.del.map((k) => (
                      <Chip key={k} tone="bad" mono>
                        − {k}
                      </Chip>
                    ))}
                    <span className="text-faint text-xs w-full">
                      v{it.prevVer} → v{it.ver}에서 바뀐 변수예요. 값은 보여주지 않아요.
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Hint>
          되돌리면 그 버전의 내용으로 새 버전(v{env.ver + 1})이 만들어져요. 지금 버전도 기록에 그대로 남아서 다시 되돌릴 수 있어요.
        </Hint>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- open a set by name (from deploy screens) ---------- */

/**
 * An env set's name that opens it: after the password re-check, its values show in the editor to read or change.
 * Members who can't see values (not Owner/Admin) just get a short note.
 */
export function EnvLink({ name }: { name: string }) {
  const { withSudo, openModal, toast, can, refresh } = useApp();
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!can("env")) return toast("환경 변수 값은 Owner와 Admin만 볼 수 있어요");
    withSudo("환경 변수 보기·수정", async () => {
      const sets = await api.get<EnvSet[]>("/envs");
      const env = sets.find((x) => x.name === name);
      if (!env) return toast(`${name} 세트를 찾지 못했어요`, "error");
      const r = await api.get<EnvValues>(`/envs/${env.id}/values?purpose=edit`);
      openEnvWorkspace(env, r, { openModal, withSudo, toast, refresh });
    }, { always: true });
  };
  return (
    <button type="button" onClick={open} className="link font-mono text-[12.5px]" title="비밀번호를 확인하고 값을 보거나 고쳐요">
      {name}
    </button>
  );
}
