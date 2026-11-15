import * as THREE from 'three';
import { bodyBaker, GLASS, reflect, strut } from './chopper.js';

export const SEED = 1337;           // fixed map seed: the career island stays learnable
export const SIZE = 2800;           // terrain square, metres
export const SEGS = 560;                   // 5 m cells, ~627k triangles
export const CELL = SIZE / SEGS, HALF = SIZE / 2;
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
  // The two outer islets get a hamlet each, on their flattest spot near the middle: off the road network (islet: true),
  // but otherwise towns like any other, so cargo, rescues and house fires go there too.
  for (const [[ix, iz, ir], name] of [[ISLETS[1], 'Northcay'], [ISLETS[2], 'Gull Rock']]) {
    let best = null;
    for (let dz = -ir * 0.45; dz <= ir * 0.45; dz += 8) for (let dx = -ir * 0.45; dx <= ir * 0.45; dx += 8) {
      const x = ix + dx, z = iz + dz, y = rawHeight(x, z);
      if (y < 4 || y > 70) continue;
      const rough = Math.max(...[[30, 0], [-30, 0], [0, 30], [0, -30]].map(([ax, az]) => Math.abs(rawHeight(x + ax, z + az) - y))) + Math.hypot(dx, dz) * 0.02;
      if (!best || rough < best.rough) best = { x, z, y, rough };
    }
    if (best) out.push({ x: best.x, z: best.z, y: best.y, yaw: rng() * Math.PI * 2, name, islet: true });
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

export const H = new Float32Array((SEGS + 1) * (SEGS + 1));
for (let j = 0; j <= SEGS; j++)
  for (let i = 0; i <= SEGS; i++) H[j * (SEGS + 1) + i] = height(i * CELL - HALF, j * CELL - HALF);
const h = (i, j) => H[j * (SEGS + 1) + i];
// Which diagonal cell (i, j) is cut along: the one whose ends are closer in height, so the facets fold along ridges
// and valleys instead of zig-zagging across them. true: (i, j) to (i+1, j+1); false: (i+1, j) to (i, j+1).
export const flip = (i, j) => Math.abs(h(i, j) - h(i + 1, j + 1)) < Math.abs(h(i + 1, j) - h(i, j + 1));

// Exact height of the rendered triangles (same diagonal split as the mesh and the physics).
export function heightAt(x, z) {
  const gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= SEGS || gz >= SEGS) return FLOOR;
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  if (flip(i, j)) return fx >= fz ? h(i, j) + (h(i + 1, j) - h(i, j)) * fx + (h(i + 1, j + 1) - h(i + 1, j)) * fz
    : h(i, j) + (h(i, j + 1) - h(i, j)) * fz + (h(i + 1, j + 1) - h(i, j + 1)) * fx;
  if (fx + fz <= 1) return h(i, j) + (h(i + 1, j) - h(i, j)) * fx + (h(i, j + 1) - h(i, j)) * fz;
  const h11 = h(i + 1, j + 1);
  return h11 + (h(i, j + 1) - h11) * (1 - fx) + (h(i + 1, j) - h11) * (1 - fz);
}

export const groundAt = (x, z) => Math.max(heightAt(x, z), SEA);

// Harbour: a timber jetty running straight out (perpendicular to the shoreline) from the nearest beach to base into
// deep water (~10–12 m), so the Rescue Cutter's berth is completely clear of the beach on all sides.
// x, z: the berth (boat's home, alongside the jetty head). yaw: local +z points back to shore. len: shore to head.
export const HARBOUR = (() => {
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.03) {
    const rx = Math.cos(a), rz = Math.sin(a);
    let r = 30;
    while (r < 500 && height(PAD.x + rx * r, PAD.z + rz * r) > 0.8) r += 3;
    if (r >= 500) continue;
    const sx0 = PAD.x + rx * r, sz0 = PAD.z + rz * r;
    const gx = -(height(sx0 + 18, sz0) - height(sx0 - 18, sz0)), gz = -(height(sx0, sz0 + 18) - height(sx0, sz0 - 18)), gl = Math.hypot(gx, gz);
    if (gl < 1) continue;
    const dx = gx / gl, dz = gz / gl; // perpendicular to shoreline, straight out to sea
    let d = 0;
    while (d < 90 && height(sx0 + dx * d, sz0 + dz * d) > -9.5) d += 2;
    if (d >= 90 || [...Array(12)].some((_, k) => runwayGap(sx0 + dx * (k - 2) * 5, sz0 + dz * (k - 2) * 5) < 35)) continue;
    const len = Math.max(38, d + 10), hx = sx0 + dx * (len - 8), hz = sz0 + dz * (len - 8), score = r + d * 1.5;
    if (!best || score < best.score) best = { score, r: Math.hypot(hx - PAD.x, hz - PAD.z), len, hx, hz, yaw: Math.atan2(-dx, -dz), shore: { x: sx0 - dx * 8, z: sz0 - dz * 8 } }; // shore: where the road comes down to the jetty
  }
  const b = best, side = { x: Math.cos(b.yaw), z: -Math.sin(b.yaw) }; // local +x
  return { ...b, x: b.hx + side.x * 41.6, z: b.hz + side.z * 41.6, y: SEA, name: 'the harbour' }; // alongside the separate Rescue Station berth in ~10 m deep water
})();

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
  // The harbour hangs off the network too (usually straight from the base gate); the islet hamlets can't.
  const nodes = [GATE, ...SITES.filter((s) => !s.islet), HARBOUR.shore], inTree = [nodes[0]], roads = [];
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

