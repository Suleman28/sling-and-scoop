import assert from 'node:assert/strict';
import { SHIP, buildShip, deckAt, stepShip, toLocal } from '../src/ship.js';
import { heightAt } from '../src/world.js';

const m = buildShip(), p = m.group.children[0].geometry.attributes.position.array;
assert.ok(p.length > 0 && p.every(Number.isFinite), 'ship geometry finite');
const tris = p.length / 9;
assert.ok(tris > 5000 && tris < 25000, `tris ${tris}`);
m.update(1 / 60);

// Deterministic, and moves at SHIP.speed with vx/vz as its true derivative.
const at = (t) => (stepShip(t), { x: SHIP.x, z: SHIP.z, yaw: SHIP.yaw, vx: SHIP.vx, vz: SHIP.vz });
const a = at(100), a2 = at(100), b = at(101);
assert.deepEqual(a, a2, 'deterministic');
assert.ok(Math.abs(Math.hypot(b.x - a.x, b.z - a.z) - SHIP.speed) < 0.02, 'moves at SHIP.speed');
assert.ok(Math.abs(Math.hypot(a.vx, a.vz) - SHIP.speed) < 1e-9 && Math.abs((b.x - a.x) - (a.vx + b.vx) / 2) < 0.02 && Math.abs((b.z - a.z) - (a.vz + b.vz) / 2) < 0.02, 'vx/vz match');

// The whole lap stays in deep water, inside the soft world edge; she points along her velocity; the group follows SHIP.
const lap = SHIP.loop; assert.ok(lap > 600, `lap ${lap}`);
let rmin = 1e9, rmax = 0, hmax = -1e9;
for (let t = 0; t < lap; t += 2) {
  const q = at(t), r = Math.hypot(q.x, q.z);
  rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); hmax = Math.max(hmax, heightAt(q.x, q.z));
  assert.ok(Math.abs(Math.sin(q.yaw) * q.vx + Math.cos(q.yaw) * q.vz + SHIP.speed) < 1e-6, 'yaw along velocity'); // forward = (-sin, -cos)
}
assert.ok(hmax < -10 && rmax < 1600, `route depth ${hmax.toFixed(1)} radius ${rmin.toFixed(0)}..${rmax.toFixed(0)}`);
const e0 = at(0), e1 = at(lap); assert.ok(Math.hypot(e0.x - e1.x, e0.z - e1.z) < 0.01, 'closed loop');

// Deck and frame. Heave follows a third of the swell.
stepShip(37, () => 0.9); assert.ok(Math.abs(SHIP.y - 0.3) < 1e-9, 'heave');
const w = (lx, lz) => { const c = Math.cos(SHIP.yaw), s = Math.sin(SHIP.yaw); return [SHIP.x + lx * c + lz * s, SHIP.z - lx * s + lz * c]; };
for (const [lx, lz] of [[0, SHIP.pad.z], [5, -26], [-5, 5]]) assert.ok(Math.abs(deckAt(...w(lx, lz)) - (SHIP.y + SHIP.deck)) < 1e-9, `deck at ${lx},${lz}`);
assert.equal(deckAt(...w(30, SHIP.pad.z)), null, '30 m abeam');
assert.equal(deckAt(...w(0, 12)), null, 'on the house');
assert.equal(deckAt(...w(0, -35)), null, 'on the forecastle');
for (const [lx, lz] of [[3, -14], [-7, 20], [0, -40]]) { const l = toLocal(...w(lx, lz)); assert.ok(Math.hypot(l.x - lx, l.z - lz) < 1e-9, 'toLocal inverts'); }
console.log('ship ok');
