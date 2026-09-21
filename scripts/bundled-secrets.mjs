// Decides whether build-time secrets may be inlined into the bundle, and says
// so loudly when they are.
//
// Bundling a key ships it to every browser that loads the app, so it has to be
// a deliberate act. Reading `process.env.OPENAI_API_KEY` directly is not: that
// variable is exported in many developers' shells — this project's own README
// tells you to export it — so an ordinary `npm run build` silently baked a live
// credential into the published plugin bundle, and one reached the public
// plugin registry that way. Requiring a separate, single-purpose flag means no
// variable a developer already has exported can leak on its own.

/** The env var that opts a build in to inlining secrets. */
export const BUNDLE_KEYS_FLAG = "OPERA_BUNDLE_KEYS";

/** True when this build is explicitly allowed to inline secrets. */
export function bundlingSecretsAllowed(env = process.env) {
  return env[BUNDLE_KEYS_FLAG] === "1";
}

/**
 * The value to inline for `name`: the environment's value when the build opted
 * in, otherwise an empty string. Warns for each secret actually embedded, so a
 * publishable build is never quiet about carrying one.
 */
export function bundledSecret(name, env = process.env) {
  if (!bundlingSecretsAllowed(env)) {
    if (env[name]) {
      console.warn(
        `[bundled-secrets] ${name} is set but will NOT be bundled. ` +
          `Set ${BUNDLE_KEYS_FLAG}=1 to inline it (do not publish that build).`,
      );
    }
    return "";
  }
  const value = env[name] ?? "";
  if (value) {
    console.warn(
      `[bundled-secrets] WARNING: ${name} is being inlined into the build ` +
        `output. Anyone who loads this bundle can read it. Do not publish it ` +
        `to npm or the plugin registry.`,
    );
  }
  return value;
}
