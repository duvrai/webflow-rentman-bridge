import { ConfigError } from "./config.ts";
import { isTruthy } from "./config.ts";
import { mapSubmission } from "./mapper.ts";
import {
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
        message: "Use GET / for health or POST / for form submissions.",
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

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
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
  if (!auth.ok) {
    return cors(json(auth.status, { ok: false, error: auth.error, message: auth.message }));
  }

  if (!rawBody.trim()) {
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
    submission = parseBody(request, rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid body";
    return cors(json(400, { ok: false, error: "invalid_body", message }));
  }

  let mapped;
  try {
    mapped = mapSubmission(submission, env, deps.now);
  } catch (error) {
    if (error instanceof ConfigError) {
      return cors(
        json(500, { ok: false, error: "invalid_config", message: error.message }),
      );
    }
    throw error;
  }

  if (mapped.ignored) {
    console.log(
      JSON.stringify({
        event: "ignored",
        reason: mapped.reason,
        formName: submission.formName,
        requestId: deps.randomId(),
      }),
    );
    return cors(json(200, { ok: true, ignored: true, reason: mapped.reason }));
  }

  const rentmanBody = mapped.request;
  if (!rentmanBody) {
    return cors(
      json(500, {
        ok: false,
        error: "map_failed",
        message: "Mapper produced no Rentman request.",
      }),
    );
  }

  if (isTruthy(env.DRY_RUN)) {
    console.log(
      JSON.stringify({
        event: "dry_run",
        formName: submission.formName,
        name: rentmanBody.name,
      }),
    );
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
    console.error(
      JSON.stringify({
        event: "rentman_error",
        status: result.status,
        body: redactSecrets(clip(result.body)),
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

  console.log(
    JSON.stringify({
      event: "rentman_created",
      rentmanId: result.id,
      status: result.status,
      formName: submission.formName,
      name: rentmanBody.name,
    }),
  );

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

function parseBody(request: Request, rawBody: string): NormalizedSubmission {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    if (contentType.includes("multipart/form-data")) {
      throw new Error(
        "multipart/form-data is not supported. Use JSON (Webflow webhook) or x-www-form-urlencoded.",
      );
    }
    return {
      source: "form_urlencoded",
      formName: null,
      submittedAt: null,
      siteId: null,
      localeId: null,
      submissionId: null,
      fields: parseUrlEncoded(rawBody),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Body is not valid JSON.");
  }

  const submission = normalizeSubmission(parsed);
  if (submission.source === "flat_json") {
    submission.fields = stripMetaFields(submission.fields);
  }
  return submission;
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
