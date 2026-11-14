import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyFilters, draw, type Dist } from '../src/widgets/samplingSim.ts'

const data = JSON.parse(readFileSync(new URL('../src/widgets/data/sampling-distributions.json', import.meta.url), 'utf8'))
const dists: Dist[] = data.contexts
const off = { temperature: 1, topK: 0, topP: 1, minP: 0 }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

test('with no filter every token can be drawn and the probabilities add up to 1', () => {
  for (const d of dists) {
    const r = applyFilters(d, off)
    assert.equal(r.keptTokens, d.vocab)
    assert.ok(Math.abs(r.keptMass - 1) < 1e-9)
    assert.ok(Math.abs(sum(r.after.slice(0, 20)) + r.tailAfter - 1) < 1e-6)
  }
})

test('greedy keeps one token, top-k keeps k', () => {
  for (const d of dists) {
    assert.equal(applyFilters(d, { ...off, temperature: 0 }).keptTokens, 1)
    for (const k of [1, 5, 50, 500]) assert.equal(applyFilters(d, { ...off, topK: k }).keptTokens, k)
  }
})

test('top-p keeps the smallest set reaching p, so a peaked distribution keeps fewer tokens than a flat one', () => {
  const [peaked, , flat] = dists
  const a = applyFilters(peaked, { ...off, topP: 0.9 })
  const b = applyFilters(flat, { ...off, topP: 0.9 })
  assert.ok(a.keptMass >= 0.9 && a.keptMass < 0.95)
  assert.ok(b.keptMass >= 0.9 && b.keptMass < 0.91)
  assert.ok(a.keptTokens < 40 && b.keptTokens > 1000)
})

test('min-p removes tokens below min_p times the top probability, and its cut rises with temperature', () => {
  const d = dists[0]
  const r = applyFilters(d, { ...off, minP: 0.1 })
  r.before.forEach((p, i) => assert.equal(r.after[i] > 0, p >= 0.1 * r.before[0]))
  const hot = applyFilters(d, { ...off, temperature: 2, minP: 0.1 })
  assert.ok(hot.keptTokens > r.keptTokens)
})

test('the filters only remove probability, and the kept tokens are renormalized', () => {
  for (const d of dists) {
    const r = applyFilters(d, { temperature: 0.8, topK: 50, topP: 0.9, minP: 0.02 })
    assert.ok(r.keptMass <= 1)
    r.after.forEach((p, i) => assert.ok(p === 0 || p >= r.before[i] - 1e-12))
    assert.ok(Math.abs(sum(r.after) - 1) < 1e-6, 'with top-k 50 every kept token is in the top 300')
  }
})

test('draws come from kept tokens only', () => {
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const d = dists[0]
  const r = applyFilters(d, { ...off, topK: 3 })
  for (const t of draw(d, r, 200, rand)) assert.ok(d.top.slice(0, 3).some(([s]) => s === t))
})
