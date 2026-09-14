import { describe, expect, it } from "vitest";
import {
  COMMENT_MAX_BYTES,
  type CommentContext,
  escapeMd,
  marker,
  type PlatformRow,
  parsePreviousBuildIds,
  renderComment,
  renderCommentState,
  STATE_RE,
} from "../../src/action/markdown.js";
import type { BuildState, Platform } from "../../src/shared/types.js";
import { buildPageUrl, permalink, qrUrl } from "../../src/shared/urls.js";

const BASE = "https://links.example.com";
const OWNER = "VictorHenrion";
const REPO = "Expo-Preview-Links";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REF = "feature/login";
const IOS_BUILD = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
const ANDROID_BUILD = "1f2e3d4c-5b6a-4790-8812-aabbccddeeff";

function row(platform: Platform, state: BuildState, extra: Partial<PlatformRow> = {}): PlatformRow {
  return {
    platform,
    state,
    permalink: permalink(BASE, OWNER, REPO, REF, platform),
    qrUrl: qrUrl(BASE, OWNER, REPO, REF, platform, SHA),
    ...extra,
  };
}

function ctx(rows: PlatformRow[], extra: Partial<CommentContext> = {}): CommentContext {
  return {
    owner: OWNER,
    repo: REPO,
    ref: REF,
    sha: SHA,
    prNumber: 42,
    profile: "preview",
    rows,
    ...extra,
  };
}

// --- sanitizer probes --------------------------------------------------------
// GitHub's markdown sanitizer is the whole reason this module exists, so the
// probes are written as generic scanners over the rendered body rather than as
// assertions about one hard-coded string.

