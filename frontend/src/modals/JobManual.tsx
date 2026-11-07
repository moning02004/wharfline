import { useState, type ReactNode } from "react";
import { useApp } from "../lib/app";
import { copyText } from "./ResourceModals";
import { Icon } from "../components/Icon";
import { cx } from "../components/ui";

/** Steps of the new-job flow. Kept here so the manual and the modal agree on ids. */
export type JobStepId = "basic" | "target" | "method" | "env" | "safety" | "review";

/* ---------- building blocks ---------- */

function Code({ children, label, wrap }: { children: string; label?: string; wrap?: boolean }) {
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

function Sections({ items }: { items: Section[] }) {
  const [open, setOpen] = useState(0);
  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-1.5">
      {items.map((s, i) => (
        <li key={s.title} className={cx("rounded-2xl transition-colors", open === i ? "bg-surface-2" : "hover:bg-hover")}>
          <button type="button" onClick={() => setOpen(open === i ? -1 : i)} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
            <span className={cx("grid place-items-center size-6 rounded-full text-[11px] font-semibold flex-none", open === i ? "bg-accent text-on-accent" : "bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)]")}>
              {i + 1}
            </span>
            <span className="flex-1 font-medium text-[13px]">{s.title}</span>
            <Icon name="chev" className={cx("size-4 text-faint transition-transform", open === i && "rotate-180")} />
          </button>
          {open === i && <div className="px-3 pb-3 pl-[46px] text-[12.5px] text-muted leading-relaxed animate-fade [&_p]:my-1.5">{s.body}</div>}
        </li>
      ))}
    </ol>
  );
}

/* ---------- content ---------- */

const PUB = "ssh-ed25519 AAAA...(키 저장소에서 복사한 공개 키) wharfline";

