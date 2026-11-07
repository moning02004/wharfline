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
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and an effect must not return one.
    document.getElementById("content")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [w.step]);

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
        desc="처음 배포까지 필요한 것을 순서대로 등록해요. 단계마다 오른쪽 매뉴얼에 무엇을 발급받고 어디에 넣는지 적어 뒀어요."
      >
        {doneCount > 0 && (
          <Button variant="ghost" icon="refresh" onClick={restart}>
            처음부터 다시
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[210px_minmax(0,1fr)_330px] gap-5 items-start">
        {/* stepper */}
        <nav aria-label="진행 단계" className="lg:sticky lg:top-0 flex lg:flex-col gap-1 overflow-x-auto scroll-soft max-lg:-mx-1 max-lg:px-1 max-lg:pb-1">
          <div className="max-lg:hidden mb-2 px-3">
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div className="h-full bg-accent rounded-full transition-all duration-500 ease-(--ease-soft)" style={{ width: `${(doneCount / STEPS.length) * 100}%` }} />
            </div>
            <div className="text-[11.5px] text-faint mt-1.5 tabular-nums">
              {doneCount}/{STEPS.length} 완료
            </div>
          </div>
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
                  current ? "bg-surface text-fg shadow-soft" : can ? "text-muted hover:bg-hover hover:text-fg" : "text-faint cursor-not-allowed",
                )}
              >
                <span
                  className={cx(
                    "grid place-items-center size-6 rounded-full text-[11px] font-semibold flex-none transition-colors",
                    st === "done" && "bg-ok text-white",
                    st === "skipped" && "bg-surface-2 text-faint shadow-[inset_0_0_0_1px_var(--border-strong)]",
                    !st && current && "bg-accent text-on-accent",
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

        {/* current step */}
        <Card className="p-5 sm:p-6 min-w-0">
          <div key={step.id} className="animate-rise flex flex-col gap-5">
            <div className="flex items-start gap-3">
              <span className="grid place-items-center size-11 rounded-2xl bg-accent-soft text-accent flex-none">
                <Icon name={step.icon} className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] text-faint font-medium">
                  {w.step + 1}단계 / {STEPS.length}
                  {step.skip ? " · 건너뛸 수 있어요" : step.id !== "review" ? " · 필수" : ""}
                </div>
                <h2 className="m-0 text-[19px] font-semibold tracking-[-0.02em]">{step.title}</h2>
              </div>
            </div>
            <Body
              w={w}
              goTo={goTo}
              done={(patch) => advance(patch, "done")}
              back={w.step > 0 ? () => setW((s) => ({ ...s, step: s.step - 1 })) : undefined}
              skip={step.skip ? () => advance(SKIP_PATCH[step.id] ?? {}, "skipped") : undefined}
            />
          </div>
        </Card>

        {/* manual */}
        <aside className="xl:sticky xl:top-0 max-xl:lg:col-start-2">
          <Card className="p-5">
            <Manual step={step.id} state={w} />
          </Card>
        </aside>
      </div>
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
