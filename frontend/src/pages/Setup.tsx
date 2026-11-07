import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/app";
import { useRun } from "../modals/RunModals";
import { Icon } from "../components/Icon";
import { Button, Card, Chip, KV, PageHeader, cx } from "../components/ui";
import { Manual } from "./setup/Manual";
import { clearState, loadState, saveState, STEPS, type StepId, type WizardState } from "./setup/model";
import { DeployStep, EnvStep, ImageStep, InventoryStep, KeyStep, RegistryStep, RepoStep, ReviewStep, type StepProps } from "./setup/steps";

const BODIES: Record<StepId, (p: StepProps) => JSX.Element> = {
  key: KeyStep,
  inventory: InventoryStep,
  registry: RegistryStep,
  image: ImageStep,
  repo: RepoStep,
  deploy: DeployStep,
  env: EnvStep,
  review: ReviewStep,
};

const SKIP_PATCH: Partial<Record<StepId, Partial<WizardState>>> = {
  registry: { registry: null },
  repo: { repo: null },
  env: { env: null },
};

export default function Setup() {
  const [w, setW] = useState<WizardState>(loadState);
  const { refresh } = useApp();

  useEffect(() => {
    saveState(w);
  }, [w]);

  const step = STEPS[w.step];
  // A step is reachable once every step before it is done or skipped.
  const reachable = (i: number) => STEPS.slice(0, i).every((s) => w.status[s.id]);
  const goTo = (i: number) => reachable(i) && setW((s) => ({ ...s, step: i }));
  const advance = (patch: Partial<WizardState>, status: "done" | "skipped") => {
    setW((s) => ({ ...s, ...patch, status: { ...s.status, [step.id]: status }, step: Math.min(s.step + 1, STEPS.length - 1) }));
    refresh();
  };
  const restart = () => {
    clearState();
    setW({ step: 0, status: {} });
  };

  if (w.job) return <Finished w={w} restart={restart} />;

  const Body = BODIES[step.id];
  const doneCount = STEPS.filter((s) => w.status[s.id]).length;

  return (
    <>
      <PageHeader
        title="배포 마법사"
        desc="처음 배포까지 필요한 것을 순서대로 등록해요. 단계마다 아래 매뉴얼에 무엇을 발급받고 어디에 넣는지 적어 뒀어요."
      >
        {doneCount > 0 && (
          <Button variant="ghost" icon="refresh" onClick={restart}>
            처음부터 다시
          </Button>
        )}
      </PageHeader>

      {/* progress: stepper + current step, both locked to the same fixed height */}
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] gap-5">
        <Card className="p-3 lg:h-[var(--wizard-h)] flex flex-col min-w-0">
          <div className="max-lg:hidden px-3 pt-2 pb-3">
            <div className="flex items-baseline justify-between text-[12px] mb-2">
              <span className="font-semibold">진행</span>
              <span className="text-faint tabular-nums">
                {doneCount}/{STEPS.length}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all duration-500 ease-(--ease-soft)" style={{ width: `${(doneCount / STEPS.length) * 100}%` }} />
            </div>
          </div>
          <nav aria-label="진행 단계" className="flex lg:flex-col gap-1 overflow-x-auto scroll-soft lg:overflow-y-auto">
            {STEPS.map((s, i) => {
              const st = w.status[s.id];
              const current = i === w.step;
              const can = reachable(i);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!can}
                  onClick={() => goTo(i)}
                  aria-current={current ? "step" : undefined}
                  className={cx(
                    "flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap text-left transition-all duration-200 flex-none",
                    current ? "bg-primary-soft text-primary" : can ? "text-muted hover:bg-hover hover:text-fg" : "text-faint cursor-not-allowed",
                  )}
                >
                  <span
                    className={cx(
                      "grid place-items-center size-6 rounded-full text-[11px] font-semibold flex-none transition-colors",
                      st === "done" && "bg-ok text-white",
                      st === "skipped" && "bg-surface-2 text-faint shadow-[inset_0_0_0_1px_var(--border-strong)]",
                      !st && current && "bg-primary text-primary-fg",
                      !st && !current && "bg-surface-2 text-faint shadow-[inset_0_0_0_1px_var(--border)]",
                    )}
                  >
                    {st === "done" ? <Icon name="check" className="size-3" strokeWidth={3} /> : st === "skipped" ? "–" : i + 1}
                  </span>
                  <span className="flex-1">{s.short}</span>
                  {st === "skipped" && <span className="text-[10.5px] text-faint max-lg:hidden">건너뜀</span>}
                  {!s.skip && s.id !== "review" && !st && <span className="text-[10.5px] text-faint max-lg:hidden">필수</span>}
                </button>
              );
            })}
          </nav>
        </Card>

        <Card className="h-[var(--wizard-h)] flex flex-col min-w-0 overflow-hidden">
          <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-line flex-none">
            <span className="grid place-items-center size-10 rounded-2xl bg-primary-soft text-primary flex-none">
              <Icon name={step.icon} className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] text-faint font-medium">
                {w.step + 1}단계 / {STEPS.length}
                {step.skip ? " · 건너뛸 수 있어요" : step.id !== "review" ? " · 필수" : ""}
              </div>
              <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em] truncate">{step.title}</h2>
            </div>
          </div>
          {/* Body scrolls inside the fixed panel; each step's footer stays pinned to the bottom. */}
          <div key={step.id} className="flex-1 min-h-0 flex flex-col animate-fade">
            <Body
              w={w}
              goTo={goTo}
              done={(patch) => advance(patch, "done")}
              back={w.step > 0 ? () => setW((s) => ({ ...s, step: s.step - 1 })) : undefined}
              skip={step.skip ? () => advance(SKIP_PATCH[step.id] ?? {}, "skipped") : undefined}
            />
          </div>
        </Card>
      </div>

      {/* manual below, full width */}
      <Card className="p-5 sm:p-6">
        <Manual step={step.id} state={w} />
      </Card>
    </>
  );
}

