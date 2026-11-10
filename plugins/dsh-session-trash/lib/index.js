/**
 * @module dsh-session-trash
 *
 * Host half: moves conversations into a recycle bin, restores them, and
 * permanently deletes conversations (either from the sidebar or from the bin).
 *
 * HTTP surface (loopback + same-origin only, see `trusted`):
 *   GET  /api/session-trash/health
 *   GET  /api/session-trash/list
 *   POST /api/session-trash/trash   { sessionIds, titles?, force? }
 *   POST /api/session-trash/delete  { sessionIds, titles?, force? }
 *   POST /api/session-trash/restore { entryIds }
 *   POST /api/session-trash/purge   { entryIds }
 *   POST /api/session-trash/empty
 *
 * Deletion order matters: detach the conversation from every workspace first,
 * then move or remove its artifacts, then tell the running Client that the
 * conversation left the Host catalog (`api-session/removed`).
 *
 * A conversation that still has a running Host session is refused unless the
 * caller retries with `force: true`; the force path stops the work the same way
 * the sidebar's archive-with-stop does.
 */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'

/** Loader entry id used by cordis.patch.yml. */
export const name = 'session-trash'
/** The only Host service this plugin needs eagerly. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/api/session-trash'
const VERSION = '0.1.0'
const BUILD = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString()
  } catch {
    return 'unknown'
  }
})()
const MAX_BODY_BYTES = 1024 * 1024
const MAX_IDS = 5000

/**
 * Register the HTTP routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{dshHome?: string}} [config] - optional Config.
 */
export function apply(ctx, config = {}) {
  const options = { dshHome: typeof config.dshHome === 'string' ? config.dshHome : undefined }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) =>
          route(ctx, options, req, res).catch((error) => {
            try {
              sendJson(res, Number.isInteger(error?.status) ? error.status : 500, { ok: false, error: messageOf(error) })
            } catch {
              /* response already gone */
            }
          }),
      }),
    'session-trash: /api/session-trash',
  )
}

export default { name, inject, apply }

/**
 * Dispatch one request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{dshHome?: string}} options - normalized Config.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function route(ctx, options, req, res) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机同源界面调用该接口' })
    return
  }
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    sendJson(res, 400, { ok: false, error: '无法解析请求地址' })
    return
  }
  const suffix = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '') || '/'
  const method = (req.method ?? 'GET').toUpperCase()
  const home = store.resolveDshHome(options.dshHome)

  if (suffix === '/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, plugin: name, version: VERSION, build: BUILD, home })
    return
  }

  if (suffix === '/list' && method === 'GET') {
    const entries = await store.listTrashEntries(home)
    sendJson(res, 200, {
      ok: true,
      home,
      entries,
      totals: { entries: entries.length, bytes: entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0) },
    })
    return
  }

  if (suffix === '/trash' && method === 'POST') {
    const body = await readJsonBody(req)
    const ids = requireIds(body, 'sessionIds')
    const payload = await trashSessions(ctx, home, ids, body.titles ?? {}, body.force === true)
    sendJson(res, 200, { ok: payload.failures.length === 0, ...payload })
    return
  }

  if (suffix === '/delete' && method === 'POST') {
    const body = await readJsonBody(req)
    const ids = requireIds(body, 'sessionIds')
    const payload = await deleteSessions(ctx, home, ids, body.titles ?? {}, body.force === true)
    sendJson(res, 200, { ok: payload.failures.length === 0, ...payload })
    return
  }

  if (suffix === '/restore' && method === 'POST') {
    const body = await readJsonBody(req)
    const ids = requireIds(body, 'entryIds')
    const payload = await restoreEntries(ctx, home, ids)
    sendJson(res, 200, { ok: payload.failures.length === 0, ...payload })
    return
  }

  if (suffix === '/purge' && method === 'POST') {
    const body = await readJsonBody(req)
    const ids = requireIds(body, 'entryIds')
    const payload = await purgeEntries(home, ids)
    sendJson(res, 200, { ok: payload.failures.length === 0, ...payload })
    return
  }

  if (suffix === '/empty' && method === 'POST') {
    const payload = await store.emptyTrash(home)
    sendJson(res, 200, { ok: payload.errors.length === 0, ...payload })
    return
  }

  sendJson(res, 404, { ok: false, error: `未知接口：${method} ${suffix}` })
}

/* -------------------------------------------------------------------- trash */

