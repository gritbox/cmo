# CMO — Context & Memory Optimizer for Claude Code

Deterministic, zero-API-cost cross-session memory and context management,
packaged as a single Claude Code plugin. No daemons, no databases, no MCP
server, no Python — five small Node scripts (Claude Code already ships Node)
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
| Oversized tool output | `PostToolUse` hook (`updatedToolOutput`) | Output > 30k chars is first **line-deduplicated with counts** (`[xN]` — logs and test spam compress dramatically, losing no distinct line), then head/tail-excerpted if still over; the **full payload is preserved** in `.claude/memory/spill/` and recoverable via `Read`/`Grep` |
| Every user prompt | `UserPromptSubmit` hook | Just-in-time recall: when a prompt's distinctive terms match journal history, injects a ≤100-token pointer to the matching lines. Precision-first: fires only on two co-occurring concepts or one curated glossary concept; synonyms reach it via stemming + glossary expansion; bare affirmations ("sure, go ahead") resolve their referent from the previous assistant turn; never repeats a pointer within a session |
| Retrieval | `/cmo:recall` skill (model- and user-invocable) | Tiered lazy search: index → handoff → ranked synonym-aware search (`scripts/search.js`, glossary-expanded, weak matches labeled) → `Grep` the journal → `Grep` spill files. On a miss the model retries with its own synonyms — the searcher is the query expander |
| Durable facts | `/cmo:remember` skill | Curates `decisions.md`/`index.md` with supersede-in-place and a line budget, plus `glossary.md` aliases (recall insurance: the write-time model records the synonyms it can foresee, so recall-time expansion has something to expand) |

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
| `CMO_JIT` | on | Set to `off` to disable just-in-time recall pointers |
| `CMO_JIT_BUDGET_TOKENS` | `100` | Hard cap on a just-in-time pointer |

