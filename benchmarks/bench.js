'use strict';
// CMO benchmark harness.
//
// Part 1 measures the REAL hook scripts: it synthesizes a Claude Code
// transcript, pipes it through snapshot.js / session-start.js / trim.js
// exactly as the CLI would (stdin JSON contract), and reports measured
// injection sizes, trim savings, and wall-clock latency.
//
// Part 2 feeds those measurements into a cumulative context-cost model of a
// 100-session project and compares against claude-mem and MemPalace using
// THEIR published figures (see benchmarks/README.md for sources and the
// exact parameter table). Competitor numbers are claims, not measurements —
// which is precisely the distinction the "Strategic Blueprint" failed to make.
//
// Run: node benchmarks/bench.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const est = (s) => Math.ceil(s.length / 4);

// ---------------------------------------------------------------- Part 1

function makeTranscript(dir, turns = 40) {
  const lines = [];
  const user = (t) => lines.push(JSON.stringify({ message: { role: 'user', content: t } }));
  const tool = (name, input) =>
    lines.push(
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } })
    );
  user('Refactor the payment retry logic so failed webhooks back off exponentially');
  for (let i = 0; i < turns; i++) {
    tool('Read', { file_path: `/proj/src/module${i % 7}.ts` });
    tool('Bash', { command: `npm test -- --filter=retry-${i}` });
    if (i % 3 === 0) tool('Edit', { file_path: `/proj/src/module${i % 7}.ts` });
  }
  tool('TodoWrite', {
    todos: [
      { content: 'Add exponential backoff to webhook retries', status: 'completed' },
      { content: 'Cap retry attempts at 6 and dead-letter after', status: 'in_progress' },
      { content: 'Add integration test for dead-letter path', status: 'pending' },
    ],
  });
  user('Looks good — also make sure the dead-letter queue alerts on-call');
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function runHook(script, stdinObj, env = {}) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync('node', [path.join(SCRIPTS, script)], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* hook chose to emit nothing */
  }
  return { out, ms, code: res.status };
}

function part1() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cmo-bench-'));
  const transcript = makeTranscript(proj);
  const base = { session_id: 'bench-session-0001', transcript_path: transcript, cwd: proj };

  const snap = runHook('snapshot.js', { ...base, hook_event_name: 'SessionEnd', reason: 'exit' });
  const handoff = fs.readFileSync(path.join(proj, '.claude', 'memory', 'handoff.md'), 'utf8');

  // Simulate curated memory accumulating over time, then measure injection.
  fs.writeFileSync(
    path.join(proj, '.claude', 'memory', 'decisions.md'),
    '# Decisions\n' + Array.from({ length: 12 }, (_, i) => `- Decision ${i}: use approach ${i} for subsystem ${i}`).join('\n') + '\n'
  );
  const start = runHook('session-start.js', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  const injected = start.out ? start.out.hookSpecificOutput.additionalContext : '';

  const bigOut = Array.from({ length: 3000 }, (_, i) => `2026-07-06T12:00:${String(i % 60).padStart(2, '0')} INFO worker=${i % 8} processed batch ${i} in ${40 + (i % 25)}ms`).join('\n');
  const trim = runHook('trim.js', {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { stdout: bigOut, stderr: '' },
  });
  const trimmed = trim.out ? trim.out.hookSpecificOutput.updatedToolOutput.stdout : bigOut;

  return {
    proj,
    startupTokens: est(injected),
    handoffTokens: est(handoff),
    trimBefore: est(bigOut),
    trimAfter: est(trimmed),
    latencies: { snapshot: snap.ms, sessionStart: start.ms, trim: trim.ms },
  };
}

// ---------------------------------------------------------------- Part 2

