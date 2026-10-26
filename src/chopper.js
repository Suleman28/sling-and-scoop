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
};
const G = 9.81;

export function createFlight(x, y, z, yaw) {
  return { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), yaw, pitch: 0, roll: 0, yawVel: 0, grounded: true, hit: 0, fuel: 1 };
}

// input: { fwd, turn, lift, strafe } each in [-1, 1].
// env: { groundAt(x, z), wind?: {x, z}, trees?(pos, vel) -> closing speed, loadMass? }. Sets s.hit to the step's worst impact speed.
export function stepFlight(s, input, dt, env) {
  const T = TUNE, k = (rate) => 1 - Math.exp(-rate * dt), load = env.loadMass || 0;
  const lift = s.fuel > 0 ? input.lift : 0;
  const air = !s.grounded || lift > 0, strafe = air ? input.strafe || 0 : 0;

  s.pitch += ((air ? input.fwd * T.maxPitch : 0) - s.pitch) * k(3.5);
  const speed = Math.hypot(s.vel.x, s.vel.z);
  s.yawVel += (input.turn * T.yawRate * (1 - 0.35 * Math.min(1, speed / 45)) - s.yawVel) * k(5);
  s.yaw += s.yawVel * dt;
  if (!s.grounded) { // carve: swing velocity round with the nose
    const r = s.yawVel * dt * T.grip, c = Math.cos(r), sn = Math.sin(r), x = s.vel.x;
    s.vel.x = x * c + s.vel.z * sn;
    s.vel.z = -x * sn + s.vel.z * c;
  }

  // Work in heading space so turns carve instead of skating.
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  let vf = s.vel.x * fx + s.vel.z * fz, vr = s.vel.x * -fz + s.vel.z * fx;
  if (air) vf += Math.sin(s.pitch) * G * T.thrust * dt;
  vf -= vf * (T.drag + T.drag2 * Math.abs(vf) + (input.fwd === 0 ? T.brake : 0)) * dt;
  vr += (strafe * T.strafe - vr) * k(strafe ? 1.5 : T.slip);
  s.vel.x = fx * vf - fz * vr;
  s.vel.z = fz * vf + fx * vr;
  if (air && env.wind) { s.vel.x += env.wind.x * T.windPush * dt; s.vel.z += env.wind.z * T.windPush * dt; }

  if (air) s.fuel = Math.max(0, s.fuel - dt * T.burn * (1 + 0.5 * Math.max(0, lift) + (0.3 * speed) / 50 + 0.5 * load));
  let vyTarget = lift > 0 ? lift * T.climb * (1 - T.loadClimb * Math.min(1, load)) : lift * T.descend;
  if (s.fuel <= 0) vyTarget = -T.autorotate;
  if (s.pos.y > T.ceiling) vyTarget = Math.min(vyTarget, (T.ceiling - s.pos.y) * 0.5);
  s.vel.y += (vyTarget - s.vel.y) * k(2.5);

  // Soft world edge: push back toward the island.
  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > T.bound) { const a = (r - T.bound) * 0.5 * dt; s.vel.x -= (s.pos.x / r) * a; s.vel.z -= (s.pos.z / r) * a; }

  s.pos.addScaledVector(s.vel, dt);

  const { groundAt } = env, g = groundAt(s.pos.x, s.pos.z), contact = s.pos.y <= g + 0.05;
  s.hit = 0;
  if (s.pos.y < g) {
    s.hit = Math.max(0, -s.vel.y);
    s.pos.y = g;
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

  const bankTarget = s.grounded ? 0 : s.yawVel * T.bank * Math.min(1, Math.abs(vf) / 20) - vr * 0.02;
  s.roll += (bankTarget - s.roll) * k(4);
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
  // Medium utility: rounded cabin, slim boom, four blades.
  utility(b, body, trim) {
    hull(b, [[0, -2.55], [0.55, -2.4], [0.95, -2.0], [1.22, -1.3], [1.3, -0.4], [1.25, 0.5], [1.05, 1.4], [0.7, 2.1], [0.38, 2.55], [0, 2.6]], (x, y, z) => {
      if (y < 1.45) return trim;
      if (z < -1.0 && y > 1.75) return GLASS;
      if (z > -0.6 && z < 0.5 && y > 2.0 && y < 2.9 && Math.abs(x) > 0.7) return GLASS;
      return body;
    }, 2.0);
    b.add(new THREE.CylinderGeometry(0.45, 0.6, 2.0, 6).rotateX(Math.PI / 2).scale(1, 0.75, 1), body, 0, 3.05, 0.6); // engine cowling
    b.add(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 6).rotateX(Math.PI / 2), DARK, 0, 3.2, 1.8);               // exhaust
    b.add(new THREE.CylinderGeometry(0.12, 0.15, 0.55, 6), DARK, 0, 3.65, 0.1);                                  // mast
    b.add(new THREE.CylinderGeometry(0.2, 0.42, 5.0, 7).rotateX(Math.PI / 2), trim, 0, 2.45, 4.7);               // boom
    fin(b, [[0, 0], [0.8, 0], [1.25, 1.3], [0.85, 1.35]], ORANGE, 2.5, 6.6);
    fin(b, [[0, 0], [0.6, 0], [0.9, -0.6], [0.6, -0.65]], trim, 2.4, 6.6);
    b.add(new THREE.BoxGeometry(2.0, 0.07, 0.5), trim, 0, 2.55, 6.1);                                            // stabiliser
    for (const x of [-1, 1]) b.add(new THREE.BoxGeometry(0.06, 0.45, 0.42), ORANGE, x, 2.6, 6.15);
    for (const x of [-1.05, 1.05]) {
      b.add(new THREE.CylinderGeometry(0.07, 0.07, 3.8, 5).rotateX(Math.PI / 2), DARK, x, 0.07, 0.15);            // skid
      b.add(new THREE.CylinderGeometry(0.07, 0.07, 0.55, 5).rotateX(-0.87), DARK, x, 0.25, -1.96);               // upturned tip
      for (const z of [-0.9, 1.1]) strut(b, 0.06, DARK, [x, 0.07, z], [x * 0.65, 1.0, z]);
    }
    return { rotor: { y: 3.95, z: 0.1, blades: 4, length: 4.85, chord: 0.32 }, tail: { x: 0.2, y: 3.3, z: 7.3, size: 1.5 },
      lights: { port: [-1.06, 2.6, 6.15], star: [1.06, 2.6, 6.15], beacon: [0, 3.5, 1.2], strobe: [0, 2.45, 7.2] } };
  },

  // Light scout: glass bubble two-seater, exposed engine, open tube boom, two blades.
  scout(b, body, trim) {
    hull(b, [[0, -1.25], [0.55, -1.15], [0.88, -0.8], [1.0, -0.2], [0.95, 0.45], [0.7, 0.9], [0.35, 1.1], [0, 1.15]],
      (x, y, z) => (y > 1.05 && z < 0.75 ? GLASS : body), 1.45, 0, 0.95);
    b.add(new THREE.BoxGeometry(0.75, 0.6, 1.0), DARK, 0, 1.2, 1.4);                                             // engine
    b.add(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 8).rotateZ(Math.PI / 2), body, 0, 2.2, 0.9);               // fuel tank
    b.add(new THREE.CylinderGeometry(0.09, 0.11, 0.9, 6), DARK, 0, 2.6, 0.3);                                    // mast
    b.add(new THREE.CylinderGeometry(0.06, 0.12, 5.2, 6).rotateX(Math.PI / 2), body, 0, 1.55, 3.4);             // tube boom, rooted in the engine bay
    strut(b, 0.04, DARK, [0, 1.1, 1.8], [0, 1.55, 4.4]);                                                         // boom brace
    fin(b, [[0, 0], [0.45, 0], [0.7, 0.8], [0.45, 0.85]], trim, 1.6, 5.75);
    fin(b, [[0, 0], [0.35, 0], [0.5, -0.5], [0.3, -0.5]], trim, 1.6, 5.75);
    b.add(new THREE.BoxGeometry(1.1, 0.05, 0.3), trim, 0, 1.62, 5.6);
    for (const x of [-0.95, 0.95]) {
      b.add(new THREE.CylinderGeometry(0.06, 0.06, 3.0, 5).rotateX(Math.PI / 2), DARK, x, 0.06, -0.05);
      b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 5).rotateX(-0.87), DARK, x, 0.2, -1.7);
      for (const z of [-0.6, 0.7]) strut(b, 0.05, DARK, [x, 0.06, z], [x * 0.55, 0.7, z]);
    }
    return { rotor: { y: 3.05, z: 0.3, blades: 2, length: 3.9, chord: 0.24 }, tail: { x: 0.14, y: 1.95, z: 6.05, size: 1.0 },
      lights: { port: [-0.56, 1.62, 5.6], star: [0.56, 1.62, 5.6], beacon: [0, 2.55, 0.9], strobe: [0, 1.65, 6.15] } };
  },

  // Heavy lifter: sky-crane. Cab up front, open spine over the load, twin engines, tall wheeled legs, five big blades.
  heavy(b, body, trim) {
    hull(b, [[0, -1.6], [0.6, -1.5], [1.05, -1.1], [1.25, -0.3], [1.25, 0.6], [1.1, 1.3], [0, 1.4]], (x, y, z) => {
      if (y < 2.55) return trim;
      if (z < -5.3 && y > 3.0) return GLASS;
      if (z > -5.3 && z < -4.4 && y > 3.35 && Math.abs(x) > 0.75) return GLASS;
      return body;
    }, 3.3, -5.0, 0.95);
    b.add(new THREE.BoxGeometry(1.3, 1.3, 9.5), body, 0, 3.75, 0.2);                                             // spine
    b.add(new THREE.BoxGeometry(1.34, 0.25, 9.5), trim, 0, 3.35, 0.2);                                           // stripe
    for (const x of [-0.95, 0.95]) {
      b.add(new THREE.CylinderGeometry(0.55, 0.5, 3.0, 8).rotateX(Math.PI / 2), trim, x, 4.75, -0.6);           // engine pods
      b.add(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8).rotateX(Math.PI / 2), DARK, x, 4.75, -2.12);            // intakes
    }
    b.add(new THREE.CylinderGeometry(0.2, 0.25, 1.0, 6), DARK, 0, 5.0, 0.2);                                     // mast
    b.add(new THREE.CylinderGeometry(0.35, 0.6, 5.4, 8).rotateX(Math.PI / 2), body, 0, 3.95, 7.5);              // tail boom
    fin(b, [[0, 0], [1.2, 0], [1.8, 2.2], [1.1, 2.3]], ORANGE, 3.9, 9.4);
    b.add(new THREE.BoxGeometry(2.6, 0.08, 0.6), trim, 0, 4.0, 9.2);
    b.add(new THREE.BoxGeometry(0.5, 0.4, 0.5), DARK, 0, 2.95, 0.3);                                             // cargo hook housing
    for (const x of [-1, 1]) for (const z of [-2.6, 3.0]) {
      strut(b, 0.11, DARK, [x * 0.6, 3.15, z], [x * 2.3, 0.35, z]);                                             // legs
      b.add(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 8).rotateZ(Math.PI / 2), DARK, x * 2.3, 0.35, z);        // wheels
    }
    return { rotor: { y: 5.55, z: 0.2, blades: 5, length: 7.2, chord: 0.45 }, tail: { x: 0.3, y: 5.6, z: 10.2, size: 2.4 },
      lights: { port: [-1.3, 4.05, 9.2], star: [1.3, 4.05, 9.2], beacon: [0, 5.25, 1.8], strobe: [0, 4.2, 10.4] } };
  },
};

