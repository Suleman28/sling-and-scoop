import * as THREE from 'three';
import { SEA } from './world.js';

const G = 9.81;

// One line under the chopper; its end carries the bucket or the hook (and maybe a crate).
export const RIG = {
  bucket: { line: 9, hang: 1.2, mass: 0.08, radius: 0.9 },   // hang: rope end to bottom of the load
  hook: { line: 10, hang: 0.4, mass: 0.05, radius: 0.3 },
  crate: { hang: 1.6, mass: 0.6, radius: 1.1 },              // masses are relative to the chopper (1)
  person: { hang: 1.8, mass: 0.15, radius: 0.4 },
  // Heavy cargo: cargo is its name, pay multiplies the job reward.
  container: { hang: 2.2, mass: 1.6, radius: 1.6, cargo: 'container', label: 'Heavy container', pay: 2.5 },
  vehicle: { hang: 1.9, mass: 2.0, radius: 2.2, cargo: 'wrecked vehicle', label: 'Vehicle recovery', pay: 3 },
  cabin: { hang: 3.4, mass: 2.4, radius: 2.6, cargo: 'prefab cabin', label: 'Prefab cabin', pay: 3.5 },
  cap: 1, fillRate: 0.8, dumpRate: 1.3, waterMass: 0.45,   // fill/dump rates are per unit of capacity
  heliMass: 1,                                                // airframe mass: lighter ones get yanked more
  anchor: 0.6,                                                // rope attach height above the chopper's ground contact
  maxLift: 1.2,                                               // heaviest load the airframe can pick up
  sloshK: 30, sloshC: 2.5, sloshSettle: 1.2, sloshGain: 0.25, snatch: 0.08, spillAt: 0.45, spillRate: 0.6,
  winchSpeed: 3, minLine: 2.5,                                // Z/C reel the line between minLine and the tool's full line
  airDrag: 0.3, swingDamp: 0.4, grabRange: 2.6,   // swingDamp: bleeds swing relative to the chopper so it can't be whipped into loops
};

export function createRig(x, y, z) {
  return {
    tool: 'bucket', len: RIG.bucket.line, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), prev: new THREE.Vector3(x, y, z), up: new THREE.Vector3(0, 1, 0),
    acc: { x: 0, z: 0, vx: 0, vz: 0 }, slosh: { x: 0, z: 0, vx: 0, vz: 0, qx: 0, qz: 0 }, water: 0, dumping: false, dipped: false, taut: false, poured: 0, spilled: 0, crate: null,
  };
}

// Anything the hook can carry: a crate or a person. pos is the top (hook point); spec gives size and mass.
export function createCrate(x, y, z, spec = RIG.crate) {
  return { pos: new THREE.Vector3(x, y + spec.hang, z), vel: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), held: false, hit: 0, spec };
}

export const hangOf = (r) => (r.crate ? r.crate.spec.hang : RIG[r.tool].hang);
const radiusOf = (r) => (r.crate ? r.crate.spec.radius : RIG[r.tool].radius);
export const massOf = (r) => (r.crate ? r.crate.spec.mass : RIG[r.tool].mass + r.water * RIG.waterMass);