function part2(m) {
  // Shared workload: S sessions, T turns/session. Every architecture pays the
  // same conversation-history term, so we compare only what each one ADDS:
  // startup payload, retrieval calls, and background/maintenance API tokens.
  const S = 100;
  const T = 40;
  const rawToolOutTokens = 1500; // avg raw tool payload per turn (drives trim + claude-mem worker)

  // toolSchemas: MCP tool definitions (or skill descriptions) resident in
  // context on every turn — IF the client loads MCP schemas eagerly. Newer
  // Claude Code versions can defer MCP tool schemas and load them on demand,
  // which removes most of this term; the sensitivity table below shows both.
  // MEASURED from the shipped packages (see benchmarks/README.md for the
  // exact serialization method):
  //  - claude-mem@13.10.2: its MCP server's live tools/list response is 19
  //    tools, 11,064 chars ≈ 2,766 tokens; plus 17 bundled skills whose
  //    model-invocable frontmatter descriptions total 4,141 chars ≈ 1,035
  //    tokens (skill descriptions are resident regardless of MCP deferral).
  //  - mempalace 3.5.0 wheel: TOOLS registry defines 35 tools; compact
  //    JSON.stringify of {name, description, input_schema} totals 18,499
  //    chars ≈ 4,624 tokens.
  //
  // MemPalace startup: its own shipped layers.py says "Wake-up cost:
  // ~600-900 tokens (L0+L1)" — 750 is the midpoint. The widely-quoted
  // 170-token figure is from a third-party writeup and appears nowhere in
  // the package; the sensitivity table carries it as the favorable variant.
  const frameworks = {
    'claude-mem (measured pkg + published claims)': {
      startup: 1500,            // injected index: summaries + observation titles (claim-based; grows with history)
      toolSchemas: 2766 + 1035, // MEASURED: tools/list + skill descriptions
      residentWhenDeferred: 1035, // skill descriptions stay resident either way
      retrievalPerUse: 750,     // 3-layer MCP flow, mid-range of 500–1000/result
      retrievalRate: 0.1,
      // Every tool call's raw output is shipped to a background Agent SDK
      // call for compression — background input tokens ≈ raw payload. The
      // per-call mechanism is verified in the package; the VOLUME is an
      // assumption (every turn, full payload), not a measurement.
      backgroundPerTurn: rawToolOutTokens,
    },
    'MemPalace (measured pkg + own published claims)': {
      startup: 750,      // their layers.py: "~600-900 tokens (L0+L1)", midpoint
      startupLow: 170,   // third-party writeup figure (not in the package) — sensitivity only
      toolSchemas: 4624, // MEASURED: 35 tools in the v3.5.0 TOOLS registry, compact JSON
      residentWhenDeferred: 0,
      retrievalPerUse: 900,
      retrievalRate: 0.2,
      backgroundPerTurn: 0,
    },
    'CMO (measured by this harness)': {
      startup: m.startupTokens, // hard-capped at CMO_BUDGET_TOKENS (800)
      // MEASURED the same way as the competitors' skills: the two skill
      // frontmatter descriptions total 709 chars ≈ 177 tokens. (An earlier
      // revision claimed 80 — holding ourselves to the standard we apply
      // to others, this is the measured number.) No MCP server.
      toolSchemas: 177,
      residentWhenDeferred: 177,
      retrievalPerUse: 200,     // one ranked search over .claude/memory/ when needed
      retrievalRate: 0.15,
      // jit-recall pointers: capped at ~100 tok, fired on a minority of
      // prompts — charged here so CMO's own hook cost isn't hidden.
      jitPerUse: 60,
      jitRate: 0.1,
      backgroundPerTurn: 0,
    },
  };

  const cost = (f, { deferred = false, startupOverride = null } = {}) => {
    const startup = startupOverride != null ? startupOverride : f.startup;
    const schemas = deferred ? f.residentWhenDeferred : f.toolSchemas;
    // Startup payload and resident schemas are re-sent in every turn of the
    // session (they are context).
    const startupCost = S * T * (startup + schemas);
    // A retrieval in turn t stays in context for the rest of the session
    // (T - t turns on average ≈ T/2).
    const retrievalCost = Math.round(S * T * f.retrievalRate * f.retrievalPerUse * (T / 2) / T);
    const jitCost = f.jitPerUse ? Math.round(S * T * f.jitRate * f.jitPerUse * (T / 2) / T) : 0;
    const background = S * T * f.backgroundPerTurn;
    return {
      resident: startup + schemas,
      contextAdded: startupCost + retrievalCost + jitCost,
      background,
      total: startupCost + retrievalCost + jitCost + background,
    };
  };

  const rows = [];
  for (const [name, f] of Object.entries(frameworks)) {
    rows.push({ name, f, ...cost(f) });
  }
  return { S, T, rows, cost, frameworks };
}

// ---------------------------------------------------------------- Report

const m = part1();
const model = part2(m);

