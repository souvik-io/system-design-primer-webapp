# System Design Primer: interactive course

A React app that presents [The System Design Primer](https://github.com/donnemartin/system-design-primer) as a course: chapters split into sections, progress tracking, spaced-repetition flashcards, search, and dark mode.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # static site in dist/
npm run verify-content   # check nothing from the primer went missing
npm test                 # unit tests (progress sync merging)
```

The first run clones the primer into `source-repo/` and generates the content. Building needs Node 22.13 or newer (the flashcard decks are read with `node:sqlite`).

## How content is built

`scripts/build-content.mjs` reads the primer at build time and writes:

| Output                             | What it is                                                     |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/generated/manifest.json`      | Course outline: parts, chapters, sections, reading time, decks |
| `public/content/<chapter>.json`    | Pre-rendered HTML per chapter (syntax highlighting done here)  |
| `public/content/flashcards/*.json` | The three Anki decks, cleaned up                               |
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

`scripts/build-content.mjs` builds them like the primer chapters. `##` headings become trackable sections, and fenced `diagram` blocks are drawn as SVG that follows the theme ([`scripts/diagram.mjs`](scripts/diagram.mjs)). See [`content-extra/README.md`](content-extra/README.md) for the format. `npm run verify-content` checks their internal links too.

## Progress and flashcards

Reading progress (`sdp-progress`) and flashcard history (`sdp-flashcards`) are stored in `localStorage`. Without an account they stay in that browser. Signing in (optional, see below) syncs them across devices.

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

- Each user has one row holding a JSON document of their progress and flashcard history ([`src/lib/syncDoc.ts`](src/lib/syncDoc.ts)). The browser's copy and the account's copy are merged item by item, and the newest change wins. Un-marking a section, clearing progress and resetting a deck are recorded with timestamps too, so they aren't undone by an older copy on another device.
- Changes are saved about 1.5 seconds after they happen. Scrolling to a new section, which only updates "continue where you left off", is saved after 15 seconds. The page also saves when the tab is hidden, pulls other devices' changes when the tab comes back, and retries after reconnecting.
- Writes are conditional on the row's `version`. If another device saved in between, the browser reads again, re-merges and retries, so neither device's changes are lost.
- Signing in adds what's already in the browser to the account. Signing out saves first, then clears the browser's copy. If that save fails, the person stays signed in.
- supabase-js is loaded only for people who are signed in or open the account menu.

## Deploying

This is a static site. `vercel.json` rewrites routes to `index.html`. Other hosts need an equivalent SPA fallback. The app assumes it's served from the domain root.

## License

The content is © Donne Martin, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and is credited in the site footer.
