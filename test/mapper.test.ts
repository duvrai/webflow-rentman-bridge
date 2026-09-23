import { describe, expect, it } from "vitest";
import { resolveFieldMap } from "../src/config.ts";
import {
  buildRemark,
  mapSubmission,
  normalizeLanguage,
  toIsoDateTime,
} from "../src/mapper.ts";
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
});

describe("helpers", () => {
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
