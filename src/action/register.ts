/**
 * Mints the GitHub OIDC token and hands the build descriptors to the Worker.
 * Also the optional wait-for-build poller.
 *
 * Note what is NOT sent: the branch, the owner and the repo. The Worker reads
 * all three from the signed token instead, so a compromised or malicious
 * caller cannot address another repository's permalinks.
 */

import * as core from "@actions/core";
import type { BuildState, Platform, PointerStatusJson } from "../shared/types.js";
import { normalizeBaseUrl } from "../shared/urls.js";
import type { StartedBuild } from "./eas.js";

export interface RegisterMeta {
  prNumber?: number;
  commitSha?: string;
  message?: string;
}

export interface RegisterResult {
  registered: Array<{ platform: Platform; url: string }>;
}

export async function register(
  baseUrl: string,
  builds: StartedBuild[],
  meta: RegisterMeta,
): Promise<RegisterResult> {
  const base = normalizeBaseUrl(baseUrl);

  // Requires `permissions: id-token: write`. On a fork pull_request run GitHub
  // caps id-token at `read`, so this throws -- which is why main.ts gates fork
  // PRs out before ever getting here.
  let token: string;
  try {
    token = await core.getIDToken(base);
  } catch (err) {
    throw new Error(
      `Could not mint a GitHub OIDC token. Add \`id-token: write\` to the job's ` +
        `permissions block. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const body = {
    builds: builds.map((b) => ({
      platform: b.platform,
      buildId: b.buildId,
      appId: b.appId,
      account: b.account,
      slug: b.slug,
      profile: b.profile,
      ...(b.appVersion ? { appVersion: b.appVersion } : {}),
    })),
    ...(meta.prNumber ? { prNumber: meta.prNumber } : {}),
    ...(meta.commitSha ? { commitSha: meta.commitSha } : {}),
    ...(meta.message ? { message: meta.message } : {}),
  };

  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    let reason = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      reason = parsed.message ?? parsed.error ?? reason;
      if (parsed.error === "repo_binding_mismatch") {
        throw new Error(
          `The Worker has this repository bound to a different GitHub repository id. ` +
            `If you deleted and recreated the repo, clear the binding and re-run:\n  ${reason}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("The Worker has")) throw err;
    }
    throw new Error(`Registering builds with ${base} failed (HTTP ${res.status}): ${reason}`);
  }

  const parsed = JSON.parse(text) as RegisterResult;
  core.info(`Registered ${parsed.registered.length} build(s) with ${base}`);
  return parsed;
}

const TERMINAL: ReadonlySet<BuildState> = new Set<BuildState>([
  "ready",
  "failed",
  "canceled",
  "expired",
]);

/**
 * Poll the WORKER, not eas-cli.
 *
 * Reusing the Worker's resolver means exactly one piece of code in this repo
 * knows how to read EAS, and the polling phase needs no EXPO_TOKEN and no
 * live checkout.
 */
export async function waitForBuilds(
  permalinks: Map<Platform, string>,
  timeoutMinutes: number,
  pollSeconds = 30,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Map<Platform, PointerStatusJson>> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const results = new Map<Platform, PointerStatusJson>();

  while (Date.now() < deadline) {
    let allDone = true;

    for (const [platform, url] of permalinks) {
      const existing = results.get(platform);
      if (existing && TERMINAL.has(existing.status)) continue;

      try {
        const res = await fetch(`${url}.json`, { headers: { accept: "application/json" } });
        if (res.ok) {
          const status = (await res.json()) as PointerStatusJson;
          results.set(platform, status);
          if (!TERMINAL.has(status.status)) allDone = false;
        } else {
          allDone = false;
        }
      } catch (err) {
        core.debug(`Polling ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
        allDone = false;
      }
    }

    if (allDone && results.size === permalinks.size) return results;
    await sleep(pollSeconds * 1000);
  }

  core.warning(
    `Timed out after ${timeoutMinutes} minutes waiting for builds. ` +
      `The permalinks stay live -- they will show the finished build whenever it lands.`,
  );
  return results;
}
