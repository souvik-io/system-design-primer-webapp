import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'
import trace from './data/vllm-request-trace.json'

// A real trace of two streamed chat requests through vLLM 0.32.0 serving Llama 3.1 8B on a Modal H100, recorded by
// public/labs/infra/gpu/inside_vllm.py (content/infra/inside-vllm.md). Each row is one traced call between the
// moment the client sent the request and the moment its first chunk arrived:
// [start ms after the send, duration ms, "process / thread", function label, note].

type Row = [number, number, string, string, string]
const REQUESTS = trace.requests as unknown as { title: string; ttft_ms: number; total_ms: number; chunks: number; rows: Row[] }[]

const LANES = [
  { key: 'API server / MainThread', label: 'API server process: asyncio event loop', color: 'var(--w1)' },
  { key: 'engine core / Thread-2 (process_input_sockets)', label: 'Engine core process: input thread', color: 'var(--w5)' },
  { key: 'engine core / MainThread', label: 'Engine core process: main loop', color: 'var(--w3)' },
  { key: 'engine core / Thread-3 (process_output_sockets)', label: 'Engine core process: output thread', color: 'var(--w4)' },
]

const ABOUT: Record<string, { file: string; what: string }> = {
  'HTTP handler: create_chat_completion': {
    file: 'entrypoints/openai/chat_completion/serving.py',
    what: 'FastAPI has parsed the JSON body into a ChatCompletionRequest. This handler validates it, renders the prompt, starts generation and returns a generator that the response streams from.',
  },
  'render: chat template and tokenize': {
    file: 'entrypoints/openai/chat_completion/serving.py',
    what: 'The chat template turns the messages into one string and the tokenizer turns that into about 2,000 token ids. It is most of the time this request spends in the API server.',
  },
  'AsyncLLM._add_request': {
    file: 'v1/engine/async_llm.py',
    what: 'Registers the request with the output processor, which will detokenize its tokens, and then hands it to the engine core.',
  },
  'client: send request over ZeroMQ': {
    file: 'v1/engine/core_client.py',
    what: "The engine core is another process, so the request is serialized and written to a ZeroMQ socket. The API server's event loop is free again as soon as this returns.",
  },
  'msgpack encode': {
    file: 'v1/serial_utils.py',
    what: 'Requests and outputs cross the process boundary as msgpack, encoded by msgspec. An output message with one token takes about ten microseconds to encode.',
  },
  'msgpack decode': {
    file: 'v1/serial_utils.py',
    what: 'The receiving side decodes the msgpack bytes back into an EngineCoreRequest or an EngineCoreOutputs object.',
  },
  'core: preprocess_add_request (block hashes)': {
    file: 'v1/engine/core.py',
    what: "Builds the scheduler's Request object and hashes the prompt block by block, 16 tokens at a time, each hash chained to the one before. It runs on the input thread, so it overlaps with the main loop's GPU work.",
  },
  'core: _handle_client_request': {
    file: 'v1/engine/core.py',
    what: 'The main loop takes the request off its input queue between two steps.',
  },
  'Scheduler.add_request': {
    file: 'v1/core/sched/scheduler.py',
    what: 'Appends the request to the waiting queue. Nothing is allocated yet.',
  },
  'EngineCore.step_with_batch_queue': {
    file: 'v1/engine/core.py',
    what: 'One iteration of the engine: schedule a batch, hand it to the model runner, and, if nothing more can be scheduled, wait for the oldest batch still on the GPU and process its output.',
  },
  'Scheduler.schedule': {
    file: 'v1/core/sched/scheduler.py',
    what: 'Decides which requests run this step and how many tokens each, within the token budget: running requests first, then waiting ones.',
  },
  'KVCacheManager.get_computed_blocks': {
    file: 'v1/core/kv_cache_manager.py',
    what: "Looks up the request's block hashes in the prefix cache and returns the longest run of blocks that some earlier request already computed.",
  },
  'KVCacheManager.allocate_slots': {
    file: 'v1/core/kv_cache_manager.py',
    what: 'Takes blocks from the free queue for the tokens scheduled this step. If it returns nothing, the scheduler preempts a request.',
  },
  'GPUModelRunner.execute_model (V2)': {
    file: 'v1/worker/gpu/model_runner.py',
    what: 'Copies token ids, positions and block tables to the GPU and launches the forward pass: one replay of a full CUDA graph for a batch of decodes, or a piecewise graph for a batch with a prefill. It returns before the GPU has finished.',
  },
  'runner: prepare_inputs': {
    file: 'v1/worker/gpu/model_runner.py',
    what: "Writes this step's token ids, positions and per-request lengths into buffers that live on the GPU for the life of the server, so a CUDA graph can read them from fixed addresses.",
  },
  'runner: prepare_attn': {
    file: 'v1/worker/gpu/model_runner.py',
    what: "Builds what attention needs: each request's block table and the slot in the KV cache where each new token's keys and values go.",
  },
  'runner: replay full CUDA graph': {
    file: 'v1/worker/gpu/cudagraph_utils.py',
    what: 'A batch that is all decodes replays one CUDA graph captured at startup for its size. The whole forward pass is launched in a few hundredths of a millisecond.',
  },
  'runner: run piecewise CUDA graphs': {
    file: 'v1/worker/gpu/cudagraph_utils.py',
    what: 'A batch with a prefill in it runs the compiled model as a chain of smaller CUDA graphs with the attention kernel called between them, which takes far longer to launch than one full graph.',
  },
  'GPUModelRunner.sample_tokens (V2)': {
    file: 'v1/worker/gpu/model_runner.py',
    what: 'Launches sampling on the GPU and a non-blocking copy of the sampled tokens to the CPU. It also returns before the GPU has finished.',
  },
  'AsyncOutput.get_output: wait for the GPU': {
    file: 'v1/worker/gpu/async_utils.py',
    what: 'The main loop has nothing left to schedule, so it blocks here until the GPU has finished the oldest batch and copied its sampled tokens back.',
  },
  'Scheduler.update_from_output': {
    file: 'v1/core/sched/scheduler.py',
    what: 'Appends each sampled token to its request, checks stop conditions, frees finished requests and builds the output that goes back to the API server.',
  },
  'OutputProcessor.process_outputs: detokenize': {
    file: 'v1/engine/output_processor.py',
    what: "Back in the API server, turns the new token ids into text incrementally and puts the result on the request's queue, from which the HTTP response writes a server-sent event.",
  },
}

