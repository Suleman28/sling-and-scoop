import assert from 'node:assert/strict';
import * as THREE from 'three';
import { act, buildBucketMesh, buildCrateMesh, buildHeavyMesh, buildHookMesh, buildPersonMesh, createCrate, createRig, massOf, RIG, stepCrate, stepRig, swapTool, winch } from '../src/tools.js';
import { createFlight, stepFlight } from '../src/chopper.js';

for (const fn of [buildBucketMesh, buildHookMesh, buildCrateMesh, () => buildHeavyMesh('container'), () => buildHeavyMesh('vehicle'), () => buildHeavyMesh('cabin'), () => buildPersonMesh(false), () => buildPersonMesh(true)]) {
  const g = fn(), p = g.children[0].geometry.attributes.position.array;
  assert.ok(p.length > 0 && p.every(Number.isFinite));
}

const dt = 1 / 60;
const heli = (y) => ({ pos: new THREE.Vector3(0, y, 0), vel: new THREE.Vector3() });
const land = { groundAt: () => 0, heightAt: () => 0 };
const sea = { groundAt: () => 0, heightAt: () => -10 };
// Anchor pinned in place (chopper velocity reset each step) unless move() says otherwise.
const run = (r, s, secs, env, move = () => s.vel.set(0, 0, 0), each = () => {}) => {
  for (let i = 0; i < secs * 60; i++) { move(i); s.pos.addScaledVector(s.vel, dt); stepRig(r, s, dt, env); each(i); }
};

// Pendulum: released 30 deg off vertical, rope never stretches, swing decays, no NaN.
{
  const s = heli(50), L = RIG.bucket.line, r = createRig(Math.sin(0.52) * L, 50.6 - Math.cos(0.52) * L, 0);
  let early = 0, late = 0;
  run(r, s, 20, land, () => s.vel.set(0, 0, 0), (i) => {
    const d = r.pos.distanceTo(new THREE.Vector3(0, 50.6, 0));
    assert.ok(d <= L + 1e-9 && Number.isFinite(d));
    if (i < 120) early = Math.max(early, Math.abs(r.pos.x));
    if (i > 1080) late = Math.max(late, Math.abs(r.pos.x));
  });
  assert.ok(early > 4 && late < early * 0.5, `swing ${early} -> ${late}`);
  const r2 = createRig(Math.sin(0.52) * L, 50.6 - Math.cos(0.52) * L, 0), s2 = heli(50);
  run(r2, s2, 20, land);
  assert.deepEqual(r.pos.toArray(), r2.pos.toArray(), 'deterministic');
}

// Bucket: dips and fills over the sea, carries steadily without spilling, dumps to empty.
{
  const s = heli(8), r = createRig(0, 0, 0);
  run(r, s, 3, sea);
  assert.equal(r.water, RIG.cap);
  s.pos.y = 40;
  run(r, s, 4, sea);
  assert.ok(r.water > 0.97, `steady hover kept ${r.water}`);
  assert.equal(act(r, []), 'dump');
  let poured = 0;
  run(r, s, 2, land, undefined, () => (poured += r.poured));
  assert.ok(r.water === 0 && poured > 0.95);
}

// Slosh: violent back-and-forth jerks spill water.
{
  const s = heli(40), r = createRig(0, 31, 0);
  r.water = 1;
  run(r, s, 4, land, (i) => s.vel.set(Math.floor(i / 20) % 2 ? 18 : -18, 0, 0));
  assert.ok(r.water < 0.9, `jerky flight kept ${r.water}`);
}

// Slosh tuning in real flight: smooth flying keeps the water, one hard turn at cruise costs some but not all.
{
  const fly = (plan) => {
    const s = createFlight(0, 40, 0, 0), r = createRig(0, 31, 0), env = { groundAt: () => 0, heightAt: () => 0 };
    s.grounded = false; r.water = 1;
    for (let i = 0; i < 14 * 60; i++) { env.loadMass = r.taut ? massOf(r) : 0; stepFlight(s, { fwd: 0, turn: 0, lift: 0, strafe: 0, ...plan(i / 60) }, dt, env); stepRig(r, s, dt, env); }
    return 1 - r.water;
  };
  assert.ok(fly((t) => ({ fwd: t < 7 ? 1 : 0 })) < 0.05, 'throttle up and release spills');
  const turn = fly((t) => ({ fwd: 1, turn: t > 8 && t < 10 ? 1 : 0 }));
  assert.ok(turn > 0.03 && turn < 0.4, `hard turn spilled ${turn}`);
}