// Rope-end physics: gravity + air drag toward the wind, ground/water floor, then an inextensible rope.
// Taut rope yanks the chopper sideways by the load's mass share (altitude hold stays arcade).
// env: { groundAt, heightAt, wind? }
export function stepRig(r, s, dt, env) {
  const L = (r.len = Math.min(r.len, RIG[r.tool].line)), hang = hangOf(r), v = r.vel, w = env.wind || { x: 0, z: 0 }, wasTaut = r.taut;
  r.overloaded = !!r.crate && massOf(r) > RIG.maxLift;
  r.prev.copy(r.pos);
  v.x += (w.x - v.x) * RIG.airDrag * dt;
  v.z += (w.z - v.z) * RIG.airDrag * dt;
  v.y += (-G - v.y * RIG.airDrag) * dt;
  if (r.taut) v.addScaledVector(v.clone().sub(s.vel), -RIG.swingDamp * dt);

  const overSea = env.heightAt(r.pos.x, r.pos.z) < SEA - 0.5;
  r.dipped = overSea && r.pos.y - hang < SEA;
  if (r.dipped) v.multiplyScalar(Math.exp(-3 * dt));
  r.pos.addScaledVector(v, dt);

  // The bucket can sink 1 m under the surface to scoop; everything else rests on land or floats.
  const floor = (overSea && !r.crate && r.tool === 'bucket' ? SEA - 1 : env.groundAt(r.pos.x, r.pos.z)) + hang;
  if (r.pos.y < floor) {
    r.pos.y = floor;
    if (v.y < 0) v.y = 0;
    const f = Math.exp(-6 * dt); v.x *= f; v.z *= f;
  }

  // Trees knock the load about; a slack load under a landing chopper slides out from beneath the skids.
  if (env.trees) r.hit = env.trees(r.pos, v, radiusOf(r), 0.3 - hang);
  const ux = r.pos.x - s.pos.x, uz = r.pos.z - s.pos.z, ud = Math.hypot(ux, uz), clear = 2.4 + radiusOf(r);
  if (ud < clear && r.pos.y > s.pos.y - 0.5 && r.pos.y - hang < s.pos.y + 3) {
    const nx = ud > 0.01 ? ux / ud : Math.sin(s.yaw), nz = ud > 0.01 ? uz / ud : Math.cos(s.yaw); // default: out behind
    r.pos.x = s.pos.x + nx * clear;
    r.pos.z = s.pos.z + nz * clear;
  }

  const ax = s.pos.x, ay = s.pos.y + RIG.anchor, az = s.pos.z;
  let dx = r.pos.x - ax, dy = r.pos.y - ay, dz = r.pos.z - az;
  const len = Math.hypot(dx, dy, dz) || 1e-6;
  dx /= len; dy /= len; dz /= len;
  r.taut = len >= L - 0.05;
  if (len > L && r.overloaded && r.pos.y <= floor + 0.05) {
    // Too heavy to lift: the load stays put and the line tethers the chopper to it.
    s.pos.set(r.pos.x - dx * L, r.pos.y - dy * L - RIG.anchor, r.pos.z - dz * L);
    const away = -(s.vel.x * dx + s.vel.y * dy + s.vel.z * dz);
    if (away > 0) { s.vel.x += dx * away; s.vel.y += dy * away; s.vel.z += dz * away; }
  } else if (len > L) {
    r.pos.set(ax + dx * L, ay + dy * L, az + dz * L);
    const vrel = (v.x - s.vel.x) * dx + (v.y - s.vel.y) * dy + (v.z - s.vel.z) * dz;
    if (vrel > 0 && !wasTaut) { r.slosh.vx += dx * vrel * RIG.snatch * 60; r.slosh.vz += dz * vrel * RIG.snatch * 60; } // rope snatch jolts the water
    if (vrel > 0) {
      v.x -= dx * vrel; v.y -= dy * vrel; v.z -= dz * vrel;
      const m = massOf(r), share = m / (m + RIG.heliMass);
      s.vel.x += dx * vrel * share;
      s.vel.z += dz * vrel * share;
    }
  }
  if (r.taut) r.up.set(-dx, -dy, -dz);
  else r.up.lerp({ x: 0, y: 1, z: 0 }, 1 - Math.exp(-4 * dt)).normalize();

  // Chopper acceleration, smoothed (drives the slosh).
  const kA = 1 - Math.exp(-12 * dt);
  r.acc.x += ((s.vel.x - r.acc.vx) / dt - r.acc.x) * kA;
  r.acc.z += ((s.vel.z - r.acc.vz) / dt - r.acc.z) * kA;
  r.acc.vx = s.vel.x;
  r.acc.vz = s.vel.z;

  r.poured = r.spilled = 0;
  if (r.tool === 'bucket' && !r.crate) {
    // Slosh: a damped spring chasing the chopper's acceleration / g, high-passed so steady cruise and
    // steady turns settle. Abrupt stick inputs and rope snatches overshoot past the rim and spill.
    const sl = r.slosh, qx = (-r.acc.x / G) * RIG.sloshGain, qz = (-r.acc.z / G) * RIG.sloshGain, kq = 1 - Math.exp(-RIG.sloshSettle * dt);
    sl.qx += (qx - sl.qx) * kq;
    sl.qz += (qz - sl.qz) * kq;
    const tx = qx - sl.qx, tz = qz - sl.qz;
    sl.vx += (RIG.sloshK * (tx - sl.x) - RIG.sloshC * sl.vx) * dt;
    sl.vz += (RIG.sloshK * (tz - sl.z) - RIG.sloshC * sl.vz) * dt;
    sl.x += sl.vx * dt;
    sl.z += sl.vz * dt;
    const tilt = Math.hypot(sl.x, sl.z);
    if (!r.dipped && tilt > RIG.spillAt && r.water > 0) {
      r.spilled = Math.min(r.water, Math.min(tilt - RIG.spillAt, 0.5) * RIG.spillRate * dt);
      r.water -= r.spilled;
    }
    if (r.dumping) {
      r.poured = Math.min(r.water, RIG.dumpRate * RIG.cap * dt);
      r.water -= r.poured;
      if (r.water <= 0) r.dumping = false;
    } else if (r.dipped) r.water = Math.min(RIG.cap, r.water + RIG.fillRate * RIG.cap * dt);
  }

  if (r.crate) { r.crate.pos.copy(r.pos); r.crate.vel.copy(v); r.crate.up.copy(r.up); }
}

