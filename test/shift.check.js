import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RIG } from '../src/tools.js';
import { buildWorld, fuelAt, PAD, SITES } from '../src/world.js';
import { createFire, stepFire } from '../src/fire.js';
import { accept, comboMult, createDispatch, disposeDispatch, updateDispatch } from '../src/missions.js';

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
  const fire = createFire(fuelAt, 3), d = createDispatch({ scene, fire, houses, crates: [], can: (t) => t === 'fire', firepower: () => 6 }, 3);
  for (let i = 0; i < 3000 && !d.over; i++) { stepFire(fire, 0.1, { x: 0, z: 0 }); updateDispatch(d, 0.1, idle, () => {}); assert.ok(d.calls.every((c) => c.type === 'fire')); }
}
console.log(`shift ok (ignored shift ends at ${a.t.toFixed(0)} s, ${a.stats.lost} casualties lost, ${a.stats.housesLost} houses)`);
// Fires never outgrow the airframe: a Utility (1 unit of water per load) only ever gets small wildfires, house and car fires.
{
  const fire = createFire(fuelAt, 5), d = createDispatch({ scene, fire, houses, crates: [], can: (t) => t === 'fire', firepower: () => 1 }, 5);
  for (let i = 0; i < 4000 && !d.over; i++) {
    stepFire(fire, 0.1, { x: 0, z: 0 }); updateDispatch(d, 0.1, idle, () => {});
    assert.ok(d.calls.every((c) => !/Large|Major/.test(c.title)), d.calls.map((c) => c.title).join());
  }
}
// The chain window only runs while you're free and calls are waiting; taking a call inside it extends the chain.
{
  const d = createDispatch({ scene, fire: createFire(fuelAt, 9), houses, crates: [] }, 9);
  d.comboT = 10; d.combo = 2; d.calls.push({ id: 99, type: 'cargo', age: 0, title: 't' });
  d.job = { id: 98, type: 'cargo', age: 0, crate: { held: true, hit: 0, pos: { x: 1e4, z: 1e4 } }, to: { x: 0, z: 0 } };
  updateDispatch(d, 5, idle, () => {});
  assert.equal(d.comboT, 10, 'window paused while on a job');
}
// Stories: finishing a step posts the next; steps the airframe can't do are skipped; props and loads are cleaned up.
{
  const hospital = SITES.find((x) => x.hospital);
  const crash = (can) => { // first shift (by seed) whose opening call is a car crash
    for (let seed = 1; seed < 500; seed++) {
      const crates = [], d = createDispatch({ scene, fire: createFire(fuelAt, seed), houses, crates, can }, seed);
      updateDispatch(d, 3.1, idle, () => {});
      if (/Car crash/.test(d.calls[0]?.title)) return d;
      disposeDispatch(d);
    }
  };
  const lift = RIG.maxLift;
  RIG.maxLift = RIG.vehicle.mass; // a Utility-class airframe
  const d = crash(() => true), said = [];
  assert.ok(d, 'found a car crash');
  const first = d.calls[0], prop = first.prop;
  assert.equal(first.story.of, 2);
  accept(d, 0);
  d.job.person.aboard = true;
  updateDispatch(d, 0.1, { pos: new THREE.Vector3(hospital.x, 0, hospital.z), grounded: true }, (m) => said.push(m));
  const wreck = d.calls[0];
  assert.ok(!d.job && wreck && /Vehicle recovery/.test(wreck.title) && wreck.step === 2 && wreck.heavy, 'wreck recovery posted at once');
  assert.equal(wreck.prop, prop, 'the crash car stays as the wreck');
  assert.equal(d.crates.length, 0, 'casualty removed');
  accept(d, 0);
  assert.equal(d.job.bonus, 1.25, 'follow-up bonus when taken straight after');
  assert.equal(d.props.length, 0, 'prop gone once the wreck is hooked');
  assert.equal(d.crates.length, 1);
  disposeDispatch(d);
  assert.equal(d.crates.length, 0);
  // Not enough lift: no wreck step. Scout (rescues only): same.
  RIG.maxLift = 1.2;
  for (const can of [() => true, (t) => t === 'rescue']) {
    const e = crash(can);
    assert.equal(e.calls[0].story.of, 1, 'story collapses to a single call');
    accept(e, 0); e.job.person.aboard = true;
    updateDispatch(e, 0.1, { pos: new THREE.Vector3(hospital.x, 0, hospital.z), grounded: true }, () => {});
    assert.equal(e.calls.length, 0, 'no heavy follow-up');
    assert.equal(e.props.length, 0, 'crash car removed');
    disposeDispatch(e);
  }
  RIG.maxLift = lift;
}
console.log('shift variety ok');
// No pad, apron or house ring sits under the grass: the ground there is level with the pad.
{
  const { heightAt, PADS, SITES } = await import('../src/world.js');
  for (const [p, r] of [[PADS[0], 45], [PADS[1], 14], ...SITES.map((s) => [s, 30])])
    for (let a = 0; a < 6.28; a += 0.1) for (let d = 0; d <= r; d += 2) assert.ok(heightAt(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d) - p.y < 0.05, `ground over the pad at ${p.name || 'base'}`);
  console.log('pads level ok');
}
