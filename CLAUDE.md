# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static React site (Vite, React 19, react-router, zustand, Tailwind v4) that teaches system design, including a part on AI systems. All course content is original markdown in `content/`, compiled at build time into JSON the app fetches. Live at system.tangentbyte.com on Vercel; every push to `main` redeploys. `README.md` and `content/README.md` are the authoritative docs for the content format and sync design. Read them before changing either.

## Commands

```bash
npm run dev              # vite on :5173; predev builds content only if src/generated/manifest.json is missing
npm run content          # rebuild content JSON (run after editing content/ while dev is running)
npm run build            # prebuild content -> tsc -> vite build -> postbuild llms.txt/prerendered pages
npm run preview          # serve dist/ with the same app-shell fallback as vercel.json
npm test                 # node --test on tests/*.test.ts (native TS type stripping, Node >= 22.13)
node --disable-warning=ExperimentalWarning --test tests/syncDoc.test.ts   # one test file
npm run verify-content   # internal links, card links, redirects.json <-> vercel.json agreement
npm run coverage         # every topic in content/COVERAGE.md still points at an existing section
npm run lint-diagrams    # flag badly drawn `diagram` blocks (optionally pass specific .md files)
npm run format           # prettier: no semicolons, single quotes, printWidth 150
```

There is no ESLint; `tsc` (strict, `noUnusedLocals`/`noUnusedParameters`) in `npm run build` is the type check. Tests import `.ts` source with explicit `.ts` extensions.

## Architecture

**Content pipeline.** `scripts/build-content.mjs` is the core of the site. The `PARTS` array at its top defines curriculum order (a chapter not listed there is not published), `DECKS` lists flashcard decks, and `WIDGET_NAMES` lists allowed interactive widgets. It writes `src/generated/manifest.json` (imported by the app via `src/lib/content.ts`) and `public/content/*.json` (rendered HTML per chapter, decks, search index, fetched on demand). Both outputs are gitignored. Each `##` heading becomes a trackable section whose slug is its id; "Further reading" folds into the previous section. Fenced `diagram` blocks are rendered to theme-aware SVG by `scripts/diagram.mjs` (grid layout DSL documented in `content/README.md`); fenced `widget` blocks leave a placeholder that `ChapterPage` fills with a lazily loaded component from `src/widgets/` (registered in `Widgets.tsx`).

**Two handbooks.** Each `PARTS` entry has a `handbook` (`system-design` by default, or `infra`). The AI Infrastructure Engineer Handbook lives at `/infra` (`src/pages/InfraHomePage.tsx`), reads its chapters from `content/infra/` via the part's `dir`, and has separate progress totals, sidebar and previous/next order (`useHandbook` in `src/lib/handbook.ts`, `HANDBOOKS` in `src/lib/content.ts`). Study plans cover only the system design handbook. Its roadmap is `content/infra/SYLLABUS.md`.

**Post-build.** `scripts/build-llms.mjs` runs after `vite build` and writes `llms.txt`, `llms-full.txt`, per-chapter Markdown and prerendered `learn/<id>.html`, and copies the empty shell to `app.html`. `vercel.json` (clean URLs) serves prerendered pages and rewrites everything else to `app.html`; `vite.config.ts` mimics this for `vite preview`. `SITE_URL` enables full URLs and the sitemap.

**Saved state.** Each concern is a zustand store persisted to `localStorage`: `progress.ts` (`sdp-progress`), `flashcards.ts` (`sdp-flashcards`, SM-2 scheduling), `notes.ts` (`sdp-notes`), `plans.ts` (`sdp-plan`). Keys are `chapterId/sectionId`, so renaming a chapter or rewording a `##` heading orphans saved data unless handled (below). Removals are stored as timestamps (`removed`, `resetAt`) so they survive merges.

**Optional sync.** `VITE_PROGRESS_STORAGE=supabase` (plus URL and publishable key, read at build time) turns on accounts. `src/lib/syncDoc.ts` defines one JSON document per user and a per-item newest-wins merge; `src/lib/account.ts` handles debounced saves, optimistic concurrency on the row's `version`, and lazy-loads supabase-js. Schema is in `supabase/migrations/`. Default is browser-only.

**Renames and redirects.** `content/redirects.json` records renamed/replaced chapters, moved headings and decks. Three places must agree: `redirects.json`, the redirects in `vercel.json` (`verify-content` prints any missing ones), and `src/lib/legacy.ts`, which migrates saved notes/bookmarks/progress. Bump `DATA_VERSION` in `legacy.ts` whenever `redirects.json` gains entries. Follow the "Renaming or removing a chapter" steps in `content/README.md`.

**Interactive architecture diagrams.** `public/diagrams/*.html` are standalone pages generated with the archify skill (`.agents/skills/archify/`, working files in `.archify/`), linked from a few design chapters and opened by `src/components/useArticleClicks.tsx`. They are build artifacts committed as-is; regenerate them with the skill rather than editing the HTML.

## Content rules (from content/README.md)

- Writing is original; each chapter ends with "Check yourself" (`<details>` Q&A) and "Further reading" with sources.
- Every flashcard fact must come from the chapter it links to (`<!-- /learn/... -->` comment after the `##` question). A card's id is its question slug, so rewording a question resets its review history.
- Diagrams: at most 5 columns, labels under ~18 chars, edge labels under ~26, one edge per node pair, straight edges must not cross boxes. Math as plain text, not LaTeX.
- When adding or renaming a section that covers a primer topic, keep `content/COVERAGE.md` pointing at it.

## Ignored directories

`source-repo/` is a local, gitignored checkout of the original System Design Primer for reference only; the site no longer uses its text.
