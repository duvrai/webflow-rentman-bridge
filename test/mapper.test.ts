import { describe, expect, it } from "vitest";
import { resolveFieldMap } from "../src/config.ts";
import {
  buildRemark,
  formNameAllowed,
  mapSubmission,
  normalizeLanguage,
  resolvePlanPeriods,
  toIsoDateTime,
} from "../src/mapper.ts";
import { liveFormSubmissionWebhook } from "./fixtures/webflow-contact-form.ts";
import { normalizeSubmission } from "../src/payload.ts";
import type { Env, NormalizedSubmission } from "../src/types.ts";

const now = () => Date.parse("2026-09-22T10:00:00Z");

function webhook(data: Record<string, unknown>, name = "Offerte"): NormalizedSubmission {
  return normalizeSubmission({
    triggerType: "form_submission",
    payload: {
      name,
      siteId: "site-1",
      data,
      submittedAt: "2026-09-22T09:00:00Z",
      id: "sub-1",
      formId: "form-1",
    },
  });
}

describe("mapSubmission", () => {
  it("maps configurable fields and leaves linked_contact null", () => {
    const result = mapSubmission(
      webhook({
        project: "Festival Main Stage",
        company: "Acme Events",
        voornaam: "Piet",
        achternaam: "Jansen",
        email: "piet@acme.test",
        telefoon: "+32 2 000 00 00",
        locatie: "Brussels Expo",
        startdatum: "2026-10-01",
        einddatum: "2026-10-03",
        taal: "Nederlands",
        message: "Need PA + two techs",
        type: "Festival",
        materiaal: "Line array, FOH, 2 crew",
      }),
      {},
      now,
    );

    expect(result.ignored).toBe(false);
    expect(result.request?.linked_contact).toBeNull();
    expect(result.request?.name).toBe("Festival Main Stage");
    expect(result.request?.contact_name).toBe("Acme Events");
    expect(result.request?.contact_person_first_name).toBe("Piet");
    expect(result.request?.contact_person_lastname).toBe("Jansen");
    expect(result.request?.contact_person_email).toBe("piet@acme.test");
    expect(result.request?.contact_phone).toBe("+32 2 000 00 00");
    expect(result.request?.location_name).toBe("Brussels Expo");
    expect(result.request?.usageperiod_start).toBe("2026-10-01T00:00:00Z");
    expect(result.request?.usageperiod_end).toBe("2026-10-03T23:59:59Z");
    expect(result.request?.planperiod_start).toBe("2026-10-01T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-10-03T23:59:59Z");
    expect(result.request?.language).toBe("nl");
    expect(result.request?.remark).toContain("Brief:\nNeed PA + two techs");
    expect(result.request?.remark).toContain("Type:\nFestival");
    expect(result.request?.remark).toContain("Materiaal/crew:\nLine array, FOH, 2 crew");
    expect(result.request?.remark).toContain("--- raw form ---");
    expect(result.request?.remark).toContain("email: piet@acme.test");
  });

  it("returns 200-style ignore when the honeypot is filled", () => {
    const result = mapSubmission(
      webhook({ email: "a@b.c", website: "http://spam.test" }),
      { HONEYPOT_FIELD: "website" },
      now,
    );
    expect(result).toEqual({ ignored: true, reason: "honeypot" });
  });

  it("ignores submissions from other form names when allow-listed", () => {
    const result = mapSubmission(
      webhook({ email: "a@b.c" }, "Newsletter"),
      { ALLOWED_FORM_NAMES: "Offerte,Contact" },
      now,
    );
    expect(result).toEqual({ ignored: true, reason: "form_not_allowed" });
  });

  it("uses FIELD_MAP_JSON aliases", () => {
    const env: Env = {
      FIELD_MAP_JSON: JSON.stringify({
        contact_person_email: ["E-mailadres"],
        name: ["Evenement"],
      }),
    };
    const result = mapSubmission(
      webhook({ Evenement: "Gala", "E-mailadres": "x@y.z" }),
      env,
      now,
    );
    expect(result.request?.name).toBe("Gala");
    expect(result.request?.contact_person_email).toBe("x@y.z");
  });

  it("builds a fallback project name", () => {
    const result = mapSubmission(
      webhook({ company: "dPro client", email: "x@y.z" }),
      {},
      now,
    );
    expect(result.request?.name).toBe("dPro client — Offerte");
  });

  it("maps French language values", () => {
    const result = mapSubmission(webhook({ langue: "Français" }), {}, now);
    expect(result.request?.language).toBe("fr");
  });

  it("always sets both planperiods when the form has no dates", () => {
    const result = mapSubmission(
      webhook({ email: "ada@example.com", message: "Hello" }),
      {},
      now,
    );
    expect(result.ignored).toBe(false);
    expect(result.request?.planperiod_start).toBe("2026-09-22T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-09-22T23:59:59Z");
    expect(result.request).not.toHaveProperty("usageperiod_start");
    expect(result.request).not.toHaveProperty("usageperiod_end");
  });

  it("derives the missing planperiod when only a start date is present", () => {
    const result = mapSubmission(
      webhook({ startdatum: "2026-10-01", email: "ada@example.com" }),
      {},
      now,
    );
    expect(result.request?.usageperiod_start).toBe("2026-10-01T00:00:00Z");
    expect(result.request).not.toHaveProperty("usageperiod_end");
    expect(result.request?.planperiod_start).toBe("2026-10-01T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-10-01T23:59:59Z");
  });

  it("derives the missing planperiod when only an end date is present", () => {
    const result = mapSubmission(
      webhook({ einddatum: "2026-10-03", email: "ada@example.com" }),
      {},
      now,
    );
    expect(result.request).not.toHaveProperty("usageperiod_start");
    expect(result.request?.usageperiod_end).toBe("2026-10-03T23:59:59Z");
    expect(result.request?.planperiod_start).toBe("2026-10-03T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-10-03T23:59:59Z");
  });

  it("copies both form dates onto usage and plan periods", () => {
    const result = mapSubmission(
      webhook({
        start: "2026-11-01",
        end: "2026-11-02",
      }),
      {},
      now,
    );
    expect(result.request?.usageperiod_start).toBe("2026-11-01T00:00:00Z");
    expect(result.request?.usageperiod_end).toBe("2026-11-02T23:59:59Z");
    expect(result.request?.planperiod_start).toBe("2026-11-01T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-11-02T23:59:59Z");
  });

  it("maps dPro Webflow numbered labels onto contact and brief fields", () => {
    const result = mapSubmission(
      webhook(
        {
          "First Name 4": "Thomas",
          "Last Name 4": "dPro",
          "Email 6": "thomas@dpro.test",
          "Message 7": "Need a quote for a gala",
        },
        "Contact",
      ),
      {},
      now,
    );
    expect(result.request?.contact_person_first_name).toBe("Thomas");
    expect(result.request?.contact_person_lastname).toBe("dPro");
    expect(result.request?.contact_person_email).toBe("thomas@dpro.test");
    expect(result.request?.remark).toContain("Brief:\nNeed a quote for a gala");
    expect(result.request?.name).toBe("Thomas dPro — Contact");
    expect(result.request?.planperiod_start).toBe("2026-09-22T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-09-22T23:59:59Z");
  });

  it("maps the live Contact Form payload with an empty First Name 4", () => {
    const result = mapSubmission(
      normalizeSubmission(liveFormSubmissionWebhook),
      {},
      now,
    );
    expect(result.ignored).toBe(false);
    expect(result.request?.contact_person_first_name).toBeUndefined();
    expect(result.request?.contact_person_lastname).toBe("nog");
    expect(result.request?.contact_person_email).toBe("contact@example.com");
    expect(result.request?.remark).toContain("Brief:\nnognog");
    expect(result.request?.name).toBe("nog — Contact Form");
    expect(result.request?.planperiod_start).toBe("2026-09-22T00:00:00Z");
    expect(result.request?.planperiod_end).toBe("2026-09-22T23:59:59Z");
    expect(result.request).not.toHaveProperty("usageperiod_start");
  });

  it("does not ignore Contact Form when allow-listed as Contact", () => {
    const result = mapSubmission(
      normalizeSubmission(liveFormSubmissionWebhook),
      { ALLOWED_FORM_NAMES: "Contact,Offerte" },
      now,
    );
    expect(result.ignored).toBe(false);
    expect(result.request?.contact_person_email).toBe("contact@example.com");
  });

  it("does not treat Designer website metadata as a honeypot", () => {
    const result = mapSubmission(
      normalizeSubmission({
        name: "Contact Form",
        website: "https://www.dpro.be",
        page: "https://www.dpro.be/contact",
        "Email 6": "ada@example.com",
        "Last Name 4": "Lovelace",
      }),
      { HONEYPOT_FIELD: "website" },
      now,
    );
    expect(result.ignored).toBe(false);
    expect(result.request?.contact_person_email).toBe("ada@example.com");
  });
});

