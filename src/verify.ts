const MAX_SKEW_MS = 5 * 60 * 1000;

export type AuthMode = "none" | "webflow_hmac" | "shared_secret";

export type AuthFailReason =
  | "missing_secret"
  | "secret_mismatch"
  | "invalid_signature"
  | "stale_timestamp";

export type AuthResult =
  | {
      ok: true;
      mode: AuthMode;
      hmacAttempted: boolean;
      hmacFailedReason?: AuthFailReason;
    }
  | {
      ok: false;
      status: 401;
      error: "unauthorized" | "invalid_signature";
      message: string;
      reason: AuthFailReason;
      hmacAttempted: boolean;
    };

export async function authorizeRequest(
  request: Request,
  rawBody: string,
  secret: string | undefined,
  now = () => Date.now(),
): Promise<AuthResult> {
  const expected = secret?.trim() ?? "";
  if (!expected) {
    return { ok: true, mode: "none", hmacAttempted: false };
  }

  const signature = header(request, "x-webflow-signature");
  const timestamp = header(request, "x-webflow-timestamp");
  let hmacAttempted = false;
  let hmacFailedReason: AuthFailReason | undefined;

  if (signature && timestamp) {
    hmacAttempted = true;
    const hmac = await verifyWebflowSignatureDetailed(
      expected,
      timestamp,
      rawBody,
      signature,
      now,
    );
    if (hmac.ok) {
      return { ok: true, mode: "webflow_hmac", hmacAttempted: true };
    }
    hmacFailedReason = hmac.reason;
  }

  const provided = sharedSecretFromRequest(request);
  if (provided && timingSafeEqualString(provided, expected)) {
    return {
      ok: true,
      mode: "shared_secret",
      hmacAttempted,
      hmacFailedReason,
    };
  }

  if (hmacAttempted && hmacFailedReason) {
    const usedQueryOrHeader = Boolean(provided);
    if (!usedQueryOrHeader) {
      return {
        ok: false,
        status: 401,
        error: "invalid_signature",
        message:
          hmacFailedReason === "stale_timestamp"
            ? "Webflow webhook timestamp is outside the 5-minute window."
            : "Webflow webhook signature is invalid.",
        reason: hmacFailedReason,
        hmacAttempted: true,
      };
    }
  }

  return {
    ok: false,
    status: 401,
    error: "unauthorized",
    message:
      "Missing or invalid shared secret. Send X-Webhook-Secret, Authorization: Bearer, or ?secret=.",
    reason: provided ? "secret_mismatch" : "missing_secret",
    hmacAttempted,
  };
}

export function sharedSecretFromRequest(request: Request): string | null {
  const headerSecret = header(request, "x-webhook-secret");
  if (headerSecret) return headerSecret;

  const authorization = header(request, "authorization");
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
    return authorization.trim();
  }

  return querySecret(new URL(request.url));
}

/** Prefer the literal `secret=` query param; accept case variants and `token=`. */
export function querySecret(url: URL): string | null {
  const exact = url.searchParams.get("secret");
  if (exact != null) return exact;

  for (const [key, value] of url.searchParams.entries()) {
    if (key.toLowerCase() === "secret") return value;
  }

  return url.searchParams.get("token");
}

export async function verifyWebflowSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedSignature: string,
  now = () => Date.now(),
): Promise<boolean> {
  const result = await verifyWebflowSignatureDetailed(
    secret,
    timestamp,
    rawBody,
    providedSignature,
    now,
  );
  return result.ok;
}

export async function verifyWebflowSignatureDetailed(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedSignature: string,
  now = () => Date.now(),
): Promise<{ ok: true } | { ok: false; reason: AuthFailReason }> {
  const requestTimestamp = parseWebhookTimestamp(timestamp);
  if (requestTimestamp == null) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (Math.abs(now() - requestTimestamp) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  // Webflow signs `${timestamp}:${rawBody}` using the header value as-is.
  const expected = await hmacSha256Hex(secret, `${timestamp}:${rawBody}`);
  if (!timingSafeEqualString(expected, providedSignature.trim().toLowerCase())) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

/** Webflow documents milliseconds; some senders emit Unix seconds. */
export function parseWebhookTimestamp(timestamp: string): number | null {
  const raw = Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) {
    // Compare anyway so runtime does not short-circuit on length alone.
    let acc = left.length ^ right.length;
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i += 1) {
      acc |= (left[i] ?? 0) ^ (right[i] ?? 0);
    }
    return acc === 0;
  }
  let acc = 0;
  for (let i = 0; i < left.length; i += 1) {
    acc |= left[i] ^ right[i];
  }
  return acc === 0;
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
