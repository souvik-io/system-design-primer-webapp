import { useState } from 'react'
import clsx from 'clsx'
import { Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// A tensor is a pointer to storage plus a shape, strides and a storage offset (content/cpp/cpp-pointers.md).
// The storage holds the values 0 to n - 1 in row-major order, like torch.arange(n).reshape(rows, cols).
// Each operation below builds a new view the way PyTorch does: transpose swaps shape and strides, indexing a row
// or column drops a dimension and moves the offset, and step slicing multiplies a stride. Only .contiguous()
// on a non-contiguous view copies the data into new storage. is_contiguous follows PyTorch's rule: every
// dimension of size greater than 1 must have a stride equal to the product of the sizes after it.

type ShapeKey = '2x3' | '3x4' | '4x4'
type Op = 'none' | 'T' | 'row' | 'col' | 'step' | 'rows' | 'Tcontig'

type View = { shape: number[]; strides: number[]; offset: number; storage: number[]; copied: boolean }

const SHAPES: { value: ShapeKey; label: string }[] = [
  { value: '2x3', label: '2 × 3' },
  { value: '3x4', label: '3 × 4' },
  { value: '4x4', label: '4 × 4' },
]

const OPS: { value: Op; label: string; code: string }[] = [
  { value: 'none', label: 't', code: 't' },
  { value: 'T', label: 't.T', code: 't.T' },
  { value: 'row', label: 't[1]', code: 't[1]' },
  { value: 'col', label: 't[:, 1]', code: 't[:, 1]' },
  { value: 'step', label: 't[:, ::2]', code: 't[:, ::2]' },
  { value: 'rows', label: 't[1:]', code: 't[1:]' },
  { value: 'Tcontig', label: 't.T.contiguous()', code: 't.T.contiguous()' },
]

function dims(key: ShapeKey) {
  const [r, c] = key.split('x').map(Number)
  return { rows: r, cols: c }
}

function makeView(key: ShapeKey, op: Op): View {
  const { rows, cols } = dims(key)
  const storage = Array.from({ length: rows * cols }, (_, i) => i)
  const base = { storage, copied: false }
  switch (op) {
    case 'none':
      return { ...base, shape: [rows, cols], strides: [cols, 1], offset: 0 }
    case 'T':
      return { ...base, shape: [cols, rows], strides: [1, cols], offset: 0 }
    case 'row':
      return { ...base, shape: [cols], strides: [1], offset: cols }
    case 'col':
      return { ...base, shape: [rows], strides: [cols], offset: 1 }
    case 'step':
      return { ...base, shape: [rows, Math.ceil(cols / 2)], strides: [cols, 2], offset: 0 }
    case 'rows':
      return { ...base, shape: [rows - 1, cols], strides: [cols, 1], offset: cols }
    case 'Tcontig': {
      // A new block of memory holding the transpose in row-major order.
      const copy: number[] = []
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) copy.push(i + j * cols)
      return { storage: copy, copied: true, shape: [cols, rows], strides: [rows, 1], offset: 0 }
    }
  }
}

function isContiguous(v: View) {
  let expected = 1
  for (let d = v.shape.length - 1; d >= 0; d--) {
    if (v.shape[d] > 1 && v.strides[d] !== expected) return false
    expected *= v.shape[d]
  }
  return true
}

/** Every index of the view, as [i] or [i, j]. */
function indices(v: View): number[][] {
  if (v.shape.length === 1) return Array.from({ length: v.shape[0] }, (_, i) => [i])
  const out: number[][] = []
  for (let i = 0; i < v.shape[0]; i++) for (let j = 0; j < v.shape[1]; j++) out.push([i, j])
  return out
}

const flat = (v: View, idx: number[]) => v.offset + idx.reduce((sum, x, d) => sum + x * v.strides[d], 0)
const tuple = (xs: number[]) => (xs.length === 1 ? `(${xs[0]},)` : `(${xs.join(', ')})`)

