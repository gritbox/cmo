# CMO — Context & Memory Optimizer for Claude Code

Deterministic, zero-API-cost cross-session memory and context management,
packaged as a single Claude Code plugin. No daemons, no databases, no MCP
server, no Python — three small Node scripts (Claude Code already ships Node)
and two skills.

CMO was designed from a critical review of the `claude-mem` / `mempalace` /
`headroom` / `cozempic` stack — see [ANALYSIS.md](ANALYSIS.md) for the full
teardown and the design principles derived from it.

## What it does

| Lifecycle point | Mechanism | Effect |
|---|---|---|
| Session start / resume / clear | `SessionStart` hook | Injects a **hard-budgeted** memory slice (default ≤ 800 tokens, truncated at the cap): last working state, durable decisions, curated index |
| Before compaction | `PreCompact` hook | Deterministically snapshots working state (intent, todos, edited files, recent commands) from the transcript to `.claude/memory/handoff.md` |
| After compaction | `SessionStart(source=compact)` hook | Re-injects only the handoff, so compaction never loses the thread |
| Session end | `SessionEnd` hook | Appends a deduplicated digest to an append-only monthly journal |
| Oversized tool output | `PostToolUse` hook (`updatedToolOutput`) | Output > 30k chars is replaced in context with head + tail + pointer; the **full payload is preserved** in `.claude/memory/spill/` and recoverable via `Read`/`Grep` |
| Retrieval | `/cmo:recall` skill (model- and user-invocable) | Tiered lazy search: index → handoff → `Grep` the journal → `Grep` spill files |
| Durable facts | `/cmo:remember` skill | Curates `decisions.md`/`index.md` with supersede-in-place and a line budget |

All capture is **deterministic extraction** — no LLM summarization anywhere, so
memory maintenance costs $0 in API tokens and nothing generative can silently
poison future sessions. Memory is **plain Markdown inside the repo**
(`.claude/memory/`): greppable, diffable, reviewable in PRs, and it survives
ephemeral containers and travels to teammates if committed.

## Install

From this repo as a marketplace:

```
/plugin marketplace add gritbox/cmo
/plugin install cmo@cmo
```

Or for local development: clone, then `claude --plugin-dir /path/to/cmo`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CMO_BUDGET_TOKENS` | `800` | Hard cap on SessionStart injection |
| `CMO_TRIM_CHARS` | `30000` | Tool-output size that triggers trimming (`0` disables) |
| `CMO_STALE_HOURS` | `48` | Handoff older than this is injected with an explicit STALE label |
| `CMO_STALE_DROP_DAYS` | `14` | Handoff older than this collapses to a one-line pointer |
| `CMO_SPILL_MAX` | `50` | Maximum spill files kept (oldest pruned first) |

Staleness gating exists because a weeks-old "working state" presented as
current is memory poisoning, not memory. Snapshots also capture **git commits
made during the session** (scoped by the transcript's first timestamp) — the
highest-signal deterministic record of what actually happened.

If you don't want memory in version control, add `.claude/memory/` to
`.gitignore`; at minimum ignore the spill cache (see this repo's
`.gitignore`).

## How it beats claude-mem and MemPalace

Run `node benchmarks/bench.js` (no dependencies). Part 1 executes the real
hook scripts against a synthetic 40-turn transcript; Part 2 feeds the measured
numbers into an overhead model alongside the competitors' *published* figures
(sources and parameters in [benchmarks/README.md](benchmarks/README.md)).

Measured on this machine:

```
SessionStart injection:     415 tokens (budget cap: 800)
Handoff snapshot size:      216 tokens
Trim (180k-char log):       46973 -> 5679 tokens (88% saved, lossless on disk)
Hook latency:               snapshot ~57ms · session-start ~45ms · trim ~44ms
```

Lifetime overhead a memory system adds to a 100-session × 40-turn project
(conversation history itself is identical everywhere and excluded):

| System | Resident tokens/session (startup + tool schemas) | Context tokens added (lifetime) | Background API tokens (lifetime) | Total overhead |
|---|---|---|---|---|
| claude-mem (published claims) | 1,860 | 7,590,000 | 6,000,000 | 13,590,000 |
| MemPalace (published claims) | 2,450 | 10,160,000 | 0 | 10,160,000 |
| **CMO (measured)** | **495** | **2,040,000** | **0** | **2,040,000** |

**~85% lower total overhead than claude-mem, ~80% lower than MemPalace.**

Why, structurally:

1. **Zero background LLM spend.** claude-mem ships every tool call's raw
   output through a background Agent SDK compression call. That's the largest
   single line item in its column above, and it's invisible in context-window
   accounting.
2. **Zero MCP tool-schema tax.** MemPalace's "170-token startup" is real but
   omits its 19 MCP tool schemas resident in context every turn. CMO uses no
   MCP server; retrieval is native `Grep`/`Read` plus two skill descriptions
   (~80 tokens).
3. **A cap, not an average.** claude-mem's injected index grows with history.
   CMO's injection is truncated at a configurable hard budget, every session.
4. **Lossless trimming with no infrastructure.** The headroom-style
   compression idea, implemented natively via `updatedToolOutput` + a spill
   file — no proxy, no vector DB, no KV store, and the model can recover any
   byte on demand.
5. **Nothing to install or babysit.** No SQLite, no ChromaDB, no worker on
   port 37777, no filesystem-watcher daemon rewriting transcripts it doesn't
   own. Works identically on laptops, CI, and ephemeral cloud containers.
6. **Auditable memory.** Every remembered fact is a Markdown line with a date
   in your repo. `git blame` your memory. Delete a wrong memory with your
   editor, not a database client.

What CMO deliberately does **not** do: semantic/vector search. For
project-scoped engineering memory, keyword `Grep` over structured Markdown —
performed by a model that is itself good at choosing search terms — covers the
retrieval need without an embedding pipeline's cost, weight, and failure
modes. That trade-off is argued in [ANALYSIS.md](ANALYSIS.md).

## Layout

```
.claude-plugin/plugin.json     plugin manifest (+ marketplace.json)
hooks/hooks.json               lifecycle wiring
scripts/session-start.js       budgeted injection
scripts/snapshot.js            PreCompact/SessionEnd state capture
scripts/trim.js                reversible output trimming
scripts/lib.js                 shared helpers (stdin, transcript parsing)
skills/recall/SKILL.md         tiered retrieval (/cmo:recall)
skills/remember/SKILL.md       durable-fact curation (/cmo:remember)
benchmarks/bench.js            measurement harness + overhead model
test/hooks.test.js             hook test suite (`node --test`)
```

## Development

```
node --test                # run the test suite (18 tests, no dependencies)
node benchmarks/bench.js   # run the benchmark harness
```

CI runs both on Linux, macOS, and Windows against Node 18 and 22.
