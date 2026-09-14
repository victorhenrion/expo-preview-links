import { describe, expect, it } from "vitest";
import {
  bindingKey,
  decodeRefPath,
  encodeRefPath,
  isValidRepoPart,
  normalizeRef,
  normalizeRepoPart,
  pointerKey,
  RefError,
  refHash,
} from "../../src/shared/ref.js";

/** sha256("main"), so the pointerKey assertions pin a real digest, not a shape. */
const SHA256_MAIN = "0d6e4079e36703ebd37c00722f5891d28b0e2811dc114b129215123adcce3605";

describe("normalizeRef: accepted refs", () => {
  it("strips the refs/heads/ prefix", () => {
    expect(normalizeRef("refs/heads/main")).toBe("main");
    expect(normalizeRef("refs/heads/feat/new-onboarding")).toBe("feat/new-onboarding");
  });

  it("leaves an already-short ref alone", () => {
    expect(normalizeRef("main")).toBe("main");
  });

  it("strips only the first refs/heads/ occurrence", () => {
    expect(normalizeRef("refs/heads/refs/heads/x")).toBe("refs/heads/x");
  });

  it("does not strip a refs/ prefix that is not refs/heads/", () => {
    expect(normalizeRef("refs/tags/v1")).toBe("refs/tags/v1");
  });

  it("accepts feat/new-onboarding", () => {
    expect(normalizeRef("feat/new-onboarding")).toBe("feat/new-onboarding");
  });

  it("accepts release/1.2.x", () => {
    expect(normalizeRef("release/1.2.x")).toBe("release/1.2.x");
  });

  it("accepts a ref containing a single dot, %, # and + (git allows them)", () => {
    expect(normalizeRef("release/v1.0")).toBe("release/v1.0");
    expect(normalizeRef("feat/100%-done")).toBe("feat/100%-done");
    expect(normalizeRef("feat/fix-#42")).toBe("feat/fix-#42");
    expect(normalizeRef("user/j+k")).toBe("user/j+k");
  });

  it("accepts a bare '@' inside a longer ref, and '@' not followed by '{'", () => {
    expect(normalizeRef("user@host")).toBe("user@host");
    expect(normalizeRef("v@1")).toBe("v@1");
  });

  it("accepts a component merely containing '.lock' but not ending in it", () => {
    expect(normalizeRef("feat/x.lockfile")).toBe("feat/x.lockfile");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRef("  main  ")).toBe("main");
    expect(normalizeRef("\tmain\n")).toBe("main");
  });

  it("accepts exactly 255 characters", () => {
    const ref = "a".repeat(255);
    expect(normalizeRef(ref)).toBe(ref);
  });

  it("accepts a 39- and a 41-hex string (only exactly 40 looks like a sha)", () => {
    expect(normalizeRef("0".repeat(39))).toBe("0".repeat(39));
    expect(normalizeRef("0".repeat(41))).toBe("0".repeat(41));
  });

  it("accepts a 40-char string that is not all hex", () => {
    const ref = `z${"0".repeat(39)}`;
    expect(normalizeRef(ref)).toBe(ref);
  });
});

