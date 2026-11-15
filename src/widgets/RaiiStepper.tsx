import { useState } from 'react'
import clsx from 'clsx'
import { Button, Narration, Segmented, WidgetFrame } from './ui'

// Manual cleanup versus RAII for content/cpp/cpp-raii.md. One request handler acquires three resources (a file, a
// mutex and a scratch buffer) and leaves by one of three paths: the normal end, an early return, or an exception
// from run_layer. The reader steps through it and watches which resources are released. In the RAII version the
// destructors run in reverse order of construction on every path, as the standard requires for automatic objects
// (including during stack unwinding, when a handler further up catches the exception).

type Version = 'manual' | 'raii'
type Path = 'normal' | 'early' | 'throw'
type Res = 'file' | 'lock' | 'scratch'

const CODE: Record<Version, string[]> = {
  manual: [
    'void handle(const Request& r) {',
    '  std::FILE* f = std::fopen(r.path, "rb");',
    '  mu.lock();',
    '  float* scratch = new float[r.tokens * kHidden];',
    '  if (!valid(r)) return;            // bad request',
    '  run_layer(scratch, r);            // may throw',
    '  delete[] scratch;',
    '  mu.unlock();',
    '  std::fclose(f);',
    '}',
  ],
  raii: [
    'void handle(const Request& r) {',
    '  File f(r.path, "rb");',
    '  std::lock_guard lock(mu);',
    '  std::vector<float> scratch(r.tokens * kHidden);',
    '  if (!valid(r)) return;            // bad request',
    '  run_layer(scratch.data(), r);     // may throw',
    '}   // destructors run here: scratch, lock, f',
  ],
}

const RES: { id: Res; label: string }[] = [
  { id: 'file', label: 'file f' },
  { id: 'lock', label: 'mutex mu' },
  { id: 'scratch', label: 'scratch buffer' },
]

type State = Record<Res, boolean>
type Step = { line: number; text: string; state: State; done?: boolean }

const NONE: State = { file: false, lock: false, scratch: false }

function steps(version: Version, path: Path): Step[] {
  const out: Step[] = []
  let s: State = { ...NONE }
  const push = (line: number, text: string, change?: Partial<State>, done?: boolean) => {
    s = { ...s, ...change }
    out.push({ line, text, state: s, done })
  }
  const raii = version === 'raii'

  push(0, 'handle() is called. Nothing is held yet.')
  push(
    1,
    raii ? "File's constructor opens the file. From now on, f's destructor will close it." : 'fopen opens the file. Someone must call fclose later.',
    {
      file: true,
    },
  )
  push(
    2,
    raii ? "lock_guard's constructor locks the mutex, and its destructor will unlock it." : 'The mutex is locked. Someone must call unlock later.',
    {
      lock: true,
    },
  )
  push(
    3,
    raii
      ? 'The vector allocates the scratch buffer, and its destructor will free it.'
      : 'new[] allocates the scratch buffer. Someone must call delete[] later.',
    { scratch: true },
  )

  const exitLine = raii ? 6 : 9
  const unwind = (why: string) => {
    push(exitLine, `${why} The destructors run in reverse order of construction. First scratch's destructor frees the buffer.`, {
      scratch: false,
    })
    push(exitLine, "Then lock's destructor unlocks the mutex, so the next request can take it.", { lock: false })
    push(exitLine, "Last, f's destructor closes the file.", { file: false })
  }

  if (path === 'early') {
    if (raii) {
      push(4, 'valid(r) is false, so the function returns early.')
      unwind('Leaving the scope by return destroys every local object, whatever line the return is on.')
    } else {
      push(4, 'valid(r) is false, so the function returns. Lines 6 to 8, the only cleanup code, never run.')
    }
  } else {
    push(4, 'The request is valid, so execution continues.')
    if (path === 'throw') {
      if (raii) {
        push(5, 'run_layer throws std::length_error. No more lines of handle() run, and the exception travels up to a catch in the caller.')
        unwind('As the exception leaves the scope, the stack is unwound and every local object is destroyed on the way.')
      } else {
        push(5, 'run_layer throws std::length_error. No more lines of handle() run, so the cleanup on lines 6 to 8 is skipped.')
      }
    } else {
      push(5, 'run_layer returns normally.')
      if (raii) unwind('The function reaches its closing brace.')
      else {
        push(6, 'delete[] frees the scratch buffer.', { scratch: false })
        push(7, 'The mutex is unlocked.', { lock: false })
        push(8, 'fclose closes the file.', { file: false })
      }
    }
  }

  const leaked = RES.filter((r) => s[r.id])
  if (leaked.length === 0) {
    push(
      exitLine,
      path === 'throw'
        ? 'The exception has left handle() on its way to a catch, and everything handle() acquired was released on the way out.'
        : 'handle() has returned, and everything it acquired has been released.',
      undefined,
      true,
    )
  } else {
    push(
      out[out.length - 1].line, // the line it left from: the return, or the call that threw
      `handle() has exited, still holding ${leaked.map((r) => r.label).join(', ')}. The file descriptor and the buffer are leaked, ` +
        'and the mutex stays locked forever, so the next request that calls mu.lock() waits for good.',
      undefined,
      true,
    )
  }
  return out
}

