'use strict';
// Ranked memory search for /cmo:recall (and anything else that wants it).
//
//   node search.js [--cwd <project>] [--top N] <query terms...>
//
// Searches every Markdown file under .cmo/ (and spill/*.txt) line
// by line, expanding the query deterministically the same way jit-recall.js
// does: light stemming plus glossary aliases from .cmo/glossary.md.
// Lines are ranked by (distinct concept groups matched, then total variant
// hits) and the top N printed as `file:line: text`.
//
// Unlike the jit hook this is an on-demand tool, so it returns single-group
// matches too — the model asked, so weaker evidence is still worth listing —
// but multi-concept lines always rank first. Exit code 0 with no output means
// no match (absent memory is not evidence about what happened).

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function main() {
  const argv = process.argv.slice(2);
  let cwd = process.cwd();
  let top = 5;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--top') top = parseInt(argv[++i], 10) || 5;
    else rest.push(argv[i]);
  }
  const query = rest.join(' ').trim();
  if (!query) {
    process.stderr.write('usage: node search.js [--cwd dir] [--top N] <query>\n');
    process.exit(2);
  }

  const root = lib.memoryDir(cwd);
  if (!fs.existsSync(root)) process.exit(0);

  const terms = lib.extractTerms(query);
  if (!terms.length) process.exit(0);
  const groups = lib.termGroups(terms, query, lib.loadGlossary(cwd));

  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') || e.name.endsWith('.txt')) {
        const rel = path.relative(root, p);
        const lines = lib.readIfExists(p, 1024 * 1024).split('\n');
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t || t === '---') continue;
          const low = t.toLowerCase();
          const stems = lib.lineStemSet(low);
          let matched = 0;
          let variantHits = 0;
          let curatedHit = false;
          const matchedSources = [];
          for (const g of groups) {
            if (lib.groupMatchesLine(g, low, stems)) {
              matched++;
              if (g.curated) curatedHit = true;
              matchedSources.push(g.source);
              for (const v of g.variants) if (low.includes(v)) variantHits++;
            }
          }
          if (matched > 0) {
            // One incidental word out of a multi-concept query is listed but
            // labeled, so the model (and the quality gate) can discount it.
            const weak = matched === 1 && groups.length >= 2 && !curatedHit;
            hits.push({ rel, n: i + 1, t, matched, variantHits, weak, matchedSources });
          }
        }
      }
    }
  })(root);

  hits.sort((a, b) => b.matched - a.matched || b.variantHits - a.variantHits);
  for (const h of hits.slice(0, top)) {
    const tag = h.weak ? ` [weak: only "${h.matchedSources[0]}" matched]` : '';
    process.stdout.write(`${h.rel}:${h.n}: ${lib.oneLine(h.t, 200)}${tag}\n`);
  }
}

try {
  main();
} catch {
  process.exit(0); // recall helpers fail open, same as the hooks
}