describe("normalizeRef: rejected refs", () => {
  it("throws RefError, not a bare Error", () => {
    expect(() => normalizeRef("")).toThrow(RefError);
    try {
      normalizeRef("");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RefError);
      expect((err as RefError).name).toBe("RefError");
      expect((err as RefError).message).toMatch(/^Invalid git ref: /);
    }
  });

  it("rejects empty and whitespace-only input", () => {
    expect(() => normalizeRef("")).toThrow(/empty/);
    expect(() => normalizeRef("   ")).toThrow(/empty/);
    expect(() => normalizeRef("refs/heads/")).toThrow(/empty/);
  });

  it("rejects longer than 255 characters", () => {
    expect(() => normalizeRef("a".repeat(256))).toThrow(/longer than 255 characters/);
  });

  it("rejects '..'", () => {
    expect(() => normalizeRef("feat/..")).toThrow(/contains '\.\.'/);
    expect(() => normalizeRef("a..b")).toThrow(/contains '\.\.'/);
    expect(() => normalizeRef("../../etc/passwd")).toThrow(/contains '\.\.'/);
  });

  it("rejects '@{'", () => {
    expect(() => normalizeRef("main@{upstream}")).toThrow(/contains '@\{'/);
    expect(() => normalizeRef("@{-1}")).toThrow(/contains '@\{'/);
  });

  it("rejects a lone '@'", () => {
    expect(() => normalizeRef("@")).toThrow(/lone '@'/);
    expect(() => normalizeRef("  @  ")).toThrow(/lone '@'/);
  });

  it("rejects a leading slash", () => {
    expect(() => normalizeRef("/main")).toThrow(/starts or ends with '\/'/);
  });

  it("rejects a trailing slash", () => {
    expect(() => normalizeRef("feat/")).toThrow(/starts or ends with '\/'/);
  });

  it("rejects a doubled slash", () => {
    expect(() => normalizeRef("feat//x")).toThrow(/empty path component/);
  });

  it("rejects a component starting with '.'", () => {
    expect(() => normalizeRef(".hidden")).toThrow(/component starting with '\.'/);
    expect(() => normalizeRef("feat/.hidden")).toThrow(/component starting with '\.'/);
    expect(() => normalizeRef("feat/.hidden/x")).toThrow(/component starting with '\.'/);
  });

  it("rejects a component ending with '.lock'", () => {
    expect(() => normalizeRef("main.lock")).toThrow(/component ending with '\.lock'/);
    expect(() => normalizeRef("feat/main.lock")).toThrow(/component ending with '\.lock'/);
    expect(() => normalizeRef("feat/main.lock/x")).toThrow(/component ending with '\.lock'/);
  });

  it("rejects a trailing '.'", () => {
    expect(() => normalizeRef("main.")).toThrow(/ends with '\.'/);
    expect(() => normalizeRef("feat/x.")).toThrow(/ends with '\.'/);
  });

  it("rejects control characters", () => {
    for (const code of [0x00, 0x01, 0x07, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      const ref = `fe${String.fromCharCode(code)}at`;
      expect(() => normalizeRef(ref), `charCode ${code}`).toThrow(
        /character git forbids in a ref name/,
      );
    }
  });

  it("rejects an embedded space", () => {
    expect(() => normalizeRef("feat/new onboarding")).toThrow(
      /character git forbids in a ref name/,
    );
  });

  it("rejects the ~ ^ : ? * [ backslash set", () => {
    for (const char of ["~", "^", ":", "?", "*", "[", "\\"]) {
      expect(() => normalizeRef(`feat${char}x`), `char ${char}`).toThrow(
        /character git forbids in a ref name/,
      );
    }
  });

  it("rejects a 40-hex string in either case", () => {
    expect(() => normalizeRef("0123456789abcdef0123456789abcdef01234567")).toThrow(
      /looks like a commit sha/,
    );
    expect(() => normalizeRef("0123456789ABCDEF0123456789ABCDEF01234567")).toThrow(
      /looks like a commit sha/,
    );
    expect(() => normalizeRef(`refs/heads/${"f".repeat(40)}`)).toThrow(/looks like a commit sha/);
  });

  it("rejects a non-string input", () => {
    expect(() => normalizeRef(null as unknown as string)).toThrow(RefError);
    expect(() => normalizeRef(42 as unknown as string)).toThrow(RefError);
  });
});

