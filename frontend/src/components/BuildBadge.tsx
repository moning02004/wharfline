import type { Build } from "../lib/types";
import { cx } from "./ui";

function elapsed(since: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - since));
  return s < 60 ? `${s}초째` : `${Math.floor(s / 60)}분째`;
}

/** CI build state next to an image: running now, or failed recently. Links to the run in Gitea. */
export function BuildBadge({ build }: { build: Build | null }) {
  if (!build) return null;
  const failed = build.status === "failure";
  const label = failed
    ? `빌드 실패 · #${build.runNumber ?? build.runId}`
    : `${build.status === "queued" ? "빌드 대기" : "빌드 중"} · ${build.step ?? build.branch ?? "준비"} · ${elapsed(build.startedAt)}`;
  const cls = cx(
    "inline-flex items-center gap-1.5 h-5 px-1.5 rounded-[5px] border text-[11.5px] font-medium whitespace-nowrap no-underline",
    failed ? "bg-bad-soft text-bad border-bad/20" : "bg-accent-soft text-accent border-accent/20",
  );
  const dot = <span className={cx("size-1.5 rounded-full", failed ? "bg-bad" : "bg-accent animate-pulse-dot")} />;
  const title = [build.workflow, build.title, build.sha?.slice(0, 7)].filter(Boolean).join(" · ");
  return build.url ? (
    <a href={build.url} target="_blank" rel="noreferrer noopener" className={cls} title={title} onClick={(e) => e.stopPropagation()}>
      {dot}
      {label}
    </a>
  ) : (
    <span className={cls} title={title}>
      {dot}
      {label}
    </span>
  );
}
