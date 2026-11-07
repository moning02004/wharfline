# 운영 서버에 Wharfline 띄우기

GitHub 릴리스로 만들어진 이미지(`ghcr.io/moning02004/wharfline-*`)를 받아서 실행해요. 서버에서 빌드하지 않고, 샘플 데이터도 넣지 않아요. 처음 띄우면 `.env`에 적은 Owner 한 명만 만들어져요.

필요한 것: Docker Engine과 Compose 플러그인(`docker compose version`), 이 폴더의 파일(`docker-compose.yml`, `.env.example`, `Makefile`, 그리고 서버 한 대로 HTTPS까지 할 때만 `Caddyfile`). 저장소 맨 위의 Makefile은 개발용이라 서버에서는 쓰지 않아요.

## 1. 폴더 만들기

```bash
sudo mkdir -p /opt/wharfline && sudo chown "$USER" /opt/wharfline && cd /opt/wharfline
# 이 폴더의 docker-compose.yml, .env.example, Makefile (필요하면 Caddyfile)을 여기로 복사해요
cp .env.example .env && chmod 600 .env
```

## 2. 이미지를 받을 수 있게 하기

GHCR 패키지는 처음에 비공개예요. 둘 중 하나를 고르세요.

- GitHub에서 패키지(`wharfline-backend`, `wharfline-frontend`)를 공개로 바꾸기, 또는
- 서버에서 로그인: `read:packages` 권한만 준 토큰으로
  `echo <토큰> | docker login ghcr.io -u moning02004 --password-stdin`

## 3. 마스터 키 만들기

비밀 값(SSH 키, 토큰, 환경 변수)을 암호화하는 키예요. **잃어버리면 저장된 비밀 값을 영영 못 읽어요.**

`.env`에 `WHARFLINE_VERSION`을 먼저 적고:

```bash
make keygen       # secrets/master_keys를 만들어요 (이미 있으면 덮어쓰지 않아요)
make key-backup   # 암호를 걸어 backups/에 복사본을 만들어요. 이 파일은 DB 백업과 다른 곳에 옮겨 두세요
```

## 4. `.env` 채우기

