# GitLab에서 Docker 이미지 빌드 확인하기

이 문서는 순서대로 따라 하면 되도록 썼습니다. 파이프라인 정의는 레포 루트의 `.gitlab-ci.yml`에 있습니다.

## 결과적으로 이렇게 동작합니다

| 이벤트 | 실행되는 Job | 하는 일 |
|---|---|---|
| MR 생성/업데이트 | `build-check` | 이미지 빌드만 (푸시 X) |
| main 이외 브랜치 push (MR 없음) | `build-check` | 이미지 빌드만 (푸시 X) |
| main 브랜치 push | `build-push` | 빌드 + `:<커밋SHA>`, `:latest` 푸시 |
| Git 태그 push (예: `v1.2.0`) | `build-push` | 빌드 + `:v1.2.0` 푸시 |

이미지는 GitLab 프로젝트에 붙어 있는 Container Registry(`$CI_REGISTRY_IMAGE`)에 올라갑니다.

---

## 0단계. 준비물 확인

- [ ] 레포 루트에 `Dockerfile`이 있음 (다른 위치라면 `.gitlab-ci.yml`의 `DOCKERFILE`, `BUILD_CONTEXT` 값을 수정)
- [ ] GitLab 계정 (gitlab.com 또는 사내 GitLab)
- [ ] 로컬에서 `docker build .`가 성공하는지 먼저 확인. 로컬에서 실패하면 CI에서도 실패합니다.

> gitlab.com 신규 계정은 공유 러너를 쓰려면 본인 인증(전화번호 또는 카드)이 필요할 수 있습니다. 무료 플랜은 월 CI 사용 시간 제한이 있습니다.

---

## 1단계. GitLab 프로젝트 만들기

1. GitLab에서 **New project → Create blank project** 선택
2. 프로젝트 이름 입력, **Initialize repository with a README** 는 체크 해제 (기존 레포를 올릴 것이므로)
3. **Create project** 클릭 후 프로젝트 URL 확인 (예: `https://gitlab.com/<그룹>/wharfline.git`)

---

## 2단계. git으로 GitLab 연동하기

로컬 git 레포에 GitLab을 remote로 등록해서 push 합니다.

### 2-1. GitLab 인증 준비

HTTPS와 SSH 중 하나를 고르세요.

**HTTPS (토큰 사용)**
1. GitLab 우측 상단 프로필 → **Edit profile → Access tokens → Add new token**
2. Scope: `write_repository` (레지스트리 이미지를 로컬에서 받을 거면 `read_registry`도 체크)
3. 생성된 토큰 복사 (다시 볼 수 없음). push 할 때 비밀번호 대신 이 토큰을 입력합니다.

**SSH (키 사용)**
1. 키가 없다면 생성
   ```bash
   ssh-keygen -t ed25519 -C "<이메일>"
   cat ~/.ssh/id_ed25519.pub
   ```
2. GitLab 프로필 → **Edit profile → SSH Keys → Add new key** 에 위 공개키 붙여넣기
3. 연결 확인
   ```bash
   ssh -T git@gitlab.com      # "Welcome to GitLab, @사용자명!" 이 나오면 성공
   ```

### 2-2. remote 등록

현재 remote 확인:

```bash
git remote -v
```

**경우 1. GitLab만 쓸 때 (remote가 없거나 origin을 GitLab으로 바꿀 때)**

```bash
# remote가 없으면
git remote add origin https://gitlab.com/<그룹>/wharfline.git
# 이미 origin이 있고 GitLab으로 바꾸려면
git remote set-url origin https://gitlab.com/<그룹>/wharfline.git
```

**경우 2. 기존 원격 저장소는 그대로 두고 GitLab을 추가할 때**

```bash
git remote add gitlab https://gitlab.com/<그룹>/wharfline.git
```

SSH를 쓴다면 URL을 `git@gitlab.com:<그룹>/wharfline.git` 형식으로 바꾸면 됩니다.

### 2-3. 첫 push

```bash
git push -u origin main     # 경우 1
git push -u gitlab main     # 경우 2
git push gitlab --tags      # 태그도 올리려면 (경우 1이면 origin)
```

GitLab 프로젝트 화면을 새로고침해서 파일이 보이면 연동 완료입니다.

### 2-4. (선택) 한 번의 push로 기존 원격 + GitLab 동시에 올리기

경우 2에서 매번 두 번 push 하기 번거롭다면 `origin`에 push 주소를 하나 더 붙입니다.

```bash
# 기존 주소를 push 대상으로 다시 등록 (이걸 빼먹으면 기존 원격에 push가 안 됨)
git remote set-url --add --push origin $(git remote get-url origin)
# GitLab 주소를 push 대상으로 추가
git remote set-url --add --push origin https://gitlab.com/<그룹>/wharfline.git

git remote -v   # origin (push) 줄이 두 개 보이면 성공
```

이후에는 `git push origin main` 한 번으로 두 곳 모두에 올라가고, GitLab 파이프라인도 같이 실행됩니다.

> MR 파이프라인(`build-check`의 MR 실행)은 GitLab 화면에서 Merge Request를 열어야 동작합니다. 브랜치를 push만 해도 `build-check`는 실행됩니다.

---

## 3단계. Container Registry 켜져 있는지 확인

1. 프로젝트 **Settings → General → Visibility, project features, permissions** 펼치기
2. **Container registry** 가 켜져 있는지 확인 (기본값은 켜짐)
3. **Save changes**

