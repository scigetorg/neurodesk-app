import { toInlineScriptJson, toMiniApp } from '../welcomeview/miniapps';

const entry = {
  title: 'neurodesk',
  description: 'Neuroimaging tools.',
  registry: 'docker.io/vnmd/neurodesktop',
  defaultVersion: '2026-09-23',
  containerName: 'neurodeskapp',
  volumeMount: 'neurodesk-home',
  defaultStorageMount: 'neurodesktop-storage'
};

describe('toMiniApp', () => {
  it('launches by catalog ID and keeps the title-based telemetry ID', () => {
    const app = toMiniApp('neurodesk', entry);
    expect(app.id).toBe('neurodesk');
    expect(app.telemetryId).toBe('neurodesk');
  });

  it('gives a telemetry ID the telemetry filter accepts', () => {
    const app = toMiniApp('x', { ...entry, title: 'Micro Scope (v2.1)' });
    expect(app.telemetryId).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it('defaults remoteUrl to an empty list and omits absent options', () => {
    const app = toMiniApp('neurodesk', entry);
    expect(app.remoteUrl).toEqual([]);
    expect(app).not.toHaveProperty('releaseHistoryUrl');
    expect(app).not.toHaveProperty('tags');
  });
});

describe('toInlineScriptJson', () => {
  const tricky = {
    a: '</script><script>alert(1)</script>',
    b: '<!-- x -->',
    c: 'a & b',
    d: 'line\u2028sep\u2029par'
  };

  it('cannot close the script element or open a comment', () => {
    const json = toInlineScriptJson(tricky);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
  });

  it('round-trips to the same value', () => {
    expect(JSON.parse(toInlineScriptJson(tricky))).toEqual(tricky);
  });
});
