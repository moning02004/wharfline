# Wharfline

셀프호스팅 배포 콘솔 프로토타입. React + Tailwind 프론트엔드, FastAPI 백엔드, PostgreSQL(Alembic 마이그레이션)로 구성돼요.

```
backend/
  app/                FastAPI + SQLAlchemy, 실행 로그는 SSE로 스트리밍
  migrations/         Alembic 마이그레이션
  alembic.ini
frontend/             Vite + React + TypeScript + Tailwind v4, nginx로 서빙
docker-compose.yml       db + backend + frontend
docker-compose.dev.yml   로컬 개발용: DB 포트를 localhost:55432에 열어요
Makefile                 자주 쓰는 명령 (`make`로 목록 보기)
```

## Docker로 실행

```bash
cp .env.example .env     # 비밀번호와 포트를 바꾸려면
make up                  # = docker compose up -d --build
# http://localhost:8080
```

- nginx가 `/api/*` 요청을 backend로 넘겨요. backend와 DB 포트는 외부에 열지 않아요.
- backend 컨테이너는 시작할 때 `python -m app.prestart`를 먼저 실행해요: DB 대기 → `alembic upgrade head` → DB가 비어 있으면 예시 데이터 입력. 그다음 API를 띄워요.
- API는 DB가 최신 마이그레이션이 아니면 시작하지 않아요. 스키마는 API가 아니라 마이그레이션으로만 바뀌어요.
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

## 로컬 개발

```bash
make db-up                                    # Postgres만 (localhost:55432)

cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m app.prestart                        # 마이그레이션 + 예시 데이터
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
| `env_sets`, `env_versions` | 환경 변수와 버전 기록 |
| `jobs`, `runs` | 배포 작업, 실행 기록 (끝난 실행의 로그 포함). 실행 번호는 `run_no_seq` 시퀀스 |
| `activity`, `logins` | 활동 기록, 로그인 이력 |
| `members`, `device_sessions`, `menu_access` | 멤버, 로그인된 기기, 역할별 메뉴 |
| `settings` | 보안 정책, 데모 사용자 세션 상태 |
| `alembic_version` | 적용된 마이그레이션 리비전 |

## 프로토타입 한계

- 환경 변수 값은 아직 평문으로 저장돼요. 운영 전에 AES-256-GCM 암호화가 필요해요.
- 로그인, 비밀번호 재확인, TOTP는 아무 값이나 통과하고, 사용자는 한 명(데모)이에요.
- 실제 SSH 접속이나 배포는 하지 않고 로그를 흉내 내요. 실행 중이던 배포는 backend가 재시작되면 "실패"로 표시돼요.
- backend를 여러 개 띄우면 각자 마이그레이션을 시도해요. 그때는 마이그레이션을 별도 단계(일회용 컨테이너나 배포 파이프라인)로 빼세요.