describe("helpers", () => {
  it("matches Contact to Contact Form allow-list names", () => {
    expect(formNameAllowed("Contact Form", ["Contact", "Offerte"])).toBe(true);
    expect(formNameAllowed("Contact Form 2", ["Contact"])).toBe(true);
    expect(formNameAllowed("Newsletter", ["Contact"])).toBe(false);
    expect(formNameAllowed(null, ["Contact"])).toBe(false);
    expect(formNameAllowed("Contact", [])).toBe(true);
  });

  it("normalizes language aliases", () => {
    expect(normalizeLanguage("FR-BE", "nl")).toBe("fr");
    expect(normalizeLanguage("", "nl")).toBe("nl");
    expect(normalizeLanguage("nope", "en")).toBe("en");
  });

  it("parses dates to ISO", () => {
    expect(toIsoDateTime("2026-10-01", false)).toBe("2026-10-01T00:00:00Z");
    expect(toIsoDateTime("2026-10-01T18:30", true)).toBe("2026-10-01T18:30:00Z");
    expect(toIsoDateTime("not-a-date", false)).toBeUndefined();
  });

  it("resolves planperiod defaults and one-sided dates", () => {
    expect(resolvePlanPeriods(undefined, undefined, now)).toEqual({
      start: "2026-09-22T00:00:00Z",
      end: "2026-09-22T23:59:59Z",
    });
    expect(
      resolvePlanPeriods("2026-10-01T18:30:00Z", undefined, now),
    ).toEqual({
      start: "2026-10-01T18:30:00Z",
      end: "2026-10-01T23:59:59Z",
    });
    expect(
      resolvePlanPeriods(undefined, "2026-10-03T12:00:00Z", now),
    ).toEqual({
      start: "2026-10-03T00:00:00Z",
      end: "2026-10-03T12:00:00Z",
    });
    expect(
      resolvePlanPeriods("2026-10-01T00:00:00Z", "2026-10-03T23:59:59Z", now),
    ).toEqual({
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-03T23:59:59Z",
    });
  });

  it("always includes a raw dump in the remark", () => {
    const remark = buildRemark(
      {
        name: "",
        contact_name: "",
        contact_person_first_name: "",
        contact_person_lastname: "",
        contact_person_email: "",
        contact_phone: "",
        location_name: "",
        usageperiod_start: "",
        usageperiod_end: "",
        language: "",
        brief: "",
        type: "",
        material: "",
      },
      {
        source: "flat_json",
        formName: null,
        submittedAt: null,
        siteId: null,
        localeId: null,
        submissionId: null,
        fields: { foo: "bar" },
      },
    );
    expect(remark).toContain("foo: bar");
  });

  it("merges env alias lists over defaults", () => {
    const map = resolveFieldMap({ FIELD_NAME: "evenement" });
    expect(map.name).toEqual(["evenement"]);
    expect(map.contact_person_email).toContain("email");
  });
});
