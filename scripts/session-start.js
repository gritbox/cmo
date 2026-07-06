'use strict';
// SessionStart hook: inject a hard-budgeted slice of project memory.
//
// Priority order: handoff (most recent working state) > decisions > index.
// After compaction (source === "compact") only the handoff is re-injected.
// If the budget is exceeded, content is truncated at a line boundary and a
// pointer to the on-disk memory is appended — retrieval past the budget is
// always lazy (Grep/Read), never pushed.
//
// Config: CMO_BUDGET_TOKENS (default 800).

const path = require('path');
const lib = require('./lib');

lib.failOpen(() => {
  const input = lib.readHookInput();
  const cwd = input.cwd || process.cwd();
  const dir = lib.memoryDir(cwd);
  const budgetChars = (parseInt(process.env.CMO_BUDGET_TOKENS, 10) || 800) * 4;

  const handoff = lib.readIfExists(path.join(dir, 'handoff.md')).trim();
  const decisions = lib.readIfExists(path.join(dir, 'decisions.md')).trim();
  const index = lib.readIfExists(path.join(dir, 'index.md')).trim();

  const afterCompact = input.source === 'compact';
  const sections = [];
  if (handoff) sections.push('## Working state from last session/compaction\n' + handoff);
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
    ? `\n[…truncated at ${Math.round(budgetChars / 4)}-token budget. Full memory: .claude/memory/]`
    : '';
  const footer =
    '\nOlder session history is in .claude/memory/journal/ (append-only Markdown). ' +
    'Grep it on demand instead of asking the user to repeat context.';

  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '# Project memory (cmo)\n' + body + pointer + footer,
    },
  });
});
