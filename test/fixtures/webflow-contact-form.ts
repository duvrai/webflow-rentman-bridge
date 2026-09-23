/**
 * Realistic Webflow payloads for the live dPro Contact Form.
 * Field labels match the 2026-09-23 notification email / Designer data-names.
 * No secrets.
 */

export const LIVE_FORM_NAME = "Contact Form";

/** Matches the live notification: empty First Name 4, Last Name 4, Email 6, Message 7. */
export const liveContactFields = {
  "First Name 4": "",
  "Last Name 4": "nog",
  "Email 6": "contact@example.com",
  "Message 7": "nognog",
};

/** Documented site webhook (Apps & integrations / API V2). */
export const liveFormSubmissionWebhook = {
  triggerType: "form_submission",
  payload: {
    name: LIVE_FORM_NAME,
    siteId: "6aa2b75583025ce11f7084ee",
    data: liveContactFields,
    schema: [
      { fieldName: "First Name 4", fieldType: "FormTextInput" },
      { fieldName: "Last Name 4", fieldType: "FormTextInput" },
      { fieldName: "Email 6", fieldType: "FormTextInput" },
      { fieldName: "Message 7", fieldType: "FormTextInput" },
    ],
    submittedAt: "2026-09-23T19:19:00.000Z",
    id: "68d2live0000000000000001",
    formId: "dfdf35b5f5ab63aaaff1fc92",
    formElementId: "dfdf35b5-f5ab-63aa-aff1-fc9237b5b039",
    localeId: null,
  },
};

/** Variant some senders use: formData instead of data. */
export const liveFormSubmissionFormData = {
  triggerType: "form_submission",
  payload: {
    name: LIVE_FORM_NAME,
    site: { id: "6aa2b75583025ce11f7084ee", name: "dPro" },
    submittedAt: "2026-09-23T19:19:00.000Z",
    formData: liveContactFields,
  },
};

/** Designer “Form webhook URL” — nested data, no formId/siteId. */
export const designerWebhookNested = {
  name: LIVE_FORM_NAME,
  site: "dPro",
  page: "https://www.dpro.be/contact",
  website: "https://www.dpro.be",
  data: liveContactFields,
};

/** Designer “Form webhook URL” — flat fields + envelope meta (website must not honeypot). */
export const designerWebhookFlat = {
  name: LIVE_FORM_NAME,
  site: "dPro",
  page: "https://www.dpro.be/contact",
  website: "https://www.dpro.be",
  ...liveContactFields,
};

/** HTML name attributes from the published contact form. */
export const designerUrlEncoded =
  "first-name-4=&last-name-4=nog&email-6=contact%40example.com&message-7=nognog";
