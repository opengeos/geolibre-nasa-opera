#!/usr/bin/env node

// Fails the build when credential-shaped strings are found in build output.
//
// The `define` opt-in in the Vite configs stops the two secrets this project
// inlines on purpose. This is the backstop for every other way one can arrive:
// a key pasted into a source file, a fixture committed with a real token, a
// dependency that embeds one. It reads the built files rather than the config,
// so it cannot be fooled by how the value got there.
//
//   node scripts/check-bundle-secrets.mjs <dir> [<dir>...]
//
// With OPERA_BUNDLE_KEYS=1 the build has explicitly opted in to inlining, so
// findings are reported as a warning and the build is allowed through.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_KEYS_FLAG, bundlingSecretsAllowed } from "./bundled-secrets.mjs";

// Deliberately narrow: each pattern matches a credential format with a
// distinctive prefix, so ordinary minified code and hashes do not trip it.
const PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Mapbox secret token", re: /\bsk\.eyJ[A-Za-z0-9_-]{20,}/g },
];

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".json", ".css", ".html", ".map", ".txt",
]);

/**
 * Credential-shaped strings in `text`, as `{ name, sample }` where `sample` is
 * a redacted excerpt — enough to locate the value, never enough to use it.
 */
export function findSecrets(text) {
  const found = [];
  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(new RegExp(re))) {
      const value = match[0];
      found.push({ name, sample: `${value.slice(0, 6)}…(${value.length} chars)` });
    }
  }
  return found;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // A build that produced nothing has nothing to check.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

/**
 * Run the scan over `dirs`, returning the process exit code. Kept separate from
 * the module body so importing this file (the tests do) does not run the CLI.
 */
async function main(dirs) {
  if (dirs.length === 0) {
    console.error("usage: check-bundle-secrets.mjs <dir> [<dir>...]");
    return 2;
  }

  const hits = [];
  let scanned = 0;
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      scanned += 1;
      const found = findSecrets(await fs.readFile(file, "utf8"));
      for (const hit of found) hits.push({ file, ...hit });
    }
  }

  if (hits.length === 0) {
    console.log(`No credential-shaped strings in ${scanned} built file(s).`);
    return 0;
  }

  const seen = new Set();
  const lines = hits
    .filter((h) => !seen.has(`${h.file}:${h.sample}`) && seen.add(`${h.file}:${h.sample}`))
    .map((h) => `  ${h.file}: ${h.name} ${h.sample}`);

  if (bundlingSecretsAllowed()) {
    console.warn(
      `[check-bundle-secrets] ${BUNDLE_KEYS_FLAG}=1, so these are expected. ` +
        `Do not publish this build:\n${lines.join("\n")}`,
    );
    return 0;
  }

  console.error(
    `[check-bundle-secrets] Credential-shaped strings found in build output:\n` +
      `${lines.join("\n")}\n\n` +
      `Publishing this build would expose them. If the key is meant to be in ` +
      `there (a controlled demo build), rerun with ${BUNDLE_KEYS_FLAG}=1 and do ` +
      `not publish the result.`,
  );
  return 1;
}

// Only act as a CLI when executed directly, never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await main(process.argv.slice(2)));
}
