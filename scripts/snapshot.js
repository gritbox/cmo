'use strict';
// PreCompact + SessionEnd hook: deterministic working-state capture.
//
// Reads the transcript path Claude Code hands over on stdin (we never scan or
// mutate ~/.claude/projects/ ourselves) and extracts — with zero LLM calls —
// the session's intents (user messages), todo state, edited files, and recent
// commands. Writes:
//   .cmo/handoff.md          (overwritten; restored at SessionStart)
//   .cmo/journal/YYYY-MM.md  (append-only digest, SessionEnd only)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

lib.failOpen(() => {
  const input = lib.readHookInput();
  const cwd = input.cwd || process.cwd();
  if (!input.transcript_path) process.exit(0);

  const parsed = lib.parseTranscript(input.transcript_path);
  const state = lib.extractState(parsed, cwd);

  // Trivial sessions (nothing edited, barely any conversation) leave no trace.
  if (!state.filesEdited.length && parsed.userTexts.length < 2 && !state.todos.length) {
    process.exit(0);
  }

  let branch = '';
  let commits = [];
  const gitOpts = { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 };
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).toString().trim();
    // Commits made during this session are the highest-signal deterministic
    // record of what happened — human-curated summaries, captured for free.
    if (parsed.firstTimestamp) {
      try {
        commits = execFileSync(
          'git',
          ['log', '--oneline', '--no-decorate', '-n', '10', '--since', parsed.firstTimestamp],
          gitOpts
        )
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch {
        /* log can fail on an unborn branch */
      }
    }
  } catch {
    /* not a git repo */
  }

  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const event = input.hook_event_name || 'unknown';
  const lines = [];
  lines.push(`_${stamp} · ${event}${branch ? ` · branch \`${branch}\`` : ''}_`);
  if (state.intents.length) {
    lines.push('', '**Working on:**');
    for (const t of state.intents) lines.push(`- ${t}`);
  }
  if (state.todos.length) {
    lines.push('', '**Todos at snapshot:**');
    for (const t of state.todos) lines.push(`- ${t}`);
  }
  if (state.filesEdited.length) {
    lines.push('', '**Files modified:** ' + state.filesEdited.join(', '));
  }
  if (commits.length) {
    lines.push('', '**Commits this session:**');
    for (const c of commits) lines.push(`- ${lib.oneLine(c, 100)}`);
  }
  if (state.commands.length) {
    lines.push('', '**Recent commands:**');
    for (const c of state.commands) lines.push(`- \`${c}\``);
  }
  const digest = lines.join('\n');

  const dir = lib.memoryDir(cwd);
  lib.ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'handoff.md'), digest + '\n');

  if (event === 'SessionEnd') {
    const journalDir = path.join(dir, 'journal');
    lib.ensureDir(journalDir);
    const file = path.join(journalDir, now.toISOString().slice(0, 7) + '.md');
    // Dedup on the full session id — a truncated prefix can collide and
    // silently drop sessions from the journal.
    const sid = input.session_id || 'unknown-session';
    const sidTag = `session ${sid}`;
    const existing = lib.readIfExists(file, 1024 * 1024);
    if (!existing.includes(sidTag)) {
      // Journal entries are terser than the handoff: intent, files, todos left open.
      const open = state.todos.filter((t) => !t.startsWith('[completed]'));
      const entry = [
        `\n---\n### ${stamp} (${sidTag})${branch ? ` on \`${branch}\`` : ''}`,
        state.intents.length ? `- Intent: ${state.intents[0]}` : null,
        commits.length ? `- Commits: ${commits.map((c) => lib.oneLine(c, 80)).join('; ')}` : null,
        state.filesEdited.length ? `- Touched: ${state.filesEdited.join(', ')}` : null,
        open.length ? `- Left open: ${open.join('; ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      fs.appendFileSync(file, entry + '\n');
    }
  }
});