// Free crates: fall, land (recording impact speed), settle upright.
export function stepCrate(c, dt, env) {
  c.vel.y -= G * dt;
  c.pos.addScaledVector(c.vel, dt);
  c.hit = env.trees ? env.trees(c.pos, c.vel, c.spec.radius, 0.3 - c.spec.hang) : 0;
  const floor = env.groundAt(c.pos.x, c.pos.z) + c.spec.hang;
  if (c.pos.y < floor) {
    c.hit = Math.max(c.hit, -c.vel.y);
    c.pos.y = floor;
    c.vel.y = 0;
    const f = Math.exp(-8 * dt); c.vel.x *= f; c.vel.z *= f;
  }
  c.up.lerp({ x: 0, y: 1, z: 0 }, 1 - Math.exp(-4 * dt)).normalize();
}

// Action key. Returns what happened, for prompts and sound.
export function act(r, crates) {
  if (r.crate) { r.crate.held = false; r.crate = null; return 'released'; }
  if (r.tool === 'bucket') {
    if (r.water < 0.05 || r.dumping) return null;
    r.dumping = true;
    return 'dump';
  }
  const c = nearestCrate(r, crates);
  if (!c) return null;
  r.crate = c;
  c.held = true;
  r.pos.copy(c.pos);
  r.vel.copy(c.vel);
  return 'hooked';
}

export const nearestCrate = (r, crates) => {
  let best = null, bd = RIG.grabRange;
  for (const c of crates) { const d = c.pos.distanceTo(r.pos); if (!c.held && d < bd) { bd = d; best = c; } }
  return best;
};

// dir: -1 reels in, +1 lets out.
export function winch(r, dir, dt) {
  r.len = Math.min(RIG[r.tool].line, Math.max(RIG.minLine, r.len + dir * RIG.winchSpeed * dt));
}

export function swapTool(r) {
  if (r.crate || r.dumping) return false;
  r.tool = r.tool === 'bucket' ? 'hook' : 'bucket';
  r.len = RIG[r.tool].line;
  r.water = 0;
  return true;
}

// ---- Visuals ----

const Y = new THREE.Vector3(0, 1, 0);

export function buildRigView(scene) {
  const lambert = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 4).translate(0, 0.5, 0), lambert(0x2a2a32));

  const bucket = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.6, 1.0, 8, 1, true).translate(0, -0.7, 0), lambert(0xe2502c, { side: THREE.DoubleSide }));
  const base = new THREE.Mesh(new THREE.CircleGeometry(0.6, 8).rotateX(Math.PI / 2).translate(0, -1.2, 0), lambert(0x8c2e1a));
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.8, 8).rotateX(-Math.PI / 2), lambert(0x4fb3cf));
  const bridle = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([0, 1, 2].flatMap((i) => {
    const a = (i * Math.PI * 2) / 3;
    return [new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * 0.85, -0.2, Math.sin(a) * 0.85)];
  })), new THREE.LineBasicMaterial({ color: 0x2a2a32 }));
  bucket.add(shell, base, water, bridle);

  const hook = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), lambert(0xf2763a));
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 4).rotateX(Math.PI).translate(0, -0.3, 0), lambert(0x2a2a32));
  hook.add(ball, tip);

  scene.add(rope, bucket, hook);
  const p = new THREE.Vector3(), anchor = new THREE.Vector3(), dir = new THREE.Vector3();

  // view: interpolated chopper position; shown false hides the whole rig (airframes with no line).
  // Returns the interpolated rope end.
  return function update(r, view, alpha, shown = true) {
    rope.visible = shown;
    if (!shown) { bucket.visible = hook.visible = false; return p.copy(view); }
    p.lerpVectors(r.prev, r.pos, alpha);
    anchor.set(view.x, view.y + RIG.anchor, view.z);
    dir.subVectors(p, anchor);
    rope.position.copy(anchor);
    rope.scale.y = dir.length();
    rope.quaternion.setFromUnitVectors(Y, dir.normalize());

    bucket.visible = r.tool === 'bucket';
    hook.visible = r.tool === 'hook';
    const g = bucket.visible ? bucket : hook;
    g.position.copy(p);
    g.quaternion.setFromUnitVectors(Y, r.up);
    if (bucket.visible) {
      water.visible = r.water > 0.02;
      const full = r.water / RIG.cap;
      bucket.scale.setScalar(Math.cbrt(RIG.cap));
      water.position.y = -1.15 + full * 0.8;
      water.scale.setScalar(0.75 + full * 0.25);
      water.rotation.set(r.slosh.z * 1.5, 0, -r.slosh.x * 1.5);
    }
    return p;
  };
}

