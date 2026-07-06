# Benchmark methodology

`node bench.js` — no dependencies.

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

### Parameter provenance

| Parameter | Value | Source |
|---|---|---|
| claude-mem startup index | 1,500 tok | Injected index of "session summaries, observation titles grouped by type, timestamps"; grows with history — 1,500 is a mid-life estimate ([README](https://github.com/thedotmack/claude-mem)) |
| claude-mem MCP schemas | 3 × 120 tok | search / timeline / get_observations tools ([DataCamp guide](https://www.datacamp.com/tutorial/claude-mem-guide)) |
| claude-mem retrieval | 750 tok @ 10% of turns | Their "500–1,000 tokens/result" claim, mid-range |
| claude-mem background | 1,500 tok/turn | PostToolUse ships raw output to an Agent SDK compression call ("1,000–10,000 tokens compressed to ~500"); background *input* ≈ raw payload |
| MemPalace startup | 170 tok | Their headline L0+L1 claim ([recca0120 writeup](https://recca0120.github.io/en/2026/04/08/mempalace-ai-memory-system/)) |
| MemPalace MCP schemas | 19 × 120 tok | "Claude Code auto-discovers 19 MCP tools" ([mempalace.tech setup](https://www.mempalace.tech/guides/setup)); ~120 tok/schema is a conservative per-tool estimate |
| MemPalace retrieval | 900 tok @ 20% of turns | Blueprint's own workload assumption, kept for comparability |
| CMO startup | measured (415 tok) | Part 1, capped at `CMO_BUDGET_TOKENS` |
| CMO "schemas" | 80 tok | Two skill frontmatter descriptions; no MCP server |
| CMO retrieval | 200 tok @ 15% of turns | One `Grep` call + matched lines over `.claude/memory/` |

### Honesty notes

- Competitor figures are **their published claims**, not our measurements —
  installing and profiling both under an identical replayed workload is the
  obvious follow-up. The distinction between claimed and measured numbers is
  kept explicit in every table because the blueprint this project responds to
  failed to do exactly that.
- The retrieval-residency term (T/2) favors nobody in particular; changing it
  moves all three systems together.
- Not modeled, and favoring CMO further if included: claude-mem worker
  latency per tool call (non-blocking HTTP, but the worker's API spend is
  modeled), MemPalace's pip install + local service footprint, and both
  systems' cold-start behavior in ephemeral containers (their state lives
  outside the repo and is simply gone; CMO's memory is in the repo).
- Not modeled and favoring competitors: vector search may retrieve with fewer
  attempts than keyword Grep on some queries; CMO's rate/perUse assumptions
  are estimates, not measurements.
- Memory *quality* (does the right memory surface; do stale entries get
  superseded) is unbenchmarked here — as it is everywhere else. CMO's design
  answer is auditability: memory is reviewable Markdown in the repo, and
  `/cmo:remember` supersedes in place instead of appending contradictions.
