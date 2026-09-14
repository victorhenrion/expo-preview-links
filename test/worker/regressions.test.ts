/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Regression tests for defects found by adversarial review.
 *
 * Each block names the bug it locks down. Do not delete these without
 * understanding the failure they encode.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointerKey } from "../../src/shared/ref.js";
import type { BuildPointer, Platform } from "../../src/shared/types.js";
import worker from "../../src/worker/index.js";

const ORIGIN = "https://preview.example.com";
const OWNER = "acme";
const REPO = "mobile-app";
const APP_ID = "b1a2c3d4-0000-4000-8000-abcdefabcdef";
const BUILD_ID = "0f9a1b2c-1111-4111-8111-123456789abc";
const NEWER_BUILD_ID = "1a2b3c4d-2222-4222-8222-2233445566aa";
const SHA = "a".repeat(40);
const ARTIFACT_URL = "https://expo.dev/artifacts/eas/mR7pQ2kTfake.ipa";
const DAY_MS = 24 * 60 * 60 * 1000;

function pointer(ref: string, platform: Platform, over: Partial<BuildPointer> = {}): BuildPointer {
  const now = new Date().toISOString();
  return {
    v: 1,
    buildId: BUILD_ID,
    appId: APP_ID,
    account: "acme",
    slug: "mobile",
    platform,
    ref,
    sha: SHA,
    profile: "preview",
    registeredAt: now,
    status: "ready",
    resolvedAt: now,
    artifactUrl: ARTIFACT_URL,
    expirationDate: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    ...over,
  };
}

async function seed(ref: string, platform: Platform, over: Partial<BuildPointer> = {}) {
  const p = pointer(ref, platform, over);
  await env.BUILDS.put(await pointerKey(OWNER, REPO, ref, platform), JSON.stringify(p));
  return p;
}

