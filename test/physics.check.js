import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPhysics } from '../src/physics.js';
import { createFlight, stepFlight } from '../src/chopper.js';
import { act, createCrate, createRig, massOf, RIG, swapTool } from '../src/tools.js';
import { groundAt, HARBOUR, heightAt, PAD, padLocal } from '../src/world.js';

const ph = await createPhysics(new THREE.Scene()), dt = 1 / 60, env = { groundAt, heightAt, wind: { x: 0, z: 0 } };
const away = { pos: new THREE.Vector3(1e4, 500, 1e4), vel: new THREE.Vector3() };
const run = (secs, loads, r = null, each = () => {}) => { for (let i = 0; i < secs * 60; i++) { each(); ph.step({ loads, s: away, r, env, fly: false, radius: 1.8 }); } };
const at = padLocal(PAD, 0, -20), ground = groundAt(at.x, at.z);

// Dropped from 30 m onto the apron: lands hard, settles, rests on its pallet at ground level.
const c = createCrate(at.x, ground + 30, at.z);
let hit = 0;
run(5, [c], null, () => { hit = Math.max(hit, c.hit); });
assert.ok(hit > 15, `impact ${hit}`);
assert.ok(c.vel.length() < 0.1, `at rest ${c.vel.length()}`);
assert.ok(Math.abs(c.pos.y - RIG.crate.hang - ground) < 0.1, `on the ground ${c.pos.y}`);

// Classic rope: a load on the hook swept through a resting crate knocks it aside and goes where the rope puts it.
const swing = createCrate(c.pos.x - 6, ground + 0.1, c.pos.z);
swing.held = true;
const x0 = c.pos.x;
run(2, [c, swing], { crate: swing }, () => { swing.pos.x += 8 / 60; swing.vel.set(8, 0, 0); });
assert.ok(c.pos.x > x0 + 1.5, `knocked from ${x0} to ${c.pos.x}`);
assert.ok(Math.abs(swing.pos.x - (x0 - 6 + 16)) < 1e-6);

// ---- Flight physics: the helicopter flies through stepFlight, Rapier adds the rope and the knocks. ----
const idle = { fwd: 0, turn: 0, lift: 0, strafe: 0 };
const fly = (s, r, loads, input, secs, each = () => {}) => {
  for (let i = 0; i < secs * 60; i++) {
    env.loadMass = r.taut ? massOf(r) : 0;
    if (!s.wreck) stepFlight(s, { ...idle, ...input }, dt, env);
    ph.step({ loads, s, r, env, fly: true, radius: 1.8 });
    each(i);
  }
};
const start = (lx, lz) => { const p = padLocal(PAD, lx, lz); return [createFlight(p.x, groundAt(p.x, p.z), p.z, PAD.yaw), createRig(p.x + 3, groundAt(p.x, p.z) + 1.2, p.z)]; };

// Bucket on the rope: climb and hover, it hangs taut a line-length below the belly; no NaN, altitude holds.
{
  const [s, r] = start(0, -20);
  fly(s, r, [], { lift: 1 }, 3);
  fly(s, r, [], {}, 4);
  const y = s.pos.y;
  fly(s, r, [], {}, 2);
  assert.ok(s.pos.y > ground + 25 && Math.abs(s.pos.y - y) < 1, `hover ${y} -> ${s.pos.y}`);
  assert.ok(r.taut && Math.abs(s.pos.y + RIG.anchor - r.pos.y - r.len) < 0.3, `bucket ${r.pos.y} under ${s.pos.y}`);
  assert.ok([s.pos, s.vel, r.pos, r.vel].every((v) => v.toArray().every(Number.isFinite)));
}

// Hook a crate and climb out with it; it swings below on the rope, and pulls the chopper about when yanked.
const lift = (spec, maxLift) => {
  RIG.maxLift = maxLift;
  const [s, r] = start(-30, -20), load = createCrate(s.pos.x + 0.5, groundAt(s.pos.x, s.pos.z), s.pos.z, spec);
  swapTool(r);
  fly(s, r, [load], {}, 1);
  r.pos.copy(load.pos);
  assert.equal(act(r, [load]), 'hooked');
  fly(s, r, [load], { lift: 1 }, 6);
  const out = { load: load.pos.y - groundAt(load.pos.x, load.pos.z) - spec.hang, heli: s.pos.y - groundAt(s.pos.x, s.pos.z), overloaded: r.overloaded };
  act(r, [load]);
  fly(s, r, [], {}, 0.1); // drop it from the world
  return out;
};
{
  const crate = lift(RIG.crate, 1.2);
  assert.ok(crate.load > 10 && crate.heli > 15, `crate lifted to ${crate.load}`);
  const stuck = lift(RIG.container, 1.2);
  assert.ok(stuck.overloaded && stuck.load < 1.5 && stuck.heli < 15, `container too heavy: load ${stuck.load}, heli ${stuck.heli}`);
  const heavy = lift(RIG.container, 2.05);
  assert.ok(heavy.load > 5, `container lifted with more power ${heavy.load}`);
  RIG.maxLift = 1.2;
}