/** Every `[text](target)` target, ignoring backslash-escaped brackets. */
function markdownLinkTargets(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?<!\\)\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function htmlTags(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

/** Every href-ish target in the body: markdown links plus raw HTML hrefs. */
function allHrefs(body: string): string[] {
  const html = [...body.matchAll(/\bhref="([^"]*)"/gi)].map((m) => m[1] ?? "");
  return [...markdownLinkTargets(body), ...html];
}

/** A body exercising every element the renderer can emit. */
function kitchenSink(): string {
  return renderComment(
    ctx(
      [
        row("ios", "ready", {
          buildId: IOS_BUILD,
          appVersion: "1.4.0",
          buildPageUrl: buildPageUrl("acme", "acme-app", IOS_BUILD),
        }),
        row("android", "failed", {
          buildId: ANDROID_BUILD,
          buildPageUrl: buildPageUrl("acme", "acme-app", ANDROID_BUILD),
          errorMessage: "Gradle build failed with exit code 1",
        }),
      ],
      { note: "1 superseded build cancelled" },
    ),
  );
}

describe("marker", () => {
  it("lowercases owner and repo", () => {
    expect(marker("VictorHenrion", "Expo-Preview-Links")).toBe(
      "<!-- expo-preview-links:v1:victorhenrion/expo-preview-links -->",
    );
  });

  it("is byte-identical for any casing of the same repo", () => {
    expect(marker("ACME", "APP")).toBe(marker("acme", "app"));
  });

  it("is the FIRST line of the rendered body", () => {
    const body = renderComment(ctx([row("ios", "building", { buildId: IOS_BUILD })]));
    expect(body.split("\n")[0]).toBe(marker(OWNER, REPO));
    expect(body.startsWith(marker(OWNER, REPO))).toBe(true);
  });

  it("is still the first line when the body is truncated", () => {
    const body = renderComment(
      ctx([
        row("ios", "failed", {
          buildId: IOS_BUILD,
          errorMessage: "Code signing error. ".repeat(6000),
        }),
      ]),
    );
    expect(body.split("\n")[0]).toBe(marker(OWNER, REPO));
  });
});

describe("renderCommentState / parsePreviousBuildIds", () => {
  it("round-trips the in-flight build ids through the rendered body", () => {
    const body = renderComment(
      ctx([
        row("ios", "building", { buildId: IOS_BUILD }),
        row("android", "building", { buildId: ANDROID_BUILD }),
      ]),
    );
    expect(parsePreviousBuildIds(body)).toEqual([IOS_BUILD, ANDROID_BUILD]);
  });

  it("emits the state block on its own line so the anchored regex matches", () => {
    const body = renderComment(ctx([row("ios", "building", { buildId: IOS_BUILD })]));
    expect(body.split("\n")[1]).toMatch(STATE_RE);
  });

  it("records pr and sha but omits them when absent", () => {
    const withMeta = renderCommentState(ctx([], { prNumber: 7, sha: SHA }));
    expect(JSON.parse(/^<!-- epl-state:(.*) -->$/.exec(withMeta)?.[1] ?? "")).toEqual({
      pr: 7,
      sha: SHA,
      builds: [],
    });

    const bare = renderCommentState(ctx([], { prNumber: undefined, sha: "" }));
    expect(JSON.parse(/^<!-- epl-state:(.*) -->$/.exec(bare)?.[1] ?? "")).toEqual({ builds: [] });
  });

  it("only records rows that actually have a buildId", () => {
    const state = renderCommentState(
      ctx([row("ios", "ready", { buildId: IOS_BUILD }), row("android", "no-pointer")]),
    );
    expect(state).toContain(IOS_BUILD);
    expect(state).toContain('"platform":"ios"');
    expect(state).not.toContain('"platform":"android"');
  });

  it("filters out ids that are not uuids", () => {
    const body = renderComment(
      ctx([
        row("ios", "building", { buildId: "not-a-uuid" }),
        row("android", "building", { buildId: ANDROID_BUILD }),
      ]),
    );
    expect(parsePreviousBuildIds(body)).toEqual([ANDROID_BUILD]);
  });

  it("accepts uppercase uuids", () => {
    const body = `<!-- epl-state:{"builds":[{"platform":"ios","buildId":"${IOS_BUILD.toUpperCase()}"}]} -->`;
    expect(parsePreviousBuildIds(body)).toEqual([IOS_BUILD.toUpperCase()]);
  });

  it("returns [] for an absent, empty, null or undefined body", () => {
    expect(parsePreviousBuildIds(undefined)).toEqual([]);
    expect(parsePreviousBuildIds(null)).toEqual([]);
    expect(parsePreviousBuildIds("")).toEqual([]);
    expect(parsePreviousBuildIds("### Some other comment entirely")).toEqual([]);
  });

  it("tolerates a malformed state block instead of throwing", () => {
    expect(parsePreviousBuildIds("<!-- epl-state:{not json at all} -->")).toEqual([]);
    expect(parsePreviousBuildIds('<!-- epl-state:{"builds":"nope"} -->')).toEqual([]);
    expect(parsePreviousBuildIds('<!-- epl-state:{"builds":[null,{},{"buildId":7}]} -->')).toEqual(
      [],
    );
    expect(parsePreviousBuildIds("<!-- epl-state: -->")).toEqual([]);
  });
});

describe("rendered states", () => {
  it("both platforms building", () => {
    const body = renderComment(
      ctx([
        row("ios", "building", { buildId: IOS_BUILD }),
        row("android", "building", { buildId: ANDROID_BUILD }),
      ]),
    );
    expect(body).toContain("🟡 building");
    expect(body).toContain(`[Open](${permalink(BASE, OWNER, REPO, REF, "ios")})`);
    expect(body).toContain(`[Open](${permalink(BASE, OWNER, REPO, REF, "android")})`);
    // No QR until there is something installable.
    expect(htmlTags(body, "img")).toHaveLength(0);
    expect(body).not.toContain("[Install]");
    expect(body).toContain("**iOS**");
    expect(body).toContain("**Android**");
    expect(body).toContain("Branch `feature/login`");
    expect(body).toContain("commit `0123456`");
    expect(body).toContain("profile `preview`");
  });

  it("one ready, one failed", () => {
    const body = renderComment(
      ctx([
        row("ios", "ready", {
          buildId: IOS_BUILD,
          appVersion: "1.4.0",
          buildPageUrl: buildPageUrl("acme", "acme-app", IOS_BUILD),
        }),
        row("android", "failed", {
          buildId: ANDROID_BUILD,
          buildPageUrl: buildPageUrl("acme", "acme-app", ANDROID_BUILD),
          errorMessage: "Gradle build failed with exit code 1",
        }),
      ]),
    );

    expect(body).toContain("🟢 ready");
    expect(body).toContain("🔴 failed");
    expect(body).toContain(`**[Install](${permalink(BASE, OWNER, REPO, REF, "ios")})**`);
    expect(body).toContain(`[View error](${buildPageUrl("acme", "acme-app", ANDROID_BUILD)})`);
    expect(body).not.toContain(`[Install](${permalink(BASE, OWNER, REPO, REF, "android")})`);

    // Exactly one QR: the ready platform.
    const imgs = htmlTags(body, "img");
    expect(imgs).toHaveLength(1);
    expect(attr(imgs[0] ?? "", "src")).toBe(qrUrl(BASE, OWNER, REPO, REF, "ios", SHA));
    expect(attr(imgs[0] ?? "", "alt")).toBe("QR code for the iOS build");

    // The error text lands in the details block.
    expect(body).toContain("**Build errors**");
    expect(body).toContain("Gradle build failed with exit code 1");
    // ...and the version badge is on the row.
    expect(body).toContain("1\\.4\\.0");
  });

  it("a failed row with no build page renders an em dash rather than a dead link", () => {
    const body = renderComment(
      ctx([row("ios", "failed", { buildId: IOS_BUILD, errorMessage: "boom" })]),
    );
    expect(body).not.toContain("[View error]");
    expect(body).toMatch(/\|\s*—\s*\|/);
    expect(body).toContain("boom");
  });

  it("both ready", () => {
    const body = renderComment(
      ctx([
        row("ios", "ready", { buildId: IOS_BUILD }),
        row("android", "ready", { buildId: ANDROID_BUILD }),
      ]),
    );
    const imgs = htmlTags(body, "img");
    expect(imgs).toHaveLength(2);
    expect(attr(imgs[0] ?? "", "src")).toBe(qrUrl(BASE, OWNER, REPO, REF, "ios", SHA));
    expect(attr(imgs[1] ?? "", "src")).toBe(qrUrl(BASE, OWNER, REPO, REF, "android", SHA));
    expect(body.match(/\*\*\[Install\]\(/g)).toHaveLength(2);
    expect(body).not.toContain("🟡 building");
    expect(body).not.toContain("**Build errors**");
  });

  it("expired links to Details, not Install", () => {
    const body = renderComment(ctx([row("ios", "expired", { buildId: IOS_BUILD })]));
    expect(body).toContain("🟠 expired");
    expect(body).toContain(`[Details](${permalink(BASE, OWNER, REPO, REF, "ios")})`);
    expect(body).not.toContain("[Install]");
    expect(htmlTags(body, "img")).toHaveLength(0);
    // The troubleshooting block explains the state.
    expect(body).toContain("**The build says expired?**");
  });

  it("unavailable falls back to the generic Open action", () => {
    const body = renderComment(ctx([row("ios", "unavailable")]));
    expect(body).toContain("⚪ unavailable");
    expect(body).toContain(`[Open](${permalink(BASE, OWNER, REPO, REF, "ios")})`);
    expect(htmlTags(body, "img")).toHaveLength(0);
  });

  it("covers no-pointer and canceled too", () => {
    const body = renderComment(
      ctx([row("ios", "no-pointer"), row("android", "canceled", { buildId: ANDROID_BUILD })]),
    );
    expect(body).toContain("⚪ not registered");
    expect(body).toContain("⚪ canceled");
    expect(body.match(/\[Open\]\(/g)).toHaveLength(2);
  });

  it("appends the note in italics when one is supplied, and nothing when not", () => {
    const withNote = renderComment(
      ctx([row("ios", "building", { buildId: IOS_BUILD })], {
        note: "2 superseded builds cancelled",
      }),
    );
    expect(withNote).toContain("_2 superseded builds cancelled_");

    const without = renderComment(ctx([row("ios", "building", { buildId: IOS_BUILD })]));
    expect(without).not.toContain("superseded");
  });

  it("omits the commit fragment when there is no sha", () => {
    const body = renderComment(ctx([row("ios", "building")], { sha: "" }));
    expect(body).not.toContain("· commit");
    expect(body).toContain("Branch `feature/login` · profile `preview`");
  });

  it("always lists the stable permalinks, whatever the state", () => {
    const body = renderComment(ctx([row("ios", "no-pointer"), row("android", "failed")]));
    expect(body).toContain(`- **iOS** — ${permalink(BASE, OWNER, REPO, REF, "ios")}`);
    expect(body).toContain(`- **Android** — ${permalink(BASE, OWNER, REPO, REF, "android")}`);
    expect(body).toContain("These links are **stable**");
  });

  it("matches the expected shape end to end", () => {
    expect(renderComment(ctx([row("ios", "ready", { buildId: IOS_BUILD })]))).toMatchSnapshot();
  });
});

describe("GitHub sanitizer rules", () => {
  it("uses no non-https scheme in any href", () => {
    const hrefs = allHrefs(kitchenSink());
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("https://"), `href must be https: ${href}`).toBe(true);
    }
  });

  it("never emits itms-services:, exp+, intent: or data: anywhere in the body", () => {
    const body = kitchenSink();
    expect(body).not.toContain("itms-services:");
    expect(body).not.toContain("exp+");
    expect(body).not.toContain("intent:");
    expect(body).not.toContain("data:");
    expect(body).not.toMatch(/\bhttp:\/\//);
  });

  it("emits no inline <svg>", () => {
    expect(kitchenSink()).not.toMatch(/<\s*svg/i);
  });

  it("uses no data: URI in any img src", () => {
    const imgs = htmlTags(kitchenSink(), "img");
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      const src = attr(img, "src") ?? "";
      expect(src).not.toMatch(/^data:/i);
      expect(src.startsWith("https://")).toBe(true);
    }
  });

  it("sizes every img with BARE INTEGER width/height (no px)", () => {
    const imgs = htmlTags(kitchenSink(), "img");
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(attr(img, "width")).toMatch(/^\d+$/);
      expect(attr(img, "height")).toMatch(/^\d+$/);
      expect(img).not.toMatch(/px/);
    }
  });

  it("emits no style= attribute anywhere", () => {
    expect(kitchenSink()).not.toMatch(/\sstyle\s*=/i);
  });

  it("uses only elements GitHub allows", () => {
    const tags = [...kitchenSink().matchAll(/<\/?([a-z][a-z0-9-]*)\b/gi)].map((m) =>
      (m[1] ?? "").toLowerCase(),
    );
    const allowed = new Set(["img", "details", "summary", "sub"]);
    for (const tag of new Set(tags)) {
      expect(allowed.has(tag), `unexpected element <${tag}>`).toBe(true);
    }
  });
});

