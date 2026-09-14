/**
 * Every KV read and write in the Worker. No other file touches env.BUILDS.
 *
 * Two KV facts a reader will otherwise trip over:
 *
 *  1. Writes are limited to ONE PER SECOND PER KEY. That is fine here because
 *     iOS and Android are different keys, so both platforms finishing at the
 *     same instant is not a conflict.
 *
 *  2. NEGATIVE lookups are cached, for up to ~60s in the colo that missed.
 *     This is exactly why a missing pointer renders a self-refreshing 200
 *     instead of a 404: a reviewer who clicks the moment the comment appears
 *     would otherwise get a dead link that stays dead for a minute.
 */

import { bindingKey, pointerKey } from "../shared/ref.js";
import {
  type BuildPointer,
  KV_CACHE_TTL_SECONDS,
  POINTER_TTL_SECONDS,
  type Platform,
  type RepoBinding,
} from "../shared/types.js";

export async function getPointer(
  env: Env,
  owner: string,
  repo: string,
  ref: string,
  platform: Platform,
): Promise<BuildPointer | null> {
  const key = await pointerKey(owner, repo, ref, platform);
  return env.BUILDS.get<BuildPointer>(key, { type: "json", cacheTtl: KV_CACHE_TTL_SECONDS });
}

export async function putPointer(
  env: Env,
  owner: string,
  repo: string,
  ref: string,
  platform: Platform,
  pointer: BuildPointer,
): Promise<void> {
  const key = await pointerKey(owner, repo, ref, platform);
  await env.BUILDS.put(key, JSON.stringify(pointer), {
    expirationTtl: POINTER_TTL_SECONDS,
    // Metadata rides along with list results, which makes an ops-time
    // `wrangler kv key list` readable without fetching every value.
    metadata: { sha: pointer.sha, status: pointer.status, buildId: pointer.buildId },
  });
}

export async function getBinding(
  env: Env,
  owner: string,
  repo: string,
): Promise<RepoBinding | null> {
  return env.BUILDS.get<RepoBinding>(bindingKey(owner, repo), { type: "json" });
}

export async function putBinding(
  env: Env,
  owner: string,
  repo: string,
  binding: RepoBinding,
): Promise<void> {
  // Deliberately no expirationTtl: a binding that expired would silently
  // re-open the namespace to whoever registers next.
  await env.BUILDS.put(bindingKey(owner, repo), JSON.stringify(binding));
}
