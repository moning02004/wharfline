import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { EnvSet } from "../lib/types";
import { EditEnvModal, EnvHistoryModal, NewEnvModal } from "../modals/EnvModals";
import { copyText } from "../modals/ResourceModals";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Button, Byline, Card, Chip, Input, Loading, PageHeader, TableWrap, cx } from "../components/ui";

export default function Envs() {
  const { data } = useApi<EnvSet[]>("/envs");
  const { openModal, can } = useApp();
  const manage = can("env");
  const [q, setQ] = useState("");
  if (!data) return <Loading />;

  const needle = q.trim().toLowerCase();
  const sets = data.filter(
    (e) => !needle || e.name.toLowerCase().includes(needle) || e.vars.some((v) => v.key.toLowerCase().includes(needle)) || e.usedBy.some((j) => j.toLowerCase().includes(needle)),
  );
  const open = (e: EnvSet) => openModal((c) => <EnvSetModal env={e} onClose={c} />, "md");

  return (
    <>
      <PageHeader title="환경 변수" desc="배포할 때 서버에 넣는 .env 묶음이에요.">
        {manage && (
          <Button variant="primary" icon="upload" onClick={() => openModal((c) => <NewEnvModal onClose={c} />, "md")}>
            .env 추가
          </Button>
        )}
      </PageHeader>
      <div className="relative max-w-[420px]">
        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-faint pointer-events-none" />
        <Input aria-label="환경 변수 검색" placeholder="세트, 변수 이름, 쓰는 작업으로 찾기" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>변수</th>
                <th>버전</th>
                <th>쓰는 작업</th>
                <th>수정</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sets.length === 0 && (
                <tr>
                  <td colSpan={6} className="!text-center text-muted py-8">
                    {needle ? "찾는 세트가 없어요." : "아직 없어요."}
                  </td>
                </tr>
              )}
              {sets.map((e) => (
                <tr key={e.id} className="click" onClick={() => open(e)}>
                  <td>
                    <span className="font-mono font-medium">{e.name}</span>
                    <Byline label="수정" name={e.updated.includes(" · ") ? e.updated.split(" · ").slice(1).join(" · ") : null} />
                  </td>
                  <td className="tabular-nums">{e.vars.length}개</td>
                  <td>
                    <Chip>v{e.ver}</Chip>
                  </td>
                  <td className="text-muted">{e.usedBy.length ? (e.usedBy.length === 1 ? e.usedBy[0] : `${e.usedBy[0]} 외 ${e.usedBy.length - 1}개`) : <span className="text-faint">없음</span>}</td>
                  <td className="text-muted">{e.updated.split(" · ")[0]}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost">
                      자세히
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

/**
 * One set in a dialog: its variable names, values after the password re-check, the jobs using it,
 * and edit / history / copy. Revealed values live only here and go away when sudo ends.
 */
function EnvSetModal({ env, onClose }: { env: EnvSet; onClose: () => void }) {
  const { withSudo, openModal, toast, can, sudoActive } = useApp();
  const manage = can("env");
  const [vals, setVals] = useState<[string, string][] | null>(null);
  useEffect(() => {
    if (!sudoActive) setVals(null);
  }, [sudoActive]);

  const reveal = () =>
    vals
      ? setVals(null)
      : withSudo("환경 변수 값 보기", async () => {
          const r = await api.get<{ vars: [string, string][] }>(`/envs/${env.id}/values`);
          setVals(r.vars);
        });
  const edit = () =>
    withSudo("환경 변수 수정", async () => {
      const r = await api.get<{ vars: [string, string][] }>(`/envs/${env.id}/values?purpose=edit`);
      onClose();
      openModal((c) => <EditEnvModal env={env} values={r.vars} onClose={c} />, "md");
    });
  const copy = () => {
    if (!vals) return;
    copyText(vals.map(([k, v]) => `${k}=${v}`).join("\n"), toast);
    api.post(`/envs/${env.id}/copied`).catch(() => {});
  };

  return (
    <>
      <ModalHead title={env.name} sub={`v${env.ver} · 변수 ${env.vars.length}개 · ${env.updated}`} onClose={onClose} />
      <ModalBody>
        <div className="rounded-xl border border-line overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2 bg-surface-2 border-b border-line">
            <span className="text-[12px] text-muted">변수</span>
            {manage && (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" icon={vals ? "lock" : "eye"} onClick={reveal}>
                  {vals ? "가리기" : "값 보기"}
                </Button>
                {vals && (
                  <Button size="sm" variant="ghost" icon="copy" onClick={copy}>
                    .env 복사
                  </Button>
                )}
              </span>
            )}
          </div>
          <div className="max-h-[340px] overflow-y-auto scroll-soft">
            {env.vars.map((v) => {
              const value = vals?.find(([k]) => k === v.key)?.[1];
              return (
                <div key={v.key} className="grid grid-cols-[minmax(120px,40%)_minmax(0,1fr)] gap-3 px-3.5 py-2 border-b border-line last:border-b-0 font-mono text-[12.5px]">
                  <span className="truncate">{v.key}</span>
                  <span className={cx("truncate", vals ? "text-fg" : "text-faint tracking-[.05em]")}>{vals ? value : "••••••••••••"}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">쓰는 작업</span>
          {env.usedBy.length ? (
            <span className="flex flex-wrap gap-1.5">
              {env.usedBy.map((j) => (
                <Chip key={j}>{j}</Chip>
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-faint">없음</span>
          )}
        </div>
      </ModalBody>
      <ModalFoot between>
        <Button
          variant="ghost"
          icon="history"
          onClick={() => {
            onClose();
            openModal((c) => <EnvHistoryModal env={env} onClose={c} />, "md");
          }}
        >
          기록
        </Button>
        <div className="flex gap-2">
          {manage && (
            <Button icon="edit" onClick={edit}>
              편집
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </ModalFoot>
    </>
  );
}
