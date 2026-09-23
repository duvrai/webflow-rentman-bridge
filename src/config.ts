import type { Env, FieldKey, FieldMap } from "./types.ts";

export const FIELD_KEYS: FieldKey[] = [
  "name",
  "contact_name",
  "contact_person_first_name",
  "contact_person_lastname",
  "contact_person_email",
  "contact_phone",
  "location_name",
  "usageperiod_start",
  "usageperiod_end",
  "language",
  "brief",
  "type",
  "material",
];

const ENV_ALIAS: Record<FieldKey, keyof Env> = {
  name: "FIELD_NAME",
  contact_name: "FIELD_CONTACT_NAME",
  contact_person_first_name: "FIELD_CONTACT_PERSON_FIRST_NAME",
  contact_person_lastname: "FIELD_CONTACT_PERSON_LASTNAME",
  contact_person_email: "FIELD_CONTACT_PERSON_EMAIL",
  contact_phone: "FIELD_CONTACT_PHONE",
  location_name: "FIELD_LOCATION_NAME",
  usageperiod_start: "FIELD_USAGEPERIOD_START",
  usageperiod_end: "FIELD_USAGEPERIOD_END",
  language: "FIELD_LANGUAGE",
  brief: "FIELD_BRIEF",
  type: "FIELD_TYPE",
  material: "FIELD_MATERIAL",
};

/** Default Webflow label / name aliases. Override per adopter via env. */
export const DEFAULT_FIELD_MAP: FieldMap = {
  name: [
    "project",
    "project_name",
    "event",
    "event_name",
    "projectnaam",
    "evenement",
    "titre",
    "nom_projet",
    "name",
  ],
  contact_name: [
    "company",
    "company_name",
    "organisation",
    "organization",
    "bedrijf",
    "firma",
    "societe",
    "société",
    "contact_name",
  ],
  contact_person_first_name: [
    "first_name",
    "firstname",
    "first name",
    "voornaam",
    "prenom",
    "prénom",
  ],
  contact_person_lastname: [
    "last_name",
    "lastname",
    "last name",
    "achternaam",
    "nom",
    "family_name",
  ],
  contact_person_email: ["email", "e-mail", "e_mail", "mail", "contact_email"],
  contact_phone: [
    "phone",
    "phone_number",
    "telephone",
    "tel",
    "telefoon",
    "gsm",
    "mobile",
  ],
  location_name: [
    "location",
    "venue",
    "locatie",
    "lieu",
    "plaats",
    "location_name",
  ],
  usageperiod_start: [
    "start",
    "start_date",
    "from",
    "date_start",
    "startdatum",
    "debut",
    "début",
    "usageperiod_start",
  ],
  usageperiod_end: [
    "end",
    "end_date",
    "to",
    "date_end",
    "einddatum",
    "fin",
    "usageperiod_end",
  ],
  language: ["language", "taal", "langue", "locale", "lang"],
  brief: [
    "brief",
    "message",
    "remarks",
    "remark",
    "opmerkingen",
    "bericht",
    "description",
    "omschrijving",
    "comment",
    "comments",
  ],
  type: ["type", "event_type", "soort", "aanvraagtype", "request_type"],
  material: [
    "materiaal",
    "crew",
    "materiaal_crew",
    "materiaal / crew",
    "equipment",
    "gear",
    "needs",
    "behoefte",
  ],
};

export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveFieldMap(env: Env): FieldMap {
  const map: FieldMap = {
    name: [...DEFAULT_FIELD_MAP.name],
    contact_name: [...DEFAULT_FIELD_MAP.contact_name],
    contact_person_first_name: [...DEFAULT_FIELD_MAP.contact_person_first_name],
    contact_person_lastname: [...DEFAULT_FIELD_MAP.contact_person_lastname],
    contact_person_email: [...DEFAULT_FIELD_MAP.contact_person_email],
    contact_phone: [...DEFAULT_FIELD_MAP.contact_phone],
    location_name: [...DEFAULT_FIELD_MAP.location_name],
    usageperiod_start: [...DEFAULT_FIELD_MAP.usageperiod_start],
    usageperiod_end: [...DEFAULT_FIELD_MAP.usageperiod_end],
    language: [...DEFAULT_FIELD_MAP.language],
    brief: [...DEFAULT_FIELD_MAP.brief],
    type: [...DEFAULT_FIELD_MAP.type],
    material: [...DEFAULT_FIELD_MAP.material],
  };

  if (env.FIELD_MAP_JSON) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.FIELD_MAP_JSON);
    } catch {
      throw new ConfigError("FIELD_MAP_JSON is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError("FIELD_MAP_JSON must be a JSON object");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isFieldKey(key)) continue;
      map[key] = aliasesFromUnknown(value);
    }
  }

  for (const key of FIELD_KEYS) {
    const raw = env[ENV_ALIAS[key]];
    if (raw && raw.trim()) {
      map[key] = parseCsv(raw);
    }
  }

  return map;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isFieldKey(value: string): value is FieldKey {
  return (FIELD_KEYS as string[]).includes(value);
}

function aliasesFromUnknown(value: unknown): string[] {
  if (typeof value === "string") return parseCsv(value);
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
