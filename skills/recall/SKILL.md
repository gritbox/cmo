---
name: recall
description: Search this project's memory from past Claude Code sessions. Use when the user references earlier work ("last time", "as we discussed", "why did we…", "what was decided about…"), when a vague reply ("sure, go ahead") points back at something you proposed from memory, or when context about a prior decision, bug fix, or architectural choice is missing. Argument: what to look for.
allowed-tools: Read Grep Glob Bash
---

# Recall project memory

Search the plain-Markdown memory under `.claude/memory/` for: **$ARGUMENTS**

If the argument is vague ("that", "go ahead"), resolve it from the
conversation first — the thing being referred to is usually in your own
previous message.

Work tier by tier and stop as soon as you have the answer — do not read
everything.

1. **Index & decisions (cheapest).** Read `.claude/memory/index.md` and
   `.claude/memory/decisions.md` if they exist. These are small, curated files;
   the answer to "what did we decide" questions is usually here.
2. **Handoff.** Read `.claude/memory/handoff.md` for the most recent working
   state (intent, todos, files touched) if the question is about what was in
   flight.
3. **Ranked search (synonym-aware).** Run
   `node "$CLAUDE_PLUGIN_ROOT/scripts/search.js" --cwd "$PWD" --top 5 <terms>`
   with the distinctive terms of the query. It stems, expands terms through
   `.claude/memory/glossary.md`, and ranks every memory line by how many
   distinct concepts it matches. If the first run misses, run it once more
   with synonyms you'd expect a past session to have used instead (e.g.
   "http client" for "fetch wrapper") — you are the query expander; two short
   runs cost almost nothing.
4. **Journal (grep, don't read).** For exact strings the search step can't
   rank (error messages, commit hashes), Grep `.claude/memory/journal/` with
   `-C 2` and only Read a section grep already matched.
5. **Spill files.** If a journal or handoff entry points at
   `.claude/memory/spill/*.txt` (full outputs preserved by trimming), Grep
   inside the specific spill file rather than reading it whole.

If nothing matches, say so plainly and ask the user rather than guessing —
absent memory is not evidence about what happened.

When you find the answer, cite which memory file it came from so the user can
correct stale entries. If the query used a synonym the memory didn't (that is
why step 3 needed a second run), add the missing alias to
`.claude/memory/glossary.md` so the next lookup matches on the first try.
