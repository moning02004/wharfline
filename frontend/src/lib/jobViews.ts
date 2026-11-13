import type { Job } from "./types";

/** Saved views of the job list: the side menu links to /jobs?view=<id>, the list filters by the same test. */
export interface JobView {
  id: string;
  label: string;
  /** Color of the small square beside the name (a CSS color or variable) */
  dot: string;
  test: (job: Job, me: string | undefined) => boolean;
}

export const JOB_VIEWS: JobView[] = [
  { id: "all", label: "모든 작업", dot: "var(--fg)", test: () => true },
  { id: "mine", label: "내가 만든 작업", dot: "var(--faint)", test: (j, me) => !!me && j.createdBy === me },
  { id: "failed", label: "실패한 작업", dot: "var(--bad)", test: (j) => j.last?.status === "bad" },
  { id: "approval", label: "승인 필요", dot: "var(--mark)", test: (j) => j.protected },
  { id: "auto", label: "자동 배포 켜짐", dot: "var(--accent)", test: (j) => j.hook },
];

export function jobView(id: string | null): JobView {
  return JOB_VIEWS.find((v) => v.id === id) ?? JOB_VIEWS[0];
}
