import { parseCsv, resolveFieldMap } from "./config.ts";
import { normalizeLookupKey } from "./payload.ts";
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
  if (allowed.length > 0) {
    const formName = submission.formName ?? "";
    const match = allowed.some(
      (name) => normalizeLookupKey(name) === normalizeLookupKey(formName),
    );
    if (!match) {
      return { ignored: true, reason: "form_not_allowed" };
    }
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
    planperiod_start: plan.planperiod_start,
    planperiod_end: plan.planperiod_end,
  };

  assignIf(request, "contact_name", picked.contact_name);
  assignIf(request, "contact_person_first_name", picked.contact_person_first_name);
  assignIf(request, "contact_person_lastname", picked.contact_person_lastname);
  assignIf(request, "contact_person_email", picked.contact_person_email);
  assignIf(request, "contact_phone", picked.contact_phone);
  assignIf(request, "location_name", picked.location_name);

  // Only copy usage dates the form actually sent. Do not invent usageperiod_*.
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
  for (const [key, value] of Object.entries(fields)) {
    const normalized = normalizeLookupKey(key);
    if (!normalized) continue;
    if (!lookup.has(normalized)) lookup.set(normalized, value);
  }
  return lookup;
}

export function readField(lookup: Map<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = lookup.get(normalizeLookupKey(alias));
    if (value != null && value.trim()) return value.trim();
  }

  // Webflow often suffixes colliding labels with a number
  // ("First Name 4", "Email 6") and may send either data-name or name="first-name-4".
  for (const alias of aliases) {
    const key = normalizeLookupKey(alias);
    if (!key) continue;
    const numbered = readNumberedAlias(lookup, key);
    if (numbered) return numbered;
  }
  return "";
}

function readNumberedAlias(lookup: Map<string, string>, aliasKey: string): string {
  const prefix = `${aliasKey}_`;
  for (const [fieldKey, value] of lookup) {
    if (!value.trim() || !fieldKey.startsWith(prefix)) continue;
    if (/^\d+$/.test(fieldKey.slice(prefix.length))) return value.trim();
  }
  return "";
}

export function normalizeLanguage(value: string, fallback: string): string {
  const key = normalizeLookupKey(value);
  if (key && LANGUAGE_ALIASES[key]) return LANGUAGE_ALIASES[key];
  const fb = normalizeLookupKey(fallback);
  return LANGUAGE_ALIASES[fb] ?? "nl";
}

/**
 * Rentman POST /projectrequests requires planperiod_start and planperiod_end.
 * Defaults (UTC, from `now`): today 00:00:00Z → today 23:59:59Z.
 * A single form date is paired with the start or end of that UTC day
 * (never inverted). usageperiod_* are not invented here.
 */
export function resolvePlanPeriods(
  usageStart: string | undefined,
  usageEnd: string | undefined,
  now: () => number,
): { planperiod_start: string; planperiod_end: string } {
  if (usageStart && usageEnd) {
    return { planperiod_start: usageStart, planperiod_end: usageEnd };
  }
  if (usageStart) {
    return {
      planperiod_start: usageStart,
      planperiod_end: laterIso(endOfUtcDay(usageStart), usageStart),
    };
  }
  if (usageEnd) {
    return {
      planperiod_start: earlierIso(startOfUtcDay(usageEnd), usageEnd),
      planperiod_end: usageEnd,
    };
  }
  const day = new Date(now()).toISOString().slice(0, 10);
  return {
    planperiod_start: `${day}T00:00:00Z`,
    planperiod_end: `${day}T23:59:59Z`,
  };
}

function startOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00Z`;
}

function endOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T23:59:59Z`;
}

function laterIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function earlierIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export function toIsoDateTime(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return endOfDay ? `${trimmed}T23:59:59Z` : `${trimmed}T00:00:00Z`;
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
