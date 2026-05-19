/**
 * withAdiRegistration.js — Expo config plugin
 *
 * Google Play "Android Developer Identity" verification requires a file
 * at android/app/src/main/assets/adi-registration.properties containing
 * a per-account verification snippet.
 *
 * This plugin copies that file into the native Android assets folder
 * during `expo prebuild`, so it ends up baked into the signed APK that
 * EAS builds.
 *
 * Source file location (in this repo):
 *   /app/frontend/assets/adi-registration.properties
 *
 * Destination (created during prebuild):
 *   android/app/src/main/assets/adi-registration.properties
 *
 * After verification clears (one-time), this plugin can be removed —
 * but keeping it costs nothing and protects against re-verification
 * if Google ever rotates their flow.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, createRunOncePlugin } = require('@expo/config-plugins');

const FILE_NAME = 'adi-registration.properties';

const withAdiRegistration = (config) => {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const source = path.join(projectRoot, 'assets', FILE_NAME);

      // Skip silently if the source file isn't present — useful for
      // dev environments that don't need the production verification.
      if (!fs.existsSync(source)) {
        console.warn(
          `[withAdiRegistration] ${FILE_NAME} not found at ${source} — skipping.`
        );
        return cfg;
      }

      const androidAssets = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets'
      );
      fs.mkdirSync(androidAssets, { recursive: true });

      const destination = path.join(androidAssets, FILE_NAME);
      fs.copyFileSync(source, destination);
      console.log(
        `[withAdiRegistration] ✓ Copied ${FILE_NAME} → ${destination}`
      );
      return cfg;
    },
  ]);
};

module.exports = createRunOncePlugin(
  withAdiRegistration,
  'with-adi-registration',
  '1.0.0'
);
