/**
 * GitHub OIDC verification and the trust-on-first-use repo binding.
 * This is the entire write-side security model.
 *
 * THE RULE: a valid signature is AUTHENTICATION, not AUTHORIZATION. Any repo
 * on GitHub can mint a token signed by token.actions.githubusercontent.com
 * with our audience. What makes a token authorised to write to
 * `<owner>/<repo>` is the binding below, not the signature.
 *
 * Why OIDC and not a shared secret: on a pull_request run from a FORK, GitHub
 * caps `id-token` at `read`, so a fork cannot mint a token at all. That makes
 * fork-safety structural rather than conventional -- and it means a consuming
 * repo stores no secret for the Worker, only the EXPO_TOKEN it needs anyway.
 */

import type { JWTPayload } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { bindingKey } from "../shared/ref.js";
import type { RepoBinding } from "../shared/types.js";
import { getBinding, putBinding } from "./kv.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = new URL(`${ISSUER}/.well-known/jwks`);

export interface GhOidcClaims extends JWTPayload {
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  repository_visibility?: string;
  ref?: string;
  ref_type?: string;
  sha?: string;
  head_ref?: string;
  base_ref?: string;
  event_name?: string;
  workflow_ref?: string;
  job_workflow_ref?: string;
  runner_environment?: string;
  actor?: string;
  run_id?: string;
}

export class OidcError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message?: string) {
    super(message ?? reason);
    this.name = "OidcError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Module scope in Workers means PER ISOLATE, so this is a warm-isolate cache
 * rather than a global one. The customFetch hook additionally pins the JWKS
 * response in Cloudflare's own cache, so a burst of cold isolates does not turn
 * into a burst of requests to GitHub.
 */
const jwks = createRemoteJWKSet(JWKS_URL, {
  cacheMaxAge: 600_000,
  cooldownDuration: 30_000,
  timeoutDuration: 5_000,
  [Symbol.for("jose.customFetch")]: (input: string, init?: RequestInit) =>
    fetch(input, {
      ...init,
      cf: { cacheTtl: 600, cacheEverything: true },
    } as RequestInit),
});

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function expectedAudience(request: Request, env: Env): string {
  // Deriving the audience from our own origin means there is nothing to
  // configure: the check exists only to stop a token minted for someone
  // else's Worker being replayed at ours. On Cloudflare, request.url reflects
  // the hostname the request actually arrived on, so it cannot be spoofed by
  // a Host header.
  if (env.OIDC_AUDIENCE) return stripTrailingSlash(env.OIDC_AUDIENCE);
  return stripTrailingSlash(new URL(request.url).origin);
}

const ALLOWED_EVENTS = new Set(["pull_request", "push", "workflow_dispatch", "merge_group"]);

/** Verify the bearer token and apply every policy check. Throws OidcError. */
export async function verifyCiToken(
  jwt: string,
  request: Request,
  env: Env,
): Promise<GhOidcClaims> {
  let payload: GhOidcClaims;
  try {
    const result = await jwtVerify(jwt, jwks, {
      issuer: ISSUER,
      audience: expectedAudience(request, env),
      algorithms: ["RS256"],
      // GitHub backdates nbf by ~600s and issues a 5-minute window; a tight
      // tolerance makes verification flaky for no security benefit.
      clockTolerance: 60,
      maxTokenAge: "10 minutes",
    });
    payload = result.payload as GhOidcClaims;
  } catch (err) {
    throw new OidcError(401, "invalid_token", err instanceof Error ? err.message : "bad token");
  }

  if (!payload.repository || !payload.repository_id || !payload.repository_owner_id) {
    throw new OidcError(401, "missing_claims", "token is missing repository claims");
  }

  const selfHostedAllowed = env.ALLOW_SELF_HOSTED === "true";
  if (!selfHostedAllowed && payload.runner_environment !== "github-hosted") {
    throw new OidcError(
      403,
      "self_hosted_runner",
      "set ALLOW_SELF_HOSTED=true to permit self-hosted runners",
    );
  }

  if (payload.event_name && !ALLOWED_EVENTS.has(payload.event_name)) {
    throw new OidcError(403, "event_not_allowed", `event ${payload.event_name} is not allowed`);
  }

  if (env.ALLOWED_REPOS && env.ALLOWED_REPOS.trim() !== "") {
    const allowed = new Set(
      env.ALLOWED_REPOS.split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!allowed.has(payload.repository.toLowerCase())) {
      throw new OidcError(403, "repo_not_allowed", `${payload.repository} is not in ALLOWED_REPOS`);
    }
  }

  if (env.REQUIRED_JOB_WORKFLOW_REF && env.REQUIRED_JOB_WORKFLOW_REF.trim() !== "") {
    const actual = (payload.job_workflow_ref ?? "").split("@")[0];
    if (actual !== env.REQUIRED_JOB_WORKFLOW_REF.trim()) {
      throw new OidcError(403, "workflow_not_allowed", "job_workflow_ref does not match");
    }
  }

  return payload;
}

/**
 * Derive the branch from the TOKEN, never from the request body. Without this,
 * any authenticated repo could overwrite any other repo's permalinks.
 */
export function refFromClaims(claims: GhOidcClaims): string {
  if (claims.event_name === "pull_request" || claims.event_name === "pull_request_target") {
    if (!claims.head_ref) throw new OidcError(400, "no_head_ref", "token has no head_ref claim");
    return claims.head_ref;
  }
  const ref = claims.ref ?? "";
  if (!ref.startsWith("refs/heads/")) {
    throw new OidcError(400, "not_a_branch", `ref ${ref || "(empty)"} is not a branch`);
  }
  return ref.slice("refs/heads/".length);
}

export function ownerRepoFromClaims(claims: GhOidcClaims): { owner: string; repo: string } {
  const [owner, repo] = claims.repository.split("/");
  if (!owner || !repo) {
    throw new OidcError(400, "bad_repository_claim", "repository claim is malformed");
  }
  return { owner, repo };
}

/**
 * Trust on first use: the first repo to register `<owner>/<repo>` binds its
 * numeric ids to that namespace, and every later write must match.
 *
 * Numeric ids -- never the `sub` claim. GitHub is migrating repos created after
 * 2026-07-15 to immutable subject claims, so any regex written against the old
 * `sub` format either breaks silently or is loose enough to be bypassed.
 */
export async function assertRepoBinding(
  env: Env,
  owner: string,
  repo: string,
  claims: GhOidcClaims,
): Promise<void> {
  const existing = await getBinding(env, owner, repo);

  if (!existing) {
    await putBinding(env, owner, repo, {
      v: 1,
      repositoryId: String(claims.repository_id),
      repositoryOwnerId: String(claims.repository_owner_id),
      repository: claims.repository,
      boundAt: new Date().toISOString(),
    } satisfies RepoBinding);
    return;
  }

  const idMatches = existing.repositoryId === String(claims.repository_id);
  const ownerMatches = existing.repositoryOwnerId === String(claims.repository_owner_id);
  if (!idMatches || !ownerMatches) {
    throw new OidcError(
      403,
      "repo_binding_mismatch",
      `${owner}/${repo} is bound to repository id ${existing.repositoryId}. ` +
        `If you deleted and recreated the repository, clear the binding with: ` +
        `wrangler kv key delete --binding BUILDS "${bindingKey(owner, repo)}"`,
    );
  }
}
