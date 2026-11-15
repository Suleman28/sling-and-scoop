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

// Vortex ring state: a long vertical descent settles into its own downwash and sinks past the normal rate; pulling
// collective barely helps, flying forward clears it. A short drop (a landing) never gets there.
{
  const high = { groundAt: () => 0 };
  let w = run(createFlight(0, 400, 0, 0), { lift: -1 }, 1.5, high);
  assert.ok(w.vrs < 0.5 && w.vel.y > -TUNE.descend - 1, `short descent is clean ${w.vrs}`);
  run(w, { lift: -1 }, 4, high);
  assert.ok(w.vrs === 1 && w.vel.y < -15, `settling ${w.vel.y}`);
  run(w, { lift: 1 }, 1.5, high);
  assert.ok(w.vel.y < -5, `collective alone doesn't save it ${w.vel.y}`);
  run(w, { lift: 1, fwd: 1 }, 4, high);
  assert.ok(w.vrs === 0 && w.vel.y > 5, `flown out ${w.vel.y}`);
}
// Autorotation: gliding sinks slower than a dead hover, and a flare (collective) arrests it until the rotor energy is spent.
{
  const high = { groundAt: () => 0 }, dead = (v) => { const w = createFlight(0, 400, 0, 0); w.grounded = false; w.fuel = 0; w.vel.z = -v; return w; };
  const hover = run(dead(0), {}, 3, high), glide = run(dead(30), { fwd: 1 }, 3, high);
  assert.ok(hover.vel.y < -9 && glide.vel.y > hover.vel.y + 2, `hover ${hover.vel.y}, glide ${glide.vel.y}`);
  run(hover, { lift: 1 }, 1.5, high);
  assert.ok(hover.vel.y > -3 && hover.rotorE < 0.5, `flare ${hover.vel.y}`);
  run(hover, { lift: 1 }, 3, high);
  assert.ok(hover.rotorE === 0 && hover.vel.y < -8, `spent ${hover.vel.y}`);
}
// The rotor spools up from ground idle before it lifts; a light tank climbs faster; a hard touchdown springs back.
{
  const w = run(createFlight(0, 10, 0, 0), { lift: 1 }, 0.1);
  assert.ok(w.pos.y < 10.01 && w.rpm < 0.8, `still spooling ${w.pos.y}`);
  const full = run(createFlight(0, 10, 0, 0), { lift: 1 }, 4), light = createFlight(0, 10, 0, 0);
  light.fuel = 0.1;
  assert.ok(run(light, { lift: 1 }, 4).pos.y > full.pos.y + 1, 'light climbs faster');
  const drop = createFlight(0, 11, 0, 0); drop.grounded = false; drop.vel.y = -12;
  run(drop, {}, 0.5);
  assert.ok(drop.maxHit > 6 && drop.pos.y > 10.05, `bounced ${drop.pos.y}`);
  assert.ok(run(drop, {}, 4).grounded);
}
// Parked on a gentle slope the skids follow the ground (nose-down facing downhill); on a steep one it slides off.
{
  const hill = (k) => ({ groundAt: (x, z) => 10 + z * k }); // yaw 0 faces -z: downhill
  const w = run(createFlight(0, 10, 0, 0), {}, 2, hill(0.2));
  assert.ok(Math.abs(w.pitch - Math.atan(0.2)) < 0.02 && Math.abs(w.roll) < 0.01 && Math.abs(w.pos.z) < 0.5, `sits on the slope ${w.pitch}`);
  const side = run(createFlight(0, 10, 0, Math.PI / 2), {}, 2, hill(0.2)); // facing -x: downhill is to the right
  assert.ok(Math.abs(side.roll + Math.atan(0.2)) < 0.02, `rolled with the slope ${side.roll}`);
  const steep = run(createFlight(0, 10, 0, 0), {}, 3, hill(0.6));
  assert.ok(steep.pos.z < -3, `slid downhill ${steep.pos.z}`);
}
// Over a fire, low: lifted and buffeted.
{
  const calm = run(createFlight(0, 30, 0, 0), { lift: 0.001 }, 3, { groundAt: () => 0 }), hot = run(createFlight(0, 30, 0, 0), { lift: 0.001 }, 3, { groundAt: () => 0, burning: () => true });
  assert.ok(hot.buffet > 0 && hot.pos.y > calm.pos.y + 2 && Math.abs(hot.pos.x) > 0.05, `thermal ${hot.pos.y} vs ${calm.pos.y}`);
}
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
