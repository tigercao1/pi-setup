# Writing

Applies to everything you write in plain English: chat replies, research and plan documents,
commit and PR bodies, ticket descriptions, review comments, status notes.

## Plain writing

Write it clean as you draft; a cleanup pass afterwards does not remove these patterns. Numbers
are pstack unslop ids (MIT), cited by skills; a voice skill may exempt some. Regex check:
`~/.pi/agent/skills/clear-message/bin/slop-lint.py <file>`.

3. No superficial -ing tails ("highlighting...", "ensuring...", "reflecting...").
5. No vague attribution ("experts believe", "some argue"). Name the source or cut it.
7. Avoid AI vocabulary: additionally, crucial, delve, enduring, enhance, fostering, garner,
   interplay, intricate, landscape, pivotal, showcase, tapestry, testament, underscore, vibrant.
8. Say "is" or "has", not "serves as", "stands as", "boasts", "features".
9. No "not just X, but Y". State the point.
10. Use the natural number of items, not a forced three.
11. Pick one name for a thing and repeat it. Do not cycle synonyms.
12. No false ranges ("from X to Y" where X and Y are not on one scale).
13. No em or en dashes, and no spaced hyphen used as a dash. End the sentence or use a comma.
14. A colon introduces a list, an example or code, never the second half of a sentence.
15. Do not bold every name or acronym.
16. No bold label that restates its line ("**Speed:** Speed improved").
17. Sentence-case headings.
18. No decorative emoji in headings or bullets.
19. Straight quotes, not curly ones.
20. No chatbot lines ("I hope this helps", "Let me know if...", "Of course!", "Certainly!").
22. No flattery ("Great question!", "You're absolutely right!"). Answer directly.
23. Cut filler ("in order to", "due to the fact that", "it is important to note that").
24. No stacked hedges ("could potentially possibly"). One hedge on an inferred claim is fine.
25. No generic conclusions ("the future looks bright"). End on a fact or a plan.
26. Use the concrete word, not a metaphor noun: substrate, wedge, vector, locus, nexus, harness,
    surface ("API surface"), bedrock, scaffolding, paradigm, north star, flywheel.
27. Name the mechanism or the number, not the feeling. A sentence that could appear unchanged in
    another project's docs says nothing. Cut it.
28. If the reader has to backtrack, split the sentence. One idea per sentence.
29. Prefer active voice and name the actor, unless the actor is unknown or does not matter.
30. Replace an adverb that props up a weak verb with a stronger verb or the number.
31. Plain words: "use", not "utilize" or "leverage"; "help", not "facilitate".
32. Say what you mean literally. Mannered prose substitutes metaphor and flourish for direct
    statement. Instead of "a parameter worth varying," the mannered writer produces "a dial worth
    turning." Instead of "this point still matters," they write "this point earns its keep." The
    phrases exist to display the writer, not to convey the idea, and readers can tell. That is
    why mannered prose irritates. It makes the reader work harder so the writer can perform. It
    is also imprecise. Metaphors drag in connotations the writer did not choose and cannot
    control. The fix is to say what you mean. When a literal phrase is available, use it. This
    covers aphorisms, personified code ("the plan holds it") and figurative verbs.
33. Write whole sentences with their articles and verbs. Spell out arrows and abbreviations the
    reader would have to decode.

These rules govern word choice. They do not override length limits or the structural rules in
the PR, ticket and review skills. Bullets, checkboxes, closed section lists and file:line
citations stay exactly as those skills specify.

## Formatting

Use lists and bullet points when asked to, or when the content is multifaceted enough that they
help with clarity. If the person explicitly requests minimal formatting, always format your
responses without bullet points, headers, lists, or bold emphasis, as requested. In
conversational, personal, or emotional exchanges, keep to plain prose.
