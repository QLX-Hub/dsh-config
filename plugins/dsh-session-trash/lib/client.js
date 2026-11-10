/**
 * @module dsh-session-trash-bin/client
 *
 * Client half:
 *   - adds two actions to every Session row's right-click menu:
 *       「删除会话（放入回收站）」 and 「彻底删除会话」
 *   - adds a global 「会话回收站」 panel where trashed sessions can be restored
 *     or permanently deleted.
 *
 * The bundle is a Module-Loader CJS entry: executing the file only registers a
 * factory, and module bodies run lazily at materialization.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash-bin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const mod = { exports: {} }

    const PLUGIN_ID = 'session-trash'
    const PANEL_ID = 'session-trash'
    const API = '/api/session-trash'

    const STRINGS = {
      zh: {
        panel: '会话回收站',
        'menu.trash': '删除会话（放入回收站）',
        'menu.purge': '彻底删除会话',
        'confirm.purgeTitle': '彻底删除会话',
        'confirm.purgeBody': (title) =>
          `「${title}」将从磁盘永久删除：会话记录、日志与投影缓存都会被清除，且不会进入回收站。此操作无法撤销。`,
        'confirm.purge': '彻底删除',
        'confirm.cancel': '取消',
        'running.trashTitle': '会话正在运行',
        'running.trashBody': (title) => `「${title}」还有正在运行的工作。继续会先停止这些工作，再把会话移入回收站。`,
        'running.deleteBody': (title) => `「${title}」还有正在运行的工作。继续会先停止这些工作，再永久删除会话。`,
        'running.confirm': '停止并继续',
        'toast.trashed': '已移入回收站',
        'toast.undo': '撤销',
        'toast.undoFailed': '恢复失败，请到「会话回收站」重试',
        'toast.purged': '已彻底删除会话',
        'toast.purgeFailed': '彻底删除失败，请重试',
        'toast.restored': '会话已恢复',
        'failed': (message) => `操作失败：${message}`,
        'panel.title': '会话回收站',
        'panel.subtitle': '被「删除会话（放入回收站）」移入的会话会保存在这里；恢复后会回到原来的工作区，不占用侧栏列表。',
        'panel.refresh': '刷新',
        'panel.empty': '回收站是空的。',
        'panel.home': '数据目录',
        'panel.entries': (n) => `${n} 个会话`,
        'panel.bytes': '占用',
        'panel.restore': '恢复',
        'panel.purge': '彻底删除',
        'panel.emptyTrash': '清空回收站',
        'panel.emptyTitle': '清空回收站',
        'panel.emptyBody': (n) => `回收站中的 ${n} 个会话将从磁盘永久删除，无法恢复。确定继续吗？`,
        'panel.purgeTitle': '彻底删除会话',
        'panel.purgeBody': (title) => `「${title}」将从磁盘永久删除，无法恢复。确定继续吗？`,
        'panel.workspace': '工作区',
        'panel.deletedAt': '删除时间',
        'panel.subagentCount': (n) => `含 ${n} 个子 agent 会话`,
        'panel.restored': '已恢复，页面即将刷新以显示会话…',
        'panel.purged': '已从磁盘永久删除。',
        'panel.error': '读取回收站失败',
        'panel.retry': '重试',
        'panel.unknownWorkspace': '未分组',
        'panel.loading': '正在读取回收站…',
        'panel.confirm': '确定',
        'panel.cancel': '取消',
      },
      en: {
        panel: 'Session recycle bin',
        'menu.trash': 'Delete session (move to recycle bin)',
        'menu.purge': 'Delete session permanently',
        'confirm.purgeTitle': 'Delete this session permanently',
        'confirm.purgeBody': (title) =>
          `"${title}" will be removed from disk: its log, records and projection cache are deleted and it does not go to the recycle bin. This cannot be undone.`,
        'confirm.purge': 'Delete permanently',
        'confirm.cancel': 'Cancel',
        'running.trashTitle': 'Session is running',
        'running.trashBody': (title) => `"${title}" still has running work. Continuing stops that work first, then moves the session to the recycle bin.`,
        'running.deleteBody': (title) => `"${title}" still has running work. Continuing stops that work first, then deletes the session permanently.`,
        'running.confirm': 'Stop and continue',
        'toast.trashed': 'Moved to the recycle bin',
        'toast.undo': 'Undo',
        'toast.undoFailed': 'Restore failed — try again in the recycle bin',
        'toast.purged': 'Session deleted permanently',
        'toast.purgeFailed': 'Permanent deletion failed — try again',
        'toast.restored': 'Session restored',
        'failed': (message) => `Action failed: ${message}`,
        'panel.title': 'Session recycle bin',
        'panel.subtitle': 'Sessions moved here by "Delete session (move to recycle bin)" stay on disk. Restoring one returns it to its original workspace.',
        'panel.refresh': 'Refresh',
        'panel.empty': 'The recycle bin is empty.',
        'panel.home': 'Data directory',
        'panel.entries': (n) => `${n} session(s)`,
        'panel.bytes': 'on disk',
        'panel.restore': 'Restore',
        'panel.purge': 'Delete permanently',
        'panel.emptyTrash': 'Empty recycle bin',
        'panel.emptyTitle': 'Empty the recycle bin',
        'panel.emptyBody': (n) => `${n} session(s) will be permanently removed from disk. This cannot be undone. Continue?`,
        'panel.purgeTitle': 'Delete session permanently',
        'panel.purgeBody': (title) => `"${title}" will be permanently removed from disk. This cannot be undone. Continue?`,
        'panel.workspace': 'Workspace',
        'panel.deletedAt': 'Deleted',
        'panel.subagentCount': (n) => `including ${n} sub-agent session(s)`,
        'panel.restored': 'Restored — reloading the page to show the session…',
        'panel.purged': 'Permanently removed from disk.',
        'panel.error': 'Could not read the recycle bin',
        'panel.retry': 'Retry',
        'panel.unknownWorkspace': 'Ungrouped',
        'panel.loading': 'Reading the recycle bin…',
        'panel.confirm': 'Continue',
        'panel.cancel': 'Cancel',
      },
    }

    const locale = (() => {
      if (typeof navigator === 'undefined') return 'en'
      return /^zh\b/iu.test(navigator.language ?? '') ? 'zh' : 'en'
    })()
    const dict = STRINGS[locale]
    const t = (key, ...args) => {
      const value = dict[key] ?? key
      return typeof value === 'function' ? value(...args) : value
    }

    const CSS = `
.sstrash-page { display: flex; flex-direction: column; gap: 16px; padding: calc(var(--dsh-frame-top-clearance, 48px) + 16px) 28px 40px; color: var(--dsw-alias-label-primary); min-height: 100%; box-sizing: border-box; }
.sstrash-head { display: flex; flex-direction: column; gap: 6px; }
.sstrash-title { font-size: 20px; font-weight: 600; margin: 0; }
.sstrash-subtitle { font-size: 13px; color: var(--dsw-alias-label-secondary); margin: 0; line-height: 1.6; }
.sstrash-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sstrash-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.sstrash-toolbar-spacer { flex: 1 1 auto; }
.sstrash-button { font: inherit; font-size: 13px; line-height: 1.2; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.sstrash-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.sstrash-button:disabled { opacity: 0.45; cursor: default; }
.sstrash-button-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.sstrash-button-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sstrash-button-danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); border-color: var(--dsw-alias-state-error-primary); }
.sstrash-button-danger-solid { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }
.sstrash-list { display: flex; flex-direction: column; gap: 8px; }
.sstrash-card { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.sstrash-card-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.sstrash-card-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sstrash-card-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sstrash-card-actions { display: flex; gap: 6px; flex: none; }
.sstrash-empty { padding: 28px 16px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; }
.sstrash-error { font-size: 12px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sstrash-notice { font-size: 12px; line-height: 1.6; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.sstrash-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; line-height: 1.6; }
.sstrash-overlay { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); padding: 24px; }
.sstrash-dialog { width: min(480px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 18px 48px rgba(0,0,0,0.35); }
.sstrash-dialog-title { font-size: 15px; font-weight: 600; margin: 0; }
.sstrash-dialog-body { font-size: 13px; line-height: 1.7; margin: 0; white-space: pre-wrap; }
.sstrash-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
`

    /** Inject the page CSS exactly once per document. */
    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${PLUGIN_ID}"]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', PLUGIN_ID)
      style.textContent = CSS
      document.head.append(style)
    }

    /** Human-readable byte size. */
    function formatBytes(bytes) {
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

    /** Human-readable local date/time. */
    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    /** Fetch one API endpoint, surfacing transport errors. */
    async function request(pathname, init) {
      const response = await fetch(`${API}${pathname}`, {
        credentials: 'same-origin',
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    /** True when the Host refused because the conversation is running. */
    function needsForce(payload) {
      return Array.isArray(payload?.failures) && payload.failures.some((failure) => failure?.needsForce === true)
    }

    /** Collect the first readable failure from one API payload. */
    function failureText(payload) {
      const failures = Array.isArray(payload?.failures) ? payload.failures : []
      for (const failure of failures) {
        if (typeof failure?.error === 'string' && failure.error !== '') return failure.error
        if (Array.isArray(failure?.errors) && failure.errors.length > 0) return failure.errors.join('; ')
      }
      return typeof payload?.error === 'string' ? payload.error : 'unknown error'
    }

    /**
     * Promise-based confirmation store shared by the context-menu actions and
     * the recycle-bin panel. A single overlay component renders it.
     */
    function createConfirmStore() {
      let current = null
      let overlaySeen = false
      let sequence = 0
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      return {
        markOverlaySeen() {
          overlaySeen = true
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get() {
          return current
        },
        ask(options) {
          return new Promise((resolve) => {
            const id = ++sequence
            let settled = false
            const finish = (ok) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(ok)
            }
            current = {
              id,
              title: options.title ?? '',
              body: options.body ?? '',
              confirmLabel: options.confirmLabel ?? t('panel.confirm'),
              cancelLabel: options.cancelLabel ?? t('panel.cancel'),
              danger: options.danger === true,
              resolve: finish,
            }
            emit()
            // Safety net: if the shell overlay never mounts (for example the
            // slot was replaced by another plugin), ask through the browser's
            // native dialog instead of leaving the action pending forever.
            const timer = setTimeout(() => {
              if (overlaySeen || typeof window === 'undefined' || typeof window.confirm !== 'function') return
              const ok = window.confirm(`${current?.title ?? ''}\n\n${current?.body ?? ''}`)
              if (current !== null && current.id === id) {
                current = null
                emit()
              }
              finish(ok)
            }, 400)
          })
        },
        settle(ok) {
          const pending = current
          if (pending === null) return
          current = null
          emit()
          pending.resolve(ok)
        },
      }
    }

    const confirmStore = createConfirmStore()

    /** Shared confirmation dialog mounted into the shell overlay. */
    function ConfirmOverlay() {
      const [, forceRender] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        confirmStore.markOverlaySeen()
        return confirmStore.subscribe(forceRender)
      }, [])
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (confirmStore.get() === null) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            confirmStore.settle(false)
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [])
      const pending = confirmStore.get()
      if (pending === null) return null
      return h(
        'div',
        {
          className: 'sstrash-overlay',
          onPointerDown: (event) => {
            if (event.target === event.currentTarget) confirmStore.settle(false)
          },
        },
        h(
          'div',
          { className: 'sstrash-dialog', role: 'alertdialog', 'aria-modal': 'true' },
          h('h3', { className: 'sstrash-dialog-title' }, pending.title),
          h('p', { className: 'sstrash-dialog-body' }, pending.body),
          h(
            'div',
            { className: 'sstrash-dialog-actions' },
            h('button', { type: 'button', className: 'sstrash-button', onClick: () => confirmStore.settle(false) }, pending.cancelLabel),
            h(
              'button',
              {
                type: 'button',
                autoFocus: true,
                className: `sstrash-button ${pending.danger ? 'sstrash-button-danger-solid' : 'sstrash-button-primary'}`,
                onClick: () => confirmStore.settle(true),
              },
              pending.confirmLabel,
            ),
          ),
        ),
      )
    }

    /** Recycle-bin glyph for the sidebar rail. */
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' && Number.isFinite(size) ? size : 16
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }),
        h('path', { d: 'M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7' }),
        h('path', { d: 'M10 11v6M14 11v6' }),
      )
    }

    /** Trash glyph used by the context-menu action icon. */
    function TrashGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }),
        h('path', { d: 'M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7' }),
        h('path', { d: 'M10 11v6M14 11v6' }),
      )
    }

    /** Warning glyph for the permanent-delete action. */
    function PurgeGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 9v4' }),
        h('path', { d: 'M12 16.5h.01' }),
        h('path', { d: 'M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z' }),
      )
    }

    /**
     * The recycle-bin global panel.
     * @param {{notify?: (text: string, success?: boolean, action?: object) => void}} props - injected from the registering plugin.
     */
    function TrashPanel({ notify }) {
      const [state, setState] = React.useState({ status: 'loading', entries: [], totals: { entries: 0, bytes: 0 }, home: '', error: null })
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: null }))
        try {
          const payload = await request('/list', { method: 'GET' })
          setState({ status: 'ready', entries: payload.entries ?? [], totals: payload.totals ?? { entries: 0, bytes: 0 }, home: payload.home ?? '', error: null })
        } catch (error) {
          setState((previous) => ({ ...previous, status: 'ready', error: error instanceof Error ? error.message : String(error) }))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const restore = async (entry) => {
        setBusy(true)
        setNotice(null)
        try {
          const payload = await request('/restore', { method: 'POST', body: JSON.stringify({ entryIds: [entry.entryId] }) })
          if (Array.isArray(payload.restored) && payload.restored.length > 0) {
            setNotice(t('panel.restored'))
            window.setTimeout(() => window.location.reload(), 700)
          } else {
            throw new Error(failureText(payload))
          }
        } catch (error) {
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setBusy(false)
        }
      }

      const purge = async (entry) => {
        const ok = await confirmStore.ask({
          title: t('panel.purgeTitle'),
          body: t('panel.purgeBody', entry.title || entry.sessionId),
          confirmLabel: t('panel.purge'),
          danger: true,
        })
        if (!ok) return
        setBusy(true)
        setNotice(null)
        try {
          const payload = await request('/purge', { method: 'POST', body: JSON.stringify({ entryIds: [entry.entryId] }) })
          if (Array.isArray(payload.purged) && payload.purged.length > 0) {
            if (typeof notify === 'function') notify(t('toast.purged'), true)
            else setNotice(t('panel.purged'))
            await load()
          } else {
            throw new Error(failureText(payload))
          }
        } catch (error) {
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setBusy(false)
        }
      }

      const empty = async () => {
        const count = state.totals.entries ?? 0
        if (count === 0) return
        const ok = await confirmStore.ask({
          title: t('panel.emptyTitle'),
          body: t('panel.emptyBody', count),
          confirmLabel: t('panel.emptyTrash'),
          danger: true,
        })
        if (!ok) return
        setBusy(true)
        setNotice(null)
        try {
          const payload = await request('/empty', { method: 'POST', body: '{}' })
          if (typeof notify === 'function') notify(t('toast.purged'), true)
          else setNotice(t('panel.purged'))
          await load()
          if (Array.isArray(payload.failures) && payload.failures.length > 0) throw new Error(failureText(payload))
        } catch (error) {
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setBusy(false)
        }
      }

      const entries = state.entries ?? []
      const rows = entries.map((entry) =>
        h(
          'div',
          { className: 'sstrash-card', key: entry.entryId },
          h(
            'div',
            { className: 'sstrash-card-main' },
            h('div', { className: 'sstrash-card-title' }, entry.title || entry.sessionId),
            h(
              'div',
              { className: 'sstrash-card-sub' },
              `${t('panel.workspace')}：${entry.workspaceTitle || t('panel.unknownWorkspace')} · ${t('panel.deletedAt')} ${formatDate(entry.deletedAt)} · ${formatBytes(entry.bytes ?? 0)}${
                Array.isArray(entry.sessionIds) && entry.sessionIds.length > 1 ? ` · ${t('panel.subagentCount', entry.sessionIds.length - 1)}` : ''
              }`,
            ),
          ),
          h(
            'div',
            { className: 'sstrash-card-actions' },
            h('button', { type: 'button', className: 'sstrash-button sstrash-button-primary', disabled: busy, onClick: () => void restore(entry) }, t('panel.restore')),
            h('button', { type: 'button', className: 'sstrash-button sstrash-button-danger', disabled: busy, onClick: () => void purge(entry) }, t('panel.purge')),
          ),
        ),
      )

      return h(
        'div',
        { className: 'sstrash-page' },
        h(
          'div',
          { className: 'sstrash-head' },
          h('h2', { className: 'sstrash-title' }, t('panel.title')),
          h('p', { className: 'sstrash-subtitle' }, t('panel.subtitle')),
          h(
            'div',
            { className: 'sstrash-meta' },
            h('span', null, t('panel.entries', state.totals.entries ?? 0)),
            h('span', null, `${t('panel.bytes')} ${formatBytes(state.totals.bytes ?? 0)}`),
            state.home !== '' ? h('span', null, `${t('panel.home')}: ${state.home}`) : null,
          ),
        ),
        state.error !== null ? h('div', { className: 'sstrash-error' }, `${t('panel.error')}：${state.error}`) : null,
        notice !== null ? h('div', { className: 'sstrash-notice' }, notice) : null,
        h(
          'div',
          { className: 'sstrash-toolbar' },
          h('span', { className: 'sstrash-toolbar-spacer' }),
          h('button', { type: 'button', className: 'sstrash-button', disabled: busy || state.status === 'loading', onClick: () => void load() }, t('panel.refresh')),
          h('button', { type: 'button', className: 'sstrash-button sstrash-button-danger-solid', disabled: busy || entries.length === 0, onClick: () => void empty() }, t('panel.emptyTrash')),
        ),
        state.status === 'loading' && entries.length === 0
          ? h('div', { className: 'sstrash-empty' }, t('panel.loading'))
          : entries.length === 0
            ? h('div', { className: 'sstrash-empty' }, t('panel.empty'))
            : h('div', { className: 'sstrash-list' }, ...rows),
        h('p', { className: 'sstrash-hint' }, locale === 'zh' ? '提示：彻底删除会清理会话目录、投影缓存和工作区登记；共享附件不会被删除。' : 'Permanent deletion removes the session directory, projection cache and workspace registration. Shared attachments are kept.'),
      )
    }

    /**
     * Build the two session-row menu actions and their handlers.
     * @param {{contextMenus: any, slots: any}} ctx - client plugin context.
     * @returns {{register: () => void}} registration controller.
     */
    function createSessionActions(ctx) {
      const notify = (text, success, action) => ctx.contextMenus.notify(text, success, action)
      const fail = (error) => notify(t('failed', error instanceof Error ? error.message : String(error)), false)

      const moveToTrash = async (sessionId, displayTitle) => {
        try {
          let payload = await request('/trash', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: [sessionId], titles: { [sessionId]: displayTitle } }),
          })
          if (needsForce(payload)) {
            const ok = await confirmStore.ask({
              title: t('running.trashTitle'),
              body: t('running.trashBody', displayTitle || sessionId),
              confirmLabel: t('running.confirm'),
              danger: true,
            })
            if (!ok) return
            payload = await request('/trash', {
              method: 'POST',
              body: JSON.stringify({ sessionIds: [sessionId], titles: { [sessionId]: displayTitle }, force: true }),
            })
          }
          const moved = Array.isArray(payload.moved) ? payload.moved : []
          if (moved.length === 0) throw new Error(failureText(payload))
          const entryId = moved[0].entryId
          notify(t('toast.trashed'), true, {
            label: t('toast.undo'),
            failureLabel: t('toast.undoFailed'),
            run: async () => {
              const restored = await request('/restore', { method: 'POST', body: JSON.stringify({ entryIds: [entryId] }) })
              if (!Array.isArray(restored.restored) || restored.restored.length === 0) throw new Error(failureText(restored))
              window.setTimeout(() => window.location.reload(), 600)
            },
          })
        } catch (error) {
          fail(error)
        }
      }

      const purge = async (sessionId, displayTitle) => {
        const ok = await confirmStore.ask({
          title: t('confirm.purgeTitle'),
          body: t('confirm.purgeBody', displayTitle || sessionId),
          confirmLabel: t('confirm.purge'),
          danger: true,
        })
        if (!ok) return
        try {
          let payload = await request('/delete', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: [sessionId], titles: { [sessionId]: displayTitle } }),
          })
          if (needsForce(payload)) {
            const proceed = await confirmStore.ask({
              title: t('running.trashTitle'),
              body: t('running.deleteBody', displayTitle || sessionId),
              confirmLabel: t('running.confirm'),
              danger: true,
            })
            if (!proceed) return
            payload = await request('/delete', {
              method: 'POST',
              body: JSON.stringify({ sessionIds: [sessionId], titles: { [sessionId]: displayTitle }, force: true }),
            })
          }
          const deleted = Array.isArray(payload.deleted) ? payload.deleted : []
          if (deleted.length === 0) throw new Error(failureText(payload))
          notify(t('toast.purged'), true)
        } catch (error) {
          fail(error)
        }
      }

      return {
        trash: moveToTrash,
        purge,
      }
    }

    /** Client plugin entry point. */
    function apply(ctx) {
      ensureCss()
      const actions = createSessionActions(ctx)

      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: 'session-trash.actions',
            target: 'session',
            order: 700,
            resolve: ({ sessionId, displayTitle }) => [
              {
                id: 'trash',
                label: t('menu.trash'),
                icon: { key: 'session-trash.trash' },
                separatorBefore: true,
                run: () => actions.trash(sessionId, displayTitle),
              },
              {
                id: 'purge',
                label: t('menu.purge'),
                icon: { key: 'session-trash.purge' },
                danger: true,
                failureLabel: t('toast.purgeFailed'),
                run: () => actions.purge(sessionId, displayTitle),
              },
            ],
          }),
        'session-trash: session row menu actions',
      )

      ctx.slots.inject('contextMenu.icon', function* () {
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-trash.trash' }, TrashGlyph)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-trash.purge' }, PurgeGlyph)
      })

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-trash.confirm' }, ConfirmOverlay))

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({
              notify: (text, success) => ctx.contextMenus.notify(text, success === true),
            }),
          },
          TrashPanel,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: () => t('panel'),
          },
          PanelIcon,
        ),
      )
    }

    mod.exports.name = PLUGIN_ID
    mod.exports.inject = ['slots', 'contextMenus', 'layout']
    mod.exports.apply = apply
    return mod.exports
  },
})
