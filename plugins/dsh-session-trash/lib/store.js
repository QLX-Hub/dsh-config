/**
 * @module dsh-session-trash/store
 *
 * Cordis-free helpers for the session recycle bin.
 *
 * Everything here takes an explicit DSH home directory and only touches paths
 * below it, so the module can be exercised against a throwaway sandbox
 * (`DSH_HOME` pointed at a temp directory) without touching real state.
 *
 * What a conversation (session) owns on disk:
 *   <home>/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
 *   <home>/storages/session_projcache/sessions/<sessionId>.json   (+ .bak.*)
 * Attachments live in a shared content-addressed store and are intentionally
 * left alone: one object may be referenced by many conversations.
 *
 * The recycle bin lives at <home>/storages/session-trash/entries/<entryId>/:
 *   meta.json    what the entry is and where its files came from
 *   files/...    the moved artifacts, keeping their home-relative paths
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** Environment variable that overrides the DSH home directory. */
export const DSH_HOME_ENV = 'DSH_HOME'
/** File name of a session log inside its session directory. */
export const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'
/** Workspace registry document, relative to the DSH home. */
export const WORKSPACE_STATE_FILE = join('storages', 'workspace.json')
/** Projection-cache record directory, relative to the DSH home. */
export const PROJECTION_CACHE_DIR = join('storages', 'session_projcache', 'sessions')
/** Session log root, relative to the DSH home. */
export const SESSIONS_ROOT = 'sessions'
/** Recycle-bin storage root, relative to the DSH home. */
export const TRASH_ROOT = join('storages', 'session-trash')
/** Directory below {@link TRASH_ROOT} holding one directory per entry. */
export const TRASH_ENTRIES_DIR = 'entries'
/** Metadata file name inside one trash entry. */
export const TRASH_META_FILE = 'meta.json'
/** Payload directory inside one trash entry. */
export const TRASH_FILES_DIR = 'files'

const SAFE_CHARACTER = /^[\w.-]$/u
const SAFE_ID = /^[\w.-]{1,200}$/u

