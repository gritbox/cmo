'use strict';
// Shared helpers for CMO hooks. No dependencies, Node >= 16.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Read and parse the hook payload Claude Code sends on stdin. */
function readHookInput() {
  try {
    return JSON.parse(readStdin() || '{}');
  } catch {
    return {};
  }
}

/**
 * Read all of stdin synchronously. A plain fs.readFileSync(0) throws EAGAIN
 * on macOS when the pipe is non-blocking and momentarily empty mid-stream —
 * which happens precisely on payloads larger than the 64 KB pipe buffer,
 * i.e. exactly the oversized tool outputs trim.js exists to handle. (Found
 * because CI's macOS lane failed on every large-stdin test while the
 * fail-open wrapper hid the same silent no-op in production.) Retry EAGAIN
 * with a short sleep, bounded by a deadline so a hook can never hang a
 * session.
 */
function readStdin(deadlineMs = 10000) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const deadline = Date.now() + deadlineMs;
  while (true) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < deadline) {
        // ~5 ms synchronous sleep; the writer is mid-stream.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (e.code === 'EOF') break; // Windows closed-pipe convention
      break; // unknown error or deadline: fail open with what we have
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Rough token estimate (4 chars/token) — used only for budgeting, never billing. */
function estTokens(s) {
  return Math.ceil((s || '').length / 4);
}

/**
 * Project-scoped memory root: plain Markdown, greppable, committable.
 *
 * Lives at .cmo/ — deliberately NOT under .claude/. Claude Code hardcodes
 * everything under .claude/ as a sensitive path: model-initiated Write/Edit
 * there always requires manual approval (and is denied outright in
 * non-interactive runs), even when a PreToolUse hook answers "allow". Memory
 * the model is supposed to curate (/cmo:remember, glossary upkeep) must
 * therefore live outside .claude/. Existing .claude/memory/ trees from
 * earlier versions are migrated on first touch.
 */
function memoryDir(cwd) {
  const root = cwd || process.cwd();
  const dir = path.join(root, '.cmo');
  migrateLegacyMemory(root, dir);
  return dir;
}

/** One-time move of a pre-0.2 .claude/memory/ tree to .cmo/. Best-effort. */
function migrateLegacyMemory(root, dir) {
  try {
    const legacy = path.join(root, '.claude', 'memory');
    if (!fs.existsSync(dir) && fs.existsSync(legacy)) fs.renameSync(legacy, dir);
  } catch {
    /* concurrent hook won the race, or legacy tree is unmovable — ignore */
  }
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
  const out = {
    userTexts: [],
    toolUses: [],
    assistantTexts: [],
    toolResultTexts: [],
    firstTimestamp: null,
  };
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
          } else if (block && block.type === 'tool_result') {
            // Tool results carry the strings future keyword recall needs
            // verbatim (exact error messages, identifiers). Keep a bounded
            // tail; extractState distills error lines from it.
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
                      .map((b) => b.text)
                      .join('\n')
                  : '';
            if (text) {
              out.toolResultTexts.push(text.slice(0, 4000));
              if (out.toolResultTexts.length > 40) out.toolResultTexts.shift();
            }
          }
        }
      }
    } else if (msg.role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name) {
          out.toolUses.push({ name: block.name, input: block.input || {} });
        } else if (block && block.type === 'text' && block.text && block.text.trim()) {
          // Keep only the tail — used by jit-recall's vague-prompt fallback.
          out.assistantTexts.push(block.text);
          if (out.assistantTexts.length > 3) out.assistantTexts.shift();
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
  // Skill/command invocations appear as pseudo-user turns: a
  // <command-message> wrapper plus the expanded skill body ("Base directory
  // for this skill: …"). Neither is something the human typed.
  if (t.startsWith('<command-message>') || t.startsWith('<local-command-stdout>')) return false;
  if (t.startsWith('Base directory for this skill')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  return true;
}

// Lines worth keeping verbatim for future keyword recall: failures carry the
// most distinctive strings a later session will search for. Deliberately a
// word-boundary list, not a fuzzy match — a false "error" line in the journal
// is noise forever.
const ERROR_LINE = /\b(error|exception|fatal|failed|failure|traceback|panic|segfault|enoent|econnrefused|etimedout)\b/i;

/** Extract deterministic working state from a parsed transcript. */
function extractState(parsed, cwd) {
  const state = { intents: [], todos: [], filesEdited: [], commands: [], errors: [] };

  const errs = [];
  for (const text of parsed.toolResultTexts || []) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t && t.length <= 400 && ERROR_LINE.test(t)) errs.push(oneLine(t, 160));
    }
  }
  state.errors = dedupeTail(errs, 6);

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

// ------------------------------------------------------------ term expansion

