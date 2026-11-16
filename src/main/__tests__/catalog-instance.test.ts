import {
  DEFAULT_CONTAINER_ID,
  defaultStorageMount,
  getContainerCatalog,
  requireContainerEntry,
  setContainerCatalog
} from '../config/catalogInstance';
import { ContainerCatalog } from '../config/containerCatalog';

const entry = {
  title: 'neurodesk',
  description: 'Neuroimaging tools.',
  registry: 'docker.io/vnmd/neurodesktop',
  defaultVersion: '2026-09-23',
  containerName: 'neurodeskapp',
  volumeMount: 'neurodesk-home',
  defaultStorageMount: 'remote-storage'
};

afterEach(() => setContainerCatalog(null));

function catalogWith(entries: Record<string, typeof entry>) {
  const catalog = new ContainerCatalog({
    url: '',
    bundledDir: '/nonexistent',
    appVersion: '1.0.0'
  });
  jest
    .spyOn(catalog, 'getEntry')
    .mockImplementation(id => (entries as any)[id]);
  setContainerCatalog(catalog);
}

test('the bundled catalog has the default container', () => {
  setContainerCatalog(
    new ContainerCatalog({
      url: '',
      bundledDir: require('../config/catalogInstance').bundledContainerDir(),
      appVersion: '1.0.0'
    })
  );
  expect(getContainerCatalog().getEntry(DEFAULT_CONTAINER_ID)).toBeDefined();
});

test('requireContainerEntry names an unknown ID', () => {
  catalogWith({});
  expect(() => requireContainerEntry('missing')).toThrow(
    'Unknown container configuration: missing'
  );
});

test('the default storage folder follows the catalog entry', () => {
  catalogWith({ [DEFAULT_CONTAINER_ID]: entry });
  expect(defaultStorageMount()).toBe('remote-storage');
});

test('the default storage folder falls back to the bundled file', () => {
  catalogWith({});
  expect(defaultStorageMount()).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
});
