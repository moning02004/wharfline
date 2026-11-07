# 배포 입력 단순화 (설계)

목표: 배포 작업 하나를 만들 때 **한 화면에서** 아래만 정하면 되게 한다. 따로 미리 등록해야 하는 것을 없앤다.

| 정할 것 | 필수 | 예 |
|---|---|---|
| 이름 | 예 | `api-server · production` |
| 플레이북 | 예 | Git 주소 + 브랜치 + 플레이북 경로, 또는 기본 플레이북 |
| 배포 대상 | 예 | 인벤토리 + 그룹 (기존 그대로) |
| 이미지 | 아니요 | `postgres:15`, `ghcr.io/acme/api:v1.2` (기본 플레이북이면 필수) |
| 환경 변수 | 아니요 | `.env` 붙여넣기 또는 저장된 세트 (기존 EnvSource 그대로) |
| 고급 | 아니요 | 자동 배포, 운영 보호, 동시 실행 잠금, 실패 시 되돌리기. 접어 두고 기본값 |

바뀌는 것:

- 배포 방식 "Docker Compose"는 없어진다. 모든 작업은 플레이북을 실행한다. 플레이북이 없는 사람을 위해 **기본 플레이북**(`wharfline-builtin` / `container.yml`)이 있다: 이미지 하나를 `.env`와 함께 컨테이너로 띄운다.
- 플레이북 레포는 미리 연결하지 않는다. 작업을 만들 때 Git 주소를 넣으면 같은 주소+브랜치의 레포를 재사용하고 없으면 만든다. 레포의 가짜 플레이북 목록(`books`)은 없앤다. 플레이북 경로는 작업마다 직접 적는다(Semaphore의 Template과 같음).
- 이미지는 미리 등록하지 않는다. 작업에 `이름:버전`을 적으면 이미지 행이 없을 때 자동으로 만든다(레지스트리는 호스트로 자동 매칭, 없으면 공개 이미지). 이미지 추가 모달은 `이미지:버전` 한 칸이다. 빌드 레포는 모달에서 빠진다(이미지 표의 "+ 연결"로만, 선택).
- 실행할 때 버전은 아는 태그 중에서 고르거나 직접 적는다. 직접 적은 태그는 이미지에 기록된다.

플레이북이 받는 변수(extra vars), 화면 힌트와 실행 로그에 그대로 보여 준다:

| 변수 | 값 |
|---|---|
| `image` | `docker.io/library/postgres` (이미지 없으면 빠짐) |
| `image_tag` | `15` (digest 고정 전 태그) |
| `image_ref` | `docker.io/library/postgres:15` |
| `env_file` | 대상 서버의 `.env` 경로 `/srv/wharfline/<app_name>/.env` (환경 변수 없으면 빠짐) |
| `app_name` | 작업 이름 slug, 예: `api-server-production` |

## 이미지 이름 해석 `parse_image(text) -> (ref, tag)`

- 앞뒤 공백 제거, `https://` 제거. `@sha256:...`가 있으면 400.
- 마지막 `/` 뒤에 `:`가 있으면 그 뒤가 태그, 없으면 `latest`.
- ref는 소문자. 첫 경로 조각에 `.`이나 `:`가 없고 `localhost`도 아니면 Docker Hub: 앞에 `docker.io/`를 붙이고, 조각이 하나뿐이면 `docker.io/library/<name>`.
  - `postgres:15` → (`docker.io/library/postgres`, `15`)
  - `bitnami/redis` → (`docker.io/bitnami/redis`, `latest`)
  - `ghcr.io/acme/api:v1.2` → (`ghcr.io/acme/api`, `v1.2`)
  - `localhost:5000/app:dev` → (`localhost:5000/app`, `dev`)
- ref는 `IMAGE_RE`, 태그는 `TAG_RE`로 검사 (기존 정규식).
- `latest`는 태그로 저장하지 않는다(기존 규칙).

## API 계약

### `POST /api/jobs`

```json
{
  "name": "api-server · production",
  "playbook": { "source": "git", "url": "git@git.acme.kr:ops/ansible.git", "branch": "main", "path": "deploy/app.yml", "key": "staging-deploy" },
  "inventory": "production",
  "targets": ["web"],
  "image": "ghcr.io/acme/api-server:v1.8.2",
  "envMode": "paste", "envName": null, "envVars": [["NODE_ENV", "production"]],
  "hook": false, "protected": true, "lock": true, "rollback": true
}
```

