/**
 * Optional permalink gating (GATING_MODE=signed).
 *
 * The default is "public", which matches how Expo itself treats internal
 * distribution builds -- their install URLs are available to anybody who has
 * the URL. Gating only this Worker while the underlying artifact URL stays
 * open buys very little, and it breaks the one-tap PR comment flow, so it is
 * opt-in rather than default.
 *
 * When enabled, a permalink must carry `?t=<expiryEpochSeconds>.<base64url hmac>`.
 * The Action signs the links it puts in the comment and re-signs them on every
 * rewrite, so a link stays valid as long as the PR is active.
 */

const encoder = new TextEncoder();

function base64UrlEncode(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Sign `<path>` (no query) until `expiry`. Exported for tests and tooling. */
export async function signPermalink(
  pathname: string,
  expiryEpochSeconds: number,
  secret: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${expiryEpochSeconds}:${pathname}`),
  );
  return `${expiryEpochSeconds}.${base64UrlEncode(mac)}`;
}

/** Constant-time-ish comparison. Lengths are public, contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignedPermalink(request: Request, env: Env): Promise<boolean> {
  const secret = env.PERMALINK_HMAC_SECRET;
  if (!secret) {
    // Fail CLOSED: GATING_MODE says links are gated, so a missing secret must
    // not silently serve everything to everyone.
    console.error("GATING_MODE=signed but PERMALINK_HMAC_SECRET is not set");
    return false;
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  if (!token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const expiry = Number(token.slice(0, dot));
  if (!Number.isInteger(expiry) || expiry * 1000 <= Date.now()) return false;

  // Sign the canonical permalink path, so /ios, /ios/artifact and /ios.json
  // all verify against the same signature the comment carries.
  const canonical = url.pathname
    .replace(/\/(artifact|qr\.png|qr\.svg)$/, "")
    .replace(/\.json$/, "");
  const expected = await signPermalink(canonical, expiry, secret);
  return timingSafeEqual(token, expected);
}
