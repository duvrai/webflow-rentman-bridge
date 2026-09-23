import { describe, expect, it } from "vitest";
import {
  extractFields,
  fieldsFromRecord,
  looksLikeUrlEncoded,
  normalizeLookupKey,
  normalizeSubmission,
  parseUrlEncoded,
  stripTrailingFieldIndex,
} from "../src/payload.ts";
import {
  designerUrlEncoded,
  designerWebhookFlat,
  designerWebhookNested,
  liveFormSubmissionFormData,
  liveFormSubmissionWebhook,
} from "./fixtures/webflow-contact-form.ts";

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

  it("reads the live dPro form_submission webhook (empty First Name 4)", () => {
    const result = normalizeSubmission(liveFormSubmissionWebhook);
    expect(result.source).toBe("webflow_webhook");
    expect(result.formName).toBe("Contact Form");
    expect(result.siteId).toBe("6aa2b75583025ce11f7084ee");
    expect(result.fields["First Name 4"]).toBe("");
    expect(result.fields["Last Name 4"]).toBe("nog");
    expect(result.fields["Email 6"]).toBe("contact@example.com");
    expect(result.fields["Message 7"]).toBe("nognog");
  });

  it("reads payload.formData when data is absent", () => {
    const result = normalizeSubmission(liveFormSubmissionFormData);
    expect(result.source).toBe("webflow_webhook");
    expect(result.fields["Email 6"]).toBe("contact@example.com");
    expect(result.siteId).toBe("6aa2b75583025ce11f7084ee");
  });

  it("reads a Designer form webhook with nested data and no formId", () => {
    const result = normalizeSubmission(designerWebhookNested);
    expect(result.source).toBe("webflow_webhook");
    expect(result.formName).toBe("Contact Form");
    expect(result.fields["Last Name 4"]).toBe("nog");
    expect(result.fields.website).toBeUndefined();
  });

  it("reads a Designer flat POST and does not treat website as a form field", () => {
    const result = normalizeSubmission(designerWebhookFlat);
    expect(result.source).toBe("webflow_webhook");
    expect(result.formName).toBe("Contact Form");
    expect(result.fields["Email 6"]).toBe("contact@example.com");
    expect(result.fields.website).toBeUndefined();
    expect(result.fields.page).toBeUndefined();
    expect(result.fields.name).toBeUndefined();
  });

  it("reads Logic-style field arrays and { value } wrappers", () => {
    const result = normalizeSubmission({
      triggerType: "form_submission",
      payload: {
        name: "Contact Form",
        fields: [
          { name: "Email 6", value: "ada@example.com" },
          { label: "Message 7", text: "hello" },
        ],
      },
    });
    expect(result.fields["Email 6"]).toBe("ada@example.com");
    expect(result.fields["Message 7"]).toBe("hello");
  });

  it("unwraps a stringified payload object", () => {
    const result = normalizeSubmission({
      triggerType: "form_submission",
      payload: JSON.stringify({
        name: "Contact Form",
        data: { "Email 6": "ada@example.com" },
      }),
    });
    expect(result.formName).toBe("Contact Form");
    expect(result.fields["Email 6"]).toBe("ada@example.com");
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

  it("parses the live Designer field names from a form body", () => {
    const fields = parseUrlEncoded(designerUrlEncoded);
    expect(fields["first-name-4"]).toBe("");
    expect(fields["last-name-4"]).toBe("nog");
    expect(fields["email-6"]).toBe("contact@example.com");
    expect(fields["message-7"]).toBe("nognog");
  });
});

describe("helpers", () => {
  it("normalizes labels with spaces, accents, and punctuation", () => {
    expect(normalizeLookupKey("Prénom")).toBe("prenom");
    expect(normalizeLookupKey("First Name")).toBe("first_name");
    expect(normalizeLookupKey("e-mail")).toBe("e_mail");
    expect(normalizeLookupKey("First Name 4")).toBe("first_name_4");
    expect(stripTrailingFieldIndex("first_name_4")).toBe("first_name");
    expect(stripTrailingFieldIndex("email_6")).toBe("email");
    expect(stripTrailingFieldIndex("message_7")).toBe("message");
  });

  it("stringifies nested field values", () => {
    expect(fieldsFromRecord({ tags: ["a", "b"], n: 3 }).tags).toBe("a, b");
    expect(extractFields([{ name: "email", value: "a@b.c" }]).email).toBe("a@b.c");
    expect(looksLikeUrlEncoded(designerUrlEncoded)).toBe(true);
    expect(looksLikeUrlEncoded('{"email":"a@b.c"}')).toBe(false);
  });
});