describe("escapeMd", () => {
  it("neutralises the pipe character", () => {
    expect(escapeMd("a|b")).toBe("a\\|b");
  });

  it("escapes the other table- and markdown-breaking punctuation", () => {
    expect(escapeMd("*_`[]()#+-.!<>{}\\")).toBe(
      "\\*\\_\\`\\[\\]\\(\\)\\#\\+\\-\\.\\!\\<\\>\\{\\}\\\\",
    );
  });

  it("flattens newlines so a value cannot spill into the next table row", () => {
    expect(escapeMd("line one\r\nline two")).toBe("line one line two");
  });

  it("keeps a branch named a|b from breaking the table", () => {
    const body = renderComment(
      ctx([row("ios", "ready", { buildId: IOS_BUILD, appVersion: "1.0|--|evil" })], {
        ref: "a|b",
      }),
    );

    expect(body).toContain("Branch `a\\|b`");
    expect(body).not.toMatch(/Branch `a\|b`/);

    // Every body row of the table still has exactly the 6 delimiters the
    // 5-column header declares, once escaped pipes are removed.
    const tableLines = body.split("\n").filter((l) => l.startsWith("| "));
    expect(tableLines.length).toBe(2); // header + one platform row
    for (const line of tableLines) {
      expect(line.replaceAll("\\|", "").split("|").length - 1).toBe(6);
    }
  });

  it("escapes a piped note and error message too", () => {
    const body = renderComment(
      ctx([row("ios", "failed", { buildId: IOS_BUILD, errorMessage: "a|b" })], { note: "c|d" }),
    );
    expect(body).toContain("a\\|b");
    expect(body).toContain("_c\\|d_");
  });
});

