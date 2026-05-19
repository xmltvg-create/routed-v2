#!/usr/bin/env node
/**
 * Guarded wrapper around `eas update`. Refuses to publish to the
 * `production` channel/branch unless the resolved
 * `EXPO_PUBLIC_BACKEND_URL` is the production backend host.
 *
 * Why this exists:
 *   `eas update` reads env vars from (a) `--environment <name>` on EAS,
 *   (b) the local `.env` file, in that order. The local `.env` in this
 *   repo points at the dev preview URL for Expo Go work. On 2026-05-09
 *   we shipped multiple OTAs to the production channel that silently
 *   re-pointed the live APK at the dev backend because `--environment`
 *   wasn't passed and the EAS `production` env was empty.
 *
 * What it does:
 *   1. Inspects argv for `--branch production` or `--channel production`.
 *   2. If detected, requires `--environment production`.
 *   3. Calls `eas env:list --environment production --format short` and
 *      verifies `EXPO_PUBLIC_BACKEND_URL` contains the production host.
 *   4. Refuses with a non-zero exit if any check fails. Otherwise
 *      execs `eas update` with the original argv.
 */
const { spawnSync } = require('child_process');

const PROD_HOST = 'floating-map-ui.emergent.host';
const DEV_HOST_FRAGMENTS = ['preview.emergentagent.com', 'localhost', '127.0.0.1'];

function fail(msg) {
  console.error(`\n[guard-ota] ❌ ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const isProdTarget =
  (args.includes('--branch') && args[args.indexOf('--branch') + 1] === 'production') ||
  (args.includes('--channel') && args[args.indexOf('--channel') + 1] === 'production');

if (isProdTarget) {
  // 1. Require --environment production
  const envIdx = args.indexOf('--environment');
  if (envIdx === -1 || args[envIdx + 1] !== 'production') {
    fail(
      'Pushing to the `production` branch/channel requires `--environment production`.\n' +
      '   Without it, `eas update` falls back to your local .env, which points at the dev preview URL.\n' +
      '   Run again as: npm run update:prod -- <your other args>'
    );
  }

  // 2. Verify EAS production env var resolves to the production host.
  const r = spawnSync(
    'npx',
    ['eas-cli', 'env:list', '--environment', 'production', '--format', 'short'],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    fail(`Could not read EAS production env vars:\n${r.stderr || r.stdout}`);
  }
  const line = (r.stdout || '')
    .split('\n')
    .find(l => l.includes('EXPO_PUBLIC_BACKEND_URL'));
  if (!line) {
    fail(
      'EAS production environment is missing EXPO_PUBLIC_BACKEND_URL.\n' +
      `   Set it with:  npx eas-cli env:create --environment production --name EXPO_PUBLIC_BACKEND_URL --value "https://${PROD_HOST}" --visibility plaintext`
    );
  }
  if (DEV_HOST_FRAGMENTS.some(d => line.includes(d))) {
    fail(`EAS production EXPO_PUBLIC_BACKEND_URL looks like a dev host:\n   ${line.trim()}`);
  }
  if (!line.includes(PROD_HOST)) {
    console.warn(
      `[guard-ota] ⚠️  EXPO_PUBLIC_BACKEND_URL on EAS does not contain "${PROD_HOST}":\n   ${line.trim()}\n` +
      '   Continuing because it does not look like a known dev host.'
    );
  } else {
    console.log(`[guard-ota] ✅ EAS production EXPO_PUBLIC_BACKEND_URL → ${PROD_HOST}`);
  }
}

// All checks passed (or target is not production). Pass through to eas-cli.
const exec = spawnSync('npx', ['eas-cli', 'update', ...args], { stdio: 'inherit' });
process.exit(exec.status === null ? 1 : exec.status);
