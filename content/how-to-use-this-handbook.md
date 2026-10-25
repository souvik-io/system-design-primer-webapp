# How to use this handbook

System design is the work of deciding how a piece of software is split into parts, where its data lives, and how those parts talk to each other so the whole thing stays fast, available and affordable as it grows. This handbook teaches it from the ground up, in one place, with a worked example in every chapter and a source you can check for every real-world number.

It serves two goals:

- **Learn to design large systems.** Knowing why a site stays up under load, and why it sometimes doesn't, makes you a better engineer even if you never draw an architecture diagram at work.
- **Prepare for the system design interview.** At many tech companies, a system design round is a required part of the interview process, alongside the coding rounds. This handbook gives you the topics, a step-by-step method for the interview itself, and worked practice questions to compare your answers against.

The subject is broad, and good material on it is scattered across blog posts, papers, talks and post-mortems. The handbook gathers it into a single course with one order, one running set of examples and one place to track your progress.

## How the handbook is organized

The chapters build on each other, so the order matters most at the start.

1. **Start here.** This chapter, [the system design interview, step by step](/learn/system-design-interview), [scalability](/learn/scalability) and [back-of-the-envelope estimation](/learn/estimation). Read these first, whatever your goal.
2. **Core trade-offs.** The tensions every design has to balance: [performance and latency](/learn/performance-and-latency), [CAP and consistency](/learn/cap-and-consistency), and [availability](/learn/availability).
3. **Building blocks.** The parts a request passes through, one chapter each: DNS and CDNs, load balancers, reverse proxies and API gateways, databases, caches, queues, network protocols and security.
4. **Deeper concepts.** Ideas that come up again and again in larger designs, such as [consistent hashing](/learn/consistent-hashing), [rate limiting](/learn/rate-limiting), [event streaming](/learn/event-streaming) and [consensus](/learn/consensus).
5. **Design questions.** Full worked answers to common interview questions, such as a [URL shortener](/learn/design-url-shortener), a [news feed](/learn/design-social-news-feed) and a [chat system](/learn/design-chat-system). Each one follows the four interview steps.
6. **Object-oriented design questions.** Smaller exercises where you design classes instead of services, such as a parking lot or a deck of cards, with code.
7. **AI systems.** How large language models are served and how products are built on them: [how LLM inference works](/learn/llm-inference), GPUs, inference engines, estimating AI workloads, [retrieval-augmented generation](/learn/rag), agents, evaluation and security.
8. **AI system design questions.** Worked answers for products built on models, in the same four steps, such as a [chat assistant](/learn/design-chat-assistant), an [LLM gateway](/learn/design-llm-gateway) and a [coding assistant](/learn/design-coding-assistant).
9. **Reference.** Numbers worth remembering, a bank of extra practice questions, and real-world architectures from companies' engineering blogs.

Every chapter ends with **Check yourself** questions. Try to answer each one before you open it. Then each chapter lists **Further reading**, the sources it draws on, for when you want to go deeper.

## Do you need to know everything here?

No. You don't need to know everything in this handbook to do well in an interview.

What you get asked depends on several things:

- how much experience you have,
- your technical background,
- the role you're interviewing for,
- the companies you're interviewing with,
- and some luck.

Experienced candidates are usually expected to know more about system design than people early in their careers. Architects and team leads may be expected to know more than individual engineers. Large tech companies often have one or more system design rounds.

The best approach is to **start broad, then go deep in a few areas.** It helps to know a little about every key topic, so that nothing in an interview is completely new. Then pick a few areas, perhaps the ones closest to the jobs you want, and learn them well.

## Pick a study plan

How you spend your time depends on how long you have before your interviews. The home page can turn any of these into a study plan, with a daily goal and your progress tracked as you mark sections done.

- **Short timeline.** Aim for breadth across all the topics. Practice by working through some of the design questions.
- **Medium timeline.** Aim for breadth and some depth. Practice by working through many of the design questions.
- **Long timeline.** Aim for breadth and more depth. Practice by working through most of the design questions.