/**
 * Move conversations into the recycle bin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} home - DSH home directory.
 * @param {string[]} sessionIds - conversations to move.
 * @param {Record<string, string>} titles - display titles supplied by the menu.
 * @param {boolean} force - also move conversations that are currently running.
 * @returns {Promise<{moved: Array<object>, failures: Array<object>, warnings: string[]}>}
 */
async function trashSessions(ctx, home, sessionIds, titles, force) {
  const moved = []
  const failures = []
  const warnings = []
  const dirs = await store.scanSessionDirs(home)
  const projections = await store.scanProjectionFiles(home)
  const state = await store.readWorkspaceState(home)
  const live = liveSessionIds(ctx)
  const handled = new Set()

  for (const id of sessionIds) {
    if (handled.has(id)) continue
    const subtreeIds = [...(await collectSubagentIds(ctx, id))]
    for (const nodeId of subtreeIds) handled.add(nodeId)
    const title = displayTitle(titles, id, { sessionId: id })
    const plans = []
    for (const nodeId of subtreeIds) plans.push(await store.planSessionArtifacts({ home, sessionId: nodeId, dirs, projections }))
    const entries = plans.flatMap((plan) => plan.entries)
    const projectDirs = [...new Set(plans.flatMap((plan) => plan.projectDirs))]
    if (entries.length === 0) {
      failures.push({ id, title, error: '会话记录已不在磁盘上（可能已被删除）' })
      continue
    }
    const running = subtreeIds.filter((nodeId) => live.has(nodeId))
    if (running.length > 0 && !force) {
      failures.push({
        id,
        title,
        error: running.length > 1 ? `该会话及其 ${running.length - 1} 个子 agent 会话正在运行，需要先确认停止并删除` : '该会话正在运行，需要先确认停止并删除',
        needsForce: true,
      })
      continue
    }
    if (running.length > 0) {
      for (const nodeId of running) await stopLiveSession(ctx, nodeId)
      warnings.push('已尝试停止仍在运行的会话。')
    }
    const ownership = findWorkspace(state, id)
    const detach = await detachSessions(ctx, home, subtreeIds)
    if (!detach.ok) {
      failures.push({ id, title, error: detach.errors.join('; ') })
      continue
    }
    let outcome
    try {
      outcome = await store.createTrashEntry(home, {
        sessionId: id,
        sessionIds: subtreeIds,
        title,
        workspaceId: ownership?.id ?? '',
        workspaceTitle: ownership?.title ?? '',
        archived: state.archivedSessionIds.includes(id),
        pinned: state.pinnedSessionIds.includes(id),
        entries,
        projectDirs,
      })
    } catch (error) {
      await attachSession(ctx, home, id, ownership?.id)
      failures.push({ id, title, error: `移入回收站失败：${messageOf(error)}` })
      continue
    }
    if (outcome.entry.files.length === 0) {
      await attachSession(ctx, home, id, ownership?.id)
      failures.push({ id, title, errors: outcome.errors.map((item) => `${item.rel}: ${item.error}`) })
      continue
    }
    if (outcome.errors.length > 0) {
      warnings.push(`「${title || id}」有 ${outcome.errors.length} 个文件未能移入回收站，已跳过。`)
    }
    notifySessionsRemoved(ctx, subtreeIds)
    moved.push({
      entryId: outcome.entry.entryId,
      sessionId: id,
      sessionIds: subtreeIds.length,
      title,
      bytes: outcome.entry.bytes,
      files: outcome.entry.files.length,
    })
  }
  return { moved, failures, warnings }
}

