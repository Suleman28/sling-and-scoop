import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Arcade tuning. Speeds in m/s, angles in rad.
export const TUNE = {
  maxPitch: 0.38, thrust: 2.0,      // tilt -> forward accel (top speed ~50 m/s)
  drag: 0.04, drag2: 0.0021,        // linear + quadratic forward drag
  brake: 0.5,                       // extra drag when stick is centred
  slip: 2.0,                        // sideways velocity damping
  grip: 0.8,                        // share of yaw that drags velocity round with it
  strafe: 14,                       // sideways cruise speed on Q/E
  windPush: 0.2,                    // wind m/s -> drift accel
  bounce: 0.4,                      // restitution off cliffs and trees
  yawRate: 1.5, climb: 14, descend: 12, ceiling: 420, bound: 1650,
  burn: 1 / 540,                    // fuel per airborne second at hover (full tank ~9 min hover, ~6 min busy flying)
  autorotate: 6,                    // sink rate with a dry tank
  loadClimb: 0.4,                   // climb lost per unit of slung load mass
  bank: 0.35,
  agility: 1.0,                     // attitude & collective response multiplier per airframe
};
const G = 9.81;

export function createFlight(x, y, z, yaw) {
  return { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), yaw, pitch: 0, roll: 0, yawVel: 0, grounded: true, hit: 0, fuel: 1, rotorTiltX: 0, rotorTiltZ: 0 };
}

