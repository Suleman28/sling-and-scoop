import * as THREE from 'three';
import { bodyBaker, DARK, GLASS, strut } from './chopper.js';

const SEA = 0, swell = (t, x, z) => 0.14 * Math.sin(t * 1.3 + x * 0.07 + z * 0.05); // surface height: same formula as every other floating thing
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Fire & rescue cutter, an arcade semi-planing hull with twin transom waterjets and bow/stern side thrusters.
// W/S is the throttle lever (S = astern), A/D the wheel, Q/E the side thrusters; she can pivot in her own length at rest.
// She squats through a hump at mid speed (bow up), then settles.
export const BOAT = {
  thrust: 5.5, drag: 0.1, drag2: 0.0118, // top speed ~17 m/s (~33 kn): thrust = drag*u + drag2*u^2
  astern: 0.65, asternDrag: 1.5,         // waterjet reversing buckets give strong astern thrust and braking
  spool: 1.8,                            // throttle lever follow rate (1/s)
  hump: 1.0, humpAt: 8, humpW: 3,        // extra drag and bow-up peak around this speed (m/s)
  turn: 0.85, turnWay: 5, turnEase: 0.25, turnIdle: 0.45, // max yaw rate (rad/s), speed for full steer, loss flat out, thruster pivot at rest
  turnLag: 3.5, bank: 0.016,             // yaw-rate response; roll per (speed x yaw rate), banks into turns
  thruster: 4.5,                         // Q/E bow & stern side-thruster sway speed (m/s)
  skid: 1.8, scrub: 0.25,                // sideways velocity decay (1/s); forward speed lost to skidding
  wind: 0.08,                            // wind push (m/s² per m/s of wind): a gentle drift
  burn: 1 / 600, idleBurn: 0.05,         // full tank = 10 min at full power; fraction burned at idle
  shallow: -1.1, bound: 1650,            // seabed above this = aground (waterjets draw ~1 m, no hanging props); soft world edge radius
  monitors: [[0, 2.2, -7.4], [0, 5.93, -3.3]], jet: [26, 19], jetFlow: 1, // fire monitor pedestals (model space; the nozzle is ~1.45 m up, 1.1 m out) and full-pressure jet speed [out, up]: lands ~95 m away (s.jetK scales it down)
};

export function createBoat(x, z, yaw, moored = false) {
  return { pos: new THREE.Vector3(x, swell(0, x, z), z), vel: new THREE.Vector3(), yaw, pitch: 0, roll: 0, throttle: 0, speed: 0,
    fuel: 1, grounded: true, hit: 0, t: 0, lat: 0, yawRate: 0, planing: 0, aim: 0, steer: 0, sway: 0, moored, anchored: false, castOffT: 0 }; // aim: where the monitors and searchlight point, yaw off the bow
}

const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