// Warm-dusk palette: rich golden-hour sunlight, deep stylized cartoon ocean blue with crisp white foam outlines, and warm amber window glow.
const C = {
  seabed: new THREE.Color(0xc29572), shallow: new THREE.Color(0xeedca4), reef: new THREE.Color(0x3ab8c8), deep: new THREE.Color(0x164a78),
  foam: new THREE.Color(0xfffaf2), sand: new THREE.Color(0xf4d5a2),
  lush: new THREE.Color(0x68a044), grass: new THREE.Color(0x88a850), dry: new THREE.Color(0xc8b25a), forest: new THREE.Color(0x4c7434),
  rock: new THREE.Color(0x8f7684), rock2: new THREE.Color(0xb29288), peak: new THREE.Color(0xf7e5d6), snow: new THREE.Color(0xf4f4f6),
  water: 0x1d6ea3, waterShallow: new THREE.Color(0x32a6c8), waterDeep: new THREE.Color(0x134b7a), waterCrest: new THREE.Color(0x52bce0), shimmer: new THREE.Color(0xffe0a6),
  skyTop: new THREE.Color(0x2b2d6e), horizon: new THREE.Color(0xf49d78), sun: new THREE.Color(0xffe6b0),
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

const snowLine = (x, z) => 125 + 45 * noise(x / 90, z / 90, 2); // the snowcap starts here (and nothing burns above it)

function biome(y, ny, x, z, out) {
  const c = crop(x, z, y, ny);
  if (y < SEA - 0.6) out.copy(C.shallow).lerp(C.reef, smooth(-0.6, -5, y)).lerp(C.deep, smooth(-5, -16, y)); // shallows glow through the water
  else if (y < SEA + 0.5) out.copy(C.foam);                                                                  // surf line where the waves lap
  else if (y < SEA + 1.2 + 2.4 * noise(x / 90 + 13, z / 90, 2) && ny > 0.8) out.copy(C.sand);
  else if (y > snowLine(x, z) && ny > 0.74 - 0.1 * noise(x / 14, z / 14, 1)) out.copy(C.snow).lerp(C.peak, noise(x / 40, z / 40, 2) * 0.5); // snowcap on the gentler high ground
  else if (ny < 0.78 || y > 140) out.copy(C.rock).lerp(C.rock2, smooth(0.35, 0.65, noise(x / 30 + y / 60, z / 30, 2)) * 0.8); // two-tone rock in blotches
  else if (c >= 0) out.copy(CROPS[c]).multiplyScalar(0.95 + 0.08 * Math.sin((x * 0.6 - z * 0.8) * 0.9));    // plowed furrow stripes
  else {
    const tex = noise(x / 32 + 11, z / 32 - 7, 2);
    out.copy(C.grass).lerp(C.lush, smooth(40, 5, y) * 0.75 + (tex - 0.5) * 0.35).lerp(C.dry, smooth(0.38, 0.72, noise(x / 160 - 20, z / 160 + 4, 2)));
    if (forest(x, z) >= 0.5 && y > 3 && y < 120) out.lerp(C.forest, 0.78); // forest floor, so woods read as masses
    if (noise(x / 22 - 19, z / 22 + 31, 2) > 0.72 && y > 5 && y < 65) out.lerp(CROPS[0], 0.38); // wildflower meadow patches
  }
  return out.multiplyScalar(0.95 + Math.random() * 0.08);
}

let terrain, terrainColors; // kept for scorching and resetting
const treeMeshes = [];

function buildTerrain() {
  const n = SEGS * SEGS * 6, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const vn = new Float32Array((SEGS + 1) * (SEGS + 1) * 3);
  for (let j = 0; j <= SEGS; j++) for (let i = 0; i <= SEGS; i++) {
    const hl = h(Math.max(0, i - 1), j), hr = h(Math.min(SEGS, i + 1), j), hd = h(i, Math.max(0, j - 1)), hu = h(i, Math.min(SEGS, j + 1));
    const nx = hl - hr, ny = 2 * CELL, nz = hd - hu, l = Math.hypot(nx, ny, nz), idx = (j * (SEGS + 1) + i) * 3;
    vn[idx] = nx / l; vn[idx + 1] = ny / l; vn[idx + 2] = nz / l;
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), color = new THREE.Color();
  let k = 0;
  // Crisp facets: mostly the triangle's own normal (a little of the smooth one softens the steps). The colour is picked
  // from the smoothed slope at its corners, so both halves of a square agree and slopes don't come out checkered.
  const tri = (i0, j0, i1, j1, i2, j2) => {
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2).normalize();
    const ny = (vn[(j0 * (SEGS + 1) + i0) * 3 + 1] + vn[(j1 * (SEGS + 1) + i1) * 3 + 1] + vn[(j2 * (SEGS + 1) + i2) * 3 + 1]) / 3;
    biome((a.y + b.y + c.y) / 3, ny, (a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, color);
    for (const [v, vi, vj] of [[a, i0, j0], [b, i1, j1], [c, i2, j2]]) {
      const ni = (vj * (SEGS + 1) + vi) * 3;
      const nx = vn[ni] * 0.15 + e1.x * 0.85, ny = vn[ni + 1] * 0.15 + e1.y * 0.85, nz = vn[ni + 2] * 0.15 + e1.z * 0.85, nl = Math.hypot(nx, ny, nz);
      pos.set([v.x, v.y, v.z], k * 3);
      nrm.set([nx / nl, ny / nl, nz / nl], k * 3);
      col.set([color.r, color.g, color.b], k * 3);
      k++;
    }
  };
  for (let j = 0; j < SEGS; j++) for (let i = 0; i < SEGS; i++) {
    const x0 = i * CELL - HALF, z0 = j * CELL - HALF, x1 = x0 + CELL, z1 = z0 + CELL;
    if (flip(i, j)) {
      a.set(x0, h(i, j), z0); b.set(x0, h(i, j + 1), z1); c.set(x1, h(i + 1, j + 1), z1); tri(i, j, i, j + 1, i + 1, j + 1);
      a.set(x0, h(i, j), z0); b.set(x1, h(i + 1, j + 1), z1); c.set(x1, h(i + 1, j), z0); tri(i, j, i + 1, j + 1, i + 1, j);
    } else {
      a.set(x0, h(i, j), z0); b.set(x0, h(i, j + 1), z1); c.set(x1, h(i + 1, j), z0); tri(i, j, i, j + 1, i + 1, j);
      a.set(x1, h(i + 1, j), z0); b.set(x0, h(i, j + 1), z1); c.set(x1, h(i + 1, j + 1), z1); tri(i + 1, j, i, j + 1, i + 1, j + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  terrainColors = col.slice();
  terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  return terrain;
}

// Trees (and farmhouses) as cones in a 20 m grid (same cells as the fire sim): [x, z, baseY, height, radius, kind, instance].
const TREE_CELL = 20, TREE_COLS = Math.ceil(SIZE / TREE_CELL);
// Building colliders { x, y, z, hx, hy, hz, yaw }: world box centre, half-extents, rotation.y (local +x -> (cos yaw, 0, -sin yaw)). Filled by buildWorld.
export const SOLIDS = [];
// Box centred lx, lz from frame g (a group's x, y, z, yaw), resting on g.y.
const solid = (g, lx, lz, hx, hy, hz, yaw = 0) => { const c = Math.cos(g.yaw), s = Math.sin(g.yaw); SOLIDS.push({ x: g.x + lx * c + lz * s, y: g.y + hy, z: g.z - lx * s + lz * c, hx, hy, hz, yaw: g.yaw + yaw }); };
export const treeGrid = []; // [x, z, base y, height, radius, kind (-1: tower), index] per 20 m cell
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
  // Buildings: pushed out through the nearest wall.
  for (const b of SOLIDS) {
    const dx = pos.x - b.x, dz = pos.z - b.z;
    if (Math.abs(dx) > 24 || Math.abs(dz) > 24 || pos.y + dy > b.y + b.hy) continue;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw), lx = dx * c - dz * s, lz = dx * s + dz * c, px = b.hx + radius - Math.abs(lx), pz = b.hz + radius - Math.abs(lz);
    if (px <= 0 || pz <= 0) continue;
    const ox = px < pz ? Math.sign(lx) * px : 0, oz = px < pz ? 0 : Math.sign(lz) * pz, wx = ox * c + oz * s, wz = -ox * s + oz * c, l = Math.hypot(wx, wz);
    pos.x += wx; pos.z += wz;
    hit = Math.max(hit, reflect(vel, wx / l, wz / l, 0.3));
  }
  return hit;
}

// Instanced kinds, one draw call each: { geometry, collision height and radius, max count }.
function treeKinds() {
  const TRUNK = 0x6b4a3a, kind = (fill, h, r, max) => { const b = bodyBaker(0.72); fill(b); return { geo: b.geometry(), h, r, max, list: [] }; };
  return [
    kind((b) => { // conifer: soft layered cones
      b.add(new THREE.CylinderGeometry(0.25, 0.35, 2, 6), TRUNK, 0, 1, 0);
      b.add(new THREE.ConeGeometry(2.6, 6, 8), 0x3f6b3c, 0, 4.5, 0);
      b.add(new THREE.ConeGeometry(1.8, 4.5, 8), 0x4a7a44, 0, 7, 0);
    }, 9, 2.6, 2600),
    kind((b) => { // broadleaf: lush rounded canopy puffs
      b.add(new THREE.CylinderGeometry(0.3, 0.45, 3.4, 6), TRUNK, 0, 1.7, 0);
      b.add(new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.8, 1), 0x5f8f3e, 0, 5, 0);
      b.add(new THREE.IcosahedronGeometry(1.9, 0), 0x78a24c, 1.3, 6.4, 0.6);
    }, 8, 3, 1600),
    kind((b) => { // palm: leaning curved trunk, six drooping fronds
      b.add(new THREE.CylinderGeometry(0.2, 0.32, 7.5, 6).rotateZ(0.12), 0x9a7a55, -0.45, 3.7, 0);
      for (let k = 0; k < 6; k++) b.add(new THREE.ConeGeometry(0.55, 4, 4).rotateZ(-Math.PI / 2 - 0.45).translate(1.8, -0.8, 0).rotateY((k * Math.PI) / 3 + 0.3), k % 2 ? 0x4f8a3e : 0x5f9a46, -0.9, 7.4, 0);
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
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), list.length);
    list.forEach(([x, z, y, yaw, sc], i) => {
      const sy = kind === 3 ? 1 : sc * (0.85 + rng() * 0.4), sxz = kind === 3 ? 1 : sc;
      if (kind === 3) solid({ x, y, z, yaw }, 3.5, 0, 6.5, 2, 4); // farmhouse + barn
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
  const rng = mulberry32(SEED + 3), rb = bodyBaker(0.72);
  rb.add(new THREE.DodecahedronGeometry(1, 0), 0x9a8590);
  const mesh = new THREE.InstancedMesh(rb.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), 500);
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
  if (y < SEA + 2.2 || y > snowLine(x, z)) return 0;
  if (slope > 1 || y > 140) return 0.08;
  const n = (treeGrid[Math.floor((z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((x + HALF) / TREE_CELL)] || []).length;
  return Math.min(1, 0.35 + 0.25 * smooth(0.4, 0.7, noise(x / 160 - 20, z / 160 + 4, 2)) + n * 0.1);
}

// Char a burnt-out 20 m cell (index i + j * 140): its PER x PER terrain cells and its trees.
const CHAR = new THREE.Color(0x2e2622), PER = TREE_CELL / CELL; // terrain cells per fire cell, each way
export function scorch(cell) {
  const fi = cell % TREE_COLS, fj = Math.floor(cell / TREE_COLS), col = terrain.geometry.attributes.color, c = new THREE.Color();
  for (let tj = fj * PER; tj < fj * PER + PER; tj++) {
    const start = (tj * SEGS + fi * PER) * 6;
    for (let v = start; v < start + PER * 6; v++) col.setXYZ(v, ...c.fromBufferAttribute(col, v).lerp(CHAR, 0.75).toArray());
    col.addUpdateRange(start * 3, PER * 18);
  }
  col.needsUpdate = true;
  for (const t of treeGrid[cell] || []) if (t[5] >= 0) { treeMeshes[t[5]].setColorAt(t[6], CHAR); treeMeshes[t[5]].instanceColor.needsUpdate = true; }
}

// Start of a shift: burnt land regrows halfway back each shift (a scar fades over two or three shifts) and burnt houses
// are rebuilt. regrow = 1 restores everything at once.
export function resetScorch(houses, regrow = 0.5) {
  const col = terrain.geometry.attributes.color, back = (a, orig) => { for (let i = 0; i < a.length; i++) a[i] += (orig[i] - a[i]) * (Math.abs(orig[i] - a[i]) < 0.01 ? 1 : regrow); };
  back(col.array, terrainColors);
  col.clearUpdateRanges();
  col.needsUpdate = true;
  for (const t of treeMeshes) { back(t.instanceColor.array, t.userData.colors); t.instanceColor.needsUpdate = true; }
  for (const h of houses) { h.burnt = false; h.mats.forEach((m, i) => m.color.setHex(h.colors[i])); }
}

// The swell: surface height above SEA at (x, z), time t. The water mesh draws it; floating things and the boat ride it.
export const SEAS = { h: 1 }; // sea state: 1 is the usual swell, a squall pushes it to 3
export const waveAt = (x, z, t) => (Math.sin(x * 0.03 + t * 0.9) * 0.35 + Math.sin(z * 0.041 - t * 1.2 + x * 0.01) * 0.3) * SEAS.h;

function buildWater() {
  const SPAN = 4200, N = 120, STEP = SPAN / N;
  const g = new THREE.PlaneGeometry(SPAN, SPAN, N, N).rotateX(-Math.PI / 2);
  // Stylized cartoon ocean blue: rich sapphire/cobalt water with a subtle white shoreline foam outline,
  // matte shading (no specular glare), and clear 0.78 opacity.
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: 0.78, emissive: 0x061b30 }));
  const base = g.attributes.position.array.slice(), col = new Float32Array(base.length), sea = new THREE.Color(C.water), c = new THREE.Color();
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Follows the camera in whole-cell steps so the edge never shows and waves don't swim.
  const depth = new Float32Array(base.length / 3);
  let at = null;
  mesh.userData.update = (t, cam) => {
    mesh.position.x = Math.round(cam.x / STEP) * STEP;
    mesh.position.z = Math.round(cam.z / STEP) * STEP;
    const p = g.attributes.position.array, moved = at !== `${mesh.position.x},${mesh.position.z}`; // seabed depth only changes when the mesh steps
    at = `${mesh.position.x},${mesh.position.z}`;
    for (let i = 0; i < p.length; i += 3) {
      const x = base[i] + mesh.position.x, z = base[i + 2] + mesh.position.z;
      if (moved) depth[i / 3] = Math.abs(x) < HALF && Math.abs(z) < HALF ? heightAt(x, z) : FLOOR;
      const d = depth[i / 3];
      const calm = d > -2.5 ? smooth(-0.05, -2.5, d) : 1, w = waveAt(x, z, t) * calm;
      p[i + 1] = w;
      const k = w / (0.65 * SEAS.h);
      const sh = d > -12 ? smooth(-12, -0.8, d) * 0.45 : 0;
      const outline = d > -0.8 && d < 0.2 ? smooth(-0.7, -0.25, d) * smooth(0.2, -0.05, d) * 0.38 : 0;
      const cap = outline + smooth(0.65, 1, k) * Math.min(0.45, 0.04 + 0.22 * (SEAS.h - 1));
      c.copy(sea).lerp(C.waterShallow, sh).multiplyScalar(0.88 + 0.14 * k).lerp(C.foam, Math.min(0.5, cap));
      col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
    }
    g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
  };
  return mesh;
}

// Surf: subtle shore-parallel wave-crest foam bars that wash gently up and down the beaches (no circles).
function buildSurf() {
  const spots = [], rng = mulberry32(SEED + 9), J = HARBOUR;
  for (let j = 2; j < SEGS; j += 2) for (let i = 2; i < SEGS; i += 2) { // every 10 m
    const h = H[j * (SEGS + 1) + i];
    if (h > -0.55 && h < -0.08) {
      const x = i * CELL - HALF + (rng() - 0.5) * CELL * 0.35, z = j * CELL - HALF + (rng() - 0.5) * CELL * 0.35;
      if (Math.hypot(x - J.hx, z - J.hz) < J.len + 18) continue; // keep beach surf clear of the concrete harbour
      const gx = heightAt(x + 3, z) - heightAt(x - 3, z), gz = heightAt(x, z + 3) - heightAt(x, z - 3);
      if (Math.hypot(gx, gz) < 0.05) continue;
      spots.push([x, z, 3.2 + rng() * 2.4, Math.atan2(gx, gz), rng() * Math.PI * 2]);
    }
  }
  // Slender tapered foam bar aligned parallel to the shoreline contour (along local X, thin along shore-normal Z).
  const g = new THREE.PlaneGeometry(1, 0.14, 4, 1).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = Math.abs(p.getX(i)) * 2;
    p.setZ(i, p.getZ(i) * (1 - 0.75 * u * u) + (1 - u * u) * 0.06); // slightly arched, tapered ends
  }
  g.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: C.foam, transparent: true, opacity: 0.28, depthWrite: false }), spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  spots.forEach(([x, z, w, a], i) => mesh.setMatrixAt(i, m.compose(pos.set(x, 0, z), q.setFromAxisAngle(up, a), sc.set(w, 1, 1))));
  mesh.frustumCulled = false;
  mesh.userData.update = (t) => { mesh.position.y = SEA + 0.05 + 0.07 * SEAS.h * Math.sin(t * 0.9); mesh.material.opacity = 0.22 + 0.08 * Math.sin(t * 1.4); };
  return mesh;
}

