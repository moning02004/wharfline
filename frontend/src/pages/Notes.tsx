import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, PageHeader } from "../components/ui";

const L = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="link text-fg">
    {children}
  </Link>
);

function NoteList({ title, items, no }: { title: string; items: [ReactNode, ReactNode][]; no?: boolean }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="p-5">
        <ul className="m-0 pl-[18px] flex flex-col gap-2.5 text-muted marker:text-faint">
          {items.map(([b, rest], i) => (
            <li key={i} className="max-w-[70ch]">
              <b className={no ? "font-semibold text-bad" : "font-semibold text-fg"}>{b}</b> · {rest}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default function Notes() {
  return (
    <>
      <PageHeader title="설계 노트" desc="요청한 기능이 화면 어디에 있는지, 제가 더한 것과 일부러 뺀 것을 정리했어요." />
      <div className="grid lg:grid-cols-2 gap-4">
        <NoteList
          title="요청한 기능"
          items={[
            ["SSH 키 저장소", <><L to="/keys">키 저장소</L>. ED25519 키 생성과 기존 키 가져오기.</>],
            ["인벤토리", <><L to="/inventory">인벤토리</L>. 서버 묶음별로 IP, 포트, 사용자, 키, 그룹 지정.</>],
            ["배포할 것 고르기", <><L to="/registries">이미지 레지스트리</L>(GitHub, Gitea)의 도커 이미지를 고르고, 실행할 때 태그를 정해요.</>],
            ["배포 방식 섞어 쓰기", <>작업마다 Docker Compose(서버에 compose.yml을 올려 교체) 또는 Ansible 플레이북(<L to="/repos">플레이북 레포</L>)을 골라요.</>],
            [".env 업로드·붙여넣기", <>배포 작업 만들기와 <L to="/envs">환경 변수</L>.</>],
            ["실행 로그 모달", "아무 작업에서 \"실행\"을 눌러 보세요. 로그는 서버에서 실시간으로 스트리밍돼요."],
            ["로그인과 2단계 인증", <>왼쪽 아래 로그아웃 버튼, <L to="/security">보안</L>.</>],
            ["로그인 이력과 활동 기록", <L to="/activity">활동 기록</L>],
            ["비밀번호 재확인 후 5분 열람", "환경 변수에서 \"값 보기\". 상단에 남은 시간이 보여요."],
            ["되돌리기", "배포 작업 카드의 \"되돌리기\"로 이전 이미지 태그를 다시 배포하고, 환경 변수는 \"기록\"에서 이전 버전으로 되돌려요. 되돌려도 기록은 지워지지 않아요."],
            ["환경 변수 추가·수정·삭제", "환경 변수에서 \"편집\". 목록이나 .env 텍스트로 고치고, 저장하면 버전이 올라가요."],
          ]}
        />
        <NoteList
          title="제가 더한 것"
          items={[
            ["배포 마법사", <><L to="/setup">배포 마법사</L>에서 SSH 키부터 .env까지 한 페이지에서 순서대로 등록하고, 완료하면 바로 배포를 시작해요. 단계마다 발급·등록 매뉴얼이 있어요.</>],
            ["비밀 값 봉투 암호화", "환경 변수, SSH 비공개 키, 토큰을 레코드마다 새 데이터 키로 암호화해요. 마스터 키는 키 파일이나 Vault/OpenBao(KMS)에 둬요."],
            ["역할 기반 권한", "Owner, Admin, Deployer, Viewer. production 작업은 승인 필요."],
            ["역할별 메뉴 설정", <><L to="/members">멤버와 권한</L>에서 관리자가 역할마다 보일 메뉴를 켜고 꺼요. 숨긴 메뉴는 서버 API에서도 같이 막아야 해요(화면만 숨기면 주소로 들어올 수 있어요).</>],
            ["호스트 키 고정", "처음 접속 때 지문을 저장하고, 바뀌면 배포를 막아요."],
            ["그룹 단위 배포", "인벤토리 서버에 그룹(web, worker…)을 붙이고, 작업마다 보낼 그룹을 골라요. 실행 확인 창에서 이번 실행만 대상을 바꿀 수도 있어요."],
            ["실행 전 확인", "\"배포하시겠습니까?\" 창에서 레포, 커밋, 대상 서버 IP를 한 번 보여주고 실행해요. 보호된 작업은 Deployer가 실행할 때 승인이 필요해요."],
            ["동시 실행 잠금과 실패 시 롤백", "같은 서버에 두 배포가 겹치지 않게."],
            ["로그 속 비밀 값 가리기", ".env 값이 로그에 찍히면 저장 전에 ••••로 바꿔요."],
            ["해시 체인 활동 기록", "관리자도 기록을 몰래 지울 수 없게."],
            ["로그인 보호", "실패 잠금, IP 허용 목록, 세션 만료, 기기별 로그아웃, 복구 코드, 패스키."],
            ["Webhook 자동 배포", "서명(HMAC)을 검증한 push만 받아요."],
          ]}
        />
        <NoteList
          no
          title="일부러 뺀 것"
          items={[
            ["웹 터미널, 임의 명령 실행 칸", "계정 하나가 털리면 서버 전체가 넘어가요. 정해진 두 방식(Compose, 연결한 레포의 플레이북)만 돌리고, 넘기는 변수도 정해져 있어요."],
            ["서버에서 이미지 빌드, 위험한 compose 설정", "build:, privileged, network_mode: host, docker.sock 마운트, cap_add가 있으면 저장을 막아요. 이미지는 CI에서 만들어 레지스트리에 올린 것만 써요."],
            ["비공개 키 다시 보기·내려받기", "요청하신 \"비밀번호로 열람\"은 .env 값에만 적용했어요. 비공개 키는 저장 후 누구도 꺼낼 수 없어요."],
            ["root 접속", "SSH 사용자로 root를 지정하면 저장을 막고, 제한된 deploy 계정을 쓰도록 안내해요."],
            ["2단계 인증 끄기", "정책이 켜져 있으면 개인이 끌 수 없어요."],
          ]}
        />
        <Card>
          <CardHeader title="서버 쪽에서 지킬 것 (화면에 안 보이는 부분)" />
          <div className="p-5">
            <ul className="m-0 pl-[18px] flex flex-col gap-2.5 text-muted marker:text-faint">
              <li>비밀 값은 봉투 암호화(AES-256-GCM)로 저장하고, 마스터 키는 DB가 아닌 Docker secret 파일이나 KMS(Vault/OpenBao Transit)에 둬요. (구현됨)</li>
              <li>비밀번호는 Argon2id로 해시, TOTP 비밀값도 암호화 저장.</li>
              <li>세션 쿠키는 HttpOnly, Secure, SameSite=Strict. 모든 변경 요청에 CSRF 토큰.</li>
              <li>배포 실행기는 웹 서버와 분리된 워커 프로세스에서 돌리고, 키는 실행 중 메모리에만 풀어요.</li>
              <li>대상 서버의 deploy 계정은 sudo 없이, 필요한 명령만 허용(authorized_keys의 command 제한 등).</li>
            </ul>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="참고한 프로젝트" />
        <div className="p-5 grid md:grid-cols-3 gap-3">
          {[
            ["Semaphore UI", "키 저장소, 인벤토리, 플레이북 레포, 환경을 묶어 작업 템플릿을 만드는 구조. Ansible 방식과 실행 로그 화면."],
            ["Komodo", "서버와 배포 단위를 나눠 관리하는 방식, 레지스트리 이미지 + Compose 배포, 권한 모델."],
            ["Coolify", "이미지 태그 webhook 자동 배포, 환경 변수 편집 경험, 깔끔한 대시보드."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[18px] bg-surface-2 p-4 transition-transform duration-300 hover:-translate-y-0.5">
              <b className="block mb-1">{t}</b>
              <span className="text-muted">{d}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