// input: { fwd, turn, lift, strafe } in [-1, 1]. env: { heightAt, wind?, waveAt?(x, z): the big swell to ride }. s.pitch > 0 = bow down, s.roll > 0 = starboard up.
export function stepBoat(s, input, dt, env) {
  const B = BOAT; dt = clamp(dt, 0, 0.1); s.t += dt;
  s.castOffT = Math.max(0, (s.castOffT || 0) - dt);
  const rawFwd = clamp(input.fwd || 0, -1, 1), rawTurn = clamp(input.turn || 0, -1, 1), rawStrafe = s.fuel > 0 ? clamp(input.strafe || 0, -1, 1) : 0;
  if (s.moored && (Math.abs(rawFwd) > 0.05 || Math.abs(rawTurn) > 0.05 || Math.abs(rawStrafe) > 0.05)) { s.moored = false; s.castOffT = 3.0; }
  if (env.atDock?.() && !s.moored && !s.anchored && s.castOffT <= 0 && Math.abs(rawFwd) < 0.05 && Math.abs(rawTurn) < 0.05 && Math.abs(rawStrafe) < 0.05 && Math.hypot(s.vel.x, s.vel.z) < 0.8) {
    s.moored = true; s.vel.set(0, 0, 0); s.yawRate = 0;
  }
  const held = s.moored || s.anchored;
  const fwd = s.anchored ? 0 : rawFwd, turn = s.anchored ? 0 : rawTurn, strafe = s.anchored ? 0 : rawStrafe;
  s.steer = turn; s.sway = strafe;
  s.throttle += (s.fuel > 0 ? (fwd >= 0 ? fwd : fwd * B.astern) - s.throttle : -s.throttle) * (1 - Math.exp(-B.spool * dt));

  // Steering: waterjet nozzles + bow/stern thrusters pivot her on the spot at low speed, reverse going astern, ease off flat out.
  let fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), u = s.vel.x * fx + s.vel.z * fz;
  const au = Math.abs(u), way = Math.min(1, au / B.turnWay) * (1 - B.turnEase * smooth(11, 17, au));
  const rate = s.fuel > 0 ? Math.max(B.turnIdle * (1 - smooth(0, B.turnWay, au)), way) : way;
  s.yawRate += (turn * B.turn * rate * (u < -0.5 ? -1 : 1) - s.yawRate) * (1 - Math.exp(-B.turnLag * dt));
  if (held) s.yawRate *= Math.exp(-5 * dt);
  s.yaw += s.yawRate * dt;
  fx = -Math.sin(s.yaw); fz = -Math.cos(s.yaw);
  const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);

  // Surge & sway: waterjets push against drag (with a hump); Q/E side thrusters crab her sideways, tapering as she gets up on the plane.
  if (env.wind && !held) { s.vel.x += env.wind.x * B.wind * dt; s.vel.z += env.wind.z * B.wind * dt; }
  if (held) s.vel.multiplyScalar(Math.exp(-5 * dt));
  u = s.vel.x * fx + s.vel.z * fz;
  let v = s.vel.x * rx + s.vel.z * rz;
  const sg = Math.sign(u), hump = u > 0 ? B.hump * Math.exp(-(((u - B.humpAt) / B.humpW) ** 2)) : 0;
  const thrust = s.throttle * B.thrust, drag = (B.drag * Math.abs(u) + B.drag2 * u * u + hump) * (u < 0 ? B.asternDrag : 1);
  const scrub = strafe ? Math.max(0, Math.abs(v) - Math.abs(strafe) * B.thruster) : Math.abs(v); // intentional side-thruster sway doesn't scrub forward way
  const stepDrag = (drag + B.scrub * scrub) * dt;
  const un = (Math.abs(u) > stepDrag ? u - sg * stepDrag : 0) + thrust * dt;
  const vTarget = strafe * B.thruster * (1 - 0.65 * smooth(4, 13, au));
  v += (vTarget - v) * (1 - Math.exp(-(strafe ? 2.8 : B.skid) * dt));
  s.vel.set(fx * un + rx * v, 0, fz * un + rz * v);

  // Soft edge: swing the bow and push back toward the island.
  const d = Math.hypot(s.pos.x, s.pos.z);
  if (d > B.bound) {
    const a = Math.atan2(s.pos.x, s.pos.z) - s.yaw;
    s.yaw += Math.sign(Math.sin(a)) * 0.8 * dt;
    const k = 3 * Math.min(1, (d - B.bound) / 50) * dt;
    s.vel.x -= (s.pos.x / d) * k; s.vel.z -= (s.pos.z / d) * k;
  }

  // Move; shallows and walls stop it and slide it along the tangent. It may still move toward deeper water (backing off, or spawned in the shallows).
  const nx = s.pos.x + s.vel.x * dt, nz = s.pos.z + s.vel.z * dt, h0 = env.heightAt(s.pos.x, s.pos.z), h1 = env.heightAt(nx, nz);
  s.hit = 0;
  if (h1 > B.shallow && h1 > h0) {
    let gx = env.heightAt(s.pos.x + 2, s.pos.z) - env.heightAt(s.pos.x - 2, s.pos.z), gz = env.heightAt(s.pos.x, s.pos.z + 2) - env.heightAt(s.pos.x, s.pos.z - 2);
    let gl = Math.hypot(gx, gz);
    if (h1 >= 0.9 || gl < 1e-6) { // step-function wall (jetty, breakwater, freighter) or flat shelf: sample across the step
      const sx = (env.heightAt(nx, s.pos.z) - h0) * Math.sign(nx - s.pos.x), sz = (env.heightAt(s.pos.x, nz) - h0) * Math.sign(nz - s.pos.z);
      gx = sx || env.heightAt(nx + 2, nz) - env.heightAt(nx - 2, nz); gz = sz || env.heightAt(nx, nz + 2) - env.heightAt(nx, nz - 2);
      gl = Math.hypot(gx, gz);
    }
    if (gl < 1e-6) { gx = s.vel.x; gz = s.vel.z; gl = Math.hypot(gx, gz) || 1; } // flat: treat the shore as square-on
    const nxo = -gx / gl, nzo = -gz / gl, close = -(s.vel.x * nxo + s.vel.z * nzo); // outward (seaward) normal; closing speed into the shore
    if (close > 0) {
      s.hit = close;
      const bounce = close > 1 ? 1.15 : 1, damp = close > 1 ? 0.85 : Math.exp(-0.6 * dt); // hard hits bounce; scraping along a shore or wall slides and turns clear
      s.vel.x = (s.vel.x + nxo * close * bounce) * damp;
      s.vel.z = (s.vel.z + nzo * close * bounce) * damp;
      if (fwd > 0 || strafe) s.yaw -= (fx * nzo - fz * nxo) * 1.4 * dt; // deflect bow along the shore/wall when under power
    }
    const sx = s.pos.x + s.vel.x * dt, sz = s.pos.z + s.vel.z * dt;
    if (env.heightAt(sx, sz) <= B.shallow || env.heightAt(sx, sz) <= h0) s.pos.set(sx, 0, sz); // slide along the wall or shore
    else { s.pos.x += nxo * 0.25; s.pos.z += nzo * 0.25; } // nudge off the contour so wind or diagonal steps can never pin the hull
    s.yawRate *= close > 1 ? 0.5 : Math.exp(-3 * dt);
  } else s.pos.set(nx, 0, nz);

  // Attitude: bow rises over the hump then trims level on the plane; banks into turns; rides the swell and slams lightly at speed.
  u = s.vel.x * fx + s.vel.z * fz;
  s.speed = Number.isFinite(u) ? u : 0;
  s.lat = s.vel.x * rx + s.vel.z * rz;
  s.planing = smooth(8, 14, s.speed);
  const ph = 1.3 * s.t + 0.07 * s.pos.x + 0.05 * s.pos.z, c = 0.14 * Math.cos(ph) * 3; // a long hull only nods to the chop
  const pitchT = -0.07 * (s.speed > 0 ? Math.exp(-(((s.speed - B.humpAt - 1) / 4.5) ** 2)) : 0) - 0.025 * s.planing + (s.speed < -1 ? 0.03 : 0)
    - c * (0.07 * fx + 0.05 * fz) + 0.025 * s.planing * Math.sin(s.t * 6.5 + s.pos.z * 0.2);
  // She also lies to the big swell: bow and stern, port and starboard sit on the water under them.
  const W = env.waveAt, px = s.pos.x, pz = s.pos.z;
  const swP = W ? Math.atan((W(px - fx * 7, pz - fz * 7) - W(px + fx * 7, pz + fz * 7)) / 14) : 0, swR = W ? Math.atan((W(px + rx * 2.6, pz + rz * 2.6) - W(px - rx * 2.6, pz - rz * 2.6)) / 5.2) : 0;
  const rollT = clamp(B.bank * s.speed * s.yawRate, -0.4, 0.4) + c * (0.07 * rx + 0.05 * rz) + swR;
  const k = 1 - Math.exp(-5 * dt);
  s.pitch += (pitchT + swP - s.pitch) * k;
  s.roll += (rollT - s.roll) * k;
  s.pos.y = SEA + (env.waveAt ? env.waveAt(s.pos.x, s.pos.z) : 0) + swell(s.t, s.pos.x, s.pos.z) + 0.05 * s.planing * Math.sin(s.t * 7.1 + s.pos.x * 0.3);
  s.grounded = Math.abs(s.speed) < 1.5;

  if (s.throttle * s.throttle > 1e-6 || s.fuel > 0) s.fuel = Math.max(0, s.fuel - dt * B.burn * (B.idleBurn + (1 - B.idleBurn) * Math.abs(s.throttle)));
  if (![s.vel.x, s.vel.z, s.pitch, s.roll, s.yawRate, s.throttle].every(Number.isFinite)) { s.vel.set(0, 0, 0); s.yawRate = s.pitch = s.roll = s.throttle = s.speed = s.lat = 0; } // never let a NaN stick
}

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

