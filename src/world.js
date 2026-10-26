import * as THREE from 'three';
import { reflect } from './chopper.js';

export const SEED = 1337;           // fixed map seed: the career island stays learnable
export const SIZE = 2800;           // terrain square, metres
const SEGS = 280;                   // 10 m cells, ~157k triangles
const CELL = SIZE / SEGS, HALF = SIZE / 2;
export const SEA = 0;
const FLOOR = -18;

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded value-noise fBm in [0,1].
function makeNoise(seed) {
  const hash = (x, y) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, oct = 4) => {
    let s = 0, amp = 1, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += n(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
    return s / norm;
  };
}

const noise = makeNoise(SEED);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Main island plus three islets: an archipelago small enough for one draw call.
const ISLETS = [[-900, 760, 260], [860, -880, 210], [1060, 520, 150]];

function rawHeight(x, z) {
  const warp = (noise(x / 500 + 7, z / 500 - 3, 3) - 0.5) * 0.9;
  let mask = smooth(1.05, 0.35, Math.hypot(x, z) / 860 + warp);
  for (const [ix, iz, ir] of ISLETS) mask = Math.max(mask, smooth(1, 0.2, Math.hypot(x - ix, z - iz) / ir + warp * 0.8) * 0.85);
  const m = noise(x / 380, z / 380, 5);
  const ridge = 1 - Math.abs(noise(x / 260 + 11, z / 260 + 5, 4) * 2 - 1);
  const e = mask * (0.25 + 0.75 * (m * 0.6 + ridge * 0.4));
  return FLOOR + mask * 22 + e * e * 240 * mask;
}

// Home pad: a low stretch of main-island coast, nose out to sea toward the sunset.
export const SUN_DIR = new THREE.Vector3(-0.75, 0.22, -0.62).normalize();
export const PAD = (() => {
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    const dx = Math.cos(a), dz = Math.sin(a);
    let r = 1300;
    while (r > 0 && rawHeight(dx * r, dz * r) < 2) r -= 5;
    r -= 55;
    const x = dx * r, z = dz * r, y = rawHeight(x, z);
    const score = y - 25 * (dx * SUN_DIR.x + dz * SUN_DIR.z);
    if (y > 3 && (!best || score < best.score)) best = { x, z, y, score, yaw: Math.atan2(-dx, -dz) };
  }
  return best;
})();

// Fuel depot on the big western islet: the only other place to refuel.
const DEPOT = { x: ISLETS[0][0], z: ISLETS[0][1], y: Math.max(4, rawHeight(ISLETS[0][0], ISLETS[0][1])), yaw: PAD.yaw };
export const PADS = [PAD, DEPOT];

// Destinations on the main island: a hospital and three towns, each with a landing pad, spread apart on flat ground.
export const SITES = (() => {
  const rng = mulberry32(SEED + 2), out = [], names = ['Mercy Point Hospital', 'Saltmere', 'Kettle Ridge', 'Lowfield'];
  for (let tries = 0; tries < 6000 && out.length < names.length; tries++) {
    const x = (rng() - 0.5) * 1700, z = (rng() - 0.5) * 1700, y = rawHeight(x, z);
    if (y < 6 || y > 90 || [...PADS, ...out].some((p) => Math.hypot(p.x - x, p.z - z) < 380)) continue;
    if ([[35, 0], [-35, 0], [0, 35], [0, -35]].some(([dx, dz]) => Math.abs(rawHeight(x + dx, z + dz) - y) > 10)) continue;
    out.push({ x, z, y, yaw: rng() * Math.PI * 2, name: names[out.length], hospital: out.length === 0 });
  }
  return out;
})();
export const BASE = { ...PAD, name: 'Base' };