function manualFor(id: JobStepId, image: string): { intro: ReactNode; sections: Section[] } {
  const app = image.split("/").pop() || "app";
  switch (id) {
    case "basic":
      return {
        intro: "배포할 도커 이미지와 태그예요. 이미지는 CI에서 빌드해 레지스트리에 올린 것만 써요. 서버에서 빌드하지 않아요. 목록에 없으면 이미지 레지스트리 메뉴에서 먼저 연결하세요.",
        sections: [
          {
            title: "이미지 주소 형식",
            body: (
              <>
                <p><M>ghcr.io/조직/앱이름</M> 처럼 넣어요. 소문자만 써요.</p>
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
          {
            title: "비공개 이미지: ghcr.io 토큰 발급",
            body: (
              <>
                <p>
                  <Ext href="https://github.com/settings/tokens/new?scopes=read:packages&description=wharfline">GitHub → Settings → Developer settings → Personal access tokens (classic)</Ext>에서 새 토큰을 만들어요.
                </p>
                <p>권한은 <M>read:packages</M> 하나만 체크하고, 만료일도 정해 두세요. ghcr.io는 아직 fine-grained 토큰을 완전히 지원하지 않아서 classic 토큰을 써요.</p>
                <p>만든 토큰은 이미지 레지스트리 메뉴에 등록해요. 봉투 암호화로 저장되고 화면에 다시 나오지 않아요.</p>
              </>
            ),
          },
          {
            title: "비공개 이미지: Gitea 토큰 발급",
            body: (
              <>
                <p>Gitea → 우측 상단 프로필 → <b>설정 → 애플리케이션 → 새 토큰 생성</b>.</p>
                <p>권한은 <M>package: 읽기</M>만 주세요. 주소에는 Gitea 호스트 이름(예: <M>git.example.com</M>)을 넣어요.</p>
              </>
            ),
          },
        ],
      };
    case "target":
      return {
        intro: "배포할 서버 묶음(인벤토리)과 그룹이에요. 서버는 인벤토리 메뉴에서, SSH 키는 키 저장소에서 등록해요. 처음이라면 아래 순서대로 서버를 준비하세요.",
        sections: [
          {
            title: "서버에 배포용 사용자 만들고 공개 키 넣기",
            body: (
              <>
                <p>대상 서버마다 한 번씩 실행해요. root 대신 권한이 좁은 <M>deploy</M> 사용자를 써요. 공개 키는 키 저장소에서 복사해요.</p>
                <Code label="대상 서버에서 (sudo 가능한 계정으로)">{`sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
echo '${PUB}' | sudo tee -a /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys`}</Code>
                <p>더 안전하게: 공개 키 앞에 <M>from="Wharfline서버IP",no-pty,no-port-forwarding</M>을 붙이면 이 서버에서만, 터미널 없이 쓰여요.</p>
              </>
            ),
          },
          {
            title: "Docker 설치",
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
                <p>인벤토리에서 "연결 확인"을 누르면 서버가 보낸 지문이 보여요. 서버에서 직접 확인한 값과 같아야 해요. 다르면 중간에서 가로채는 공격일 수 있어요.</p>
                <Code label="대상 서버에서">{`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`}</Code>
              </>
            ),
          },
          {
            title: "그룹은 어떻게 고르나요",
            body: (
              <p>
                역할별로 묶어요: <M>web</M>(웹/API), <M>worker</M>(백그라운드 작업), <M>batch</M>. 고른 그룹의 서버에 함께 배포되고, 그룹을 고르지 않으면 인벤토리 전체에 배포해요.
              </p>
            ),
          },
        ],
      };
    case "method":
      return {
        intro: "서버에 어떻게 배포할지 정해요. 대부분은 Docker Compose로 충분하고, 팀에 배포 플레이북이 이미 있다면 Ansible을 골라요.",
        sections: [
          {
            title: "Compose와 Ansible, 무엇을 고르나요",
            body: (
              <>
                <p><b>Compose</b>: 서버에 compose.yml과 .env를 올리고 컨테이너를 바꿔요. 레포가 필요 없어요. 처음이라면 이쪽이에요.</p>
                <p><b>Ansible</b>: 이미 팀에 배포 플레이북이 있거나, 컨테이너 외 서버 설정도 같이 바꿔야 할 때 써요. 플레이북 레포 메뉴에서 레포를 먼저 연결해요.</p>
              </>
            ),
          },
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
            body: (
              <p>
                <M>/srv/{app}</M>처럼 /srv 아래나 deploy 사용자 홈 아래만 쓸 수 있어요. 없으면 첫 배포 때 만들어져요(서버에서 deploy가 쓸 수 있어야 해요: <M>sudo mkdir -p /srv && sudo chown deploy /srv</M>).
              </p>
            ),
          },
          {
            title: "플레이북 레포 연결: GitHub",
            body: (
              <>
                <p>SSH 주소(<M>git@github.com:조직/레포.git</M>)라면 레포의 <b>Settings → Deploy keys → Add deploy key</b>에 키 저장소의 공개 키를 넣어요. "Allow write access"는 끄세요.</p>
                <p>
                  HTTPS 주소라면 <Ext href="https://github.com/settings/personal-access-tokens/new">fine-grained 토큰</Ext>을 만들고, 해당 레포만 고른 뒤 권한은 <M>Contents: Read-only</M>만 주세요.
                </p>
              </>
            ),
          },
          {
            title: "플레이북 레포 연결: Gitea",
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
    case "env":
      return {
        intro: "앱이 읽는 환경 변수예요. 없어도 배포할 수 있고, 나중에 환경 변수 메뉴에서 추가해도 돼요.",
        sections: [
          {
            title: "형식",
            body: (
              <Code>{`# 주석은 무시돼요
DATABASE_URL=postgres://app:비밀번호@10.0.3.31:5432/app
REDIS_URL=redis://10.0.2.21:6379/0
export JWT_SECRET="따옴표와 export는 자동으로 정리돼요"`}</Code>
            ),
          },
          {
            title: "어떻게 보관되나요",
            body: <p>값마다가 아니라 묶음마다 새 데이터 키로 AES-256-GCM 암호화하고, 그 키는 마스터 키로 다시 암호화해 저장해요. 화면에서 값을 보려면 비밀번호를 다시 확인해야 하고, 열람은 활동 기록에 남아요.</p>,
          },
          {
            title: "넣지 말아야 할 것",
            body: <p>레지스트리 토큰, SSH 키는 여기 넣지 마세요. 각각 이미지 레지스트리와 키 저장소에 등록하면 따로 보호돼요.</p>,
          },
        ],
      };
    case "safety":
      return {
        intro: "실행 방식과 실패했을 때의 동작이에요. 잘 모르겠다면 기본값을 쓰세요.",
        sections: [
          {
            title: "보호된 작업",
            body: <p>Deployer 역할이 실행하면 Admin 승인을 받은 뒤 시작돼요. production에는 켜 두세요.</p>,
          },
          {
            title: "동시 실행 금지",
            body: <p>같은 서버에 다른 배포가 돌고 있으면 끝날 때까지 기다려요. 배포가 겹쳐 컨테이너가 꼬이는 걸 막아요.</p>,
          },
          {
            title: "실패하면 롤백",
            body: <p>상태 확인(healthcheck)이 실패하면 직전에 성공한 이미지 태그로 되돌려요.</p>,
          },
          {
            title: "새 태그가 올라오면 자동 배포",
            body: <p>레지스트리 webhook의 서명을 검증하고, <M>v</M>로 시작하는 릴리스 태그만 받아요. 보호된 작업이라면 자동 배포도 승인을 기다려요.</p>,
          },
        ],
      };
    case "review":
      return {
        intro: "만들기를 누르면 배포 작업이 만들어져요. 배포 작업 메뉴에서 실행 버튼으로 배포를 시작해요.",
        sections: [
          {
            title: "실행하면 일어나는 일",
            body: (
              <p>
                서버 연결과 호스트 키 확인 → compose.yml/.env 전송 → 레지스트리 로그인 후 이미지 받기 → 컨테이너 교체 → 상태 확인 → 레지스트리 로그아웃. 모든 단계의 로그는 실시간으로 보이고 실행 기록에 남아요.
              </p>
            ),
          },
          {
            title: "실패하면",
            body: <p>롤백을 켰다면 이전 태그로 되돌려요. 로그에서 어느 단계에서 멈췄는지 확인하고, 서버의 SSH·Docker 설정을 "배포 대상" 단계 매뉴얼과 비교해 보세요.</p>,
          },
        ],
      };
  }
}

export function JobManual({ step, image }: { step: JobStepId; image: string }) {
  const { intro, sections } = manualFor(step, image);
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[12.5px] text-muted leading-relaxed">{intro}</p>
      <Sections key={step} items={sections} />
    </div>
  );
}