/** True when `value` is a non-blank string, after trimming. */
function filled(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** True when a filesystem error means "not there". */
function isMissing(error) {
  const code = error?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Error message helper. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the DSH home directory.
 * Precedence mirrors `@deepseek-ai/dsh-home-paths`: an explicit configured
 * path, then `$DSH_HOME`, then `~/.dsh`.
 * @param {string | undefined} configured - explicit path from plugin Config.
 * @param {Record<string, string | undefined>} [env] - environment mapping.
 * @returns {string} absolute path.
 */
export function resolveDshHome(configured, env = process.env) {
  const explicit = filled(configured)
  if (explicit !== undefined) return resolve(explicit)
  const fromEnvironment = filled(env?.[DSH_HOME_ENV])
  if (fromEnvironment !== undefined) return resolve(fromEnvironment)
  return resolve(join(homedir(), '.dsh'))
}

/**
 * Encode one path segment the way `dsh-session-persistence-jsonl` does:
 * `.` / `..` become `~002E` / `~002E~002E`, `[A-Za-z0-9._-]` pass through,
 * every other UTF-16 code unit becomes `~` plus four upper-case hex digits.
 * @param {string} raw - logical segment value (here: a session id).
 * @returns {string} filesystem-safe segment.
 */
export function encodeSegment(raw) {
  const value = String(raw)
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (SAFE_CHARACTER.test(character)) {
      out += character
    } else {
      out += `~${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/**
 * Inverse of {@link encodeSegment} for ids that are already on disk.
 * @param {string} segment - encoded directory name.
 * @returns {string} decoded logical value.
 */
export function decodeSegment(segment) {
  return String(segment).replace(/~([0-9A-Fa-f]{4})/gu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** True when an id is safe to embed in a path segment. */
export function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && id !== '.' && id !== '..'
}

/** Absolute workspace-registry path for one home. */
export function workspaceStatePath(home) {
  return join(home, WORKSPACE_STATE_FILE)
}

/** Absolute projection-cache record directory for one home. */
export function projectionCachePath(home) {
  return join(home, PROJECTION_CACHE_DIR)
}

/** Absolute session log root for one home. */
export function sessionsRoot(home) {
  return join(home, SESSIONS_ROOT)
}

/** Absolute recycle-bin root for one home. */
export function trashRoot(home) {
  return join(home, TRASH_ROOT)
}

/** Absolute directory holding every recycle-bin entry. */
export function trashEntriesRoot(home) {
  return join(trashRoot(home), TRASH_ENTRIES_DIR)
}

/** Absolute directory of one recycle-bin entry. */
export function trashEntryDir(home, entryId) {
  if (!isSafeId(entryId)) throw new Error(`unsafe trash entry id: ${String(entryId)}`)
  return join(trashEntriesRoot(home), entryId)
}

/**
 * Guard that a resolved path really lives below the DSH home.
 * @param {string} root - allowed root.
 * @param {string} target - candidate path.
 * @returns {string} the resolved target.
 */
export function assertInside(root, target) {
  const resolvedRoot = resolve(root)
  const candidate = resolve(target)
  const rel = relative(resolvedRoot, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    const error = new Error(`refusing to touch a path outside ${resolvedRoot}: ${candidate}`)
    error.code = 'OUTSIDE_ROOT'
    throw error
  }
  return candidate
}

/**
 * Normalize a home-relative path to forward slashes and validate its shape.
 * @param {string} rel - relative path as stored on disk (either separator).
 * @returns {string} POSIX-style relative path.
 */
export function normalizeRel(rel) {
  const normalized = String(rel).replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`unsafe relative path: ${String(rel)}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe relative path: ${String(rel)}`)
  }
  return posix.normalize(normalized)
}

/** Convert a POSIX relative path back to the platform's path form. */
function platformRel(rel) {
  return normalizeRel(rel).split('/').join(sep)
}

/** Recursively sum the size of one directory or file, tolerating races. */
async function sizeOf(target) {
  let info
  try {
    info = await stat(target)
  } catch {
    return 0
  }
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return total
  }
  for (const entry of entries) total += await sizeOf(join(target, entry.name))
  return total
}

/* ----------------------------------------------------------- workspace state */

/**
 * Read and summarize the workspace registry document.
 * A missing document is reported, not thrown.
 * @param {string} home - DSH home directory.
 * @returns {Promise<{file: string, exists: boolean, error?: string, raw?: any, defaultWorkspaceId?: string, workspaces: Array<{id: string, title: string, path: string, sessionIds: string[], isDefault: boolean}>, archivedSessionIds: string[], pinnedSessionIds: string[]}>}
 */
export async function readWorkspaceState(home) {
  const file = workspaceStatePath(home)
  const empty = { file, exists: false, workspaces: [], archivedSessionIds: [], pinnedSessionIds: [] }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return empty
    return { ...empty, error: messageOf(error) }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ...empty, exists: true, error: `workspace.json 不是合法 JSON：${messageOf(error)}` }
  }
  return { file, exists: true, raw, ...summarizeWorkspaceState(raw) }
}

/**
 * Normalize a raw `workspace.json` document.
 * Stored order is preserved; rows present in the table but missing from
 * `global.workspaceIds` are appended so nothing silently disappears from the UI.
 * @param {any} raw - parsed document.
 * @returns {{defaultWorkspaceId?: string, workspaces: Array<any>, archivedSessionIds: string[], pinnedSessionIds: string[]}}
 */
export function summarizeWorkspaceState(raw) {
  const global = raw?.global ?? {}
  const table = raw?.tables?.workspaces ?? {}
  const defaultWorkspaceId = typeof global.defaultWorkspaceId === 'string' ? global.defaultWorkspaceId : undefined
  const order = []
  const seen = new Set()
  for (const id of Array.isArray(global.workspaceIds) ? global.workspaceIds : []) {
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
  }
  for (const id of Object.keys(table)) {
    if (!seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
  }
  const workspaces = order.map((id) => {
    const row = table[id] ?? {}
    const path = typeof row.path === 'string' ? row.path : ''
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : path
    return {
      id,
      title,
      path,
      sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.filter((sessionId) => typeof sessionId === 'string') : [],
      isDefault: id === defaultWorkspaceId,
    }
  })
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  return {
    defaultWorkspaceId,
    workspaces,
    archivedSessionIds: strings(global.archivedSessionIds),
    pinnedSessionIds: strings(global.pinnedSessionIds),
  }
}

/** Recursive clone of a plain JSON document. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Remove conversations from the registry document (pure).
 * Detaches each id from every workspace and from the archived/pinned lists.
 * @param {any} raw - parsed `workspace.json`.
 * @param {string[]} sessionIds - conversations to detach.
 * @returns {any} a new document; the input is not mutated.
 */
export function removeSessionsFromState(raw, sessionIds) {
  const drop = new Set(sessionIds)
  const next = cloneJson(raw ?? {})
  next.global = next.global ?? {}
  next.global.archivedSessionIds = (Array.isArray(next.global.archivedSessionIds) ? next.global.archivedSessionIds : []).filter((id) => !drop.has(id))
  next.global.pinnedSessionIds = (Array.isArray(next.global.pinnedSessionIds) ? next.global.pinnedSessionIds : []).filter((id) => !drop.has(id))
  const table = next.tables?.workspaces
  if (table !== null && typeof table === 'object') {
    for (const row of Object.values(table)) {
      if (row === null || typeof row !== 'object') continue
      if (Array.isArray(row.sessionIds)) row.sessionIds = row.sessionIds.filter((id) => !drop.has(id))
    }
  }
  return next
}

/**
 * Atomically replace the workspace registry document.
 * The host process keeps its own in-memory copy, so prefer the registry service
 * at runtime; this writer exists for sandboxes and repair paths.
 * @param {string} home - DSH home directory.
 * @param {any} raw - document to persist.
 * @returns {Promise<string>} the written path.
 */
export async function writeWorkspaceState(home, raw) {
  const file = workspaceStatePath(home)
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return file
}

/* ---------------------------------------------------------------- inventory */

/**
 * Scan every session directory below the home.
 * @param {string} home - DSH home directory.
 * @returns {Promise<Map<string, string[]>>} session id → absolute session directories.
 */
export async function scanSessionDirs(home) {
  const found = new Map()
  const root = sessionsRoot(home)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return found
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = decodeSegment(entry.name)
      const list = found.get(sessionId) ?? []
      list.push(join(projectDir, entry.name))
      found.set(sessionId, list)
    }
  }
  return found
}

/**
 * Scan projection-cache records below the home (including `.bak.*` siblings).
 * @param {string} home - DSH home directory.
 * @returns {Promise<Map<string, string[]>>} session id → absolute cache files.
 */
export async function scanProjectionFiles(home) {
  const found = new Map()
  const root = projectionCachePath(home)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return found
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^(.+?)\.json(?:\.bak\..*)?$/u.exec(entry.name)
    if (match === null) continue
    const sessionId = match[1]
    const list = found.get(sessionId) ?? []
    list.push(join(root, entry.name))
    found.set(sessionId, list)
  }
  return found
}

/**
 * Build a move/removal plan for one conversation.
 * @param {{home: string, sessionId: string, dirs?: Map<string, string[]>, projections?: Map<string, string[]>}} input
 * @returns {Promise<{sessionId: string, entries: Array<{rel: string, kind: string, bytes: number}>, bytes: number, projectDirs: string[]}>}
 */
export async function planSessionArtifacts({ home, sessionId, dirs, projections }) {
  const entries = []
  const projectDirs = new Set()
  for (const directory of dirs?.get(sessionId) ?? []) {
    const absolute = assertInside(home, directory)
    entries.push({ rel: normalizeRel(relative(home, absolute)), kind: '会话目录', bytes: await sizeOf(absolute) })
    projectDirs.add(normalizeRel(relative(home, dirname(absolute))))
  }
  for (const file of projections?.get(sessionId) ?? []) {
    const absolute = assertInside(home, file)
    entries.push({ rel: normalizeRel(relative(home, absolute)), kind: '投影缓存', bytes: await sizeOf(absolute) })
  }
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  return { sessionId, entries, bytes, projectDirs: [...projectDirs] }
}

/**
 * Remove the now-empty project directories of the given session artifacts.
 * @param {string} home - DSH home directory.
 * @param {string[]} projectDirs - home-relative project directories.
 * @returns {Promise<string[]>} pruned directories.
 */
async function pruneProjectDirs(home, projectDirs) {
  const pruned = []
  for (const rel of projectDirs ?? []) {
    try {
      const directory = assertInside(home, join(home, platformRel(rel)))
      const rest = await readdir(directory)
      if (rest.length === 0) {
        await rmdir(directory)
        pruned.push(normalizeRel(relative(home, directory)))
      }
    } catch {
      /* a shared project directory with other sessions stays */
    }
  }
  return pruned
}

/**
 * Remove one conversation's artifacts permanently.
 * @param {string} home - DSH home directory.
 * @param {{sessionId: string, entries: Array<{rel: string, kind: string, bytes: number}>, bytes: number, projectDirs: string[]}} plan - removal plan.
 * @returns {Promise<{sessionId: string, removed: Array<{rel: string, kind: string, bytes: number}>, bytes: number, errors: Array<{rel: string, error: string}>, pruned: string[]}>}
 */
export async function deleteSessionArtifacts(home, plan) {
  const removed = []
  const errors = []
  for (const entry of plan.entries) {
    try {
      const absolute = assertInside(home, join(home, platformRel(entry.rel)))
      await rm(absolute, { recursive: true, force: true })
      removed.push(entry)
    } catch (error) {
      errors.push({ rel: entry.rel, error: messageOf(error) })
    }
  }
  const pruned = await pruneProjectDirs(home, plan.projectDirs)
  return {
    sessionId: plan.sessionId,
    removed,
    bytes: removed.reduce((total, entry) => total + entry.bytes, 0),
    errors,
    pruned,
  }
}

/* --------------------------------------------------------------- trash bins */

/** Absolute path of one trash entry's metadata file. */
export function trashMetaPath(home, entryId) {
  return join(trashEntryDir(home, entryId), TRASH_META_FILE)
}

/**
 * Move one conversation's artifacts into a new recycle-bin entry.
 * Artifacts that fail to move are reported but do not stop the others.
 * @param {string} home - DSH home directory.
 * @param {{sessionId: string, title?: string, workspaceId?: string, workspaceTitle?: string, archived?: boolean, pinned?: boolean, entries: Array<{rel: string, kind: string, bytes: number}>, projectDirs: string[]}} input - move plan plus captured registration state.
 * @returns {Promise<{entry: any, errors: Array<{rel: string, error: string}>, pruned: string[]}>}
 */
export async function createTrashEntry(home, input) {
  const entryId = `trash-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const directory = trashEntryDir(home, entryId)
  const filesRoot = join(directory, TRASH_FILES_DIR)
  await mkdir(filesRoot, { recursive: true })
  const moved = []
  const errors = []
  for (const entry of input.entries) {
    try {
      const from = assertInside(home, join(home, platformRel(entry.rel)))
      const to = assertInside(filesRoot, join(filesRoot, platformRel(entry.rel)))
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
      moved.push(entry)
    } catch (error) {
      errors.push({ rel: entry.rel, error: messageOf(error) })
    }
  }
  const pruned = await pruneProjectDirs(home, input.projectDirs)
  const meta = {
    version: 1,
    entryId,
    sessionId: input.sessionId,
    sessionIds: Array.isArray(input.sessionIds) ? input.sessionIds.filter((id) => typeof id === 'string') : [input.sessionId],
    title: typeof input.title === 'string' ? input.title : '',
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : '',
    workspaceTitle: typeof input.workspaceTitle === 'string' ? input.workspaceTitle : '',
    archived: input.archived === true,
    pinned: input.pinned === true,
    deletedAt: new Date().toISOString(),
    bytes: moved.reduce((total, entry) => total + entry.bytes, 0),
    files: moved.map((entry) => ({ rel: entry.rel, kind: entry.kind, bytes: entry.bytes })),
  }
  await writeFile(join(directory, TRASH_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { entry: meta, errors, pruned }
}

/**
 * Read one recycle-bin entry's metadata.
 * @param {string} home - DSH home directory.
 * @param {string} entryId - entry id.
 * @returns {Promise<any | undefined>} metadata, or undefined when absent.
 */
export async function readTrashEntry(home, entryId) {
  try {
    const text = await readFile(trashMetaPath(home, entryId), 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (isMissing(error)) return undefined
    return undefined
  }
}

/**
 * List every recycle-bin entry, newest first. Malformed entries are skipped.
 * @param {string} home - DSH home directory.
 * @returns {Promise<Array<any>>} entry metadata list.
 */
export async function listTrashEntries(home) {
  const root = trashEntriesRoot(home)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await readTrashEntry(home, entry.name)
    if (meta === undefined) continue
    out.push(meta)
  }
  out.sort((left, right) => String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? '')))
  return out
}

/**
 * Move one recycle-bin entry's files back to their home-relative locations.
 * The entry directory is removed only when every file was restored.
 * @param {string} home - DSH home directory.
 * @param {string} entryId - entry id.
 * @returns {Promise<{meta: any | undefined, restored: Array<{rel: string, kind: string, bytes: number}>, errors: Array<{rel: string, error: string}>}>}
 */
export async function restoreTrashEntry(home, entryId) {
  const meta = await readTrashEntry(home, entryId)
  if (meta === undefined) return { meta: undefined, restored: [], errors: [] }
  const directory = trashEntryDir(home, entryId)
  const filesRoot = join(directory, TRASH_FILES_DIR)
  const restored = []
  const errors = []
  for (const entry of Array.isArray(meta.files) ? meta.files : []) {
    try {
      const from = assertInside(filesRoot, join(filesRoot, platformRel(entry.rel)))
      const to = assertInside(home, join(home, platformRel(entry.rel)))
      try {
        await stat(to)
        errors.push({ rel: entry.rel, error: '目标位置已存在同名文件，未覆盖' })
        continue
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
      restored.push(entry)
    } catch (error) {
      errors.push({ rel: entry.rel, error: messageOf(error) })
    }
  }
  if (errors.length === 0) await rm(directory, { recursive: true, force: true })
  return { meta, restored, errors }
}

/**
 * Permanently remove one recycle-bin entry.
 * @param {string} home - DSH home directory.
 * @param {string} entryId - entry id.
 * @returns {Promise<{entryId: string, ok: boolean, error?: string}>}
 */
export async function purgeTrashEntry(home, entryId) {
  try {
    await rm(trashEntryDir(home, entryId), { recursive: true, force: true })
    return { entryId, ok: true }
  } catch (error) {
    return { entryId, ok: false, error: messageOf(error) }
  }
}

/**
 * Permanently remove every recycle-bin entry.
 * @param {string} home - DSH home directory.
 * @returns {Promise<{count: number, errors: Array<{entryId: string, error: string}>}>}
 */
export async function emptyTrash(home) {
  const entries = await listTrashEntries(home)
  const errors = []
  for (const meta of entries) {
    const outcome = await purgeTrashEntry(home, meta.entryId)
    if (!outcome.ok) errors.push({ entryId: meta.entryId, error: outcome.error ?? 'unknown' })
  }
  if (errors.length === 0) {
    try {
      const root = trashEntriesRoot(home)
      const rest = await readdir(root)
      if (rest.length === 0) await rmdir(root)
    } catch {
      /* no entries directory left behind */
    }
  }
  return { count: entries.length - errors.length, errors }
}

/** Human-readable byte size (shared by API payloads and tests). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}