// kind: 'utility' | 'scout' | 'heavy'; body/trim: livery colours.
export function buildChopper({ kind = 'utility', body = CREAM, trim = TEAL, scale = 1 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55 });
  const b = bodyBaker(), spec = BODIES[kind](b, body, trim), group = new THREE.Group();
  group.add(new THREE.Mesh(b.geometry(), mat));

  const R = spec.rotor, rb = bodyBaker();
  rb.add(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 8), DARK);
  for (let i = 0; i < R.blades; i++) {
    const a = (i * Math.PI * 2) / R.blades;
    rb.add(new THREE.BoxGeometry(R.length - 0.4, 0.05, R.chord).translate((R.length - 0.4) / 2 + 0.25, 0, 0).rotateY(a), DARK);
    rb.add(new THREE.BoxGeometry(0.4, 0.06, R.chord + 0.01).translate(R.length + 0.05, 0, 0).rotateY(a), ORANGE); // tips
  }
  const rotor = new THREE.Mesh(rb.geometry(), mat);
  rotor.position.set(0, R.y, R.z);

  const T = spec.tail, tb = bodyBaker();
  tb.add(new THREE.BoxGeometry(0.05, T.size, 0.16), DARK);
  tb.add(new THREE.BoxGeometry(0.05, 0.16, T.size), DARK);
  const tail = new THREE.Mesh(tb.geometry(), mat);
  tail.position.set(T.x, T.y, T.z);

  const disc = new THREE.Mesh(new THREE.CircleGeometry(R.length + 0.6, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c1c22, transparent: true, opacity: 0.12, depthWrite: false }));
  disc.position.copy(rotor.position);

  // Nav lights (unlit so they glow at dusk): red port, green starboard, blinking beacon and tail strobe.
  const lamp = (color, [x, y, z]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  const L = spec.lights;
  lamp(0xff3030, L.port);
  lamp(0x30ff70, L.star);
  const beacon = lamp(0xff2a2a, L.beacon), strobe = lamp(0xffffff, L.strobe);

  group.add(rotor, tail, disc);
  group.scale.setScalar(scale);
  group.rotation.order = 'YXZ';
  // Deliberately slow apparent spin so the rotor reads instead of strobing; power 0..1.
  let spinA = 0;
  const spin = (dt, power) => { spinA += dt * (21 + 5 * power); rotor.rotation.y = spinA; tail.rotation.x = spinA * 1.7; disc.material.opacity = 0.1 + 0.05 * power; };
  return { group, rotor, tail, disc, beacon, strobe, spin };
}
