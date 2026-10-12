# System Design Primer: interactive course

A React app that presents [The System Design Primer](https://github.com/donnemartin/system-design-primer) as a course: chapters split into sections, progress tracking, spaced-repetition flashcards, search, and dark mode.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # static site in dist/
npm run verify-content   # check nothing from the primer went missing
```

The first run clones the primer into `source-repo/` and generates the content. Building needs Node 22.13 or newer (the flashcard decks are read with `node:sqlite`).

## How content is built

`scripts/build-content.mjs` reads the primer at build time and writes:

| Output                            | What it is                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| `src/generated/manifest.json`     | Course outline: parts, chapters, sections, reading time, decks |
| `public/content/<chapter>.json`   | Pre-rendered HTML per chapter (syntax highlighting done here)  |
| `public/content/flashcards/*.json` | The three Anki decks, cleaned up                              |
| `public/content/search.json`      | Plain-text index used by search                                |
| `public/repo/...`                 | Diagrams referenced by the content                             |

- README `##` topics become chapters, and `###` headings become trackable sections. Database also splits at `####`. "Disadvantage(s)" and "Source(s)" are folded into the section before them.
- Solution READMEs and the OOD notebooks each become a chapter. Each solution also shows its full `.py` files under "Full source code".
- The README's Anki, Under development, Contributing, Credits, Contact and License sections form an "About the primer" chapter, which doesn't count toward progress.
- `scripts/flashcards.mjs` unpacks the `.apkg` decks (zip + SQLite), strips GitHub's inline styles, and re-highlights the code.
- Links between topics are rewritten to in-app routes. Imgur and GitHub camo diagrams are swapped for the copies in the repo where they exist.

To pull upstream changes, run `git -C source-repo pull`, then `npm run content` and `npm run verify-content`. The curriculum order lives in the `PARTS` array at the top of the build script.

## Checking content

`npm run verify-content` compares every paragraph, heading, list item, table cell, code block and image in the primer with the generated site, and checks that every internal link and image resolves. It lists what is left out on purpose (the README's tables of contents, language links and notebook attribution lines) and exits with an error if anything else is missing.

## Progress and flashcards

Reading progress (`sdp-progress`) and flashcard history (`sdp-flashcards`) are stored in `localStorage`, so they stay in one browser. There is no account or sync.

Flashcards use an SM-2 style schedule like Anki's: Again (1 minute), Hard, Good and Easy, with intervals growing by each card's ease. New cards are limited per deck per day, 10 by default.

## Deploying

This is a static site. `vercel.json` rewrites routes to `index.html`. Other hosts need an equivalent SPA fallback. The app assumes it's served from the domain root.

## License

The content is © Donne Martin, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and is credited in the site footer.
