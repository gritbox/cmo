'use strict';
// CMO hook test suite. No dependencies: `node --test test/`
//
// Every test drives the real scripts through their stdin JSON contract in an
// isolated temp project, the same way Claude Code invokes them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function run(script, stdinObj, env = {}) {
  const res = spawnSync('node', [path.join(SCRIPTS, script)], {
    input: stdinObj === null ? '' : JSON.stringify(stdinObj),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* hook emitted nothing — valid */
  }
  return { code: res.status, out, raw: res.stdout };
}

function tmpProj() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmo-test-'));
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function memFile(proj, ...rest) {
  return path.join(proj, '.cmo', ...rest);
}

const userMsg = (t, ts) => ({ timestamp: ts, message: { role: 'user', content: t } });
const toolUse = (name, input) => ({
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
});

/** Standard non-trivial session transcript. */
function standardTranscript(proj, firstTs) {
  return writeTranscript(proj, [
    userMsg('Fix the flaky login test', firstTs),
    userMsg('<system-reminder>injected harness noise</system-reminder>'),
    userMsg('<command-message>cmo:remember</command-message> <command-name>/cmo:remember</command-name>'),
    userMsg('Base directory for this skill: /plugins/cmo/skills/remember # Remember a durable fact'),
    toolUse('Edit', { file_path: path.join(proj, 'src', 'login.test.ts') }),
    toolUse('Bash', { command: 'npm test -- login' }),
    toolUse('TodoWrite', {
      todos: [
        { content: 'stabilize login test', status: 'in_progress' },
        { content: 'remove sleep-based waits', status: 'completed' },
      ],
    }),
    userMsg('also drop the sleep-based waits'),
  ]);
}

// ---------------------------------------------------------------- fail-open

test('all scripts exit 0 and stay silent on empty stdin', () => {
  for (const s of ['session-start.js', 'snapshot.js', 'trim.js', 'jit-recall.js']) {
    const r = run(s, null);
    assert.equal(r.code, 0, `${s} exit code`);
    assert.equal(r.out, null, `${s} should emit nothing`);
  }
});

test('session-start is silent when no memory exists', () => {
  const proj = tmpProj();
  const r = run('session-start.js', { cwd: proj, source: 'startup' });
  assert.equal(r.code, 0);
  assert.equal(r.out, null);
});

test('snapshot is silent when the transcript is missing', () => {
  const proj = tmpProj();
  const r = run('snapshot.js', {
    cwd: proj,
    transcript_path: path.join(proj, 'nope.jsonl'),
    hook_event_name: 'SessionEnd',
  });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(memFile(proj, 'handoff.md')));
});

// ---------------------------------------------------------------- snapshot

test('snapshot extracts intent, todos, files, commands; filters harness noise', () => {
  const proj = tmpProj();
  const transcript = standardTranscript(proj);
  const r = run('snapshot.js', {
    cwd: proj,
    transcript_path: transcript,
    session_id: 'sess-11112222',
    hook_event_name: 'PreCompact',
  });
  assert.equal(r.code, 0);
  const handoff = fs.readFileSync(memFile(proj, 'handoff.md'), 'utf8');
  assert.match(handoff, /Fix the flaky login test/);
  assert.match(handoff, /\[in_progress\] stabilize login test/);
  assert.match(handoff, /src[/\\]login\.test\.ts/);
  assert.match(handoff, /npm test -- login/);
  assert.doesNotMatch(handoff, /system-reminder/);
  assert.doesNotMatch(handoff, /command-message/);
  assert.doesNotMatch(handoff, /Base directory for this skill/);
  // PreCompact writes the handoff but not the journal
  assert.ok(!fs.existsSync(memFile(proj, 'journal')));
});

