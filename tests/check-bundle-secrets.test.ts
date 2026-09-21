import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs build script, no type declarations
import { findSecrets } from "../scripts/check-bundle-secrets.mjs";
// @ts-expect-error - plain .mjs build script, no type declarations
import { bundledSecret, bundlingSecretsAllowed } from "../scripts/bundled-secrets.mjs";

describe("findSecrets", () => {
  it("flags credential-shaped strings in build output", () => {
    // A Google key is `AIza` + exactly 35 characters; a GitHub token is its
    // prefix + exactly 36. The lengths are part of what makes the patterns
    // narrow enough not to fire on ordinary minified code.
    const google = `AIza${"a".repeat(35)}`;
    const github = `ghp_${"b".repeat(36)}`;
    const found = findSecrets(
      'const a="sk-abcdefghijklmnopqrstuvwxyz012345";' +
        `const b="${google}";const c="${github}";`,
    );
    expect(found.map((f: { name: string }) => f.name)).toEqual([
      "OpenAI-style key",
      "Google API key",
      "GitHub token",
    ]);
  });

  it("redacts what it reports, so a CI log never carries the key", () => {
    const [hit] = findSecrets('"sk-abcdefghijklmnopqrstuvwxyz012345"');
    expect(hit.sample).toBe("sk-abc…(35 chars)");
    expect(hit.sample).not.toContain("xyz012345");
  });

  it("does not trip on ordinary minified code, hashes or urls", () => {
    expect(
      findSecrets(
        'function sk(e){return e}const h="9f86d081884c7d659a2feaa0c55ad015";' +
          'const u="https://cli-proxy.opengeos.org/v1/models";const s="sk-short";',
      ),
    ).toEqual([]);
  });
});

describe("bundledSecret", () => {
  it("withholds a secret that is merely exported in the shell", () => {
    const env = { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz012345" };
    expect(bundlingSecretsAllowed(env)).toBe(false);
    expect(bundledSecret("OPENAI_API_KEY", env)).toBe("");
  });

  it("inlines it only when the build explicitly opts in", () => {
    const env = {
      OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz012345",
      OPERA_BUNDLE_KEYS: "1",
    };
    expect(bundlingSecretsAllowed(env)).toBe(true);
    expect(bundledSecret("OPENAI_API_KEY", env)).toBe(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  it("returns an empty string when the variable is unset", () => {
    expect(bundledSecret("OPENAI_API_KEY", { OPERA_BUNDLE_KEYS: "1" })).toBe("");
  });
});
