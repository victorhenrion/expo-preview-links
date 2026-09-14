/**
 * The only code in this repo that talks to api.expo.dev.
 *
 * WARNING: api.expo.dev/graphql is undocumented, unversioned and carries no
 * stability guarantee. The vendored introspection in eas-cli is the only spec,
 * and it tracks the CLI release rather than an API contract. A field rename
 * upstream breaks every permalink at once, so:
 *
 *   - the selection set below is as narrow as it can be;
 *   - resolveBuild NEVER throws into the request path -- it degrades to
 *     "unavailable", which still renders a page linking to expo.dev.
 *
 * The query shape is taken from eas-cli 24.3.0
 * (build/graphql/queries/BuildQuery.js, `builds { byId(buildId: ID!) }`).
 *
 * Authentication: EXPO_TOKEN is OPTIONAL but recommended. We try without it
 * first, because a project with unauthenticated build access enabled (Expo's
 * default for internal distribution) can be read anonymously. If that comes
 * back null or errors and a token is configured, we retry with it.
 */

import type { BuildPointer, BuildState } from "../shared/types.js";
import { allowedArtifactHosts, assertArtifactUrl } from "../shared/urls.js";

const GRAPHQL_ENDPOINT = "https://api.expo.dev/graphql";
const TIMEOUT_MS = 5_000;

const BUILD_BY_ID_QUERY = `query EplBuildById($buildId: ID!) {
  builds {
    byId(buildId: $buildId) {
      id
      status
      platform
      distribution
      isForIosSimulator
      appVersion
      appBuildVersion
      appIdentifier
      expirationDate
      queuePosition
      estimatedWaitTimeLeftSeconds
      error { errorCode message docsUrl }
      artifacts { applicationArchiveUrl buildUrl }
    }
  }
}`;

/** BuildStatus values from eas-cli's generated enum. */
type EasBuildStatus =
  | "NEW"
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "FINISHED"
  | "ERRORED"
  | "CANCELED"
  | "PENDING_CANCEL";

interface EasBuild {
  id: string;
  status: EasBuildStatus;
  platform?: "IOS" | "ANDROID";
  distribution?: "INTERNAL" | "SIMULATOR" | "STORE";
  isForIosSimulator?: boolean;
  appVersion?: string | null;
  appBuildVersion?: string | null;
  appIdentifier?: string | null;
  expirationDate?: string | null;
  queuePosition?: number | null;
  estimatedWaitTimeLeftSeconds?: number | null;
  error?: { errorCode?: string | null; message?: string | null; docsUrl?: string | null } | null;
  artifacts?: { applicationArchiveUrl?: string | null; buildUrl?: string | null } | null;
}

/** The subset of a pointer that EAS owns. Merged over the stored record. */
export type ResolvedBuild = Partial<
  Pick<
    BuildPointer,
    | "status"
    | "artifactUrl"
    | "appVersion"
    | "appBuildVersion"
    | "appIdentifier"
    | "expirationDate"
    | "isSimulator"
    | "queuePosition"
    | "estimatedWaitSeconds"
    | "errorCode"
    | "errorMessage"
    | "errorDocsUrl"
  >
> & { status: BuildState; resolvedAt: string };

async function queryEas(buildId: string, token?: string): Promise<EasBuild | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: BUILD_BY_ID_QUERY, variables: { buildId } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`EAS responded ${res.status}`);

  const body = (await res.json()) as {
    data?: { builds?: { byId?: EasBuild | null } | null } | null;
    errors?: unknown[];
  };

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`EAS GraphQL error: ${JSON.stringify(body.errors).slice(0, 300)}`);
  }
  return body.data?.builds?.byId ?? null;
}

function mapStatus(build: EasBuild, now: number): BuildState {
  switch (build.status) {
    case "NEW":
    case "IN_QUEUE":
    case "IN_PROGRESS":
      return "building";
    case "ERRORED":
      return "failed";
    case "CANCELED":
    case "PENDING_CANCEL":
      return "canceled";
    case "FINISHED": {
      if (build.expirationDate && Date.parse(build.expirationDate) <= now) return "expired";
      if (!build.artifacts?.applicationArchiveUrl) return "expired";
      return "ready";
    }
    default:
      return "unavailable";
  }
}

/**
 * Resolve one build id against EAS. Never throws.
 *
 * Returns "unavailable" when we could not get an answer -- which renders a page
 * explaining the two causes (no EXPO_TOKEN on a project with unauthenticated
 * access disabled, or an EAS outage) rather than a broken install button.
 */
export async function resolveBuild(buildId: string, env: Env): Promise<ResolvedBuild> {
  const resolvedAt = new Date().toISOString();
  const now = Date.now();

  let build: EasBuild | null = null;
  try {
    build = await queryEas(buildId);
  } catch {
    build = null;
  }

  if (!build && env.EXPO_TOKEN) {
    try {
      build = await queryEas(buildId, env.EXPO_TOKEN);
    } catch {
      build = null;
    }
  }

  if (!build) return { status: "unavailable", resolvedAt };

  const status = mapStatus(build, now);
  const resolved: ResolvedBuild = { status, resolvedAt };

  if (build.appVersion) resolved.appVersion = build.appVersion;
  if (build.appBuildVersion) resolved.appBuildVersion = build.appBuildVersion;
  if (build.appIdentifier) resolved.appIdentifier = build.appIdentifier;
  if (build.expirationDate) resolved.expirationDate = build.expirationDate;
  if (typeof build.isForIosSimulator === "boolean") resolved.isSimulator = build.isForIosSimulator;
  if (typeof build.queuePosition === "number") resolved.queuePosition = build.queuePosition;
  if (typeof build.estimatedWaitTimeLeftSeconds === "number") {
    resolved.estimatedWaitSeconds = build.estimatedWaitTimeLeftSeconds;
  }
  if (build.error?.errorCode) resolved.errorCode = build.error.errorCode;
  if (build.error?.message) resolved.errorMessage = build.error.message;
  if (build.error?.docsUrl) resolved.errorDocsUrl = build.error.docsUrl;

  // Validate on the way IN as well as on the way out. A URL that fails the
  // allowlist is dropped, which downgrades the state to "expired" rather than
  // storing something we would refuse to redirect to anyway.
  const archive = build.artifacts?.applicationArchiveUrl;
  if (status === "ready" && archive) {
    try {
      resolved.artifactUrl = assertArtifactUrl(
        archive,
        allowedArtifactHosts(env.ALLOWED_ARTIFACT_HOSTS),
      ).toString();
    } catch {
      resolved.status = "unavailable";
    }
  }

  return resolved;
}