test('snapshot captures commits made during the session window', () => {
  const proj = tmpProj();
  const git = (...args) => execFileSync('git', args, { cwd: proj, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'fix: add retry backoff');
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const transcript = standardTranscript(proj, hourAgo);
  run('snapshot.js', {
    cwd: proj,
    transcript_path: transcript,
    session_id: 'sess-commits1',
    hook_event_name: 'SessionEnd',
  });
  const handoff = fs.readFileSync(memFile(proj, 'handoff.md'), 'utf8');
  assert.match(handoff, /Commits this session:/);
  assert.match(handoff, /fix: add retry backoff/);
  const journal = fs.readFileSync(journalFile(proj), 'utf8');
  assert.match(journal, /Commits: .*fix: add retry backoff/);
});

test('journal entries are deduplicated per session', () => {
  const proj = tmpProj();
  const transcript = standardTranscript(proj);
  const input = {
    cwd: proj,
    transcript_path: transcript,
    session_id: 'sess-dedup123',
    hook_event_name: 'SessionEnd',
  };
  run('snapshot.js', input);
  run('snapshot.js', input);
  const journal = fs.readFileSync(journalFile(proj), 'utf8');
  const entries = journal.match(/^### /gm) || [];
  assert.equal(entries.length, 1);
});

test('trivial sessions leave no trace', () => {
  const proj = tmpProj();
  const transcript = writeTranscript(proj, [userMsg('hi')]);
  run('snapshot.js', {
    cwd: proj,
    transcript_path: transcript,
    session_id: 'sess-trivial1',
    hook_event_name: 'SessionEnd',
  });
  assert.ok(!fs.existsSync(memFile(proj)));
});

function journalFile(proj) {
  const dir = memFile(proj, 'journal');
  return path.join(dir, fs.readdirSync(dir)[0]);
}

// ---------------------------------------------------------------- session-start

function seedHandoff(proj, ageHours, body = '**Working on:**\n- Fix the flaky login test') {
  fs.mkdirSync(memFile(proj), { recursive: true });
  const stamp = new Date(Date.now() - ageHours * 3_600_000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  fs.writeFileSync(memFile(proj, 'handoff.md'), `_${stamp} UTC · SessionEnd_\n\n${body}\n`);
}

test('fresh handoff injects as current working state', () => {
  const proj = tmpProj();
  seedHandoff(proj, 1);
  const ctx = run('session-start.js', { cwd: proj, source: 'startup' }).out.hookSpecificOutput
    .additionalContext;
  assert.match(ctx, /## Working state from last session\/compaction/);
  assert.match(ctx, /Fix the flaky login test/);
});

test('stale handoff (>48h) is labeled STALE', () => {
  const proj = tmpProj();
  seedHandoff(proj, 5 * 24);
  const ctx = run('session-start.js', { cwd: proj, source: 'startup' }).out.hookSpecificOutput
    .additionalContext;
  assert.match(ctx, /STALE — verify before relying on it/);
  assert.match(ctx, /Fix the flaky login test/); // content still present
});

test('ancient handoff (>14d) collapses to a pointer', () => {
  const proj = tmpProj();
  seedHandoff(proj, 30 * 24);
  const ctx = run('session-start.js', { cwd: proj, source: 'startup' }).out.hookSpecificOutput
    .additionalContext;
  assert.match(ctx, /treat it as history, not current state/);
  assert.doesNotMatch(ctx, /Fix the flaky login test/);
});

test('after compaction only the handoff is injected', () => {
  const proj = tmpProj();
  seedHandoff(proj, 1);
  fs.writeFileSync(memFile(proj, 'decisions.md'), '# Decisions\n- use pnpm\n');
  fs.writeFileSync(memFile(proj, 'index.md'), '# Index\n- entry point: src/main.ts\n');
  const ctx = run('session-start.js', { cwd: proj, source: 'compact' }).out.hookSpecificOutput
    .additionalContext;
  assert.match(ctx, /Working state/);
  assert.doesNotMatch(ctx, /use pnpm/);
  assert.doesNotMatch(ctx, /entry point/);
});

test('injection is truncated at the token budget with a marker', () => {
  const proj = tmpProj();
  seedHandoff(proj, 1, Array.from({ length: 80 }, (_, i) => `- filler line ${i}`).join('\n'));
  const ctx = run('session-start.js', { cwd: proj, source: 'startup' }, { CMO_BUDGET_TOKENS: '60' })
    .out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /truncated at 60-token budget/);
  assert.ok(ctx.length < 60 * 4 + 400, 'stays near budget plus fixed footer');
});

// ---------------------------------------------------------------- trim

const trimInput = (proj, payload) => ({
  cwd: proj,
  tool_name: 'Bash',
  tool_response: { stdout: payload, stderr: '' },
});

test('outputs under the threshold pass through untouched', () => {
  const proj = tmpProj();
  const r = run('trim.js', trimInput(proj, 'short output'));
  assert.equal(r.out, null);
});

test('oversized output is trimmed, marked, and fully recoverable from spill', () => {
  const proj = tmpProj();
  const payload = 'A'.repeat(20000) + 'NEEDLE-IN-MIDDLE' + 'B'.repeat(20000);
  const r = run('trim.js', trimInput(proj, payload));
  const stdout = r.out.hookSpecificOutput.updatedToolOutput.stdout;
  assert.ok(stdout.length < payload.length);
  assert.match(stdout, /\[cmo: output trimmed/);
  assert.doesNotMatch(stdout, /NEEDLE-IN-MIDDLE/);
  const spillDir = memFile(proj, 'spill');
  const spill = fs.readFileSync(path.join(spillDir, fs.readdirSync(spillDir)[0]), 'utf8');
  assert.equal(spill, payload, 'spill preserves the exact payload');
  assert.equal(r.out.hookSpecificOutput.updatedToolOutput.stderr, '', 'other fields untouched');
});

test('array-of-blocks tool responses are trimmed per text block', () => {
  const proj = tmpProj();
  const r = run('trim.js', {
    cwd: proj,
    tool_name: 'Read',
    tool_response: [{ type: 'text', text: 'X'.repeat(40000) }],
  });
  assert.match(r.out.hookSpecificOutput.updatedToolOutput[0].text, /\[cmo: output trimmed/);
});

test('nested Read-shaped responses (tool_response.file.content) are trimmed', () => {
  // The real Read tool nests its payload: { type, file: { filePath, content, … } }.
  const proj = tmpProj();
  const payload = 'line\n'.repeat(9000); // 45k chars, repetitive
  const r = run('trim.js', {
    cwd: proj,
    tool_name: 'Read',
    tool_response: {
      type: 'text',
      file: { filePath: path.join(proj, 'big.log'), content: payload, numLines: 9000 },
    },
  });
  const file = r.out.hookSpecificOutput.updatedToolOutput.file;
  assert.match(file.content, /\[cmo: output trimmed/);
  assert.ok(file.content.length < payload.length);
  assert.equal(file.numLines, 9000, 'sibling fields untouched');
  assert.equal(r.out.hookSpecificOutput.updatedToolOutput.type, 'text');
  const spillDir = memFile(proj, 'spill');
  const spill = fs.readFileSync(path.join(spillDir, fs.readdirSync(spillDir)[0]), 'utf8');
  assert.equal(spill, payload);
});

test('already-trimmed payloads are not re-trimmed', () => {
  const proj = tmpProj();
  const payload = 'A'.repeat(40000) + '[cmo: output trimmed marker from earlier]';
  const r = run('trim.js', trimInput(proj, payload));
  assert.equal(r.out, null);
});

test('CMO_TRIM_CHARS=0 disables trimming', () => {
  const proj = tmpProj();
  const r = run('trim.js', trimInput(proj, 'X'.repeat(40000)), { CMO_TRIM_CHARS: '0' });
  assert.equal(r.out, null);
});

test('repetitive log payloads are line-deduped with counts instead of excerpted', () => {
  const proj = tmpProj();
  const unique = Array.from({ length: 30 }, (_, i) => `INFO starting worker ${i}`);
  const spam = Array(2000).fill('WARN retry queue full, backing off');
  const payload = unique.concat(spam).join('\n');
  assert.ok(payload.length > 30000);
  const r = run('trim.js', trimInput(proj, payload));
  const stdout = r.out.hookSpecificOutput.updatedToolOutput.stdout;
  assert.match(stdout, /WARN retry queue full, backing off {2}\[x2000\]/);
  assert.match(stdout, /deduplicated/);
  assert.match(stdout, /INFO starting worker 29/, 'every distinct line survives');
});

test('mostly-unique payloads skip dedup and fall back to head+tail', () => {
  const proj = tmpProj();
  const payload = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const r = run('trim.js', trimInput(proj, payload));
  const stdout = r.out.hookSpecificOutput.updatedToolOutput.stdout;
  assert.match(stdout, /middle omitted/);
  assert.doesNotMatch(stdout, /deduplicated/);
});

test('spill directory is capped at CMO_SPILL_MAX files, pruned files leave tombstones', () => {
  const proj = tmpProj();
  for (let i = 0; i < 5; i++) {
    run('trim.js', trimInput(proj, `payload-${i}-` + 'X'.repeat(40000)), { CMO_SPILL_MAX: '3' });
  }
  const files = fs.readdirSync(memFile(proj, 'spill')).filter((f) => f.endsWith('.txt'));
  assert.ok(files.length <= 3, `expected <=3 spill files, got ${files.length}`);
  const tomb = fs.readFileSync(memFile(proj, 'spill', 'tombstones.md'), 'utf8');
  assert.match(tomb, /pruned \d{4}-\d{2}-\d{2}/);
  assert.match(tomb, /began: "payload-0-/); // oldest unaccessed went first
});

test('accessed spill files are protected from pruning; a Read records heat', () => {
  const proj = tmpProj();
  // Create the first spill, then simulate the model Reading it back.
  run('trim.js', trimInput(proj, 'precious-' + 'X'.repeat(40000)), { CMO_SPILL_MAX: '2' });
  const first = fs.readdirSync(memFile(proj, 'spill')).find((f) => f.endsWith('.txt'));
  run('trim.js', {
    tool_name: 'Read',
    tool_input: { file_path: memFile(proj, 'spill', first) },
    cwd: proj,
  });
  const heat = JSON.parse(fs.readFileSync(memFile(proj, 'heat.json'), 'utf8'));
  assert.ok(heat.hits[`file:spill/${first}`], 'Read of a spill file is recorded as heat');

  // Ensure distinct mtimes so the accessed file is the oldest candidate.
  fs.utimesSync(memFile(proj, 'spill', first), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  for (let i = 0; i < 4; i++) {
    run('trim.js', trimInput(proj, `later-${i}-` + 'Y'.repeat(40000)), { CMO_SPILL_MAX: '2' });
  }
  assert.ok(
    fs.existsSync(memFile(proj, 'spill', first)),
    'the accessed (hot) spill survives pruning that removed colder, newer files'
  );
});

// ---------------------------------------------------------------- jit-recall

function seedJournal(proj) {
  fs.mkdirSync(memFile(proj, 'journal'), { recursive: true });
  fs.writeFileSync(
    memFile(proj, 'journal', '2026-06.md'),
    [
      '---',
      '### 2026-06-10 09:00 UTC (session aaa)',
      '- Intent: We need rate limiting. Decided to go with floodgate because sliding windows.',
      '- Touched: src/floodgate.ts',
      '---',
      '### 2026-06-12 09:00 UTC (session bbb)',
      '- Intent: Pick a logging library. Went with inkwell for structured JSON output.',
      '- Touched: src/inkwell.ts',
    ].join('\n') + '\n'
  );
}

const jitInput = (proj, prompt, sid) => ({
  cwd: proj,
  prompt,
  session_id: sid || `jit-${Math.random().toString(36).slice(2)}`,
  hook_event_name: 'UserPromptSubmit',
});

test('jit-recall surfaces a pointer for prompts matching journal history', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const r = run('jit-recall.js', jitInput(proj, 'why is rate limiting behaving oddly under load?'));
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[cmo recall hint\]/);
  assert.match(ctx, /floodgate/);
});

test('jit-recall stays silent for unrelated prompts', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const r = run('jit-recall.js', jitInput(proj, 'please refactor the checkout page styling for mobile'));
  assert.equal(r.out, null);
});

test('jit-recall stays silent for slash commands and short prompts', () => {
  const proj = tmpProj();
  seedJournal(proj);
  assert.equal(run('jit-recall.js', jitInput(proj, '/compact')).out, null);
  assert.equal(run('jit-recall.js', jitInput(proj, 'ok do it')).out, null);
});

test('jit-recall never repeats a pointer within a session', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const sid = `jit-dedup-${Date.now()}`;
  const first = run('jit-recall.js', jitInput(proj, 'rate limiting seems broken again', sid));
  assert.ok(first.out, 'first prompt gets the pointer');
  const second = run('jit-recall.js', jitInput(proj, 'still seeing rate limiting failures', sid));
  assert.equal(second.out, null, 'same pointer suppressed for the rest of the session');
});

test('jit-recall can be disabled with CMO_JIT=off', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const r = run('jit-recall.js', jitInput(proj, 'rate limiting is failing under load'), { CMO_JIT: 'off' });
  assert.equal(r.out, null);
});

// ------------------------------------------ glossary + expansion + vagueness

function seedGlossary(proj) {
  fs.mkdirSync(memFile(proj), { recursive: true });
  fs.writeFileSync(
    memFile(proj, 'glossary.md'),
    '# Glossary\n- floodgate: rate limiting, throttling, request limits\n'
  );
}

test('jit-recall matches paraphrases through glossary aliases', () => {
  const proj = tmpProj();
  seedJournal(proj);
  seedGlossary(proj);
  // "throttling" never appears in the journal — only via the glossary.
  const r = run('jit-recall.js', jitInput(proj, 'the request throttling seems too aggressive lately'));
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /floodgate/);
});

test('glossary expansion counts one concept once — no self-inflated match', () => {
  const proj = tmpProj();
  seedJournal(proj);
  seedGlossary(proj);
  // An off-topic prompt sharing zero concepts must stay silent even though
  // the glossary knows many surface forms for floodgate.
  const r = run('jit-recall.js', jitInput(proj, 'rewrite the marketing landing page hero copy'));
  assert.equal(r.out, null);
});

test('stemming bridges morphological variants (retry vs retries)', () => {
  const proj = tmpProj();
  fs.mkdirSync(memFile(proj, 'journal'), { recursive: true });
  fs.writeFileSync(
    memFile(proj, 'journal', '2026-06.md'),
    '### 2026-06-01 (session ccc)\n- Intent: webhook retry backoff uses exponential delays.\n'
  );
  const r = run('jit-recall.js', jitInput(proj, 'why are webhook retries so slow lately?'));
  assert.match(r.out.hookSpecificOutput.additionalContext, /retry backoff/);
});

test('vague affirmation resolves its referent from the previous assistant turn', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const transcript = writeTranscript(proj, [
    userMsg('hm, where did we land on that?'),
    {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Past sessions covered the rate limiting rollout with floodgate — want me to pull that decision up?' },
        ],
      },
    },
  ]);
  const r = run('jit-recall.js', { ...jitInput(proj, 'sure. go ahead.'), transcript_path: transcript });
  assert.match(r.out.hookSpecificOutput.additionalContext, /floodgate/);
});

