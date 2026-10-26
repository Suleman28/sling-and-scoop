import * as THREE from 'three';
import { SEA } from './world.js';
import { bodyBaker, DARK, GLASS, strut } from './chopper.js';

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
    tool: 'bucket', len: RIG.bucket.line, savedLen: RIG.bucket.line, dLen: 0, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), prev: new THREE.Vector3(x, y, z), up: new THREE.Vector3(0, 1, 0),
    acc: { x: 0, z: 0, vx: 0, vz: 0 }, slosh: { x: 0, z: 0, vx: 0, vz: 0, qx: 0, qz: 0 }, water: 0, dumping: false, dipped: false, taut: false, poured: 0, spilled: 0, crate: null,
  };
}

// Physical scale of the bucket from water capacity: compact starter bucket (0.72×), growing noticeably with
// each Water Capacity upgrade and much larger on the Heavy Lifter.
export const bucketScale = (cap = RIG.cap) => 0.72 * Math.pow(cap, 0.58);
// Splash rings a bucket's water reaches (see douse): a fuller dump spreads wider, so more water covers more fire
// instead of over-soaking the same patch. Utility 2 (5x5 cells), Heavy Lifter 3, an upgraded Heavy up to 5.
export const splashReach = (cap = RIG.cap) => Math.max(2, Math.round(1 + 0.75 * cap));

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
  if (r.dLen > 0) r.pos.addScaledVector(r.up, -r.dLen);
  r.dLen = 0;
  const ax = s.pos.x, ay = s.pos.y + RIG.anchor, az = s.pos.z;
  if (r.tool === 'hook' && !r.crate && L <= 0.15) {
    // Fully retracted hook: stowed snugly against the belly winch housing with no swing.
    r.pos.set(ax, ay - L, az);
    v.copy(s.vel);
    r.up.set(0, 1, 0);
    r.taut = r.dipped = false;
    r.poured = r.spilled = 0;
    return;
  }
  v.x += (w.x - v.x) * RIG.airDrag * dt;
  v.z += (w.z - v.z) * RIG.airDrag * dt;
  v.y += (-G - v.y * RIG.airDrag) * dt;
  if (r.taut) v.addScaledVector(v.clone().sub(s.vel), -RIG.swingDamp * dt);

  // The sea, or the base dip tank once it's built (env.pond: { x, z, r, y } surface).
  const inPond = env.pond && Math.hypot(r.pos.x - env.pond.x, r.pos.z - env.pond.z) < env.pond.r - 0.8, surface = inPond ? env.pond.y : SEA;
  const overSea = inPond || env.heightAt(r.pos.x, r.pos.z) < SEA - 0.5;
  r.dipped = overSea && r.pos.y - hang < surface;
  if (r.dipped) v.multiplyScalar(Math.exp(-3 * dt));
  r.pos.addScaledVector(v, dt);

  // The bucket can sink 1 m under the surface to scoop; everything else rests on land or floats.
  const floor = (overSea && !r.crate && r.tool === 'bucket' ? surface - 1 : env.groundAt(r.pos.x, r.pos.z)) + hang;
  if (r.pos.y < floor) {
    r.pos.y = floor;
    if (v.y < 0) v.y = 0;
    const f = Math.exp(-6 * dt); v.x *= f; v.z *= f;
  }

  // Trees knock the load about; a slack load on the ground under a landing chopper slides out from beneath the skids.
  if (env.trees) r.hit = env.trees(r.pos, v, radiusOf(r), 0.3 - hang);
  const ux = r.pos.x - s.pos.x, uz = r.pos.z - s.pos.z, ud = Math.hypot(ux, uz), clear = 2.4 + radiusOf(r);
  if (r.pos.y <= floor + 0.15 && ud < clear && r.pos.y > s.pos.y - 0.5 && r.pos.y - hang < s.pos.y + 3) {
    const nx = ud > 0.01 ? ux / ud : Math.sin(s.yaw), nz = ud > 0.01 ? uz / ud : Math.cos(s.yaw); // default: out behind
    r.pos.x = s.pos.x + nx * clear;
    r.pos.z = s.pos.z + nz * clear;
  }

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
  if (r.taut) {
    r.up.set(-dx, -dy, -dz);
    // A swinging taut load rocks the helicopter's attitude in pitch and roll proportional to its mass share.
    if (s.yaw !== undefined && !s.grounded) {
      const m = massOf(r), share = m / (m + RIG.heliMass * 2.5);
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const pullFwd = dx * fx + dz * fz, pullRight = dx * -fz + dz * fx;
      s.pitch += pullFwd * share * 0.55 * dt;
      s.roll -= pullRight * share * 0.75 * dt;
    }
  } else r.up.lerp({ x: 0, y: 1, z: 0 }, 1 - Math.exp(-4 * dt)).normalize();

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

