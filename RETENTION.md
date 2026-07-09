# Retention economics — the cost of being cheap

An evaluative pass over every token-reduction mechanism in CMO (and its
companion plugin [Trolly](https://github.com/gritbox/trolly)), asking one
question of each: **does this compression preserve the context window for
relevant context, or does it delete intelligence to save tokens that were
never being spent?** Efficiency is not the goal; it is a means. A method
that cuts token cost is justified only when it *improves* what the model
knows and attends to — never when it degrades alignment, cross-session
recall, or understanding. All context costs the same per token; its value
varies enormously. Compressing uniformly by age or position treats those as
equal, and that is the central mistake this document corrects.

## The taxonomy: pushed vs. pulled context

Every piece of persistent memory in this stack is one of two kinds, and the
correct retention discipline is opposite for each:

| | **Pushed** (injected every session) | **Pulled** (read on demand) |
|---|---|---|
| Examples | handoff, `decisions.md`, `index.md`, Trolly cursor | journal, spill files, glossary, `lessons.md`, journey docs, ADRs |
| Cost of a token | Paid in **every** session, relevant or not | Paid **only when retrieved**, i.e. only when relevant |
| What over-size costs | Attention dilution: irrelevant injected context degrades reasoning on *all* sessions | Almost nothing (disk, a grep) |
| Correct discipline | **Hard budgets** — with **value-ordered** eviction inside them | **Findability and precision** — structure, aliases, pointers; no size budgets |
| Failure mode to avoid | Evicting by age/position instead of value | Importing push-tier budgets and deleting recall paths for free |

The budgets on pushed context (≤800 tokens at SessionStart, ≤300 for the
Trolly cursor, ≤100 per JIT pointer) are pro-intelligence and stay: an
800-token cap in a ~200k window was never about money — it is about not
spending the session's opening attention on noise, and about the injection
not growing without bound as history accumulates.

The mistakes are all of one shape: **push-tier discipline applied to pulled
stores, or value-blind eviction inside a justified budget.**

## The audit: where cheap was expensive

### 1. The glossary term cap (fixed — removed)

An earlier revision capped `.cmo/glossary.md` at ~40 terms "to keep it
curated". Wrong instrument: the glossary is a **pulled** store — parsed by
`search.js` and `jit-recall.js` at match time, never injected — so its size
costs zero context tokens. A 200-term glossary of tight aliases is strictly
more recall coverage than 40 terms; the cap deleted recall insurance to
save nothing. What actually needs guarding is **precision**: in JIT recall
a curated-concept hit alone clears the evidence bar that otherwise requires
two independent terms, so one sloppy alias converts directly into false
unsolicited pointers. The discipline that stays: 2–4 aliases per term, only
words someone would plausibly search; prune duplicate heads, dead terms,
and aliases that misfire. **Quality, never count.**

### 2. The journal digest (fixed — enriched)

CMO's own LongMemEval-S run put a number on this one: shipped journal
digests score **76.6% R@5**; the same keyword ranking over verbatim text
scores **93.6%** — the README's own conclusion is that the gap is
*retention policy, not search method*. The old digest kept one intent line,
80-char commit summaries, filenames, and open todos; everything with high
retrieval entropy — exact error strings, the vocabulary a debate was
conducted in — was discarded at write time. Keyword search can only find
strings that survived digestion, and a recall miss does not cost zero: it
costs a re-derivation (an investigation's worth of tokens) plus the
alignment risk of contradicting a decision the system technically
"remembered". The journal is pulled and grepped, never read whole or
injected, so its terseness was buying **nothing**.

The digest now keeps **all intents** (joined, up to 4) and a bounded set of
**verbatim error lines** deterministically extracted from tool results
(word-boundary match on error/exception/failed/…, deduplicated, last 6,
one-lined at 160 chars). Still deterministic, still $0, still one short
entry per session — but the distinctive strings future recall needs now
survive.

### 3. Spill pruning (fixed — cold-aware, with tombstones)

Burying content out of context is fine **iff the map survives and the
buried thing stays intact**. The trim→spill mechanism gets the map right —
a pointer in context, full bytes on disk — and then violated "intact":
pruning deleted oldest-first past `CMO_SPILL_MAX`, unconditionally, leaving
journal and handoff references dangling silently. A dangling pointer is
worse than no pointer; the next session pays to follow it before
discovering the loss.

Pruning is now **cold-aware and tombstoned**: spill files the model
actually came back to Read or Grep (recorded in the heat ledger, below) are
skipped while unaccessed files remain, with a 2× hard cap so protection
cannot grow the directory without bound — and every pruned file leaves one
line in `spill/tombstones.md` (name, date, size, first line), so a
reference to it resolves to an explanation instead of a 404.

### 4. Eviction inside the injection budget (fixed — value-ordered)

Even where the budget is right, the eviction order was value-blind:
`session-start.js` truncated the assembled injection with a positional
tail-cut, and since `decisions.md` is appended chronologically, budget
pressure deleted the **newest decisions first** — the exact opposite of any
defensible ordering. Assembly is now priority-ordered: the handoff is
protected (tail-cut only as last resort), decisions shed their **oldest**
date-sections first with an explicit `[older decisions omitted…]` marker,
and the index is dropped to a one-line pointer before any decision is
touched. Likewise `/cmo:remember`'s consolidation guidance no longer says
"consolidate the oldest": it consolidates the **superseded and absorbed**,
with age only as a tiebreaker — a years-old rule that still changes
behavior is the most valuable line in the file, not the first against the
wall.

## The heat ledger: read-time evidence for curation

Curation decisions were previously made blind — by age, position, or count.
The stack now records the one deterministic value signal it can observe:
**what retrieval actually surfaces.** Every path that brings memory back
into context records a hit in `.cmo/heat.json`:

| Event | Recorded key |
|---|---|
| `search.js` prints a result line | `<file>:<sha12(line)>` |
| `jit-recall.js` injects a pointer | `<file>:<sha12(line)>` |
| A curated glossary concept produced the match | `glossary:<head>` |
| The model Reads/Greps a spill or journal file | `file:<relpath>` |

Counts halve at each month boundary (recent-weighted, never wiped in one
step); the ledger is bounded (coldest keys dropped past 400); recording is
best-effort and disabled with `CMO_HEAT=off`. Zero LLM calls, zero
schema — one small JSON file.

**The policy is deliberately asymmetric**, because the signal is
asymmetric: a hit is evidence of value, but coldness is *not* evidence of
worthlessness — insurance memories are valuable in proportion to how rarely
they are claimed, and injected tiers show zero recall hits precisely
*because injection means recall never happens*. Therefore:

- **Heat protects**: accessed spill files are skipped by pruning.
- **Heat promotes**: `/cmo:recall` treats a repeat lookup (n ≥ 2) of a
  journal or spill line as a memory living in the wrong tier and distills
  it into `decisions.md`/`index.md` — hot facts migrate toward the pushed
  tier instead of being re-searched forever.
- **Cold never deletes by itself**: consolidation criteria remain semantic
  (superseded, absorbed, demonstrably dead); the ledger informs the model's
  judgment, it never executes deletions by counter arithmetic.
- **Injected tiers are not tracked**: `decisions.md`/`index.md` hits would
  measure nothing (the content is already present every session), so the
  ledger is scoped to the pulled tiers where the signal is real.

## The principle, stated once

**Budgets belong on pushed context; discipline belongs on pulled context;
eviction anywhere must be value-ordered; and burial requires an intact body
and a surviving map.** The end state is a value-ordered memory hierarchy:
hot facts migrate up toward injection, cold facts sink into cheap pulled
storage *intact*, and deletion happens only where a human-legible criterion
exists. Saving tokens is never the goal — preserving the session's window
for the context that matters is.