test('vague affirmation without a transcript stays silent', () => {
  const proj = tmpProj();
  seedJournal(proj);
  assert.equal(run('jit-recall.js', jitInput(proj, 'sure, go ahead!')).out, null);
});

// ---------------------------------------------------------------- search.js

function runSearch(proj, ...args) {
  const res = spawnSync('node', [path.join(SCRIPTS, 'search.js'), '--cwd', proj, ...args], {
    encoding: 'utf8',
  });
  return res.stdout.split('\n').filter(Boolean);
}

test('search.js ranks multi-concept matches first and finds glossary paraphrases', () => {
  const proj = tmpProj();
  seedJournal(proj);
  seedGlossary(proj);
  const hits = runSearch(proj, '--top', '3', 'throttling requests');
  assert.ok(hits.length >= 1, 'paraphrase should match via glossary');
  assert.match(hits[0], /floodgate|rate limiting/);
});

test('search.js labels single-incidental-word matches as weak', () => {
  const proj = tmpProj();
  seedJournal(proj);
  // Only "logging" overlaps; "kafka consumer" does not — the hit must carry
  // the [weak: …] label so consumers can discount it.
  const hits = runSearch(proj, 'kafka consumer logging offsets');
  assert.ok(hits.every((h) => !h.includes('inkwell') || h.includes('[weak:')));
});