// input: { fwd, turn, lift, strafe } each in [-1, 1].
// env: { groundAt(x, z), wind?: {x, z}, trees?(pos, vel) -> closing speed, loadMass? }. Sets s.hit to the step's worst impact speed.
export function stepFlight(s, input, dt, env) {
  const T = TUNE, load = env.loadMass || 0, strain = Math.max(0, load - 1) * T.loadClimb, ag = (T.agility || 1) / (1 + strain * 0.8);
  const k = (rate) => 1 - Math.exp(-rate * dt);
  const lift = s.fuel > 0 ? input.lift : 0;
  const air = !s.grounded || lift > 0, strafe = air ? input.strafe || 0 : 0;

  // Work in heading space so turns carve instead of skating.
  let fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  let vf = s.vel.x * fx + s.vel.z * fz, vr = s.vel.x * -fz + s.vel.z * fx;

  // Flare back when releasing the stick at speed, and pitch slightly with headwind/tailwind gusts.
  const w = air && env.wind ? env.wind : { x: 0, z: 0 };
  const wFwd = w.x * fx + w.z * fz, wRight = w.x * -fz + w.z * fx;
  const flare = air && input.fwd === 0 ? -Math.min(0.16, Math.max(-0.16, vf * 0.005)) : 0;
  const pitchCmd = air ? input.fwd * T.maxPitch : 0;
  s.pitch += (pitchCmd + flare - wFwd * 0.003 - s.pitch) * k(3.5 * ag);
  const speed = Math.hypot(s.vel.x, s.vel.z);
  // Tail fin weathercocks gently in crosswinds while airborne.
  const weathercock = air && speed > 2 ? -wRight * 0.006 : 0;
  s.yawVel += (input.turn * T.yawRate * (1 - 0.35 * Math.min(1, speed / 45)) + weathercock - s.yawVel) * k(5 * ag);
  s.yaw += s.yawVel * dt;
  fx = -Math.sin(s.yaw); fz = -Math.cos(s.yaw);
  if (!s.grounded) { // carve: swing velocity round with the nose
    const r = s.yawVel * dt * T.grip, c = Math.cos(r), sn = Math.sin(r), x = s.vel.x;
    s.vel.x = x * c + s.vel.z * sn;
    s.vel.z = -x * sn + s.vel.z * c;
    vf = s.vel.x * fx + s.vel.z * fz;
    vr = s.vel.x * -fz + s.vel.z * fx;
  }

  if (air) vf += Math.sin(pitchCmd || s.pitch) * G * (T.thrust / (1 + strain * 1.4)) * dt;
  vf -= vf * (T.drag + strain * 0.08 + T.drag2 * Math.abs(vf) + (input.fwd === 0 ? T.brake : 0)) * dt;
  vr += (strafe * (T.strafe / (1 + strain)) - vr) * k((strafe ? 1.5 : T.slip) * (0.7 + 0.3 * ag));
  s.vel.x = fx * vf - fz * vr;
  s.vel.z = fz * vf + fx * vr;
  if (air && env.wind) { s.vel.x += env.wind.x * T.windPush * dt; s.vel.z += env.wind.z * T.windPush * dt; }

  const { groundAt } = env, g = groundAt(s.pos.x, s.pos.z), alt = Math.max(0, s.pos.y - g);
  // In-ground-effect (IGE) cushion near the surface + effective translational lift (ETL) when climbing at forward speed.
  const ige = air && lift >= 0 && alt < 8 ? (1 - alt / 8) * 0.12 : 0;
  const etl = air && lift > 0 && speed > 10 ? Math.min(0.1, (speed - 10) / 250) : 0;

  if (air) s.fuel = Math.max(0, s.fuel - dt * T.burn * (1 + 0.5 * Math.max(0, lift) + (0.3 * speed) / 50 + 0.5 * load));
  let vyTarget = lift > 0 ? lift * T.climb * (1 + ige + etl - Math.min(0.78, T.loadClimb * load)) : lift * T.descend;
  if (s.fuel <= 0) vyTarget = -T.autorotate * (1 - ige * 1.5);
  if (s.pos.y > T.ceiling) vyTarget = Math.min(vyTarget, (T.ceiling - s.pos.y) * 0.5);
  s.vel.y += (vyTarget - s.vel.y) * k(2.5 * (0.75 + 0.25 * ag));

  // Soft world edge: push back toward the island.
  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > T.bound) { const a = (r - T.bound) * 0.5 * dt; s.vel.x -= (s.pos.x / r) * a; s.vel.z -= (s.pos.z / r) * a; }

  s.pos.addScaledVector(s.vel, dt);

  const gNew = groundAt(s.pos.x, s.pos.z), contact = s.pos.y <= gNew + 0.05;
  s.hit = 0;
  if (s.pos.y < gNew) {
    s.hit = Math.max(0, -s.vel.y);
    s.pos.y = gNew;
    if (s.vel.y < 0) s.vel.y = 0;
  }
  if (contact) {
    // Steep ground (cliff face) bounces you back; gentle ground is scraped over below.
    const gx = (groundAt(s.pos.x + 1, s.pos.z) - groundAt(s.pos.x - 1, s.pos.z)) / 2;
    const gz = (groundAt(s.pos.x, s.pos.z + 1) - groundAt(s.pos.x, s.pos.z - 1)) / 2;
    const steep = Math.hypot(gx, gz);
    if (steep > 0.75) s.hit = Math.max(s.hit, reflect(s.vel, -gx / steep, -gz / steep, T.bounce));
  }
  if (env.trees) s.hit = Math.max(s.hit, env.trees(s.pos, s.vel));

  // Fast contact is a scrape: hop off and bleed speed instead of snagging on the slope.
  const hs = Math.hypot(s.vel.x, s.vel.z);
  if (contact && hs > 6) {
    s.vel.y = Math.max(s.vel.y, 3 + hs * 0.1);
    const f = Math.exp(-1.5 * dt); s.vel.x *= f; s.vel.z *= f;
  }
  s.grounded = contact && hs <= 6;
  if (s.grounded && lift <= 0) { const f = Math.exp(-6 * dt); s.vel.x *= f; s.vel.z *= f; }

  const bankTarget = s.grounded ? 0 : s.yawVel * T.bank * Math.min(1, Math.abs(vf) / 18) - vr * 0.024 - strafe * 0.09 + wRight * 0.004;
  s.roll += (bankTarget - s.roll) * k(4.5 * ag);

  // Rotor disc leads cyclic input and flares opposite to velocity when braking.
  s.rotorTiltX = (s.rotorTiltX || 0) + ((air ? -input.fwd * 0.1 - flare * 0.35 : 0) - (s.rotorTiltX || 0)) * k(10);
  s.rotorTiltZ = (s.rotorTiltZ || 0) + ((air ? -strafe * 0.1 - input.turn * 0.045 : 0) - (s.rotorTiltZ || 0)) * k(10);
}

// Bounce horizontal velocity off a surface with unit horizontal normal (nx, nz). Returns closing speed.
export function reflect(vel, nx, nz, e) {
  const vin = vel.x * nx + vel.z * nz;
  if (vin >= 0) return 0;
  vel.x -= (1 + e) * vin * nx;
  vel.z -= (1 + e) * vin * nz;
  return -vin;
}

