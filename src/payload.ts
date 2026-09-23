import type { NormalizedSubmission, SubmissionSource } from "./types.ts";

const META_KEYS = new Set([
  "triggertype",
  "trigger",
  "payload",
  "formresponse",
  "formdata",
  "form_data",
  "formfields",
  "form_fields",
  "schema",
  "displayname",
  "siteid",
  "site_id",
  "site",
  "workspaceid",
  "workspace_id",
  "datesubmitted",
  "submittedat",
  "formid",
  "form_id",
  "formelementid",
  "form_element_id",
  "localeid",
  "locale_id",
  "id",
  "page",
  "path",
  "domain",
  "hostname",
  "referrer",
  "url",
  "webhook",
  "event",
  "d",
  "formname",
  "form_name",
  "secret",
  "token",
]);

const FIELD_CONTAINER_KEYS = [
  "data",
  "formData",
  "form_data",
  "formResponse",
  "form_response",
  "fields",
  "formFields",
  "form_fields",
] as const;

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
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (rec.value != null && typeof rec.value !== "object") {
      return stringifyFieldValue(rec.value);
    }
    if (typeof rec.text === "string") return rec.text;
    if (rec.data != null && typeof rec.data !== "object") {
      return stringifyFieldValue(rec.data);
    }
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

/** Object of fields, or Webflow/Logic-style `[{ name, value }]`. */
export function extractFields(data: unknown): Record<string, string> {
  const unwrapped = unwrapJson(data);
  if (Array.isArray(unwrapped)) {
    const fields: Record<string, string> = {};
    for (const item of unwrapped) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const key =
        asString(rec.name) ??
        asString(rec.label) ??
        asString(rec.fieldName) ??
        asString(rec.field_name) ??
        asString(rec.key);
      if (!key) continue;
      const value = rec.value ?? rec.text ?? rec.data ?? rec.fieldValue;
      fields[key] = stringifyFieldValue(value);
    }
    return fields;
  }
  return fieldsFromRecord(unwrapped);
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

export function looksLikeUrlEncoded(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (!trimmed.includes("=")) return false;
  const params = new URLSearchParams(trimmed);
  return [...params.keys()].length > 0;
}