describe("COMMENT_MAX_BYTES", () => {
  const LONG_REF = `feature/${"x".repeat(242)}`;

  it("the fixture really is a 250-character branch name", () => {
    expect(LONG_REF).toHaveLength(250);
  });

  it("stays under the cap with a 250-char branch and a long error message", () => {
    const body = renderComment(
      ctx(
        [
          row("ios", "failed", {
            buildId: IOS_BUILD,
            errorMessage: `xcodebuild: error: ${"Code signing is required for product type. ".repeat(4000)}`,
          }),
          row("android", "ready", { buildId: ANDROID_BUILD }),
        ],
        { ref: LONG_REF },
      ),
    );

    expect(body.length).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
    expect(body.endsWith("_…comment truncated._")).toBe(true);
  });

  it("does not truncate a 250-char branch with an ordinary error message", () => {
    const body = renderComment(
      ctx(
        [
          row("ios", "failed", {
            buildId: IOS_BUILD,
            errorMessage: "Fastlane failed. ".repeat(100),
          }),
          row("android", "ready", { buildId: ANDROID_BUILD }),
        ],
        { ref: LONG_REF },
      ),
    );

    expect(body.length).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
    expect(body).not.toContain("comment truncated");
    expect(body).toContain("</details>");
    expect(parsePreviousBuildIds(body)).toEqual([IOS_BUILD, ANDROID_BUILD]);
  });
});
