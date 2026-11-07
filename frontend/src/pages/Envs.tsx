import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet } from "../lib/types";
import { EditEnvModal, EnvHistoryModal, NewEnvModal } from "../modals/EnvModals";
import { copyText } from "../modals/ResourceModals";
import { Button, Card, CardHeader, Chip, Loading, PageHeader, cx } from "../components/ui";

export default function Envs() {
  const { data } = useApi<EnvSet[]>("/envs");
  const { openModal, withSudo, sudoActive, session, toast, can } = useApp();
  const manage = can("env");
  // Revealed values live only in memory and are dropped when sudo ends.
  const [revealed, setRevealed] = useState<Record<string, [string, string][]>>({});

  useEffect(() => {
    if (!sudoActive) setRevealed({});
  }, [sudoActive]);

  if (!data) return <Loading />;

  const reveal = (e: EnvSet) => {
    if (revealed[e.id]) {
      const { [e.id]: _, ...rest } = revealed;
      return setRevealed(rest);
    }
    withSudo("환경 변수 값 보기", async () => {
      const r = await api.get<{ vars: [string, string][] }>(`/envs/${e.id}/values`);
      setRevealed((x) => ({ ...x, [e.id]: r.vars }));
    });
  };

  const edit = (e: EnvSet) =>
    withSudo("환경 변수 수정", async () => {
      const r = await api.get<{ vars: [string, string][] }>(`/envs/${e.id}/values?purpose=edit`);
      openModal((c) => <EditEnvModal env={e} values={r.vars} onClose={c} />, "md");
    });

  const copy = async (e: EnvSet) => {
    const vars = revealed[e.id];
    if (!vars) return;
    copyText(vars.map(([k, v]) => `${k}=${v}`).join("\n"), toast);
    api.post(`/envs/${e.id}/copied`).catch(() => {});
  };

  return (
    <>
      <PageHeader
        title="환경 변수"
        desc={
          manage
            ? `.env를 붙여넣거나 파일로 올려 저장해요. 비밀번호를 다시 확인하면 ${session?.sudoMinutes ?? 5}분 동안 값을 보고 수정할 수 있어요. 저장할 때마다 버전이 올라가요.`
            : "저장된 .env의 변수 이름이에요. 값을 보고 바꾸는 건 Owner와 Admin만 할 수 있어요."
        }
      >
        {manage && (
          <Button variant="primary" icon="upload" onClick={() => openModal((c) => <NewEnvModal onClose={c} />, "md")}>
            .env 추가
          </Button>
        )}
      </PageHeader>
      {data.map((e) => {
        const vals = revealed[e.id];
        const shown = !!vals;
        return (
          <Card key={e.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[13.5px]">{e.name}</span>
                  <Chip>v{e.ver}</Chip>
                  <span className="text-muted text-xs font-normal">{e.updated}</span>
                </span>
              }
            >
              <Button size="sm" variant="ghost" icon="history" onClick={() => openModal((c) => <EnvHistoryModal env={e} onClose={c} />, "md")}>
                기록
              </Button>
              {manage && (
                <>
                  <Button size="sm" icon="edit" onClick={() => edit(e)}>
                    편집
                  </Button>
                  <Button size="sm" icon={shown ? "lock" : "eye"} onClick={() => reveal(e)}>
                    {shown ? "가리기" : "값 보기"}
                  </Button>
                  <Button size="sm" icon="copy" disabled={!shown} onClick={() => copy(e)}>
                    .env 복사
                  </Button>
                </>
              )}
            </CardHeader>
            <div>
              {e.vars.map((v, i) => {
                const value = vals?.find(([k]) => k === v.key)?.[1];
                return (
                  <div
                    key={v.key}
                    className="grid grid-cols-1 sm:grid-cols-[minmax(120px,240px)_minmax(0,1fr)] gap-x-4 gap-y-1 items-center px-4 py-2 border-b border-line last:border-b-0 font-mono text-[12.5px] hover:bg-surface-2 transition-colors"
                  >
                    <span>{v.key}</span>
                    <span
                      className={cx(
                        "truncate transition-all duration-300",
                        shown ? "text-fg" : "text-faint tracking-[.05em]",
                      )}
                      style={shown ? { animation: `fade .3s ${i * 30}ms both` } : undefined}
                    >
                      {shown ? value : "••••••••••••••••"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </>
  );
}
