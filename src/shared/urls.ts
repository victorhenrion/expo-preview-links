/**
 * Every external URL template in the system, in one file.
 *
 * The iOS install URL is copied verbatim from eas-cli's own
 * `getInternalDistributionInstallUrl` (build/utils/url.js, eas-cli 24.3.0):
 *
 *   itms-services://?action=download-manifest;url=${apiBaseUrl}/v2/projects/${app.id}/builds/${id}/manifest.plist
 *
 * Note the SEMICOLON separator and the un-percent-encoded manifest URL. Apple
 * documents no separator at all and most of the ecosystem writes `&url=` with
 * percent-encoding; we match eas-cli because that is the form Expo actually
 * serves to every internal-distribution user today, and the `&`-truncation
 * hazard that motivates encoding cannot arise here (the manifest URL has no
 * query string). If a device test ever shows the semicolon form failing, this
 * is the one line to change.
 */

import { encodeRefPath } from "./ref.js";
import type { Platform } from "./types.js";

export const EXPO_API_BASE = "https://api.expo.dev";
export const EXPO_WEB_BASE = "https://expo.dev";

/** The expo.dev page for one build -- always safe to link to, in every state. */
export function buildPageUrl(account: string, slug: string, buildId: string): string {
  const a = encodeURIComponent(account);
  const s = encodeURIComponent(slug);
  const b = encodeURIComponent(buildId);
  return `${EXPO_WEB_BASE}/accounts/${a}/projects/${s}/builds/${b}`;
}

/** EAS-hosted over-the-air install manifest for an internal-distribution iOS build. */
export function iosManifestUrl(appId: string, buildId: string): string {
  return `${EXPO_API_BASE}/v2/projects/${appId}/builds/${buildId}/manifest.plist`;
}

/**
 * The `itms-services://` URL iOS needs to install an ad hoc build.
 *
 * This MUST be an href the user taps -- never a redirect Location. Mobile
 * Safari has blocked non-user-activated custom-scheme navigations since iOS 13.
 */
export function iosInstallUrl(appId: string, buildId: string): string {
  return `itms-services://?action=download-manifest;url=${iosManifestUrl(appId, buildId)}`;
}

/** Strip a trailing slash so joins never produce a double slash. */
export function normalizeBaseUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The stable permalink. This is what the PR comment links to and the QR encodes. */
export function permalink(
  base: string,
  owner: string,
  repo: string,
  ref: string,
  platform: Platform,
): string {
  const o = encodeURIComponent(owner.toLowerCase());
  const r = encodeURIComponent(repo.toLowerCase());
  return `${normalizeBaseUrl(base)}/${o}/${r}/${encodeRefPath(ref)}/${platform}`;
}

/**
 * QR image URL for a permalink.
 *
 * `?c=` is read by nobody: it exists only so the URL changes whenever the bot
 * rewrites the comment, which changes GitHub camo's HMAC and defeats camo's
 * one-year default caching of proxied images. It must never affect the encoded
 * payload, or the QR would stop matching the canonical permalink.
 */
export function qrUrl(
  base: string,
  owner: string,
  repo: string,
  ref: string,
  platform: Platform,
  cacheBuster?: string,
): string {
  const url = `${permalink(base, owner, repo, ref, platform)}/qr.png`;
  return cacheBuster ? `${url}?c=${encodeURIComponent(cacheBuster.slice(0, 12))}` : url;
}

/** Hosts we will ever redirect a user to. Exact match only -- see assertArtifactUrl. */
export const DEFAULT_ALLOWED_ARTIFACT_HOSTS = ["expo.dev", "api.expo.dev"] as const;

const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]*:[0-9a-f:.]*\]?$/i;

export class ArtifactUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing artifact URL: ${reason}`);
    this.name = "ArtifactUrlError";
  }
}

/**
 * Open-redirect defence. Applied when a URL is stored AND again immediately
 * before any 302 is issued -- never trust a value written by an older or
 * looser version of this Worker, or put there by hand with `wrangler kv put`.
 *
 * Membership is an exact `Set.has`. `hostname.endsWith("expo.dev")` is NOT a
 * substitute: `evilexpo.dev` and `expo.dev.attacker.com` both pass that test.
 */
export function assertArtifactUrl(raw: string, allowed: Iterable<string>): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new ArtifactUrlError("empty");
  if (raw.length > 2048) throw new ArtifactUrlError("longer than 2048 characters");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtifactUrlError("not a valid absolute URL");
  }

  if (url.protocol !== "https:")
    throw new ArtifactUrlError(`protocol ${url.protocol} is not https`);
  if (url.username !== "" || url.password !== "") {
    throw new ArtifactUrlError("contains embedded credentials");
  }

  const host = url.hostname.toLowerCase();
  if (IP_LITERAL_RE.test(host)) throw new ArtifactUrlError("host is an IP literal");

  const allowSet = new Set([...allowed].map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (!allowSet.has(host)) throw new ArtifactUrlError(`host ${host} is not allow-listed`);

  // expo.dev serves the marketing site too; artifacts live under /artifacts/.
  if (host === "expo.dev" && !url.pathname.startsWith("/artifacts/")) {
    throw new ArtifactUrlError("expo.dev URL is not under /artifacts/");
  }

  return url;
}

/** Parse the ALLOWED_ARTIFACT_HOSTS var, falling back to the locked-down default. */
export function allowedArtifactHosts(configured?: string): string[] {
  if (!configured || configured.trim() === "") return [...DEFAULT_ALLOWED_ARTIFACT_HOSTS];
  return configured
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
