# Wharfline

셀프호스팅 배포 콘솔 프로토타입. React + Tailwind 프론트엔드, FastAPI 백엔드, PostgreSQL(Alembic 마이그레이션)로 구성돼요. 서버마다 **Wharfline 에이전트**(Docker 컨테이너)가 Wharfline에 접속해서 배포하므로, Wharfline은 서버의 SSH 키를 갖지 않아요. 환경 변수, 액세스·레지스트리 토큰은 봉투 암호화(AES-256-GCM)로 저장하고, 마스터 키는 DB 밖의 로컬 키 파일(Docker secret)에 둬요.

배포 작업은 **배포 작업 → 새 배포 작업** 모달에서 단계별(기본 정보 → 대상 → 방식 → .env → 안전장치 → 확인)로 만들어요. 제목 옆 ⓘ를 누르면 그 단계에서 무엇을 어디서 발급받는지 매뉴얼이 보여요.

```
backend/
  app/                FastAPI + SQLAlchemy, 실행 로그는 SSE로 스트리밍
    authn.py          비밀번호(bcrypt), TOTP, 세션 토큰, CSRF 미들웨어
    crypto.py         봉투 암호화 (마스터 키 파일)
    keys.py           마스터 키 상태 확인, 검증, 교체
    sshkeys.py        SSH 키 생성·가져오기, 지문 (Git 저장소, 전환 전 서버용)
    agentproto.py     에이전트와 서로 믿는 법: 서명, 봉인, 등록 토큰
    agenthub.py       서버마다의 작업 큐 (에이전트가 long-poll로 가져가요)
    agentinstall.py   서버에 에이전트를 띄우는 명령 (서버 초기화, install.sh)
    registryclient.py 레지스트리에 태그의 다이제스트를 물어봐요
  migrations/         Alembic 마이그레이션
  tests/              pytest (암호화, SSH 키, TOTP, 로그인·권한·배포·웹훅 흐름)
  alembic.ini
frontend/             Vite + React + TypeScript + Tailwind v4, nginx로 서빙
agent/                Wharfline 에이전트 이미지 (서버마다 하나, `make agent`로 빌드)
docker-compose.yml       db + backend + frontend
docker-compose.dev.yml   로컬 개발용: DB 포트를 localhost:55432에 열어요
Makefile                 자주 쓰는 명령 (`make`로 목록 보기)
secrets/master_keys      마스터 키 (`make keygen`이 만들어요, git에 안 올라가요)
```

## Docker로 실행

```bash
cp .env.example .env     # 비밀번호와 포트를 바꾸려면
make up                  # 마스터 키가 없으면 만들고, docker compose up -d --build
# http://localhost:8080
```

- nginx가 `/api/*` 요청을 backend로 넘겨요. backend와 DB 포트는 외부에 열지 않아요.
- 시작 순서: `db` → `migrate`(일회용: DB 대기 → `alembic upgrade head` → DB가 비어 있으면 예시 데이터) → `backend` → `frontend`.
  backend는 migrate가 성공해야 시작해서, backend를 여러 개 띄워도 마이그레이션이 겹치지 않아요. migrate를 동시에 여러 번 돌려도 Postgres advisory lock으로 하나만 실행돼요.
- API는 DB가 최신 마이그레이션이 아니거나, 마스터 키가 없거나, 저장된 데이터에 필요한 키가 빠져 있으면 시작하지 않아요.
- 데이터는 `pgdata` 볼륨에 남아요. 처음부터 다시 시작하려면 `make db-reset`.

## 로그인

- **예시 계정**: `jeonghoon@acme.kr`(Owner), `minji@acme.kr`(Deployer), `seojun@acme.kr`(Viewer). 비밀번호는 `WHARFLINE_SEED_PASSWORD`(기본 `wharfline`)예요. 처음 DB를 만들 때만 쓰이니, 공유하는 곳에 띄우기 전에 `.env`에서 바꾸고 로그인 뒤 **보안 → 비밀번호 바꾸기**로 각자 바꿔요.
  예전 데모 DB를 마이그레이션하면 기존 멤버도 이 비밀번호를 받고, 다음 로그인 때 새 비밀번호를 정해야 해요.
