import * as THREE from 'three';

// Wildfire as a coarse cellular grid over the whole map, ticked at a fixed rate.
// Each cell has fuel (from terrain and trees), heat (0 = not burning, up to 1) and a wet timer.
export const FIRE = {
  cell: 20, n: 140,           // 20 m cells over the 2.8 km map
  tick: 0.25,                 // seconds per sim tick
  grow: 0.25,                 // heat gained per second while fuel lasts
  burn: 0.02,                 // fuel consumed per second at full heat (forest cell burns ~50 s)
  spread: 0.007,              // ignition chance per neighbour per second at full heat and fuel
  windBias: 1.4,              // downwind spread multiplier per 10 m/s of wind
  douse: 4,                   // heat removed per unit of water (a full bucket clears ~3x3 burning cells)
  reach: 2,                   // splash rings round the hit cell: a full bucket soaks a 5x5 patch (~100 m); bigger buckets reach further
  snuff: 0.2,                 // a doused cell below this heat goes out instead of smouldering
  wetTime: 25,                // seconds a doused cell can't reignite
  minHeat: 0.04,
};
const N = FIRE.n, HALF = (FIRE.n * FIRE.cell) / 2;
const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([i, j]) => [i, j, i / Math.hypot(i, j), j / Math.hypot(i, j)]);

export const cellOf = (x, z) => {
  const i = Math.floor((x + HALF) / FIRE.cell), j = Math.floor((z + HALF) / FIRE.cell);
  return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
};
export const cellCentre = (c) => ({ x: ((c % N) + 0.5) * FIRE.cell - HALF, z: (Math.floor(c / N) + 0.5) * FIRE.cell - HALF });

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fuelAt(x, z) -> 0..1 for a cell centre. Each burning cell remembers which fire (owner id) it belongs to.
export function createFire(fuelAt, seed) {
  const fuel0 = new Float32Array(N * N);
  for (let c = 0; c < N * N; c++) { const p = cellCentre(c); fuel0[c] = fuelAt(p.x, p.z); }
  // rate: per-fire spread multiplier (owner id -> x), so small and major fires can burn side by side.
  const f = { fuel0, fuel: null, heat: new Float32Array(N * N), wet: new Float32Array(N * N), owner: new Int32Array(N * N), rate: new Map(), burning: new Set(), scorched: [] };
  resetFire(f, seed);
  return f;
}

// Fresh map: all fuel back, nothing burning or wet.
export function resetFire(f, seed) {
  f.fuel = f.fuel0.slice();
  f.heat.fill(0); f.wet.fill(0); f.owner.fill(0);
  f.burning.clear();
  f.rate.clear();
  f.scorched.length = 0;
  f.rng = mulberry32(seed);
  f.acc = 0;
}

export function ignite(f, c, owner = 1) {
  if (c < 0 || f.heat[c] > 0 || f.fuel[c] < 0.05 || f.wet[c] > 0) return false;
  f.heat[c] = 0.1;
  f.owner[c] = owner;
  f.burning.add(c);
  return true;
}

// Burning cells of one fire: count and centroid.
export function fireStatus(f, owner) {
  let n = 0, x = 0, z = 0;
  for (const c of f.burning) if (f.owner[c] === owner) { const p = cellCentre(c); n++; x += p.x; z += p.z; }
  return { n, x: n ? x / n : 0, z: n ? z / n : 0 };
}

// Water landing at (x, z): full effect on its cell, falling off to 0.3 at the outer ring (reach rings out).
// Returns true if it hit a burning cell (for steam).
export function douse(f, x, z, amount, R = FIRE.reach) {
  const c0 = cellOf(x, z);
  if (c0 < 0) return false;
  let hit = false;
  const i0 = c0 % N, j0 = Math.floor(c0 / N);
  for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) {
    if (i < 0 || j < 0 || i >= N || j >= N) continue;
    const c = j * N + i, share = 1 - (0.7 * Math.max(Math.abs(i - i0), Math.abs(j - j0))) / R;
    f.wet[c] = Math.max(f.wet[c], FIRE.wetTime * share);
    if (!f.burning.has(c)) continue;
    hit ||= c === c0;
    f.heat[c] -= amount * share * FIRE.douse;
    if (f.heat[c] <= FIRE.snuff) { f.heat[c] = 0; f.burning.delete(c); }
  }
  return hit;
}