// ---- Model: a 21 m fire & rescue cutter, built fine rather than chunky (the one high-detail craft in the game).
// Faired hull (sections every half metre: deep forefoot, flared bow, bulwarks forward, open working deck aft) with boot
// top, rubbing strake, spray rail, twin transom waterjets (intake tunnels, pump housings, steerable nozzles and reversing
// buckets); a deckhouse and forward-raked wheelhouse glazed pane by pane; lattice mast with a turning radar; funnel; two
// fire monitors and a searchlight that train with s.aim; a tender under a davit, windlass and anchor, hose reels,
// liferafts, fenders, crew. Waterline y = 0, bow to -z (stem -11, transom 10). ----
const fore = (z) => clamp((-3 - z) / 8, 0, 1);                                        // 0 abaft z = -3, 1 at the stem
const sheer = (z) => 1.5 + 1.2 * fore(z) ** 1.6;                                      // deck height: flat aft, rising to the bow
const beam = (z) => 2.9 * (1 - fore(z) ** 2.4) + 0.05 - (z > 4 ? 0.35 * ((z - 4) / 6) ** 2 : 0); // half-breadth at the deck
const keel = (z) => -1.15 + 1.75 * fore(z) ** 3 + (z > 5 ? 0.5 * ((z - 5) / 5) ** 2 : 0);
const bulwark = (z) => 0.62 * (1 - smooth(3.2, 4.2, z));                              // solid bulwarks forward, rails aft
export function buildBoat({ body = 0xf2763a, trim = 0x2a2a32 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
  const b = bodyBaker(), group = new THREE.Group(), V = THREE.Vector3;
  const WHITE = 0xfff1d8, DECK = 0x8a8f96, ANTIFOUL = 0x6e2a26, STEEL = 0x4a4d57, ORANGE = 0xf2763a, RED = 0xd8352a, BRASS = 0xc9a24a, SKIN = 0xe2b28c;
  const box = (w, h, d, color, x, y, z) => b.add(new THREE.BoxGeometry(w, h, d), color, x, y, z);
  const cyl = (r0, r1, h, color, x, y, z, seg = 10) => b.add(new THREE.CylinderGeometry(r0, r1, h, seg), color, x, y, z);
  const chain = (r, color, pts) => { for (let i = 1; i < pts.length; i++) strut(b, r, color, pts[i - 1], pts[i]); };

  // Hull. One half-section, keel to deck edge: convex bottom to the chine (with a point at the waterline for the boot
  // top), flared topside, bulwark out and back in to the deck. Mirrored into a ring whose closing edge is the deck.
  const section = (z) => {
    const B = beam(z), K = keel(z), S = sheer(z), c = B * (0.8 - 0.12 * fore(z)), bw = bulwark(z), yc = Math.max(0.32, K + 0.2), wl = clamp(Math.max(0, (0.02 - K) / (yc - K)) ** 0.62, 0.72, 0.95); // yc: chine height
    const side = [...[0.3, 0.55, wl, 1].map((v) => [c * v, K + (yc - K) * v ** 1.6]), ...[0.3, 0.62, 1].map((u) => [c + (B - c) * u ** 0.8, yc + (S - yc) * u]), [B + 0.03, S + bw], [B - 0.1, S + bw], [B - 0.1, S]];
    return [...side.slice().reverse().map(([x, y]) => new V(-x, y, z)), new V(0, K, z), ...side.map(([x, y]) => new V(x, y, z))];
  };
  const zs = Array.from({ length: 43 }, (_, i) => -11 + i * 0.5);
  b.add(loft(zs.map(section), false, true), (x, y, z) => {
    const S = sheer(z), ax = Math.abs(x), B = beam(z);
    if (y > S - 0.03 && ax < B - 0.09) return y > S + 0.05 ? WHITE : Math.abs(ax - (B - 0.5)) < 0.22 && z > 3.8 ? 0xe9b93a : DECK; // bulwark inside; deck (yellow edge line aft)
    if (y > S + bulwark(z) - 0.04 && bulwark(z) > 0.1) return trim;                   // cap rail
    if (y < 0.03) return ANTIFOUL;
    if (y < 0.3) return WHITE;                                                        // boot top
    return z > -8.5 && z < -7.5 ? WHITE : z > -7 && z < -6.5 ? trim : z > 9.9 ? trim : body; // service stripes abaft the bow
  }, 0, 0, 0, 6);
  for (const sx of [-1, 1]) {
    chain(0.075, trim, zs.filter((z, i) => i % 2 === 0 && z > -10.6).map((z) => [sx * (beam(z) + 0.04), sheer(z) - 0.16, z]));                 // rubbing strake
    chain(0.05, WHITE, zs.filter((z) => z > -10.4 && z < -3).map((z) => [sx * (beam(z) * (0.8 - 0.12 * fore(z)) + 0.03), 0.4, z]));            // spray rail
    for (const z of [-4.5, -1, 2.5, 6, 8.8]) {                                        // tyre fenders on lanyards
      b.add(new THREE.TorusGeometry(0.3, 0.13, 6, 10).rotateY(Math.PI / 2), trim, sx * (beam(z) + 0.2), 0.75, z);
      strut(b, 0.02, WHITE, [sx * (beam(z) + 0.2), 1.05, z], [sx * (beam(z) + 0.02), sheer(z) + bulwark(z), z]);
    }
    // Twin transom waterjets: flush hull intake duct and trash screen (static); steerable nozzles and reversing buckets are moving parts below.
    box(0.58, 0.22, 1.5, DARK, sx * 1.1, -0.58, 9.15);                                                                     // flush bottom intake duct
    for (const dx of [-0.16, 0, 0.16]) box(0.03, 0.06, 1.3, STEEL, sx * 1.1 + dx, -0.68, 9.15);                            // intake trash-screen bars
    box(0.76, 0.68, 0.16, trim, sx * 1.1, -0.26, 10.04);                                                                   // transom mounting plate
    b.add(new THREE.CylinderGeometry(0.24, 0.28, 0.42, 10).rotateX(Math.PI / 2), STEEL, sx * 1.1, -0.26, 10.28);           // stator pump bowl
    strut(b, 0.05, STEEL, [sx * 1.1, -0.6, 10.02], [sx * 1.1, -0.34, 10.42]);                                              // lower nozzle guard strut
    for (const dx of [-0.22, 0.22]) strut(b, 0.035, BRASS, [sx * 1.1 + dx, -0.02, 10.08], [sx * 1.1 + dx, -0.08, 10.48]);  // hydraulic actuator rams
    // Bow & stern side-thruster tunnel mouths with protective cross-grilles on both sides of the hull.
    for (const [tz, ty, tr] of [[-7.6, -0.45, 0.3], [7.2, -0.52, 0.26]]) {
      const bx = sx * (beam(tz) * (0.8 - 0.12 * fore(tz)) * 0.58);
      b.add(new THREE.CylinderGeometry(tr, tr, 0.14, 10).rotateZ(Math.PI / 2), DARK, bx, ty, tz);
      b.add(new THREE.TorusGeometry(tr, 0.035, 6, 10).rotateY(Math.PI / 2), STEEL, bx + sx * 0.05, ty, tz);
      strut(b, 0.022, STEEL, [bx + sx * 0.06, ty - tr * 0.85, tz], [bx + sx * 0.06, ty + tr * 0.85, tz]);
      strut(b, 0.022, STEEL, [bx + sx * 0.06, ty, tz - tr * 0.85], [bx + sx * 0.06, ty, tz + tr * 0.85]);
    }
    // Aft deck rails: three courses on stanchions.
    const rz = [4.2, 5.3, 6.4, 7.5, 8.6, 9.75];
    rz.forEach((z) => strut(b, 0.03, STEEL, [sx * (beam(z) - 0.12), 1.5, z], [sx * (beam(z) - 0.12), 2.5, z]));
    for (const h of [0.4, 0.72, 1]) chain(0.022, STEEL, rz.map((z) => [sx * (beam(z) - 0.12), 1.5 + h, z]));
    strut(b, 0.03, STEEL, [sx * (beam(4.2) - 0.12), 2.5, 4.2], [sx * (beam(3.4) - 0.04), sheer(3.4) + bulwark(3.4), 3.4]);
  }
  box(0.5, 0.9, 1.6, ANTIFOUL, 0, -1.0, 6.2);                                         // skeg
  b.add(new THREE.CylinderGeometry(0.3, 0.3, 2.7, 10).rotateZ(Math.PI / 2), 0x1a1418, 0, -0.45, -7.6); // bow thruster tunnel
  b.add(new THREE.CylinderGeometry(0.26, 0.26, 3.2, 10).rotateZ(Math.PI / 2), 0x1a1418, 0, -0.52, 7.2); // stern thruster tunnel
  for (const h of [0.4, 0.72, 1]) strut(b, 0.022, STEEL, [-beam(9.75) + 0.12, 1.5 + h, 9.75], [-0.7, 1.5 + h, 9.75]), strut(b, 0.022, STEEL, [0.7, 1.5 + h, 9.75], [beam(9.75) - 0.12, 1.5 + h, 9.75]); // taffrail, gate amidships
  for (const x of [-0.7, 0.7]) strut(b, 0.03, STEEL, [x, 1.5, 9.75], [x, 2.5, 9.75]);

  // Stern: rescue platform on brackets with a boarding ladder, ensign staff and flag, stern light.
  box(4.4, 0.12, 1.3, DECK, 0, 0.42, 10.65);
  for (let x = -2; x <= 2; x += 0.5) box(0.05, 0.03, 1.3, trim, x, 0.5, 10.65);       // grating
  for (const sx of [-1.7, 0, 1.7]) strut(b, 0.05, STEEL, [sx, 0.38, 11.2], [sx, -0.2, 10.05]);
  for (const sx of [-0.25, 0.25]) strut(b, 0.03, STEEL, [sx + 1.2, 0.5, 11.3], [sx + 1.2, -0.9, 11.3]);
  for (let y = -0.8; y < 0.4; y += 0.3) strut(b, 0.022, STEEL, [0.95, y, 11.3], [1.45, y, 11.3]);
  strut(b, 0.025, WHITE, [2.2, 1.5, 9.85], [2.2, 3.5, 10.15]);
  b.add(new THREE.PlaneGeometry(1.1, 0.65, 4, 1), (x) => (x > 2.9 ? RED : WHITE), 2.78, 3.12, 10.1);
  box(0.12, 0.12, 0.08, 0xfff8e0, 0, 2.2, 10.02);

  // Foredeck: windlass with gypsies, chain to the hawse, anchor hung at the stem, bitts, fairleads, hatch, jackstaff, pulpit rail.
  const fd = sheer(-8.9);
  box(1.0, 0.3, 0.7, STEEL, 0, fd + 0.15, -8.9);
  for (const sx of [-0.62, 0.62]) b.add(new THREE.CylinderGeometry(0.24, 0.24, 0.22, 10).rotateZ(Math.PI / 2), trim, sx, fd + 0.35, -8.9);
  b.add(new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8).rotateZ(Math.PI / 2), STEEL, 0, fd + 0.35, -8.9);
  strut(b, 0.05, STEEL, [0.62, fd + 0.4, -8.9], [1.78, sheer(-8.35) + 0.02, -8.35]);    // chain to starboard hawse
  b.add(new THREE.TorusGeometry(0.18, 0.05, 6, 10).rotateY(Math.PI / 2), STEEL, 1.79, 1.78, -8.35); // starboard hawsepipe collar
  b.add(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 8).rotateZ(Math.PI / 2), DARK, 1.76, 1.78, -8.35);
  for (const [x, z] of [[-0.9, -9.7], [0.9, -9.7], [-1.9, -6.2], [1.9, -6.2]]) for (const dz of [-0.14, 0.14]) cyl(0.07, 0.085, 0.42, trim, x, sheer(z) + 0.21, z + dz, 8);
  box(1.1, 0.16, 1.1, WHITE, 0, sheer(-6.1) + 0.08, -6.1);                            // forward hatch
  cyl(0.2, 0.2, 0.05, STEEL, 0, sheer(-6.1) + 0.19, -6.1, 10);
  strut(b, 0.02, WHITE, [0, sheer(-10.7), -10.7], [0, sheer(-10.7) + 1.7, -10.8]);
  for (const sx of [-1, 1]) {
    const pz = [-10.6, -9.6, -8.4, -7.2, -6];
    pz.forEach((z) => strut(b, 0.025, STEEL, [sx * (beam(z) - 0.04), sheer(z) + 0.62, z], [sx * (beam(z) - 0.04), sheer(z) + 1.05, z]));
    chain(0.025, STEEL, pz.map((z) => [sx * (beam(z) - 0.04), sheer(z) + 1.05, z]));
  }
  strut(b, 0.025, STEEL, [-beam(-10.6) + 0.04, sheer(-10.6) + 1.05, -10.6], [beam(-10.6) - 0.04, sheer(-10.6) + 1.05, -10.6]);

  // Cabins: a rounded-corner plan lofted through levels [y, scale, forward lean]; then glass panes set just proud of
  // the wall between two levels, each shrunk a little so the wall shows as its frame.
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
  const panes = (P, lo, hi, pick, glass = GLASS) => {
    const A = ringAt(P, lo), B = ringAt(P, hi), n = A.length, out = [];
    for (let i = 0; i < n; i++) {
      if (!pick(P.kind[i])) continue;
      const q = [A[i], A[(i + 1) % n], B[(i + 1) % n], B[i]], c = q.reduce((m, p) => m.add(p), new V()).multiplyScalar(0.25), o = new V(c.x, 0, c.z - (P.z0 + P.z1) / 2).normalize().multiplyScalar(0.025);
      const [p0, p1, p2, p3] = q.map((p) => p.clone().lerp(c, 0.1).add(o)), nrm = new V().subVectors(p1, p0).cross(new V().subVectors(p2, p0));
      out.push(...(nrm.dot(o) > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2]));
    }
    b.add(new THREE.BufferGeometry().setFromPoints(out), glass);
  };
  const H0 = 1.45, H1 = 3.75, W0 = 3.87, W1 = 5.8;
  const dk = plan(2.25, -5.6, 2.8, 0.55, 0.62), whp = plan(1.95, -4.9, -1.3, 0.45, 0.6);
  cabin(dk, [[H0], [H1]], (x, y) => (y < H0 + 0.35 ? body : WHITE));                  // deckhouse, with a coloured plinth... (single band: painted by height)
  cabin(dk, [[H1, 1.035], [W0, 1.035]], trim);                                        // its roof, a lip proud of the walls
  panes(dk, [2.75], [3.4], (k) => k !== 'c' && k[0] !== 'b' && k[1] !== '3', (x, y) => (y < 3.0 ? 0xffd28a : 0x3b4d63)); // warm cabin glow inside the lower deckhouse windows
  const whIn = plan(1.82, -4.75, -1.45, 0.38, 0.6);
  cabin(whIn, [[W0 + 0.02], [4.52]], (x, y, z) => (z < -3.9 ? trim : 0xd8cfc2));      // wheelhouse console & warm interior lining
  for (const sx of [-0.65, 0.65]) {
    box(0.46, 0.45, 0.44, trim, sx, 4.72, -3.55);                                     // helm & navigator seats
    box(0.46, 0.55, 0.1, trim, sx, 5.1, -3.35);
    for (const dx of [-0.22, 0.22]) box(0.34, 0.26, 0.06, 0x38b6ff, sx + dx, 4.7, -4.35); // glowing bridge radar/chart displays
  }
  b.add(new THREE.CylinderGeometry(0.18, 0.18, 0.04, 10).rotateX(1.1), BRASS, -0.65, 4.68, -4.05); // ship's wheel
  box(0.36, 0.14, 0.22, RED, 0, 4.62, -4.15);                                         // twin waterjet throttle quadrant
  cabin(whp, [[W0], [4.5], [5.42, 1, 0.38], [W1, 1, 0.38]], WHITE);                   // wheelhouse: glass leans forward to shed spray and glare
  panes(whp, [4.5], [5.42, 1, 0.38], () => true);
  b.add(loft([[W1, 1.07, 0.75], [W1 + 0.13, 1.07, 0.75]].map((l) => ringAt(whp, l)), false, true), trim, 0, 0, 0, 6); // roof with a brow over the screens
  for (const x of [-0.9, 0, 0.9]) strut(b, 0.015, trim, [x, 4.56, -4.95], [x + 0.3, 5.1, -5.14]); // wipers
  for (const sx of [-1, 1]) {
    box(0.07, 1.8, 0.8, body, sx * 2.26, 2.42, 2.05); box(0.08, 0.5, 0.5, GLASS, sx * 2.27, 2.95, 2.05);                 // side doors with a light
    strut(b, 0.025, STEEL, [sx * 2.32, 2.5, -4.8], [sx * 2.32, 2.5, 1.5]);            // grab rail along the house
    b.add(new THREE.TorusGeometry(0.33, 0.1, 6, 12).rotateY(Math.PI / 2), ORANGE, sx * 2.36, 2.1, -1.2);                 // life rings
    b.add(new THREE.TorusGeometry(0.33, 0.1, 6, 12).rotateY(Math.PI / 2), ORANGE, sx * 2.36, 2.1, 0.9);
    b.add(new THREE.CylinderGeometry(0.32, 0.32, 1.1, 12).rotateX(Math.PI / 2), WHITE, sx * 1.7, W0 + 0.45, 1.7);       // liferaft canisters in cradles
    for (const dz of [-0.35, 0.35]) box(0.75, 0.12, 0.1, STEEL, sx * 1.7, W0 + 0.08, 1.7 + dz), b.add(new THREE.TorusGeometry(0.33, 0.025, 4, 12), trim, sx * 1.7, W0 + 0.45, 1.7 + dz);
    box(0.1, 0.16, 0.22, sx < 0 ? 0xff3030 : 0x30e070, sx * 2.02, 5.0, -2.2);         // sidelights: red to port, green to starboard
    box(0.06, 0.3, 0.34, trim, sx * 1.98, 5.0, -2.2);
    const rr = [-0.6, 0.5, 1.6, 2.7];                                                 // rail round the after end of the house top
    rr.forEach((z) => strut(b, 0.025, STEEL, [sx * 2.25, W0, z], [sx * 2.25, W0 + 0.9, z]));
    for (const h of [0.5, 0.9]) chain(0.02, STEEL, rr.map((z) => [sx * 2.25, W0 + h, z]));
  }
  for (const h of [0.5, 0.9]) strut(b, 0.02, STEEL, [-2.25, W0 + h, 2.7], [2.25, W0 + h, 2.7]);
  box(0.9, 1.85, 0.07, body, -0.9, 2.42, 2.82); box(0.5, 0.5, 0.08, GLASS, -0.9, 2.95, 2.83);                           // after door
  for (const sx of [0.55, 1.05]) strut(b, 0.03, STEEL, [sx, H0 + 0.05, 2.95], [sx, W0 + 0.9, 2.95]);                     // ladder to the house top
  for (let y = H0 + 0.3; y < W0 + 0.2; y += 0.3) strut(b, 0.022, STEEL, [0.55, y, 2.95], [1.05, y, 2.95]);

  // Funnel: tapered casing with a colour band, twin exhausts.
  const fn = plan(0.75, -0.9, 1.1, 0.3, 0.5);
  cabin(fn, [[W0], [W0 + 0.7, 0.96], [W0 + 1.25, 0.9], [W0 + 1.85, 0.84]], (x, y) => (y > W0 + 1.3 ? trim : y > W0 + 0.75 ? body : WHITE));
  for (const sx of [-0.25, 0.25]) cyl(0.11, 0.13, 0.5, STEEL, sx, W0 + 2.05, 0.45, 8), cyl(0.14, 0.14, 0.08, trim, sx, W0 + 2.32, 0.45, 8);
  box(0.9, 0.5, 0.06, STEEL, 0, W0 + 0.5, -0.95);                                     // vent grille

  // Wheelhouse top: lattice mast (four legs, braced), radar platform, yard with lights, aerials, domes, horns, light bar.
  const mz = -2.3, m0 = W1 + 0.13, m1 = m0 + 3.3, leg = (sx, sz, k) => [sx * (0.5 - 0.38 * k), m0 + (m1 - m0) * k, mz + sz * (0.5 - 0.38 * k) + 0.25 * k];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    strut(b, 0.045, WHITE, leg(sx, sz, 0), leg(sx, sz, 1));
    for (const k of [0.25, 0.5, 0.75]) { strut(b, 0.022, WHITE, leg(sx, sz, k), leg(-sx, sz, k)); strut(b, 0.022, WHITE, leg(sx, sz, k), leg(sx, -sz, k)); strut(b, 0.018, WHITE, leg(sx, sz, k - 0.25), leg(sx === sz ? -sx : sx, sx === sz ? sz : -sz, k)); }
  }
  box(1.3, 0.07, 1.0, STEEL, 0, m0 + 1.3, mz - 0.55);                                 // radar platform, forward of the mast
  for (const sx of [-0.5, 0.5]) strut(b, 0.025, STEEL, [sx, m0 + 1.3, mz - 0.95], [sx * 0.6, m0 + 0.75, mz - 0.3]);
  strut(b, 0.035, WHITE, [-1.5, m0 + 2.45, mz + 0.14], [1.5, m0 + 2.45, mz + 0.14]);  // yard
  for (const x of [-1.4, -0.9, 0.9]) box(0.1, 0.14, 0.1, x < -1 ? 0xfff8e0 : RED, x, m0 + 2.58, mz + 0.14);
  cyl(0.09, 0.09, 0.16, 0xfff8e0, 0, m1 + 0.1, mz + 0.25, 8);                         // masthead light
  strut(b, 0.012, STEEL, [0.1, m1, mz + 0.25], [0.1, m1 + 1.5, mz + 0.3]); strut(b, 0.012, STEEL, [1.45, m0 + 2.45, mz + 0.14], [1.5, m0 + 3.7, mz + 0.2]); // whip aerials
  strut(b, 0.012, STEEL, [-1.7, W1 + 0.13, -1.6], [-1.75, W1 + 2.3, -1.5]);
  b.add(new THREE.SphereGeometry(0.28, 10, 7), WHITE, 1.2, W1 + 0.5, -1.9); cyl(0.12, 0.16, 0.24, WHITE, 1.2, W1 + 0.25, -1.9, 8); // satcom dome
  b.add(new THREE.SphereGeometry(0.12, 8, 5), WHITE, -1.2, W1 + 0.32, -1.8); cyl(0.03, 0.03, 0.2, STEEL, -1.2, W1 + 0.2, -1.8, 6);  // GPS
  for (const sx of [-0.14, 0.14]) b.add(new THREE.CylinderGeometry(0.11, 0.03, 0.55, 10).rotateX(-Math.PI / 2), RED, 0.9 + sx, W1 + 0.3 + Math.abs(sx) * 0, -4.0); // horns, bells forward
  box(0.4, 0.14, 0.2, STEEL, 0.9, W1 + 0.2, -3.75);
  box(1.3, 0.12, 0.26, 0x2f6fe0, 0, W1 + 0.27, -4.55); box(1.4, 0.06, 0.3, trim, 0, W1 + 0.18, -4.55); // blue light bar on the brow

  // Fire main: the pedestals the monitors turn on, hose reels and a hydrant manifold abaft the house.
  const mon = BOAT.monitors;
  for (const [x, y, z] of mon) { cyl(0.2, 0.3, 0.6, RED, x, y + 0.3, z, 10); cyl(0.34, 0.34, 0.06, STEEL, x, y + 0.04, z, 10); }
  for (const sx of [-1.75, 1.75]) {
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 12).rotateZ(Math.PI / 2), RED, sx, H0 + 0.75, 3.35);
    for (const dx of [-0.28, 0.28]) b.add(new THREE.CylinderGeometry(0.44, 0.44, 0.05, 12).rotateZ(Math.PI / 2), STEEL, sx + dx, H0 + 0.75, 3.35);
    box(0.7, 0.4, 0.12, STEEL, sx, H0 + 0.25, 3.35);
  }
  box(0.7, 0.5, 0.35, RED, 0.2, H0 + 0.3, 3.15);
  for (const x of [0, 0.4]) b.add(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 8).rotateX(Math.PI / 2), BRASS, x, H0 + 0.35, 3.38);

  // Aft deck: tender (hull, tube collar, console, outboard) in chocks to port; hydraulic davit to starboard; towing
  // winch and bitt; hatches; gear locker; two of the crew.
  const tx = -1.15, tz = 6.4, ty = 1.5 + 0.5;
  b.add(loft([[-1.9, 0.05, 0.3], [-1.3, 0.45, 0.02], [-0.4, 0.6, -0.1], [1.2, 0.62, -0.12], [1.9, 0.56, 0]].map(([z, w, k]) => [[-w, 0.36], [-w, 0.1], [0, k], [w, 0.1], [w, 0.36]].map(([x, y]) => new V(x + tx, y + ty, z + tz))), false, true), (x, y) => (y > ty + 0.3 ? DECK : trim), 0, 0, 0, 6);
  const collar = [[0.62, 1.9], [0.7, 1], [0.72, 0], [0.68, -0.9], [0.5, -1.5], [0.2, -1.95], [-0.2, -1.95], [-0.5, -1.5], [-0.68, -0.9], [-0.72, 0], [-0.7, 1], [-0.62, 1.9]];
  b.add(loft(collar.map(([x, z], i) => {
    const [px, pz] = collar[Math.max(0, i - 1)], [qx, qz] = collar[Math.min(collar.length - 1, i + 1)], l = Math.hypot(qx - px, qz - pz), nx = (qz - pz) / l, nz = -(qx - px) / l;
    return Array.from({ length: 8 }, (_, k) => { const a = (k / 8) * Math.PI * 2, o = 0.2 * Math.cos(a); return new V(x + tx + nx * o, ty + 0.42 + 0.2 * Math.sin(a), z + tz + nz * o); });
  }), false, true), (x, y, z) => (Math.abs(((z - tz) % 1.1) - 0.2) < 0.12 ? trim : ORANGE), 0, 0, 0, 6);
  box(0.5, 0.6, 0.5, WHITE, tx, ty + 0.6, tz + 0.2); box(0.46, 0.3, 0.04, GLASS, tx, ty + 1.02, tz + 0.02);
  box(0.36, 0.5, 0.5, trim, tx, ty + 0.72, tz + 2.0); box(0.14, 0.9, 0.2, trim, tx, ty + 0.1, tz + 2.1);
  for (const dz of [-1.1, 1.1]) { box(1.5, 0.14, 0.2, STEEL, tx, 1.57, tz + dz); for (const sx of [-0.6, 0.6]) strut(b, 0.05, STEEL, [tx + sx, 1.6, tz + dz], [tx + sx * 0.75, ty + 0.12, tz + dz]); }
  cyl(0.2, 0.26, 0.5, STEEL, 1.75, 1.75, 5.2, 10); cyl(0.15, 0.17, 2.3, body, 1.75, 3.1, 5.2, 10);
  strut(b, 0.11, body, [1.75, 4.2, 5.2], [-0.9, 4.95, 6.3]); strut(b, 0.06, STEEL, [1.75, 2.9, 5.2], [0.6, 4.45, 5.7]); // jib and its ram
  b.add(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 10).rotateZ(Math.PI / 2), STEEL, -0.9, 4.9, 6.3);
  strut(b, 0.015, trim, [-0.9, 4.85, 6.3], [tx, ty + 0.95, tz]); box(0.12, 0.2, 0.12, RED, tx, ty + 0.92, tz);
  b.add(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 12).rotateZ(Math.PI / 2), STEEL, 0.9, 1.9, 7.4);                         // towing winch
  for (const dx of [-0.45, 0.45]) b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 12).rotateZ(Math.PI / 2), trim, 0.9 + dx, 1.9, 7.4);
  box(1.1, 0.3, 0.7, STEEL, 0.9, 1.6, 7.4);
  cyl(0.15, 0.17, 0.75, trim, 0, 1.87, 8.9, 10); strut(b, 0.07, trim, [-0.42, 2.1, 8.9], [0.42, 2.1, 8.9]);
  box(1.3, 0.1, 1.3, WHITE, 0.2, 1.55, 4.6); box(0.9, 0.1, 0.9, WHITE, 1.7, 1.55, 8.7);                                    // hatches
  box(1.3, 0.6, 0.8, ORANGE, -1.5, 1.8, 9.1); box(1.34, 0.06, 0.84, trim, -1.5, 2.12, 9.1);                                // rescue gear locker
  const crew = (x, y, z, turn) => {
    const add = (g, color, dy) => b.add(g.rotateY(turn), color, x, y + dy, z);
    for (const sx of [-0.1, 0.1]) add(new THREE.BoxGeometry(0.15, 0.85, 0.18).translate(sx, 0, 0), trim, 0.43);
    add(new THREE.BoxGeometry(0.46, 0.62, 0.26), ORANGE, 1.16);
    add(new THREE.BoxGeometry(0.5, 0.2, 0.3), 0xe9b93a, 1.3);                           // lifejacket
    for (const sx of [-0.3, 0.3]) add(new THREE.BoxGeometry(0.12, 0.6, 0.14).translate(sx, 0, 0), ORANGE, 1.14);
    add(new THREE.SphereGeometry(0.13, 8, 6), SKIN, 1.62);
    add(new THREE.SphereGeometry(0.15, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), WHITE, 1.66); // helmet
  };
  crew(1.6, 1.5, 6.6, 0.6); crew(-1.3, sheer(-5.2), -5.2, 2.6);
  const hullMesh = new THREE.Mesh(b.geometry(), mat);
  hullMesh.castShadow = hullMesh.receiveShadow = true;
  group.add(hullMesh);

  // Moving parts: the radar scanner; the two monitors and the searchlight, which train with s.aim (yaw off the bow);
  // and the twin waterjet steering nozzles + reversing buckets at the transom.
  const part = (build, x, y, z, parent = group) => { const pb = bodyBaker(); build(pb); const m = new THREE.Mesh(pb.geometry(), mat); m.castShadow = m.receiveShadow = true; m.position.set(x, y, z); parent.add(m); return m; };
  const jets = [-1, 1].map((sx) => {
    const noz = part((pb) => {
      pb.add(new THREE.CylinderGeometry(0.19, 0.24, 0.36, 10).rotateX(Math.PI / 2), ORANGE, 0, 0, 0.14); // steerable nozzle cone
      pb.add(new THREE.TorusGeometry(0.19, 0.03, 6, 10), STEEL, 0, 0, 0.31);                             // nozzle exit ring
      pb.add(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8).rotateX(Math.PI / 2), DARK, 0, 0, 0.28);    // dark jet bore
      for (const dx of [-0.21, 0.21]) pb.add(new THREE.BoxGeometry(0.05, 0.14, 0.22), STEEL, dx, 0.02, 0.12); // bucket hinge trunnions
    }, sx * 1.1, -0.26, 10.46);
    const bkt = part((pb) => {
      pb.add(new THREE.CylinderGeometry(0.24, 0.24, 0.3, 10, 1, false, -Math.PI * 0.45, Math.PI * 0.9).rotateZ(Math.PI / 2).rotateX(0.35), STEEL, 0, 0.2, 0.18); // split-duct reversing bucket hood
      for (const dx of [-0.21, 0.21]) strut(pb, 0.03, STEEL, [dx, 0, 0], [dx, 0.18, 0.2]);               // bucket side arms
    }, 0, 0.04, 0.12, noz);
    return { noz, bkt };
  });
  const radar = part((pb) => {
    pb.add(new THREE.BoxGeometry(1.9, 0.16, 0.22), WHITE, 0, 0.3, 0); pb.add(new THREE.BoxGeometry(1.9, 0.05, 0.24), trim, 0, 0.2, 0);
    pb.add(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 8), STEEL, 0, 0.12, 0); pb.add(new THREE.BoxGeometry(0.5, 0.2, 0.4), WHITE, 0, 0, 0);
  }, 0, m0 + 1.45, mz - 0.55);
  const turret = (pb) => {
    pb.add(new THREE.SphereGeometry(0.24, 8, 6), STEEL, 0, 0.78, 0);
    pb.add(new THREE.BoxGeometry(0.56, 0.1, 0.1), STEEL, 0, 0.78, 0);
    for (const sx of [-0.3, 0.3]) pb.add(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 8).rotateZ(Math.PI / 2), BRASS, sx, 0.78, 0); // handwheels
    strut(pb, 0.11, RED, [0, 0.78, 0], [0, 1.3, -0.85]);
    strut(pb, 0.085, BRASS, [0, 1.3, -0.85], [0, 1.47, -1.13]);
    strut(pb, 0.13, trim, [0, 1.25, -0.77], [0, 1.31, -0.87]);
  };
  const turrets = mon.map(([x, y, z]) => part(turret, x, y, z));
  const light = part((pb) => {
    pb.add(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 6), STEEL, 0, 0.15, 0);
    pb.add(new THREE.CylinderGeometry(0.2, 0.16, 0.34, 10).rotateX(Math.PI / 2), trim, 0, 0.42, 0);
    pb.add(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 10).rotateX(Math.PI / 2), 0xfff2b0, 0, 0.42, -0.18);
  }, -1.35, W1 + 0.13, -3.9);
  const anchor = part((pb) => {
    pb.add(new THREE.TorusGeometry(0.09, 0.03, 5, 8), STEEL, 0, 0.05, 0);                                 // shackle ring
    pb.add(new THREE.BoxGeometry(0.11, 0.72, 0.11), STEEL, 0, -0.34, 0);                                  // shank
    pb.add(new THREE.BoxGeometry(0.12, 0.12, 0.56), STEEL, 0, -0.16, 0);                                  // stock
    pb.add(new THREE.BoxGeometry(0.12, 0.16, 0.64), STEEL, 0, -0.68, 0);                                  // crown
    for (const sz of [-1, 1]) {
      pb.add(new THREE.ConeGeometry(0.14, 0.36, 4).rotateY(Math.PI / 4).rotateX(sz * 0.45), STEEL, 0, -0.52, sz * 0.32); // flukes
    }
  }, 1.90, 1.78, -8.35);
  const anchorChain = part((pb) => {
    pb.add(new THREE.CylinderGeometry(0.04, 0.04, 1, 6), STEEL, 0, -0.5, 0);
  }, 1.90, 1.78, -8.35);
  let anchorDrop = 0;
  const beamGeo = new THREE.ConeGeometry(6.5, 75, 14, 1, true).translate(0, -37.5, 0).rotateX(Math.PI / 2);
  const bp = beamGeo.attributes.position, bc = new Float32Array(bp.count * 3);
  for (let i = 0; i < bp.count; i++) { const k = bp.getZ(i) > -1 ? 1 : 0; bc[i * 3] = k; bc[i * 3 + 1] = k * 0.95; bc[i * 3 + 2] = k * 0.78; }
  beamGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  const beam_ = new THREE.Mesh(beamGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beam_.position.set(0, 0.42, -0.18); beam_.rotation.x = -0.06;
  light.add(beam_);
  const lamp = (color, x, y, z, w = 0.22) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.16), new THREE.MeshBasicMaterial({ color })); m.position.set(x, y, z); group.add(m); return m; };
  const beacon = lamp(0x4f9bff, -0.4, W1 + 0.3, -4.56, 0.5), strobe = lamp(0x9fd0ff, 0.4, W1 + 0.3, -4.56, 0.5); // the light bar's two halves flash in turn
  group.rotation.order = 'YXZ';
  return { group, beacon, strobe, spin: (dt, power, s) => {
    radar.rotation.y += dt * 2.4;
    beam_.visible = !!s?.light; // L switches it
    for (const m of [...turrets, light]) m.rotation.y += ((s?.aim || 0) - m.rotation.y) * (1 - Math.exp(-6 * dt));
    const steer = -(s?.steer || 0) * 0.42, rev = (s?.throttle || 0) < -0.02 ? 0.55 : 0, k = 1 - Math.exp(-10 * dt);
    for (const j of jets) { j.noz.rotation.y += (steer - j.noz.rotation.y) * k; j.bkt.rotation.x += (rev - j.bkt.rotation.x) * k; }
    anchorDrop += ((s?.anchored ? 1 : 0) - anchorDrop) * (1 - Math.exp(-(s?.anchored ? 3.2 : 2.2) * dt));
    anchor.position.y = 1.78 - anchorDrop * 4.5;
    anchor.rotation.z = (1 - anchorDrop) * 0.12;
    anchor.rotation.y = anchorDrop * Math.sin((s?.t || 0) * 1.4) * 0.15;
    anchorChain.visible = anchorDrop > 0.02;
    anchorChain.scale.y = Math.max(0.01, anchorDrop * 4.5);
  } };
}
