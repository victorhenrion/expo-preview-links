import { describe, expect, it } from "vitest";
import {
  ArtifactUrlError,
  allowedArtifactHosts,
  assertArtifactUrl,
  buildPageUrl,
  DEFAULT_ALLOWED_ARTIFACT_HOSTS,
  EXPO_API_BASE,
  EXPO_WEB_BASE,
  iosInstallUrl,
  iosManifestUrl,
  normalizeBaseUrl,
  permalink,
  qrUrl,
} from "../../src/shared/urls.js";

const APP_ID = "b0f1e4a2-9c3d-4e5f-8a7b-1c2d3e4f5a6b";
const BUILD_ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const BASE = "https://links.example.com";

describe("bases", () => {
  it("point at the real Expo hosts, over https, with no trailing slash", () => {
    expect(EXPO_API_BASE).toBe("https://api.expo.dev");
    expect(EXPO_WEB_BASE).toBe("https://expo.dev");
  });
});

describe("iosManifestUrl", () => {
  it("is the v2 projects/builds manifest.plist path", () => {
    expect(iosManifestUrl(APP_ID, BUILD_ID)).toBe(
      `https://api.expo.dev/v2/projects/${APP_ID}/builds/${BUILD_ID}/manifest.plist`,
    );
  });
});

describe("iosInstallUrl", () => {
  it("is byte-for-byte eas-cli's getInternalDistributionInstallUrl", () => {
    expect(iosInstallUrl(APP_ID, BUILD_ID)).toBe(
      "itms-services://?action=download-manifest;url=https://api.expo.dev/v2/projects/" +
        `${APP_ID}/builds/${BUILD_ID}/manifest.plist`,
    );
  });

  it("uses a SEMICOLON before url=, not an ampersand", () => {
    const url = iosInstallUrl(APP_ID, BUILD_ID);
    expect(url).toContain("?action=download-manifest;url=");
    expect(url).not.toContain("&url=");
    expect(url.indexOf(";")).toBeGreaterThan(url.indexOf("?action="));
  });

  it("does NOT percent-encode the manifest URL", () => {
    const url = iosInstallUrl(APP_ID, BUILD_ID);
    expect(url).toContain("url=https://api.expo.dev/");
    expect(url).not.toContain("https%3A%2F%2F");
    expect(url).not.toContain("%2F");
  });

  it("embeds exactly the iosManifestUrl", () => {
    expect(iosInstallUrl(APP_ID, BUILD_ID)).toBe(
      `itms-services://?action=download-manifest;url=${iosManifestUrl(APP_ID, BUILD_ID)}`,
    );
  });
});

describe("buildPageUrl", () => {
  it("builds the expo.dev accounts/projects/builds path", () => {
    expect(buildPageUrl("acme", "my-app", BUILD_ID)).toBe(
      `https://expo.dev/accounts/acme/projects/my-app/builds/${BUILD_ID}`,
    );
  });

  it("percent-encodes every component, including slashes", () => {
    expect(buildPageUrl("a/b", "c d", "e?f")).toBe(
      "https://expo.dev/accounts/a%2Fb/projects/c%20d/builds/e%3Ff",
    );
  });

  it("encodes a component that would otherwise escape the path", () => {
    expect(buildPageUrl("../../evil", "s", "b")).toBe(
      "https://expo.dev/accounts/..%2F..%2Fevil/projects/s/builds/b",
    );
  });
});

describe("normalizeBaseUrl", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeBaseUrl("https://x.dev/")).toBe("https://x.dev");
  });

  it("strips repeated trailing slashes", () => {
    expect(normalizeBaseUrl("https://x.dev///")).toBe("https://x.dev");
  });

  it("leaves a base with no trailing slash alone", () => {
    expect(normalizeBaseUrl("https://x.dev")).toBe("https://x.dev");
    expect(normalizeBaseUrl("https://x.dev/sub")).toBe("https://x.dev/sub");
  });

  it("strips trailing slashes from a sub-path base", () => {
    expect(normalizeBaseUrl("https://x.dev/sub//")).toBe("https://x.dev/sub");
  });

  it("does not touch interior slashes", () => {
    expect(normalizeBaseUrl("https://x.dev/a//b")).toBe("https://x.dev/a//b");
  });
});

