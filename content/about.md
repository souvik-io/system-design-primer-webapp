# About this handbook

The System Design Handbook is a free, open-source course in system design. It teaches how large software systems are built: how they stay fast, how they survive failures, and how they grow from one server to millions of users. It also prepares you for the system design interview, where you're asked to design such a system out loud in about 45 minutes.

Every chapter is written for this site in plain language, and each one lists the sources it draws on under "Further reading". If you're new, start with [How to use this handbook](/learn/how-to-use-this-handbook).

## Flashcards

The [flashcards](/flashcards) help you remember what you've read. They use **spaced repetition**: a card you answer easily comes back after a longer gap, and a card you miss comes back soon. Reviewing a few minutes a day this way is enough to keep the key ideas fresh.

The scheduler works much like the one in [Anki](https://apps.ankiweb.net/), the popular flashcard app. New cards go through a few short learning steps, then the gap between reviews grows each time you remember the card.

Each card links to the section that teaches it, so when you miss one you can go straight back to the explanation. The decks cover one card per topic, the decisions inside each design question, and a walkthrough of each full design. Your review history is saved in your browser, and it's synced to your account if you sign in.

### Coding interview practice

System design is usually one round of several. Most interview loops also include coding rounds on algorithms and data structures. For those, [Interactive Coding Challenges](https://github.com/donnemartin/interactive-coding-challenges) is a free collection of problems with solutions in Python notebooks, and it includes its own Anki deck.

## Under development

The handbook is still growing. The next part being written covers AI systems: how large language models are served, what GPUs and inference engines do, and how to design products built on them, such as a chat assistant, a retrieval-augmented question-answering service and an inference platform.

Some topics that were once listed here as unfinished now have full chapters:

- **MapReduce:** [Batch processing](/learn/batch-processing#mapreduce-the-foundational-model).
- **Consistent hashing:** [Consistent hashing](/learn/consistent-hashing).
- **Scatter-gather:** [scatter-gather queries](/learn/database-internals#scatter-gather-queries) in Database internals, and the search service in [Design the Twitter timeline and search](/learn/design-twitter).

If there's a topic you'd like to see, open an issue (see [Contributing](#contributing)).

## Contributing

The handbook is open source, and fixes and improvements are welcome. The source is on GitHub at [souvik-io/system-design-primer-webapp](https://github.com/souvik-io/system-design-primer-webapp). You can help by:

- fixing errors, from typos to wrong numbers;
- making an explanation clearer;
- adding a chapter, a design question, a diagram or flashcards;
- translating the site.

Chapters are markdown files in the repository's `content/` folder. Its README explains the chapter format, diagrams and flashcard decks. Open an issue first for anything large, so the work can be planned together.

## Credits

The handbook began as a reader for [The System Design Primer](https://github.com/donnemartin/system-design-primer) by Donne Martin, released under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/). Its syllabus shaped this one: the topics, their order, and the classic design questions all come from it. The chapters here are written fresh, and each one credits its own sources.

These resources were also thanked by the primer, and they remain worth reading:

- [HiredInTech's system design guide](https://www.hiredintech.com/system-design/)
- [Cracking the Coding Interview](https://www.amazon.com/dp/0984782850/), by Gayle Laakmann McDowell
- [High Scalability](https://highscalability.com/)
- [checkcheckzz/system-design-interview](https://github.com/checkcheckzz/system-design-interview)
- [shashank88/system_design](https://github.com/shashank88/system_design)
- [mmcgrana/services-engineering](https://github.com/mmcgrana/services-engineering)
- [System design cheat sheet](https://gist.github.com/vasanthk/485d1c25737e8e72759f)
- [A distributed systems reading list](https://dancres.github.io/Pages/)
- [Crack the system design interview](https://tianpan.co/notes/2016-02-13-crack-the-system-design-interview)

## Contact info

For questions, corrections or ideas, [open an issue on GitHub](https://github.com/souvik-io/system-design-primer-webapp/issues). It's the fastest way to reach the maintainer, and it lets others see the answer too.

## License

The handbook's chapters and flashcards are licensed under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0): you may share and adapt them as long as you credit the source. The site's code is released under the MIT License, in the repository's [LICENSE](https://github.com/souvik-io/system-design-primer-webapp/blob/main/LICENSE) file.

The System Design Primer, which the handbook's syllabus is based on, is © 2017 Donne Martin and licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
