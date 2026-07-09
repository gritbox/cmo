'use strict';
// PostToolUse hook: reversible trimming of oversized tool outputs.
//
// If a tool result exceeds CMO_TRIM_CHARS (default 30000 chars ≈ 7.5k tokens),
// the full payload is spilled to .cmo/spill/<sha12>.txt and the
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
  const input = lib.readHookInput();
  const cwd = input.cwd || process.cwd();

  // Read-time heat for the pulled tiers: a model Read/Grep of a spill or
  // journal file is direct evidence the buried content mattered. Recorded
  // here because this hook already fires on exactly those tools.
  recordMemoryAccess(input, cwd);

  const limit = process.env.CMO_TRIM_CHARS === undefined
    ? 30000
    : parseInt(process.env.CMO_TRIM_CHARS, 10) || 0;
  if (!limit) process.exit(0);

  const resp = input.tool_response !== undefined ? input.tool_response : input.tool_output;
  if (resp === undefined || resp === null) process.exit(0);

  // Depth-limited walk over the whole response: oversized strings live at
  // different depths per tool (Bash: top-level stdout/stderr; Read:
  // tool_response.file.content; MCP-style: [{type:"text",text}] blocks), so
  // no shallow scan or schema assumption covers them all. Returns null when
  // nothing was trimmed.
  const updated = trimDeep(resp, limit, cwd, 0);

  if (updated === null) process.exit(0);
  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: updated,
    },
  });
});

/**
 * Recursively trim any oversized string inside a tool response, preserving
 * the surrounding structure. Returns the replacement value, or null if the
 * subtree is unchanged. Depth-capped so a pathological payload can't recurse
 * away the hook's time budget.
 */
function trimDeep(node, limit, cwd, depth) {
  if (node === null || node === undefined || depth > 4) return null;
  if (typeof node === 'string') return trimPayload(node, limit, cwd);
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((v) => {
      const t = trimDeep(v, limit, cwd, depth + 1);
      if (t === null) return v;
      changed = true;
      return t;
    });
    return changed ? out : null;
  }
  if (typeof node === 'object') {
    let changed = false;
    const out = { ...node };
    for (const [k, v] of Object.entries(out)) {
      const t = trimDeep(v, limit, cwd, depth + 1);
      if (t !== null) {
        out[k] = t;
        changed = true;
      }
    }
    return changed ? out : null;
  }
  return null;
}

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

/** Record heat when the model Reads/Greps inside .cmo/ (spill, journal…). */
function recordMemoryAccess(input, cwd) {
  try {
    if (input.tool_name !== 'Read' && input.tool_name !== 'Grep') return;
    const target =
      input.tool_input && (input.tool_input.file_path || input.tool_input.path);
    if (typeof target !== 'string' || !target) return;
    const memRoot = path.resolve(cwd, '.cmo');
    if (!fs.existsSync(memRoot)) return;
    const abs = path.resolve(cwd, target);
    const rel = path.relative(memRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (rel === 'heat.json') return; // looking at the ledger is not a memory hit
    lib.recordHeat(cwd, [`file:${rel.split(path.sep).join('/')}`]);
  } catch {
    /* heat is best-effort */
  }
}

/**
 * Deterministic guardrail on our own files only: cap the spill dir size.
 * Eviction is cold-aware, not purely positional (RETENTION.md): spills the
 * model actually came back to Read/Grep (heat `file:spill/<name>`) are
 * skipped while anything unaccessed remains, and pruned only under a 2×
 * hard cap. Every pruned file leaves one line in spill/tombstones.md, so a
 * journal or handoff reference to it never dangles unexplained.
 */
function pruneSpill(dir) {
  try {
    const cwd = path.resolve(dir, '..', '..');
    const heat = lib.loadHeat(cwd);
    const accessed = new Set(
      Object.keys(heat.hits)
        .filter((k) => k.startsWith('file:spill/'))
        .map((k) => k.slice('file:spill/'.length))
    );
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const p = path.join(dir, f);
        return { f, p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size };
      })
      .sort((a, b) => a.mtime - b.mtime);

    let excess = files.length - SPILL_MAX_FILES;
    if (excess <= 0) return;
    const victims = [];
    for (const f of files) {
      if (victims.length >= excess) break;
      if (!accessed.has(f.f)) victims.push(f);
    }
    // Hard cap: if protecting accessed spills would let the dir grow without
    // bound, evict oldest regardless past 2× the soft cap.
    if (files.length - victims.length > SPILL_MAX_FILES * 2) {
      for (const f of files) {
        if (files.length - victims.length <= SPILL_MAX_FILES * 2) break;
        if (!victims.includes(f)) victims.push(f);
      }
    }

    const stones = [];
    for (const f of victims) {
      const firstLine = lib.oneLine(lib.readIfExists(f.p, 4096).split('\n')[0] || '', 60);
      fs.unlinkSync(f.p);
      stones.push(
        `- ${f.f} pruned ${new Date().toISOString().slice(0, 10)} (${f.size} bytes, began: "${firstLine}")`
      );
    }
    if (stones.length) {
      const tomb = path.join(dir, 'tombstones.md');
      const existing = lib.readIfExists(tomb).split('\n').filter(Boolean);
      const kept = existing.concat(stones).slice(-200);
      fs.writeFileSync(tomb, kept.join('\n') + '\n');
    }
  } catch {
    /* best effort */
  }
}
