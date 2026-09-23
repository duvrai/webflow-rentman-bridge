import { parseCsv, resolveFieldMap } from "./config.ts";
import { normalizeLookupKey, stripTrailingFieldIndex } from "./payload.ts";
import type {
  Env,
  FieldKey,
  FieldMap,
  MappedRequest,
  NormalizedSubmission,
  RentmanProjectRequest,
} from "./types.ts";

const LANGUAGE_ALIASES: Record<string, string> = {
  nl: "nl",
  nederlands: "nl",
  dutch: "nl",
  "nl_be": "nl",
  "nl_nl": "nl",
  fr: "fr",
  francais: "fr",
  french: "fr",
  "fr_be": "fr",
  "fr_fr": "fr",
  en: "en",
  english: "en",
  "en_gb": "en",
  "en_us": "en",
};

export function mapSubmission(
  submission: NormalizedSubmission,
  env: Env,
  now = () => Date.now(),
): MappedRequest {
  const fieldMap = resolveFieldMap(env);
  const lookup = buildLookup(submission.fields);
  const honeypotName = (env.HONEYPOT_FIELD ?? "website").trim() || "website";
  const honeypot = readField(lookup, [honeypotName]);

  if (honeypot) {
    return { ignored: true, reason: "honeypot" };
  }

  const allowed = parseCsv(env.ALLOWED_FORM_NAMES);
  if (allowed.length > 0 && !formNameAllowed(submission.formName, allowed)) {
    return { ignored: true, reason: "form_not_allowed" };
  }

  const picked = pickFields(lookup, fieldMap);
  const language = normalizeLanguage(
    picked.language,
    env.DEFAULT_LANGUAGE ?? "nl",
  );
  const start = toIsoDateTime(picked.usageperiod_start, false);
  const end = toIsoDateTime(picked.usageperiod_end, true);
  const plan = resolvePlanPeriods(start, end, now);
  const defaultName = (env.DEFAULT_PROJECT_NAME ?? "Website request").trim() ||
    "Website request";
  const name = buildProjectName(picked, submission, defaultName, now);

  const request: RentmanProjectRequest = {
    linked_contact: null,
    name,
    language,
    remark: buildRemark(picked, submission),
    planperiod_start: plan.start,
    planperiod_end: plan.end,
  };

  assignIf(request, "contact_name", picked.contact_name);
  assignIf(request, "contact_person_first_name", picked.contact_person_first_name);
  assignIf(request, "contact_person_lastname", picked.contact_person_lastname);
  assignIf(request, "contact_person_email", picked.contact_person_email);
  assignIf(request, "contact_phone", picked.contact_phone);
  assignIf(request, "location_name", picked.location_name);

  // Only set usageperiod when the form supplied a date. Contact forms have
  // none today; later optional date fields can populate usage + plan cleanly.
  if (start) request.usageperiod_start = start;
  if (end) request.usageperiod_end = end;

  return { ignored: false, request };
}

export function pickFields(
  lookup: Map<string, string>,
  fieldMap: FieldMap,
): Record<FieldKey, string> {
  const picked = {} as Record<FieldKey, string>;
  for (const [key, aliases] of Object.entries(fieldMap) as [FieldKey, string[]][]) {
    picked[key] = readField(lookup, aliases);
  }
  return picked;
}

export function buildLookup(fields: Record<string, string>): Map<string, string> {
  const lookup = new Map<string, string>();
  const indexed: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(fields)) {
    const normalized = normalizeLookupKey(key);
    if (!normalized) continue;
    if (!lookup.has(normalized)) lookup.set(normalized, value);

    const base = stripTrailingFieldIndex(normalized);
    if (base && base !== normalized) {
      indexed.push([base, value]);
    }
  }

  // Exact names win; Webflow "Label N" aliases fill in only if unused.
  for (const [base, value] of indexed) {
    if (!lookup.has(base)) lookup.set(base, value);
  }

  return lookup;
}

