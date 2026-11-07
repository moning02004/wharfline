import type { Build, GitProvider } from "../lib/types";
import { cx } from "./ui";

export function elapsed(since: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - since));
  return s < 60 ? `${s}초째` : `${Math.floor(s / 60)}분째`;
}

export const PROVIDER_NAME: Record<GitProvider, string> = { gitea: "Gitea", github: "GitHub", gitlab: "GitLab" };

export const buildNo = (b: Build) => `#${b.runNumber ?? b.runId}`;

export function buildState(b: Build): { tone: "accent" | "ok" | "bad" | "neutral"; label: string } {
  if (b.status === "queued") return { tone: "accent", label: "빌드 대기" };
  if (b.status === "in_progress") return { tone: "accent", label: "빌드 중" };
  if (b.status === "success") return { tone: "ok", label: "빌드 성공" };
  if (b.status === "failure") return { tone: "bad", label: "빌드 실패" };
  return { tone: "neutral", label: b.status === "cancelled" ? "빌드 취소" : "빌드 건너뜀" };
}

const TONE = {
  accent: "bg-accent-soft text-accent border-accent/20",
  ok: "bg-ok-soft text-ok border-ok/20",
  bad: "bg-bad-soft text-bad border-bad/20",
  neutral: "bg-surface-2 text-muted border-line",
};
const DOT = { accent: "bg-accent animate-pulse-dot", ok: "bg-ok", bad: "bg-bad", neutral: "bg-faint" };

/** CI build state next to an image: "빌드 중 #42 · Build and push · 1분째", "빌드 성공 #42 → v0.9.5". Links to the run on its Git host. */
export function BuildBadge({ build }: { build: Build | null }) {
  if (!build) return null;
  const { tone, label } = buildState(build);
  const detail = build.active ? ` · ${build.step ?? build.branch ?? "준비"} · ${elapsed(build.startedAt)}` : build.tag ? ` → ${build.tag}` : "";
  const cls = cx("inline-flex items-center gap-1.5 h-5 px-1.5 rounded-[5px] border text-[11.5px] font-medium whitespace-nowrap no-underline", TONE[tone]);
  const content = (
    <>
      <span className={cx("size-1.5 rounded-full", DOT[tone])} />
      {label} <span className="font-mono">{buildNo(build)}</span>
      {detail}
    </>
  );
  const title = [build.workflow, build.title, build.sha?.slice(0, 7)].filter(Boolean).join(" · ");
  return build.url ? (
    <a href={build.url} target="_blank" rel="noreferrer noopener" className={cls} title={title} onClick={(e) => e.stopPropagation()}>
      {content}
    </a>
  ) : (
    <span className={cls} title={title}>
      {content}
    </span>
  );
}