export default function TensorStrides() {
  const [shapeKey, setShapeKey] = useState<ShapeKey>('2x3')
  const [op, setOp] = useState<Op>('none')
  const [picked, setPicked] = useState<number[]>([0, 1])

  const v = makeView(shapeKey, op)
  const all = indices(v)
  // Keep the picked element inside the current view.
  const sel = all.find((idx) => idx.length === picked.length && idx.every((x, d) => x === picked[d])) ?? all[Math.min(1, all.length - 1)]
  const selFlat = flat(v, sel)
  const used = new Set(all.map((idx) => flat(v, idx)))
  const contiguous = isContiguous(v)
  const code = OPS.find((o) => o.value === op)!.code

  const rows = v.shape.length === 1 ? 1 : v.shape[0]
  const cols = v.shape.length === 1 ? v.shape[0] : v.shape[1]
  const formula =
    v.shape.length === 1
      ? `${v.offset} + ${sel[0]} × ${v.strides[0]} = ${selFlat}`
      : `${v.offset} + ${sel[0]} × ${v.strides[0]} + ${sel[1]} × ${v.strides[1]} = ${selFlat}`

  const notes: Record<Op, string> = {
    none: 'The original row-major tensor: moving one column along skips 1 element, and moving one row down skips a whole row.',
    T: 'Transposing swaps the shape and the strides and copies nothing. Walking along a row of the view now jumps through memory, so the view is not contiguous.',
    row: 'Indexing one row drops a dimension and moves the storage offset to the start of that row. The row is still one unbroken run of memory, so it is contiguous.',
    col: 'A column is a strided view: consecutive elements are a whole row apart in memory, so it is not contiguous, although no data moved.',
    step: 'Step slicing multiplies the column stride by 2. The view skips every other element of each row, with no copy.',
    rows: 'Dropping the first row only moves the storage offset. The remaining rows are still back to back, so the view is contiguous.',
    Tcontig:
      '.contiguous() on a non-contiguous view allocates new storage and copies the elements into row-major order for the view’s shape. The strides become ordinary row-major strides again.',
  }

  return (
    <WidgetFrame
      title="Try it: one block of memory, many views"
      description="The bottom row is the tensor's storage, the flat block of floats a pointer points at. The grid is the view you index. Pick an operation and click an element to see where it lives. Try t.T, and notice the strides swap while the storage stays the same. Then try t.T.contiguous() and watch new storage appear."
    >
      <Segmented label="Shape of t" value={shapeKey} options={SHAPES} onChange={setShapeKey} />
      <Segmented label="View" value={op} options={OPS.map(({ value, label }) => ({ value, label }))} onChange={setOp} />

      <div className="space-y-1.5">
        <div className="font-mono text-[0.8125rem] text-muted">{code}</div>
        <div
          className="inline-grid gap-1"
          style={{ gridTemplateColumns: `repeat(${cols}, 2.5rem)` }}
          role="grid"
          aria-label={`View of shape ${tuple(v.shape)}`}
        >
          {all.map((idx) => {
            const k = flat(v, idx)
            const on = idx.every((x, d) => x === sel[d])
            return (
              <button
                key={idx.join(',')}
                type="button"
                onClick={() => setPicked(idx)}
                aria-pressed={on}
                aria-label={`Element ${idx.join(', ')}, value ${v.storage[k]}, storage index ${k}`}
                className={clsx(
                  'h-10 rounded-md border font-mono text-[0.875rem] tabular-nums',
                  on ? 'border-accent bg-accent text-on-accent' : 'border-rule bg-surface text-ink hover:border-accent/60',
                )}
              >
                {v.storage[k]}
              </button>
            )
          })}
        </div>
        {rows > 1 && <div className="text-[0.75rem] text-muted">Click any element.</div>}
      </div>

      <div className="space-y-1">
        <div className="text-[0.8125rem] text-muted">{v.copied ? 'New storage (a copy)' : 'Storage (unchanged by every view)'}</div>
        <div className="flex flex-wrap gap-1">
          {v.storage.map((val, k) => (
            <div key={k} className="flex flex-col items-center">
              <div
                className={clsx(
                  'flex h-9 w-9 items-center justify-center rounded border font-mono text-[0.8125rem] tabular-nums',
                  k === selFlat
                    ? 'border-accent bg-accent text-on-accent'
                    : used.has(k)
                      ? 'border-accent/40 bg-accent-soft text-ink'
                      : 'border-rule bg-paper text-muted',
                )}
              >
                {val}
              </div>
              <span className="text-[0.6875rem] text-muted tabular-nums">{k}</span>
            </div>
          ))}
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
          <Key color="var(--accent)">the element you picked</Key>
          <Key color="var(--accent-soft)">read by this view</Key>
          <Key color="var(--rule)">not in this view</Key>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="shape" value={tuple(v.shape)} />
        <Stat label="stride()" value={tuple(v.strides)} />
        <Stat label="storage_offset()" value={v.offset} />
        <Stat label="is_contiguous()" value={contiguous ? 'True' : 'False'} tone={contiguous ? 'good' : 'warn'} />
      </div>

      <Narration>
        Element [{sel.join('][')}] lives at offset + index × stride: {formula}, so it reads storage[{selFlat}], which holds {v.storage[selFlat]}.{' '}
        {notes[op]}
      </Narration>
    </WidgetFrame>
  )
}
