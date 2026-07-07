'use strict';
// PostToolUse hook: reversible trimming of oversized tool outputs.
//
// If a tool result exceeds CMO_TRIM_CHARS (default 30000 chars ≈ 7.5k tokens),
// the full payload is spilled to .claude/memory/spill/<sha12>.txt and the
// in-context result is replaced (via hookSpecificOutput.updatedToolOutput)
// with head + tail excerpts plus a pointer. The model can Read/Grep the spill
// file to recover any part — the trim is lossless on disk, cheap in context.
//
// Does the job of an intercepting-proxy + vector-store compression layer in
// ~100 lines with zero infrastructure. Set CMO_TRIM_CHARS=0 to disable.

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
  const rel = path.relative(cwd, spillPath) || spillPath;

  // Pass 1: repeated-line dedup. Logs and test spam compress dramatically
  // under exact-line dedup with counts, and unlike head+tail excerpting it
  // loses no distinct line. If dedup alone gets under the limit, keep the
  // whole deduplicated payload.
  const deduped = dedupLines(s);
  if (deduped && deduped.length <= limit) {
    const saved = lib.estTokens(s) - lib.estTokens(deduped);
    return (
      deduped +
      `\n\n${MARKER}: ${s.length} chars deduplicated to ${deduped.length} (~${saved} tokens saved); ` +
      `repeated lines are annotated with [xN]. Exact original preserved at ${rel}.]`
    );
  }

  // Pass 2: head + tail excerpt (over the deduped text when that helps).
  const base = deduped && deduped.length < s.length * 0.7 ? deduped : s;
  const headLen = Math.floor(limit * 0.6);
  const tailLen = Math.floor(limit * 0.15);
  const saved = lib.estTokens(s) - lib.estTokens(base.slice(0, headLen) + base.slice(-tailLen));
  return (
    base.slice(0, headLen) +
    `\n\n${MARKER}: ${s.length} chars total, middle omitted (~${saved} tokens saved). ` +
    `Full output preserved at ${rel} — Read with offset/limit or Grep it if the omitted portion matters.]\n\n` +
    base.slice(-tailLen)
  );
}

/**
 * Exact-line dedup preserving first-occurrence order, annotating lines seen
 * >= 2 times with a count. Returns null when there isn't enough repetition
 * to be worth the reordering (< 25% shrink) or the payload isn't line-shaped.
 */
function dedupLines(s) {
  const lines = s.split('\n');
  if (lines.length < 100) return null;
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  if (counts.size > lines.length * 0.75) return null; // mostly unique — dedup won't pay
  const out = [];
  for (const [l, c] of counts) out.push(c >= 2 ? `${l}  [x${c}]` : l);
  const joined = out.join('\n');
  return joined.length <= s.length * 0.75 ? joined : null;
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