// Airstrip for the water bomber: the straight 520 m strip near base needing the least cut-and-fill, found by a
// one-off search over this (fixed-seed) map. About a third of it is reclaimed from the sea, built up to pad height.
// Takeoff runs toward the sea end so you climb out over water.
export const RUNWAY = (() => {
  const x = -358, z = -625, a = 1.7, len = 520, width = 30, dx = Math.sin(a), dz = Math.cos(a);
  const seaward = rawHeight(x + dx * 250, z + dz * 250) < rawHeight(x - dx * 250, z - dz * 250) ? 1 : -1;
  const fx = dx * seaward, fz = dz * seaward; // takeoff direction
  return { x, z, dx, dz, len, width, y: PAD.y, yaw: Math.atan2(-fx, -fz), start: { x: x - fx * (len / 2 - 30), z: z - fz * (len / 2 - 30) } };
})();
// Distance outside the runway rectangle (0 inside), expanded by margin.
const runwayGap = (x, z, margin = 0) => {
  const rx = x - RUNWAY.x, rz = z - RUNWAY.z, t = rx * RUNWAY.dx + rz * RUNWAY.dz, o = -rx * RUNWAY.dz + rz * RUNWAY.dx;
  return Math.hypot(Math.max(0, Math.abs(t) - RUNWAY.len / 2 - margin), Math.max(0, Math.abs(o) - RUNWAY.width / 2 - margin));
};
export const onRunway = (x, z) => runwayGap(x, z) === 0;
const FLATS = [...PADS, ...SITES];
export const PAD_RADIUS = 11;

// Pad-local offset (x right, z back) to world xz.
export const padLocal = (pad, lx, lz) => ({ x: pad.x + Math.cos(pad.yaw) * lx + Math.sin(pad.yaw) * lz, z: pad.z - Math.sin(pad.yaw) * lx + Math.cos(pad.yaw) * lz });

function height(x, z) {
  let y = rawHeight(x, z);
  for (const p of FLATS) { const t = smooth(70, 32, Math.hypot(x - p.x, z - p.z)); y = y * (1 - t) + p.y * t; }
  const r = smooth(60, 0, runwayGap(x, z, 8)); // airstrip apron, blending into the land (or rising out of the sea) over 60 m
  return y * (1 - r) + RUNWAY.y * r;
}

const H = new Float32Array((SEGS + 1) * (SEGS + 1));
for (let j = 0; j <= SEGS; j++)
  for (let i = 0; i <= SEGS; i++) H[j * (SEGS + 1) + i] = height(i * CELL - HALF, j * CELL - HALF);
const h = (i, j) => H[j * (SEGS + 1) + i];

// Exact height of the rendered triangles (same diagonal split as the mesh).
export function heightAt(x, z) {
  const gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= SEGS || gz >= SEGS) return FLOOR;
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  if (fx + fz <= 1) return h(i, j) + (h(i + 1, j) - h(i, j)) * fx + (h(i, j + 1) - h(i, j)) * fz;
  const h11 = h(i + 1, j + 1);
  return h11 + (h(i, j + 1) - h11) * (1 - fx) + (h(i + 1, j) - h11) * (1 - fz);
}

export const groundAt = (x, z) => Math.max(heightAt(x, z), SEA);

// Warm-dusk palette.
const C = {
  seabed: new THREE.Color(0xb98e6e), sand: new THREE.Color(0xeccb9c),
  grass: new THREE.Color(0x86a052), dry: new THREE.Color(0xbfae5e),
  rock: new THREE.Color(0x8d7584), peak: new THREE.Color(0xf3e1d2),
  tree: new THREE.Color(0x3f6b3c), water: 0x3a8fa6,
  skyTop: new THREE.Color(0x2e3170), horizon: new THREE.Color(0xf2a07a), sun: new THREE.Color(0xffe2a8),
};
export const FOG = C.horizon;

function biome(y, ny, x, z, out) {
  if (y < SEA - 1.5) out.copy(C.seabed);
  else if (y < SEA + 2.2) out.copy(C.sand);
  else if (y > 185) out.copy(C.peak);
  else if (ny < 0.72 || y > 140) out.copy(C.rock);
  else out.copy(C.grass).lerp(C.dry, smooth(0.4, 0.7, noise(x / 160 - 20, z / 160 + 4, 2)));
  return out.multiplyScalar(0.94 + Math.random() * 0.1);
}

let terrain, trees, terrainColors, treeColors; // kept for scorching and resetting