| 값 | 설명 |
|---|---|
| `WHARFLINE_VERSION` | 실행할 릴리스 태그. [릴리스 목록](https://github.com/moning02004/wharfline/releases)에서 골라요 |
| `WHARFLINE_URL` | 브라우저로 여는 주소, 예: `https://deploy.example.com` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32`로 만든 긴 값 |
| `WHARFLINE_OWNER_EMAIL` / `_NAME` / `_PASSWORD` | 처음 만들 Owner. 비밀번호는 10자 이상, 첫 로그인 때 바꾸게 돼요 |
| `WHARFLINE_COOKIE_SECURE` | HTTPS면 `1`(기본). HTTP로만 시험할 때만 `0` |
| `WEB_BIND`, `WEB_PORT` | 웹 포트. 기본은 `127.0.0.1:8080`. 프록시가 다른 VM이면 이 VM의 내부 IP |
| `COMPOSE_PROFILES`, `WHARFLINE_DOMAIN` | 서버 한 대로 HTTPS까지 할 때만. `COMPOSE_PROFILES=https`면 Caddy가 함께 떠요 |

Owner가 생긴 뒤에는 `WHARFLINE_OWNER_PASSWORD`를 `.env`에서 지워도 돼요(빈 DB일 때만 쓰여요).

## 5. 띄우기

```bash
make up           # = docker compose up -d
```

Wharfline은 HTTP 포트 하나만 열어요. HTTPS는 둘 중 하나가 맡아요.

| 상황 | `.env` | 필요한 파일 |
|---|---|---|
| 앞에 리버스 프록시가 이미 있음 (NPM, 회사 nginx, 로드밸런서) | 그대로 | `docker-compose.yml`, `.env`, `Makefile` |
| 공인 IP가 붙은 서버 한 대뿐 (예: NCP 서버) | `COMPOSE_PROFILES=https`, `WHARFLINE_DOMAIN=…` | 위 셋 + `Caddyfile` |

두 번째는 함께 든 **Caddy**가 앞단을 맡아요. Caddy는 Let's Encrypt 인증서를 알아서 받고 갱신해요. `Caddyfile`은 그 설정 파일이에요.

`make`만 치면 쓸 수 있는 명령이 다 나와요: `up`, `down`, `restart`, `ps`, `logs`, `upgrade`, `backup`, `restore`, `keygen`, `key-status`, `key-verify`, `key-rotate`, `key-backup`.

### Nginx Proxy Manager(NPM)를 앞에 둘 때

공유기 → NPM → 이 VM 구성 예시예요. `COMPOSE_PROFILES`는 비워 두고 `make up`으로 띄워요.

1. NPM이 다른 VM·LXC에 있으면 `127.0.0.1`로는 닿지 않아요. `.env`에서 웹 포트를 이 VM의 내부 IP에 열어요.
   ```
   WEB_BIND=192.168.0.50      # 이 VM의 내부 IP
   WEB_PORT=8080
   WHARFLINE_URL=https://deploy.example.com
   WHARFLINE_COOKIE_SECURE=1
   ```
2. 그 포트는 **NPM만** 들어오게 막아요. Docker가 연 포트는 VM 안의 ufw 규칙을 건너뛰니, Proxmox 방화벽(VM → Firewall)에서 8080은 NPM의 IP만 허용하세요.
3. NPM에서 Proxy Host 추가
   - Domain: `deploy.example.com` → Scheme `http`, Forward `192.168.0.50`, Port `8080`
   - SSL 탭: 인증서 발급, Force SSL, HTTP/2, HSTS 켜기
   - Advanced 탭에 아래를 넣어요. 배포 로그를 실시간으로 받는 연결(SSE)이 끊기거나 늦게 오지 않게 해요.
     ```
     proxy_buffering off;
     proxy_read_timeout 1h;
     ```
4. 사용자 IP: NPM이 보내는 `X-Forwarded-For`를 Wharfline의 nginx가 받아요(내부망 주소에서 온 것만 믿어요). 활동 기록과 로그인 잠금에 실제 사용자 IP가 남아요.

### NCP(네이버 클라우드) 서버 한 대로 띄울 때

1. **서버와 공인 IP**: Ubuntu 서버를 만들고 공인 IP를 붙여요. Docker는 `curl -fsSL https://get.docker.com | sh`로 설치해요.
2. **ACG(방화벽) 인바운드 규칙**
   - TCP 80, 443: 모두 허용 (80은 인증서 발급과 HTTPS로 넘기기에 필요해요). HTTP/3를 쓰려면 UDP 443도.
   - TCP 22(SSH): 관리하는 곳의 IP만.
   - 8080은 열지 마세요. 이 구성에서는 `127.0.0.1`에만 열려서 Caddy만 써요.
3. **도메인**: 쓸 도메인의 A 레코드를 이 서버의 공인 IP로 맞춰요. DNS가 퍼지기 전에 띄우면 인증서 발급이 실패해요(퍼진 뒤 Caddy가 다시 시도해요).
4. **`.env`**
   ```
   COMPOSE_PROFILES=https
   WHARFLINE_DOMAIN=deploy.example.com
   WHARFLINE_URL=https://deploy.example.com
   WHARFLINE_COOKIE_SECURE=1
   WEB_BIND=127.0.0.1
   ```
5. **띄우기**: `.env`에 `COMPOSE_PROFILES=https`를 넣고 `make up`. `make logs s=caddy`에서 `certificate obtained successfully`가 보이면 끝이에요.
6. **접속 허용 주소**: Wharfline이 배포 대상 서버에 SSH로 접속할 때 나가는 주소는 이 서버의 공인 IP예요. 키 저장소의 **접속 허용 주소**에 그 IP를 넣고, 대상 서버들의 `authorized_keys`를 그 줄로 바꿔요. (대상 서버가 같은 VPC 안이면 사설 IP로 접속하니 사설 IP도 함께 넣어요.)
7. **백업**: DB 덤프는 서버 밖(예: Object Storage)에 두고, 마스터 키 백업은 그와 **다른 곳**에 둬요.

인증서는 `caddy_data` 볼륨에 저장돼요. `docker compose down -v`처럼 볼륨까지 지우면 인증서를 다시 받으니, 평소에는 `-v` 없이 내리세요.

확인:

```bash
make ps           # backend, frontend가 healthy, migrate는 exited (0)
make logs s=migrate   # "created the first Owner (no sample data)"
```

`WHARFLINE_URL`로 들어가 Owner로 로그인하면 새 비밀번호를 정하라고 나와요. 그다음 **보안** 탭에서 2단계 인증을 켜는 걸 권해요.

## 업데이트

```bash
make upgrade v=2026.11.09-1   # DB를 먼저 백업하고, .env의 버전을 바꾸고, 새 이미지를 받아 다시 띄워요
```

migrate가 DB를 새 버전으로 올린 뒤 백엔드가 떠요.

## 백업

```bash
make backup                                   # backups/wharfline-<시각>.dump
make restore f=backups/wharfline-....dump     # 되살리기
```

DB 덤프와 마스터 키 백업은 **따로** 두세요. 둘이 같이 털리면 비밀 값이 다 풀려요.

## 운영 전에 확인할 것

- [ ] `.env`는 `chmod 600`, `secrets/`는 `chmod 700`
- [ ] DB 포트는 밖에 열지 않아요(이 구성은 열지 않아요)
- [ ] 웹은 HTTPS로만, `WHARFLINE_COOKIE_SECURE=1`
- [ ] 마스터 키 백업을 DB 백업과 다른 곳에
- [ ] Owner 2단계 인증 켜기
- [ ] 키 저장소의 **접속 허용 주소**에 이 서버의 바깥 IP를 넣고, 배포 대상 서버의 `authorized_keys`를 그 줄로 바꾸기 (자세한 건 저장소 README의 "보안 운영")
- [ ] 로그는 컨테이너마다 10MB × 5개까지만 남아요. 더 오래 보관하려면 따로 수집하세요
