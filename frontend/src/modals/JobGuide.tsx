/** Step ids and the guide shown under each step of the deploy job modal ("배포를 도와드릴까요?"). */

export type JobStepId = "name" | "playbook" | "target" | "image" | "env" | "access" | "review";

export const JOB_STEPS: { id: JobStepId; label: string }[] = [
  { id: "name", label: "기본 정보" },
  { id: "playbook", label: "플레이북" },
  { id: "target", label: "배포 대상" },
  { id: "image", label: "이미지" },
  { id: "env", label: "환경 변수" },
  { id: "access", label: "권한과 안전장치" },
  { id: "review", label: "확인" },
];

// Placeholder until the guide content lands.
export function JobGuide({ step }: { step: JobStepId; mode: "new" | "edit" }) {
  return <div className="text-[12.5px] text-muted">{JOB_STEPS.find((s) => s.id === step)?.label}</div>;
}