describe("permalink", () => {
  it("is <base>/<owner>/<repo>/<ref>/<platform>", () => {
    expect(permalink(BASE, "octocat", "hello-world", "main", "ios")).toBe(
      "https://links.example.com/octocat/hello-world/main/ios",
    );
  });

  it("lowercases owner and repo", () => {
    expect(permalink(BASE, "OctoCat", "Hello-World", "main", "android")).toBe(
      "https://links.example.com/octocat/hello-world/main/android",
    );
  });

  it("keeps the ref's case", () => {
    expect(permalink(BASE, "o", "r", "feat/New-Onboarding", "ios")).toBe(
      "https://links.example.com/o/r/feat/New-Onboarding/ios",
    );
  });

  it("keeps slashes in the ref literal", () => {
    expect(permalink(BASE, "o", "r", "release/1.2.x", "ios")).toBe(
      "https://links.example.com/o/r/release/1.2.x/ios",
    );
    expect(permalink(BASE, "o", "r", "a/b/c", "ios")).toBe(
      "https://links.example.com/o/r/a/b/c/ios",
    );
  });

  it("escapes %, # and ? in the ref but not its slashes", () => {
    expect(permalink(BASE, "o", "r", "feat/100%-#1?x", "ios")).toBe(
      "https://links.example.com/o/r/feat/100%25-%231%3Fx/ios",
    );
  });

  it("normalizes a base with a trailing slash so no double slash appears", () => {
    expect(permalink("https://links.example.com/", "o", "r", "main", "ios")).toBe(
      "https://links.example.com/o/r/main/ios",
    );
  });

  it("ends with the platform", () => {
    expect(permalink(BASE, "o", "r", "main", "ios").endsWith("/ios")).toBe(true);
    expect(permalink(BASE, "o", "r", "main", "android").endsWith("/android")).toBe(true);
  });
});

describe("qrUrl", () => {
  it("is the permalink plus /qr.png when there is no cache buster", () => {
    expect(qrUrl(BASE, "o", "r", "main", "ios")).toBe(
      `${permalink(BASE, "o", "r", "main", "ios")}/qr.png`,
    );
    expect(qrUrl(BASE, "o", "r", "main", "ios")).toBe(
      "https://links.example.com/o/r/main/ios/qr.png",
    );
  });

  it("appends ?c= when given a cache buster", () => {
    expect(qrUrl(BASE, "o", "r", "main", "ios", "abc123")).toBe(
      "https://links.example.com/o/r/main/ios/qr.png?c=abc123",
    );
  });

  it("truncates the cache buster to 12 characters", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(qrUrl(BASE, "o", "r", "main", "ios", sha)).toBe(
      "https://links.example.com/o/r/main/ios/qr.png?c=0123456789ab",
    );
    expect(new URL(qrUrl(BASE, "o", "r", "main", "ios", sha)).searchParams.get("c")).toHaveLength(
      12,
    );
  });

  it("percent-encodes the cache buster so it cannot inject query parameters", () => {
    expect(qrUrl(BASE, "o", "r", "main", "ios", "a&b=c")).toBe(
      "https://links.example.com/o/r/main/ios/qr.png?c=a%26b%3Dc",
    );
    const url = new URL(qrUrl(BASE, "o", "r", "main", "ios", "a&b=c"));
    expect([...url.searchParams.keys()]).toEqual(["c"]);
    expect(url.searchParams.get("c")).toBe("a&b=c");
  });

  it("omits ?c= for an empty-string cache buster", () => {
    expect(qrUrl(BASE, "o", "r", "main", "ios", "")).toBe(
      "https://links.example.com/o/r/main/ios/qr.png",
    );
  });

  it("does not change the encoded payload -- the permalink is a strict prefix", () => {
    const link = permalink(BASE, "o", "r", "feat/new-onboarding", "ios");
    expect(qrUrl(BASE, "o", "r", "feat/new-onboarding", "ios", "deadbeef")).toBe(
      `${link}/qr.png?c=deadbeef`,
    );
  });
});

describe("allowedArtifactHosts", () => {
  it("falls back to the locked-down default when unset, empty or whitespace", () => {
    expect(allowedArtifactHosts()).toEqual(["expo.dev", "api.expo.dev"]);
    expect(allowedArtifactHosts("")).toEqual(["expo.dev", "api.expo.dev"]);
    expect(allowedArtifactHosts("   ")).toEqual(["expo.dev", "api.expo.dev"]);
    expect(allowedArtifactHosts(undefined)).toEqual([...DEFAULT_ALLOWED_ARTIFACT_HOSTS]);
  });

  it("returns a fresh array, not the shared default constant", () => {
    const a = allowedArtifactHosts();
    const b = allowedArtifactHosts();
    expect(a).not.toBe(b);
    expect(a as readonly string[]).not.toBe(DEFAULT_ALLOWED_ARTIFACT_HOSTS);
  });

  it("splits on commas, trims and lowercases", () => {
    expect(allowedArtifactHosts("expo.dev, API.Expo.Dev ,  cdn.example.com")).toEqual([
      "expo.dev",
      "api.expo.dev",
      "cdn.example.com",
    ]);
  });

  it("drops empty entries from stray commas", () => {
    expect(allowedArtifactHosts("expo.dev,,, ,api.expo.dev,")).toEqual([
      "expo.dev",
      "api.expo.dev",
    ]);
  });

  it("accepts a single host", () => {
    expect(allowedArtifactHosts("cdn.example.com")).toEqual(["cdn.example.com"]);
  });
});

