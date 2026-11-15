import * as THREE from 'three';
import { bodyBaker, DARK, GLASS, strut } from './chopper.js';
import { heightAt, OILRIG } from './world.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// MV Kestrel, a 72 m coastal supply ship that circles the island forever. The flat working deck is the aircraft's
// helideck: the integrator reads every number here (never hard-codes them). Local frame: origin amidships on the waterline,
// bow -z, +x starboard.
export const SHIP = {
  name: 'MV Kestrel',
  x: 0, z: 0, y: 0,                // world position of the origin; y = heave on the swell
  yaw: 0,                          // heading: forward is world (-sin yaw, 0, -cos yaw)
  dYaw: 0,                         // change in yaw over the last step, rad
  vx: 0, vz: 0,                    // world velocity, m/s
  speed: 4,                        // cruising speed, m/s
  deck: 5,                         // flat working deck above the origin, m
  pad: { z: -14, r: 6 },           // helideck centre (local z, on the centreline) and radius
  flat: { z0: -27, z1: 6, hw: 6 }, // the flat deck: z from z0 (bow side) to z1, |x| < hw
};

// Route: a circle about the island, the first radius whose whole track (and 60 m either side) is deep water.
const ROUTE = (() => {
  for (let R = 1250; R <= 1550; R += 10) {
    let ok = true;
    for (let k = 0; k < 1440 && ok; k++) for (const o of [-60, 0, 60]) {
      const px = (R + o) * Math.cos(k * Math.PI / 720), pz = (R + o) * Math.sin(k * Math.PI / 720);
      if (heightAt(px, pz) >= -10 || Math.hypot(px - OILRIG.x, pz - OILRIG.z) < 80) { ok = false; break; }
    }
    if (ok) return R;
  }
  return 1550; // ponytail: no circle clear -> open sea edge; vary the radius with angle if a future island needs it
})();
SHIP.loop = (2 * Math.PI * ROUTE) / SHIP.speed; // seconds for one lap

// Where she is at sim time t: anticlockwise round the island at SHIP.speed, heaving a third of the swell under her.
export function stepShip(t, waveAt) {
  const a = (t * SHIP.speed) / ROUTE;
  SHIP.x = ROUTE * Math.cos(a); SHIP.z = ROUTE * Math.sin(a);
  SHIP.vx = -SHIP.speed * Math.sin(a); SHIP.vz = SHIP.speed * Math.cos(a);
  SHIP.yaw = Math.atan2(-SHIP.vx, -SHIP.vz);
  SHIP.y = waveAt ? waveAt(SHIP.x, SHIP.z) / 3 : 0;
}

// World point -> ship frame (inverse of x = X + lx cos + lz sin, z = Z - lx sin + lz cos).
export function toLocal(x, z) {
  const dx = x - SHIP.x, dz = z - SHIP.z, c = Math.cos(SHIP.yaw), s = Math.sin(SHIP.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

// World height of the flat deck under (x, z), or null off it.
export function deckAt(x, z) {
  const p = toLocal(x, z), F = SHIP.flat;
  return p.z >= F.z0 && p.z <= F.z1 && Math.abs(p.x) < F.hw ? SHIP.y + SHIP.deck : null;
}

stepShip(0);

// Sweep a closed ring of points along a path of sections (each [x, y, z][]); winding is fixed to face outward from each ring's centre.
function loft(rings, closed, caps) {
  const out = [], tri = (a, b, c, o) => { const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)); out.push(...(n.dot(o) < 0 ? [a, c, b] : [a, b, c])); };
  const cen = rings.map((r) => r.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(r.length));
  for (let i = 0; i < rings.length - (closed ? 0 : 1); i++) {
    const j = (i + 1) % rings.length, A = rings[i], B = rings[j], n = A.length;
    for (let k = 0; k < n; k++) {
      const l = (k + 1) % n, o = A[k].clone().sub(cen[i]).add(B[k]).sub(cen[j]);
      tri(A[k], A[l], B[k], o); tri(A[l], B[l], B[k], o);
    }
  }
  if (caps) for (const i of [0, rings.length - 1]) for (let k = 0; k < rings[i].length; k++) tri(cen[i], rings[i][k], rings[i][(k + 1) % rings[i].length], cen[i].clone().sub(cen[i ? i - 1 : 1]));
  return new THREE.BufferGeometry().setFromPoints(out);
}

