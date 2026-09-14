/// <reference types="@cloudflare/vitest-plugin/types" />
import { env as testEnv } from "cloudflare:test";
import { env as wEnv, exports as wExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("probe", () => {
  it("cloudflare:workers", async () => {
    console.log("wEnv BUILDS", typeof (wEnv as any).BUILDS, "same as test env?", (wEnv as any).BUILDS === (testEnv as any).BUILDS);
    console.log("exports", Object.keys(wExports ?? {}));
    const r = await (wExports as any).default.fetch("https://example.com/healthz");
    console.log("via exports", r.status, await r.text());
    expect(true).toBe(true);
  });
});
