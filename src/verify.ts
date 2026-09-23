const MAX_SKEW_MS = 5 * 60 * 1000;

export type AuthResult =
  | { ok: true; mode: "none" | "webflow_hmac" | "shared_secret" }
  | { ok: false; status: 401; error: string; message: string };

export async function authorizeRequest(
  request: Request,
  rawBody: string,
  secret: string | undefined,
  now = () => Date.now(),
): Promise<AuthResult> {
  if (!secret) {
    return { ok: true, mode: "none" };
  }

  const signature = header(request, "x-webflow-signature");
  const timestamp = header(request, "x-webflow-timestamp");

  if (signature && timestamp) {
    const valid = await verifyWebflowSignature(secret, timestamp, rawBody, signature, now);
    if (!valid) {
      return {
        ok: false,
        status: 401,
        error: "invalid_signature",
        message: "Webflow webhook signature or timestamp is invalid.",
      };
    }
    return { ok: true, mode: "webflow_hmac" };
  }

  const provided = sharedSecretFromRequest(request);
  if (!provided || !timingSafeEqualString(provided, secret)) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message:
        "Missing or invalid shared secret. Send X-Webhook-Secret, Authorization: Bearer, or ?secret=.",
    };
  }
  return { ok: true, mode: "shared_secret" };
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

  const url = new URL(request.url);
  return url.searchParams.get("secret") ?? url.searchParams.get("token");
}

export async function verifyWebflowSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedSignature: string,
  now = () => Date.now(),
): Promise<boolean> {
  const requestTimestamp = Number(timestamp);
  if (!Number.isFinite(requestTimestamp)) return false;
  if (Math.abs(now() - requestTimestamp) > MAX_SKEW_MS) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}:${rawBody}`);
  return timingSafeEqualString(expected, providedSignature.trim().toLowerCase());
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
