import { describe, expect, it } from "vitest";
import {
  authorizeRequest,
  hmacSha256Hex,
  timingSafeEqualString,
  verifyWebflowSignature,
} from "../src/verify.ts";

const now = () => 1_722_370_035_277;

describe("verifyWebflowSignature", () => {
  it("accepts a valid HMAC over timestamp:rawBody", async () => {
    const body = '{"triggerType":"form_submission"}';
    const timestamp = String(now());
    const secret = "webhook-secret";
    const signature = await hmacSha256Hex(secret, `${timestamp}:${body}`);
    await expect(
      verifyWebflowSignature(secret, timestamp, body, signature, now),
    ).resolves.toBe(true);
  });

  it("rejects a stale timestamp", async () => {
    const body = "{}";
    const timestamp = String(now() - 6 * 60 * 1000);
    const signature = await hmacSha256Hex("s", `${timestamp}:${body}`);
    await expect(
      verifyWebflowSignature("s", timestamp, body, signature, now),
    ).resolves.toBe(false);
  });
});

describe("authorizeRequest", () => {
  it("allows unsigned traffic when no secret is configured", async () => {
    const request = new Request("http://bridge.test/", { method: "POST" });
    const result = await authorizeRequest(request, "{}", undefined, now);
    expect(result).toMatchObject({ ok: true, mode: "none", hmacAttempted: false });
  });

  it("verifies Webflow headers when present", async () => {
    const body = '{"ok":true}';
    const timestamp = String(now());
    const signature = await hmacSha256Hex("wf", `${timestamp}:${body}`);
    const request = new Request("http://bridge.test/", {
      method: "POST",
      headers: {
        "x-webflow-timestamp": timestamp,
        "x-webflow-signature": signature,
      },
    });
    const result = await authorizeRequest(request, body, "wf", now);
    expect(result).toMatchObject({ ok: true, mode: "webflow_hmac", hmacAttempted: true });
  });

  it("accepts a shared secret header for dashboard / form POST", async () => {
    const request = new Request("http://bridge.test/", {
      method: "POST",
      headers: { "X-Webhook-Secret": "shared" },
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result).toMatchObject({ ok: true, mode: "shared_secret", hmacAttempted: false });
  });

  it("accepts ?secret= for Webflow dashboard webhook URLs", async () => {
    const request = new Request("http://bridge.test/?secret=shared", {
      method: "POST",
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result.ok).toBe(true);
  });

  it("accepts a case-variant Secret= query param", async () => {
    const request = new Request("http://bridge.test/?Secret=shared", {
      method: "POST",
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result.ok).toBe(true);
  });

  it("trims the configured secret", async () => {
    const request = new Request("http://bridge.test/?secret=shared", {
      method: "POST",
    });
    const result = await authorizeRequest(request, "{}", "shared\n", now);
    expect(result.ok).toBe(true);
  });

  it("falls back to ?secret= when HMAC headers are present but invalid", async () => {
    const request = new Request("http://bridge.test/?secret=shared", {
      method: "POST",
      headers: {
        "x-webflow-timestamp": String(now()),
        "x-webflow-signature": "deadbeef",
      },
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result).toMatchObject({
      ok: true,
      mode: "shared_secret",
      hmacAttempted: true,
      hmacFailedReason: "invalid_signature",
    });
  });

  it("returns invalid_signature when HMAC fails and no shared secret is sent", async () => {
    const request = new Request("http://bridge.test/", {
      method: "POST",
      headers: {
        "x-webflow-timestamp": String(now()),
        "x-webflow-signature": "deadbeef",
      },
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("invalid_signature");
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("reports missing_secret vs secret_mismatch", async () => {
    const missing = await authorizeRequest(
      new Request("http://bridge.test/", { method: "POST" }),
      "{}",
      "shared",
      now,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("missing_secret");

    const mismatch = await authorizeRequest(
      new Request("http://bridge.test/?secret=nope", { method: "POST" }),
      "{}",
      "shared",
      now,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe("secret_mismatch");
  });

  it("rejects a wrong secret", async () => {
    const request = new Request("http://bridge.test/", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    const result = await authorizeRequest(request, "{}", "shared", now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("timingSafeEqualString", () => {
  it("compares equal strings", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
  });
});
