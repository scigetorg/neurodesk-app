const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  // Create a backward-compatible symlink so the old executable path
  // (NeurodeskApp) still resolves after auto-update replaces the bundle.
  // This lets the updater relaunch via the old process.execPath on the
  // first upgrade from NeurodeskApp to ScigetApp.
  const appName = context.packager.appInfo.productFilename;
  const macosDir = path.join(
    context.appOutDir,
    `${appName}.app`,
    'Contents',
    'MacOS'
  );
  const legacyName = 'NeurodeskApp';
  const legacyPath = path.join(macosDir, legacyName);

  if (appName !== legacyName && !fs.existsSync(legacyPath)) {
    fs.symlinkSync(appName, legacyPath);
  }
};
