# Running CMO alongside mattpocock/skills

A workflow guide for using **CMO** and **[mattpocock/skills][mp]** together in
one Claude Code project. They are not alternatives — they sit on different
axes, and each supplies exactly what the other lacks. This document is the
cross-comparative analysis and the concrete setup that runs both
simultaneously.

[mp]: https://github.com/mattpocock/skills

## The one-sentence thesis

**CMO is the substrate; mattpocock/skills is the method.** CMO decides *what
persists, how it is budgeted, and how it is retrieved* — automatically, for
free, with no opinion about how you work. mattpocock/skills decides *how the
work proceeds* — alignment, specs, TDD, review, architecture — with a strong
opinion and no durable memory mechanism of its own. Install both and you get a
disciplined engineering loop running on top of a deterministic memory layer
that survives compaction, session ends, and ephemeral containers.

## The two systems at a glance

| | **CMO** | **mattpocock/skills** |
|---|---|---|
| Layer it occupies | Memory / context **substrate** | Engineering **method / process** |
| Who drives it | Ambient — Claude Code hooks fire automatically | Human — you invoke a skill explicitly |
| Token cost of the machinery | Zero API tokens (deterministic extraction) | Model-driven (the LLM does the reasoning) |
| Opinion about *how you work* | None | Strong (align → spec → TDD → review → maintain) |
| Primary storage | `.cmo/` plain Markdown, in-repo | Issue tracker + `CONTEXT.md` + `docs/adr/` + OS-temp handoff |
| Core question answered | "What did we decide / what was in flight / where's that output?" | "How do I take this from idea to reviewed, working code?" |
| Unit of work | A remembered fact, a handoff, a spill file | A grill, a spec, a ticket, a TDD loop, a review |
| Failure mode it removes | Context loss, budget blowout, lost prior sessions | Misalignment, verbosity, broken code, architectural decay |

Read the columns as complements. CMO has **no methodology**. mattpocock has
**no budgeted, compaction-surviving, in-repo memory mechanism** — its state
lives on the issue tracker (durable, but coarse-grained and only updated at
ticket boundaries) and its `/handoff` writes to the OS temp directory (lost
when a cloud/CI container is reclaimed). Each is the other's missing half.

## Why they compose instead of collide

The systems touch at four seams. Three are pure synergy; one is an overlap you
should deliberately reconcile so you don't do the same work twice.

### Seam 1 — Domain vocabulary (strong synergy)

This is the best fit between the two projects, and it is not a coincidence:
both independently concluded that a curated glossary is worth maintaining, for two
*different* reasons.

- mattpocock's **`domain-modeling`** / **`grill-with-docs`** build
  **`CONTEXT.md`** — a pure "ubiquitous language" glossary, deliberately
  *devoid of implementation detail*, whose job is to stop the agent inventing
  terminology and being verbose. It is a **write-time** artifact for
  precision *within* a session.
- CMO's **`/cmo:remember`** maintains **`.cmo/glossary.md`** — term → aliases
  someone might search for instead. Its job is **recall insurance**:
  cross-session keyword search can only expand a synonym that remember-time
  recorded. It is a **read-time** artifact for retrieval *across* sessions.

