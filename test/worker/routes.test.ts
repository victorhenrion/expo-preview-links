/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Read-path route tests, running on workerd through @cloudflare/vitest-plugin.
 *
 * Plugin API notes (this package is NOT @cloudflare/vitest-pool-workers any
 * more -- `defineWorkersConfig` and `test.poolOptions.workers` no longer
 * exist). What exists today:
 *   - vitest.config.ts: `plugins: [cloudflareTest({ wrangler: { configPath } })]`
 *   - `cloudflare:test` exports `createExecutionContext`, `waitOnExecutionContext`,
 *     plus `env` and `SELF`, both now deprecated in favour of `cloudflare:workers`.
 *     There is no `fetchMock` export in 1.1.9, so outbound EAS calls are blocked
 *     by stubbing the global `fetch` instead.
 *   - `cloudflare:workers` exports the live `env` (the very same binding objects)
 *     and `exports`, so the handler is called directly with a synthetic
 *     ExecutionContext -- which also lets the KV write in `ctx.waitUntil` be
 *     awaited deterministically.
 *
 * api.expo.dev is unreachable from CI and must never be contacted, so every
 * seeded pointer is deliberately FRESH (`resolvedAt` = now, no past
 * `expirationDate`) and therefore not stale -- see `isStale` in the Worker.
 * The one state that is stale by definition ("building") gets an explicit
 * fetch stub.
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
const SHA = "a".repeat(40);
const ARTIFACT_URL = "https://expo.dev/artifacts/eas/mR7pQ2kTfake.ipa";

const DAY_MS = 24 * 60 * 60 * 1000;

function basePointer(ref: string, platform: Platform, over: Partial<BuildPointer>): BuildPointer {
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
    prNumber: 42,
    message: "feat: add onboarding",
    registeredAt: now,
    status: "ready",
    resolvedAt: now,
    ...over,
  };
}

/** Seed KV directly, using the Worker's own key derivation. */
async function seed(
  ref: string,
  platform: Platform,
  over: Partial<BuildPointer> = {},
): Promise<BuildPointer> {
  const pointer = basePointer(ref, platform, over);
  await env.BUILDS.put(await pointerKey(OWNER, REPO, ref, platform), JSON.stringify(pointer));
  return pointer;
}

