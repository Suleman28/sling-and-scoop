import assert from 'node:assert/strict';
import { BOAT, buildBoat, createBoat, stepBoat } from '../src/boat.js';

const m = buildBoat(), g = m.group.children[0].geometry, p = g.attributes.position.array;
assert.ok(p.length > 0 && p.every(Number.isFinite), 'boat geometry finite');
assert.ok(p.length / 9 < 30000, `tris ${p.length / 9}`);
m.spin(1 / 60, 1, createBoat(0, 0, 0));

const dt = 1 / 60, sea = { heightAt: () => -20 };
const run = (s, input, secs, env = sea, each = () => {}) => {
  let hit = 0;
  for (let i = 0; i < secs * 60; i++) { stepBoat(s, { fwd: 0, turn: 0, lift: 0, strafe: 0, ...input(i / 60) }, dt, env); hit = Math.max(hit, s.hit); each(s); }
  s.maxHit = hit;
  return s;
};

// Idle stays put (bobbing on the swell only).
const i = run(createBoat(10, 20, 0), () => ({}), 5);
assert.ok(Math.hypot(i.pos.x - 10, i.pos.z - 20) < 0.01 && i.grounded && Math.abs(i.pos.y) < 0.25, 'idle');

// Full ahead at yaw 0 heads to -z and tops out ~17 m/s (~33 kn); it gets over the hump (bow up) and levels onto the plane.
let minPitch = 0;
const s = run(createBoat(0, 0, 0), () => ({ fwd: 1 }), 30, sea, (b) => { minPitch = Math.min(minPitch, b.pitch); });
assert.ok(s.speed > 16 && s.speed < 18.5, `top speed ${s.speed.toFixed(1)}`);
assert.ok(s.pos.z < -300 && Math.abs(s.pos.x) < 1 && s.vel.z < -15, 'heads to -z');
assert.ok(minPitch < -0.05 && s.pitch > -0.07 && !s.grounded, `hump ${minPitch.toFixed(2)} -> ${s.pitch.toFixed(2)}`);
assert.ok(Math.abs(s.vel.length() - Math.abs(s.speed)) < 0.5, 'vel is true velocity');

// Turn left: yaw rises, banks into the turn (starboard up), scrubs speed, skids a little.
const v0 = s.speed, y0 = s.yaw; let skid = 0;
run(s, () => ({ fwd: 1, turn: 1 }), 3, sea, (b) => { skid = Math.max(skid, Math.abs(b.lat)); });
assert.ok(s.yaw - y0 > 1 && s.roll > 0.08 && s.speed < v0 - 0.5 && skid > 0.5, `turn ${(s.yaw - y0).toFixed(2)} roll ${s.roll.toFixed(2)} speed ${v0.toFixed(1)}->${s.speed.toFixed(1)} skid ${skid.toFixed(1)}`);

// Bow & stern thrusters: at rest, A/D pivots her on the spot and Q/E crabs her sideways without forward way.
const t0 = run(createBoat(0, 0, 0), () => ({ turn: 1 }), 2);
assert.ok(t0.yaw > 0.4 && Math.abs(t0.speed) < 0.05, `pivot at rest yaw ${t0.yaw.toFixed(2)}`);
const sw = run(createBoat(0, 0, 0), () => ({ strafe: 1 }), 2);
assert.ok(sw.pos.x > 4 && Math.abs(sw.pos.z) < 0.1 && sw.lat > 3.5, `side thrusters x ${sw.pos.x.toFixed(2)} lat ${sw.lat.toFixed(2)}`);

// Release the throttle: coasts down.
run(s, () => ({}), 1);
const c1 = s.speed; run(s, () => ({}), 20);
assert.ok(c1 < v0 && s.speed < 1, `coast ${c1.toFixed(1)} -> ${s.speed.toFixed(2)}`);

// Beach: -z runs up a slope reaching -0.6 at z = -124. Stops with a hit, stays off the land, and reverse backs it off.
const beach = { heightAt: (x, z) => -3 + (-z - 100) * 0.1 }, b = createBoat(0, 0, 0);
let onLand = false;
run(b, () => ({ fwd: 1 }), 20, beach, (q) => { if (beach.heightAt(q.pos.x, q.pos.z) > BOAT.shallow + 1e-9) onLand = true; });
assert.ok(b.maxHit > 5 && !onLand && b.pos.z > -125 && Math.abs(b.speed) < 3, `beach hit ${b.maxHit.toFixed(1)} at z ${b.pos.z.toFixed(1)}`);
const zb = b.pos.z;
run(b, () => ({ fwd: -1 }), 6, beach, () => { if (beach.heightAt(b.pos.x, b.pos.z) > BOAT.shallow + 1e-9) onLand = true; });
assert.ok(b.pos.z > zb + 3 && b.speed < -1 && !onLand, `reversed ${(b.pos.z - zb).toFixed(1)} m`);

