import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWER, EXAMPLES, QUESTION, SHORT_ANSWER, simulate, SYSTEM, USER, type Action } from '../src/widgets/radixCacheSim.ts'

const chat = (who: number): Action => ({ kind: 'chat', who })
const tokens = (s: ReturnType<typeof simulate>) => s.nodes.reduce((n, v) => n + v.len, 0)

test('a second chat reuses the system prompt and splits the first chat off it', () => {
  const one = simulate([chat(0)], 64)
  assert.equal(one.last!.hit, 0)
  assert.equal(one.nodes.length, 1)
  const two = simulate([chat(0), chat(1)], 64)
  assert.equal(two.last!.hit, SYSTEM)
  assert.ok(two.last!.split)
  assert.equal(two.nodes.length, 3)
  assert.equal(two.used, SYSTEM + 2 * (USER + ANSWER))
})

test('the next turn of a chat finds its whole history, answer included', () => {
  const s = simulate([chat(0), chat(0), chat(0)], 64)
  assert.equal(s.last!.hit, SYSTEM + 2 * (USER + ANSWER))
  assert.equal(s.last!.prompt, SYSTEM + 2 * (USER + ANSWER) + USER)
})

test('a prompt sent again hits all but its last token', () => {
  const s = simulate([{ kind: 'fewshot' }, { kind: 'repeat' }], 64)
  assert.equal(s.last!.hit, EXAMPLES + QUESTION - 1)
  assert.equal(s.last!.blockHit, 16)
})

test('the tree never holds more than the pool and the least recently used leaf goes first', () => {
  const actions: Action[] = [chat(0), chat(1), chat(2), chat(0), chat(1), { kind: 'fewshot' }, chat(2), chat(0)]
  for (const pool of [32, 48, 64])
    for (let n = 1; n <= actions.length; n++) {
      const s = simulate(actions.slice(0, n), pool)
      assert.ok(s.used <= pool, `${pool} ${n}`)
      assert.equal(tokens(s), s.used)
      assert.ok(s.hits <= s.prompts && s.blockHits <= s.prompts)
    }
  // Pool 32: chat A (20 tokens), then chat B needs 8 more and fits; chat C needs 8 with 4 free, so A's tail goes.
  const s = simulate([chat(0), chat(1), chat(2)], 32)
  assert.deepEqual(
    s.last!.evicted.map((e) => e.label),
    ['A1'],
  )
  assert.equal(s.last!.hit, SYSTEM)
})

test('a request larger than the pool is refused and changes nothing', () => {
  const before = simulate([chat(0), chat(0)], 32)
  const after = simulate([chat(0), chat(0), chat(0)], 32)
  assert.ok(after.last!.refused)
  assert.equal(after.used, before.used)
  assert.equal(after.next.chat[0], SYSTEM + 3 * (USER + ANSWER))
  assert.equal(after.next.fewshot, EXAMPLES + QUESTION + SHORT_ANSWER)
})
