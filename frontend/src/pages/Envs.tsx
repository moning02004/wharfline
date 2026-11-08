import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet } from "../lib/types";
import { EditEnvModal, EnvHistoryModal, NewEnvModal } from "../modals/EnvModals";
import { copyText } from "../modals/ResourceModals";
import { Icon } from "../components/Icon";
import { Button, Card, CardHeader, Chip, Input, Loading, PageHeader, cx } from "../components/ui";

export default function Envs() {
  const { data } = useApi<EnvSet[]>("/envs");
  const { openModal, withSudo, sudoActive, session, toast, can } = useApp();
  const manage = can("env");
  // Revealed values live only in memory and are dropped when sudo ends.
  const [revealed, setRevealed] = useState<Record<string, [string, string][]>>({});
  const [q, setQ] = useState("");
  // Which sets are open. Remembered in this browser only; a few sets start open.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("wharfline-env-open") ?? "{}");
    } catch {
      return {};
    }
  });
  const setOpenSaved = (next: Record<string, boolean>) => {
    setOpen(next);
    try {
      localStorage.setItem("wharfline-env-open", JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (!sudoActive) setRevealed({});
  }, [sudoActive]);

  if (!data) return <Loading />;

  const needle = q.trim().toLowerCase();
  const matchKey = (key: string) => !!needle && key.toLowerCase().includes(needle);
  const sets = data.filter(
    (e) => !needle || e.name.toLowerCase().includes(needle) || e.vars.some((v) => matchKey(v.key)) || e.usedBy.some((j) => j.toLowerCase().includes(needle)),
  );
  // Searching opens what matches; otherwise the saved state, and everything when there are only a few sets.
  const isOpen = (e: EnvSet) => (needle ? true : open[e.id] ?? data.length <= 3);
  const toggle = (e: EnvSet) => setOpenSaved({ ...open, [e.id]: !isOpen(e) });
  const allOpen = sets.every(isOpen);

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
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-[420px]">
          <Icon name="list" className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-faint pointer-events-none" />
          <Input aria-label="환경 변수 검색" placeholder="세트, 변수 이름, 쓰는 작업으로 찾기" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="text-[12.5px] text-muted">
          {needle ? `${sets.length}개 찾음` : `세트 ${data.length}개`}
        </span>
        {!needle && data.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpenSaved(Object.fromEntries(data.map((e) => [e.id, !allOpen])))}>
            {allOpen ? "모두 접기" : "모두 펼치기"}
          </Button>
        )}
      </div>
      {sets.length === 0 && <p className="m-0 py-8 text-center text-muted">찾는 세트가 없어요.</p>}
      {sets.map((e) => {
        const vals = revealed[e.id];
        const shown = !!vals;
        const expanded = isOpen(e);
        return (
          <Card key={e.id}>
            <CardHeader
              className={cx("cursor-pointer select-none", !expanded && "border-b-0")}
              title={
                <span className="flex items-center gap-2 flex-wrap" onClick={() => toggle(e)}>
                  <Icon name="chev" className={cx("size-3.5 text-faint transition-transform", expanded ? "" : "-rotate-90")} />
                  <span className="font-mono text-[13.5px]">{e.name}</span>
                  <Chip>v{e.ver}</Chip>
                  <span className="text-muted text-xs font-normal">
                    변수 {e.vars.length}개 · {e.updated}
                  </span>
                  {e.usedBy.length > 0 && (
                    <span className="flex gap-1 flex-wrap">
                      {e.usedBy.map((j) => (
                        <Chip key={j} tone={needle && j.toLowerCase().includes(needle) ? "accent" : "neutral"}>
                          {j}
                        </Chip>
                      ))}
                    </span>
                  )}
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
            {expanded && (
            <div>
              {e.vars.map((v, i) => {
                const value = vals?.find(([k]) => k === v.key)?.[1];
                return (
                  <div
                    key={v.key}
                    className="grid grid-cols-1 sm:grid-cols-[minmax(120px,240px)_minmax(0,1fr)] gap-x-4 gap-y-1 items-center px-4 py-2 border-b border-line last:border-b-0 font-mono text-[12.5px] hover:bg-surface-2 transition-colors"
                  >
                    <span className={cx(matchKey(v.key) && "bg-warn-soft text-fg rounded px-1 -mx-1 w-fit")}>{v.key}</span>
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
            )}
          </Card>
        );
      })}
    </>
  );
}
