/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * The security tests. These are the ones that must never be deleted.
 *
 * Everything here guards a property that, if it broke, would be a
 * vulnerability rather than a bug:
 *
 *   1. /api/register is unreachable without a GitHub-signed OIDC token
 *      (no header, garbage, `alg: none`, wrong key, wrong audience, wrong
 *      issuer, stale token -- all 401).
 *   2. owner/repo/branch are taken from the VERIFIED CLAIMS, never the body.
 *   3. The trust-on-first-use binding stops repo B from writing repo A's
 *      namespace even though B can mint a perfectly valid token.
 *   4. Every field in the body is shape-checked before it reaches KV.
 *   5. A branch name is attacker-controlled text and is escaped on output.
 *   6. GATING_MODE=signed fails CLOSED and its HMAC is bound to path + expiry.
 *
 * How the OIDC side is made testable: we cannot mint a token GitHub would
 * sign, so the test generates its own RS256 keypair and stubs the global
 * `fetch` so that the JWKS document at token.actions.githubusercontent.com is
 * served from that keypair. Everything else -- issuer, audience, algorithm,
 * token age, the claim policy and the binding -- is the Worker's real code
 * path. The stub throws on any other URL, so an accidental call to
 * api.expo.dev (unreachable from CI, and never legitimate in this file)
 * fails the test instead of hanging it. `vi.unstubAllGlobals` in afterEach
 * restores the real fetch.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingKey, encodeRefPath, pointerKey } from "../../src/shared/ref.js";
import type { BuildPointer, Platform, RepoBinding } from "../../src/shared/types.js";
import worker from "../../src/worker/index.js";
import {
  assertRepoBinding,
  type GhOidcClaims,
  OidcError,
  ownerRepoFromClaims,
  refFromClaims,
} from "../../src/worker/oidc.js";
import { escapeHtml } from "../../src/worker/render.js";
import { signPermalink, verifySignedPermalink } from "../../src/worker/signing.js";

const ORIGIN = "https://preview.example.com";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const KID = "test-key-1";

const OWNER = "acme";
const HEAD_REF = "feat/preview";
const CLAIM_SHA = "a".repeat(40);
const BUILD_ID = "0f9a1b2c-1111-4111-8111-123456789abc";
const BUILD_ID_2 = "0f9a1b2c-2222-4222-8222-123456789abc";
const APP_ID = "b1a2c3d4-0000-4000-8000-abcdefabcdef";

// ---------------------------------------------------------------------------
// keys + JWKS stub
// ---------------------------------------------------------------------------

let signingKey: CryptoKey;
/** A second, valid RS256 key that is NOT published in the JWKS. */
let impostorKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  const impostor = await generateKeyPair("RS256", { extractable: true });
  signingKey = real.privateKey as CryptoKey;
  impostorKey = impostor.privateKey as CryptoKey;

  const jwk: JWK = await exportJWK(real.publicKey as CryptoKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwksBody = JSON.stringify({ keys: [jwk] });
});

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(jwksBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected outbound fetch to ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * A fresh repo identity per test. Two reasons: the TOFU binding is permanent
 * once written, and RL_REGISTER is keyed on repository_id -- so reusing one
 * identity across the whole file would make later tests depend on how many
 * registrations earlier ones made.
 */
let repoCounter = 0;
function freshRepo(label: string): { repo: string; repositoryId: string } {
  repoCounter += 1;
  return { repo: `${label}-${repoCounter}`, repositoryId: String(100_000 + repoCounter) };
}

function claimsFor(repo: string, repositoryId: string, over: Partial<GhOidcClaims> = {}) {
  return {
    repository: `${OWNER}/${repo}`,
    repository_id: repositoryId,
    repository_owner: OWNER,
    repository_owner_id: "9001",
    repository_visibility: "private",
    event_name: "pull_request",
    head_ref: HEAD_REF,
    ref: "refs/pull/42/merge",
    sha: CLAIM_SHA,
    runner_environment: "github-hosted",
    actor: "octocat",
    workflow_ref: `${OWNER}/${repo}/.github/workflows/preview.yml@refs/heads/main`,
    job_workflow_ref: `${OWNER}/${repo}/.github/workflows/preview.yml@refs/heads/main`,
    run_id: "1234567890",
    ...over,
  } satisfies GhOidcClaims;
}

interface MintOptions {
  audience?: string;
  issuer?: string;
  key?: CryptoKey;
  issuedAt?: number;
  expiresAt?: number;
}

async function mint(claims: Record<string, unknown>, opts: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? ORIGIN)
    .setIssuedAt(opts.issuedAt ?? now)
    .setExpirationTime(opts.expiresAt ?? now + 300)
    .sign(opts.key ?? signingKey);
}

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const VALID_BUILD = {
  platform: "ios",
  buildId: BUILD_ID,
  appId: APP_ID,
  account: "acme",
  slug: "mobile",
  profile: "preview",
};

async function post(
  body: unknown,
  init: { authorization?: string; raw?: string; env?: Env } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(body),
    }),
    init.env ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** POST /api/register with a freshly minted, fully valid token. */
async function postAs(
  claims: Record<string, unknown>,
  body: unknown,
  opts: MintOptions & { raw?: string } = {},
): Promise<Response> {
  const token = await mint(claims, opts);
  return post(body, { authorization: `Bearer ${token}`, raw: opts.raw });
}

