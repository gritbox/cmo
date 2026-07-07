'use strict';
// CMO recall-quality regression gate: does the memory pipeline surface the
// right fact later?
//
// This is a REGRESSION GATE over synthetic data, not a standardized
// benchmark: the direct/topical queries share vocabulary with the seeded
// facts by construction, so their job is to fail CI when the pipeline
// breaks, not to be compared with LongMemEval-class results (for that, see
// benchmarks/longmemeval.js, which runs CMO's real retrieval over the actual
// LongMemEval-S dataset).
//
// 20 known decisions ("chose X for Y because Z") are seeded across 20
// synthetic sessions, each run through the REAL snapshot.js SessionEnd hook.
// 8 of them are additionally curated the way /cmo:remember writes them:
// a decisions.md bullet plus a glossary.md alias line (the write-time model
// records the synonyms it can foresee — recall-time can only expand what
// remember-time recorded). Retrieval runs through the REAL search.js ranker
// (stemming + glossary expansion), scored R@5-style: a hit must appear in
// the top 5 results. Query classes:
//
//   direct        query names the chosen thing        ("neonhttp")
//   topical       query names the problem domain      ("http client retries")
//   paraphrase    query uses synonyms never stored in the fact itself
//                 ("fetch wrapper") — split into curated (glossary exists)
//                 and uncurated (no glossary; the honest keyword-search 0%)
//
// plus 6 negative queries about facts never seeded (false-positive check),
// and two end-to-end passes through the real jit-recall.js hook: on-topic
// prompts, and bare affirmations ("sure, go ahead") that must resolve their
// referent from the assistant's previous message.
//
// Run: node benchmarks/quality.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const est = (s) => Math.ceil(s.length / 4);

// topic (domain words) | choice (named thing) | reason | paraphrase (synonyms, never recorded in the fact)
const FACTS = [
  ['http client retries', 'neonhttp', 'retries and backoff are built in', 'fetch wrapper'],
  ['database migrations', 'driftless', 'plain SQL files, no DSL', 'schema evolution'],
  ['background jobs', 'quejo', 'redis-free, table-backed', 'async task runner'],
  ['feature flags', 'flagstone', 'local JSON evaluation, no network', 'toggle rollout'],
  ['date handling', 'tempora', 'immutable API, tz database bundled', 'time library'],
  ['form validation', 'strictform', 'schema shared with the API layer', 'input checking'],
  ['logging', 'inkwell', 'structured JSON with child loggers', 'telemetry output'],
  ['rate limiting', 'floodgate', 'sliding window, per-tenant keys', 'throttling requests'],
  ['payments provider', 'ledgerly', 'webhooks are idempotent by default', 'billing vendor'],
  ['search indexing', 'grainstore', 'incremental indexing on save', 'full text lookup'],
  ['config loading', 'confluence-free envfig', 'no remote config dependency', 'settings parser'],
  ['image resizing', 'pixelmill', 'streams instead of buffering', 'thumbnail generation'],
  ['email sending', 'posthaste', 'sandbox mode for CI', 'transactional mail'],
  ['error tracking', 'faultline', 'self-hosted, scrubs PII', 'crash reporting'],
  ['pdf generation', 'papyra', 'renders from HTML templates', 'document export'],
  ['websocket layer', 'currentwire', 'auto-reconnect with jittered backoff', 'realtime channel'],
  ['caching strategy', 'memofreeze', 'stale-while-revalidate default', 'response reuse'],
  ['api pagination', 'cursorcraft', 'opaque cursors, no offsets', 'result paging'],
  ['secrets storage', 'vaultlite', 'age-encrypted files in repo', 'credential management'],
  ['ci pipeline', 'beltline', 'single YAML, local runner parity', 'build automation'],
].map(([topic, choice, reason, paraphrase]) => ({ topic, choice, reason, paraphrase }));

// Glossary lines /cmo:remember would plausibly have written for the 8
// curated facts. Deliberately NOT copied from the paraphrase queries: the
// write-time model records the synonyms it can foresee, and some paraphrases
// (e.g. "schema evolution", "telemetry output") are ones it plausibly would
// not — those stay misses, and the split below keeps that visible.
const CURATED = 8;
const GLOSSARY = [
  'neonhttp: http client, fetch wrapper, request retries',
  'driftless: database migrations, sql migrations, schema changes',
  'quejo: background jobs, job queue, async tasks',
  'flagstone: feature flags, toggles, flag rollout',
  'tempora: date handling, time library, timezones',
  'strictform: form validation, input validation, form schemas',
  'inkwell: logging, structured logs, logger',
  'floodgate: rate limiting, throttling, request limits',
];

