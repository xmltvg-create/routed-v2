#!/usr/bin/env node
/**
 * check-props.js
 *
 * Build-time safety net: scans the TypeScript project for JSX invocations
 * that are missing required props. Catches exactly the class of bug that
 * caused the 2026-04-18 Android APK black-screen crash (Sidebar was called
 * without `optimizationHubs`, which then threw `.length of undefined` in
 * Hermes release mode and unmounted the whole screen).
 *
 * What it flags:
 *   TS2741 — "Property 'X' is missing in type '...' but required in type '...'"
 *   TS2739 — "Type '...' is missing the following properties from type '...': a, b, c"
 *   TS2305 — "Module '...' has no exported member 'X'"       (dead named import)
 *   TS2307 — "Cannot find module '...'"                      (file path typo / missing file)
 *   TS2304 — "Cannot find name 'X'"                          (undefined identifier)
 *   TS2552 — "Cannot find name 'X'. Did you mean 'Y'?"       (typo on identifier)
 *
 * Usage:
 *   node scripts/check-props.js           # run once, exit non-zero on failure
 *   yarn check:props                       # alias (see package.json)
 *
 * Run this before every deploy. Metro/Babel does not type-check, so
 * without this guard, missing-prop bugs only surface as crashes on a
 * user's device — far too late.
 */

const path = require('path');
const ts = require('typescript');

const TARGET_CODES = new Set([2741, 2739, 2305, 2307, 2304, 2552]);
const ROOT = path.resolve(__dirname, '..');
const TSCONFIG = path.join(ROOT, 'tsconfig.json');

function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

function main() {
  // Load tsconfig
  const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (configFile.error) {
    console.error(red('[check-props] Failed to read tsconfig.json:'));
    console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
    process.exit(2);
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
  if (parsed.errors.length) {
    console.error(red('[check-props] tsconfig parse errors:'));
    parsed.errors.forEach((e) =>
      console.error('  ' + ts.flattenDiagnosticMessageText(e.messageText, '\n'))
    );
    process.exit(2);
  }

  console.log(dim(`[check-props] Type-checking ${parsed.fileNames.length} files…`));
  const started = Date.now();

  // Build program & collect diagnostics
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const offenders = diagnostics.filter((d) => TARGET_CODES.has(d.code));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(dim(`[check-props] Scan finished in ${elapsed}s`));

  // ── Babel parse (matches Metro's parser) ───────────────────────────────
  // TypeScript is more lenient than Babel about template-literal contents —
  // e.g. TS tolerates a backtick character inside a `//` comment that sits
  // *inside* another template literal, but Babel (and therefore Metro's
  // production bundler) bails with "Missing semicolon". This crashes the EAS
  // build long after CI is green, so we run a Babel parse pass here to catch
  // it at preflight time.
  let babelOffenders = 0;
  try {
    const babel = require('@babel/parser');
    const tsSources = parsed.fileNames.filter((f) => /\.(t|j)sx?$/.test(f));
    for (const file of tsSources) {
      const src = ts.sys.readFile(file);
      if (!src) continue;
      try {
        babel.parse(src, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript'],
          errorRecovery: false,
        });
      } catch (e) {
        babelOffenders++;
        const rel = path.relative(ROOT, file);
        console.error('');
        console.error(red(bold(`[check-props] Babel parse FAILED — ${rel}`)));
        console.error('    ' + (e && e.message ? e.message : String(e)));
      }
    }
  } catch (e) {
    // @babel/parser not installed — skip this check silently (TS still ran)
    console.log(dim('[check-props] @babel/parser unavailable, skipping Metro-parity check'));
  }
  if (babelOffenders > 0) {
    console.error('');
    console.error(red(bold(`[check-props] FAILED — ${babelOffenders} file(s) would crash the EAS Metro bundler`)));
    process.exit(1);
  }

  if (offenders.length === 0) {
    console.log(green(bold('[check-props] OK ')) + '— no release-crash errors detected (props, imports, identifiers).');
    process.exit(0);
  }

  // Print each offender in a readable format
  console.error('');
  console.error(red(bold(`[check-props] FAILED — ${offenders.length} error(s) that would crash in release:`)));
  console.error('');
  for (const d of offenders) {
    if (d.file && typeof d.start === 'number') {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      const rel = path.relative(ROOT, d.file.fileName);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n    ');
      console.error(`  ${yellow(`${rel}:${line + 1}:${character + 1}`)}`);
      console.error(`    ${bold(`TS${d.code}`)}: ${msg}`);
      console.error('');
    } else {
      console.error(`  TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    }
  }
  console.error(
    dim(
      'Each error above would silently crash the release APK. Fix at the indicated ' +
        'file:line — common fixes:\n' +
        '    • Missing prop (TS2741/TS2739): pass it at the call site, or give it a default + make the interface optional\n' +
        '    • Dead import (TS2305/TS2307):  remove the import, fix the module path, or export the missing name\n' +
        '    • Unknown name  (TS2304/TS2552): add the missing import or fix the typo'
    )
  );
  process.exit(1);
}

main();
