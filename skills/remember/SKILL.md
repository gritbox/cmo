---
name: remember
description: Save a durable fact, decision, or preference to project memory so future sessions start with it. Use when the user says "remember this", "note for next time", "always/never do X in this project", or immediately after an important decision (library choice, architecture, convention) is settled. Argument: the fact to remember.
allowed-tools: Read Write Edit Glob
---

# Remember a durable fact

Persist to project memory: **$ARGUMENTS**

If no argument was given, infer the fact from the immediately preceding
conversation and state what you are saving before saving it.

1. Ensure `.claude/memory/` exists.
2. Rewrite the fact as a single self-contained bullet a future session can act
   on without this conversation's context. Bad: "use the second option".
   Good: "Use pnpm, not npm — the lockfile is pnpm-lock.yaml."
3. Append it to `.claude/memory/decisions.md` under a `### YYYY-MM-DD` heading
   (create the file with a `# Decisions` title if missing). Before appending,
   check for an existing entry on the same topic: if the new fact supersedes
   it, **edit the old entry in place** instead of appending a contradiction.
4. Budget discipline: `decisions.md` is injected at every session start.
   If it exceeds ~60 lines, consolidate the oldest entries — merge related
   bullets, move narrative history into
   `.claude/memory/journal/<current YYYY-MM>.md`, and keep only what changes
   future behavior.
5. If the fact is core orientation (what the project is, key entry points,
   invariants), put it in `.claude/memory/index.md` instead of
   `decisions.md` — same conciseness rules.

Confirm to the user in one line what was written and where.