// Bake geometry parts into one flat-coloured buffer (one draw call per moving piece).
export function bodyBaker() {
  const parts = [], c = new THREE.Color();
  // color: hex, or fn(x, y, z) of each face's centre. per = 6 paints whole quads (triangle pairs) for clean edges.
  const add = (geo, color, x = 0, y = 0, z = 0, per = 3) => {
    const p = (geo.index ? geo.toNonIndexed() : geo).translate(x, y, z).attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i += per) {
      const m = (f) => { let t = 0; for (let j = 0; j < per; j++) t += f(i + j); return t / per; };
      c.set(typeof color === 'function' ? color(m((v) => p.getX(v)), m((v) => p.getY(v)), m((v) => p.getZ(v))) : color);
      for (let j = 0; j < per; j++) col.set([c.r, c.g, c.b], (i + j) * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', p);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  return { add, geometry: () => mergeGeometries(parts) };
}

const CREAM = 0xfff1d8, TEAL = 0x1d6a70, ORANGE = 0xf2763a;
export const DARK = 0x2a2a32, GLASS = 0x1f3346;
const V = THREE.Vector2;

// Lathe a hull along z (profile: [radius, z] from nose to tail), painted per quad by paint(x, y, z).
export const hull = (b, profile, paint, y, z = 0, width = 0.92) =>
  b.add(new THREE.LatheGeometry(profile.map(([r, zz]) => new V(r, zz)), 12).rotateX(Math.PI / 2).scale(width, 1, 1), paint, 0, y, z, 6);
// Flat swept fin in the y-z plane: pts are [back, up] from its root at (y, z); thick is its width.
export const fin = (b, pts, color, y, z, thick = 0.1) =>
  b.add(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, yy]) => new V(x, yy))), { depth: thick, bevelEnabled: false }).translate(0, 0, -thick / 2).rotateY(-Math.PI / 2), color, 0, y, z);
// Strut from a to b (any direction).
export const strut = (b, r, color, [ax, ay, az], [bx, by, bz]) => {
  const d = new THREE.Vector3(bx - ax, by - ay, bz - az), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, 5).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  b.add(g, color, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
};