export default function RaiiStepper() {
  const [version, setVersion] = useState<Version>('manual')
  const [path, setPath] = useState<Path>('throw')
  const [i, setI] = useState(0)

  const all = steps(version, path)
  const step = all[Math.min(i, all.length - 1)]
  const last = i >= all.length - 1
  const leaked = step.done && RES.some((r) => step.state[r.id])

  const choose =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v)
      setI(0)
    }

  return (
    <WidgetFrame
      title="Try it: three ways out of a function"
      description="A request handler acquires a file, a lock and a buffer. Choose how it is written and how it exits, then step through it and watch what gets released."
    >
      <div className="flex flex-col gap-2.5">
        <Segmented
          label="Written with"
          value={version}
          options={[
            { value: 'manual', label: 'Manual cleanup' },
            { value: 'raii', label: 'RAII' },
          ]}
          onChange={choose(setVersion)}
        />
        <Segmented
          label="Exit path"
          value={path}
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'early', label: 'Early return' },
            { value: 'throw', label: 'Exception' },
          ]}
          onChange={choose(setPath)}
        />
      </div>

      <pre className="overflow-x-auto rounded-md border border-rule bg-paper py-2 font-mono text-[0.78rem] leading-relaxed text-ink">
        {CODE[version].map((line, n) => (
          <div
            key={n}
            className={clsx('px-3 whitespace-pre', n === step.line && (step.done ? (leaked ? 'bg-bad-soft' : 'bg-done-soft') : 'bg-accent-soft'))}
          >
            {line}
          </div>
        ))}
      </pre>

      <div className="flex flex-wrap gap-2" aria-label="Resources">
        {RES.map((r) => {
          const held = step.state[r.id]
          return (
            <span
              key={r.id}
              className={clsx(
                'rounded-md border px-2.5 py-1 text-[0.8125rem] font-medium',
                held ? (step.done ? 'border-bad/50 bg-bad-soft text-bad' : 'border-accent/50 bg-accent-soft text-accent') : 'border-rule text-muted',
              )}
            >
              {r.label}: {held ? (step.done ? 'leaked' : 'held') : 'free'}
            </span>
          )
        })}
      </div>

      <Narration tone={step.done ? (leaked ? 'bad' : 'good') : undefined}>{step.text}</Narration>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setI((n) => Math.max(0, n - 1))} disabled={i === 0}>
          Back
        </Button>
        <Button tone="primary" onClick={() => setI((n) => Math.min(all.length - 1, n + 1))} disabled={last}>
          Step
        </Button>
        <Button onClick={() => setI(all.length - 1)} disabled={last}>
          Run to the end
        </Button>
        <Button onClick={() => setI(0)} disabled={i === 0}>
          Reset
        </Button>
        <span className="text-[0.8125rem] text-muted tabular-nums">
          Step {Math.min(i, all.length - 1) + 1} of {all.length}
        </span>
      </div>
    </WidgetFrame>
  )
}
