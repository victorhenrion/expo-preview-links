/**
 * expo-preview-links -- the Worker.
 *
 * THE TOUR, in six lines:
 *  1. EAS cannot answer "the latest build for branch X" -- BuildFilter has no
 *     gitRef, and a CLI-triggered build does not even record one. So the
 *     GitHub Action tells us: POST /api/register, authenticated with a GitHub
 *     OIDC token, writes `branch -> buildId` into KV.
 *  2. A reviewer opens /<owner>/<repo>/<branch>/ios minutes or hours later.
 *  3. We read the pointer from KV and, if it is stale or still building, ask
 *     EAS what became of that one build id, then cache the answer back.
 *  4. We render an HTML page -- never a redirect to a custom scheme -- with a
 *     tappable install link.
 *  5. Artifact URLs are re-validated against a host allowlist immediately
 *     before any redirect.
 *  6. Nothing here ever 404s a permalink: a miss is a 200 that refreshes
 *     itself, because KV caches negative lookups for about a minute.
 */

import { decodeRefPath, isValidRepoPart, normalizeRef, RefError } from "../shared/ref.js";
import {
  type BuildPointer,
  isPlatform,
  type Platform,
  type PointerStatusJson,
  RESOLVE_TTL_MS,
} from "../shared/types.js";
import { allowedArtifactHosts, assertArtifactUrl, buildPageUrl } from "../shared/urls.js";
import { resolveBuild } from "./eas.js";
import { getPointer, putPointer } from "./kv.js";
import { qrPng, qrSvg } from "./qr.js";
import { handleRegister } from "./register.js";
import { renderInstallPage, renderLanding, securityHeaders } from "./render.js";
import { verifySignedPermalink } from "./signing.js";

type Tail = "page" | "artifact" | "qr.png" | "qr.svg" | "json";

