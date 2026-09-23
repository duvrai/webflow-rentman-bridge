import { describe, expect, it } from "vitest";
import {
  fieldsFromRecord,
  normalizeLookupKey,
  normalizeSubmission,
  parseUrlEncoded,
} from "../src/payload.ts";

const webhook = {
  triggerType: "form_submission",
  payload: {
    name: "Contact Us",
    siteId: "65427cf400e02b306eaa049c",
    data: {
      "First Name": "Zaphod",
      "Last Name": "Beeblebrox",
      email: "zaphod@heartofgold.ai",
      "Phone Number": 15550000000,
    },
    submittedAt: "2022-09-14T12:35:16.117Z",
    id: "6321ca84df3949bfc6752327",
    formId: "65429eadebe8a9f3a30f62d0",
    localeId: null,
  },
};

const dataApi = {
  id: "6321ca84df3949bfc6752327",
  displayName: "Sample Form",
  siteId: "62749158efef318abc8d5a0f",
  dateSubmitted: "2022-09-14T12:35:16.117Z",
  formResponse: {
    "First Name": "Arthur",
    "Last Name": "Dent",
    email: "arthur@example.com",
  },
  localeId: null,
};

describe("normalizeSubmission", () => {
  it("reads native Webflow form_submission webhooks", () => {
    const result = normalizeSubmission(webhook);
    expect(result.source).toBe("webflow_webhook");
    expect(result.formName).toBe("Contact Us");
    expect(result.fields.email).toBe("zaphod@heartofgold.ai");
    expect(result.fields["Phone Number"]).toBe("15550000000");
    expect(result.submissionId).toBe("6321ca84df3949bfc6752327");
  });

  it("reads Data API form_submission objects (formResponse)", () => {
    const result = normalizeSubmission(dataApi);
    expect(result.source).toBe("webflow_data_api");
    expect(result.formName).toBe("Sample Form");
    expect(result.fields["First Name"]).toBe("Arthur");
    expect(result.submittedAt).toBe("2022-09-14T12:35:16.117Z");
  });

  it("reads a payload-only webhook body", () => {
    const result = normalizeSubmission(webhook.payload);
    expect(result.source).toBe("webflow_webhook");
    expect(result.fields["First Name"]).toBe("Zaphod");
  });

  it("reads a flat JSON object of form fields", () => {
    const result = normalizeSubmission({
      email: "a@b.c",
      company: "Acme",
    });
    expect(result.source).toBe("flat_json");
    expect(result.fields.company).toBe("Acme");
  });
});

describe("parseUrlEncoded", () => {
  it("parses native form POST bodies", () => {
    const fields = parseUrlEncoded(
      "voornaam=Ada&email=ada%40example.com&website=",
    );
    expect(fields.voornaam).toBe("Ada");
    expect(fields.email).toBe("ada@example.com");
    expect(fields.website).toBe("");
  });
});

describe("helpers", () => {
  it("normalizes labels with spaces, accents, and punctuation", () => {
    expect(normalizeLookupKey("Prénom")).toBe("prenom");
    expect(normalizeLookupKey("First Name")).toBe("first_name");
    expect(normalizeLookupKey("e-mail")).toBe("e_mail");
  });

  it("stringifies nested field values", () => {
    expect(fieldsFromRecord({ tags: ["a", "b"], n: 3 }).tags).toBe("a, b");
  });
});