function buildTerrain() {
  const n = SEGS * SEGS * 6, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), color = new THREE.Color();
  let k = 0;
  const tri = () => {
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2).normalize();
    biome((a.y + b.y + c.y) / 3, e1.y, a.x, a.z, color);
    for (const v of [a, b, c]) { pos.set([v.x, v.y, v.z], k * 3); col.set([color.r, color.g, color.b], k * 3); k++; }
  };
  for (let j = 0; j < SEGS; j++) for (let i = 0; i < SEGS; i++) {
    const x0 = i * CELL - HALF, z0 = j * CELL - HALF, x1 = x0 + CELL, z1 = z0 + CELL;
    a.set(x0, h(i, j), z0); b.set(x0, h(i, j + 1), z1); c.set(x1, h(i + 1, j), z0); tri();
    a.set(x1, h(i + 1, j), z0); b.set(x0, h(i, j + 1), z1); c.set(x1, h(i + 1, j + 1), z1); tri();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  terrainColors = col.slice();
  return (terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
}

// Trees as cones in a 20 m grid (same cells as the fire sim): [x, z, baseY, height, radius, instance].
const TREE_CELL = 20, TREE_COLS = Math.ceil(SIZE / TREE_CELL), treeGrid = [];
// Pushes a body of `radius` out of any tree cone, sampled at height pos.y + dy; returns the closing speed.
// Defaults fit the chopper (skid-to-belly height).
export function hitTrees(pos, vel, radius = 1.8, dy = 0.8) {
  const cx = Math.floor((pos.x + HALF) / TREE_CELL), cz = Math.floor((pos.z + HALF) / TREE_CELL);
  let hit = 0;
  for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    for (const [x, z, y0, h, r0] of treeGrid[j * TREE_COLS + i] || []) {
      const y = pos.y + dy - y0;
      if (y < 0 || y > h) continue;
      const r = r0 * (1 - y / h) + radius, dx = pos.x - x, dz = pos.z - z, d = Math.hypot(dx, dz);
      if (d >= r || d === 0) continue;
      pos.x = x + (dx / d) * r; pos.z = z + (dz / d) * r;
      hit = Math.max(hit, reflect(vel, dx / d, dz / d, 0.3));
    }
  }
  return hit;
}

function buildTrees() {
  const rng = mulberry32(SEED + 1), geo = new THREE.ConeGeometry(2.6, 9, 5).translate(0, 4, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), 3500);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  let count = 0;
  for (let tries = 0; tries < 60000 && count < mesh.count; tries++) {
    const x = (rng() - 0.5) * SIZE, z = (rng() - 0.5) * SIZE, y = heightAt(x, z);
    if (y < 4 || y > 120 || noise(x / 220 + 40, z / 220 - 9, 3) < 0.5) continue;
    if (Math.abs(heightAt(x + 4, z) - y) + Math.abs(heightAt(x, z + 4) - y) > 4) continue;
    if (FLATS.some((p) => Math.hypot(x - p.x, z - p.z) < 70) || runwayGap(x, z) < 25) continue;
    const k = 0.7 + rng() * 0.8, sy = k * (0.8 + rng() * 0.5), cell = Math.floor((z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((x + HALF) / TREE_CELL);
    (treeGrid[cell] ||= []).push([x, z, y - 0.5, 9 * sy, 2.6 * k, count]);
    m.compose(p.set(x, y - 0.5, z), q.setFromAxisAngle(up, rng() * 6.28), s.set(k, sy, k));
    mesh.setMatrixAt(count, m);
    mesh.setColorAt(count++, col.copy(C.tree).multiplyScalar(0.8 + rng() * 0.4));
  }
  mesh.count = count;
  treeColors = mesh.instanceColor.array.slice();
  return (trees = mesh);
}

// Fire fuel for the 20 m cell around (x, z): grass by dryness, plus trees; sand, water and rock barely burn.
export function fuelAt(x, z) {
  const y = heightAt(x, z), slope = Math.hypot(heightAt(x + 5, z) - y, heightAt(x, z + 5) - y) / 5;
  if (y < SEA + 2.2) return 0;
  if (slope > 1 || y > 140) return 0.08;
  const n = (treeGrid[Math.floor((z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((x + HALF) / TREE_CELL)] || []).length;
  return Math.min(1, 0.35 + 0.25 * smooth(0.4, 0.7, noise(x / 160 - 20, z / 160 + 4, 2)) + n * 0.1);
}

// Char a burnt-out 20 m cell (index i + j * 140): its 2x2 terrain cells and its trees.
const CHAR = new THREE.Color(0x2e2622);
export function scorch(cell) {
  const fi = cell % TREE_COLS, fj = Math.floor(cell / TREE_COLS), col = terrain.geometry.attributes.color, c = new THREE.Color();
  for (let tj = fj * 2; tj < fj * 2 + 2; tj++) {
    const start = (tj * SEGS + fi * 2) * 6;
    for (let v = start; v < start + 12; v++) col.setXYZ(v, ...c.fromBufferAttribute(col, v).lerp(CHAR, 0.75).toArray());
    col.addUpdateRange(start * 3, 36);
  }
  col.needsUpdate = true;
  for (const t of treeGrid[cell] || []) trees.setColorAt(t[5], CHAR);
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
}

// Undo all scorching and rebuild burnt houses (start of a shift).
export function resetScorch(houses) {
  const col = terrain.geometry.attributes.color;
  col.array.set(terrainColors);
  col.clearUpdateRanges();
  col.needsUpdate = true;
  trees.instanceColor.array.set(treeColors);
  trees.instanceColor.needsUpdate = true;
  for (const h of houses) { h.burnt = false; h.mats.forEach((m, i) => m.color.setHex(h.colors[i])); }
}

function buildWater() {
  const SPAN = 4200, N = 120, STEP = SPAN / N;
  const g = new THREE.PlaneGeometry(SPAN, SPAN, N, N).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.6, metalness: 0, flatShading: true, transparent: true, opacity: 0.86 }));
  const base = g.attributes.position.array.slice();
  // Follows the camera in whole-cell steps so the edge never shows and waves don't swim.
  mesh.userData.update = (t, cam) => {
    mesh.position.x = Math.round(cam.x / STEP) * STEP;
    mesh.position.z = Math.round(cam.z / STEP) * STEP;
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      const x = base[i] + mesh.position.x, z = base[i + 2] + mesh.position.z;
      p[i + 1] = Math.sin(x * 0.03 + t * 0.9) * 0.35 + Math.sin(z * 0.041 - t * 1.2 + x * 0.01) * 0.3;
    }
    g.attributes.position.needsUpdate = true;
  };
  return mesh;
}