// Wall collision (step function, e.g. harbour jetty): hitting a wall at an angle slides along it instead of pinning dead.
const wall = { heightAt: (x) => (x > 2 ? 1 : -5) }, wBoat = createBoat(0, 0, -Math.PI / 6);
run(wBoat, () => ({ fwd: 1 }), 5, wall);
assert.ok(wBoat.pos.x <= 2 && wBoat.pos.z < -20 && wBoat.speed > 8, `slides along wall: x ${wBoat.pos.x.toFixed(2)} z ${wBoat.pos.z.toFixed(1)} speed ${wBoat.speed.toFixed(1)}`);

// Dry tank: engine dead, coasts to a stop. A full tank lasts ~10 minutes flat out.
const f = createBoat(0, 0, 0), f0 = f.fuel;
run(f, () => ({ fwd: 1 }), 60);
assert.ok(Math.abs((f0 - f.fuel) * 10 - 1) < 0.15, `burn ${f0 - f.fuel}`);
f.fuel = 0;
run(f, () => ({ fwd: 1 }), 30);
assert.ok(f.speed < 0.5 && f.throttle < 0.01, 'dry tank coasts to a stop');

// Soft edge turns it back; wind drifts it; deterministic; no NaN with odd input.
const e = run(createBoat(1640, 0, Math.PI / 2 * -1 + Math.PI), () => ({ fwd: 1 }), 60);
assert.ok(Math.hypot(e.pos.x, e.pos.z) < 1700, 'soft edge');
const w = run(createBoat(0, 0, 0), () => ({}), 10, { ...sea, wind: { x: 5, z: 0 } });
assert.ok(w.pos.x > 0.5 && w.pos.x < 20, `wind drift ${w.pos.x.toFixed(1)}`);
const a = run(createBoat(0, 0, 0), (t) => ({ fwd: Math.sin(t), turn: Math.cos(t * 2) }), 20), c = run(createBoat(0, 0, 0), (t) => ({ fwd: Math.sin(t), turn: Math.cos(t * 2) }), 20);
assert.deepEqual([a.pos.x, a.pos.z, a.yaw], [c.pos.x, c.pos.z, c.yaw], 'deterministic');
const n = createBoat(0, 0, 0); stepBoat(n, {}, 0, sea); stepBoat(n, { fwd: NaN }, 1e9, sea);
assert.ok(Number.isFinite(n.pos.x + n.yaw + n.speed), 'finite');

// 7. Quartering astern + crosswind forward acceleration & shallow-contour wind lock regression:
// Previously, when idle in a wind with an astern component (u < 0, sg = -1) and crosswind (v != 0),
// pressing W caused the skid-scrub term (-sg * B.scrub * |v| * dt) to push un from negative to positive,
// triggering `if (u * un < 0 && thrust * sg <= 0) un = 0` every frame and locking the boat at u = -0.007 m/s!
{
  const windEnv = { heightAt: () => -20, wind: { x: 6, z: 6 } };
  const wb = createBoat(0, 0, 0);
  for (let i = 0; i < 60; i++) stepBoat(wb, { fwd: 0, turn: 0, strafe: 0 }, dt, windEnv);
  for (let i = 0; i < 180; i++) stepBoat(wb, { fwd: 1, turn: 0, strafe: 0 }, dt, windEnv);
  assert.ok(wb.speed > 8, `boat accelerates forward cleanly in astern+crosswind (speed=${wb.speed.toFixed(2)})`);

  const contourEnv = {
    heightAt: (x, z) => -1.1 + (x + z) * 0.2, // deeper toward (-x, -z), shallower toward (+x, +z)
    wind: { x: 8, z: 8 },
  };
  const sb2 = createBoat(0, 0, -Math.PI * 0.65); // angled along the shallow contour
  for (let i = 0; i < 60; i++) stepBoat(sb2, { fwd: 0, turn: 0, strafe: 0 }, dt, contourEnv);
  for (let i = 0; i < 180; i++) stepBoat(sb2, { fwd: 1, turn: 0, strafe: 0 }, dt, contourEnv);
  assert.ok(sb2.speed > 5, `boat escapes diagonal shallow contour under throttle (speed=${sb2.speed.toFixed(2)})`);
}

console.log('boat ok');