// Hook: grab a crate, lift it, release it, it falls and lands.
{
  const s = heli(10), r = createRig(0, 0, 0);
  assert.ok(swapTool(r) && r.tool === 'hook');
  const c = createCrate(0, 0, 0);
  run(r, s, 1, land);
  r.pos.copy(c.pos);
  assert.equal(act(r, [c]), 'hooked');
  s.pos.y = 30;
  run(r, s, 3, land);
  assert.ok(c.pos.y > 15, `crate lifted to ${c.pos.y}`);
  assert.ok(!swapTool(r), 'cannot swap while carrying');
  assert.equal(act(r, [c]), 'released');
  let hit = 0;
  for (let i = 0; i < 240; i++) { stepCrate(c, dt, land); hit = Math.max(hit, c.hit); }
  assert.ok(Math.abs(c.pos.y - RIG.crate.hang) < 1e-9 && hit > 10);
}
// Heavy cargo: too heavy for the airframe, it stays down and tethers the chopper; with enough lift it comes up.
{
  const lift = (maxLift) => {
    RIG.maxLift = maxLift;
    const s = heli(8), r = createRig(0, 0, 0), c = createCrate(0, 0, 0, RIG.container);
    swapTool(r);
    run(r, s, 1, land);
    r.pos.copy(c.pos);
    act(r, [c]);
    for (let i = 0; i < 4 * 60; i++) { s.vel.y = 8; s.pos.addScaledVector(s.vel, dt); stepRig(r, s, dt, land); } // full climb
    return { crateY: c.pos.y, heliY: s.pos.y, overloaded: r.overloaded };
  };
  const stuck = lift(1.2);
  assert.ok(stuck.overloaded && Math.abs(stuck.crateY - RIG.container.hang) < 1e-6, 'container stays on the ground');
  assert.ok(stuck.heliY < RIG.container.hang + RIG.hook.line + 0.01, `chopper tethered at ${stuck.heliY}`);
  const lifted = lift(2.6);
  assert.ok(!lifted.overloaded && lifted.crateY > 15, `heavy lifter raised it to ${lifted.crateY}`);
  RIG.maxLift = 1.2;
}
// Winch: reeling in raises a hanging load; it stops at the limits.
{
  const s = heli(40), r = createRig(0, 31, 0);
  run(r, s, 2, land);
  const low = r.pos.y;
  run(r, s, 3, land, undefined, () => winch(r, -1, dt));
  assert.ok(r.len === RIG.minLine && r.pos.y > low + 5, `reeled in to ${r.len}`);
  run(r, s, 1, land, undefined, () => winch(r, 1, dt));
  const kept = r.len;
  assert.ok(swapTool(r) && Math.abs(r.len - kept) < 1e-9, 'tool swap preserves rope length');
  run(r, s, 3, land, undefined, () => winch(r, -1, dt));
  assert.ok(Math.abs(r.len - 0.1) < 1e-9 && !r.taut, `hook retracts fully to ${r.len}`);
  assert.ok(swapTool(r) && Math.abs(r.len - RIG.minLine) < 1e-9, 'switching back to bucket restores working length');
  // Extending a hanging load stays taut and lowers at a smooth uniform rate every frame.
  for (let i = 0; i < 60; i++) {
    const prevY = r.pos.y;
    winch(r, 1, dt);
    stepRig(r, s, dt, land);
    assert.ok(r.taut && Math.abs((prevY - r.pos.y) - RIG.winchSpeed * dt) < 0.01, `smooth extension step ${prevY - r.pos.y}`);
  }
  run(r, s, 6, land, undefined, () => winch(r, 1, dt));
  assert.equal(r.len, RIG.bucket.line);
}
console.log('rig ok');
// The base dip tank fills the bucket over dry land once it's built; without it, dry land never does.
{
  const tank = { ...land, pond: { x: 0, z: 0, r: 8, y: 1.6 } };
  for (const [env, fills] of [[tank, true], [land, false]]) {
    const s = heli(RIG.bucket.line + 2.2), r = createRig(0, 3, 0);
    for (let i = 0; i < 4 * 60; i++) { s.vel.set(0, 0, 0); stepRig(r, s, dt, env); }
    assert.equal(r.water > 0.5 * RIG.cap, fills, `dip tank ${fills ? 'fills' : 'does not fill'} the bucket (${r.water.toFixed(2)})`);
  }
}
console.log('dip tank ok');
