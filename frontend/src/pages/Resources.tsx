import { useState } from "react";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Image, Inventory as Inv, Key, Registry, Repo } from "../lib/types";
import { HostKeyModal, NewHostModal, NewKeyModal, NewRegistryModal, NewRepoModal, PubKeyModal } from "../modals/ResourceModals";
import { Icon } from "../components/Icon";
import { Banner, Button, Card, CardHeader, Chip, Dot, Loading, PageHeader, TableWrap } from "../components/ui";

const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono">{children}</span>;

/* ---------- registries ---------- */

export function Registries() {
  const { data } = useApi<{ registries: Registry[]; images: Image[] }>("/registries");
  const { openModal } = useApp();
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="이미지 레지스트리" desc="배포할 도커 이미지를 가져오는 곳이에요. GitHub Container Registry와 Gitea 패키지 레지스트리를 지원해요.">
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewRegistryModal onClose={c} />)}>
          레지스트리 추가
        </Button>
      </PageHeader>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>레지스트리</th>
                <th>주소</th>
                <th>계정</th>
                <th>인증</th>
                <th>이미지</th>
              </tr>
            </thead>
            <tbody>
              {data.registries.map((g) => (
                <tr key={g.id}>
                  <td className="font-medium">{g.name}</td>
                  <td className="font-mono">
                    {g.host}/{g.namespace}
                  </td>
                  <td className="font-mono text-muted">{g.user}</td>
                  <td className="text-muted">{g.auth}</td>
                  <td className="tabular-nums">{g.imageCount}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <Card>
        <CardHeader title="이미지">
          <span className="text-faint text-[12.5px]">태그는 5분마다 새로 확인해요</span>
        </CardHeader>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>이미지</th>
                <th>최신 태그</th>
                <th>digest</th>
                <th>올라온 시간</th>
                <th>쓰는 작업</th>
              </tr>
            </thead>
            <tbody>
              {data.images.map((i) => {
                const t = i.tags[0];
                return (
                  <tr key={i.ref}>
                    <td className="font-mono">{i.ref}</td>
                    <td className="font-mono">{t?.name ?? "-"}</td>
                    <td className="font-mono text-faint">sha256:{t?.digest ?? "-"}…</td>
                    <td className="text-muted">{t?.pushed ?? "-"}</td>
                    <td>
                      <span className="flex gap-1.5">
                        {i.usedBy.length ? i.usedBy.map((n) => <Chip key={n}>{n}</Chip>) : <span className="text-faint">없음</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

/* ---------- repos ---------- */

export function Repos() {
  const { data } = useApi<Repo[]>("/repos");
  const { openModal } = useApp();
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="플레이북 레포"
        desc="Ansible 플레이북 방식으로 배포할 때 쓰는 레포예요. Semaphore처럼 Git 저장소나 배포 서버의 폴더를 연결할 수 있어요. 앱 소스는 연결하지 않고, 앱은 이미지 레지스트리의 도커 이미지로 배포해요. Docker Compose 방식은 레포 없이도 쓸 수 있어요."
      >
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewRepoModal onClose={c} />)}>
          레포 연결
        </Button>
      </PageHeader>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>레포</th>
                <th>주소</th>
                <th>브랜치</th>
                <th>플레이북</th>
                <th>인증</th>
                <th>최근 커밋</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.name}>
                  <td className="font-mono">{r.name}</td>
                  <td className="font-mono text-muted">
                    {r.kind === "local" && <Chip className="mr-1.5">서버 경로</Chip>}
                    {r.url}
                  </td>
                  <td className="font-mono">{r.branch}</td>
                  <td>
                    <span className="flex gap-1">
                      {r.books.map((b) => (
                        <Chip key={b}>{b}</Chip>
                      ))}
                    </span>
                  </td>
                  <td className="text-muted">{r.auth}</td>
                  <td className="font-mono">{r.commit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <Banner icon="shield" title="플레이북에 넘기는 변수는 정해져 있어요">
        <Mono>image</Mono>, <Mono>image_tag</Mono>, <Mono>image_digest</Mono>, <Mono>env_file</Mono>, <Mono>target_group</Mono>만 넘겨요. 화면에서 extra-vars나 임의 명령은 넣을 수 없어요.
      </Banner>
    </>
  );
}

/* ---------- inventory ---------- */

export function Inventory() {
  const { data } = useApi<Inv[]>("/inventory");
  const { openModal, toast } = useApp();
  const [pinging, setPinging] = useState<string | null>(null);
  if (!data) return <Loading />;

  const ping = async (inv: Inv) => {
    setPinging(inv.id);
    try {
      const r = await api.post<{ total: number; ok: number }>(`/inventory/${inv.id}/ping`);
      toast(`${inv.name}: ${r.total}대 중 ${r.ok}대 응답`);
    } catch (e) {
      toast(errMsg(e));
    }
    setPinging(null);
  };

  return (
    <>
      <PageHeader
        title="인벤토리"
        desc="배포 대상 서버 묶음이에요. 서버마다 그룹을 정해 두면 배포 작업에서 그룹만 골라 보낼 수 있어요. 처음 연결할 때 호스트 키 지문을 저장하고, 이후 바뀌면 배포를 막아요."
      >
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewHostModal inventories={data} onClose={c} />)}>
          서버 추가
        </Button>
      </PageHeader>
      {data.map((inv) => {
        const gm: Record<string, number> = {};
        inv.hosts.forEach((h) => (gm[h.group] = (gm[h.group] ?? 0) + 1));
        return (
          <Card key={inv.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2 flex-wrap">
                  {inv.name}
                  <span className="inline-flex items-center gap-1 text-xs text-muted font-mono font-normal">
                    <Icon name="key" className="size-[13px]" />
                    {inv.key}
                  </span>
                  {Object.entries(gm).map(([g, n]) => (
                    <Chip key={g}>
                      {g} · {n}
                    </Chip>
                  ))}
                </span>
              }
            >
              <Button size="sm" icon="refresh" disabled={pinging === inv.id} onClick={() => ping(inv)}>
                {pinging === inv.id ? "확인 중…" : "연결 테스트"}
              </Button>
            </CardHeader>
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>그룹</th>
                    <th>이름</th>
                    <th>주소</th>
                    <th>SSH 사용자</th>
                    <th>호스트 키</th>
                    <th>상태</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inv.hosts.map((h, ix) => (
                    <tr key={h.name + ix}>
                      <td>
                        <Chip tone="accent" mono>
                          {h.group}
                        </Chip>
                      </td>
                      <td className="font-medium">{h.name}</td>
                      <td className="font-mono">
                        {h.ip}:{h.port}
                      </td>
                      <td className="font-mono">{h.user}</td>
                      <td>{h.hostKey === "ok" ? <Dot tone="ok">지문 일치</Dot> : <Dot tone="bad">지문 변경됨</Dot>}</td>
                      <td>{h.status === "on" ? <Dot tone="ok">응답</Dot> : <Dot>응답 없음</Dot>}</td>
                      <td className="text-right">
                        {h.hostKey === "changed" && (
                          <Button size="sm" variant="danger" onClick={() => openModal((c) => <HostKeyModal invId={inv.id} ix={ix} host={h} onClose={c} />)}>
                            지문 확인
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        );
      })}
    </>
  );
}

/* ---------- keys ---------- */

export function Keys() {
  const { data } = useApi<Key[]>("/keys");
  const { openModal, toast, withSudo, refresh } = useApp();
  if (!data) return <Loading />;

  const del = (k: Key) => {
    if (k.usedCount) return toast(`${k.kind === "token" ? "레포" : "인벤토리"} ${k.usedCount}곳에서 쓰고 있어 지울 수 없어요`);
    withSudo("SSH 키 삭제", async () => {
      await api.del(`/keys/${k.id}`);
      refresh();
      toast(`${k.name}을(를) 지웠어요`);
    });
  };

  return (
    <>
      <PageHeader title="키 저장소" desc="서버 접속용 SSH 키와 Git 저장소(HTTPS)용 액세스 토큰을 저장해요. 모두 암호화해 저장하고, 저장한 뒤에는 화면에 다시 보여주지 않아요.">
        <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} />)}>
          키 추가
        </Button>
      </PageHeader>
      <Banner icon="info" title="비공개 키와 토큰은 내려받거나 열람할 수 없어요">
        SSH 키는 공개 키와 지문만, 토큰은 계정과 끝 4자리만 볼 수 있어요. 키를 잃어버렸다면 새로 만들고 서버의 authorized_keys를 바꾸는 쪽이 안전해요.
      </Banner>
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>종류</th>
                <th>지문 / 계정</th>
                <th>사용 중</th>
                <th>마지막 사용</th>
                <th>만든 사람</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.id}>
                  <td className="font-medium">{k.name}</td>
                  <td>
                    <Chip>{k.type}</Chip>
                  </td>
                  <td className="font-mono text-muted">{k.fingerprint}</td>
                  <td className="tabular-nums">{k.usedCount ? `${k.kind === "token" ? "레포" : "인벤토리"} ${k.usedCount}곳` : <span className="text-faint">없음</span>}</td>
                  <td className="text-muted">{k.lastUsed}</td>
                  <td className="text-muted">
                    {k.createdBy} · {k.createdAt}
                  </td>
                  <td className="text-right">
                    <span className="inline-flex gap-1">
                      {k.kind === "ssh" && (
                        <Button size="sm" variant="ghost" onClick={() => openModal((c) => <PubKeyModal k={k} onClose={c} />)}>
                          공개 키
                        </Button>
                      )}
                      <Button size="sm" variant="dangerGhost" onClick={() => del(k)}>
                        삭제
                      </Button>
                    </span>
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