// Short dev terms (api, ci, db, jwt…) are often the most distinctive words in
// a prompt, so terms of 2+ chars are kept and common short words are
// stopworded explicitly instead of length-filtered away.
const STOPWORDS = new Set(
  (
    'the and for with this that from have will what when where which should would could ' +
    'about into make need just like them then than some only also been does please want ' +
    'lets look looks take over after was after before more less very much many how why who your our are ' +
    'not all any one two out get got see say said use using used run running add adding ' +
    'fix fixing update updating change changing check checking create creating remove ' +
    'removing write writing read reading work working works file files code test tests ' +
    'testing project setup set still same other there here these those know think sure ' +
    'okay back improve improving better best good great right wrong issue issues problem ' +
    'problems error errors thing things stuff maybe actually really currently session claude ' +
    'something anything investigate investigating seems seeing looking behaving broken failing ' +
    // short filler (2-3 chars) that would otherwise slip through
    'to of in on at is it we do be as an or if so no up my me us he go by am ok hi ' +
    'off has its per via due yet let put try end now too way new old bad big few own ' +
    'may but did had were they she him her its non can'
  ).split(' ')
);

/** Distinctive lowercase terms of a prompt, stopworded, capped at 16. */
function extractTerms(text) {
  const words = (String(text).toLowerCase().match(/[a-z0-9][a-z0-9_.\-]{1,}/g) || [])
    // the token class keeps ._- for file names, but sentence punctuation
    // ("limiting." at end of clause) must not defeat stemming
    .map((w) => w.replace(/[._\-]+$/, ''))
    .filter((w) => w.length >= 2);
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 16);
}
//
// Deterministic recall expansion: light stemming plus an optional
// project-curated glossary (.cmo/glossary.md). No embeddings, no
// index build — the glossary is written at remember-time by the model (which
// knows the likely synonyms when it stores the fact) and consumed at
// recall-time by plain string matching.

/**
 * Conservative suffix stemmer. Maps morphological variants onto one key
 * ("retries"/"retrying"/"retried" -> "retri"-ish) without a dictionary.
 * Deliberately light: false merges are worse than missed merges here.
 */
function stem(word) {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('ies')) w = w.slice(0, -3) + 'y'; // retries -> retry
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/**
 * Parse `.cmo/glossary.md` lines of the form
 *   `- head: alias, alias, multi word alias`
 * into [{ head, aliases }]. Everything is lowercased. Malformed lines are
 * skipped — the glossary is user-editable Markdown, not a schema.
 */
function loadGlossary(cwd) {
  const entries = [];
  const raw = readIfExists(path.join(memoryDir(cwd), 'glossary.md'));
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]{2,60}):\s*(.+)$/);
    if (!m) continue;
    const head = m[1].trim().toLowerCase();
    const aliases = m[2]
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length >= 2)
      .slice(0, 8);
    if (head && aliases.length) entries.push({ head, aliases });
  }
  return entries;
}

/**
 * Build concept groups from prompt terms. Each group is one concept with all
 * its known surface forms:  { source, variants: [string...] }.
 *
 * - A glossary head or alias found in the text pulls in the head and all
 *   sibling aliases (they name the same concept, so they count as ONE group —
 *   expansion must never inflate a multi-term precision bar).
 * - Every remaining term becomes its own single-concept group.
 * Multi-word glossary phrases are matched against the full lowercased text,
 * not just the term list, so "fetch wrapper" is recognized as one concept.
 */
function termGroups(terms, fullText, glossary) {
  const low = ' ' + String(fullText || terms.join(' ')).toLowerCase() + ' ';
  const groups = [];
  const claimed = new Set(); // terms absorbed into a glossary group
  for (const g of glossary || []) {
    const surfaces = [g.head, ...g.aliases];
    // A multi-word surface counts as present if the exact phrase occurs, or
    // if every one of its words is among the terms (stem-equal) — so
    // "async tasks" recognizes "async task runner". A single word must
    // stem-match a term outright.
    const present = surfaces.some((s) =>
      s.includes(' ')
        ? low.includes(s) || s.split(/\s+/).every((w) => terms.some((t) => stem(t) === stem(w)))
        : terms.some((t) => stem(t) === stem(s))
    );
    if (!present) continue;
    for (const s of surfaces) {
      if (!s.includes(' ')) {
        for (const t of terms) if (stem(t) === stem(s)) claimed.add(t);
      } else {
        for (const w of s.split(/\s+/)) {
          for (const t of terms) if (stem(t) === stem(w)) claimed.add(t);
        }
      }
    }
    // curated: a deliberate, user-reviewable concept mapping — matching one
    // is stronger evidence than an incidental single-word overlap.
    groups.push({ source: g.head, variants: [...new Set(surfaces)], curated: true });
  }
  for (const t of terms) {
    if (!claimed.has(t)) groups.push({ source: t, variants: [t], curated: false });
  }
  return groups;
}

/**
 * Does `lineLow` (a lowercased line) contain any variant of the group?
 * Single alphanumeric words match on stem equality against the line's own
 * tokens (so "retries" finds "retry" but "api" does not match "rapid");
 * phrases and punctuated terms (paths, dotted names) match by substring.
 */