// Ramming a parked container at full speed wrecks the chopper: it tumbles and comes to rest on the ground.
{
  const [s, r] = start(30, -20), fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), box = createCrate(s.pos.x + fx * 30, ground, s.pos.z + fz * 30, RIG.container);
  fly(s, r, [box], {}, 1);
  s.pos.y = ground + 0.6; s.vel.set(fx * 45, 0, fz * 45); // nose first
  let worst = 0;
  fly(s, r, [box], { fwd: 1 }, 1.5, () => { worst = Math.max(worst, s.hit); });
  assert.ok(s.wreck && worst > 20, `wrecked at ${worst}`);
  fly(s, r, [box], {}, 6);
  assert.ok(s.vel.length() < 1 && s.pos.y - groundAt(s.pos.x, s.pos.z) < 2 && s.pos.y > ground - 0.5, `wreck at rest ${s.pos.y}`);
}

// ---- The loose world: floating, exploding drums. ----
// A crate dropped into deep water splashes, bobs up and floats with its top above the surface; a wrecked vehicle rides low.
{
  let x = 0; while (heightAt(x, 0) > -4) x += 20;
  const box = createCrate(x, 12, 0), car = createCrate(x + 8, 12, 0, RIG.vehicle), events = [];
  for (let i = 0; i < 600; i++) events.push(...ph.step({ loads: [box, car], s: away, r: null, env, fly: false, radius: 1.8 }));
  assert.ok(events.filter((e) => e.type === 'splash').length === 2, 'two splashes');
  const top = (c) => c.pos.y, bottom = (c) => c.pos.y - c.spec.hang;
  assert.ok(top(box) > 0.3 && bottom(box) < -0.1 && Math.abs(box.vel.y) < 0.5, `crate afloat ${bottom(box)}..${top(box)}`);
  assert.ok(bottom(car) < bottom(box) - 0.3 && bottom(car) > -2, `vehicle rides low ${bottom(car)}`);
  run(0.1, []);
}
// Fire under the drum piles sets them all off, one after another; a crate beside a pile is thrown clear. reset() restacks them.
{
  const pile = padLocal(PAD, 12 * -PAD.away, 18), near = createCrate(pile.x + 4, groundAt(pile.x + 4, pile.z), pile.z), x0 = near.pos.clone(), booms = [];
  const burn = (secs, on) => { for (let i = 0; i < secs * 60; i++) for (const e of ph.step({ loads: [near], s: away, r: null, env: { ...env, burning: () => on }, fly: false, radius: 1.8 })) if (e.type === 'boom') booms.push(i); };
  burn(1, false);
  assert.equal(booms.length, 0, 'drums sit quietly');
  burn(7, true);
  assert.equal(booms.length, 23, `every drum went up (${booms.length})`);
  assert.ok(new Set(booms).size > 6, 'staggered, not all at once');
  assert.ok(near.pos.distanceTo(x0) > 1.5, `crate thrown ${near.pos.distanceTo(x0)}`);
  ph.reset();
  burn(1, false);
  // A container dropped on the pile from 40 m sets it off by impact alone.
  const bomb = createCrate(pile.x, PAD.y + 40, pile.z, RIG.container);
  booms.length = 0;
  for (let i = 0; i < 300; i++) for (const e of ph.step({ loads: [bomb], s: away, r: null, env, fly: false, radius: 1.8 })) if (e.type === 'boom') booms.push(i);
  assert.ok(booms.length >= 1, `impact set off ${booms.length}`);
  ph.reset();
}
// A moving deck (the freighter's): a crate set down on it rides along instead of being left behind.
{
  let x = 0; while (heightAt(x, 300) > -6) x += 20;
  const box = createCrate(x, 5 + 3, 300), deck = { x, y: 5, z: 300, yaw: 0, hw: 6, hl: 16 };
  for (let i = 0; i < 480; i++) { deck.x += 4 * dt; ph.step({ loads: [box], s: away, r: null, env, fly: false, radius: 1.8, deck }); }
  assert.ok(Math.abs(box.pos.x - deck.x) < 4.5 && Math.abs(box.pos.y - RIG.crate.hang - 5) < 0.15 && Math.abs(box.vel.x - 4) < 0.5, `rides the deck: ${box.pos.x - deck.x} m off, ${box.vel.x} m/s`);
  run(0.1, []);
}

