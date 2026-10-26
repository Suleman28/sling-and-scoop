import assert from 'node:assert/strict';
import { cellCentre, cellOf, createFire, douse, fireStatus, ignite, resetFire, stepFire } from '../src/fire.js';

const forest = () => 1, still = { x: 0, z: 0 };
const run = (f, secs, wind = still) => { for (let i = 0; i < secs * 60; i++) stepFire(f, 1 / 60, wind); return f; };
const touched = (f) => [...f.fuel.keys()].filter((c) => f.fuel[c] < 1 || f.heat[c] > 0);

// Deterministic for a seed; grows from one cell.
const a = run(createFire(forest, 7), 0), b = createFire(forest, 7);
ignite(a, cellOf(0, 0)); ignite(b, cellOf(0, 0));
run(a, 90); run(b, 90);
assert.deepEqual(a.heat, b.heat);
assert.ok(a.burning.size > 3, `grew to ${a.burning.size}`);

// Wind pushes it downwind.
const w = createFire(forest, 3);
ignite(w, cellOf(0, 0));
run(w, 120, { x: 10, z: 0 });
const cx = touched(w).reduce((sum, c) => sum + cellCentre(c).x, 0) / touched(w).length;
assert.ok(cx > 15, `downwind centroid ${cx}`);

// Water puts burning cells out and keeps them wet.
for (const c of [...a.burning]) if (a.burning.has(c)) { const p = cellCentre(c); assert.ok(douse(a, p.x, p.z, 1)); }
assert.equal(a.burning.size, 0);
assert.ok(!ignite(a, cellOf(0, 0)), 'wet cell will not reignite');

// No fuel, no fire; a fire left alone burns out and scorches.
const rock = createFire(() => 0, 1);
assert.ok(!ignite(rock, cellOf(0, 0)));
const island = createFire((x, z) => (Math.hypot(x, z) < 60 ? 1 : 0), 5);
ignite(island, cellOf(0, 0));
run(island, 600);
assert.equal(island.burning.size, 0);
assert.ok(island.scorched.length > 0);
// Two fires keep their identities; reset clears everything.
const two = createFire(forest, 9);
ignite(two, cellOf(-600, 0), 1); ignite(two, cellOf(600, 0), 2);
run(two, 60);
const f1 = fireStatus(two, 1), f2 = fireStatus(two, 2);
assert.ok(f1.n > 0 && f2.n > 0 && f1.x < 0 && f2.x > 0);
resetFire(two, 9);
assert.ok(two.burning.size === 0 && two.fuel.every((v) => v === 1));
console.log('fire ok');
