import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POOL, REQUESTS, simulate } from '../src/widgets/pagedKvSim.ts'

const settings = (['reserve', 'paged'] as const).flatMap((mode) => [2, 4, 8, 16].flatMap((bs) => ([1, 2] as const).map((n) => ({ mode, bs, n }))))

test('every setting finishes every request without over-filling the pool', () => {
  for (const { mode, bs, n } of settings) {
    const snaps = simulate(mode, bs, n)
    assert.equal(snaps[snaps.length - 1].finished, REQUESTS.length, `${mode} ${bs} ${n}`)
    for (const s of snaps) {
      assert.ok(s.used <= s.allocated && s.allocated <= POOL)
      if (mode === 'paged') assert.equal(s.allocated % bs, 0)
    }
  }
})

test('paging uses the pool better and finishes sooner than reserving the maximum length', () => {
  const reserve = simulate('reserve', 4, 1)
  const paged = simulate('paged', 4, 1)
  assert.ok(paged.length < reserve.length)
  const util = (snaps: typeof paged) => snaps.slice(1).reduce((a, s) => a + (s.allocated ? s.used / s.allocated : 0), 0) / (snaps.length - 1)
  assert.ok(util(paged) > 0.8 && util(reserve) < 0.6)
})

test('only paged mode preempts, and only paged mode with two samples copies on write', () => {
  assert.equal(simulate('reserve', 4, 2).at(-1)!.preemptions, 0)
  assert.ok(simulate('paged', 4, 1).at(-1)!.preemptions > 0)
  assert.equal(simulate('paged', 4, 1).at(-1)!.copies, 0)
  assert.ok(simulate('paged', 4, 2).at(-1)!.copies > 0)
})

test('shared blocks never have more owners than samples', () => {
  for (const s of simulate('paged', 4, 2)) for (const slot of s.slots) assert.ok(slot.shared <= 2)
})
