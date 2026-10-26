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
  tank: 6, scoopRate: 2.5, scoopSpeed: 18, scoopHeight: 3, dropRate: 2.4, reach: 3, // reach: splash rings per drop (a tank load spreads wide); skim within scoopHeight of the sea to fill
  burn: 1 / 420,
  rollDrag: 0.04, brake: 4, waterDrag: 0.15,
  hardSink: 6,                       // sink rate that turns a touchdown into a hard landing
  ceiling: 600, bound: 1650,
};

export function createPlane(x, y, z, yaw) {
  return { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    dir: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), yaw, pitch: 0, roll: 0, speed: 0, throttle: 0,
    onSurface: true, onWater: false, grounded: true, hit: 0, fuel: 1, water: 0, dumping: false, poured: 0, scooping: false, lift: 0, gear: 1 };
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const dq = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), nose = new THREE.Vector3();
const rotLocal = (q, axis, a) => q.multiply(dq.setFromAxisAngle(axis, a));
const unwrap = (a, near) => a + Math.round((near - a) / (Math.PI * 2)) * Math.PI * 2;

// input: { fwd, turn, lift, strafe } in [-1, 1]. env: { groundAt, heightAt, trees?, wind? }.
export function stepPlane(s, input, dt, env) {
  const P = PLANE, load = s.water / P.tank;
  s.throttle = s.fuel > 0 ? Math.min(1, Math.max(0, s.throttle + input.lift * 0.7 * dt)) : 0;
  s.lift = Math.min(1, Math.max(0, (s.speed - P.stall * 0.6) / (P.stall * 0.4)));

  if (!s.onSurface) {
    const authority = 0.35 + 0.65 * s.lift, strafe = input.strafe || 0; // controls go mushy as it slows
    rotLocal(s.q, X, -input.fwd * P.pitchRate * (1 - 0.06 * load) * authority * dt);
    rotLocal(s.q, Z, (input.turn * P.rollRate * authority + strafe * 0.16) * dt); // rudder also coaxes a gentle roll via dihedral
    rotLocal(s.q, Y, -strafe * P.rudderRate * dt);
    e.setFromQuaternion(s.q);
    if (!input.turn && !strafe) rotLocal(s.q, Z, -e.z * P.autoLevel * dt);
    if (!input.fwd) rotLocal(s.q, X, -e.x * P.pitchLevel * dt); // and the nose drifts back toward level
    s.q.premultiply(dq.setFromAxisAngle(Y, ((G * Math.sin(e.z)) / Math.max(s.speed, 15)) * P.bankTurn * dt)); // banked: it turns
    if (s.lift < 1) rotLocal(s.q, X, -(1 - s.lift) * (0.9 + 0.15 * load) * dt);                                // stalling: nose drops
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

  // Ground effect near the surface cushions sink rate; flight path swings toward the nose.
  const g0 = env.groundAt(s.pos.x, s.pos.z), alt = Math.max(0, s.pos.y - g0), wig = !s.onSurface && alt < 8 ? (1 - alt / 8) * 0.14 : 0;
  s.dir.lerp(nose, 1 - Math.exp(-P.follow * (s.onSurface ? 3 : Math.max(0.2, s.lift)) * dt));
  if (!s.onSurface) s.dir.y -= ((1 - s.lift) * (0.6 - wig) + load * 0.015) * dt;
  if (s.onSurface) s.dir.y = Math.max(0, s.dir.y);
  s.dir.normalize();

  // Induced drag rises slightly in steep banks and with a heavy water load.
  const bankDrag = !s.onSurface ? 1 + 0.12 * Math.sin(s.roll) ** 2 + 0.05 * load : 1;
  let a = s.throttle * P.thrust - P.drag * bankDrag * s.speed * s.speed - G * s.dir.y * (1 + 0.08 * load); // climbing costs speed, diving gains it
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
  // Amphibious gear retracts once airborne or on the water, and extends automatically on low land approaches.
  const gearTarget = !overSea && !s.onWater && (s.onSurface || s.pos.y - g < 22) ? 1 : 0;
  s.gear = (s.gear ?? 1) + (gearTarget - (s.gear ?? 1)) * (1 - Math.exp(-3 * dt));
  s.scooping = overSea && s.pos.y - SEA < P.scoopHeight && s.speed > P.scoopSpeed && !s.dumping;
  if (s.scooping) s.water = Math.min(P.tank, s.water + P.scoopRate * dt);
  s.poured = 0;
  if (s.dumping) {
    s.poured = Math.min(s.water, P.dropRate * dt);
    s.water -= s.poured;
    if (!s.onSurface && s.poured > 0) { s.dir.y = Math.min(0.45, s.dir.y + (s.poured / P.tank) * 0.06); s.dir.normalize(); } // shedding water balloons lift slightly
    if (s.water <= 0) s.dumping = false;
  }
  if (!s.onSurface || s.throttle > 0.1) s.fuel = Math.max(0, s.fuel - dt * P.burn * (0.5 + s.throttle * (1 + 0.15 * load)));
}

// F: open the doors (needs water aboard).
export function drop(s) {
  if (s.water < 0.1 || s.dumping) return false;
  s.dumping = true;
  return true;
}

// ---- Model: classic twin-prop amphibious scooper (CL-415 style). Stepped V-chine boat hull with an upswept tail,
// high straight wing on a central saddle, tapered turboprop nacelles with props ahead of the leading edge,
// cruciform tail with fin bullet & endplates, stepped wingtip pontoons, and triangulated amphibious gear.
// Wheels touch y = 0, nose to -z. ----
export function buildPlane({ body = 0xf2c230, trim = 0xd8352a } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5 });
  const b = bodyBaker(), group = new THREE.Group(), V = THREE.Vector2, WHITE = 0xf3efe6;

  // Fuselage: low forward flying-boat bow stepping sharply up at z = -6.0..-4.9 into a tall forward-facing
  // cockpit windshield (so the pilots have an unobstructed view over the nose), then sweeping up into the tail.
  const sweep = (z) => 0.09 * Math.max(0, z - 1) ** 1.35;
  const ycAt = (z) => (z <= -6.0 ? 1.6 + (z + 6.0) * 0.11 : z < -4.9 ? 1.6 + ((z + 6.0) / 1.1) * 0.55 : 2.15 + sweep(z));
  const fuselage = new THREE.LatheGeometry([
    [0, -8.2], [0.38, -7.9], [0.64, -7.1], [0.78, -6.0], [1.38, -4.9], [1.42, -3.9],
    [1.42, -3.0], [1.42, -2.0], [1.4, 1.0], [1.3, 3.0], [1.1, 5.0], [0.85, 7.0], [0.62, 9.0], [0.42, 10.6], [0, 11.2],
  ].map(([r, z]) => new V(r, z)), 12).rotateX(Math.PI / 2).scale(0.86, 1, 1).toNonIndexed();
  const fp = fuselage.attributes.position;
  for (let i = 0; i < fp.count; i++) fp.setY(i, fp.getY(i) + ycAt(fp.getZ(i)));
  b.add(fuselage, (x, y, z) => {
    const waterline = y - 2.15 - sweep(z), dy = y - ycAt(z), r = Math.hypot(x / 0.86, dy) || 1, c = dy / r;
    if (z < -7.85) return DARK;                                                       // nose radome cap
    if (waterline < -0.78) return trim;                                               // red flying-boat hull bottom
    if (waterline < -0.48) return WHITE;                                              // white waterline cheat stripe
    if (z > -6.0 && z < -4.9 && c > -0.1) return GLASS;                               // tall stepped forward windshield
    if (z >= -4.9 && z < -3.9 && c > 0.15 && c < 0.72) return GLASS;                  // cockpit side windows below yellow roof
    if (z > -3.0 && z < -2.0 && c > 0.15 && c < 0.55) return GLASS;                   // aft cabin observer windows
    return body;
  }, 0, 0, 0, 6);

  // Flying-boat forward chine spray rails & amphibious main-gear side sponsons.
  for (const s of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.22, 0.12, 4.2), trim, s * 1.08, 1.32, -2.5);        // hull chine spray rail
    b.add(new THREE.BoxGeometry(0.42, 0.78, 1.85), body, s * 1.12, 1.52, 0.55);       // main wheel-well sponson blister
  }

  // High wing set into a central pylon saddle on top of the fuselage: tapered halves with slight dihedral and red/white tips.
  b.add(new THREE.BoxGeometry(2.1, 0.62, 3.8), body, 0, 3.32, -0.85);                 // wing-root saddle fairing
  for (const side of [-1, 1]) {
    const pts = [[0, -1.75], [13, -1.05], [13, 0.82], [0, 1.65]].map(([x, z]) => new V(side * x, z));
    const wing = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.36, bevelEnabled: false }).rotateX(Math.PI / 2).rotateZ(side * -0.03);
    b.add(wing, (x) => (Math.abs(x) > 11.9 ? trim : Math.abs(x) > 11.1 ? WHITE : body), 0, 3.62, -0.8);
    for (const fx of [2.4, 6.8, 9.6]) b.add(new THREE.BoxGeometry(0.16, 0.22, 0.95), body, side * fx, 3.38, 0.55); // flap track fairings
  }

  // Twin turboprop nacelles (radiusBottom = 0.78 at front -z, tapering to radiusTop = 0.46 at rear +z) + V-braced wingtip pontoons.
  for (const x of [-4.2, 4.2]) {
    const s = Math.sign(x);
    b.add(new THREE.CylinderGeometry(0.46, 0.78, 4.9, 10).rotateX(Math.PI / 2), body, x, 3.55, -2.4);   // tapered engine nacelle
    b.add(new THREE.CylinderGeometry(0.78, 0.72, 0.34, 10).rotateX(Math.PI / 2), trim, x, 3.55, -4.92); // forward red cowl lip
    b.add(new THREE.CylinderGeometry(0.58, 0.58, 0.1, 10).rotateX(Math.PI / 2), DARK, x, 3.55, -5.06);  // dark intake face
    b.add(new THREE.BoxGeometry(0.42, 0.26, 1.35), trim, x, 4.22, -3.7);                                // upper oil-cooler air scoop
    for (const dx of [-0.68, 0.68]) b.add(new THREE.CylinderGeometry(0.11, 0.13, 0.36, 6).rotateZ(Math.PI / 2), DARK, x + dx, 3.48, -3.6); // exhaust stacks

    // Wingtip pontoon float with twin vertical struts and diagonal brace into the underside of the wing.
    const fx = s * 11.2;
    strut(b, 0.075, DARK, [fx, 3.32, -1.35], [fx, 1.22, -1.35]);                                        // front float strut
    strut(b, 0.075, DARK, [fx, 3.32, -0.25], [fx, 1.22, -0.25]);                                        // rear float strut
    strut(b, 0.06, DARK, [fx - s * 0.85, 3.35, -0.8], [fx, 1.35, -0.8]);                                // inboard diagonal brace
    const pontoon = new THREE.LatheGeometry([[0, -2.35], [0.34, -2.0], [0.46, -1.2], [0.44, 0.0], [0.26, 0.65], [0, 0.85]]
      .map(([r, z]) => new V(r, z)), 8).rotateX(Math.PI / 2).scale(0.82, 0.78, 1);
    b.add(pontoon, (px, py) => (py < 1.08 ? trim : body), fx, 1.12, 0, 6);                              // stepped wingtip pontoon
  }

  // Tall swept fin with dorsal fillet, flush red fin tip cap, cruciform tailplane with central bullet fairing & swept finlets.
  fin(b, [[0, 0], [2.6, 0.5], [2.6, 1.2], [0, 0.25]], body, 3.05, 5.8, 0.24);                           // dorsal fin fillet
  fin(b, [[0, 0], [3.1, 0.1], [4.1, 4.7], [2.4, 4.8]], body, 3.8, 8.0, 0.32);                           // vertical stabilizer
  fin(b, [[0, 0], [1.7, 0], [1.95, 0.68], [0.28, 0.75]], trim, 7.9, 10.15, 0.34);                       // flush red fin cap
  const bullet = new THREE.LatheGeometry([[0, -1.1], [0.22, -0.55], [0.24, 0.2], [0.16, 0.8], [0, 1.15]].map(([r, z]) => new V(r, z)), 8).rotateX(Math.PI / 2);
  b.add(bullet, (x, y, z) => (z < 9.75 ? trim : body), 0, 6.25, 10.4, 6);                               // streamlined tailplane bullet fairing
  b.add(new THREE.BoxGeometry(8.6, 0.18, 1.65), body, 0, 6.25, 10.45);                                  // horizontal tailplane
  for (const x of [-4.25, 4.25]) {
    const tip = new THREE.ExtrudeGeometry(new THREE.Shape([[0, -0.35], [1.2, -0.35], [1.55, 0.45], [0.4, 0.45]].map(([z, y]) => new V(z, y))), { depth: 0.12, bevelEnabled: false }).translate(0, 0, -0.06).rotateY(-Math.PI / 2);
    b.add(tip, trim, x, 6.25, 9.72);                                                                     // swept tailplane vertical finlets
  }

  // Belly water-drop doors and scoop probes.
  b.add(new THREE.BoxGeometry(1.55, 0.16, 2.1), DARK, 0, 0.84, -1.1);                                   // belly water-drop doors
  for (const dx of [-0.36, 0.36]) b.add(new THREE.BoxGeometry(0.14, 0.18, 0.45), DARK, dx, 0.78, 1.25); // water scoop probes
  group.add(new THREE.Mesh(b.geometry(), mat));

  // Retractable amphibious tricycle landing gear: main legs swing up flush against the fuselage sponsons; nose gear tucks into the bow.
  const mainGear = [-1, 1].map((s) => {
    const gb = bodyBaker();
    strut(gb, 0.1, DARK, [0, 0, 0], [s * 0.44, -1.07, 0]);                                              // main oleo shock strut
    strut(gb, 0.08, DARK, [-s * 0.24, -0.55, 0], [s * 0.44, -1.07, 0]);                                 // lower A-frame wishbone link
    strut(gb, 0.075, DARK, [-s * 0.04, -0.12, -0.75], [s * 0.38, -0.9, 0]);                             // forward drag brace
    gb.add(new THREE.CylinderGeometry(0.48, 0.48, 0.36, 10).rotateZ(Math.PI / 2), DARK, s * 0.44, -1.07, 0); // main wheel (bottom at y = 0)
    gb.add(new THREE.CylinderGeometry(0.22, 0.22, 0.38, 8).rotateZ(Math.PI / 2), WHITE, s * 0.44, -1.07, 0); // wheel hub
    const m = new THREE.Mesh(gb.geometry(), mat);
    m.position.set(s * 1.18, 1.55, 0.55);
    group.add(m);
    return { m, s };
  });
  const nb = bodyBaker();
  strut(nb, 0.095, DARK, [0, 0, 0], [0, -0.87, -0.15]);                                                 // nose gear shock strut
  strut(nb, 0.07, DARK, [0, 0.05, 0.55], [0, -0.57, -0.07]);                                            // nose gear drag brace
  for (const dx of [-0.18, 0.18]) {
    nb.add(new THREE.CylinderGeometry(0.38, 0.38, 0.16, 10).rotateZ(Math.PI / 2), DARK, dx, -0.87, -0.15); // twin nose wheels (bottom at y = 0)
  }
  const noseGear = new THREE.Mesh(nb.geometry(), mat);
  noseGear.position.set(0, 1.25, -5.65);
  group.add(noseGear);

  // Four-blade props with painted yellow tips and a blur disc that fades in with throttle.
  const props = [-4.2, 4.2].map((x) => {
    const pb = bodyBaker();
    pb.add(new THREE.ConeGeometry(0.38, 0.85, 8).rotateX(-Math.PI / 2), trim, 0, 0, -0.15);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      pb.add(new THREE.BoxGeometry(0.24, 1.75, 0.06).translate(0, 0.92, 0).rotateZ(a), DARK);
      pb.add(new THREE.BoxGeometry(0.24, 0.3, 0.065).translate(0, 1.92, 0).rotateZ(a), body);           // hi-vis prop tips
    }
    const p = new THREE.Mesh(pb.geometry(), mat);
    p.position.set(x, 3.55, -5.18);
    group.add(p);
    return p;
  });
  const discMat = new THREE.MeshBasicMaterial({ color: 0x1c1c22, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  for (const p of props) { const d = new THREE.Mesh(new THREE.CircleGeometry(2.1, 20), discMat); d.position.copy(p.position); group.add(d); }

  const lamp = (color, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  lamp(0xff3030, -13, 3.45, -0.3);
  lamp(0x30ff70, 13, 3.45, -0.3);
  const beacon = lamp(0xff2a2a, 0, 3.72, 0.8), strobe = lamp(0xffffff, 0, 8.68, 11.2);
  group.rotation.order = 'YXZ';
  let spinA = 0, rpm = 0.3;
  return { group, beacon, strobe, spin: (dt, power, s) => {
    rpm += (0.28 + 0.72 * power - rpm) * (1 - Math.exp(-3.5 * dt));
    spinA += dt * 28 * rpm;
    props.forEach((p, i) => (p.rotation.z = spinA + i * 0.4));
    discMat.opacity = Math.max(0, (rpm - 0.32) * 0.22);
    const up = 1 - (s?.gear ?? 1);
    for (const { m, s: side } of mainGear) {
      m.rotation.z = -side * up * 1.35; // swing inward into the fuselage belly/sponson well
      m.visible = up < 0.92;
    }
    noseGear.rotation.x = -up * 1.35;
    noseGear.visible = up < 0.92;
  } };
}