// dir: -1 reels in, +1 lets out. An unloaded hook can be reeled all the way in (0.1 m) to stow against the belly.
export function winch(r, dir, dt) {
  const min = r.tool === 'hook' && !r.crate ? 0.1 : RIG.minLine, prev = r.len;
  r.len = Math.min(RIG[r.tool].line, Math.max(min, r.len + dir * RIG.winchSpeed * dt));
  if (r.len >= RIG.minLine) r.savedLen = r.len;
  r.dLen = r.len - prev;
}

export function swapTool(r) {
  if (r.crate || r.dumping) return false;
  const prev = r.len;
  r.tool = r.tool === 'bucket' ? 'hook' : 'bucket';
  if (r.tool === 'bucket' && r.len < RIG.minLine) r.len = r.savedLen || RIG.minLine;
  const min = r.tool === 'hook' ? 0.1 : RIG.minLine;
  r.len = Math.min(RIG[r.tool].line, Math.max(min, r.len));
  if (r.len > prev) { r.pos.addScaledVector(r.up, -(r.len - prev)); r.prev.copy(r.pos); }
  r.water = 0;
  return true;
}

// ---- Visuals ----

const Y = new THREE.Vector3(0, 1, 0), V = THREE.Vector2;
const ORANGE = 0xf2763a, BUCKET_RED = 0xe2502c, BUCKET_DARK = 0x8c2e1a, YELLOW = 0xf6d34a, STEEL = 0x4a4d57;

// Collapsible Bambi Bucket on a 4-leg tubular bridle with control head, rim collar, vertical battens, hi-vis band, and dump valve base.
// Origin at top shackle (0, 0, 0); base at y = -1.2 (matches RIG.bucket.hang).
export function buildBucketMesh() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55 });
  const hb = bodyBaker(), sb = bodyBaker(), group = new THREE.Group();

  // Top swivel shackle & yellow ballast/release control head at the rope attachment point (stays fixed size).
  hb.add(new THREE.CylinderGeometry(0.055, 0.075, 0.09, 6), DARK, 0, -0.045, 0);
  hb.add(new THREE.CylinderGeometry(0.11, 0.09, 0.09, 8), YELLOW, 0, -0.12, 0);
  hb.add(new THREE.CylinderGeometry(0.065, 0.085, 0.06, 8), DARK, 0, -0.18, 0);
  strut(hb, 0.016, DARK, [0, -0.18, 0], [0, -1.0, 0]); // internal dump-valve trip line

  // 4-leg suspension bridle struts + collapsible basket shell (expands radially as the bucket fills with water).
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4, cx = Math.cos(a) * 0.78, cz = Math.sin(a) * 0.78;
    strut(sb, 0.024, STEEL, [Math.cos(a) * 0.05, -0.15, Math.sin(a) * 0.05], [cx, -0.48, cz]);
    sb.add(new THREE.BoxGeometry(0.1, 0.09, 0.1).rotateY(-a), DARK, cx, -0.47, cz);
  }

  // Tapered collapsible bucket shell (segmented rings for crisp red-orange body + yellow safety band + dark interior wall).
  const prof = [
    [0, -1.2], [0.54, -1.2], [0.56, -1.12], [0.58, -1.06],
    [0.67, -0.82], [0.72, -0.69], [0.82, -0.52], [0.85, -0.46],
    [0.76, -0.46], [0.74, -0.53], [0.52, -1.06], [0, -1.06],
  ];
  sb.add(new THREE.LatheGeometry(prof.map(([r, y]) => new V(r, y)), 12), (x, y, z) => {
    const r = Math.hypot(x, z);
    if (y > -0.5) return DARK;                                            // heavy upper rubber/steel rim collar
    if (r < 0.54 + (y + 1.06) * 0.38 && y < -0.49) return 0x222026;       // dark interior cavity wall
    if (y < -1.1) return DARK;                                            // bottom dump-valve ring
    if (y < -1.02) return BUCKET_DARK;                                    // lower ballast skirt
    if (y > -0.81 && y < -0.7) return YELLOW;                             // hi-vis reflective middle stripe
    return BUCKET_RED;
  }, 0, 0, 0, 6);

  // 6 external vertical reinforcement web battens along the tapered shell wall.
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    strut(sb, 0.024, BUCKET_DARK, [Math.cos(a) * 0.81, -0.52, Math.sin(a) * 0.81], [Math.cos(a) * 0.57, -1.1, Math.sin(a) * 0.57]);
  }

  const head = new THREE.Mesh(hb.geometry(), mat);
  const shell = new THREE.Mesh(sb.geometry(), mat);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(0.73, 0.5, 0.08, 12).translate(0, -0.04, 0),
    new THREE.MeshStandardMaterial({ color: 0x4fb3cf, flatShading: true, roughness: 0.25 }),
  );
  water.position.y = -0.56;
  group.add(head, shell, water);
  group.userData = { shell, water };
  return group;
}

