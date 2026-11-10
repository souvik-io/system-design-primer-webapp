import { useMemo, useState } from 'react'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'
import { ANSWER, BLOCK, CHATS, EXAMPLES, simulate, SYSTEM, USER, type Action } from './radixCacheSim'

// A radix-tree prefix cache over a small pool of KV slots (chapter 5.3). Each button sends one request; the tree
// shows what the cache holds afterwards. A node's width is its number of tokens, and it starts where its parent
// ends, so the distance from the left edge is the position in the prompt. The rules are in radixCacheSim.ts.

const PX = 9
const ROW = 46
const BOX = 26
const LEFT = 8

export default function RadixTree() {
  const [pool, setPool] = useState(48)
  const [actions, setActions] = useState<Action[]>([])
  const s = useMemo(() => simulate(actions, pool), [actions, pool])
  const send = (a: Action) => setActions((xs) => [...xs, a])
  const W = LEFT * 2 + 64 * PX
  const H = Math.max(s.rows, 3) * ROW + 8
  const pctOf = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–')
  const tooBig = (n: number | null) => n === null || n > pool
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

  let note: string
  let tone: 'good' | 'bad' | undefined
  const l = s.last
  if (!l) {
    note = `The pool holds ${pool} tokens of keys and values and the tree is empty. Every chat starts with the same ${SYSTEM}-token system prompt, and every few-shot question starts with the same ${EXAMPLES} tokens of examples. Send a request.`
  } else if (l.refused) {
    note = `${l.name} needs ${l.prompt + l.output} slots for its prompt and answer, and the pool has ${pool}. A request that cannot fit even in an empty pool is rejected. Choose a larger pool or reset.`
    tone = 'bad'
  } else {
    const parts = [
      l.hit === 0
        ? `${l.name}: none of its ${l.prompt} prompt tokens were in the tree, so all of them were computed.`
        : `${l.name}: the walk from the root matched ${l.hit} of ${l.prompt} prompt tokens (green), so only ${l.prompt - l.hit} ${l.prompt - l.hit === 1 ? 'was' : 'were'} computed.`,
    ]
    if (l.hit === l.prompt - 1 && l.hit > 0)
      parts.push('The whole prompt was cached, but its last token is always run again, because its output is the first new token.')
    if (l.split) parts.push('The match ended inside a node, so that node was split in two at the point where the prompts diverge.')
    if (l.evicted.length)
      parts.push(
        `The pool was short, so the least recently used ${l.evicted.length === 1 ? 'leaf was' : 'leaves were'} evicted: ${l.evicted.map((e) => `${e.label} (${e.len} tokens)`).join(', ')}.`,
      )
    parts.push(`Its ${count(l.prompt - l.hit, 'new prompt token')} and ${count(l.output, 'answer token')} are now in the tree (blue).`)
    if (l.blockHit !== l.hit) parts.push(`A cache of ${BLOCK}-token hashed blocks would have found ${l.blockHit}.`)
    note = parts.join(' ')
    tone = l.evicted.length ? undefined : l.hit ? 'good' : undefined
  }

  return (
    <WidgetFrame
      title="Try it: a radix tree over token prefixes"
      description="Each button sends one request to a server whose KV cache is indexed by a radix tree, as in SGLang. Watch the tree grow, split and evict, and compare how many prompt tokens each request found."
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Segmented
          label="Pool, tokens"
          value={pool}
          options={[32, 48, 64].map((p) => ({ value: p, label: String(p) }))}
          onChange={(v) => (setPool(v), setActions([]))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {CHATS.map((c, i) => (
          <Button
            key={c}
            tone="primary"
            onClick={() => send({ kind: 'chat', who: i })}
            disabled={tooBig(s.next.chat[i])}
            title={
              tooBig(s.next.chat[i])
                ? `This turn needs ${s.next.chat[i]} slots, more than the pool`
                : `History, a ${USER}-token message and a ${ANSWER}-token answer`
            }
          >
            Chat {c}: next turn
          </Button>
        ))}
        <Button onClick={() => send({ kind: 'fewshot' })} disabled={tooBig(s.next.fewshot)}>
          Few-shot question
        </Button>
        <Button onClick={() => send({ kind: 'repeat' })} disabled={tooBig(s.next.repeat)} title="Send the previous prompt once more">
          Same prompt again
        </Button>
        <Button onClick={() => setActions([])} disabled={actions.length === 0}>
          Reset
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full min-w-[34rem]"
          role="img"
          aria-label={`The radix tree after ${actions.length} requests: ${s.nodes.length} nodes holding ${s.used} tokens`}
        >
          <line x1={LEFT - 3} y1={4} x2={LEFT - 3} y2={H - 4} stroke="var(--ink-2)" strokeWidth={2} />
          {s.nodes.length === 0 && (
            <text x={LEFT + 8} y={ROW / 2 + 8} fontSize={12} fill="var(--muted)">
              root (empty tree)
            </text>
          )}
          {s.nodes.map((n) => {
            const x = LEFT + n.depth * PX
            const y = 6 + n.row * ROW
            const w = n.len * PX - 3
            const fits = n.label.length * 6 + 28 < w
            return (
              <g key={n.id}>
                {n.parentRow >= 0 && n.row !== n.parentRow && (
                  <path
                    d={`M ${x - 4} ${6 + n.parentRow * ROW + BOX} V ${y + BOX / 2} H ${x}`}
                    fill="none"
                    stroke="var(--ink-2)"
                    strokeOpacity={0.55}
                  />
                )}
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={BOX}
                  rx={4}
                  fill={n.state === 'matched' ? 'var(--done-soft)' : n.state === 'new' ? 'var(--accent-soft)' : 'var(--surface)'}
                  stroke={n.state === 'matched' ? 'var(--done)' : n.state === 'new' ? 'var(--accent)' : 'var(--muted)'}
                  strokeWidth={n.state === 'idle' ? 1 : 2}
                />
                {w >= 14 && (
                  <text
                    x={x + (fits ? 5 : w / 2)}
                    y={y + BOX / 2 + 4}
                    fontSize={11}
                    fontWeight={600}
                    fill="var(--ink)"
                    textAnchor={fits ? 'start' : 'middle'}
                  >
                    {fits ? `${n.label} · ${n.len}` : n.len}
                  </text>
                )}
                {w >= 20 && (
                  <text x={x + 2} y={y + BOX + 11} fontSize={9.5} fill="var(--muted)">
                    {w >= 56 ? `used #${n.last}` : `#${n.last}`}
                  </text>
                )}
                <title>{`${n.label}: ${n.len} tokens, last used by request ${n.last}`}</title>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="-mt-2 text-[0.75rem] leading-relaxed text-muted">
        A node's width is its token count and its left edge is its position in the prompt. Green nodes were matched by the last request, the blue node
        is what it added, and “used #n” (or “#n” under a short node) is the request that last touched it: among leaves, the lowest is evicted first.
        A2 is the message and answer of chat A's second turn, and Q1 is the first few-shot question with its answer.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Last request, cached"
          value={l && !l.refused ? `${l.hit} of ${l.prompt}` : '–'}
          tone={l && !l.refused && l.hit ? 'good' : undefined}
        />
        <Stat label="Hit rate so far" value={`${pctOf(s.hits, s.prompts)} (blocks ${pctOf(s.blockHits, s.prompts)})`} />
        <Stat label="Pool in use" value={`${s.used} of ${pool}`} tone={s.used > pool - 8 ? 'warn' : undefined} />
        <Stat label="Tokens evicted" value={`${s.evictedTokens}`} tone={s.evictedTokens ? 'warn' : undefined} />
      </div>

      <Narration tone={tone}>{note}</Narration>
    </WidgetFrame>
  )
}
