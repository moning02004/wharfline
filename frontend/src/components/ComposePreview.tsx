import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { Button, Chip, cx } from "./ui";
import { Icon } from "./Icon";
import { ModalBody, ModalFoot, ModalHead } from "./Modal";

/** The file names docker compose finds on its own (the server checks the same list). */
export const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
export const isComposeName = (path: string) => COMPOSE_NAMES.includes((path.split("/").pop() ?? path).toLowerCase());

interface Service {
  name: string;
  image: string;
  build: boolean;
  containers: string[];
  replicas: number;
  ports: string[];
  dependsOn: string[];
  profiles: string[];
  warning: string | null;
}

interface Preview {
  ok: boolean;
  error: string | null;
  project: string;
  services: Service[];
}

/**
 * What `docker compose up` would start from this file, before anything runs: a one-line summary in the form, the
 * table (each service, its image and the containers it makes) in a modal. Container names are <project>-<service>-<n>,
 * or container_name; the project is the deploy folder's name unless the file sets `name:`.
 */
export function ComposePreview({ content, servicePath, jobName, fileName }: { content: string; servicePath: string; jobName: string; fileName?: string }) {
  const { openModal } = useApp();
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!content.trim()) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api.post<Preview>("/compose/preview", { content, servicePath: servicePath.trim(), name: jobName.trim() }).then(
        (r) => alive && setPreview(r),
        () => alive && setPreview(null),
      );
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [content, servicePath, jobName]);

  if (!preview) return null;
  if (!preview.ok)
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
        <Icon name="alert" className="size-4 flex-none mt-0.5" />
        <span>{preview.error}</span>
      </div>
    );
  const total = preview.services.reduce((n, sv) => n + sv.containers.length, 0);
  const warned = preview.services.some((sv) => sv.warning);
  return (
    <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
      <Icon name="box" className="size-3.5 text-faint flex-none" />
      <span>
        {fileName && <span className="font-mono">{fileName} · </span>}
        서비스 {preview.services.length}개 · 컨테이너 {total}개
        <span className="text-muted"> · 프로젝트 <span className="font-mono">{preview.project}</span></span>
      </span>
      {warned && <Chip tone="warn">확인 필요</Chip>}
      <Button size="sm" variant="ghost" onClick={() => openModal((c) => <ComposeContainersModal preview={preview} fileName={fileName} onClose={c} />, "md")}>
        컨테이너 보기
      </Button>
    </div>
  );
}

function ComposeContainersModal({ preview, fileName, onClose }: { preview: Preview; fileName?: string; onClose: () => void }) {
  const total = preview.services.reduce((n, sv) => n + sv.containers.length, 0);
  return (
    <>
      <ModalHead title="뜨는 컨테이너" sub={`${fileName ? fileName + " · " : ""}서비스 ${preview.services.length}개 · 컨테이너 ${total}개 · 프로젝트 ${preview.project}`} onClose={onClose} />
      <ModalBody>
        <ContainersTable preview={preview} />
        <span className="text-[12px] text-muted">
          컨테이너 이름은 &lt;프로젝트&gt;-&lt;서비스&gt;-&lt;번호&gt;예요 (container_name이 있으면 그 이름). 프로젝트는 배포 폴더 이름이고, 파일에 name:이 있으면 그 이름이에요.
          {" ${…}"} 값은 배포할 때 채워져요. 프로필이 붙은 서비스는 그 프로필을 켜야 떠요.
        </span>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={onClose}>
          닫기
        </Button>
      </ModalFoot>
    </>
  );
}

function ContainersTable({ preview }: { preview: Preview }) {
  return (
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-[12.5px] min-w-[520px]">
          <thead>
            <tr className="text-left text-muted bg-surface-2">
              <th className="font-medium px-3 py-1.5">서비스</th>
              <th className="font-medium px-3 py-1.5">이미지</th>
              <th className="font-medium px-3 py-1.5">컨테이너</th>
              <th className="font-medium px-3 py-1.5">포트</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.services.map((s) => (
              <tr key={s.name} className="align-top">
                <td className="px-3 py-2">
                  <div className="font-mono font-medium">{s.name}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {s.profiles.length > 0 && <Chip tone="warn">프로필 {s.profiles.join(", ")}</Chip>}
                    {s.dependsOn.length > 0 && <span className="text-[11.5px] text-muted">← {s.dependsOn.join(", ")}</span>}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono break-all">
                  {s.image || (s.build ? <span className="text-muted">서버에서 빌드</span> : <span className="text-faint">-</span>)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    {s.containers.map((c) => (
                      <span key={c} className="font-mono">
                        {c}
                      </span>
                    ))}
                    {s.warning && <span className="text-[11.5px] text-warn">{s.warning}</span>}
                  </div>
                </td>
                <td className={cx("px-3 py-2 font-mono", !s.ports.length && "text-faint")}>{s.ports.join(", ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