// ---- Model: 72 m coastal freighter. Faired hull (stem -40, transom +32) with flare, a raised forecastle forward, a long flat
// working deck amidships (y = SHIP.deck exactly, nothing on it but paint), and a four-deck white house, bridge, funnel, mast and
// lifeboats aft. Waterline y = 0, keel about 4 m below. One merged static mesh plus the radar. ----
const DK = SHIP.deck, BW = 0.9;                                                      // deck height; bulwark height
const fore = (z) => clamp((-22 - z) / 18, 0, 1);                                     // 0 abaft z = -22, 1 at the stem
const fcDeck = (z) => 8 + 0.9 * fore(z) ** 1.5;                                      // forecastle deck, rising to the bow
const sheer = (z) => (z <= -29 ? fcDeck(z) : z >= -28.6 ? DK : fcDeck(-29) + (DK - fcDeck(-29)) * ((z + 29) / 0.4)); // a steep step down to the flat deck
const beam = (z) => 7.5 * (1 - fore(z) ** 2.4) * (1 - 0.3 * clamp((z - 24) / 8, 0, 1) ** 2) + 0.08; // half-breadth at the deck
const keel = (z) => -4 + 3.2 * fore(z) ** 3 + clamp((z - 26) / 6, 0, 1) ** 2;
const chine = (z) => Math.min(keel(z) + 1.3, -0.35);
const hullX = (z, y) => { const B = beam(z), c = B * (0.8 - 0.22 * fore(z)), yc = chine(z); return c + (B - c) * ((y - yc) / (sheer(z) - yc)) ** 0.8; }; // half-breadth of the topside at height y