function Finished({ w, restart }: { w: WizardState; restart: () => void }) {
  const job = w.job!;
  const { confirm } = useRun();
  const nav = useNavigate();
  return (
    <div className="max-w-[640px] mx-auto w-full flex flex-col gap-5 animate-rise">
      <Card className="p-7 flex flex-col items-center text-center gap-3">
        <span className="grid place-items-center size-14 rounded-full bg-ok-soft text-ok">
          <Icon name="check" className="size-7" strokeWidth={2.4} />
        </span>
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.03em]">배포 준비가 끝났어요</h1>
        <p className="m-0 text-muted max-w-[46ch]">
          <b className="text-fg">{job.name}</b> 배포 작업을 만들었어요. 지금 바로 첫 배포를 시작하거나, 나중에 배포 작업 메뉴에서 실행할 수 있어요.
        </p>
        <div className="flex gap-2 flex-wrap justify-center mt-2">
          <Button variant="primary" size="lg" icon="play" onClick={() => confirm(job)}>
            배포 시작
          </Button>
          <Button size="lg" onClick={() => nav("/jobs")}>
            배포 작업 보기
          </Button>
        </div>
      </Card>
      <Card className="p-5">
        <KV
          items={[
            ["이미지", `${job.image}:${job.defaultTag}`, "font-mono text-[12.5px]"],
            ["대상", <>{job.inventory} · <Chip tone="accent" mono>{job.targetLabel}</Chip> {job.targetHosts.map((h) => h.ip).join(", ")}</>],
            ["방식", job.method === "compose" ? `Docker Compose · ${job.dir}` : `Ansible · ${job.repo} / ${job.book}`],
            ["환경 변수", job.env || <span className="text-faint">없음</span>, "font-mono text-[12.5px]"],
          ]}
        />
      </Card>
      <div className="text-center">
        <Button variant="ghost" icon="wand" onClick={restart}>
          다른 배포 하나 더 만들기
        </Button>
      </div>
    </div>
  );
}