// wind: {x, z} in m/s. Cells that burn out with their fuel spent are pushed to f.scorched.
export function stepFire(f, dt, wind) {
  for (f.acc += dt; f.acc >= FIRE.tick; f.acc -= FIRE.tick) {
    const t = FIRE.tick, ws = Math.hypot(wind.x, wind.z), wx = ws ? wind.x / ws : 0, wz = ws ? wind.z / ws : 0;
    for (let c = 0; c < N * N; c++) if (f.wet[c] > 0) f.wet[c] = Math.max(0, f.wet[c] - t);
    for (const c of [...f.burning]) {
      const fuel = f.fuel[c];
      f.heat[c] = Math.min(1, f.heat[c] + (fuel > 0.05 ? FIRE.grow : -FIRE.grow * 2) * t);
      f.fuel[c] = Math.max(0, fuel - FIRE.burn * f.heat[c] * t);
      if (f.heat[c] <= FIRE.minHeat) {
        f.heat[c] = 0;
        f.burning.delete(c);
        if (f.fuel[c] < 0.1) f.scorched.push(c);
        continue;
      }
      const i = c % N, j = Math.floor(c / N), spread = FIRE.spread * (f.rate.get(f.owner[c]) ?? 1);
      for (const [di, dj, dx, dz] of NB) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nc = nj * N + ni;
        if (f.heat[nc] > 0 || f.wet[nc] > 0 || f.fuel[nc] < 0.05) continue;
        const windF = Math.max(0.2, 1 + FIRE.windBias * (dx * wx + dz * wz) * (ws / 10));
        if (f.rng() < spread * f.heat[c] * f.fuel[nc] * windF * t) ignite(f, nc, f.owner[c]);
      }
    }
  }
}

// ---- Visuals: flames per burning cell, smoke columns, steam. Scorching is applied by the caller (world). ----

export function buildFireView(scene, groundAt, smoke) {
  const MAX = 1800;
  const flames = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), MAX); // unfogged: flames stay hot-coloured at range
  flames.frustumCulled = false;
  flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(flames);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const hash = (c, k) => { const h = Math.sin(c * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };
  let smokeAcc = 0;

  return function update(f, dt, t, wind) {
    let n = 0;
    for (const c of f.burning) {
      const centre = cellCentre(c), heat = f.heat[c];
      for (let k = 0; k < 3 && n < MAX; k++) {
        const x = centre.x + (hash(c, k) - 0.5) * FIRE.cell * 0.8, z = centre.z + (hash(c, k + 7) - 0.5) * FIRE.cell * 0.8;
        const flick = 0.75 + 0.25 * Math.sin(t * (9 + k * 3) + c), h = (4 + 9 * heat) * flick * (0.7 + hash(c, k + 3) * 0.6);
        m.compose(p.set(x, groundAt(x, z) - 0.5, z), q, s.set(1.4 + heat * 1.6, h, 1.4 + heat * 1.6));
        flames.setMatrixAt(n, m);
        flames.setColorAt(n++, col.setHSL(0.015 + 0.08 * hash(c, k + 11) * flick, 1, 0.42 + 0.12 * flick));
      }
    }
    flames.count = n;
    flames.instanceMatrix.needsUpdate = true;
    if (flames.instanceColor) flames.instanceColor.needsUpdate = true;

    // Smoke: a capped number of puffs per second spread over the burning cells.
    if (f.burning.size) {
      const cells = [...f.burning];
      for (smokeAcc += Math.min(90, cells.length * 8) * dt; smokeAcc >= 1; smokeAcc--) {
        const c = cells[Math.floor(Math.random() * cells.length)], ce = cellCentre(c), x = ce.x + (Math.random() - 0.5) * FIRE.cell, z = ce.z + (Math.random() - 0.5) * FIRE.cell;
        smoke.spawn(x, groundAt(x, z) + 8, z, wind.x * 0.5, 4 + Math.random() * 3, wind.z * 0.5, f.heat[c] > 0.5 ? 0x5a5058 : 0x8a8088, { life: 9, grav: 0.3, drag: 0.1, grow: 9 + Math.random() * 5 });
      }
    }
  };
}
