import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertInside,
  createTrashEntry,
  deleteSessionArtifacts,
  emptyTrash,
  listTrashEntries,
  planSessionArtifacts,
  purgeTrashEntry,
  readTrashEntry,
  readWorkspaceState,
  removeSessionsFromState,
  restoreTrashEntry,
  scanProjectionFiles,
  scanSessionDirs,
} from '../lib/store.js'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'
const PROJECT = '--C-Users-Test-project--'

/** Build a sandbox home with one session, its cache and a workspace record. */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-trash-'))
  const sessionDir = join(home, 'sessions', PROJECT, SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${SESSION_ID}.json`), '{"title":"hello"}')
  await writeFile(join(cacheDir, `${SESSION_ID}.json.bak.1`), '{"title":"hello"}')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: 'ws-1',
        workspaceIds: ['ws-1'],
        archivedSessionIds: [SESSION_ID],
        pinnedSessionIds: [SESSION_ID],
      },
      tables: { workspaces: { 'ws-1': { path: 'C:\\Users\\Test\\project', title: 'project', sessionIds: [SESSION_ID, OTHER_ID], createdAt: '', updatedAt: '' } } },
    }),
  )
  return home
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Run one store test and always clean up the sandbox. */
async function test(name, body) {
  const home = await makeHome()
  try {
    await body(home)
    console.log(`ok - ${name}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('reads the workspace registry', async (home) => {
  const state = await readWorkspaceState(home)
  assert.equal(state.exists, true)
  assert.equal(state.defaultWorkspaceId, 'ws-1')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID])
  assert.deepEqual(state.pinnedSessionIds, [SESSION_ID])
  assert.equal(state.workspaces[0].sessionIds.length, 2)
})

test('plans artifacts for a session', async (home) => {
  const dirs = await scanSessionDirs(home)
  const projections = await scanProjectionFiles(home)
  const plan = await planSessionArtifacts({ home, sessionId: SESSION_ID, dirs, projections })
  assert.equal(plan.entries.length, 3)
  assert.equal(plan.entries.filter((entry) => entry.kind === '会话目录').length, 1)
  assert.equal(plan.entries.filter((entry) => entry.kind === '投影缓存').length, 2)
  assert.ok(plan.bytes > 0)
  assert.deepEqual(plan.projectDirs, [`sessions/${PROJECT}`])
})

test('moves a session into the trash and restores it', async (home) => {
  const dirs = await scanSessionDirs(home)
  const projections = await scanProjectionFiles(home)
  const plan = await planSessionArtifacts({ home, sessionId: SESSION_ID, dirs, projections })
  const before = plan.bytes

  const { entry, errors } = await createTrashEntry(home, {
    sessionId: SESSION_ID,
    title: 'Hello session',
    workspaceId: 'ws-1',
    workspaceTitle: 'project',
    archived: true,
    pinned: true,
    entries: plan.entries,
    projectDirs: plan.projectDirs,
  })
  assert.deepEqual(errors, [])
  assert.equal(entry.sessionId, SESSION_ID)
  assert.equal(entry.files.length, 3)
  assert.equal(entry.bytes, before)

  assert.equal(await exists(join(home, 'sessions', PROJECT, SESSION_ID)), false)
  assert.equal(await exists(join(home, 'sessions', PROJECT)), false, 'empty project dir is pruned')
  assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', `${SESSION_ID}.json`)), false)

  const listed = await listTrashEntries(home)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].entryId, entry.entryId)
  assert.equal(listed[0].title, 'Hello session')
  assert.equal(listed[0].workspaceId, 'ws-1')
  assert.equal((await readTrashEntry(home, entry.entryId)).archived, true)

  const restored = await restoreTrashEntry(home, entry.entryId)
  assert.deepEqual(restored.errors, [])
  assert.equal(restored.restored.length, 3)
  assert.equal(await exists(join(home, 'sessions', PROJECT, SESSION_ID, 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(join(home, 'storages', 'session_projcache', 'sessions', `${SESSION_ID}.json.bak.1`)), true)
  assert.equal((await listTrashEntries(home)).length, 0)
})

