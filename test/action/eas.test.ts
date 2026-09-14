import { beforeEach, describe, expect, it, vi } from "vitest";

// eas.ts warns on every skipped entry. Mock the whole module so the suite stays
// quiet and so the warnings themselves become assertable.
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
}));

import * as core from "@actions/core";
import { extractJsonArray, parseStartedBuilds } from "../../src/action/eas.js";

const warning = vi.mocked(core.warning);

beforeEach(() => {
  vi.clearAllMocks();
});

const IOS_BUILD = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
const ANDROID_BUILD = "1f2e3d4c-5b6a-4790-8812-aabbccddeeff";
const APP_ID = "b0f1e4a2-9c3d-4e5f-8a7b-1c2d3e4f5a6b";

/**
 * Shaped after real `eas build --platform all --profile preview --no-wait
 * --json` output: an ARRAY even for one platform, uppercase platform enum,
 * and the app/ownerAccount nesting the parser reads.
 */
const TWO_BUILDS = [
  {
    id: IOS_BUILD,
    status: "NEW",
    platform: "IOS",
    artifacts: {},
    initiatingActor: { id: "3f0e9d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f", displayName: "github-actions" },
    buildProfile: "preview",
    appVersion: "1.4.0",
    appBuildVersion: "42",
    distribution: "INTERNAL",
    createdAt: "2026-09-14T09:12:04.000Z",
    app: {
      id: APP_ID,
      name: "Acme",
      slug: "acme-app",
      ownerAccount: { id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d", name: "acme" },
    },
  },
  {
    id: ANDROID_BUILD,
    status: "IN_QUEUE",
    platform: "ANDROID",
    artifacts: {},
    initiatingActor: { id: "3f0e9d1c-2b3a-4c5d-6e7f-8a9b0c1d2e3f", displayName: "github-actions" },
    buildProfile: "preview",
    appVersion: "1.4.0",
    appBuildVersion: "42",
    distribution: "INTERNAL",
    createdAt: "2026-09-14T09:12:05.000Z",
    app: {
      id: APP_ID,
      name: "Acme",
      slug: "acme-app",
      ownerAccount: { id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d", name: "acme" },
    },
  },
];

describe("extractJsonArray", () => {
  it("parses a realistic two-element payload", () => {
    const parsed = extractJsonArray(JSON.stringify(TWO_BUILDS, null, 2));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as { id: string }).id).toBe(IOS_BUILD);
  });

  it("parses an array wrapped in surrounding whitespace and newlines", () => {
    expect(extractJsonArray('\n\n  [{"id":"a"}]  \n')).toEqual([{ id: "a" }]);
  });

  it("still yields the array when eas leaks a log line onto stdout first", () => {
    const stdout = `Starting build for platform ios\n${JSON.stringify(TWO_BUILDS)}`;
    expect(extractJsonArray(stdout)).toHaveLength(2);
  });

  it("tolerates trailing noise after the array", () => {
    const stdout = `${JSON.stringify(TWO_BUILDS)}\nDone in 12.4s\n`;
    expect(extractJsonArray(stdout)).toHaveLength(2);
  });

  it("throws a clear error on empty stdout", () => {
    expect(() => extractJsonArray("")).toThrow("eas build produced no output on stdout");
    expect(() => extractJsonArray("   \n\t  ")).toThrow("eas build produced no output on stdout");
  });

  it("throws on a non-array JSON payload", () => {
    // `eas build:view` emits a bare object; `eas build` must not.
    expect(() => extractJsonArray('{"id":"8a7b","status":"NEW"}')).toThrow(
      /did not print a JSON array/,
    );
    expect(() => extractJsonArray("null")).toThrow(/did not print a JSON array/);
    expect(() => extractJsonArray("Error: not logged in")).toThrow(/did not print a JSON array/);
  });

  it("includes the offending output in the error message, capped", () => {
    expect(() => extractJsonArray("Error: EAS project not configured")).toThrow(
      /Got: Error: EAS project not configured/,
    );
    const long = "z".repeat(1000);
    let message = "";
    try {
      extractJsonArray(long);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("z".repeat(400));
    expect(message).not.toContain("z".repeat(401));
  });

  it("propagates a JSON syntax error when the bracketed slice is not valid JSON", () => {
    expect(() => extractJsonArray("[{oops}]")).toThrow(SyntaxError);
  });
});

describe("parseStartedBuilds", () => {
  it("turns a realistic two-element payload into two StartedBuilds", () => {
    const builds = parseStartedBuilds(TWO_BUILDS, "fallback-profile");

    expect(builds).toHaveLength(2);
    expect(builds[0]).toEqual({
      platform: "ios",
      buildId: IOS_BUILD,
      appId: APP_ID,
      account: "acme",
      slug: "acme-app",
      profile: "preview",
      appVersion: "1.4.0",
      status: "NEW",
    });
    expect(builds[1]).toEqual({
      platform: "android",
      buildId: ANDROID_BUILD,
      appId: APP_ID,
      account: "acme",
      slug: "acme-app",
      profile: "preview",
      appVersion: "1.4.0",
      status: "IN_QUEUE",
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it("round-trips straight from stdout", () => {
    const builds = parseStartedBuilds(
      extractJsonArray(JSON.stringify(TWO_BUILDS)),
      "fallback-profile",
    );
    expect(builds.map((b) => b.platform)).toEqual(["ios", "android"]);
  });

  it("parses a QUEUED build that has NO artifacts key at all", () => {
    // sanitizeValue DELETES null-valued keys, so a queued build simply has no
    // `artifacts` property. Reading through it must not throw.
    const queued = {
      id: IOS_BUILD,
      status: "IN_QUEUE",
      platform: "IOS",
      buildProfile: "preview",
      queuePosition: 3,
      estimatedWaitTimeLeftSeconds: 420,
      app: { id: APP_ID, slug: "acme-app", ownerAccount: { name: "acme" } },
    };
    expect(Object.hasOwn(queued, "artifacts")).toBe(false);

    let builds: ReturnType<typeof parseStartedBuilds> = [];
    expect(() => {
      builds = parseStartedBuilds([queued], "fallback-profile");
    }).not.toThrow();

    expect(builds).toHaveLength(1);
    expect(builds[0]?.buildId).toBe(IOS_BUILD);
    expect(builds[0]?.status).toBe("IN_QUEUE");
    // Optional keys are omitted, not set to undefined.
    expect(Object.hasOwn(builds[0] ?? {}, "appVersion")).toBe(false);
  });

  it("falls back to the supplied profile when buildProfile is absent", () => {
    const builds = parseStartedBuilds(
      [
        {
          id: IOS_BUILD,
          platform: "ios",
          app: { id: APP_ID, slug: "acme-app", ownerAccount: { name: "acme" } },
        },
      ],
      "fallback-profile",
    );
    expect(builds[0]?.profile).toBe("fallback-profile");
    expect(Object.hasOwn(builds[0] ?? {}, "status")).toBe(false);
  });

  it("accepts lowercase and uppercase platform spellings, rejects anything else", () => {
    const base = { id: IOS_BUILD, app: { id: APP_ID, slug: "s", ownerAccount: { name: "a" } } };
    expect(parseStartedBuilds([{ ...base, platform: "ios" }], "p")[0]?.platform).toBe("ios");
    expect(parseStartedBuilds([{ ...base, platform: "IOS" }], "p")[0]?.platform).toBe("ios");
    expect(parseStartedBuilds([{ ...base, platform: "Android" }], "p")[0]?.platform).toBe(
      "android",
    );
    expect(parseStartedBuilds([{ ...base, platform: "web" }], "p")).toEqual([]);
  });

  it("skips entries missing id, app.id, ownerAccount or slug rather than crashing", () => {
    const good = { id: APP_ID, slug: "acme-app", ownerAccount: { name: "acme" } };
    const entries = [
      { platform: "IOS", app: good }, // no id
      { id: IOS_BUILD, platform: "IOS", app: { slug: "acme-app", ownerAccount: { name: "acme" } } }, // no app.id
      { id: IOS_BUILD, platform: "IOS", app: { id: APP_ID, slug: "acme-app" } }, // no ownerAccount
      { id: IOS_BUILD, platform: "IOS", app: { id: APP_ID, ownerAccount: { name: "acme" } } }, // no slug
      { id: IOS_BUILD, platform: "IOS" }, // no app at all
      { id: IOS_BUILD, app: good }, // no platform
    ];

    let builds: ReturnType<typeof parseStartedBuilds> = [];
    expect(() => {
      builds = parseStartedBuilds(entries, "preview");
    }).not.toThrow();

    expect(builds).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(entries.length);
    expect(warning.mock.calls[0]?.[0]).toMatch(/missing required fields/);
  });

  it("survives null and primitive entries", () => {
    // Every value JSON.parse can actually produce in an array slot. (`undefined`
    // is deliberately excluded: JSON.stringify(undefined) returns undefined, so
    // the warning path in parseStartedBuilds would throw a TypeError on it --
    // unreachable from extractJsonArray, but see the note in the report.)
    const entries = [null, 7, "nope", true, []];
    let builds: ReturnType<typeof parseStartedBuilds> = [];
    expect(() => {
      builds = parseStartedBuilds(entries, "preview");
    }).not.toThrow();
    expect(builds).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(entries.length);
  });

  it("keeps the good entries alongside the bad ones", () => {
    const builds = parseStartedBuilds(
      [{ id: "no-app-here", platform: "IOS" }, ...TWO_BUILDS],
      "preview",
    );
    expect(builds.map((b) => b.buildId)).toEqual([IOS_BUILD, ANDROID_BUILD]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for empty input without warning", () => {
    expect(parseStartedBuilds([], "preview")).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
  });

  it("truncates the skipped entry in the warning to 200 characters", () => {
    parseStartedBuilds([{ platform: "IOS", junk: "j".repeat(500) }], "preview");
    const message = String(warning.mock.calls[0]?.[0] ?? "");
    const serialized = message.slice(message.indexOf(": ") + 2);
    expect(serialized.length).toBeLessThanOrEqual(200);
  });
});