Same raw material (the project's terms of art), two jobs. **Integration:** when
a grilling session settles a canonical term in `CONTEXT.md`, mirror it into
`.cmo/glossary.md` with the synonyms you'd search for later. Now the domain
model that keeps *this* session precise also makes *next month's* `/cmo:recall`
find the work on the first try. `grill-with-docs` is the ideal trigger for a
follow-up `/cmo:remember`.

### Seam 2 — Handoff & compaction survival (overlap → reconcile)

Both projects ship something called a "handoff," but they differ in trigger,
authorship, and destination — and the difference is exactly why they coexist.

| | CMO `handoff.md` | mattpocock `/handoff` |
|---|---|---|
| Trigger | Automatic (`PreCompact`, `SessionEnd`) | Explicit, user-invoked |
| Author | Deterministic extraction (no LLM) | The model (rich narrative) |
| Content | Working state: intent, todos, edited files, commands, commits | Narrative + "suggested next skills" + artifact references |
| Destination | `.cmo/handoff.md` **in the repo** | OS **temp directory** |
| Re-entry | Auto re-injected on `SessionStart(compact)` | Read by the next agent manually |

**Reconciliation:** let each own what it is good at.
- CMO owns the **always-on, free, compaction-survival** path. You never invoke
  it; it simply means compaction and session-end never drop the thread. Do
  *not* reach for mattpocock `/handoff` just to survive an auto-compaction —
  CMO already did it, deterministically.
- Use mattpocock **`/handoff`** for the deliberate, cross-agent transfer at a
  real stopping point — when you want a narrated summary with recommended next
  skills. But its output goes to a temp dir that an ephemeral container
  reclaims, so **land its key decisions with `/cmo:remember`** before you stop.
  That moves the durable part of the handoff into `.cmo/` (in-repo, committed,
  survives the container) while keeping the rich narrative for the human/agent
  picking up immediately.

Net: CMO fixes mattpocock handoff's one weakness (temp-dir volatility) for the
facts that matter, and mattpocock adds the narrative layer CMO deliberately
omits.

### Seam 3 — Decisions vs. ADRs (complementary tiers, don't duplicate)

- mattpocock stores formal **Architecture Decision Records** in `docs/adr/` —
  full rationale, human-facing, permanent.
- CMO stores **`.cmo/decisions.md`** — terse, one-line-actionable, machine-facing,
  *injected into every session start* under a hard budget (~60 lines, then
  consolidated), with supersede-in-place.

Different audiences, different budgets, no conflict. **Integration:** the ADR
is the canonical "why"; `/cmo:remember` distills the one-line "what changes my
behavior next time" into `decisions.md` and can reference the ADR path. Don't
paste the ADR into memory — link it. The always-loaded working set stays small;
the full record stays in `docs/adr/`.

### Seam 4 — Last-mile persistence (CMO plugs a real gap)

mattpocock's **`wayfinder`** puts multi-session state on the **issue tracker**:
a `wayfinder:map` issue plus child tickets, with native blocking. That is
excellent for coarse, durable, multi-agent coordination — but it is only
updated at ticket boundaries. **Between** those checkpoints, the live working
state (what's edited, what's in flight, the last three commands) exists only in
the conversation. CMO's `PreCompact`/`SessionEnd` snapshot captures exactly
that, deterministically and for free, and re-injects it on resume. So:

- **Tracker (wayfinder):** the map and the frontier — survives everything,
  coordinates concurrent sessions.
- **CMO snapshot:** the last-mile working state between tracker updates —
  survives compaction and container reclaim, orients you the instant a session
  resumes, *before* you even open the map.

They stack. On resume you get CMO's budgeted injection (last state + decisions +
index) and then load the wayfinder map — micro-context and macro-context
together.

## The combined workflow

Two layers run at once: an **ambient layer** (CMO, always on, zero effort) and
a **deliberate layer** (mattpocock skills, invoked by you). The interlock
points — where a deliberate action should feed the ambient memory — are marked
**⇄**.

```
Ambient (CMO, automatic):
  SessionStart → budgeted memory injection (≤800 tok)
  UserPromptSubmit → just-in-time recall pointers
  PostToolUse → trim oversized output → spill (recoverable)
  PreCompact / SessionEnd → deterministic working-state snapshot
```

1. **Setup (once per repo).** Install the CMO plugin
   (`/plugin marketplace add gritbox/cmo` → `/plugin install cmo@cmo`) and run
   `/setup-matt-pocock-skills`. Choose: `CONTEXT.md` at root, `docs/adr/`, an
   issue tracker, and commit `.cmo/` so memory travels with the repo (ignore
   only `.cmo/spill/`).
