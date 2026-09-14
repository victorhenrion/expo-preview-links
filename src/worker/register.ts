/**
 * POST /api/register -- the only write in the system.
 *
 * The addressing rule, which is the whole security model in one sentence:
 * owner, repo and branch come from the VERIFIED OIDC CLAIMS, never from the
 * request body. The body supplies build descriptors and display-only metadata.
 * Without this, any repo that can authenticate could overwrite any other
 * repo's permalinks.
 */

import { normalizeRef, RefError } from "../shared/ref.js";
import {
  type BuildPointer,
  isPlatform,
  type Platform,
  type RegisterBuild,
  type RegisterRequest,
} from "../shared/types.js";
import { putPointer } from "./kv.js";
import {
  assertRepoBinding,
  OidcError,
  ownerRepoFromClaims,
  refFromClaims,
  verifyCiToken,
} from "./oidc.js";

const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

class BadRequest extends Error {}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new BadRequest(`${field} must be a string of 1..${max} characters`);
  }
  return v;
}

function parseBuild(raw: unknown, index: number): RegisterBuild {
  if (typeof raw !== "object" || raw === null)
    throw new BadRequest(`builds[${index}] is not an object`);
  const b = raw as Record<string, unknown>;

  if (!isPlatform(b.platform))
    throw new BadRequest(`builds[${index}].platform must be ios or android`);

  const buildId = str(b.buildId, `builds[${index}].buildId`, 64);
  if (!UUID_RE.test(buildId)) throw new BadRequest(`builds[${index}].buildId must be a uuid`);

  const appId = str(b.appId, `builds[${index}].appId`, 64);
  if (!UUID_RE.test(appId)) throw new BadRequest(`builds[${index}].appId must be a uuid`);

  const build: RegisterBuild = {
    platform: b.platform,
    buildId,
    appId,
    account: str(b.account, `builds[${index}].account`, 100),
    slug: str(b.slug, `builds[${index}].slug`, 100),
    profile: str(b.profile, `builds[${index}].profile`, 100),
  };
  if (typeof b.appVersion === "string" && b.appVersion.length <= 64) {
    build.appVersion = b.appVersion;
  }
  return build;
}

function parseBody(raw: unknown): RegisterRequest {
  if (typeof raw !== "object" || raw === null) throw new BadRequest("body must be a JSON object");
  const body = raw as Record<string, unknown>;

  if (!Array.isArray(body.builds) || body.builds.length === 0 || body.builds.length > 8) {
    throw new BadRequest("builds must be an array of 1..8 entries");
  }

  const builds = body.builds.map(parseBuild);

  const seen = new Set<Platform>();
  for (const b of builds) {
    if (seen.has(b.platform)) throw new BadRequest(`duplicate platform ${b.platform}`);
    seen.add(b.platform);
  }

  const out: RegisterRequest = { builds };

  // Display-only fields: shape-validated, never used for addressing or auth.
  if (typeof body.prNumber === "number" && Number.isInteger(body.prNumber) && body.prNumber > 0) {
    out.prNumber = body.prNumber;
  }
  if (typeof body.commitSha === "string" && SHA_RE.test(body.commitSha)) {
    out.commitSha = body.commitSha;
  }
  if (typeof body.message === "string") {
    out.message = body.message.slice(0, 300);
  }

  return out;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token) {
    await env.RL_BADAUTH.limit({ key: "missing-token" });
    return json({ error: "unauthorized", reason: "missing_bearer_token" }, 401);
  }

  let claims: Awaited<ReturnType<typeof verifyCiToken>>;
  let owner: string;
  let repo: string;
  let ref: string;

  try {
    claims = await verifyCiToken(token, request, env);
    ({ owner, repo } = ownerRepoFromClaims(claims));
    ref = normalizeRef(refFromClaims(claims));
    await assertRepoBinding(env, owner, repo, claims);
  } catch (err) {
    if (err instanceof OidcError) {
      await env.RL_BADAUTH.limit({ key: err.reason });
      return json({ error: err.reason, message: err.message }, err.status);
    }
    if (err instanceof RefError) {
      return json({ error: "invalid_ref", message: err.message }, 400);
    }
    console.error("register auth failed", err);
    return json({ error: "internal_error" }, 500);
  }

  // Per-repo and unforgeable: repository_id comes from the signed token.
  const { success } = await env.RL_REGISTER.limit({ key: `repo:${claims.repository_id}` });
  if (!success) return json({ error: "rate_limited" }, 429);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);

  let body: RegisterRequest;
  try {
    body = parseBody(JSON.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON";
    return json({ error: "bad_request", message }, 400);
  }

  const registeredAt = new Date().toISOString();
  const origin = new URL(request.url).origin;
  const registered: Array<{ platform: Platform; url: string }> = [];

  for (const build of body.builds) {
    const pointer: BuildPointer = {
      v: 1,
      buildId: build.buildId,
      appId: build.appId,
      account: build.account,
      slug: build.slug,
      platform: build.platform,
      ref,
      sha: body.commitSha ?? claims.sha ?? "",
      profile: build.profile,
      registeredAt,
      status: "building",
    };
    if (body.prNumber !== undefined) pointer.prNumber = body.prNumber;
    if (body.message !== undefined) pointer.message = body.message;
    if (build.appVersion !== undefined) pointer.appVersion = build.appVersion;

    await putPointer(env, owner, repo, ref, build.platform, pointer);

    const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
    registered.push({
      platform: build.platform,
      url: `${origin}/${owner.toLowerCase()}/${repo.toLowerCase()}/${encodedRef}/${build.platform}`,
    });
  }

  return json({ ok: true, repository: claims.repository, ref, registered }, 200);
}
