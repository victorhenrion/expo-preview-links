/**
 * All HTML. One switch over the seven build states, no template engine, no
 * client-side framework.
 *
 * Why an interstitial page rather than a redirect:
 *  - iOS: Mobile Safari has blocked non-user-activated custom-scheme
 *    navigations since iOS 13, so `Location: itms-services://…` fails
 *    silently. The install URL has to be an anchor the user taps.
 *  - Both: PR comments get opened inside Slack, Gmail, Teams and Telegram
 *    in-app browsers, which swallow `itms-services://` with a blank screen and
 *    no error. The interstitial is the only place we can tell the user to
 *    reopen in Safari -- the single worst failure mode this product has.
 *
 * Everything that traces back to a branch name, a commit message or an EAS
 * error string is attacker-controlled text and MUST go through escapeHtml.
 */

import { buildPageUrl, iosInstallUrl } from "../shared/urls.js";
import type { BuildPointer, Platform } from "../shared/types.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Shared headers for every HTML response. */
export function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    // The entire point of a permalink is "always the latest", so nothing here
    // may be cached by a browser or an intermediary.
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

const STYLE = `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#1b1f24; --muted:#59636e;
  --line:#d8dee4; --card:#f6f8fa; --accent:#6b46e5; --accent-fg:#ffffff;
  --ok:#1a7f37; --err:#cf222e; --warn:#9a6700; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#2f3742;
    --card:#161b22; --accent:#8b6ef0; --accent-fg:#0d1117; --ok:#3fb950;
    --err:#f85149; --warn:#d29922; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg);
  font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  display:flex; justify-content:center; }
.wrap { width:100%; max-width:26rem; }
h1 { font-size:1.35rem; line-height:1.3; margin:0 0 4px; }
.sub { color:var(--muted); font-size:.92rem; margin:0 0 20px; word-break:break-word; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:16px; margin:0 0 16px; }
.btn { display:block; width:100%; padding:16px 20px; min-height:52px; border-radius:12px;
  background:var(--accent); color:var(--accent-fg); text-decoration:none;
  font-weight:600; font-size:1.05rem; text-align:center; margin:0 0 12px; }
.btn.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
.meta { width:100%; border-collapse:collapse; font-size:.88rem; }
.meta th { text-align:left; color:var(--muted); font-weight:500; padding:3px 12px 3px 0;
  white-space:nowrap; vertical-align:top; }
.meta td { padding:3px 0; word-break:break-word; }
.badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:.78rem;
  font-weight:600; border:1px solid var(--line); }
.badge.ok { color:var(--ok); } .badge.err { color:var(--err); } .badge.warn { color:var(--warn); }
.hint { font-size:.88rem; color:var(--muted); margin:12px 0 0; }
.perma { font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted);
  word-break:break-all; user-select:all; }
code { font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background:var(--bg); border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
.spin { display:inline-block; width:9px; height:9px; border-radius:50%;
  background:var(--warn); margin-right:7px; vertical-align:middle; }
`;

export interface RenderContext {
  owner: string;
  repo: string;
  ref: string;
  platform: Platform;
  permalink: string;
}

function page(title: string, bodyHtml: string, metaRefreshSeconds?: number): string {
  const refresh = metaRefreshSeconds
    ? `<meta http-equiv="refresh" content="${metaRefreshSeconds}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
${refresh}
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

function header(ctx: RenderContext, title: string): string {
  const platformLabel = ctx.platform === "ios" ? "iOS" : "Android";
  return `<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(platformLabel)} &middot; <strong>${escapeHtml(ctx.ref)}</strong><br>${escapeHtml(ctx.owner)}/${escapeHtml(ctx.repo)}</p>`;
}

function metaTable(rows: Array<[string, string]>): string {
  if (rows.length === 0) return "";
  const body = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  return `<table class="meta">${body}</table>`;
}

function buildLink(p: BuildPointer): string {
  const url = buildPageUrl(p.account, p.slug, p.buildId);
  return `<a class="btn secondary" href="${escapeHtml(url)}">View build on expo.dev</a>`;
}

function permalinkFooter(ctx: RenderContext): string {
  return `<p class="hint">This link always points at the latest build for this branch:</p>
