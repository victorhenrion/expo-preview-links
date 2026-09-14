/**
 * Sticky comment upsert. About fifty lines, which is why it is not a
 * third-party action dependency.
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";

export interface UpsertOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  marker: string;
  body: string;
}

export interface UpsertResult {
  id: number;
  url: string;
  action: "created" | "updated" | "unchanged";
}

type Octokit = ReturnType<typeof getOctokit>;

interface ExistingComment {
  id: number;
  body?: string | undefined;
  html_url: string;
}

async function findExisting(
  octokit: Octokit,
  opts: UpsertOptions,
): Promise<ExistingComment | null> {
  // Paginate: the default page size is 30, so on a busy PR our comment falls
  // off page one and a naive single request would post a duplicate.
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.issueNumber,
    per_page: 100,
  });

  for await (const { data } of iterator) {
    for (const comment of data) {
      // startsWith, not includes: a human quoting our marker in a reply must
      // not be mistaken for the bot's own comment. The Bot check is the
      // second half of that guard.
      const body = comment.body ?? "";
      if (body.startsWith(opts.marker) && comment.user?.type === "Bot") {
        return { id: comment.id, body: comment.body, html_url: comment.html_url };
      }
    }
  }
  return null;
}

export async function upsertStickyComment(opts: UpsertOptions): Promise<UpsertResult> {
  const octokit = getOctokit(opts.token);

  const existing = await findExisting(octokit, opts);

  if (existing) {
    if (existing.body === opts.body) {
      core.info("Preview comment is already up to date; skipping the write.");
      return { id: existing.id, url: existing.html_url, action: "unchanged" };
    }
    const { data } = await octokit.rest.issues.updateComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: existing.id,
      body: opts.body,
    });
    return { id: data.id, url: data.html_url, action: "updated" };
  }

  // Re-check immediately before creating. `concurrency: cancel-in-progress`
  // narrows the double-post race but does not close it, and a duplicate
  // comment is the most visible way this bot can misbehave.
  const recheck = await findExisting(octokit, opts);
  if (recheck) {
    const { data } = await octokit.rest.issues.updateComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: recheck.id,
      body: opts.body,
    });
    return { id: data.id, url: data.html_url, action: "updated" };
  }

  const { data } = await octokit.rest.issues.createComment({
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.issueNumber,
    body: opts.body,
  });
  return { id: data.id, url: data.html_url, action: "created" };
}

/** Fetch the current sticky comment body, if any -- used to read epl-state. */
export async function findStickyCommentBody(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
): Promise<string | null> {
  const octokit = getOctokit(token);
  const existing = await findExisting(octokit, {
    token,
    owner,
    repo,
    issueNumber,
    marker,
    body: "",
  });
  return existing?.body ?? null;
}
