import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { chapters, sectionKey, type ChapterMeta, type SectionMeta } from './content'
import { useSettings } from './settings'
import { useProgress } from './progress'

// Study plans based on the primer's study guide, which suggests what to cover for a short, medium
// or long interview timeline. The primer doesn't give lengths or pick which questions to practice,
// so the weeks and the question choices here are this site's suggestions.

export type PlanId = 'short' | 'medium' | 'long'

export type PlanDef = {
  id: PlanId
  title: string
  weeks: number
  description: string
  /** Practice questions to include. Every plan covers all the topic chapters. */
  questions: 'some' | 'many' | 'all'
  /** Which extra chapters to add when the reader has them turned on */
  extras: 'none' | 'concepts' | 'all'
}

export const PLANS: PlanDef[] = [
  {
    id: 'short',
    title: 'Short',
    weeks: 2,
    description: 'Breadth across every topic, and a few practice questions.',
    questions: 'some',
    extras: 'none',
  },
  {
    id: 'medium',
    title: 'Medium',
    weeks: 5,
    description: 'Breadth, some depth, and many practice questions.',
    questions: 'many',
    extras: 'concepts',
  },
  {
    id: 'long',
    title: 'Long',
    weeks: 10,
    description: 'Breadth, more depth, and every practice question.',
    questions: 'all',
    extras: 'all',
  },
]

export const planById = new Map(PLANS.map((p) => [p.id, p]))

const SOME = new Set(['design-pastebin', 'design-twitter', 'design-web-crawler', 'ood-hash-table', 'ood-lru-cache'])
const MANY = new Set([...SOME, 'design-query-cache', 'design-sales-rank', 'design-scaling-aws', 'ood-parking-lot', 'ood-online-chat'])
const QUESTION_PARTS = new Set(['system-design', 'ood'])

/** The chapters a plan covers, in course order. Extra chapters count only while they're turned on. */
export function planChapters(plan: PlanDef, showExtras: boolean): ChapterMeta[] {
  return chapters.filter((c) => {
    if (c.untracked) return false
    if (c.extra) return showExtras && (plan.extras === 'all' || (plan.extras === 'concepts' && c.part.id === 'extra-concepts'))
    if (!QUESTION_PARTS.has(c.part.id)) return true
    return plan.questions === 'all' || (plan.questions === 'many' ? MANY : SOME).has(c.id)
  })
}

export function planSize(plan: PlanDef, showExtras: boolean) {
  const list = planChapters(plan, showExtras)
  return {
    chapters: list.length,
    sections: list.reduce((n, c) => n + c.sections.length, 0),
    minutes: list.reduce((n, c) => n + c.minutes, 0),
  }
}

export type PlanData = {
  /** null when not following a plan */
  plan: { id: PlanId; start: string; target: string } | null
  /** When the plan was last changed, so the latest choice wins when syncing */
  planAt: number
}

type PlanState = PlanData & {
  startPlan: (id: PlanId, target: string) => void
  setTarget: (target: string) => void
  stopPlan: () => void
}

export const usePlan = create<PlanState>()(
  persist(
    (set) => ({
      plan: null,
      planAt: 0,
      startPlan: (id, target) => set({ plan: { id, start: dayKey(Date.now()), target }, planAt: Date.now() }),
      setTarget: (target) => set((s) => (s.plan ? { plan: { ...s.plan, target }, planAt: Date.now() } : s)),
      stopPlan: () => set({ plan: null, planAt: Date.now() }),
    }),
    { name: 'sdp-plan', version: 1 },
  ),
)

// Days are the reader's local calendar days, written as YYYY-MM-DD.

export function dayKey(time: number) {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole days from one YYYY-MM-DD to another. */
export function daysBetween(from: string, to: string) {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  })
  return Math.round((b - a) / 86_400_000)
}

export function addDays(day: string, n: number) {
  const [y, m, d] = day.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n).getTime())
}

export type PlanStatus = {
  def: PlanDef
  start: string
  target: string
  total: number
  done: number
  /** Sections in the plan finished today */
  doneToday: number
  /** Sections to finish today to end on the target date */
  goalToday: number
  /** Days left including today; 0 once the target date has passed */
  daysLeft: number
  next: { chapter: ChapterMeta; section: SectionMeta } | null
}

/** Today's goal: what was left this morning, spread evenly over the days remaining. */
export function planStatus(
  plan: NonNullable<PlanData['plan']>,
  completed: Record<string, number>,
  showExtras: boolean,
  now = Date.now(),
): PlanStatus | null {
  const def = planById.get(plan.id)
  if (!def) return null
  const today = dayKey(now)
  const list = planChapters(def, showExtras)
  let total = 0
  let done = 0
  let doneToday = 0
  let next: PlanStatus['next'] = null
  for (const chapter of list) {
    for (const section of chapter.sections) {
      total++
      const at = completed[sectionKey(chapter.id, section.id)]
      if (at) {
        done++
        if (dayKey(at) === today) doneToday++
      } else if (!next) next = { chapter, section }
    }
  }
  const daysLeft = Math.max(0, daysBetween(today, plan.target) + 1)
  const leftThisMorning = total - done + doneToday
  const goalToday = daysLeft === 0 ? leftThisMorning : Math.ceil(leftThisMorning / daysLeft)
  return { def, start: plan.start, target: plan.target, total, done, doneToday, goalToday, daysLeft, next }
}

export function usePlanStatus() {
  const plan = usePlan((s) => s.plan)
  const completed = useProgress((s) => s.completed)
  const showExtras = useSettings((s) => s.showExtras)
  return plan ? planStatus(plan, completed, showExtras) : null
}

/** Days in a row, up to today, with at least one section finished. Today doesn't break the streak until it's over. */
export function streak(completed: Record<string, number>, now = Date.now()) {
  const days = new Set(Object.values(completed).map(dayKey))
  let day = dayKey(now)
  if (!days.has(day)) day = addDays(day, -1)
  let n = 0
  while (days.has(day)) {
    n++
    day = addDays(day, -1)
  }
  return n
}
