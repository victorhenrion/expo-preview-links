/**
 * Runs eas-cli and parses its output.
 *
 * eas-cli demands two specific defensive habits, and getting either wrong
 * produces a confusing failure rather than a clean one:
 *
 *  1. `--json` sends every non-JSON byte to STDERR. Merging the two streams
 *     corrupts the payload, so they are captured separately.
 *  2. `printJsonOnlyOutput`'s sanitizeValue DELETES null-valued keys rather
 *     than emitting null. On a queued build there is no `artifacts` key at
 *     all, so `build.artifacts.buildUrl` throws instead of yielding undefined.
 *     Everything is read with optional chaining.
 *
 * Also note `eas build` emits an ARRAY even for a single platform, while
 * `eas build:view` emits a bare object. The two are inconsistent.
 */

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import type { Platform, RegisterBuild } from "../shared/types.js";

export interface TriggerOptions {
  platform: "ios" | "android" | "all";
  profile: string;
  workingDirectory: string;
  message?: string;
  refreshAdHocProvisioningProfile: boolean;
}

/** One build as eas-cli reports it immediately after submission. */
export interface StartedBuild extends RegisterBuild {
  status?: string;
}

interface RawEasBuild {
  id?: string;
  status?: string;
  platform?: string;
  buildProfile?: string;
  appVersion?: string;
  app?: {
    id?: string;
    slug?: string;
    ownerAccount?: { name?: string };
  };
}

function toPlatform(raw: string | undefined): Platform | null {
  const v = (raw ?? "").toLowerCase();
  if (v === "ios") return "ios";
  if (v === "android") return "android";
  return null;
}

/**
 * Pull the JSON array out of stdout. eas-cli is supposed to print nothing else
 * there, but being tolerant of a stray leading line costs three lines and
 * turns a baffling parse error into a working run.
 */
export function extractJsonArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new Error("eas build produced no output on stdout");

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`eas build did not print a JSON array. Got: ${trimmed.slice(0, 400)}`);
  }

  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("eas build output was not an array");
  return parsed;
}

export function parseStartedBuilds(raw: unknown[], profileFallback: string): StartedBuild[] {
  const builds: StartedBuild[] = [];

  for (const entry of raw) {
    const b = entry as RawEasBuild;
    const platform = toPlatform(b?.platform);
    const buildId = b?.id;
    const appId = b?.app?.id;
    const account = b?.app?.ownerAccount?.name;
    const slug = b?.app?.slug;

    if (!platform || !buildId || !appId || !account || !slug) {
      core.warning(
        `Skipping a build entry that is missing required fields: ${JSON.stringify(entry).slice(0, 200)}`,
      );
      continue;
    }

    const build: StartedBuild = {
      platform,
      buildId,
      appId,
      account,
      slug,
      profile: b?.buildProfile ?? profileFallback,
    };
    if (b?.appVersion) build.appVersion = b.appVersion;
    if (b?.status) build.status = b.status;
    builds.push(build);
  }

  return builds;
}

export async function triggerBuilds(options: TriggerOptions): Promise<StartedBuild[]> {
  const args = [
    "build",
    "--platform",
    options.platform,
    "--profile",
    options.profile,
    "--non-interactive",
    // WAITING IS THE DEFAULT. The flag is `--[no-]wait`, so omitting this
    // blocks the runner for the entire 20-40 minute build.
    "--no-wait",
    "--json",
  ];
  if (options.message) args.push("--message", options.message);
  if (options.refreshAdHocProvisioningProfile) {
    args.push("--refresh-ad-hoc-provisioning-profile");
  }

  let stdout = "";
  let stderr = "";

  const exitCode = await exec.exec("eas", args, {
    cwd: options.workingDirectory,
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
      stderr: (data: Buffer) => {
        stderr += data.toString();
      },
    },
  });

  if (exitCode !== 0) {
    const detail = stderr.trim().slice(-1500) || stdout.trim().slice(-1500);
    if (/eas\.json/i.test(detail) && /not found|does not exist/i.test(detail)) {
      throw new Error(
        `eas build failed: no eas.json found in ${options.workingDirectory}. ` +
          `Run \`eas build:configure\`, or set the \`working-directory\` input.\n\n${detail}`,
      );
    }
    if (/project.*not configured|run .*eas init/i.test(detail)) {
      throw new Error(
        `eas build failed: this project is not linked to an EAS project. ` +
          `Run \`eas init\` and commit the resulting projectId.\n\n${detail}`,
      );
    }
    throw new Error(`eas build exited with code ${exitCode}.\n\n${detail}`);
  }

  if (stderr.trim()) core.debug(`eas build stderr:\n${stderr.trim()}`);

  const builds = parseStartedBuilds(extractJsonArray(stdout), options.profile);
  if (builds.length === 0) {
    throw new Error("eas build reported no builds. Check the build profile and platform inputs.");
  }
  return builds;
}

/**
 * Cancel builds a newer push has superseded.
 *
 * This is the highest-value operational safeguard here: free EAS plans stop
 * building when the monthly quota runs out and cannot incur overage, and more
 * than 50 pending builds per platform causes new builds to be rejected. A
 * build that already finished cannot be cancelled, and that is not an error.
 */
export async function cancelBuilds(
  buildIds: string[],
  workingDirectory: string,
): Promise<number> {
  let cancelled = 0;
  for (const id of buildIds) {
    const code = await exec.exec("eas", ["build:cancel", id, "--non-interactive"], {
      cwd: workingDirectory,
      ignoreReturnCode: true,
      silent: true,
    });
    if (code === 0) {
      cancelled += 1;
      core.info(`Cancelled superseded build ${id}`);
    } else {
      core.debug(`Could not cancel build ${id} (it has most likely already finished)`);
    }
  }
  return cancelled;
}