// Weighted crane overhaul ball + swivel yoke + sculpted J-hook with spring safety latch.
// Origin at top shackle (0, 0, 0); bottom of hook saddle at y = -0.48.
export function buildHookMesh() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5 });
  const b = bodyBaker(), group = new THREE.Group();

  // Top clevis shackle & swivel pin.
  b.add(new THREE.CylinderGeometry(0.045, 0.055, 0.06, 6), STEEL, 0, -0.03, 0);
  b.add(new THREE.CylinderGeometry(0.065, 0.065, 0.04, 8), DARK, 0, -0.07, 0);

  // Lathed overhaul headache ball with a yellow equatorial bumper band.
  const ballProf = [[0, -0.23], [0.09, -0.215], [0.135, -0.17], [0.135, -0.13], [0.09, -0.085], [0, -0.07]];
  b.add(new THREE.LatheGeometry(ballProf.map(([r, y]) => new V(r, y)), 10), (x, y) => (y > -0.17 && y < -0.13 ? YELLOW : ORANGE), 0, 0, 0, 6);

  // Lower swivel collar & yellow latch yoke housing.
  b.add(new THREE.CylinderGeometry(0.055, 0.05, 0.045, 8), DARK, 0, -0.245, 0);
  b.add(new THREE.BoxGeometry(0.11, 0.06, 0.11), YELLOW, 0, -0.29, -0.01);

  // Extruded forged J-hook profile in the y-z plane with thick reinforced spine, wide saddle, upturned bill & safety latch.
  const hookShape = new THREE.Shape([
    [-0.045, -0.30], [0.025, -0.30], [0.025, -0.34], [-0.02, -0.365], [-0.025, -0.415],
    [0.02, -0.435], [0.068, -0.41], [0.082, -0.36], [0.115, -0.368], [0.105, -0.445],
    [0.025, -0.49], [-0.065, -0.465], [-0.085, -0.385], [-0.06, -0.30],
  ].map(([z, y]) => new V(z, y)));
  const jHook = new THREE.ExtrudeGeometry(hookShape, { depth: 0.06, bevelEnabled: false }).translate(0, 0, -0.03).rotateY(-Math.PI / 2);
  b.add(jHook, DARK);
  strut(b, 0.014, ORANGE, [0, -0.32, 0.015], [0, -0.365, 0.085]); // spring safety latch across the hook throat

  group.add(new THREE.Mesh(b.geometry(), mat));
  return group;
}

export function buildRigView(scene) {
  const rope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038, 0.038, 1, 6).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: DARK, flatShading: true, roughness: 0.7 }),
  );
  const bucket = buildBucketMesh(), { shell, water } = bucket.userData;
  const hook = buildHookMesh();

  scene.add(rope, bucket, hook);
  const p = new THREE.Vector3(), anchor = new THREE.Vector3(), dir = new THREE.Vector3();
  let plump = 0;

  // view: interpolated chopper position; shown false hides the whole rig (airframes with no line).
  // Returns the interpolated rope end.
  return function update(r, view, alpha, shown = true) {
    if (!shown) { rope.visible = bucket.visible = hook.visible = false; return p.copy(view); }
    p.lerpVectors(r.prev, r.pos, alpha);
    anchor.set(view.x, view.y + RIG.anchor, view.z);
    dir.subVectors(p, anchor);
    const len = dir.length();
    rope.visible = len > 0.16;
    rope.position.copy(anchor);
    rope.scale.y = len;
    if (len > 1e-4) rope.quaternion.setFromUnitVectors(Y, dir.divideScalar(len));

    bucket.visible = r.tool === 'bucket';
    hook.visible = r.tool === 'hook';
    const g = bucket.visible ? bucket : hook;
    g.position.copy(p);
    g.quaternion.setFromUnitVectors(Y, r.up);
    if (bucket.visible) {
      const full = Math.min(1, Math.max(0, r.water / RIG.cap));
      plump += (full - plump) * 0.18;
      const rad = 0.62 + plump * 0.46; // collapsible basket: slim when empty, swells wide as it fills
      shell.scale.set(rad, 1.03 - plump * 0.04, rad);
      water.visible = r.water > 0.02;
      bucket.scale.setScalar(bucketScale());
      water.position.y = -1.04 + full * 0.5;
      const wr = (0.72 + full * 0.28) * rad;
      water.scale.set(wr, 1, wr);
      water.rotation.set(r.slosh.z * 1.5, 0, -r.slosh.x * 1.5);
    }
    return p;
  };
}