// Lights that come on at dusk: helipad perimeters, runway edges and thresholds, the jetty, the town pads (one instanced draw).
function buildLights() {
  const pts = [], add = (x, y, z, color, r = 0.3) => pts.push([x, y, z, color, r]);
  for (const pad of [...PADS, ...SITES]) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; add(pad.x + Math.cos(a) * (PAD_RADIUS - 0.5), pad.y + 0.2, pad.z + Math.sin(a) * (PAD_RADIUS - 0.5), pad.hospital ? 0x8fd0ff : 0xffc24a); }
  const R = RUNWAY, px = -R.dz, pz = R.dx;
  for (let d = -R.len / 2; d <= R.len / 2 + 0.1; d += 26) for (const side of [-1, 1]) add(R.x + R.dx * d + px * side * (R.width / 2 + 1), R.y + 0.25, R.z + R.dz * d + pz * side * (R.width / 2 + 1), 0xfff3d0);
  for (const end of [-1, 1]) for (let w = -12; w <= 12; w += 4) add(R.x + R.dx * end * (R.len / 2 + 2) + px * w, R.y + 0.25, R.z + R.dz * end * (R.len / 2 + 2) + pz * w, R.dx * end * R.fx + R.dz * end * R.fz > 0 ? 0xff4030 : 0x40ff70);
  const J = HARBOUR, jx = Math.sin(J.yaw), jz = Math.cos(J.yaw), sx = Math.cos(J.yaw), sz = -Math.sin(J.yaw); // local +z, +x
  for (let d = 7; d < J.len; d += 6) for (const side of [-3.7, 3.7]) add(J.hx + jx * d + sx * side, 3.15, J.hz + jz * d + sz * side, 0xffd68a, 0.18); // festoon string lights along causeway
  for (const [lx, ly, lz] of [[16, 5.4, 4], [-16, 5.4, 4], [-13, 5.2, -26], [31, 5.4, 6], [31, 5.4, -6], [31.5, 3.6, -1.5]]) add(J.hx + jx * lz + sx * lx, ly, J.hz + jz * lz + sz * lx, 0xffdf9a, 0.26); // quay & rescue station lamps
  add(J.hx - jx * 12 - sx * 19, 2.6, J.hz - jz * 12 - sz * 19, 0xff4030, 0.32); add(J.hx - jx * 8 + sx * 38, 2.6, J.hz - jz * 8 + sz * 38, 0x40ff70, 0.32); // port red & rescue starboard green
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ fog: false }), pts.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  pts.forEach(([x, y, z, color, r], i) => { mesh.setMatrixAt(i, m.makeScale(r, r, r).setPosition(x, y, z)); mesh.setColorAt(i, c.set(color)); });
  mesh.frustumCulled = false;
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
  const b = bodyBaker(0.72), k = -at.away, flat = (w, d, color, x, z, y = 0.05) => b.add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), color, x, y, z);
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
    solid(at, -24 * k, -16, 2.5, 2, 3);
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }), g = new THREE.Group();
  const pm = new THREE.Mesh(b.geometry(), mat); pm.castShadow = pm.receiveShadow = true;
  g.add(pm);
  if (home) { // the hangar is built door-forward along +x, so it's turned round when the layout is mirrored
    const h = new THREE.Mesh(baked(hangar), mat);
    h.castShadow = h.receiveShadow = true;
    h.position.set(-33 * k, 0, 3);
    h.rotation.y = k > 0 ? 0 : Math.PI;
    solid(at, -33 * k, 3, 9, 4, 8, h.rotation.y);
    g.add(h);
  }
  g.position.set(at.x, at.y, at.z);
  g.rotation.y = at.yaw;
  return g;
}
const baked = (fill) => { const b = bodyBaker(0.72); fill(b); return b.geometry(); };

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
const TRIM = 0xf6efe6, STONE = 0x8f8790, WOOD = 0x6b4a3a, GLOW = 0xffcf7c;
// Window: white frame, dark or warm-lit glass, on a wall facing +x/-x (axis 'x') or +z/-z (axis 'z'), outward sign s.
function windowAt(b, axis, s, x, y, z, w = 1, h = 1, lit = false) {
  const [fx, fz] = axis === 'x' ? [0.08, w + 0.24] : [w + 0.24, 0.08], [gx, gz] = axis === 'x' ? [0.1, w] : [w, 0.1];
  const ox = axis === 'x' ? s * 0.04 : 0, oz = axis === 'z' ? s * 0.04 : 0;
  b.add(new THREE.BoxGeometry(fx, h + 0.24, fz), TRIM, x + ox, y, z + oz);
  b.add(new THREE.BoxGeometry(gx, h, gz), lit ? GLOW : GLASS, x + ox * 1.6, y, z + oz * 1.6);
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
  // Front: door under a porch roof on two posts, with a warm porch lantern; cozy lit windows down both sides and on the back.
  b.add(new THREE.BoxGeometry(0.1, 2.1, 1.2), TRIM, ox - w / 2 - 0.03, 1.45, oz);
  b.add(new THREE.BoxGeometry(0.12, 1.9, 0.95), WOOD, ox - w / 2 - 0.06, 1.35, oz);
  b.add(new THREE.BoxGeometry(0.16, 0.24, 0.16), GLOW, ox - w / 2 - 0.12, 2.35, oz - 0.82);                           // warm porch lantern
  windowAt(b, 'x', -1, ox - w / 2, 2.2, oz + d * 0.3, 1, 1, true);
  b.add(new THREE.BoxGeometry(1.8, 0.2, d * 0.6), shade(WOOD, 1.3), ox - w / 2 - 0.9, 0.4, oz);                      // porch deck
  for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(0.16, 2.6, 0.16), TRIM, ox - w / 2 - 1.65, 1.8, oz + sz * d * 0.28);
  b.add(new THREE.BoxGeometry(2.2, 0.12, d * 0.66).rotateZ(0.25), roof, ox - w / 2 - 0.95, 3.3, oz);
  for (const sz of [-1, 1]) for (const f of [-0.25, 0.25]) windowAt(b, 'z', sz, ox + f * w, 2.2, oz + sz * d / 2, 1, 1, rng() < 0.7);
  windowAt(b, 'x', 1, ox + w / 2, 2.2, oz, 1, 1, rng() < 0.65);
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
  const g = new THREE.Group(), pad = bodyBaker(0.72);
  pad.add(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 1, 1, 8), site.hospital ? 0xf2ede6 : 0x5b5566, 0, -0.48, 0);
  if (site.hospital) for (const [w, d] of [[2, 8], [8, 2]]) pad.add(new THREE.BoxGeometry(w, 0.1, d), 0xd8352a, 0, 0.05, 0);
  else for (const [w, d, x] of [[1.2, 7, -2.2], [1.2, 7, 2.2], [3.2, 1.2, 0]]) pad.add(new THREE.BoxGeometry(w, 0.1, d), 0xffd27a, x, 0.05, 0);
  g.add(new THREE.Mesh(pad.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 })));
  const rng = mulberry32(Math.floor(site.x * 7 + site.z));
  const count = site.hospital ? 1 : 4 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    let a = (i / count) * Math.PI * 2 + rng() * 0.4;
    const r = site.hospital ? 24 : 21 + rng() * 6;
    // Nudge round the ring until clear of the road coming in (houses are ~8 m across, the road 6 m wide).
    const world = (a) => ({ x: site.x + Math.cos(site.yaw) * Math.cos(a) * r + Math.sin(site.yaw) * Math.sin(a) * r, z: site.z - Math.sin(site.yaw) * Math.cos(a) * r + Math.cos(site.yaw) * Math.sin(a) * r });
    for (let k = 0; k < 12 && roadDist(world(a).x, world(a).z) < (site.hospital ? 16 : 11); k++) a += 0.2;
    const b = bodyBaker(0.72), mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 });
    let w = 12, d = 18; // hospital footprint
    if (site.hospital) hospital(b);
    else house(b, w = 5 + rng() * 2, d = 6 + rng() * 2, [0xf3e3c8, 0xe8c9a4, 0xd9e2d0, 0xf0d2c0][i % 4], [0xb5523b, 0x8e3829, 0x5b5566, 0x2f7c7a][Math.floor(rng() * 4)], rng);
    const mesh = new THREE.Mesh(b.geometry(), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    mesh.rotation.y = -a; // front faces the pad
    g.add(mesh);
    solid(site, Math.cos(a) * r, Math.sin(a) * r, w / 2, site.hospital ? 4 : 2.2, d / 2, -a);
    const wp = mesh.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), site.yaw);
    houses.push({ x: site.x + wp.x, z: site.z + wp.z, mats: [mat], colors: [0xffffff], site, burnt: false });
  }
  g.position.set(site.x, site.y, site.z);
  g.rotation.y = site.yaw;
  scene.add(g);
}

