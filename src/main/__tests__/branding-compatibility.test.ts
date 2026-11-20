import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);

describe('Sciget upgrade compatibility', () => {
  it('keeps installer and update identifiers used by existing installations', () => {
    expect(pkg.name).toBe('scigetapp');
    expect(pkg.build.appId).toBe('org.neurodesk.neurodeskapp');
    expect(pkg.build.productName).toBe('NeurodeskApp');
    expect(pkg.build.artifactName).toBe('${productName}.${ext}');
    expect(pkg.build.nsis.artifactName).toBe('${productName}-Setup.${ext}');
    expect(pkg.build.mac.artifactName).toBe('${productName}-${arch}.${ext}');
    expect(pkg.repository).toBe('https://github.com/scigetorg/neurodesk-app');
    expect(pkg.build.mac.extendInfo.CFBundleDisplayName).toBe('Sciget App');
    expect(pkg.build.linux.desktop.entry.Name).toBe('Sciget App');
    expect(pkg.build.nsis.shortcutName).toBe('Sciget App');

    const publishWorkflow = fs.readFileSync(
      path.join(root, '.github/workflows/publish.yml'),
      'utf8'
    );
    for (const asset of [
      'NeurodeskApp-Setup-Windows.exe',
      'NeurodeskApp-macOS-arm64.zip',
      'NeurodeskApp-macOS-x64.zip',
      'latest.yml'
    ]) {
      expect(publishWorkflow).toContain(`asset_name: ${asset}`);
    }
  });
});