/* ------------------------------------------------------------- permanent delete */

/**
 * Permanently delete conversations from disk (no recycle bin).
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} home - DSH home directory.
 * @param {string[]} sessionIds - conversations to delete.
 * @param {Record<string, string>} titles - display titles supplied by the menu.
 * @param {boolean} force - also delete conversations that are currently running.
 * @returns {Promise<{deleted: Array<object>, failures: Array<object>, warnings: string[]}>}
 */
async function deleteSessions(ctx, home, sessionIds, titles, force) {
  const deleted = []
  const failures = []
  const warnings = []
  const dirs = await store.scanSessionDirs(home)
  const projections = await store.scanProjectionFiles(home)
  const live = liveSessionIds(ctx)
  const handled = new Set()

  for (const id of sessionIds) {
    if (handled.has(id)) continue
    const subtreeIds = [...(await collectSubagentIds(ctx, id))]
    for (const nodeId of subtreeIds) handled.add(nodeId)
    const title = displayTitle(titles, id, { sessionId: id })
    const plans = []
    for (const nodeId of subtreeIds) plans.push(await store.planSessionArtifacts({ home, sessionId: nodeId, dirs, projections }))
    const entries = plans.flatMap((plan) => plan.entries)
    if (entries.length === 0) {
      failures.push({ id, title, error: '会话记录已不在磁盘上（可能已被删除）' })
      continue
    }
    const running = subtreeIds.filter((nodeId) => live.has(nodeId))
    if (running.length > 0 && !force) {
      failures.push({
        id,
        title,
        error: running.length > 1 ? `该会话及其 ${running.length - 1} 个子 agent 会话正在运行，需要先确认停止并删除` : '该会话正在运行，需要先确认停止并删除',
        needsForce: true,
      })
      continue
    }
    if (running.length > 0) {
      for (const nodeId of running) await stopLiveSession(ctx, nodeId)
      warnings.push('已尝试停止仍在运行的会话。')
    }
    const detach = await detachSessions(ctx, home, subtreeIds)
    const errors = []
    let bytes = 0
    for (const plan of plans) {
      const outcome = await store.deleteSessionArtifacts(home, plan)
      bytes += outcome.bytes
      for (const item of outcome.errors) errors.push(`${item.rel}: ${item.error}`)
    }
    notifySessionsRemoved(ctx, subtreeIds)
    const ok = errors.length === 0 && detach.ok
    const entry = {
      id,
      title,
      sessionIds: subtreeIds.length,
      ok,
      bytes,
      errors: [...errors, ...detach.errors],
    }
    if (ok) deleted.push(entry)
    else failures.push(entry)
  }
  return { deleted, failures, warnings }
}

/* ------------------------------------------------------------------ restore */

/**
 * Restore recycle-bin entries and re-attach them to their original workspace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} home - DSH home directory.
 * @param {string[]} entryIds - recycle-bin entries to restore.
 * @returns {Promise<{restored: Array<object>, failures: Array<object>, warnings: string[]}>}
 */