function buildSky() {
  const g = new THREE.SphereGeometry(4500, 32, 16), p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color(), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    c.copy(C.horizon).lerp(C.skyTop, smooth(0, 0.55, v.y));
    c.lerp(C.sun, Math.pow(Math.max(0, v.dot(SUN_DIR)), 24) * 0.9);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
}

function buildPad(at, withHangar) {
  const g = new THREE.Group(), mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const add = (geo, color, x, y, z) => { const m = new THREE.Mesh(geo, mat(color)); m.position.set(x, y, z); g.add(m); return m; };
  add(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 1, 1, 8), 0x5b5566, 0, -0.48, 0);
  for (const [w, d, x] of [[1.2, 7, -2.2], [1.2, 7, 2.2], [3.2, 1.2, 0]]) add(new THREE.BoxGeometry(w, 0.1, d), 0xffd27a, x, 0.05, 0);
  for (const [x, z] of [[-16, -12], [-12.5, -15]]) {       // fuel tanks: refuel by landing on the pad
    add(new THREE.CylinderGeometry(1.4, 1.4, 3.2, 8), 0xf4ede4, x, 1.6, z);
    add(new THREE.CylinderGeometry(1.45, 1.45, 0.5, 8), 0xd8452e, x, 2.2, z);
  }
  if (withHangar) {
    add(new THREE.BoxGeometry(12, 7, 16), 0xd9c4b0, -26, 3.5, 4);
    add(new THREE.CylinderGeometry(6.5, 6.5, 16.4, 6, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2), 0x2f7c7a, -26, 7, 4);
  }
  g.position.set(at.x, at.y, at.z);
  g.rotation.y = at.yaw;
  return g;
}

