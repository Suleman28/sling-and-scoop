import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildWorld, fuelAt, SITES } from '../src/world.js';
import { cellOf, cellCentre, createFire, douse, FIRE, ignite, stepFire } from '../src/fire.js';
import { FIRES } from '../src/missions.js';
import { PLANE } from '../src/plane.js';

// A fire as the director starts it (forest 150-450 m from a site, FIRES seed shape and rate), then a player
// flies the intended aircraft: arrive after `travel`, drop on the hottest cells, round trip to refill, repeat.
buildWorld(new THREE.Scene());
const AIR = {
  Utility: { water: 1, trip: 35, dump: 1 },                                  // bucket: one spot
  Heavy: { water: 2.8, trip: 45, dump: 1 },
  Bomber: { water: PLANE.tank, trip: 60, dump: 0, speed: 40 },               // strip along the flight path
};
const BEAT = 360, TRAVEL = 45, LIMIT = 600, AIM = 40, /* worst-case miss, m */ wind = (t) => { const a = 0.8 + Math.sin(t * 0.013) * 0.6, s = Math.max(0, 5 + 3 * Math.sin(t * 0.21) + 2 * Math.sin(t * 0.53 + 1)) * 0.6 + 2; return { x: Math.cos(a) * s, z: Math.sin(a) * s }; }; // updateWind, moderated (~3-6 m/s)

function rngOf(seed) { let a = seed; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); }

function start(cls, seed) {
  const rng = rngOf(seed), f = createFire(fuelAt, seed);
  for (let i = 0; i < 400; i++) {
    const site = SITES[Math.floor(rng() * SITES.length)], a = rng() * Math.PI * 2, r = 150 + rng() * 300;
    const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r, c = cellOf(x, z);
    if (fuelAt(x, z) < 0.75 || !ignite(f, c, 1)) continue;
    f.rate.set(1, cls.rate);
    for (const [di, dj] of cls.seed) ignite(f, c + di + dj * FIRE.n, 1);
    return { f, rng };
  }
}

function drop(f, rng, air) {
  const hot = [...f.burning].sort((a, b) => f.heat[b] - f.heat[a]);
  if (!air.speed) { // bucket: aim at the hottest cell, a couple of metres of wobble
    const t = cellCentre(hot[0]), ex = (rng() - 0.5) * AIM, ez = (rng() - 0.5) * AIM; // aim error: rope swing, wind drift
    for (let k = 0; k < 250 * air.water; k++) douse(f, t.x + ex + (rng() - 0.5) * 4, t.z + ez + (rng() - 0.5) * 4, 1 / 250);
    return;
  }
  // bomber: pick the heading (8 of them) and centre (any burning cell) whose strip covers the most heat
  const len = air.speed * air.water / PLANE.dropRate;
  let best = null, bs = -1, cx = 0, cz = 0;
  for (const k of hot) for (let h = 0; h < 8; h++) {
    const dx = Math.cos(h * Math.PI / 4), dz = Math.sin(h * Math.PI / 4), o = cellCentre(k);
    let sc = 0;
    for (const c of hot) { const p = cellCentre(c), u = (p.x - o.x) * dx + (p.z - o.z) * dz, v = -(p.x - o.x) * dz + (p.z - o.z) * dx; if (Math.abs(u) < len / 2 + 20 && Math.abs(v) < 27) sc += f.heat[c]; }
    if (sc > bs) { bs = sc; best = [dx, dz]; cx = o.x; cz = o.z; }
  }
  const [dx, dz] = best, rx = -dz, rz = dx, n = Math.round(air.water * 70), off = (rng() - 0.5) * AIM; // lateral line-up error
  for (let k = 0; k < n; k++) { const u = (k / n - 0.5) * len, v = (rng() - 0.5) * 14; douse(f, cx + dx * u + rx * (v + off), cz + dz * u + rz * (v + off), 1 / 70); }
}

// Returns seconds until the fire is out, or Infinity.
function fight(cls, air, seed) {
  const { f, rng } = start(cls, seed);
  let next = TRAVEL;
  for (let t = 0; t < LIMIT; t += FIRE.tick) {
    stepFire(f, FIRE.tick, wind(t));
    if (t >= next && f.burning.size) { drop(f, rng, air); next = t + air.trip; }
    if (!f.burning.size) return t;
  }
  return Infinity;
}

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1), names = ['Utility', 'Heavy', 'Bomber'], out = [];
const res = FIRES.map((cls) => names.map((n) => SEEDS.map((s) => fight(cls, AIR[n], s))));
FIRES.forEach((cls, i) => names.forEach((n, j) => {
  const r = res[i][j], won = r.filter(isFinite), med = [...r].sort((a, b) => a - b)[r.length >> 1];
  out.push(`${cls.name} vs ${n}: ${won.length}/${r.length} out (${r.filter((t) => t < BEAT).length} by ${BEAT} s), ${won.length ? `${Math.min(...won).toFixed(0)}-${Math.max(...won).toFixed(0)} s, median ${med.toFixed(0)}` : 'never'}`);
}));
console.log(out.join('\n'));
for (let i = 0; i < 3; i++) assert.ok(res[i][i].every(isFinite) && Math.max(...res[i][i]) < BEAT, `${FIRES[i].name} beaten by ${names[i]} in under 6 min`);
const med = (r) => [...r].sort((a, b) => a - b)[r.length >> 1], inTime = res[2][0].filter((t) => t < BEAT).length;
assert.ok(inTime <= SEEDS.length * 0.75 && med(res[2][0]) >= 1.25 * med(res[2][2]), `a Major fire is not reasonably beatable by the Utility (${inTime}/${SEEDS.length} by ${BEAT} s)`);
console.log('firefight ok');
