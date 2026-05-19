// Dynamic Expo config.
// Purpose: Take precedence over app.json so that the literal
// `runtimeVersion` strings can NEVER be overwritten by any build
// pipeline that mutates app.json (e.g. Emergent deployment's
// "Fixing app.json for EAS compatibility" step). In bare workflow
// (where the `ios/` folder exists), `eas update` rejects any
// runtimeVersion policy object like {"policy": "appVersion"} and
// requires a literal version string. Locking the value here guarantees
// it survives all upstream rewrites.

const appJson = require('./app.json');

const RUNTIME_VERSION = '1.0.0';

module.exports = ({ config }) => {
  const base = appJson.expo || config || {};

  return {
    ...base,
    runtimeVersion: RUNTIME_VERSION,
    ios: {
      ...(base.ios || {}),
      runtimeVersion: RUNTIME_VERSION,
    },
    android: {
      ...(base.android || {}),
      runtimeVersion: RUNTIME_VERSION,
    },
  };
};
