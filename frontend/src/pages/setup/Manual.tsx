import type { ReactNode } from "react";
import { useApp } from "../../lib/app";
import { copyText } from "../../modals/ResourceModals";
import { Icon } from "../../components/Icon";
import type { StepId, WizardState } from "./model";
import { imageShort, STEPS } from "./model";

/* ---------- building blocks ---------- */

export function Code({ children, label, wrap }: { children: string; label?: string; wrap?: boolean }) {
  const { toast } = useApp();
  return (
    <div className="relative group my-2">
      {label && <div className="text-[11px] text-faint mb-1">{label}</div>}
      <pre className={`bg-log-bg text-log-fg font-mono text-[11.5px] leading-[1.7] rounded-2xl px-4 py-3 pr-11 overflow-x-auto scroll-soft ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>{children}</pre>
      <button
        type="button"
        onClick={() => copyText(children, toast)}
        aria-label="복사"
        title="복사"
        className="absolute right-2 bottom-2 grid place-items-center size-7 rounded-lg bg-white/10 text-log-fg hover:bg-white/20 transition-colors"
      >
        <Icon name="copy" className="size-3.5" />
      </button>
    </div>
  );
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="link text-fg inline-flex items-center gap-0.5">
    {children}
    <Icon name="external" className="size-3" />
  </a>
);
const M = ({ children }: { children: ReactNode }) => <span className="font-mono text-[12px] bg-surface-2 rounded-md px-1.5 py-0.5">{children}</span>;

interface Section {
  title: string;
  body: ReactNode;
}

/** All sections open side by side: the manual sits below the form with room to spare. */
function Sections({ items }: { items: Section[] }) {
  return (
    <ol className="m-0 p-0 list-none grid md:grid-cols-2 gap-3 items-start">
      {items.map((s, i) => (
        <li key={s.title} className="rounded-[18px] bg-surface-2 p-4 min-w-0 animate-fade" style={{ animationDelay: `${i * 40}ms` }}>
          <div className="flex items-center gap-2.5 mb-1.5">
            <span className="grid place-items-center size-6 rounded-full bg-primary text-primary-fg text-[11px] font-semibold flex-none">{i + 1}</span>
            <span className="font-semibold text-[13.5px]">{s.title}</span>
          </div>
          <div className="text-[12.5px] text-muted leading-relaxed pl-[34px] [&_p]:my-1.5">{s.body}</div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- content ---------- */

function manualFor(id: StepId, w: WizardState): { intro: ReactNode; sections: Section[] } {
  const pub = w.key?.publicKey ?? "ssh-ed25519 AAAA...(1단계에서 만든 공개 키) wharfline";
  const reg = w.registry;
  switch (id) {
    case "key":
      return {
        intro: "Wharfline이 배포할 서버에 SSH로 접속할 때 쓰는 키예요. 비공개 키는 암호화되어 저장되고 누구도 다시 꺼낼 수 없어요.",
        sections: [
          {
            title: "가장 쉬운 방법: 새로 만들기",
            body: (
              <>
                <p>"새로 만들기"를 고르고 등록하면 ED25519 키 쌍이 만들어져요. 화면에 나오는 <b>공개 키</b>만 서버에 넣으면 돼요.</p>
                <p>비공개 키는 이 화면에도 나오지 않아요. 잃어버려도 새로 만들면 되니 따로 보관할 필요가 없어요.</p>
              </>
            ),
          },
          {
            title: "서버에 배포용 사용자 만들고 공개 키 넣기",
            body: (
              <>
                <p>대상 서버마다 한 번씩 실행해요. root 대신 권한이 좁은 <M>deploy</M> 사용자를 써요.</p>
                <Code label="대상 서버에서 (sudo 가능한 계정으로)">{`sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
echo '${pub}' | sudo tee -a /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys`}</Code>
                <p>더 안전하게: 공개 키 앞에 <M>from="Wharfline서버IP",no-pty,no-port-forwarding</M>을 붙이면 이 서버에서만, 터미널 없이 쓰여요.</p>
              </>
            ),
          },
          {
            title: "이미 있는 키를 쓰고 싶다면",
            body: (
              <>
                <p>배포 전용 키를 새로 만들어 가져오는 걸 권해요. 개인 키를 재사용하지 마세요.</p>
                <Code label="내 컴퓨터에서">{`ssh-keygen -t ed25519 -C wharfline -f ~/.ssh/wharfline_deploy
cat ~/.ssh/wharfline_deploy        # 이 내용을 "가져오기"에 붙여넣기`}</Code>
                <p>키 암호를 걸었다면 같이 넣어 주세요. RSA는 3072비트 이상만 받아요.</p>
              </>
            ),
          },
        ],
      };
    case "inventory":
      return {
        intro: "배포할 서버 목록이에요. 서버마다 그룹(web, worker 등)을 정하면 나중에 그룹 단위로 골라서 배포할 수 있어요.",
        sections: [
          {
            title: "서버 준비: Docker 설치",
            body: (
              <>
                <p>Ubuntu/Debian 기준이에요. 다른 배포판은 <Ext href="https://docs.docker.com/engine/install/">Docker 설치 문서</Ext>를 보세요.</p>
                <Code label="대상 서버에서">{`curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy      # deploy 사용자가 docker를 쓸 수 있게
sudo systemctl enable --now docker`}</Code>
                <p>docker 그룹은 root에 가까운 권한이에요. 이 서버는 배포 전용으로 쓰는 걸 권해요.</p>
              </>
            ),
          },
          {
            title: "방화벽: SSH 열기",
            body: (
              <>
                <p>Wharfline 서버의 IP에서만 SSH(기본 22)를 허용하세요.</p>
                <Code label="ufw 예시">{`sudo ufw allow from <Wharfline서버IP> to any port 22 proto tcp`}</Code>
              </>
            ),
          },
          {
            title: "호스트 키 지문 확인하기",
            body: (
              <>
                <p>"연결 확인"을 누르면 서버가 보낸 지문이 보여요. 서버에서 직접 확인한 값과 같아야 해요. 다르면 중간에서 가로채는 공격일 수 있어요.</p>
                <Code label="대상 서버에서">{`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`}</Code>
              </>
            ),
          },
          {
            title: "그룹 이름 정하는 법",
            body: (
              <p>
                역할별로 묶어요: <M>web</M>(웹/API), <M>worker</M>(백그라운드 작업), <M>batch</M>. 같은 그룹 서버에는 함께 배포돼요. 서버가 한 대라면 <M>web</M> 하나로 충분해요.
              </p>
            ),
          },
        ],
      };
    case "registry":
      return {
        intro: "비공개 도커 이미지를 받아올 때 쓰는 계정과 토큰이에요. 읽기 전용 토큰만 넣으세요. 공개 이미지라면 건너뛰어도 돼요.",
        sections: [
          {
            title: "GitHub Container Registry (ghcr.io) 토큰 발급",
            body: (
              <>
                <p>
                  <Ext href="https://github.com/settings/tokens/new?scopes=read:packages&description=wharfline">GitHub → Settings → Developer settings → Personal access tokens (classic)</Ext>에서 새 토큰을 만들어요.
                </p>
                <p>권한은 <M>read:packages</M> 하나만 체크하세요. 만료일도 정해 두는 게 좋아요. ghcr.io는 아직 fine-grained 토큰을 완전히 지원하지 않아서 classic 토큰을 써요.</p>
                <p>사용자 이름: GitHub 아이디 · 조직: 이미지가 있는 계정이나 조직 이름 (ghcr.io/<b>조직</b>/이미지)</p>
              </>
            ),
          },
          {
            title: "Gitea 패키지 레지스트리 토큰 발급",
            body: (
              <>
                <p>Gitea → 우측 상단 프로필 → <b>설정 → 애플리케이션 → 새 토큰 생성</b>.</p>
                <p>권한은 <M>package: 읽기</M>만 주세요. 주소에는 Gitea 호스트 이름(예: <M>git.example.com</M>)을 넣어요.</p>
              </>
            ),
          },
          {
            title: "토큰은 어떻게 보관되나요",
            body: <p>등록하면 봉투 암호화로 저장되고 화면에 다시 나오지 않아요. 배포할 때만 대상 서버에서 로그인하고 바로 로그아웃해요.</p>,
          },
        ],
      };
    case "image":
      return {
        intro: "배포할 도커 이미지 주소와 태그예요. 이미지는 CI에서 빌드해서 레지스트리에 올린 것만 써요. 서버에서 빌드하지 않아요.",
        sections: [
          {
            title: "이미지 주소 형식",
            body: (
              <>
                <p>
                  <M>{reg ? `${reg.host}/${reg.namespace || "조직"}/앱이름` : "ghcr.io/조직/앱이름"}</M> 처럼 넣어요. 소문자만 써요.
                </p>
                <p>Docker Hub 공식 이미지는 <M>docker.io/library/nginx</M>처럼 넣어요.</p>
              </>
            ),
          },
          {
            title: "GitHub Actions로 이미지 올리기",
            body: (
              <>
                <p>레포에 아래 파일을 넣으면 <M>v1.2.3</M> 같은 태그를 push할 때마다 이미지가 올라가요.</p>
                <Code label=".github/workflows/image.yml">{`name: image
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/\${{ github.repository }}:\${{ github.ref_name }}`}</Code>
              </>
            ),
          },
          {
            title: "태그는 어떻게 고르나요",
            body: <p>버전 태그(<M>v1.2.0</M>)를 권해요. latest를 고르면 실행할 때 가장 최근 태그로 고정(digest)해서 배포하니, 무엇이 배포됐는지 실행 기록에 정확히 남아요.</p>,
          },
        ],
      };
    case "repo":
      return {
        intro: "Ansible 플레이북으로 배포할 때만 필요해요. 대부분은 Docker Compose 방식으로 충분하니, 잘 모르겠다면 건너뛰세요.",
        sections: [
          {
            title: "Compose와 Ansible, 무엇을 고르나요",
            body: (
              <>
                <p><b>Compose</b>: 서버에 compose.yml과 .env를 올리고 컨테이너를 바꿔요. 레포가 필요 없어요. 처음이라면 이쪽이에요.</p>
                <p><b>Ansible</b>: 이미 팀에 배포 플레이북이 있거나, 컨테이너 외 서버 설정도 같이 바꿔야 할 때 써요.</p>
              </>
            ),
          },
          {
            title: "GitHub: 배포 키(Deploy key) 등록",
            body: (
              <>
                <p>SSH 주소(<M>git@github.com:조직/레포.git</M>)를 쓴다면, 레포의 <b>Settings → Deploy keys → Add deploy key</b>에 1단계 공개 키를 넣어요. "Allow write access"는 끄세요.</p>
                <Code label="공개 키" wrap>{pub}</Code>
              </>
            ),
          },
          {
            title: "GitHub: HTTPS + 토큰",
            body: (
              <p>
                HTTPS 주소를 쓴다면 <Ext href="https://github.com/settings/personal-access-tokens/new">fine-grained 토큰</Ext>을 만들고, 해당 레포만 고른 뒤 권한은 <M>Contents: Read-only</M>만 주세요.
              </p>
            ),
          },
          {
            title: "Gitea",
            body: <p>레포 → <b>설정 → 배포 키</b>에 공개 키를 넣거나(읽기 전용), 설정 → 애플리케이션에서 <M>repository: 읽기</M> 토큰을 만들어요.</p>,
          },
          {
            title: "플레이북에 넘어가는 변수",
            body: (
              <p>
                <M>image</M>, <M>image_tag</M>, <M>image_digest</M>, <M>env_file</M>, <M>target_group</M>만 넘겨요. 임의 extra-vars나 명령은 넣을 수 없어요.
              </p>
            ),
          },
        ],
      };
    case "deploy":
      return {
        intro: "어떤 서버 그룹에, 어떤 방식으로 배포할지 정해요. 여기까지 정하면 실행 버튼 하나로 배포돼요.",
        sections: [
          {
            title: "compose.yml 작성 규칙",
            body: (
              <>
                <p>이미지 자리에는 <M>{"${IMAGE}:${IMAGE_TAG}"}</M>를 그대로 두세요. 실행할 때 채워져요.</p>
                <p>서버 권한을 넘기는 설정은 저장되지 않아요: <M>privileged</M>, <M>network_mode: host</M>, <M>docker.sock</M> 마운트, <M>cap_add</M>, <M>pid: host</M>, <M>build:</M></p>
                <p>healthcheck를 넣어 두면 배포 후 상태 확인에 써요.</p>
              </>
            ),
          },
          {
            title: "배포 경로",
            body: <p><M>/srv/{imageShort(w.image?.ref)}</M>처럼 /srv 아래나 deploy 사용자 홈 아래만 쓸 수 있어요. 없으면 첫 배포 때 만들어져요(서버에서 deploy가 쓸 수 있어야 해요: <M>sudo mkdir -p /srv && sudo chown deploy /srv</M>).</p>,
          },
          {
            title: "안전장치",
            body: (
              <>
                <p><b>보호된 작업</b>: Deployer 역할이 실행하면 Admin 승인이 필요해요. production에는 켜 두세요.</p>
                <p><b>동시 실행 금지</b>: 같은 서버에 배포가 겹치지 않게 기다려요.</p>
                <p><b>실패 시 롤백</b>: 상태 확인이 실패하면 이전 태그로 되돌려요.</p>
              </>
            ),
          },
        ],
      };
    case "env":
      return {
        intro: "앱이 읽는 환경 변수예요. 없어도 배포할 수 있고, 나중에 환경 변수 메뉴에서 추가해도 돼요.",
        sections: [
          {
            title: "형식",
            body: (
              <>
                <Code>{`# 주석은 무시돼요
DATABASE_URL=postgres://app:비밀번호@10.0.3.31:5432/app
REDIS_URL=redis://10.0.2.21:6379/0
export JWT_SECRET="따옴표와 export는 자동으로 정리돼요"`}</Code>
              </>
            ),
          },
          {
            title: "어떻게 보관되나요",
            body: <p>값마다가 아니라 묶음마다 새 데이터 키로 AES-256-GCM 암호화하고, 그 키는 마스터 키로 다시 암호화해 저장해요. 화면에서 값을 보려면 비밀번호를 다시 확인해야 하고, 열람은 활동 기록에 남아요.</p>,
          },
          {
            title: "넣지 말아야 할 것",
            body: <p>레지스트리 토큰, SSH 키는 여기 넣지 마세요. 각각 레지스트리와 키 저장소에 등록하면 따로 보호돼요.</p>,
          },
        ],
      };
    case "review":
      return {
        intro: "완료를 누르면 배포 작업이 만들어져요. 바로 배포를 시작하거나, 나중에 배포 작업 메뉴에서 실행할 수 있어요.",
        sections: [
          {
            title: "배포를 누르면 일어나는 일",
            body: (
              <p>
                서버 연결과 호스트 키 확인 → compose.yml/.env 전송 → 레지스트리 로그인 후 이미지 받기 → 컨테이너 교체 → 상태 확인 → 레지스트리 로그아웃. 모든 단계의 로그는 실시간으로 보이고 실행 기록에 남아요.
              </p>
            ),
          },
          {
            title: "실패하면",
            body: <p>롤백을 켰다면 이전 태그로 되돌려요. 로그에서 어느 단계에서 멈췄는지 확인하고, 서버의 SSH·Docker 설정을 매뉴얼 앞 단계와 비교해 보세요.</p>,
          },
        ],
      };
  }
}

export function Manual({ step, state }: { step: StepId; state: WizardState }) {
  const { intro, sections } = manualFor(step, state);
  const title = STEPS.find((s) => s.id === step)?.short;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="grid place-items-center size-9 rounded-2xl bg-accent-soft text-accent flex-none">
          <Icon name="book" className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">매뉴얼 · {title}</h3>
          <p className="m-0 mt-0.5 text-[13px] text-muted leading-relaxed max-w-[80ch]">{intro}</p>
        </div>
      </div>
      <Sections key={step} items={sections} />
    </div>
  );
}
