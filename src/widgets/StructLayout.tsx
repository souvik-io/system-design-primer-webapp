import { useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Button, Key, Narration, SERIES, Segmented, Stat, WidgetFrame } from './ui'

// Struct layout and padding for content/cpp/cpp-memory.md. The rules are the ones every mainstream 64-bit ABI uses
// (x86-64 System V, Windows x64, AArch64): each member goes at the next offset that is a multiple of its alignment,
// the struct's alignment is its largest member's, and sizeof is rounded up to a multiple of that alignment. For the
// types offered here, alignment equals size (an array takes its element's alignment).

type TypeId = 'bool' | 'int8' | 'u16' | 'int32' | 'float' | 'int64' | 'double' | 'ptr' | 'qs'

const TYPES: Record<TypeId, { label: string; size: number; align: number }> = {
  bool: { label: 'bool', size: 1, align: 1 },
  int8: { label: 'std::int8_t', size: 1, align: 1 },
  u16: { label: 'std::uint16_t', size: 2, align: 2 },
  int32: { label: 'std::int32_t', size: 4, align: 4 },
  float: { label: 'float', size: 4, align: 4 },
  int64: { label: 'std::int64_t', size: 8, align: 8 },
  double: { label: 'double', size: 8, align: 8 },
  ptr: { label: 'float*', size: 8, align: 8 },
  qs: { label: 'std::uint8_t[16]', size: 16, align: 1 },
}

type Field = { key: number; type: TypeId; name: string; hue: number }
type Preset = 'block' | 'q4' | 'small'

const PRESETS: Record<Preset, { label: string; fields: [TypeId, string][] }> = {
  block: {
    label: 'KV block info',
    fields: [
      ['bool', 'in_use'],
      ['int64', 'seq_id'],
      ['int32', 'ref_count'],
      ['bool', 'on_gpu'],
      ['double', 'last_used'],
      ['int32', 'num_tokens'],
    ],
  },
  q4: {
    label: 'llama.cpp Q4_0 block',
    fields: [
      ['u16', 'd'],
      ['qs', 'qs'],
    ],
  },
  small: {
    label: 'int8 then double',
    fields: [
      ['int8', 'tag'],
      ['double', 'value'],
    ],
  },
}

let nextKey = 0
const make = (fields: [TypeId, string][]): Field[] => fields.map(([type, name], hue) => ({ key: nextKey++, type, name, hue }))

type Piece = { kind: 'field'; start: number; size: number; index: number } | { kind: 'pad'; start: number; size: number }

function layout(fields: Field[]) {
  const pieces: Piece[] = []
  let offset = 0
  let align = 1
  fields.forEach((f, index) => {
    const t = TYPES[f.type]
    const pad = (t.align - (offset % t.align)) % t.align
    if (pad) pieces.push({ kind: 'pad', start: offset, size: pad })
    offset += pad
    pieces.push({ kind: 'field', start: offset, size: t.size, index })
    offset += t.size
    align = Math.max(align, t.align)
  })
  const tail = (align - (offset % align)) % align
  if (tail) pieces.push({ kind: 'pad', start: offset, size: tail })
  const size = fields.length ? offset + tail : 1
  const data = fields.reduce((s, f) => s + TYPES[f.type].size, 0)
  return { pieces, size, align, data, padding: fields.length ? size - data : 0 }
}

const color = (hue: number) => SERIES[hue % SERIES.length]

