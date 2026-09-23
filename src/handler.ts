import { ConfigError } from "./config.ts";
import { isTruthy } from "./config.ts";
import { mapSubmission } from "./mapper.ts";
import {
  looksLikeUrlEncoded,
  normalizeSubmission,
  parseUrlEncoded,
  stripMetaFields,
} from "./payload.ts";
import { clip, createProjectRequest, redactSecrets } from "./rentman.ts";
import type { Env, HandlerDeps, NormalizedSubmission } from "./types.ts";
import { VERSION } from "./types.ts";
import { authorizeRequest } from "./verify.ts";

const MAX_BODY_BYTES = 100_000;

export async function handleRequest(
  request: Request,
  env: Env,
  deps: HandlerDeps = defaultDeps(),
): Promise<Response> {
  const url = new URL(request.url);
  const requestId = deps.randomId();

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return cors(json(200, health(env)));
  }

  if (request.method !== "POST") {
    return cors(
      json(405, {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET / for health or POST / or POST /webhook for form submissions.",
      }),
    );
  }

  if (url.pathname !== "/" && url.pathname !== "/webhook") {
    return cors(
      json(404, {
        ok: false,
        error: "not_found",
        message: "POST / or POST /webhook.",
      }),
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    logLine({
      event: "webhook_rejected",
      requestId,
      path: url.pathname,
      error: "payload_too_large",
      contentLength,
    });
    return cors(
      json(413, {
        ok: false,
        error: "payload_too_large",
        message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
      }),
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    logLine({
      event: "webhook_rejected",
      requestId,
      path: url.pathname,
      error: "payload_too_large",
      bodyBytes: rawBody.length,
    });
    return cors(
      json(413, {
        ok: false,
        error: "payload_too_large",
        message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
      }),
    );
  }

  const auth = await authorizeRequest(
    request,
    rawBody,
    env.WEBHOOK_SECRET,
    deps.now,
  );

  logLine({
    event: "webhook_post",
    requestId,
    path: url.pathname,
    contentType: contentType.slice(0, 80) || null,
    bodyBytes: rawBody.length,
    hasSecretQuery: url.searchParams.has("secret") || hasQueryKeyIgnoreCase(url, "secret"),
    hasTokenQuery: url.searchParams.has("token"),
    hasWebhookSecretHeader: Boolean(request.headers.get("x-webhook-secret")?.trim()),
    hasAuthorization: Boolean(request.headers.get("authorization")?.trim()),
    hasWebflowSignature: Boolean(request.headers.get("x-webflow-signature")?.trim()),
    hasWebflowTimestamp: Boolean(request.headers.get("x-webflow-timestamp")?.trim()),
    authOk: auth.ok,
    authMode: auth.ok ? auth.mode : null,
    authError: auth.ok ? null : auth.error,
    authReason: auth.ok ? auth.hmacFailedReason ?? null : auth.reason,
    hmacAttempted: auth.hmacAttempted,
  });

  if (!auth.ok) {
    return cors(
      json(auth.status, { ok: false, error: auth.error, message: auth.message }),
    );
  }

  if (!rawBody.trim()) {
    logLine({ event: "payload_error", requestId, error: "empty_body" });
    return cors(
      json(400, {
        ok: false,
        error: "empty_body",
        message: "Request body is empty.",
      }),
    );
  }

  let submission: NormalizedSubmission;
  try {
    submission = await parseBody(request, rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid body";
    const errorCode = message.toLowerCase().includes("multipart")
      ? "unsupported_media_type"
      : "invalid_body";
    logLine({
      event: "payload_error",
      requestId,
      error: errorCode,
      message,
    });
    return cors(json(400, { ok: false, error: errorCode, message }));
  }

  const fieldKeys = Object.keys(submission.fields);
  const emptyFieldKeys = fieldKeys.filter((key) => !submission.fields[key]?.trim());
  logLine({
    event: "payload_parsed",
    requestId,
    source: submission.source,
    formName: submission.formName,
    siteId: submission.siteId,
    submissionId: submission.submissionId,
    fieldCount: fieldKeys.length,
    fieldKeys,
    emptyFieldKeys,
    hasEmailKey: fieldKeys.some((key) => /email/i.test(key)),
  });

  let mapped;
  try {
    mapped = mapSubmission(submission, env, deps.now);
  } catch (error) {
    if (error instanceof ConfigError) {
      logLine({
        event: "map_error",
        requestId,
        error: "invalid_config",
        message: error.message,
      });
      return cors(
        json(500, { ok: false, error: "invalid_config", message: error.message }),
      );
    }
    throw error;
  }

  if (mapped.ignored) {
    logLine({
      event: "ignored",
      requestId,
      reason: mapped.reason,
      formName: submission.formName,
    });
    return cors(json(200, { ok: true, ignored: true, reason: mapped.reason }));
  }

  const rentmanBody = mapped.request;
  if (!rentmanBody) {
    logLine({ event: "map_error", requestId, error: "map_failed" });
    return cors(
      json(500, {
        ok: false,
        error: "map_failed",
        message: "Mapper produced no Rentman request.",
      }),
    );
  }

  logLine({
    event: "mapped",
    requestId,
    formName: submission.formName,
    name: rentmanBody.name,
    hasFirstName: Boolean(rentmanBody.contact_person_first_name),
    hasLastName: Boolean(rentmanBody.contact_person_lastname),
    hasEmail: Boolean(rentmanBody.contact_person_email),
    hasPlanPeriod: Boolean(rentmanBody.planperiod_start && rentmanBody.planperiod_end),
  });

  if (isTruthy(env.DRY_RUN)) {
    logLine({
      event: "dry_run",
      requestId,
      formName: submission.formName,
      name: rentmanBody.name,
    });
    return cors(
      json(200, {
        ok: true,
        dryRun: true,
        rentman: rentmanBody,
      }),
    );
  }

  const token = env.RENTMAN_API_TOKEN?.trim();
  if (!token) {
    logLine({ event: "not_configured", requestId, error: "not_configured" });
    return cors(
      json(500, {
        ok: false,
        error: "not_configured",
        message: "RENTMAN_API_TOKEN is not set.",
      }),
    );
  }

  const result = await createProjectRequest(
    rentmanBody,
    token,
    env.RENTMAN_API_BASE ?? "https://api.rentman.net",
    deps.fetch,
  );

  if (!result.ok) {
    const rentmanBodySnippet = redactSecrets(clip(result.body));
    console.error(
      JSON.stringify({
        event: "rentman_error",
        requestId,
        status: result.status,
        body: rentmanBodySnippet,
        formName: submission.formName,
        name: rentmanBody.name,
      }),
    );
    return cors(
      json(502, {
        ok: false,
        error: "rentman_error",
        message: "Rentman rejected or failed the project request.",
        rentmanStatus: result.status || null,
      }),
    );
  }

  logLine({
    event: "rentman_created",
    requestId,
    rentmanId: result.id,
    status: result.status,
    formName: submission.formName,
    name: rentmanBody.name,
  });

  return cors(
    json(201, {
      ok: true,
      rentmanId: result.id,
      name: rentmanBody.name,
    }),
  );
}

export function defaultDeps(): HandlerDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };
}

