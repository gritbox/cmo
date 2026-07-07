# Benchmark methodology

Three harnesses, no dependencies:

- `node bench.js` — token-overhead measurement, comparison model, and
  sensitivity analysis
- `node quality.js` — recall-quality regression gate (exits non-zero on
  regression)
- `node --max-old-space-size=8192 longmemeval.js <longmemeval_s.json>` —
  standardized retrieval benchmark on the real LongMemEval-S dataset (opt-in;
  the dataset is a ~278 MB download from
  <https://huggingface.co/datasets/xiaowu0162/longmemeval>)

## Part 1 — measurement (CMO only)

The harness synthesizes a 40-turn Claude Code transcript (reads, bash runs,
edits, a todo list, two user prompts) in a temp project, then invokes the
actual hook scripts through their real stdin JSON contract, exactly as the
CLI would:

- `snapshot.js` (SessionEnd) → measures handoff size and verifies journal write
- `session-start.js` (startup, with 12 accumulated decisions) → measures
  injected `additionalContext` tokens against the budget
- `trim.js` (PostToolUse on a ~180k-char log) → measures in-context reduction
  and verifies the spill file preserves the full payload

Tokens are estimated at 4 chars/token throughout (same convention for all
systems, so ratios are unaffected).

## Part 2 — overhead model (comparison)

All memory systems pay the identical conversation-history cost, so the model
counts only what a memory system **adds**:

```
total = S·T·(startup + toolSchemas)                  resident payload, every turn
      + S·T·rate·perUse·(T/2)/T                      retrievals, resident for ~half a session
      + S·T·backgroundPerTurn                        maintenance API tokens
```

with S = 100 sessions, T = 40 turns, average raw tool payload 1,500 tokens.
CMO's column additionally charges its own jit-recall pointers (60 tokens at a
10% fire rate) so the hook's cost isn't hidden.

Two accounting caveats apply to every row: tokens are counted at face value
with **no prompt-caching discount** (cached re-sends are ~10× cheaper in
dollars, which shrinks all context columns but not claude-mem's background
column), and background tokens may be billed at a different model's rate — the
"total" column adds unlike quantities and is a volume indicator, not a bill.

### Parameter provenance

Resident tool-schema payloads are **measured from the shipped packages**, with
the serialization method stated so the numbers are reproducible:

- **claude-mem@13.10.2** (`npm pack claude-mem`): its MCP server, queried live
  over stdio with `initialize` + `tools/list`, returns **19 tools, 11,064
  serialized chars ≈ 2,766 tokens**. The plugin additionally bundles **17
  skills** whose model-invocable frontmatter `description:` lines total
  4,141 chars ≈ **1,035 tokens** (these stay resident even when MCP schemas
  are deferred). Its hooks.json registers 6 events including `PreToolUse` on
  every `Read` and `PostToolUse` on `*` (matcher-`*` shell scripts on the hot
  path), and its worker imports `@anthropic-ai/claude-agent-sdk` — the
  background-compression mechanism is real; the *volume* modeled below is an
  assumption.
- **mempalace 3.5.0** (PyPI wheel): `mcp_server.py` defines a `TOOLS`
  registry of **35 tools** (its GitHub README says 35; an internal module
  README says 34). Compact `JSON.stringify` of each tool's
  `{name, description, input_schema}` totals **18,499 chars ≈ 4,624 tokens**.
  (Pretty-printed serializations are larger — indent=2 gives ~24.4k chars —
  which is why the serialization is documented; actual in-context cost
  depends on how the client renders schemas.)