test('search.js is silent (exit 0) when memory does not exist', () => {
  const proj = tmpProj();
  const res = spawnSync('node', [path.join(SCRIPTS, 'search.js'), '--cwd', proj, 'anything'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

// ------------------------------------- journey convergence (Trolly layout)

function seedJourneyGlossary(proj) {
  fs.mkdirSync(path.join(proj, 'journey'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'journey', 'glossary.md'),
    [
      '# Glossary',
      '- **floodgate** — the rate limiter *(aliases: throttling, request limits, backpressure)*',
      '- **heat ledger** — read-time hits: stored in heat.json *(aliases: read tracking, hit counts)*',
      '- **orphan** — a term with no aliases contributes no expansion',
      '',
    ].join('\n')
  );
}

test('loadGlossary parses the Trolly shape and merges sources deduped by head', () => {
  const proj = tmpProj();
  seedGlossary(proj); // .cmo shape: floodgate: rate limiting, throttling, request limits
  seedJourneyGlossary(proj);
  const lib = require(path.join(SCRIPTS, 'lib.js'));
  const g = lib.loadGlossary(proj);
  const heads = g.map((e) => e.head);
  // One concept group per head, even with the term in both files — a
  // duplicate would let a single concept satisfy the two-group precision bar.
  assert.equal(heads.filter((h) => h === 'floodgate').length, 1);
  const fg = g.find((e) => e.head === 'floodgate');
  assert.ok(fg.aliases.includes('rate limiting'), 'cmo-source alias kept');
  assert.ok(fg.aliases.includes('backpressure'), 'journey-source alias unioned in');
  // A colon inside the meaning must not false-parse under the CMO regex.
  assert.ok(heads.includes('heat ledger'));
  assert.ok(!heads.some((h) => h.includes('**')), 'no garbage bold heads');
  assert.ok(!heads.includes('orphan'), 'alias-less lines are skipped');
});

test('jit-recall expands through the journey glossary with no derived copy', () => {
  const proj = tmpProj();
  seedJournal(proj);
  seedJourneyGlossary(proj);
  // "backpressure" appears only as a journey-glossary alias.
  const r = run('jit-recall.js', jitInput(proj, 'is the backpressure handling too aggressive lately?'));
  assert.match(r.out.hookSpecificOutput.additionalContext, /floodgate/);
});

test('search.js searches journey docs but never journey/archive', () => {
  const proj = tmpProj();
  fs.mkdirSync(path.join(proj, 'journey', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'journey', 'archive'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'journey', 'specs', '01-mvp.md'),
    '- The zeppelin hydraulics manifold must vent within 2s.\n'
  );
  fs.writeFileSync(
    path.join(proj, 'journey', 'archive', 'old-spec.md'),
    '- The zeppelin hydraulics manifold must vent within 9s.\n'
  );
  const hits = runSearch(proj, 'zeppelin hydraulics manifold');
  assert.ok(hits.some((h) => h.startsWith('journey/specs/01-mvp.md:')), 'journey doc surfaced');
  assert.ok(!hits.some((h) => h.includes('archive')), 'superseded archive versions stay buried');
});

test('search.js quota keeps memory hits from being crowded out by journey docs', () => {
  const proj = tmpProj();
  fs.mkdirSync(memFile(proj, 'journal'), { recursive: true });
  fs.writeFileSync(
    memFile(proj, 'journal', '2026-06.md'),
    '- Decided: zeppelin hydraulics pressure capped at 40psi.\n'
  );
  fs.mkdirSync(path.join(proj, 'journey'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'journey', 'notes.md'),
    [
      '- zeppelin hydraulics manifold alpha section',
      '- zeppelin hydraulics manifold beta section',
      '- zeppelin hydraulics manifold gamma section',
      '',
    ].join('\n')
  );
  // Journey lines match 3 concepts, the journal line only 2 — a global top-2
  // would be all journey. The quota reserves room for the memory hit.
  const hits = runSearch(proj, '--top', '2', 'zeppelin hydraulics manifold');
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.startsWith('journal/2026-06.md:')), 'memory hit survives');
  assert.ok(hits.some((h) => h.startsWith('journey/notes.md:')), 'journey hit shown');
});

test('search.js records heat for memory hits only — journey is not CMO-governed', () => {
  const proj = tmpProj();
  seedJournal(proj);
  fs.mkdirSync(path.join(proj, 'journey'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'journey', 'notes.md'), '- floodgate sliding windows rollout plan.\n');
  runSearch(proj, 'floodgate', 'sliding', 'windows');
  const heat = JSON.parse(fs.readFileSync(memFile(proj, 'heat.json'), 'utf8'));
  const keys = Object.keys(heat.hits);
  assert.ok(keys.some((k) => k.startsWith('journal/2026-06.md:')), 'memory line recorded');
  assert.ok(!keys.some((k) => k.startsWith('journey/')), 'journey lines not recorded');
});

// ------------------------------------------------- approve-memory-writes

const approveInput = (proj, tool, file) => ({
  cwd: proj,
  tool_name: tool,
  hook_event_name: 'PreToolUse',
  tool_input: { file_path: file },
});

test('memory-dir writes are auto-approved for Write and Edit', () => {
  const proj = tmpProj();
  for (const tool of ['Write', 'Edit']) {
    const r = run('approve-memory-writes.js', approveInput(proj, tool, path.join(proj, '.cmo', 'decisions.md')));
    assert.equal(r.code, 0);
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'allow', `${tool} allowed`);
  }
});

test('relative memory paths are approved, everything else gets no opinion', () => {
  const proj = tmpProj();
  const rel = run('approve-memory-writes.js', approveInput(proj, 'Write', '.cmo/journal/2026-07.md'));
  assert.equal(rel.out.hookSpecificOutput.permissionDecision, 'allow');
  for (const file of [
    path.join(proj, 'src', 'app.js'), // ordinary project file
    path.join(proj, '.claude', 'settings.json'), // protected harness config
    path.join(proj, '.cmo', '..', 'escape.md'), // traversal out of the memory dir
    proj + '.cmo/decisions.md', // sibling dir with a tricky prefix
  ]) {
    const r = run('approve-memory-writes.js', approveInput(proj, 'Write', file));
    assert.equal(r.out, null, `no opinion for ${file}`);
  }
});

test('a symlinked memory subdir cannot become a write gate to elsewhere', () => {
  const proj = tmpProj();
  const outside = tmpProj();
  fs.mkdirSync(path.join(proj, '.cmo'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(proj, '.cmo', 'link'), 'dir');
  } catch {
    return; // symlinks unavailable (Windows without privileges) — skip
  }
  const r = run('approve-memory-writes.js', approveInput(proj, 'Write', path.join(proj, '.cmo', 'link', 'x.md')));
  assert.equal(r.out, null, 'symlink escape must not be auto-approved');
});

test('non-write tools get no opinion even for memory paths', () => {
  const proj = tmpProj();
  const r = run('approve-memory-writes.js', {
    cwd: proj,
    tool_name: 'Bash',
    hook_event_name: 'PreToolUse',
    tool_input: { command: `rm -rf ${path.join(proj, '.cmo')}` },
  });
  assert.equal(r.out, null);
});

// ------------------------------------------------------- legacy migration

test('a pre-0.2 .claude/memory tree is migrated to .cmo on first touch', () => {
  const proj = tmpProj();
  const legacy = path.join(proj, '.claude', 'memory');
  fs.mkdirSync(path.join(legacy, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'handoff.md'), '_2099-01-01 00:00 UTC · SessionEnd_\nold state\n');
  fs.writeFileSync(path.join(legacy, 'journal', '2025-12.md'), '- Intent: legacy entry\n');
  const r = run('session-start.js', { cwd: proj, source: 'startup' });
  assert.match(r.out.hookSpecificOutput.additionalContext, /old state/);
  assert.ok(fs.existsSync(path.join(proj, '.cmo', 'journal', '2025-12.md')), 'tree moved');
  assert.ok(!fs.existsSync(legacy), 'legacy dir gone');
});

test('an existing .cmo dir is never clobbered by a leftover legacy tree', () => {
  const proj = tmpProj();
  fs.mkdirSync(path.join(proj, '.cmo'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.cmo', 'handoff.md'), '_2099-01-01 00:00 UTC · SessionEnd_\nnew state\n');
  fs.mkdirSync(path.join(proj, '.claude', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'memory', 'handoff.md'), 'stale\n');
  const r = run('session-start.js', { cwd: proj, source: 'startup' });
  assert.match(r.out.hookSpecificOutput.additionalContext, /new state/);
  assert.doesNotMatch(r.out.hookSpecificOutput.additionalContext, /stale/);
});

// ------------------------------------------------- retention (RETENTION.md)

test('budget eviction is value-ordered: newest decisions survive, oldest are shed', () => {
  const proj = tmpProj();
  fs.mkdirSync(memFile(proj), { recursive: true });
  const stamp = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  fs.writeFileSync(memFile(proj, 'handoff.md'), `_${stamp} UTC · SessionEnd_\n\n**Working on:**\n- current work\n`);
  fs.writeFileSync(
    memFile(proj, 'decisions.md'),
    '# Decisions\n### 2024-01-01\n- OLD-RULE ' + 'filler '.repeat(60) + '\n### 2026-07-01\n- NEW-RULE use widget-beta\n'
  );
  fs.writeFileSync(memFile(proj, 'index.md'), '# Index\n- entry point: src/main.ts\n');
  const ctx = run('session-start.js', { cwd: proj, source: 'startup' }, { CMO_BUDGET_TOKENS: '150' })
    .out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /NEW-RULE use widget-beta/, 'newest decision survives the budget');
  assert.doesNotMatch(ctx, /OLD-RULE/, 'oldest decision is the one shed');
  assert.match(ctx, /older decisions omitted at budget/);
  assert.match(ctx, /entry point: src\/main\.ts/, 'index still fits after value-ordered trim');
});

test('journal digest keeps all intents and verbatim error lines', () => {
  const proj = tmpProj();
  const transcript = writeTranscript(proj, [
    userMsg('Fix the payment webhook', '2026-07-09T10:00:00Z'),
    {
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'stack:\nError: connect ECONNREFUSED 127.0.0.1:5432 at db.ts:42\nmore output',
          },
        ],
      },
    },
    toolUse('Edit', { file_path: path.join(proj, 'src', 'webhook.ts') }),
    userMsg('also retry idempotently on duplicate delivery'),
  ]);
  run('snapshot.js', {
    cwd: proj,
    transcript_path: transcript,
    hook_event_name: 'SessionEnd',
    session_id: 'retention-1',
  });
  const journal = fs.readFileSync(
    memFile(proj, 'journal', new Date().toISOString().slice(0, 7) + '.md'),
    'utf8'
  );
  assert.match(journal, /Intent: Fix the payment webhook \| also retry idempotently/);
  assert.match(journal, /Errors seen: .*ECONNREFUSED 127\.0\.0\.1:5432 at db\.ts:42/);
});

