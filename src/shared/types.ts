/**
 * The wire format and the stored record, in one place.
 *
 * Read this file first: it is the only thing the GitHub Action and the
 * Cloudflare Worker have to agree on. The Action writes `RegisterRequest`;
 * the Worker stores `BuildPointer` and renders it.
 */

export type Platform = "ios" | "android";

export const PLATFORMS: readonly Platform[] = ["ios", "android"] as const;

export function isPlatform(v: unknown): v is Platform {
  return v === "ios" || v === "android";
}

/**
 * The seven states a permalink can render. Every one of them is a 200 with a
 * human-readable page -- a permalink never 404s, because a KV miss is cached
 * for ~60s and the first click after registration would otherwise dead-end.
 */
export type BuildState =
  | "no-pointer" // nothing registered for this branch/platform yet
  | "building" // NEW | IN_QUEUE | IN_PROGRESS
  | "ready" // FINISHED, artifact present and unexpired
  | "failed" // ERRORED
  | "canceled" // CANCELED | PENDING_CANCEL
  | "expired" // FINISHED but the artifact is gone (EAS expires them)
  | "unavailable"; // we could not ask EAS (no token / API error)

/** One KV record: "the latest build for this repo+branch+platform". */
export interface BuildPointer {
  /** Schema version. Bump only on a breaking change; readers must tolerate older. */
  v: 1;

  // --- identity, written once at registration time -------------------------
  buildId: string;
  appId: string;
  account: string;
  slug: string;
  platform: Platform;
  ref: string;
  sha: string;
  profile: string;
  prNumber?: number;
  message?: string;
  registeredAt: string;

  // --- resolved from EAS, refreshed lazily on read -------------------------
  status: BuildState;
  resolvedAt?: string;
  artifactUrl?: string;
  appVersion?: string;
  appBuildVersion?: string;
  appIdentifier?: string;
  expirationDate?: string;
  isSimulator?: boolean;
  queuePosition?: number;
  estimatedWaitSeconds?: number;
  errorCode?: string;
  errorMessage?: string;
  errorDocsUrl?: string;
}

/**
 * Trust-on-first-use binding of a GitHub repo to an owner/repo namespace.
 *
 * Keyed on the NUMERIC ids, never the name: numeric ids survive repo and org
 * renames, and they stop someone who claims a freed org name from taking over
 * the permalinks that name used to own.
 */
export interface RepoBinding {
  v: 1;
  repositoryId: string;
  repositoryOwnerId: string;
  boundAt: string;
  /** Informational only -- the names at bind time, for a readable error message. */
  repository: string;
}

/** POST /api/register body. */
export interface RegisterRequest {
  builds: RegisterBuild[];
  /** Display-only. Never used for addressing or authorization. */
  prNumber?: number;
  /** Display-only. Must look like a 40-hex sha. */
  commitSha?: string;
  /** Display-only. The build message / commit subject. */
  message?: string;
}

export interface RegisterBuild {
  platform: Platform;
  buildId: string;
  appId: string;
  account: string;
  slug: string;
  profile: string;
  appVersion?: string;
}

/** What GET /<owner>/<repo>/<ref>/<platform>.json returns. */
export interface PointerStatusJson {
  status: BuildState;
  platform: Platform;
  ref: string;
  installUrl: string;
  buildId?: string;
  sha?: string;
  appVersion?: string;
  appIdentifier?: string;
  buildPageUrl?: string;
  expiresAt?: string;
  errorCode?: string;
  errorMessage?: string;
  queuePosition?: number;
  estimatedWaitSeconds?: number;
}

/** How long a resolved pointer is served before we re-ask EAS. */
export const RESOLVE_TTL_MS = 60_000;

/** How long a pointer lives in KV with no further writes: 90 days. */
export const POINTER_TTL_SECONDS = 60 * 60 * 24 * 90;

/** Minimum settable KV cacheTtl. The default is 60. */
export const KV_CACHE_TTL_SECONDS = 30;