/** "Contact" matches Webflow `data-name` "Contact Form" / "Contact Form 2". */
export function formNameAllowed(
  formName: string | null | undefined,
  allowed: string[],
): boolean {
  if (allowed.length === 0) return true;
  const actual = normalizeLookupKey(formName ?? "");
  const actualBase = stripFormNameSuffix(actual);
  return allowed.some((name) => {
    const normalized = normalizeLookupKey(name);
    if (!normalized) return false;
    if (normalized === actual) return true;
    return stripFormNameSuffix(normalized) === actualBase;
  });
}

function stripFormNameSuffix(key: string): string {
  return key.replace(/_form(_\d+)?$/, "").replace(/_\d+$/, "");
}

export function readField(lookup: Map<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = lookup.get(normalizeLookupKey(alias));
    if (value != null && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeLanguage(value: string, fallback: string): string {
  const key = normalizeLookupKey(value);
  if (key && LANGUAGE_ALIASES[key]) return LANGUAGE_ALIASES[key];
  const fb = normalizeLookupKey(fallback);
  return LANGUAGE_ALIASES[fb] ?? "nl";
}

export function toIsoDateTime(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return endOfDay ? endOfUtcDay(trimmed) : startOfUtcDay(trimmed);
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}:00Z`;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}Z`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * Rentman requires planperiod_start and planperiod_end.
 * Usage dates stay unset unless the form supplied them.
 *
 * Defaults (no form dates): today UTC, 00:00:00Z–23:59:59Z — a same-day
 * planning window so contact forms succeed. Staff replace it when converting
 * the request. One date: the missing plan bound is the same UTC calendar day.
 */
export function resolvePlanPeriods(
  start: string | undefined,
  end: string | undefined,
  now: () => number,
): { start: string; end: string } {
  if (start && end) return { start, end };

  if (start) {
    return { start, end: endOfUtcDay(utcDatePart(start)) };
  }

  if (end) {
    return { start: startOfUtcDay(utcDatePart(end)), end };
  }

  const day = new Date(now()).toISOString().slice(0, 10);
  return { start: startOfUtcDay(day), end: endOfUtcDay(day) };
}

function utcDatePart(iso: string): string {
  return iso.slice(0, 10);
}

function startOfUtcDay(day: string): string {
  return `${day}T00:00:00Z`;
}

function endOfUtcDay(day: string): string {
  return `${day}T23:59:59Z`;
}

export function buildProjectName(
  picked: Record<FieldKey, string>,
  submission: NormalizedSubmission,
  defaultName: string,
  now: () => number,
): string {
  if (picked.name) return picked.name;

  const person = [picked.contact_person_first_name, picked.contact_person_lastname]
    .filter(Boolean)
    .join(" ");
  const who = picked.contact_name || person;
  const form = submission.formName;
  const day = new Date(now()).toISOString().slice(0, 10);

  if (who && form) return `${who} — ${form}`;
  if (who) return `${who} — ${day}`;
  if (form) return `${form} — ${day}`;
  return `${defaultName} — ${day}`;
}

export function buildRemark(
  picked: Record<FieldKey, string>,
  submission: NormalizedSubmission,
): string {
  const sections: string[] = [];
  if (picked.brief) sections.push(`Brief:\n${picked.brief}`);
  if (picked.type) sections.push(`Type:\n${picked.type}`);
  if (picked.material) sections.push(`Materiaal/crew:\n${picked.material}`);

  const meta: string[] = [];
  if (submission.formName) meta.push(`Form: ${submission.formName}`);
  if (submission.submittedAt) meta.push(`Submitted: ${submission.submittedAt}`);
  if (submission.siteId) meta.push(`Site: ${submission.siteId}`);
  if (submission.submissionId) meta.push(`Submission: ${submission.submissionId}`);
  meta.push(`Source: ${submission.source}`);

  const dump = Object.entries(submission.fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  const parts = [
    ...sections,
    meta.join("\n"),
    `--- raw form ---\n${dump || "(empty)"}`,
  ];
  return parts.join("\n\n");
}

function assignIf<K extends keyof RentmanProjectRequest>(
  request: RentmanProjectRequest,
  key: K,
  value: string,
): void {
  if (value) {
    (request[key] as string) = value;
  }
}
