import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import {
  CATALOG_SCHEMA_VERSION,
  isEntryCompatible,
  parseCatalogDocument,
  validateCatalogEntry
} from '../config/containerCatalogSchema';
import { validateStorageMount } from '../config/storageMount';

const schemaPath = path.join(__dirname, '../config/domains.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajvValidate = new Ajv({ strict: true }).compile(schema);

const validEntry = () => ({
  title: 'neurodesk',
  description:
    'Neuroimaging tools and resources for neuroimaging research and analysis.',
  registry: 'docker.io/vnmd/neurodesktop',
  defaultVersion: '2026-09-23',
  releaseHistoryUrl:
    'https://raw.githubusercontent.com/neurodesk/neurodesk.github.io/refs/heads/main/src/content/docs/overview/release-history/index.mdx',
  containerName: 'neurodeskapp',
  volumeMount: 'neurodesk-home',
  defaultStorageMount: 'neurodesktop-storage',
  remoteUrl: [
    'https://play.neurodesk.cloud.edu.au/',
    'https://play-america.neurodesk.org/'
  ],
  tags: ['neuroimaging', 'MRI'],
  minAppVersion: '2.1.0'
});

// Each case replaces one field. Shell-injection cases target the fields that
// reach the launch script; markup/quote cases target fields that reach the
// welcome view's innerHTML and inline onclick handlers.
const INVALID: Array<[string, string, unknown]> = [
  [
    'registry with command separator',
    'registry',
    'vnmd/neurodesktop; rm -rf ~'
  ],
  ['registry with command substitution', 'registry', 'vnmd/$(id)'],
  ['registry with backticks', 'registry', 'vnmd/`id`'],
  ['registry with uppercase', 'registry', 'VNMD/neurodesktop'],
  ['registry with space', 'registry', 'vnmd/neuro desktop'],
  ['registry with tag', 'registry', 'vnmd/neurodesktop:latest'],
  ['registry with leading dash', 'registry', '-vnmd/neurodesktop'],
  ['registry empty', 'registry', ''],
  ['tag with pipe', 'defaultVersion', 'latest|sh'],
  ['tag with ampersand', 'defaultVersion', '2026&calc'],
  ['tag starting with dot', 'defaultVersion', '.hidden'],
  ['tag too long', 'defaultVersion', 'a'.repeat(129)],
  ['tag as number', 'defaultVersion', 20260923],
  ['containerName with space', 'containerName', 'neurodesk app'],
  ['containerName with quote', 'containerName', 'nd"app'],
  ['volumeMount with path', 'volumeMount', '/etc:/host'],
  ['volumeMount with colon', 'volumeMount', 'home:rw'],
  ['storage mount traversal', 'defaultStorageMount', '..'],
  ['storage mount with slash', 'defaultStorageMount', 'a/b'],
  ['title with markup', 'title', '<img src=x onerror=alert(1)>'],
  ['title with single quote', 'title', "neuro'desk"],
  ['title empty', 'title', ''],
  ['description with markup', 'description', 'Tools <script>x</script>'],
  ['description with entity', 'description', 'Tools &amp; data'],
  ['description empty', 'description', ''],
  ['http release history', 'releaseHistoryUrl', 'http://example.org/x.mdx'],
  ['javascript release history', 'releaseHistoryUrl', 'javascript:alert(1)'],
  ['release history with quote', 'releaseHistoryUrl', "https://a.org/x'y"],
  ['remote url not https', 'remoteUrl', ['http://play.neurodesk.org/']],
  ['remote url with quote', 'remoteUrl', ["https://a.org/');alert(1);//"]],
  ['remote url with no host', 'remoteUrl', ['https:///path']],
  ['remote url string', 'remoteUrl', 'https://play.neurodesk.org/'],
  ['too many remote urls', 'remoteUrl', Array(11).fill('https://a.org/')],
  [
    'http appJsonUrl',
    'appJsonUrl',
    'http://example.org/neuroimaging/apps.json'
  ],
  ['javascript appJsonUrl', 'appJsonUrl', 'javascript:alert(1)'],
  ['appJsonUrl with quote', 'appJsonUrl', "https://a.org/x'y"],
  ['download url not https', 'downloadUrls', ['http://example.org/{file}']],
  ['download url with quote', 'downloadUrls', ["https://a.org/'{file}"]],
  ['download url with backtick', 'downloadUrls', ['https://a.org/`{file}`']],
  ['download url string', 'downloadUrls', 'https://example.org/{file}'],
  [
    'too many download urls',
    'downloadUrls',
    Array(11).fill('https://a.org/{file}')
  ],
  ['tag label with markup', 'tags', ['<b>']],
  ['tags not a list', 'tags', 'mri'],
  ['minAppVersion not semver', 'minAppVersion', '2.1'],
  ['minAppVersion as number', 'minAppVersion', 2]
];

const REQUIRED = [
  'title',
  'description',
  'registry',
  'defaultVersion',
  'containerName',
  'volumeMount',
  'defaultStorageMount'
];

// A domains.json document giving each domain the launch fields shown.
const document = (containers: Record<string, unknown>) => ({
  schemaVersion: CATALOG_SCHEMA_VERSION,
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

describe('validateCatalogEntry', () => {
  it('accepts a complete entry and returns its fields', () => {
    const result = validateCatalogEntry('neuroimaging', validEntry());
    expect(result).toEqual({ ok: true, entry: validEntry() });
  });

  it('accepts an entry with only the required fields', () => {
    const entry: Record<string, unknown> = validEntry();
    for (const key of Object.keys(entry)) {
      if (!REQUIRED.includes(key)) delete entry[key];
    }
    expect(validateCatalogEntry('neuroimaging', entry).ok).toBe(true);
  });

  it.each([
    'docker.io/vnmd/neurodesktop',
    'vnmd/neurodesktop',
    'neurodesktop',
    'ghcr.io/neurodesk/neuro_desktop',
    'localhost:5000/neurodesktop',
    'registry.example.org/a/b/c',
    'vnmd/neuro__desktop',
    'vnmd/neuro--desktop'
  ])('accepts registry %s', registry => {
    expect(
      validateCatalogEntry('neuroimaging', { ...validEntry(), registry }).ok
    ).toBe(true);
  });

  it.each(['2026-09-23', 'latest', 'glass', 'v1.2.3', '_dev'])(
    'accepts tag %s',
    defaultVersion => {
      expect(
        validateCatalogEntry('neuroimaging', {
          ...validEntry(),
          defaultVersion
        }).ok
      ).toBe(true);
    }
  );

  it.each(INVALID)('rejects %s', (_label, field, value) => {
    const result = validateCatalogEntry('neuroimaging', {
      ...validEntry(),
      [field]: value
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.join('\n')).toContain(`neuroimaging.${field}`);
    }
  });

  it.each(REQUIRED)('rejects an entry missing %s', field => {
    const entry: Record<string, unknown> = validEntry();
    delete entry[field];
    expect(validateCatalogEntry('neuroimaging', entry).ok).toBe(false);
  });

  it.each(['neuroimaging', 'microscopy', 'neuro-imaging', 'n2'])(
    'accepts domain ID %j as container ID',
    id => {
      expect(validateCatalogEntry(id, validEntry()).ok).toBe(true);
    }
  );

  it.each([
    'Neuroimaging',
    'neuro--imaging',
    'neuro-',
    '-neuro',
    '2d',
    'neuro_imaging',
    'neuro desk',
    '../etc',
    'a;b',
    '',
    'x'.repeat(65)
  ])('rejects container ID %j', id => {
    expect(validateCatalogEntry(id, validEntry()).ok).toBe(false);
  });

  it.each([null, [], 'neurodesk', 42])('rejects non-object entry %j', raw => {
    expect(validateCatalogEntry('neuroimaging', raw).ok).toBe(false);
  });

  it('drops unknown fields instead of rejecting the entry', () => {
    const result = validateCatalogEntry('neuroimaging', {
      ...validEntry(),
      futureField: 'x'
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.entry).not.toHaveProperty('futureField');
    }
  });

  it('reports every bad field at once', () => {
    const result = validateCatalogEntry('neuroimaging', {
      ...validEntry(),
      registry: 'a;b',
      title: '<x>'
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors).toHaveLength(2);
    }
  });

  it('accepts exactly the storage mounts validateStorageMount accepts', () => {
    for (const mount of [
      'neurodesktop-storage',
      'a.b_c',
      '..',
      '.hidden',
      'a/b',
      ''
    ]) {
      let expected = true;
      try {
        validateStorageMount(mount);
      } catch {
        expected = false;
      }
      const result = validateCatalogEntry('neuroimaging', {
        ...validEntry(),
        defaultStorageMount: mount
      });
      expect([mount, result.ok]).toEqual([mount, expected]);
    }
  });
});

describe('isEntryCompatible', () => {
  const entry = (minAppVersion?: string) => ({
    ...validEntry(),
    minAppVersion
  });

  it('accepts entries with no minimum', () => {
    expect(isEntryCompatible(entry(undefined), '0.0.1')).toBe(true);
  });

  it.each([
    ['2.1.0', '2.1.0', true],
    ['2.1.0', '2.2.0', true],
    ['2.1.0', '3.0.0', true],
    ['2.2.0', '2.1.0', false],
    ['2.2.0', '2.2.0-beta.1', true],
    ['2.2.0', 'not-a-version', false]
  ])('min %s with app %s → %s', (min, app, expected) => {
    expect(isEntryCompatible(entry(min), app)).toBe(expected);
  });
});

describe('parseCatalogDocument', () => {
  it('accepts a current document', () => {
    const result = parseCatalogDocument(
      document({ neuroimaging: validEntry() })
    );
    expect(result).toEqual({
      ok: true,
      entries: {
        neuroimaging: {
          source_repositories: ['NeuroDesk/neurocontainers'],
          ...validEntry()
        }
      }
    });
  });

  it('skips domains with only source repositories', () => {
    expect(
      parseCatalogDocument({
        schemaVersion: 1,
        domains: {
          microscopy: { source_repositories: ['Example/microcontainers'] }
        }
      })
    ).toEqual({ ok: true, entries: {} });
  });

  it.each([
    ['not an object', []],
    ['null', null],
    ['missing schemaVersion', { domains: {} }],
    ['future schemaVersion', { schemaVersion: 2, domains: {} }],
    ['string schemaVersion', { schemaVersion: '1', domains: {} }],
    ['domains as list', { schemaVersion: 1, domains: [] }],
    ['the old containers.json shape', { schemaVersion: 1, containers: {} }]
  ])('rejects %s', (_label, raw) => {
    expect(parseCatalogDocument(raw).ok).toBe(false);
  });
});

// domains.schema.json is what the catalog repository's CI runs. It must
// reject everything the app rejects, or CI would pass an entry the app then
// drops. It may be stricter (it rejects unknown fields to catch typos).
describe('domains.schema.json agrees with validateCatalogEntry', () => {
  it('accepts the valid fixtures', () => {
    const ok = ajvValidate(document({ neuroimaging: validEntry() }));
    expect(ajvValidate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it.each(INVALID)('also rejects %s', (_label, field, value) => {
    expect(
      ajvValidate(
        document({ neuroimaging: { ...validEntry(), [field]: value } })
      )
    ).toBe(false);
  });

  it.each(REQUIRED)('also rejects an entry missing %s', field => {
    const entry: Record<string, unknown> = validEntry();
    delete entry[field];
    expect(ajvValidate(document({ neuroimaging: entry }))).toBe(false);
  });

  it('rejects unknown fields, which the app only drops', () => {
    expect(
      ajvValidate(document({ neuroimaging: { ...validEntry(), titel: 'x' } }))
    ).toBe(false);
  });

  it('rejects documents the app rejects', () => {
    expect(ajvValidate({ schemaVersion: 2, domains: {} })).toBe(false);
    expect(ajvValidate({ schemaVersion: 1, domains: [] })).toBe(false);
  });

  it('accepts a domain with no container yet', () => {
    expect(
      ajvValidate({
        schemaVersion: 1,
        domains: {
          microscopy: { source_repositories: ['Example/microcontainers'] }
        }
      })
    ).toBe(true);
  });

  it('rejects a domain with no source repositories', () => {
    expect(
      ajvValidate({
        schemaVersion: 1,
        domains: { neuroimaging: validEntry() }
      })
    ).toBe(false);
  });

  it('uses the same field patterns as the TS validator', () => {
    const tsSource = fs.readFileSync(
      path.join(__dirname, '../config/containerCatalogSchema.ts'),
      'utf8'
    );
    const props = schema.definitions.domain.properties;
    const expectPattern = (constName: string, jsonPattern: string) => {
      const match = new RegExp(`export const ${constName} = /(.*)/;`).exec(
        tsSource
      );
      expect(match).not.toBeNull();
      expect(new RegExp(jsonPattern).source).toBe(
        new RegExp(match[1].replace(/\\\//g, '/')).source
      );
    };
    expectPattern('TITLE_PATTERN', props.title.pattern);
    expectPattern('DESCRIPTION_PATTERN', props.description.pattern);
    expectPattern('REGISTRY_PATTERN', props.registry.pattern);
    expectPattern('TAG_PATTERN', props.defaultVersion.pattern);
    expectPattern('DOCKER_NAME_PATTERN', props.containerName.pattern);
    expectPattern('DOCKER_NAME_PATTERN', props.volumeMount.pattern);
    expectPattern('STORAGE_MOUNT_PATTERN', props.defaultStorageMount.pattern);
    expectPattern('HTTPS_URL_PATTERN', props.releaseHistoryUrl.pattern);
    expectPattern('HTTPS_URL_PATTERN', props.remoteUrl.items.pattern);
    expectPattern('HTTPS_URL_PATTERN', props.appJsonUrl.pattern);
    expectPattern('DOWNLOAD_URL_PATTERN', props.downloadUrls.items.pattern);
    expectPattern('TAG_LABEL_PATTERN', props.tags.items.pattern);
    expectPattern(
      'CONTAINER_ID_PATTERN',
      schema.properties.domains.propertyNames.pattern
    );
  });
});

describe('bundled container configs', () => {
  it('every bundled yml passes the catalog validator', () => {
    const { ContainerCatalog } = require('../config/containerCatalog');
    const bundledDir = path.join(__dirname, '../../../container_installer');
    const ids = fs
      .readdirSync(bundledDir)
      .filter(f => /\.ya?ml$/.test(f))
      .map(f => f.replace(/\.ya?ml$/, ''))
      .sort();
    const catalog = new ContainerCatalog({
      url: '',
      bundledDir,
      appVersion: '999.0.0'
    });
    expect(catalog.getIds()).toEqual(ids);
  });
});
