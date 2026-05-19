/**
 * withHardwareAcceleration.js — Expo config plugin
 * Full Android hardware acceleration for WebGL/MapLibre in WebView.
 *
 * Enforces:
 *  - android:hardwareAccelerated="true" on <application>
 *  - android:largeHeap="true" for WebGL memory (tile textures, building extrusions)
 *  - android:usesCleartextTraffic="true" (tile CDN fallbacks)
 *  - android:hardwareAccelerated="true" on the main <activity>
 */
const { withAndroidManifest, createRunOncePlugin } = require('@expo/config-plugins');

const withHardwareAcceleration = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return cfg;

    // Application-level flags
    app.$['android:hardwareAccelerated'] = 'true';
    app.$['android:largeHeap'] = 'true';
    app.$['android:usesCleartextTraffic'] = 'true';

    // Activity-level: ensure main activity has HW accel
    const activities = app.activity || [];
    for (const activity of activities) {
      if (activity.$?.['android:name'] === '.MainActivity') {
        activity.$['android:hardwareAccelerated'] = 'true';
        activity.$['android:windowSoftInputMode'] = 'adjustResize';
      }
    }

    return cfg;
  });
};

module.exports = createRunOncePlugin(
  withHardwareAcceleration,
  'with-hardware-acceleration',
  '1.0.0'
);