/** A "ready" pointer that `isStale` will leave alone: fresh, unexpired. */
function ready(over: Partial<BuildPointer> = {}): Partial<BuildPointer> {
  return {
    status: "ready",
    artifactUrl: ARTIFACT_URL,
    appVersion: "1.4.0",
    appBuildVersion: "231",
    appIdentifier: "com.acme.mobile",
    expirationDate: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    ...over,
  };
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  // Flush the lazy KV write-back before the test ends.
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * Replace the global fetch so a stale pointer resolves against a canned EAS
 * reply instead of reaching out to api.expo.dev. Any other origin throws,
 * which surfaces as a failed test rather than a hung one.
 */
function stubEas(build: Record<string, unknown> | null): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://api.expo.dev/graphql")) {
      throw new Error(`unexpected outbound fetch to ${url}`);
    }
    return new Response(JSON.stringify({ data: { builds: { byId: build } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("iOS install page", () => {
  it("renders the eas-cli itms-services href verbatim, semicolon and all", async () => {
    const ref = "ios-ready";
    await seed(ref, "ios", ready());

    const res = await req(`/${OWNER}/${REPO}/${ref}/ios`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const expected = `itms-services://?action=download-manifest;url=https://api.expo.dev/v2/projects/${APP_ID}/builds/${BUILD_ID}/manifest.plist`;
    expect(html).toContain(`href="${expected}"`);

    // The three ways this line is usually got wrong.
    expect(html).not.toContain("itms-services://?action=download-manifest&url=");
    expect(html).not.toContain("manifest.plist%");
    expect(html).not.toContain("url=https%3A%2F%2Fapi.expo.dev");
  });

  it("offers a download, not an itms link, for a simulator build", async () => {
    const ref = "ios-simulator";
    await seed(ref, "ios", ready({ isSimulator: true }));

    const html = await (await req(`/${OWNER}/${REPO}/${ref}/ios`)).text();
    expect(html).not.toContain("itms-services://");
    expect(html).toContain(`href="${ORIGIN}/${OWNER}/${REPO}/${ref}/ios/artifact"`);
  });
});

describe("custom-scheme redirects", () => {
  it("never answers any route with a 3xx to itms-services:", async () => {
    // FINISHED with an artifact, so even the states that force a re-resolve
    // come back "ready" -- the state most likely to tempt a redirect.
    stubEas({
      id: BUILD_ID,
      status: "FINISHED",
      platform: "IOS",
      artifacts: { applicationArchiveUrl: ARTIFACT_URL },
    });

    await seed("sweep-ready", "ios", ready());
    await seed("sweep-ready", "android", ready({ artifactUrl: `${ARTIFACT_URL}.apk` }));
    await seed("sweep-sim", "ios", ready({ isSimulator: true }));
    await seed("sweep-building", "ios", { status: "building", resolvedAt: undefined });
    await seed("sweep-expired", "ios", { status: "expired" });
    await seed("sweep-failed", "ios", { status: "failed", errorCode: "EAS_BUILD_UNKNOWN_ERROR" });
    await seed("sweep-canceled", "ios", { status: "canceled" });

    const refs = [
      "sweep-ready",
      "sweep-sim",
      "sweep-building",
      "sweep-expired",
      "sweep-failed",
      "sweep-canceled",
      "sweep-missing",
    ];
    const paths: string[] = ["/", "/healthz", "/nope"];
    for (const ref of refs) {
      for (const platform of ["ios", "android"]) {
        const base = `/${OWNER}/${REPO}/${ref}/${platform}`;
        paths.push(base, `${base}/artifact`, `${base}/qr.png`, `${base}/qr.svg`, `${base}.json`);
      }
    }

    for (const path of paths) {
      const res = await req(path);
      const location = res.headers.get("location");
      if (location !== null) {
        expect(
          location.startsWith("itms-services:"),
          `${path} redirected to a custom scheme: ${location}`,
        ).toBe(false);
        expect(location.startsWith("https://"), `${path} -> ${location}`).toBe(true);
      }
      expect(res.status, `${path}`).not.toBe(301);
      if (res.status === 302) {
        expect(path.endsWith("/artifact"), `${path} unexpectedly redirected`).toBe(true);
      }
    }
  });
});

describe("missing pointer", () => {
  it("is a self-refreshing 200, never a 404", async () => {
    const res = await req(`/${OWNER}/${REPO}/never-registered/ios`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toMatch(/<meta http-equiv="refresh" content="\d+">/);
    expect(html).toContain("No preview build yet");
  });
});

describe("/artifact", () => {
  it("302s to the allow-listed artifact host when the build is ready", async () => {
    const ref = "artifact-ready";
    await seed(ref, "android", ready({ artifactUrl: "https://expo.dev/artifacts/eas/zzz.apk" }));

    const res = await req(`/${OWNER}/${REPO}/${ref}/android/artifact`);
    expect(res.status).toBe(302);

    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://expo.dev/artifacts/eas/zzz.apk");
    expect(new URL(location).hostname).toBe("expo.dev");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s while the build is still building", async () => {
    // "building" is always stale, so this is the one case that needs EAS.
    stubEas({ id: BUILD_ID, status: "IN_PROGRESS", queuePosition: 3 });
    const ref = "artifact-building";
    await seed(ref, "ios", { status: "building", resolvedAt: undefined });

    const res = await req(`/${OWNER}/${REPO}/${ref}/ios/artifact`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_ready", status: "building" });
  });

  it("404s when nothing is registered", async () => {
    const res = await req(`/${OWNER}/${REPO}/artifact-missing/ios/artifact`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", status: "no-pointer" });
  });

  it("410s when the artifact has expired", async () => {
    // No expirationDate: an expired record whose artifact EAS already dropped.
    // A PAST expirationDate would mark the pointer stale and force an EAS call.
    const ref = "artifact-expired";
    await seed(ref, "ios", { status: "expired" });

    const res = await req(`/${OWNER}/${REPO}/${ref}/ios/artifact`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired" });
  });
});

describe("QR images", () => {
  const qrPath = `/${OWNER}/${REPO}/qr-branch/ios`;

  it("serves PNG with an exact content-type and a short cache-control", async () => {
    const res = await req(`${qrPath}/qr.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const cc = res.headers.get("cache-control") ?? "";
    const maxAge = /(?:^|[\s,])max-age=(\d+)/.exec(cc);
    expect(maxAge, `cache-control was ${cc}`).not.toBeNull();
    // Camo freezes an uncached origin for a year; anything near that defeats
    // the whole point of a permalink that follows the latest build.
    const seconds = Number(maxAge?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(600);
    expect(cc).not.toContain("31536000");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves SVG as exactly image/svg+xml, with no charset suffix", async () => {
    const res = await req(`${qrPath}/qr.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");

    const svg = await res.text();
    expect(svg).toContain("<svg");
    // The library emits no background and no fill; unpatched it is unscannable
    // on a dark theme.
    expect(svg).toContain('fill="#ffffff"');
  });

  it("ignores the ?c= cache-buster: identical bytes with and without it", async () => {
    const plain = new Uint8Array(await (await req(`${qrPath}/qr.png`)).arrayBuffer());
    const busted = new Uint8Array(
      await (await req(`${qrPath}/qr.png?c=abc123def456`)).arrayBuffer(),
    );
    expect(busted.length).toBe(plain.length);
    expect([...busted]).toEqual([...plain]);
  });

  it("reads no pointer at all, so a QR works before anything is registered", async () => {
    const res = await req(`/${OWNER}/${REPO}/no-such-branch-at-all/android/qr.svg`);
    expect(res.status).toBe(200);
  });
});

describe("branch names containing a slash", () => {
  const ref = "feat/new-onboarding";
  const path = `/${OWNER}/${REPO}/${ref}`;

  it("round-trips through the page, the JSON and the QR routes", async () => {
    await seed(ref, "ios", ready());

    const page = await req(`${path}/ios`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("feat/new-onboarding");
    // The permalink echoed back to the reader keeps the slash literal.
    expect(html).toContain(`${ORIGIN}${path}/ios`);

    const body = (await (await req(`${path}/ios.json`)).json()) as { ref: string; status: string };
    expect(body.ref).toBe(ref);
    expect(body.status).toBe("ready");

    expect((await req(`${path}/ios/qr.png`)).status).toBe(200);
    expect((await req(`${path}/ios/artifact`)).status).toBe(302);
  });

  it("is keyed identically whether or not the slash is percent-encoded", async () => {
    await seed(ref, "android", ready({ artifactUrl: "https://expo.dev/artifacts/eas/a.apk" }));
    const encoded = await req(`/${OWNER}/${REPO}/feat%2Fnew-onboarding/android.json`);
    const body = (await encoded.json()) as { ref: string; status: string };
    expect(body.ref).toBe(ref);
    expect(body.status).toBe("ready");
  });
});

describe("<platform>.json", () => {
  it("returns the documented shape for a ready build", async () => {
    const ref = "json-ready";
    await seed(ref, "ios", ready());

    const res = await req(`/${OWNER}/${REPO}/${ref}/ios.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "appIdentifier",
        "appVersion",
        "buildId",
        "buildPageUrl",
        "expiresAt",
        "installUrl",
        "platform",
        "ref",
        "sha",
        "status",
      ].sort(),
    );
    expect(body.status).toBe("ready");
    expect(body.platform).toBe("ios");
    expect(body.ref).toBe(ref);
    expect(body.buildId).toBe(BUILD_ID);
    expect(body.sha).toBe(SHA);
    expect(body.buildPageUrl).toBe(
      `https://expo.dev/accounts/acme/projects/mobile/builds/${BUILD_ID}`,
    );
    // installUrl is the HTML install page, not the .json endpoint it was asked from.
    expect(body.installUrl).toBe(`${ORIGIN}/${OWNER}/${REPO}/${ref}/ios`);
  });

  it("returns the no-pointer shape rather than 404 when nothing is registered", async () => {
    const res = await req(`/${OWNER}/${REPO}/json-missing/android.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "no-pointer",
      platform: "android",
      ref: "json-missing",
      installUrl: `${ORIGIN}/${OWNER}/${REPO}/json-missing/android`,
    });
  });
});

describe("response headers", () => {
  it("marks every permalink HTML response no-store and noindex", async () => {
    await seed("hdr-ready", "ios", ready());
    await seed("hdr-failed", "android", { status: "failed", errorMessage: "gradle exploded" });

    const paths = [
      `/${OWNER}/${REPO}/hdr-ready/ios`,
      `/${OWNER}/${REPO}/hdr-failed/android`,
      `/${OWNER}/${REPO}/hdr-missing/ios`,
      "/not-a-permalink",
    ];

    for (const path of paths) {
      const res = await req(path);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    }
  });

  it("keeps the landing page noindex too (it is the one cacheable HTML page)", async () => {
    const res = await req("/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // Deliberately NOT no-store: it is static, holds no build data and reads no KV.
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});

describe("routing", () => {
  it("renders the landing page at /", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("expo-preview-links");
    expect(html).toContain("&lt;branch&gt;");
  });

  it("404s unroutable paths", async () => {
    for (const path of [
      "/nope",
      "/acme",
      "/acme/mobile-app",
      "/acme/mobile-app/main/windows",
      "/acme/mobile-app/main/ios/nonsense",
      "/acme/mobile-app//ios",
      "/acme/mobile-app/../ios",
    ]) {
      const res = await req(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("405s a POST to a read route", async () => {
    for (const path of [
      "/",
      `/${OWNER}/${REPO}/main/ios`,
      `/${OWNER}/${REPO}/main/ios.json`,
      `/${OWNER}/${REPO}/main/ios/artifact`,
      `/${OWNER}/${REPO}/main/ios/qr.png`,
    ]) {
      const res = await req(path, { method: "POST" });
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("GET, HEAD");
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("answers HEAD on a permalink with the page headers and no body", async () => {
    await seed("head-branch", "ios", ready());
    const res = await req(`/${OWNER}/${REPO}/head-branch/ios`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