async function get(path: string, overrideEnv?: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), overrideEnv ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function readPointer(
  repo: string,
  ref: string,
  platform: Platform,
): Promise<BuildPointer | null> {
  return env.BUILDS.get<BuildPointer>(await pointerKey(OWNER, repo, ref, platform), {
    type: "json",
  });
}

async function seedPointer(
  repo: string,
  ref: string,
  platform: Platform,
  over: Partial<BuildPointer> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const pointer: BuildPointer = {
    v: 1,
    buildId: BUILD_ID,
    appId: APP_ID,
    account: "acme",
    slug: "mobile",
    platform,
    ref,
    sha: CLAIM_SHA,
    profile: "preview",
    registeredAt: now,
    // "ready", freshly resolved and unexpired, so the read path never calls
    // EAS -- which the fetch stub would turn into a failure anyway.
    status: "ready",
    resolvedAt: now,
    artifactUrl: "https://expo.dev/artifacts/eas/fake.ipa",
    expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
  await env.BUILDS.put(await pointerKey(OWNER, repo, ref, platform), JSON.stringify(pointer));
}

function envWith(over: Record<string, unknown>): Env {
  return { ...env, ...over } as unknown as Env;
}

// ---------------------------------------------------------------------------
// 1. authentication
// ---------------------------------------------------------------------------

describe("POST /api/register authentication", () => {
  it("accepts a correctly signed token (so the rejections below are not vacuous)", async () => {
    const { repo, repositoryId } = freshRepo("happy");
    const res = await postAs(claimsFor(repo, repositoryId), { builds: [VALID_BUILD] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repository: string;
      ref: string;
      registered: Array<{ platform: string; url: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.repository).toBe(`${OWNER}/${repo}`);
    expect(body.ref).toBe(HEAD_REF);
    expect(body.registered).toEqual([
      { platform: "ios", url: `${ORIGIN}/${OWNER}/${repo}/feat/preview/ios` },
    ]);
  });

  it("401s with no Authorization header at all", async () => {
    const res = await post({ builds: [VALID_BUILD] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", reason: "missing_bearer_token" });
  });

  it("401s on an Authorization header that is not a non-empty Bearer", async () => {
    for (const authorization of [
      "",
      "Bearer",
      "Bearer ",
      "Bearer    ",
      "Basic YWRtaW46aHVudGVyMg==",
      "token ghp_000000000000000000000000000000000000",
      // Case matters: the check is `startsWith("Bearer ")`.
      "bearer abc.def.ghi",
    ]) {
      const res = await post({ builds: [VALID_BUILD] }, { authorization });
      expect(res.status, authorization).toBe(401);
      expect(await res.json(), authorization).toEqual({
        error: "unauthorized",
        reason: "missing_bearer_token",
      });
    }
  });

  it("401s on a garbage bearer", async () => {
    for (const token of [
      "garbage",
      "not.a.jwt",
      "aaaa.bbbb.cccc",
      "....",
      `${"A".repeat(4000)}.b.c`,
      // Well-formed base64url segments, meaningless signature.
      `${b64url({ alg: "RS256", kid: KID })}.${b64url({ repository: "acme/x" })}.AAAA`,
    ]) {
      const res = await post({ builds: [VALID_BUILD] }, { authorization: `Bearer ${token}` });
      expect(res.status, token.slice(0, 32)).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    }
  });

  it('401s on an unsigned "alg": "none" token carrying otherwise perfect claims', async () => {
    const { repo, repositoryId } = freshRepo("nonealg");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...claimsFor(repo, repositoryId),
      iss: ISSUER,
      aud: ORIGIN,
      iat: now,
      nbf: now - 60,
      exp: now + 300,
    };
    const header = b64url({ alg: "none", typ: "JWT" });
    const claims = b64url(payload);

    for (const token of [
      `${header}.${claims}.`, // canonical unsecured JWS
      `${header}.${claims}.AAAA`, // "none" with a signature bolted on
      `${b64url({ alg: "None", typ: "JWT" })}.${claims}.`, // case tricks
      `${b64url({ alg: "nOnE", typ: "JWT" })}.${claims}.`,
    ]) {
      const res = await post({ builds: [VALID_BUILD] }, { authorization: `Bearer ${token}` });
      expect(res.status, token.slice(0, 24)).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    }

    expect(await env.BUILDS.get(bindingKey(OWNER, repo))).toBeNull();
  });

  it("401s on a token signed with a key that is not in GitHub's JWKS", async () => {
    const { repo, repositoryId } = freshRepo("impostor");
    // Same kid, same issuer, same audience, real RS256 signature -- only the
    // key is wrong. This is the check that a JWKS lookup is actually made.
    const res = await postAs(
      claimsFor(repo, repositoryId),
      { builds: [VALID_BUILD] },
      {
        key: impostorKey,
      },
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("401s on a token minted for a different Worker (audience pinning)", async () => {
    const { repo, repositoryId } = freshRepo("audience");
    for (const audience of [
      "https://someone-elses-worker.example.com",
      "https://preview.example.com.evil.test",
      "sigstore",
    ]) {
      const res = await postAs(
        claimsFor(repo, repositoryId),
        { builds: [VALID_BUILD] },
        {
          audience,
        },
      );
      expect(res.status, audience).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    }
  });

  it("401s on a token from the wrong issuer", async () => {
    const { repo, repositoryId } = freshRepo("issuer");
    const res = await postAs(
      claimsFor(repo, repositoryId),
      { builds: [VALID_BUILD] },
      {
        issuer: "https://token.actions.githubusercontent.evil.test",
      },
    );
    expect(res.status).toBe(401);
  });

  it("401s on an expired token and on one older than maxTokenAge", async () => {
    const { repo, repositoryId } = freshRepo("stale");
    const now = Math.floor(Date.now() / 1000);

    const expired = await postAs(
      claimsFor(repo, repositoryId),
      { builds: [VALID_BUILD] },
      {
        issuedAt: now - 3600,
        expiresAt: now - 1800,
      },
    );
    expect(expired.status).toBe(401);

    // Unexpired but issued long ago: maxTokenAge ("10 minutes") must reject it.
    const tooOld = await postAs(
      claimsFor(repo, repositoryId),
      { builds: [VALID_BUILD] },
      {
        issuedAt: now - 3600,
        expiresAt: now + 3600,
      },
    );
    expect(tooOld.status).toBe(401);
  });

  it("401s when the repository claims are missing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      event_name: "push",
      ref: "refs/heads/main",
      runner_environment: "github-hosted",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(ORIGIN)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);

    const res = await post({ builds: [VALID_BUILD] }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_claims");
  });

  it("403s a self-hosted runner unless ALLOW_SELF_HOSTED is set", async () => {
    const { repo, repositoryId } = freshRepo("selfhosted");
    const claims = claimsFor(repo, repositoryId, { runner_environment: "self-hosted" });

    const denied = await postAs(claims, { builds: [VALID_BUILD] });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("self_hosted_runner");

    const token = await mint(claims);
    const allowed = await post(
      { builds: [VALID_BUILD] },
      { authorization: `Bearer ${token}`, env: envWith({ ALLOW_SELF_HOSTED: "true" }) },
    );
    expect(allowed.status).toBe(200);
  });

  it("403s an event that is not in the allow-list", async () => {
    const { repo, repositoryId } = freshRepo("event");
    for (const event of ["schedule", "issue_comment", "repository_dispatch", "release"]) {
      const res = await postAs(
        claimsFor(repo, repositoryId, { event_name: event, ref: "refs/heads/main" }),
        { builds: [VALID_BUILD] },
      );
      expect(res.status, event).toBe(403);
      expect(((await res.json()) as { error: string }).error, event).toBe("event_not_allowed");
    }
  });

  it("403s a repository outside ALLOWED_REPOS when that var is set", async () => {
    const { repo, repositoryId } = freshRepo("allowlist");
    const token = await mint(claimsFor(repo, repositoryId));

    const denied = await post(
      { builds: [VALID_BUILD] },
      { authorization: `Bearer ${token}`, env: envWith({ ALLOWED_REPOS: "someone/else" }) },
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("repo_not_allowed");

    const allowed = await post(
      { builds: [VALID_BUILD] },
      {
        authorization: `Bearer ${token}`,
        // Case-insensitive, and the check must tolerate whitespace.
        env: envWith({ ALLOWED_REPOS: ` someone/else , ${OWNER.toUpperCase()}/${repo} ` }),
      },
    );
    expect(allowed.status).toBe(200);
  });

  it("403s a workflow other than REQUIRED_JOB_WORKFLOW_REF when that var is set", async () => {
    const { repo, repositoryId } = freshRepo("workflow");
    const token = await mint(claimsFor(repo, repositoryId));

    const denied = await post(
      { builds: [VALID_BUILD] },
      {
        authorization: `Bearer ${token}`,
        env: envWith({
          REQUIRED_JOB_WORKFLOW_REF: `${OWNER}/${repo}/.github/workflows/other.yml`,
        }),
      },
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("workflow_not_allowed");

    const allowed = await post(
      { builds: [VALID_BUILD] },
      {
        authorization: `Bearer ${token}`,
        env: envWith({
          REQUIRED_JOB_WORKFLOW_REF: `${OWNER}/${repo}/.github/workflows/preview.yml`,
        }),
      },
    );
    expect(allowed.status).toBe(200);
  });

  it("writes nothing to KV on any rejected request", async () => {
    const { repo, repositoryId } = freshRepo("nowrite");
    const attempts: Array<Promise<Response>> = [
      post({ builds: [VALID_BUILD] }),
      post({ builds: [VALID_BUILD] }, { authorization: "Bearer garbage" }),
      postAs(claimsFor(repo, repositoryId), { builds: [VALID_BUILD] }, { key: impostorKey }),
      postAs(claimsFor(repo, repositoryId), { builds: [VALID_BUILD] }, { audience: "nope" }),
    ];
    for (const attempt of attempts) expect((await attempt).status).toBe(401);

    expect(await env.BUILDS.get(bindingKey(OWNER, repo))).toBeNull();
    expect(await readPointer(repo, HEAD_REF, "ios")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. addressing comes from the claims, never the body
// ---------------------------------------------------------------------------

describe("refFromClaims", () => {
  const base = claimsFor("mobile-app", "1");

  it("uses head_ref for a pull_request, ignoring the merge ref", () => {
    const claims = {
      ...base,
      event_name: "pull_request",
      head_ref: "feat/x",
      ref: "refs/pull/7/merge",
    };
    expect(refFromClaims(claims)).toBe("feat/x");
  });

  it("uses head_ref for pull_request_target too", () => {
    const claims = {
      ...base,
      event_name: "pull_request_target",
      head_ref: "feat/y",
      ref: "refs/heads/main",
    };
    expect(refFromClaims(claims)).toBe("feat/y");
  });

  it("rejects a pull_request token with no head_ref", () => {
    const claims = { ...base, event_name: "pull_request", head_ref: undefined };
    expect(() => refFromClaims(claims)).toThrow(OidcError);
    try {
      refFromClaims(claims);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as OidcError).reason).toBe("no_head_ref");
      expect((err as OidcError).status).toBe(400);
    }
  });

  it("strips refs/heads/ for a push, including nested branch names", () => {
    expect(refFromClaims({ ...base, event_name: "push", ref: "refs/heads/main" })).toBe("main");
    expect(refFromClaims({ ...base, event_name: "push", ref: "refs/heads/feat/a/b" })).toBe(
      "feat/a/b",
    );
    // Only the FIRST occurrence is a prefix; the rest is branch name.
    expect(refFromClaims({ ...base, event_name: "push", ref: "refs/heads/refs/heads/x" })).toBe(
      "refs/heads/x",
    );
  });

  it("rejects a ref that is not a branch", () => {
    for (const ref of [
      "refs/tags/v1.0.0",
      "refs/pull/42/merge",
      "refs/remotes/origin/main",
      "main",
      "",
      "Refs/Heads/main",
      "xrefs/heads/main",
    ]) {
      const claims = { ...base, event_name: "push", ref };
      try {
        refFromClaims(claims);
        expect.unreachable(`should have rejected ${ref}`);
      } catch (err) {
        expect(err, ref).toBeInstanceOf(OidcError);
        expect((err as OidcError).reason, ref).toBe("not_a_branch");
        expect((err as OidcError).status, ref).toBe(400);
      }
    }
  });

  it("rejects a token with no ref claim at all", () => {
    const claims = { ...base, event_name: "workflow_dispatch", ref: undefined };
    expect(() => refFromClaims(claims)).toThrow(OidcError);
  });
});

describe("ownerRepoFromClaims", () => {
  it("splits a well-formed repository claim", () => {
    expect(ownerRepoFromClaims(claimsFor("mobile-app", "1"))).toEqual({
      owner: OWNER,
      repo: "mobile-app",
    });
  });

  it("rejects a malformed repository claim", () => {
    for (const repository of ["", "noslash", "/repo", "owner/", "/"]) {
      const claims = { ...claimsFor("mobile-app", "1"), repository };
      try {
        ownerRepoFromClaims(claims);
        expect.unreachable(`should have rejected ${JSON.stringify(repository)}`);
      } catch (err) {
        expect(err, repository).toBeInstanceOf(OidcError);
        expect((err as OidcError).reason, repository).toBe("bad_repository_claim");
        expect((err as OidcError).status, repository).toBe(400);
      }
    }
  });
});

describe("the body cannot influence addressing", () => {
  it("stores under the claims' owner/repo/branch, ignoring look-alike body fields", async () => {
    const { repo, repositoryId } = freshRepo("addressing");
    const res = await postAs(claimsFor(repo, repositoryId), {
      builds: [VALID_BUILD],
      // Every field an attacker would reach for.
      owner: "victim",
      repo: "victim-app",
      repository: "victim/victim-app",
      ref: "main",
      branch: "main",
      head_ref: "main",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: string; registered: Array<{ url: string }> };
    expect(body.ref).toBe(HEAD_REF);
    expect(body.registered[0]?.url).toBe(`${ORIGIN}/${OWNER}/${repo}/feat/preview/ios`);

    expect(await readPointer(repo, HEAD_REF, "ios")).not.toBeNull();
    expect(await readPointer(repo, "main", "ios")).toBeNull();
    expect(await readPointer("victim-app", "main", "ios")).toBeNull();
    expect(await env.BUILDS.get(bindingKey("victim", "victim-app"))).toBeNull();
  });

  it("400s when the token's branch is not a legal git ref", async () => {
    const { repo, repositoryId } = freshRepo("badref");
    const res = await postAs(
      claimsFor(repo, repositoryId, { event_name: "push", ref: "refs/heads/bad..ref" }),
      { builds: [VALID_BUILD] },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_ref");
  });
});

// ---------------------------------------------------------------------------
// 3. trust-on-first-use binding
// ---------------------------------------------------------------------------

describe("trust-on-first-use repo binding", () => {
  it("binds the numeric ids on first registration", async () => {
    const { repo, repositoryId } = freshRepo("tofu-bind");
    const claims = claimsFor(repo, repositoryId);

    expect(await env.BUILDS.get(bindingKey(OWNER, repo))).toBeNull();
    await assertRepoBinding(env, OWNER, repo, claims);

    const stored = await env.BUILDS.get<RepoBinding>(bindingKey(OWNER, repo), { type: "json" });
    expect(stored).not.toBeNull();
    expect(stored?.v).toBe(1);
    expect(stored?.repositoryId).toBe(repositoryId);
    expect(stored?.repositoryOwnerId).toBe("9001");
    expect(stored?.repository).toBe(`${OWNER}/${repo}`);
    expect(Number.isNaN(Date.parse(stored?.boundAt ?? ""))).toBe(false);
  });

  it("accepts the same repository_id again and rejects a different one", async () => {
    const { repo, repositoryId } = freshRepo("tofu-mismatch");
    await assertRepoBinding(env, OWNER, repo, claimsFor(repo, repositoryId));

    // Same repo, same ids: fine, and idempotent.
    await expect(
      assertRepoBinding(env, OWNER, repo, claimsFor(repo, repositoryId)),
    ).resolves.toBeUndefined();

    // A different repository that happens to be called acme/<repo> now --
    // e.g. the name was freed and re-taken. Rejected.
    try {
      await assertRepoBinding(env, OWNER, repo, claimsFor(repo, "999999999"));
      expect.unreachable("a different repository_id must not be accepted");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).reason).toBe("repo_binding_mismatch");
      expect((err as OidcError).status).toBe(403);
      // The error tells an operator how to unbind deliberately.
      expect((err as OidcError).message).toContain(bindingKey(OWNER, repo));
    }

    // The binding itself is untouched by the failed attempt.
    const stored = await env.BUILDS.get<RepoBinding>(bindingKey(OWNER, repo), { type: "json" });
    expect(stored?.repositoryId).toBe(repositoryId);
  });

  it("rejects a matching repository_id under a different owner id", async () => {
    const { repo, repositoryId } = freshRepo("tofu-owner");
    await assertRepoBinding(env, OWNER, repo, claimsFor(repo, repositoryId));

    await expect(
      assertRepoBinding(
        env,
        OWNER,
        repo,
        claimsFor(repo, repositoryId, { repository_owner_id: "424242" }),
      ),
    ).rejects.toThrow(/bound to repository id/);
  });

  it("compares numerically-typed ids as strings, not by identity", async () => {
    const { repo, repositoryId } = freshRepo("tofu-numeric");
    await assertRepoBinding(env, OWNER, repo, claimsFor(repo, repositoryId));
    // GitHub sends these as strings, but a hand-rolled token might not.
    const numeric = {
      ...claimsFor(repo, repositoryId),
      repository_id: Number(repositoryId) as unknown as string,
      repository_owner_id: 9001 as unknown as string,
    };
    await expect(assertRepoBinding(env, OWNER, repo, numeric)).resolves.toBeUndefined();
  });

  it("rejects a second repository over the wire with repo_binding_mismatch", async () => {
    const { repo, repositoryId } = freshRepo("tofu-http");

    const first = await postAs(claimsFor(repo, repositoryId), { builds: [VALID_BUILD] });
    expect(first.status).toBe(200);

    // A perfectly valid GitHub token -- just a different repository that
    // claims the same owner/repo namespace.
    const attacker = await postAs(claimsFor(repo, "777777777"), {
      builds: [{ ...VALID_BUILD, buildId: BUILD_ID_2 }],
    });
    expect(attacker.status).toBe(403);
    expect(((await attacker.json()) as { error: string }).error).toBe("repo_binding_mismatch");

    // The victim's pointer still points at the victim's build.
    expect((await readPointer(repo, HEAD_REF, "ios"))?.buildId).toBe(BUILD_ID);

    // And the legitimate owner can still register again.
    const second = await postAs(claimsFor(repo, repositoryId), {
      builds: [{ ...VALID_BUILD, buildId: BUILD_ID_2 }],
    });
    expect(second.status).toBe(200);
    expect((await readPointer(repo, HEAD_REF, "ios"))?.buildId).toBe(BUILD_ID_2);
  });

  it("keeps separate namespaces for different repos of the same owner", async () => {
    const a = freshRepo("tofu-sep-a");
    const b = freshRepo("tofu-sep-b");
    expect(
      (await postAs(claimsFor(a.repo, a.repositoryId), { builds: [VALID_BUILD] })).status,
    ).toBe(200);
    expect(
      (await postAs(claimsFor(b.repo, b.repositoryId), { builds: [VALID_BUILD] })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. body validation
// ---------------------------------------------------------------------------

describe("register body validation", () => {
  async function badBody(
    body: unknown,
    raw?: string,
  ): Promise<{ status: number; message: string }> {
    const { repo, repositoryId } = freshRepo("body");
    const res = await postAs(claimsFor(repo, repositoryId), body, raw ? { raw } : {});
    const json = (await res.json()) as { error: string; message?: string };
    return { status: res.status, message: `${json.error}: ${json.message ?? ""}` };
  }

  it("rejects a buildId or appId that is not a uuid", async () => {
    for (const buildId of [
      "not-a-uuid",
      "0f9a1b2c1111411181111234567 89abc",
      `${BUILD_ID}x`,
      `${BUILD_ID}\n`,
      "../../etc/passwd",
      "0f9a1b2c-1111-4111-8111-123456789ab",
      "",
      12345,
      null,
    ]) {
      const r = await badBody({ builds: [{ ...VALID_BUILD, buildId }] });
      expect(r.status, String(buildId)).toBe(400);
      expect(r.message, String(buildId)).toContain("buildId");
    }

    const appIdBad = await badBody({ builds: [{ ...VALID_BUILD, appId: "nope" }] });
    expect(appIdBad.status).toBe(400);
    expect(appIdBad.message).toContain("appId");
  });

  it("accepts an upper-case uuid (EAS sometimes returns one)", async () => {
    const { repo, repositoryId } = freshRepo("uuidcase");
    const res = await postAs(claimsFor(repo, repositoryId), {
      builds: [{ ...VALID_BUILD, buildId: BUILD_ID.toUpperCase() }],
    });
    expect(res.status).toBe(200);
  });

  it("rejects a build with any required field missing", async () => {
    for (const field of ["platform", "buildId", "appId", "account", "slug", "profile"]) {
      const build: Record<string, unknown> = { ...VALID_BUILD };
      delete build[field];
      const r = await badBody({ builds: [build] });
      expect(r.status, field).toBe(400);
      expect(r.message, field).toContain(field);
    }
  });

  it("rejects an unknown platform", async () => {
    for (const platform of ["windows", "web", "IOS", "", null, 1, ["ios"]]) {
      const r = await badBody({ builds: [{ ...VALID_BUILD, platform }] });
      expect(r.status, String(platform)).toBe(400);
      expect(r.message, String(platform)).toContain("platform");
    }
  });

  it("rejects over-long string fields", async () => {
    const r = await badBody({ builds: [{ ...VALID_BUILD, account: "a".repeat(101) }] });
    expect(r.status).toBe(400);
    expect(r.message).toContain("account");
  });

  it("rejects a builds array that is missing, empty, not an array, or longer than 8", async () => {
    for (const builds of [
      undefined,
      null,
      [],
      {},
      "ios",
      8,
      Array.from({ length: 9 }, () => VALID_BUILD),
    ]) {
      const r = await badBody({ builds });
      expect(r.status, JSON.stringify(builds)?.slice(0, 24)).toBe(400);
      expect(r.message).toContain("builds must be an array of 1..8 entries");
    }
  });

  it("rejects a duplicate platform", async () => {
    const r = await badBody({
      builds: [VALID_BUILD, { ...VALID_BUILD, buildId: BUILD_ID_2 }],
    });
    expect(r.status).toBe(400);
    expect(r.message).toContain("duplicate platform ios");
  });

  it("accepts exactly one ios and one android", async () => {
    const { repo, repositoryId } = freshRepo("bothplatforms");
    const res = await postAs(claimsFor(repo, repositoryId), {
      builds: [VALID_BUILD, { ...VALID_BUILD, platform: "android", buildId: BUILD_ID_2 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { registered: unknown[] }).toMatchObject({
      registered: [{ platform: "ios" }, { platform: "android" }],
    });
  });

  it("rejects a body that is not a JSON object", async () => {
    for (const raw of ["", "null", "[]", '"builds"', "42", "{oops", "{}"]) {
      const r = await badBody(undefined, raw);
      expect(r.status, raw).toBe(400);
    }
  });

  it("413s an oversized body before parsing it", async () => {
    const { repo, repositoryId } = freshRepo("toolarge");
    const raw = JSON.stringify({ builds: [VALID_BUILD], message: "x".repeat(17_000) });
    expect(raw.length).toBeGreaterThan(16 * 1024);

    const res = await postAs(claimsFor(repo, repositoryId), undefined, { raw });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
    expect(await readPointer(repo, HEAD_REF, "ios")).toBeNull();
  });

  it("treats prNumber, commitSha and message as display-only and shape-checked", async () => {
    const { repo, repositoryId } = freshRepo("displayonly");
    const res = await postAs(claimsFor(repo, repositoryId), {
      builds: [VALID_BUILD],
      prNumber: "42", // wrong type
      commitSha: "deadbeef", // not 40 hex
      message: "m".repeat(500), // over the 300-char cap
    });
    expect(res.status).toBe(200);

    const pointer = await readPointer(repo, HEAD_REF, "ios");
    expect(pointer?.prNumber).toBeUndefined();
    // A rejected commitSha falls back to the sha in the signed token.
    expect(pointer?.sha).toBe(CLAIM_SHA);
    expect(pointer?.message).toHaveLength(300);
  });

  it("drops a prNumber that is negative, zero or fractional", async () => {
    for (const prNumber of [0, -1, 1.5, Number.NaN, "7", true]) {
      const { repo, repositoryId } = freshRepo("prnum");
      const res = await postAs(claimsFor(repo, repositoryId), {
        builds: [VALID_BUILD],
        prNumber,
      });
      expect(res.status, String(prNumber)).toBe(200);
      expect(
        (await readPointer(repo, HEAD_REF, "ios"))?.prNumber,
        String(prNumber),
      ).toBeUndefined();
    }
  });

  it("keeps well-formed display fields", async () => {
    const { repo, repositoryId } = freshRepo("displayok");
    const sha = "b".repeat(40);
    const res = await postAs(claimsFor(repo, repositoryId), {
      builds: [VALID_BUILD],
      prNumber: 42,
      commitSha: sha,
      message: "feat: add onboarding",
    });
    expect(res.status).toBe(200);

    const pointer = await readPointer(repo, HEAD_REF, "ios");
    expect(pointer?.prNumber).toBe(42);
    expect(pointer?.sha).toBe(sha);
    expect(pointer?.message).toBe("feat: add onboarding");
    // Registration never claims to know the build's outcome.
    expect(pointer?.status).toBe("building");
  });
});

// ---------------------------------------------------------------------------
// 5. output escaping
// ---------------------------------------------------------------------------

describe("escaping attacker-controlled text", () => {
  const XSS = "<img src=x onerror=alert(1)>";

  /**
   * Every `<...>` a browser would parse as a TAG. Escaped payloads show up in
   * the document as `&lt;img …&gt;`, which is text and matches nothing here --
   * so asserting on this list is the difference between "the page contains the
   * string onerror=" (it does, harmlessly) and "the page contains an onerror
   * handler" (it must never).
   */
  function tags(html: string): string[] {
    return html.match(/<[^>]*>/g) ?? [];
  }

  function expectNoInjectedTag(html: string, label: string): void {
    for (const tag of tags(html)) {
      expect(tag, `${label}: ${tag}`).not.toMatch(/^<\/?\s*(img|svg|script|iframe|object|embed)/i);
      // No event handler, and no scheme that executes.
      expect(tag, `${label}: ${tag}`).not.toMatch(/\bon[a-z]+\s*=/i);
      expect(tag, `${label}: ${tag}`).not.toMatch(/javascript:/i);
      expect(tag, `${label}: ${tag}`).not.toMatch(/\bdata:text\/html/i);
    }
  }

  it("escapeHtml neutralises a branch literally named feat/<img src=x onerror=alert(1)>", () => {
    expect(escapeHtml(`feat/${XSS}`)).toBe("feat/&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`feat/${XSS}`)).not.toContain("<img");

    // The other two ways out of an HTML context: an attribute and a quote.
    expect(escapeHtml('" onmouseover="alert(1)')).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(escapeHtml("' onmouseover='alert(1)")).toBe("&#39; onmouseover=&#39;alert(1)");
    // & is escaped FIRST, or every other entity would be double-escapable.
    expect(escapeHtml("&lt;img&gt;")).toBe("&amp;lt;img&amp;gt;");
    expect(escapeHtml("</script><script>alert(1)</script>")).not.toContain("<script");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("never emits a raw <img for an XSS-shaped branch name on the install page", async () => {
    const { repo } = freshRepo("xss");
    // The literal `feat/<img src=x onerror=alert(1)>` contains spaces, which
    // `git check-ref-format` forbids, so normalizeRef rejects it before it can
    // ever be rendered (asserted separately below). This is the same payload
    // with the spaces removed -- a ref git WOULD accept, so it reaches the
    // renderer and the escaping is what stops it.
    const ref = "feat/<img_src=x_onerror=alert(1)>";
    await seedPointer(repo, ref, "ios", { message: XSS, appVersion: `1.0${XSS}` });

    const res = await get(`/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await res.text();
    // The literal payload never appears as markup...
    expect(html).not.toContain("<img");
    expectNoInjectedTag(html, "install page");
    // ...only as inert text, in the heading, the <title> and the meta table.
    expect(html).toContain("&lt;img_src=x_onerror=alert(1)&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes the same payload in a failed build's error text and on every route", async () => {
    const { repo } = freshRepo("xss-failed");
    const ref = "feat/<svg_onload=alert(1)>";
    await seedPointer(repo, ref, "android", {
      status: "failed",
      resolvedAt: new Date().toISOString(),
      artifactUrl: undefined,
      expirationDate: undefined,
      errorCode: `<b>code</b>`,
      errorMessage: `${XSS} gradle exploded`,
      errorDocsUrl: `https://expo.dev/"><script>alert(1)</script>`,
      message: XSS,
    });

    const encoded = encodeRefPath(ref);
    const html = await (await get(`/${OWNER}/${repo}/${encoded}/android`)).text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg_onload");
    expectNoInjectedTag(html, "failed page");
    // Every hostile field came back escaped rather than dropped.
    expect(html).toContain("&lt;b&gt;code&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; gradle exploded");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");

    // The QR is generated from the URL alone, so no pointer text reaches it.
    const svg = await (await get(`/${OWNER}/${repo}/${encoded}/android/qr.svg`)).text();
    expect(svg).not.toContain("alert(");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("onload=");

    // The JSON route is served as application/json with nosniff, so the raw
    // text is expected there -- what matters is that it is a JSON string.
    const json = (await (await get(`/${OWNER}/${repo}/${encoded}/android.json`)).json()) as {
      ref: string;
      errorMessage: string;
    };
    expect(json.ref).toBe(ref);
    expect(json.errorMessage).toBe(`${XSS} gradle exploded`);
  });

  it("refuses to route the literal branch (git forbids the spaces in it) without echoing it", async () => {
    const { repo } = freshRepo("xss-literal");
    const ref = `feat/${XSS}`;
    const res = await get(`/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`);

    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("does not let a branch name escape the permalink echoed back to the reader", async () => {
    const { repo } = freshRepo("xss-quote");
    const ref = 'feat/"onload="alert(1)';
    await seedPointer(repo, ref, "ios");

    const html = await (await get(`/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`)).text();
    // The quote survives only as an entity, so no attribute can be broken out of.
    expect(html).not.toContain('"onload="');
    expect(html).toContain("&quot;onload=&quot;alert(1)");
  });
});

// ---------------------------------------------------------------------------
// 6. signed permalinks
// ---------------------------------------------------------------------------

describe("verifySignedPermalink", () => {
  const SECRET = "correct horse battery staple";
  const PATH = "/acme/mobile-app/feat/preview/ios";

  function signedRequest(path: string, token: string): Request {
    return new Request(`${ORIGIN}${path}?t=${encodeURIComponent(token)}`);
  }

  function inAnHour(): number {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  it("fails CLOSED when GATING_MODE=signed but PERMALINK_HMAC_SECRET is unset", async () => {
    const noSecret = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: undefined });
    const expiry = inAnHour();
    // Even a token that WOULD be valid under some secret must be refused,
    // and so must a request with no token at all.
    const token = await signPermalink(PATH, expiry, SECRET);
    expect(await verifySignedPermalink(signedRequest(PATH, token), noSecret)).toBe(false);
    expect(await verifySignedPermalink(new Request(`${ORIGIN}${PATH}`), noSecret)).toBe(false);

    const empty = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: "" });
    expect(await verifySignedPermalink(signedRequest(PATH, token), empty)).toBe(false);
  });

  it("verifies a correctly signed, unexpired token", async () => {
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const token = await signPermalink(PATH, inAnHour(), SECRET);
    expect(await verifySignedPermalink(signedRequest(PATH, token), gated)).toBe(true);
  });

  it("verifies the same token on every sub-route of the canonical permalink", async () => {
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const token = await signPermalink(PATH, inAnHour(), SECRET);
    for (const suffix of ["", "/artifact", "/qr.png", "/qr.svg", ".json"]) {
      expect(
        await verifySignedPermalink(signedRequest(`${PATH}${suffix}`, token), gated),
        suffix,
      ).toBe(true);
    }
  });

  it("rejects an expired token", async () => {
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const past = Math.floor(Date.now() / 1000) - 1;
    const token = await signPermalink(PATH, past, SECRET);
    expect(await verifySignedPermalink(signedRequest(PATH, token), gated)).toBe(false);
  });

  it("rejects a tampered token", async () => {
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const expiry = inAnHour();
    const token = await signPermalink(PATH, expiry, SECRET);
    const [, mac] = token.split(".");

    const flipLast = (s: string): string => s.slice(0, -1) + (s.at(-1) === "A" ? "B" : "A");

    const tampered = [
      // Same length, one character different: this is the case a naive
      // early-return comparison would still catch, but a length-only check
      // would not.
      `${expiry}.${flipLast(mac ?? "")}`,
      // Extend the expiry, keep the mac.
      `${expiry + 86_400}.${mac}`,
      // Truncated mac.
      `${expiry}.${(mac ?? "").slice(0, -1)}`,
      // Mac from a different secret.
      await signPermalink(PATH, expiry, `${SECRET} not`),
      // Mac for a different path.
      await signPermalink("/acme/mobile-app/main/ios", expiry, SECRET),
      // Mac for the other platform.
      await signPermalink("/acme/mobile-app/feat/preview/android", expiry, SECRET),
      // Structurally broken tokens.
      "",
      ".",
      `.${mac}`,
      `${expiry}`,
      `not-a-number.${mac}`,
      `${expiry}.`,
    ];

    for (const token of tampered) {
      expect(await verifySignedPermalink(signedRequest(PATH, token), gated), token).toBe(false);
    }

    // And the untampered original still verifies, so the assertions above are
    // not passing for some unrelated reason.
    expect(await verifySignedPermalink(signedRequest(PATH, token), gated)).toBe(true);
  });

  it("rejects a token signed for a different repository's permalink", async () => {
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const expiry = inAnHour();
    const token = await signPermalink("/other/repo/feat/preview/ios", expiry, SECRET);
    expect(await verifySignedPermalink(signedRequest(PATH, token), gated)).toBe(false);
  });
});

describe("GATING_MODE=signed on the read path", () => {
  const SECRET = "a signing secret";

  it("403s an unsigned permalink and 200s a signed one", async () => {
    const { repo } = freshRepo("gated");
    const ref = "feat/gated";
    await seedPointer(repo, ref, "ios");

    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const path = `/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`;

    const denied = await get(path, gated);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("forbidden");

    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const token = await signPermalink(path, expiry, SECRET);
    const allowed = await get(`${path}?t=${token}`, gated);
    expect(allowed.status).toBe(200);
    expect((await allowed.text()).includes("Install the iOS preview")).toBe(true);
  });

  it("403s everything, including .json and /artifact, without a signature", async () => {
    const { repo } = freshRepo("gated-all");
    const ref = "feat/gated";
    await seedPointer(repo, ref, "ios");

    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const base = `/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`;
    for (const path of [base, `${base}.json`, `${base}/artifact`]) {
      const res = await get(path, gated);
      expect(res.status, path).toBe(403);
      // No artifact URL may leak through a redirect.
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("serves the QR image unsigned, because it encodes only the URL already known", async () => {
    // Documented, deliberate: the QR is a pure function of the request URL --
    // no KV read, no EAS call, no build data -- and PR comments render it
    // through GitHub's image proxy, which cannot carry a signature. Tapping
    // the code still lands on the gated page.
    const { repo } = freshRepo("gated-qr");
    const gated = envWith({ GATING_MODE: "signed", PERMALINK_HMAC_SECRET: SECRET });
    const res = await get(`/${OWNER}/${repo}/feat/gated/ios/qr.svg`, gated);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("leaves the default public mode ungated", async () => {
    const { repo } = freshRepo("public");
    const ref = "feat/public";
    await seedPointer(repo, ref, "ios");
    const res = await get(`/${OWNER}/${repo}/${encodeRefPath(ref)}/ios`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 7. the write route is the only write
// ---------------------------------------------------------------------------

describe("method and route surface", () => {
  it("does not expose /api/register on GET, PUT or DELETE", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`${ORIGIN}/api/register`, { method }), env, ctx);
      await waitOnExecutionContext(ctx);
      if (method === "GET") {
        // Falls through to the read router, which does not know this path.
        expect(res.status).toBe(404);
      } else {
        expect(res.status, method).toBe(405);
      }
    }
  });

  it("does not accept a registration on a look-alike path", async () => {
    for (const path of ["/api/register/", "/API/register", "/api/Register", "//api/register"]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          body: JSON.stringify({ builds: [VALID_BUILD] }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(405);
    }
  });
});
