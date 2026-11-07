# 운영 서버에 Wharfline 띄우기

GitHub 릴리스로 만들어진 이미지(`ghcr.io/moning02004/wharfline-*`)를 받아서 실행해요. 서버에서 빌드하지 않고, 샘플 데이터도 넣지 않아요. 처음 띄우면 `.env`에 적은 Owner 한 명만 만들어져요.

필요한 것: Docker Engine과 Compose 플러그인(`docker compose version`), 이 폴더의 파일 세 개(`docker-compose.yml`, `Caddyfile`, `.env.example`).

## 1. 폴더 만들기

```bash
sudo mkdir -p /opt/wharfline && sudo chown "$USER" /opt/wharfline && cd /opt/wharfline
# 이 폴더의 docker-compose.yml, Caddyfile, .env.example을 여기로 복사해요
cp .env.example .env && chmod 600 .env
```

## 2. 이미지를 받을 수 있게 하기

GHCR 패키지는 처음에 비공개예요. 둘 중 하나를 고르세요.

- GitHub에서 패키지(`wharfline-backend`, `wharfline-frontend`)를 공개로 바꾸기, 또는
- 서버에서 로그인: `read:packages` 권한만 준 토큰으로
  `echo <토큰> | docker login ghcr.io -u moning02004 --password-stdin`

## 3. 마스터 키 만들기

비밀 값(SSH 키, 토큰, 환경 변수)을 암호화하는 키예요. **잃어버리면 저장된 비밀 값을 영영 못 읽어요.**

```bash
mkdir -p secrets && chmod 700 secrets
docker run --rm ghcr.io/moning02004/wharfline-backend:<버전> \
  python -c 'from app.crypto import generate_key_line; import time; print(generate_key_line(time.strftime("k%Y%m%d%H%M%S")))' \
  > secrets/master_keys
chmod 644 secrets/master_keys   # 컨테이너 안의 일반 사용자가 읽어야 해서 644, 대신 폴더를 700으로 막아요
```

바로 암호를 걸어 다른 곳에 백업해 두세요(DB 백업과 **다른 곳**에).

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -in secrets/master_keys -out master_keys-$(date +%Y%m%d).enc
```

## 4. `.env` 채우기

| 값 | 설명 |
|---|---|
| `WHARFLINE_VERSION` | 실행할 릴리스 태그. [릴리스 목록](https://github.com/moning02004/wharfline/releases)에서 골라요 |
| `WHARFLINE_URL` | 브라우저로 여는 주소, 예: `https://deploy.example.com` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32`로 만든 긴 값 |
| `WHARFLINE_OWNER_EMAIL` / `_NAME` / `_PASSWORD` | 처음 만들 Owner. 비밀번호는 10자 이상, 첫 로그인 때 바꾸게 돼요 |
| `WHARFLINE_COOKIE_SECURE` | HTTPS면 `1`(기본). HTTP로만 시험할 때만 `0` |
| `WEB_BIND`, `WEB_PORT` | 웹 포트. 기본은 `127.0.0.1:8080`이라 바깥에서 바로 못 들어와요 |
| `WHARFLINE_DOMAIN` | 아래 Caddy(자동 HTTPS)를 쓸 때의 도메인 |

Owner가 생긴 뒤에는 `WHARFLINE_OWNER_PASSWORD`를 `.env`에서 지워도 돼요(빈 DB일 때만 쓰여요).

## 5. 띄우기

HTTPS를 어떻게 붙이느냐에 따라 둘 중 하나예요.

**A. 함께 들어 있는 Caddy로 자동 HTTPS** (도메인이 이 서버를 가리키고 80/443 포트가 열려 있어야 해요)

```bash
docker compose --profile https up -d
```

**B. 이미 쓰는 리버스 프록시(nginx 등)가 있을 때**: `127.0.0.1:8080`으로 넘기고 `X-Forwarded-For`를 붙여 주세요.

```bash
docker compose up -d
```

### Nginx Proxy Manager(NPM)를 앞에 둘 때

공유기 → NPM → 이 VM 구성이면 HTTPS는 NPM이 맡으니 **Caddy와 `Caddyfile`은 필요 없어요.** `--profile https` 없이 `docker compose up -d`로 띄우면 돼요.

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

확인:

```bash
docker compose ps                 # backend, frontend가 healthy, migrate는 exited (0)
docker compose logs migrate       # "created the first Owner (no sample data)"
```

`WHARFLINE_URL`로 들어가 Owner로 로그인하면 새 비밀번호를 정하라고 나와요. 그다음 **보안** 탭에서 2단계 인증을 켜는 걸 권해요.

## 업데이트

```bash
# .env의 WHARFLINE_VERSION을 새 태그로 바꾼 뒤
docker compose pull
docker compose up -d              # migrate가 DB를 새 버전으로 올린 뒤 백엔드가 다시 떠요
```

업데이트 전에는 DB 백업을 먼저 하세요.

## 백업

```bash
docker compose exec -T db pg_dump -U wharfline -Fc wharfline > wharfline-$(date +%Y%m%d).dump
```

DB 덤프와 마스터 키 백업은 **따로** 두세요. 둘이 같이 털리면 비밀 값이 다 풀려요.

되살리기:

```bash
docker compose stop backend frontend
docker compose exec -T db pg_restore -U wharfline -d wharfline --clean --if-exists < wharfline-YYYYMMDD.dump
docker compose up -d
```

## 운영 전에 확인할 것

- [ ] `.env`는 `chmod 600`, `secrets/`는 `chmod 700`
- [ ] DB 포트는 밖에 열지 않아요(이 구성은 열지 않아요)
- [ ] 웹은 HTTPS로만, `WHARFLINE_COOKIE_SECURE=1`
- [ ] 마스터 키 백업을 DB 백업과 다른 곳에
- [ ] Owner 2단계 인증 켜기
- [ ] 키 저장소의 **접속 허용 주소**에 이 서버의 바깥 IP를 넣고, 배포 대상 서버의 `authorized_keys`를 그 줄로 바꾸기 (자세한 건 저장소 README의 "보안 운영")
- [ ] 로그는 컨테이너마다 10MB × 5개까지만 남아요. 더 오래 보관하려면 따로 수집하세요
