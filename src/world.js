import * as THREE from 'three';
import { reflect } from './chopper.js';

export const SEED = 1337;           // fixed map seed: the career island stays learnable
export const SIZE = 2800;           // terrain square, metres
const SEGS = 280;                   // 10 m cells, ~157k triangles
const CELL = SIZE / SEGS, HALF = SIZE / 2;
export const SEA = 0;
const FLOOR = -18;

function mulberry32(a) {
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

function height(x, z) {
  const t = smooth(75, 35, Math.hypot(x - PAD.x, z - PAD.z));
  return rawHeight(x, z) * (1 - t) + PAD.y * t;
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
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

// Trees as cones in a coarse grid for collision: [x, z, baseY, height, radius].
const TREE_CELL = 25, TREE_COLS = Math.ceil(SIZE / TREE_CELL), treeGrid = [];
const BODY = 1.8; // chopper body radius

// Pushes the chopper out of any tree cone at skid-to-belly height; returns the closing speed.
export function hitTrees(pos, vel) {
  const cx = Math.floor((pos.x + HALF) / TREE_CELL), cz = Math.floor((pos.z + HALF) / TREE_CELL);
  let hit = 0;
  for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    for (const [x, z, y0, h, r0] of treeGrid[j * TREE_COLS + i] || []) {
      const y = pos.y + 0.8 - y0;
      if (y < 0 || y > h) continue;
      const r = r0 * (1 - y / h) + BODY, dx = pos.x - x, dz = pos.z - z, d = Math.hypot(dx, dz);
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
    if (Math.hypot(x - PAD.x, z - PAD.z) < 70) continue;
    const k = 0.7 + rng() * 0.8, sy = k * (0.8 + rng() * 0.5), cell = Math.floor((z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((x + HALF) / TREE_CELL);
    (treeGrid[cell] ||= []).push([x, z, y - 0.5, 9 * sy, 2.6 * k]);
    m.compose(p.set(x, y - 0.5, z), q.setFromAxisAngle(up, rng() * 6.28), s.set(k, sy, k));
    mesh.setMatrixAt(count, m);
    mesh.setColorAt(count++, col.copy(C.tree).multiplyScalar(0.8 + rng() * 0.4));
  }
  mesh.count = count;
  return mesh;
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

function buildBase() {
  const g = new THREE.Group(), mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 1, 8), mat(0x5b5566));
  pad.position.y = -0.48;
  const mark = mat(0xffd27a);
  const bar = (w, d, x, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), mark); b.position.set(x, 0.05, z); g.add(b); };
  bar(1.2, 7, -2.2, 0); bar(1.2, 7, 2.2, 0); bar(3.2, 1.2, 0, 0);
  const hangar = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 16), mat(0xd9c4b0));
  hangar.position.set(-26, 3.5, 4);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 16.4, 6, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2), mat(0x2f7c7a));
  roof.position.set(-26, 7, 4);
  g.add(pad, hangar, roof);
  g.position.set(PAD.x, PAD.y, PAD.z);
  g.rotation.y = PAD.yaw;
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
  scene.add(sun, sky, seabed, buildTerrain(), buildTrees(), water, buildBase(), windsock);
  return { sky, water, windsock };
}