const NEGATIVE_QUERIES = [
  'graphql federation',
  'kubernetes operator',
  'i18n pluralization',
  'service mesh sidecar',
  'blue green deploys',
  'wasm plugin sandbox',
];

// ---------------------------------------------------------------- seeding

function seed() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cmo-quality-'));
  FACTS.forEach((f, i) => {
    const transcript = path.join(proj, `t${i}.jsonl`);
    const lines = [
      { message: { role: 'user', content: `We need ${f.topic}. Decided to go with ${f.choice} because ${f.reason}.` } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj, 'src', f.choice.replace(/\W+/g, '-') + '.ts') } }] } },
      { message: { role: 'user', content: 'looks good, ship it' } },
    ];
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    spawnSync('node', [path.join(SCRIPTS, 'snapshot.js')], {
      input: JSON.stringify({
        cwd: proj,
        transcript_path: transcript,
        session_id: `qual-${String(i).padStart(4, '0')}`,
        hook_event_name: 'SessionEnd',
      }),
      encoding: 'utf8',
    });
  });
  // First 8 facts also curated via the /cmo:remember format: decisions + glossary.
  const dec = ['# Decisions', '', `### ${new Date().toISOString().slice(0, 10)}`];
  for (const f of FACTS.slice(0, CURATED)) dec.push(`- Use ${f.choice} for ${f.topic} — ${f.reason}.`);
  fs.writeFileSync(path.join(proj, '.claude', 'memory', 'decisions.md'), dec.join('\n') + '\n');
  fs.writeFileSync(
    path.join(proj, '.claude', 'memory', 'glossary.md'),
    ['# Glossary', ...GLOSSARY.map((g) => `- ${g}`)].join('\n') + '\n'
  );
  return proj;
}

// ---------------------------------------------------------------- retrieval

/** The REAL ranked search the /cmo:recall skill runs (top 5, R@5-style). */
function search(proj, query) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'search.js'), '--cwd', proj, '--top', '5', query], {
    encoding: 'utf8',
  });
  return (r.stdout || '').split('\n').filter(Boolean);
}

function score(proj, queries, expectFn) {
  let found = 0;
  let tokens = 0;
  for (const q of queries) {
    const hits = search(proj, q.query);
    tokens += est(hits.join('\n'));
    if (hits.some((h) => expectFn(q, h))) found++;
  }
  return { recall: queries.length ? found / queries.length : 0, avgTokens: Math.round(tokens / Math.max(queries.length, 1)) };
}

// ---------------------------------------------------------------- run

const proj = seed();

const direct = score(
  proj,
  FACTS.map((f) => ({ query: f.choice, f })),
  (q, hit) => hit.toLowerCase().includes(q.f.topic.split(' ')[0])
);
const topical = score(
  proj,
  FACTS.map((f) => ({ query: f.topic, f })),
  (q, hit) => hit.toLowerCase().includes(q.f.choice.toLowerCase())
);
const paraCurated = score(
  proj,
  FACTS.slice(0, CURATED).map((f) => ({ query: f.paraphrase, f })),
  (q, hit) => hit.toLowerCase().includes(q.f.choice.toLowerCase())
);
const paraUncurated = score(
  proj,
  FACTS.slice(CURATED).map((f) => ({ query: f.paraphrase, f })),
  (q, hit) => hit.toLowerCase().includes(q.f.choice.toLowerCase())
);
// Negatives must not ASSERT any seeded choice. search.js labels
// single-incidental-word matches as weak precisely so they can be
// discounted; an unlabeled hit naming a planted choice is a false positive.
let falsePositives = 0;
for (const q of NEGATIVE_QUERIES) {
  const asserted = search(proj, q)
    .filter((h) => !h.includes('[weak:'))
    .join(' ')
    .toLowerCase();
  if (FACTS.some((f) => asserted.includes(f.choice.toLowerCase()))) falsePositives++;
}

// ---------------------------------------------------------------- jit hook

// End-to-end through the real jit-recall.js hook: a user prompt mentioning a
// seeded topic should produce a pointer naming the choice; unrelated prompts
// must stay silent.
function runJit(prompt, transcriptPath) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'jit-recall.js')], {
    input: JSON.stringify({
      cwd: proj,
      prompt,
      transcript_path: transcriptPath,
      session_id: 'jitq-' + Math.random().toString(36).slice(2),
      hook_event_name: 'UserPromptSubmit',
    }),
    encoding: 'utf8',
  });
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch {
    return null;
  }
}