- **세션**: 브라우저마다 따로예요. 쿠키 `wharfline_session`(HttpOnly, SameSite=Lax)에는 임의 토큰만 있고 DB에는 그 SHA-256만 저장해요. 만료는 보안 정책의 세션 길이(기본 6시간, 그동안은 활동이 없어도 유지. "8시간 (활동 없으면 30분)" 같은 값을 고르면 활동이 없을 때 먼저 끝나요). **보안 → 로그인된 기기**에서 다른 기기를 로그아웃할 수 있어요.
- **HTTPS로 띄우면** `WHARFLINE_COOKIE_SECURE=1`을 줘서 쿠키에 Secure를 붙여요(HTTP에서 켜면 로그인이 안 돼요).
- **비밀번호**: bcrypt 해시. 틀리면 이메일이 있든 없든 같은 메시지이고, 정책의 잠금 규칙(기본 5회 실패 → 15분)을 서버가 지켜요. 비밀번호 재확인(민감 정보 열람 등)도 실제 비밀번호를 확인해요.
- **멤버 일괄 추가**(Owner만): **멤버와 권한 → 멤버 일괄 추가**에서 한 줄에 하나씩 `그룹, 계정, 이름`으로 적고(또는 .txt를 올리고) **추가하기**를 누르면 돼요. 이름은 `그룹명 이름`으로 저장돼요(`전략기획실, a@b.com, A 과장` → "전략기획실 A 과장"). 이름은 비워도 되고, 그러면 이메일 앞부분이 이름이 돼요. 쉼표 대신 탭이나 띄어쓰기(`그룹 계정 이름`, 이메일 앞이 그룹·뒤가 이름)도 되고, 예전 `| 그룹 | 계정 |` 표도 받아요. 틀린 줄이 있으면 그 줄을 보여 주고 아무것도 추가하지 않아요. 추가할 때 비밀번호를 다시 확인해요.
  새 계정은 Viewer, 비밀번호 `0000`이고 처음 로그인하면 새 비밀번호를 정하기 전에는 아무것도 못 해요. 이미 있는 계정은 이름·역할·비밀번호를 그대로 두고 그룹만 더해요. 없는 그룹은 작업·실행 기록·보안 메뉴만 보이게 만들어지니 그룹 탭에서 넓혀 주세요.
  ```
  전략기획실, username@a.com, A 과장
  전략기획실, kim@a.com, 김민수 대리
  브랜드마케팅2팀, lee@a.com, 이영희 사원
  ```
- **비밀번호를 잊었을 때**: Owner가 **멤버와 권한**에서 비밀번호 재설정 → 임시 비밀번호를 한 번만 보여 줘요. 그 멤버는 다음 로그인 때 새 비밀번호를 정하고, 잠금도 풀려요.
- **2단계 인증은 선택**이에요. **보안 → 인증 앱 켜기**로 각자 켜면 그때부터 로그인 두 번째 단계에서 TOTP(30초, 6자리)를 물어요. 비밀값은 봉투 암호화, 복구 코드는 해시로 저장해요. 정책 "모든 멤버에게 2단계 인증 강제"(기본 꺼짐)를 켜면 2단계 인증이 없는 멤버는 로그인 직후 설정 화면으로 가요.
- **CSRF**: `/api/hooks/*`를 뺀 모든 변경 요청(POST/PUT/PATCH/DELETE)은 `X-Requested-With: wharfline` 헤더가 있어야 해요. 프론트(`lib/api.ts`)가 붙여요. API를 스크립트로 부를 때도 넣어 주세요.
- 접속 IP는 nginx가 넘기는 `X-Real-IP`로 기록해요. backend 포트를 밖에 열면 이 값은 믿을 수 없어요.

## 마이그레이션

모델(`backend/app/models.py`)을 바꾼 뒤:

```bash
make revision m="add description to jobs"   # 변경을 감지해 backend/migrations/versions/에 파일 생성
# 생성된 파일을 꼭 열어 보고 고쳐요 (아래 주의점 참고)
make migrate                                # 적용 (backend 재시작 때도 자동 적용돼요)
make check                                  # 모델과 마이그레이션이 어긋나면 실패 (CI에 넣기 좋아요)
```

