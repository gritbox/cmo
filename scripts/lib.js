'use strict';
// Shared helpers for CMO hooks. No dependencies, Node >= 16.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Read and parse the hook payload Claude Code sends on stdin. */
function readHookInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** Rough token estimate (4 chars/token) — used only for budgeting, never billing. */
function estTokens(s) {
  return Math.ceil((s || '').length / 4);
}

/** Project-scoped memory root: plain Markdown, greppable, committable. */
function memoryDir(cwd) {
  return path.join(cwd || process.cwd(), '.claude', 'memory');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readIfExists(p, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return '';
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Parse a Claude Code transcript JSONL defensively. Unknown lines are skipped.
 * Returns { userTexts, toolUses, firstTimestamp } where toolUses = [{ name, input }]
 * and firstTimestamp is the earliest entry timestamp (ISO string) if present —
 * used to scope git-log capture to the session window.
 */
function parseTranscript(transcriptPath) {
  const out = { userTexts: [], toolUses: [], firstTimestamp: null };
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.firstTimestamp && entry && typeof entry.timestamp === 'string') {
      out.firstTimestamp = entry.timestamp;
    }
    const msg = entry && entry.message;
    if (!msg || !msg.role) continue;
    const content = msg.content;
    if (msg.role === 'user') {
      if (typeof content === 'string') {
        if (looksLikeHumanText(content)) out.userTexts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'text' && looksLikeHumanText(block.text)) {
            out.userTexts.push(block.text);
          }
        }
      }
    } else if (msg.role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name) {
          out.toolUses.push({ name: block.name, input: block.input || {} });
        }
      }
    }
  }
  return out;
}

/** Filter out harness-injected pseudo-user messages (system reminders, hook noise). */
function looksLikeHumanText(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith('<system-reminder>') || t.startsWith('<command-name>')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  return true;
}

/** Extract deterministic working state from a parsed transcript. */
function extractState(parsed, cwd) {
  const state = { intents: [], todos: [], filesEdited: [], commands: [] };

  const texts = parsed.userTexts.map((t) => oneLine(t, 220));
  if (texts.length) {
    state.intents.push(texts[0]);
    for (const t of texts.slice(-3)) {
      if (!state.intents.includes(t)) state.intents.push(t);
    }
  }

  const files = new Set();
  const commands = [];
  let lastTodos = null;
  for (const tu of parsed.toolUses) {
    if ((tu.name === 'Edit' || tu.name === 'Write' || tu.name === 'NotebookEdit') && tu.input.file_path) {
      files.add(relativize(tu.input.file_path, cwd));
    } else if (tu.name === 'Bash' && typeof tu.input.command === 'string') {
      commands.push(oneLine(tu.input.command, 100));
    } else if (tu.name === 'TodoWrite' && Array.isArray(tu.input.todos)) {
      lastTodos = tu.input.todos;
    }
  }
  state.filesEdited = [...files].slice(0, 30);
  state.commands = dedupeTail(commands, 8);
  if (lastTodos) {
    state.todos = lastTodos
      .filter((t) => t && t.content)
      .map((t) => `[${t.status || 'pending'}] ${oneLine(t.content, 120)}`);
  }
  return state;
}

function relativize(p, cwd) {
  if (cwd && p.startsWith(cwd + path.sep)) return p.slice(cwd.length + 1);
  return p;
}

function oneLine(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Keep the last `n` unique entries, preserving recency order. */
function dedupeTail(arr, n) {
  const seen = new Set();
  const out = [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
    if (!seen.has(arr[i])) {
      seen.add(arr[i]);
      out.unshift(arr[i]);
    }
  }
  return out;
}

function sha12(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** Emit hook JSON and exit successfully. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/** Hooks must never break a session: run fn, exit 0 silently on any failure. */
function failOpen(fn) {
  try {
    fn();
  } catch {
    /* deliberately silent */
  }
  process.exit(0);
}

module.exports = {
  readHookInput,
  estTokens,
  memoryDir,
  ensureDir,
  readIfExists,
  parseTranscript,
  extractState,
  oneLine,
  sha12,
  emit,
  failOpen,
};
