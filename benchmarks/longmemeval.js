'use strict';
// LongMemEval-S retrieval benchmark for CMO — the apples-to-apples run.
//
// MemPalace publishes "96.6% R@5 raw on LongMemEval"; claude-mem publishes
// no standardized numbers. This harness runs CMO's REAL deterministic
// pipeline against the actual LongMemEval-S dataset (500 questions, ~50
// haystack chat sessions each, labeled evidence sessions) and reports the
// same metric family (session-level Recall@k: an evidence session ranked in
// the top k).
//
// Two conditions are measured, because they answer different questions:
//
//   journal   what CMO actually persists: each haystack session is written
//             as a transcript and digested by the same lib code snapshot.js
//             uses (deterministic extraction -> one intent line). Retrieval
//             ranks those digests with the same term-group scoring
//             search.js/jit-recall.js use. This is the honest number for
//             "CMO as shipped" on this workload.
//   verbatim  the same keyword ranking over full session text — the ceiling
//             for CMO-style keyword retrieval if verbatim transcripts were
//             retained (CMO deliberately does not retain them; the CLI's own
//             local transcripts or spill files partially fill this role).
//
// Interpretation caveats, stated up front:
//   - LongMemEval is personal-assistant memory (favorite singers, travel
//     plans), not engineering memory. CMO's curated tiers (decisions.md,
//     glossary.md, /cmo:remember) have NO analog in this replay — nothing
//     is curated at write time, so the strongest parts of the pipeline sit
//     idle. The run measures CMO's deterministic floor, not its ceiling.
//   - In live use the searcher is a model that reformulates queries on a
//     miss (see skills/recall); a fixed harness cannot simulate that.
//   - MemPalace's 96.6% comes from semantic search over verbatim stored
//     text with embeddings. CMO's design trades that recall for zero
//     infrastructure — this harness exists to state the price of that trade
//     in the standard metric instead of hand-waving it.
//
// Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval
// (longmemeval_s, a ~278 MB JSON array; the *_abs abstention questions are
// excluded, as in standard retrieval evaluations.)
//
// Run: node --max-old-space-size=8192 benchmarks/longmemeval.js <longmemeval_s.json> [--limit N]

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../scripts/lib');

function main() {
  const argv = process.argv.slice(2);
  let file = null;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limit = parseInt(argv[++i], 10) || Infinity;
    else file = argv[i];
  }
  if (!file || !fs.existsSync(file)) {
    console.error('usage: node --max-old-space-size=8192 benchmarks/longmemeval.js <longmemeval_s.json> [--limit N]');
    process.exit(2);
  }

  console.error('Loading dataset (this is a ~278 MB JSON parse)…');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const questions = data.filter((q) => !String(q.question_id).endsWith('_abs')).slice(0, limit);
  console.error(`${questions.length} questions (abstention questions excluded).`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmo-lme-'));
  const tmpTranscript = path.join(tmp, 'session.jsonl');

  const K = [1, 5, 10];
  const modes = ['journal', 'verbatim'];
  const totals = {};
  const byType = {};
  for (const m of modes) totals[m] = Object.fromEntries(K.map((k) => [k, 0]));

  let done = 0;
  for (const q of questions) {
    const answerIds = new Set(q.answer_session_ids || []);
    const queryText = String(q.question || '');
    const terms = lib.extractTerms(queryText);
    const groups = lib.termGroups(terms, queryText, []); // no glossary: nothing was curated at write time

    const scored = { journal: [], verbatim: [] };
    for (let s = 0; s < q.haystack_sessions.length; s++) {
      const turns = q.haystack_sessions[s] || [];
      const id = q.haystack_session_ids[s];

      // --- journal condition: the digest CMO's SessionEnd hook would keep.
      // Same code path as snapshot.js: parseTranscript + extractState over a
      // real transcript file in the CLI's JSONL shape.
      const jsonl = turns
        .map((t) =>
          JSON.stringify({
            message: {
              role: t.role === 'user' ? 'user' : 'assistant',
              content:
                t.role === 'user' ? String(t.content || '') : [{ type: 'text', text: String(t.content || '') }],
            },
          })
        )
        .join('\n');
      fs.writeFileSync(tmpTranscript, jsonl + '\n');
      const state = lib.extractState(lib.parseTranscript(tmpTranscript), tmp);
      // The journal entry stores the first intent line (see snapshot.js).
      const digest = state.intents.length ? `- Intent: ${state.intents[0]}` : '';

      // --- verbatim condition: everything said in the session.
      const full = turns.map((t) => String(t.content || '')).join('\n');

      for (const [mode, text] of [
        ['journal', digest],
        ['verbatim', full],
      ]) {
        const low = text.toLowerCase();
        const stems = lib.lineStemSet(low);
        let matched = 0;
        let variantHits = 0;
        for (const g of groups) {
          if (lib.groupMatchesLine(g, low, stems)) {
            matched++;
            for (const v of g.variants) if (low.includes(v)) variantHits++;
          }
        }
        scored[mode].push({ id, matched, variantHits });
      }
    }

    for (const mode of modes) {
      scored[mode].sort((a, b) => b.matched - a.matched || b.variantHits - a.variantHits);
      for (const k of K) {
        const hit = scored[mode].slice(0, k).some((s) => answerIds.has(s.id));
        if (hit) totals[mode][k]++;
        if (k === 5) {
          byType[q.question_type] = byType[q.question_type] || { n: 0, journal: 0, verbatim: 0 };
          if (mode === 'journal') byType[q.question_type].n++;
          if (hit) byType[q.question_type][mode]++;
        }
      }
    }
    if (++done % 50 === 0) console.error(`  ${done}/${questions.length}…`);
  }

  const pct = (n) => ((100 * n) / questions.length).toFixed(1) + '%';
  console.log(`\n## LongMemEval-S — CMO deterministic retrieval (${questions.length} questions)\n`);
  console.log('| Condition | R@1 | R@5 | R@10 |');
  console.log('|---|---|---|---|');
  for (const mode of modes) {
    const label =
      mode === 'journal'
        ? 'CMO journal digests (what CMO persists — as shipped)'
        : 'Keyword ranking over verbatim text (retention ceiling, not what CMO stores)';
    console.log(`| ${label} | ${pct(totals[mode][1])} | ${pct(totals[mode][5])} | ${pct(totals[mode][10])} |`);
  }
  console.log('| MemPalace (their published claim, semantic search + embeddings) | — | 96.6% | — |');

  console.log('\nBy question type (R@5):\n');
  console.log('| Type | n | journal | verbatim |');
  console.log('|---|---|---|---|');
  for (const [t, v] of Object.entries(byType).sort()) {
    console.log(`| ${t} | ${v.n} | ${((100 * v.journal) / v.n).toFixed(1)}% | ${((100 * v.verbatim) / v.n).toFixed(1)}% |`);
  }
  console.log(
    '\nCaveats: no write-time curation ran (decisions/glossary tiers idle); no\n' +
      'model-side query reformulation; dataset is assistant-style personal memory,\n' +
      'not the engineering memory CMO targets. See header comment for framing.'
  );
}

main();
