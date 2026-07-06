'use strict';
// UserPromptSubmit hook: deterministic just-in-time recall pointers.
//
// Query-driven memory has one structural failure mode: the model never thinks
// to look. This hook closes it without a vector database. On each user
// prompt it extracts distinctive terms, scans the journal (the only tier NOT
// already injected at session start), and — only when there is a strong
// match — injects a tiny pointer telling the model which memory lines look
// relevant. The model then decides whether to follow up with /cmo:recall.
//
// Noise discipline, in order:
//   - fires only for lines matching >=2 distinct prompt terms. Single-term
//     matching was tried and rejected: the quality benchmark showed it false-
//     firing on incidental word overlap, and an unsolicited pointer must be
//     near-zero-noise — a missed pointer costs nothing (the model can still
//     /cmo:recall), while a wrong one erodes trust in every future pointer
//   - at most 2 pointer lines, hard-capped by CMO_JIT_BUDGET_TOKENS (~100)
//   - never repeats a pointer within the same session
//   - silent on slash commands, short prompts, or when nothing matches
//
// Config: CMO_JIT=off disables; CMO_JIT_BUDGET_TOKENS (default 100).

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

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
    // short filler (2-3 chars) that would otherwise slip through
    'to of in on at is it we do be as an or if so no up my me us he go by am ok hi ' +
    'off has its per via due yet let put try end now too way new old bad big few own ' +
    'may but did had were they she him her its non'
  ).split(' ')
);

lib.failOpen(() => {
  if ((process.env.CMO_JIT || '').toLowerCase() === 'off') process.exit(0);

  const input = lib.readHookInput();
  const prompt = (input.prompt || '').trim();
  if (prompt.length < 16 || prompt.startsWith('/')) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const journalDir = path.join(lib.memoryDir(cwd), 'journal');
  if (!fs.existsSync(journalDir)) process.exit(0);

  const terms = extractTerms(prompt);
  if (!terms.length) process.exit(0);

  // Collect journal lines with their source file.
  const corpus = [];
  for (const f of fs.readdirSync(journalDir).filter((f) => f.endsWith('.md'))) {
    for (const line of lib.readIfExists(path.join(journalDir, f)).split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('###') && t !== '---') corpus.push({ file: `journal/${f}`, line: t, low: t.toLowerCase() });
    }
  }
  if (!corpus.length) process.exit(0);

  const scored = corpus
    .map((c) => ({ ...c, score: terms.filter((t) => c.low.includes(t)).length }))
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (!scored.length) process.exit(0);

  // Session-scoped dedup: never surface the same pointer twice.
  const stateFile = path.join(
    os.tmpdir(),
    'cmo-jit-' + String(input.session_id || 'nosession').replace(/[^a-zA-Z0-9-]/g, '_') + '.json'
  );
  let seen = [];
  try {
    seen = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* first pointer this session */
  }
  const fresh = scored.filter((c) => !seen.includes(lib.sha12(c.line)));
  if (!fresh.length) process.exit(0);
  try {
    fs.writeFileSync(stateFile, JSON.stringify(seen.concat(fresh.map((c) => lib.sha12(c.line)))));
  } catch {
    /* dedup is best-effort */
  }

  const budgetChars = (parseInt(process.env.CMO_JIT_BUDGET_TOKENS, 10) || 100) * 4;
  let msg =
    '[cmo recall hint] Project journal lines matching this prompt ' +
    '(Grep .claude/memory/journal/ for full context):\n' +
    fresh.map((c) => `- ${c.file}: ${lib.oneLine(c.line, 150)}`).join('\n');
  if (msg.length > budgetChars) msg = msg.slice(0, budgetChars);

  lib.emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: msg,
    },
  });
});

function extractTerms(prompt) {
  const words = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_.\-]{1,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 16);
}
