import * as THREE from 'three';
import { bodyBaker, DARK, GLASS, fin, strut } from './chopper.js';

const G = 9.81, SEA = 0;

// Water bomber flight, arcade-but-plane-like. Orientation is a quaternion so it can roll freely:
// A/D roll, S pulls the nose up (and round, when banked), W pushes it down, Q/E rudder, Space/Shift throttle.
// A banked plane turns on its own (gently); it eases back toward level when you let go of A/D.
// The flight path lags the nose, so it carries momentum. Too slow and it stalls: the nose drops and it sinks.
export const PLANE = {
  thrust: 8, drag: 0.0045,           // top speed ~42 m/s (~150 km/h)
  stall: 24,                         // full lift at and above this airspeed (~86 km/h)
  rollRate: 1.7, pitchRate: 0.55, rudderRate: 0.35,
  bankTurn: 1.1,                     // how hard a bank alone turns the plane
  autoLevel: 0.6, pitchLevel: 0.5,   // roll / pitch ease back toward level when A/D / W/S are released
  maxPitch: 0.55,                    // ~32 degrees: steep enough to climb out, hard to stall by accident
  follow: 2.2,                       // how fast the flight path swings round to the nose (momentum)
  tank: 6, scoopRate: 2.5, scoopSpeed: 18, scoopHeight: 3, dropRate: 3, // skim within scoopHeight of the sea to fill
  burn: 1 / 420,
  rollDrag: 0.04, brake: 4, waterDrag: 0.15,
  hardSink: 6,                       // sink rate that turns a touchdown into a hard landing
  ceiling: 600, bound: 1650,
};

export function createPlane(x, y, z, yaw) {
  return { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    dir: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), yaw, pitch: 0, roll: 0, speed: 0, throttle: 0,
    onSurface: true, onWater: false, grounded: true, hit: 0, fuel: 1, water: 0, dumping: false, poured: 0, scooping: false, lift: 0 };
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const dq = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), nose = new THREE.Vector3();
const rotLocal = (q, axis, a) => q.multiply(dq.setFromAxisAngle(axis, a));
const unwrap = (a, near) => a + Math.round((near - a) / (Math.PI * 2)) * Math.PI * 2;