const W = 540
const PAD = 6
const ROW = 17

export default function RequestTrace() {
  const [which, setWhich] = useState(0)
  const [view, setView] = useState('all')
  const [picked, setPicked] = useState(0)
  const req = REQUESTS[which]
  const rows = req.rows

  const depth = useMemo(
    () =>
      rows.map(
        (r, i) => rows.filter((o, j) => j !== i && o[2] === r[2] && o[0] <= r[0] && o[0] + o[1] >= r[0] + r[1] && (o[1] > r[1] || j < i)).length,
      ),
    [rows],
  )
  const firstStep = rows.find((r) => r[3].startsWith('EngineCore.step'))!
  const add = rows.find((r) => r[3] === 'AsyncLLM._add_request')!
  const windows: Record<string, [number, number]> = {
    all: [0, req.ttft_ms * 1.02],
    api: [0, add[0] + 1],
    handoff: [add[0] - 0.2, firstStep[0] + 0.7],
    last: [req.ttft_ms - 3.2, req.ttft_ms + 0.2],
  }
  const [t0, t1] = windows[view]
  const x = (t: number) => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD)

  let y = 32
  const lanes = LANES.map((lane) => {
    const maxDepth = Math.max(0, ...rows.map((r, i) => (r[2] === lane.key ? depth[i] : 0)))
    const top = y
    y += (maxDepth + 1) * ROW + 30
    return { ...lane, top }
  })
  const H = y + 22
  const sel = rows[picked] ?? rows[0]
  const about = ABOUT[sel[3]]
  const ticks = Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5)
  const pick = (i: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, i))
    setPicked(next)
    if (rows[next][0] < t0 || rows[next][0] > t1) setView('all') // keep the selected call on screen
  }

  return (
    <WidgetFrame
      title="Try it: one request through vLLM"
      description={`Two real requests to vLLM ${trace.vllm} serving Llama 3.1 8B on an H100, traced from the moment the client sent them to the arrival of the first streamed chunk. Both have the same 2,000-token system prompt. Step through the calls, zoom into the hand-off between the two processes, then switch to the second request and find what changed.`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Segmented
          label="Request"
          value={which}
          options={[
            { value: 0, label: '1: nothing cached' },
            { value: 1, label: '2: same system prompt' },
          ]}
          onChange={(v) => (setWhich(v), setPicked(0))}
        />
        <Segmented
          label="Zoom"
          value={view}
          options={[
            { value: 'all', label: 'To first token' },
            { value: 'api', label: 'API server' },
            { value: 'handoff', label: 'Hand-off' },
            { value: 'last', label: 'Last 3 ms' },
          ]}
          onChange={setView}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[28rem]" role="img" aria-label={`Timeline of ${req.title}`}>
          <text x={PAD} y={12} fontSize={11.5} fill="var(--muted)">
            Client
          </text>
          {[
            [0, 'request sent'],
            [req.ttft_ms, 'first chunk arrives'],
          ].map(([t, label]) =>
            (t as number) >= t0 && (t as number) <= t1 ? (
              <g key={label}>
                <line x1={x(t as number)} x2={x(t as number)} y1={16} y2={H - 20} stroke="var(--ink-2)" strokeDasharray="3 3" strokeOpacity={0.6} />
                <text x={x(t as number) + (t === 0 ? 4 : -4)} y={25} fontSize={11} textAnchor={t === 0 ? 'start' : 'end'} fill="var(--ink)">
                  {label}
                </text>
              </g>
            ) : null,
          )}
          {lanes.map((lane) => (
            <g key={lane.key}>
              <line x1={PAD} x2={W - PAD} y1={lane.top + 4} y2={lane.top + 4} stroke="var(--rule)" />
              <text x={PAD} y={lane.top + 17} fontSize={11.5} fill="var(--muted)">
                {lane.label}
              </text>
              {rows.map((r, i) => {
                if (r[2] !== lane.key || r[0] + r[1] < t0 || r[0] > t1) return null
                const x0 = Math.max(PAD, x(r[0]))
                const x1 = Math.min(W - PAD, x(r[0] + r[1]))
                const wait = r[3].startsWith('AsyncOutput')
                return (
                  <rect
                    key={i}
                    x={x0}
                    y={lane.top + 23 + depth[i] * ROW}
                    width={Math.max(2.5, x1 - x0)}
                    height={ROW - 2}
                    rx={1.5}
                    fill={wait ? 'var(--w2)' : lane.color}
                    opacity={i === picked ? 1 : wait ? 0.45 : 0.3 + 0.2 * depth[i]}
                    stroke={i === picked ? 'var(--ink)' : 'none'}
                    strokeWidth={1.5}
                    className="cursor-pointer"
                    onClick={() => setPicked(i)}
                  >
                    <title>{r[3]}</title>
                  </rect>
                )
              })}
            </g>
          ))}
          {ticks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 6} fontSize={11} textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'} fill="var(--muted)">
              {t.toFixed(t1 - t0 < 10 ? 1 : 0)} ms
            </text>
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => pick(picked - 1)} disabled={picked === 0} title="Previous call">
          <ChevronLeft className="size-4" />
        </Button>
        <Button tone="primary" onClick={() => pick(picked + 1)} disabled={picked === rows.length - 1}>
          Next call <ChevronRight className="size-4" />
        </Button>
        <span className="text-[0.8125rem] text-muted">
          Call {picked + 1} of {rows.length}. Nested bars are calls made inside the bar above them. You can also click a bar.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Started" value={`${sel[0].toFixed(2)} ms`} />
        <Stat label="Took" value={`${sel[1] < 1 ? sel[1].toFixed(3) : sel[1].toFixed(1)} ms`} />
        <Stat label="First token" value={`${req.ttft_ms.toFixed(1)} ms`} tone={which === 1 ? 'good' : undefined} />
        <Stat label="Measured" value={sel[4] || '–'} />
      </div>

      <Narration>
        <strong>{sel[3]}</strong> <span className="text-muted">({about?.file})</span>. {about?.what}
      </Narration>
    </WidgetFrame>
  )
}
