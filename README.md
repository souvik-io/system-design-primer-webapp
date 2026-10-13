# System Design Primer: interactive course

A React app that presents [The System Design Primer](https://github.com/donnemartin/system-design-primer) as a course: chapters split into sections, progress tracking, study plans with a daily goal, notes and bookmarks, interactive diagrams, spaced-repetition flashcards, search, and dark mode.

**Live site: [system.tangentbyte.com](https://system.tangentbyte.com)**

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # static site in dist/, plus llms.txt and prerendered pages
npm run preview          # serve dist/ locally
npm run verify-content   # check nothing from the primer went missing
npm test                 # unit tests (sync merging)
```

The first run clones the primer into `source-repo/` and generates the content. Building needs Node 22.13 or newer (the flashcard decks are read with `node:sqlite`).

## How content is built

`scripts/build-content.mjs` reads the primer at build time and writes:

| Output                             | What it is                                                     |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/generated/manifest.json`      | Course outline: parts, chapters, sections, reading time, decks |
| `public/content/<chapter>.json`    | Pre-rendered HTML per chapter (syntax highlighting done here)  |
| `public/content/flashcards/*.json` | The three Anki decks, cleaned up, and the site's own decks     |
| `public/content/search.json`       | Plain-text index used by search                                |
| `public/repo/...`                  | Diagrams referenced by the content                             |

- README `##` topics become chapters, and `###` headings become trackable sections. Database also splits at `####`. "Disadvantage(s)" and "Source(s)" are folded into the section before them.
- Solution READMEs and the OOD notebooks each become a chapter. Each solution also shows its full `.py` files under "Full source code".
- The README's Anki, Under development, Contributing, Credits, Contact and License sections form an "About the primer" chapter, which doesn't count toward progress.
- `scripts/flashcards.mjs` unpacks the `.apkg` decks (zip + SQLite), strips GitHub's inline styles, and re-highlights the code.
- Links between topics are rewritten to in-app routes. Imgur and GitHub camo diagrams are swapped for the copies in the repo where they exist.

To pull upstream changes, run `git -C source-repo pull`, then `npm run content` and `npm run verify-content`. The curriculum order lives in the `PARTS` array at the top of the build script.

## Checking content

`npm run verify-content` compares every paragraph, heading, list item, table cell, code block and image in the primer with the generated site, and checks that every internal link and image resolves. It lists what is left out on purpose (the README's tables of contents, language links and notebook attribution lines) and exits with an error if anything else is missing.

## Extra chapters

`content-extra/` holds chapters written for this site on topics the primer doesn't cover, such as rate limiting, consistent hashing and a chat system design. They're original writing. Each one lists the books, papers and docs it draws on under "Further reading".

They're off by default. Readers turn them on with **Show extra chapters** on the home page, and the choice is saved in that browser (`sdp-settings`). When they're on, they appear in the course list, the sidebar and search, and count toward progress. When they're off, a link to one shows a page with the same switch.

Four of them are always shown, because they're companions to primer chapters that are short and lean on old external links. Each sits right after the chapters it covers, and those chapters link to it:

- **Scalability 101**, after "System design topics: start here": what Harvard's scalability lecture and the _Scalability for Dummies_ series cover.
- **Performance and latency 101**, after "Performance vs scalability" and "Latency vs throughput".
- **CAP and consistency 101**, after "Availability vs consistency" and "Consistency patterns".
- **Availability 101**, after "Availability patterns".

They're fact-checked against the original sources and primary accounts (papers, post-mortems, official docs), with real examples. Readers can use the originals, the companions, or both.

`scripts/build-content.mjs` builds them like the primer chapters. `##` headings become trackable sections, and fenced `diagram` blocks are drawn as SVG that follows the theme ([`scripts/diagram.mjs`](scripts/diagram.mjs)). See [`content-extra/README.md`](content-extra/README.md) for the format. `npm run verify-content` checks their internal links too.

## Interactive diagrams

Four topics have a diagram the reader can play with, in [`src/widgets/`](src/widgets/):

| Diagram            | Chapter                                     | What it shows                                                                              |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cache-strategies` | Cache, "When to update the cache"           | Cache-aside, write-through and write-behind: hits, stale reads, write latency, lost writes |
| `replication`      | Database, "Master-slave replication"        | Replication lag, stale reads from replicas, and which writes a failover loses              |
| `hash-ring`        | Consistent hashing (extra), "Virtual nodes" | Which keys move when servers come and go, against hash mod N, and how points even out load |
| `rate-limiter`     | Rate limiting (extra), "The algorithms"     | Fixed window, sliding log, sliding counter and token bucket on the same traffic            |

The content build leaves an empty placeholder where each goes and the chapter page renders the component into it. Each diagram's code loads only with its chapter. See [`content-extra/README.md`](content-extra/README.md) to add one.

## Progress, plans, notes and flashcards

Everything a reader does is stored in `localStorage`: reading progress (`sdp-progress`), flashcard history (`sdp-flashcards`), notes and bookmarks (`sdp-notes`) and the study plan (`sdp-plan`). Without an account it stays in that browser. Signing in (optional, see below) syncs all of it across devices.

- **Study plans** follow the primer's study guide: short, medium or long. Each covers every topic chapter plus some, many or all of the practice questions, and adds extra chapters when they're turned on. The lengths (2, 5 and 10 weeks) and the question choices are this site's suggestions ([`src/lib/plans.ts`](src/lib/plans.ts)). Today's goal is what was left this morning divided by the days left, so it doesn't move while you read.
- **Notes and bookmarks** are per section, added from the buttons at the end of each one. The Notes and bookmarks page lists them in course order and downloads the notes as Markdown.

There are two sets of flashcard decks. The primer's three Anki decks have one card per topic or question. Five more decks, written for this site in [`content-extra/flashcards/`](content-extra/flashcards/), ask one specific question per card across every chapter, the 101 chapters and worked solutions included. Each answer is drawn from the chapter it links to. The two decks covering the extra chapters are shown only when extra chapters are turned on.

Flashcards use an SM-2 style schedule like Anki's: Again (1 minute), Hard, Good and Easy, with intervals growing by each card's ease. New cards are limited per deck per day, 10 by default.

## Accounts and sync (optional)

Progress is kept in the browser by default. One environment variable switches it:

| `VITE_PROGRESS_STORAGE` | What happens                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `browser` (or unset)    | Progress stays in `localStorage`. No sign-in button. Any Supabase keys are ignored.                                     |
| `supabase`              | A **Sign in** button appears in the top bar. People sign in with an emailed link (no password) and sync across devices. |

If it's set to `supabase` but either Supabase value is missing, the site stays in browser mode and logs a warning in the console.

Setup:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/migrations/20261012000000_progress.sql`](supabase/migrations/20261012000000_progress.sql). It creates the `progress` table with row-level security, so each user can read and write only their own row.
3. Under **Authentication → URL Configuration**, set **Site URL** to where the site is hosted, and add `http://localhost:5173/**` and `https://<your-domain>/**` to **Redirect URLs**. The sign-in link returns people to the page they were on.
4. Copy `.env.example` to `.env.local`, set `VITE_PROGRESS_STORAGE=supabase`, and fill in the project URL and publishable key from **Project Settings → API**. Set the same three variables in your host (Vercel: Project → Settings → Environment Variables) and rebuild. Vite reads them at build time, so changing them always needs a rebuild or a dev server restart.

Supabase's built-in email sender allows only a few sign-in emails per hour. That's fine for personal use. For more users, set up custom SMTP under **Authentication → Emails**.

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

This is a static site. `vercel.json` turns on clean URLs, so `/learn/cache` serves the prerendered `learn/cache.html`, and rewrites every other route to the app shell, `app.html` (served at `/app` because of clean URLs). Other hosts need the same two rules. The live site runs on Vercel with `SITE_URL=https://system.tangentbyte.com`, and every push to `main` redeploys it. `npm run preview` behaves the same way. The app assumes it's served from the domain root.

## License

- **The site's code** is released under the [MIT License](LICENSE), © 2026 Souvik Samanta.
- **The primer's content** is © Donne Martin, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and is credited in the site footer. It isn't stored in this repository; the build fetches it from the [original repo](https://github.com/donnemartin/system-design-primer).
- **The extra chapters** in `content-extra/` are © 2026 Souvik Samanta, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