| 명령 | 하는 일 |
| --- | --- |
| `make migrate` | 남은 마이그레이션 모두 적용 |
| `make downgrade` | 하나 되돌리기 |
| `make current` / `make history` | 지금 DB 리비전 / 마이그레이션 목록 |
| `make check` | 모델과 DB 스키마 차이 검사 |
| `make sql` | 실행하지 않고 SQL만 출력 (운영 DB에 직접 적용하거나 검토할 때) |
| `make db-shell` | psql 열기 |

이 명령들은 `./backend`를 마운트한 일회용 backend 컨테이너에서 돌아서, 로컬에 Python을 설치하지 않아도 되고 새 파일이 바로 레포에 생겨요.

**자동 생성이 놓치는 것** (직접 써야 해요)

- 시퀀스 추가·삭제 (`run_no_seq`는 초기 마이그레이션에 직접 넣었어요)
- 컬럼·테이블 이름 변경: 삭제 후 추가로 잡혀서 데이터가 사라져요. `op.alter_column(..., new_column_name=)`으로 고쳐요.
- 기존 행이 있는 테이블에 `nullable=False` 컬럼 추가: `server_default`를 주거나, 추가 → 값 채우기 → NOT NULL 순서로 나눠요.
- 데이터 변환: `op.execute()`나 `op.get_bind()`로 직접 써요.

제약 조건 이름은 `app/db.py`의 naming convention으로 정해져서(`pk_keys`, `uq_keys_name` 등) 나중에 바꾸거나 지울 수 있어요.

## 비밀 값 암호화

환경 변수, SSH 비공개 키, 액세스 토큰, 레지스트리 토큰 모두 봉투 암호화로 저장해요 (`backend/app/crypto.py`). 어떤 API도 비공개 키와 토큰을 다시 내주지 않아요.

- 저장할 때마다 새 데이터 키(DEK, 256비트)를 만들어 값을 AES-256-GCM으로 암호화하고, DEK는 마스터 키(KEK)로 다시 AES-256-GCM 암호화해서 함께 저장해요. DB에는 감싼 DEK만 있고 마스터 키는 없어요.
- 암호문과 감싼 DEK는 레코드 ID에 묶여 있어요(AAD). DB에서 다른 행으로 옮겨 붙이거나 한 바이트라도 바꾸면 복호화가 실패해요.
- 평문으로 남는 건 변수 이름뿐이에요(목록과 로그 마스킹용). 값의 길이도 화면에 보여주지 않아요.
- 값은 비밀번호를 다시 확인한 사용자에게만 `/values`로 나가고, 열람은 활동 기록에 남아요.

**마스터 키**는 `secrets/master_keys`에 있고 Docker secret으로 `/run/secrets/master_keys`에 읽기 전용으로 붙어요(환경 변수가 아니라서 `docker inspect`에 안 보여요). 한 줄에 `<id>:<base64 32바이트>`이고 첫 줄이 새 데이터를 암호화하는 키예요.

> **이 파일을 잃으면 환경 변수를 되살릴 수 없어요.** DB 백업과 따로, 비밀번호 관리자 같은 안전한 곳에 백업하세요.

| 명령 | 하는 일 |
| --- | --- |
| `make keygen` | 키 파일이 없으면 만들기 (`make up`이 자동으로 해요) |
| `make key-status` | 각 행이 어떤 키로 감싸져 있는지 |
| `make key-verify` | 모든 행을 복호화해서 키와 데이터가 멀쩡한지 확인 |
| `make key-rotate` | 새 키를 맨 앞에 추가 → 모든 DEK를 새 키로 다시 감싸기 → API 재시작. 데이터는 다시 암호화하지 않아요 |

| `make key-backup` | 키 파일을 암호(passphrase)로 잠근 백업 파일을 `backups/`에 만들기 |
| `make key-restore f=…` | 백업에서 키 파일 되살리기 |

키 교체 후 `key-status`가 새 키만 보여주면 파일에서 옛 키 줄을 지워요(백업은 남겨 두세요).

## Git 연동 (빌드 상태와 새 이미지 자동 배포)

Gitea(Forgejo), GitHub, GitLab의 CI가 이미지를 빌드하는 동안 배포 작업에 `빌드 중`을 띄우고, 이미지가 푸시되면 새 태그를 등록해요. 자동 배포가 켜진 작업은 `v`로 시작하는 새 태그가 오면 바로 배포해요.

