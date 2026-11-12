/** How long ago, from epoch seconds sent by the server: "방금", "5분 전", "3시간 전", "2일 전", then the date.
 *  Old rows without a time keep their stored label (fallback). */
export function since(at: number | null | undefined, fallback = "-"): string {
  if (!at) return fallback;
  const s = Math.max(0, Math.round(Date.now() / 1000 - at));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}일 전`;
  const d = new Date(at * 1000);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** The full local date and time, for a tooltip. */
export function stamp(at: number | null | undefined): string | undefined {
  return at ? new Date(at * 1000).toLocaleString("ko-KR") : undefined;
}
