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
  return path.join(proj, '.claude', 'memory', ...rest);
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
  for (const s of ['session-start.js', 'snapshot.js', 'trim.js']) {
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

test('spill directory is capped at CMO_SPILL_MAX files', () => {
  const proj = tmpProj();
  for (let i = 0; i < 5; i++) {
    run('trim.js', trimInput(proj, `payload-${i}-` + 'X'.repeat(40000)), { CMO_SPILL_MAX: '3' });
  }
  const files = fs.readdirSync(memFile(proj, 'spill'));
  assert.ok(files.length <= 3, `expected <=3 spill files, got ${files.length}`);
});
