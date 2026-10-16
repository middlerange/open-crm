export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(payload.error ?? "The request failed.", response.status);
  return payload;
}

export function formatDate(value?: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(
    "en",
    includeTime
      ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
      : { day: "numeric", month: "short" },
  ).format(date);
}

export function relativeDate(value?: string | null) {
  if (!value) return "No date";
  const date = new Date(value);
  const diffDays = Math.ceil((date.valueOf() - Date.now()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  return `In ${diffDays}d`;
}

export function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function roleLabel(value: string) {
  return value === "founder" || value === "manager" ? "Lead" : titleCase(value);
}
