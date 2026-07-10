'use strict';
// Ranked memory search for /cmo:recall (and anything else that wants it).
//
//   node search.js [--cwd <project>] [--top N] <query terms...>
//
// Searches every Markdown file under .cmo/ (and spill/*.txt) line by line —
// plus the Trolly pipeline's journey/ docs when present (specs, blueprints,
// ADRs; journey/archive/ is excluded: it holds superseded doc versions,
// stale by design). Queries are expanded deterministically the same way
// jit-recall.js does: light stemming plus glossary aliases (see
// lib.glossarySources). Lines are ranked by (distinct concept groups
// matched, then total variant hits) and the top N printed as
// `file:line: text`. Journey hits take at most half the result slots while
// memory hits remain — journey docs are far larger than memory digests, so
// an unconstrained global top-N could bury the cross-session memory this
// tool exists to surface.
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

  const memRoot = lib.memoryDir(cwd);
  const journeyName = process.env.TROLLY_DIR_JOURNEY || 'journey';
  const journeyDir = path.join(cwd, journeyName);
  // Corpus roots: CMO's own memory, plus the Trolly journey docs when the
  // project runs that pipeline. `memory` marks the tier CMO governs — only
  // those hits record line heat (journey files are Trolly's to curate) and
  // only they are exempt from the crowd-out quota below.
  const roots = [];
  if (fs.existsSync(memRoot)) roots.push({ dir: memRoot, prefix: '', memory: true });
  if (fs.existsSync(journeyDir))
    roots.push({ dir: journeyDir, prefix: journeyName + '/', memory: false, skipDirs: new Set(['archive']) });
  if (!roots.length) process.exit(0);

  const terms = lib.extractTerms(query);
  if (!terms.length) process.exit(0);
  const groups = lib.termGroups(terms, query, lib.loadGlossary(cwd));

  const hits = [];
  for (const r of roots) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (r.skipDirs && r.skipDirs.has(e.name)) continue;
          walk(p);
        } else if (e.name.endsWith('.md') || e.name.endsWith('.txt')) {
          const rel = r.prefix + path.relative(r.dir, p).split(path.sep).join('/');
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
              hits.push({ rel, n: i + 1, t, matched, variantHits, weak, matchedSources, memory: r.memory });
            }
          }
        }
      }
    })(r.dir);
  }

  const byRank = (a, b) => b.matched - a.matched || b.variantHits - a.variantHits;
  hits.sort(byRank);
  // Crowd-out quota: journey hits fill at most half the slots while memory
  // hits remain, then backfill whatever is left. Re-sorted so display order
  // stays rank order.
  const maxJourney = Math.ceil(top / 2);
  const shown = [];
  const overflow = [];
  for (const h of hits) {
    if (shown.length >= top) break;
    if (!h.memory && shown.filter((s) => !s.memory).length >= maxJourney) overflow.push(h);
    else shown.push(h);
  }
  while (shown.length < top && overflow.length) shown.push(overflow.shift());
  shown.sort(byRank);
  for (const h of shown) {
    const tag = h.weak ? ` [weak: only "${h.matchedSources[0]}" matched]` : '';
    process.stdout.write(`${h.rel}:${h.n}: ${lib.oneLine(h.t, 200)}${tag}\n`);
  }

  // Read-time heat: every surfaced memory line (and the curated concepts
  // that surfaced it) is a hit. Heat protects spill files from pruning and
  // marks journal lines as promotion candidates — see RETENTION.md. Journey
  // hits record nothing: those files live under Trolly's lifecycle
  // (archive-on-edit, doctor), and CMO's protect/promote policies must not
  // reach into a tier it does not govern.
  const heatKeys = [];
  for (const h of shown) {
    if (h.memory) heatKeys.push(`${h.rel}:${lib.sha12(h.t)}`);
  }
  for (const g of groups) {
    if (g.curated && shown.some((h) => h.matchedSources.includes(g.source))) {
      heatKeys.push(`glossary:${g.source}`);
    }
  }
  lib.recordHeat(cwd, heatKeys);
}

try {
  main();
} catch {
  process.exit(0); // recall helpers fail open, same as the hooks
}
