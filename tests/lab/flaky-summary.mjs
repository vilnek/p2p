// Summarises the runs in a flaky.sh output folder: per test, how many runs it failed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const tally = new Map(); // key -> { suite, runs, fails, errors[] }
const add = (suite, name, ok, err) => {
  const k = `${suite} › ${name}`;
  const t = tally.get(k) ?? { runs: 0, fails: 0, errors: [] };
  t.runs++;
  if (!ok) {
    t.fails++;
    if (err) t.errors.push(String(err).split('\n').find((l) => l.trim()) ?? '');
  }
  tally.set(k, t);
};
const runs = { unit: 0, e2e: 0 };
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  let j;
  try {
    j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    continue;
  }
  if (f.startsWith('unit')) {
    runs.unit++;
    for (const file of j.testResults ?? []) for (const a of file.assertionResults ?? []) add('unit', `${file.name.split('/tests/')[1]} › ${a.fullName}`, a.status === 'passed', a.failureMessages?.[0]);
  } else {
    runs.e2e++;
    const walk = (s, path) => {
      for (const sp of s.specs ?? [])
        for (const t of sp.tests ?? [])
          for (const r of t.results ?? []) add('e2e', `${path}${sp.title}`, r.status === 'passed' || r.status === 'skipped', r.error?.message?.replace(/\x1b\[[0-9;]*m/g, ''));
      for (const c of s.suites ?? []) walk(c, s.file === c.file && c.title !== c.file ? `${path}${c.title} › ` : `${path}`);
    };
    for (const s of j.suites ?? []) walk(s, `${s.file ?? s.title} › `);
  }
}
const bad = [...tally].filter(([, t]) => t.fails);
console.log(`runs: unit ${runs.unit}, e2e ${runs.e2e}; tests seen: ${tally.size}; failed at least once: ${bad.length}`);
for (const [k, t] of bad.sort((a, b) => b[1].fails / b[1].runs - a[1].fails / a[1].runs))
  console.log(`${t.fails}/${t.runs} (${Math.round((100 * t.fails) / t.runs)}%)  ${k}\n      first error: ${t.errors[0]?.slice(0, 220) ?? ''}`);
