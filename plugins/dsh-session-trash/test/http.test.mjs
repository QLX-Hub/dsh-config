import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

const SESSION_ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const OTHER_ID = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const LIVE_ID = 'session-cccccccc-1111-2222-3333-444444444444'
const CHILD_ID = 'session-dddddddd-1111-2222-3333-444444444444'
const PROJECT = '--C-Users-Test-project--'
const PORT = '50333'

/** Write one session directory and projection record. */
async function seedSession(home, sessionId) {
  const dir = join(home, 'sessions', PROJECT, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), `log-${sessionId}`)
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${sessionId}.json`), '{"title":"x"}')
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** A fake workspace registry that records every call. */
function makeRegistry({ sessions }) {
  const calls = { detach: [], attach: [], archive: [], unarchive: [], pin: [], unpin: [], stop: [] }
  const workspaces = [
    {
      id: 'ws-1',
      title: 'project',
      path: 'C:\\Users\\Test\\project',
      sessionIds: new Set(sessions),
      async detachSession(id) {
        calls.detach.push(id)
        this.sessionIds.delete(id)
      },
      async attachSession(id) {
        calls.attach.push(id)
        this.sessionIds.add(id)
      },
    },
  ]
  return {
    calls,
    workspaces,
    async list() {
      return workspaces
    },
    async archiveSession(id, options) {
      calls.archive.push([id, options])
      if (options?.stopActivity === true) calls.stop.push(id)
    },
    async unarchiveSession(id) {
      calls.unarchive.push(id)
    },
    async pinSession(id) {
      calls.pin.push(id)
    },
    async unpinSession(id) {
      calls.unpin.push(id)
    },
  }
}

/** A fake Cordis context with one captured web route. */
function makeCtx({ registry, liveIds = [], subagents = [] }) {
  const events = []
  const effects = []
  const routes = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get(key) {
      if (key === 'workspaceRegistry') return registry
      if (key === 'sessions') return { list: () => liveIds.map((id) => ({ id })) }
      if (key === 'sessionQuery') {
        return {
          async listSessions() {
            return subagents.map((item) => ({ header: { id: item.id, origin: 'subagent', parentSession: item.parent } }))
          },
        }
      }
      return null
    },
    emit(type, id) {
      events.push([type, id])
    },
  }
  return { ctx, routes, events }
}

/** Invoke one captured route with a fake HTTP request. */
async function call(route, { method = 'GET', path, body, remoteAddress = '127.0.0.1', origin } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')])
  req.method = method
  req.url = path
  const headers = { host: `127.0.0.1:${PORT}` }
  if (origin !== undefined) headers.origin = origin
  req.headers = headers
  req.socket = { remoteAddress }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      this.body = String(value ?? '')
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

/** Build the sandbox home, registry, context and route. */
async function makeWorld({ liveIds = [], subagents = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-trash-http-'))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: 'ws-1',
        workspaceIds: ['ws-1'],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: { workspaces: { 'ws-1': { path: 'C:\\Users\\Test\\project', title: 'project', sessionIds: [SESSION_ID, OTHER_ID, LIVE_ID] } } },
    }),
  )
  await seedSession(home, SESSION_ID)
  await seedSession(home, OTHER_ID)
  await seedSession(home, LIVE_ID)
  for (const item of subagents) await seedSession(home, item.id)
  const registry = makeRegistry({ sessions: [SESSION_ID, OTHER_ID, LIVE_ID] })
  const world = makeCtx({ registry, liveIds, subagents })
  apply(world.ctx, { dshHome: home })
  return { home, registry, ...world, route: world.routes[0] }
}

async function test(name, body, options) {
  const world = await makeWorld(options)
  try {
    await body(world)
    console.log(`ok - ${name}`)
  } finally {
    await rm(world.home, { recursive: true, force: true })
  }
}

await test('health answers', async ({ route, home }) => {
  const response = await call(route, { path: '/api/session-trash/health' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.plugin, 'session-trash')
  assert.equal(response.json.home, home)
})

await test('moves a session to the trash, lists it and restores it', async ({ route, home, registry, events }) => {
  const trashed = await call(route, {
    method: 'POST',
    path: '/api/session-trash/trash',
    body: { sessionIds: [SESSION_ID], titles: { [SESSION_ID]: 'My session' } },
  })
  assert.equal(trashed.status, 200)
  assert.equal(trashed.json.ok, true)
  assert.equal(trashed.json.moved.length, 1)
  assert.deepEqual(registry.calls.detach, [SESSION_ID])
  assert.equal(await exists(join(home, 'sessions', PROJECT, SESSION_ID)), false)
  assert.deepEqual(events.at(-1), ['api-session/removed', SESSION_ID])

  const listed = await call(route, { path: '/api/session-trash/list' })
  assert.equal(listed.json.entries.length, 1)
  assert.equal(listed.json.entries[0].title, 'My session')
  assert.equal(listed.json.totals.entries, 1)
  assert.ok(listed.json.totals.bytes > 0)

  const entryId = listed.json.entries[0].entryId
  const restored = await call(route, { method: 'POST', path: '/api/session-trash/restore', body: { entryIds: [entryId] } })
  assert.equal(restored.json.ok, true)
  assert.equal(restored.json.restored.length, 1)
  assert.equal(await exists(join(home, 'sessions', PROJECT, SESSION_ID, 'session.v4.jsonl.zstd')), true)
  assert.deepEqual(registry.calls.attach, [SESSION_ID])
  const listedAfter = await call(route, { path: '/api/session-trash/list' })
  assert.equal(listedAfter.json.entries.length, 0)
})

await test('purges trash entries and empties the bin', async ({ route, home }) => {
  await call(route, { method: 'POST', path: '/api/session-trash/trash', body: { sessionIds: [SESSION_ID, OTHER_ID] } })
  const listed = await call(route, { path: '/api/session-trash/list' })
  assert.equal(listed.json.entries.length, 2)
  const entryId = listed.json.entries[0].entryId
  const purged = await call(route, { method: 'POST', path: '/api/session-trash/purge', body: { entryIds: [entryId] } })
  assert.equal(purged.json.purged.length, 1)
  assert.equal((await call(route, { path: '/api/session-trash/list' })).json.entries.length, 1)

  const emptied = await call(route, { method: 'POST', path: '/api/session-trash/empty', body: {} })
  assert.equal(emptied.json.ok, true)
  assert.equal(emptied.json.count, 1)
  assert.equal((await call(route, { path: '/api/session-trash/list' })).json.entries.length, 0)
  assert.equal(await exists(join(home, 'storages', 'session-trash', 'entries')), false)
})

await test('permanently deletes a session from disk', async ({ route, home, registry, events }) => {
  const response = await call(route, {
    method: 'POST',
    path: '/api/session-trash/delete',
    body: { sessionIds: [OTHER_ID], titles: { [OTHER_ID]: 'Other' } },
  })
  assert.equal(response.json.ok, true)
  assert.equal(response.json.deleted.length, 1)
  assert.equal(await exists(join(home, 'sessions', PROJECT, OTHER_ID)), false)
  assert.deepEqual(registry.calls.detach, [OTHER_ID])
  assert.deepEqual(events.at(-1), ['api-session/removed', OTHER_ID])
})

await test('refuses a live session without force, then stops it on force', async ({ route, home, registry }) => {  const refused = await call(route, {
    method: 'POST',
    path: '/api/session-trash/trash',
    body: { sessionIds: [LIVE_ID], titles: { [LIVE_ID]: 'Live' } },
  })
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.failures[0].needsForce, true)
  assert.equal(await exists(join(home, 'sessions', PROJECT, LIVE_ID)), true)

  const forced = await call(route, {
    method: 'POST',
    path: '/api/session-trash/trash',
    body: { sessionIds: [LIVE_ID], force: true },
  })
  assert.equal(forced.json.ok, true)
  assert.deepEqual(registry.calls.stop, [LIVE_ID])
  assert.equal(await exists(join(home, 'sessions', PROJECT, LIVE_ID)), false)
}, { liveIds: [LIVE_ID] })

await await test('moves sub-agent sessions together with their parent', async ({ route, home, events }) => {
  const trashed = await call(route, {
    method: 'POST',
    path: '/api/session-trash/trash',
    body: { sessionIds: [SESSION_ID], titles: { [SESSION_ID]: 'Parent' } },
  })
  assert.equal(trashed.json.ok, true)
  assert.equal(trashed.json.moved[0].sessionIds, 2)
  assert.equal(await exists(join(home, 'sessions', PROJECT, CHILD_ID)), false)
  assert.deepEqual(events.slice(-2), [
    ['api-session/removed', SESSION_ID],
    ['api-session/removed', CHILD_ID],
  ])

  const listed = await call(route, { path: '/api/session-trash/list' })
  assert.equal(listed.json.entries[0].sessionIds.length, 2)
  const restored = await call(route, { method: 'POST', path: '/api/session-trash/restore', body: { entryIds: [listed.json.entries[0].entryId] } })
  assert.equal(restored.json.restored.length, 1)
  assert.equal(await exists(join(home, 'sessions', PROJECT, CHILD_ID, 'session.v4.jsonl.zstd')), true)
}, { subagents: [{ id: CHILD_ID, parent: SESSION_ID }] })

test('rejects cross-origin and non-loopback callers', async ({ route }) => {
  const foreign = await call(route, { path: '/api/session-trash/health', remoteAddress: '8.8.8.8' })
  assert.equal(foreign.status, 403)
  const crossOrigin = await call(route, { path: '/api/session-trash/health', origin: 'https://evil.example' })
  assert.equal(crossOrigin.status, 403)
})

await test('rejects invalid request bodies', async ({ route }) => {
  const empty = await call(route, { method: 'POST', path: '/api/session-trash/trash', body: { sessionIds: [] } })
  assert.equal(empty.status, 400)
  const unsafe = await call(route, { method: 'POST', path: '/api/session-trash/trash', body: { sessionIds: ['../escape'] } })
  assert.equal(unsafe.status, 400)
})
