#!/usr/bin/env node
/**
 * check-backend-url.js — preflight check that pings every backend URL the
 * APK might bake into its bundle, so a stale `eas.json` env doesn't ship
 * a non-functional build.
 *
 * Reads:
 *   - frontend/.env             → EXPO_PUBLIC_BACKEND_URL (dev/tunnel)
 *   - frontend/eas.json         → build.<profile>.env.EXPO_PUBLIC_BACKEND_URL
 *
 * For every unique URL found, GETs `/api/live` (≤4s timeout). Fails the
 * preflight if any URL is unreachable, returns non-2xx, or returns a body
 * other than `{"alive": true}`.
 *
 * Bypass for offline preflight:  CHECK_BACKEND_URL=0 yarn deploy:preflight
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

if (process.env.CHECK_BACKEND_URL === '0') {
  console.log('[check-backend-url] skipped (CHECK_BACKEND_URL=0)');
  process.exit(0);
}

const FRONTEND = path.resolve(__dirname, '..');
const TIMEOUT_MS = 4000;
const seen = new Map(); // url → source label

// Pull URL out of frontend/.env (line-based, ignores comments).
const envPath = path.join(FRONTEND, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*EXPO_PUBLIC_BACKEND_URL\s*=\s*(.+?)\s*$/);
    if (m) {
      const url = m[1].replace(/^['"]|['"]$/g, '');
      if (url) seen.set(url, '.env');
    }
  }
}

// Pull URLs out of every build profile in eas.json.
const easPath = path.join(FRONTEND, 'eas.json');
if (fs.existsSync(easPath)) {
  const eas = JSON.parse(fs.readFileSync(easPath, 'utf8'));
  for (const [profile, cfg] of Object.entries(eas.build || {})) {
    const url = cfg?.env?.EXPO_PUBLIC_BACKEND_URL;
    if (url && !seen.has(url)) seen.set(url, `eas.json:${profile}`);
  }
}

if (seen.size === 0) {
  console.error('[check-backend-url] ✗ no EXPO_PUBLIC_BACKEND_URL found in .env or eas.json');
  process.exit(1);
}

function ping(url) {
  return new Promise((resolve) => {
    const target = url.replace(/\/+$/, '') + '/api/live';
    const lib = target.startsWith('https:') ? https : http;
    const req = lib.get(target, { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `timeout after ${TIMEOUT_MS}ms` }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  let failed = false;
  for (const [url, source] of seen) {
    process.stdout.write(`[check-backend-url] ${source.padEnd(20)} ${url} → `);
    const r = await ping(url);
    if (r.error) {
      console.log(`✗ ${r.error}`);
      failed = true;
    } else if (r.status !== 200 || !r.body.includes('"alive"')) {
      console.log(`✗ HTTP ${r.status} body="${r.body}"`);
      failed = true;
    } else {
      console.log('✓');
    }
  }
  if (failed) {
    console.error(
      '\n[check-backend-url] ✗ at least one backend URL is unreachable.\n' +
      '   Update `EXPO_PUBLIC_BACKEND_URL` in eas.json / .env to a live host\n' +
      '   before shipping an APK that bakes in a dead URL. Bypass with\n' +
      '   `CHECK_BACKEND_URL=0 yarn deploy:preflight` for offline work.\n'
    );
    process.exit(1);
  }
  console.log('[check-backend-url] OK');
})();