2. **Align.** `/grill-with-docs` → builds/updates `CONTEXT.md`.
   **⇄** Immediately `/cmo:remember` the decisions the grilling settled, and
   seed `.cmo/glossary.md` from the new `CONTEXT.md` terms (Seam 1). Recall is
   now synonym-aware from day one.
3. **Plan large work.** `/wayfinder` → map + tickets on the tracker (Seam 4).
   CMO snapshots carry live state between ticket sessions.
4. **Spec & break down.** `/to-spec`, then `/to-tickets`.
5. **Implement.** `/implement`, which orchestrates `/tdd` and `/code-review`.
   TDD's red-green loop emits exactly the high-volume, repetitive test/log
   output CMO's line-dedup + spill was built for — the context window stays
   lean while every byte remains greppable in `.cmo/spill/`. Direct synergy,
   no configuration.
6. **Debug.** `/diagnosing-bugs`; CMO keeps full repro logs off-context but
   recoverable.
7. **Compaction (anytime, unattended).** CMO's `PreCompact` handoff carries the
   thread across; `SessionStart(compact)` re-injects it. No mattpocock action
   needed — do *not* invoke `/handoff` for this (Seam 2).
8. **Stop / switch agents.** `/handoff` for a narrated, skill-suggesting
   transfer. **⇄** `/cmo:remember` its load-bearing decisions first, so they
   persist in-repo past the temp dir (Seam 2). Next session:
   SessionStart injection + `/cmo:recall` reconstruct context instantly.
9. **Maintain.** Periodically `/improve-codebase-architecture`.
   **⇄** `/cmo:remember` (and an ADR) for each architectural decision made
   (Seam 3).

## The one convention that makes them sing

Keep **`.cmo/glossary.md` tracking `CONTEXT.md`.** Every time domain-modeling
adds or sharpens a canonical term, add a glossary line with the aliases you'd
search for later. `CONTEXT.md` keeps the current session precise; the mirrored
glossary keeps every future session's recall precise. It is the single highest-
leverage habit in this pairing, and it costs one line per term.

## What *not* to do (avoid double-work)

- **Don't** invoke mattpocock `/handoff` to survive auto-compaction — CMO
  already handles that deterministically and for free.
- **Don't** paste ADRs into `.cmo/decisions.md` — link them; the injected
  working set is budgeted and must stay terse.
- **Don't** duplicate the wayfinder map into `.cmo/` — the tracker is its home;
  CMO carries only the between-checkpoint working state.
- **Don't** let `CONTEXT.md` accumulate implementation detail to "help recall";
  keep it a pure glossary and let `.cmo/decisions.md`/`index.md` hold the
  actionable specifics.

## Division of labor, summarized

| Concern | Owned by |
|---|---|
| Requirements alignment, questioning | mattpocock (`grill-*`) |
| Domain vocabulary (write-time precision) | mattpocock (`CONTEXT.md`) |
| Domain vocabulary (read-time recall) | CMO (`.cmo/glossary.md`) |
| Specs & tickets | mattpocock (`to-spec`, `to-tickets`, tracker) |
| Multi-session macro-plan | mattpocock (`wayfinder`, tracker) |
| Between-checkpoint working state | CMO (snapshot → `handoff.md`) |
| TDD / review discipline | mattpocock (`tdd`, `code-review`) |
| Oversized tool-output control | CMO (`trim` → spill) |
| Session-start context budget | CMO (`session-start`, ≤800 tok) |
| Compaction survival | CMO (`PreCompact` + `SessionStart(compact)`) |
| Formal decision record (human) | mattpocock (`docs/adr/`) |
| Working decision set (model, budgeted) | CMO (`.cmo/decisions.md`) |
| Rich cross-agent handoff narrative | mattpocock (`/handoff`) |
| Durable, in-repo persistence of that handoff | CMO (`/cmo:remember`) |

Install CMO and forget it; invoke mattpocock skills deliberately. The two
interlock at the four seams above — most importantly, keep the glossary
tracking `CONTEXT.md` — and you have a disciplined engineering method running
on a free, deterministic, compaction- and container-proof memory substrate.
