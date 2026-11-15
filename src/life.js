import * as THREE from 'three';
import { bodyBaker, strut } from './chopper.js';
import { makeWake } from './fx.js';
import { buildShip } from './ship.js';
import { heightAt, mulberry32, OILRIG, SEED, SITES, LIGHTHOUSE, HARBOUR, ROADS, waveAt } from './world.js';

// Ambient scenery that moves: drifting clouds, circling seabirds, sailboats, dolphins, buoys and trawlers. Pure decoration (no collision),
// one instanced draw call each.
const UP = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), p = new THREE.Vector3(), sc = new THREE.Vector3();

function clouds(scene, rng) {
  const b = bodyBaker(0.72);
  // Warm up the cloud vertex colors and sunset under-glow (tint lower puff vertices soft peach-gold 0xffdfc8 and upper vertices 0xfff6ee)
  for (const [x, y, z, r] of [[0, 0, 0, 1], [1.1, -0.2, 0.3, 0.75], [-1, -0.25, -0.2, 0.7], [0.3, 0.35, -0.4, 0.6]]) {
    b.add(new THREE.IcosahedronGeometry(r, 2), (vx, vy) => (vy < 0 ? 0xffdfc8 : 0xfff6ee), x, y, z);
  }
  const n = 34, mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, emissive: 0x6a4452 }), n);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const list = Array.from({ length: n }, () => ({ x: (rng() - 0.5) * 4000, z: (rng() - 0.5) * 4000, y: 280 + rng() * 160, s: 22 + rng() * 40, yaw: rng() * 6.28 }));
  return (t) => {
    list.forEach((c, i) => {
      const x = ((c.x + t * 6 + 2000) % 4000) - 2000, z = ((c.z + t * 3 + 2000) % 4000) - 2000; // drift on the prevailing wind, wrapping
      mesh.setMatrixAt(i, m.compose(p.set(x, c.y, z), q.setFromAxisAngle(UP, c.yaw), sc.set(c.s, c.s * 0.55, c.s * 0.8)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// Gull flocks wheeling over the towns and the lighthouse. Wings flap by flipping the V's y scale.
function birds(scene, rng) {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.4, -1.4, 0.5, 0.1, 0, 0, 0.3, 0, 0, -0.4, 0, 0, 0.3, 1.4, 0.5, 0.1], 3));
  const flocks = [...SITES, LIGHTHOUSE].map((c) => ({ x: c.x, z: c.z, y: Math.max(c.y, 0) + 45 + rng() * 30, r: 50 + rng() * 60, w: (rng() < 0.5 ? -1 : 1) * (0.12 + rng() * 0.06) }));
  const per = 7, mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xf6efe8, side: THREE.DoubleSide }), flocks.length * per);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const birds = flocks.flatMap((f) => Array.from({ length: per }, () => ({ f, a: rng() * 0.9, dr: (rng() - 0.5) * 30, dy: (rng() - 0.5) * 14, flap: rng() * 6, rate: 7 + rng() * 3 })));
  return (t) => {
    birds.forEach((b, i) => {
      const f = b.f, a = f.w * t + b.a, r = f.r + b.dr + Math.sin(t * 0.3 + b.flap) * 10;
      const glide = Math.sin(t * 0.7 + b.flap) > 0.3; // flap in bursts, glide between
      e.set(0.05, a + (f.w > 0 ? 0 : Math.PI), -Math.sign(f.w) * 0.35);
      m.compose(p.set(f.x + Math.cos(a) * r, f.y + b.dy + Math.sin(t * 0.5 + b.flap) * 3, f.z - Math.sin(a) * r), q.setFromEuler(e), sc.set(1.3, glide ? 0.15 : 1.3 * Math.sin(t * b.rate + b.flap), 1.3));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// Detailed low-poly sloop sailboat (~10 m long). Nose toward -z, waterline at y = 0.
export function sailboat(b, wake = true) {
  const HULL = (x, y) => (y < 0.16 ? 0x7a2f2a : y > 0.78 ? 0x2f7c7a : 0xf6efe6);
  const DECK = 0xc8a47e, CABIN = 0xf4ede4, DARK = 0x2a2a32, SAIL = 0xfff3df;
  // Sculpted hull: beamy midship (z = -2.2..3.2), seamless tapered bow prism (z = -5.4..-2.2), teak deck & cockpit
  b.add(new THREE.BoxGeometry(2.5, 1.05, 5.4), HULL, 0, 0.42, 0.5);
  b.add(new THREE.CylinderGeometry(0, 1.768, 3.2, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2).scale(1, 0.42, 1), HULL, 0, 0.42, -3.8);
  b.add(new THREE.BoxGeometry(2.2, 0.12, 4.8), DECK, 0, 0.96, 0.4);                                         // teak deck
  b.add(new THREE.CylinderGeometry(0, 1.55, 2.8, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2).scale(1, 0.05, 1), DECK, 0, 0.96, -3.4); // foredeck
  b.add(new THREE.BoxGeometry(2.2, 0.25, 0.18), 0x2f7c7a, 0, 1.05, 3.15);                                  // stern transom
  b.add(new THREE.BoxGeometry(1.55, 0.52, 2.2), CABIN, 0, 1.24, -0.35);                                    // cabin coachroof
  b.add(new THREE.BoxGeometry(1.62, 0.22, 1.5), 0xffcf7c, 0, 1.28, -0.35);                                 // warm glowing cabin windows
  b.add(new THREE.BoxGeometry(0.42, 0.35, 0.08), DARK, 0, 1.15, 1.9);                                      // helm pedestal & wheel
  b.add(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 8).rotateX(Math.PI / 2), 0xc89658, 0, 1.32, 1.95);
  // Bowsprit, forestay, mast, spreaders, boom, and solid double-sided mainsail + jib
  strut(b, 0.04, DARK, [0, 0.92, -4.2], [0, 1.06, -6.1]);                                                  // bowsprit anchored on foredeck
  strut(b, 0.02, DARK, [0, 1.06, -5.9], [0, 8.5, -0.6]);                                                   // forestay
  b.add(new THREE.CylinderGeometry(0.06, 0.09, 8.2, 6), DARK, 0, 5.0, -0.6);                               // mast
  b.add(new THREE.BoxGeometry(1.4, 0.06, 0.06), DARK, 0, 5.6, -0.6);                                       // spreaders
  strut(b, 0.045, DARK, [0, 1.75, -0.6], [0, 1.75, 2.9]);                                                  // boom
  const sailGeo = (pts) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth: 0.05, bevelEnabled: false }).rotateY(-Math.PI / 2);
  b.add(sailGeo([[0, 0], [3.3, 0], [0, 7.0]]), SAIL, 0.025, 1.8, -0.55);                                   // mainsail (visible both sides)
  b.add(sailGeo([[0, 0], [2.8, 0], [2.8, 6.7]]), SAIL, 0.025, 1.3, -3.5);                                  // jib (visible both sides)
  b.add(new THREE.CylinderGeometry(0.08, 0.08, 0.18, 6), 0xffe8a8, 0, 9.15, -0.6);                         // masthead light
  if (wake) b.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-1.1, 0), new THREE.Vector2(1.1, 0), new THREE.Vector2(4, 16), new THREE.Vector2(-4, 16)])).rotateX(Math.PI / 2), 0xd7ecea, 0, 0.12, 3.4);
}
// Sailboats on slow loops through open water (each loop checked to stay clear of land).
function boats(scene, rng) {
  const b = bodyBaker();
  sailboat(b, true);
  const loops = [];
  for (let tries = 0; tries < 400 && loops.length < 7; tries++) {
    const x = (rng() - 0.5) * 2600, z = (rng() - 0.5) * 2600, r = 80 + rng() * 220;
    if ([...Array(24)].some((_, k) => {
      const a = k / 3.82, ax = x + Math.cos(a) * (r + 25), az = z + Math.sin(a) * (r + 25), bx = x + Math.cos(a) * (r - 25), bz = z + Math.sin(a) * (r - 25);
      return heightAt(ax, az) > -3 || heightAt(bx, bz) > -3 || Math.hypot(ax - OILRIG.x, az - OILRIG.z) < 45 || Math.hypot(bx - OILRIG.x, bz - OILRIG.z) < 45;
    })) continue;
    loops.push({ x, z, r, w: ((rng() < 0.5 ? -1 : 1) * 5) / r, a: rng() * 6.28 });
  }
  const mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }), loops.length);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return (t) => {
    loops.forEach((l, i) => {
      const a = l.a + l.w * t;
      e.set(Math.sin(t * 0.9 + i) * 0.03, (l.w > 0 ? Math.PI : 0) - a, Math.sign(l.w) * 0.12 + Math.sin(t * 1.3 + i) * 0.05); // heel into the turn, bob on the swell
      mesh.setMatrixAt(i, m.compose(p.set(l.x + Math.cos(a) * l.r, Math.sin(t * 1.1 + i * 2) * 0.2 - 0.3, l.z + Math.sin(a) * l.r), q.setFromEuler(e), sc.set(1, 1, 1)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// n loops of radius r0..r1 whose ring stays pad metres clear of anything shallower than depth; w is angular speed for a ground speed.
function loops(rng, n, r0, r1, pad, depth, speed) {
  const out = [], bad = (x, z, r, k) => { const px = x + Math.cos(k * 0.27) * r, pz = z + Math.sin(k * 0.27) * r; return heightAt(px, pz) > depth || Math.hypot(px - OILRIG.x, pz - OILRIG.z) < 45; };
  for (let tries = 0; tries < 800 && out.length < n; tries++) {
    const x = (rng() - 0.5) * 2600, z = (rng() - 0.5) * 2600, r = r0 + rng() * (r1 - r0);
    if ([...Array(24)].some((_, k) => bad(x, z, r + pad, k) || bad(x, z, r - pad, k))) continue;
    out.push({ x, z, r, w: ((rng() < 0.5 ? -1 : 1) * speed) / r, a: rng() * 6.28 });
  }
  return out;
}

// Dolphin pods porpoising round wide loops in deep water: submerged (hidden) between ~1.2 s leaps.
function dolphins(scene, rng) {
  const b = bodyBaker(), FIN = 0x4d5a68;
  b.add(new THREE.SphereGeometry(1, 8, 6).scale(0.3, 0.32, 1.2), (x, y) => (y < -0.08 ? 0xcfd6da : 0x5d6b7a));
  b.add(new THREE.CylinderGeometry(0.1, 0.04, 0.4, 6).rotateX(Math.PI / 2), 0x5d6b7a, 0, -0.05, -1.3);                                  // beak
  b.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.35, 0), new THREE.Vector2(0.3, 0), new THREE.Vector2(0.15, 0.4)])).rotateY(Math.PI / 2), FIN, 0, 0.26, 0.1); // dorsal
  b.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0.1), new THREE.Vector2(0.55, -0.3), new THREE.Vector2(0, -0.1), new THREE.Vector2(-0.55, -0.3)])).rotateX(-Math.PI / 2), FIN, 0, 0, 1.05); // flukes
  const L = loops(rng, 3, 150, 300, 60, -8, 5), per = 4, offs = [[0, 0], [-6, 5], [6, 7], [0, 14]];
  const mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }), L.length * per);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return (t) => {
    L.forEach((l, i) => offs.forEach(([lx, lb], j) => {
      const a = l.a + l.w * t, yaw = (l.w > 0 ? Math.PI : 0) - a, c = Math.cos(yaw), s = Math.sin(yaw), x = l.x + Math.cos(a) * l.r + c * lx + s * lb, z = l.z + Math.sin(a) * l.r - s * lx + c * lb;
      const u = (t / 5 + j * 0.23 + i * 0.37) % 1 / 0.24, jump = u < 1; // each dolphin leaps once per 5 s, staggered
      e.set(jump ? Math.atan2((-22.4 * (u - 0.5)) / 1.2, 5) : 0, yaw, 0);
      mesh.setMatrixAt(i * per + j, m.compose(p.set(x, waveAt(x, z, t) + (jump ? 1.6 - 11.2 * (u - 0.5) ** 2 : -1.2), z), q.setFromEuler(e), sc.set(1, 1, 1)));
    }));
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// Channel buoys leading out from the harbour (red / green pairs) plus yellow hazard buoys on the shallows; one tinted mesh.
function buoys(scene, rng) {
  const b = bodyBaker();
  b.add(new THREE.CylinderGeometry(0.7, 0.7, 0.9, 8), (x, y) => (y < -0.2 ? 0xc8c8c8 : 0xffffff));
  b.add(new THREE.CylinderGeometry(0.1, 0.35, 2.2, 4), 0xe8e8e8, 0, 1.55, 0);
  b.add(new THREE.CylinderGeometry(0.05, 0.4, 0.6, 6), 0xfff2b0, 0, 2.95, 0); // bright warm beacon at y = 2.95
  const H = HARBOUR, dx = -Math.sin(H.yaw), dz = -Math.cos(H.yaw), list = [];
  for (let k = 0; k < 4; k++) for (const [side, col] of [[1, 0xd23a2a], [-1, 0x2f9e4f]]) list.push({ x: H.hx + dx * (50 + 60 * k) - dz * 15 * side, z: H.hz + dz * (50 + 60 * k) + dx * 15 * side, col });
  for (let tries = 0; tries < 6000 && list.length < 14; tries++) {
    const x = (rng() - 0.5) * 2600, z = (rng() - 0.5) * 2600, h = heightAt(x, z);
    if (h > -6 && h < -2.5) list.push({ x, z, col: 0xf2c230 });
  }
  const mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
  mesh.frustumCulled = false;
  list.forEach((o, i) => mesh.setColorAt(i, new THREE.Color(o.col)));
  scene.add(mesh);
  return (t) => {
    list.forEach((o, i) => {
      const y = waveAt(o.x, o.z, t), sx = (waveAt(o.x + 1, o.z, t) - waveAt(o.x - 1, o.z, t)) / 2, sz = (waveAt(o.x, o.z + 1, t) - waveAt(o.x, o.z - 1, t)) / 2;
      q.setFromUnitVectors(UP, sc.set(-sx, 1, -sz).normalize());
      mesh.setMatrixAt(i, m.compose(p.set(o.x, y, o.z), q, sc.set(1, 1, 1)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

const SMOOTH = (x) => x * x * (3 - 2 * x);

// Working fishing trawler (~11.8 m long, 3.8 m beam). Nose toward -z, waterline at y = 0.
export function trawler(b) {
  const HULL = (x, y) => (y < 0.25 ? 0x7a2f2a : y > 1.18 ? 0xf6efe6 : 0x2d5a4a);
  const DECK = 0x8a6a4c, CABIN = 0xf6efe6, DARK = 0x2a2a32, ORANGE = 0xf2763a, WIN = 0xffcf7c;
  // Hull: main beamy mid/aft body + seamless flared bow + raised bow bulwark + wooden working deck
  b.add(new THREE.BoxGeometry(3.7, 1.65, 6.8), HULL, 0, 0.52, 1.4);
  b.add(new THREE.CylinderGeometry(0, 2.616, 4.2, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2).scale(1, 0.446, 1), HULL, 0, 0.52, -4.1); // seamless raked bow
  b.add(new THREE.BoxGeometry(3.45, 0.36, 3.0), (x, y) => (y > 1.52 ? 0xf6efe6 : 0x2d5a4a), 0, 1.46, -1.6); // raised forecastle bulwark
  b.add(new THREE.BoxGeometry(3.3, 0.14, 6.5), DECK, 0, 1.32, 1.35);                                        // wooden aft working deck
  b.add(new THREE.BoxGeometry(3.3, 0.14, 2.4), DECK, 0, 1.52, -1.9);                                        // raised foredeck
  for (const sx of [-1.75, 1.75]) {
    b.add(new THREE.BoxGeometry(0.18, 0.44, 6.6), 0x2d5a4a, sx, 1.5, 1.4);                                  // aft bulwark rails
    for (const z of [-0.6, 1.4, 3.4]) b.add(new THREE.TorusGeometry(0.22, 0.08, 5, 8).rotateY(Math.PI / 2), DARK, sx * 1.07, 0.95, z); // tyre fenders
  }
  b.add(new THREE.BoxGeometry(3.6, 0.42, 0.24), 0x2d5a4a, 0, 1.48, 4.75);                                   // stern transom
  b.add(new THREE.CylinderGeometry(0.18, 0.18, 2.4, 8).rotateZ(Math.PI / 2), DARK, 0, 1.66, 4.82);          // stern trawl roller
  // Wheelhouse (forward-midship) with raked bridge roof, glowing windows, funnel & mast
  b.add(new THREE.BoxGeometry(2.5, 1.9, 2.5), CABIN, 0, 2.35, -0.6);
  b.add(new THREE.BoxGeometry(2.6, 0.55, 2.42), WIN, 0, 2.75, -0.72);                                       // warm lit bridge windows (incl. front windshield)
  b.add(new THREE.BoxGeometry(2.85, 0.16, 2.9), DARK, 0, 3.35, -0.65);                                      // bridge roof visor
  b.add(new THREE.CylinderGeometry(0.24, 0.28, 1.25, 8), (x, y) => (y > 4.05 && y < 4.35 ? ORANGE : DARK), 0, 3.95, 0.2); // exhaust funnel
  b.add(new THREE.CylinderGeometry(0.07, 0.1, 3.4, 6), DARK, 0, 5.05, -0.65);                               // main mast
  b.add(new THREE.BoxGeometry(1.1, 0.12, 0.2), CABIN, 0, 4.2, -0.65);                                       // radar scanner
  b.add(new THREE.CylinderGeometry(0.12, 0.12, 0.25, 6), 0xffe8a8, 0, 6.8, -0.65);                          // masthead lamp
  b.add(new THREE.BoxGeometry(0.14, 0.18, 0.18), 0xd8352a, -1.32, 3.15, -1.1);                              // port sidelight
  b.add(new THREE.BoxGeometry(0.14, 0.18, 0.18), 0x30d860, 1.32, 3.15, -1.1);                               // starboard sidelight
  // Aft fishing gear: stern A-frame gantry, derrick boom, winch, net floats & fish crates
  for (const sx of [-1.4, 1.4]) strut(b, 0.08, DARK, [sx, 1.45, 4.35], [sx * 0.72, 4.1, 4.55]);
  strut(b, 0.08, DARK, [-1.02, 4.1, 4.55], [1.02, 4.1, 4.55]);                                              // gantry crossbeam
  strut(b, 0.06, DARK, [0, 3.6, -0.65], [0, 4.6, 3.2]);                                                     // aft derrick boom (anchored to mast)
  strut(b, 0.025, DARK, [0, 5.8, -0.65], [0, 4.6, 3.2]);                                                    // topping-lift cable
  b.add(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 8).rotateZ(Math.PI / 2), DARK, 0, 1.65, 1.3);           // trawl winch drum
  for (const [x, z, col] of [[0.9, 2.4, 0xc89658], [0.9, 3.2, 0x2b6e8c], [-0.95, 2.7, 0xc89658]]) b.add(new THREE.BoxGeometry(0.7, 0.55, 0.7), col, x, 1.65, z);
  for (const [x, z] of [[-0.9, 3.6], [-0.6, 3.9], [1.1, 1.6]]) b.add(new THREE.IcosahedronGeometry(0.28, 0), ORANGE, x, 1.62, z); // net buoys
}
function trawlerGeo() {
  const b = bodyBaker();
  trawler(b);
  return b.geometry();
}

function fishing(scene, rng, geo) {
  const L = loops(rng, 3, 250, 450, 40, -4, 3);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }), L.length);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const wakes = L.map(() => makeWake(scene, 40, 6.5));
  let prevT = 0;
  return (t) => {
    const dt = Math.min(0.1, Math.max(0, t - prevT)); prevT = t;
    L.forEach((l, i) => {
      const a = l.a + l.w * t, yaw = (l.w > 0 ? Math.PI : 0) - a, x = l.x + Math.cos(a) * l.r, z = l.z + Math.sin(a) * l.r, fx = -Math.sin(yaw) * 4, fz = -Math.cos(yaw) * 4;
      e.set(Math.atan2(waveAt(x + fx, z + fz, t) - waveAt(x - fx, z - fz, t), 8), yaw, Math.sin(t * 0.8 + i) * 0.04);
      mesh.setMatrixAt(i, m.compose(p.set(x, waveAt(x, z, t) - 0.1, z), q.setFromEuler(e), sc.set(1, 1, 1)));
      if (dt > 0) wakes[i].update(dt, (wx, wz) => waveAt(wx, wz, t), 0.12, { x, z, yaw, speed: 3, throttle: 0.25, steer: 0, stern: 4.8, bow: 6.2, beam: 3.7, jets: [0.6, 4.8] });
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// One trawler works out of the harbour: moored on the far side of the jetty head from the cutter, it turns, steams out along a gentle
// curve, lingers, and returns. The route is picked so every sample stays in deep water (never the jetty, breakwater or land).
function harbourTrawler(scene, geo) {
  const H = HARBOUR, dx = -Math.sin(H.yaw), dz = -Math.cos(H.yaw), nx = Math.cos(H.yaw), nz = -Math.sin(H.yaw); // out to sea, and starboard
  const at = (u, s) => new THREE.Vector3(H.hx + dx * u + nx * s, 0, H.hz + dz * u + nz * s);
  let curve = null;
  for (const k of [-1, 1]) for (const f of [1, 0.7, 0.45]) { // try bending either way, then shorter routes
    const c = new THREE.CatmullRomCurve3([[6, -38], [42, -38], [108, -38 - 22 * k], [185, -38 - 70 * k * f], [255, -38 - 150 * k * f], [265, -38 - 230 * k * f], [205, -38 - 280 * k * f]].map(([u, s]) => at(u * f ** 0.5, s)), false, 'centripetal');
    if (c.getSpacedPoints(120).every((v) => heightAt(v.x, v.z) < -4 && heightAt(v.x + nx * 20, v.z + nz * 20) < -4 && heightAt(v.x - nx * 20, v.z - nz * 20) < -4 && Math.hypot(v.x - OILRIG.x, v.z - OILRIG.z) > 55)) { curve = c; break; }
  }
  if (!curve) return () => {};
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  scene.add(mesh);
  const D = curve.getLength(), drive = D / 3.5, wait = 50, turn = 7, linger = 30, cycle = wait + turn + 2 * drive + linger;
  const yawOf = (a) => { const f = curve.getTangentAt(a); return Math.atan2(-f.x, -f.z); }; // nose along travel
  const yaw0 = yawOf(0), turnBy = (a, b, k) => a + SMOOTH(Math.min(1, Math.max(0, k))) * Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const tWake = makeWake(scene, 45, 7);
  let prevT = 0, prevX = 0, prevZ = 0;
  return (t) => {
    const dt = Math.min(0.1, Math.max(0, t - prevT)); prevT = t;
    let c = t % cycle, a, yaw;
    if (c < wait) { a = 0; yaw = yaw0 + Math.PI; }                                        // moored, nose to shore
    else if ((c -= wait) < turn) { a = 0; yaw = turnBy(yaw0 + Math.PI, yaw0, c / turn); } // swing round
    else if ((c -= turn) < drive) { a = SMOOTH(c / drive); yaw = yawOf(a); }               // out, eased start and stop
    else if ((c -= drive) < linger) { a = 1; yaw = turnBy(yawOf(1), yawOf(1) + Math.PI, c / turn); } // idle, turn about
    else { a = 1 - SMOOTH((c - linger) / drive); yaw = yawOf(a) + Math.PI; }                      // home, nose to shore on arrival
    const p0 = curve.getPointAt(a), fx = -Math.sin(yaw) * 4, fz = -Math.cos(yaw) * 4;
    e.set(Math.atan2(waveAt(p0.x + fx, p0.z + fz, t) - waveAt(p0.x - fx, p0.z - fz, t), 8), yaw, Math.sin(t * 0.8) * 0.04);
    mesh.position.set(p0.x, waveAt(p0.x, p0.z, t) - 0.1, p0.z);
    mesh.quaternion.setFromEuler(e);
    const spd = dt > 0 ? Math.hypot(p0.x - prevX, p0.z - prevZ) / dt : 0;
    prevX = p0.x; prevZ = p0.z;
    if (dt > 0) tWake.update(dt, (wx, wz) => waveAt(wx, wz, t), 0.12, spd > 0.25 ? { x: p0.x, z: p0.z, yaw, speed: spd, throttle: 0.25, steer: 0, stern: 4.8, bow: 6.2, beam: 3.7, jets: [0.6, 4.8] } : null);
  };
}

// Fuel tanker: twin-rail chassis, detailed cab with grille/mirrors/visor/stack, domed white-and-red tank with catwalk,
// rear valve cabinet, and 6 hubbed wheels. Nose toward -z, origin at the ground.
export function fuelTruck(b) {
  const DARK = 0x2a2a32, TIRE = 0x1d1d22, RIM = 0xc8c4cc, RED = 0xd8352a, WHITE = 0xf4ede4, GLASS = 0x1f3346, ORANGE = 0xf2763a;
  // Twin-rail chassis, cross-members, side saddle fuel tank, rear mudguards & bumpers
  for (const sx of [-0.55, 0.55]) b.add(new THREE.BoxGeometry(0.18, 0.28, 9.0), DARK, sx, 0.92, 0.15);
  b.add(new THREE.BoxGeometry(2.3, 0.2, 8.2), DARK, 0, 1.08, 0.35);                                        // deck frame
  b.add(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 8).rotateX(Math.PI / 2), DARK, -1.0, 0.85, -1.2);      // saddle diesel tank
  b.add(new THREE.BoxGeometry(0.55, 0.48, 0.8), DARK, 1.0, 0.88, -1.2);                                    // battery/tool box
  b.add(new THREE.BoxGeometry(2.55, 0.34, 0.36), RIM, 0, 1.1, -4.45);                                      // front chrome/steel bumper
  b.add(new THREE.BoxGeometry(2.3, 0.28, 0.25), DARK, 0, 1.05, 4.72);                                      // rear underrun bar
  for (const sx of [-0.9, 0.9]) b.add(new THREE.BoxGeometry(0.38, 0.16, 0.1), 0xff4a2a, sx, 1.08, 4.86);   // rear tail lights
  for (const sx of [-1.15, 1.15]) b.add(new THREE.BoxGeometry(0.52, 0.14, 2.95), DARK, sx, 1.22, 2.2);     // rear tandem mudguards
  // Cab: lower body, stepped radiator grille, wrap-around glass, sun visor, amber roof beacons, mirrors & vertical exhaust
  b.add(new THREE.BoxGeometry(2.42, 1.25, 1.95), RED, 0, 1.82, -3.35);
  b.add(new THREE.BoxGeometry(2.36, 1.05, 1.8), (x, y, z) => (z < -4.08 || (Math.abs(x) > 1.1 && z < -2.7) ? GLASS : RED), 0, 2.92, -3.18);
  b.add(new THREE.BoxGeometry(2.48, 0.14, 0.42).rotateX(0.25), DARK, 0, 3.45, -4.12);                      // cab sun visor
  for (const sx of [-0.75, 0.75]) b.add(new THREE.CylinderGeometry(0.1, 0.12, 0.22, 6), ORANGE, sx, 3.55, -3.65); // roof beacons
  b.add(new THREE.BoxGeometry(1.55, 0.72, 0.12), DARK, 0, 1.85, -4.34);                                    // radiator grille
  for (const ry of [1.65, 1.85, 2.05]) b.add(new THREE.BoxGeometry(1.38, 0.06, 0.16), RIM, 0, ry, -4.35);  // grille slats
  for (const sx of [-0.94, 0.94]) {
    b.add(new THREE.BoxGeometry(0.34, 0.24, 0.14), 0xffcf7c, sx, 1.82, -4.35);                             // headlamps
    b.add(new THREE.BoxGeometry(0.18, 0.14, 0.14), ORANGE, sx * 1.15, 1.82, -4.34);                        // turn indicators
    b.add(new THREE.BoxGeometry(0.1, 0.42, 0.14), DARK, sx * 1.42, 2.8, -3.9);                             // wing mirrors
    strut(b, 0.03, DARK, [sx * 1.25, 2.95, -3.8], [sx * 1.4, 2.95, -3.9]);
    strut(b, 0.03, DARK, [sx * 1.25, 2.65, -3.8], [sx * 1.4, 2.65, -3.9]);
    b.add(new THREE.BoxGeometry(0.24, 0.12, 0.55), RIM, sx * 1.22, 1.02, -3.15);                           // cab step
  }
  b.add(new THREE.CylinderGeometry(0.08, 0.09, 2.3, 6), RIM, -1.05, 2.75, -2.15);                          // vertical exhaust stack
  // Tanker barrel: white cylinder with domed end caps, 3 red hazard bands, top catwalk, twin hatches & rear valve box
  b.add(new THREE.CylinderGeometry(1.18, 1.18, 5.5, 14).rotateX(Math.PI / 2), WHITE, 0, 2.38, 1.55);
  for (const [cz, s] of [[-1.2, -1], [4.3, 1]]) b.add(new THREE.SphereGeometry(1.18, 12, 6).scale(1, 1, 0.36), WHITE, 0, 2.38, cz + s * 0.02); // domed ends
  for (const z of [-0.65, 1.55, 3.75]) b.add(new THREE.CylinderGeometry(1.21, 1.21, 0.48, 14).rotateX(Math.PI / 2), RED, 0, 2.38, z);
  b.add(new THREE.BoxGeometry(0.75, 0.08, 5.0), DARK, 0, 3.58, 1.55);                                      // top catwalk
  for (const z of [0.35, 2.75]) b.add(new THREE.CylinderGeometry(0.32, 0.34, 0.24, 8), DARK, 0, 3.7, z);   // twin manhole hatches
  for (const sx of [-1.05, 1.05]) b.add(new THREE.CylinderGeometry(0.14, 0.14, 5.0, 6).rotateX(Math.PI / 2), RIM, sx, 1.38, 1.55); // side hose tubes
  b.add(new THREE.BoxGeometry(1.5, 0.85, 0.55), RED, 0, 1.65, 4.48);                                       // rear hose-reel & valve cabinet
  b.add(new THREE.BoxGeometry(1.1, 0.55, 0.1), DARK, 0, 1.65, 4.74);
  // 6 wheels (single steer front, tandem rear) with tyres & hubs
  for (const z of [-3.25, 1.45, 3.0]) for (const sx of [-1.14, 1.14]) {
    b.add(new THREE.CylinderGeometry(0.56, 0.56, 0.44, 12).rotateZ(Math.PI / 2), TIRE, sx, 0.56, z);
    b.add(new THREE.CylinderGeometry(0.28, 0.28, 0.48, 8).rotateZ(Math.PI / 2), RIM, sx, 0.56, z);
  }
}

// The fuel truck shuttling the road between the base gate and the jetty, pausing at each end.
function truck(scene) {
  const end = HARBOUR.shore, road = ROADS.find((r) => [r[0], r[r.length - 1]].some(([x, z]) => Math.hypot(x - end.x, z - end.z) < 4));
  if (!road) return () => {};
  const pts = Math.hypot(road[0][0] - end.x, road[0][1] - end.z) < 4 ? [...road].reverse() : road, cum = [0];
  pts.forEach((q, i) => i && cum.push(cum[i - 1] + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1])));
  const D = cum[cum.length - 1], V = 9, drive = D / V, pause = 8, cycle = 2 * (drive + pause);
  const pos = (d, out) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const k = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); out.set(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, 0, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k); return out.setY(heightAt(out.x, out.z)); };
  const b = bodyBaker(); fuelTruck(b);
  const mesh = new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  scene.add(mesh);
  const a = new THREE.Vector3(), c = new THREE.Vector3(), f = new THREE.Vector3(), back = new THREE.Vector3(), front = new THREE.Vector3();
  return (t) => {
    let u = t % cycle, d, dir = 1;
    if (u < pause) d = 0; else if ((u -= pause) < drive) d = D * SMOOTH(u / drive); else if ((u -= drive) < pause) d = D; else { d = D * (1 - SMOOTH((u - pause) / drive)); dir = -1; }
    pos(Math.min(D, d + 3), front); pos(Math.max(0, d - 3), back); pos(d, a);
    f.subVectors(front, back).multiplyScalar(dir);
    const yaw = Math.atan2(-f.x, -f.z), pitch = Math.atan2((front.y - back.y) * dir, Math.hypot(front.x - back.x, front.z - back.z));
    e.set(pitch, yaw, 0);
    mesh.position.copy(a);
    mesh.quaternion.setFromEuler(e);
  };
}

// Moored vessels in the expanded harbour: a trawler along the fishing pier + 3 sailboats in the marina slips.
function mooredBoats(scene, trawlerGeometry) {
  const H = HARBOUR, c = Math.cos(H.yaw), s = Math.sin(H.yaw);
  const toWorld = (lx, lz) => [H.hx + lx * c + lz * s, H.hz - lx * s + lz * c];
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const [tx, tz] = toWorld(-7.5, -20.0);
  const tMesh = new THREE.Mesh(trawlerGeometry, mat);
  scene.add(tMesh);

  const sb = bodyBaker(); sailboat(sb, false);
  const sailGeo = sb.geometry();
  const slips = [[-25.5, -1.8, 0xc8452e], [-25.5, 3.7, 0x2b6e8c], [-25.5, 9.2, 0xe89a38]];
  const sMeshes = slips.map(([lx, lz, col], i) => {
    const [wx, wz] = toWorld(lx, lz);
    const mesh = new THREE.Mesh(sailGeo, mat);
    scene.add(mesh);
    return { mesh, wx, wz, yaw: H.yaw - Math.PI / 2, phase: i * 1.7 };
  });
  return (t) => {
    tMesh.position.set(tx, waveAt(tx, tz, t) - 0.1, tz);
    tMesh.rotation.set(Math.sin(t * 0.9) * 0.018, H.yaw, Math.cos(t * 0.7) * 0.022);
    for (const o of sMeshes) {
      o.mesh.position.set(o.wx, waveAt(o.wx, o.wz, t) - 0.08, o.wz);
      o.mesh.rotation.set(Math.sin(t * 1.1 + o.phase) * 0.025, o.yaw, Math.cos(t * 0.95 + o.phase) * 0.032);
    }
  };
}

// Live positions of the harbour ships for the minimap, big map, collision & landing.
export const SHIPS = [];

// Container ship & passenger ferry that berth on opposite sides of the seaward Container/Ferry Pier, steam out to deep water, and return.
function harbourShip(scene, variant = 'cargo', berthS = 1.2, sideSign = -1, scale = 0.68, phase = 0, name = 'MV Heron') {
  const H = HARBOUR, dx = -Math.sin(H.yaw), dz = -Math.cos(H.yaw), nx = Math.cos(H.yaw), nz = -Math.sin(H.yaw);
  const at = (u, s) => new THREE.Vector3(H.hx + dx * u + nx * s, 0, H.hz + dz * u + nz * s);
  let curve = null;
  for (const f of [1, 0.75, 0.55]) {
    const c = new THREE.CatmullRomCurve3([
      [42, berthS], [92, berthS], [150, berthS + 35 * sideSign * f], [235 * f, berthS + 115 * sideSign * f], [300 * f, berthS + 210 * sideSign * f], [290 * f, berthS + 290 * sideSign * f],
    ].map(([u, s]) => at(u, s)), false, 'centripetal');
    if (c.getSpacedPoints(120).every((v) => heightAt(v.x, v.z) < -6 && heightAt(v.x + nx * 16, v.z + nz * 16) < -6 && heightAt(v.x - nx * 16, v.z - nz * 16) < -6 && Math.hypot(v.x - OILRIG.x, v.z - OILRIG.z) > 65)) { curve = c; break; }
  }
  if (!curve) return () => {};
  const { group } = buildShip(variant);
  group.scale.setScalar(scale);
  scene.add(group);
  const D = curve.getLength(), drive = D / 3.8, aTurn = Math.min(0.25, 50 / D), driveIn = (1 - aTurn) * drive, berthBack = aTurn * drive * 1.4;
  const wait = 42, linger = 28, turn = 12, cycle = wait + drive + linger + turn + driveIn + turn + berthBack;
  const yawOf = (a) => { const f = curve.getTangentAt(a); return Math.atan2(-f.x, -f.z); };
  const yaw0 = yawOf(0), turnBy = (a, b, k) => a + SMOOTH(Math.min(1, Math.max(0, k))) * Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const track = {
    name, variant, scale, x: 0, y: 0, z: 0, yaw: yaw0, vx: 0, vz: 0, dYaw: 0,
    deckAt(wx, wz) {
      const rx = wx - track.x, rz = wz - track.z, cs = Math.cos(track.yaw), sn = Math.sin(track.yaw);
      const lx = (rx * cs - rz * sn) / scale, lz = (rx * sn + rz * cs) / scale;
      if (variant === 'cargo') {
        if (Math.abs(lx) < 5.5 && lz >= 0.5 && lz <= 6.8) return track.y + 5.0 * scale;
        if (Math.abs(lx) < 4.1 && lz >= -26.5 && lz <= -0.1) {
          const bay = Math.min(3, Math.max(0, Math.floor((lz + 26.5) / 6.8)));
          return track.y + (5.0 + (bay % 2 ? 2 : 3) * 2.52) * scale;
        }
      } else {
        if (Math.abs(lx) < 5.0 && lz >= -11.5 && lz <= 8.5) return track.y + 11.18 * scale;
        if (Math.abs(lx) < 4.2 && lz >= -36.0 && lz <= -24.5) return track.y + 8.4 * scale;
      }
      return null;
    },
  };
  const shipWake = makeWake(scene, 65, 11);
  let lastT = -1;
  const update = (t) => {
    if (t === lastT) return;
    const prevX = track.x, prevZ = track.z, prevYaw = track.yaw, dt = lastT < 0 ? 0 : t - lastT;
    lastT = t;
    let c = (t + phase) % cycle, a, yaw;
    if (c < wait) { a = 0; yaw = yaw0; }
    else if ((c -= wait) < drive) { a = SMOOTH(c / drive); yaw = yawOf(a); }
    else if ((c -= drive) < linger) { a = 1; yaw = yawOf(1); }
    else if ((c -= linger) < turn) { a = 1; yaw = turnBy(yawOf(1), yawOf(1) + Math.PI, c / turn); }
    else if ((c -= turn) < driveIn) { a = 1 - (1 - aTurn) * SMOOTH(c / driveIn); yaw = yawOf(a) + Math.PI; }
    else if ((c -= driveIn) < turn) { a = aTurn; yaw = turnBy(yawOf(aTurn) + Math.PI, yawOf(aTurn), c / turn); }
    else { a = aTurn * (1 - SMOOTH((c - turn) / berthBack)); yaw = yawOf(a); }
    const p0 = curve.getPointAt(a), fx = -Math.sin(yaw) * 12, fz = -Math.cos(yaw) * 12, wy = waveAt(p0.x, p0.z, t) * 0.35;
    e.set(Math.atan2(waveAt(p0.x + fx, p0.z + fz, t) - waveAt(p0.x - fx, p0.z - fz, t), 24) * 0.4, yaw, Math.sin(t * 0.5 + phase) * 0.015);
    group.position.set(p0.x, wy, p0.z);
    group.quaternion.setFromEuler(e);
    let dy = yaw - prevYaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    track.x = p0.x; track.y = wy; track.z = p0.z; track.yaw = yaw;
    track.dYaw = dt > 0 ? dy : 0;
    track.vx = dt > 0 ? (p0.x - prevX) / dt : 0;
    track.vz = dt > 0 ? (p0.z - prevZ) / dt : 0;
    const spd = Math.hypot(track.vx, track.vz);
    if (dt > 0) shipWake.update(Math.min(0.1, dt), (wx, wz) => waveAt(wx, wz, t), 0.14, spd > 0.25 ? { x: track.x, z: track.z, yaw: track.yaw, speed: spd, throttle: 0.4, steer: 0, stern: 32 * scale, bow: 40 * scale, beam: 15 * scale, jets: [1.5 * scale, 32 * scale] } : null);
  };
  track.update = update;
  SHIPS.push(track);
  update(0);
  return update;
}

export function buildLife(scene) {
  SHIPS.length = 0;
  const rng = mulberry32(SEED + 4), trawler = trawlerGeo(), parts = [clouds, birds, boats, dolphins, buoys, (s, r) => fishing(s, r, trawler)].map((f) => f(scene, rng));
  parts.push(harbourTrawler(scene, trawler), harbourShip(scene, 'cargo', 1.2, -1, 0.68, 0, 'MV Heron'), harbourShip(scene, 'passenger', 18.5, 1, 0.65, 110, 'SS Meridian'), mooredBoats(scene, trawler), truck(scene));
  return (t) => parts.forEach((u) => u(t));
}
