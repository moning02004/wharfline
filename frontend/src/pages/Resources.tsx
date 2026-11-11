import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import { useApi, useApp } from "../lib/app";
import type { Build, GitProvider, Image, ImageUsage, Inventory as Inv, Key, Registry, Repo } from "../lib/types";
import { HostKeyModal, NewHostModal, NewImageModal, NewInventoryModal, NewKeyModal, NewRegistryModal, PubKeyModal, copyText } from "../modals/ResourceModals";
import { Icon } from "../components/Icon";
import { ModalBody, ModalFoot, ModalHead } from "../components/Modal";
import { Banner, Button, Card, CardHeader, Chip, Dot, ErrorText, Field, Input, Loading, PageHeader, Seg, Select, TableWrap, Textarea } from "../components/ui";
import { PROVIDER_NAME } from "../components/BuildBadge";

const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono">{children}</span>;

/* ---------- registries ---------- */

function RegistryActions({ g }: { g: Registry }) {
  const { openModal, withSudo, refresh, toast } = useApp();
  const del = () =>
    openModal((c) => (
      <ConfirmDelete
        title="레지스트리 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("레지스트리 삭제", async () => {
            await api.del(`/registries/${g.id}`);
            refresh();
            toast(`${g.host}/${g.namespace} 레지스트리를 지웠어요`);
          })
        }
      >
        <span className="font-mono font-medium">
          {g.host}/{g.namespace}
        </span>
        와(과) 저장된 토큰을 지워요.
        {g.imageCount > 0 && (
          <>
            {" "}
            이 레지스트리로 받던 이미지 {g.imageCount}개는 이제 로그인 없이 받거나(같은 주소에 다른 레지스트리가 있으면 그걸로) 받아요. 비공개 이미지라면 배포가 실패해요.
          </>
        )}
      </ConfirmDelete>
    ));
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="ghost" icon="edit" onClick={() => openModal((c) => <NewRegistryModal reg={g} onClose={c} />)}>
        편집
      </Button>
      <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`${g.host}/${g.namespace} 레지스트리 삭제`} title="레지스트리 삭제" onClick={del} />
    </span>
  );
}

