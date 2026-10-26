import assert from 'node:assert/strict';
import { buildPlane, createPlane, drop, PLANE, stepPlane } from '../src/plane.js';

const m = buildPlane(), p = m.group.children[0].geometry.attributes.position.array;
assert.ok(p.length > 0 && p.every(Number.isFinite), 'plane geometry finite');
m.spin(1 / 60, 1);

const dt = 1 / 60, sea = { groundAt: () => 0, heightAt: () => -20 }, land = { groundAt: () => 6, heightAt: () => 6 };
const run = (s, input, secs, env = sea, each = () => {}) => {
  let hit = 0;
  for (let i = 0; i < secs * 60; i++) { stepPlane(s, { fwd: 0, turn: 0, lift: 0, strafe: 0, ...input(i / 60) }, dt, env); hit = Math.max(hit, s.hit); each(); }
  s.maxHit = hit;
  return s;
};

// Skimming just above the sea scoops too (no touchdown needed).
const k = createPlane(0, 2, 0, 0); k.onSurface = false; k.speed = 30; k.throttle = 0.6;
run(k, () => ({}), 1);
assert.ok(k.water > 1.5 && !k.onSurface, `skim-scooped ${k.water.toFixed(2)}`);

// Water takeoff: full throttle, the run-up scoops, then rotate (S) and it flies.
const s = createPlane(0, 0, 0, 0);
run(s, () => ({ lift: 1 }), 2);
run(s, () => ({}), 8);
assert.ok(s.onWater && s.speed > PLANE.scoopSpeed && s.water > 0, `scooped ${s.water.toFixed(2)} at ${s.speed.toFixed(0)} m/s`);
run(s, (t) => ({ fwd: t < 1.2 ? -1 : 0 }), 6);
assert.ok(!s.onSurface && s.pos.y > 15, `climbed to ${s.pos.y.toFixed(0)}`);

// Roll in with A, then pull with S: it turns left. Let go and it rolls back toward level.
const yaw0 = s.yaw;
run(s, (t) => ({ turn: t < 0.45 ? 1 : 0, fwd: t > 0.45 ? -0.6 : 0 }), 4);
assert.ok(s.yaw - yaw0 > 0.8, `turned ${(s.yaw - yaw0).toFixed(2)} rad`);
run(s, () => ({}), 5);
assert.ok(Math.abs(s.roll) < 0.2, `levelled to ${s.roll.toFixed(2)}`);

// Holding A keeps rolling (no bank limit), like a real plane.
const r0 = s.roll;
run(s, () => ({ turn: 1 }), 1.2);
assert.ok(Math.abs(s.roll - r0) > 1.5, 'free roll');
run(s, () => ({ turn: -1 }), 1.0);
run(s, () => ({}), 6);

// Drop empties the tank over about a second and a half.
s.water = PLANE.tank;
assert.ok(drop(s));
let poured = 0;
run(s, () => ({}), 2.5, sea, () => (poured += s.poured));
assert.ok(s.water === 0 && Math.abs(poured - PLANE.tank) < 1e-9);

// Throttle off and nose up: it stalls and sinks.
let minLift = 1, minVy = 0;
run(s, () => ({ lift: -1, fwd: -1 }), 10, sea, () => { minLift = Math.min(minLift, s.lift); minVy = Math.min(minVy, s.vel.y); });
assert.ok(minLift < 0.5 && minVy < -2, `stalls (lift ${minLift.toFixed(2)}, sink ${minVy.toFixed(1)})`);

// Diving into the sea nose-down is a hard hit.
const d = createPlane(0, 60, 0, 0); d.onSurface = d.onWater = false; d.speed = 40; d.throttle = 1;
run(d, () => ({ fwd: 1 }), 6);
assert.ok(d.maxHit > 10, `belly-flop hit ${d.maxHit.toFixed(1)}`);

// Runway: roll, rotate and climb from flat land; then throttle back, settle onto the ground and brake to a stop.
const r = createPlane(0, 6, 0, 0);
run(r, () => ({ lift: 1 }), 6, land);
assert.ok(r.onSurface && r.speed > PLANE.stall * 0.8 && r.water === 0, `rolled to ${r.speed.toFixed(0)} m/s, no scooping on land`);
run(r, (t) => ({ fwd: t < 1.5 ? -1 : 0 }), 6, land);
assert.ok(!r.onSurface && r.pos.y > 12, `airborne at ${r.pos.y.toFixed(0)} m`);
// Approach like a pilot: hold ~28 m/s and a gentle 1.5 m/s descent, then cut the throttle once down.
run(r, () => (r.onSurface ? { lift: -1 } : { lift: r.speed > 28 ? -1 : 1, fwd: Math.max(-1, Math.min(1, (r.vel.y + (r.pos.y - 6 > 10 ? 4 : 1)) * 0.4)) }), 60, land); // flare below 10 m
assert.ok(r.onSurface && r.grounded && r.maxHit < 1, `landed and stopped (hit ${r.maxHit.toFixed(1)}, speed ${r.speed.toFixed(1)})`);
console.log('plane ok');