test('refuses to overwrite files while restoring', async (home) => {
  const dirs = await scanSessionDirs(home)
  const projections = await scanProjectionFiles(home)
  const plan = await planSessionArtifacts({ home, sessionId: SESSION_ID, dirs, projections })
  const { entry } = await createTrashEntry(home, { sessionId: SESSION_ID, title: 'x', entries: plan.entries, projectDirs: plan.projectDirs })
  const logPath = join(home, 'sessions', PROJECT, SESSION_ID, 'session.v4.jsonl.zstd')
  await mkdir(join(home, 'sessions', PROJECT, SESSION_ID), { recursive: true })
  await writeFile(logPath, 'recreated')

  const restored = await restoreTrashEntry(home, entry.entryId)
  assert.equal(restored.restored.length, 2)
  assert.equal(restored.errors.length, 1)
  assert.match(restored.errors[0].error, /已存在/u)
  assert.equal(await readFile(logPath, 'utf8'), 'recreated')
  assert.equal((await listTrashEntries(home)).length, 1, 'entry stays when a file could not be restored')
})

test('purges one entry and empties the recycle bin', async (home) => {
  const dirs = await scanSessionDirs(home)
  const projections = await scanProjectionFiles(home)
  const plan = await planSessionArtifacts({ home, sessionId: SESSION_ID, dirs, projections })
  const { entry } = await createTrashEntry(home, { sessionId: SESSION_ID, title: 'x', entries: plan.entries, projectDirs: plan.projectDirs })
  const purged = await purgeTrashEntry(home, entry.entryId)
  assert.equal(purged.ok, true)
  assert.equal((await listTrashEntries(home)).length, 0)

  const second = await createTrashEntry(home, { sessionId: SESSION_ID, title: 'y', entries: [], projectDirs: [] })
  assert.equal((await listTrashEntries(home)).length, 1)
  const emptied = await emptyTrash(home)
  assert.equal(emptied.count, 1)
  assert.deepEqual(emptied.errors, [])
  assert.equal((await listTrashEntries(home)).length, 0)
  assert.equal(await exists(join(home, 'storages', 'session-trash', 'entries', second.entry.entryId)), false)
})

test('deletes session artifacts permanently', async (home) => {
  const dirs = await scanSessionDirs(home)
  const projections = await scanProjectionFiles(home)
  const plan = await planSessionArtifacts({ home, sessionId: SESSION_ID, dirs, projections })
  const outcome = await deleteSessionArtifacts(home, plan)
  assert.deepEqual(outcome.errors, [])
  assert.equal(outcome.removed.length, 3)
  assert.equal(outcome.pruned.length, 1)
  assert.equal(await exists(join(home, 'sessions', PROJECT)), false)
})

test('guards path traversal', async (home) => {
  assert.throws(() => assertInside(home, join(home, '..', 'escape')))
  assert.throws(() => assertInside(home, home))
  assert.equal(assertInside(home, join(home, 'sessions')), join(home, 'sessions'))
})

test('detaches sessions from the registry document', async () => {
  const raw = {
    global: { archivedSessionIds: [SESSION_ID], pinnedSessionIds: [SESSION_ID] },
    tables: { workspaces: { 'ws-1': { sessionIds: [SESSION_ID, OTHER_ID] } } },
  }
  const next = removeSessionsFromState(raw, [SESSION_ID])
  assert.deepEqual(next.global.archivedSessionIds, [])
  assert.deepEqual(next.global.pinnedSessionIds, [])
  assert.deepEqual(next.tables.workspaces['ws-1'].sessionIds, [OTHER_ID])
  assert.deepEqual(raw.global.archivedSessionIds, [SESSION_ID], 'input is not mutated')
})
