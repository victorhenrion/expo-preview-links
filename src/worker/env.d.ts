/**
 * Optional configuration that `wrangler types` cannot see.
 *
 * Secrets (set with `wrangler secret put NAME`) and commented-out vars in
 * wrangler.jsonc never appear in the generated worker-configuration.d.ts, so
 * they are declared here by merging into the generated `Env` interface.
 *
 * All of these are optional: a Worker deployed with nothing but the KV
 * namespace and the rate-limit bindings is a complete, working install.
 */

declare namespace Cloudflare {
  interface Env {
    /**
     * Expo ROBOT user access token. Only needed when the Expo project has
     * unauthenticated build access disabled; without it those builds render
     * as "unavailable" rather than failing outright.
     */
    EXPO_TOKEN?: string;

    /** Required only when GATING_MODE is "signed". */
    PERMALINK_HMAC_SECRET?: string;

    /** Defaults to this Worker's own origin. */
    OIDC_AUDIENCE?: string;

    /** Comma-separated `owner/repo` allowlist. Default: any repo (TOFU-bound). */
    ALLOWED_REPOS?: string;

    /** "true" permits OIDC tokens minted on self-hosted runners. */
    ALLOW_SELF_HOSTED?: string;

    /** Pin registrations to one workflow file, e.g. `acme/app/.github/workflows/preview.yml`. */
    REQUIRED_JOB_WORKFLOW_REF?: string;

    /** Comma-separated artifact host allowlist. Default: expo.dev, api.expo.dev. */
    ALLOWED_ARTIFACT_HOSTS?: string;
  }
}

interface Env extends Cloudflare.Env {}
