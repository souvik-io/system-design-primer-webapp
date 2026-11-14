import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, Narration, Stat, WidgetFrame, useReducedMotion } from './ui'
import data from './data/grammar-steps.json'

// Constrained decoding, one step at a time (content/infra/structured-output.md). A real run of SmolLM2-135M-Instruct
// with the character automaton and index of public/labs/infra/constrained_decoding.py: at every step, the model's six
// most likely tokens before the mask, whether the grammar allows each, how many tokens it allows, and the text it
// forces from that point. data/grammar-steps.json is written by `constrained_decoding.py --widget-data`.

type Step = {
  allowed: number
  forced: string
  top: [string, number, boolean][]
  chosen: string
  chosen_p_before: number
  allowed_mass: number
}
const STEPS = data.steps as Step[]
const VOCAB = data.vocab as number
/** A token as text, with its spaces, newlines and tabs made visible. */
const show = (t: string) => (t === '<end>' ? '⟨end⟩' : t.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/ /g, '·'))
const pct = (p: number) => (p >= 0.1 ? `${(100 * p).toFixed(0)}%` : p >= 0.001 ? `${(100 * p).toFixed(1)}%` : p > 0 ? '<0.1%' : '0')
/** The chosen token only copies text the grammar forced: jump-forward could have appended it without the model. */
const isForced = (s: Step) => s.forced.length > 0 && s.chosen !== '<end>' && s.forced.startsWith(s.chosen)
const FORCED_STEPS = STEPS.filter(isForced).length

export default function GrammarMask() {
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const reduced = useReducedMotion()
  const step = STEPS[i]

  useEffect(() => {
    if (!playing) return
    if (i >= STEPS.length - 1) {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setI((v) => v + 1), reduced ? 1400 : 900)
    return () => clearTimeout(t)
  }, [playing, i, reduced])

  const blockedTop = step.top[0][2] ? null : step.top[0]
  let narration: string
  if (step.allowed >= 1000) {
    narration = `Inside a string the grammar allows ${step.allowed.toLocaleString()} of ${VOCAB.toLocaleString()} tokens: almost anything except a token that would close the string and then break the format. The model chooses freely, and the mask costs nothing in quality here.`
  } else if (blockedTop) {
    narration = `The model's favourite, “${show(blockedTop[0])}” at ${pct(blockedTop[1])}, is not allowed: the grammar permits only ${step.allowed} token${step.allowed === 1 ? '' : 's'}, which together had ${pct(step.allowed_mass)} of the model's probability. After the mask they share all of it, and the model takes “${show(step.chosen)}”.`
  } else if (step.allowed === 1) {
    narration = `Only one token is allowed, so the step decides nothing.`
  } else {
    narration = `The model's first choice, “${show(step.chosen)}”, is allowed. ${step.allowed} token${step.allowed === 1 ? ' is' : 's are'} allowed in all, holding ${pct(step.allowed_mass)} of the model's probability.`
  }
  if (step.forced && step.chosen !== '<end>')
    narration += ` From here the grammar forces the text “${show(step.forced)}”${isForced(step) ? ', so with jump-forward decoding this token would not have needed a step of its own.' : '.'}`
  if (i === 1) narration += ' Unconstrained, the model writes a newline here; the grammar has fixed the layout to one line, so it must split {" into two tokens, a split the tokenizer itself never makes.'

  return (
    <WidgetFrame
      title="Try it: the grammar mask, step by step"
      description={`SmolLM2-135M-Instruct turning "${data.input}" into JSON, with the schema compiled into an automaton of ${data.states} states. At each step, the model's six favourite tokens before the mask, and which of them the grammar allows.`}
    >
      <div className="rounded-md bg-paper px-3 py-2 font-mono text-[0.8125rem] leading-relaxed break-all">
        {STEPS.map((s, j) => (
          <button
            key={j}
            type="button"
            onClick={() => (setI(j), setPlaying(false))}
            className={clsx(
              'rounded-sm whitespace-pre',
              j === i ? 'bg-accent text-on-accent' : j < i ? (isForced(s) ? 'text-muted' : 'text-ink') : 'text-muted/40',
            )}
            title={`step ${j + 1}`}
          >
            {s.chosen === '<end>' ? '⟨end⟩' : s.chosen}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => (setI(Math.max(0, i - 1)), setPlaying(false))} disabled={i === 0}>
          Back
        </Button>
        <Button tone="primary" onClick={() => (i >= STEPS.length - 1 ? (setI(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? 'Pause' : i >= STEPS.length - 1 ? 'Replay' : 'Play'}
        </Button>
        <Button onClick={() => (setI(Math.min(STEPS.length - 1, i + 1)), setPlaying(false))} disabled={i >= STEPS.length - 1}>
          Next
        </Button>
        <span className="text-[0.8125rem] text-muted tabular-nums">
          step {i + 1} of {STEPS.length}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="text-left text-[0.75rem] text-muted">
              <th className="pb-1 font-normal">Model's top tokens</th>
              <th className="pb-1 font-normal">Probability</th>
              <th className="pb-1 font-normal">Grammar</th>
            </tr>
          </thead>
          <tbody>
            {step.top.map(([tok, p, ok], j) => (
              <tr key={j} className={clsx(tok === (step.chosen === '<end>' ? '<|im_end|>' : step.chosen) && 'font-semibold')}>
                <td className={clsx('py-0.5 font-mono', !ok && 'text-muted line-through')}>{show(tok)}</td>
                <td className="py-0.5">
                  <span className="inline-block h-2 rounded-sm bg-accent align-middle" style={{ width: `${Math.max(2, p * 120)}px`, opacity: ok ? 1 : 0.3 }} />{' '}
                  <span className="tabular-nums text-muted">{pct(p)}</span>
                </td>
                <td className={clsx('py-0.5', ok ? 'text-done' : 'text-bad')}>{ok ? 'allowed' : 'masked'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-3 sm:w-48 sm:grid-cols-1">
          <Stat label="Tokens allowed" value={`${step.allowed.toLocaleString()} of ${VOCAB.toLocaleString()}`} />
          <Stat label="Their probability before the mask" value={pct(step.allowed_mass)} tone={step.allowed_mass < 0.5 ? 'bad' : undefined} />
          <Stat label="Chosen" value={<span className="font-mono">{show(step.chosen)}</span>} />
        </div>
      </div>

      <Narration tone={blockedTop ? 'bad' : undefined}>{narration}</Narration>
      <p className="text-[0.8125rem] text-muted">
        {FORCED_STEPS} of the {STEPS.length} steps only copied text the grammar had already fixed. Without the grammar, greedy decoding of the same prompt gives{' '}
        <span className="font-mono text-ink-2">{data.free_answer.replace(/\s+/g, ' ')}</span>: valid JSON, with the wrong value for member.
      </p>
    </WidgetFrame>
  )
}
