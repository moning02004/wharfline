/** Step ids, and the guide tips that point at each input of the deploy job modal ("배포를 도와드릴까요?"). */
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";

export type JobStepId = "name" | "playbook" | "target" | "image" | "env" | "access" | "review";

export const JOB_STEPS: { id: JobStepId; label: string }[] = [
  { id: "name", label: "기본 정보" },
  { id: "playbook", label: "배포 방법" },
  { id: "target", label: "배포 대상" },
  { id: "image", label: "이미지" },
  { id: "env", label: "환경 변수" },
  { id: "access", label: "권한과 안전장치" },
  { id: "review", label: "확인" },
];

export type TipId =
  | "name"
  | "playbook.source"
  | "playbook.url"
  | "playbook.branch"
  | "playbook.path"
  | "playbook.key"
  | "playbook.builtin"
  | "playbook.script"
  | "target.inv"
  | "target.groups"
  | "image"
  | "env"
  | "env.vars"
  | "access.editors"
  | "access.safety"
  | "review";

type Mode = "new" | "edit";
type Tip = { text: string; example?: string };

/** One short sentence per input: what to put there, plus one example. */
export function tipFor(id: TipId, mode: Mode, opts: { builtin?: boolean } = {}): Tip {
  switch (id) {
    case "name":
      return { text: "무엇을 어디에 배포하는지 알 수 있게 이름을 적어요.", example: "api-server · production" };
    case "playbook.source":
      return { text: "Ansible 플레이북이 있으면 Git 레포, 서버에서 실행할 명령만 있으면 SSH 스크립트, 이미지 하나만 띄우면 기본 플레이북을 골라요." };
    case "playbook.script":
      return { text: "서버에서 차례로 실행할 명령을 단계로 나눠 적어요. 단계마다 모든 서버에서 실행하고, 실패한 서버는 남은 단계를 건너뛰어요.", example: "docker compose pull" };
    case "playbook.url":
      return { text: "플레이북이 있는 저장소 주소예요. git clone 할 때 쓰는 주소를 붙여넣어요.", example: "git@git.acme.kr:ops/ansible.git" };
    case "playbook.branch":
      return { text: "가져올 브랜치예요. 보통 main이에요.", example: "main" };
    case "playbook.path":
      return { text: "레포 맨 위에서부터 실행할 플레이북 파일까지의 경로예요.", example: "deploy/app.yml" };
    case "playbook.key":
      return { text: "비공개 저장소면 키를 골라요. SSH 주소는 SSH 키, HTTPS 주소는 토큰이에요. 공개 저장소면 그대로 둬요." };
    case "playbook.builtin":
      return { text: "플레이북 없이 이미지 하나를 컨테이너로 띄워요. 다음 단계에서 이미지를 꼭 적어요." };
    case "target.inv":
      return { text: "배포할 서버 목록(인벤토리)을 골라요." };
    case "target.groups":
      return { text: "일부 서버에만 보내려면 그룹을 골라요. 비워 두면 목록의 모든 서버에 배포해요." };
    case "image":
      return opts.builtin
        ? { text: "띄울 이미지를 docker pull 할 때처럼 이름:버전으로 적어요.", example: "postgres:15" }
        : { text: "배포할 이미지를 이름:버전으로 적어요. 플레이북만 돌린다면 비워 둬요.", example: "ghcr.io/acme/api:v1.2" };
    case "env":
      return mode === "edit"
        ? { text: "그대로 두려면 지금 것 유지, 값을 바꾸려면 바꾸기를 골라요." }
        : { text: "앱이 읽을 .env가 있으면 넣기, 없으면 없음을 골라요." };
    case "env.vars":
      return { text: "한 줄에 하나씩 KEY=VALUE로 붙여넣어요. 값은 암호화해서 저장해요.", example: "NODE_ENV=production" };
    case "access.editors":
      return { text: "이 작업을 고칠 그룹이나 사람을 골라요. 안 고르면 Owner, Admin, 만든 사람만 고칠 수 있어요." };
    case "access.safety":
      return { text: "운영 서버라면 운영 보호와 동시 실행 잠금을 켜 두세요. 잘 모르겠으면 기본값 그대로 둬요." };
    case "review":
      return mode === "edit"
        ? { text: "바뀐 내용을 확인하고 저장해요. 다음 실행부터 적용돼요." }
        : { text: "내용을 확인하고 만들기를 눌러요. 만들기만 해서는 배포되지 않아요." };
  }
}

