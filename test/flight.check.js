import assert from 'node:assert/strict';
import { buildChopper, createFlight, stepFlight, TUNE } from '../src/chopper.js';
import { AIRFRAMES } from '../src/career.js';

// All chopper models build cleanly with finite geometry and spin without error.
for (const k of ['scout', 'utility', 'heavy']) {
  const m = buildChopper(AIRFRAMES[k]), p = m.group.children[0].geometry.attributes.position.array;
  assert.ok(p.length > 0 && p.every(Number.isFinite), `${k} geometry finite`);
  m.spin(1 / 60, 1, createFlight(0, 10, 0, 0));
}

const dt = 1 / 60, flat = { groundAt: () => 10 };
const idle = { fwd: 0, turn: 0, lift: 0, strafe: 0 };
const run = (s, input, secs, env = flat) => { let hit = 0; for (let i = 0; i < secs * 60; i++) { stepFlight(s, { ...idle, ...input }, dt, env); hit = Math.max(hit, s.hit); } s.maxHit = hit; return s; };

// Idle on the ground stays put.
let s = run(createFlight(0, 10, 0, 0), {}, 2);
assert.ok(s.grounded && s.pos.length() < 10.01);

// Climb, then full forward: top speed lands near the tuned ~50 m/s and nothing goes NaN.
s = run(createFlight(0, 10, 0, 0), { lift: 1 }, 3);
assert.ok(s.pos.y > 40);
run(s, { fwd: 1 }, 30);
const v = Math.hypot(s.vel.x, s.vel.z);
assert.ok(v > 45 && v < 55, `top speed ${v}`);
assert.ok(s.vel.z < -40, 'yaw 0 flies toward -z');

// Release stick: brakes to near-hover within 8 s.
run(s, {}, 8);
assert.ok(Math.hypot(s.vel.x, s.vel.z) < 3);

// Strafe right at yaw 0 slides toward +x.
run(s, { strafe: 1 }, 4);
assert.ok(s.vel.x > 10 && Math.abs(s.vel.z) < 2, `strafe ${s.vel.x}`);

// Diving into the ground at speed scrapes along it without penetrating; slow descent lands.
run(s, { fwd: 1, turn: 1, lift: -1 }, 20);
assert.ok(s.pos.y >= 10 && s.pos.y < 14 && Number.isFinite(s.pos.x));
run(s, { lift: -1 }, 8);
assert.ok(s.grounded && s.pos.y === 10);

// Wind drifts a hovering chopper downwind.
s = run(createFlight(0, 50, 0, 0), { lift: 0.01 }, 6, { groundAt: () => 0, wind: { x: 8, z: 0 } });
assert.ok(s.pos.x > 3, `wind drift ${s.pos.x}`);

// Flying into a cliff bounces back and reports the hit.
const cliff = { groundAt: (x, z) => (z < -100 ? 10 + (-100 - z) * 3 : 10) };
s = run(createFlight(0, 20, 0, 0), { fwd: 1 }, 9, cliff);
assert.ok(s.maxHit > 10 && s.pos.z > -110, `cliff hit ${s.maxHit} at z ${s.pos.z}`);

// Deterministic.
const a = run(createFlight(0, 10, 0, 0), { fwd: 1, turn: 1, lift: 1 }, 5), b = run(createFlight(0, 10, 0, 0), { fwd: 1, turn: 1, lift: 1 }, 5);
assert.deepEqual(a.pos.toArray(), b.pos.toArray());
console.log('flight ok');

// Reversing the tail into a rising slope lifts the craft: the tail probe never ends up below the ground.
{
  const heavy = AIRFRAMES.heavy.tune.probes, slope = { groundAt: (x, z) => 10 + Math.max(0, z - 5) * 3 };
  Object.assign(TUNE, { probes: heavy });
  const w = createFlight(0, 10, 0, 0);
  for (let i = 0; i < 600; i++) { stepFlight(w, { ...idle, fwd: -1 }, dt, slope); assert.ok(w.pos.y + heavy[0][1] >= slope.groundAt(0, w.pos.z + heavy[0][2]) - 0.11, 'tail above ground'); }
  assert.ok(w.pos.y > 10.5, `tail pushed craft up ${w.pos.y}`);
  Object.assign(TUNE, { probes: [] });
}
