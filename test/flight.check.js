import assert from 'node:assert/strict';
import { createFlight, stepFlight } from '../src/chopper.js';

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