/* ---------- pointing tips ---------- */

interface GuideState {
  on: boolean;
  tip: TipId | null;
  /** Bumps on every focus, so the same tip shows again after it faded. */
  seq: number;
  mode: Mode;
  builtin: boolean;
  /** The tip after this one in the current step, if any. */
  nextOf: (id: TipId) => TipId | null;
  focus: (id: TipId) => void;
}

export const GuideContext = createContext<GuideState>({ on: false, tip: null, seq: 0, mode: "new", builtin: false, nextOf: () => null, focus: () => {} });

/** How long a bubble stays before it fades away. */
const TIP_MS = 6000;

/**
 * Wraps one input. While the guide is on and this is the active tip, a bubble floats right below the
 * input with an arrow pointing at it. It is portaled and fixed, so it never moves other elements; it
 * pops in, then fades out after a few seconds or when focus leaves. The modal tracks focus via data-tip.
 */
export function TipSpot({ id, children, className, arrow = "left" }: { id: TipId; children: ReactNode; className?: string; arrow?: "left" | "right" }) {
  const g = useContext(GuideContext);
  const active = g.on && g.tip === id;
  const [phase, setPhase] = useState<"off" | "in" | "out">("off");
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; width: number } | null>(null);

  // Show on every activation (g.seq changes on each focus), fade after TIP_MS.
  useEffect(() => {
    if (!active) {
      setPhase((p) => (p === "in" ? "out" : p));
      return;
    }
    setPhase("in");
    const t = setTimeout(() => setPhase("out"), TIP_MS);
    return () => clearTimeout(t);
  }, [active, g.seq]);
  useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(() => setPhase("off"), 220);
    return () => clearTimeout(t);
  }, [phase]);

  // The anchor is the first element marked with this tip id (the env tip marks the switch in the field header).
  useLayoutEffect(() => {
    if (phase === "off") return;
    const place = () => {
      const el = document.querySelector<HTMLElement>(`[data-tip="${id}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 32);
      setPos(
        arrow === "right"
          ? { top: r.bottom + 10, right: Math.max(16, window.innerWidth - r.right), width }
          : { top: r.bottom + 10, left: Math.min(Math.max(16, r.left), window.innerWidth - width - 16), width },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [phase, id, arrow]);

  const tip = phase !== "off" ? tipFor(id, g.mode, { builtin: g.builtin }) : null;
  const next = tip ? g.nextOf(id) : null;
  return (
    <div data-tip={id} className={className ?? "flex flex-col gap-2 min-w-0"}>
      {children}
      {tip &&
        pos &&
        createPortal(
          <div
            role="note"
            style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right, maxWidth: pos.width }}
            className={`guide-bubble ${phase === "out" ? "is-out" : ""} z-[60] w-max rounded-lg px-3 py-2.5 text-[13px] leading-relaxed`}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the input
              e.stopPropagation(); // not an outside click
            }}
          >
            <span aria-hidden="true" className={`guide-bubble-arrow absolute -top-[6px] size-3 rotate-45 ${arrow === "right" ? "right-6" : "left-5"}`} />
            <div className="relative flex items-start gap-2">
              <Icon name="wand" className="guide-bubble-icon size-3.5 mt-[3px] flex-none" />
              <div className="min-w-0">
                <p className="m-0">{tip.text}</p>
                {tip.example && (
                  <p className="m-0 mt-1 text-[12px]">
                    예: <code className="font-mono text-[12px] break-all">{tip.example}</code>
                  </p>
                )}
                {next && (
                  <button type="button" onClick={() => g.focus(next)} className="guide-bubble-next mt-1.5 -ml-1.5 text-[12px] font-medium whitespace-nowrap rounded px-1.5 py-0.5">
                    다음 칸 →
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