<p class="perma">${escapeHtml(ctx.permalink)}</p>`;
}

function commonRows(p: BuildPointer): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (p.appVersion) {
    rows.push(["Version", p.appBuildVersion ? `${p.appVersion} (${p.appBuildVersion})` : p.appVersion]);
  }
  if (p.appIdentifier) rows.push(["Bundle id", p.appIdentifier]);
  if (p.sha) rows.push(["Commit", p.sha.slice(0, 7)]);
  if (p.profile) rows.push(["Profile", p.profile]);
  if (p.message) rows.push(["Message", p.message.split("\n")[0]?.slice(0, 120) ?? ""]);
  return rows;
}

/** The whole read path renders through here. Always a 200, never a 404. */
export function renderInstallPage(pointer: BuildPointer | null, ctx: RenderContext): Response {
  if (!pointer) {
    const html = page(
      `No preview build yet - ${ctx.ref}`,
      `${header(ctx, "No preview build yet")}
<div class="card">
  <p style="margin:0 0 8px"><span class="spin"></span><strong>Waiting for a build to be registered.</strong></p>
  <p class="hint" style="margin:0">If a build was just triggered this page will pick it up
  within a few seconds. This page refreshes itself.</p>
</div>
${permalinkFooter(ctx)}`,
      15,
    );
    return new Response(html, { status: 200, headers: securityHeaders() });
  }

  const platformLabel = ctx.platform === "ios" ? "iOS" : "Android";

  switch (pointer.status) {
    case "building": {
      const rows = commonRows(pointer);
      if (typeof pointer.queuePosition === "number") {
        rows.unshift(["Queue", `position ${pointer.queuePosition}`]);
      }
      if (typeof pointer.estimatedWaitSeconds === "number") {
        rows.unshift(["Est. wait", `${Math.ceil(pointer.estimatedWaitSeconds / 60)} min`]);
      }
      return new Response(
        page(
          `Building - ${ctx.ref}`,
          `${header(ctx, "Build in progress")}
<div class="card">
  <p style="margin:0 0 10px"><span class="spin"></span><span class="badge warn">building</span></p>
  ${metaTable(rows)}
  <p class="hint">EAS builds usually take 10-25 minutes. This page refreshes itself,
  so you can leave it open or come back to the same link later.</p>
</div>
${buildLink(pointer)}
${permalinkFooter(ctx)}`,
          30,
        ),
        { status: 200, headers: securityHeaders() },
      );
    }

    case "ready": {
      const isIos = ctx.platform === "ios";
      let action: string;
      let advice: string;

      if (isIos && pointer.isSimulator) {
        action = `<a class="btn" href="${escapeHtml(ctx.permalink)}/artifact">Download simulator build</a>`;
        advice = `<p class="hint">This is a <strong>simulator</strong> build - it cannot be installed on a
physical iPhone. Unpack it and drag the <code>.app</code> onto a running simulator, or run
<code>eas build:run -p ios --url ${escapeHtml(ctx.permalink)}/artifact</code>.</p>`;
      } else if (isIos) {
        action = `<a class="btn" href="${escapeHtml(iosInstallUrl(pointer.appId, pointer.buildId))}">Install on this iPhone</a>`;
        advice = `<p class="hint"><strong>Nothing happened?</strong> You are probably in an in-app browser
(Slack, Gmail, Telegram, Teams). Tap the &hellip; menu and choose <strong>Open in Safari</strong>,
then tap Install again.</p>
<p class="hint"><strong>&ldquo;Unable to Install&rdquo;?</strong> Your device UDID is most likely not in
the build's provisioning profile. Register it with <code>eas device:create</code> and rebuild with
<code>--refresh-ad-hoc-provisioning-profile</code>.</p>`;
      } else {
        action = `<a class="btn" href="${escapeHtml(ctx.permalink)}/artifact">Download APK</a>`;
        advice = `<p class="hint">Android will ask you to allow installs from your browser the first
time. If the download opens as a file instead of installing, tap it in your notifications.</p>`;
      }

      const rows = commonRows(pointer);
      if (pointer.expirationDate) {
        rows.push(["Expires", new Date(pointer.expirationDate).toISOString().slice(0, 10)]);
      }

      return new Response(
        page(
          `Install ${platformLabel} preview - ${ctx.ref}`,
          `${header(ctx, `Install the ${platformLabel} preview`)}