async function restoreEntries(ctx, home, entryIds) {
  const restored = []
  const failures = []
  const warnings = []
  for (const entryId of entryIds) {
    const outcome = await store.restoreTrashEntry(home, entryId)
    if (outcome.meta === undefined) {
      failures.push({ entryId, error: '回收站中找不到该条目（可能已被清空）' })
      continue
    }
    const meta = outcome.meta
    if (outcome.restored.length === 0) {
      failures.push({ entryId, id: meta.sessionId, title: meta.title, errors: outcome.errors.map((item) => `${item.rel}: ${item.error}`) })
      continue
    }
    if (outcome.errors.length > 0) {
      warnings.push(`「${meta.title || meta.sessionId}」有 ${outcome.errors.length} 个文件未能恢复，条目仍保留。`)
    }
    const attach = await attachSession(ctx, home, meta.sessionId, meta.workspaceId)
    if (!attach.ok) warnings.push(attach.warning ?? `会话已恢复，但重新挂回工作区失败：${attach.error ?? '未知原因'}`)
    if (outcome.errors.length === 0 && meta.archived === true) await tryRegistry(ctx, 'archiveSession', meta.sessionId)
    if (outcome.errors.length === 0 && meta.pinned === true) await tryRegistry(ctx, 'pinSession', meta.sessionId)
    const entry = {
      entryId,
      sessionId: meta.sessionId,
      title: meta.title,
      bytes: outcome.restored.reduce((total, item) => total + item.bytes, 0),
      files: outcome.restored.length,
    }
    if (outcome.errors.length === 0) restored.push(entry)
    else failures.push({ ...entry, errors: outcome.errors.map((item) => `${item.rel}: ${item.error}`) })
  }
  return { restored, failures, warnings }
}

/* --------------------------------------------------------------------- purge */

/**
 * Permanently delete recycle-bin entries.
 * @param {string} home - DSH home directory.
 * @param {string[]} entryIds - recycle-bin entries to delete.
 * @returns {Promise<{purged: Array<object>, failures: Array<object>}>}
 */
async function purgeEntries(home, entryIds) {
  const purged = []
  const failures = []
  for (const entryId of entryIds) {
    const meta = await store.readTrashEntry(home, entryId)
    if (meta === undefined) {
      failures.push({ entryId, error: '回收站中找不到该条目（可能已被清空）' })
      continue
    }
    const outcome = await store.purgeTrashEntry(home, entryId)
    if (outcome.ok) purged.push({ entryId, sessionId: meta.sessionId, title: meta.title, bytes: meta.bytes ?? 0 })
    else failures.push({ entryId, id: meta.sessionId, title: meta.title, error: outcome.error })
  }
  return { purged, failures }
}

/* -------------------------------------------------------------- host helpers */

/**
 * Resolve an optional Host service without throwing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} key - service key.
 * @returns {any} the service, or null when unavailable.
 */
function service(ctx, key) {
  try {
    return ctx.get(key) ?? null
  } catch {
    return null
  }
}

/**
 * Call one optional registry method, ignoring absence and failures.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} method - registry method name.
 * @param {string} sessionId - conversation id.
 * @returns {Promise<void>}
 */
async function tryRegistry(ctx, method, sessionId) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === null || typeof registry[method] !== 'function') return
  try {
    await registry[method](sessionId)
  } catch {
    /* archive/pin restoration is best effort */
  }
}

/**
 * Ids of conversations that currently have a live Host session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Set<string>} live conversation ids.
 */
function liveSessionIds(ctx) {
  const live = new Set()
  const sessions = service(ctx, 'sessions')
  if (sessions === null || typeof sessions.list !== 'function') return live
  try {
    for (const entry of sessions.list() ?? []) live.add(String(entry?.id ?? entry))
  } catch {
    /* liveness checks are best effort */
  }
  return live
}

/**
 * Ids of the conversation plus every sub-agent conversation it spawned.
 *
 * Sub-agent Sessions are not registered in any workspace and never appear as
 * rows, so deleting the visible parent must include them or their logs would be
 * left behind. Forks are independent Sessions and are NOT included. The scan is
 * best effort: without a `sessionQuery` service only the selected id is used.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - selected conversation id.
 * @returns {Promise<Set<string>>} selected id and its sub-agent descendants.
 */