// Heavy cargo meshes; origin at the top centre (the hook point), baked into one mesh with 3D slings & spreader bars.
export function buildHeavyMesh(key) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
  const b = bodyBaker(), g = new THREE.Group();
  // Top master lifting link & shackle at the hook point (0, 0, 0).
  b.add(new THREE.CylinderGeometry(0.055, 0.065, 0.09, 6), DARK, 0, -0.045, 0);
  b.add(new THREE.CylinderGeometry(0.08, 0.08, 0.05, 8), YELLOW, 0, -0.09, 0);

  if (key === 'container') {
    // H-frame steel spreader bar at y = -0.34 with 4 upper bridle cables & 4 lower twist-lock corner cables.
    b.add(new THREE.BoxGeometry(1.56, 0.09, 0.14), YELLOW, 0, -0.34, 0);
    for (const sx of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.11, 0.09, 2.04), YELLOW, sx * 0.72, -0.34, 0);
      for (const sz of [-1, 1]) {
        strut(b, 0.022, STEEL, [0, -0.08, 0], [sx * 0.72, -0.34, sz * 0.96]);
        b.add(new THREE.BoxGeometry(0.14, 0.11, 0.14), DARK, sx * 0.72, -0.34, sz * 0.96);
        strut(b, 0.022, DARK, [sx * 0.72, -0.36, sz * 0.96], [sx * 1.0, -0.6, sz * 1.56]);
        // Top & bottom ISO corner castings (bottom sits at y = -2.20, matching RIG.container.hang).
        b.add(new THREE.BoxGeometry(0.18, 0.16, 0.18), DARK, sx * 1.0, -0.66, sz * 1.56);
        b.add(new THREE.BoxGeometry(0.18, 0.16, 0.18), DARK, sx * 1.0, -2.12, sz * 1.56);
        b.add(new THREE.BoxGeometry(0.14, 1.48, 0.14), 0x1e4e6e, sx * 1.0, -1.39, sz * 1.56);
      }
      // Top & bottom longitudinal side rails + forklift pockets.
      b.add(new THREE.BoxGeometry(0.12, 0.12, 3.12), 0x1e4e6e, sx * 1.0, -0.66, 0);
      b.add(new THREE.BoxGeometry(0.12, 0.14, 3.12), 0x1e4e6e, sx * 1.0, -2.11, 0);
      for (const fz of [-0.52, 0.52]) b.add(new THREE.BoxGeometry(0.16, 0.08, 0.28), DARK, sx * 1.0, -2.13, fz);
    }
    // Main container shell & corrugated ribs.
    b.add(new THREE.BoxGeometry(2.02, 1.48, 3.16), 0x28668e, 0, -1.39, 0);
    for (let z = -1.28; z <= 1.29; z += 0.32) {
      b.add(new THREE.BoxGeometry(2.1, 1.36, 0.11), 0x205272, 0, -1.39, z);
      b.add(new THREE.BoxGeometry(1.92, 0.08, 0.12), 0x205272, 0, -0.64, z);
    }
    // Side logistics markings + rear double doors with vertical locking bars & hazard plates.
    for (const sx of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.04, 0.32, 0.85), YELLOW, sx * 1.05, -1.15, -0.35);
      b.add(new THREE.BoxGeometry(0.04, 0.18, 0.45), ORANGE, sx * 1.05, -1.15, 0.55);
    }
    for (const sz of [-1, 1]) b.add(new THREE.BoxGeometry(1.92, 0.12, 0.12), 0x1e4e6e, 0, -0.66, sz * 1.56);
    for (const dx of [-0.46, 0.46]) b.add(new THREE.BoxGeometry(0.86, 1.34, 0.06), 0x235a7d, dx, -1.39, 1.59);
    for (const lx of [-0.62, -0.22, 0.22, 0.62]) strut(b, 0.022, STEEL, [lx, -0.74, 1.63], [lx, -2.04, 1.63]);
    b.add(new THREE.BoxGeometry(0.32, 0.24, 0.04), YELLOW, -0.46, -1.15, 1.63);
    b.add(new THREE.BoxGeometry(0.26, 0.2, 0.04), ORANGE, 0.46, -1.15, 1.63);
  } else if (key === 'vehicle') {
    // 4-point heavy orange recovery webbing sling + roof stabilizer lines.
    for (const sx of [-1, 1]) {
      strut(b, 0.026, ORANGE, [0, -0.08, 0], [sx * 0.72, -1.22, -1.78]);
      strut(b, 0.026, ORANGE, [0, -0.08, 0], [sx * 0.76, -1.16, 1.72]);
      strut(b, 0.016, DARK, [0, -0.08, 0], [sx * 0.64, -0.64, -0.05]);
      b.add(new THREE.BoxGeometry(0.1, 0.1, 0.12), DARK, sx * 0.72, -1.22, -1.78);
      b.add(new THREE.BoxGeometry(0.1, 0.1, 0.12), DARK, sx * 0.76, -1.16, 1.72);
    }
    // Ladder chassis, solid axles & 4 mud-terrain tires (bottom at y = -1.52 - 0.38 = -1.90, matching RIG.vehicle.hang).
    b.add(new THREE.BoxGeometry(1.42, 0.2, 3.68), DARK, 0, -1.42, 0);
    for (const wz of [-1.25, 1.22]) {
      b.add(new THREE.CylinderGeometry(0.075, 0.075, 1.82, 8).rotateZ(Math.PI / 2), DARK, 0, -1.52, wz);
      b.add(new THREE.BoxGeometry(1.92, 0.24, 0.86), DARK, 0, -1.28, wz); // flared fender arches
      for (const sx of [-1, 1]) {
        b.add(new THREE.CylinderGeometry(0.38, 0.38, 0.32, 12).rotateZ(Math.PI / 2), DARK, sx * 0.86, -1.52, wz);
        b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.35, 8).rotateZ(Math.PI / 2), STEEL, sx * 0.86, -1.52, wz);
      }
    }
    // Lower truck body, sculpted hood, front bullbar, headlights & taillights.
    b.add(new THREE.BoxGeometry(1.82, 0.38, 3.76), 0xb84a39, 0, -1.2, 0);
    b.add(new THREE.BoxGeometry(1.86, 0.12, 2.1), 0x7d3227, 0, -1.4, 0); // rocker panels
    b.add(new THREE.BoxGeometry(1.52, 0.1, 1.05), 0xc95542, 0, -0.99, -1.26); // hood power dome
    b.add(new THREE.BoxGeometry(1.88, 0.22, 0.18), DARK, 0, -1.34, -1.92); // front winch bumper
    strut(b, 0.035, DARK, [-0.68, -1.32, -1.98], [0.68, -1.32, -1.98]);
    strut(b, 0.035, DARK, [-0.52, -1.04, -1.95], [0.52, -1.04, -1.95]);
    for (const sx of [-1, 1]) {
      strut(b, 0.035, DARK, [sx * 0.52, -1.34, -1.96], [sx * 0.52, -1.04, -1.95]);
      b.add(new THREE.BoxGeometry(0.26, 0.16, 0.06), YELLOW, sx * 0.66, -1.16, -1.88); // headlights
      b.add(new THREE.BoxGeometry(0.22, 0.22, 0.06), 0xe23d28, sx * 0.74, -1.14, 1.88); // taillights
    }
    b.add(new THREE.BoxGeometry(0.92, 0.2, 0.06), STEEL, 0, -1.18, -1.88); // radiator grille
    b.add(new THREE.BoxGeometry(1.88, 0.18, 0.16), DARK, 0, -1.36, 1.9);   // rear step bumper
    // Crew cab greenhouse with glass windshield/windows, pillars, roof rack & amber lightbar.
    b.add(new THREE.BoxGeometry(1.66, 0.42, 1.32), GLASS, 0, -0.84, -0.12);
    b.add(new THREE.BoxGeometry(1.72, 0.09, 1.38), 0xb84a39, 0, -0.64, -0.1); // cab roof
    b.add(new THREE.BoxGeometry(1.7, 0.4, 0.12), 0xb84a39, 0, -0.84, 0.5);    // cab rear wall
    for (const sx of [-1, 1]) {
      strut(b, 0.045, 0xb84a39, [sx * 0.81, -1.03, -0.78], [sx * 0.79, -0.65, -0.66]); // A-pillars
      strut(b, 0.05, 0xb84a39, [sx * 0.82, -1.03, -0.08], [sx * 0.81, -0.65, -0.08]);  // B-pillars
      strut(b, 0.022, DARK, [sx * 0.68, -0.6, -0.62], [sx * 0.68, -0.6, 0.44]);        // roof rails
    }
    b.add(new THREE.BoxGeometry(1.1, 0.08, 0.18), YELLOW, 0, -0.57, -0.42); // roof rescue lightbar
    // Open rear pickup cargo bed with dark liner, roll bar & spare tire.
    b.add(new THREE.BoxGeometry(1.56, 0.08, 1.24), DARK, 0, -1.24, 1.18);
    for (const sx of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.14, 0.22, 1.28), 0x9e3d2e, sx * 0.84, -0.96, 1.18);
      strut(b, 0.04, DARK, [sx * 0.72, -1.0, 0.64], [sx * 0.72, -0.62, 0.64]);
      strut(b, 0.035, DARK, [sx * 0.72, -0.64, 0.64], [sx * 0.72, -1.0, 1.28]);
    }
    strut(b, 0.04, DARK, [-0.72, -0.62, 0.64], [0.72, -0.62, 0.64]);
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10).rotateX(0.35), DARK, 0, -1.02, 1.12);
  } else {
    // Prefab timber cabin on heavy skid runners with steel spreader beam rig (bottom at y = -3.40, matching RIG.cabin.hang).
    b.add(new THREE.BoxGeometry(2.42, 0.14, 0.2), YELLOW, 0, -0.5, 0);
    for (const sx of [-1, 1]) {
      strut(b, 0.025, STEEL, [0, -0.08, 0], [sx * 1.14, -0.5, 0]);
      b.add(new THREE.BoxGeometry(0.16, 0.18, 0.24), DARK, sx * 1.14, -0.5, 0);
      for (const sz of [-1, 1]) {
        strut(b, 0.022, DARK, [sx * 1.14, -0.54, 0], [sx * 1.32, -1.42, sz * 1.48]);
        b.add(new THREE.BoxGeometry(0.14, 0.12, 0.14), DARK, sx * 1.32, -1.42, sz * 1.48);
      }
    }
    // 3 heavy foundation skid beams at y = -3.40..3.22 + timber deck platform (extends forward for porch).
    for (const kx of [-1.22, 0, 1.22]) b.add(new THREE.BoxGeometry(0.22, 0.18, 4.16), DARK, kx, -3.31, 0);
    b.add(new THREE.BoxGeometry(2.96, 0.14, 4.08), 0x7a5230, 0, -3.16, 0);
    // Warm cedar cabin walls, corner posts, horizontal log bands & gable peaks.
    b.add(new THREE.BoxGeometry(2.76, 1.58, 3.36), 0xc48e56, 0, -2.3, 0.28);
    for (let y = -2.92; y <= -1.88; y += 0.32) b.add(new THREE.BoxGeometry(2.82, 0.07, 3.4), 0xa87440, 0, y, 0.28);
    for (const sx of [-1, 1]) for (const wz of [-1.38, 1.94]) b.add(new THREE.BoxGeometry(0.18, 1.6, 0.18), 0x7a4e28, sx * 1.36, -2.3, wz);
    const gable = new THREE.Shape([new V(-1.36, -1.52), new V(1.36, -1.52), new V(0, -0.86)]);
    b.add(new THREE.ExtrudeGeometry(gable, { depth: 3.36, bevelEnabled: false }), 0xb8824c, 0, 0, -1.4);
    // Steep overhanging corrugated red-oxide gable roof, ridge beam & exterior rear stone chimney stack.
    for (const sx of [-1, 1]) {
      b.add(new THREE.BoxGeometry(1.88, 0.12, 4.24).rotateZ(-sx * 0.46), 0x8e3829, sx * 0.78, -1.22, 0);
      for (let z = -1.8; z <= 1.81; z += 0.6) b.add(new THREE.BoxGeometry(1.9, 0.05, 0.08).rotateZ(-sx * 0.46), 0x732b1f, sx * 0.78, -1.19, z);
    }
    b.add(new THREE.BoxGeometry(0.24, 0.16, 4.28), DARK, 0, -0.84, 0);
    b.add(new THREE.BoxGeometry(0.48, 2.42, 0.38), 0x626068, 0.72, -1.9, 2.04); // rear exterior stone chimney
    b.add(new THREE.BoxGeometry(0.56, 0.12, 0.46), DARK, 0.72, -0.66, 2.04);
    // Front porch posts, railings, recessed timber door, lantern & framed glass windows.
    for (const sx of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.14, 1.56, 0.14), 0x7a4e28, sx * 1.34, -2.31, -1.92);
      b.add(new THREE.BoxGeometry(0.84, 0.09, 0.1), 0x7a4e28, sx * 0.92, -2.62, -1.92);
      for (const bx of [0.56, 0.86, 1.14]) b.add(new THREE.BoxGeometry(0.06, 0.46, 0.06), 0x9c6838, sx * bx, -2.86, -1.92);
      for (const wz of [-0.45, 0.95]) {
        b.add(new THREE.BoxGeometry(0.08, 0.62, 0.74), 0xfff1d8, sx * 1.4, -2.18, wz);
        b.add(new THREE.BoxGeometry(0.1, 0.48, 0.6), GLASS, sx * 1.4, -2.18, wz);
      }
    }
    b.add(new THREE.BoxGeometry(0.84, 1.38, 0.08), 0xfff1d8, 0.15, -2.4, -1.4);  // doorframe
    b.add(new THREE.BoxGeometry(0.7, 1.3, 0.1), 0x5a361e, 0.15, -2.44, -1.4);    // timber door
    b.add(new THREE.BoxGeometry(0.14, 0.18, 0.14), YELLOW, 0.68, -2.02, -1.44);  // warm porch lantern
    b.add(new THREE.BoxGeometry(0.72, 0.62, 0.08), 0xfff1d8, -0.78, -2.18, -1.4); // front window
    b.add(new THREE.BoxGeometry(0.58, 0.48, 0.1), GLASS, -0.78, -2.18, -1.4);
  }
  g.add(new THREE.Mesh(b.geometry(), mat));
  return g;
}

