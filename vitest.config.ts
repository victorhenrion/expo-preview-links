import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One config, two runtimes: the worker suite runs on workerd, the action suite
// on plain node.
//
// Note: the Cloudflare plugin injects nodejs_compat into the TEST runtime, so a
// worker test can pass while production fails. Keep production code free of
// Node built-ins.
//
// `vitest.workspace.ts` was removed in Vitest 4 -- projects live here now, and
// `defineWorkersConfig` / `test.poolOptions.workers` went away when
// @cloudflare/vitest-pool-workers became @cloudflare/vitest-plugin.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "action",
          environment: "node",
          include: ["test/action/**/*.test.ts", "test/shared/**/*.test.ts"],
        },
      },
    ],
  },
});