// Heavy cargo meshes; origin at the top centre (the hook point), with lifting straps where needed.
export function buildHeavyMesh(key) {
  const g = new THREE.Group(), lam = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const add = (geo, color, x, y, z) => { const m = new THREE.Mesh(geo, lam(color)); m.position.set(x, y, z); g.add(m); };
  const straps = (pts) => g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts.flatMap(([x, y, z]) => [new THREE.Vector3(), new THREE.Vector3(x, y, z)])), new THREE.LineBasicMaterial({ color: 0x2a2a32 })));
  if (key === 'container') {
    add(new THREE.BoxGeometry(2.2, 2.2, 3.4), 0x2f6f9a, 0, -1.1, 0);
    for (const z of [-1.2, -0.4, 0.4, 1.2]) add(new THREE.BoxGeometry(2.26, 2.26, 0.12), 0x24506e, 0, -1.1, z);
  } else if (key === 'vehicle') {
    add(new THREE.BoxGeometry(1.9, 0.9, 4.2), 0x9a4a3a, 0, -1.25, 0);                                 // body
    add(new THREE.BoxGeometry(1.7, 0.75, 2.0), 0x7d3a2e, 0, -0.45, 0.3);                              // cab
    add(new THREE.BoxGeometry(1.6, 0.6, 0.05), 0x1f3346, 0, -0.45, -0.72);                            // windscreen
    for (const x of [-0.95, 0.95]) for (const z of [-1.35, 1.35]) add(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 8).rotateZ(Math.PI / 2), 0x2a2a32, x, -1.5, z);
    straps([[-0.9, -0.8, -1.9], [0.9, -0.8, -1.9], [-0.9, -0.8, 1.9], [0.9, -0.8, 1.9]]);
  } else {
    add(new THREE.BoxGeometry(3.0, 2.3, 4.0), 0xc3925e, 0, -2.25, 0);                                 // walls
    add(new THREE.CylinderGeometry(1.9, 1.9, 4.2, 3, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 6).scale(0.85, 0.55, 1), 0x8a3b2c, 0, -0.95, 0); // roof
    add(new THREE.BoxGeometry(0.9, 1.6, 0.05), 0x5a3a24, 0.6, -2.6, -2.02);                           // door
    straps([[-1.4, -1.1, -1.9], [1.4, -1.1, -1.9], [-1.4, -1.1, 1.9], [1.4, -1.1, 1.9]]);
  }
  return g;
}

export function buildCrateMesh() {
  const g = new THREE.Group(), wood = new THREE.MeshLambertMaterial({ color: 0xc08a4e, flatShading: true }), band = new THREE.MeshLambertMaterial({ color: 0x6b4426 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6).translate(0, -0.8, 0), wood));
  for (const r of [0, Math.PI / 2]) g.add(new THREE.Mesh(new THREE.BoxGeometry(1.64, 1.64, 0.3).translate(0, -0.8, 0).rotateY(r), band));
  return g;
}

// Little low-poly person in a hi-vis vest; origin at the top of the head (the hook point).
export function buildPersonMesh() {
  const g = new THREE.Group(), lam = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const add = (geo, color, y) => { const m = new THREE.Mesh(geo, lam(color)); m.position.y = y; g.add(m); };
  add(new THREE.IcosahedronGeometry(0.2, 0), 0xe0b08a, -0.2);
  add(new THREE.CylinderGeometry(0.24, 0.2, 0.7, 6), 0xff8a1f, -0.75);
  add(new THREE.CylinderGeometry(0.18, 0.12, 0.75, 6), 0x2c3550, -1.45);
  return g;
}

export function placeCrateMesh(mesh, c) {
  mesh.position.copy(c.pos);
  mesh.quaternion.setFromUnitVectors(Y, c.up);
}