interface ParsedRoute {
  owner: string;
  repo: string;
  ref: string;
  platform: Platform;
  tail: Tail;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * Hand-rolled routing, deliberately.
 *
 * The shape we need is `/<owner>/<repo>/<branch...>/<platform>[/<action>]`
 * where the BRANCH is the catch-all in the middle. Every router library makes
 * that ambiguous -- a greedy `:branch{.+}` followed by a fixed `:platform`
 * needs backtracking. Splitting from the right is unambiguous and is fewer
 * lines than configuring a router would be.
 */
export function parseRoute(pathname: string): ParsedRoute | null {
  const raw = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (raw === "") return null;

  const segments = raw.split("/");
  if (segments.length < 3) return null;

  // Decide the tail from the right-hand end, then whatever is left between
  // `repo` and the platform is the branch.
  let tail: Tail = "page";
  const last = segments[segments.length - 1] ?? "";

  if (last === "artifact" || last === "qr.png" || last === "qr.svg") {
    tail = last as Tail;
    segments.pop();
  }

  let platformSegment = segments.pop() ?? "";
  if (tail === "page" && platformSegment.endsWith(".json")) {
    tail = "json";
    platformSegment = platformSegment.slice(0, -".json".length);
  }

  if (!isPlatform(platformSegment)) return null;
  if (segments.length < 3) return null;

  const owner = decodeURIComponent(segments.shift() ?? "");
  const repo = decodeURIComponent(segments.shift() ?? "");
  if (!isValidRepoPart(owner) || !isValidRepoPart(repo)) return null;
  if (segments.length === 0) return null;

  let ref: string;
  try {
    // Exactly one decode pass per segment -- a branch may legally contain `%`.
    ref = normalizeRef(decodeRefPath(segments));
  } catch (err) {
    if (err instanceof RefError) return null;
    throw err;
  }

  return { owner, repo, ref, platform: platformSegment, tail };
}

/** True when we should ask EAS again rather than serve what KV has. */
function isStale(pointer: BuildPointer, now: number): boolean {
  if (pointer.status === "building" || pointer.status === "unavailable") return true;
  if (!pointer.resolvedAt) return true;
  if (now - Date.parse(pointer.resolvedAt) > RESOLVE_TTL_MS) return true;
  if (pointer.expirationDate && Date.parse(pointer.expirationDate) <= now) return true;
  return false;
}

async function readPath(
  route: ParsedRoute,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { owner, repo, ref, platform, tail } = route;
  const origin = new URL(request.url).origin;
  // The canonical permalink for this resource: every sub-route (/artifact,
  // /qr.png, /qr.svg, .json) maps back to the one HTML page. Kept in step with
  // the canonicalisation in signing.ts -- and `.json` must be stripped here
  // too, or `installUrl` in the JSON body would point at the JSON endpoint
  // itself instead of the install page.
  const permalinkUrl = `${origin}${new URL(request.url).pathname}`
    .replace(/\/(artifact|qr\.png|qr\.svg)$/, "")
    .replace(/\.json$/, "");

  // QR images are pure functions of the URL: no KV read, no EAS call. Serving
  // them before the rate limiter also means a comment full of images cannot
  // exhaust a repo's read budget.
  if (tail === "qr.png" || tail === "qr.svg") {
    const target = permalinkUrl;
    if (tail === "qr.svg") {
      return new Response(qrSvg(target), {
        status: 200,
        headers: {
          // Exact content type: camo sets nosniff and 404s anything it does
          // not recognise, which renders as a silently broken image.
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=60, s-maxage=60, must-revalidate",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    const png = await qrPng(target);
    return new Response(png as BodyInit, {
      status: 200,
      headers: {
        "content-type": "image/png",
        // MANDATORY. Camo stamps `public, max-age=31536000` on any origin that
        // omits Cache-Control, freezing the image for a year.
        "cache-control": "public, max-age=60, s-maxage=60, must-revalidate",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // Widened deliberately: `wrangler types` narrows a var to the literal value
  // in wrangler.jsonc, which would make this comparison a type error.
  const gatingMode: string = env.GATING_MODE ?? "public";
  if (gatingMode === "signed") {
    const ok = await verifySignedPermalink(request, env);
    if (!ok) {
      return json({ error: "forbidden", reason: "missing or invalid ?t= signature" }, 403);
    }
  }

  // Keyed on the resource, never on IP: Cloudflare warns that client IPs are
  // shared, so an IP key punishes whole offices behind one NAT.
  const { success } = await env.RL_READ.limit({ key: `${owner}/${repo}/${ref}/${platform}` });
  if (!success) {
    return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
  }

  let pointer = await getPointer(env, owner, repo, ref, platform);

  if (pointer && isStale(pointer, Date.now())) {
    const resolved = await resolveBuild(pointer.buildId, env);
    pointer = { ...pointer, ...resolved };
    // waitUntil so the KV write never delays the response the reviewer is
    // waiting on.
    ctx.waitUntil(putPointer(env, owner, repo, ref, platform, pointer));
  }

  if (tail === "json") {
    const body: PointerStatusJson = pointer
      ? {
          status: pointer.status,
          platform,
          ref,
          installUrl: permalinkUrl,
          buildId: pointer.buildId,
          sha: pointer.sha,
          appVersion: pointer.appVersion,
          appIdentifier: pointer.appIdentifier,
          buildPageUrl: buildPageUrl(pointer.account, pointer.slug, pointer.buildId),
          expiresAt: pointer.expirationDate,
          errorCode: pointer.errorCode,
          errorMessage: pointer.errorMessage,
          queuePosition: pointer.queuePosition,
          estimatedWaitSeconds: pointer.estimatedWaitSeconds,
        }
      : { status: "no-pointer", platform, ref, installUrl: permalinkUrl };
    return json(body, 200);
  }

  if (tail === "artifact") {
    if (!pointer) return json({ error: "not_found", status: "no-pointer" }, 404);
    if (pointer.status === "expired") return json({ error: "expired" }, 410);
    if (pointer.status !== "ready" || !pointer.artifactUrl) {
      return json({ error: "not_ready", status: pointer.status }, 404);
    }
    // Re-validate immediately before redirecting. Never trust a stored value:
    // it may have been written by an older, looser build of this Worker, or by
    // hand with `wrangler kv key put`.
    let target: URL;
    try {
      target = assertArtifactUrl(
        pointer.artifactUrl,
        allowedArtifactHosts(env.ALLOWED_ARTIFACT_HOSTS),
      );
    } catch {
      return json({ error: "artifact_host_not_allowed" }, 502);
    }
    // Issue the 302 and do NOT follow it -- each hop would burn one of the 50
    // subrequests a single invocation gets.
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), "cache-control": "no-store" },
    });
  }

  return renderInstallPage(pointer, { owner, repo, ref, platform, permalink: permalinkUrl });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/register") {
      return handleRegister(request, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
    }

    if (url.pathname === "/" || url.pathname === "") return renderLanding();

    if (url.pathname === "/healthz") {
      return json({ ok: true }, 200);
    }

    const route = parseRoute(url.pathname);
    if (!route) {
      return new Response(
        "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found. Permalinks look like <code>/&lt;owner&gt;/&lt;repo&gt;/&lt;branch&gt;/ios</code>.",
        { status: 404, headers: securityHeaders() },
      );
    }

    try {
      return await readPath(route, request, env, ctx);
    } catch (err) {
      console.error("read path failed", err);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