1. **이미지 레지스트리 → Git 연동**에서 비밀값을 만들어요(봉투 암호화로 저장, 한 번만 보여줘요). 세 곳 모두 같은 값을 써요.
2. 빌드하는 저장소에 웹훅을 추가해요. 주소는 모두 `https://<wharfline 주소>/api/hooks/git`, 콘텐츠 유형 `application/json`.

| 호스트 | 메뉴 | 비밀값 칸 | 이벤트 |
|---|---|---|---|
| Gitea / Forgejo | 설정 → 웹훅 → 웹훅 추가 → Gitea | 비밀 | Workflow run, Workflow job, 패키지 |
| GitHub | Settings → Webhooks → Add webhook | Secret | Workflow runs, Workflow jobs, Registry packages |
| GitLab | Settings → Webhooks → Add new webhook | Secret token | Pipeline events, Job events |

3. 이미지 표에서 이미지마다 **빌드 레포**(`owner/name`, GitLab 하위 그룹은 `group/sub/name`)를 연결해요.

- 보낸 곳은 헤더로 알아봐요(`X-Gitea-Event`, `X-GitHub-Event`, `X-Gitlab-Event`). Gitea·GitHub는 HMAC-SHA256 서명(`X-Gitea-Signature`, `X-Hub-Signature-256`), GitLab은 `X-Gitlab-Token`이 맞아야만 받아요. 비밀값이 없으면 503, 틀리면 401이에요.
- GitLab은 이미지 푸시 알림이 없어서 파이프라인 성공으로 새 태그를 알아요. Git 태그 파이프라인은 그 태그, 기본 브랜치는 커밋 SHA 앞 8자리(`CI_COMMIT_SHORT_SHA`)예요. 레포의 `.gitlab-ci.yml`과 같은 규칙이에요.
- 예전 주소 `/api/hooks/gitea`도 계속 받아요. 이미 만든 Gitea 웹훅은 그대로 둬도 돼요.
- Git 호스트가 Wharfline 주소에 접속할 수 있어야 해요.
- 실제 Git 호스트 없이 확인하려면 Git 연동 카드에서 호스트를 고른 뒤 이미지 표의 **시험 빌드** / **실패 시험**을 누르면 그 호스트 형식의 이벤트가 같은 처리 경로로 흘러가요.
- 웹훅 비밀값도 `make key-status` / `key-verify` / `key-rotate` 대상이에요.

## 서버와 에이전트

서버마다 에이전트 컨테이너 하나가 Wharfline에 **밖으로** 접속해(long-poll) 할 일을 받아 가요. Wharfline은 서버의 SSH 키를 갖지 않고, 서버는 Wharfline으로 나가는 HTTP(S)만 있으면 돼요. 배포 작업을 몇 개 추가하든 에이전트는 서버당 하나예요.

- **서버 추가 (인벤토리 → 서버 추가)**
  - **새 서버 초기화**: 서버에 원래 있던 계정과 비밀번호로 SSH에 한 번 들어가서(비밀번호는 저장하지 않아요) 실행 계정을 만들고, Docker와 docker rollout을 설치하고, 허용 경로를 만들고, 에이전트를 띄워요. 호스트 키 지문을 확인한 뒤에만 비밀번호를 보내요.
  - **설치 명령으로 추가**: Wharfline이 SSH로 들어갈 수 없는 서버. 화면에 나온 한 줄을 서버에서 root로 실행해요: `curl -fsSL <Wharfline>/api/agent/install.sh | sudo sh -s -- <토큰> <계정> <경로>`.
  - **에이전트로 전환**: 예전처럼 SSH 키로 배포하던 서버는 목록에 "SSH · 전환 필요"로 보여요. 버튼을 누르면 인벤토리의 키로 마지막으로 한 번 접속해 에이전트를 띄워요. 모두 바꾼 뒤 인벤토리에서 키를 빼고 서버의 authorized_keys에서도 지워요.
