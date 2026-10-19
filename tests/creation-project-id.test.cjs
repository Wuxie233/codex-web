const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('scratch/asar/.vite/build/main-C5K7o1Hr.js', 'utf8');

const SERVER_PROJECT = '01a0b2b8-1240-7bc3-a7ff-52d2830090d0';
const LEGACY_PROJECT = 'd55ffc44-b6f0-4740-8ab5-714c787ffb35';

function matchProject() {
  const begin = source.indexOf('function codexWebMatchProject(');
  assert.ok(begin >= 0, 'shared project lookup helper is installed');
  const end = source.indexOf('\n      globalThis.__codexThreadCreations.registerAdapter({', begin);
  assert.ok(end > begin, 'helper ends before the creation adapter');
  return new Function(`${source.slice(begin, end)}\nreturn codexWebMatchProject;`)();
}

function legacyProjectIdFor(backend, globalState) {
  const begin = source.indexOf('const legacyProjectIdFor = (projectId) => {');
  assert.ok(begin >= 0, 'creation adapter maps app-server project ids');
  const end = source.indexOf('const project = args.target.type === `project`', begin);
  assert.ok(end > begin, 'mapping ends before project resolution');
  const n = {
    Ai: (value) => value,
    Sc: { APP_SERVER_PROJECT_ID_BY_LEGACY_PROJECT_ID_BY_HOST: 'app-server-project-id-by-legacy-project-id-by-host' },
  };
  const fetch = { globalState: { get: (key) => globalState[key] } };
  const factory = new Function('n', 'fetch', `${source.slice(begin, end)}\nreturn legacyProjectIdFor;`);
  return factory.call({ projectsManager: { projectBackend: backend } }, n, fetch);
}

const localProject = (projectId) => ({
  projectId, projectKind: `local`, hostId: `local`,
  label: projectId, path: `/workspace/${projectId}`, rootPaths: [`/workspace/${projectId}`],
});

test('native app-server project ids resolve to the Desktop projection', () => {
  const resolve = legacyProjectIdFor({
    migrationIdentity: 'local:/root/.codex',
    legacyProjectIdsByServerId: new Map([[SERVER_PROJECT, LEGACY_PROJECT]]),
  }, {});
  const project = matchProject()([localProject(LEGACY_PROJECT)], SERVER_PROJECT, resolve);
  assert.equal(project?.projectId, LEGACY_PROJECT);
});

test('the persisted Desktop migration mapping is used when the cache is not warm', () => {
  const resolve = legacyProjectIdFor({ migrationIdentity: 'local:/root/.codex' }, {
    'app-server-project-id-by-legacy-project-id-by-host': {
      'local:/root/.codex': { [LEGACY_PROJECT]: SERVER_PROJECT },
    },
  });
  assert.equal(resolve(SERVER_PROJECT), LEGACY_PROJECT);
});

test('projects created after the migration keep their shared id', () => {
  const mine = localProject(SERVER_PROJECT);
  const project = matchProject()([mine], SERVER_PROJECT, () => {
    throw new Error('resolver must not run for a direct match');
  });
  assert.equal(project, mine);
});

test('legacy ids still resolve unchanged', () => {
  const mine = localProject(LEGACY_PROJECT);
  const project = matchProject()([mine], LEGACY_PROJECT, () => LEGACY_PROJECT);
  assert.equal(project, mine);
});

test('unknown project ids stay unknown', () => {
  const resolve = legacyProjectIdFor({ migrationIdentity: 'local:/root/.codex' }, {});
  assert.equal(resolve('01a99999-0000-7000-8000-000000000000'), null);
  assert.equal(matchProject()([localProject(LEGACY_PROJECT)],
    '01a99999-0000-7000-8000-000000000000', resolve), null);
});

test('a mapped id without a projected entry is not silently reused', () => {
  const other = '11111111-2222-4333-8444-555555555555';
  const resolve = () => other;
  assert.equal(matchProject()([localProject(LEGACY_PROJECT)], SERVER_PROJECT, resolve), null);
});

test('a failing resolver cannot match the wrong project', () => {
  assert.equal(matchProject()([localProject(LEGACY_PROJECT)], SERVER_PROJECT, () => {
    throw new Error('desktop state unavailable');
  }), null);
});

test('creation resolves project targets through both identities', () => {
  assert.match(source,
    /codexWebMatchProject\(projects\(\), args\.target\.projectId, legacyProjectIdFor\)/);
});