// Wooden air-cargo supply crate on 3 forklift pallet skids with timber cross-bracing & 4-leg lifting sling.
// Origin at top shackle (0, 0, 0); bottom of pallet skids at y = -1.60 (matches RIG.crate.hang).
export function buildCrateMesh() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.65 });
  const b = bodyBaker(), g = new THREE.Group();

  // Top master shackle & 4-leg wire sling down to corner pad-eyes on the crate roof.
  b.add(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 6), DARK, 0, -0.04, 0);
  b.add(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 8), YELLOW, 0, -0.08, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    strut(b, 0.02, DARK, [0, -0.07, 0], [sx * 0.62, -0.44, sz * 0.62]);
    b.add(new THREE.BoxGeometry(0.12, 0.08, 0.12), DARK, sx * 0.62, -0.44, sz * 0.62);
  }

  // Inner wooden plank box + horizontal plank battens.
  b.add(new THREE.BoxGeometry(1.3, 1.0, 1.3), 0xc89252, 0, -0.96, 0);
  for (const y of [-1.24, -0.96, -0.68]) b.add(new THREE.BoxGeometry(1.34, 0.06, 1.34), 0xb07c3e, 0, y, 0);

  // Heavy outer timber framing rails, corner posts, diagonal face cross-braces & steel corner brackets.
  for (const y of [-0.49, -1.43]) b.add(new THREE.BoxGeometry(1.42, 0.1, 1.42), 0x85582c, 0, y, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.12, 1.04, 0.12), 0x85582c, sx * 0.65, -0.96, sz * 0.65);
    for (const cy of [-0.48, -1.44]) b.add(new THREE.BoxGeometry(0.15, 0.12, 0.15), DARK, sx * 0.65, cy, sz * 0.65);
  }
  for (const s of [-0.67, 0.67]) {
    strut(b, 0.042, 0x85582c, [-0.62, -1.4, s], [0.62, -0.52, s]);
    strut(b, 0.042, 0x85582c, [-0.62, -0.52, s], [0.62, -1.4, s]);
    strut(b, 0.042, 0x85582c, [s, -1.4, -0.62], [s, -0.52, 0.62]);
    strut(b, 0.042, 0x85582c, [s, -0.52, -0.62], [s, -1.4, 0.62]);
    // High-visibility cargo stencil plates.
    b.add(new THREE.BoxGeometry(0.38, 0.22, 0.04), YELLOW, 0, -0.78, s * 1.03);
    b.add(new THREE.BoxGeometry(0.04, 0.22, 0.38), ORANGE, s * 1.03, -0.78, 0);
  }

  // 3 heavy forklift pallet skids at the base (y = -1.48..-1.60).
  for (const kx of [-0.56, 0, 0.56]) b.add(new THREE.BoxGeometry(0.16, 0.12, 1.42), 0x5c3a1e, kx, -1.54, 0);

  g.add(new THREE.Mesh(b.geometry(), mat));
  return g;
}

