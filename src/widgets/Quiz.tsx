import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Narration, WidgetFrame } from './ui'

// A one-question-at-a-time quiz: show a snippet, pick an answer, read why. Used by the C++ course's
// "which stage is complaining?" and "predict the output" widgets.

export type QuizItem = {
  /** Code or an error message, shown in a monospace block. */
  snippet: string
  /** The question asked about the snippet; falls back to the quiz's default. */
  question?: string
  options: string[]
  /** Index into options. */
  answer: number
  /** Why the answer is right, shown after any choice. */
  explanation: ReactNode
}

export function Quiz({
  title,
  description,
  items,
  question,
  noun,
  extra,
}: {
  title: string
  description: ReactNode
  items: QuizItem[]
  question: string
  /** What one item is called, as in "Error 3 of 8". */
  noun: string
  /** Optional picture under the snippet, given the current item and whether it has been answered. */
  extra?: (item: QuizItem, answered: boolean) => ReactNode
}) {
  const [index, setIndex] = useState(0)
  const [choices, setChoices] = useState<(number | undefined)[]>(() => items.map(() => undefined))
  const item = items[index]
  const choice = choices[index]
  const answered = choice !== undefined
  const score = choices.filter((c, i) => c === items[i].answer).length
  const done = choices.filter((c) => c !== undefined).length

  const pick = (i: number) => {
    if (answered) return
    setChoices((cs) => cs.map((c, j) => (j === index ? i : c)))
  }

  return (
    <WidgetFrame title={title} description={description}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-muted">
        <span>
          {noun} {index + 1} of {items.length}
        </span>
        <span className="tabular-nums">
          {score} right out of {done} answered
        </span>
      </div>

      <pre className="overflow-x-auto rounded-md border border-rule bg-paper px-3 py-2.5 font-mono text-[0.78rem] leading-relaxed whitespace-pre text-ink">
        {item.snippet}
      </pre>

      {extra?.(item, answered)}

      <div>
        <p className="mb-2 font-medium text-ink">{item.question ?? question}</p>
        <div className="flex flex-wrap gap-2">
          {item.options.map((o, i) => (
            <button
              key={o}
              type="button"
              onClick={() => pick(i)}
              disabled={answered}
              aria-pressed={choice === i}
              className={clsx(
                'rounded-md border px-3 py-1.5 text-left text-[0.8125rem] font-medium transition-colors',
                !answered && 'border-rule bg-surface text-ink hover:border-accent hover:text-accent',
                answered && i === item.answer && 'border-done bg-done-soft text-ink',
                answered && i === choice && i !== item.answer && 'border-bad bg-bad-soft text-ink',
                answered && i !== choice && i !== item.answer && 'border-rule text-muted opacity-60',
              )}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      <Narration tone={!answered ? undefined : choice === item.answer ? 'good' : 'bad'}>
        {!answered ? (
          'Pick an answer to see the explanation.'
        ) : (
          <>
            <strong>{choice === item.answer ? 'Right. ' : `Not quite: the answer is ${item.options[item.answer]}. `}</strong>
            {item.explanation}
          </>
        )}
      </Narration>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setIndex(index - 1)} disabled={index === 0}>
          Previous
        </Button>
        <Button tone="primary" onClick={() => setIndex(index + 1)} disabled={index === items.length - 1}>
          Next {noun.toLowerCase()}
        </Button>
        <Button
          onClick={() => {
            setChoices(items.map(() => undefined))
            setIndex(0)
          }}
          disabled={done === 0}
        >
          Start over
        </Button>
      </div>
    </WidgetFrame>
  )
}