사내 GitLab인데 메뉴에 Container registry가 아예 없다면, GitLab 관리자가 레지스트리 기능을 켜지 않은 것이므로 관리자에게 요청해야 합니다.

---

## 4단계. 러너 확인

이미지 빌드는 Docker-in-Docker를 쓰기 때문에 **privileged 모드**를 지원하는 러너가 필요합니다.

### gitlab.com을 쓰는 경우

1. **Settings → CI/CD → Runners** 펼치기
2. **Instance runners(공유 러너)** 가 켜져 있으면 끝. 별도 설정이 필요 없습니다.

### 사내 GitLab / 직접 러너를 띄우는 경우

1. **Settings → CI/CD → Runners → New project runner**
   - Tags는 비워두고 **Run untagged jobs** 체크
   - **Create runner** 후 나오는 토큰(`glrt-...`) 복사
2. 러너를 돌릴 서버(Docker 설치된 Linux)에서 등록

   ```bash
   # gitlab-runner 설치는 공식 문서 참고: https://docs.gitlab.com/runner/install/
   sudo gitlab-runner register \
     --url https://gitlab.example.com \
     --token glrt-xxxxxxxxxxxx \
     --executor docker \
     --docker-image docker:27
   ```

3. `/etc/gitlab-runner/config.toml` 을 열어 해당 러너 항목을 아래처럼 수정

   ```toml
   [[runners]]
     ...
     [runners.docker]
       image = "docker:27"
       privileged = true                 # ← 반드시 true
       volumes = ["/certs/client", "/cache"]
   ```

4. 러너 재시작 후 GitLab 화면에서 러너가 초록색(online)인지 확인

   ```bash
   sudo gitlab-runner restart
   ```

---

## 5단계. `.gitlab-ci.yml` 올리기

이 레포에는 이미 `.gitlab-ci.yml`이 있으므로 커밋해서 GitLab에 push만 하면 됩니다.

```bash
git add .gitlab-ci.yml
git commit -m "ci: add GitLab image build pipeline"
git push origin main        # 2단계 경우 2라면: git push gitlab main
```

수정했다면 GitLab의 **Build → Pipeline editor** 에서 문법 검사(Validate)를 먼저 해볼 수 있습니다.

---

## 6단계. 파이프라인 결과 확인

1. 프로젝트 **Build → Pipelines** 이동
2. 방금 push 한 커밋의 파이프라인 클릭
3. main 브랜치라면 `build-push`, 다른 브랜치라면 `build-check` Job이 보입니다
4. Job을 클릭하면 실시간 로그가 나오고, 성공하면 초록색 ✅ 로 바뀝니다

MR에서는 MR 화면 상단에 파이프라인 상태가 표시됩니다. **Settings → Merge requests → Pipelines must succeed** 를 켜면 빌드가 실패한 MR은 머지할 수 없게 막을 수 있습니다.

---

## 7단계. 올라간 이미지 확인

1. 프로젝트 **Deploy → Container Registry** 이동
2. 이미지와 태그(`latest`, 커밋 SHA, 버전 태그)가 보이면 성공
3. 로컬에서 직접 받아보기

   ```bash
   docker login registry.gitlab.com          # 사내 GitLab이면 해당 레지스트리 주소
   # 비밀번호 자리에는 read_registry 권한의 Personal Access Token 입력
   docker pull registry.gitlab.com/<그룹>/wharfline:latest
   ```

---

## 자주 겪는 문제

| 증상 | 원인 / 해결 |
|---|---|
| 파이프라인이 `pending` 에서 멈춤 | 사용 가능한 러너가 없음 → 4단계 확인 (공유 러너 켜기, 또는 러너 online 여부) |
| `Cannot connect to the Docker daemon at tcp://docker:2376` | 러너가 privileged가 아님 → `config.toml`에 `privileged = true` 후 재시작 |
| `unable to prepare context: unable to evaluate symlinks in Dockerfile path` | Dockerfile 위치가 다름 → `.gitlab-ci.yml`의 `DOCKERFILE` / `BUILD_CONTEXT` 수정 |
| `denied: access forbidden` (push 단계) | Container Registry가 꺼져 있음 → 3단계 확인 |
| Docker Hub `toomanyrequests` 오류 | Docker Hub pull 제한 → GitLab Dependency Proxy 사용 또는 Dockerfile의 베이스 이미지 레지스트리 변경 |
| 브랜치 push와 MR에서 파이프라인이 두 번 돔 | `.gitlab-ci.yml` 맨 위 `workflow:` 블록이 지워지지 않았는지 확인 |

---

## 참고: Gitea / GitHub와 비교

| | Gitea Actions | GitHub Actions | GitLab CI |
|---|---|---|---|
| 설정 파일 | `.gitea/workflows/*.yml` | `.github/workflows/*.yml` | `.gitlab-ci.yml` (단일 파일) |
| 문법 | GitHub Actions 호환 | GitHub Actions | GitLab 전용 문법 (호환 안 됨) |
| 러너 | `act_runner` 직접 운영 | 호스팅 러너 제공 | gitlab.com은 공유 러너 제공, 사내는 `gitlab-runner` 운영 |
| 기본 레지스트리 | Gitea Packages | GHCR (`ghcr.io`) | GitLab Container Registry |

GitLab CI는 Gitea/GitHub 워크플로 파일을 재사용할 수 없으므로 `.gitlab-ci.yml`을 따로 관리해야 합니다.
