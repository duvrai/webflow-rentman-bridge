import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/handler.ts";
import { hmacSha256Hex } from "../src/verify.ts";
import type { Env, HandlerDeps } from "../src/types.ts";

const now = () => Date.parse("2026-09-22T10:00:00.000Z");

function deps(fetchImpl: typeof fetch = vi.fn()): HandlerDeps {
  return {
    fetch: fetchImpl,
    now,
    randomId: () => "req-1",
  };
}

function env(overrides: Env = {}): Env {
  return {
    DRY_RUN: "false",
    HONEYPOT_FIELD: "website",
    DEFAULT_LANGUAGE: "nl",
    ...overrides,
  };
}

async function post(
  body: unknown,
  init: { env?: Env; fetch?: typeof fetch; headers?: HeadersInit; url?: string } = {},
): Promise<Response> {
  const request = new Request(init.url ?? "http://bridge.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleRequest(request, env(init.env), deps(init.fetch));
}

describe("handleRequest", () => {
  it("returns health JSON on GET /", async () => {
    const response = await handleRequest(
      new Request("http://bridge.test/", { method: "GET" }),
      env({ RENTMAN_API_TOKEN: "tok" }),
      deps(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      service: "webflow-rentman-bridge",
      rentmanConfigured: true,
      dryRun: false,
    });
  });

  it("ignores honeypot submissions with 200 and does not call Rentman", async () => {
    const fetchImpl = vi.fn();
    const response = await post(
      {
        triggerType: "form_submission",
        payload: {
          name: "Contact",
          data: { email: "a@b.c", website: "http://bots.test" },
        },
      },
      { fetch: fetchImpl, env: { RENTMAN_API_TOKEN: "tok" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      reason: "honeypot",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dry-runs the mapped Rentman body without calling the API", async () => {
    const fetchImpl = vi.fn();
    const response = await post(
      {
        triggerType: "form_submission",
        payload: {
          name: "Contact",
          data: {
            project: "Gala",
            email: "ada@example.com",
            message: "Need lights",
          },
        },
      },
      { fetch: fetchImpl, env: { DRY_RUN: "true" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      dryRun: boolean;
      rentman: { name: string; linked_contact: null; remark: string };
    };
    expect(body.dryRun).toBe(true);
    expect(body.rentman.name).toBe("Gala");
    expect(body.rentman.linked_contact).toBeNull();
    expect(body.rentman.remark).toContain("Need lights");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs a project request to Rentman and returns the id", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 42 } }), { status: 201 }),
    );
    const response = await post(
      {
        company: "Acme",
        email: "ops@acme.test",
        project: "Corporate gala",
      },
      { fetch: fetchImpl, env: { RENTMAN_API_TOKEN: "tok_live" } },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      rentmanId: 42,
      name: "Corporate gala",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.rentman.net/projectrequests");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok_live",
    );
    const sent = JSON.parse(String(init.body));
    expect(sent.linked_contact).toBeNull();
    expect(sent.contact_person_email).toBe("ops@acme.test");
    expect(sent).not.toHaveProperty("projectequipment");
  });

  it("returns 502 when Rentman fails, without leaking the token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      new Response("nope Authorization: Bearer tok_live", { status: 500 }),
    );
    const response = await post(
      { email: "a@b.c" },
      { fetch: fetchImpl, env: { RENTMAN_API_TOKEN: "tok_live" } },
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: "rentman_error" });
    expect(JSON.stringify(body)).not.toContain("tok_live");
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain("rentman_error");
    expect(logged).not.toContain("tok_live");
    error.mockRestore();
  });

  it("returns 401 when the shared secret is wrong", async () => {
    const response = await post(
      { email: "a@b.c" },
      { env: { WEBHOOK_SECRET: "correct" }, headers: { "X-Webhook-Secret": "wrong" } },
    );
    expect(response.status).toBe(401);
  });

  it("accepts a valid Webflow HMAC", async () => {
    const body = JSON.stringify({ email: "a@b.c", project: "Show" });
    const timestamp = String(now());
    const signature = await hmacSha256Hex("wf-secret", `${timestamp}:${body}`);
    const fetchImpl = vi.fn();
    const response = await handleRequest(
      new Request("http://bridge.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webflow-timestamp": timestamp,
          "x-webflow-signature": signature,
        },
        body,
      }),
      env({ WEBHOOK_SECRET: "wf-secret", DRY_RUN: "true" }),
      deps(fetchImpl),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { dryRun: boolean }).dryRun).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const response = await post("{", {
      env: { DRY_RUN: "true" },
    });
    expect(response.status).toBe(400);
  });

  it("returns 500 when Rentman is not configured and dry-run is off", async () => {
    const response = await post({ email: "a@b.c" }, { env: { DRY_RUN: "false" } });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "not_configured" });
  });

  it("accepts application/x-www-form-urlencoded form POSTs", async () => {
    const request = new Request("http://bridge.test/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=Club+night&email=booker%40venue.test&website=",
    });
    const response = await handleRequest(
      request,
      env({ DRY_RUN: "true" }),
      deps(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rentman: { name: string } };
    expect(body.rentman.name).toBe("Club night");
  });
});