// Each body bakes its static parts and says where the rotors and lights go. Local frame: ground contact at y = 0, nose to -z.
const BODIES = {
  // Medium utility: rounded cabin with sloped nose & windshield, turboshaft doghouse, slim boom, four blades.
  utility(b, body, trim) {
    // Fuselage lathe with a drooped nose apex so the windshield slopes cleanly up from the nose tip to the roof.
    const droop = (z) => (z < -0.4 ? -0.38 * (Math.max(0, -0.4 - z) / 2.15) ** 1.35 : 0);
    const prof = [[0, -2.55], [0.46, -2.42], [0.92, -2.0], [1.22, -1.2], [1.28, -0.92], [1.3, 0.35], [1.22, 0.6], [1.14, 1.35], [0.82, 2.0], [0.42, 2.55], [0, 2.65]];
    const cab = new THREE.LatheGeometry(prof.map(([r, z]) => new V(r, z)), 12).rotateX(Math.PI / 2).scale(0.92, 1, 1).toNonIndexed();
    const cp = cab.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setY(i, cp.getY(i) + 2.0 + droop(cp.getZ(i)));
    b.add(cab, (x, y, z) => {
      const dy = y - 2.0 - droop(z), r = Math.hypot(x / 0.92, dy) || 1, c = dy / r;
      if (c < -0.45) return trim;
      if (z < -1.2 && c > -0.05) return GLASS;
      if (z > -0.92 && z < 0.35 && c > -0.08 && c < 0.8) return GLASS;
      if (z > 0.6 && z < 1.35 && c > -0.08 && c < 0.8) return GLASS;
      return body;
    }, 0, 0, 0, 6);
    // Streamlined turboshaft doghouse cowling: intake fairing up front, main engine deck, twin exhausts, and tail-cone transition.
    b.add(new THREE.CylinderGeometry(0.56, 0.36, 0.85, 8).rotateX(Math.PI / 2).scale(1, 0.72, 1), body, 0, 3.04, -0.52); // forward intake fairing
    for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.24, 0.22, 0.14), DARK, s * 0.24, 3.06, -0.92);                // twin air intakes
    b.add(new THREE.CylinderGeometry(0.46, 0.56, 1.9, 8).rotateX(Math.PI / 2).scale(1, 0.75, 1), body, 0, 3.06, 0.85);   // main turbine cowling
    b.add(new THREE.CylinderGeometry(0.22, 0.38, 1.1, 8).rotateX(Math.PI / 2).scale(1, 0.7, 1), body, 0, 2.75, 2.15);    // rear doghouse fairing into boom
    for (const s of [-1, 1]) b.add(new THREE.CylinderGeometry(0.15, 0.18, 0.48, 6).rotateX(Math.PI / 2), DARK, s * 0.22, 3.16, 1.92); // twin exhausts
    b.add(new THREE.CylinderGeometry(0.32, 0.38, 0.2, 8), trim, 0, 3.42, 0.1);                                           // mast collar
    b.add(new THREE.CylinderGeometry(0.12, 0.15, 0.52, 6), DARK, 0, 3.68, 0.1);                                          // rotor mast
    b.add(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 8), trim, 0, 3.72, 0.1);                                           // swashplate

    // Tapered tail boom (radiusBottom = 0.44 at cabin, radiusTop = 0.2 at tail), stabiliser with endplates, swept fins, tail gearbox.
    b.add(new THREE.CylinderGeometry(0.2, 0.44, 5.2, 8).rotateX(Math.PI / 2), trim, 0, 2.46, 4.6);                       // tail boom
    b.add(new THREE.BoxGeometry(0.14, 0.08, 4.4), body, 0, 2.78, 4.35);                                                  // driveshaft spine cover
    fin(b, [[0, 0], [0.85, 0], [1.3, 1.32], [0.85, 1.38]], ORANGE, 2.48, 6.55, 0.12);                                    // swept dorsal fin
    fin(b, [[0, 0], [0.65, 0], [0.95, -0.62], [0.62, -0.66]], trim, 2.42, 6.58, 0.12);                                   // ventral fin
    strut(b, 0.035, ORANGE, [0, 1.78, 7.22], [0, 1.52, 7.45]);                                                           // tail rotor stinger
    b.add(new THREE.CylinderGeometry(0.12, 0.14, 0.32, 6).rotateZ(Math.PI / 2), DARK, 0.12, 3.3, 7.3);                   // tail rotor gearbox
    b.add(new THREE.BoxGeometry(2.1, 0.07, 0.5), trim, 0, 2.55, 5.95);                                                   // horizontal stabiliser
    for (const x of [-1.02, 1.02]) b.add(new THREE.BoxGeometry(0.06, 0.46, 0.44), ORANGE, x, 2.6, 6.0);                  // stabiliser endplates

    // Tubular landing skids rooted directly into the hull belly (ground contact at y = 0).
    for (const x of [-1.05, 1.05]) {
      b.add(new THREE.CylinderGeometry(0.07, 0.07, 3.85, 6).rotateX(Math.PI / 2), DARK, x, 0.07, 0.12);                  // main skid tube (bottom at y = 0)
      strut(b, 0.065, DARK, [x, 0.07, -1.78], [x, 0.32, -2.18]);                                                         // upturned front toe
      strut(b, 0.06, DARK, [x, 0.07, 2.02], [x, 0.18, 2.22]);                                                            // rear heel
      for (const z of [-0.88, 1.02]) strut(b, 0.06, DARK, [x, 0.07, z], [x * 0.62, 1.05, z]);                            // skid struts into hull
    }
    return { rotor: { y: 3.95, z: 0.1, blades: 4, length: 4.85, chord: 0.32 }, tail: { x: 0.24, y: 3.3, z: 7.3, size: 1.5 },
      lights: { port: [-1.08, 2.6, 6.0], star: [1.08, 2.6, 6.0], beacon: [0, 3.48, 1.15], strobe: [0, 3.88, 7.62] } };
  },

  // Light scout: glass bubble two-seater, exposed engine, open welded-tube truss boom, two blades with flybar.
  scout(b, body, trim) {
    // Clean glass bubble canopy as original, with a yellow lower tub and rear bulkhead.
    hull(b, [[0, -1.35], [0.55, -1.22], [0.88, -0.85], [1.0, -0.25], [0.96, 0.4], [0.74, 0.88], [0.38, 1.08], [0, 1.14]],
      (x, y, z) => (y > 1.05 && z < 0.65 ? GLASS : body), 1.45, 0, 0.95);

    // Exposed flat-six engine bay, cooling shroud, exhausts, transmission column and twin saddle fuel tanks.
    b.add(new THREE.BoxGeometry(0.68, 0.52, 0.92), DARK, 0, 1.14, 1.22);                                         // crankcase
    b.add(new THREE.BoxGeometry(1.12, 0.26, 0.68), 0x454752, 0, 1.14, 1.2);                                      // opposed cylinder heads
    b.add(new THREE.CylinderGeometry(0.28, 0.32, 0.22, 8).rotateX(Math.PI / 2), trim, 0, 1.2, 1.72);             // cooling fan shroud
    for (const s of [-1, 1]) {
      strut(b, 0.055, DARK, [s * 0.42, 0.98, 1.15], [s * 0.36, 0.72, 1.88]);                                     // twin exhaust pipes
      b.add(new THREE.CylinderGeometry(0.24, 0.24, 1.12, 8).rotateX(Math.PI / 2), body, s * 0.42, 1.98, 1.02);   // saddle fuel tanks
      b.add(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 8).rotateX(Math.PI / 2), trim, s * 0.42, 1.98, 0.72);    // front tank strap
      b.add(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 8).rotateX(Math.PI / 2), trim, s * 0.42, 1.98, 1.32);    // rear tank strap
      strut(b, 0.04, DARK, [s * 0.42, 1.76, 0.75], [s * 0.42, 0.92, 0.75]);                                      // forward engine-frame upright
      strut(b, 0.04, DARK, [s * 0.42, 1.76, 1.42], [s * 0.38, 0.92, 1.55]);                                      // rear engine-frame brace
      strut(b, 0.038, DARK, [s * 0.42, 0.92, 0.75], [s * 0.42, 1.76, 1.42]);                                     // engine bay diagonal
    }
    b.add(new THREE.CylinderGeometry(0.26, 0.34, 0.75, 8), DARK, 0, 2.05, 0.32);                                 // transmission housing
    b.add(new THREE.CylinderGeometry(0.34, 0.42, 0.22, 8), body, 0, 2.38, 0.32);                                 // mast roof collar
    b.add(new THREE.CylinderGeometry(0.09, 0.11, 0.78, 6), DARK, 0, 2.72, 0.32);                                 // rotor mast
    b.add(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 8), trim, 0, 2.78, 0.32);                                  // swashplate

    // Open welded-tube triangular truss tail boom (3 longerons + cross-bracing + tail rotor driveshaft).
    const nodes = [
      [1.45, 0.38, 1.92, 0.92],
      [2.35, 0.31, 1.88, 1.08],
      [3.25, 0.24, 1.84, 1.24],
      [4.15, 0.17, 1.80, 1.40],
      [5.00, 0.11, 1.76, 1.56],
      [5.75, 0.06, 1.72, 1.66],
    ];
    for (let i = 0; i < nodes.length - 1; i++) {
      const [z0, w0, ty0, by0] = nodes[i], [z1, w1, ty1, by1] = nodes[i + 1];
      strut(b, 0.052, body, [0, ty0, z0], [0, ty1, z1]);                                                         // top spine tube
      for (const s of [-1, 1]) {
        strut(b, 0.038, body, [s * w0, by0, z0], [s * w1, by1, z1]);                                             // bottom longerons
        strut(b, 0.03, body, [s * w0, by0, z0], [0, ty0, z0]);                                                   // vertical V-frame
        strut(b, 0.028, body, [s * w0, by0, z0], [0, ty1, z1]);                                                  // side diagonal lace
      }
      strut(b, 0.028, body, [-w0, by0, z0], [w0, by0, z0]);                                                      // bottom cross-rung
      strut(b, 0.024, body, [-w0, by0, z0], [w1, by1, z1]);                                                      // planform diagonal
    }
    strut(b, 0.026, DARK, [0, 2.02, 0.55], [0, 1.82, 5.85]);                                                     // exposed tail-rotor driveshaft

    // Tail gearbox, swept dorsal/ventral fins, horizontal stabiliser with endplates, and tail-rotor stinger.
    b.add(new THREE.BoxGeometry(0.22, 0.24, 0.42), DARK, 0, 1.74, 5.85);                                         // tail gearbox fairing
    fin(b, [[0, 0], [0.46, 0], [0.74, 0.86], [0.46, 0.9]], trim, 1.72, 5.65, 0.08);
    b.add(new THREE.BoxGeometry(0.09, 0.14, 0.3), ORANGE, 0, 2.56, 6.24);                                        // hi-vis fin tip cap
    fin(b, [[0, 0], [0.38, 0], [0.54, -0.48], [0.32, -0.5]], trim, 1.68, 5.68, 0.08);
    strut(b, 0.028, ORANGE, [0, 1.22, 6.08], [0, 1.02, 6.26]);                                                   // tail stinger skid
    b.add(new THREE.BoxGeometry(1.32, 0.06, 0.34), trim, 0, 1.7, 5.15);                                          // horizontal stabiliser
    for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.05, 0.28, 0.32), ORANGE, s * 0.66, 1.72, 5.16);       // stabiliser endplates

    // Tubular landing skids rooted into the bubble cabin and engine frame (ground contact at y = 0).
    for (const x of [-0.92, 0.92]) {
      b.add(new THREE.CylinderGeometry(0.065, 0.065, 3.05, 6).rotateX(Math.PI / 2), DARK, x, 0.065, -0.02);      // main skid tube (bottom at y = 0)
      strut(b, 0.06, DARK, [x, 0.065, -1.52], [x, 0.28, -1.88]);                                                 // upturned front toe
      strut(b, 0.055, DARK, [x, 0.065, 1.48], [x, 0.16, 1.66]);                                                  // upturned tail heel
      for (const z of [-0.58, 0.68]) strut(b, 0.052, DARK, [x, 0.065, z], [x * 0.48, 0.86, z]);                  // skid legs into hull
    }
    return { rotor: { y: 3.12, z: 0.32, blades: 2, length: 3.95, chord: 0.25 }, tail: { x: 0.15, y: 1.98, z: 6.02, size: 1.05 },
      lights: { port: [-0.7, 1.72, 5.16], star: [0.7, 1.72, 5.16], beacon: [0, 2.26, 1.02], strobe: [0, 2.66, 6.28] } };
  },

  // Heavy lifter: Sikorsky-style sky-crane. Forward cockpit + rear loadmaster booth, overhead crane spine with open cargo bay underneath,
  // twin turboshaft nacelles flanking the main gearbox, wide portal main landing gear + nose gear, five big blades.
  heavy(b, body, trim) {
    // Forward sky-crane cockpit cab whose roofline blends flush into the overhead spine (y = 4.4), with front windshield,
    // deep side windows, and a rear-facing crane-operator window looking back into the cargo bay under the spine.
    const droop = (z) => (z < -4.2 ? -0.45 * (Math.max(0, -4.2 - z) / 2.5) ** 1.25 : 0);
    const cabProf = [[0, -6.7], [0.52, -6.52], [0.98, -6.05], [1.24, -5.2], [1.28, -4.2], [1.25, -3.35], [0.92, -3.12], [0, -3.05]];
    const cab = new THREE.LatheGeometry(cabProf.map(([r, z]) => new V(r, z)), 12).rotateX(Math.PI / 2).scale(0.98, 0.92, 1).toNonIndexed();
    const cp = cab.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setY(i, cp.getY(i) + 3.28 + droop(cp.getZ(i)));
    b.add(cab, (x, y, z) => {
      const dy = y - 3.28 - droop(z), r = Math.hypot(x / 0.98, dy / 0.92) || 1, c = (dy / 0.92) / r;
      if (c < -0.42) return trim;
      if (z < -5.2 && c > -0.08) return GLASS;
      if (z > -5.0 && z < -3.35 && c > -0.25 && c < 0.75 && Math.abs(x) > 0.72) return GLASS;
      if (z >= -3.35 && c < 0.25 && c > -0.42) return GLASS; // rear-facing crane operator window
      return body;
    }, 0, 0, 0, 6);

    // Overhead structural crane spine starting cleanly inside the rear of the cab (z = -3.4 to 4.8):
    // wide upper box girder + narrower lower web + exterior truss ribs & red cheatline.
    b.add(new THREE.BoxGeometry(1.38, 0.78, 8.2), body, 0, 4.02, 0.7);                                            // upper spine girder (flush with cab top)
    b.add(new THREE.BoxGeometry(1.02, 0.42, 7.9), body, 0, 3.44, 0.65);                                           // lower spine web
    b.add(new THREE.BoxGeometry(1.42, 0.2, 8.22), trim, 0, 3.68, 0.7);                                            // bold red livery stripe
    for (const z of [-2.8, -1.4, 0.0, 1.4, 2.8, 4.2]) {
      b.add(new THREE.BoxGeometry(1.48, 0.82, 0.14), body, 0, 4.02, z);                                           // external structural frame ribs
      for (const s of [-1, 1]) strut(b, 0.055, body, [s * 0.48, 3.25, z], [s * 0.68, 3.68, z]);                   // lower web gussets
    }

    // Main rotor transmission deck & twin turboshaft engine nacelles with intakes, compressor cowls and upturned exhausts.
    b.add(new THREE.CylinderGeometry(0.55, 0.68, 2.8, 8).rotateX(Math.PI / 2).scale(1, 0.72, 1), DARK, 0, 4.62, 0.1); // central gearbox fairing
    for (const x of [-0.96, 0.96]) {
      b.add(new THREE.BoxGeometry(0.68, 0.48, 2.5), body, x * 0.6, 4.5, -0.35);                                   // engine deck mount fairing
      b.add(new THREE.CylinderGeometry(0.46, 0.54, 3.1, 8).rotateX(Math.PI / 2), trim, x, 4.82, -0.35);           // red turbine nacelle
      b.add(new THREE.CylinderGeometry(0.55, 0.52, 0.3, 8).rotateX(Math.PI / 2), body, x, 4.82, -1.82);           // intake cowl lip
      b.add(new THREE.CylinderGeometry(0.38, 0.38, 0.12, 8).rotateX(Math.PI / 2), DARK, x, 4.82, -1.94);          // dark compressor intake
      b.add(new THREE.CylinderGeometry(0.3, 0.42, 0.75, 8).rotateX(Math.PI / 2), DARK, x, 4.88, 1.48);            // rear exhaust nozzle
      strut(b, 0.06, DARK, [x, 4.42, -1.3], [x * 0.68, 4.05, -1.3]);                                              // nacelle support strut
    }
    b.add(new THREE.CylinderGeometry(0.38, 0.46, 0.24, 8), trim, 0, 4.98, 0.2);                                   // mast collar
    b.add(new THREE.CylinderGeometry(0.2, 0.24, 0.85, 6), DARK, 0, 5.18, 0.2);                                    // rotor mast
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 8), trim, 0, 5.25, 0.2);                                   // swashplate

    // Heavy-duty belly cargo winch & 4-point anti-sway frame tucked under the spine (matches RIG.anchor = 2.45).
    b.add(new THREE.BoxGeometry(0.84, 0.34, 1.5), DARK, 0, 3.08, 0.2);                                            // winch drum cradle
    b.add(new THREE.CylinderGeometry(0.24, 0.3, 0.28, 8), ORANGE, 0, 2.8, 0.2);                                   // hi-vis hook housing

    // Tapered tail boom continuing smoothly from the upper spine, swept dorsal/ventral fins, asymmetric sky-crane tailplane & gearbox.
    b.add(new THREE.CylinderGeometry(0.34, 0.64, 5.2, 8).rotateX(Math.PI / 2), body, 0, 4.0, 7.2);                // tail boom
    b.add(new THREE.BoxGeometry(0.2, 0.12, 4.8), trim, 0, 4.46, 7.0);                                             // tail driveshaft spine
    fin(b, [[0, 0], [1.3, 0], [1.9, 2.25], [1.15, 2.35]], ORANGE, 3.92, 9.2, 0.18);                               // tall swept dorsal pylon
    fin(b, [[0, 0], [0.9, 0], [1.25, -0.68], [0.78, -0.72]], trim, 3.82, 9.2, 0.16);                              // ventral tail fin
    strut(b, 0.045, ORANGE, [0, 3.12, 10.1], [0, 2.75, 10.45]);                                                   // tail bumper stinger
    b.add(new THREE.CylinderGeometry(0.16, 0.18, 0.4, 6).rotateZ(Math.PI / 2), DARK, 0.16, 5.6, 10.2);            // tail rotor gearbox
    b.add(new THREE.BoxGeometry(2.7, 0.1, 0.64), trim, 0, 4.05, 9.05);                                            // horizontal stabiliser
    for (const x of [-1.35, 1.35]) b.add(new THREE.BoxGeometry(0.08, 0.54, 0.56), ORANGE, x, 4.08, 9.08);         // stabiliser endplates

    // Tricycle sky-crane gantry landing gear: steerable twin-wheel nose gear under the cab + wide portal main gear sponsons
    // behind the cargo bay (z = 1.35), leaving the entire under-spine loading bay wide open for containers and vehicles.
    strut(b, 0.095, DARK, [0, 2.25, -5.0], [0, 0.34, -5.25]);                                                     // nose gear shock strut
    strut(b, 0.065, DARK, [0, 2.25, -4.35], [0, 0.85, -5.12]);                                                    // nose gear drag brace
    b.add(new THREE.CylinderGeometry(0.1, 0.1, 0.46, 6).rotateZ(Math.PI / 2), DARK, 0, 0.34, -5.25);              // nose axle
    for (const dx of [-0.18, 0.18]) {
      b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.14, 10).rotateZ(Math.PI / 2), DARK, dx, 0.34, -5.25);        // twin nose wheels (bottom at y = 0)
    }
    for (const x of [-1, 1]) {
      // Wide horizontal outrigger sponson beam + vertical oleo shock leg + forward drag brace forming an open cargo gantry.
      strut(b, 0.14, body, [x * 0.55, 3.45, 1.35], [x * 2.18, 2.25, 1.35]);                                       // upper sponson outrigger beam
      strut(b, 0.095, trim, [x * 0.48, 3.3, 1.35], [x * 1.65, 2.25, 1.35]);                                       // lower sponson brace
      strut(b, 0.11, DARK, [x * 0.58, 3.42, -0.45], [x * 2.12, 2.25, 1.35]);                                      // forward diagonal drag beam
      b.add(new THREE.CylinderGeometry(0.16, 0.16, 0.45, 8), body, x * 2.18, 2.22, 1.35);                         // sponson knee joint housing
      strut(b, 0.115, DARK, [x * 2.18, 2.22, 1.35], [x * 2.38, 0.42, 1.35]);                                      // vertical oleo shock leg
      b.add(new THREE.CylinderGeometry(0.15, 0.15, 0.75, 8), trim, x * 2.26, 1.5, 1.35);                          // hydraulic shock cylinder collar
      b.add(new THREE.CylinderGeometry(0.12, 0.12, 0.62, 6).rotateZ(Math.PI / 2), DARK, x * 2.38, 0.42, 1.35);    // main wheel axle
      for (const dx of [-0.22, 0.22]) {
        b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.18, 10).rotateZ(Math.PI / 2), DARK, x * 2.38 + dx, 0.42, 1.35); // dual main tires (bottom at y = 0)
      }
    }
    return { rotor: { y: 5.55, z: 0.2, blades: 5, length: 7.2, chord: 0.45 }, tail: { x: 0.34, y: 5.6, z: 10.2, size: 2.4 },
      lights: { port: [-1.4, 4.08, 9.08], star: [1.4, 4.08, 9.08], beacon: [0, 5.02, 1.25], strobe: [0, 6.22, 10.7] } };
  },
};

