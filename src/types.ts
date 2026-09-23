export interface Env {
  RENTMAN_API_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  DRY_RUN?: string;
  RENTMAN_API_BASE?: string;
  HONEYPOT_FIELD?: string;
  DEFAULT_LANGUAGE?: string;
  DEFAULT_PROJECT_NAME?: string;
  FIELD_MAP_JSON?: string;
  ALLOWED_FORM_NAMES?: string;
  FIELD_NAME?: string;
  FIELD_CONTACT_NAME?: string;
  FIELD_CONTACT_PERSON_FIRST_NAME?: string;
  FIELD_CONTACT_PERSON_LASTNAME?: string;
  FIELD_CONTACT_PERSON_EMAIL?: string;
  FIELD_CONTACT_PHONE?: string;
  FIELD_LOCATION_NAME?: string;
  FIELD_USAGEPERIOD_START?: string;
  FIELD_USAGEPERIOD_END?: string;
  FIELD_LANGUAGE?: string;
  FIELD_BRIEF?: string;
  FIELD_TYPE?: string;
  FIELD_MATERIAL?: string;
}

export type FieldKey =
  | "name"
  | "contact_name"
  | "contact_person_first_name"
  | "contact_person_lastname"
  | "contact_person_email"
  | "contact_phone"
  | "location_name"
  | "usageperiod_start"
  | "usageperiod_end"
  | "language"
  | "brief"
  | "type"
  | "material";

export type FieldMap = Record<FieldKey, string[]>;

export type SubmissionSource =
  | "webflow_webhook"
  | "webflow_data_api"
  | "flat_json"
  | "form_urlencoded";

export interface NormalizedSubmission {
  source: SubmissionSource;
  formName: string | null;
  submittedAt: string | null;
  siteId: string | null;
  localeId: string | null;
  submissionId: string | null;
  fields: Record<string, string>;
}

/** Body sent to POST https://api.rentman.net/projectrequests */
export interface RentmanProjectRequest {
  linked_contact: null;
  name: string;
  language: string;
  remark: string;
  contact_name?: string;
  contact_person_first_name?: string;
  contact_person_lastname?: string;
  contact_person_email?: string;
  contact_phone?: string;
  location_name?: string;
  usageperiod_start?: string | null;
  usageperiod_end?: string | null;
  /** Required by Rentman POST /projectrequests (non-optional in OpenAPI). */
  planperiod_start: string;
  planperiod_end: string;
}

export interface MappedRequest {
  ignored: boolean;
  reason?: "honeypot" | "form_not_allowed";
  request?: RentmanProjectRequest;
}

export interface HandlerDeps {
  fetch: typeof fetch;
  now: () => number;
  randomId: () => string;
}

export const VERSION = "1.1.0";