- **MemPalace startup**: the package's own `layers.py` states "Wake-up cost:
  ~600-900 tokens (L0+L1)" — the model uses the **750** midpoint. The
  frequently-quoted **170-token** figure comes from a third-party writeup
  ([recca0120](https://recca0120.github.io/en/2026/04/08/mempalace-ai-memory-system/))
  and appears nowhere in the shipped package; it is carried only as the
  MemPalace-favorable variant in the sensitivity table.

| Parameter | Value | Source |
|---|---|---|
| claude-mem startup index | 1,500 tok | Injected index of "session summaries, observation titles grouped by type, timestamps"; grows with history — 1,500 is a mid-life estimate ([README](https://github.com/thedotmack/claude-mem)) |
| claude-mem MCP + skills | 2,766 + 1,035 tok | **Measured** from claude-mem@13.10.2 (live `tools/list` + skill frontmatter) |
| claude-mem retrieval | 750 tok @ 10% of turns | Their "500–1,000 tokens/result" claim, mid-range |
| claude-mem background | 1,500 tok/turn | PostToolUse ships raw output to an Agent SDK compression call ("1,000–10,000 tokens compressed to ~500"); background *input* ≈ raw payload. Mechanism verified in the package; volume is an assumption |
| MemPalace startup | 750 tok (170 in sensitivity) | **Their own** `layers.py` "~600-900 tokens (L0+L1)", midpoint; 170 is a third-party figure |
| MemPalace MCP schemas | 4,624 tok | **Measured** from the mempalace 3.5.0 wheel's `TOOLS` registry (35 tools, compact JSON) |
| MemPalace retrieval | 900 tok @ 20% of turns | Workload assumption (estimate, not a measurement; applied consistently across systems) |
| CMO startup | measured (415 tok) | Part 1, capped at `CMO_BUDGET_TOKENS` |
| CMO "schemas" | 177 tok | **Measured**: two skill frontmatter descriptions, 709 chars (an earlier revision said 80 — corrected to the same standard applied to competitors); no MCP server |
| CMO retrieval | 200 tok @ 15% of turns | One ranked `search.js` call + matched lines over `.claude/memory/` |
| CMO jit pointers | 60 tok @ 10% of prompts | Hard-capped at `CMO_JIT_BUDGET_TOKENS` (100) |

### Sensitivity analysis

The headline hinges on two contestable assumptions, so `bench.js` prints the
same model under all four combinations of:

- **MCP schema residency** — eager (schemas in context every turn: the
  historical behavior) vs deferred (newer Claude Code loads MCP tool schemas
  on demand). claude-mem's 17 skill descriptions are resident either way.
- **MemPalace startup** — 750 (its own package) vs 170 (third-party).

Result shape: CMO vs claude-mem stays **~85–91% lower** in every scenario,
because claude-mem's background compression spend and resident skill
descriptions don't depend on schema residency. CMO vs MemPalace ranges from
**~89% lower** (eager schemas) to **~27% lower** (deferred, MemPalace's own
startup figure) to **higher** in the most MemPalace-favorable corner
(deferred + the 170-token figure its own package contradicts). Any honest
summary of this model is therefore a range, not a single percentage.

### Recall-quality regression gate (`quality.js`)

Token counts say nothing about whether the *right* memory surfaces. But note
what this harness **is**: a synthetic self-test whose direct/topical queries
share vocabulary with the seeded facts by construction. It exists to fail CI
when the pipeline regresses — its percentages are **not comparable** to
standardized benchmarks like LongMemEval (see below for that).

It seeds 20 known decisions across 20 synthetic sessions (each run through
the real `snapshot.js` hook; 8 also curated the way `/cmo:remember` writes
them — a `decisions.md` bullet **plus a `glossary.md` alias line**), then
scores the real `search.js` ranker R@5-style:

| Query class | Recall (R@5) | Notes |
|---|---|---|
| Direct (names the choice) | **100%** | gated in CI — regression fails the build |
| Topical (names the domain) | **100%** | gated in CI (≥90%) |
| Paraphrase, curated (synonyms never stored in the fact; glossary written at remember-time) | **88%** | gated in CI (≥50%). Bounded by which synonyms the write-time model foresaw — deliberately not all of them |
| Paraphrase, uncurated (no glossary) | 0% | the honest keyword-search floor, kept measured; live use adds model-side query reformulation (`/cmo:recall` retries with its own synonyms) |
| Negative (never stored) | **0 false positives** | gated in CI; `search.js` labels single-incidental-word matches `[weak: …]` so they can be discounted |
| JIT pointer (real `jit-recall.js` hook, on-topic prompts) | **95%** | gated in CI (≥85%) |
| JIT on vague affirmations ("sure. go ahead.") | **95%** | gated in CI (≥85%); the referent is resolved deterministically from the previous assistant turn in the transcript |
| JIT on never-stored topics | **0 false fires** (topic and vague variants) | gated in CI |

The JIT hook fires only on match evidence worth 2: two distinct incidental
concepts, or one **curated glossary concept** (curation supplies the precision
the two-term bar otherwise enforces; all surface forms of one concept count as
a single group, so expansion can never inflate the score). A single-rare-term
rule was tried first and rejected: this very benchmark caught it false-firing
on incidental word overlap ("wasm plugin sandbox" surfacing an email-sandbox
memory). Precision wins for unsolicited pointers — a missed pointer costs
nothing, a wrong one erodes trust in all of them.

This harness already earned its keep twice: its first run exposed a
session-id prefix collision in journal dedup that silently dropped 9 of 20
sessions, and a later run caught sentence punctuation defeating the stemmer
(`limiting.` ≠ `limit`). Both fixed.

### Standardized benchmark (`longmemeval.js`)

MemPalace publishes **96.6% R@5 on LongMemEval**; claude-mem publishes no
standardized retrieval numbers. To make the comparison apples-to-apples
instead of juxtaposing incomparable harnesses, `longmemeval.js` runs CMO's
real deterministic pipeline over the actual **LongMemEval-S** dataset
(470 non-abstention questions × ~50 haystack chat sessions, labeled evidence
sessions) and reports session-level Recall@k. Measured result:

| Condition | R@1 | R@5 | R@10 |
|---|---|---|---|
| CMO journal digests (what CMO persists — as shipped) | 61.5% | **76.6%** | 81.1% |
| Keyword ranking over verbatim session text (retention ceiling; CMO does not store this) | 78.7% | **93.6%** | 97.2% |
| MemPalace (their published claim; semantic search + embeddings + verbatim storage) | — | 96.6% | — |

Reading: CMO as shipped recovers the right session for **76.6%** of questions
from ~one digest line per session, at zero API cost with no index. The
verbatim row shows plain keyword ranking reaches within ~3 points of
MemPalace's published semantic-search number on the same dataset — most of
the gap between CMO-as-shipped and MemPalace is **retention policy (digests
vs verbatim storage), not keyword-vs-embedding search**. Caveats in both
directions: this replay exercises none of CMO's curated tiers (no
`/cmo:remember`, no glossary, no model-side query reformulation), and the
dataset is personal-assistant memory, not the engineering memory CMO targets;
conversely MemPalace's 96.6% is its own published figure — we measured our
side of the table, not theirs.

### Honesty notes

- Tool-schema payloads and skill descriptions are measured from shipped
  packages with the serialization documented; the remaining competitor
  parameters (startup index size, retrieval size/rate, background compression
  volume) are still **their published claims** — running both systems live
  under an identical replayed workload is the remaining follow-up. The
  claimed-vs-measured distinction is kept explicit in every table so a reader
  can always tell which numbers we produced and which we inherited.
- The retrieval-residency term (T/2) favors nobody in particular; changing it
  moves all three systems together.
- Not modeled, and favoring CMO further if included: claude-mem worker
  latency per tool call (non-blocking HTTP, but the worker's API spend is
  modeled), MemPalace's pip install + local service footprint, and both
  systems' cold-start behavior in ephemeral containers (their state lives
  outside the repo and is simply gone; CMO's memory is in the repo).
- Not modeled and favoring competitors: vector search may retrieve with fewer
  attempts than keyword search on some queries (the LongMemEval verbatim row
  bounds that gap at ~3 points on that dataset); CMO's rate/perUse
  assumptions are estimates, not measurements; and the glossary tier only
  helps synonyms that remember-time curation recorded.
- Freshness quality (do stale entries get superseded) remains unbenchmarked —
  as it is everywhere else. CMO's design answer is auditability: memory is
  reviewable Markdown in the repo, and `/cmo:remember` supersedes in place
  instead of appending contradictions.