- **등록**: 설치 명령에 든 토큰은 15분 동안 한 번만 쓸 수 있고, Wharfline에는 해시만 남아요. 토큰은 명령줄이나 컨테이너 환경 변수에 남지 않게 에이전트 볼륨의 0600 파일로 넘기고, 등록하자마자 지워요.
- **실행 계정과 허용 경로는 서버에서 정해요**: 설치할 때 `WHARFLINE_ALLOWED_USERS`(예: `deploy,ubuntu`, root는 안 돼요)와 `WHARFLINE_ALLOWED_PATHS`(예: `/srv,/home/ubuntu/apps`)가 에이전트에 들어가요. 에이전트는 그 밖의 계정으로 실행하거나 그 밖의 경로에 파일을 쓰는 작업을 거부해요. 바꾸려면 서버 수정의 '설치 명령 다시 받기'로 서버에서 다시 실행해요. 홈 폴더 아래 허용 경로는 그 계정 소유로 만들어요.
- **작업의 실행 계정**: 배포 작업마다 고를 수 있어요(비우면 인벤토리 계정). 에이전트는 `nsenter`로 서버에 들어가 `runuser -u <계정>`으로 실행해서, SSH로 그 계정에 로그인한 것과 똑같이 동작해요.
- **비밀번호 없는 sudo**: `become: true` 플레이북에 필요해요. 서버 수정에서 허용 계정마다 켜고 끌 수 있어요(`/etc/sudoers.d/wharfline-<계정>`).
- **에이전트 업데이트**: 서버 수정의 '에이전트 업데이트'를 누르면 에이전트가 Wharfline의 에이전트 이미지(`WHARFLINE_AGENT_IMAGE`, 릴리스와 같은 태그)를 받아 자기 컨테이너를 바꿔요. 등록 정보는 볼륨에 남아서 다시 등록하지 않아요.
- **에이전트 접속 주소**: 기본은 `WHARFLINE_URL`. 서버에서 닿는 주소가 다르면(사내망 주소 등) 인벤토리의 '에이전트 설정'에서 바꿔요. 이미 설치된 에이전트는 설치할 때의 주소를 써요.
- **내부 주소**: 같은 사설망의 서버가 Wharfline이나 레지스트리의 공인 도메인으로 접속하지 못할 때(헤어핀 NAT 없음) '에이전트 설정'에 `10.0.1.6 deploy.example.com git.example.com`처럼 적어요. 설치·초기화·에이전트 전환 때 서버의 `/etc/hosts` 맨 위에 `# BEGIN wharfline` ~ `# END wharfline` 블록으로 들어가고(다시 실행하면 그 블록만 바뀌어요), 설치 명령의 curl은 `--resolve`로 사설 IP에 바로 접속해요. 서버마다 `/etc/hosts`를 손으로 고칠 필요가 없어요.

## 배포 실행

배포 작업을 실행하면 서버마다 에이전트에 작업을 보내고, 로그 창에 실제 출력이 그대로 흘러요. 에이전트가 연결돼 있지 않으면 20초(`WHARFLINE_AGENT_WAIT`) 기다린 뒤 그 서버는 연결 실패로 처리해요.

- **스크립트·Compose 작업**: 작업 파일과 `.env`(0600)를 서비스 경로에 실행 계정으로 쓰고, 레지스트리에 `docker login --password-stdin`을 한 뒤, 단계를 순서대로 `bash -s`(없으면 `sh`)로 실행해요. 각 단계는 `set -e`로 돌아서 명령 하나라도 실패하면 그 서버는 멈추고 나머지 단계는 건너뛰어요.
- **플레이북 작업**: 레포를 Wharfline에서 받아(`git clone --depth 1`) 변수와 함께 묶어 서버마다 보내요. 에이전트가 자기 서버에 `ansible-playbook`을 실행해요(서버 안에서만 쓰는 키로 `127.0.0.1`에 접속, 실행 계정으로). 그래서 플레이북은 고치지 않아도 그대로 돌아요.
  - 넘기는 변수: `app_name`, 이미지가 있으면 `image`·`image_tag`·`image_ref`(다이제스트 고정)·`image_digest`, 환경 변수가 있으면 `env_file`(서버 경로)·`env_src`(에이전트 쪽 임시 .env, `copy`의 `src`로 써요), 비공개 레지스트리면 `registry_host`·`registry_user`·`registry_password`, 추가 이미지마다 `<var>_image`·`<var>_tag`·`<var>_image_ref`.
  - **가져온 파일**: 플레이북이 `fetch` 등으로 컨트롤러에 가져온 파일은 Wharfline 키로 봉인해 돌려보내고, 실행 기록의 '가져온 파일'에서 받을 수 있어요(Owner/Admin, 비밀번호 재확인).
  - **안 되는 것**: 에이전트는 자기 서버만 알아요. 다른 서버로 넘기는 작업(`delegate_to: 다른서버`), 다른 서버의 `hostvars`를 읽는 플레이북은 서버마다 따로 도는 형태로 바꿔야 해요. Docker를 처음 설치하는 플레이북은 에이전트 전에 한 번 직접 실행해요.
  - 기본 플레이북 `container.yml`은 `backend/playbooks/builtin`에 있어요. Ansible 컬렉션(`ansible.posix`, `community.general`, `community.docker`)은 에이전트 이미지에 들어 있어요(`agent/ansible-collections.yml`).