// kind: 'utility' | 'scout' | 'heavy'; body/trim: livery colours.
export function buildChopper({ kind = 'utility', body = CREAM, trim = TEAL, scale = 1 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55 });
  const b = bodyBaker(), spec = BODIES[kind](b, body, trim), group = new THREE.Group();
  group.add(new THREE.Mesh(b.geometry(), mat));

  const R = spec.rotor, rb = bodyBaker();
  rb.add(new THREE.CylinderGeometry(0.24, 0.28, 0.22, 8), DARK);
  rb.add(new THREE.CylinderGeometry(0.08, 0.22, 0.12, 8), trim, 0, 0.16, 0);                                      // hub cap
  if (R.blades === 2) {
    // Teetering stabilizer bar (flybar) perpendicular to the 2-blade main rotor.
    rb.add(new THREE.CylinderGeometry(0.022, 0.022, 1.6, 5).rotateX(Math.PI / 2), DARK, 0, -0.05, 0);
    for (const z of [-0.85, 0.85]) rb.add(new THREE.BoxGeometry(0.14, 0.03, 0.24), ORANGE, 0, -0.05, z);
  }
  for (let i = 0; i < R.blades; i++) {
    const a = (i * Math.PI * 2) / R.blades;
    rb.add(new THREE.BoxGeometry(0.28, 0.08, R.chord * 0.65).translate(0.32, 0, 0).rotateY(a), trim);             // blade grip cuff
    rb.add(new THREE.BoxGeometry(R.length - 0.4, 0.05, R.chord).translate((R.length - 0.4) / 2 + 0.25, 0, 0).rotateY(a), DARK);
    rb.add(new THREE.BoxGeometry(0.4, 0.06, R.chord + 0.01).translate(R.length + 0.05, 0, 0).rotateY(a), ORANGE); // tips
  }
  const rotor = new THREE.Mesh(rb.geometry(), mat);
  rotor.position.set(0, R.y, R.z);
  rotor.rotation.order = 'ZXY';

  const T = spec.tail, tb = bodyBaker();
  tb.add(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 6).rotateZ(Math.PI / 2), trim);                             // tail hub
  tb.add(new THREE.BoxGeometry(0.05, T.size, 0.15), DARK);
  tb.add(new THREE.BoxGeometry(0.05, 0.15, T.size), DARK);
  for (const d of [-1, 1]) {
    tb.add(new THREE.BoxGeometry(0.055, 0.14, 0.16), ORANGE, 0, d * (T.size * 0.44), 0);
    tb.add(new THREE.BoxGeometry(0.055, 0.16, 0.14), ORANGE, 0, 0, d * (T.size * 0.44));
  }
  const tail = new THREE.Mesh(tb.geometry(), mat);
  tail.position.set(T.x, T.y, T.z);

  const disc = new THREE.Mesh(new THREE.CircleGeometry(R.length + 0.6, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c1c22, transparent: true, opacity: 0.12, depthWrite: false }));
  disc.position.copy(rotor.position);
  disc.rotation.order = 'ZXY';

  // Nav lights (unlit so they glow at dusk): red port, green starboard, blinking beacon and tail strobe.
  const lamp = (color, [x, y, z]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  const L = spec.lights;
  lamp(0xff3030, L.port);
  lamp(0x30ff70, L.star);
  const beacon = lamp(0xff2a2a, L.beacon), strobe = lamp(0xffffff, L.strobe);

  group.add(rotor, tail, disc);
  group.scale.setScalar(scale);
  group.rotation.order = 'YXZ';
  // Deliberately slow apparent spin so the rotor reads instead of strobing; spools down slightly when parked at idle.
  let spinA = 0, rpm = 1;
  const spin = (dt, power, s) => {
    const targetRpm = s?.grounded && power <= 0 ? (s.fuel <= 0 ? 0.15 : 0.62) : 1 + 0.24 * power;
    rpm += (targetRpm - rpm) * (1 - Math.exp(-3 * dt));
    spinA += dt * 21 * rpm;
    const tx = s?.rotorTiltX || 0, tz = s?.rotorTiltZ || 0;
    rotor.rotation.set(tx, spinA, tz);
    disc.rotation.set(tx, 0, tz);
    tail.rotation.x = spinA * 1.7;
    disc.material.opacity = Math.max(0, (rpm - 0.35) * 0.14 + 0.05 * power);
  };
  return { group, rotor, tail, disc, beacon, strobe, spin };
}