async function collectSubagentIds(ctx, sessionId) {
  const ids = new Set([sessionId])
  const query = service(ctx, 'sessionQuery')
  if (query === null || typeof query.listSessions !== 'function') return ids
  try {
    const records = await query.listSessions()
    const parentOf = new Map()
    for (const record of records ?? []) {
      const header = record?.header
      if (header === null || typeof header !== 'object') continue
      if (typeof header.id !== 'string' || header.origin !== 'subagent') continue
      if (typeof header.parentSession === 'string' && header.parentSession !== '' && header.parentSession !== header.id) {
        parentOf.set(header.id, header.parentSession)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const [child, parent] of parentOf) {
        if (ids.has(parent) && !ids.has(child)) {
          ids.add(child)
          changed = true
        }
      }
    }
  } catch {
    /* sub-agent lineage is best effort */
  }
  return ids
}

/**
 * Ask the host to stop a live conversation before its artifacts move.
 * Archive-with-stop is the public way to end activity; failures are ignored
 * because the log is about to leave the catalog anyway.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - conversation id.
 * @returns {Promise<void>}
 */
async function stopLiveSession(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry !== null && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch {
      /* fall through */
    }
  }
  const controller = service(ctx, 'sessionController')
  for (const call of [() => controller?.cancel?.({ sessionId }), () => controller?.cancel?.(sessionId)]) {
    try {
      await call()
      break
    } catch {
      /* try the next shape, then give up */
    }
  }
}

/**
 * Find the workspace registration that currently lists one conversation.
 * @param {Awaited<ReturnType<typeof store.readWorkspaceState>>} state - disk snapshot.
 * @param {string} sessionId - conversation id.
 * @returns {{id: string, title: string} | undefined} owning workspace.
 */
function findWorkspace(state, sessionId) {
  for (const workspace of state.workspaces) {
    if (workspace.sessionIds.includes(sessionId)) return { id: workspace.id, title: workspace.title }
  }
  return undefined
}

/**
 * Detach conversation ids from every workspace registration and clear their
 * archived/pinned references.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} home - DSH home directory.
 * @param {string[]} sessionIds - conversations to detach.
 * @returns {Promise<{ok: boolean, errors: string[]}>} outcome.
 */
async function detachSessions(ctx, home, sessionIds) {
  if (sessionIds.length === 0) return { ok: true, errors: [] }
  const errors = []
  const registry = service(ctx, 'workspaceRegistry')
  if (registry !== null && typeof registry.list === 'function') {
    try {
      const list = await registry.list()
      for (const workspace of list) {
        const owned = new Set([...workspace.sessionIds].map(String))
        for (const id of sessionIds) {
          if (!owned.has(id) || typeof workspace.detachSession !== 'function') continue
          try {
            await workspace.detachSession(id)
          } catch (error) {
            errors.push(`分离会话 ${id} 失败：${messageOf(error)}`)
          }
        }
      }
    } catch (error) {
      errors.push(`读取工作区登记失败：${messageOf(error)}`)
    }
    for (const id of sessionIds) {
      for (const method of ['unarchiveSession', 'unpinSession']) {
        if (typeof registry[method] !== 'function') continue
        try {
          await registry[method](id)
        } catch {
          /* id was probably not archived/pinned */
        }
      }
    }
    return { ok: errors.length === 0, errors }
  }
  const state = await store.readWorkspaceState(home)
  if (state.raw === undefined) return { ok: false, errors: ['无法读取工作区登记文件，会话已从磁盘删除但登记未更新'] }
  try {
    await store.writeWorkspaceState(home, store.removeSessionsFromState(state.raw, sessionIds))
    return { ok: true, errors }
  } catch (error) {
    return { ok: false, errors: [...errors, `写回工作区登记失败：${messageOf(error)}`] }
  }
}

/**
 * Re-attach a restored conversation to its original workspace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} home - DSH home directory.
 * @param {string} sessionId - conversation id.
 * @param {string | undefined} workspaceId - original workspace id, if known.
 * @returns {Promise<{ok: boolean, warning?: string, error?: string}>} outcome.
 */
