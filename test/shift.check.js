import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildWorld, fuelAt, PAD } from '../src/world.js';
import { createFire, stepFire } from '../src/fire.js';
import { comboMult, createDispatch, updateDispatch } from '../src/missions.js';

const scene = new THREE.Scene(), { houses } = buildWorld(scene);
const idle = { pos: new THREE.Vector3(PAD.x, PAD.y, PAD.z), grounded: true };

// Run a shift with nobody flying: returns the call log and how long it lasted.
function ignoredShift(seed) {
  const fire = createFire(fuelAt, seed), d = createDispatch({ scene, fire, houses, crates: [] }, seed), log = [];
  const dt = 1 / 10;
  while (!d.over && d.t < 1200) {
    stepFire(fire, dt, { x: 4, z: 1 });
    updateDispatch(d, dt, idle, (msg) => log.push(`${d.t.toFixed(1)} ${msg}`));
  }
  return { log, t: d.t, over: d.over, stats: d.stats };
}

const a = ignoredShift(20261025), b = ignoredShift(20261025);
assert.deepEqual(a.log, b.log, 'same seed, same shift');
assert.ok(a.over, 'an ignored shift ends');
assert.ok(a.t > 120 && a.t < 600, `ignored shift lasted ${a.t.toFixed(0)} s`);
assert.notDeepEqual(ignoredShift(7).log, a.log, 'different seed, different shift');
assert.equal(comboMult(1), 1);
assert.equal(comboMult(3), 1.5);
assert.equal(comboMult(99), 3);
// A fires-only fleet never gets calls it can't do, even when the fire cap blocks new fires.
{
  const fire = createFire(fuelAt, 3), d = createDispatch({ scene, fire, houses, crates: [], can: (t) => t === 'fire', bigFires: () => true }, 3);
  for (let i = 0; i < 3000 && !d.over; i++) { stepFire(fire, 0.1, { x: 0, z: 0 }); updateDispatch(d, 0.1, idle, () => {}); assert.ok(d.calls.every((c) => c.type === 'fire')); }
}
console.log(`shift ok (ignored shift ends at ${a.t.toFixed(0)} s, ${a.stats.lost} casualties lost, ${a.stats.housesLost} houses)`);
