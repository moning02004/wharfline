export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
  get sudoRequired() {
    return this.status === 403 && this.detail === "sudo_required";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : "입력값을 확인해 주세요.";
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.detail : "요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
}

export function parseEnv(txt: string): [string, string][] {
  return txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).replace(/^export\s+/, "").trim(),
        l.slice(i + 1).trim().replace(/^["']|["']$/g, ""),
      ];
    });
}