- **이미지는 다이제스트로 고정해요**: 실행을 시작할 때 레지스트리에 태그의 다이제스트를 직접 물어보고 `이미지:태그@sha256:…`로 배포해요(`IMAGE_REF`, `<VAR>_TAG` 등이 그 값이 돼요. 버전만 필요하면 `IMAGE_VERSION`, `<VAR>_VERSION`). 같은 태그가 다른 이미지로 다시 푸시되면 로그에 경고하고, 자동 배포는 멈춰요. 레지스트리에 물어볼 수 없으면 태그로 배포하고 경고해요.
- **.env 형식**: 스크립트 작업과 직접 만든 플레이북의 .env는 docker compose 규칙으로 써요. 특수문자가 있는 값은 작은따옴표로 감싸서 `pa$word` 같은 값의 `$`가 변수로 풀리지 않아요. 기본 플레이북은 `docker run --env-file`이 읽어서 값을 그대로 쓰고, 줄바꿈이 있는 값은 실패로 알려요.
- **비밀 값**: 토큰, .env 값, 비밀 변수는 실행을 시작할 때만 풀고, 그 서버의 에이전트 키로 봉인한 작업 안에서만 오가요(HTTPS가 아닌 사내망에서도 읽을 수 없어요). 로그에서는 `••••••••`로 가려요.
- **동시 실행**: 같은 서버에 배포 중인 실행이 있으면 그 서버는 실패로 처리해요. 실행을 취소하면 에이전트가 하던 명령을 멈춰요.
- 실제 서버 없이 데모로 돌리려면 backend에 `WHARFLINE_RUN_SIMULATE=1`을 주세요(테스트는 `WHARFLINE_SSH_SIMULATE=1`).

## 보안 운영

- **에이전트와 Wharfline은 서로를 확인해요** (`backend/app/agentproto.py`): 에이전트의 모든 요청은 에이전트 키(Ed25519)로 서명하고, 시각(±2분)과 일회용 nonce로 재전송을 막아요. Wharfline은 공개 키만 저장해요. Wharfline이 보내는 작업은 에이전트 키(X25519)로 봉인하고 Wharfline 키로 서명해요. 에이전트는 등록할 때 받은 Wharfline 공개 키로 확인해요.
- **서버 쪽 경계**: 에이전트는 허용 계정·허용 경로 밖의 작업을 거부해요. 다만 에이전트는 Docker 소켓을 쓰므로 그 서버에서 root와 같은 권한이에요. Wharfline 자체를 인터넷에 열지 말고 VPN 안에 두고, 모든 멤버에게 2단계 인증을 켜요.
- **자동 배포는 레지스트리를 확인해요**: 웹훅은 "새 태그가 있을 수 있다"는 신호로만 써요. 자동 배포 전에 레지스트리에 그 태그가 정말 있는지 묻고, 없으면 배포하지 않아요. 그래도 production은 운영 보호(승인)를 켜 두고, `v`로 시작하는 태그를 누가 푸시할 수 있는지 레지스트리·Git 호스트 권한으로 좁혀요.
- **마스터 키와 DB 백업은 따로**: DB 덤프와 마스터 키가 같이 새면 모든 비밀 값이 풀려요. `make key-backup`으로 만든 키 백업은 DB 백업과 다른 곳(비밀번호 관리자, 오프라인 저장소)에 둬요.

