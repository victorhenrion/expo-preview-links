/**
 * Action entry point.
 *
 * Ordering matters here, so it is spelled out:
 *   1. bail out early and loudly on a fork PR, before anything touches EAS;
 *   2. resolve the branch from the PR head ref -- never github.ref;
 *   3. read the existing comment to learn which builds this push supersedes;
 *   4. trigger the new builds;
 *   5. cancel the superseded ones (quota protection);
 *   6. register the new ones with the Worker;
 *   7. write the sticky comment;
 *   8. optionally wait, then rewrite the same comment.
 */

import * as core from "@actions/core";
import { context } from "@actions/github";
import type { BuildState, Platform, PointerStatusJson } from "../shared/types.js";
import { normalizeRef } from "../shared/ref.js";
import { normalizeBaseUrl, permalink, qrUrl } from "../shared/urls.js";
import { findStickyCommentBody, upsertStickyComment } from "./comment.js";
import { cancelBuilds, triggerBuilds, type StartedBuild } from "./eas.js";
import { marker, parsePreviousBuildIds, renderComment, type PlatformRow } from "./markdown.js";
import { register, waitForBuilds } from "./register.js";

function boolInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function requiredInput(name: string): string {
  // `required: true` in action.yml is documentation, not enforcement --
  // GitHub does not check it. Validate explicitly.
  const value = core.getInput(name).trim();
  if (value === "") throw new Error(`The \`${name}\` input is required but was empty.`);
  return value;
}

function platformsFor(input: string): Platform[] {
  if (input === "ios") return ["ios"];
  if (input === "android") return ["android"];
  return ["ios", "android"];
}

