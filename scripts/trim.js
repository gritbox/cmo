'use strict';
// PostToolUse hook: reversible trimming of oversized tool outputs.
//
// If a tool result exceeds CMO_TRIM_CHARS (default 30000 chars ≈ 7.5k tokens),
// the full payload is spilled to .claude/memory/spill/<sha12>.txt and the
// in-context result is replaced (via hookSpecificOutput.updatedToolOutput)
// with head + tail excerpts plus a pointer. The model can Read/Grep the spill
// file to recover any part — the trim is lossless on disk, cheap in context.
//
// This replaces the blueprint's "headroom" proxy + vector store with ~100
// lines and zero infrastructure. Set CMO_TRIM_CHARS=0 to disable.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const MARKER = '[cmo: output trimmed';
const SPILL_MAX_FILES = parseInt(process.env.CMO_SPILL_MAX, 10) || 50;

lib.failOpen(() => {
  const limit = process.env.CMO_TRIM_CHARS === undefined
    ? 30000
    : parseInt(process.env.CMO_TRIM_CHARS, 10) || 0;
  if (!limit) process.exit(0);

  const input = lib.readHookInput();
  const cwd = input.cwd || process.cwd();
  const resp = input.tool_response !== undefined ? input.tool_response : input.tool_output;
  if (resp === undefined || resp === null) process.exit(0);

  let changed = false;
  let updated;

  if (typeof resp === 'string') {
    const t = trimPayload(resp, limit, cwd);
    if (t) {
      updated = t;
      changed = true;
    }
  } else if (Array.isArray(resp)) {
    updated = resp.map((block) => {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const t = trimPayload(block.text, limit, cwd);
        if (t) {
          changed = true;
          return { ...block, text: t };
        }
      }
      return block;
    });
  } else if (typeof resp === 'object') {
    // Shallow walk: replace any oversized string field (covers Bash's
    // {stdout, stderr}, Read's file content, etc.) without assuming a schema.
    updated = { ...resp };
    for (const [k, v] of Object.entries(updated)) {
      if (typeof v === 'string') {
        const t = trimPayload(v, limit, cwd);
        if (t) {
          updated[k] = t;
          changed = true;
        }
      }
    }
  }

  if (!changed) process.exit(0);
  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: updated,
    },
  });
});

/** Returns the trimmed replacement string, or null if no trim applies. */
function trimPayload(s, limit, cwd) {
  if (s.length <= limit || s.includes(MARKER)) return null;

  const spillDir = path.join(lib.memoryDir(cwd), 'spill');
  lib.ensureDir(spillDir);
  const name = lib.sha12(s) + '.txt';
  const spillPath = path.join(spillDir, name);
  if (!fs.existsSync(spillPath)) fs.writeFileSync(spillPath, s);
  pruneSpill(spillDir);

  const headLen = Math.floor(limit * 0.6);
  const tailLen = Math.floor(limit * 0.15);
  const rel = path.relative(cwd, spillPath) || spillPath;
  const saved = lib.estTokens(s) - lib.estTokens(s.slice(0, headLen) + s.slice(-tailLen));
  return (
    s.slice(0, headLen) +
    `\n\n${MARKER}: ${s.length} chars total, middle omitted (~${saved} tokens saved). ` +
    `Full output preserved at ${rel} — Read with offset/limit or Grep it if the omitted portion matters.]\n\n` +
    s.slice(-tailLen)
  );
}

/** Deterministic guardrail on our own files only: cap the spill dir size. */
function pruneSpill(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const f of files.slice(0, Math.max(0, files.length - SPILL_MAX_FILES))) {
      fs.unlinkSync(f.p);
    }
  } catch {
    /* best effort */
  }
}
