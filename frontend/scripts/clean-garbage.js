#!/usr/bin/env node
/**
 * clean-garbage.js — detect and remove EAS-build-breaking junk files.
 *
 * Targets 0-byte files whose names contain non-printable bytes (the class of
 * corruption that caused EAS tar `lstat ENOENT` failures during the April 2026
 * deploy). Handles invalid UTF-8 names correctly by operating on Buffer paths
 * throughout — converting to a string would lose the original bytes and cause
 * `fs.statSync` to fail on a replacement-char path.
 *
 * Usage: `node ./scripts/clean-garbage.js`
 * Invoked automatically by `yarn deploy:preflight`.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = Buffer.from(path.resolve(__dirname, '..'));

// Directories we never descend into (huge + irrelevant + won't be tarred)
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.expo', '.metro-cache',
  '.ruff_cache', 'android', 'ios', 'dist', 'web-build',
]);

/** True if `buf` contains any non-printable / DEL byte. */
function hasNonPrintable(buf) {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) return true;
    if (b === 0x7F) return true;
  }
  return false;
}

/** Buffer-aware path join that preserves non-UTF-8 bytes. */
function joinBuf(dirBuf, nameBuf) {
  const sep = Buffer.from(path.sep);
  return Buffer.concat([dirBuf, sep, nameBuf]);
}

let removed = 0;

function scan(dirBuf) {
  let entries;
  try {
    entries = fs.readdirSync(dirBuf, { withFileTypes: true, encoding: 'buffer' });
  } catch (err) {
    console.warn(`[clean-garbage] cannot read ${dirBuf}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const nameBuf = entry.name;                     // always Buffer here
    const fullBuf = joinBuf(dirBuf, nameBuf);

    if (entry.isDirectory()) {
      // Only check top-level dirs against the skip list (uses utf-8 name —
      // a binary-named dir would never be on the skip list anyway).
      const nameStr = nameBuf.toString('utf8');
      if (SKIP_DIRS.has(nameStr)) continue;
      scan(fullBuf);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!hasNonPrintable(nameBuf)) continue;

    // Filename contains unprintable bytes → EAS `lstat` will choke during tar
    // upload regardless of file size. Remove it unconditionally. (Previously
    // we guarded on size===0; that left non-empty corrupt names able to break
    // the build.)
    let stat;
    try { stat = fs.statSync(fullBuf); } catch { /* unreadable → still try to unlink */ }

    try {
      fs.unlinkSync(fullBuf);
      removed++;
      const sizeStr = stat ? `${stat.size}B` : 'unreadable';
      console.log(
        `[clean-garbage] removed junk file (size=${sizeStr} name-hex=${nameBuf.toString('hex')})`
      );
    } catch (err) {
      console.warn(`[clean-garbage] failed to remove junk file: ${err.message}`);
    }
  }
}

scan(ROOT);

if (removed === 0) {
  console.log('[clean-garbage] clean — no junk files found');
} else {
  console.log(`[clean-garbage] removed ${removed} junk file${removed === 1 ? '' : 's'}`);
}
process.exit(0);
