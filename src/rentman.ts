import type { RentmanProjectRequest } from "./types.ts";

export interface RentmanSuccess {
  ok: true;
  id: number | null;
  status: number;
}

export interface RentmanFailure {
  ok: false;
  status: number;
  body: string;
}

export async function createProjectRequest(
  request: RentmanProjectRequest,
  token: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<RentmanSuccess | RentmanFailure> {
  const url = `${baseUrl.replace(/\/+$/, "")}/projectrequests`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    return { ok: false, status: 0, body: message };
  }

  const body = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body: clip(body) };
  }

  return { ok: true, id: extractId(body), status: response.status };
}

export function clip(text: string, max = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function redactSecrets(text: string): string {
  return text.replace(
    /(Authorization:\s*Bearer\s+)(\S+)/gi,
    "$1[redacted]",
  );
}

function extractId(body: string): number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      data?: { id?: unknown };
      id?: unknown;
    };
    const raw = parsed.data?.id ?? parsed.id;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  } catch {
    return null;
  }
  return null;
}