test('search.js records line and glossary heat for surfaced results', () => {
  const proj = tmpProj();
  seedJournal(proj);
  seedGlossary(proj);
  execFileSync('node', [path.join(SCRIPTS, 'search.js'), '--cwd', proj, 'throttling', 'sliding', 'windows'], {
    encoding: 'utf8',
  });
  const heat = JSON.parse(fs.readFileSync(memFile(proj, 'heat.json'), 'utf8'));
  const keys = Object.keys(heat.hits);
  assert.ok(keys.some((k) => k.startsWith('journal/2026-06.md:')), 'surfaced line recorded');
  assert.ok(keys.includes('glossary:floodgate'), 'curated concept that matched is recorded');
});

test('jit-recall records heat for the pointers it injects', () => {
  const proj = tmpProj();
  seedJournal(proj);
  const r = run('jit-recall.js', jitInput(proj, 'why is rate limiting behaving oddly under load?'));
  assert.ok(r.out, 'pointer fired');
  const heat = JSON.parse(fs.readFileSync(memFile(proj, 'heat.json'), 'utf8'));
  assert.ok(
    Object.keys(heat.hits).some((k) => k.startsWith('journal/2026-06.md:')),
    'injected pointer line recorded as heat'
  );
});

test('heat counts halve at month boundaries and CMO_HEAT=off disables recording', () => {
  const proj = tmpProj();
  fs.mkdirSync(memFile(proj), { recursive: true });
  fs.writeFileSync(
    memFile(proj, 'heat.json'),
    JSON.stringify({ v: 1, decayed: '2020-01', hits: { 'file:spill/a.txt': { n: 5, last: '2020-01-15' }, 'file:spill/b.txt': { n: 1, last: '2020-01-15' } } })
  );
  const lib = require(path.join(SCRIPTS, 'lib.js'));
  const heat = lib.loadHeat(proj);
  assert.equal(heat.hits['file:spill/a.txt'].n, 2, 'count halved (floor)');
  assert.equal(heat.hits['file:spill/b.txt'], undefined, 'decayed-to-zero keys dropped');

  const off = tmpProj();
  fs.mkdirSync(memFile(off), { recursive: true });
  process.env.CMO_HEAT = 'off';
  try {
    lib.recordHeat(off, ['file:spill/x.txt']);
  } finally {
    delete process.env.CMO_HEAT;
  }
  assert.ok(!fs.existsSync(memFile(off, 'heat.json')), 'CMO_HEAT=off writes nothing');
});
