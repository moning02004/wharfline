import type { IconName } from "../../components/Icon";
import type { Job } from "../../lib/types";

export type StepId = "key" | "inventory" | "registry" | "image" | "repo" | "deploy" | "env" | "review";

export interface StepDef {
  id: StepId;
  title: string;
  short: string;
  icon: IconName;
  /** Label of the skip button; undefined means the step cannot be skipped. */
  skip?: string;
}

export const STEPS: StepDef[] = [
  { id: "key", title: "서버 접속용 SSH 키", short: "SSH 키", icon: "key" },
  { id: "inventory", title: "배포할 서버 (인벤토리)", short: "서버", icon: "server" },
  { id: "registry", title: "이미지 레지스트리", short: "레지스트리", icon: "box", skip: "공개 이미지라 건너뛰기" },
  { id: "image", title: "배포할 도커 이미지", short: "이미지", icon: "rocket" },
  { id: "repo", title: "Ansible 플레이북 레포", short: "플레이북 레포", icon: "git", skip: "레포 없이 Compose로 배포" },
  { id: "deploy", title: "배포 방식과 대상", short: "배포 설정", icon: "list" },
  { id: "env", title: "환경 변수 (.env)", short: ".env", icon: "file", skip: ".env 없이 진행" },
  { id: "review", title: "확인하고 만들기", short: "확인", icon: "check" },
];

export interface HostDraft {
  name: string;
  ip: string;
  port: string;
  user: string;
  group: string;
}

export interface WizardState {
  step: number;
  status: Partial<Record<StepId, "done" | "skipped">>;
  key?: { name: string; publicKey?: string };
  inventory?: { id: string; name: string; added: string[] };
  registry?: { id: string; host: string; namespace: string } | null;
  image?: { ref: string; tags: string[] };
  repo?: { name: string; books: string[] } | null;
  deploy?: {
    name: string;
    defaultTag: string;
    targets: string[];
    dir: string;
    compose: string;
    book: string;
    hook: boolean;
    protected: boolean;
    lock: boolean;
    rollback: boolean;
  };
  env?: { mode: "paste" | "upload" | "existing"; text: string; picked: string } | null;
  job?: Job;
}

export const COMPOSE_TPL = `services:
  app:
    image: \${IMAGE}:\${IMAGE_TAG}
    env_file: .env
    restart: unless-stopped
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 10s
`;

const STORAGE_KEY = "wharfline-setup";

/** Progress survives a page refresh in this tab only; everything it points to is already saved on the server. */
export function loadState(): WizardState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WizardState;
  } catch {
    /* storage unavailable */
  }
  return { step: 0, status: {} };
}

export function saveState(s: WizardState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function clearState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const imageShort = (ref?: string) => ref?.split("/").pop() ?? "app";