export default function StructLayout() {
  const [preset, setPreset] = useState<Preset>('block')
  const [fields, setFields] = useState<Field[]>(() => make(PRESETS.block.fields))
  const [adding, setAdding] = useState<TypeId>('int32')
  const { pieces, size, align, data, padding } = layout(fields)
  const sorted = [...fields].sort((a, b) => TYPES[b.type].align - TYPES[a.type].align)
  const best = layout(sorted).size
  const isSorted = sorted.every((f, i) => f.key === fields[i].key)

  const choose = (p: Preset) => {
    setPreset(p)
    setFields(make(PRESETS[p].fields))
  }
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const j = i + d
      if (j < 0 || j >= fs.length) return fs
      const copy = [...fs]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
  const remove = (i: number) => setFields((fs) => fs.filter((_, j) => j !== i))
  const add = () =>
    setFields((fs) => [...fs, { key: nextKey++, type: adding, name: `field${fs.length + 1}`, hue: Math.max(-1, ...fs.map((f) => f.hue)) + 1 }])

  // One cell per byte, eight bytes to a row, so an 8-byte member fills exactly one row when it is aligned.
  const cells: { piece: Piece; byte: number }[] = []
  for (const piece of pieces) for (let b = 0; b < piece.size; b++) cells.push({ piece, byte: piece.start + b })
  const rows = Math.ceil(Math.max(size, 1) / 8)

  return (
    <WidgetFrame
      title="Try it: lay out a struct"
      description="Each member sits at an offset that is a multiple of its alignment, and the compiler fills the gaps with padding. Reorder, add or remove members and watch sizeof change. Try: load the KV block info preset, then press “Largest alignment first”."
    >
      <Segmented
        label="Start from"
        value={preset}
        options={(Object.keys(PRESETS) as Preset[]).map((p) => ({ value: p, label: PRESETS[p].label }))}
        onChange={choose}
      />

      <div className="grid gap-4">
        <div className="space-y-1.5">
          <pre className="overflow-x-auto rounded-md bg-paper px-3 py-2 font-mono text-[0.8rem] leading-relaxed text-ink">
            {'struct S {\n'}
            {fields.map((f, i) => (
              <span key={f.key} className="flex items-center gap-2">
                <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: color(f.hue) }} aria-hidden />
                <span className="grow">
                  {'  '}
                  {TYPES[f.type].label} {f.name};
                </span>
                <span className="text-[0.7rem] text-muted tabular-nums">
                  offset {(pieces.find((p) => p.kind === 'field' && p.index === i) as Piece).start}
                </span>
                <button
                  type="button"
                  className="text-muted hover:text-ink disabled:opacity-30"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${f.name} up`}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="text-muted hover:text-ink disabled:opacity-30"
                  onClick={() => move(i, 1)}
                  disabled={i === fields.length - 1}
                  aria-label={`Move ${f.name} down`}
                >
                  <ArrowDown size={14} />
                </button>
                <button type="button" className="text-muted hover:text-bad" onClick={() => remove(i)} aria-label={`Remove ${f.name}`}>
                  <X size={14} />
                </button>
              </span>
            ))}
            {'};'}
          </pre>
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <select
              value={adding}
              onChange={(e) => setAdding(e.target.value as TypeId)}
              className="rounded-md border border-rule bg-surface px-2 py-1.5 text-ink"
              aria-label="Type of the member to add"
            >
              {(Object.keys(TYPES) as TypeId[]).map((t) => (
                <option key={t} value={t}>
                  {TYPES[t].label} (size {TYPES[t].size}, align {TYPES[t].align})
                </option>
              ))}
            </select>
            <Button onClick={add} disabled={fields.length >= 10}>
              Add member
            </Button>
            <Button onClick={() => setFields(sorted)} disabled={isSorted} tone="primary">
              Largest alignment first
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-1 grid grid-cols-[2.5rem_repeat(8,1.5rem)] gap-0.5 text-center text-[0.65rem] text-muted tabular-nums">
            <span />
            {Array.from({ length: 8 }, (_, b) => (
              <span key={b}>+{b}</span>
            ))}
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="mb-0.5 grid grid-cols-[2.5rem_repeat(8,1.5rem)] gap-0.5">
              <span className="pr-1 text-right text-[0.65rem] leading-6 text-muted tabular-nums">{r * 8}</span>
              {Array.from({ length: 8 }, (_, b) => {
                const cell = cells.find((c) => c.byte === r * 8 + b)
                if (!cell) return <span key={b} />
                const p = cell.piece
                return p.kind === 'field' ? (
                  <span
                    key={b}
                    className="h-6 rounded-sm"
                    style={{ background: color(fields[p.index].hue) }}
                    title={`${fields[p.index].name}, byte ${cell.byte}`}
                  />
                ) : (
                  <span
                    key={b}
                    className="h-6 rounded-sm border border-dashed border-muted/60"
                    style={{ background: 'repeating-linear-gradient(135deg, transparent 0 3px, var(--rule) 3px 5px)' }}
                    title={`padding, byte ${cell.byte}`}
                  />
                )
              })}
            </div>
          ))}
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
            <Key color="var(--w1)">a member</Key>
            <Key color="var(--rule)">padding</Key>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="sizeof(S)" value={`${size} bytes`} />
        <Stat label="alignof(S)" value={align} />
        <Stat label="Padding" value={`${padding} bytes`} tone={padding > data / 3 ? 'warn' : undefined} />
        <Stat label="A million of them" value={`${size} MB`} />
      </div>

      <Narration tone={fields.length && isSorted && size === data ? 'good' : undefined}>
        {!fields.length
          ? 'A struct with no members still has sizeof 1, because every object must have its own address.'
          : padding === 0
            ? `No padding: the ${data} bytes of members pack exactly. ${preset === 'q4' && size === 18 ? 'llama.cpp relies on this: block_q4_0 is 18 bytes, and its alignment of 2 lets blocks sit back to back in a file and in memory.' : ''}`
            : best < size
              ? `${padding} of the ${size} bytes are padding. Sorting the members from largest alignment to smallest would make the struct ${best} bytes, ${Math.round((1 - best / size) * 100)}% smaller, with the same members.`
              : `${padding} bytes are padding, and no order of these members does better: ${size} is the smallest multiple of the alignment, ${align}, that holds ${data} bytes of members.`}
      </Narration>
    </WidgetFrame>
  )
}
