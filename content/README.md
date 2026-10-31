# Content

Every chapter and flashcard deck on the site lives in this folder as markdown. The writing is original, not copied or closely paraphrased from any book or site, and each chapter lists what it drew on under "Further reading". `npm run content` builds it into the JSON the app loads.

- `<chapter-id>.md`: one chapter each. The curriculum order lives in the `PARTS` array in `scripts/build-content.mjs`; a chapter that isn't listed there isn't published.
- `flashcards/<deck-id>.md`: one deck each, listed in `DECKS` in the same script.
- `redirects.json`: chapters, headings and decks that were renamed or replaced, and where they went. Old links, notes and bookmarks follow it (see below).
- `COVERAGE.md`: every topic in The System Design Primer, which this handbook's syllabus started from, and the section that now covers it. `npm run coverage` checks that each target still exists, so a rename can't quietly drop a topic.

## Writing a chapter

One markdown file per chapter: `content/<chapter-id>.md`. Add its id to a part in `PARTS`.

```markdown
# Chapter title

Intro paragraphs. These become the "Overview" section.

## First section

Text, lists, tables, code blocks, diagrams.

### A subsection

## Check yourself

<details>
<summary>A question that makes the reader recall or apply the chapter?</summary>

The answer, in a paragraph or two of markdown.

</details>

## Further reading

- [Title](https://example.com): why it's worth reading.
```

- Each `##` heading is a section the reader marks as done. `###` makes a subsection inside it.
- "Further reading" is folded into the section before it, so it isn't tracked on its own.
- Link to other chapters with `/learn/<chapter-id>` or `/learn/<chapter-id>#<heading-id>`. `npm run verify-content` checks every internal link.

## Diagrams

A fenced code block with the language `diagram` is drawn as an SVG at build time, so it follows the light and dark theme.

````markdown
```diagram
title: What the diagram shows, as a caption
[client:client] Client @ 0,0
[lb] Load balancer @ 1,0
[api] API servers @ 2,0
[db:store] Database @ 3,0
[q:queue] Job queue @ 2,1
[w] Workers @ 3,1
client -> lb : HTTPS
lb -> api
api -> db
api --> q : enqueue
q --> w
```
````

- Nodes: `[id] Label @ column,row`. Optional kind after a colon: `box` (default), `store` (database), `queue`, `client`, `note`. Add `span N` at the end to make a box N columns wide.
- Columns and rows start at 0, and halves like `1.5` are allowed. Up to 5 columns fit the page.
- Write `\n` in a label for a line break. Keep lines under about 18 characters.
- Edges: `a -> b`, `a <-> b`, `a --> b` (dashed, for async work), each with an optional `: label`. Edges are straight lines, so lay nodes out so lines don't cross other boxes.
- Draw at most one edge between two nodes: a second one is drawn on top of the first. A step-by-step exchange (request, reply, retry) belongs in a numbered list, not in edges.
- Keep edge labels short (under about 26 characters) and leave the boxes far enough apart that the line shows on both sides of its label.
- Write formulas and arithmetic as plain text (`10M ÷ 86,400 s ≈ 116 a second`), not LaTeX: the site has no math renderer.
- `npm run lint-diagrams` flags diagrams that will draw badly: too wide, overlapping boxes, doubled edges, lines through boxes, and labels that cover lines or each other. Readers can click any diagram to open it full size.

## Interactive diagrams

A fenced code block with the language `widget` and a diagram's name places one of the site's interactive diagrams there:

````markdown
```widget
hash-ring
```
````

The diagrams are React components in `src/widgets/` (`hash-ring`, `cache-strategies`, `replication`, `rate-limiter`, `kv-cache-calculator`, `batching-simulator`). A new one needs a component there, an entry in `src/widgets/Widgets.tsx`, and its name added to `WIDGET_NAMES` in `scripts/build-content.mjs`.

## Flashcard decks

`content/flashcards/<deck-id>.md` holds a deck. Its title and description live in `DECKS` in `scripts/build-content.mjs`.

```markdown
<!-- chapter: cache -->

## Why does a cache help a read-heavy app more than a write-heavy one?

<!-- /learn/cache#database-caching -->

The answer, in a short paragraph, a few bullets or a small table.
```

- Each `## ` heading is a card's front. The comment right after it links to the chapter or section that teaches the answer, and the card shows it as a link. Other comments are ignored.
- Take every fact on a card from the chapter it links to, so the deck never says more than the course does.
- A card's id is its question's slug, so rewording a question resets that card's review history.
- `npm run verify-content` checks the links on every card.

## Renaming or removing a chapter

Readers' progress, notes and bookmarks are keyed by chapter and section id, and other sites link to chapter URLs. To rename a chapter, or replace one with another:

1. Add the old id to `redirects.json`: under `renamed` if only the id changed and the headings stayed, or under `replaced` (pointing at the chapter, or `chapter#heading`, that took over) if the content moved. Add any headings that moved under `anchors` as `"old-chapter#old-heading": "chapter#heading"`.
2. Add the matching redirect to `vercel.json`. `npm run verify-content` lists any that are missing, and the exact destination each one needs.
3. If the old id was a saved-data key, the app's migrations (`src/lib/legacy.ts`) move notes and bookmarks to the section that now holds the heading. Progress follows renamed chapters only. Bump `DATA_VERSION` there so existing readers' saved data runs through them again.

Rewording a heading changes its section id the same way, so treat it like a rename if readers may have notes on it.
