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
  windPush: 0.3,                    // wind m/s -> drift accel
  bounce: 0.4,                      // restitution off cliffs and trees
  yawRate: 1.5, climb: 14, descend: 12, ceiling: 420, bound: 1650,
  bank: 0.35,
};
const G = 9.81;

export function createFlight(x, y, z, yaw) {
  return { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), yaw, pitch: 0, roll: 0, yawVel: 0, grounded: true, hit: 0 };
}

// input: { fwd, turn, lift, strafe } each in [-1, 1].
// env: { groundAt(x, z), wind?: {x, z}, trees?(pos, vel) -> closing speed }. Sets s.hit to the step's worst impact speed.
export function stepFlight(s, input, dt, env) {
  const T = TUNE, k = (rate) => 1 - Math.exp(-rate * dt);
  const air = !s.grounded || input.lift > 0, strafe = air ? input.strafe || 0 : 0;

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

  let vyTarget = input.lift > 0 ? input.lift * T.climb : input.lift * T.descend;
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
  if (s.grounded && input.lift <= 0) { const f = Math.exp(-6 * dt); s.vel.x *= f; s.vel.z *= f; }

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
function baker() {
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

const CREAM = 0xfff1d8, TEAL = 0x1d6a70, ORANGE = 0xf2763a, DARK = 0x2a2a32, GLASS = 0x1f3346;

// Local frame: skids at y = 0, nose toward -z.
export function buildChopper() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55 });
  const b = baker(), V = THREE.Vector2;

  const hull = [[0, -2.55], [0.55, -2.4], [0.95, -2.0], [1.22, -1.3], [1.3, -0.4], [1.25, 0.5], [1.05, 1.4], [0.7, 2.1], [0.38, 2.55], [0, 2.6]];
  // Hull facets painted by position: teal belly, wraparound windscreen, side windows.
  const hullPaint = (x, y, z) => {
    if (y < 1.45) return TEAL;
    if (z < -1.0 && y > 1.75) return GLASS;
    if (z > -0.6 && z < 0.5 && y > 2.0 && y < 2.9 && Math.abs(x) > 0.7) return GLASS;
    return CREAM;
  };
  b.add(new THREE.LatheGeometry(hull.map(([r, z]) => new V(r, z)), 12).rotateX(Math.PI / 2).scale(0.92, 1, 1), hullPaint, 0, 2.0, 0, 6);
  b.add(new THREE.CylinderGeometry(0.45, 0.6, 2.0, 6).rotateX(Math.PI / 2).scale(1, 0.75, 1), CREAM, 0, 3.05, 0.6); // engine cowling
  b.add(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 6).rotateX(Math.PI / 2), DARK, 0, 3.2, 1.8);       // exhaust
  b.add(new THREE.CylinderGeometry(0.12, 0.15, 0.55, 6), DARK, 0, 3.65, 0.1);                          // mast
  b.add(new THREE.CylinderGeometry(0.2, 0.42, 5.0, 7).rotateX(Math.PI / 2), TEAL, 0, 2.45, 4.7);       // boom

  const fin = (pts, color, y) => b.add(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, yy]) => new V(x, yy))), { depth: 0.1, bevelEnabled: false }).translate(0, 0, -0.05).rotateY(-Math.PI / 2), color, 0, y, 6.6);
  fin([[0, 0], [0.8, 0], [1.25, 1.3], [0.85, 1.35]], ORANGE, 2.5);
  fin([[0, 0], [0.6, 0], [0.9, -0.6], [0.6, -0.65]], TEAL, 2.4);
  b.add(new THREE.BoxGeometry(2.0, 0.07, 0.5), TEAL, 0, 2.55, 6.1);                                    // stabiliser
  for (const x of [-1, 1]) b.add(new THREE.BoxGeometry(0.06, 0.45, 0.42), ORANGE, x, 2.6, 6.15);

  for (const x of [-1.05, 1.05]) {
    b.add(new THREE.CylinderGeometry(0.07, 0.07, 3.8, 5).rotateX(Math.PI / 2), DARK, x, 0.07, 0.15);    // skid
    b.add(new THREE.CylinderGeometry(0.07, 0.07, 0.55, 5).rotateX(-0.87), DARK, x, 0.25, -1.96);       // upturned tip
    for (const z of [-0.9, 1.1]) b.add(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5).rotateZ(Math.sign(x) * 0.35), DARK, x * 0.82, 0.55, z);
  }
  const group = new THREE.Group();
  group.add(new THREE.Mesh(b.geometry(), mat));

  const rb = baker();
  rb.add(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 8), DARK);
  for (let i = 0; i < 4; i++) {
    rb.add(new THREE.BoxGeometry(4.6, 0.05, 0.32).translate(2.55, 0, 0).rotateY((i * Math.PI) / 2), DARK);
    rb.add(new THREE.BoxGeometry(0.4, 0.06, 0.33).translate(5.05, 0, 0).rotateY((i * Math.PI) / 2), ORANGE); // tips
  }
  const rotor = new THREE.Mesh(rb.geometry(), mat);
  rotor.position.set(0, 3.95, 0.1);

  const tb = baker();
  tb.add(new THREE.BoxGeometry(0.05, 1.5, 0.16), DARK);
  tb.add(new THREE.BoxGeometry(0.05, 0.16, 1.5), DARK);
  const tail = new THREE.Mesh(tb.geometry(), mat);
  tail.position.set(0.2, 3.3, 7.3);

  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.45, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c1c22, transparent: true, opacity: 0.12, depthWrite: false }));
  disc.position.copy(rotor.position);

  // Nav lights (unlit so they glow at dusk): red port, green starboard, blinking beacon and tail strobe.
  const lamp = (color, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  lamp(0xff3030, -1.06, 2.6, 6.15);
  lamp(0x30ff70, 1.06, 2.6, 6.15);
  const beacon = lamp(0xff2a2a, 0, 3.5, 1.2), strobe = lamp(0xffffff, 0, 2.45, 7.2);

  group.add(rotor, tail, disc);
  group.rotation.order = 'YXZ';
  return { group, rotor, tail, disc, beacon, strobe };
}