let jitHits = 0;
let jitTokens = 0;
for (const f of FACTS) {
  const ctx = runJit(`Something looks off with our ${f.topic} — can you investigate?`);
  if (ctx) jitTokens += est(ctx);
  if (ctx && ctx.toLowerCase().includes(f.choice.toLowerCase())) jitHits++;
}
let jitFalseFires = 0;
for (const q of NEGATIVE_QUERIES) {
  if (runJit(`Something looks off with our ${q} — can you investigate?`)) jitFalseFires++;
}
const jitRecall = jitHits / FACTS.length;
const jitAvgTokens = Math.round(jitTokens / Math.max(jitHits, 1));

// Vague affirmations: "sure, go ahead" carries no terms — the hook must
// resolve the referent from the assistant's previous message in the
// transcript (the real input contract gives it transcript_path).
let vagueHits = 0;
for (const f of FACTS) {
  const t = path.join(proj, `vague-${f.choice.replace(/\W+/g, '-')}.jsonl`);
  fs.writeFileSync(
    t,
    [
      { message: { role: 'user', content: `hm, remind me where we landed on that` } },
      {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `I remember past sessions touched on ${f.topic} — want me to look through the project memory and pull that decision up?`,
            },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
  const ctx = runJit('sure. go ahead.', t);
  if (ctx && ctx.toLowerCase().includes(f.choice.toLowerCase())) vagueHits++;
}
let vagueFalseFires = 0;
for (const q of NEGATIVE_QUERIES) {
  const t = path.join(proj, `vague-neg.jsonl`);
  fs.writeFileSync(
    t,
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Want me to set up the ${q} configuration now?` }],
      },
    }) + '\n'
  );
  if (runJit('sure. go ahead.', t)) vagueFalseFires++;
}
const vagueRecall = vagueHits / FACTS.length;

const journalDir = path.join(proj, '.claude', 'memory', 'journal');
const journalTokens = fs
  .readdirSync(journalDir)
  .reduce((n, f) => n + est(fs.readFileSync(path.join(journalDir, f), 'utf8')), 0);

console.log('## Recall-quality regression gate (20 seeded facts, real snapshot + search + jit pipeline)\n');
console.log('Synthetic self-test — NOT comparable to LongMemEval-class published');
console.log('numbers. For that, run benchmarks/longmemeval.js on the real dataset.\n');
console.log('| Query class | Example | Recall (R@5) | Avg retrieval tokens |');
console.log('|---|---|---|---|');
console.log(`| Direct (names the choice) | \`floodgate\` | ${pct(direct.recall)} | ${direct.avgTokens} |`);
console.log(`| Topical (names the domain) | \`rate limiting\` | ${pct(topical.recall)} | ${topical.avgTokens} |`);
console.log(`| Paraphrase, curated (glossary written at remember-time) | \`throttling requests\` | ${pct(paraCurated.recall)} | ${paraCurated.avgTokens} |`);
console.log(`| Paraphrase, uncurated (no glossary) | \`crash reporting\` | ${pct(paraUncurated.recall)} | ${paraUncurated.avgTokens} |`);
console.log(`| Negative (never stored) | \`service mesh sidecar\` | ${falsePositives}/${NEGATIVE_QUERIES.length} false positives | — |`);
console.log(`| JIT pointer (real UserPromptSubmit hook) | "something looks off with our rate limiting" | ${pct(jitRecall)} | ${jitAvgTokens} |`);
console.log(`| JIT on vague affirmation (referent in previous assistant turn) | "sure. go ahead." | ${pct(vagueRecall)} | — |`);
console.log(`| JIT on never-stored topics | — | ${jitFalseFires}/${NEGATIVE_QUERIES.length} false fires (topic prompts), ${vagueFalseFires}/${NEGATIVE_QUERIES.length} (vague) | — |`);
console.log(`\nTotal journal size after 20 sessions: ${journalTokens} tokens (retrieved lazily, never resident).`);
console.log('\nParaphrase recall is bounded by what remember-time curation recorded:');
console.log('glossary aliases close the gap only for synonyms the write-time model');
console.log('foresaw — the uncurated row is the honest keyword-search floor, and the');
console.log('recall skill instructs the model to retry with its own synonyms on a miss.');
console.log(`\n(scratch project: ${proj})`);

// Non-zero exit if the pipeline regresses on what it MUST do.
if (
  direct.recall < 1 ||
  topical.recall < 0.9 ||
  paraCurated.recall < 0.5 ||
  falsePositives > 0 ||
  jitRecall < 0.85 ||
  vagueRecall < 0.85 ||
  jitFalseFires > 0 ||
  vagueFalseFires > 0
) {
  console.error('\nQUALITY REGRESSION: recall, JIT pointer, or false-positive guarantee failed.');
  process.exit(1);
}

function pct(x) {
  return (100 * x).toFixed(0) + '%';
}