console.log('## Part 1 — measured (real hooks, synthetic 40-turn transcript)\n');
console.log(`SessionStart injection:     ${m.startupTokens} tokens (budget cap: ${process.env.CMO_BUDGET_TOKENS || 800})`);
console.log(`Handoff snapshot size:      ${m.handoffTokens} tokens`);
console.log(`Trim (180k-char log):       ${m.trimBefore} -> ${m.trimAfter} tokens (${Math.round((1 - m.trimAfter / m.trimBefore) * 100)}% saved, lossless on disk)`);
console.log(`Hook latency:               snapshot ${m.latencies.snapshot.toFixed(0)}ms · session-start ${m.latencies.sessionStart.toFixed(0)}ms · trim ${m.latencies.trim.toFixed(0)}ms (no LLM, no network)\n`);

console.log(`## Part 2 — memory-system overhead model (${model.S} sessions x ${model.T} turns)\n`);
console.log('Conversation-history cost is identical across systems and excluded;');
console.log('this table is ONLY what each memory system adds on top. Tokens are');
console.log('counted at face value: no prompt-caching discount (cached re-sends are');
console.log('~10x cheaper in $, which shrinks every context column but not');
console.log("claude-mem's background column), and background tokens may be billed");
console.log('at a different model rate — the "total" column adds unlike quantities');
console.log('and should be read as a volume indicator, not a bill.\n');
console.log('| System | Resident tokens/session (startup + tool schemas) | Context tokens added (lifetime) | Background API tokens (lifetime) | Total overhead |');
console.log('|---|---|---|---|---|');
for (const r of model.rows) {
  console.log(`| ${r.name} | ${r.resident} | ${r.contextAdded.toLocaleString()} | ${r.background.toLocaleString()} | ${r.total.toLocaleString()} |`);
}
const [cm, mp, cmo] = model.rows;
console.log(`\nCMO total overhead vs claude-mem: ${(100 * (1 - cmo.total / cm.total)).toFixed(1)}% lower.`);
console.log(`CMO total overhead vs MemPalace:  ${(100 * (1 - cmo.total / mp.total)).toFixed(1)}% lower.`);

// ------------------------------------------------- sensitivity analysis
// The headline above hinges on two contestable assumptions. Vary both:
//  - MCP schema residency: eager (schemas in context every turn) vs
//    deferred (newer Claude Code loads MCP tool schemas on demand;
//    claude-mem's 17 skill descriptions stay resident either way).
//  - MemPalace startup: 750 (their own layers.py) vs 170 (third-party).
console.log('\n### Sensitivity — the same model under different assumptions\n');
console.log('| Assumption | claude-mem | MemPalace | CMO | CMO vs MemPalace |');
console.log('|---|---|---|---|---|');
const scenarios = [
  ['MCP schemas resident, MemPalace startup 750 (their layers.py)', {}, {}],
  ['MCP schemas resident, MemPalace startup 170 (third-party figure)', {}, { startupOverride: 170 }],
  ['MCP schemas deferred, MemPalace startup 750', { deferred: true }, { deferred: true }],
  ['MCP schemas deferred, MemPalace startup 170', { deferred: true }, { deferred: true, startupOverride: 170 }],
];
for (const [label, cmOpts, mpOpts] of scenarios) {
  const a = model.cost(model.frameworks[cm.name], cmOpts).total;
  const b = model.cost(model.frameworks[mp.name], mpOpts).total;
  const c = model.cost(model.frameworks[cmo.name], cmOpts).total;
  const delta = c <= b ? `${(100 * (1 - c / b)).toFixed(1)}% lower` : `${(100 * (c / b - 1)).toFixed(1)}% HIGHER`;
  console.log(`| ${label} | ${a.toLocaleString()} | ${b.toLocaleString()} | ${c.toLocaleString()} | ${delta} |`);
}
console.log('\nRead: the claude-mem comparison is robust across all four scenarios');
console.log('(its background compression spend and resident skill descriptions do');
console.log('not depend on schema residency). The MemPalace comparison is NOT:');
console.log('with deferred schemas and the favorable third-party startup figure,');
console.log('MemPalace models out cheaper than CMO. The honest summary is a range,');
console.log('not a single percentage — see README.');
console.log('\nCompetitor parameters are their published claims where not measured');
console.log('(sources in benchmarks/README.md); CMO numbers are produced by');
console.log('executing the actual hook scripts above.');
console.log(`\n(scratch project: ${m.proj})`);
