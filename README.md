# Wharfline

셀프호스팅 배포 콘솔 프로토타입. React + Tailwind 프론트엔드, FastAPI 백엔드, PostgreSQL(Alembic 마이그레이션)로 구성돼요. 환경 변수, SSH 비공개 키, 액세스·레지스트리 토큰은 봉투 암호화(AES-256-GCM)로 저장하고, 마스터 키는 DB 밖의 로컬 키 파일(Docker secret)에 둬요.

배포 작업은 **배포 작업 → 새 배포 작업** 모달에서 단계별(기본 정보 → 대상 → 방식 → .env → 안전장치 → 확인)로 만들어요. 제목 옆 ⓘ를 누르면 그 단계에서 무엇을 어디서 발급받는지 매뉴얼이 보여요.

```
backend/
  app/                FastAPI + SQLAlchemy, 실행 로그는 SSE로 스트리밍
    crypto.py         봉투 암호화 (마스터 키 파일)
    keys.py           마스터 키 상태 확인, 검증, 교체
    sshkeys.py        SSH 키 생성·가져오기, 지문
  migrations/         Alembic 마이그레이션
  tests/              pytest (암호화, SSH 키, 권한·배포·웹훅 흐름)
  alembic.ini
frontend/             Vite + React + TypeScript + Tailwind v4, nginx로 서빙
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
| `members`, `device_sessions`, `menu_access` | 멤버, 로그인된 기기, 역할별 메뉴 |
| `settings` | 보안 정책, 데모 사용자 세션 상태 |
| `alembic_version` | 적용된 마이그레이션 리비전 |

## 프로토타입 한계

- 실제 SSH 접속, 레지스트리 조회(태그·digest), 호스트 키 지문 받기는 아직 흉내예요. 키와 토큰은 진짜로 만들어지고 암호화 저장돼서, 실행기를 붙이면 그대로 쓸 수 있어요.
- Python에서는 복호화한 값을 메모리에서 확실히 지울 수 없어요. 서버 프로세스 메모리에 접근할 수 있으면 복호화된 값을 볼 수 있어요.
- 로그인, 비밀번호 재확인, TOTP는 아무 값이나 통과하고, 사용자는 한 명(데모)이에요.
- 실제 SSH 접속이나 배포는 하지 않고 로그를 흉내 내요. 실행 중이던 배포는 backend가 재시작되면 "실패"로 표시돼요.
