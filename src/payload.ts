import type { NormalizedSubmission, SubmissionSource } from "./types.ts";

const META_KEYS = new Set([
  "triggertype",
  "payload",
  "formresponse",
  "schema",
  "displayname",
  "siteid",
  "workspaceid",
  "datesubmitted",
  "submittedat",
  "formid",
  "formelementid",
  "localeid",
  "id",
]);

export function stringifyFieldValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyFieldValue(item))
      .filter(Boolean)
      .join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function fieldsFromRecord(data: unknown): Record<string, string> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    fields[key] = stringifyFieldValue(value);
  }
  return fields;
}

export function parseUrlEncoded(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const params = new URLSearchParams(body);
  for (const [key, value] of params.entries()) {
    if (key in fields && fields[key]) {
      fields[key] = `${fields[key]}, ${value}`;
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

export function normalizeSubmission(
  raw: unknown,
  sourceHint?: SubmissionSource,
): NormalizedSubmission {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const root = raw as Record<string, unknown>;

    if (isWebflowWebhook(root)) {
      const payload = (root.payload ?? {}) as Record<string, unknown>;
      return {
        source: "webflow_webhook",
        formName: asString(payload.name),
        submittedAt: asString(payload.submittedAt),
        siteId: asString(payload.siteId),
        localeId: asString(payload.localeId),
        submissionId: asString(payload.id) ?? asString(payload.formId),
        fields: fieldsFromRecord(payload.data),
      };
    }

    if (isWebflowDataApi(root)) {
      return {
        source: "webflow_data_api",
        formName: asString(root.displayName) ?? asString(root.name),
        submittedAt: asString(root.dateSubmitted) ?? asString(root.submittedAt),
        siteId: asString(root.siteId),
        localeId: asString(root.localeId),
        submissionId: asString(root.id),
        fields: fieldsFromRecord(root.formResponse),
      };
    }

    if (looksLikeWebhookPayload(root)) {
      return {
        source: "webflow_webhook",
        formName: asString(root.name),
        submittedAt: asString(root.submittedAt),
        siteId: asString(root.siteId),
        localeId: asString(root.localeId),
        submissionId: asString(root.id) ?? asString(root.formId),
        fields: fieldsFromRecord(root.data),
      };
    }
  }

  return {
    source: sourceHint ?? "flat_json",
    formName: null,
    submittedAt: null,
    siteId: null,
    localeId: null,
    submissionId: null,
    fields: fieldsFromRecord(raw),
  };
}

export function stripMetaFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (META_KEYS.has(normalizeLookupKey(key))) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeLookupKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Webflow Designer often appends an index ("First Name 4" → first_name_4). */
export function stripTrailingFieldIndex(key: string): string {
  return key.replace(/_\d+$/, "");
}

function isWebflowWebhook(root: Record<string, unknown>): boolean {
  const trigger = asString(root.triggerType)?.toLowerCase();
  if (trigger === "form_submission") return true;
  const payload = root.payload;
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "data" in (payload as object),
  );
}

function isWebflowDataApi(root: Record<string, unknown>): boolean {
  return Boolean(root.formResponse && typeof root.formResponse === "object");
}

function looksLikeWebhookPayload(root: Record<string, unknown>): boolean {
  return Boolean(
    root.data &&
      typeof root.data === "object" &&
      !Array.isArray(root.data) &&
      (root.formId != null || root.submittedAt != null || root.siteId != null),
  );
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