describe("assertArtifactUrl: accepted", () => {
  const allowed = allowedArtifactHosts();

  it("accepts a real EAS artifact URL on expo.dev", () => {
    const raw = `https://expo.dev/artifacts/eas/${BUILD_ID}.ipa`;
    const url = assertArtifactUrl(raw, allowed);
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe(raw);
    expect(url.hostname).toBe("expo.dev");
    expect(url.pathname.startsWith("/artifacts/")).toBe(true);
  });

  it("accepts an api.expo.dev URL outside /artifacts/ (the path rule is expo.dev-only)", () => {
    const raw = `https://api.expo.dev/v2/projects/${APP_ID}/builds/${BUILD_ID}/manifest.plist`;
    expect(assertArtifactUrl(raw, allowed).hostname).toBe("api.expo.dev");
  });

  it("accepts a host whose case differs from the allow-list entry", () => {
    expect(assertArtifactUrl("https://EXPO.DEV/artifacts/eas/x.apk", allowed).hostname).toBe(
      "expo.dev",
    );
    expect(assertArtifactUrl("https://expo.dev/artifacts/x", ["EXPO.DEV"]).hostname).toBe(
      "expo.dev",
    );
  });

  it("tolerates whitespace and blanks in the supplied allow-list", () => {
    expect(
      assertArtifactUrl("https://cdn.example.com/x", [" CDN.Example.com ", "", "  "]).hostname,
    ).toBe("cdn.example.com");
  });

  it("accepts a URL of exactly 2048 characters", () => {
    const prefix = "https://api.expo.dev/artifacts/";
    const raw = prefix + "a".repeat(2048 - prefix.length);
    expect(raw).toHaveLength(2048);
    expect(assertArtifactUrl(raw, allowed).hostname).toBe("api.expo.dev");
  });
});

describe("assertArtifactUrl: rejected", () => {
  const allowed = allowedArtifactHosts();

  const expectReject = (raw: string, pattern: RegExp) => {
    expect(() => assertArtifactUrl(raw, allowed), raw.slice(0, 60)).toThrow(ArtifactUrlError);
    expect(() => assertArtifactUrl(raw, allowed), raw.slice(0, 60)).toThrow(pattern);
  };

  it("throws ArtifactUrlError with a prefixed message", () => {
    try {
      assertArtifactUrl("https://evilexpo.dev/artifacts/x", allowed);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactUrlError);
      expect((err as ArtifactUrlError).name).toBe("ArtifactUrlError");
      expect((err as ArtifactUrlError).message).toMatch(/^Refusing artifact URL: /);
    }
  });

  it("rejects evilexpo.dev (suffix match is not membership)", () => {
    expectReject("https://evilexpo.dev/artifacts/x", /host evilexpo\.dev is not allow-listed/);
  });

  it("rejects expo.dev.attacker.com (prefix match is not membership)", () => {
    expectReject(
      "https://expo.dev.attacker.com/artifacts/x",
      /host expo\.dev\.attacker\.com is not allow-listed/,
    );
  });

  it("rejects a subdomain of an allow-listed host", () => {
    expectReject("https://evil.expo.dev/artifacts/x", /not allow-listed/);
  });

  it("rejects non-https schemes", () => {
    expectReject("http://expo.dev/artifacts/x", /protocol http: is not https/);
    expectReject("ftp://expo.dev/artifacts/x", /protocol ftp: is not https/);
    expectReject("javascript:alert(1)", /is not https/);
  });

  it("rejects embedded credentials", () => {
    expectReject("https://user:pass@expo.dev/artifacts/x", /contains embedded credentials/);
    expectReject("https://user@expo.dev/artifacts/x", /contains embedded credentials/);
  });

  it("rejects an IPv4 literal host", () => {
    expectReject("https://127.0.0.1/artifacts/x", /host is an IP literal/);
    expectReject("https://169.254.169.254/artifacts/x", /host is an IP literal/);
  });

  it("rejects an IPv6 literal host", () => {
    expectReject("https://[::1]/artifacts/x", /host is an IP literal/);
    expectReject("https://[fd00::1]/artifacts/x", /host is an IP literal/);
  });

  it("rejects a URL longer than 2048 characters", () => {
    const raw = `https://api.expo.dev/artifacts/${"a".repeat(2100)}`;
    expect(raw.length).toBeGreaterThan(2048);
    expectReject(raw, /longer than 2048 characters/);
  });

  it("rejects a non-URL string", () => {
    expectReject("not a url", /not a valid absolute URL/);
    expectReject("/artifacts/eas/x.ipa", /not a valid absolute URL/);
    expectReject("expo.dev/artifacts/x", /not a valid absolute URL/);
  });

  it("rejects an empty or non-string value", () => {
    expectReject("", /empty/);
    expect(() => assertArtifactUrl(null as unknown as string, allowed)).toThrow(/empty/);
    expect(() => assertArtifactUrl(undefined as unknown as string, allowed)).toThrow(/empty/);
  });

  it("rejects an expo.dev URL outside /artifacts/", () => {
    expectReject("https://expo.dev/not-artifacts/x", /expo\.dev URL is not under \/artifacts\//);
    expectReject("https://expo.dev/", /expo\.dev URL is not under \/artifacts\//);
    expectReject("https://expo.dev/artifactsfoo", /expo\.dev URL is not under \/artifacts\//);
  });

  it("rejects an allow-listed host when the allow-list is empty", () => {
    expect(() => assertArtifactUrl("https://expo.dev/artifacts/x", [])).toThrow(/not allow-listed/);
  });
});
