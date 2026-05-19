const { withAndroidManifest, withDangerousMod, createRunOncePlugin } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const META_NAME = 'com.google.android.gms.car.application';
const META_RESOURCE = '@xml/automotive_app_desc';
const SERVICE_NAME = 'com.shopify.rnandroidauto.CarService';
const CAR_APP_ACTION = 'com.google.android.car.action.CAR_APP';

function ensureMetaData(mainApplication) {
  const existing = mainApplication['meta-data'] || [];
  const hasMeta = existing.some(
    (item) => item?.$?.['android:name'] === META_NAME
  );
  if (!hasMeta) {
    existing.push({
      $: {
        'android:name': META_NAME,
        'android:resource': META_RESOURCE,
      },
    });
    mainApplication['meta-data'] = existing;
  }
}

function ensureService(mainApplication) {
  const services = mainApplication.service || [];
  const hasService = services.some(
    (item) => item?.$?.['android:name'] === SERVICE_NAME
  );
  if (!hasService) {
    services.push({
      $: {
        'android:name': SERVICE_NAME,
        'android:exported': 'true',
      },
      'intent-filter': [
        {
          action: [
            {
              $: {
                'android:name': CAR_APP_ACTION,
              },
            },
          ],
        },
      ],
    });
    mainApplication.service = services;
  }
}

const withAndroidAutoManifest = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) {
      return cfg;
    }

    ensureMetaData(app);
    ensureService(app);
    return cfg;
  });
};

const withAndroidAutoDescriptorFile = (config) => {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      const xmlPath = path.join(xmlDir, 'automotive_app_desc.xml');

      if (!fs.existsSync(xmlDir)) {
        fs.mkdirSync(xmlDir, { recursive: true });
      }

      const descriptor = `<?xml version="1.0" encoding="utf-8"?>\n<automotiveApp>\n  <uses name="template" />\n</automotiveApp>\n`;
      fs.writeFileSync(xmlPath, descriptor);
      return cfg;
    },
  ]);
};

const withAndroidAuto = (config) => {
  config = withAndroidAutoManifest(config);
  config = withAndroidAutoDescriptorFile(config);
  return config;
};

module.exports = createRunOncePlugin(withAndroidAuto, 'with-android-auto', '1.0.0');