function buildRunway() {
  const b = bodyBaker(0.72), add = (w, l, color, x, y, z) => b.add(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), color, x, y, z);
  add(RUNWAY.width, RUNWAY.len, 0x4a4652, 0, 0.08, 0);
  for (let z = -RUNWAY.len / 2 + 40; z < RUNWAY.len / 2 - 30; z += 30) add(0.8, 12, 0xf2ead8, 0, 0.12, z);  // centreline
  for (const end of [-1, 1]) for (let i = -5; i <= 5; i += 2) if (i) add(1.4, 18, 0xf2ead8, i * 1.3, 0.12, end * (RUNWAY.len / 2 - 14)); // thresholds
  for (const side of [-1, 1]) for (let z = -RUNWAY.len / 2; z <= RUNWAY.len / 2; z += 40) b.add(new THREE.BoxGeometry(0.4, 0.4, 0.4), 0xffd27a, side * (RUNWAY.width / 2 + 1), 0.3, z); // edge lights
  const g = new THREE.Mesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, emissive: 0x201810 }));
  g.receiveShadow = true;
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
  const L = LIGHTHOUSE, g = new THREE.Group(), b = bodyBaker(0.72), rng = mulberry32(SEED + 5), STONE = 0x8f8790;
  b.add(new THREE.BoxGeometry(6, 9, L.len + 20), STONE, 0, -3, L.len / 2 + 6);                          // breakwater, running into the beach
  for (let z = 4; z < L.len + 10; z += 3.5) for (const side of [-1, 1])                                   // armour stones along both sides
    b.add(new THREE.DodecahedronGeometry(1.4 + rng() * 0.8, 0), rng() < 0.5 ? 0x9a8f96 : 0x7d7480, side * (3.2 + rng() * 0.6), 0.2 + rng() * 0.6, z);
  b.add(new THREE.CylinderGeometry(5, 5.6, 9, 16), STONE, 0, -3, 0);                                    // round plinth at the tip
  b.add(new THREE.CylinderGeometry(1.5, 2.3, 15, 16, 6), (x, y) => (Math.floor((y - 1.5) / 2.5) % 2 ? 0xd8352a : 0xf6efe6), 0, 9, 0);
  b.add(new THREE.CylinderGeometry(2.4, 2.4, 0.4, 16), 0x2a2a32, 0, 16.7, 0);
  b.add(new THREE.ConeGeometry(1.7, 1.8, 16), 0xd8352a, 0, 19.8, 0);
  b.add(new THREE.BoxGeometry(3.6, 2.6, 4), 0xf3e3c8, 0, 2.8, 12);                                       // keeper's hut
  b.add(new THREE.CylinderGeometry(0, 3, 1.4, 4, 1).rotateY(Math.PI / 4).scale(0.9, 1, 1), 0x5b5566, 0, 4.8, 12);
  const lm = new THREE.Mesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }));
  lm.castShadow = lm.receiveShadow = true;
  g.add(lm);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2, 8), new THREE.MeshBasicMaterial({ color: 0xfff2b0 }));
  lamp.position.y = 17.9;
  const beam = new THREE.Group(), beamMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const dir of [1, -1]) beam.add(new THREE.Mesh(new THREE.ConeGeometry(6, 160, 10, 1, true).translate(0, -80, 0).rotateZ((dir * Math.PI) / 2), beamMat)); // two opposite arms
  beam.position.y = 17.9;
  beam.rotation.z = 0.05;
  g.add(lamp, beam);
  g.position.set(L.x, L.y, L.z);
  g.rotation.y = L.yaw;
  (treeGrid[Math.floor((L.z + HALF) / TREE_CELL) * TREE_COLS + Math.floor((L.x + HALF) / TREE_CELL)] ||= []).push([L.x, L.z, L.y, 21, 5.5, -1, -1]);
  // Sector light: the beam fades out while it points back over the land (local +z is the shore).
  g.userData.update = (t, night = 0) => { beam.rotation.y = t * 0.7; beamMat.opacity = (0.1 + 0.22 * night) * smooth(-0.1, 0.5, Math.sin(beam.rotation.y)); }; // ~9 s per sweep; the sector fade covers both arms; brighter on a night shift
  return g;
}