Staleness gating exists because a weeks-old "working state" presented as
current is memory poisoning, not memory. Snapshots also capture **git commits
made during the session** (scoped by the transcript's first timestamp) — the
highest-signal deterministic record of what actually happened.

If you don't want memory in version control, add `.claude/memory/` to
`.gitignore`; at minimum ignore the spill cache (see this repo's
`.gitignore`).

## How it compares to claude-mem and MemPalace

Run `node benchmarks/bench.js` (no dependencies). Part 1 executes the real
hook scripts against a synthetic 40-turn transcript; Part 2 feeds the measured
numbers into an overhead model alongside the competitors' figures — measured
from their shipped packages where possible, their own published claims where
not (sources, serialization method, and parameters in
[benchmarks/README.md](benchmarks/README.md)).

Measured on this machine:

```
SessionStart injection:     415 tokens (budget cap: 800)
Handoff snapshot size:      216 tokens
Trim (180k-char log):       46973 -> 5679 tokens (88% saved, lossless on disk)
Hook latency:               snapshot ~57ms · session-start ~45ms · trim ~44ms
```

Lifetime overhead a memory system adds to a 100-session × 40-turn project
(conversation history itself is identical everywhere and excluded).
Competitor resident payloads are **measured from their shipped packages**
(claude-mem@13.10.2 via a live `tools/list` query against its MCP server —
19 tools; mempalace 3.5.0 via its wheel's `TOOLS` registry — 35 tools;
MemPalace's startup is its own `layers.py` figure of ~600–900 tokens,
midpoint 750):

| System | Resident tokens/session (startup + tool schemas) | Context tokens added (lifetime) | Background API tokens (lifetime) | Total overhead |
|---|---|---|---|---|
| claude-mem (measured pkg + published claims) | 5,301 | 21,354,000 | 6,000,000 | 27,354,000 |
| MemPalace (measured pkg + own published claims) | 5,374 | 21,856,000 | 0 | 21,856,000 |
| **CMO (measured)** | **592** | **2,440,000** | **0** | **2,440,000** |

**Under these assumptions, ~89–91% lower total overhead than both — but the
honest summary is a range, not one percentage.** The model's biggest term is
MCP tool schemas resident in context every turn; newer Claude Code versions
can defer MCP schemas and load them on demand, which removes most of that
term. `bench.js` prints a sensitivity table varying schema residency and
MemPalace's startup figure: the claude-mem comparison stays **85–91% lower**
in every scenario (its background LLM spend and resident skill descriptions
don't depend on schema residency), while the MemPalace comparison ranges from
**~89% lower** (eager schemas) through **~27% lower** (deferred schemas,
MemPalace's own startup figure) to **modestly higher** in the most
MemPalace-favorable corner (deferred + the third-party 170-token startup
figure its own package contradicts). Token counts are also face-value: prompt
caching discounts re-sent context (but not claude-mem's background calls) in
dollar terms.

On quality, two harnesses:

- `node benchmarks/quality.js` — a synthetic **regression gate** over the
  real hooks (not comparable to standardized benchmarks): 100% direct and
  topical recall, **88% paraphrase recall when remember-time curation wrote
  glossary aliases** (0% uncurated — the honest keyword floor, kept measured),
  95% just-in-time pointers on on-topic prompts, **95% on vague affirmations**
  ("sure, go ahead") resolved from the previous assistant turn, and 0 false
  positives/fires everywhere — all gated in CI.
- `node benchmarks/longmemeval.js` — CMO's real retrieval run against the
  actual **LongMemEval-S** dataset (470 questions), the benchmark MemPalace
  reports 96.6% R@5 on. CMO's shipped journal digests score **76.6% R@5**
  with zero API calls, zero embeddings, and ~1-line-per-session storage;
  the same keyword ranking over verbatim text reaches **93.6% R@5**, so most
  of the gap to semantic search is *retention policy, not search method* —
  and the dataset plays to none of CMO's curated tiers (no /cmo:remember, no
  glossary, no model-side query reformulation in the harness).

Why the overhead gap, structurally:

1. **Zero background LLM spend.** claude-mem ships every tool call's raw
   output through a background Agent SDK compression call (mechanism verified
   in its shipped worker; the volume is modeled, not measured). That's the
   largest single line item in its column above, and it's invisible in
   context-window accounting.
2. **Zero MCP tool-schema tax.** MemPalace's v3.5.0 server registers **35
   MCP tools** — a measured ~4,624 tokens of schema (compact serialization)
   that eager-loading clients keep resident every turn, ~6× its own ~750-token
   startup claim. claude-mem's server returns 19 tools (~2,766 tokens) plus
   ~1,035 tokens of bundled skill descriptions. CMO uses no MCP server;
   retrieval is native `Grep`/`Read` plus two skill descriptions (a measured
   ~177 tokens — held to the same measurement standard as the competitors').
3. **A cap, not an average.** claude-mem's injected index grows with history.
   CMO's injection is truncated at a configurable hard budget, every session.
4. **Lossless trimming with no infrastructure.** The headroom-style
   compression idea, implemented natively via `updatedToolOutput` + a spill
   file — no proxy, no vector DB, no KV store, and the model can recover any
   byte on demand.
5. **Nothing to install or babysit.** No SQLite, no ChromaDB, no worker
   daemon, no filesystem watcher rewriting transcripts it doesn't own. Works
   identically on laptops, CI, and ephemeral cloud containers.
6. **Auditable memory.** Every remembered fact is a Markdown line with a date
   in your repo. `git blame` your memory. Delete a wrong memory with your
   editor, not a database client.

What CMO deliberately does **not** do: semantic/vector search. For
project-scoped engineering memory, ranked keyword search over structured
Markdown — stemmed, expanded through a curated glossary, and performed by a
model that is itself good at choosing and reformulating search terms — covers
the retrieval need without an embedding pipeline's cost, weight, and failure
modes; the LongMemEval numbers above put a measured price on that trade-off.
It is argued in [ANALYSIS.md](ANALYSIS.md).

## Layout

```
.claude-plugin/plugin.json     plugin manifest (+ marketplace.json)
hooks/hooks.json               lifecycle wiring
scripts/session-start.js       budgeted injection
scripts/snapshot.js            PreCompact/SessionEnd state capture
scripts/trim.js                reversible output trimming (dedup + excerpt)
scripts/jit-recall.js          just-in-time recall pointers
scripts/search.js              ranked synonym-aware memory search (used by /cmo:recall)
scripts/lib.js                 shared helpers (stdin, transcript parsing, term expansion)
skills/recall/SKILL.md         tiered retrieval (/cmo:recall)
skills/remember/SKILL.md       durable-fact + glossary curation (/cmo:remember)
benchmarks/bench.js            measurement harness + overhead model + sensitivity
benchmarks/quality.js          recall-quality regression gate
benchmarks/longmemeval.js      LongMemEval-S retrieval benchmark (opt-in, real dataset)
test/hooks.test.js             hook test suite (`node --test`)
```

## Development

```
node --test                    # run the test suite (no dependencies)
node benchmarks/bench.js       # token-overhead harness + sensitivity analysis
node benchmarks/quality.js     # recall-quality gate (non-zero exit on regression)
node benchmarks/longmemeval.js <longmemeval_s.json>   # standardized retrieval benchmark
```

CI runs both on Linux, macOS, and Windows against Node 18 and 22.
