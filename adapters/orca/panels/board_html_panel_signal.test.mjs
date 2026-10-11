// The Board tells the worker it is open (T4b, odd/tasks/feature-modules.md):
// the worker refreshes the summaries the Board shows only while a panel is
// open, and the Board sends it no request that would say so. It writes its
// own key on every reload (every 8 s while visible, on focus and on a manual
// refresh) in the background lane, so a click's reserved quota is never
// spent on it. board.html is sandboxed HTML with no module graph, so the
// function is read from its source and evaluated here, and the key is
// checked against the one main.mjs reads.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const boardHtml = readFileSync(new URL('./board.html', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')

function extractFunction (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  assert.ok(startMatch, `function ${name} not found -- update this test if it moved or was renamed`)
  const start = startMatch.index
  let depth = 0
  let i = start + startMatch[0].length - 1
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

test('the Board writes the key main.mjs reads, with the time, in the background lane', () => {
  const key = mainSource.match(/const BOARD_PANEL_SEEN_KEY = '([^']+)'/)?.[1]
  assert.ok(key, 'main.mjs names the board signal key')
  assert.match(boardHtml, new RegExp(`var BOARD_PANEL_SEEN_KEY = '${key}'`))
  const calls = []
  const signal = new Function('call', 'BOARD_PANEL_SEEN_KEY', `${extractFunction(boardHtml, 'signalPanelOpen')}; return signalPanelOpen`)(
    (action, params, usuario) => { calls.push({ action, params, usuario }); return Promise.resolve({ ok: true }) },
    key
  )
  signal()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'storage.set')
  assert.equal(calls[0].params.key, key)
  assert.equal(Number.isNaN(Date.parse(calls[0].params.value.at)), false, 'an ISO time')
  assert.equal(calls[0].usuario, false, 'background lane')
})

test('every reload of the Board signals that it is open, before its reads', () => {
  const reload = extractFunction(boardHtml, 'reload')
  const signalAt = reload.indexOf('signalPanelOpen()')
  assert.ok(signalAt >= 0, 'reload signals')
  assert.ok(signalAt < reload.indexOf('Promise.all'), 'before the reads')
})