// Stranded hiker / boater in a hi-vis rescue jacket, helmet, backpack & hoist harness; origin at top hoist ring (0, 0, 0),
// boots at y = -1.80 (matches RIG.person.hang). Passing boater = true adds an inflatable orange life raft.
export function buildPersonMesh(boater = false) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
  const b = bodyBaker(), g = new THREE.Group();

  // Top hoist D-ring, swivel & dual yellow rescue hoist straps down to the chest harness.
  b.add(new THREE.CylinderGeometry(0.045, 0.055, 0.07, 6), STEEL, 0, -0.035, 0);
  b.add(new THREE.CylinderGeometry(0.065, 0.065, 0.04, 8), YELLOW, 0, -0.08, 0);
  for (const sx of [-1, 1]) strut(b, 0.02, YELLOW, [0, -0.08, 0], [sx * 0.17, -0.66, -0.06]);

  // Rescue helmet, head & neck.
  b.add(new THREE.SphereGeometry(0.15, 8, 6), (x, y) => (y > -0.31 && Math.abs(x) < 0.045 ? ORANGE : 0xf4f1ee), 0, -0.37, 0.01);
  b.add(new THREE.BoxGeometry(0.21, 0.05, 0.14), DARK, 0, -0.37, -0.09); // helmet visor/goggles
  b.add(new THREE.IcosahedronGeometry(0.135, 1), 0xe2b28c, 0, -0.44, 0);
  b.add(new THREE.CylinderGeometry(0.07, 0.08, 0.08, 6), 0xe2b28c, 0, -0.56, 0);

  // Torso in hi-vis orange rescue jacket with reflective yellow chest band, dark harness & expedition backpack.
  b.add(new THREE.CylinderGeometry(0.21, 0.17, 0.52, 8, 5), (x, y) => {
    if (y < -1.0) return DARK;                  // rescue harness waist belt
    if (y > -0.88 && y < -0.76) return YELLOW;  // reflective hi-vis chest stripe
    return ORANGE;
  }, 0, -0.84, 0, 6);
  b.add(new THREE.BoxGeometry(0.28, 0.38, 0.18), 0x3d563a, 0, -0.83, 0.18); // backpack
  b.add(new THREE.CylinderGeometry(0.07, 0.07, 0.28, 6).rotateZ(Math.PI / 2), 0x2b3d29, 0, -0.62, 0.17);

  // Raised waving arms + hands, pelvis, two distinct trek-pant legs & hiking boots (soles at y = -1.80).
  b.add(new THREE.CylinderGeometry(0.17, 0.15, 0.14, 8), 0x28334a, 0, -1.14, 0);
  for (const sx of [-1, 1]) {
    strut(b, 0.06, ORANGE, [sx * 0.18, -0.64, 0], [sx * 0.34, -0.42, -0.06]);
    b.add(new THREE.SphereGeometry(0.055, 6, 5), 0xe2b28c, sx * 0.35, -0.4, -0.07);
    strut(b, 0.072, 0x28334a, [sx * 0.09, -1.16, 0], [sx * 0.1, -1.66, 0]);
    b.add(new THREE.BoxGeometry(0.13, 0.1, 0.22), 0x4e3524, sx * 0.1, -1.71, -0.03);
    b.add(new THREE.BoxGeometry(0.14, 0.04, 0.23), DARK, sx * 0.1, -1.78, -0.03);
  }

  // Inflatable rescue life raft for adrift boaters.
  if (boater) {
    b.add(new THREE.TorusGeometry(0.95, 0.22, 8, 8).rotateX(Math.PI / 2), (x, y, z) => (Math.abs(x) < 0.22 || Math.abs(z) < 0.22 ? YELLOW : 0xff6a2a), 0, -1.72, 0);
    b.add(new THREE.CylinderGeometry(0.92, 0.92, 0.1, 8), DARK, 0, -1.82, 0);
  }

  g.add(new THREE.Mesh(b.geometry(), mat));
  return g;
}

export function placeCrateMesh(mesh, c) {
  mesh.position.copy(c.pos);
  mesh.quaternion.setFromUnitVectors(Y, c.up);
}
