/** Step ids and the guide shown under each step of the deploy job modal ("배포를 도와드릴까요?"). */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";

export type JobStepId = "name" | "playbook" | "target" | "image" | "env" | "access" | "review";

export const JOB_STEPS: { id: JobStepId; label: string }[] = [
  { id: "name", label: "기본 정보" },
  { id: "playbook", label: "플레이북" },
  { id: "target", label: "배포 대상" },
  { id: "image", label: "이미지" },
  { id: "env", label: "환경 변수" },
  { id: "access", label: "권한과 안전장치" },
  { id: "review", label: "확인" },
];

type Mode = "new" | "edit";

/* ---------- small building blocks ---------- */

/** Inline code. */
function C({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11.5px] px-1 py-px rounded-[4px] bg-surface-2 border border-line text-fg break-all">{children}</code>;
}

/** Compact mono block. */
function Code({ children }: { children: string }) {
  return (
    <pre className="m-0 font-mono text-[11.5px] leading-[1.55] text-fg bg-surface-2 border border-line rounded-lg px-3 py-2 overflow-x-auto scroll-soft whitespace-pre">
      {children}
    </pre>
  );
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="m-0 mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-faint tracking-[0.02em]">
        <Icon name={icon} className="size-3" />
        {title}
      </h4>
      <div className="space-y-1.5 text-[12.5px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="m-0 p-0 list-none space-y-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-1.5 min-w-0">
          <span className="text-faint flex-none select-none">·</span>
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** Two-column "input → result" rows, stacked on narrow screens. */
function Pairs({ head, rows }: { head?: [string, string]; rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="rounded-lg border border-line overflow-hidden text-[12px]">
      {head && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2 px-2.5 py-1 bg-surface-2 text-faint font-medium border-b border-line">
          <span>{head[0]}</span>
          <span>{head[1]}</span>
        </div>
      )}
      {rows.map(([a, b], i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2 px-2.5 py-1.5 border-b border-line last:border-b-0 items-baseline">
          <span className="min-w-0 break-words">{a}</span>
          <span className="min-w-0 break-words text-muted">{b}</span>
        </div>
      ))}
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11.5px] text-fg">{children}</span>;

/* ---------- content ---------- */

interface GuideBody {
  what: ReactNode;
  example?: ReactNode;
  mistakes?: ReactNode[];
}

const PLAYBOOK_SNIPPET = `- hosts: all
  tasks:
    - name: 앱 컨테이너 띄우기
      community.docker.docker_container:
        name: "{{ app_name }}"
        image: "{{ image_ref }}"
        env_file: "{{ env_file | default(omit) }}"
        restart_policy: unless-stopped`;

function content(step: JobStepId, mode: Mode): GuideBody {
  switch (step) {
    case "name":
      return {
        what: (
          <>
            <p className="m-0">
              이 작업을 부를 이름이에요. 배포 작업 목록, 실행 기록, 로그에 이 이름이 그대로 나와요. <b className="text-fg font-medium">무엇을 · 어디에</b> 배포하는지 한눈에 보이게 적으면 좋아요.
            </p>
            <p className="m-0">
              플레이북에는 이 이름을 줄인 <C>app_name</C>이 넘어가요. 예: <C>api-server-production</C>
            </p>
          </>
        ),
        example: (
          <Bullets
            items={[
              <C>api-server · production</C>,
              <C>web · staging</C>,
              <C>worker · canary</C>,
            ]}
          />
        ),
        mistakes: [
          <>
            <C>배포1</C>, <C>test</C>처럼 뜻이 없는 이름은 나중에 목록에서 헷갈려요.
          </>,
          "같은 이름은 두 번 쓸 수 없어요. 환경을 붙여서 구분해 주세요.",
        ],
      };

    case "playbook":
      return {
        what: (
          <>
            <p className="m-0">
              플레이북은 서버에서 무엇을 할지 적은 Ansible 파일(<C>.yml</C>)이에요. 두 가지 중에 골라요.
            </p>
            <Bullets
              items={[
                <>
                  <b className="text-fg font-medium">Git 레포</b>: 팀에 이미 플레이북이 있을 때. 주소, 브랜치, 레포 안의 파일 경로를 적어요.
                </>,
                <>
                  <b className="text-fg font-medium">기본 플레이북</b>: 플레이북이 없을 때. 이미지 하나를 <C>.env</C>와 함께 컨테이너로 띄워 줘요. 이때는 이미지가 꼭 있어야 해요.
                </>,
              ]}
            />
            <p className="m-0">
              비공개 레포는 키가 필요해요. <b className="text-fg font-medium">SSH 주소</b>는 SSH 키, <b className="text-fg font-medium">HTTPS 비공개</b>는 토큰, 공개 레포는 아무것도 필요 없어요. 키는 키 저장소에 있고, 없으면 옆의 "키 추가"로 바로 만들 수 있어요.
            </p>
          </>
        ),
        example: (
          <>
            <Pairs
              rows={[
                [<span className="text-faint">주소</span>, <Mono>git@git.acme.kr:ops/ansible.git</Mono>],
                [<span className="text-faint">브랜치</span>, <Mono>main</Mono>],
                [<span className="text-faint">경로</span>, <Mono>deploy/app.yml</Mono>],
              ]}
            />
            <p className="m-0">플레이북은 이 다섯 변수를 받아요. 이미지나 환경 변수가 없으면 해당 변수는 빠져요.</p>
            <Pairs
              rows={[
                [<Mono>image</Mono>, <Mono>docker.io/library/postgres</Mono>],
                [<Mono>image_tag</Mono>, <Mono>15</Mono>],
                [<Mono>image_ref</Mono>, <Mono>docker.io/library/postgres:15</Mono>],
                [<Mono>env_file</Mono>, <Mono>/srv/wharfline/&lt;app_name&gt;/.env</Mono>],
                [<Mono>app_name</Mono>, <Mono>api-server-production</Mono>],
              ]}
            />
            <Code>{PLAYBOOK_SNIPPET}</Code>
          </>
        ),
        mistakes: [
          <>
            경로는 레포 안에서부터 적어요. <C>/deploy/app.yml</C>처럼 <C>/</C>로 시작하거나 <C>..</C>이 들어가면 안 돼요.
          </>,
          <>
            <C>git@...</C> 주소에 SSH 키를 안 고르면 저장되지 않아요.
          </>,
          <>
            <C>env_file</C>은 없을 수도 있으니 <C>default(omit)</C>을 붙여 두면 안전해요.
          </>,
        ],
      };

    case "target":
      return {
        what: (
          <>
            <p className="m-0">
              <b className="text-fg font-medium">인벤토리</b>는 서버 목록이에요(예: production, staging). <b className="text-fg font-medium">그룹</b>은 그 안의 일부 서버 묶음이에요(예: web, worker).
            </p>
            <p className="m-0">그룹을 비워 두면 인벤토리의 모든 서버에 배포해요. 아래 미리보기에서 실제로 어떤 서버에 가는지 확인할 수 있어요.</p>
          </>
        ),
        example: (
          <Pairs
            head={["고른 것", "배포되는 곳"]}
            rows={[
              [<Mono>production</Mono>, "production의 모든 서버"],
              [<Mono>production · web</Mono>, "web 그룹의 서버만"],
              [<Mono>production · web, worker</Mono>, "두 그룹의 서버"],
            ]}
          />
        ),
        mistakes: [
          <>
            미리보기에 <b className="text-fg font-medium">건너뜀</b>으로 나온 서버는 배포되지 않아요. "호스트 키 확인 필요"면 서버 화면에서 호스트 키(서버 신원 확인용 지문)를 먼저 승인하고, "연결 안 됨"이면 서버가 켜져 있는지 확인해 주세요.
          </>,
          "운영 인벤토리를 고르면서 그룹을 비워 두면 모든 운영 서버에 가요. 한 번 더 확인해 주세요.",
        ],
      };

    case "image":
      return {
        what: (
          <>
            <p className="m-0">
              <C>docker pull</C> 할 때 쓰는 그대로 <C>이름:버전</C> 한 줄을 적어요. 처음 보는 이미지면 이미지 목록에 자동으로 등록돼요.
            </p>
            <p className="m-0">
              플레이북만 돌리는 작업이면 비워 두고 "이미지 없이 진행"을 눌러요. 기본 플레이북을 골랐다면 꼭 적어야 해요.
            </p>
          </>
        ),
        example: (
          <Pairs
            head={["적은 것", "이렇게 읽어요 (이미지 · 버전)"]}
            rows={[
              [<Mono>postgres:15</Mono>, <Mono>docker.io/library/postgres · 15</Mono>],
              [<Mono>bitnami/redis</Mono>, <Mono>docker.io/bitnami/redis · latest</Mono>],
              [<Mono>ghcr.io/acme/api:v1.2</Mono>, <Mono>ghcr.io/acme/api · v1.2</Mono>],
            ]}
          />
        ),
        mistakes: [
          <>
            버전을 안 적으면 <C>latest</C>예요. <C>latest</C>는 버전 목록에 저장되지 않으니, 되돌릴 일이 있으면 <C>v1.2</C>처럼 정확한 버전을 쓰는 게 좋아요.
          </>,
          "레지스트리 토큰은 비공개 이미지일 때만 필요해요. 공개 이미지는 그냥 두세요.",
          <>
            <C>@sha256:...</C> 같은 digest는 받지 않아요. 태그로 적어 주세요.
          </>,
        ],
      };

    case "env":
      return {
        what: (
          <>
            <p className="m-0">
              앱에 넘길 <C>.env</C>예요. 세 가지 방법이 있어요: <b className="text-fg font-medium">붙여넣기</b>, <b className="text-fg font-medium">파일 올리기</b>, 이미 만든 <b className="text-fg font-medium">저장된 세트</b> 고르기.
            </p>
            <p className="m-0">
              값은 암호화해서 저장해요(봉투 암호화: 값마다 키로 잠그고, 그 키를 다시 마스터 키로 잠그는 방식). 배포할 때 서버에 파일로 올리고, 그 경로를 플레이북에 <C>env_file</C>로 넘겨요.
            </p>
            {mode === "edit" && (
              <p className="m-0">
                편집에서는 <b className="text-fg font-medium">지금 것 유지</b>가 기본이라 손대지 않으면 그대로예요. 새로 붙여넣으면 같은 세트의 새 버전으로 저장되고, 비밀값을 바꾸는 일이라 비밀번호를 한 번 더 물어봐요.
              </p>
            )}
          </>
        ),
        example: <Code>{`NODE_ENV=production\nDATABASE_URL=postgres://app:****@db.internal:5432/app\nLOG_LEVEL=info`}</Code>,
        mistakes: [
          <>
            <C>KEY = value</C>처럼 <C>=</C> 양옆에 띄어쓰기를 넣으면 앱에 따라 못 읽어요. <C>KEY=value</C>로 붙여 주세요.
          </>,
          "환경 변수가 필요 없으면 \".env 없이 진행\"을 눌러요. 그러면 env_file 변수도 빠져요.",
        ],
      };

    case "access":
      return {
        what: (
          <>
            <p className="m-0">
              <b className="text-fg font-medium">누가 고칠 수 있나</b>: Owner와 Admin은 항상, Viewer는 못 해요. 그 밖의 사람은 이 작업을 만든 사람, 그리고 여기서 고른 그룹·사람만 고칠 수 있어요.
            </p>
            <Pairs
              head={["안전장치", "켜면"]}
              rows={[
                [<b className="text-fg font-medium">자동 배포</b>, <>Git 연동으로 새 <C>v</C> 태그(예: <C>v1.9.0</C>)가 오면 알아서 배포해요.</>],
                [<b className="text-fg font-medium">운영 보호</b>, "실행 전에 한 번 더 확인을 받아요."],
                [<b className="text-fg font-medium">동시 실행 잠금</b>, "이 작업이 도는 동안 같은 작업을 또 못 돌려요."],
                [<b className="text-fg font-medium">실패 시 되돌리기</b>, "배포가 실패하면 직전 태그로 자동으로 되돌려요."],
              ]}
            />
          </>
        ),
        mistakes: [
          "운영 환경이면 운영 보호와 동시 실행 잠금은 켜 두는 게 좋아요.",
          <>
            실패 시 되돌리기는 직전 태그가 있어야 해요. <C>latest</C>만 쓰면 돌아갈 곳이 없어요.
          </>,
        ],
      };

    case "review":
      return {
        what: (
          <>
            <p className="m-0">
              {mode === "new" ? "만들기" : "저장"} 전에 마지막으로 훑어봐요. 특히 이 세 가지요.
            </p>
            <Bullets
              items={[
                "배포 대상: 인벤토리와 그룹이 맞는지, 운영 서버 전체로 가고 있지 않은지",
                "이미지 버전: 의도한 태그인지 (latest인지 아닌지)",
                "환경 변수: 맞는 세트를 골랐는지",
              ]}
            />
            <p className="m-0">
              {mode === "new"
                ? "만든 뒤에도 배포 작업 목록의 \"편집\" 버튼으로 언제든 고칠 수 있어요. 만들기만 해서는 배포되지 않고, 실행을 눌러야 시작돼요."
                : "바꾼 내용은 다음 실행부터 적용돼요. 지금 돌고 있는 배포에는 영향이 없어요. 줄 옆 \"고치기\"로 그 단계에 바로 갈 수 있어요."}
            </p>
          </>
        ),
      };
  }
}

/* ---------- panel ---------- */

export function JobGuide({ step, mode }: { step: JobStepId; mode: Mode }) {
  const label = JOB_STEPS.find((s) => s.id === step)?.label ?? "";
  const body = content(step, mode);
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-3 sm:px-4 min-w-0">
      <div className="flex items-center gap-1.5 mb-2.5 text-[12px] font-medium">
        <span className="grid place-items-center size-5 rounded-md bg-accent-soft text-accent flex-none">
          <Icon name="wand" className="size-3" />
        </span>
        <span className="text-faint">가이드</span>
        <span className="text-faint">·</span>
        <span className="text-fg">{label}</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-x-5 gap-y-3">
        <div className={body.example ? "" : "sm:col-span-2"}>
          <Section icon="note" title="무엇을 적나요">
            {body.what}
          </Section>
        </div>
        {body.example && (
          <Section icon="book" title="예시">
            {body.example}
          </Section>
        )}
        {body.mistakes && (
          <div className="sm:col-span-2">
            <Section icon="alert" title="자주 하는 실수">
              <Bullets items={body.mistakes} />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
