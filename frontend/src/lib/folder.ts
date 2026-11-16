/** Reading a folder the person picked or dropped in the browser, for uploads (playbooks, job files). */

export const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".idea", ".vscode"]);
export const MAX_FOLDER_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;

export type Picked = { path: string; file: File };

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const skipPath = (path: string) => path.split("/").some((p) => SKIP_DIRS.has(p));

/** Files of a dropped folder (DataTransfer entries), with paths starting at the folder name. */
export async function readEntry(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: entry.fullPath.replace(/^\//, ""), file });
    return;
  }
  if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await readEntry(e, out);
  }
}

/** Files from an <input type=file> (a folder input gives each file its relative path). */
export const fromFileList = (list: FileList): Picked[] =>
  [...list].map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));

/** Files dropped on the page: a folder keeps its paths, a single file keeps its plain name. */
export async function fromDrop(dt: DataTransfer): Promise<Picked[]> {
  const items = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  if (!items.length) return fromFileList(dt.files);
  const out: Picked[] = [];
  for (const it of items) await readEntry(it, out);
  return out.length === 1 && items[0].isFile ? [{ path: out[0].file.name, file: out[0].file }] : out;
}

/**
 * The request body for an upload endpoint that takes either one file ({name, data}) or a folder ({entries}).
 * Folder files over 512KB are left out and reported in `tooBig`.
 */
export async function uploadBody(picked: Picked[]): Promise<{ body: Record<string, unknown>; tooBig: { path: string; reason: string }[] }> {
  const list = picked.filter((p) => !skipPath(p.path));
  if (!list.length) throw new Error("올릴 파일이 없어요.");
  if (list.length === 1 && !list[0].path.includes("/")) {
    const f = list[0].file;
    if (f.size > MAX_FOLDER_BYTES) throw new Error("파일이 너무 커요. 5MB까지 올릴 수 있어요.");
    return { body: { name: f.name, data: toBase64(await f.arrayBuffer()) }, tooBig: [] };
  }
  const small = list.filter((p) => p.file.size <= MAX_FILE_BYTES);
  if (small.reduce((n, p) => n + p.file.size, 0) > MAX_FOLDER_BYTES) throw new Error("폴더가 너무 커요. 모두 합쳐 5MB까지 올릴 수 있어요. 필요한 폴더만 골라 주세요.");
  const entries = await Promise.all(small.map(async (p) => ({ path: p.path, content: toBase64(await p.file.arrayBuffer()) })));
  return { body: { entries }, tooBig: list.filter((p) => p.file.size > MAX_FILE_BYTES).map((p) => ({ path: p.path, reason: "512KB가 넘는 파일이에요" })) };
}