// Town or hospital: a pad plus a ring of houses. Returns the houses (for fire damage).
function buildSite(site, scene, houses) {
  const g = new THREE.Group(), lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const add = (geo, m, x, y, z, parent = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); parent.add(o); return o; };
  add(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 1, 1, 8), lam(site.hospital ? 0xf2ede6 : 0x5b5566), 0, -0.48, 0);
  if (site.hospital) for (const [w, d] of [[2, 8], [8, 2]]) add(new THREE.BoxGeometry(w, 0.1, d), lam(0xd8352a), 0, 0.05, 0);
  else for (const [w, d, x] of [[1.2, 7, -2.2], [1.2, 7, 2.2], [3.2, 1.2, 0]]) add(new THREE.BoxGeometry(w, 0.1, d), lam(0xffd27a), x, 0.05, 0);
  const rng = mulberry32(Math.floor(site.x * 7 + site.z));
  const count = site.hospital ? 1 : 4 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.4, r = site.hospital ? 24 : 21 + rng() * 6;
    const house = new THREE.Group(), walls = lam([0xf3e3c8, 0xe8c9a4, 0xd9e2d0, 0xf0d2c0][i % 4]), roof = lam(site.hospital ? 0xd8352a : 0xb5523b);
    const [w, h, d] = site.hospital ? [16, 8, 11] : [5 + rng() * 2, 3.5, 6 + rng() * 2];
    add(new THREE.BoxGeometry(w, h, d), walls, 0, h / 2, 0, house);
    add(new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 0.3, 2.5, 4).rotateY(Math.PI / 4).scale(w / Math.hypot(w, d) * 1.42, 1, d / Math.hypot(w, d) * 1.42), roof, 0, h + 1.25, 0, house);
    house.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    house.rotation.y = -a;
    g.add(house);
    const wp = house.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), site.yaw);
    houses.push({ x: site.x + wp.x, z: site.z + wp.z, mats: [walls, roof], colors: [walls.color.getHex(), roof.color.getHex()], site, burnt: false });
  }
  g.position.set(site.x, site.y, site.z);
  g.rotation.y = site.yaw;
  scene.add(g);
}

function buildRunway() {
  const g = new THREE.Group(), lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const add = (w, l, color, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), lam(color)); m.position.set(x, 0, z); g.add(m); return m; };
  add(RUNWAY.width, RUNWAY.len, 0x4a4652, 0, 0).position.y = 0.08;
  for (let z = -RUNWAY.len / 2 + 40; z < RUNWAY.len / 2 - 30; z += 30) add(0.8, 12, 0xf2ead8, 0, z).position.y = 0.12;  // centreline
  for (const end of [-1, 1]) for (let i = -5; i <= 5; i += 2) if (i) add(1.4, 18, 0xf2ead8, i * 1.3, end * (RUNWAY.len / 2 - 14)).position.y = 0.12; // thresholds
  for (const side of [-1, 1]) for (let z = -RUNWAY.len / 2; z <= RUNWAY.len / 2; z += 40) {                           // edge lights
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    m.position.set(side * (RUNWAY.width / 2 + 1), 0.3, z);
    g.add(m);
  }
  g.position.set(RUNWAY.x, RUNWAY.y, RUNWAY.z);
  g.rotation.y = Math.atan2(RUNWAY.dx, RUNWAY.dz);
  return g;
}

// Windsock beside the pad: points downwind, droops in light air.
function buildWindsock() {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 5).translate(0, 3, 0), new THREE.MeshLambertMaterial({ color: 0xd8d0c8 }));
  const pivot = new THREE.Group();
  pivot.position.y = 5.9;
  pivot.rotation.order = 'YXZ';
  pivot.add(new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.8, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.4), new THREE.MeshLambertMaterial({ color: 0xff6a2a, flatShading: true, side: THREE.DoubleSide })));
  pole.add(pivot);
  const side = PAD.yaw + Math.PI / 2;
  pole.position.set(PAD.x + Math.sin(side) * 15, PAD.y, PAD.z + Math.cos(side) * 15);
  pole.userData.update = (wind) => {
    const str = Math.hypot(wind.x, wind.z);
    pivot.rotation.y = Math.atan2(wind.x, wind.z);
    pivot.rotation.x = (1 - Math.min(1, str / 10)) * 1.2;
  };
  return pole;
}

export function buildWorld(scene) {
  scene.background = C.horizon;
  scene.fog = new THREE.Fog(C.horizon, 350, 2100);
  scene.add(new THREE.HemisphereLight(0xffd8c4, 0x6a4f6e, 1.5));
  const sun = new THREE.DirectionalLight(0xffc48e, 3.2);
  sun.position.copy(SUN_DIR);
  const sky = buildSky(), water = buildWater();
  const seabed = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: C.seabed }));
  seabed.position.y = FLOOR - 0.5;
  const windsock = buildWindsock();
  scene.add(sun, sky, seabed, buildTerrain(), buildTrees(), water, buildPad(PAD, true), buildPad(DEPOT, false), buildRunway(), windsock);
  const houses = [];
  for (const site of SITES) buildSite(site, scene, houses);
  return { sky, water, windsock, houses };
}
