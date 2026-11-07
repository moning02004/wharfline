# 보안 강화 (설계)

Wharfline 계정이나 키가 털렸을 때 연결된 서버로 피해가 번지지 않게 한다. 세 갈래로 나눠 작업한다.

## A. 진짜 로그인 (워커 1)

지금은 로그인 상태가 앱 전체에 하나뿐(설정 테이블의 `session`)이고, 비밀번호·2단계 인증·비밀번호 재확인이 아무 값이나 통과한다.

- **세션**: 브라우저마다 세션. `sessions` 테이블(토큰의 SHA-256을 키로, member email, created_at, last_seen, expires_at, sudo_until, user_agent, ip). 쿠키 `wharfline_session`(HttpOnly, SameSite=Lax, `WHARFLINE_COOKIE_SECURE=1`이면 Secure). 만료는 보안 정책의 세션 길이.
- **`store.current_member(db)`와 `store.sudo_active(db)`의 시그니처는 그대로** 둔다. 요청마다 미들웨어가 쿠키의 토큰을 contextvar에 넣고, 두 함수는 그 토큰으로 세션을 찾는다. 다른 코드는 이 두 함수만 쓴다.
- **비밀번호**: members에 bcrypt 해시. 로그인 실패는 같은 메시지("이메일 또는 비밀번호가 맞지 않아요."). 정책의 잠금 규칙(예: 5회 실패 → 15분 잠금)을 서버에서 지킨다.
- **2단계 인증은 선택**: 멤버가 켠 경우에만 로그인 두 번째 단계에서 TOTP(RFC 6238, 30초, 6자리, ±1 구간)를 묻는다. 비밀값은 봉투 암호화로 저장(컨텍스트 `member_tfa:{email}`), 복구 코드는 해시로 저장. 켜기(QR/otpauth URI → 코드 확인 → 복구 코드), 끄기(비밀번호 재확인 필요).
- **정책 "모든 멤버에게 2단계 인증 강제"는 기본 꺼짐**. 켜면 2단계 인증이 없는 멤버는 로그인 직후 설정 화면으로 간다.
- **비밀번호 재확인(sudo)**: 실제 비밀번호를 확인하고 세션의 sudo_until을 늘린다.
- **비밀번호 바꾸기**와 **Owner의 비밀번호 재설정**(임시 비밀번호를 한 번만 보여 주고, 다음 로그인 때 바꾸게 함).
- **시드 비밀번호**: 샘플 멤버는 `WHARFLINE_SEED_PASSWORD`(기본 `wharfline`)로 만든다. README에 적는다.
- **CSRF**: `/api/hooks/*`를 뺀 모든 변경 요청(POST/PUT/PATCH/DELETE)은 `X-Requested-With: wharfline` 헤더가 있어야 한다. 프론트 `lib/api.ts`가 붙인다.
- 기존 `DeviceSession` 목록은 실제 세션 목록으로 바꾸고, 다른 세션 로그아웃을 할 수 있게 한다.

## B. 역할 권한을 서버에서 강제 (워커 2)

지금은 로그인만 하면 누구나 배포 작업을 만들고 실행하고, 인벤토리·서버를 추가할 수 있다. "운영 보호"도 화면에만 있다.

| 할 수 있는 일 | Owner | Admin | Deployer | Viewer |
|---|---|---|---|---|
| 보기(목록, 실행 기록, 로그) | O | O | O | O |
| 일반 작업 실행, 실행 취소 | O | O | O | - |
| 운영 보호 작업 실행 | O | O | 승인 요청 | - |
| 배포 작업 만들기 | O | O | O (운영 보호 켜짐·자동 배포 꺼짐으로 고정) | - |
| 배포 작업 편집 | O | O | 편집 권한이 있을 때만, 운영 보호·자동 배포는 못 바꿈 | - |
| 실행 승인/거절 | O | O | - | - |
| 환경 변수 값 보기·바꾸기 | O | O | - | - |
| 키·인벤토리·서버·레지스트리·이미지·Git 연동 설정 | O | O | - | - |
| 멤버, 그룹, 보안 정책 | O | - | - | - |

- 서버 쪽: `can(member, action)` 하나로 판단하고, 엔드포인트마다 의존성으로 건다. 거절은 403 "이 작업을 할 권한이 없어요." 권한 판단은 항상 **로그인한 멤버** 기준(X-View-As는 보여 주기만 바꾼다).
- **승인 흐름**: Deployer가 운영 보호 작업을 실행하면 실행 기록이 `status: "approval"`(승인 대기)로 생기고 실행되지 않는다. Owner/Admin이 `POST /api/runs/{no}/approve` 하면 그때 실행되고, `POST /api/runs/{no}/reject` 하면 `status: "rejected"`. 요청한 사람, 승인/거절한 사람, 시각을 남긴다. 자동 배포(웹훅)로 운영 보호 작업이 실행될 때도 승인 대기로 만든다.
- 프론트: 역할에 맞지 않는 버튼은 숨기거나 막는다. 실행 창에서 Deployer가 운영 보호 작업을 고르면 버튼이 "승인 요청"이 된다. 실행 기록과 대시보드 알림에 승인 대기가 보이고, Owner/Admin은 거기서 승인·거절한다. 역할 권한 탭의 표를 위 표와 맞춘다.

## C. 서버 쪽 피해 범위 줄이기 (워커 3)

- **접속 허용 주소**: 키 저장소 화면에서 Wharfline이 서버에 접속할 때 나가는 주소(IP/CIDR, 여러 개)를 설정한다(설정 키 `ssh_from`, 엔드포인트 `GET/PUT /api/keys/access-from`, Owner/Admin). 공개키 보기 창은 서버에 넣을 줄을 이렇게 만들어 준다:
  `from="203.0.113.10",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA… wharfline`
  주소가 비어 있으면 그 사실과 위험을 알려 주고 일반 줄을 보여 준다.
- **deploy 사용자 권한 안내**: 같은 창에 root 대신 deploy 사용자를 쓰고, sudo는 필요한 명령만 허용하는 예시(sudoers 한 줄)와 docker 그룹은 root와 같다는 경고.
- **키 분리 경고**: 한 SSH 키를 여러 인벤토리(예: production과 staging)가 함께 쓰면 키 저장소와 인벤토리 화면에 경고를 보여 준다.
- **문서**: README에 "보안 운영" 절. 접속 허용 주소, deploy 사용자, 환경별 키, 마스터 키와 DB 백업을 따로 두기(`make key-backup`), **털렸을 때 순서**(서버의 authorized_keys에서 공개키 먼저 지우기 → 새 키 → `make key-rotate` → 웹훅 비밀값·토큰 재발급 → 활동 기록 확인), 자동 배포 주의점. 설계 노트 페이지에도 요약.

## 공통

- 테스트: 각자 바꾼 부분의 흐름 테스트를 `backend/tests/test_flow_*.py`로 더한다. 공용 픽스처 `client`, `login(email, sudo=False)`의 **이름과 사용법은 유지**한다(워커 1이 세션 방식에 맞게 내부를 바꾼다).
- 문구는 앱의 다른 곳처럼 짧은 해요체.