async function run(): Promise<void> {
  const pr = context.payload.pull_request;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  if (!pr) {
    core.setFailed(
      "This action expects a pull_request event. Trigger it with `on: pull_request`.",
    );
    return;
  }

  // Fork gate. eas-cli executes app.config.js, so running a build against fork
  // head code would be arbitrary code execution with EXPO_TOKEN in the
  // environment. GitHub also withholds secrets and caps id-token at `read` on
  // a fork pull_request run, so this path cannot work even if it were safe.
  const headRepo = pr.head?.repo?.full_name;
  if (headRepo && headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    core.notice(
      `Skipping preview builds: this pull request comes from the fork ${headRepo}. ` +
        `Secrets are not available to fork pull requests, which is deliberate. ` +
        `See the README section "Fork pull requests" for the supported alternative.`,
    );
    return;
  }

  const baseUrl = normalizeBaseUrl(requiredInput("base-url"));
  const profile = core.getInput("profile").trim() || "preview";
  const platformInput = (core.getInput("platform").trim() || "all") as "ios" | "android" | "all";
  const githubToken = core.getInput("github-token").trim();
  const shouldComment = boolInput("comment", true);
  const cancelSuperseded = boolInput("cancel-superseded", true);
  const shouldWait = boolInput("wait-for-build", false);
  const waitTimeout = Number(core.getInput("wait-timeout-minutes").trim() || "40");
  const refreshAdHoc = boolInput("refresh-ad-hoc-provisioning-profile", false);
  const workingDirectory = core.getInput("working-directory").trim() || process.cwd();

  // NEVER github.ref: on pull_request that is `refs/pull/N/merge`, and
  // github.ref_name is `N/merge`, which makes nonsense branch keys.
  const rawRef = pr.head?.ref;
  if (typeof rawRef !== "string" || rawRef === "") {
    core.setFailed("Could not read the pull request head ref from the event payload.");
    return;
  }
  const ref = normalizeRef(rawRef);
  const sha: string = pr.head?.sha ?? context.sha ?? "";
  const prNumber: number = pr.number;
  const message = core.getInput("message").trim() || `PR #${prNumber}: ${pr.title ?? ref}`;

  const commentMarker = marker(owner, repo);

  // Read the previous comment BEFORE building, so we know which builds this
  // push supersedes even if a later step fails.
  let supersededIds: string[] = [];
  if (githubToken && (shouldComment || cancelSuperseded)) {
    try {
      const previousBody = await findStickyCommentBody(
        githubToken,
        owner,
        repo,
        prNumber,
        commentMarker,
      );
      supersededIds = parsePreviousBuildIds(previousBody);
    } catch (err) {
      core.debug(`Could not read the previous comment: ${err instanceof Error ? err.message : err}`);
    }
  }

  core.info(`Triggering EAS builds for ${owner}/${repo}@${ref} (profile: ${profile})`);
  const builds: StartedBuild[] = await triggerBuilds({
    platform: platformInput,
    profile,
    workingDirectory,
    message,
    refreshAdHocProvisioningProfile: refreshAdHoc,
  });

  const startedIds = new Set(builds.map((b) => b.buildId));
  const toCancel = supersededIds.filter((id) => !startedIds.has(id));
  let cancelledCount = 0;
  if (cancelSuperseded && toCancel.length > 0) {
    cancelledCount = await cancelBuilds(toCancel, workingDirectory);
  }

  await register(baseUrl, builds, { prNumber, commitSha: sha, message });

  const permalinks = new Map<Platform, string>();
  for (const platform of platformsFor(platformInput)) {
    permalinks.set(platform, permalink(baseUrl, owner, repo, ref, platform));
  }

  const buildByPlatform = new Map<Platform, StartedBuild>(builds.map((b) => [b.platform, b]));

  const buildRows = (statuses?: Map<Platform, PointerStatusJson>): PlatformRow[] =>
    [...permalinks.entries()].map(([platform, link]) => {
      const build = buildByPlatform.get(platform);
      const status = statuses?.get(platform);
      const state: BuildState = status?.status ?? (build ? "building" : "no-pointer");
      const row: PlatformRow = {
        platform,
        state,
        permalink: link,
        qrUrl: qrUrl(baseUrl, owner, repo, ref, platform, sha),
      };
      if (status?.buildPageUrl) row.buildPageUrl = status.buildPageUrl;
      if (build?.buildId) row.buildId = build.buildId;
      const version = status?.appVersion ?? build?.appVersion;
      if (version) row.appVersion = version;
      if (status?.errorMessage) row.errorMessage = status.errorMessage;
      return row;
    });

  const note =
    cancelledCount > 0
      ? `${cancelledCount} superseded build${cancelledCount === 1 ? "" : "s"} cancelled.`
      : undefined;

  const commentContext = {
    owner,
    repo,
    ref,
    sha,
    prNumber,
    profile,
    rows: buildRows(),
    ...(note ? { note } : {}),
  };

  for (const [platform, link] of permalinks) {
    core.setOutput(`${platform}-url`, link);
    const build = buildByPlatform.get(platform);
    if (build) core.setOutput(`${platform}-build-id`, build.buildId);
  }

  if (shouldComment) {
    if (!githubToken) {
      core.warning("No `github-token` provided; skipping the pull request comment.");
    } else {
      const result = await upsertStickyComment({
        token: githubToken,
        owner,
        repo,
        issueNumber: prNumber,
        marker: commentMarker,
        body: renderComment(commentContext),
      });
      core.setOutput("comment-id", String(result.id));
      core.setOutput("comment-url", result.url);
      core.info(`Preview comment ${result.action}: ${result.url}`);
    }
  }

  await core.summary
    .addHeading("Expo preview builds", 3)
    .addRaw(`Branch <code>${ref}</code> · profile <code>${profile}</code>`)
    .addTable([
      [
        { data: "Platform", header: true },
        { data: "Build", header: true },
        { data: "Permalink", header: true },
      ],
      ...[...permalinks.entries()].map(([platform, link]) => [
        platform,
        buildByPlatform.get(platform)?.buildId ?? "—",
        link,
      ]),
    ])
    .write();

  if (shouldWait) {
    core.info(`Waiting up to ${waitTimeout} minutes for the builds to finish…`);
    const statuses = await waitForBuilds(permalinks, waitTimeout);

    if (shouldComment && githubToken) {
      await upsertStickyComment({
        token: githubToken,
        owner,
        repo,
        issueNumber: prNumber,
        marker: commentMarker,
        body: renderComment({ ...commentContext, rows: buildRows(statuses) }),
      });
    }

    const failed = [...statuses.values()].filter((s) => s.status === "failed");
    if (failed.length > 0) {
      core.setFailed(
        `${failed.length} build(s) failed: ${failed.map((f) => f.errorCode ?? f.platform).join(", ")}`,
      );
    }
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