export function health(env: Env) {
  return {
    ok: true,
    service: "webflow-rentman-bridge",
    version: VERSION,
    rentmanConfigured: Boolean(env.RENTMAN_API_TOKEN?.trim()),
    webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET?.trim()),
    dryRun: isTruthy(env.DRY_RUN),
  };
}

export async function parseBody(
  request: Request,
  rawBody: string,
): Promise<NormalizedSubmission> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    return {
      source: "form_urlencoded",
      formName: null,
      submittedAt: null,
      siteId: null,
      localeId: null,
      submissionId: null,
      fields: await parseMultipartFields(request, rawBody),
    };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return submissionFromFields("form_urlencoded", parseUrlEncoded(rawBody));
  }

  try {
    const parsed: unknown = JSON.parse(rawBody);
    const submission = normalizeSubmission(parsed);
    if (submission.source === "flat_json") {
      submission.fields = stripMetaFields(submission.fields);
    }
    return submission;
  } catch {
    if (looksLikeUrlEncoded(rawBody)) {
      return submissionFromFields("form_urlencoded", parseUrlEncoded(rawBody));
    }
    throw new Error("Body is not valid JSON.");
  }
}

function submissionFromFields(
  source: NormalizedSubmission["source"],
  fields: Record<string, string>,
): NormalizedSubmission {
  return {
    source,
    formName: null,
    submittedAt: null,
    siteId: null,
    localeId: null,
    submissionId: null,
    fields: stripMetaFields(fields),
  };
}

async function parseMultipartFields(
  request: Request,
  rawBody: string,
): Promise<Record<string, string>> {
  const replay = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: rawBody,
  });

  let formData: FormData;
  try {
    formData = await replay.formData();
  } catch {
    throw new Error(
      "multipart/form-data body could not be parsed. Use JSON (Webflow webhook) or x-www-form-urlencoded.",
    );
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (key in fields && fields[key]) {
      fields[key] = `${fields[key]}, ${value}`;
    } else {
      fields[key] = value;
    }
  }
  return stripMetaFields(fields);
}

function hasQueryKeyIgnoreCase(url: URL, name: string): boolean {
  const needle = name.toLowerCase();
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === needle) return true;
  }
  return false;
}

function logLine(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Content-Type, Authorization, X-Webhook-Secret, X-Webflow-Signature, X-Webflow-Timestamp",
  );
  return new Response(response.body, { status: response.status, headers });
}