${action}
<div class="card">
  <p style="margin:0 0 10px"><span class="badge ok">ready</span></p>
  ${metaTable(rows)}
</div>
${advice}
${buildLink(pointer)}
${permalinkFooter(ctx)}`,
        ),
        { status: 200, headers: securityHeaders() },
      );
    }

    case "failed": {
      const rows = commonRows(pointer);
      if (pointer.errorCode) rows.unshift(["Error", pointer.errorCode]);
      const docs = pointer.errorDocsUrl
        ? `<a class="btn secondary" href="${escapeHtml(pointer.errorDocsUrl)}">Expo docs for this error</a>`
        : "";
      return new Response(
        page(
          `Build failed - ${ctx.ref}`,
          `${header(ctx, "Build failed")}
<div class="card">
  <p style="margin:0 0 10px"><span class="badge err">failed</span></p>
  ${metaTable(rows)}
  ${pointer.errorMessage ? `<p class="hint">${escapeHtml(pointer.errorMessage.slice(0, 500))}</p>` : ""}
</div>
${buildLink(pointer)}
${docs}
${permalinkFooter(ctx)}`,
        ),
        { status: 200, headers: securityHeaders() },
      );
    }

    case "canceled":
      return new Response(
        page(
          `Build canceled - ${ctx.ref}`,
          `${header(ctx, "Build canceled")}
<div class="card">
  <p style="margin:0 0 10px"><span class="badge warn">canceled</span></p>
  ${metaTable(commonRows(pointer))}
  <p class="hint">This build was canceled - usually because a newer commit superseded it.
  Push again, or check the pull request for a newer preview.</p>
</div>
${buildLink(pointer)}
${permalinkFooter(ctx)}`,
        ),
        { status: 200, headers: securityHeaders() },
      );

    case "expired":
      return new Response(
        page(
          `Build expired - ${ctx.ref}`,
          `${header(ctx, "This build has expired")}
<div class="card">
  <p style="margin:0 0 10px"><span class="badge warn">expired</span></p>
  ${metaTable(commonRows(pointer))}
  <p class="hint">EAS keeps build artifacts for a limited time and this one is gone.
  Push a commit to the branch to produce a fresh build - this same link will then work again.</p>
</div>
${buildLink(pointer)}
${permalinkFooter(ctx)}`,
        ),
        { status: 200, headers: securityHeaders() },
      );

    default:
      return new Response(
        page(
          `Preview unavailable - ${ctx.ref}`,
          `${header(ctx, "Could not reach EAS")}
<div class="card">
  <p style="margin:0 0 10px"><span class="badge warn">unavailable</span></p>
  ${metaTable(commonRows(pointer))}
  <p class="hint">This usually means one of two things:</p>
  <p class="hint">1. The Expo project has unauthenticated build access disabled, and this
  Worker has no <code>EXPO_TOKEN</code> secret. Set one with
  <code>wrangler secret put EXPO_TOKEN</code>.</p>
  <p class="hint">2. EAS is temporarily unreachable. The build page below still works.</p>
</div>
${buildLink(pointer)}
${permalinkFooter(ctx)}`,
        ),
        { status: 200, headers: securityHeaders() },
      );
  }
}

/** GET / -- a one-screen explanation, no data, no KV read. */
export function renderLanding(): Response {
  const html = page(
    "expo-preview-links",
    `<h1>expo-preview-links</h1>
<p class="sub">Stable per-branch permalinks to the latest Expo (EAS) builds.</p>
<div class="card">
  <p style="margin:0 0 10px">Permalinks look like this:</p>
  <p class="perma">/&lt;owner&gt;/&lt;repo&gt;/&lt;branch&gt;/ios<br>/&lt;owner&gt;/&lt;repo&gt;/&lt;branch&gt;/android</p>
  <p class="hint">Each one always resolves to the most recent build for that branch,
  so a link posted on a pull request never goes stale.</p>
</div>
<a class="btn secondary" href="https://github.com/victorhenrion/expo-preview-links">Documentation on GitHub</a>`,
  );
  return new Response(html, {
    status: 200,
    headers: securityHeaders({ "cache-control": "public, max-age=3600" }),
  });
}