export function harbour(b, len = HARBOUR.len) {
  const CONC = 0xa8a4aa, CONC2 = 0x938f96, COPING = 0xd6d0c8, PILE = 0x625e66, WOOD = 0x8a6a4c, ROOF = 0x2f7c7a, WALL = 0xf3e3c8, DARK = 0x2a2a32, ORANGE = 0xf2763a, deck = 1.5;
  // 1. Concrete causeway (8 m wide) & shoreward logistics plaza (28 m × 16 m) on Concrete Caisson Piers.
  b.add(new THREE.BoxGeometry(28.0, 2.8, 16.0), STONE, 0, 0.35, len - 2);
  b.add(new THREE.BoxGeometry(28.2, 0.24, 16.2), COPING, 0, 1.65, len - 2);
  b.add(new THREE.BoxGeometry(8.0, 0.36, len), (x, y, z) => (Math.floor(z / 2.5) % 2 ? CONC : CONC2), 0, deck, len / 2);
  for (const sx of [-3.85, 3.85]) b.add(new THREE.BoxGeometry(0.3, 0.22, len), (x, y, z) => (z < 7 && Math.floor(z) % 2 ? YELLOW : COPING), sx, deck + 0.24, len / 2);
  for (let z = 6.5; z < len - 5; z += 6.0) {
    for (const sx of [-3.3, 0, 3.3]) b.add(new THREE.CylinderGeometry(0.38, 0.42, 7.4, 8), PILE, sx, deck - 3.4, z);
    b.add(new THREE.BoxGeometry(7.4, 0.46, 0.65), PILE, 0, deck - 0.32, z);
  }

  // 2. Main concrete Port Quay Head (38 m × 18 m, top at y = 1.69) on caisson piles.
  b.add(new THREE.BoxGeometry(38.0, 0.38, 18.0), (x, y, z) => (Math.floor((x + z) / 3.0) % 2 ? CONC : CONC2), 0, deck, 0);
  b.add(new THREE.BoxGeometry(37.2, 0.95, 17.2), PILE, 0, deck - 0.55, 0);
  for (const sz of [-8.85, 8.85]) b.add(new THREE.BoxGeometry(38.0, 0.22, 0.3), COPING, 0, deck + 0.24, sz);
  for (const sx of [-18.85, 18.85]) b.add(new THREE.BoxGeometry(0.3, 0.22, 18.0), COPING, sx, deck + 0.24, 0);
  for (const x of [-17.5, -9, 0, 9, 17.5]) for (const z of [-7.8, 0, 7.8]) {
    b.add(new THREE.CylinderGeometry(0.46, 0.5, 9, 8), PILE, x, deck - 2.9, z);
  }

  // 3. Port-side Fishing Pier (lx = -13, lz = -28..-9, 5 m × 19 m) for commercial trawlers.
  b.add(new THREE.BoxGeometry(5.0, 0.36, 19.0), (x, y, z) => (Math.floor(z / 2.5) % 2 ? CONC : CONC2), -13.0, deck, -18.5);
  b.add(new THREE.BoxGeometry(4.4, 0.8, 18.4), PILE, -13.0, deck - 0.5, -18.5);
  for (const z of [-27, -21, -15, -10]) {
    for (const sx of [-15.0, -11.0]) b.add(new THREE.CylinderGeometry(0.38, 0.42, 8.2, 8), PILE, sx, deck - 3.0, z);
    b.add(new THREE.BoxGeometry(0.28, 1.25, 0.36), DARK, -10.35, 0.95, z);
  }
  for (const [cx, cz, s, col] of [[-13.5, -24.5, 0.85, 0x2b6e8c], [-12.5, -23.4, 0.72, 0xc89658], [-13.6, -15.5, 0.9, 0x4b7496]]) {
    b.add(new THREE.BoxGeometry(s, s, s), col, cx, deck + 0.18 + s / 2, cz);
  }

  // 3b. Seaward Container & Ferry Pier (lx = 10, lz = -38..-9, 6 m × 29 m) for cargo ships & passenger ferries.
  b.add(new THREE.BoxGeometry(6.0, 0.36, 29.0), (x, y, z) => (Math.floor(z / 2.5) % 2 ? CONC : CONC2), 10.0, deck, -23.5);
  b.add(new THREE.BoxGeometry(5.4, 0.8, 28.4), PILE, 10.0, deck - 0.5, -23.5);
  for (const sx of [7.15, 12.85]) b.add(new THREE.BoxGeometry(0.28, 0.22, 29.0), COPING, sx, deck + 0.24, -23.5);
  for (const z of [-36, -29, -22, -15, -10]) {
    for (const sx of [7.6, 12.4]) b.add(new THREE.CylinderGeometry(0.42, 0.46, 8.6, 8), PILE, sx, deck - 3.0, z);
    for (const sx of [6.85, 13.15]) b.add(new THREE.BoxGeometry(0.28, 1.25, 0.38), DARK, sx, 0.95, z);
  }

  // 4. Port-side Marina Slips (lx = -22, lz = -7..10) with finger piers & gangway.
  b.add(new THREE.BoxGeometry(3.2, 0.46, 17.0), WOOD, -22.0, 0.48, 1.5);
  b.add(new THREE.BoxGeometry(3.8, 0.14, 1.4).rotateZ(0.32), COPING, -20.0, 1.12, 2.0);
  for (const z of [-4.5, 1.0, 6.5]) {
    b.add(new THREE.BoxGeometry(4.6, 0.42, 1.4), WOOD, -25.8, 0.46, z);
    b.add(new THREE.CylinderGeometry(0.22, 0.24, 5.2, 6), DARK, -27.9, 0.35, z);
    b.add(new THREE.CylinderGeometry(0.22, 0.24, 5.2, 6), DARK, -21.0, 0.35, z);
  }

  // 5. Outer L-shaped Stone & Concrete Breakwater (armour rocks + green entry beacon at (-19, -28)).
  b.add(new THREE.BoxGeometry(4.6, 2.6, 38.0), STONE, -31.5, 0.45, -10.5);
  b.add(new THREE.BoxGeometry(4.8, 0.28, 38.2), COPING, -31.5, 1.76, -10.5);
  b.add(new THREE.BoxGeometry(3.2, 1.1, 36.0), PILE, -31.5, 2.3, -10.5);
  b.add(new THREE.BoxGeometry(13.0, 2.6, 4.6), STONE, -25.0, 0.45, -28.0);
  b.add(new THREE.BoxGeometry(13.2, 0.28, 4.8), COPING, -25.0, 1.76, -28.0);
  b.add(new THREE.BoxGeometry(11.5, 1.1, 3.2), PILE, -24.5, 2.3, -28.0);
  for (let z = -27.5; z <= 7.5; z += 3.2) for (const sx of [-34.0, -29.0]) b.add(new THREE.DodecahedronGeometry(1.2, 0), STONE, sx, 0.25, z);
  for (let x = -31.0; x <= -20.0; x += 3.2) b.add(new THREE.DodecahedronGeometry(1.2, 0), STONE, x, 0.25, -30.5);
  b.add(new THREE.CylinderGeometry(0.62, 0.8, 3.6, 8), 0xf6efe6, -19.0, 3.5, -28.0);
  b.add(new THREE.CylinderGeometry(0.66, 0.72, 0.54, 8), 0x2f8a58, -19.0, 3.8, -28.0);
  b.add(new THREE.CylinderGeometry(0.46, 0.46, 0.6, 8), 0x40ff70, -19.0, 5.4, -28.0);
  b.add(new THREE.ConeGeometry(0.66, 0.5, 8), 0x2f8a58, -19.0, 5.9, -28.0);

  // 6. Separate Coastguard & Rescue Station Wing (lx = 24..38, lz = -8..8) linked by a bridge at lx = 21.5.
  b.add(new THREE.BoxGeometry(5.4, 0.36, 4.8), (x, y, z) => (Math.floor(x * 1.4) % 2 ? CONC : CONC2), 21.5, deck, 0);
  for (const sz of [-2.25, 2.25]) b.add(new THREE.BoxGeometry(5.2, 0.22, 0.24), ORANGE, 21.5, deck + 0.28, sz);
  b.add(new THREE.BoxGeometry(14.0, 0.38, 16.0), (x, y, z) => (Math.floor((x + z) / 2.5) % 2 ? CONC : CONC2), 31.0, deck, 0);
  b.add(new THREE.BoxGeometry(13.4, 0.95, 15.4), PILE, 31.0, deck - 0.55, 0);
  for (const sz of [-7.85, 7.85]) b.add(new THREE.BoxGeometry(14.0, 0.22, 0.32), ORANGE, 31.0, deck + 0.24, sz);
  for (const sx of [24.15, 37.85]) b.add(new THREE.BoxGeometry(0.32, 0.22, 16.0), sx > 30 ? (x, y, z) => (Math.floor((z + 10) * 1.4) % 2 ? YELLOW : DARK) : ORANGE, sx, deck + 0.24, 0);
  for (const x of [25.0, 31.0, 37.0]) for (const z of [-7.0, 0, 7.0]) {
    b.add(new THREE.CylinderGeometry(0.44, 0.48, 9, 8), PILE, x, deck - 2.9, z);
  }
  for (const z of [-6.0, -3.0, 0.0, 3.0, 6.0]) {
    b.add(new THREE.BoxGeometry(0.32, 1.35, 0.42), DARK, 38.15, 0.9, z);
    b.add(new THREE.TorusGeometry(0.42, 0.15, 6, 8).rotateY(Math.PI / 2), DARK, 38.22, 0.95, z + 1.1);
  }
  // Rescue boat launch ramp / slipway on the south apron edge.
  b.add(new THREE.BoxGeometry(3.8, 0.28, 5.2).rotateX(0.28), CONC2, 34.0, 0.95, 10.2);

  // Two-storey Coastguard & Rescue HQ (lx = 29.0, lz = -1.5) with observation cupola, radar & VHF mast.
  const hx = 29.0, hz = -1.5, hw = 4.4, hd = 5.4, hh = 2.8;
  b.add(new THREE.BoxGeometry(hw, hh, hd), WALL, hx, deck + hh / 2 + 0.18, hz);
  b.add(new THREE.BoxGeometry(hw + 0.08, 0.32, hd + 0.08), ORANGE, hx, deck + hh - 0.14, hz);
  for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(2.8, 0.16, hd + 0.6).rotateZ(-sx * 0.4), ROOF, hx + sx * 1.2, deck + hh + 0.58, hz);
  b.add(new THREE.BoxGeometry(2.6, 1.3, 2.7), WALL, hx, deck + hh + 1.15, hz - 0.4);
  b.add(new THREE.BoxGeometry(2.66, 0.72, 2.76), GLASS, hx, deck + hh + 1.25, hz - 0.4);
  b.add(new THREE.CylinderGeometry(0, 2.1, 0.85, 4, 1).rotateY(Math.PI / 4), ROOF, hx, deck + hh + 2.15, hz - 0.4);
  b.add(new THREE.CylinderGeometry(0.06, 0.09, 1.6, 6), DARK, hx, deck + hh + 2.95, hz - 0.4);
  b.add(new THREE.BoxGeometry(1.2, 0.14, 0.24), 0xf6efe6, hx, deck + hh + 3.58, hz - 0.4);
  windowAt(b, 'x', 1, hx + hw / 2, deck + 1.48, hz - 1.1, 1.05, 0.88, true);
  windowAt(b, 'x', 1, hx + hw / 2, deck + 1.48, hz + 1.1, 1.05, 0.88, true);
  windowAt(b, 'z', -1, hx, deck + 1.48, hz - hd / 2, 1.3, 0.88, true);
  b.add(new THREE.BoxGeometry(0.1, 1.85, 0.92), WOOD, hx + hw / 2 + 0.04, deck + 1.1, hz + 0.05);
  b.add(new THREE.BoxGeometry(0.18, 0.24, 0.18), GLOW, hx + hw / 2 + 0.14, deck + 1.96, hz - 0.55);
  // Rescue fuel dispenser & hose reel on the Rescue apron.
  b.add(new THREE.BoxGeometry(0.95, 1.55, 0.65), RED, 35.6, deck + 0.94, -0.3);
  b.add(new THREE.BoxGeometry(0.54, 0.36, 0.06), GLOW, 35.6, deck + 1.34, -0.64);
  b.add(new THREE.CylinderGeometry(0.32, 0.32, 0.4, 8).rotateZ(Math.PI / 2), RED, 35.6, deck + 0.58, 0.55);

  // 7. Main Quay Cargo Warehouse, Shipping Containers, Marine Bunker Tank, Hammerhead Crane & Crates.
  b.add(new THREE.BoxGeometry(7.6, 3.2, 10.0), 0x8e959c, -9.5, deck + 1.78, -1.5);
  b.add(new THREE.BoxGeometry(8.0, 0.32, 10.4), ROOF, -9.5, deck + 3.52, -1.5);
  b.add(new THREE.BoxGeometry(0.12, 2.2, 3.4), DARK, -5.65, deck + 1.28, -1.5);
  b.add(new THREE.BoxGeometry(2.4, 2.4, 5.8), 0xc8452e, -9.5, 2.85, len - 2.2);
  b.add(new THREE.BoxGeometry(2.4, 2.4, 5.8), 0x2b6e8c, -9.4, 5.25, len - 2.3);
  b.add(new THREE.BoxGeometry(2.4, 2.4, 5.8), 0xd49a38, -6.5, 2.85, len - 2.4);
  b.add(new THREE.CylinderGeometry(0.95, 0.95, 3.6, 10).rotateZ(Math.PI / 2), 0xf4ede4, 8.8, 2.75, len - 3.6);
  b.add(new THREE.CylinderGeometry(0.98, 0.98, 0.4, 10).rotateZ(Math.PI / 2), RED, 8.8, 2.75, len - 3.6);
  for (const x of [7.6, 10.0]) b.add(new THREE.BoxGeometry(0.32, 0.68, 1.5), DARK, x, 1.98, len - 3.6);
  // Yellow dockside hammerhead crane near the seaward main quay edge.
  b.add(new THREE.BoxGeometry(1.4, 0.6, 1.4), DARK, 6.5, deck + 0.48, -6.2);
  b.add(new THREE.CylinderGeometry(0.3, 0.34, 4.2, 8), YELLOW, 6.5, deck + 2.75, -6.2);
  b.add(new THREE.BoxGeometry(1.25, 1.0, 1.45), YELLOW, 6.5, deck + 4.95, -6.2);
  b.add(new THREE.BoxGeometry(0.6, 0.58, 0.7), GLASS, 6.9, deck + 5.0, -6.2);
  strut(b, 0.15, YELLOW, [6.4, deck + 5.05, -6.2], [9.8, deck + 6.4, -6.2]);
  strut(b, 0.045, DARK, [9.6, deck + 6.3, -6.2], [9.6, deck + 3.0, -6.2]);
  b.add(new THREE.BoxGeometry(0.34, 0.38, 0.34), ORANGE, 9.6, deck + 2.9, -6.2);
  for (const [cx, cz, s, col] of [[2.2, 2.4, 0.95, 0xc89658], [3.4, 2.8, 0.76, 0xb58046], [2.7, 3.4, 0.68, 0xd8452e], [6.2, len - 0.8, 0.95, 0xc89658]])
    b.add(new THREE.BoxGeometry(s, s, s), col, cx, deck + 0.18 + s / 2, cz);

  // 8. Heavy T-head mooring bollards, floodlight towers, and warm festoon string lights along the causeway.
  for (const [x, z] of [[-16, -8], [0, -8], [16, -8], [17.8, -4], [17.8, 4], [37.2, -6], [37.2, 6]]) {
    b.add(new THREE.CylinderGeometry(0.2, 0.26, 0.58, 6), DARK, x, deck + 0.46, z);
    b.add(new THREE.BoxGeometry(0.56, 0.14, 0.16), DARK, x, deck + 0.68, z);
  }
  for (const [sx, sz] of [[-14.0, 6.5], [14.0, 6.5], [35.5, 6.5]]) {
    b.add(new THREE.CylinderGeometry(0.09, 0.12, 4.2, 6), DARK, sx, deck + 2.25, sz);
    b.add(new THREE.BoxGeometry(0.62, 0.26, 0.38), DARK, sx, deck + 4.4, sz);
    b.add(new THREE.BoxGeometry(0.54, 0.2, 0.32), GLOW, sx, deck + 4.28, sz);
  }
  const fz = [];
  for (let z = 10; z < len - 2; z += 5.5) fz.push(z);
  for (const sx of [-3.7, 3.7]) {
    for (const z of fz) b.add(new THREE.CylinderGeometry(0.05, 0.06, 1.7, 5), DARK, sx, deck + 1.0, z);
    for (let i = 1; i < fz.length; i++) strut(b, 0.02, DARK, [sx, deck + 1.75, fz[i - 1]], [sx, deck + 1.75, fz[i]]);
  }
  for (const z of [11, 19, 27]) if (z < len - 3) {
    b.add(new THREE.TorusGeometry(0.4, 0.12, 5, 8).rotateY(Math.PI / 2), ORANGE, 3.8, deck + 0.85, z);
    b.add(new THREE.BoxGeometry(0.12, 1.35, 0.12), DARK, 3.66, deck + 0.85, z);
  }
}
function buildHarbour() {
  const J = HARBOUR, b = bodyBaker(0.72);
  harbour(b, J.len);
  const g = new THREE.Mesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }));
  g.castShadow = g.receiveShadow = true;
  g.position.set(J.hx, SEA, J.hz);
  g.rotation.y = J.yaw;
  // Register harbour colliders in SOLIDS (split into <=16 m spans so hitTrees' 24 m broad-phase check never culls them).
  const frame = { x: J.hx, y: SEA, z: J.hz, yaw: J.yaw };
  const segs = Math.max(2, Math.ceil(J.len / 16)), step = J.len / segs;
  for (let i = 0; i < segs; i++) solid(frame, 0, (i + 0.5) * step, 4.0, 0.85, step / 2);          // causeway
  solid(frame, 0, J.len - 2, 14.0, 0.89, 8.0);                                                    // shoreward logistics plaza
  for (const qx of [-9.5, 9.5]) solid(frame, qx, 0, 9.5, 0.85, 9.0);                              // main quay head (2 halves)
  solid(frame, -13.0, -18.5, 2.5, 0.85, 9.5);                                                     // fishing pier
  for (const pz of [-30.5, -16.5]) solid(frame, 10.0, pz, 3.0, 0.85, 7.5);                         // container & ferry pier (2 halves)
  solid(frame, -22.0, 1.5, 1.6, 0.36, 8.5);                                                       // marina walkway
  for (const bz of [-20.0, -1.0]) solid(frame, -31.5, bz, 2.4, 1.45, 9.5);                        // outer breakwater main arm
  solid(frame, -25.0, -28.0, 6.5, 1.45, 2.4);                                                     // breakwater cross-arm
  solid(frame, -19.0, -28.0, 0.8, 2.9, 0.8);                                                      // port entry beacon tower
  solid(frame, 21.5, 0, 2.7, 0.85, 2.4);                                                          // rescue station bridge
  solid(frame, 31.0, 0, 7.0, 0.85, 8.0);                                                          // rescue station apron
  solid(frame, 29.0, -1.5, 2.2, 2.8, 2.7);                                                        // coastguard & rescue HQ
  solid(frame, -9.5, -1.5, 3.8, 2.6, 5.0);                                                        // cargo warehouse
  solid(frame, -8.0, J.len - 2.2, 2.8, 3.25, 3.0);                                                // stacked shipping containers
  solid(frame, 6.5, -6.2, 1.0, 3.3, 1.0);                                                         // hammerhead crane
  return g;
}