describe("refHash", () => {
  it("is 64 lowercase hex characters", async () => {
    const hash = await refHash("main");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known sha256 of the input", async () => {
    await expect(refHash("main")).resolves.toBe(SHA256_MAIN);
  });

  it("is deterministic across calls", async () => {
    const [a, b] = await Promise.all([
      refHash("feat/new-onboarding"),
      refHash("feat/new-onboarding"),
    ]);
    expect(a).toBe(b);
  });

  it("differs for different refs, including case-only differences", async () => {
    expect(await refHash("main")).not.toBe(await refHash("Main"));
    expect(await refHash("feat/a")).not.toBe(await refHash("feat/b"));
  });

  it("handles a ref with multi-byte UTF-8 without throwing", async () => {
    await expect(refHash("feat/café")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalizeRepoPart", () => {
  it("lowercases", () => {
    expect(normalizeRepoPart("Octocat")).toBe("octocat");
    expect(normalizeRepoPart("HELLO-World")).toBe("hello-world");
  });
});

describe("pointerKey", () => {
  it("has the shape b:<owner>/<repo>:<sha256>:<platform>", async () => {
    const key = await pointerKey("octocat", "hello-world", "main", "ios");
    expect(key).toBe(`b:octocat/hello-world:${SHA256_MAIN}:ios`);
    expect(key.split(":")).toHaveLength(4);
  });

  it("lowercases owner and repo", async () => {
    await expect(pointerKey("OctoCat", "Hello-World", "main", "android")).resolves.toBe(
      `b:octocat/hello-world:${SHA256_MAIN}:android`,
    );
  });

  it("is case-insensitive for owner and repo", async () => {
    const a = await pointerKey("OCTOCAT", "HELLO-WORLD", "main", "ios");
    const b = await pointerKey("octocat", "hello-world", "main", "ios");
    expect(a).toBe(b);
  });

  it("is case-SENSITIVE for the ref", async () => {
    const lower = await pointerKey("octocat", "hello-world", "main", "ios");
    const upper = await pointerKey("octocat", "hello-world", "Main", "ios");
    expect(lower).not.toBe(upper);
  });

  it("separates platforms", async () => {
    const ios = await pointerKey("o", "r", "main", "ios");
    const android = await pointerKey("o", "r", "main", "android");
    expect(ios).not.toBe(android);
    expect(ios.endsWith(":ios")).toBe(true);
    expect(android.endsWith(":android")).toBe(true);
  });

  it("keeps the hashed ref out of the key so a slashy ref cannot forge a key", async () => {
    const key = await pointerKey("o", "r", "feat/new-onboarding", "ios");
    expect(key).not.toContain("feat/new-onboarding");
    expect(key).toBe(`b:o/r:${await refHash("feat/new-onboarding")}:ios`);
  });
});

describe("bindingKey", () => {
  it("has the shape r:<owner>/<repo>, lowercased", () => {
    expect(bindingKey("OctoCat", "Hello-World")).toBe("r:octocat/hello-world");
    expect(bindingKey("octocat", "hello-world")).toBe("r:octocat/hello-world");
  });

  it("cannot collide with a pointer key", async () => {
    expect(bindingKey("o", "r").startsWith("r:")).toBe(true);
    expect((await pointerKey("o", "r", "main", "ios")).startsWith("b:")).toBe(true);
  });
});

describe("encodeRefPath", () => {
  it("leaves slashes literal", () => {
    expect(encodeRefPath("feat/new-onboarding")).toBe("feat/new-onboarding");
    expect(encodeRefPath("a/b/c")).toBe("a/b/c");
  });

  it("escapes %, #, ? and &", () => {
    expect(encodeRefPath("100%")).toBe("100%25");
    expect(encodeRefPath("fix-#42")).toBe("fix-%2342");
    expect(encodeRefPath("a?b")).toBe("a%3Fb");
    expect(encodeRefPath("a&b")).toBe("a%26b");
    expect(encodeRefPath("feat/a%b#c?d&e")).toBe("feat/a%25b%23c%3Fd%26e");
  });

  it("leaves unreserved characters alone", () => {
    expect(encodeRefPath("release/1.2.x-rc_1~")).toBe("release/1.2.x-rc_1~");
  });

  it("escapes a literal percent-escape so it survives exactly one decode", () => {
    expect(encodeRefPath("%2e%2e%2f")).toBe("%252e%252e%252f");
    expect(encodeRefPath("%2F")).toBe("%252F");
  });

  it("does not escape a literal slash even in a traversal-shaped ref", () => {
    // Slashes are structural here: encodeRefPath splits on them first.
    expect(encodeRefPath("a/../b")).toBe("a/../b");
  });
});

describe("decodeRefPath", () => {
  it("joins segments with slashes", () => {
    expect(decodeRefPath(["feat", "new-onboarding"])).toBe("feat/new-onboarding");
    expect(decodeRefPath(["main"])).toBe("main");
  });

  it("round-trips with encodeRefPath", () => {
    for (const ref of [
      "main",
      "feat/new-onboarding",
      "release/1.2.x",
      "feat/100%-done",
      "feat/fix-#42",
      "a&b?c",
      "%2e%2e%2f",
    ]) {
      const encoded = encodeRefPath(ref);
      expect(decodeRefPath(encoded.split("/")), ref).toBe(ref);
    }
  });

  it("decodes EXACTLY ONCE: %252e%252e%252f does not become ../", () => {
    const decoded = decodeRefPath(["%252e%252e%252f"]);
    expect(decoded).toBe("%2e%2e%2f");
    expect(decoded).not.toBe("../");
    expect(decoded).not.toContain("..");
    expect(decoded).not.toContain("/");
  });

  it("decodes a single encoded slash without splitting the segment", () => {
    expect(decodeRefPath(["a%2Fb"])).toBe("a/b");
    expect(decodeRefPath(["a%2Fb", "c"])).toBe("a/b/c");
  });

  it("decodes a percent-escaped percent to a single percent", () => {
    expect(decodeRefPath(["100%25"])).toBe("100%");
  });
});

describe("isValidRepoPart", () => {
  it("accepts letters, digits, dot, underscore and hyphen", () => {
    expect(isValidRepoPart("octocat")).toBe(true);
    expect(isValidRepoPart("Hello-World")).toBe(true);
    expect(isValidRepoPart("a.b_c-d9")).toBe(true);
    expect(isValidRepoPart("a")).toBe(true);
    expect(isValidRepoPart("a".repeat(100))).toBe(true);
  });

  it("rejects empty and over-long parts", () => {
    expect(isValidRepoPart("")).toBe(false);
    expect(isValidRepoPart("a".repeat(101))).toBe(false);
  });

  it("rejects '.' and '..'", () => {
    expect(isValidRepoPart(".")).toBe(false);
    expect(isValidRepoPart("..")).toBe(false);
  });

  it("rejects path separators and other punctuation", () => {
    for (const s of ["a/b", "a\\b", "a b", "a:b", "a%b", "a?b", "../etc", "a#b", "a@b"]) {
      expect(isValidRepoPart(s), s).toBe(false);
    }
  });

  it("rejects a value with a newline, anchoring the regex at both ends", () => {
    expect(isValidRepoPart("ok\nbad/")).toBe(false);
    expect(isValidRepoPart("ok\n")).toBe(false);
  });
});
