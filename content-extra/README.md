# Extra chapters

Chapters written for this site to cover topics The System Design Primer doesn't. They are hidden until a reader turns on **Extra chapters** on the home page.

These are original writing, not copied or closely paraphrased from any book or site. Each chapter lists what it drew on under "Further reading". The curriculum order lives in the `EXTRA_PARTS` array in `scripts/build-content.mjs`.

A chapter can also be a **companion** to a primer chapter: always shown, placed in a primer part, and marked "Written for this site". `scalability-101` is one, a beginner's walkthrough of the lecture and article that "System design topics: start here" points to. Add it to a part's `readme` list as `{ companion: '<chapter-id>' }`, and add a note to the primer chapter that links to it with `PRIMER_NOTES` in the same script.

## Writing a chapter

One markdown file per chapter: `content-extra/<chapter-id>.md`.

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

## Interactive diagrams

A fenced code block with the language `widget` and a diagram's name places one of the site's interactive diagrams there:

````markdown
```widget
hash-ring
```
````

The diagrams are React components in `src/widgets/` (`hash-ring`, `cache-strategies`, `replication`, `rate-limiter`). A new one needs a component there, an entry in `src/widgets/Widgets.tsx`, and its name added to `WIDGET_NAMES` in `scripts/build-content.mjs`. Primer chapters can't be edited, so their diagrams are placed by `PRIMER_WIDGETS` in the same script.

## Flashcard decks

`content-extra/flashcards/<deck-id>.md` holds a deck written for this site. Its title and description live in `SITE_DECKS` in `scripts/build-content.mjs`, and `extra: true` there shows the deck only when extra chapters are turned on.

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