function groupMatchesLine(group, lineLow, lineStems) {
  for (const v of group.variants) {
    if (/^[a-z0-9]+$/.test(v) && !v.includes(' ')) {
      if (lineStems.has(stem(v))) return true;
    } else if (lineLow.includes(v)) {
      return true;
    }
  }
  return false;
}

/** Precompute the stemmed token set of a line for groupMatchesLine. */
function lineStemSet(lineLow) {
  const s = new Set();
  for (const w of lineLow.match(/[a-z0-9][a-z0-9_.\-]*/g) || []) {
    s.add(stem(w.replace(/[._\-]+$/, '')));
  }
  return s;
}

// ------------------------------------------------------------ heat tracking
//
// A deterministic read-time tally over the PULLED memory tiers (journal,
// spill, glossary): every time a retrieval path actually surfaces a memory
// line — search.js results, jit-recall pointers, model Reads/Greps of spill
// and journal files — the hit is recorded in .cmo/heat.json. The signal is
// asymmetric by design (see RETENTION.md): heat PROTECTS and PROMOTES
// (spill pruning skips accessed files; /cmo:recall promotes repeatedly-hit
// journal lines toward decisions.md); coldness alone never deletes anything.
// Injected tiers (decisions.md, index.md) are deliberately not tracked —
// they are never recalled *because they are already present*, so zero hits
// there means the injection is working, not that the content is cold.
//
// Counts decay by half at each month boundary, so heat is recent-weighted
// without ever wiping the ledger in one step. Disable with CMO_HEAT=off.

const HEAT_MAX_KEYS = 400;

function heatPath(cwd) {
  return path.join(memoryDir(cwd), 'heat.json');
}

/** Load the heat ledger, applying the monthly half-life decay lazily. */
function loadHeat(cwd) {
  let heat;
  try {
    heat = JSON.parse(readIfExists(heatPath(cwd)) || 'null');
  } catch {
    heat = null;
  }
  if (!heat || typeof heat.hits !== 'object') heat = { v: 1, decayed: month(), hits: {} };
  if (heat.decayed !== month()) {
    for (const [k, h] of Object.entries(heat.hits)) {
      h.n = Math.floor(h.n / 2);
      if (h.n < 1) delete heat.hits[k];
    }
    heat.decayed = month();
  }
  return heat;
}

/**
 * Record read-time hits. Keys by convention:
 *   `<relfile>:<sha12(line)>`  a specific memory line that was surfaced
 *   `file:<relpath>`           a whole-file access (spill/journal Read or Grep)
 *   `glossary:<head>`          a curated concept that produced a match
 * Best-effort and silent: heat must never break a retrieval path.
 */
function recordHeat(cwd, keys) {
  if ((process.env.CMO_HEAT || '').toLowerCase() === 'off') return;
  if (!keys || !keys.length) return;
  try {
    const dir = memoryDir(cwd);
    if (!fs.existsSync(dir)) return;
    const heat = loadHeat(cwd);
    const today = new Date().toISOString().slice(0, 10);
    for (const k of keys) {
      const h = heat.hits[k] || { n: 0, last: today };
      h.n += 1;
      h.last = today;
      heat.hits[k] = h;
    }
    // Bound the ledger: drop the coldest keys (fewest hits, oldest last).
    const entries = Object.entries(heat.hits);
    if (entries.length > HEAT_MAX_KEYS) {
      entries.sort((a, b) => a[1].n - b[1].n || (a[1].last < b[1].last ? -1 : 1));
      for (const [k] of entries.slice(0, entries.length - HEAT_MAX_KEYS)) delete heat.hits[k];
    }
    fs.writeFileSync(heatPath(cwd), JSON.stringify(heat));
  } catch {
    /* deliberately silent */
  }
}

function month() {
  return new Date().toISOString().slice(0, 7);
}

/** Emit hook JSON and exit successfully. */
function emit(obj) {
  writeStdoutSync(JSON.stringify(obj));
  process.exit(0);
}

/**
 * Write to stdout fully-synchronously before exiting. process.stdout.write +
 * process.exit truncates on macOS when a payload larger than the pipe buffer
 * only partially completes — the queued remainder is discarded at exit
 * (nodejs/node#6456 family). That silently corrupted every large hook
 * emission on macOS: exactly trim.js's updatedToolOutput, whose whole job is
 * large payloads. Same shape as readStdin: retry EAGAIN with a short sleep,
 * bounded so a hook can never hang a session.
 */
function writeStdoutSync(s, deadlineMs = 10000) {
  const buf = Buffer.from(s, 'utf8');
  let off = 0;
  const deadline = Date.now() + deadlineMs;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      break; // fail open with a partial write rather than hang
    }
  }
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
  stem,
  extractTerms,
  loadGlossary,
  termGroups,
  groupMatchesLine,
  lineStemSet,
  heatPath,
  loadHeat,
  recordHeat,
};
