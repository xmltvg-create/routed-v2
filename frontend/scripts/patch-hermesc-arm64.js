#!/usr/bin/env node
/**
 * patch-hermesc-arm64.js — wrap react-native's bundled linux64 hermesc (x86_64 ELF)
 * in a qemu-user-static shim so `eas update` / `expo export` work on aarch64 hosts.
 *
 * No-ops on x86_64 hosts and on systems without qemu-x86_64-static installed.
 * Idempotent: safe to re-run after every `yarn install` (postinstall hook).
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR   = path.resolve(__dirname, '..', 'node_modules', 'react-native', 'sdks', 'hermesc', 'linux64-bin');
const HERMESC   = path.join(BIN_DIR, 'hermesc');
const HERMESC_X = path.join(BIN_DIR, 'hermesc.x86_64');

// 1. Platform gate — only needed on ARM64 Linux.
if (os.platform() !== 'linux' || os.arch() !== 'arm64') {
  process.exit(0);
}

// 2. Skip if react-native isn't installed (e.g. first-ever clone before yarn).
if (!fs.existsSync(BIN_DIR)) {
  process.exit(0);
}

// 3. Require qemu-x86_64-static in PATH.
try { execSync('command -v qemu-x86_64-static', { stdio: 'ignore' }); }
catch {
  console.warn('[patch-hermesc-arm64] qemu-x86_64-static not installed — skipping. '
             + 'Run `apt-get install qemu-user-static binfmt-support` to enable eas update on aarch64.');
  process.exit(0);
}

// 4. If already wrapped, no-op.
if (fs.existsSync(HERMESC_X) && fs.existsSync(HERMESC)) {
  const first = fs.readFileSync(HERMESC, { encoding: 'utf8', flag: 'r' }).slice(0, 20);
  if (first.startsWith('#!/bin/sh')) {
    // already patched
    process.exit(0);
  }
}

// 5. Move original ELF aside and drop the shim in its place.
if (!fs.existsSync(HERMESC_X)) {
  fs.renameSync(HERMESC, HERMESC_X);
}
fs.writeFileSync(HERMESC,
`#!/bin/sh
# ARM64 shim — routes the x86_64 hermesc ELF through qemu-user-static.
# Auto-installed by scripts/patch-hermesc-arm64.js (postinstall).
exec qemu-x86_64-static "$(dirname "$0")/hermesc.x86_64" "$@"
`);
fs.chmodSync(HERMESC, 0o755);
console.log('[patch-hermesc-arm64] installed qemu shim → hermesc now runnable on aarch64');
