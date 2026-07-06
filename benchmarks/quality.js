'use strict';
// CMO recall-quality benchmark: does the memory pipeline actually surface the
// right fact later?
//
// 20 known decisions ("chose X for Y because Z") are seeded across 20
// synthetic sessions, each run through the REAL snapshot.js SessionEnd hook.
// 8 of them are additionally written to decisions.md in the format
// /cmo:remember produces. Retrieval is then simulated the way /cmo:recall
// works — case-insensitive keyword search over .claude/memory/ — under three
// query classes:
//
//   direct     query names the chosen thing        ("neonhttp")
//   topical    query names the problem domain      ("http client retries")
//   paraphrase query uses synonyms never recorded  ("fetch wrapper")
//
// plus 6 negative queries about facts never seeded (false-positive check).
//
// Paraphrase queries are EXPECTED to fail under keyword search — that is the
// semantic-search trade-off CMO consciously makes, and this benchmark exists
// to keep the size of that trade-off measured instead of hand-waved.
//
// Run: node benchmarks/quality.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const est = (s) => Math.ceil(s.length / 4);

// topic (domain words) | choice (named thing) | reason | paraphrase (synonyms, never recorded)
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
  // First 8 facts also curated via the /cmo:remember format.
  const dec = ['# Decisions', '', `### ${new Date().toISOString().slice(0, 10)}`];
  for (const f of FACTS.slice(0, 8)) dec.push(`- Use ${f.choice} for ${f.topic} — ${f.reason}.`);
  fs.writeFileSync(path.join(proj, '.claude', 'memory', 'decisions.md'), dec.join('\n') + '\n');
  return proj;
}

// ---------------------------------------------------------------- retrieval

/** Simulate /cmo:recall's grep tier: lines where ALL query terms appear. */
function grepMemory(proj, query) {
  const root = path.join(proj, '.claude', 'memory');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          const low = line.toLowerCase();
          if (terms.every((t) => low.includes(t))) hits.push(line.trim());
        }
      }
    }
  };
  walk(root);
  return hits;
}

function score(proj, queries, expectFn) {
  let found = 0;
  let tokens = 0;
  for (const q of queries) {
    const hits = grepMemory(proj, q.query);
    tokens += est(hits.join('\n'));
    if (hits.some((h) => expectFn(q, h))) found++;
  }
  return { recall: found / queries.length, avgTokens: Math.round(tokens / queries.length) };
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
const paraphrase = score(
  proj,
  FACTS.map((f) => ({ query: f.paraphrase, f })),
  (q, hit) => hit.toLowerCase().includes(q.f.choice.toLowerCase())
);
let falsePositives = 0;
for (const q of NEGATIVE_QUERIES) if (grepMemory(proj, q).length) falsePositives++;

// ---------------------------------------------------------------- jit hook

// End-to-end through the real jit-recall.js hook: a user prompt mentioning a
// seeded topic should produce a pointer naming the choice; unrelated prompts
// must stay silent.
function runJit(prompt) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'jit-recall.js')], {
    input: JSON.stringify({
      cwd: proj,
      prompt,
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

const journalDir = path.join(proj, '.claude', 'memory', 'journal');
const journalTokens = fs
  .readdirSync(journalDir)
  .reduce((n, f) => n + est(fs.readFileSync(path.join(journalDir, f), 'utf8')), 0);

console.log('## Recall-quality benchmark (20 seeded facts, real snapshot pipeline)\n');
console.log('| Query class | Example | Recall | Avg retrieval tokens |');
console.log('|---|---|---|---|');
console.log(`| Direct (names the choice) | \`floodgate\` | ${pct(direct.recall)} | ${direct.avgTokens} |`);
console.log(`| Topical (names the domain) | \`rate limiting\` | ${pct(topical.recall)} | ${topical.avgTokens} |`);
console.log(`| Paraphrase (synonyms only) | \`throttling requests\` | ${pct(paraphrase.recall)} | ${paraphrase.avgTokens} |`);
console.log(`| Negative (never stored) | \`service mesh sidecar\` | ${falsePositives}/${NEGATIVE_QUERIES.length} false positives | — |`);
console.log(`| JIT pointer (real UserPromptSubmit hook) | "something looks off with our rate limiting" | ${pct(jitRecall)} | ${jitAvgTokens} |`);
console.log(`| JIT on never-stored topics | — | ${jitFalseFires}/${NEGATIVE_QUERIES.length} false fires | — |`);
console.log(`\nTotal journal size after 20 sessions: ${journalTokens} tokens (retrieved lazily, never resident).`);
console.log('\nParaphrase misses are the expected cost of keyword-only retrieval —');
console.log('tracked here so the trade-off stays measured. The jit-recall hook covers');
console.log('the "model never looked" gap for on-topic prompts at ~zero resident cost.');
console.log(`\n(scratch project: ${proj})`);

// Non-zero exit if the pipeline regresses on what it MUST do.
if (direct.recall < 1 || topical.recall < 0.9 || falsePositives > 0 || jitRecall < 0.85 || jitFalseFires > 0) {
  console.error('\nQUALITY REGRESSION: recall, JIT pointer, or false-positive guarantee failed.');
  process.exit(1);
}

function pct(x) {
  return (100 * x).toFixed(0) + '%';
}