### 털렸을 때 순서

1. **의심되는 서버를 인벤토리에서 지우거나 설치 명령을 다시 받아 재등록**해요. 옛 에이전트 키는 그 순간 쓸모없어져요.
2. **`make key-rotate`**로 마스터 키를 바꿔요. 옛 키 줄은 `make key-status`로 확인한 뒤 지워요.
3. **웹훅 비밀값과 토큰을 다시 발급**해요. Git 연동 비밀값, 레지스트리 토큰, Git 액세스 토큰은 발급한 곳에서 먼저 취소하고 새로 넣어요.
4. **활동 기록을 확인**해요. 모르는 로그인, 서버·에이전트 변경, sudo 부여, 승인 없는 배포가 있었는지 봐요.

## 운영 서버

운영 서버에서는 `deploy/` 폴더의 구성으로 릴리스 이미지를 받아 실행해요. 샘플 데이터 없이 Owner 한 명만 만들어져요. 순서는 [deploy/README.md](deploy/README.md)에 있어요.

- **Wharfline 자체는 `make upgrade`로 올려요.** docker rollout(무중단 배포)은 쓰지 마세요. 실행 상태와 에이전트 작업 큐가 backend 프로세스 메모리에 있어서 backend는 한 개만 떠야 해요. 재시작하는 몇 초 동안 에이전트는 끊겼다가 스스로 다시 붙어요.
- frontend의 nginx는 backend 주소를 10초마다 다시 찾아서, backend 컨테이너가 바뀌어도 frontend를 재시작할 필요가 없어요.

## 릴리스 (GitHub Actions)

`main`에 푸시하면 `.github/workflows/release.yml`이 돌아요.

1. 오늘 날짜(한국 시간)와 그날의 빌드 번호로 태그를 정해요. 예: `v2026.11.08-1`, 같은 날 두 번째는 `v2026.11.08-2`. `v`로 시작해서 Wharfline의 기본 자동 배포 규칙에 맞아요.
2. 백엔드·프론트엔드(amd64)와 에이전트(amd64·arm64) 이미지를 빌드해 GitHub Container Registry에 올려요.
   - `ghcr.io/moning02004/wharfline-backend:<태그>` (와 `latest`)
   - `ghcr.io/moning02004/wharfline-frontend:<태그>` (와 `latest`)
   - `ghcr.io/moning02004/wharfline-agent:<태그>` (와 `latest`) · 서버가 로그인 없이 받도록 패키지를 공개로 두세요
3. 이미지가 다 올라간 뒤 태그와 GitHub 릴리스를 만들어요. 릴리스 노트에는 이미지 주소와 바뀐 커밋 목록이 들어가요.

동시에 두 번 푸시해도 한 번에 하나씩 돌아서 번호가 겹치지 않아요. Actions 화면의 "Run workflow"로 직접 돌릴 수도 있어요.

처음 한 번 확인할 것: 저장소 **Settings → Actions → General → Workflow permissions**가 "Read and write permissions"인지. 패키지는 처음엔 비공개로 만들어져요. 서버에서 로그인 없이 받으려면 GitHub의 패키지 설정에서 공개로 바꾸세요.

## 로컬 개발

```bash
make db-up                                    # Postgres만 (localhost:55432), 키 파일도 만들어요

cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
export WHARFLINE_MASTER_KEYS_FILE=../secrets/master_keys
python -m app.prestart                        # 마이그레이션 + 예시 데이터
python -m pytest                              # 또는 make test
uvicorn app.main:app --reload --port 8000     # 기본 DATABASE_URL이 localhost:55432를 가리켜요
alembic revision --autogenerate -m "..."      # 로컬에서 바로 마이그레이션 만들기도 돼요

cd frontend && npm install && npm run dev     # http://localhost:5173 (/api는 :8000으로 프록시)
```

에이전트까지 로컬에서 돌려 보려면 `make agent`로 `wharfline-agent:dev` 이미지를 만들고, 인벤토리의 '에이전트 설정'에서 서버(또는 테스트 컨테이너)가 닿는 주소(예: `http://host.docker.internal:8080`)를 넣은 뒤 '설치 명령으로 추가'를 써요.

## DB 구조

