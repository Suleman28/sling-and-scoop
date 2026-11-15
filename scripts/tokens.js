// Tallies the tokens AI agents have spent on this repo and rewrites the table in README.md.
// Reads the local session logs of Claude Code (~/.claude) and Antigravity (~/.gemini). Run: npm run tokens
// Totals are saved to tokens.json and never go down, so logs the tools later delete don't erase history.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS = ['sling-and-scoop', 'dispatch-game', 'rotor-relay']; // current and earlier names of this project
const HOME = homedir(), SAVE = 'tokens.json', FIELDS = ['calls', 'input', 'cacheWrite', 'cacheRead', 'output'];
const walk = (d) => !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const bucket = (t, k) => t[k] ??= Object.fromEntries(FIELDS.map((f) => [f, 0]));

const found = {};
// Claude Code: one assistant message is logged several times, so count each message id once
const cc = join(HOME, '.claude/projects'), seen = new Set();
for (const dir of existsSync(cc) ? readdirSync(cc).filter((d) => KEYS.some((k) => d.includes(k))) : [])
  for (const f of walk(join(cc, dir)).filter((p) => p.endsWith('.jsonl')))
    for (const { message: m } of lines(f)) {
      if (!m?.usage || m.role !== 'assistant' || seen.has(m.id) || !m.model || m.model === '<synthetic>') continue;
      seen.add(m.id);
      const b = bucket(found, m.model), u = m.usage;
      b.calls++; b.input += u.input_tokens || 0; b.cacheWrite += u.cache_creation_input_tokens || 0;
      b.cacheRead += u.cache_read_input_tokens || 0; b.output += u.output_tokens || 0;
    }
// Antigravity: no model name or cache-write count in its logs, so all Gemini models share one row
const ag = join(HOME, '.gemini/antigravity/brain');
for (const id of existsSync(ag) ? readdirSync(ag) : []) {
  const f = join(ag, id, '.system_generated/logs/transcript_full.jsonl');
  if (!existsSync(f) || !KEYS.some((k) => readFileSync(f, 'utf8').includes(k))) continue;
  for (const d of lines(f)) {
    if (d.input_tokens === undefined) continue;
    const b = bucket(found, 'Gemini (Antigravity, all models)');
    b.calls++; b.input += d.input_tokens; b.cacheRead += d.cache_read_tokens || 0; b.output += d.output_tokens || 0;
  }
}

const saved = existsSync(SAVE) ? JSON.parse(readFileSync(SAVE, 'utf8')) : {};
for (const [k, v] of Object.entries(found)) { const b = bucket(saved, k); for (const f of FIELDS) b[f] = Math.max(b[f], v[f]); }
writeFileSync(SAVE, JSON.stringify(saved, null, 2) + '\n');

const n = (x) => x.toLocaleString('en-US'), tot = Object.fromEntries(FIELDS.map((f) => [f, 0]));
const rows = Object.entries(saved).sort((a, b) => b[1].output - a[1].output).map(([k, v]) => {
  for (const f of FIELDS) tot[f] += v[f];
  return `| ${k} | ${n(v.calls)} | ${n(v.input)} | ${n(v.cacheWrite)} | ${n(v.cacheRead)} | ${n(v.output)} |`;
});
const table = ['<!-- tokens:start -->', '| Model | Calls | Input | Cache write | Cache read | Output |', '|---|--:|--:|--:|--:|--:|', ...rows,
  `| **Total** | ${n(tot.calls)} | ${n(tot.input)} | ${n(tot.cacheWrite)} | ${n(tot.cacheRead)} | **${n(tot.output)}** |`,
  '', `_Updated ${new Date().toISOString().slice(0, 10)} by \`npm run tokens\`. Cache read is the same context re-read each call, so it dominates; output is what the models wrote._`, '<!-- tokens:end -->'].join('\n');
const readme = readFileSync('README.md', 'utf8');
if (!readme.includes('<!-- tokens:start -->')) throw new Error('README.md has no tokens markers');
writeFileSync('README.md', readme.replace(/<!-- tokens:start -->[\s\S]*<!-- tokens:end -->/, () => table));
console.log(table);
