#!/usr/bin/env node
/**
 * check-expo-deps.js — preflight check that catches the dependency-mismatch
 * class of EAS Build failures BEFORE we burn a 5-minute cloud build slot.
 *
 * Specifically targets the 2026-04-29 incident:
 *   1. EAS Build's pre-install hook injects an `overrides` block pinning
 *      Expo SDK-locked packages to exact versions. If our direct dep is a
 *      caret range (e.g. `^2.2.0`) that doesn't exact-match the SDK version,
 *      npm v9+ aborts with EOVERRIDE.
 *   2. Stale `package-lock.json` alongside `yarn.lock` confuses EAS into
 *      using the wrong package manager.
 *
 * Checks performed:
 *   - `npx expo install --check` (Expo's own SDK-version validator). Exits
 *     non-zero with a list of mismatches if any direct dep doesn't match the
 *     SDK-expected version.
 *   - Bails if `package-lock.json` exists alongside `yarn.lock` (mixed
 *     lockfile state — pick one).
 *
 * Re-run cost: ~3s when clean. Cheap insurance against a 5-minute cloud
 * round-trip.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FRONTEND = path.resolve(__dirname, '..');
const PKG_PATH = path.join(FRONTEND, 'package.json');
const PKG = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
let failed = false;

// Packages Emergent Native Deploy auto-rewrites in Step 3b of `eas-apk-build`.
// They MUST be listed in `expo.install.exclude` in package.json or the
// pipeline's later `expo install --fix` will try to upgrade them and crash
// with EOVERRIDE (see 2026-04-29 incident — root cause documented in PRD.md).
const EMERGENT_REWRITTEN_PACKAGES = [
  '@react-native-async-storage/async-storage',
];

// 1. Mixed lockfile guard.
const hasNpmLock  = fs.existsSync(path.join(FRONTEND, 'package-lock.json'));
const hasYarnLock = fs.existsSync(path.join(FRONTEND, 'yarn.lock'));
if (hasNpmLock && hasYarnLock) {
  console.error(
    '[check-expo-deps] ✗ Both package-lock.json and yarn.lock exist.\n' +
    '   This project is yarn-managed (see `packageManager` in package.json).\n' +
    '   Delete package-lock.json so Emergent Native Deploy / EAS picks yarn.\n'
  );
  failed = true;
} else {
  console.log('[check-expo-deps] ✓ lockfile state clean');
}

// 2. Emergent-rewritten packages must be in expo.install.exclude.
const excluded = (PKG.expo && PKG.expo.install && PKG.expo.install.exclude) || [];
const missing = EMERGENT_REWRITTEN_PACKAGES.filter((p) => !excluded.includes(p));
if (missing.length > 0) {
  console.error(
    `[check-expo-deps] ✗ missing from "expo.install.exclude" in package.json:\n` +
    missing.map((p) => `     - ${p}`).join('\n') + '\n' +
    `   Emergent's deploy pipeline (Step 3b of eas-apk-build) auto-rewrites\n` +
    `   these to a version different from the SDK 54 expected one. Without\n` +
    `   the exclude entry, Step 7's \`expo install --fix\` will try to upgrade\n` +
    `   and crash with npm EOVERRIDE.\n` +
    `   Add them to package.json:\n` +
    `     "expo": { "install": { "exclude": ${JSON.stringify(EMERGENT_REWRITTEN_PACKAGES)} } }\n`
  );
  failed = true;
} else {
  console.log('[check-expo-deps] ✓ Emergent-rewritten packages are in expo.install.exclude');
}

// 3. Expo SDK version-match check.
console.log('[check-expo-deps] running `expo install --check`…');
const result = spawnSync(
  'npx',
  ['--no-install', 'expo', 'install', '--check'],
  { cwd: FRONTEND, stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);

if (result.status !== 0) {
  console.error(
    '\n[check-expo-deps] ✗ Expo dependency mismatch detected (see above).\n' +
    '   EAS Build will inject `overrides` for these and fail with EOVERRIDE.\n' +
    '   Fix:  pin each flagged dep to the exact SDK-recommended version\n' +
    '         (drop the caret), then re-run preflight.\n'
  );
  failed = true;
} else {
  console.log('[check-expo-deps] ✓ all deps match SDK 54 expectations');
}

if (failed) process.exit(1);
console.log('[check-expo-deps] OK');