// input: { fwd, turn, lift, strafe } in [-1, 1]. env: { groundAt, heightAt, trees?, wind? }.
export function stepPlane(s, input, dt, env) {
  const P = PLANE;
  s.throttle = s.fuel > 0 ? Math.min(1, Math.max(0, s.throttle + input.lift * 0.7 * dt)) : 0;
  s.lift = Math.min(1, Math.max(0, (s.speed - P.stall * 0.6) / (P.stall * 0.4)));

  if (!s.onSurface) {
    const authority = 0.35 + 0.65 * s.lift; // controls go mushy as it slows
    rotLocal(s.q, X, -input.fwd * P.pitchRate * authority * dt);
    rotLocal(s.q, Z, input.turn * P.rollRate * authority * dt);
    rotLocal(s.q, Y, -(input.strafe || 0) * P.rudderRate * dt);
    e.setFromQuaternion(s.q);
    if (!input.turn) rotLocal(s.q, Z, -e.z * P.autoLevel * dt);
    if (!input.fwd) rotLocal(s.q, X, -e.x * P.pitchLevel * dt); // and the nose drifts back toward level
    s.q.premultiply(dq.setFromAxisAngle(Y, ((G * Math.sin(e.z)) / Math.max(s.speed, 15)) * P.bankTurn * dt)); // banked: it turns
    if (s.lift < 1) rotLocal(s.q, X, -(1 - s.lift) * 0.9 * dt);                                                // stalling: nose drops
    e.setFromQuaternion(s.q);
    if (Math.abs(e.x) > P.maxPitch) { e.x = Math.sign(e.x) * P.maxPitch; s.q.setFromEuler(e); }
  } else {
    // Rolling: nosewheel steering and rudder, wings level, and you can rotate the nose up once near flying speed.
    e.setFromQuaternion(s.q);
    e.y += (input.turn * 0.6 + (input.strafe || 0) * -0.3) * Math.min(1, s.speed / 6) * dt;
    e.x = Math.min(s.speed > P.stall * 0.75 ? 0.25 : 0, Math.max(0, e.x - input.fwd * P.pitchRate * dt));
    e.z = 0;
    s.q.setFromEuler(e);
  }
  e.setFromQuaternion(s.q);
  s.yaw = unwrap(e.y, s.yaw);
  s.pitch = -e.x;
  s.roll = unwrap(e.z, s.roll);
  nose.set(0, 0, -1).applyQuaternion(s.q);

  // Flight path swings toward the nose; without lift, gravity bends it down.
  s.dir.lerp(nose, 1 - Math.exp(-P.follow * (s.onSurface ? 3 : Math.max(0.2, s.lift)) * dt));
  if (!s.onSurface) s.dir.y -= (1 - s.lift) * 0.6 * dt;
  if (s.onSurface) s.dir.y = Math.max(0, s.dir.y);
  s.dir.normalize();

  let a = s.throttle * P.thrust - P.drag * s.speed * s.speed - G * s.dir.y; // climbing costs speed, diving gains it
  if (s.onSurface) a -= s.onWater ? P.waterDrag * s.speed : P.rollDrag * s.speed + (s.throttle < 0.05 ? P.brake : 0);
  s.speed = Math.max(0, s.speed + a * dt);

  s.vel.copy(s.dir).multiplyScalar(s.speed);
  if (s.pos.y > P.ceiling) s.vel.y = Math.min(0, s.vel.y);
  if (env.wind && !s.onSurface) { s.vel.x += env.wind.x * 0.2; s.vel.z += env.wind.z * 0.2; }
  if (Math.hypot(s.pos.x, s.pos.z) > P.bound && !s.onSurface) {
    s.q.premultiply(dq.setFromAxisAngle(Y, Math.sign(Math.sin(Math.atan2(-s.pos.x, -s.pos.z) - s.yaw)) * 0.6 * dt)); // edge: nudge back
  }
  s.pos.addScaledVector(s.vel, dt);

  // Touching down: gentle, level and wings-level is a landing (runway, flat land or calm sea); otherwise a hard bounce.
  const g = env.groundAt(s.pos.x, s.pos.z), water = env.heightAt(s.pos.x, s.pos.z) < SEA - 0.5;
  s.hit = 0;
  if (s.pos.y <= g + 0.02) {
    const sink = Math.max(0, -s.vel.y), slope = Math.hypot(env.groundAt(s.pos.x + 2, s.pos.z) - g, env.groundAt(s.pos.x, s.pos.z + 2) - g) / 2;
    s.pos.y = g;
    const ok = water ? sink < P.hardSink * 1.5 && s.pitch < 0.35 && Math.abs(s.roll) < 0.6 : sink < P.hardSink && s.pitch < 0.25 && Math.abs(s.roll) < 0.35 && slope < 0.15 && s.speed < 40;
    if (!ok) { s.hit = sink + s.speed * 0.3; s.speed *= 0.5; if (!water) { s.pos.y = g + 0.5; s.dir.y = 0.15; } }
    s.onSurface = ok || water;
    s.onWater = water;
    if (s.onSurface) {
      s.dir.y = Math.max(0, s.dir.y);
      e.set(Math.max(0, Math.min(-s.pitch, 0.25)), s.yaw, 0);
      s.q.setFromEuler(e);
      s.pitch = -e.x;
      s.roll = 0;
    }
  } else s.onSurface = s.onWater = false;
  s.grounded = s.onSurface && s.speed < 3;
  if (env.trees) { const t = env.trees(s.pos, s.vel, 2.5, 1.5); if (t > 0) { s.hit = Math.max(s.hit, t); s.speed *= 0.5; } }

  // Scoop by skimming: touching the sea or just above it, fast enough.
  const overSea = env.heightAt(s.pos.x, s.pos.z) < SEA - 0.5;
  s.scooping = overSea && s.pos.y - SEA < P.scoopHeight && s.speed > P.scoopSpeed && !s.dumping;
  if (s.scooping) s.water = Math.min(P.tank, s.water + P.scoopRate * dt);
  s.poured = 0;
  if (s.dumping) {
    s.poured = Math.min(s.water, P.dropRate * dt);
    s.water -= s.poured;
    if (s.water <= 0) s.dumping = false;
  }
  if (!s.onSurface || s.throttle > 0.1) s.fuel = Math.max(0, s.fuel - dt * P.burn * (0.5 + s.throttle));
}

// F: open the doors (needs water aboard).
export function drop(s) {
  if (s.water < 0.1 || s.dumping) return false;
  s.dumping = true;
  return true;
}