Here is what each plan covers:

| Activity | Short | Medium | Long |
| --- | --- | --- | --- |
| Read the topic chapters (start here, trade-offs, building blocks) to understand how systems work | Yes | Yes | Yes |
| Read the deeper concepts, from consistent hashing to batch processing | No | Yes | Yes |
| Read the AI systems chapters | No | No | Yes |
| Work through the AI system design questions | No | No | Most |
| Read a few articles from the engineering blogs of the companies you're interviewing with | Yes | Yes | Yes |
| Read a few real-world architectures | Yes | Yes | Yes |
| Review [the system design interview, step by step](/learn/system-design-interview) | Yes | Yes | Yes |
| Work through the system design questions | Some | Many | Most |
| Work through the object-oriented design questions | Some | Many | Most |
| Try questions from the practice question bank | Some | Many | Most |

If you're interviewing for a role that builds AI products or AI infrastructure, add the AI systems chapters and the AI system design questions to whichever plan you follow. Read them after the building blocks, since they build on caches, queues, load balancers and rate limits.

The Reference part has three chapters to come back to: [Numbers to know](/learn/numbers-to-know) for estimates, [Practice questions](/learn/practice-questions) for more questions to try, and [Real-world architectures](/learn/real-world-architectures) for papers, company architectures and engineering blogs.

## How to study a chapter

Reading a chapter once is not the same as being able to use it in an interview. A few habits help it stick:

- **Read one section at a time, then mark it done.** Each section is short enough to finish in one sitting, and the sidebar shows how far you've got.
- **Answer the Check yourself questions before opening them.** Saying an answer out loud, or writing it down, shows you what you actually remember.
- **Review with flashcards.** The [flashcards](/flashcards) page has decks for every part of the handbook. They use spaced repetition, so the cards you find hard come back sooner.
- **Practice design questions out loud, with a timer.** Pick a question, give yourself 45 minutes, and talk through the four interview steps as if someone were listening. Only then read the worked answer and compare.
- **Keep notes.** You can add a note or a bookmark to any section, and find them all on the notes page.

## An open handbook

This handbook is open source. The site's code and all its chapters are on [GitHub](https://github.com/souvik-io/system-design-primer-webapp). The chapters are published under the Creative Commons Attribution 4.0 license, so you may share and adapt them as long as you credit the source.

If you find a mistake, a broken link or a topic that's missing, open an issue or a pull request there. Corrections are welcome, and each chapter's sources are listed so you can check any claim yourself.

## Check yourself

<details>
<summary>You have two weeks before a system design interview. What should you focus on?</summary>

Breadth. Read the topic chapters so that no common building block or trade-off is new to you, and review the four interview steps. Then work through some of the design questions, out loud and timed, and compare your answers with the worked solutions. With little time, depth in one area matters less than not being caught out by a topic you've never heard of.

</details>

<details>
<summary>Why does the handbook suggest answering Check yourself questions before opening them?</summary>

Trying to recall an answer shows you what you actually know, and the effort of recalling it helps you remember it later. Reading the answer first feels like understanding, but it doesn't tell you whether you could produce that answer yourself in an interview.

</details>

<details>
<summary>A friend with ten years of experience and a new graduate are interviewing for different roles at the same company. Should they prepare the same way?</summary>

Not quite. Both should cover the basics, but interviewers usually expect more depth from experienced candidates, and even more from people interviewing for architect or lead roles. The experienced engineer should plan for deeper follow-up questions on trade-offs and scaling, and use a longer study plan if time allows.

</details>

## Further reading

- [How to ace a systems design interview](https://web.archive.org/web/20210505130322/https://www.palantir.com/2011/10/how-to-rock-a-systems-design-interview/): an archived 2011 post from Palantir's engineering team on what interviewers look for. It stresses the thought process behind a design over the design itself.
- [Episode 06: Intro to Architecture and Systems Design Interviews](https://www.youtube.com/watch?v=ZgdS0EUmn70): Jackson Gabbard's video introduction to what architecture and system design interviews involve.