async function attachSession(ctx, home, sessionId, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    return { ok: true, warning: '原会话不属于任何工作区，已恢复为「未分组」。' }
  }
  const registry = service(ctx, 'workspaceRegistry')
  if (registry !== null && typeof registry.list === 'function') {
    try {
      const list = await registry.list()
      const workspace = list.find((item) => String(item.id) === workspaceId)
      if (workspace === undefined) return { ok: true, warning: '原工作区已不存在，会话已恢复为「未分组」。' }
      await workspace.attachSession(sessionId)
      return { ok: true }
    } catch (error) {
      return { ok: true, warning: `会话已恢复，但重新挂回原工作区失败：${messageOf(error)}` }
    }
  }
  const state = await store.readWorkspaceState(home)
  if (state.raw === undefined) return { ok: true, warning: '无法读取工作区登记文件，会话已恢复为「未分组」。' }
  const table = state.raw?.tables?.workspaces
  const row = table !== null && typeof table === 'object' ? table[workspaceId] : undefined
  if (row === null || typeof row !== 'object') return { ok: true, warning: '原工作区已不存在，会话已恢复为「未分组」。' }
  const ids = Array.isArray(row.sessionIds) ? row.sessionIds : []
  if (!ids.includes(sessionId)) ids.push(sessionId)
  row.sessionIds = ids
  try {
    await store.writeWorkspaceState(home, state.raw)
    return { ok: true }
  } catch (error) {
    return { ok: true, warning: `会话已恢复，但写回工作区登记失败：${messageOf(error)}` }
  }
}

/**
 * Tell the running Client that these conversations left the Host catalog.
 * `api-session/removed` is the shipped forwarded Remote event for this
 * transition, so replaying it makes the sidebar drop the row immediately.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string[]} sessionIds - conversations that no longer exist on disk.
 */
function notifySessionsRemoved(ctx, sessionIds) {
  for (const sessionId of sessionIds) {
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch {
      /* the artifacts are already gone; a stale row is not worth failing the request */
    }
  }
}

/** Title to store in a recycle-bin entry. */
function displayTitle(titles, sessionId, plan) {
  const supplied = typeof titles?.[sessionId] === 'string' ? titles[sessionId].trim() : ''
  return supplied !== '' ? supplied : plan.sessionId
}

/* ---------------------------------------------------------------- http plumbing */

/**
 * Accept only loopback, same-origin callers. Moving conversations out of the
 * catalog is destructive, so a page on the public internet must never reach
 * this route. The desktop renderer origin is `dsh-app://127.0.0.1:<port>`, so
 * protocol equality is deliberately not required.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} whether the caller is trusted.
 */
function trusted(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  if (!loopback.has(address)) return false
  const rawHost = typeof req.headers.host === 'string' ? req.headers.host : ''
  let hostUrl
  try {
    hostUrl = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  const hostNames = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])
  if (!hostNames.has(hostUrl.hostname)) return false
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write a JSON response with no caching. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<any>} parsed body (an empty body parses as `{}`).
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) unprocessable('请求体过大', 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    unprocessable('请求体不是合法 JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) unprocessable('请求体必须是 JSON 对象', 400)
  return parsed
}

/**
 * Validate an id list from a request body.
 * @param {any} body - parsed request body.
 * @param {string} field - field name.
 * @returns {string[]} deduplicated safe ids.
 */
function requireIds(body, field) {
  const value = body?.[field]
  if (!Array.isArray(value) || value.length === 0) unprocessable(`字段 ${field} 必须是非空数组`, 400)
  if (value.length > MAX_IDS) unprocessable(`一次最多处理 ${MAX_IDS} 项`, 400)
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || !store.isSafeId(item)) unprocessable(`字段 ${field} 含有非法 id`, 400)
    ids.push(item)
  }
  return [...new Set(ids)]
}

/** Throw an HTTP-shaped error. */
function unprocessable(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

/** Error message helper. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