// Offshore Oil Rig: placed in deep water (~10 m+) within cutter range of the harbour, with a cantilevered helideck (y = 11.2)
// and a lower boat-landing stage (y = 1.6) on the starboard (+x) leg.
export const OILRIG = (() => {
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.08) for (const r of [850, 980, 1120]) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if ([0, 1, 2, 3, 4].some((k) => height(x + Math.cos(k * 1.57) * 40, z + Math.sin(k * 1.57) * 40) > -10)) continue;
    const dH = Math.hypot(x - HARBOUR.hx, z - HARBOUR.hz), dL = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
    if (dH < 500 || dL < 300) continue;
    if (!best || dH < best.dH) best = { x, z, dH };
  }
  return { x: best.x, z: best.z, y: SEA, yaw: 0, deck: 9.5, helideck: { x: 0, z: -14.5, y: 11.2, r: 5.5 }, boatStage: { x: 11.8, z: 0 }, name: 'Oil Rig' };
})();

export function oilRig(b) {
  const STEEL = 0x565d66, STEEL2 = 0x707882, DECK = 0x3f454d, GREEN = 0x2f685a, YELLOW = 0xf2b632, ORANGE = 0xf2763a, WALL = 0xf3e3c8, DARK = 0x2a2a32, RED = 0xd8352a, WHITE = 0xf6efe6;
  const rail = (pts, y, h = 1.0, col = YELLOW) => {
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2.6));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
        strut(b, 0.04, col, [x, y, z], [x, y + h, z]);
      }
      for (const ry of [0.5, h]) strut(b, 0.03, col, [ax, y + ry, az], [bx, y + ry, bz]);
    }
  };

  // 1. Four heavy jacket legs (y = -12..9.5) with mudmat footings, multi-tier ring girders, K-bracing & central conductor pipes.
  for (const sx of [-8.5, 8.5]) for (const sz of [-8.5, 8.5]) {
    b.add(new THREE.CylinderGeometry(0.95, 1.18, 21.5, 10), STEEL, sx, -1.25, sz);
    b.add(new THREE.CylinderGeometry(1.12, 1.12, 0.65, 10), YELLOW, sx, 0.35, sz);
    b.add(new THREE.BoxGeometry(3.2, 0.6, 3.2), DARK, sx, -11.7, sz);
  }
  for (const y of [0.4, 4.2, 8.0]) {
    for (const sx of [-8.5, 8.5]) strut(b, 0.24, STEEL2, [sx, y, -8.5], [sx, y, 8.5]);
    for (const sz of [-8.5, 8.5]) strut(b, 0.24, STEEL2, [-8.5, y, sz], [8.5, y, sz]);
  }
  for (const [y0, y1] of [[0.4, 4.2], [4.2, 8.0]]) {
    for (const sx of [-8.5, 8.5]) {
      strut(b, 0.2, STEEL, [sx, y0, -8.5], [sx, y1, 0]); strut(b, 0.2, STEEL, [sx, y0, 8.5], [sx, y1, 0]);
      strut(b, 0.2, STEEL, [sx, y0, 0], [sx, y1, -8.5]); strut(b, 0.2, STEEL, [sx, y0, 0], [sx, y1, 8.5]);
    }
    for (const sz of [-8.5, 8.5]) {
      strut(b, 0.2, STEEL, [-8.5, y0, sz], [0, y1, sz]); strut(b, 0.2, STEEL, [8.5, y0, sz], [0, y1, sz]);
      strut(b, 0.2, STEEL, [0, y0, sz], [-8.5, y1, sz]); strut(b, 0.2, STEEL, [0, y0, sz], [8.5, y1, sz]);
    }
  }
  // Central conductor / riser pipe cluster under the drill floor
  for (const dx of [-0.9, 0.9]) for (const dz of [-0.9, 0.9]) b.add(new THREE.CylinderGeometry(0.28, 0.28, 21.0, 8), STEEL2, -1.5 + dx, -1.0, -1.5 + dz);

  // Boat-landing stage on starboard (+x) leg with fenders, life rings & access stairway up to main deck.
  b.add(new THREE.BoxGeometry(3.0, 0.36, 6.8), YELLOW, 10.6, 1.6, 0);
  for (const dz of [-2.6, 0, 2.6]) b.add(new THREE.BoxGeometry(0.32, 1.4, 0.42), DARK, 12.1, 0.9, dz);
  b.add(new THREE.TorusGeometry(0.36, 0.1, 5, 8).rotateY(Math.PI / 2), ORANGE, 11.8, 2.3, -2.5);
  strut(b, 0.14, STEEL2, [10.4, 1.7, -2.2], [10.4, 9.5, 2.2]);
  strut(b, 0.14, STEEL2, [11.2, 1.7, -2.2], [11.2, 9.5, 2.2]);
  for (let i = 0; i < 10; i++) b.add(new THREE.BoxGeometry(1.0, 0.12, 0.42), YELLOW, 10.8, 2.0 + i * 0.76, -1.8 + i * 0.4);

  // 2. Lower Cellar / Process Deck (y = 6.8, 19 m × 19 m) & Main Production Deck (y = 9.5, 22 m × 22 m) with full railings.
  b.add(new THREE.BoxGeometry(19.0, 0.5, 19.0), DECK, 0, 6.55, 0);
  rail([[-9.3, -9.3], [9.3, -9.3], [9.3, 9.3], [-9.3, 9.3], [-9.3, -9.3]], 6.8, 0.9, STEEL2);
  for (const sx of [-6.0, -4.0]) b.add(new THREE.CylinderGeometry(0.65, 0.65, 2.2, 8).rotateZ(Math.PI / 2), ORANGE, sx, 7.5, -5.5);
  b.add(new THREE.BoxGeometry(22.0, 0.9, 22.0), DECK, 0, 9.05, 0);
  for (const sz of [-10.85, 10.85]) b.add(new THREE.BoxGeometry(22.2, 0.3, 0.3), YELLOW, 0, 9.55, sz);
  for (const sx of [-10.85, 10.85]) b.add(new THREE.BoxGeometry(0.3, 0.3, 22.2), YELLOW, sx, 9.55, 0);
  rail([[-10.7, -10.7], [-5.6, -10.7]], 9.6, 1.0);
  rail([[5.6, -10.7], [10.7, -10.7], [10.7, 10.7], [-10.7, 10.7], [-10.7, -10.7]], 9.6, 1.0);

  // 3. Three-storey Living Quarters & Control Room (+x, +z), rooftop HVAC/radomes & free-fall orange lifeboat.
  b.add(new THREE.BoxGeometry(6.8, 6.4, 7.6), WALL, 6.2, 12.7, 5.6);
  for (const y of [11.6, 13.7, 15.6]) {
    b.add(new THREE.BoxGeometry(6.95, 0.68, 6.2), GLASS, 6.2, y, 5.6);
    b.add(new THREE.BoxGeometry(6.92, 0.24, 7.72), ORANGE, 6.2, y - 0.6, 5.6);
  }
  b.add(new THREE.BoxGeometry(7.2, 0.25, 8.0), STEEL2, 6.2, 16.0, 5.6);
  b.add(new THREE.BoxGeometry(1.8, 0.9, 1.4), STEEL, 5.0, 16.5, 4.5);
  b.add(new THREE.SphereGeometry(0.65, 8, 6), WHITE, 7.8, 16.6, 7.0);
  b.add(new THREE.CylinderGeometry(0.08, 0.12, 3.2, 6), DARK, 7.8, 17.6, 4.2);
  // Free-fall orange lifeboat on stern launch davit (+z side)
  b.add(new THREE.CylinderGeometry(0.85, 0.55, 4.2, 8).rotateX(Math.PI / 2).rotateX(-0.55), ORANGE, 6.2, 11.4, 10.8);
  strut(b, 0.14, YELLOW, [5.2, 9.6, 9.6], [5.2, 12.6, 11.4]);
  strut(b, 0.14, YELLOW, [7.2, 9.6, 9.6], [7.2, 12.6, 11.4]);

  // 4. Process Separator Tanks, Manifold Piping, and Offshore Pedestal Crane.
  for (const [z, col] of [[6.2, 0xe6dfd6], [3.2, RED], [0.2, 0x2b6e8c]]) {
    b.add(new THREE.CylinderGeometry(1.05, 1.05, 5.2, 10).rotateZ(Math.PI / 2), col, -6.4, 10.85, z);
    for (const sx of [-8.2, -4.6]) b.add(new THREE.BoxGeometry(0.35, 0.9, 1.6), DARK, sx, 9.95, z);
    strut(b, 0.14, STEEL2, [-4.0, 11.5, z], [-2.5, 11.5, z]);
  }
  strut(b, 0.16, RED, [-4.0, 11.5, -1.0], [-4.0, 11.5, 7.2]);
  // Offshore pedestal crane (-x, -z corner) with cab, A-frame gantry, boom & hook block
  b.add(new THREE.CylinderGeometry(0.65, 0.85, 3.6, 8), YELLOW, -7.8, 11.3, -6.6);
  b.add(new THREE.BoxGeometry(1.6, 1.35, 2.0), YELLOW, -7.8, 13.5, -6.6);
  b.add(new THREE.BoxGeometry(1.0, 0.75, 0.8), GLASS, -8.2, 13.7, -7.3);
  strut(b, 0.12, YELLOW, [-7.8, 14.1, -6.0], [-7.8, 16.5, -6.4]);
  strut(b, 0.22, YELLOW, [-7.8, 13.6, -7.4], [-13.5, 18.8, -11.5]);
  strut(b, 0.04, DARK, [-7.8, 16.5, -6.4], [-13.5, 18.8, -11.5]);
  strut(b, 0.045, DARK, [-13.3, 18.6, -11.3], [-13.3, 13.2, -11.3]);
  b.add(new THREE.BoxGeometry(0.45, 0.55, 0.45), ORANGE, -13.3, 13.0, -11.3);

  // 5. Multi-bay Lattice Drilling Derrick (y = 9.5..27.5) with drill floor, monkeyboard & crown block.
  b.add(new THREE.BoxGeometry(5.6, 0.8, 5.6), STEEL2, -1.5, 9.9, -1.5);
  const tiers = [10.3, 14.2, 18.2, 22.5, 27.0], corner = (y, dx, dz) => {
    const k = 1 - 0.65 * ((y - 10.3) / (27.0 - 10.3));
    return [-1.5 + dx * k, y, -1.5 + dz * k];
  };
  for (const [dx, dz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) {
    strut(b, 0.18, STEEL2, corner(10.3, dx, dz), corner(27.0, dx, dz));
  }
  for (let i = 0; i < tiers.length - 1; i++) {
    const y0 = tiers[i], y1 = tiers[i + 1];
    const faces = [[[-2.4, -2.4], [2.4, -2.4]], [[2.4, -2.4], [2.4, 2.4]], [[2.4, 2.4], [-2.4, 2.4]], [[-2.4, 2.4], [-2.4, -2.4]]];
    for (const [[ax, az], [bx, bz]] of faces) {
      strut(b, 0.09, STEEL, corner(y1, ax, az), corner(y1, bx, bz));
      strut(b, 0.07, STEEL, corner(y0, ax, az), corner(y1, bx, bz));
      strut(b, 0.07, STEEL, corner(y0, bx, bz), corner(y1, ax, az));
    }
  }
  b.add(new THREE.BoxGeometry(2.6, 0.3, 1.6), YELLOW, -1.5, 18.2, -1.5); // monkeyboard
  b.add(new THREE.BoxGeometry(2.2, 0.8, 2.2), YELLOW, -1.5, 27.3, -1.5); // crown block
  b.add(new THREE.SphereGeometry(0.28, 6, 5), RED, -1.5, 28.0, -1.5);
  strut(b, 0.1, YELLOW, [-1.5, 27.0, -1.5], [-1.5, 12.5, -1.5]);

  // 6. Trussed Flare Boom (+x, +z) with gas feed pipe & glowing flare flame.
  const f0 = [8.5, 10.2, 8.5], f1 = [17.8, 19.5, 15.8];
  for (const [ox, oy, oz] of [[0, 0, 0], [0.9, 0.6, -0.5], [-0.5, 0.6, 0.9]]) {
    strut(b, 0.12, STEEL, [f0[0] + ox, f0[1] + oy, f0[2] + oz], [f1[0] + ox * 0.3, f1[1] + oy * 0.3, f1[2] + oz * 0.3]);
  }
  strut(b, 0.09, ORANGE, [7.8, 10.4, 7.8], f1);
  b.add(new THREE.SphereGeometry(0.85, 7, 6), 0xff9a28, f1[0] + 0.3, f1[1] + 0.4, f1[2] + 0.3);
  b.add(new THREE.SphereGeometry(0.5, 6, 5), 0xffe484, f1[0] + 0.5, f1[1] + 0.8, f1[2] + 0.5);

  // 7. Cantilevered Octagonal North Helideck (x = 0, z = -14.5, top at y = 11.2) with H marking, safety netting & perimeter lights.
  b.add(new THREE.CylinderGeometry(6.0, 6.0, 0.45, 8).rotateY(Math.PI / 8), GREEN, 0, 10.975, -14.5);
  b.add(new THREE.CylinderGeometry(6.2, 6.2, 0.25, 8).rotateY(Math.PI / 8), YELLOW, 0, 10.85, -14.5);
  b.add(new THREE.TorusGeometry(3.8, 0.16, 4, 16).rotateX(Math.PI / 2), YELLOW, 0, 11.21, -14.5);
  for (const sx of [-1.6, 1.6]) b.add(new THREE.BoxGeometry(0.55, 0.05, 4.2), WHITE, sx, 11.22, -14.5);
  b.add(new THREE.BoxGeometry(3.2, 0.05, 0.55), WHITE, 0, 11.22, -14.5);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + Math.PI / 8, a1 = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
    const p0 = [Math.cos(a0) * 6.0, 11.15, -14.5 + Math.sin(a0) * 6.0], q0 = [Math.cos(a0) * 6.65, 11.45, -14.5 + Math.sin(a0) * 6.65];
    const q1 = [Math.cos(a1) * 6.65, 11.45, -14.5 + Math.sin(a1) * 6.65];
    strut(b, 0.05, STEEL2, p0, q0);
    strut(b, 0.04, STEEL2, q0, q1);
    b.add(new THREE.BoxGeometry(0.2, 0.14, 0.2), 0x40ff70, p0[0] * 0.96, 11.28, -14.5 + (p0[2] + 14.5) * 0.96);
  }
  for (const sx of [-4.2, 4.2]) {
    strut(b, 0.24, STEEL, [sx, 8.2, -9.0], [sx, 10.8, -17.5]);
    strut(b, 0.18, STEEL, [sx, 9.5, -10.5], [sx, 10.8, -14.5]);
  }
}
function buildOilRig() {
  const O = OILRIG, b = bodyBaker(0.68);
  oilRig(b);
  const g = new THREE.Mesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68 }));
  g.castShadow = g.receiveShadow = true;
  g.position.set(O.x, O.y, O.z);
  const frame = { x: O.x, y: SEA, z: O.z, yaw: 0 };
  solid(frame, 0, 0, 11.0, 4.7, 11.0);             // jacket & main deck underside (y <= 9.4 so landing at 9.5 works)
  solid(frame, 6.2, 5.6, 3.2, 6.9, 3.6);           // living quarters
  solid(frame, -1.5, -1.5, 2.2, 12.2, 2.2);        // derrick tower
  solid(frame, 0, -14.5, 5.5, 5.55, 5.5);          // helideck underside (y <= 11.1 so landing at 11.2 works)
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
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  const place = (fill, at, y, yaw) => { const m = new THREE.Mesh(baked(fill), mat); m.castShadow = m.receiveShadow = true; m.position.set(at.x, y, at.z); m.rotation.y = yaw; return m; };
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
  SOLIDS.length = 0;
  scene.background = C.horizon;
  scene.fog = new THREE.Fog(C.horizon, 350, 2100);
  const hemi = new THREE.HemisphereLight(0xffdec8, 0x725474, 1.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffcc94, 3.3);
  sun.position.copy(SUN_DIR).multiplyScalar(320);
  const sky = buildSky(), water = buildWater();
  const seabed = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: C.deep })); // matches the terrain's deep water, so the map edge doesn't show
  seabed.position.y = FLOOR - 0.5;
  const windsock = buildWindsock();
  const lighthouse = buildLighthouse();
  scene.add(lighthouse, buildOilRig(), sun, sky, seabed, buildTerrain(), ...buildTrees(), buildRocks(), buildRoads(), water, buildPad(PAD, true), buildPad(DEPOT, false), buildRunway(), buildHarbour(), buildLights(), windsock);
  const surf = buildSurf();
  scene.add(surf);
  const houses = [];
  for (const site of SITES) buildSite(site, scene, houses);
  buildProjects(scene, houses);
  return { sky, water, windsock, lighthouse, houses, surf, sun, hemi };
}
