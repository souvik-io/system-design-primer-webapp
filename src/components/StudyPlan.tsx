import { useState } from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import { ArrowRight, Flame } from 'lucide-react'
import { sectionHref } from '../lib/content'
import { useProgress } from '../lib/progress'
import { addDays, dayKey, planById, planSize, PLANS, streak, usePlan, usePlanStatus, type PlanId } from '../lib/plans'
import { ProgressRing } from './ProgressRing'

const formatDay = (day: string, withYear = false) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
}

const defaultTarget = (id: PlanId) => addDays(dayKey(Date.now()), planById.get(id)!.weeks * 7 - 1)

/** The study plan on the course overview: pick one, or see today's goal for the current one. */
export function StudyPlan() {
  const status = usePlanStatus()
  return (
    <section className="mt-10" aria-labelledby="plan-heading">
      {status ? <ActivePlan /> : <PickPlan />}
    </section>
  )
}

function PickPlan({ onDone }: { onDone?: () => void }) {
  const current = usePlan((s) => s.plan)
  const startPlan = usePlan((s) => s.startPlan)
  const [chosen, setChosen] = useState<PlanId | null>(current?.id ?? null)
  const [target, setTarget] = useState(current?.target ?? '')
  const today = dayKey(Date.now())

  return (
    <div>
      {!onDone && (
        <>
          <h2 id="plan-heading" className="text-xl font-semibold tracking-tight text-ink">
            Study plan
          </h2>
          <p className="mt-1 max-w-2xl text-[0.95rem] text-muted">
            Pick how long you have and get a daily goal. The three timelines are described in{' '}
            <Link to="/learn/how-to-use-this-handbook#pick-a-study-plan" className="text-accent hover:underline">
              How to use this handbook
            </Link>
            .
          </p>
        </>
      )}
      <div role="radiogroup" aria-label="Timeline" className={clsx('grid gap-3 sm:grid-cols-3', !onDone && 'mt-4')}>
        {PLANS.map((p) => {
          const size = planSize(p)
          const perDay = Math.ceil(size.sections / (p.weeks * 7))
          const selected = chosen === p.id
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setChosen(p.id)
                setTarget(current?.id === p.id ? current.target : defaultTarget(p.id))
              }}
              className={clsx(
                'rounded-xl border p-4 text-left transition-colors',
                selected ? 'border-accent bg-accent-soft/60' : 'border-rule bg-surface hover:border-muted/50',
              )}
            >
              <span className="block font-medium text-ink">
                {p.title}, {p.weeks} weeks
              </span>
              <span className="mt-1 block text-sm text-ink-2">{p.description}</span>
              <span className="mt-3 block text-[0.8125rem] text-muted tabular-nums">
                {size.chapters} chapters, {size.sections} sections. About {perDay} {perDay === 1 ? 'section' : 'sections'} a day.
              </span>
            </button>
          )
        })}
      </div>
      {chosen && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm text-muted">
            <span className="mb-1 block">Finish by</span>
            <input
              type="date"
              value={target}
              min={today}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink"
            />
          </label>
          <button
            type="button"
            disabled={!target || target < today}
            onClick={() => {
              startPlan(chosen, target)
              onDone?.()
            }}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {current ? 'Save plan' : 'Start plan'}
          </button>
          {onDone && (
            <button type="button" onClick={onDone} className="px-2 py-2 text-sm text-muted hover:text-ink">
              Cancel
            </button>
          )}
          {target && target < today && <span className="pb-2 text-sm text-bad">Pick today or a later date.</span>}
        </div>
      )}
    </div>
  )
}

function ActivePlan() {
  const status = usePlanStatus()!
  const completed = useProgress((s) => s.completed)
  const stopPlan = usePlan((s) => s.stopPlan)
  const [changing, setChanging] = useState(false)
  const days = streak(completed)
  const { def, doneToday, goalToday, daysLeft, done, total, next, target } = status
  const finished = !next
  const metGoal = doneToday >= goalToday

  return (
    <div className="rounded-xl border border-rule bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <ProgressRing
          ratio={finished ? 1 : goalToday ? Math.min(1, doneToday / goalToday) : 1}
          size={52}
          stroke={5}
          label={`${doneToday} of ${goalToday} sections done today`}
        />
        <div className="min-w-0 flex-1">
          <h2 id="plan-heading" className="text-lg font-semibold tracking-tight text-ink">
            {finished ? 'Plan complete' : `Today: ${Math.min(doneToday, goalToday)} of ${goalToday} ${goalToday === 1 ? 'section' : 'sections'}`}
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {def.title} plan, finishing {formatDay(target)}
            {daysLeft > 0 && !finished && ` (${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left)`}. {done} of {total} sections done.
            {days > 1 && (
              <span className="ml-1 inline-flex items-center gap-1 text-ink-2">
                <Flame size={14} className="text-warn" aria-hidden /> {days} days in a row.
              </span>
            )}
          </p>
        </div>
        {next && (
          <Link
            to={sectionHref(next.chapter.id, next.section.id)}
            className="inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90"
          >
            <span className="truncate">
              Next: {next.section.id === 'overview' ? next.chapter.title : `${next.chapter.title}, ${next.section.title}`}
            </span>
            <ArrowRight size={16} className="shrink-0" />
          </Link>
        )}
      </div>

      <p className="mt-4 border-t border-rule pt-3 text-sm text-ink-2">
        {finished
          ? `You've finished every section in the ${def.title.toLowerCase()} plan. Keep the flashcards going, or pick a longer plan for more depth.`
          : daysLeft === 0
            ? `Your finish date has passed with ${total - done} sections to go. Pick a new date and the rest is spread over the days left.`
            : metGoal && doneToday > 0
              ? `Today's goal is done. Anything more you read now makes tomorrow's goal smaller.`
              : `Finish ${goalToday - doneToday} more ${goalToday - doneToday === 1 ? 'section' : 'sections'} today to stay on track for ${formatDay(target, true)}.`}
      </p>

      {changing ? (
        <div className="mt-4 border-t border-rule pt-4">
          <PickPlan onDone={() => setChanging(false)} />
        </div>
      ) : (
        <div className="mt-3 flex gap-4 text-sm">
          <button type="button" onClick={() => setChanging(true)} className="text-accent hover:underline">
            Change plan or date
          </button>
          <button type="button" onClick={stopPlan} className="text-muted hover:text-ink">
            Stop following this plan
          </button>
        </div>
      )}
    </div>
  )
}
