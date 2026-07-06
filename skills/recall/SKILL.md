---
name: recall
description: Search this project's memory from past Claude Code sessions. Use when the user references earlier work ("last time", "as we discussed", "why did we…", "what was decided about…"), when context about a prior decision, bug fix, or architectural choice is missing, or when resuming work after a break. Argument: what to look for.
allowed-tools: Read Grep Glob
---

# Recall project memory

Search the plain-Markdown memory under `.claude/memory/` for: **$ARGUMENTS**

Work tier by tier and stop as soon as you have the answer — do not read
everything.

1. **Index & decisions (cheapest).** Read `.claude/memory/index.md` and
   `.claude/memory/decisions.md` if they exist. These are small, curated files;
   the answer to "what did we decide" questions is usually here.
2. **Handoff.** Read `.claude/memory/handoff.md` for the most recent working
   state (intent, todos, files touched) if the question is about what was in
   flight.
3. **Journal (grep, don't read).** Journal files in `.claude/memory/journal/`
   are append-only monthly digests. Grep them for keywords from the query
   (file names, feature names, error strings) with a couple of lines of
   context (`-C 2`); only Read a journal file section that grep already
   matched.
4. **Spill files.** If a journal or handoff entry points at
   `.claude/memory/spill/*.txt` (full outputs preserved by trimming), Grep
   inside the specific spill file rather than reading it whole.

If nothing matches, say so plainly and ask the user rather than guessing —
absent memory is not evidence about what happened.

When you find the answer, cite which memory file it came from so the user can
correct stale entries.
