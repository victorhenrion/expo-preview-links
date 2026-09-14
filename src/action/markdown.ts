/**
 * The sticky PR comment body. A pure function, so it is trivially testable.
 *
 * GitHub's markdown sanitizer is the constraint that shapes this file:
 *
 *  - Anchor hrefs are limited to an allowlist of protocols (http, https,
 *    mailto, xmpp, irc, ircs, github-windows, github-mac, relative). So
 *    `itms-services://`, `exp+scheme://` and `intent://` are all stripped.
 *    That restriction is the structural reason the Worker permalink exists.
 *  - Inline `<svg>` is not an allowed element, and `<img src>` accepts only
 *    http, https and relative URLs -- no `data:` URIs. So the QR must be an
 *    `<img>` pointing at the Worker.
 *  - The `style` attribute is stripped from everything. Sizing must use bare
 *    integer `width`/`height` attributes; `width="250px"` is invalid HTML.
 */

import type { BuildState, Platform } from "../shared/types.js";

export const COMMENT_MAX_BYTES = 65_536;

/** Identifies our comment. Anchored to the start of the body when matching. */
export function marker(owner: string, repo: string): string {
  return `<!-- expo-preview-links:v1:${owner.toLowerCase()}/${repo.toLowerCase()} -->`;
}

/** Machine-readable state the NEXT run reads to cancel superseded builds. */
export const STATE_RE = /^<!-- epl-state:(\{.*\}) -->$/m;

export interface CommentState {
  pr?: number;
  sha?: string;
  builds: Array<{ platform: Platform; buildId: string }>;
}

export interface PlatformRow {
  platform: Platform;
  state: BuildState;
  permalink: string;
  qrUrl: string;
  buildPageUrl?: string;
  buildId?: string;
  appVersion?: string;
  errorMessage?: string;
}

export interface CommentContext {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  prNumber?: number;
  profile: string;
  rows: PlatformRow[];
  /** Appended verbatim under the table when set (e.g. "2 superseded builds cancelled"). */
  note?: string;
}

/** Escape the characters that would break out of a markdown table cell. */
export function escapeMd(input: string): string {
  return input
    .replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`)
    .replaceAll("\r", "")
    .replaceAll("\n", " ");
}

const PLATFORM_LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };

const STATE_LABEL: Record<BuildState, string> = {
  "no-pointer": "⚪ not registered",
  building: "🟡 building",
  ready: "🟢 ready",
  failed: "🔴 failed",
  canceled: "⚪ canceled",
  expired: "🟠 expired",
  unavailable: "⚪ unavailable",
};

function actionCell(row: PlatformRow): string {
  switch (row.state) {
    case "ready":
      return `**[Install](${row.permalink})**`;
    case "failed":
      return row.buildPageUrl ? `[View error](${row.buildPageUrl})` : "—";
    case "expired":
      return `[Details](${row.permalink})`;
    default:
      return `[Open](${row.permalink})`;
  }
}

export function renderCommentState(ctx: CommentContext): string {
  const state: CommentState = {
    ...(ctx.prNumber ? { pr: ctx.prNumber } : {}),
    ...(ctx.sha ? { sha: ctx.sha } : {}),
    builds: ctx.rows
      .filter((r): r is PlatformRow & { buildId: string } => Boolean(r.buildId))
      .map((r) => ({ platform: r.platform, buildId: r.buildId })),
  };
  return `<!-- epl-state:${JSON.stringify(state)} -->`;
}

export function renderComment(ctx: CommentContext): string {
  const shortSha = ctx.sha ? ctx.sha.slice(0, 7) : "";

  const header = [
    `### 📱 Expo preview builds`,
    "",
    `Branch \`${escapeMd(ctx.ref)}\`${shortSha ? ` · commit \`${shortSha}\`` : ""} · profile \`${escapeMd(ctx.profile)}\``,
    "",
  ].join("\n");

  const table = [
    "| | Platform | Status | Install | Scan |",
    "|---|---|---|---|---|",
    ...ctx.rows.map((row) => {
      const qr =
        row.state === "ready"
          ? `<img src="${row.qrUrl}" alt="QR code for the ${PLATFORM_LABEL[row.platform]} build" width="120" height="120">`
          : "—";
      const details = row.buildPageUrl ? ` · [build log](${row.buildPageUrl})` : "";
      return `| ${row.platform === "ios" ? "🍎" : "🤖"} | **${PLATFORM_LABEL[row.platform]}**${row.appVersion ? ` \`${escapeMd(row.appVersion)}\`` : ""} | ${STATE_LABEL[row.state]}${details} | ${actionCell(row)} | ${qr} |`;
    }),
  ].join("\n");

  const permalinkList = ctx.rows
    .map((r) => `- **${PLATFORM_LABEL[r.platform]}** — ${r.permalink}`)
    .join("\n");

  const errors = ctx.rows
    .filter((r) => r.state === "failed" && r.errorMessage)
    .map((r) => `**${PLATFORM_LABEL[r.platform]}:** ${escapeMd(r.errorMessage ?? "")}`)
    .join("\n\n");

  const details = [
    "<details>",
    "<summary>Permalinks & troubleshooting</summary>",
    "",
    "These links are **stable**: they always resolve to the latest build for this branch,",
    "so you can bookmark them and they keep working after every new push.",
    "",
    permalinkList,
    "",
    errors ? `**Build errors**\n\n${errors}\n` : "",
    "**Nothing happens when I tap Install on iPhone?**  ",
    "You are probably in an in-app browser (Slack, Gmail, Teams). Open the link in Safari.",
    "",
    '**"Unable to Install" on iPhone?**  ',
    "Your device UDID is not in the build's provisioning profile. Register it with",
    "`eas device:create`, then re-run with `refresh-ad-hoc-provisioning-profile: true`.",
    "",
    "**The build says expired?**  ",
    "EAS keeps artifacts for a limited time. Push a commit to rebuild — the same link",
    "will start working again.",
    "</details>",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const body = [
    marker(ctx.owner, ctx.repo),
    renderCommentState(ctx),
    header,
    table,
    "",
    ctx.note ? `_${escapeMd(ctx.note)}_\n` : "",
    details,
    "",
    "<sub>Posted by [expo-preview-links](https://github.com/victorhenrion/expo-preview-links)</sub>",
  ]
    .filter((part) => part !== "")
    .join("\n");

  if (body.length > COMMENT_MAX_BYTES) {
    // Never let a long branch name or error string push us past GitHub's cap,
    // which would fail the API call outright.
    return `${body.slice(0, COMMENT_MAX_BYTES - 200)}\n\n_…comment truncated._`;
  }
  return body;
}

/** Read the previous run's in-flight build ids so they can be cancelled. */
export function parsePreviousBuildIds(body: string | undefined | null): string[] {
  if (!body) return [];
  const match = STATE_RE.exec(body);
  if (!match?.[1]) return [];

  try {
    const parsed = JSON.parse(match[1]) as CommentState;
    if (!Array.isArray(parsed.builds)) return [];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return parsed.builds
      .map((b) => b?.buildId)
      .filter((id): id is string => typeof id === "string" && uuid.test(id));
  } catch {
    return [];
  }
}