// ---- Model: classic twin-prop scooper. Deep boat hull with an upswept tail, long wing sitting on the fuselage,
// engines on the wing with props well ahead of it, tall fin with the tailplane on it, wingtip floats, fixed gear.
// Wheels touch y = 0, nose to -z. ----
export function buildPlane({ body = 0xf2c230, trim = 0xd8352a } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5 });
  const b = bodyBaker(), group = new THREE.Group(), V = THREE.Vector2, WHITE = 0xf3efe6;

  // Fuselage: one continuous lathe from nose to tail, then bent so the rear sweeps up into the fin (no separate boom).
  // Painted by height relative to the bent centreline: red boat hull below, white cheat line, glass cockpit/windows.
  const sweep = (z) => 0.09 * Math.max(0, z - 1) ** 1.35;
  const fuselage = new THREE.LatheGeometry([[0, -8.2], [0.6, -7.9], [1.0, -7.2], [1.3, -5.8], [1.4, -3.5], [1.4, 1.0], [1.3, 3.0], [1.1, 5.0], [0.85, 7.0], [0.6, 9.0], [0.4, 10.6], [0, 11.0]]
    .map(([r, z]) => new V(r, z)), 12).rotateX(Math.PI / 2).scale(0.82, 1, 1).toNonIndexed();
  const fp = fuselage.attributes.position;
  for (let i = 0; i < fp.count; i++) fp.setY(i, fp.getY(i) + 2.1 + sweep(fp.getZ(i)));
  b.add(fuselage, (x, y, z) => {
    const rel = y - 2.1 - sweep(z);
    if (rel < -0.85) return trim;
    if (rel < -0.55) return WHITE;
    if (z < -6.0 && rel > 0.25) return GLASS;
    if (z > -5.6 && z < 1.0 && rel > 0.4 && rel < 0.75 && Math.abs(x) > 0.85) return GLASS;
    return body;
  }, 0, 0, 0, 6);

  // Wing set into the top of the fuselage: tapered halves meeting on the centreline, slight dihedral, white tips,
  // and a root fairing blending it into the hull.
  for (const side of [-1, 1]) {
    const pts = [[0, -1.7], [13, -1.0], [13, 0.8], [0, 1.6]].map(([x, z]) => new V(side * x, z));
    const wing = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.36, bevelEnabled: false }).rotateX(Math.PI / 2).rotateZ(side * -0.035);
    b.add(wing, (x) => (Math.abs(x) > 11.8 ? WHITE : body), 0, 3.6, -0.8);
  }
  b.add(new THREE.BoxGeometry(1.9, 0.55, 3.4).scale(1, 1, 1), body, 0, 3.3, -0.85);                    // wing-root fairing
  for (const x of [-4.2, 4.2]) {
    b.add(new THREE.CylinderGeometry(0.8, 0.55, 5.4, 10).rotateX(Math.PI / 2), body, x, 3.5, -2.4);   // nacelles, well ahead of the wing
    b.add(new THREE.CylinderGeometry(0.82, 0.82, 0.3, 10).rotateX(Math.PI / 2), trim, x, 3.5, -4.6);  // cowl ring
    strut(b, 0.08, DARK, [x * 2.7, 3.3, -0.8], [x * 2.7, 1.3, -0.8]);                                    // float struts
    b.add(new THREE.IcosahedronGeometry(0.55, 1).scale(0.7, 0.6, 2.4), trim, x * 2.7, 1.1, -0.8);      // wingtip floats
  }
  fin(b, [[0, 0], [2.8, 0], [3.9, 4.6], [2.5, 4.7]], body, 3.85, 8.2, 0.3);                                    // tall fin, rooted in the upswept tail
  b.add(new THREE.BoxGeometry(8.6, 0.18, 1.7), body, 0, 6.2, 10.6);                                      // tailplane on the fin
  for (const x of [-4.1, 4.1]) b.add(new THREE.BoxGeometry(0.4, 0.2, 1.72), trim, x, 6.2, 10.6);
  b.add(new THREE.BoxGeometry(0.34, 0.9, 1.5), trim, 0, 8.05, 11.0);                                     // fin cap
  for (const [x, z] of [[-1.55, 0.6], [1.55, 0.6], [0, -5.6]]) {                                          // fixed gear
    strut(b, 0.1, DARK, [x * 0.55, 1.2, z], [x, 0.48, z]);
    b.add(new THREE.CylinderGeometry(0.48, 0.48, 0.34, 10).rotateZ(Math.PI / 2), DARK, x, 0.48, z);
  }
  b.add(new THREE.BoxGeometry(1.6, 0.18, 1.2), DARK, 0, 0.82, -1.2);                                     // drop doors
  group.add(new THREE.Mesh(b.geometry(), mat));

  // Four-blade props with a blur disc that fades in with throttle.
  const props = [-4.2, 4.2].map((x) => {
    const pb = bodyBaker();
    pb.add(new THREE.ConeGeometry(0.38, 0.8, 8).rotateX(-Math.PI / 2), trim);
    for (let i = 0; i < 4; i++) pb.add(new THREE.BoxGeometry(0.24, 2.0, 0.06).translate(0, 1.05, 0).rotateZ((i * Math.PI) / 2), DARK);
    const p = new THREE.Mesh(pb.geometry(), mat);
    p.position.set(x, 3.5, -5.2);
    group.add(p);
    return p;
  });
  const discMat = new THREE.MeshBasicMaterial({ color: 0x1c1c22, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  for (const p of props) { const d = new THREE.Mesh(new THREE.CircleGeometry(2.1, 20), discMat); d.position.copy(p.position); group.add(d); }

  const lamp = (color, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  lamp(0xff3030, -13, 3.4, -0.3);
  lamp(0x30ff70, 13, 3.4, -0.3);
  const beacon = lamp(0xff2a2a, 0, 3.75, 1.4), strobe = lamp(0xffffff, 0, 8.7, 11.8);
  group.rotation.order = 'YXZ';
  let spinA = 0;
  return { group, beacon, strobe, spin: (dt, power) => {
    spinA += dt * (6 + 22 * power);
    for (const p of props) p.rotation.z = spinA;
    discMat.opacity = 0.18 * power;
  } };
}
