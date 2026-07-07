# Design rationale

## Provenance, briefly

CMO began as a response to an unsolicited, machine-generated "Strategic
Blueprint" report that proposed wiring `claude-mem`, `headroom`, and
`cozempic` together into a memory stack. That report was not produced or
endorsed by any of those projects, and it misrepresented them in places. A
point-by-point teardown of it used to live in this file; it has been removed
— critiquing a bad third-party report about the tools says nothing about the
tools themselves, and the actual comparison now rests on measurements of the
shipped packages (method and numbers in
[benchmarks/README.md](benchmarks/README.md)).

What remains here is what stays relevant: the verified facts about the real
systems that shaped CMO's design, and the principles derived from them.

## Verified facts about the real systems

These were measured directly from the shipped artifacts (claude-mem@13.10.2
from npm, mempalace 3.5.0 from PyPI) — not taken from anyone's writeup,
including our own earlier one:

- **claude-mem** registers 19 MCP tools (~2,766 tokens of schema, from a live
  `tools/list` query) plus 17 skills (~1,035 tokens of always-resident
  descriptions); hooks 6 lifecycle events including `PostToolUse` on `*` and
  `PreToolUse` on every `Read`; runs a Bun-managed worker daemon; and its
  worker imports `@anthropic-ai/claude-agent-sdk` — tool-output compression
  is a background LLM call, i.e. real API spend that never appears in
  context-window accounting, and a generative step whose summarization errors
  would compound silently across sessions.
- **mempalace** registers 35 MCP tools (~4,624 tokens of schema, compact
  serialization); its own `layers.py` puts wake-up cost at ~600–900 tokens
  (the widely-quoted 170-token figure is from a third-party writeup and
  appears nowhere in the package). Storage is ChromaDB + SQLite with an
  embedding model — real retrieval strength (its published LongMemEval
  numbers are strong) bought with real operational weight, and state that
  lives outside the repo does not survive ephemeral/CI containers.

## Architectural lessons CMO is built on

1. **Never mutate state you don't own.** A daemon rewriting the CLI's
   transcript files (the `cozempic` idea) cannot shrink the live context
   window — the CLI doesn't reload the file mid-session — while it *can*
   corrupt the transcript other tools depend on, break `--resume`, and
   invalidate the prompt cache on resume. The hook protocol already provides
   the legitimate seams: `PreCompact` fires before history is flattened,
   `SessionStart(source=compact)` fires after, and
   `PostToolUse.updatedToolOutput` can replace a bulky result *before it
   enters context*. Deterministic lifecycle logic belongs there — no daemon,
   no file races, no TLS-terminating proxy.
2. **Zero background LLM calls.** Deterministic extraction costs $0 in API
   tokens, and nothing generative can silently poison future sessions. The
   glossary tier keeps this property: the model writes aliases at
   remember-time, but they land as reviewable Markdown the user can audit and
   edit — never as an unreviewed generative rewrite of past events.
3. **Resident payload is the hidden overhead.** Tool schemas and skill
   descriptions sit in context every turn (on eager-loading clients; newer
   Claude Code can defer MCP schemas — the benchmarks carry both cases).
   A memory system's *headline* startup number is meaningless without its
   schema footprint next to it.
4. **Query-driven beats push-driven at scale — with a hard cap.** mempalace's
   small-startup + on-demand retrieval is the right shape. CMO keeps the
   startup payload budgeted and *truncated at the cap*, every session; a
   growing injected index is an average, not a guarantee.
5. **Reversible trimming beats archival compression.** Replace oversized tool
   outputs on the doorstep (`updatedToolOutput`) and spill the full payload
   to a plain file the model can `Read`/`Grep` back — lossless on disk, no
   proxy, no vector store, no KV service.
6. **Memory quality must be measured, not asserted.** Token counts say
   nothing about whether the *right* memory surfaces. CMO gates recall
   quality in CI (`benchmarks/quality.js`) and reports standardized retrieval
   numbers on the real LongMemEval-S dataset (`benchmarks/longmemeval.js`) —
   including the trade-offs it loses, like uncurated paraphrase recall.

## Design principles

| # | Principle | Consequence in CMO |
|---|-----------|--------------------|
| 1 | Never mutate state you don't own | CMO never touches `~/.claude/projects/` transcripts; it only reads `transcript_path` when a hook hands it over |
| 2 | Zero background LLM calls | All capture is deterministic extraction (todos, edited files, commands, intents) — memory maintenance costs $0 in API tokens, and nothing generative can poison memory |
| 3 | Hard budget, not "small-ish" | SessionStart injection is capped (default 800 tokens) and truncated at the cap, every time |
| 4 | Memory lives in the repo | Plain Markdown under `.cmo/` — greppable, diffable, committable, survives ephemeral containers, zero databases |
| 5 | Trim on the doorstep, not in the archive | `PostToolUse.updatedToolOutput` replaces oversized outputs *before* they enter context; full payload spills to a file the model can `Read`/`Grep` back — reversible, no proxy, no KV store |
| 6 | Survive compaction | `PreCompact` snapshots working state; `SessionStart(source=compact)` re-injects only the handoff |
| 7 | Fail open | Every hook is wrapped so an error exits 0 silently — a memory plugin must never break a session |
| 8 | No daemons, no ports, no deps | Node scripts only (Claude Code already ships Node); works anywhere the CLI works, including CI and cloud containers |
| 9 | Expansion without embeddings | Synonyms are curated at remember-time (`glossary.md`) and applied deterministically at recall-time — recall breadth from write-time knowledge, not from an embedding pipeline |