async function req(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function readBack(ref: string, platform: Platform): Promise<BuildPointer | null> {
  return env.BUILDS.get<BuildPointer>(await pointerKey(OWNER, REPO, ref, platform), {
    type: "json",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("malformed percent-encoding never throws out of fetch()", () => {
  // Previously parseRoute ran OUTSIDE the try/catch and decodeURIComponent
  // threw URIError, so the client got Cloudflare's error page -- with none of
  // the hardened headers -- instead of our 404, and every request was booked
  // as a Worker exception.
  const malformed = [
    "/acme/mobile-app/%/ios",
    "/%/mobile-app/branch/ios",
    "/acme/%zz/branch/ios",
    "/acme/mobile-app/%zz/ios",
    "/acme/mobile-app/%E0%A4%A/ios",
    "/acme/mobile-app/feat/%/ios",
  ];

  for (const path of malformed) {
    it(`returns a hardened 404 for ${path}`, async () => {
      const res = await req(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  }

  it("still accepts a branch that legitimately contains a percent sign", async () => {
    // `feat%252Fx` decodes exactly once to the literal ref `feat%2Fx`.
    await seed("feat%2Fx", "ios");
    const res = await req("/acme/mobile-app/feat%252Fx/ios");
    expect(res.status).toBe(200);
  });
});

describe("the canonical permalink is rebuilt, not string-edited", () => {
  // Previously permalinkUrl was derived by stripping suffixes off the request
  // path, so a trailing slash leaked into the QR payload, into installUrl and
  // into the /artifact href on the page -- where it 404'd.
  it("a trailing slash does not leak into the rendered permalink", async () => {
    await seed("feat-x", "android");
    const res = await req("/acme/mobile-app/feat-x/android/");
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(`${ORIGIN}/acme/mobile-app/feat-x/android`);
    expect(body).not.toContain("/android//artifact");
    expect(body).not.toContain("/android/</p>");
  });

  it("installUrl in the JSON body points at the install page, not at itself", async () => {
    await seed("feat-x", "ios");
    const res = await req("/acme/mobile-app/feat-x/ios.json");
    const body = (await res.json()) as { installUrl: string };
    expect(body.installUrl).toBe(`${ORIGIN}/acme/mobile-app/feat-x/ios`);
    expect(body.installUrl).not.toContain(".json");
  });

  it("a trailing slash on the JSON route is canonicalised too", async () => {
    await seed("feat-x", "ios");
    const res = await req("/acme/mobile-app/feat-x/ios.json/");
    const body = (await res.json()) as { installUrl: string };
    expect(body.installUrl).toBe(`${ORIGIN}/acme/mobile-app/feat-x/ios`);
  });

  it("the QR encodes the canonical permalink regardless of trailing slashes", async () => {
    await seed("feat-x", "ios");
    const clean = await (await req("/acme/mobile-app/feat-x/ios/qr.png")).arrayBuffer();
    const slashed = await (await req("/acme/mobile-app/feat-x/ios/qr.png/")).arrayBuffer();
    expect(new Uint8Array(slashed)).toEqual(new Uint8Array(clean));
  });
});

describe("the lazy write-back never resurrects a superseded build", () => {
  /** Resolve slowly, so a newer registration can land mid-flight. */
  function stubSlowEas(status: string, delayMs: number) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.expo.dev/")) throw new Error(`unexpected fetch: ${url}`);
      await new Promise((r) => setTimeout(r, delayMs));
      return Response.json({
        data: {
          builds: {
            byId: {
              id: BUILD_ID,
              status,
              platform: "IOS",
              artifacts: { applicationArchiveUrl: ARTIFACT_URL },
            },
          },
        },
      });
    });
  }

  it("abandons the write when a newer buildId was registered while resolving", async () => {
    const ref = "feat-race";
    // A stale pointer: status "building" is stale by definition.
    await seed(ref, "ios", { status: "building", artifactUrl: undefined });
    stubSlowEas("CANCELED", 40);

    const ctx = createExecutionContext();
    const pending = worker.fetch(new Request(`${ORIGIN}/acme/mobile-app/${ref}/ios`), env, ctx);

    // A new push registers a different build for the same key mid-resolve.
    await new Promise((r) => setTimeout(r, 10));
    const newer = pointer(ref, "ios", {
      buildId: NEWER_BUILD_ID,
      status: "building",
      registeredAt: new Date(Date.now() + 1000).toISOString(),
      artifactUrl: undefined,
    });
    await env.BUILDS.put(await pointerKey(OWNER, REPO, ref, "ios"), JSON.stringify(newer));

    await pending;
    await waitOnExecutionContext(ctx);

    const stored = await readBack(ref, "ios");
    expect(stored?.buildId).toBe(NEWER_BUILD_ID);
  });
});

describe("an unreachable EAS does not destroy a known-good ready pointer", () => {
  it("keeps serving the stored artifact when the lookup fails", async () => {
    const ref = "feat-outage";
    // Ready, with a resolvedAt old enough to be stale, but an unexpired artifact.
    await seed(ref, "android", {
      status: "ready",
      resolvedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("EAS is down");
    });

    const res = await req(`/acme/mobile-app/${ref}/android.json`);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ready");

    // And the artifact redirect still works rather than 404ing as "not_ready".
    const artifact = await req(`/acme/mobile-app/${ref}/android/artifact`);
    expect(artifact.status).toBe(302);
    expect(artifact.headers.get("location")).toBe(ARTIFACT_URL);

    // The downgrade must not have been persisted either.
    const stored = await readBack(ref, "android");
    expect(stored?.status).not.toBe("unavailable");
  });

  it("still reports unavailable when there is no usable stored artifact", async () => {
    const ref = "feat-outage-2";
    await seed(ref, "android", {
      status: "building",
      artifactUrl: undefined,
      expirationDate: undefined,
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("EAS is down");
    });

    const res = await req(`/acme/mobile-app/${ref}/android.json`);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("unavailable");
  });
});

describe("queue metadata is cleared when EAS stops reporting it", () => {
  it("drops a stale queuePosition once the build starts", async () => {
    const ref = "feat-queue";
    await seed(ref, "ios", {
      status: "building",
      artifactUrl: undefined,
      queuePosition: 12,
      estimatedWaitSeconds: 1200,
    });

    // EAS now reports IN_PROGRESS and omits both queue fields.
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          builds: {
            byId: { id: BUILD_ID, status: "IN_PROGRESS", platform: "IOS" },
          },
        },
      }),
    );

    const res = await req(`/acme/mobile-app/${ref}/ios.json`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("building");
    expect(body.queuePosition).toBeUndefined();
    expect(body.estimatedWaitSeconds).toBeUndefined();

    const stored = await readBack(ref, "ios");
    expect(stored?.queuePosition).toBeUndefined();
    expect(stored?.estimatedWaitSeconds).toBeUndefined();
  });
});
