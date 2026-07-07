'use strict';
// PreToolUse hook: auto-approve Write/Edit inside the .cmo/ memory dir only.
//
// /cmo:remember and glossary upkeep have the model curate decisions.md /
// index.md / glossary.md — the same directory the lifecycle hooks already
// write to without any prompt. Prompting the user for every one of those
// writes (or failing them outright in non-interactive runs) would make
// memory curation effectively manual. Installing the plugin is the opt-in
// for frictionless writes to its own data directory.
//
// Scope is deliberately minimal: only the Write and Edit tools, only paths
// that resolve to real locations inside <project>/.cmo/. Anything else gets
// no opinion (exit 0), leaving the normal permission flow intact.

const path = require('path');
const fs = require('fs');
const lib = require('./lib');

lib.failOpen(() => {
  const input = lib.readHookInput();
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') process.exit(0);
  const file = input.tool_input && input.tool_input.file_path;
  if (typeof file !== 'string' || !file) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const memRoot = lib.memoryDir(cwd);
  const abs = path.resolve(cwd, file);
  if (!isInside(abs, memRoot)) process.exit(0);

  // A symlink under .cmo/ must not become a write gate to
  // elsewhere: resolve the deepest existing ancestor and re-check.
  if (!isInside(realExisting(abs), realExisting(memRoot))) process.exit(0);

  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason:
        'cmo: writes inside .cmo/ are plugin-managed project memory',
    },
  });
});

function isInside(p, root) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** realpath of the deepest existing ancestor of p, with the rest appended. */
function realExisting(p) {
  let base = p;
  const tail = [];
  while (!fs.existsSync(base)) {
    const parent = path.dirname(base);
    if (parent === base) break;
    tail.unshift(path.basename(base));
    base = parent;
  }
  try {
    base = fs.realpathSync(base);
  } catch {
    /* keep unresolved base */
  }
  return path.join(base, ...tail);
}