// ---- Rescue Cutter in Rapier: waterjet wash, fire monitor jet, side thruster wash, and oriented hull. ----
{
  // 1. Waterjet wash: floating crate astern of the cutter is pushed away by the transom waterjets.
  const boatS = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, roll: 0, throttle: 1, speed: 5, steer: 0, sway: 0 };
  const crateAstern = createCrate(0, 0, 15); // 5 m astern of the transom (transom at z = 10)
  const z0 = crateAstern.pos.z;
  for (let i = 0; i < 90; i++) ph.step({ loads: [crateAstern], s: boatS, r: null, env, fly: false, boat: true, radius: 4 });
  assert.ok(crateAstern.pos.z > z0 + 1.0, `waterjet wash pushed crate astern from ${z0} to ${crateAstern.pos.z}`);

  // 2. Fire monitor water cannon jet: floating crate in the landing zone (~70–95 m out) is pushed along the stream.
  const boatJet = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, roll: 0, throttle: 0, steer: 0, sway: 0, jet: true, aim: 0 };
  const crateAhead = createCrate(0, 0, -80); // 80 m ahead in the water cannon landing zone (aiming along -z)
  const zAhead0 = crateAhead.pos.z;
  for (let i = 0; i < 90; i++) ph.step({ loads: [crateAhead], s: boatJet, r: null, env, fly: false, boat: true, radius: 4 });
  assert.ok(crateAhead.pos.z < zAhead0 - 1.0, `fire monitor pushed crate ahead from ${zAhead0} to ${crateAhead.pos.z}`);

  // 3. Side thruster wash: crate alongside the bow is pushed sideways when crabbing with Q/E.
  const boatSway = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, roll: 0, throttle: 0, steer: 0, sway: 1 }; // crabbing starboard -> jet blows to port (-x)
  const cratePort = createCrate(-5, 0, -7.5); // 5 m to port near the bow thruster
  const xPort0 = cratePort.pos.x;
  for (let i = 0; i < 90; i++) ph.step({ loads: [cratePort], s: boatSway, r: null, env, fly: false, boat: true, radius: 4 });
  assert.ok(cratePort.pos.x < xPort0 - 0.8, `side thruster wash pushed crate sideways from ${xPort0} to ${cratePort.pos.x}`);

  // 4. Oriented hull: the 21 m cutter hull physically nudges a floating crate when moving into it.
  const boatHull = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, roll: 0, throttle: 0, steer: 0, sway: 0 };
  const crateSide = createCrate(2.5, 0, 5); // alongside midships (hull half-width is 2.9)
  const xSide0 = crateSide.pos.x;
  for (let i = 0; i < 60; i++) {
    boatHull.pos.x += 2 * dt; // nudge to starboard into the crate
    ph.step({ loads: [crateSide], s: boatHull, r: null, env, fly: false, boat: true, radius: 4 });
  }
  assert.ok(crateSide.pos.x > xSide0 + 0.5, `oriented hull pushed crate aside to ${crateSide.pos.x}`);
  run(0.1, []);
}

// ---- Harbour pier colliders: a crate dropped on the timber deck rests at deck level. ----
{
  const hyaw = HARBOUR.yaw, hcos = Math.cos(hyaw), hsin = Math.sin(hyaw);
  // Point on the pier head (local (0, 0, -1.5))
  const hx = HARBOUR.hx + (-1.5) * hsin, hz = HARBOUR.hz + (-1.5) * hcos;
  const pierCrate = createCrate(hx, 10, hz);
  for (let i = 0; i < 180; i++) ph.step({ loads: [pierCrate], s: away, r: null, env, fly: false, radius: 1.8 });
  const deckTop = 1.5 + 0.38 / 2; // deck height 1.5, half-thickness 0.19 -> 1.69
  assert.ok(Math.abs(pierCrate.pos.y - RIG.crate.hang - deckTop) < 0.15, `crate rests on pier deck: ${pierCrate.pos.y}`);
  run(0.1, []);
}

console.log('physics ok');
