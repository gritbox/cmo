'use strict';
// SessionStart hook: inject a hard-budgeted slice of project memory.
//
// Priority order: handoff (most recent working state) > decisions > index.
// After compaction (source === "compact") only the handoff is re-injected.
// If the budget is exceeded, content is truncated at a line boundary and a
// pointer to the on-disk memory is appended — retrieval past the budget is
// always lazy (Grep/Read), never pushed.
//
// A handoff is only "working state" while it is recent. Injecting a weeks-old
// snapshot as if it were current would poison the session with stale context,
// so age gates apply: fresh (< CMO_STALE_HOURS, default 48) injects normally,
// stale gets an explicit warning label, ancient (> CMO_STALE_DROP_DAYS,
// default 14) collapses to a one-line pointer.
//
// Config: CMO_BUDGET_TOKENS (default 800), CMO_STALE_HOURS (48),
//         CMO_STALE_DROP_DAYS (14).

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

lib.failOpen(() => {
  const input = lib.readHookInput();
  const cwd = input.cwd || process.cwd();
  const dir = lib.memoryDir(cwd);
  const budgetChars = (parseInt(process.env.CMO_BUDGET_TOKENS, 10) || 800) * 4;

  const handoffPath = path.join(dir, 'handoff.md');
  const handoff = lib.readIfExists(handoffPath).trim();
  const decisions = lib.readIfExists(path.join(dir, 'decisions.md')).trim();
  const index = lib.readIfExists(path.join(dir, 'index.md')).trim();

  const afterCompact = input.source === 'compact';
  const sections = [];
  if (handoff) {
    const staleHours = parseFloat(process.env.CMO_STALE_HOURS) || 48;
    const dropDays = parseFloat(process.env.CMO_STALE_DROP_DAYS) || 14;
    const ageHours = handoffAgeHours(handoff, handoffPath);
    if (ageHours !== null && ageHours > dropDays * 24) {
      sections.push(
        '## Working state\n' +
          `Last recorded working state is ~${Math.round(ageHours / 24)} days old — ` +
          'treat it as history, not current state. See .cmo/handoff.md ' +
          'and the journal if it becomes relevant.'
      );
    } else if (ageHours !== null && ageHours > staleHours) {
      sections.push(
        `## Working state from ${(ageHours / 24).toFixed(1)} days ago (STALE — verify before relying on it)\n` +
          handoff
      );
    } else {
      sections.push('## Working state from last session/compaction\n' + handoff);
    }
  }
  if (!afterCompact && decisions) sections.push('## Durable project decisions\n' + decisions);
  if (!afterCompact && index) sections.push('## Project memory index\n' + index);

  if (!sections.length) process.exit(0); // no memory yet — inject nothing, zero noise

  let body = sections.join('\n\n');
  let truncated = false;
  if (body.length > budgetChars) {
    const cut = body.lastIndexOf('\n', budgetChars);
    body = body.slice(0, cut > 0 ? cut : budgetChars);
    truncated = true;
  }

  const pointer = truncated
    ? `\n[…truncated at ${Math.round(budgetChars / 4)}-token budget. Full memory: .cmo/]`
    : '';
  const footer =
    '\nOlder session history is in .cmo/journal/ (append-only Markdown). ' +
    'Grep it on demand instead of asking the user to repeat context.';

  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '# Project memory (cmo)\n' + body + pointer + footer,
    },
  });
});

/**
 * Age of the handoff in hours, from the stamp snapshot.js writes on its first
 * line (`_YYYY-MM-DD HH:MM UTC · event_`), falling back to file mtime.
 * Returns null if neither is available (then the handoff is injected as-is).
 */
function handoffAgeHours(text, filePath) {
  const m = text.match(/_(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/);
  let ts = m ? Date.parse(m[1].replace(' ', 'T') + ':00Z') : NaN;
  if (Number.isNaN(ts)) {
    try {
      ts = fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }
  return (Date.now() - ts) / 3_600_000;
}
