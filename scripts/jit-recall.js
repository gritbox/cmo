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
// Recall breadth without embeddings, in order of application:
//   - light stemming ("retries" finds "retry")
//   - glossary expansion: .claude/memory/glossary.md maps a concept to its
//     aliases ("neonhttp: http client, fetch wrapper"); aliases are written
//     at remember-time by the model, which knows the synonyms when it stores
//     the fact. All surface forms of one concept count as ONE matched term,
//     so expansion never weakens the precision bar below.
//   - vague-prompt fallback: a bare affirmation ("sure, go ahead") carries no
//     terms of its own, so the terms are harvested from the assistant's last
//     message in the transcript — the thing being agreed to.
//
// Noise discipline, in order:
//   - fires only on match evidence worth 2: two distinct incidental terms,
//     or one curated glossary concept. Single incidental-term matching was
//     tried and rejected: the quality benchmark showed it false-firing on
//     word overlap, and an unsolicited pointer must be near-zero-noise — a
//     missed pointer costs nothing (the model can still /cmo:recall), while
//     a wrong one erodes trust in every future pointer
//   - at most 2 pointer lines, hard-capped by CMO_JIT_BUDGET_TOKENS (~100)
//   - never repeats a pointer within the same session
//   - silent on slash commands, short non-affirmation prompts, or no match
//
// Config: CMO_JIT=off disables; CMO_JIT_BUDGET_TOKENS (default 100).

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

// Bare agreement/continuation prompts: no information content of their own —
// the referent is the assistant's previous message. Kept strict on purpose;
// a prompt that carries its own terms should be matched on its own terms.
const AFFIRMATION = /^(?:(?:yes|yeah|yep|sure|ok|okay|sounds good|go ahead|do it|do that|please do|proceed|continue|go for it|lets do it|let's do it|yes please)[\s.,!…]*)+$/i;

lib.failOpen(() => {
  if ((process.env.CMO_JIT || '').toLowerCase() === 'off') process.exit(0);

  const input = lib.readHookInput();
  const prompt = (input.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const journalDir = path.join(lib.memoryDir(cwd), 'journal');
  if (!fs.existsSync(journalDir)) process.exit(0);

  // Source of terms: the prompt itself, or — for a bare affirmation — the
  // assistant message it is agreeing to.
  let termSource = prompt;
  if (AFFIRMATION.test(prompt)) {
    if (!input.transcript_path) process.exit(0);
    const parsed = lib.parseTranscript(input.transcript_path);
    const lastAssistant = parsed.assistantTexts[parsed.assistantTexts.length - 1] || '';
    if (!lastAssistant) process.exit(0);
    // The proposal being accepted is almost always at the end of the message.
    termSource = lastAssistant.slice(-600);
  } else if (prompt.length < 16) {
    process.exit(0);
  }

  const terms = lib.extractTerms(termSource);
  if (!terms.length) process.exit(0);
  const groups = lib.termGroups(terms, termSource, lib.loadGlossary(cwd));

  // Collect journal lines with their source file.
  const corpus = [];
  for (const f of fs.readdirSync(journalDir).filter((f) => f.endsWith('.md'))) {
    for (const line of lib.readIfExists(path.join(journalDir, f)).split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('###') && t !== '---') corpus.push({ file: `journal/${f}`, line: t, low: t.toLowerCase() });
    }
  }
  if (!corpus.length) process.exit(0);

  // A line needs evidence worth 2: two distinct incidental terms, or one
  // curated glossary concept (curation already supplies the precision that
  // the two-term bar otherwise enforces — and expansion still can't inflate
  // the score, since all surface forms of a concept are one group).
  const scored = corpus
    .map((c) => {
      const stems = lib.lineStemSet(c.low);
      let score = 0;
      for (const g of groups) if (lib.groupMatchesLine(g, c.low, stems)) score += g.curated ? 2 : 1;
      return { ...c, score };
    })
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
