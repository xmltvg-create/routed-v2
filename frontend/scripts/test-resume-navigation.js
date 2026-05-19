#!/usr/bin/env node
/**
 * Zero-framework test for /app/frontend/src/utils/resumeNavigation.js.
 *
 * We intentionally avoid jest/vitest here because setting those up with
 * Expo SDK 54 + React Native 0.81 requires non-trivial babel/metro config.
 * The helper is plain JS with JSDoc types, so we can require() it.
 *
 * Run via:  node ./scripts/test-resume-navigation.js
 * Wired into `yarn deploy:preflight` so every OTA verifies this invariant.
 */
const path = require('path');
const assert = require('assert');
const Module = require('module');
const fs = require('fs');

const SRC_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'utils',
  'resumeNavigation.js',
);

// The helper uses ES module `export` syntax for the React Native bundler.
// Node's CommonJS loader doesn't support that by default, so we rewrite
// `export function X` → `function X` and tack on module.exports at the end.
function loadHelper() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const transformed = src.replace(/export\s+function/g, 'function');
  const m = new Module('resumeNavigation.runtime');
  m._compile(
    `${transformed}\nmodule.exports = { findResumeLegIndex };`,
    'resumeNavigation.runtime.js',
  );
  return m.exports;
}

const { findResumeLegIndex } = loadHelper();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('[test-resume-navigation]');

test('returns fallback when sameRoute is false', () => {
  const idx = findResumeLegIndex({
    savedStopId: 'stop-A',
    freshLegs: [{ to_stop: { id: 'stop-A' } }, { to_stop: { id: 'stop-B' } }],
    fallbackIdx: 0,
    sameRoute: false,
  });
  assert.strictEqual(idx, 0);
});

test('returns fallback when savedStopId is empty', () => {
  const idx = findResumeLegIndex({
    savedStopId: null,
    freshLegs: [{ to_stop: { id: 'stop-A' } }],
    fallbackIdx: 3,
    sameRoute: true,
  });
  assert.strictEqual(idx, 3);
});

test('finds stop when legs array is in same order', () => {
  const idx = findResumeLegIndex({
    savedStopId: 'stop-B',
    freshLegs: [
      { to_stop: { id: 'stop-A' } },
      { to_stop: { id: 'stop-B' } },
      { to_stop: { id: 'stop-C' } },
    ],
    fallbackIdx: 99,
    sameRoute: true,
  });
  assert.strictEqual(idx, 1);
});

test('finds stop when backend collapsed earlier legs (the real bug)', () => {
  // Before exit: legs [A, B, C, D, E]; driver was on leg 3 (stop-D).
  // User exits. Drives past D. Re-enters.
  // Backend rebuilds from GPS + filters completed — only [D, E] remain.
  // fallbackIdx=3 would now be out-of-range; stop-ID match gives us idx=0.
  const idx = findResumeLegIndex({
    savedStopId: 'stop-D',
    freshLegs: [{ to_stop: { id: 'stop-D' } }, { to_stop: { id: 'stop-E' } }],
    fallbackIdx: 3, // stale numeric index from before
    sameRoute: true,
  });
  assert.strictEqual(idx, 0);
});

test('finds stop when GPS shift reshuffled leg origins', () => {
  // Same stops, different leg sequence because the driver's new GPS makes a
  // different ordering cheaper. We still match by ID, not by index.
  const idx = findResumeLegIndex({
    savedStopId: 'stop-B',
    freshLegs: [
      { to_stop: { id: 'stop-C' } },
      { to_stop: { id: 'stop-A' } },
      { to_stop: { id: 'stop-B' } },
    ],
    fallbackIdx: 1, // was heading to B originally at index 1
    sameRoute: true,
  });
  assert.strictEqual(idx, 2);
});

test('falls back when saved stop was completed and no longer in legs', () => {
  const idx = findResumeLegIndex({
    savedStopId: 'stop-GONE',
    freshLegs: [
      { to_stop: { id: 'stop-A' } },
      { to_stop: { id: 'stop-B' } },
    ],
    fallbackIdx: 0,
    sameRoute: true,
  });
  assert.strictEqual(idx, 0);
});

test('tolerates null / malformed leg entries', () => {
  const idx = findResumeLegIndex({
    savedStopId: 'stop-B',
    freshLegs: [
      null,
      undefined,
      { to_stop: null },
      { to_stop: { id: 'stop-A' } },
      { to_stop: { id: 'stop-B' } },
    ],
    fallbackIdx: 0,
    sameRoute: true,
  });
  assert.strictEqual(idx, 4);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