export function Registries() {
  const { data } = useApi<{ registries: Registry[]; images: Image[] }>("/registries");
  const { openModal, can } = useApp();
  const git = useApi<GitSettings>("/integrations/git").data;
  const [picked, setProvider] = useState<GitProvider | null>(null);
  const provider = picked ?? lastSeenProvider(git) ?? "gitea";
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="이미지 레지스트리" desc="배포할 도커 이미지와, 이미지를 받아 올 곳이에요. 공개 이미지(postgres, nginx 등)는 레지스트리 없이 바로 받아요. 레지스트리는 비공개 이미지를 받을 토큰이 필요할 때만 추가하세요. GitHub, GitLab, Gitea 레지스트리를 지원하고, 이미지 주소의 호스트로 알아서 골라요.">
        {can("resources") && (
          <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewRegistryModal onClose={c} />)}>
            레지스트리 추가
          </Button>
        )}
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
                {can("resources") && <th />}
              </tr>
            </thead>
            <tbody>
              {!data.registries.length && (
                <tr>
                  <td colSpan={can("resources") ? 6 : 5} className="text-center text-muted py-6 !whitespace-normal">
                    등록한 레지스트리가 없어요. 공개 이미지만 쓴다면 그대로 두어도 돼요.
                  </td>
                </tr>
              )}
              {data.registries.map((g) => (
                <tr key={g.id}>
                  <td className="font-medium">{g.name}</td>
                  <td className="font-mono">
                    {g.host}/{g.namespace}
                  </td>
                  <td className="font-mono text-muted">{g.user}</td>
                  <td className="text-muted">{g.auth}</td>
                  <td className="tabular-nums">{g.imageCount}개</td>
                  {can("resources") && (
                    <td className="text-right">
                      <RegistryActions g={g} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <ImagesCard images={data.images} registries={data.registries} provider={provider} />
      <GitCard settings={git} provider={provider} onProvider={setProvider} />
    </>
  );
}

function ImagesCard({ images, registries, provider }: { images: Image[]; registries: Registry[]; provider: GitProvider }) {
  const { runAction, toast, openModal, can, withSudo, refresh } = useApp();
  const manage = can("resources");
  const [editing, setEditing] = useState<string | null>(null);
  const [repo, setRepo] = useState("");

  const save = async (ref: string) => {
    const ok = await runAction(() => api.put("/images/source", { ref, sourceRepo: repo }), repo ? "빌드 레포를 연결했어요" : "연결을 풀었어요");
    if (ok) setEditing(null);
  };
  const test = (ref: string, fail: boolean) =>
    runAction(() => api.post("/integrations/git/test", { ref, fail, provider }), fail ? "실패하는 시험 빌드를 보냈어요. 배포 작업 화면에서 확인해 보세요." : "시험 빌드를 보냈어요. 배포 작업 화면에서 확인해 보세요.").catch(() => toast("시험 빌드를 보내지 못했어요"));

  const delTag = (ref: string, tag: string) => runAction(() => api.del(`/images/tags?ref=${encodeURIComponent(ref)}&tag=${encodeURIComponent(tag)}`), `${tag} 태그를 지웠어요`);
  const showTags = (i: Image) => openModal((c) => <ImageTagsModal image={i} canDelete={manage} onDelete={delTag} onClose={c} />);
  const del = (i: Image) =>
    openModal((c) => (
      <ConfirmDelete
        title="이미지 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("이미지 삭제", async () => {
            await api.del(`/images?ref=${encodeURIComponent(i.ref)}`);
            refresh();
            toast(`${i.ref}을(를) 지웠어요`);
          })
        }
      >
        <span className="font-mono font-medium">{i.ref}</span>와(과) Wharfline이 알던 태그 {i.tags.length}개를 지워요. 레지스트리에 있는 이미지는 그대로예요. 다시 쓰려면 배포 작업에
        적거나 이미지 추가로 넣으면 돼요.
      </ConfirmDelete>
    ));

  return (
    <Card>
      <CardHeader
        title="이미지"
        sub="배포 작업에 이미지를 적으면 여기에 저절로 들어와요. 빌드 레포 연결은 선택이에요. 연결하면 Git 호스트(Gitea, GitHub, GitLab)에서 빌드하는 동안 배포 작업에 '빌드 중'이 보이고 새 태그가 들어와요."
      >
        {manage && (
          <Button icon="plus" onClick={() => openModal((c) => <NewImageModal registries={registries} onClose={c} />)}>
            이미지 추가
          </Button>
        )}
      </CardHeader>
      <TableWrap>
        <table className="tbl">
          <thead>
            <tr>
              <th>이미지</th>
              <th>최신 태그</th>
              <th>빌드 레포</th>
              <th>쓰는 작업</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!images.length && (
              <tr>
                <td colSpan={5} className="text-center text-muted py-6">
                  아직 이미지가 없어요. 배포 작업에 이미지를 적거나 이미지 추가로 넣어 보세요.
                </td>
              </tr>
            )}
            {images.map((i) => {
              const t = i.tags[0];
              return (
                <tr key={i.ref}>
                  <td>
                    <div className="font-mono">{i.ref}</div>
                    <div className="text-[12px] text-muted">
                      {(() => {
                        const r = registries.find((x) => x.id === i.registry);
                        return r ? (
                          <>
                            <span className="font-mono">
                              {r.host}/{r.namespace}
                            </span>{" "}
                            {r.hasSecret ? "토큰으로 받아요" : "레지스트리(토큰 없음)"}
                          </>
                        ) : (
                          "공개 이미지로 받아요"
                        );
                      })()}
                    </div>
                  </td>
                  <td>
                    <span className="font-mono">{t?.name ?? "-"}</span> <span className="text-faint text-[12px]">{t?.pushed}</span>
                    {i.tags.length > 0 && (
                      <button type="button" className="ml-1.5 text-[12px] text-accent hover:underline" onClick={() => showTags(i)}>
                        태그 {i.tags.length}개
                      </button>
                    )}
                  </td>
                  <td>
                    {editing === i.ref ? (
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          save(i.ref);
                        }}
                      >
                        <Input mono autoFocus className="!h-7 w-[200px]" placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="빌드 레포" />
                        <Button size="sm" variant="primary" type="submit">
                          저장
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          취소
                        </Button>
                      </form>
                    ) : !manage ? (
                      <span className="font-mono text-[12.5px]">{i.sourceRepo ?? <span className="font-sans text-faint">없음</span>}</span>
                    ) : (
                      <button
                        type="button"
                        className="font-mono text-[12.5px] rounded px-1 -mx-1 hover:bg-hover"
                        onClick={() => {
                          setRepo(i.sourceRepo ?? "");
                          setEditing(i.ref);
                        }}
                      >
                        {i.sourceRepo ?? <span className="font-sans text-accent">+ 연결</span>}
                      </button>
                    )}
                  </td>
                  <td>
                    {i.usedBy.length ? (
                      <Button size="sm" variant="ghost" onClick={() => openModal((c) => <ImageUsageModal image={i} onClose={c} />, "md")}>
                        자세히
                      </Button>
                    ) : (
                      <span className="text-faint">없음</span>
                    )}
                  </td>
                  <td className="text-right">
                    {manage && (
                      <span className="inline-flex gap-1">
                        {i.sourceRepo && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => test(i.ref, false)} title={`${PROVIDER_NAME[provider]} 형식으로 보내요`}>
                              시험 빌드
                            </Button>
                            <Button size="sm" variant="dangerGhost" onClick={() => test(i.ref, true)}>
                              실패 시험
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="trash"
                          aria-label={`${i.ref} 이미지 삭제`}
                          title={i.usedBy.length ? "배포 작업에서 쓰고 있어 지울 수 없어요" : "이미지 삭제"}
                          disabled={i.usedBy.length > 0}
                          onClick={() => del(i)}
                        />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

/** Every tag Wharfline knows for an image, newest first; a wrong one (typo, test, removed from the registry) can be deleted. */
function ImageTagsModal({ image, canDelete, onDelete, onClose }: { image: Image; canDelete: boolean; onDelete: (ref: string, tag: string) => Promise<unknown>; onClose: () => void }) {
  const [tags, setTags] = useState(image.tags);
  return (
    <>
      <ModalHead title="이미지 태그" sub={image.ref} onClose={onClose} />
      <ModalBody>
        <div className="text-[12.5px] text-muted">
          Wharfline이 아는 태그예요. 실행할 때 고르는 목록과 latest가 가리키는 태그가 여기서 나와요. 레지스트리의 이미지는 지우지 않아요.
        </div>
        <div className="rounded-lg border border-line divide-y divide-line max-h-[360px] overflow-auto">
          {tags.map((t) => (
            <div key={t.name} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <span className="font-mono flex-1 truncate">{t.name}</span>
              <span className="text-faint text-[12px]">{t.pushed}</span>
              {canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="trash"
                  aria-label={`${t.name} 태그 삭제`}
                  title="태그 삭제"
                  onClick={async () => {
                    if ((await onDelete(image.ref, t.name)) !== false) setTags((x) => x.filter((y) => y.name !== t.name));
                  }}
                />
              )}
            </div>
          ))}
          {!tags.length && <div className="px-3 py-4 text-center text-muted text-[13px]">아는 태그가 없어요.</div>}
        </div>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>닫기</Button>
      </ModalFoot>
    </>
  );
}

interface GitSettings {
  path: string;
  secretSet: boolean;
  secretCreated: number | null;
  lastSeen: Record<GitProvider, number | null>;
}

/** The host that sent a build most recently, so the card opens on the guide people actually use. */
function lastSeenProvider(s: GitSettings | null | undefined): GitProvider | null {
  if (!s) return null;
  const seen = (Object.entries(s.lastSeen) as [GitProvider, number | null][]).filter(([, t]) => t);
  return seen.length ? seen.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0][0] : null;
}

const B = ({ children }: { children: React.ReactNode }) => <b className="text-fg">{children}</b>;

/** Where to click on each host. The webhook address and secret are the same for all three. */
const GUIDE: Record<GitProvider, React.ReactNode[]> = {
  gitea: [
    <>이미지를 빌드하는 <B>저장소(또는 조직)의 설정 → 웹훅 → 웹훅 추가 → Gitea</B>를 고르세요. Forgejo도 같아요.</>,
    <><B>대상 URL</B>에 위 웹훅 주소, <B>HTTP 메서드</B>는 POST, <B>POST 콘텐츠 유형</B>은 <Mono>application/json</Mono>.</>,
    <><B>비밀</B>에 위에서 만든 비밀값을 넣어요.</>,
    <><B>트리거</B>는 "사용자 지정 이벤트"에서 <B>Workflow run</B>, <B>Workflow job</B>, <B>패키지</B>를 체크하고 저장해요.</>,
  ],
  github: [
    <>이미지를 빌드하는 <B>저장소(또는 조직)의 Settings → Webhooks → Add webhook</B>으로 가세요.</>,
    <><B>Payload URL</B>에 위 웹훅 주소, <B>Content type</B>은 <Mono>application/json</Mono>.</>,
    <><B>Secret</B>에 위에서 만든 비밀값을 넣어요.</>,
    <>"Let me select individual events"에서 <B>Workflow runs</B>, <B>Workflow jobs</B>, <B>Registry packages</B>를 체크해요. 이미지는 ghcr.io에 올라가고 저장소에 연결돼 있어야 태그 알림이 와요.</>,
  ],
  gitlab: [
    <>이미지를 빌드하는 <B>프로젝트의 Settings → Webhooks → Add new webhook</B>으로 가세요.</>,
    <><B>URL</B>에 위 웹훅 주소를 넣어요.</>,
    <><B>Secret token</B>에 위에서 만든 비밀값을 넣어요. GitLab은 서명 대신 이 값을 그대로 보내요.</>,
    <><B>Trigger</B>에서 <B>Pipeline events</B>와 <B>Job events</B>를 체크하고 저장해요.</>,
    <>GitLab은 이미지 푸시 알림이 없어서 <B>파이프라인 성공</B>으로 새 태그를 알아요. Git 태그 파이프라인은 그 태그, 기본 브랜치는 커밋 SHA 앞 8자리예요(레포의 <Mono>.gitlab-ci.yml</Mono>과 같은 규칙).</>,
  ],
};

function GitCard({ settings, provider, onProvider }: { settings: GitSettings | null | undefined; provider: GitProvider; onProvider: (p: GitProvider) => void }) {
  const { withSudo, openModal, refresh, toast, can } = useApp();
  const [poll, setPoll] = useState(0);
  const builds = useApi<Build[]>("/builds", poll).data ?? [];
  useEffect(() => {
    setPoll(builds.some((b) => b.active) ? 3000 : 0);
  }, [builds]);
  const url = `${window.location.origin}${settings?.path ?? "/api/hooks/git"}`;
  const name = PROVIDER_NAME[provider];

  const makeSecret = () =>
    withSudo("Git 웹훅 비밀값 만들기", async () => {
      const r = await api.post<{ secret: string }>("/integrations/git/secret");
      refresh();
      openModal((c) => <SecretModal secret={r.secret} onClose={c} />);
    });

  return (
    <Card>
      <CardHeader title="Git 연동" sub="Gitea, GitHub, GitLab의 CI 빌드 진행과 새 이미지 푸시를 실시간으로 받아요.">
        {settings?.secretSet ? <Dot tone="ok">연결 준비됨</Dot> : <Dot tone="warn">비밀값 필요</Dot>}
      </CardHeader>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-x-8 gap-y-5 p-4">
        <div className="flex flex-col gap-3.5">
          <Field label="웹훅 주소 (세 곳 모두 같아요)">
            <div className="flex gap-1.5">
              <Input mono readOnly value={url} aria-label="웹훅 주소" />
              <Button icon="copy" onClick={() => copyText(url, toast)}>
                복사
              </Button>
            </div>
          </Field>
          <Field
            label="비밀값"
            hint={settings?.secretSet ? "새로 만들면 이전 값은 바로 쓸 수 없게 돼요. 연결한 Git 호스트 쪽 값도 같이 바꿔 주세요." : "Git 호스트가 보낸 요청인지 확인하는 키예요. 암호화해 저장하고 한 번만 보여줘요."}
          >
            <div className="flex items-center gap-2">
              <span className="text-muted">{settings?.secretSet ? `설정됨 · ${new Date((settings.secretCreated ?? 0) * 1000).toLocaleString("ko-KR")}` : "아직 없어요"}</span>
              {can("resources") && (
                <Button size="sm" icon="key" onClick={makeSecret}>
                  {settings?.secretSet ? "새로 만들기" : "비밀값 만들기"}
                </Button>
              )}
            </div>
          </Field>
          <div>
            <div className="text-[12.5px] font-medium mb-1.5">최근 빌드</div>
            <div className="rounded-md border border-line overflow-hidden">
              {builds.slice(0, 5).map((b) => (
                <div key={b.id} className="flex items-center gap-2.5 px-3 py-2 border-b border-line last:border-b-0 text-[12.5px] min-w-0">
                  <StatusPillForBuild b={b} />
                  <span className="text-faint text-[11.5px]">{PROVIDER_NAME[b.provider]}</span>
                  <span className="font-mono truncate">{b.repo}</span>
                  <span className="text-muted">#{b.runNumber ?? b.runId}</span>
                  {b.tag && <Chip mono>{b.tag}</Chip>}
                  <span className="ml-auto text-faint truncate">{b.active ? b.step ?? "대기" : b.title}</span>
                </div>
              ))}
              {!builds.length && <div className="px-3 py-4 text-center text-muted text-[12.5px]">아직 받은 빌드가 없어요.</div>}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <Seg<GitProvider>
              options={[
                { value: "gitea", label: "Gitea" },
                { value: "github", label: "GitHub" },
                { value: "gitlab", label: "GitLab" },
              ]}
              value={provider}
              onChange={onProvider}
            />
            {settings?.lastSeen[provider] ? (
              <span className="text-[12px] text-muted">마지막 수신 {new Date(settings.lastSeen[provider]! * 1000).toLocaleString("ko-KR")}</span>
            ) : (
              <span className="text-[12px] text-faint">아직 받은 이벤트 없음</span>
            )}
          </div>
          <ol className="m-0 pl-5 flex flex-col gap-2 text-[12.5px] text-muted marker:text-faint">
            {GUIDE[provider].map((step, i) => (
              <li key={`${provider}-${i}`}>{step}</li>
            ))}
            <li>
              위 이미지 표에서 이미지마다 <B>빌드 레포</B>({provider === "gitlab" ? "group/project" : "owner/name"})를 연결하면 끝이에요. 자동 배포가 켜진 작업은{" "}
              <Mono>v</Mono>로 시작하는 새 태그가 올라오면 바로 배포돼요.
            </li>
            <li className="text-faint">
              {name} 서버가 이 주소로 접속할 수 있어야 해요(localhost는 안 돼요).{" "}
              {provider === "gitea" ? "사설망이면 Gitea에서 Wharfline 주소가 보이게 해 주세요." : `${name}.com을 쓰면 Wharfline이 인터넷에서 보여야 해요. 사내 ${name}면 사설망 주소도 돼요.`}
            </li>
          </ol>
        </div>
      </div>
    </Card>
  );
}

function StatusPillForBuild({ b }: { b: Build }) {
  if (b.active) return <Dot tone="accent" pulse>{b.status === "queued" ? "대기" : "빌드 중"}</Dot>;
  if (b.status === "success") return <Dot tone="ok">성공</Dot>;
  if (b.status === "failure") return <Dot tone="bad">실패</Dot>;
  return <Dot>{b.status === "cancelled" ? "취소" : "건너뜀"}</Dot>;
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { toast } = useApp();
  return (
    <>
      <ModalHead title="웹훅 비밀값" sub="이 창을 닫으면 다시 볼 수 없어요. 웹훅의 비밀값 칸(Gitea '비밀', GitHub 'Secret', GitLab 'Secret token')에 넣어 주세요." onClose={onClose} />
      <ModalBody>
        <div className="flex gap-1.5">
          <Input mono readOnly value={secret} aria-label="비밀값" />
          <Button icon="copy" onClick={() => copyText(secret, toast)}>
            복사
          </Button>
        </div>
        <Banner icon="lock">봉투 암호화로 저장돼요. 잃어버리면 새로 만들고 Git 호스트 쪽 값도 바꾸면 돼요.</Banner>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          넣었어요
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- repos ---------- */

export function Repos() {
  const { data } = useApi<Repo[]>("/repos");
  const { openModal, can, withSudo, refresh, toast } = useApp();
  const manage = can("resources");
  if (!data) return <Loading />;
  const del = (r: Repo) =>
    openModal((c) => (
      <ConfirmDelete
        title="플레이북 레포 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("플레이북 레포 삭제", async () => {
            await api.del(`/repos/${r.id}`);
            refresh();
            toast(`${r.name}을(를) 지웠어요`);
          })
        }
      >
        <span className="font-mono font-medium">{r.name}</span> ({r.branch})을(를) Wharfline에서 지워요. Git 저장소와 키 저장소의 키는 그대로예요.
      </ConfirmDelete>
    ));
  const builtin = data.find((r) => r.kind === "builtin");
  const repos = data.filter((r) => r.kind !== "builtin");
  return (
    <>
      <PageHeader
        title="플레이북 레포"
        desc={
          <>
            배포 작업이 실행하는 Ansible 플레이북이 있는 곳이에요. 따로 연결하지 않아도 돼요. 배포 작업을 만들 때 Git 주소를 넣으면 여기에 저절로 들어오고, 같은 주소와 브랜치는 다시 써요. 비공개 저장소에 쓰는 SSH 키나 토큰은 <Link to="/keys" className="link text-fg">키 저장소</Link>에서 가져와요.
          </>
        }
      />
      {builtin && (
        <Card>
          <div className="flex items-start gap-3 p-4">
            <span className="flex-none grid place-items-center size-9 rounded-lg bg-accent-soft text-accent">
              <Icon name="box" className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <b className="font-semibold">Wharfline 기본 플레이북</b>
                <Chip tone="accent">늘 있어요</Chip>
              </div>
              <div className="text-muted text-[13px] mt-0.5">
                <Mono>container.yml</Mono>: 이미지 하나를 <Mono>.env</Mono>와 함께 컨테이너로 띄워요. 플레이북이 없으면 배포 작업에서 이걸 고르세요.
              </div>
              <UsedBy items={builtin.usedBy} className="mt-2" />
            </div>
          </div>
        </Card>
      )}
      <Card>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>레포</th>
                <th>브랜치</th>
                <th>인증</th>
                <th>쓰는 작업</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {!repos.length && (
                <tr>
                  <td colSpan={manage ? 5 : 4} className="text-center text-muted py-6 !whitespace-normal">
                    아직 레포가 없어요. 배포 작업을 만들 때 플레이북의 Git 주소를 넣으면 여기에 생겨요.
                  </td>
                </tr>
              )}
              {repos.map((r) => (
                <tr key={r.name}>
                  <td>
                    <div className="font-mono font-medium">{r.name}</div>
                    <div className="font-mono text-[12px] text-muted">
                      {r.kind === "local" && <Chip className="mr-1.5">서버 경로</Chip>}
                      {r.url}
                    </div>
                  </td>
                  <td className="font-mono">{r.branch}</td>
                  <td className="text-muted">{r.auth}</td>
                  <td>
                    <UsedBy items={r.usedBy} />
                  </td>
                  {manage && (
                    <td className="text-right">
                      {r.kind === "git" && (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="ghost" icon="key" onClick={() => openModal((c) => <RepoKeyModal repo={r} onClose={c} />)}>
                            키 바꾸기
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon="trash"
                            aria-label={`${r.name} 레포 삭제`}
                            title={r.usedBy.length ? "배포 작업에서 쓰고 있어 지울 수 없어요" : "레포 삭제"}
                            disabled={r.usedBy.length > 0}
                            onClick={() => del(r)}
                          />
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <Banner icon="shield" title="플레이북에 넘기는 변수는 정해져 있어요">
        <Mono>image</Mono>, <Mono>image_tag</Mono>, <Mono>image_ref</Mono>, <Mono>env_file</Mono>, <Mono>app_name</Mono>만 넘겨요. 이미지나 환경 변수가 없는 작업이면 그 변수는 빠져요. 화면에서 extra-vars나 임의 명령은 넣을 수 없어요.
      </Banner>
    </>
  );
}

/** Pick another SSH key or access token for a repo, e.g. after the old token was revoked on the Git host. */
function RepoKeyModal({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const { openModal, withSudo, refresh, toast } = useApp();
  const ssh = /^(git@|ssh:\/\/)/.test(repo.url);
  const keys = (useApi<Key[]>("/keys").data ?? []).filter((k) => k.kind === (ssh ? "ssh" : "token"));
  const current = repo.auth.includes(" · ") ? repo.auth.split(" · ").slice(1).join(" · ") : "";
  const [key, setKey] = useState(current);
  const [err, setErr] = useState("");

  const save = () =>
    withSudo("플레이북 레포 키 변경", async () => {
      try {
        await api.put(`/repos/${repo.id}/key`, { key });
        refresh();
        toast(`${repo.name}의 인증을 바꿨어요`);
        onClose();
      } catch (e) {
        setErr(errMsg(e));
      }
    });

  return (
    <>
      <ModalHead title="레포 키 바꾸기" sub={`${repo.url} · ${repo.branch}`} onClose={onClose} />
      <ModalBody>
        <Field
          label={ssh ? "SSH 키" : "액세스 토큰"}
          htmlFor="rKey"
          hint={ssh ? "저장소에 읽기 권한이 있는 배포 키를 골라 주세요." : "Git 호스트에서 토큰을 새로 만들었다면 먼저 키 저장소에 넣고 골라 주세요."}
          right={
            <Button size="sm" variant="ghost" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} onCreated={(k) => setKey(k.name)} />)}>
              {ssh ? "키 추가" : "토큰 추가"}
            </Button>
          }
        >
          <Select id="rKey" value={key} onChange={(e) => setKey(e.target.value)}>
            {!ssh && <option value="">공개 저장소(키 없음)</option>}
            {ssh && !key && <option value="">키를 골라 주세요</option>}
            {keys.map((k) => (
              <option key={k.id} value={k.name}>
                {k.name} · {k.type}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorText>{err}</ErrorText>
        <Banner icon="git" title="이 레포를 쓰는 작업 모두에 적용돼요">
          {repo.usedBy.length ? repo.usedBy.map((u) => u.job).join(", ") : "아직 쓰는 작업이 없어요."}
        </Banner>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" disabled={(ssh && !key) || key === current} onClick={save}>
          저장
        </Button>
      </ModalFoot>
    </>
  );
}

function UsedBy({ items, className }: { items: { job: string; path: string }[]; className?: string }) {
  if (!items.length) return <span className={`text-faint ${className ?? ""}`}>아직 없음</span>;
  return (
    <span className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      {items.map((u) => (
        <Chip key={`${u.job}|${u.path}`}>
          {u.job} · <span className="font-mono text-[11px]">{u.path}</span>
        </Chip>
      ))}
    </span>
  );
}

/** Where an image is used: each job, how it names the image, the version running now, and auto-deploy. */
function ImageUsageModal({ image, onClose }: { image: Image; onClose: () => void }) {
  const usage = image.usage ?? [];
  const how = (u: ImageUsage) =>
    u.role === "main" ? (
      "메인 이미지"
    ) : u.role === "var" ? (
      <span className="font-mono">{"${" + u.var + "}"}</span>
    ) : (
      <>
        파일에 고정 <span className="font-mono">:{u.literal}</span>
      </>
    );
  const hook = (u: ImageUsage) =>
    !u.hook ? <span className="text-faint">꺼짐</span> : u.hookRule === "any" ? "모든 태그" : u.hookRule === "date" ? "날짜 태그" : u.hookRule.startsWith("re:") ? <span className="font-mono">{u.hookRule.slice(3)}</span> : <>v로 시작</>;
  return (
    <>
      <ModalHead title="쓰는 작업" sub={image.ref} onClose={onClose} />
      <ModalBody>
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>작업</th>
                <th>쓰는 방식</th>
                <th>지금 버전</th>
                <th>대상</th>
                <th>자동 배포</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u, ix) => (
                <tr key={u.jobId + ix}>
                  <td className="font-medium">
                    <Link to="/jobs" className="link" onClick={onClose}>
                      {u.job}
                    </Link>
                  </td>
                  <td className="text-[12.5px]">{how(u)}</td>
                  <td className="font-mono text-[12.5px]">{u.role === "fixed" ? u.literal : u.tagNow && u.tagNow !== "-" ? u.tagNow : <span className="font-sans text-faint">배포 전</span>}</td>
                  <td className="text-[12.5px]">
                    {u.inventory}
                    {u.targets.length ? <span className="text-muted"> · {u.targets.join(", ")}</span> : null}
                  </td>
                  <td className="text-[12.5px]">{hook(u)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      </ModalFoot>
    </>
  );
}

/* ---------- inventory ---------- */

/** Asks before deleting; the password re-check follows. */
export function ConfirmDelete({ title, children, action, onConfirm, onClose }: { title: string; children: React.ReactNode; action: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <>
      <ModalHead title={title} onClose={onClose} />
      <ModalBody>
        <div className="text-[13.5px] leading-relaxed">{children}</div>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>취소</Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </Button>
      </ModalFoot>
    </>
  );
}

export function Inventory() {
  const { data } = useApi<Inv[]>("/inventory");
  const { openModal, toast, can, withSudo, refresh } = useApp();
  const manage = can("resources");
  const [pinging, setPinging] = useState<string | null>(null);
  if (!data) return <Loading />;

  const ping = async (inv: Inv) => {
    setPinging(inv.id);
    try {
      const r = await api.post<{ total: number; ok: number; hosts: { name: string; ok: boolean; error: string | null }[] }>(`/inventory/${inv.id}/ping`);
      refresh();
      const bad = r.hosts.filter((h) => !h.ok);
      if (!bad.length) toast(`${inv.name}: ${r.total}대 모두 연결됐어요`);
      else toast(`${inv.name}: ${r.total}대 중 ${bad.length}대 실패 · ${bad.map((h) => `${h.name}: ${h.error ?? "연결 안 됨"}`).join(" / ")}`, "error");
    } catch (e) {
      toast(errMsg(e));
    }
    setPinging(null);
  };

  const delInventory = (inv: Inv) =>
    openModal((c) => (
      <ConfirmDelete
        title="인벤토리 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("인벤토리 삭제", async () => {
            await api.del(`/inventory/${inv.id}`);
            refresh();
            toast(`${inv.name}을(를) 지웠어요`);
          })
        }
      >
        <span className="font-mono font-medium">{inv.name}</span>
        {inv.hosts.length ? `과(와) 서버 ${inv.hosts.length}대를 Wharfline에서 지워요.` : "을(를) 지워요."} 서버 자체와 서버에 넣은 키는 그대로예요.
      </ConfirmDelete>
    ));

  const delHost = (inv: Inv, ix: number) => {
    const h = inv.hosts[ix];
    openModal((c) => (
      <ConfirmDelete
        title="서버 삭제"
        action="삭제"
        onClose={c}
        onConfirm={() =>
          withSudo("서버 삭제", async () => {
            await api.del(`/inventory/${inv.id}/hosts/${ix}`);
            refresh();
            toast(`${h.name}을(를) 지웠어요`);
          })
        }
      >
        <span className="font-mono font-medium">{h.name}</span> ({h.ip})을(를) {inv.name}에서 지워요. 이 서버의 <span className="font-mono">{h.group}</span> 그룹에 배포하는 작업은 이제 이 서버에 배포하지
        않아요.
      </ConfirmDelete>
    ));
  };

  return (
    <>
      <PageHeader
        title="인벤토리"
        desc="배포 대상 서버 묶음이에요. 서버마다 그룹을 정해 두면 배포 작업에서 그룹만 골라 보낼 수 있어요. 처음 연결할 때 호스트 키 지문을 저장하고, 이후 바뀌면 배포를 막아요."
      >
        {manage && (
          <>
            <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewInventoryModal onClose={c} />)}>
              인벤토리 추가
            </Button>
          </>
        )}
      </PageHeader>
      {data.map((inv) => {
        const sharedWith = data.filter((o) => o.id !== inv.id && o.key === inv.key).map((o) => o.name);
        const gm: Record<string, number> = {};
        inv.hosts.forEach((h) => (gm[h.group] = (gm[h.group] ?? 0) + 1));
        return (
          <Card key={inv.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2 flex-wrap">
                  {inv.name}
                  <span className="inline-flex items-center gap-1 text-xs text-muted font-mono font-normal" title="배포 사용자 · SSH 키">
                    <Icon name="users" className="size-[13px]" />
                    {inv.user}
                    <Icon name="key" className="size-[13px] ml-1.5" />
                    {inv.key}
                  </span>
                  {sharedWith.length > 0 && <SharedKeyChip others={sharedWith} />}
                  {Object.entries(gm).map(([g, n]) => (
                    <Chip key={g}>
                      {g} · {n}
                    </Chip>
                  ))}
                </span>
              }
            >
              {manage && (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" icon="plus" onClick={() => openModal((c) => <NewHostModal inventory={inv} onClose={c} />)}>
                    서버 추가
                  </Button>
                  <Button size="sm" icon="refresh" disabled={pinging === inv.id || !inv.hosts.length} onClick={() => ping(inv)}>
                    {pinging === inv.id ? "확인 중…" : "연결 테스트"}
                  </Button>
                  <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`${inv.name} 인벤토리 삭제`} title="인벤토리 삭제" onClick={() => delInventory(inv)} />
                </div>
              )}
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
                        <div className="inline-flex items-center gap-1.5">
                          {h.hostKey === "changed" && manage && (
                            <Button size="sm" variant="danger" onClick={() => openModal((c) => <HostKeyModal invId={inv.id} ix={ix} host={h} onClose={c} />)}>
                              지문 확인
                            </Button>
                          )}
                          {manage && (
                            <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`${h.name} 서버 삭제`} title="서버 삭제" onClick={() => delHost(inv, ix)} />
                          )}
                        </div>
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
  const { openModal, toast, withSudo, refresh, can } = useApp();
  const manage = can("resources");
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
        {manage && (
          <Button variant="primary" icon="plus" onClick={() => openModal((c) => <NewKeyModal onClose={c} />)}>
            키 추가
          </Button>
        )}
      </PageHeader>
      <Banner icon="info" title="비공개 키와 토큰은 내려받거나 열람할 수 없어요">
        SSH 키는 공개 키와 지문만, 토큰은 계정과 끝 4자리만 볼 수 있어요. 키를 잃어버렸다면 새로 만들고 서버의 authorized_keys를 바꾸는 쪽이 안전해요.
      </Banner>
      {data.some((k) => k.sharedAcrossInventories) && (
        <Banner tone="warn" icon="alert" title="여러 인벤토리가 같은 SSH 키를 써요">
          키 하나가 새면 그 키를 쓰는 모든 환경이 함께 열려요. production과 staging처럼 환경마다 키를 따로 만들어 쓰세요.
        </Banner>
      )}
      <AccessFromCard />
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
                  <td className="tabular-nums">
                    {k.kind === "ssh" && k.inventories?.length ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {k.inventories.map((n) => (
                          <Chip key={n} mono>
                            {n}
                          </Chip>
                        ))}
                        {k.sharedAcrossInventories && <SharedKeyChip />}
                      </span>
                    ) : k.usedCount ? (
                      `${k.kind === "token" ? "레포" : "인벤토리"} ${k.usedCount}곳`
                    ) : (
                      <span className="text-faint">없음</span>
                    )}
                  </td>
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
                      {manage && (
                        <Button size="sm" variant="dangerGhost" onClick={() => del(k)}>
                          삭제
                        </Button>
                      )}
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

function SharedKeyChip({ others }: { others?: string[] }) {
  return (
    <Chip tone="warn" icon="alert" className="font-sans">
      {others ? `키 공유 · ${others.join(", ")}` : "여러 인벤토리가 공유"}
    </Chip>
  );
}

/** Where Wharfline connects from. The public-key view puts these in authorized_keys as from="…". */
function AccessFromCard() {
  const { role, runAction } = useApp();
  const { data } = useApi<{ addresses: string[]; canEdit: boolean }>("/keys/access-from");
  const [text, setText] = useState<string | null>(null);
  const canEdit = role === "Owner" || role === "Admin";
  if (!data) return null;

  const editing = text !== null;
  const save = async () => {
    const addresses = (text ?? "").split(/[\s,]+/).filter(Boolean);
    const ok = await runAction(() => api.put("/keys/access-from", { addresses }), addresses.length ? "접속 허용 주소를 저장했어요" : "접속 허용 주소를 비웠어요");
    if (ok) setText(null);
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2 flex-wrap">
            접속 허용 주소
            {data.addresses.length ? <Chip tone="ok">설정됨</Chip> : <Chip tone="warn">비어 있음</Chip>}
          </span>
        }
        sub="Wharfline이 서버에 접속할 때 나가는 IP예요. 공개 키 줄에 from=으로 붙어서, 키가 새어도 이 주소 밖에서는 못 써요."
      >
        {canEdit && !editing && (
          <Button size="sm" icon="edit" onClick={() => setText(data.addresses.join("\n"))}>
            편집
          </Button>
        )}
      </CardHeader>
      <div className="p-5 flex flex-col gap-3">
        {editing ? (
          <>
            <Field label="IP 또는 CIDR, 한 줄에 하나" htmlFor="accessFrom" hint="예: 203.0.113.10, 10.0.0.0/24. 비우면 제한 없이 어디서든 접속을 받아요.">
              <Textarea id="accessFrom" rows={3} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </Field>
            <div className="flex gap-2 justify-end">
              <Button size="sm" onClick={() => setText(null)}>
                취소
              </Button>
              <Button size="sm" variant="primary" onClick={save}>
                저장
              </Button>
            </div>
          </>
        ) : data.addresses.length ? (
          <span className="flex flex-wrap gap-1.5">
            {data.addresses.map((a) => (
              <Chip key={a} mono>
                {a}
              </Chip>
            ))}
          </span>
        ) : (
          <span className="text-muted text-[13px]">
            아직 없어요. 지금 서버에 넣는 공개 키는 어디서든 접속을 받아요.{canEdit ? "" : " Owner나 Admin이 넣을 수 있어요."}
          </span>
        )}
      </div>
    </Card>
  );
}
