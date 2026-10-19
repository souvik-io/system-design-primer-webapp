# System Design Handbook

A free, open-source course in system design: how large systems are built, and how to answer the system design interview. It's a React app with chapters split into sections, progress tracking, study plans with a daily goal, notes and bookmarks, interactive diagrams, spaced-repetition flashcards, search, and dark mode.

Every chapter is written for this site, and each lists its sources under "Further reading". The syllabus started from [The System Design Primer](https://github.com/donnemartin/system-design-primer) by Donne Martin, and covers everything it teaches and more ([`content/COVERAGE.md`](content/COVERAGE.md) maps each of its topics to the section that covers it here).

**Live site: [system.tangentbyte.com](https://system.tangentbyte.com)**

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # static site in dist/, plus llms.txt and prerendered pages
npm run preview          # serve dist/ locally
npm run verify-content   # check internal links and redirects
npm run coverage         # check every syllabus topic still has a home
npm run lint-diagrams    # flag diagrams that will draw badly
npm test                 # unit tests (sync merging, old-link redirects and data migration)
```

The first run generates the content. Building needs Node 22.13 or newer.

## How content is built

All content is markdown in [`content/`](content/): one file per chapter, one per flashcard deck. [`content/README.md`](content/README.md) explains the format, diagrams, decks, and how to rename a chapter without breaking readers' links and notes. `scripts/build-content.mjs` turns it into:

| Output                             | What it is                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `src/generated/manifest.json`      | Course outline: parts, chapters, sections, reading time, decks, old URLs    |
| `public/content/<chapter>.json`    | Pre-rendered HTML per chapter (syntax highlighting and diagrams drawn here) |
| `public/content/flashcards/*.json` | One file per deck                                                           |
| `public/content/search.json`       | Plain-text index used by search                                             |

- `##` headings become trackable sections. "Further reading" is folded into the section before it.
- Fenced `diagram` blocks are drawn as SVG that follows the theme ([`scripts/diagram.mjs`](scripts/diagram.mjs)).
- The curriculum order lives in the `PARTS` array at the top of the build script, and the decks in `DECKS`.

## Old links

The site used to present the primer's own text, with some chapters ending in "101". Those chapters were renamed or replaced, and [`content/redirects.json`](content/redirects.json) records where each old chapter, heading and deck went:

- `vercel.json` sends old URLs to their new home with a permanent redirect. A replaced chapter's redirect carries `?from=<old id>`, so the app can send a link to one of its headings to the section that covers it now. `npm run verify-content` checks the two files agree.
- Readers' saved data moves too ([`src/lib/legacy.ts`](src/lib/legacy.ts)): progress in renamed chapters, and notes and bookmarks to the section that now holds the same heading. Progress in replaced chapters doesn't count any more, and a one-time notice on the home page says so.

## Interactive diagrams

Four topics have a diagram the reader can play with, in [`src/widgets/`](src/widgets/):

| Diagram            | Chapter                                              | What it shows                                                                              |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cache-strategies` | Caching, "When to update the cache"                  | Cache-aside, write-through and write-behind: hits, stale reads, write latency, lost writes |
| `replication`      | Relational databases, "Synchronous, asynchronous..." | Replication lag, stale reads from replicas, and which writes a failover loses              |
| `hash-ring`        | Consistent hashing, "Virtual nodes"                  | Which keys move when servers come and go, against hash mod N, and how points even out load |
| `rate-limiter`     | Rate limiting, "The algorithms"                      | Fixed window, sliding log, sliding counter and token bucket on the same traffic            |

The content build leaves an empty placeholder where each goes and the chapter page renders the component into it. A chapter places one with a fenced `widget` block. Each diagram's code loads only with its chapter. See [`content/README.md`](content/README.md) to add one.

## Progress, plans, notes and flashcards

Everything a reader does is stored in `localStorage`: reading progress (`sdp-progress`), flashcard history (`sdp-flashcards`), notes and bookmarks (`sdp-notes`) and the study plan (`sdp-plan`). Without an account it stays in that browser. Signing in (optional, see below) syncs all of it across devices.

- **Study plans** follow "How to use this handbook": short, medium or long. Each covers every topic chapter plus some, many or all of the design questions; the medium and long plans add the deeper concepts. The lengths (2, 5 and 10 weeks) and the question choices are this site's suggestions ([`src/lib/plans.ts`](src/lib/plans.ts)). Today's goal is what was left this morning divided by the days left, so it doesn't move while you read.
- **Notes and bookmarks** are per section, added from the buttons at the end of each one. The Notes and bookmarks page lists them in course order and downloads the notes as Markdown.

Eight flashcard decks in [`content/flashcards/`](content/flashcards/) cover the course: one card per topic, specific questions on every chapter and design, design walkthroughs, and object-oriented designs. Each answer is drawn from the chapter it links to.

Flashcards use an SM-2 style schedule like Anki's: Again (1 minute), Hard, Good and Easy, with intervals growing by each card's ease. New cards are limited per deck per day, 10 by default.

## Accounts and sync (optional)

Progress is kept in the browser by default. One environment variable switches it:

| `VITE_PROGRESS_STORAGE` | What happens                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `browser` (or unset)    | Progress stays in `localStorage`. No sign-in button. Any Supabase keys are ignored.                          |
| `supabase`              | A **Sign in** button appears in the top bar. People sign in with email and password and sync across devices. |

If it's set to `supabase` but either Supabase value is missing, the site stays in browser mode and logs a warning in the console.

Setup:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/migrations/20261012000000_progress.sql`](supabase/migrations/20261012000000_progress.sql). It creates the `progress` table with row-level security, so each user can read and write only their own row.
3. Under **Authentication → Sign In / Providers**, turn off **Confirm email**, so a new account is signed in straight away without an email step.
4. Copy `.env.example` to `.env.local`, set `VITE_PROGRESS_STORAGE=supabase`, and fill in the project URL and publishable key from **Project Settings → API**. Set the same three variables in your host (Vercel: Project → Settings → Environment Variables) and rebuild. Vite reads them at build time, so changing them always needs a rebuild or a dev server restart.

How sync works:

- Each user has one row holding a JSON document of their progress, flashcard history, notes, bookmarks and study plan ([`src/lib/syncDoc.ts`](src/lib/syncDoc.ts)). The browser's copy and the account's copy are merged item by item, and the newest change wins. Un-marking a section, clearing progress and resetting a deck are recorded with timestamps too, so they aren't undone by an older copy on another device.
- Changes are saved about 1.5 seconds after they happen. Scrolling to a new section, which only updates "continue where you left off", is saved after 15 seconds. The page also saves when the tab is hidden, pulls other devices' changes when the tab comes back, and retries after reconnecting.
- Writes are conditional on the row's `version`. If another device saved in between, the browser reads again, re-merges and retries, so neither device's changes are lost.
- Signing in adds what's already in the browser to the account. Signing out saves first, then clears the browser's copy. If that save fails, the person stays signed in.
- supabase-js is loaded only for people who are signed in or open the account menu.

## Readable by search engines and LLMs

After `vite build`, [`scripts/build-llms.mjs`](scripts/build-llms.mjs) makes the content available without running JavaScript:

| Output                 | What it is                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `dist/llms.txt`        | Index of every chapter in the [llms.txt](https://llmstxt.org) format                     |
| `dist/llms-full.txt`   | The whole course as one Markdown file                                                    |
| `dist/learn/<id>.md`   | Each chapter as Markdown, with diagrams described in text                                |
| `dist/learn/<id>.html` | Each chapter prerendered: the article is in the HTML, with its own title and description |
| `dist/index.html`      | The course overview prerendered the same way                                             |
| `dist/app.html`        | The empty app shell, for every other route                                               |
| `dist/robots.txt`      | Allows all crawlers, and points to the sitemap                                           |
| `dist/sitemap.xml`     | Every page, written only when `SITE_URL` is set                                          |

The app replaces the prerendered article as soon as it starts. Set `SITE_URL` (for example in `.env.local`) to the published address to get full URLs, canonical links and the sitemap.

## Deploying

This is a static site. `vercel.json` turns on clean URLs, so `/learn/cache` serves the prerendered `learn/cache.html`, redirects old URLs (see [Old links](#old-links)), and rewrites every other route to the app shell, `app.html` (served at `/app` because of clean URLs). Other hosts need the same rules. The live site runs on Vercel with `SITE_URL=https://system.tangentbyte.com`, and every push to `main` redeploys it. `npm run preview` behaves the same way. The app assumes it's served from the domain root.

## License

- **The site's code** is released under the [MIT License](LICENSE), © 2026 Souvik Samanta.
- **The chapters and flashcards** in `content/` are © 2026 Souvik Samanta, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **The syllabus** started from [The System Design Primer](https://github.com/donnemartin/system-design-primer), © Donne Martin, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and credited in the site footer and on the About page.
