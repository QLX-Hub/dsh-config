import assert from 'node:assert/strict'

/* ------------------------------------------------------------------ browser stub */

const registrations = []
const effects = []
const notifications = []
const fetches = []

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
    },
  },
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init })
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, moved: [{ entryId: 'entry-1', sessionId: 'session-x', title: 'X', bytes: 10 }], deleted: [] }
    },
  }
}

const React = {
  createElement(type, props, ...children) {
    return { type, props, children }
  },
  useReducer() {
    return [0, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useState(value) {
    return [typeof value === 'function' ? value() : value, () => {}]
  },
}
const require = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}

/* ------------------------------------------------------------------ load bundle */

await import('../lib/client.js')
assert.equal(registrations.length, 1)
assert.equal(registrations[0].id, 'dsh-session-trash-bin')

const mod = registrations[0].factory(require)
assert.equal(mod.name, 'session-trash')
assert.deepEqual(mod.inject, ['slots', 'contextMenus', 'layout'])
assert.equal(typeof mod.apply, 'function')

/* --------------------------------------------------------------- fake plugin ctx */

const menus = []
const slots = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return () => {}
  },
  contextMenus: {
    register(input) {
      menus.push(input)
      return () => {}
    },
    notify(...args) {
      notifications.push(args)
    },
  },
  slots: {
    inject(name, factory) {
      const result = factory()
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        for (const registration of result) void registration
      }
    },
    register(descriptor, Component) {
      slots.push({ descriptor, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)

/* ------------------------------------------------------------- assertions */

const menu = menus.find((entry) => entry.id === 'session-trash.actions')
assert.ok(menu, 'session row menu contribution is registered')
assert.equal(menu.target, 'session')
assert.equal(menu.order, 700)
const actions = menu.resolve({ sessionId: 'session-x', displayTitle: 'X' })
assert.equal(actions.length, 2)
assert.equal(actions[0].label, '删除会话（放入回收站）')
assert.equal(actions[1].label, '彻底删除会话')
assert.equal(actions[0].separatorBefore, true)
assert.equal(actions[1].danger, true)
assert.equal(actions[0].icon.key, 'session-trash.trash')
assert.equal(actions[1].icon.key, 'session-trash.purge')
assert.equal(typeof actions[0].run, 'function')
assert.equal(typeof actions[1].run, 'function')

assert.ok(slots.some((item) => item.descriptor.name === 'contextMenu.icon' && item.descriptor.key === 'session-trash.trash'))
assert.ok(slots.some((item) => item.descriptor.name === 'contextMenu.icon' && item.descriptor.key === 'session-trash.purge'))
assert.ok(slots.some((item) => item.descriptor.name === 'main' && item.descriptor.key === 'session-trash'))
assert.ok(slots.some((item) => item.descriptor.name === 'sidebar.panellist' && item.descriptor.id === 'session-trash'))
assert.ok(slots.some((item) => item.descriptor.name === 'shell.overlay' && item.descriptor.id === 'session-trash.confirm'))

await actions[0].run()
assert.equal(fetches.length, 1)
assert.match(fetches[0].url, /\/api\/session-trash\/trash$/u)
const sent = JSON.parse(fetches[0].init.body)
assert.deepEqual(sent.sessionIds, ['session-x'])
assert.equal(sent.titles['session-x'], 'X')
assert.equal(notifications.length, 1)
assert.equal(notifications[0][0], '已移入回收站')
assert.equal(notifications[0][1], true)
assert.equal(notifications[0][2].label, '撤销')
assert.equal(typeof notifications[0][2].run, 'function')

console.log('ok - client bundle registers two session menu actions, icons, panel and overlay')