export function buildShip(variant = 'helideck') {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.65 });
  const b = bodyBaker(), group = new THREE.Group(), V = THREE.Vector3;
  const WHITE = 0xf1ece0, NAVY = 0x1f3346, GREEN = 0x5f7a6a, ANTIFOUL = 0x8a2a24, STEEL = 0x4a4d57, GREY = 0x8d969a, RED = 0xd8352a, ORANGE = 0xf2763a, YELLOW = 0xe9b93a, BRASS = 0xc9a24a;
  const box = (w, h, d, color, x, y, z) => b.add(new THREE.BoxGeometry(w, h, d), color, x, y, z);
  const cyl = (r0, r1, h, color, x, y, z, seg = 10) => b.add(new THREE.CylinderGeometry(r0, r1, h, seg), color, x, y, z);
  const chain = (r, color, pts) => { for (let i = 1; i < pts.length; i++) strut(b, r, color, pts[i - 1], pts[i]); };
  const rail = (pts, y, color = STEEL, step = 2.6) => {                              // stanchions every ~step m along an [x, z] polyline, two courses
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    out.forEach(([x, z]) => strut(b, 0.035, color, [x, y, z], [x, y + 1.05, z]));
    for (const h of [0.55, 1.05]) chain(0.025, color, out.map(([x, z]) => [x, y + h, z]));
  };

  // Hull. One half-section, keel to deck edge: flat-ish bottom to the chine, flared topside with points at the waterline and
  // the boot-top, then the bulwark out and back in to the deck. Mirrored into a ring whose closing edge is the deck.
  const section = (z) => {
    const B = beam(z), K = keel(z), S = sheer(z), c = B * (0.8 - 0.22 * fore(z)), yc = chine(z);
    const side = [...[0.35, 0.7, 0.9, 1].map((u) => [c * u, K + (yc - K) * u ** 3]), ...[0, 0.6, 0.6 + (S - 0.6) * 0.5, S].map((y) => [hullX(z, y), y]), [B + 0.03, S + BW], [B - 0.1, S + BW], [B - 0.1, S]];
    return [...side.slice().reverse().map(([x, y]) => new V(-x, y, z)), new V(0, K, z), ...side.map(([x, y]) => new V(x, y, z))];
  };
  const zs = [...Array.from({ length: 12 }, (_, i) => -40 + i), -28.6, -27, -24, -22, -12, 0, 8, 16, 22, ...Array.from({ length: 10 }, (_, i) => 23 + i)];
  b.add(loft(zs.map(section), false, true), (x, y, z) => {
    const S = sheer(z), ax = Math.abs(x), B = beam(z);
    if (z > -29.05 && z < -28.55 && ax < B - 0.09) return WHITE;                      // the forecastle bulkhead
    if (y > S - 0.15 && ax < B - 0.09) return y > S + 0.1 ? 0x4a6a78 : GREEN;         // deck; inside of the bulwark
    if (z > 31.9) return y < 0.1 ? ANTIFOUL : NAVY;                                   // transom
    if (y > S + BW - 0.04) return WHITE;                                              // cap rail
    if (y < 0.03) return ANTIFOUL;
    if (variant === 'passenger') return y < 0.62 ? 0x2f7c7a : (y > 3.2 && y < 3.85 ? NAVY : WHITE);
    return y < 0.62 ? WHITE : NAVY;                                                   // boot top, topsides
  }, 0, 0, 0, 6);

  for (const sx of [-1, 1]) {
    chain(0.09, STEEL, zs.filter((z, i) => i % 2 && z > -38 && z < 31).map((z) => [sx * (hullX(z, 3) + 0.05), 3, z])); // rubbing strake
    for (let z = -26; z <= 4; z += 6) box(0.1, 0.25, 0.6, 0x0f1a24, sx * (beam(z) - 0.1), DK + 0.15, z); // scuppers
    for (let z = -37; z <= -30; z += 1.75) b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 8).rotateZ(Math.PI / 2), 0xdde6e8, sx * (hullX(z, 6.6) + 0.02), 6.6, z); // portholes
    for (let z = 8; z <= 20; z += 3) b.add(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 8).rotateZ(Math.PI / 2), 0xdde6e8, sx * (hullX(z, 3.2) + 0.03), 3.2, z);
    for (let k = 0; k < 8; k++) box(0.08, 0.14, 0.4, WHITE, sx * (hullX(29, -2.2 + k * 0.4) + 0.02), -2.2 + k * 0.4, 29); // draught marks at the stern
    // Anchors snug against the flare, chain led from the windlass to the deck pipes.
    const ax = hullX(-32, 7);
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 10).rotateZ(Math.PI / 2), DARK, sx * (ax + 0.02), 7, -32);
    strut(b, 0.07, STEEL, [sx * (ax + 0.24), 7.5, -32.3], [sx * (ax + 0.24), 5.8, -31.6]);
    box(1.0, 0.14, 0.5, STEEL, sx * (ax + 0.24), 5.7, -31.6); box(0.14, 0.5, 0.2, STEEL, sx * (ax + 0.24), 7.55, -32.3);
    cyl(0.3, 0.3, 0.12, DARK, sx * 1.5, fcDeck(-35) + 0.06, -35, 10);
    strut(b, 0.05, STEEL, [sx * 1.0, fcDeck(-33) + 0.5, -33.4], [sx * 1.5, fcDeck(-35) + 0.1, -35]);
    // Bitts on the forecastle, aft deck and bow.
    for (const [x, z] of [[4.6, -31], [3.4, -36.5], [5.8, 26.5], [5, 30.3]]) for (const dz of [-0.3, 0.3]) cyl(0.12, 0.15, 0.7, DARK, sx * x, sheer(z) + 0.35, z + dz, 8), box(0.22, 0.12, 0.9, DARK, sx * x, sheer(z) + 0.72, z);
    // Aft deck: mooring winches, vents, fairleads.
    for (const z of [24.5, 28]) b.add(new THREE.CylinderGeometry(0.4, 0.4, 0.8, 10).rotateZ(Math.PI / 2), STEEL, sx * 3.2, DK + 0.75, z), box(1.4, 0.35, 1.0, DARK, sx * 3.2, DK + 0.18, z);
    cyl(0.14, 0.16, 0.8, STEEL, sx * 5.6, DK + 0.4, 22.9, 8); cyl(0.45, 0.14, 0.4, RED, sx * 5.6, DK + 1.0, 22.9, 8);
    box(0.5, 0.4, 0.3, STEEL, sx * (beam(31) - 0.5), DK + 0.2, 31.5);
    // Ladders on the forecastle bulkhead and up the after end of the house.
    for (const x of [4.6, 5.4]) strut(b, 0.03, STEEL, [sx * x, DK + 0.1, -28.5], [sx * x, 8.1, -29.05]);
    for (let y = DK + 0.4; y < 8.1; y += 0.6) strut(b, 0.02, STEEL, [sx * 4.6, y, -28.62 - (y - DK) * 0.13], [sx * 5.4, y, -28.62 - (y - DK) * 0.13]);
    for (const x of [5.2, 5.9]) strut(b, 0.03, STEEL, [sx * x, DK + 0.1, 22.7], [sx * x, 10.8, 22.7]);
    for (let y = DK + 0.4; y < 10.6; y += 0.6) strut(b, 0.02, STEEL, [sx * 5.2, y, 22.7], [sx * 5.9, y, 22.7]);
    // Life rings and doors on the house sides.
    for (const z of [8.5, 21]) b.add(new THREE.TorusGeometry(0.4, 0.1, 6, 12).rotateY(Math.PI / 2), ORANGE, sx * 6.9, 8.6, z);
    box(0.12, 1.9, 0.95, 0x7f8a90, sx * 6.82, DK + 1.0, 14.5);
    // Running gear and rudder, twin skegs.
    box(0.4, 3.1, 1.6, ANTIFOUL, sx * 1.9, -2.4, 31.2);
    b.add(new THREE.CylinderGeometry(0.22, 0.14, 0.6, 8).rotateX(Math.PI / 2), BRASS, sx * 1.9, -3.1, 30.2);
    for (let k = 0; k < 4; k++) b.add(new THREE.BoxGeometry(0.9, 0.3, 0.06).translate(0.5, 0, 0).rotateX(0.5).rotateZ((k * Math.PI) / 2), BRASS, sx * 1.9, -3.1, 29.85);
  }
  // Rails round the stern and the edge of the forecastle deck.
  rail([[-beam(23) + 0.05, 23], [-beam(32) + 0.05, 32], [beam(32) - 0.05, 32], [beam(23) - 0.05, 23]], DK + BW - 0.05);
  rail([[-beam(-30.5) + 0.05, -30.5], [-beam(-39) + 0.05, -39]], 8.45 + BW, STEEL, 2.2);
  rail([[beam(-30.5) - 0.05, -30.5], [beam(-39) - 0.05, -39]], 8.45 + BW, STEEL, 2.2);
  strut(b, 0.025, WHITE, [0, fcDeck(-39.4) + 0.1, -39.4], [0, fcDeck(-39.4) + 2, -39.6]);             // jackstaff
  box(0.02, 0.4, 0.55, RED, 0, fcDeck(-39.4) + 1.8, -39.4);

  // Forecastle: windlass with gypsies, foremast with stays and lights, vents.
  const fy = fcDeck(-33);
  box(2.2, 0.4, 1.3, STEEL, 0, fy + 0.2, -33.4);
  for (const sx of [-1, 1]) b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 10).rotateZ(Math.PI / 2), DARK, sx * 1.0, fy + 0.65, -33.4);
  b.add(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8).rotateZ(Math.PI / 2), STEEL, 0, fy + 0.65, -33.4);
  const mz = -35.4, my = fcDeck(mz);
  cyl(0.28, 0.32, 0.4, STEEL, 0, my + 0.2, mz, 10); strut(b, 0.17, WHITE, [0, my + 0.3, mz], [0, my + 7.5, mz]);
  strut(b, 0.05, WHITE, [-1.7, my + 5.1, mz], [1.7, my + 5.1, mz]);
  for (const [x, c] of [[-1.55, 0xff3030], [1.55, 0x30e070]]) box(0.2, 0.2, 0.2, c, x, my + 5.3, mz);
  cyl(0.1, 0.1, 0.2, 0xfff8e0, 0, my + 7.7, mz, 8); box(0.3, 0.18, 0.3, 0xfff8e0, 0, my + 6.2, mz - 0.22);
  strut(b, 0.025, STEEL, [0, my + 6.6, mz], [0, fcDeck(-30.5) + 0.1, -30.5]); strut(b, 0.025, STEEL, [0, my + 6.6, mz], [0, fcDeck(-39) + 0.1, -39]);
  for (const sx of [-1, 1]) strut(b, 0.025, STEEL, [0, my + 4.4, mz], [sx * 2.4, fcDeck(-33.5) + 0.1, -33.5]);
  for (const sx of [-1, 1]) { cyl(0.14, 0.16, 0.9, STEEL, sx * 2.4, fcDeck(-37.5) + 0.45, -37.5, 8); cyl(0.4, 0.14, 0.4, RED, sx * 2.4, fcDeck(-37.5) + 1.1, -37.5, 8); }

  // Flat deck: painted only. Helideck ring and H, flush hatch panels, yellow edge lines.
  const pz = SHIP.pad.z, pr = SHIP.pad.r;
  b.add(new THREE.RingGeometry(pr - 1.25, pr - 0.75, 56).rotateX(-Math.PI / 2), YELLOW, 0, DK + 0.04, pz);
  for (const sx of [-1, 1]) box(0.5, 0.04, 3.4, WHITE, sx * 0.9, DK + 0.02, pz);
  box(1.3, 0.04, 0.5, WHITE, 0, DK + 0.02, pz);
  for (const z of [-24.5, -3, 1.5]) box(8, 0.03, z < -20 ? 2.4 : 2.5, 0x6d8a78, 0, DK + 0.015, z);
  for (const sx of [-1, 1]) box(0.25, 0.03, 31, YELLOW, sx * 6.5, DK + 0.015, -11);

  // Cabins: a rounded-corner plan lofted through levels [y, scale, forward lean]; then glass panes set just proud of the wall.
  const plan = (hw, z0, z1, r, step) => {
    const pts = [], kind = [];
    const line = (ax, az, bx, bz, k) => { const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step)); for (let i = 0; i < n; i++) { pts.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]); kind.push(k + (i % 4)); } };
    const arc = (cx, cz, a0) => { for (let i = 0; i < 3; i++) { const a = a0 + ((i / 3) * Math.PI) / 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); kind.push('c'); } };
    line(-hw + r, z0, hw - r, z0, 'f'); arc(hw - r, z0 + r, -Math.PI / 2); line(hw, z0 + r, hw, z1 - r, 's'); arc(hw - r, z1 - r, 0);
    line(hw - r, z1, -hw + r, z1, 'b'); arc(-hw + r, z1 - r, Math.PI / 2); line(-hw, z1 - r, -hw, z0 + r, 's'); arc(-hw + r, z0 + r, Math.PI);
    return { pts, kind, z0, z1 };
  };
  const ringAt = (P, [y, s = 1, lean = 0]) => P.pts.map(([x, z]) => new V(x * s, y, z - (lean * (P.z1 - z)) / (P.z1 - P.z0)));
  const cabin = (P, levels, color) => b.add(loft(levels.map((l) => ringAt(P, l)), false, true), color, 0, 0, 0, 6);
  const panes = (P, lo, hi, pick) => {
    const A = ringAt(P, lo), B = ringAt(P, hi), n = A.length, out = [];
    for (let i = 0; i < n; i++) {
      if (!pick(P.kind[i])) continue;
      const q = [A[i], A[(i + 1) % n], B[(i + 1) % n], B[i]], c = q.reduce((m, p) => m.add(p), new V()).multiplyScalar(0.25), o = new V(c.x, 0, c.z - (P.z0 + P.z1) / 2).normalize().multiplyScalar(0.03);
      const [p0, p1, p2, p3] = q.map((p) => p.clone().lerp(c, 0.12).add(o)), nrm = new V().subVectors(p1, p0).cross(new V().subVectors(p2, p0));
      out.push(...(nrm.dot(o) > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2]));
    }
    b.add(new THREE.BufferGeometry().setFromPoints(out), GLASS);
  };
  const win = (k) => k !== 'c' && k[1] !== '3';
  const lip = (P, y, s = 1.02, lean = 0) => cabin(P, [[y, s, lean], [y + 0.14, s, lean]], GREY); // roof edge, a lip proud of the walls
  let my0 = 19.66, mz0 = 12;
  if (variant === 'passenger') {
    const TEAL = 0x2f7c7a, POOL = 0x3ec5d4;
    // Three-tier stepped passenger superstructure running almost full length, with forward bridge, promenade lifeboats & lido sun deck.
    const t1 = plan(6.4, -24, 24, 1.8, 1.8), t2 = plan(5.5, -20, 20, 1.5, 1.5), pbr = plan(5.0, -22, -12, 1.2, 1.2);
    cabin(t1, [[DK], [DK + 3.0]], (x, y) => (y < DK + 0.4 ? TEAL : WHITE)); lip(t1, DK + 3.0, 1.02);
    panes(t1, [DK + 0.9], [DK + 2.3], (k) => k !== 'c');
    cabin(t2, [[DK + 3.14], [DK + 6.0]], WHITE); lip(t2, DK + 6.0, 1.02);
    panes(t2, [DK + 3.9], [DK + 5.2], (k) => k !== 'c');
    // Forward-raked navigation bridge & bridge wings
    cabin(pbr, [[DK + 6.14], [DK + 6.9], [DK + 8.7, 1, 1], [DK + 9.2, 1, 1]], WHITE);
    panes(pbr, [DK + 6.9], [DK + 8.7, 1, 1], () => true);
    b.add(loft([[DK + 9.2, 1.07, 1.5], [DK + 9.38, 1.07, 1.5]].map((l) => ringAt(pbr, l)), false, true), TEAL, 0, 0, 0, 6);
    for (const sx of [-1, 1]) {
      box(3.4, 0.16, 3.2, WHITE, sx * 5.8, DK + 6.18, -17.5);
      for (const z of [-18.8, -16.2]) strut(b, 0.07, STEEL, [sx * 7.2, DK + 6.1, -17.5 + (z + 17.5)], [sx * 4.7, DK + 4.4, -17.5 + (z + 17.5)]);
      box(0.1, 0.18, 0.18, sx < 0 ? 0xff3030 : 0x30e070, sx * 7.47, DK + 7.5, -19.0);
      // Promenade lifeboats on davits
      for (const lz of [2.0, 11.5]) {
        const lx = sx * 5.95, ly = DK + 3.25;
        b.add(loft([[-2.8, 0.06, 0.1], [-2.3, 0.5, 0.85], [-1.3, 0.78, 1.5], [1.3, 0.78, 1.5], [2.3, 0.65, 1.3], [2.8, 0.35, 0.8]].map(([z, w, h]) => Array.from({ length: 10 }, (_, k) => { const a = (k / 10) * Math.PI * 2; return new V(lx + w * Math.cos(a), ly + h * (0.5 + 0.5 * Math.sin(a)), lz + z); })), false, true), (x, y) => (y > ly + 1.1 ? 0xfff8e0 : y > ly + 0.5 ? ORANGE : DARK), 0, 0, 0, 6);
        for (const dz of [-1.6, 1.6]) chain(0.08, STEEL, [[sx * 5.2, DK + 3.1, lz + dz], [sx * 5.2, DK + 5.6, lz + dz], [lx, DK + 5.8, lz + dz]]);
      }
    }
    // Lido sun deck: swimming pool, loungers, railings & aft cruise funnel
    box(4.8, 0.22, 8.6, TEAL, 0, DK + 6.16, -2.5);
    box(4.2, 0.24, 8.0, POOL, 0, DK + 6.18, -2.5);
    for (let z = -7.5; z <= 3.5; z += 2.6) for (const sx of [-3.4, 3.4]) box(1.1, 0.28, 1.8, ORANGE, sx, DK + 6.28, z);
    rail([[-4.8, -11.5], [-4.8, 18.5], [4.8, 18.5], [4.8, -11.5]], DK + 6.18, STEEL, 2.8);
    const pfn = plan(2.2, 9.5, 16.0, 0.9, 1.2);
    cabin(pfn, [[DK + 6.14], [DK + 9.2, 0.94, -0.4], [DK + 12.2, 0.86, -0.8], [DK + 13.8, 0.8, -1.0]], (x, y) => (y > DK + 12.8 ? DARK : y > DK + 11.4 ? ORANGE : TEAL));
    for (const sx of [-0.7, 0.7]) cyl(0.28, 0.32, 0.9, STEEL, sx, DK + 14.2, 13.5, 8);
    // Forward mast, satcom domes & radar
    my0 = DK + 9.38; mz0 = -17.0;
    strut(b, 0.18, WHITE, [0, my0, mz0], [0, my0 + 7.2, mz0]);
    box(1.8, 0.12, 1.8, STEEL, 0, my0 + 4.2, mz0);
    strut(b, 0.04, WHITE, [-2.4, my0 + 5.8, mz0 + 0.2], [2.4, my0 + 5.8, mz0 + 0.2]);
    for (const sx of [-2.4, 2.4]) b.add(new THREE.SphereGeometry(0.65, 10, 7), WHITE, sx, my0 + 0.65, mz0 + 2.8), cyl(0.25, 0.35, 0.4, WHITE, sx, my0 + 0.2, mz0 + 2.8, 8);
  } else {
  // Decks 1 and 2: the main block, windows in two rows; deck 3 and 4 set back, leaving a lifeboat deck on the roof of deck 2.
  const d12 = plan(6.8, 7, 22.5, 1.4, 1.5), d3 = plan(4.9, 8, 21.2, 1.0, 1.4), d4 = plan(4.6, 8.4, 20.6, 0.9, 1.4);
  cabin(d12, [[DK], [10.6]], (x, y) => (y < DK + 0.5 ? GREY : WHITE)); lip(d12, 10.6, 1.015);
  panes(d12, [6.2], [7.4], win); panes(d12, [8.9], [10.1], win);
  cabin(d3, [[10.74], [13.5]], WHITE); lip(d3, 13.5, 1.02); panes(d3, [11.5], [12.8], win);
  cabin(d4, [[13.64], [16.2]], WHITE); lip(d4, 16.2, 1.02); panes(d4, [14.3], [15.5], win);
  box(1.3, 2.0, 0.12, 0x7f8a90, 0, DK + 1.0, 6.96);                                 // door on the front of the house, towards the helideck
  box(1.0, 1.7, 0.12, 0x7f8a90, 3.5, 12.05, 20.85); box(1.0, 1.7, 0.12, 0x7f8a90, -3.5, 12.05, 20.85);
  // Bridge: wraparound glass leaning forward, roof with a brow, wings out past the hull each side.
  const br = plan(4.9, 9.0, 15.0, 0.9, 1.2);
  cabin(br, [[16.34], [17.2], [18.9, 1, 1], [19.5, 1, 1]], WHITE); panes(br, [17.2], [18.9, 1, 1], () => true);
  b.add(loft([[19.5, 1.07, 1.5], [19.66, 1.07, 1.5]].map((l) => ringAt(br, l)), false, true), DARK, 0, 0, 0, 6);
  box(9.8, 0.14, 6.0, GREY, 0, 16.27, 12);                                          // bridge floor, also the roof of deck 4
  for (const sx of [-1, 1]) {
    box(3.9, 0.16, 3.4, WHITE, sx * 6.1, 16.3, 11.7);                                // bridge wing
    for (const z of [10.4, 13]) strut(b, 0.07, STEEL, [sx * 7.6, 16.2, z], [sx * 4.7, 14.3, z]);
    rail([[sx * 8, 10], [sx * 8, 13.4], [sx * 4.9, 13.4]], 16.38, STEEL, 2);
    box(0.1, 0.18, 0.18, sx < 0 ? 0xff3030 : 0x30e070, sx * 7.97, 17.8, 10.1); box(0.06, 0.4, 0.3, DARK, sx * 8, 17.8, 10.2);
    b.add(new THREE.CylinderGeometry(0.5, 0.5, 1.1, 12).rotateX(Math.PI / 2), WHITE, sx * 3.5, 16.95, 17.6);     // liferaft canisters on the roof of deck 4, in cradles
    for (const dz of [-0.4, 0.4]) box(0.14, 0.5, 0.12, STEEL, sx * 3.5, 16.45, 17.6 + dz), b.add(new THREE.TorusGeometry(0.5, 0.03, 4, 12), DARK, sx * 3.5, 16.95, 17.6 + dz * 1.2);
    // Lifeboat on the roof of deck 2: orange canopied hull in a cradle, with davit posts, arms and falls.
    const lx = sx * 5.85, ly = 10.85, lz = 12.3;
    b.add(loft([[-3.2, 0.06, 0.1], [-2.7, 0.55, 0.9], [-1.6, 0.85, 1.7], [1.6, 0.85, 1.7], [2.7, 0.7, 1.5], [3.2, 0.4, 0.9]].map(([z, w, h]) => Array.from({ length: 10 }, (_, k) => { const a = (k / 10) * Math.PI * 2; return new V(lx + w * Math.cos(a), ly + h * (0.5 + 0.5 * Math.sin(a)), lz + z); })), false, true), (x, y) => (y > ly + 1.3 ? 0xfff8e0 : y > ly + 0.6 ? ORANGE : DARK), 0, 0, 0, 6);
    for (const dz of [-1.9, 1.9]) {
      box(1.9, 0.14, 0.2, STEEL, lx, 10.7, lz + dz);                                  // cradle
      chain(0.09, STEEL, [[sx * 5.0, 10.6, lz + dz * 1.2], [sx * 5.0, 14.0, lz + dz * 1.2], [lx, 14.5, lz + dz * 1.2]]);
      strut(b, 0.02, DARK, [lx, 14.45, lz + dz * 1.2], [lx, ly + 1.55, lz + dz]);
    }
    for (const z of [-0.8, 0.6]) box(0.06, 0.4, 0.7, GLASS, lx + sx * 0.5, ly + 1.35, lz + z); // canopy windows
    rail([[sx * 6.75, 15.6], [sx * 6.75, 22.3]], 10.7, STEEL, 2.4); rail([[sx * 6.75, 7.3], [sx * 6.75, 9]], 10.7, STEEL, 2.4);
  }
  rail([[-6.75, 22.3], [6.75, 22.3]], 10.7, STEEL, 2.4); rail([[-6.75, 7.2], [6.75, 7.2]], 10.7, STEEL, 2.4);
  rail([[-4.45, 20.4], [4.45, 20.4]], 16.38, STEEL, 2.4); rail([[-4.45, 20.4], [-4.45, 15.6]], 16.38, STEEL, 2.4); rail([[4.45, 20.4], [4.45, 15.6]], 16.38, STEEL, 2.4);
  for (let x = -3.6; x <= 3.6; x += 1.8) box(0.5, 0.4, 0.5, STEEL, x, 10.9, 20.2);   // vents on the lifeboat deck
  for (const sx of [-1, 1]) for (const z of [11.6, 14]) strut(b, 0.04, STEEL, [sx * 4.65, 16.3, z], [sx * 4.65, 19.3, z]); // bridge door handrails
  box(0.1, 0.5, 1.1, WHITE, 0, 17.4, 8.9);                                           // spray dodger

  // Funnel: tapered casing with a red band and black top, twin exhausts abaft the bridge.
  const fn = plan(2.1, 16.2, 20.2, 0.8, 1.0);
  cabin(fn, [[16.34], [19.5, 0.95], [22.2, 0.88], [24.4, 0.84]], (x, y) => (y > 23.4 ? DARK : y > 21.3 ? RED : NAVY));
  for (const sx of [-0.8, 0.8]) cyl(0.3, 0.34, 1.0, STEEL, sx, 24.8, 18.6, 8), cyl(0.38, 0.38, 0.1, DARK, sx, 25.35, 18.6, 8);
  box(1.4, 0.8, 0.1, STEEL, 0, 18.6, 16.12);                                         // vent grille
  for (const y of [17.5, 18.6, 19.7]) strut(b, 0.02, STEEL, [-0.5, y, 16.08], [0.5, y, 16.08]);

  // Mast: a pole on a tripod on the bridge roof, radar platform, yard with lights, aerials, domes, horns.
  strut(b, 0.2, WHITE, [0, my0, mz0], [0, my0 + 9.5, mz0]);
  for (const [x, z] of [[-1.6, mz0 + 0.9], [1.6, mz0 + 0.9], [0, mz0 - 1.8]]) strut(b, 0.1, WHITE, [x, my0, z], [0, my0 + 3.6, mz0]);
  box(2.0, 0.12, 2.0, STEEL, 0, my0 + 5.5, mz0);                                      // radar platform
  for (const [x, z] of [[-0.9, 0.9], [0.9, 0.9], [-0.9, -0.9], [0.9, -0.9]]) strut(b, 0.03, STEEL, [x, my0 + 5.55, mz0 + z], [x, my0 + 6.5, mz0 + z]);
  chain(0.025, STEEL, [[-0.9, my0 + 6.5, mz0 + 0.9], [0.9, my0 + 6.5, mz0 + 0.9], [0.9, my0 + 6.5, mz0 - 0.9], [-0.9, my0 + 6.5, mz0 - 0.9], [-0.9, my0 + 6.5, mz0 + 0.9]]);
  strut(b, 0.045, WHITE, [-2.6, my0 + 7.8, mz0 + 0.2], [2.6, my0 + 7.8, mz0 + 0.2]);   // yard
  for (const [x, c] of [[-2.5, 0xff3030], [2.5, 0x30e070]]) box(0.14, 0.18, 0.14, c, x, my0 + 7.95, mz0 + 0.2);
  cyl(0.1, 0.1, 0.2, 0xfff8e0, 0, my0 + 9.6, mz0, 8); box(0.3, 0.2, 0.3, 0xfff8e0, 0, my0 + 6.8, mz0 - 0.3);
  strut(b, 0.015, STEEL, [0.2, my0 + 9.5, mz0], [0.3, my0 + 11.4, mz0 + 0.1]); strut(b, 0.015, STEEL, [2.5, my0 + 8, mz0], [2.6, my0 + 9.6, mz0]); strut(b, 0.015, STEEL, [-2.5, my0 + 8, mz0], [-2.6, my0 + 9.8, mz0]);
  b.add(new THREE.SphereGeometry(0.5, 10, 7), WHITE, 3.2, my0 + 0.55, 14); cyl(0.2, 0.28, 0.4, WHITE, 3.2, my0 + 0.2, 14, 8); // satcom dome
  b.add(new THREE.SphereGeometry(0.2, 8, 5), WHITE, -3, my0 + 0.5, 11); cyl(0.04, 0.04, 0.4, STEEL, -3, my0 + 0.2, 11, 6);   // GPS
  for (const sx of [-0.2, 0.2]) b.add(new THREE.CylinderGeometry(0.16, 0.05, 0.8, 10).rotateX(-Math.PI / 2), RED, -2.5 + sx, my0 + 0.4, 10.2); // horns
  box(0.7, 0.2, 0.3, STEEL, -2.5, my0 + 0.2, 10.5);
  box(2.2, 0.18, 0.34, 0x2f6fe0, 0, 19.7, 8.3); box(2.3, 0.1, 0.38, DARK, 0, 19.6, 8.3);   // light bar on the brow
  }
  // Stern: flagstaff and ensign, stern light.
  strut(b, 0.05, WHITE, [0, DK + BW - 0.1, 31.6], [0, DK + 5.2, 31.4]);
  b.add(new THREE.PlaneGeometry(1.4, 0.9, 4, 1), (x) => (x > 0.35 ? RED : WHITE), 0.75, DK + 4.6, 31.4);
  box(0.2, 0.2, 0.15, 0xfff8e0, 0, DK + 2, 32.05);
  if (variant === 'cargo') {
    const BOXES = [0xc8452e, 0x2b6e8c, 0xd49a38, 0x3a7a5c, 0xf2763a];
    for (let i = 0; i < 4; i++) for (const sx of [-2.7, 2.7]) for (let h = 0; h < (i % 2 ? 2 : 3); h++) {
      box(2.4, 2.5, 6.0, BOXES[(i * 3 + h + (sx > 0 ? 1 : 0)) % BOXES.length], sx, DK + 1.25 + h * 2.52, -23.5 + i * 6.8);
    }
    cyl(0.45, 0.55, 5.2, YELLOW, 0, DK + 2.6, -13.5, 8);
    strut(b, 0.22, YELLOW, [0, DK + 4.8, -13.5], [0, DK + 9.2, -21.0]);
  }
  const shipMesh = new THREE.Mesh(b.geometry(), mat);
  shipMesh.castShadow = shipMesh.receiveShadow = true;
  group.add(shipMesh);

  // The scanner turns on top of the mast.
  const pb = bodyBaker();
  pb.add(new THREE.BoxGeometry(3.6, 0.22, 0.3), WHITE, 0, 0.35, 0); pb.add(new THREE.BoxGeometry(3.6, 0.06, 0.34), DARK, 0, 0.2, 0);
  pb.add(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), STEEL, 0, 0.12, 0); pb.add(new THREE.BoxGeometry(0.7, 0.3, 0.5), WHITE, 0, 0, 0);
  const radar = new THREE.Mesh(pb.geometry(), mat);
  radar.castShadow = radar.receiveShadow = true;
  radar.position.set(0, my0 + (variant === 'passenger' ? 4.42 : 5.72), mz0); group.add(radar);
  group.rotation.order = 'YXZ';
  return { group, update(dt) {
    group.position.set(SHIP.x, SHIP.y, SHIP.z); group.rotation.y = SHIP.yaw;
    radar.rotation.y += dt * 2.2;
  } };
}