export function normalizeSubmission(
  raw: unknown,
  sourceHint?: SubmissionSource,
): NormalizedSubmission {
  const root = unwrapJson(raw);

  if (root && typeof root === "object" && !Array.isArray(root)) {
    const record = root as Record<string, unknown>;
    const payload = unwrapObject(record.payload);

    if (isWebflowWebhook(record, payload)) {
      const inner = payload ?? record;
      const fields = fieldsFromEnvelope(inner);
      return {
        source: "webflow_webhook",
        formName: formNameFrom(inner) ?? formNameFrom(record),
        submittedAt:
          asString(inner.submittedAt) ??
          asString(inner.submitted_at) ??
          asString(inner.dateSubmitted),
        siteId: siteIdFrom(inner) ?? siteIdFrom(record),
        localeId: asString(inner.localeId) ?? asString(inner.locale_id),
        submissionId:
          asString(inner.id) ??
          asString(inner.formId) ??
          asString(inner.form_id),
        fields,
      };
    }

    if (isWebflowDataApi(record)) {
      return {
        source: "webflow_data_api",
        formName: asString(record.displayName) ?? asString(record.name),
        submittedAt: asString(record.dateSubmitted) ?? asString(record.submittedAt),
        siteId: siteIdFrom(record),
        localeId: asString(record.localeId),
        submissionId: asString(record.id),
        fields: extractFields(record.formResponse),
      };
    }

    if (looksLikeWebhookPayload(record)) {
      return {
        source: "webflow_webhook",
        formName: formNameFrom(record),
        submittedAt: asString(record.submittedAt) ?? asString(record.submitted_at),
        siteId: siteIdFrom(record),
        localeId: asString(record.localeId),
        submissionId: asString(record.id) ?? asString(record.formId),
        fields: fieldsFromEnvelope(record),
      };
    }

    if (looksLikeDesignerFlat(record)) {
      return {
        source: "webflow_webhook",
        formName: formNameFrom(record),
        submittedAt: asString(record.submittedAt) ?? asString(record.submitted_at),
        siteId: siteIdFrom(record),
        localeId: asString(record.localeId),
        submissionId: asString(record.id) ?? asString(record.formId),
        fields: stripEnvelopeMeta(stripMetaFields(fieldsFromRecord(record))),
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
    fields: fieldsFromRecord(root),
  };
}

export function fieldsFromEnvelope(obj: Record<string, unknown>): Record<string, string> {
  for (const key of FIELD_CONTAINER_KEYS) {
    if (obj[key] == null) continue;
    const fields = extractFields(obj[key]);
    if (Object.keys(fields).length > 0) return fields;
  }

  const nestedForm = unwrapObject(obj.form);
  if (nestedForm) {
    const nested = fieldsFromEnvelope(nestedForm);
    if (Object.keys(nested).length > 0) return nested;
    const named = formNameFrom(nestedForm);
    if (named && Object.keys(nestedForm).length <= 3) {
      // `{ form: { name } }` only — keep looking at the parent.
    }
  }

  return stripMetaFields(fieldsFromRecord(obj));
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

export function formNameFrom(obj: Record<string, unknown>): string | null {
  const nestedForm = unwrapObject(obj.form);
  return (
    asString(obj.name) ??
    asString(obj.formName) ??
    asString(obj.form_name) ??
    asString(obj.displayName) ??
    (nestedForm ? formNameFrom(nestedForm) : null)
  );
}

function isWebflowWebhook(
  root: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): boolean {
  const trigger = (
    asString(root.triggerType) ??
    asString(root.trigger_type) ??
    asString(root.trigger)
  )?.toLowerCase();
  if (trigger === "form_submission") return true;
  return Boolean(payload && hasFieldContainer(payload));
}

function isWebflowDataApi(root: Record<string, unknown>): boolean {
  return Boolean(root.formResponse && typeof root.formResponse === "object");
}

function looksLikeDesignerFlat(root: Record<string, unknown>): boolean {
  if (hasFieldContainer(root)) return false;
  const formName = formNameFrom(root);
  if (!formName) return false;
  const keys = Object.keys(root);
  const hasEnvelope = root.page != null || root.site != null || root.website != null;
  const hasFormFields = keys.some((key) => isLikelyFormFieldKey(key));
  return hasEnvelope || hasFormFields;
}

function isLikelyFormFieldKey(key: string): boolean {
  const normalized = normalizeLookupKey(key);
  if (!normalized || META_KEYS.has(normalized) || normalized === "website") return false;
  return (
    /email/.test(normalized) ||
    /first_name/.test(normalized) ||
    /last_name/.test(normalized) ||
    /message/.test(normalized) ||
    /phone|telefoon|tel/.test(normalized)
  );
}

function stripEnvelopeMeta(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalized = normalizeLookupKey(key);
    if (
      normalized === "website" ||
      normalized === "page" ||
      normalized === "site" ||
      normalized === "name"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function looksLikeWebhookPayload(root: Record<string, unknown>): boolean {
  const nested = hasFieldContainer(root);
  const envelope =
    root.formId != null ||
    root.form_id != null ||
    root.submittedAt != null ||
    root.submitted_at != null ||
    root.siteId != null ||
    root.site_id != null ||
    root.site != null ||
    root.page != null ||
    (typeof root.name === "string" && root.name.trim() !== "");
  return nested && envelope;
}

function hasFieldContainer(obj: Record<string, unknown>): boolean {
  return FIELD_CONTAINER_KEYS.some((key) => isFieldContainer(obj[key]));
}

function isFieldContainer(value: unknown): boolean {
  const unwrapped = unwrapJson(value);
  if (Array.isArray(unwrapped)) return unwrapped.length > 0;
  return Boolean(unwrapped && typeof unwrapped === "object");
}

function siteIdFrom(obj: Record<string, unknown>): string | null {
  const direct = asString(obj.siteId) ?? asString(obj.site_id);
  if (direct) return direct;
  const site = unwrapJson(obj.site);
  if (typeof site === "string" && site.trim()) return site.trim();
  if (site && typeof site === "object" && !Array.isArray(site)) {
    const rec = site as Record<string, unknown>;
    return asString(rec.id) ?? asString(rec.siteId);
  }
  return null;
}

function unwrapObject(value: unknown): Record<string, unknown> | null {
  const unwrapped = unwrapJson(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return null;
  }
  return unwrapped as Record<string, unknown>;
}

function unwrapJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
