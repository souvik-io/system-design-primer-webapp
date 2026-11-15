import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestK, breakEven, expectedTokens, pass, samplePasses, type Gpu } from '../src/widgets/specDecodeSim.ts'

const near = (a: number, b: number, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`)
const memoryBound: Gpu = { name: 'weights only', fixed: 10, perToken: 0 }
const gpu: Gpu = { name: 'test', fixed: 6, perToken: 0.02 }

test('tokens per pass follow the capped geometric formula', () => {
  near(expectedTokens(0.8, 4), 3.362)
  near(expectedTokens(0.6, 5), 2.383)
  assert.equal(expectedTokens(1, 5), 6)
  assert.equal(expectedTokens(0, 5), 1)
  assert.equal(expectedTokens(0.9, 0), 1)
})

test('with free verification the speed-up is the paper’s formula', () => {
  // Leviathan et al., Table 1: alpha 0.8, gamma 5, c 0 gives 3.69x, and Theorem 3.8 divides by gamma * c + 1.
  near(pass(memoryBound, 1, 0.8, 5, 0).speedup, 3.69)
  // A drafter step of 1 ms against a 10 ms pass is c = 0.1.
  near(pass(memoryBound, 1, 0.8, 4, 1).speedup, 3.362 / 1.4)
  near(pass(memoryBound, 64, 0.8, 4, 1).speedup, 3.362 / 1.4)
})

test('a drafter that is always wrong only adds cost', () => {
  const p = pass(gpu, 8, 0, 3, 0.3)
  assert.equal(p.tokens, 1)
  assert.ok(p.speedup < 1)
  near(p.wasted, 0.75)
})

test('the speed-up falls as the batch grows and ends below 1', () => {
  const batches = [1, 4, 16, 64, 256, 1024]
  const s = batches.map((b) => pass(gpu, b, 0.7, 3, 0.2).speedup)
  for (let i = 1; i < s.length; i++) assert.ok(s[i] < s[i - 1])
  assert.ok(s[0] > 2)
  assert.ok(s[s.length - 1] < 1)
  const edge = breakEven(gpu, batches, 0.7, 3, 0.2)
  assert.ok(edge >= 16 && edge < 1024)
  assert.equal(breakEven(gpu, batches, 0, 3, 0.2), 0)
})

test('a compute-bound step can never gain: the limit is tokens / (k + 1)', () => {
  const computeBound: Gpu = { name: 'compute only', fixed: 0, perToken: 1 }
  near(pass(computeBound, 32, 0.9, 3, 0).speedup, expectedTokens(0.9, 3) / 4)
  assert.ok(pass(computeBound, 32, 0.99, 8, 0).speedup < 1)
})

test('the best draft length shrinks with the batch and with the acceptance rate', () => {
  assert.ok(bestK(gpu, 1, 0.9, 0.2, 8) > bestK(gpu, 256, 0.9, 0.2, 8))
  assert.ok(bestK(gpu, 1, 0.9, 0.2, 8) > bestK(gpu, 1, 0.4, 0.2, 8))
})

test('sampled passes are stable and average to the formula', () => {
  assert.deepEqual(samplePasses(0.7, 4, 16), samplePasses(0.7, 4, 16))
  const many = samplePasses(0.7, 4, 20000, 3)
  assert.ok(many.every((n) => n >= 0 && n <= 4))
  near(many.reduce((a, b) => a + b, 0) / many.length + 1, expectedTokens(0.7, 4), 0.05)
})

test('the H100 preset reproduces the measured EAGLE-3 runs within about a tenth', () => {
  // spec_decode_h100.json, chat workload, EAGLE-3 head: acceptance length 2.45 with 3 draft tokens is alpha 0.68.
  const h100: Gpu = { name: 'H100', fixed: 6.4, perToken: 0.018 }
  near(expectedTokens(0.68, 3), 2.45, 0.02)
  near(pass(h100, 1, 0.68, 3, 0.45).speedup, 2.03, 0.1) // measured 2.03x
  near(pass(h100, 32, 0.68, 3, 0.45).speedup, 1.76, 0.12) // measured 1.76x
  near(pass(h100, 128, 0.68, 3, 0.45).speedup, 1.17, 0.12) // measured 1.17x
  assert.ok(pass(h100, 128, 0.66, 5, 0.45).speedup < 1.1) // measured 0.92x with 5 draft tokens
  assert.ok(pass(h100, 1, 0.74, 5, 4.9).speedup < 0.8) // the 1B draft model: measured 0.66x
})
