import { describe, expect, it } from 'vitest';
import {
  canonicalizePackageName,
  parseDependencyLockfile,
  supportsDependencyHealth,
} from '../../adapters/dep-doctor-lockfiles.js';

function packages(content: string, filename: string) {
  const result = parseDependencyLockfile(content, filename);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.packages;
}

describe('Dep Doctor lockfile parsing', () => {
  it('recognizes health-capable formats but excludes go.sum', () => {
    expect(supportsDependencyHealth('pnpm-lock.yaml')).toBe(true);
    expect(supportsDependencyHealth('uv.lock')).toBe(true);
    expect(supportsDependencyHealth('go.sum')).toBe(false);
  });

  it('canonicalizes npm and PyPI names appropriately', () => {
    expect(canonicalizePackageName('npm', '@Scope/Package')).toBe('@scope/package');
    expect(canonicalizePackageName('PyPI', 'Foo_Bar.baz')).toBe('foo-bar-baz');
  });

  describe('package-lock.json', () => {
    it('parses nested v3 packages, actual alias names, and source lines', () => {
      const content = JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/alias': { name: 'real-package', version: '2.0.0' },
          'node_modules/parent/node_modules/child': { version: '3.0.0' },
          'node_modules/local': { version: 'file:../local', resolved: 'file:../local' },
        },
      }, null, 2);

      expect(packages(content, 'package-lock.json')).toEqual([
        expect.objectContaining({ name: 'real-package', version: '2.0.0', line: 9 }),
        expect.objectContaining({ name: 'child', version: '3.0.0', line: 13 }),
      ]);
    });

    it('recurses through v1 dependencies and deduplicates package pairs', () => {
      const content = JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          parent: {
            version: '1.0.0',
            dependencies: { child: { version: '2.0.0' } },
          },
          child: { version: '2.0.0' },
        },
      }, null, 2);
      expect(packages(content, 'package-lock.json').map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
        'parent@1.0.0',
        'child@2.0.0',
      ]);
    });

    it('rejects malformed and unsupported package locks', () => {
      expect(parseDependencyLockfile('{', 'package-lock.json')).toMatchObject({ ok: false, reason: 'lockfile-parse-failed' });
      expect(parseDependencyLockfile('{"lockfileVersion":4,"packages":{}}', 'package-lock.json'))
        .toMatchObject({ ok: false, reason: 'lockfile-version-unsupported' });
    });

    it('excludes package locks resolved from lookalike or private registry hosts', () => {
      const content = JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/lookalike': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org.corp.example/lookalike/-/lookalike-1.0.0.tgz',
          },
          'node_modules/private': {
            version: '1.0.0',
            resolved: 'https://packages.example.test/private/-/private-1.0.0.tgz',
          },
        },
      });
      expect(packages(content, 'package-lock.json')).toEqual([]);
    });
  });

  describe('yarn.lock', () => {
    it('parses Yarn Classic grouped and scoped descriptors', () => {
      const content = [
        '# yarn lockfile v1',
        '',
        'lodash@^4.17.20, lodash@^4.17.21:',
        '  version "4.17.21"',
        '',
        '"@scope/pkg@^1.0.0":',
        '  version "1.2.3"',
      ].join('\n');
      expect(packages(content, 'yarn.lock')).toEqual([
        expect.objectContaining({ name: 'lodash', version: '4.17.21', line: 3 }),
        expect.objectContaining({ name: '@scope/pkg', version: '1.2.3', line: 6 }),
      ]);
    });

    it('parses Yarn Berry npm resolutions and excludes workspaces', () => {
      const content = [
        '__metadata:',
        '  version: 8',
        '  cacheKey: 10c0',
        '',
        '"lodash@npm:^4.17.21":',
        '  version: 4.17.21',
        '  resolution: "lodash@npm:4.17.21"',
        '',
        '"fixture@workspace:.":',
        '  version: 0.0.0-use.local',
        '  resolution: "fixture@workspace:."',
      ].join('\n');
      expect(packages(content, 'yarn.lock')).toEqual([
        expect.objectContaining({ name: 'lodash', version: '4.17.21', line: 5 }),
      ]);
    });

    it('rejects malformed Yarn entries', () => {
      expect(parseDependencyLockfile('lodash@^4:\n  resolved "x"\n', 'yarn.lock'))
        .toMatchObject({ ok: false, reason: 'lockfile-parse-failed' });
      expect(parseDependencyLockfile('__metadata:\n  cacheKey: x\n', 'yarn.lock'))
        .toMatchObject({ ok: false, reason: 'lockfile-version-unsupported' });
    });

    it('excludes Yarn Classic Git and private-registry resolutions', () => {
      const content = [
        'git-package@git+https://github.com/example/package.git:',
        '  version "1.0.0"',
        '  resolved "git+https://github.com/example/package.git#abc"',
        '',
        'private-package@^1.0.0:',
        '  version "1.0.0"',
        '  resolved "https://registry.example.test/private-package/-/private-package-1.0.0.tgz"',
      ].join('\n');
      expect(packages(content, 'yarn.lock')).toEqual([]);
    });

    it('attributes Yarn Classic npm aliases to the resolved package', () => {
      const content = [
        'string-width-cjs@npm:string-width@^4.2.0:',
        '  version "4.2.3"',
        '  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz"',
      ].join('\n');
      expect(packages(content, 'yarn.lock')).toEqual([
        expect.objectContaining({ name: 'string-width', version: '4.2.3' }),
      ]);
    });
  });

  describe('pnpm-lock.yaml', () => {
    it.each([6, 9])('accepts numeric pnpm lockfileVersion %s.0', version => {
      expect(packages(`lockfileVersion: ${version}.0\npackages:\n  lodash@4.17.21: {}\n`, 'pnpm-lock.yaml'))
        .toEqual([expect.objectContaining({ name: 'lodash', version: '4.17.21' })]);
    });

    it.each([
      ['5.4', '/lodash/4.17.21', 'lodash', '4.17.21'],
      ['6.0', '/@scope/pkg@1.2.3(peer@2.0.0)', '@scope/pkg', '1.2.3'],
      ['9.0', 'lodash@4.17.21', 'lodash', '4.17.21'],
    ])('parses pnpm lock version %s', (version, key, name, resolvedVersion) => {
      const content = [
        `lockfileVersion: '${version}'`,
        '',
        'packages:',
        `  '${key}':`,
        '    resolution: {integrity: sha512-test}',
      ].join('\n');
      expect(packages(content, 'pnpm-lock.yaml')).toEqual([
        expect.objectContaining({ name, version: resolvedVersion, line: 4 }),
      ]);
    });

    it('unions multiple documents and deduplicates package pairs', () => {
      const content = [
        "lockfileVersion: '9.0'",
        'packages:',
        "  'first@1.0.0': {}",
        '---',
        "lockfileVersion: '9.0'",
        'packages:',
        "  'first@1.0.0': {}",
        "  'second@2.0.0': {}",
      ].join('\n');
      expect(packages(content, 'pnpm-lock.yaml').map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
        'first@1.0.0',
        'second@2.0.0',
      ]);
    });

    it('decodes public registry-qualified IDs and excludes private registries', () => {
      const content = [
        "lockfileVersion: '5.4'",
        'packages:',
        "  '/registry.npmjs.org/public-package/1.0.0': {}",
        "  '/registry.npmjs.org/@scope/public-package/2.0.0': {}",
        "  '/registry.example.test/private-package/3.0.0': {}",
      ].join('\n');
      expect(packages(content, 'pnpm-lock.yaml').map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
        'public-package@1.0.0',
        '@scope/public-package@2.0.0',
      ]);
    });

    it('excludes pnpm packages with explicit private tarball resolutions', () => {
      const content = [
        "lockfileVersion: '9.0'",
        'packages:',
        '  public-package@1.0.0:',
        '    resolution: {tarball: https://registry.npmjs.org/public-package/-/public-package-1.0.0.tgz}',
        '  private-package@1.0.0:',
        '    resolution: {tarball: https://packages.example.test/private-package-1.0.0.tgz}',
      ].join('\n');
      expect(packages(content, 'pnpm-lock.yaml').map(pkg => pkg.name)).toEqual(['public-package']);
    });

    it('rejects malformed YAML and unknown versions', () => {
      expect(parseDependencyLockfile("lockfileVersion: '9.0'\npackages: [", 'pnpm-lock.yaml'))
        .toMatchObject({ ok: false, reason: 'lockfile-parse-failed' });
      expect(parseDependencyLockfile("lockfileVersion: '10.0'\npackages: {}", 'pnpm-lock.yaml'))
        .toMatchObject({ ok: false, reason: 'lockfile-version-unsupported' });
    });
  });

  describe('Python lockfiles', () => {
    it('parses pinned requirements with extras, spacing, markers, and normalized names', () => {
      const content = [
        'Foo_Bar[security] == 1.2.3 ; python_version >= "3.11"',
        'foo-bar==1.2.3',
        'unpinned>=2',
        '-e ../local',
      ].join('\n');
      expect(packages(content, 'requirements.txt')).toEqual([
        expect.objectContaining({ name: 'Foo_Bar', canonicalName: 'foo-bar', version: '1.2.3', line: 1 }),
      ]);
    });

    it('supports inline comments but excludes requirements using private source directives', () => {
      expect(packages('requests==2.32.0  # pinned\n', 'requirements.txt')).toEqual([
        expect.objectContaining({ name: 'requests', version: '2.32.0' }),
      ]);
      expect(packages('--index-url https://packages.example.test/simple\ninternal==1.0.0\n', 'requirements.txt')).toEqual([]);
      expect(packages('--extra-index-url=https://packages.example.test/simple\nrequests==2.32.0\n', 'requirements.txt')).toEqual([]);
    });

    it('parses all Pipfile categories and excludes private or path dependencies', () => {
      const content = JSON.stringify({
        _meta: {
          'pipfile-spec': 6,
          sources: [
            { name: 'pypi', url: 'https://pypi.org/simple' },
            { name: 'private', url: 'https://packages.example.test/simple' },
          ],
        },
        default: {
          requests: { version: '==2.32.0', index: 'pypi' },
          internal: { version: '==1.0.0', index: 'private' },
        },
        develop: { pytest: { version: '==8.0.0' } },
        docs: { local: { path: '../local', version: '==1.0.0' } },
      }, null, 2);
      expect(packages(content, 'Pipfile.lock').map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
        'requests@2.32.0',
        'pytest@8.0.0',
      ]);
    });

    it('excludes indexless Pipfile packages when the default source is private', () => {
      const content = JSON.stringify({
        _meta: {
          'pipfile-spec': 6,
          sources: [
            { name: 'private', url: 'https://packages.example.test/simple' },
            { name: 'pypi', url: 'https://pypi.org/simple' },
          ],
        },
        default: {
          internal: { version: '==1.0.0' },
          requests: { version: '==2.32.0', index: 'pypi' },
        },
      });
      expect(packages(content, 'Pipfile.lock').map(pkg => pkg.name)).toEqual(['requests']);
    });

    it('parses Poetry packages and excludes explicit sources', () => {
      const content = [
        '[[package]]',
        'name = "requests"',
        'version = "2.32.0"',
        '',
        '[[package]]',
        'name = "internal"',
        'version = "1.0.0"',
        'source = { type = "legacy", url = "https://private.example/simple" }',
        '',
        '[metadata]',
        'lock-version = "2.1"',
      ].join('\n');
      expect(packages(content, 'poetry.lock')).toEqual([
        expect.objectContaining({ name: 'requests', version: '2.32.0', line: 2 }),
      ]);
    });

    it('parses uv registry packages and excludes virtual, Git, and private sources', () => {
      const content = [
        'version = 1',
        'revision = 3',
        '',
        '[[package]]',
        'name = "requests"',
        'version = "2.32.0"',
        'source = { registry = "https://pypi.org/simple" }',
        '',
        '[[package]]',
        'name = "workspace"',
        'version = "0.1.0"',
        'source = { virtual = "." }',
        '',
        '[[package]]',
        'name = "private"',
        'version = "1.0.0"',
        'source = { registry = "https://private.example/simple" }',
      ].join('\n');
      expect(packages(content, 'uv.lock')).toEqual([
        expect.objectContaining({ name: 'requests', version: '2.32.0', line: 5 }),
      ]);
    });

    it.each([
      ['Pipfile.lock', '{"_meta":{"pipfile-spec":7}}'],
      ['poetry.lock', '[metadata]\nlock-version = "3.0"\npackage = []'],
      ['uv.lock', 'version = 2\npackage = []'],
    ])('rejects unsupported %s versions', (filename, content) => {
      expect(parseDependencyLockfile(content, filename))
        .toMatchObject({ ok: false, reason: 'lockfile-version-unsupported' });
    });

    it.each([
      ['Pipfile.lock', '{'],
      ['poetry.lock', '[[package]\nname = "broken"'],
      ['uv.lock', 'version = 1\n[[package]\nname = "broken"'],
    ])('rejects malformed %s content', (filename, content) => {
      expect(parseDependencyLockfile(content, filename))
        .toMatchObject({ ok: false, reason: 'lockfile-parse-failed' });
    });
  });
});