| 테이블 | 내용 |
| --- | --- |
| `keys` | SSH 키, 액세스 토큰 (지문과 메타데이터만) |
| `inventories`, `hosts` | 서버 묶음과 서버 |
| `repos` | 플레이북 레포 |
| `registries`, `images`, `image_tags` | 레지스트리와 이미지 태그 |
| `env_sets`, `env_versions` | 환경 변수와 버전 기록. 값은 `ciphertext`(암호문), `wrapped_dek`, `nonce`, `kek_id`로 저장 |
| `jobs`, `runs` | 배포 작업, 실행 기록 (끝난 실행의 로그 포함). 실행 번호는 `run_no_seq` 시퀀스 |
| `builds` | Gitea Actions 빌드 기록 (레포, 실행 번호, 상태, 현재 단계, 푸시한 태그) |
| `activity`, `logins` | 활동 기록, 로그인 이력 |
| `members`, `groups`, `member_groups` | 멤버(비밀번호 해시, 암호화된 TOTP 비밀값, 복구 코드 해시), 그룹 |
| `sessions` | 로그인 세션 (브라우저마다 하나, 토큰의 SHA-256으로 찾아요) |
| `settings` | 보안 정책 등 |
| `alembic_version` | 적용된 마이그레이션 리비전 |

## 프로토타입 한계

- 레지스트리 조회(태그·digest)와 인벤토리의 "응답 확인"(ping)은 아직 흉내예요. 배포는 태그로 받고, 받은 digest를 고정하지는 않아요.
- 플레이북은 backend와 같은 사용자로 돌아요. 플레이북 레포에 쓸 수 있는 사람은 backend 컨테이너 안의 파일(마스터 키 포함)을 읽는 플레이북을 넣을 수 있으니, 플레이북 레포의 쓰기 권한은 Admin만큼 좁게 주세요.
- Git 서버의 호스트 키는 실행마다 처음 본 키를 믿어요(`StrictHostKeyChecking=accept-new`).
- Python에서는 복호화한 값을 메모리에서 확실히 지울 수 없어요. 서버 프로세스 메모리에 접근할 수 있으면 복호화된 값을 볼 수 있어요.
- 패스키(WebAuthn)와 "이 기기 기억"은 아직 없어요. 2단계 인증 설정 화면은 QR 대신 설정 키와 `otpauth://` 링크를 보여 줘요.
- 실행 중이던 배포는 backend가 재시작되면 멈추고 "실패"로 표시돼요. 실행 상태는 backend 프로세스 메모리에 있어서 backend는 한 개만 띄워야 해요.

## .env 업로드 (Gitea 로그인으로)

프로젝트 폴더에서 `.env`를 올리면 환경 변수 세트 `<저장소 이름>-env`(예: `ergo-ifdo-env`)에 새 버전으로 저장돼요. Wharfline 계정이나 API 토큰은 필요 없어요.

```
POST /api/hooks/env
Authorization: <Gitea API 에 쓰는 것과 같은 값: Basic (git 에 저장된 로그인) 또는 token ...>
{"repo": "ermore-org/ergo-ifdo", "env": "<.env 파일 내용>"}
```

- Wharfline이 그 Authorization을 `WHARFLINE_GITEA_URL`(요청에서 받지 않아요)의 Gitea에 그대로 넘겨 로그인과 그 저장소의 push 권한을 확인해요. push 할 수 있어야 받아요. 이 값은 저장하거나 기록하지 않아요.
- 처음이면 v1로 만들고, 바뀐 게 있으면 새 버전(이전 버전은 기록에 남아 되돌릴 수 있어요), 같으면 그대로 둬요. 같은 키가 두 번 있으면 뒤의 값을 써요.
- 활동 기록에는 `<Gitea 계정> (Gitea)`와 바뀐 변수 이름만 남아요. 응답도 이름만 돌려줘요.
- `WHARFLINE_GITEA_URL`이 비어 있으면 503으로 받지 않아요. 보통 Gitea 주소 그대로(`https://git.example.com`) 넣어요. backend 컨테이너 안에서 닿아야 해요(ansible-deploy 03 은 자동으로 넣고, Traefik 이 그 도메인을 서버 안에서도 받아요). 같은 compose 네트워크에 있는 Gitea면 `http://gitea:3000`도 돼요.
