import * as THREE from 'three';
import { bodyBaker, GLASS, reflect, strut } from './chopper.js';

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

// Base height: a low stretch of main-island coast facing the sunset (the airstrip below was searched at this height).
export const SUN_DIR = new THREE.Vector3(-0.75, 0.22, -0.62).normalize();
const COAST = (() => {
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

// Airstrip for the water bomber: the straight 520 m strip near base needing the least cut-and-fill, found by a
// one-off search over this (fixed-seed) map. About a third of it is reclaimed from the sea, built up to base height.
// Takeoff runs toward the sea end so you climb out over water.
export const RUNWAY = (() => {
  const x = -358, z = -625, a = 1.7, len = 520, width = 30, dx = Math.sin(a), dz = Math.cos(a);
  const seaward = rawHeight(x + dx * 250, z + dz * 250) < rawHeight(x - dx * 250, z - dz * 250) ? 1 : -1;
  const fx = dx * seaward, fz = dz * seaward; // takeoff direction
  return { x, z, dx, dz, len, width, fx, fz, y: COAST.y, yaw: Math.atan2(-fx, -fz), start: { x: x - fx * (len / 2 - 30), z: z - fz * (len / 2 - 30) } };
})();
// Home base: helipad, hangar and fuel on an apron beside the landward end of the airstrip, where the bomber starts
// its run, joined to the runway by a taxiway. away = which side of the pad (+1 right, -1 left) faces away from the runway.
export const PAD = (() => {
  const R = RUNWAY, px = -R.dz, pz = R.dx; // across the runway
  const side = rawHeight(R.x + px * 100, R.z + pz * 100) > rawHeight(R.x - px * 100, R.z - pz * 100) ? 1 : -1, o = (R.width / 2 + 38) * side;
  const x = R.start.x + R.fx * 80 + px * o, z = R.start.z + R.fz * 80 + pz * o;
  return { x, z, y: R.y, yaw: R.yaw, away: Math.sign(Math.cos(R.yaw) * px * side - Math.sin(R.yaw) * pz * side) };
})();

// Fuel depot on the big western islet: the only other place to refuel.
const DEPOT = { x: ISLETS[0][0], z: ISLETS[0][1], y: Math.max(4, rawHeight(ISLETS[0][0], ISLETS[0][1])), yaw: PAD.yaw, away: -1 };
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

// Distance outside the runway rectangle (0 inside), expanded by margin.
const runwayGap = (x, z, margin = 0) => {
  const rx = x - RUNWAY.x, rz = z - RUNWAY.z, t = rx * RUNWAY.dx + rz * RUNWAY.dz, o = -rx * RUNWAY.dz + rz * RUNWAY.dx;
  return Math.hypot(Math.max(0, Math.abs(t) - RUNWAY.len / 2 - margin), Math.max(0, Math.abs(o) - RUNWAY.width / 2 - margin));
};
export const onRunway = (x, z) => runwayGap(x, z) === 0;
const FLATS = [...PADS, ...SITES];
// How fully the ground at (x, z) is levelled to pad p: dead flat over the pad and its ring of houses (the base
// apron, hangar and huts reach further), blending into the land beyond.
const flatness = (p, x, z) => (p === PAD ? smooth(110, 56, Math.hypot(x - p.x, z - p.z)) : smooth(80, 38, Math.hypot(x - p.x, z - p.z)));
export const PAD_RADIUS = 11;

// Pad-local offset (x right, z back) to world xz.
export const padLocal = (pad, lx, lz) => ({ x: pad.x + Math.cos(pad.yaw) * lx + Math.sin(pad.yaw) * lz, z: pad.z - Math.sin(pad.yaw) * lx + Math.cos(pad.yaw) * lz });

function height(x, z) {
  let y = rawHeight(x, z);
  // Craggy detail up high and gentle lumps on the lowland, so long slopes break into facets.
  y += (noise(x / 48 + 3, z / 48 - 8, 3) - 0.5) * 16 * smooth(40, 140, y) + (noise(x / 90 - 6, z / 90 + 2, 2) - 0.5) * 5 * smooth(2, 25, y);
  for (const p of FLATS) y = y * (1 - flatness(p, x, z)) + p.y * flatness(p, x, z);
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

// Roads: a minimum spanning tree over the base gate and the towns, each link routed by A* over a 20 m grid that prefers
// gentle, low ground and keeps out of the sea and off the runway. The grid path is then string-pulled into long straights
// (where the straight line stays on land at a gentle grade), corner-rounded, resampled every 4 m, and given a smoothed
// height profile that the terrain is cut to (the road bed).
const RC = 20, RN = SIZE / RC, rcx = (i) => ((i % RN) + 0.5) * RC - HALF, rcz = (i) => (Math.floor(i / RN) + 0.5) * RC - HALF;
// No-go for roads: the base apron, and the pads of towns this road isn't going to.
const offLimits = (x, z, a, b) => Math.hypot(x - PAD.x, z - PAD.z) < 46 || SITES.some((p) => p !== a && p !== b && Math.hypot(x - p.x, z - p.z) < 30);
function route(a, b) {
  const cell = (p) => Math.floor((p.z + HALF) / RC) * RN + Math.floor((p.x + HALF) / RC), start = cell(a), goal = cell(b);
  const g = new Float32Array(RN * RN).fill(Infinity), from = new Int32Array(RN * RN).fill(-1), heap = [[0, start]];
  const push = (n) => { heap.push(n); for (let i = heap.length - 1, p; i && heap[(p = (i - 1) >> 1)][0] > heap[i][0]; i = p) [heap[i], heap[p]] = [heap[p], heap[i]]; };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; for (let i = 0; ;) { let m = i; for (const c of [2 * i + 1, 2 * i + 2]) if (c < heap.length && heap[c][0] < heap[m][0]) m = c; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
    return top;
  };
  g[start] = 0;
  while (heap.length) {
    const [, i] = pop();
    if (i === goal) break;
    const y = heightAt(rcx(i), rcz(i));
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const ix = (i % RN) + dx, iz = Math.floor(i / RN) + dz, j = iz * RN + ix;
      if ((!dx && !dz) || ix < 0 || iz < 0 || ix >= RN || iz >= RN) continue;
      const x = rcx(j), z = rcz(j), ny = heightAt(x, z), len = Math.hypot(dx, dz) * RC, grade = Math.abs(ny - y) / len;
      if ((ny < 1.5 || offLimits(x, z, a, b)) && j !== goal) continue;
      const cost = g[i] + len * (1 + grade * grade * 120 + Math.max(0, ny - 70) * 0.03) * (runwayGap(x, z) < 12 ? 40 : 1);
      if (cost < g[j]) { g[j] = cost; from[j] = i; push([cost + Math.hypot(x - b.x, z - b.z), j]); }
    }
  }
  let pts = [];
  for (let i = goal; i >= 0; i = from[i]) pts.push([rcx(i), rcz(i)]);
  pts.reverse();
  pts[0] = [a.x, a.z]; pts[pts.length - 1] = [b.x, b.z];
  const clear = ([x0, z0], [x1, z1]) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 5);
    for (let i = 0, py = heightAt(x0, z0); i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n, y = heightAt(x, z);
      if ((y < 1.5 && i && i < n) || runwayGap(x, z) < 12 || offLimits(x, z, a, b) || Math.abs(y - py) > 0.6) return false;
      py = y;
    }
    return true;
  };
  const pulled = [pts[0]];
  for (let i = 0; i < pts.length - 1;) {
    let j = Math.min(pts.length - 1, i + 40);
    while (j > i + 1 && !clear(pts[i], pts[j])) j--;
    pulled.push(pts[(i = j)]);
  }
  pts = pulled;
  for (let k = 0; k < 4; k++) pts = [pts[0], ...pts.slice(0, -1).flatMap(([x0, z0], i) => { const [x1, z1] = pts[i + 1]; return [[x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25], [x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75]]; }), pts[pts.length - 1]]; // Chaikin
  const out = [];
  for (let i = 0, carry = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], d = Math.hypot(x1 - x0, z1 - z0);
    for (let t = carry; t < d; t += 4) out.push([x0 + ((x1 - x0) * t) / d, z0 + ((z1 - z0) * t) / d]);
    carry = (4 - ((d - carry) % 4)) % 4;
  }
  // Trim where the road reaches a town pad.
  return out.filter(([x, z]) => [a, b].every((p) => !p.name || Math.hypot(x - p.x, z - p.z) > PAD_RADIUS + 1));
}
const GATE = padLocal(PAD, 10 * PAD.away, 52); // just past the back of the apron, on the hangar side
export const ROADS = (() => {
  const nodes = [GATE, ...SITES], inTree = [nodes[0]], roads = [];
  while (inTree.length < nodes.length) { // Prim's
    let best = null;
    for (const a of inTree) for (const b of nodes) if (!inTree.includes(b)) { const d = Math.hypot(a.x - b.x, a.z - b.z); if (!best || d < best.d) best = { a, b, d }; }
    inTree.push(best.b);
    const r = route(best.a, best.b), spur = [...Array(6)].map((_, i) => { const p = padLocal(PAD, 10 * PAD.away, 28 + i * 4); return [p.x, p.z]; }); // apron edge to the gate
    roads.push(best.a === GATE ? [...spur, ...r] : best.b === GATE ? [...r, ...spur.reverse()] : r);
  }
  // Road bed: average each road's height over ±24 m, then pull terrain vertices within 16 m onto it.
  const target = new Map();
  for (const r of roads) {
    const ys = r.map(([x, z]) => heightAt(x, z));
    r.forEach((p, i) => { let t = 0, n = 0; for (let k = Math.max(0, i - 6); k <= Math.min(r.length - 1, i + 6); k++) { t += ys[k]; n++; } p[2] = t / n; });
    for (const [x, z, y] of r) {
      const i0 = Math.round((x + HALF) / CELL), j0 = Math.round((z + HALF) / CELL);
      for (let j = j0 - 2; j <= j0 + 2; j++) for (let i = i0 - 2; i <= i0 + 2; i++) {
        const d = Math.hypot(i * CELL - HALF - x, j * CELL - HALF - z), k = j * (SEGS + 1) + i, old = target.get(k);
        if (d < 16 && (!old || d < old.d)) target.set(k, { d, y });
      }
    }
  }
  // Pads win: the road bed never lifts or sinks the levelled ground round a pad. The road then rides the final ground.
  for (const [k, { d, y }] of target) {
    const x = (k % (SEGS + 1)) * CELL - HALF, z = Math.floor(k / (SEGS + 1)) * CELL - HALF;
    const t = smooth(16, 8, d) * (1 - Math.max(...FLATS.map((p) => flatness(p, x, z))));
    H[k] = H[k] * (1 - t) + y * t;
  }
  for (const r of roads) for (const p of r) p[2] = heightAt(p[0], p[1]);
  return roads;
})();
export const roadDist = (x, z) => Math.min(...ROADS.flat().map(([rx, rz]) => Math.hypot(rx - x, rz - z)));
const roadCells = new Set(ROADS.flat().map(([x, z]) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`));
const nearRoad = (x, z) => [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]].some(([dx, dz]) => roadCells.has(`${Math.floor((x + dx) / 10)},${Math.floor((z + dz) / 10)}`));

function buildRoads() {
  // One continuous strip per road: each point's edge pair sits across the averaged direction, so bends join cleanly.
  const pos = [];
  for (const r of ROADS) {
    const edges = r.map(([x, z, y], i) => {
      const [ax, az] = r[Math.max(0, i - 1)], [bx, bz] = r[Math.min(r.length - 1, i + 1)], d = Math.hypot(bx - ax, bz - az) || 1, nx = (-(bz - az) / d) * 3, nz = ((bx - ax) / d) * 3;
      return [[x - nx, z - nz], [x + nx, z + nz]].map(([ex, ez]) => [ex, Math.max(y, heightAt(ex, ez)) + 0.25, ez]);
    });
    for (let i = 0; i < edges.length - 1; i++) {
      const [a, b] = edges[i], [c, e] = edges[i + 1];
      pos.push(...a, ...b, ...e, ...a, ...e, ...c);
    }
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x6a6070, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
}

// Warm-dusk palette.
const C = {
  seabed: new THREE.Color(0xb98e6e), shallow: new THREE.Color(0xe2cf9e), reef: new THREE.Color(0x5fae9e), deep: new THREE.Color(0x2d5f78),
  foam: new THREE.Color(0xf6efe2), sand: new THREE.Color(0xeccb9c),
  lush: new THREE.Color(0x6e9a48), grass: new THREE.Color(0x86a052), dry: new THREE.Color(0xbfae5e), forest: new THREE.Color(0x56763a),
  rock: new THREE.Color(0x8d7584), rock2: new THREE.Color(0xa88e88), peak: new THREE.Color(0xf3e1d2), water: 0x3a8fa6,
  skyTop: new THREE.Color(0x2e3170), horizon: new THREE.Color(0xf2a07a), sun: new THREE.Color(0xffe2a8),
};
export const FOG = C.horizon;

// Forest cover (trees where > 0.5) and farmland: a patchwork of rotated plots on flat lowland outside the forests.
const forest = (x, z) => noise(x / 220 + 40, z / 220 - 9, 3);
const CROPS = [0xe0c05a, 0x9fbf5a, 0x7fa84a, 0xc9c26a, 0xd6a24e].map((c) => new THREE.Color(c));
function crop(x, z, y, ny) {
  if (y < 4 || y > 70 || ny < 0.93 || forest(x, z) > 0.45 || noise(x / 300 - 31, z / 300 + 17, 2) < 0.5) return -1;
  const i = Math.floor((x * 0.8 + z * 0.6) / 55), j = Math.floor((z * 0.8 - x * 0.6) / 40);
  return Math.floor(noise(i * 3, j * 5, 1) * CROPS.length);
}

function biome(y, ny, x, z, out) {
  const c = crop(x, z, y, ny);
  if (y < SEA - 0.6) out.copy(C.shallow).lerp(C.reef, smooth(-0.6, -5, y)).lerp(C.deep, smooth(-5, -16, y)); // shallows glow through the water
  else if (y < SEA + 0.5) out.copy(C.foam);                                                                  // surf line where the waves lap
  else if (y < SEA + 1.2 + 2.4 * noise(x / 90 + 13, z / 90, 2) && ny > 0.8) out.copy(C.sand);
  else if (y > 185 + 20 * noise(x / 70, z / 70, 2)) out.copy(C.peak);
  else if (ny < 0.72 || y > 140) out.copy(C.rock).lerp(C.rock2, Math.sin(y * 0.45 + noise(x / 60, z / 60, 1) * 5) > 0.2 ? 0.7 : 0); // banded cliffs
  else if (c >= 0) out.copy(CROPS[c]);
  else {
    out.copy(C.grass).lerp(C.lush, smooth(40, 5, y) * 0.8).lerp(C.dry, smooth(0.4, 0.7, noise(x / 160 - 20, z / 160 + 4, 2)));
    if (forest(x, z) >= 0.5 && y > 3 && y < 120) out.lerp(C.forest, 0.75); // forest floor, so woods read as masses
  }
  return out.multiplyScalar(0.94 + Math.random() * 0.1);
}

let terrain, terrainColors; // kept for scorching and resetting
const treeMeshes = [];

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

// Trees (and farmhouses) as cones in a 20 m grid (same cells as the fire sim): [x, z, baseY, height, radius, kind, instance].
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

// Instanced kinds, one draw call each: { geometry, collision height and radius, max count }.
function treeKinds() {
  const TRUNK = 0x6b4a3a, kind = (fill, h, r, max) => { const b = bodyBaker(); fill(b); return { geo: b.geometry(), h, r, max, list: [] }; };
  return [
    kind((b) => { // conifer
      b.add(new THREE.CylinderGeometry(0.25, 0.35, 2, 5), TRUNK, 0, 1, 0);
      b.add(new THREE.ConeGeometry(2.6, 6, 6), 0x3f6b3c, 0, 4.5, 0);
      b.add(new THREE.ConeGeometry(1.8, 4.5, 6), 0x4a7a44, 0, 7, 0);
    }, 9, 2.6, 2600),
    kind((b) => { // broadleaf
      b.add(new THREE.CylinderGeometry(0.3, 0.45, 3.4, 5), TRUNK, 0, 1.7, 0);
      b.add(new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.8, 1), 0x5f8f3e, 0, 5, 0);
      b.add(new THREE.IcosahedronGeometry(1.9, 0), 0x78a24c, 1.3, 6.4, 0.6);
    }, 8, 3, 1600),
    kind((b) => { // palm: leaning trunk, six drooping fronds
      b.add(new THREE.CylinderGeometry(0.2, 0.32, 7.5, 5).rotateZ(0.12), 0x9a7a55, -0.45, 3.7, 0);
      for (let k = 0; k < 6; k++) b.add(new THREE.ConeGeometry(0.55, 4, 3).rotateZ(-Math.PI / 2 - 0.45).translate(1.8, -0.8, 0).rotateY((k * Math.PI) / 3 + 0.3), k % 2 ? 0x4f8a3e : 0x5f9a46, -0.9, 7.4, 0);
    }, 8, 1.6, 400),
    kind((b) => { // farmhouse with a barn
      house(b, 6, 8, 0xf0e2c8, 0xb5523b, mulberry32(9));
      b.add(new THREE.BoxGeometry(5, 4.2, 6), 0xa8443a, 7.5, 2.1, 1);
      for (let y = 0.8; y < 4; y += 0.7) b.add(new THREE.BoxGeometry(5.06, 0.06, 6.06), 0x8a3730, 7.5, y, 1);
      b.add(new THREE.BoxGeometry(0.08, 3, 2.6), TRIM, 10.03, 1.5, 1);
      b.add(new THREE.CylinderGeometry(0, 3.8, 2, 4, 1).rotateY(Math.PI / 4).scale(0.95, 1, 1.15), 0x5b5566, 7.5, 5.2, 1);
    }, 7, 5, 60),
  ];
}

function buildTrees() {
  const rng = mulberry32(SEED + 1), kinds = treeKinds();
  for (let tries = 0; tries < 90000; tries++) {
    const x = (rng() - 0.5) * SIZE, z = (rng() - 0.5) * SIZE, y = heightAt(x, z), roll = rng(), f = forest(x, z);
    if (y < 2.5 || y > 120) continue;
    if (Math.abs(heightAt(x + 4, z) - y) + Math.abs(heightAt(x, z + 4) - y) > 4) continue;
    if (FLATS.some((p) => Math.hypot(x - p.x, z - p.z) < 70) || runwayGap(x, z) < 25 || [LIGHTHOUSE, ...TOWERS].some((p) => Math.hypot(x - p.x, z - p.z) < 25) || nearRoad(x, z)) continue;
    const k = crop(x, z, y, 1) >= 0 ? (roll < 0.05 ? 3 : -1)           // farmland: the odd farmhouse
      : f >= 0.5 ? (roll < smooth(60, 15, y) * 0.6 ? 1 : 0)           // forest: broadleaf low down, conifers up high
      : y < 8 ? (roll < 0.5 ? 2 : -1)                                 // coast: palms
      : f > 0.38 && roll < 0.1 ? 1 : -1;                              // lone trees at the forest edges
    if (k < 0 || kinds[k].list.length >= kinds[k].max) continue;
    kinds[k].list.push([x, z, y - 0.4, rng() * 6.28, 0.7 + rng() * 0.6]);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  return kinds.map(({ geo, h, r, list }, kind) => {
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
    list.forEach(([x, z, y, yaw, sc], i) => {
      const sy = kind === 3 ? 1 : sc * (0.85 + rng() * 0.4), sxz = kind === 3 ? 1 : sc;
      (treeGrid[Math.floor((z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((x + HALF) / TREE_CELL)] ||= []).push([x, z, y, h * sy, r * sxz, kind, i]);
      mesh.setMatrixAt(i, m.compose(p.set(x, y, z), q.setFromAxisAngle(up, yaw), s.set(sxz, sy, sxz)));
      mesh.setColorAt(i, col.setScalar(0.85 + rng() * 0.3));
    });
    mesh.userData.colors = mesh.instanceColor.array.slice();
    treeMeshes.push(mesh);
    return mesh;
  });
}

// Boulders scattered over the rocky ground and beaches (scenery only).
function buildRocks() {
  const rng = mulberry32(SEED + 3), mesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0x9a8590, flatShading: true }), 500);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler(), col = new THREE.Color();
  let n = 0;
  for (let tries = 0; tries < 20000 && n < mesh.count; tries++) {
    const x = (rng() - 0.5) * SIZE, z = (rng() - 0.5) * SIZE, y = heightAt(x, z), slope = Math.abs(heightAt(x + 4, z) - y) + Math.abs(heightAt(x, z + 4) - y);
    if (y < 0.5 || (slope < 2.5 && rng() > 0.08) || FLATS.some((f) => Math.hypot(x - f.x, z - f.z) < 60) || runwayGap(x, z) < 20 || nearRoad(x, z)) continue;
    const r = 0.8 + rng() ** 2 * 4;
    mesh.setMatrixAt(n, m.compose(p.set(x, y - r * 0.3, z), q.setFromEuler(e.set(rng() * 3, rng() * 3, rng() * 3)), s.set(r, r * (0.5 + rng() * 0.4), r * (0.8 + rng() * 0.4))));
    mesh.setColorAt(n++, col.setScalar(0.85 + rng() * 0.3));
  }
  mesh.count = n;
  return mesh;
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
  for (const t of treeGrid[cell] || []) if (t[5] >= 0) { treeMeshes[t[5]].setColorAt(t[6], CHAR); treeMeshes[t[5]].instanceColor.needsUpdate = true; }
}

// Undo all scorching and rebuild burnt houses (start of a shift).
export function resetScorch(houses) {
  const col = terrain.geometry.attributes.color;
  col.array.set(terrainColors);
  col.clearUpdateRanges();
  col.needsUpdate = true;
  for (const t of treeMeshes) { t.instanceColor.array.set(t.userData.colors); t.instanceColor.needsUpdate = true; }
  for (const h of houses) { h.burnt = false; h.mats.forEach((m, i) => m.color.setHex(h.colors[i])); }
}

function buildWater() {
  const SPAN = 4200, N = 120, STEP = SPAN / N;
  const g = new THREE.PlaneGeometry(SPAN, SPAN, N, N).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.6, metalness: 0, flatShading: true, transparent: true, opacity: 0.78 }));
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

// Pad with fuel tanks (one merged mesh). Home also gets the apron, a taxiway to the runway and the hangar, all laid
// out on the side away from the runway (k mirrors the layout).
function buildPad(at, home) {
  const b = bodyBaker(), k = -at.away, flat = (w, d, color, x, z, y = 0.05) => b.add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), color, x, y, z);
  b.add(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 1, 1, 8), 0x5b5566, 0, -0.38, 0);
  for (const [w, d, x] of [[1.2, 7, -2.2], [1.2, 7, 2.2], [3.2, 1.2, 0]]) b.add(new THREE.BoxGeometry(w, 0.1, d), 0xffd27a, x, 0.15, 0);
  for (const [x, z] of [[-16, -12], [-12.5, -15]]) {       // fuel tanks: refuel by landing on the pad
    b.add(new THREE.CylinderGeometry(1.4, 1.4, 3.2, 8), 0xf4ede4, x * k, 1.6, z);
    b.add(new THREE.CylinderGeometry(1.45, 1.45, 0.5, 8), 0xd8452e, x * k, 2.2, z);
  }
  if (home) {
    flat(56, 50, 0x6e6874, -6 * k, 2);                                     // apron
    flat(22, 14, 0x6e6874, 32 * k, 0, 0.04);                               // taxiway to the runway edge
    for (let x = 24; x < 40; x += 4) flat(2, 0.5, 0xffd27a, x * k, 0, 0.07); // taxi line
    b.add(new THREE.BoxGeometry(5, 3.2, 6), 0xf3e3c8, -24 * k, 1.6, -16);  // ops hut with a control cab
    b.add(new THREE.BoxGeometry(3, 2, 3), 0x1f3346, -24 * k, 4.2, -16);
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), g = new THREE.Group();
  g.add(new THREE.Mesh(b.geometry(), mat));
  if (home) { // the hangar is built door-forward along +x, so it's turned round when the layout is mirrored
    const h = new THREE.Mesh(baked(hangar), mat);
    h.position.set(-33 * k, 0, 3);
    h.rotation.y = k > 0 ? 0 : Math.PI;
    g.add(h);
  }
  g.position.set(at.x, at.y, at.z);
  g.rotation.y = at.yaw;
  return g;
}
const baked = (fill) => { const b = bodyBaker(); fill(b); return b.geometry(); };

// Arched maintenance hangar, ground at y = 0, door end facing +x: corrugated cladding with ribs, an arched roof with
// rib bands and ridge vents, three sliding door panels (one run back to show the dark bay), a glazed gable with an
// orange sign band, a lean-to office on the -z side, downpipes and floodlights. About 18 m long, 16 m wide.
export function hangar(b) {
  const L = 18, W = 16, H = 6, R = W / 2, CLAD = 0xd9c4b0, RIB = shade(CLAD, 0.82), ROOF = 0x2f7c7a, STEEL = 0x5b5566, ORANGE = 0xf2763a;
  const arc = (r, len, color, x) => b.add(new THREE.CylinderGeometry(r, r, len, 16, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), color, x, H + 0.3, 0);
  b.add(new THREE.BoxGeometry(L + 3, 0.3, W + 2), 0x8f8790, 0.5, 0.15, 0);                                   // slab, lipped at the door
  for (const sz of [-1, 1]) {
    b.add(new THREE.BoxGeometry(L, H, 0.3), CLAD, 0, H / 2 + 0.3, sz * W / 2);                             // side walls
    for (let x = -L / 2 + 0.75; x < L / 2; x += 1.5) b.add(new THREE.BoxGeometry(0.14, H, 0.12), RIB, x, H / 2 + 0.3, sz * (W / 2 + 0.16));
    for (const x of [-5, 0, 5]) windowAt(b, 'z', sz, x, H - 0.9, sz * (W / 2 + 0.2), 2.2, 0.8);
    for (const x of [-L / 2 + 0.3, L / 2 - 0.3]) b.add(new THREE.CylinderGeometry(0.12, 0.12, H, 6), STEEL, x, H / 2 + 0.3, sz * (W / 2 + 0.3)); // downpipes
  }
  b.add(new THREE.BoxGeometry(0.3, H, W), CLAD, -L / 2, H / 2 + 0.3, 0);                                    // back wall
  arc(R, L + 0.6, ROOF, 0);                                                                                 // arched roof
  for (let x = -L / 2; x <= L / 2 + 0.01; x += 3) arc(R + 0.1, 0.3, 0x25605e, x);                           // rib bands
  for (const x of [-5, 0, 5]) b.add(new THREE.BoxGeometry(1.2, 0.7, 1.2), STEEL, x, H + 0.3 + R + 0.2, 0);  // ridge vents
  for (const [sx, rot] of [[1, Math.PI / 2], [-1, -Math.PI / 2]]) b.add(new THREE.CircleGeometry(R, 16, 0, Math.PI).rotateY(rot), CLAD, sx * L / 2, H + 0.3, 0); // gables
  b.add(new THREE.BoxGeometry(0.12, 0.6, W), ORANGE, L / 2 + 0.06, H + 0.6, 0);                            // sign band
  b.add(new THREE.BoxGeometry(0.1, 1.2, 9), GLASS, L / 2 + 0.06, H + 2.4, 0);                               // gable glazing
  for (let z = -4.5; z <= 4.5; z += 1.5) b.add(new THREE.BoxGeometry(0.16, 1.3, 0.1), TRIM, L / 2 + 0.08, H + 2.4, z);
  // Door end: corner wall pieces, a dark bay behind, two closed panels and one run back to open the bay.
  for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.3, H, 2), CLAD, L / 2, H / 2 + 0.3, sz * 7);
  b.add(new THREE.BoxGeometry(0.1, H, W - 1), 0x2a2a32, L / 2 - 2.5, H / 2 + 0.3, 0);
  b.add(new THREE.BoxGeometry(0.3, 0.3, W), 0x2a2a32, L / 2 + 0.3, H + 0.15, 0);                           // door track
  for (const [x, z] of [[L / 2 + 0.15, -4], [L / 2 + 0.15, 0], [L / 2 + 0.45, 1.6]]) {
    b.add(new THREE.BoxGeometry(0.2, H - 0.3, 4), shade(CLAD, 0.92), x, (H - 0.3) / 2 + 0.3, z);
    for (let y = 1.2; y < H; y += 1.1) b.add(new THREE.BoxGeometry(0.24, 0.08, 4.02), RIB, x, y, z);
  }
  // Lean-to office on the -z side: flat roof, windows, a door.
  b.add(new THREE.BoxGeometry(8, 3.2, 4), shade(CLAD, 1.04), -3, 1.9, -W / 2 - 2);
  b.add(new THREE.BoxGeometry(8.6, 0.25, 4.6), STEEL, -3, 3.6, -W / 2 - 2);
  for (const x of [-5.5, -3.5, -1.5]) windowAt(b, 'z', -1, x, 2.2, -W / 2 - 4, 1.2, 0.9);
  b.add(new THREE.BoxGeometry(1, 2, 0.1), WOOD, 0.2, 1.3, -W / 2 - 4.03);
  // Floodlights on poles at the door corners, angled at the apron.
  for (const sz of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.1, 0.14, 7.5, 6), STEEL, L / 2 + 1.2, 3.75, sz * (W / 2 + 0.8));
    b.add(new THREE.BoxGeometry(0.8, 0.5, 1).rotateZ(-0.5), 0x2a2a32, L / 2 + 1.5, 7.5, sz * (W / 2 + 0.8));
    b.add(new THREE.BoxGeometry(0.1, 0.4, 0.8).rotateZ(-0.5), 0xfff2b0, L / 2 + 1.75, 7.35, sz * (W / 2 + 0.8));
  }
}

const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();
const TRIM = 0xf6efe6, STONE = 0x8f8790, WOOD = 0x6b4a3a;
// Window: white frame, dark glass, on a wall facing +x/-x (axis 'x') or +z/-z (axis 'z'), outward sign s.
function windowAt(b, axis, s, x, y, z, w = 1, h = 1) {
  const [fx, fz] = axis === 'x' ? [0.08, w + 0.24] : [w + 0.24, 0.08], [gx, gz] = axis === 'x' ? [0.1, w] : [w, 0.1];
  const ox = axis === 'x' ? s * 0.04 : 0, oz = axis === 'z' ? s * 0.04 : 0;
  b.add(new THREE.BoxGeometry(fx, h + 0.24, fz), TRIM, x + ox, y, z + oz);
  b.add(new THREE.BoxGeometry(gx, h, gz), GLASS, x + ox * 1.6, y, z + oz * 1.6);
}
// A gabled house in the cabin's style, ground at y = 0, front (door and porch) facing -x, ridge along z.
// Plank-banded walls, corner posts, framed windows, a porch, an overhanging roof with a ridge beam and a chimney.
export function house(b, w, d, wall, roof, rng, ox = 0, oz = 0) {
  const h = 3.2, top = 0.4 + h, p = 0.55, s = w / 2 + 0.5, L = s / Math.cos(p);
  b.add(new THREE.BoxGeometry(w + 0.4, 0.4, d + 0.4), STONE, ox, 0.2, oz);
  b.add(new THREE.BoxGeometry(w, h, d), wall, ox, 0.4 + h / 2, oz);
  for (let y = 0.9; y < top - 0.2; y += 0.55) b.add(new THREE.BoxGeometry(w + 0.06, 0.06, d + 0.06), shade(wall, 0.86), ox, y, oz); // planks
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.24, h, 0.24), TRIM, ox + sx * w / 2, 0.4 + h / 2, oz + sz * d / 2);
  b.add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, (w / 2) * Math.tan(p))]), { depth: d, bevelEnabled: false }), wall, ox, top, oz - d / 2);
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(L, 0.16, d + 0.9).rotateZ(-sx * p), roof, ox + sx * s / 2, top + (w / 2 - s / 2) * Math.tan(p) + 0.1, oz);
    for (let z = -d / 2; z <= d / 2 + 0.01; z += d / 4) b.add(new THREE.BoxGeometry(L, 0.06, 0.12).rotateZ(-sx * p), shade(roof, 0.8), ox + sx * s / 2, top + (w / 2 - s / 2) * Math.tan(p) + 0.19, oz + z); // seams
  }
  b.add(new THREE.BoxGeometry(0.26, 0.2, d + 1), shade(roof, 0.55), ox, top + (w / 2) * Math.tan(p) + 0.12, oz); // ridge
  const cz = oz + (rng() < 0.5 ? -1 : 1) * d * 0.25;
  b.add(new THREE.BoxGeometry(0.7, 2.6, 0.7), STONE, ox + w * 0.22, top + 1.1, cz);                                   // chimney
  b.add(new THREE.BoxGeometry(0.9, 0.16, 0.9), shade(STONE, 0.7), ox + w * 0.22, top + 2.45, cz);
  // Front: door under a porch roof on two posts; windows down both sides and on the back.
  b.add(new THREE.BoxGeometry(0.1, 2.1, 1.2), TRIM, ox - w / 2 - 0.03, 1.45, oz);
  b.add(new THREE.BoxGeometry(0.12, 1.9, 0.95), WOOD, ox - w / 2 - 0.06, 1.35, oz);
  windowAt(b, 'x', -1, ox - w / 2, 2.2, oz + d * 0.3);
  b.add(new THREE.BoxGeometry(1.8, 0.2, d * 0.6), shade(WOOD, 1.3), ox - w / 2 - 0.9, 0.4, oz);                      // porch deck
  for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.16, 2.6, 0.16), TRIM, ox - w / 2 - 1.65, 1.8, oz + sz * d * 0.28);
  b.add(new THREE.BoxGeometry(2.2, 0.12, d * 0.66).rotateZ(0.25), roof, ox - w / 2 - 0.95, 3.3, oz);
  for (const sz of [-1, 1]) for (const f of [-0.25, 0.25]) windowAt(b, 'z', sz, ox + f * w, 2.2, oz + sz * d / 2);
  windowAt(b, 'x', 1, ox + w / 2, 2.2, oz);
}
// Hospital: two storeys, rows of windows, a flat roof with a parapet and a red cross, an entrance canopy facing -x.
export function hospital(b) {
  const w = 12, d = 18, h = 7.6;
  b.add(new THREE.BoxGeometry(w + 0.4, 0.4, d + 0.4), STONE, 0, 0.2, 0);
  b.add(new THREE.BoxGeometry(w, h, d), 0xf3ede4, 0, 0.4 + h / 2, 0);
  b.add(new THREE.BoxGeometry(w + 0.1, 0.5, d + 0.1), 0xd8352a, 0, 4.1, 0); // stripe between the floors
  for (const y of [2.2, 6]) {
    for (let z = -d / 2 + 2; z <= d / 2 - 1.9; z += 2.8) for (const sx of [-1, 1]) if (!(sx < 0 && y < 3 && Math.abs(z) < 2)) windowAt(b, 'x', sx, sx * w / 2, y, z, 1.4, 1.3);
    for (const sz of [-1, 1]) for (const x of [-3, 0, 3]) windowAt(b, 'z', sz, x, y, sz * d / 2, 1.4, 1.3);
  }
  b.add(new THREE.BoxGeometry(w + 0.6, 0.3, d + 0.6), 0xd9d2c8, 0, h + 0.55, 0);
  for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(0.3, 0.7, d + 0.6), 0xd9d2c8, sx * (w / 2 + 0.15), h + 0.9, 0);
  for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(w + 0.6, 0.7, 0.3), 0xd9d2c8, 0, h + 0.9, sz * (d / 2 + 0.15));
  for (const [cw, cd] of [[1.2, 4.4], [4.4, 1.2]]) b.add(new THREE.BoxGeometry(cw, 0.1, cd), 0xd8352a, 0, h + 0.75, 0);
  b.add(new THREE.BoxGeometry(0.1, 2.4, 2.6), GLASS, -w / 2 - 0.05, 1.6, 0);                                     // doors
  b.add(new THREE.BoxGeometry(3, 0.25, 5), TRIM, -w / 2 - 1.5, 3.3, 0);                                          // canopy
  for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.2, 2.9, 0.2), 0xd8352a, -w / 2 - 2.8, 1.85, sz * 2.2);
  b.add(new THREE.BoxGeometry(2.2, 1.8, 2.2), 0xb8b0b8, 2.5, h + 1.3, -5);                                       // plant room
}

// Town or hospital: a pad plus a ring of houses, each one merged mesh with its own material so fire can char it.
// Returns the houses (for fire damage).
function buildSite(site, scene, houses) {
  const g = new THREE.Group(), pad = bodyBaker();
  pad.add(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 1, 1, 8), site.hospital ? 0xf2ede6 : 0x5b5566, 0, -0.48, 0);
  if (site.hospital) for (const [w, d] of [[2, 8], [8, 2]]) pad.add(new THREE.BoxGeometry(w, 0.1, d), 0xd8352a, 0, 0.05, 0);
  else for (const [w, d, x] of [[1.2, 7, -2.2], [1.2, 7, 2.2], [3.2, 1.2, 0]]) pad.add(new THREE.BoxGeometry(w, 0.1, d), 0xffd27a, x, 0.05, 0);
  g.add(new THREE.Mesh(pad.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  const rng = mulberry32(Math.floor(site.x * 7 + site.z));
  const count = site.hospital ? 1 : 4 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    let a = (i / count) * Math.PI * 2 + rng() * 0.4;
    const r = site.hospital ? 24 : 21 + rng() * 6;
    // Nudge round the ring until clear of the road coming in (houses are ~8 m across, the road 6 m wide).
    const world = (a) => ({ x: site.x + Math.cos(site.yaw) * Math.cos(a) * r + Math.sin(site.yaw) * Math.sin(a) * r, z: site.z - Math.sin(site.yaw) * Math.cos(a) * r + Math.cos(site.yaw) * Math.sin(a) * r });
    for (let k = 0; k < 12 && roadDist(world(a).x, world(a).z) < (site.hospital ? 16 : 11); k++) a += 0.2;
    const b = bodyBaker(), mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    if (site.hospital) hospital(b);
    else house(b, 5 + rng() * 2, 6 + rng() * 2, [0xf3e3c8, 0xe8c9a4, 0xd9e2d0, 0xf0d2c0][i % 4], [0xb5523b, 0x8e3829, 0x5b5566, 0x2f7c7a][Math.floor(rng() * 4)], rng);
    const mesh = new THREE.Mesh(b.geometry(), mat);
    mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    mesh.rotation.y = -a; // front faces the pad
    g.add(mesh);
    const wp = mesh.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), site.yaw);
    houses.push({ x: site.x + wp.x, z: site.z + wp.z, mats: [mat], colors: [0xffffff], site, burnt: false });
  }
  g.position.set(site.x, site.y, site.z);
  g.rotation.y = site.yaw;
  scene.add(g);
}

function buildRunway() {
  const b = bodyBaker(), add = (w, l, color, x, y, z) => b.add(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), color, x, y, z);
  add(RUNWAY.width, RUNWAY.len, 0x4a4652, 0, 0.08, 0);
  for (let z = -RUNWAY.len / 2 + 40; z < RUNWAY.len / 2 - 30; z += 30) add(0.8, 12, 0xf2ead8, 0, 0.12, z);  // centreline
  for (const end of [-1, 1]) for (let i = -5; i <= 5; i += 2) if (i) add(1.4, 18, 0xf2ead8, i * 1.3, 0.12, end * (RUNWAY.len / 2 - 14)); // thresholds
  for (const side of [-1, 1]) for (let z = -RUNWAY.len / 2; z <= RUNWAY.len / 2; z += 40) b.add(new THREE.BoxGeometry(0.4, 0.4, 0.4), 0xffd27a, side * (RUNWAY.width / 2 + 1), 0.3, z); // edge lights
  const g = new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x201810 }));
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
  const at = padLocal(PAD, 22 * -PAD.away, 16); // between the pad and the runway
  pole.position.set(at.x, PAD.y, at.z);
  pole.userData.update = (wind) => {
    const str = Math.hypot(wind.x, wind.z);
    pivot.rotation.y = Math.atan2(wind.x, wind.z);
    pivot.rotation.x = (1 - Math.min(1, str / 10)) * 1.2;
  };
  return pole;
}

// Lighthouse at the tip of a stone breakwater, off a low stretch of coast far from base, so its beam sweeps open sea.
export const LIGHTHOUSE = (() => {
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.02) {
    const dx = Math.cos(a), dz = Math.sin(a);
    let r = 1300;
    while (r > 0 && height(dx * r, dz * r) < 1) r -= 5;
    const len = 80, x = dx * (r + len), z = dz * (r + len);
    if ([40, 80, 120, 160, 220].some((k) => !(height(dx * (r - k), dz * (r - k)) > 1 && height(dx * (r - k), dz * (r - k)) < 22)) || height(x, z) > -3) continue; // low land behind, open water ahead
    if (SITES.some((p) => Math.hypot(p.x - x, p.z - z) < 200)) continue;
    const score = Math.hypot(x - PAD.x, z - PAD.z);
    if (!best || score > best.score) best = { x, z, y: SEA, len, score, yaw: Math.atan2(-dx, -dz) }; // local +z points back to shore
  }
  return best;
})();
function buildLighthouse() {
  const L = LIGHTHOUSE, g = new THREE.Group(), b = bodyBaker(), rng = mulberry32(SEED + 5), STONE = 0x8f8790;
  b.add(new THREE.BoxGeometry(6, 9, L.len + 20), STONE, 0, -3, L.len / 2 + 6);                          // breakwater, running into the beach
  for (let z = 4; z < L.len + 10; z += 3.5) for (const side of [-1, 1])                                   // armour stones along both sides
    b.add(new THREE.DodecahedronGeometry(1.4 + rng() * 0.8, 0), rng() < 0.5 ? 0x9a8f96 : 0x7d7480, side * (3.2 + rng() * 0.6), 0.2 + rng() * 0.6, z);
  b.add(new THREE.CylinderGeometry(5, 5.6, 9, 10), STONE, 0, -3, 0);                                    // round plinth at the tip
  b.add(new THREE.CylinderGeometry(1.5, 2.3, 15, 8, 6), (x, y) => (Math.floor((y - 1.5) / 2.5) % 2 ? 0xd8352a : 0xf6efe6), 0, 9, 0);
  b.add(new THREE.CylinderGeometry(2.4, 2.4, 0.4, 8), 0x2a2a32, 0, 16.7, 0);
  b.add(new THREE.ConeGeometry(1.7, 1.8, 8), 0xd8352a, 0, 19.8, 0);
  b.add(new THREE.BoxGeometry(3.6, 2.6, 4), 0xf3e3c8, 0, 2.8, 12);                                       // keeper's hut
  b.add(new THREE.CylinderGeometry(0, 3, 1.4, 4, 1).rotateY(Math.PI / 4).scale(0.9, 1, 1), 0x5b5566, 0, 4.8, 12);
  g.add(new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2, 8), new THREE.MeshBasicMaterial({ color: 0xfff2b0 }));
  lamp.position.y = 17.9;
  const beam = new THREE.Group(), beamMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  beam.add(new THREE.Mesh(new THREE.ConeGeometry(6, 160, 10, 1, true).translate(0, -80, 0).rotateZ(Math.PI / 2), beamMat));
  beam.position.y = 17.9;
  beam.rotation.z = 0.05;
  g.add(lamp, beam);
  g.position.set(L.x, L.y, L.z);
  g.rotation.y = L.yaw;
  (treeGrid[Math.floor((L.z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((L.x + HALF) / TREE_CELL)] ||= []).push([L.x, L.z, L.y, 21, 5.5, -1, -1]);
  // Sector light: the beam fades out while it points back over the land (local +z is the shore).
  g.userData.update = (t) => { beam.rotation.y = t * 0.8; beamMat.opacity = 0.08 * smooth(-0.1, 0.5, Math.sin(beam.rotation.y)); };
  return g;
}

// ---- Island projects: bought in the hangar, built into the world (hidden until owned). ----

// Where they go. The pond, workshop and fuel farm sit on the base's flat ground (pad-local, hangar side);
// lookout towers on three high, flat-ish spots far apart; town refuel stations beside each town pad, clear of houses.
export const POND = { ...padLocal(PAD, 8 * PAD.away, -42), y: PAD.y + 1.6, r: 8 }; // dip tank: water surface a bucket can dip in
const FUEL_FARM = padLocal(PAD, 28 * PAD.away, -36);
export const TOWERS = (() => {
  // Rank a grid of high, open spots (height minus roughness), then take the best three at least 450 m apart.
  const cand = [], rng = mulberry32(SEED + 6);
  for (let z = -900; z <= 900; z += 30) for (let x = -900; x <= 900; x += 30) {
    const y = heightAt(x, z), legs = [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]].map(([dx, dz]) => heightAt(x + dx, z + dz));
    const rough = Math.max(...legs) - Math.min(...legs);
    if (y < 60 || y > 190 || rough > 3 || roadDist(x, z) < 30 || FLATS.some((p) => Math.hypot(p.x - x, p.z - z) < 250)) continue;
    cand.push({ x, z, y: Math.min(...legs), score: y - rough * 15 });
  }
  const out = [];
  for (const c of cand.sort((a, b) => b.score - a.score)) if (out.length < 3 && out.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 450)) out.push({ ...c, yaw: rng() * Math.PI * 2 });
  return out;
})();
const STEEL = 0x5b5566, RED = 0xd8352a, YELLOW = 0xf2c230;

// Town refuel station: slab, two tanks on cradles, a pump under a canopy.
export function station(b) {
  b.add(new THREE.BoxGeometry(7, 0.25, 5), 0x8f8790, 0, 0.12, 0);
  for (const z of [-1.2, 1.2]) {
    b.add(new THREE.CylinderGeometry(1, 1, 4, 10).rotateZ(Math.PI / 2), 0xf4ede4, -1.2, 1.35, z);
    b.add(new THREE.CylinderGeometry(1.03, 1.03, 0.4, 10).rotateZ(Math.PI / 2), RED, -1.2, 1.35, z);
    for (const x of [-2.6, 0.2]) b.add(new THREE.BoxGeometry(0.3, 0.5, 1.6), STEEL, x, 0.5, z);
  }
  b.add(new THREE.BoxGeometry(0.8, 1.4, 0.6), RED, 2.2, 0.95, 0);                 // pump
  b.add(new THREE.BoxGeometry(0.5, 0.4, 0.05), 0xfff2b0, 2.2, 1.3, 0.33);
  for (const z of [-1.8, 1.8]) b.add(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), STEEL, 2.9, 1.6, z);
  b.add(new THREE.BoxGeometry(2.4, 0.2, 4.4), 0xf6efe6, 2.6, 3.2, 0);              // canopy
  b.add(new THREE.BoxGeometry(2.44, 0.12, 4.44), RED, 2.6, 3.0, 0);
}
// Base dip tank: an open-topped corrugated tank, water 1.6 m up for the bucket to dip in, a ladder, a pump house.
export function pond(b) {
  const r = POND.r, top = 2.2, TANK = 0x9fb7b0;
  b.add(new THREE.CylinderGeometry(r + 0.15, r + 0.15, top, 24, 1, true), TANK, 0, top / 2, 0);                     // outer wall
  b.add(new THREE.CylinderGeometry(r, r, top, 24, 1, true).scale(-1, 1, 1), 0x6f8a86, 0, top / 2, 0);              // inner wall (faces in)
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) b.add(new THREE.BoxGeometry(0.12, top, 0.12), shade(TANK, 0.8), Math.cos(a) * (r + 0.2), top / 2, Math.sin(a) * (r + 0.2)); // ribs
  b.add(new THREE.CylinderGeometry(r + 0.3, r + 0.3, 0.15, 24, 1, true), 0x2a2a32, 0, top, 0);                       // rim
  b.add(new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2), 0x3a8fa6, 0, POND.y - PAD.y, 0);                     // water
  for (let y = 0.3; y < top; y += 0.45) b.add(new THREE.BoxGeometry(0.5, 0.06, 0.08), STEEL, r + 0.45, y, 0);        // ladder
  for (const z of [-0.25, 0.25]) b.add(new THREE.BoxGeometry(0.06, top + 0.6, 0.06), STEEL, r + 0.45, top / 2 + 0.3, z);
  b.add(new THREE.BoxGeometry(2.4, 2.2, 2.4), 0xf3e3c8, r + 3, 1.1, 2);                                              // pump house
  b.add(new THREE.CylinderGeometry(0, 2.1, 1, 4, 1).rotateY(Math.PI / 4), STEEL, r + 3, 2.7, 2);
  b.add(new THREE.CylinderGeometry(0.18, 0.18, 2.4, 6).rotateZ(Math.PI / 2), YELLOW, r + 1.1, 0.4, 2);
}
// Maintenance workshop: gabled shed with a roller door, an outdoor gantry over a parts stand, crates.
export function workshop(b) {
  const W = 10, D = 12, H = 4.5, CLAD = 0xe8c9a4;
  b.add(new THREE.BoxGeometry(W + 8, 0.25, D + 2), 0x8f8790, 3, 0.12, 0);
  b.add(new THREE.BoxGeometry(W, H, D), CLAD, 0, H / 2 + 0.25, 0);
  for (let z = -D / 2 + 1; z < D / 2; z += 1.5) for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(0.1, H, 0.12), shade(CLAD, 0.85), sx * (W / 2 + 0.05), H / 2 + 0.25, z);
  b.add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, 2.2)]), { depth: D, bevelEnabled: false }), CLAD, 0, H + 0.25, -D / 2);
  for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(5.9, 0.15, D + 0.8).rotateZ(-sx * 0.41), 0x8e3829, sx * 2.6, H + 1.45, 0);
  b.add(new THREE.BoxGeometry(0.12, 3.4, 5), 0x9a8f96, W / 2 + 0.08, 1.95, 0);    // roller door
  for (let y = 0.6; y < 3.6; y += 0.4) b.add(new THREE.BoxGeometry(0.15, 0.05, 5), 0x7d7480, W / 2 + 0.1, y, 0);
  windowAt(b, 'z', 1, -2, 2.6, D / 2, 1.6, 1);
  windowAt(b, 'z', -1, -2, 2.6, -D / 2, 1.6, 1);
  for (const z of [-3, 3]) for (const x of [W / 2 + 1.5, W / 2 + 7]) b.add(new THREE.BoxGeometry(0.3, 5, 0.3), YELLOW, x, 2.75, z); // gantry
  for (const z of [-3, 3]) b.add(new THREE.BoxGeometry(5.8, 0.4, 0.4), YELLOW, W / 2 + 4.25, 5.3, z);
  b.add(new THREE.BoxGeometry(0.4, 0.5, 6.4), YELLOW, W / 2 + 4.25, 5.6, 0);
  b.add(new THREE.CylinderGeometry(0.04, 0.04, 2, 4), 0x2a2a32, W / 2 + 4.25, 4.4, 0);
  b.add(new THREE.BoxGeometry(1.6, 1.1, 1), STEEL, W / 2 + 4.25, 2.9, 0);         // an engine on the hoist
  b.add(new THREE.BoxGeometry(1.8, 0.8, 1.2), 0x2f7c7a, W / 2 + 4.25, 0.65, 0);   // its stand
  for (const [x, z, s] of [[W / 2 + 2, D / 2 - 1, 1], [W / 2 + 2.4, D / 2 - 2.4, 0.8], [-W / 2 - 1, -D / 2 + 1.5, 1.1]]) b.add(new THREE.BoxGeometry(s, s, s), 0xb8824c, x, s / 2 + 0.25, z);
}
// Fuel farm: a bunded yard of three horizontal tanks on saddles, a pipe manifold and a catwalk.
export function fuelFarm(b) {
  b.add(new THREE.BoxGeometry(18, 0.25, 12), 0x8f8790, 0, 0.12, 0);
  for (const [w, d, x, z] of [[18, 0.4, 0, 6], [18, 0.4, 0, -6], [0.4, 12, 9, 0], [0.4, 12, -9, 0]]) b.add(new THREE.BoxGeometry(w, 1, d), 0x9a8f96, x, 0.6, z); // bund wall
  for (const z of [-3.6, 0, 3.6]) {
    b.add(new THREE.CylinderGeometry(1.5, 1.5, 12, 12).rotateZ(Math.PI / 2), 0xf4ede4, 0, 2.2, z);
    for (const x of [-6, 6]) b.add(new THREE.SphereGeometry(1.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.sign(x) * Math.PI / 2), 0xf4ede4, x, 2.2, z);
    b.add(new THREE.CylinderGeometry(1.53, 1.53, 0.5, 12).rotateZ(Math.PI / 2), RED, 2, 2.2, z);
    for (const x of [-4, 4]) b.add(new THREE.BoxGeometry(0.5, 1, 2.2), STEEL, x, 0.75, z);
  }
  b.add(new THREE.CylinderGeometry(0.15, 0.15, 10, 6).rotateX(Math.PI / 2), YELLOW, 8, 0.9, 0); // manifold
  for (const z of [-3.6, 0, 3.6]) b.add(new THREE.CylinderGeometry(0.1, 0.1, 1.6, 6).rotateZ(Math.PI / 2), YELLOW, 7.2, 1.4, z);
  b.add(new THREE.BoxGeometry(1, 0.1, 9), STEEL, -2, 3.9, 0);                     // catwalk over the tanks
  for (const z of [-4.5, 4.5]) b.add(new THREE.BoxGeometry(0.06, 0.6, 0.06), STEEL, -2.45, 4.2, z);
}
// Fire lookout: a braced timber tower with a glazed cab, hip roof and a stair.
export function lookout(b) {
  const TIMBER = 0x7a5230, h = 11;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    strut(b, 0.18, TIMBER, [sx * 2.4, 0, sz * 2.4], [sx * 1.5, h, sz * 1.5]);
    b.add(new THREE.BoxGeometry(0.8, 0.4, 0.8), 0x8f8790, sx * 2.4, 0.2, sz * 2.4);
  }
  for (const y of [3.5, 7]) for (const [a, c] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]]]) {
    const w = 2.4 - (0.9 * y) / h; strut(b, 0.08, TIMBER, [a[0] * w, y, a[1] * w], [c[0] * w, y + 3.5, c[1] * w]); // cross braces
  }
  b.add(new THREE.BoxGeometry(4, 0.3, 4), TIMBER, 0, h, 0);
  b.add(new THREE.BoxGeometry(3.4, 1, 3.4), 0xe8c9a4, 0, h + 0.65, 0);
  b.add(new THREE.BoxGeometry(3.3, 1.1, 3.3), GLASS, 0, h + 1.7, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.16, 1.1, 0.16), TRIM, sx * 1.62, h + 1.7, sz * 1.62);
  b.add(new THREE.CylinderGeometry(0, 3.1, 1.3, 4, 1).rotateY(Math.PI / 4), 0x8e3829, 0, h + 2.9, 0);
  for (let i = 0; i < 4; i++) strut(b, 0.12, TIMBER, [2.8, i * 2.75, -1.6 + (i % 2) * 3.2], [2.8, (i + 1) * 2.75, 1.6 - (i % 2) * 3.2]); // zigzag stair
}

// Groups per project, hidden until owned (setProjects).
const projectViews = {};
function buildProjects(scene, houses) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const place = (fill, at, y, yaw) => { const m = new THREE.Mesh(baked(fill), mat); m.position.set(at.x, y, at.z); m.rotation.y = yaw; return m; };
  const group = (key, meshes) => { const g = new THREE.Group(); g.add(...meshes); g.visible = false; scene.add((projectViews[key] = g)); };
  // Town stations: the spot 17 m from the pad farthest from the houses and the road.
  group('stations', SITES.filter((s) => !s.hospital).map((s) => {
    let best = null;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
      const x = s.x + Math.cos(a) * 17, z = s.z + Math.sin(a) * 17, d = Math.min(roadDist(x, z), ...houses.filter((h) => h.site === s).map((h) => Math.hypot(h.x - x, h.z - z)));
      if (!best || d > best.d) best = { x, z, d, a };
    }
    return place(station, best, s.y, -best.a + Math.PI); // pump side faces the pad
  }));
  group('pond', [place(pond, POND, PAD.y, PAD.yaw)]);
  // ponytail: the workshop model waits for the damage-meter update (repairs paid at a pad, workshop discount)
  group('fuelFarm', [place(fuelFarm, FUEL_FARM, PAD.y, PAD.yaw)]);
  group('towers', TOWERS.map((t) => place(lookout, t, t.y - 0.2, t.yaw)));
  for (const t of TOWERS) (treeGrid[Math.floor((t.z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((t.x + HALF) / TREE_CELL)] ||= []).push([t.x, t.z, t.y, 14, 3, -1, -1]);
}
export const setProjects = (owned) => { for (const [k, g] of Object.entries(projectViews)) g.visible = owned.includes(k); };

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
  const lighthouse = buildLighthouse();
  scene.add(lighthouse, sun, sky, seabed, buildTerrain(), ...buildTrees(), buildRocks(), buildRoads(), water, buildPad(PAD, true), buildPad(DEPOT, false), buildRunway(), windsock);
  const houses = [];
  for (const site of SITES) buildSite(site, scene, houses);
  buildProjects(scene, houses);
  return { sky, water, windsock, lighthouse, houses };
}
