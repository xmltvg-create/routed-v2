/**
 * Pure-logic unit tests for the bin assignment algorithm in
 * `src/store/vanLayoutStore.ts`. We don't need React Native runtime
 * (zustand + AsyncStorage) for `assignBin` itself, so the tests just
 * exercise the helper in isolation.
 *
 * Run with: `node -r sucrase/register src/store/__tests__/vanLayoutStore.assignBin.test.js`
 */
require('sucrase/register');
const { assignBin, binLabel } = require('../vanLayoutStore.ts');

const expect = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
};

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed += 1;
  }
};

console.log('binLabel');
test('A1 / B2 / C3 mapping', () => {
  expect(binLabel(0, 0) === 'A1', 'A1');
  expect(binLabel(1, 1) === 'B2', 'B2');
  expect(binLabel(2, 2) === 'C3', 'C3');
});

console.log('\nassignBin — exact fit (N == rows*cols)');
test('first stop → A1, last stop → C3 on a 3×3 grid with 9 stops', () => {
  const total = 9;
  expect(assignBin(0, total, 3, 3).label === 'A1', 'first stop → A1');
  expect(assignBin(8, total, 3, 3).label === 'C3', 'last stop → C3');
});

test('proportional row stride (3×3, 9 stops)', () => {
  const total = 9;
  // Stops 0-2 go in row A, 3-5 in row B, 6-8 in row C.
  expect(assignBin(2, total, 3, 3).row === 0, 'stop 2 still in row A');
  expect(assignBin(3, total, 3, 3).row === 1, 'stop 3 enters row B');
  expect(assignBin(5, total, 3, 3).row === 1, 'stop 5 still in row B');
  expect(assignBin(6, total, 3, 3).row === 2, 'stop 6 enters row C');
});

console.log('\nassignBin — fewer stops than bins (9 bins, 4 stops)');
test('first stop is A1 even when grid is sparse', () => {
  expect(assignBin(0, 4, 3, 3).label === 'A1', 'first → A1');
});

test('last stop hits bottom row (C) on a 3×3 grid', () => {
  // With 4 stops on 9 bins, sparseness means the last stop won't necessarily
  // land in C3 — but it MUST be in the bottom row so the spec ("last stop
  // first → bottom-row first") holds.
  const last = assignBin(3, 4, 3, 3);
  expect(last.row === 2, `expected last stop in row C, got row ${last.row}`);
});

console.log('\nassignBin — more stops than bins (9 bins, 15 stops)');
test('stops distribute across all bins, every bin appears at least once', () => {
  const total = 15;
  const seen = new Set();
  for (let i = 0; i < total; i += 1) {
    seen.add(assignBin(i, total, 3, 3).label);
  }
  expect(seen.size === 9, `expected 9 unique bins, got ${seen.size}`);
});

test('first stop still A1, last stop still C3', () => {
  expect(assignBin(0, 15, 3, 3).label === 'A1', 'first → A1');
  expect(assignBin(14, 15, 3, 3).label === 'C3', 'last → C3');
});

test('bin index is non-decreasing in delivery order (3×3, 15 stops)', () => {
  const total = 15;
  let prev = -1;
  for (let i = 0; i < total; i += 1) {
    const { row, col } = assignBin(i, total, 3, 3);
    const flat = row * 3 + col;
    expect(flat >= prev, `bin index regressed at i=${i}: ${flat} < ${prev}`);
    prev = flat;
  }
});

console.log('\nassignBin — 2×3 / 3×4 grids');
test('2×3 grid: 6 stops fill exactly', () => {
  const total = 6;
  expect(assignBin(0, total, 2, 3).label === 'A1', 'first → A1');
  expect(assignBin(5, total, 2, 3).label === 'B3', 'last → B3 (bottom-right)');
});

test('3×4 grid: 12 stops fill exactly', () => {
  const total = 12;
  expect(assignBin(0, total, 3, 4).label === 'A1', 'first → A1');
  expect(assignBin(11, total, 3, 4).label === 'C4', 'last → C4 (bottom-right)');
});

console.log('\nassignBin — defensive');
test('returns A1 fallback for empty/zero inputs', () => {
  expect(assignBin(0, 0, 3, 3).label === 'A1', 'totalStops=0');
  expect(assignBin(0, 5, 0, 0).label === 'A1', 'rows=0,cols=0');
});

test('out-of-range stopIdx clamps to the last bin', () => {
  // stopIdx > totalStops shouldn't blow up; clamp to last slot.
  expect(assignBin(99, 10, 3, 3).label === 'C3', 'oversized idx → C3');
  // Negative idx clamps to A1.
  expect(assignBin(-1, 10, 3, 3).label === 'A1', 'negative idx → A1');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