- `playbook.source`: `"git"` 또는 `"builtin"`. builtin이면 `url/branch/path/key`는 무시하고 path=`container.yml`, 이미지 필수("기본 플레이북은 띄울 이미지가 있어야 해요.").
- git: url 검사와 키 검사는 기존 `POST /repos` 규칙과 같다(SSH 주소는 SSH 키 필수, HTTPS는 토큰 키 선택). 같은 `url`+`branch` 레포가 있으면 재사용(그때 `key`는 무시). 이름은 주소의 `owner/name`, 같은 이름이 다른 주소로 있으면 `-2`, `-3`… 를 붙인다.
- `path`: `^(?!/)(?!.*\.\.)[A-Za-z0-9_./-]+\.ya?ml$`. 틀리면 400 "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml".
- `image`: 빈 문자열이면 이미지 없음. 있으면 `parse_image`, 이미지 행 자동 생성, 태그가 latest가 아니면 태그 기록. 작업의 `image`=ref, `defaultTag`=tag.
- 나머지(이름 중복, 인벤토리/그룹 검사, env 처리, 안전장치)는 기존과 같다.
- 응답: 아래 Job 모양.

### Job (GET `/api/jobs`, POST 응답, dashboard 안)

```ts
interface Job {
  id: string; name: string;
  image: string | null;        // 태그 없는 ref, 이미지 없는 작업은 null
  tagNow: string; defaultTag: string;
  playbook: { repo: string; kind: "git" | "local" | "builtin"; url: string; branch: string; path: string };
  inventory: string; targets: string[]; env: string;
  hook: boolean; protected: boolean; lock: boolean; rollback: boolean;
  last: { status: Status; time: string; duration: string };
  // job_view가 더하는 것 (기존과 같음, 이미지 없으면 imageTags=[] latestTag=null prevTag=null build=null)
  inventoryHostCount, targetLabel, targetHosts, groups, imageTags, latestTag, prevTag, build
}
```

`method`, `repo`, `book`, `dir`, `compose`는 Job에서 없어진다.

### `POST /api/jobs/{id}/runs`

`{ "tag": "v1.8.3", "groups": [...], "rollback": false }`. `tag`는 `latest` 또는 `TAG_RE`에 맞는 아무 태그. 이미지에 없는 태그면 `ImageTag(pushed="직접 입력")`으로 기록한다. 이미지 없는 작업은 tag를 무시한다.

### `GET /api/repos`

```ts
interface Repo { name: string; kind: "git" | "local" | "builtin"; url: string; branch: string; auth: string; commit: string;
                 usedBy: { job: string; path: string }[] }
```

`books`는 없어진다. `wharfline-builtin`(kind builtin, url `/var/lib/wharfline/playbooks/builtin`, branch/auth/commit `-`)은 항상 있다. `POST /api/repos`는 없앤다(레포는 작업을 만들 때 생긴다).

### `POST /api/images`

`{ "image": "postgres:15" }` → `parse_image`, 레지스트리는 호스트로 자동 매칭. 응답은 기존처럼 `{...image, created, addedTags}`. `ref/tags/sourceRepo/registry` 필드는 없어진다.

## 데이터

- jobs: `method`, `dir`, `compose` 컬럼 삭제. `image` nullable. `repo`, `book` NOT NULL. 마이그레이션에서 compose 작업은 repo=`wharfline-builtin`, book=`container.yml`로 바꾼다.
- repos: `books` 컬럼 삭제, kind에 `builtin` 추가, `wharfline-builtin` 행 삽입(없을 때).
- seed도 같은 모양으로 맞춘다.

## 실행 로그 (runner)

플레이북 한 가지 흐름:

```
$ git clone --depth 1 --branch main git@git.acme.kr:ops/ansible.git   (git 레포일 때, 키 이름 표시)
$ ansible-playbook deploy/app.yml -i <임시 인벤토리> --limit web \
    -e image=ghcr.io/acme/api-server -e image_tag=v1.8.2 -e image_ref=... -e env_file=/srv/wharfline/api-server-production/.env -e app_name=api-server-production
```

기본 플레이북이면 clone 대신 "Wharfline 기본 플레이북 container.yml: 이미지를 .env와 함께 컨테이너로 띄워요".
