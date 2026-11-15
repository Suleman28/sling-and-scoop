import * as THREE from 'three';
import R from '@dimforge/rapier3d-compat';
import { CELL, flip, H, HALF, HARBOUR, OILRIG, PAD, PADS, padLocal, SEA, SEGS, SOLIDS, treeGrid } from './world.js';
import { bodyBaker, DARK } from './chopper.js';
import { hangOf, massOf, radiusOf, RIG, settleRig, surfaceUnder } from './tools.js';

// Rapier runs the world around the flying: hookable loads and oil drums are rigid bodies that tumble, roll and stack.
// With flight physics on (fly), the helicopter is a dynamic body too. stepFlight still turns the stick into a velocity;
// Rapier adds what the world does to it (loads, drums, the rope) and stepFlight eases back from that, so knocks
// linger. The rope is a rope joint to a real bucket, hook or load, and the rotor carries the load's weight up to
// RIG.maxLift. A hit over CRASH turns the aircraft into a tumbling wreck. With fly off, the aircraft and rope stay
// hand-rolled (stepFlight, stepRig) and only shove things as kinematic bodies.
// Around that: loose things float and bob in the sea (swim), the rotor's downwash rolls drums about, and a drum that
// takes a hard knock or sits in a fire explodes, kicking everything nearby and setting off its neighbours.
// pop: the jolt (m/s in one step) that sets a drum off. blast: reach (m). punch: impulse (N s) at the centre.
const DRUM = { r: 0.45, h: 0.95, mass: 200, pop: 13, blast: 12, punch: 8000, chain: 6 };
const WASH = { r: 10, h: 18, push: 2200 };   // downwash reach, height below the rotor it's felt, force (N per m of load radius)
const KG = 1000, DT = 1 / 60;   // RIG masses are relative to the Utility (1)
export const CRASH = 20;        // impact speed (m/s) that wrecks the aircraft
// Collision groups, (member << 16) | filter: the live aircraft only meets loose things (stepFlight handles the
// ground and trees); the bucket passes through the sea to scoop; the hook and bucket never touch the aircraft.
// Loose things don't meet the sea floor either: they float (swim) or sink to the seabed.
const WORLD = 1, SEAG = 2, CRAFT = 4, LOOSE = 8, TOOL = 16, ALL = 0xffff, DRY = ALL ^ SEAG;
const groups = (member, filter) => (member << 16) | filter;

export async function createPhysics(scene) {
  await R.init();
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());

  // Terrain: the heightmap's own triangles (same diagonal split as heightAt), and the sea as a floor at SEA.
  const n = SEGS + 1, verts = new Float32Array(n * n * 3), idx = new Uint32Array(SEGS * SEGS * 6);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) verts.set([i * CELL - HALF, H[j * n + i], j * CELL - HALF], (j * n + i) * 3);
  for (let j = 0, k = 0; j < SEGS; j++) for (let i = 0; i < SEGS; i++, k += 6) {
    const a = j * n + i;
    idx.set(flip(i, j) ? [a, a + n, a + n + 1, a, a + n + 1, a + 1] : [a, a + n, a + 1, a + n + 1, a + 1, a + n], k);
  }
  world.createCollider(R.ColliderDesc.trimesh(verts, idx).setFriction(0.9).setCollisionGroups(groups(WORLD, ALL)), fixed);
  world.createCollider(R.ColliderDesc.cuboid(HALF, 10, HALF).setTranslation(0, SEA - 10, 0).setFriction(0.6).setCollisionGroups(groups(SEAG, ALL)), fixed);
  // Trees taper like hitTrees' cones; the lighthouse and lookout towers are straight.
  for (const cell of treeGrid) for (const [x, z, y, h, r, kind] of cell || []) {
    const shape = kind < 0 ? R.ColliderDesc.cylinder(h / 2, r) : R.ColliderDesc.cone(h / 2, r);
    world.createCollider(shape.setTranslation(x, y + h / 2, z).setCollisionGroups(groups(WORLD, ALL)), fixed);
  }
  for (const b of SOLIDS) if (!b.live) world.createCollider(R.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z)
    .setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) }).setFriction(0.8).setCollisionGroups(groups(WORLD, ALL)), fixed);

  // Harbour pier walkway, T-head, and boathouse
  const hyaw = HARBOUR.yaw, hcos = Math.cos(hyaw), hsin = Math.sin(hyaw);
  const hq = { x: 0, y: Math.sin(hyaw / 2), z: 0, w: Math.cos(hyaw / 2) };
  const hpos = (lx, ly, lz) => ({
    x: HARBOUR.hx + lx * hcos + lz * hsin,
    y: SEA + ly,
    z: HARBOUR.hz - lx * hsin + lz * hcos,
  });
  const addHarbourBox = (hx, hy, hz, lx, ly, lz) => {
    const p0 = hpos(lx, ly, lz);
    world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(p0.x, p0.y, p0.z).setRotation(hq).setFriction(0.8).setCollisionGroups(groups(WORLD, ALL)), fixed);
  };
  addHarbourBox(4.0, 0.18, HARBOUR.len / 2, 0, 1.5, HARBOUR.len / 2);          // causeway
  addHarbourBox(14.0, 0.24, 8.0, 0, 1.65, HARBOUR.len - 2);                      // shoreward logistics plaza
  addHarbourBox(19.0, 0.19, 9.0, 0, 1.5, 0);                                     // main quay head
  addHarbourBox(2.5, 0.18, 9.5, -13.0, 1.5, -18.5);                              // fishing pier
  addHarbourBox(3.0, 0.18, 14.5, 10.0, 1.5, -23.5);                              // container & ferry pier
  addHarbourBox(1.6, 0.23, 8.5, -22.0, 0.48, 1.5);                               // marina walkway
  addHarbourBox(2.3, 1.4, 19.0, -31.5, 1.4, -10.5);                              // outer breakwater main arm
  addHarbourBox(6.5, 1.4, 2.3, -25.0, 1.4, -28.0);                               // breakwater cross-arm
  addHarbourBox(2.7, 0.18, 2.4, 21.5, 1.5, 0);                                   // rescue station bridge
  addHarbourBox(7.0, 0.19, 8.0, 31.0, 1.5, 0);                                   // rescue station apron
  addHarbourBox(2.2, 1.8, 2.7, 29.0, 1.69 + 1.8, -1.5);                          // coastguard & rescue HQ
  addHarbourBox(3.8, 1.6, 5.0, -9.5, 1.69 + 1.6, -1.5);                          // cargo warehouse
  addHarbourBox(2.6, 2.4, 2.9, -8.0, 1.69 + 2.4, HARBOUR.len - 2.2);             // stacked shipping containers
  // Offshore Oil Rig colliders: main deck, cantilevered helideck, living quarters, and derrick tower.
  const addRigBox = (hx, hy, hz, lx, ly, lz) => world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(OILRIG.x + lx, SEA + ly, OILRIG.z + lz).setCollisionGroups(groups(WORLD, ALL)), fixed);
  addRigBox(11.0, 4.75, 11.0, 0, 4.75, 0);
  addRigBox(5.5, 0.225, 5.5, 0, 10.975, -14.5);
  addRigBox(3.2, 2.1, 3.6, 6.2, 11.6, 5.6);
  addRigBox(2.2, 7.5, 2.2, -1.5, 17.0, -1.5);

  // Oil drum pyramids: on the base apron beside the windsock, at the islet depot, and on the harbour pier head.
  const drums = [], q = new THREE.Quaternion();
  const pile = (pad, lx, lz) => {
    const o = padLocal(pad, lx, lz), ax = Math.cos(pad.yaw), az = -Math.sin(pad.yaw);
    for (let row = 0; row < 4; row++) for (let i = 0; i < 4 - row; i++) {
      const s = (i - (3 - row) / 2) * DRUM.r * 2.05, y = pad.y + DRUM.h * (row + 0.5) + 0.02;
      const home = { x: o.x + ax * s, y, z: o.z + az * s }, body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(home.x, y, home.z).setAngularDamping(0.4));
      world.createCollider(R.ColliderDesc.cylinder(DRUM.h / 2, DRUM.r).setMass(DRUM.mass).setFriction(0.7).setRestitution(0.15).setCollisionGroups(groups(LOOSE, DRY)), body);
      body.sleep();
      drums.push({ body, home, ext: [DRUM.r, DRUM.h / 2, DRUM.r], draft: 0.4, wet: false, live: true, fuse: 0, v: new THREE.Vector3() });
    }
  };
  pile(PAD, 12 * -PAD.away, 18);
  pile(PADS[1], 14, 8);
  const hPile = (lx, lz) => {
    const po = hpos(lx, 0, lz), ax = hcos, az = -hsin;
    for (let row = 0; row < 2; row++) for (let i = 0; i < 2 - row; i++) {
      const s = (i - (1 - row) / 2) * DRUM.r * 2.05, y = 1.69 + DRUM.h * (row + 0.5) + 0.02;
      const home = { x: po.x + ax * s, y, z: po.z + az * s }, body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(home.x, y, home.z).setAngularDamping(0.4));
      world.createCollider(R.ColliderDesc.cylinder(DRUM.h / 2, DRUM.r).setMass(DRUM.mass).setFriction(0.7).setRestitution(0.15).setCollisionGroups(groups(LOOSE, DRY)), body);
      body.sleep();
      drums.push({ body, home, ext: [DRUM.r, DRUM.h / 2, DRUM.r], draft: 0.4, wet: false, live: true, fuse: 0, v: new THREE.Vector3() });
    }
  };
  hPile(1.2, -4.1);
  const b = bodyBaker();
  b.add(new THREE.CylinderGeometry(DRUM.r, DRUM.r, DRUM.h, 10, 5), (x, y) => (Math.abs(y) > 0.4 ? DARK : Math.abs(Math.abs(y) - 0.16) < 0.04 ? 0xf6d34a : 0xd8452e), 0, 0, 0, 6);
  const drumMesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5 }), drums.length);
  drumMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(drumMesh);

  // The aircraft. Origin at the ground contact point like the models; a ball resting on its skids while live,
  // a box (with gravity and free rotation) once wrecked. mode: 'kin' (pushed along by hand-rolled flight), 'fly', 'wreck'.
  const craft = world.createRigidBody(R.RigidBodyDesc.dynamic().setCcdEnabled(true));
  const hull = world.createCollider(R.ColliderDesc.ball(1.8).setFriction(0.6).setRestitution(0.2), craft);
  let craftMode = '', craftR = 0, craftS = null, craftBoat = false;
  const wreckFloat = { body: craft, ext: [1, 1, 3], draft: 0.6, wet: false };
  function setCraft(mode, s, radius, mass, isBoat = false) {
    const wreck = mode === 'wreck';
    craft.setBodyType(mode === 'kin' ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Dynamic, true);
    craft.lockRotations(!wreck, true);
    craft.setGravityScale(wreck ? 1 : 0, true);
    if (isBoat && !wreck) {
      hull.setShape(new R.Cuboid(2.9, 1.8, 10.5));
      hull.setTranslationWrtParent({ x: 0, y: 1.0, z: -0.5 });
    } else {
      hull.setShape(wreck ? new R.Cuboid(radius * 0.6, radius * 0.5, radius * 1.6) : new R.Ball(radius));
      hull.setTranslationWrtParent({ x: 0, y: wreck ? radius * 0.5 : radius, z: 0 });
    }
    hull.setCollisionGroups(groups(CRAFT, wreck ? WORLD | LOOSE : LOOSE));
    wreckFloat.ext = isBoat ? [2.9, 1.8, 10.5] : [radius * 0.6, radius * 0.5, radius * 1.6];
    hull.setMass(mass);
    craft.setTranslation(s.pos, true);
    craft.setRotation(wreck || isBoat ? q.setFromEuler(new THREE.Euler(-(s.pitch || 0), s.yaw || 0, s.roll || 0, 'YXZ')) : { x: 0, y: 0, z: 0, w: 1 }, true);
    craft.setLinvel(wreck ? { x: s.vel.x, y: s.vel.y + 4, z: s.vel.z } : s.vel, true);
    craft.setAngvel(wreck ? { x: -s.vel.z * 0.15, y: 1.5, z: s.vel.x * 0.15 } : { x: 0, y: 0, z: 0 }, true);
    wreckFloat.draft = 0.6;
    craftMode = mode; craftR = radius; craftBoat = isBoat;
  }

  // The rope end when nothing's hooked: a ball for the bucket or hook (the rope joint ties it to the craft).
  const tool = world.createRigidBody(R.RigidBodyDesc.dynamic().lockRotations().setCcdEnabled(true));
  const toolCol = world.createCollider(R.ColliderDesc.ball(0.5).setMass(80).setFriction(0.8), tool);
  tool.setEnabled(false);
  let toolKind = '', joint = null, jointKey = '', jointTo = null, prevLen = 0;
  const dropJoint = () => { if (joint) world.removeImpulseJoint(joint, true); joint = jointTo = null; jointKey = ''; };

  const bodies = new Map(); // load -> { body, mode: 'free' | 'held' (kinematic, classic rope) | 'rope' (on the joint) | 'off' }
  const m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const v0 = new THREE.Vector3(), tv0 = new THREE.Vector3(), anchor = new THREE.Vector3();

  function addLoad(c) {
    const [hx, hy, hz] = c.spec.box, body = world.createRigidBody(R.RigidBodyDesc.dynamic().setCcdEnabled(true).setAngularDamping(0.3));
    world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, hy - c.spec.hang, 0).setMass(c.spec.mass * KG).setFriction(0.8).setRestitution(0.1).setCollisionGroups(groups(LOOSE, DRY)), body);
    const e = { body, mode: '', ext: c.spec.box, draft: c.spec.draft || 0.4, wet: false };
    bodies.set(c, e);
    return e;
  }

  // Water: a loose body floats with `draft` of its height under the surface, bobs on the swell and loses speed.
  // ext: its box half-extents (its height follows how it lies). Reports the splash when it goes in.
  const events = [];
  let time = 0, tick = 0;
  const vUp = new THREE.Vector3(), vNorm = new THREE.Vector3(), vTau = new THREE.Vector3();
  function swim(e, env) {
    const body = e.body;
    if (!body.isEnabled() || !body.isDynamic() || (body.isSleeping() && !e.wet)) return;
    const c = body.worldCom(), surf = surfaceUnder(c, env);
    if (surf === null) { e.wet = false; return; }
    const o = body.rotation(), [hx, hy, hz] = e.ext;
    const half = Math.abs(2 * (o.x * o.y + o.z * o.w)) * hx + Math.abs(1 - 2 * (o.x * o.x + o.z * o.z)) * hy + Math.abs(2 * (o.y * o.z - o.x * o.w)) * hz;
    const level = surf + (surf === env.pond?.y ? 0 : 0.14 * Math.sin(time * 1.3 + c.x * 0.07 + c.z * 0.05)), f = Math.min(1, (level - c.y + half) / (2 * half));
    if (f <= 0) { e.wet = false; return; }
    const v = body.linvel(), w = body.angvel(), k = Math.exp(-4 * f * DT);
    if (!e.wet && v.y < -2) events.push({ type: 'splash', x: c.x, y: level, z: c.z, v: -v.y, size: Math.max(hx, hz) });
    e.wet = true;
    let pushX = 0, pushZ = 0, torqueX = 0, torqueY = 0, torqueZ = 0;
    if (surf !== env.pond?.y && env.waveAt) {
      const sx = (env.waveAt(c.x + 1, c.z) - env.waveAt(c.x - 1, c.z)) / 2;
      const sz = (env.waveAt(c.x, c.z + 1) - env.waveAt(c.x, c.z - 1)) / 2;
      pushX = -sx * 2.5 * DT;
      pushZ = -sz * 2.5 * DT;
      vUp.copy(Y).applyQuaternion(o);
      vNorm.set(-sx, 1, -sz).normalize();
      vTau.crossVectors(vUp, vNorm);
      const torqueScale = 4 * f * DT;
      torqueX = vTau.x * torqueScale;
      torqueY = vTau.y * torqueScale;
      torqueZ = vTau.z * torqueScale;
    }
    body.setLinvel({ x: (v.x + pushX) * k, y: (v.y + Math.min(2.5, f / e.draft) * 9.81 * DT) * k, z: (v.z + pushZ) * k }, true);
    body.setAngvel({ x: (w.x + torqueX) * k, y: (w.y + torqueY) * k, z: (w.z + torqueZ) * k }, true);
  }

  // A drum goes up: it's gone, and everything in reach is thrown outward (and a little upward). Drums close by follow.
  function explode(d) {
    const o = d.body.translation(), x = o.x, y = o.y, z = o.z;
    d.live = false; d.fuse = 0;
    d.body.setEnabled(false);
    events.push({ type: 'boom', x, y, z });
    const kick = (body) => {
      if (!body.isEnabled() || !body.isDynamic()) return Infinity;
      const t = body.translation(), dx = t.x - x, dy = t.y - y + 1, dz = t.z - z, dist = Math.hypot(dx, dy, dz), fall = 1 - dist / DRUM.blast;
      if (fall <= 0) return dist;
      const j = Math.min(DRUM.punch * fall * fall, body.mass() * 25) / dist;
      body.applyImpulse({ x: dx * j, y: dy * j, z: dz * j }, true);
      return dist;
    };
    for (const n of drums) if (n.live && kick(n.body) < DRUM.chain) {
      n.body.setAngvel({ x: Math.random() * 12 - 6, y: Math.random() * 12 - 6, z: Math.random() * 12 - 6 }, true);
      n.fuse ||= 0.08 + Math.random() * 0.45;
    }
    for (const e of bodies.values()) kick(e.body);
    kick(craft); kick(tool);
  }

  // Put the drum piles back (a new shift).
  function reset() {
    for (const d of drums) {
      d.body.setEnabled(true);
      d.body.setTranslation(d.home, false);
      d.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      d.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      d.body.sleep();
      d.v.set(0, 0, 0);
      d.live = true; d.wet = false; d.fuse = 0;
    }
  }

  // A moving deck (the freighter's): a kinematic slab loose things land on and ride. deck: { x, y, z, yaw, hw, hl } (y: its top).
  let slab = null, slabKey = '';
  function moveDeck(deck) {
    const key = `${deck.hw} ${deck.hl}`;
    if (key !== slabKey) {
      if (slab) world.removeRigidBody(slab);
      slab = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(deck.x, deck.y - 0.5, deck.z));
      world.createCollider(R.ColliderDesc.cuboid(deck.hw, 0.5, deck.hl).setFriction(1).setCollisionGroups(groups(WORLD, ALL)), slab);
      slabKey = key;
    }
    slab.setNextKinematicTranslation({ x: deck.x, y: deck.y - 0.5, z: deck.z });
    slab.setNextKinematicRotation({ x: 0, y: Math.sin(deck.yaw / 2), z: 0, w: Math.cos(deck.yaw / 2) });
  }

  // One sim step, after stepFlight / stepPlane (skipped while wrecked) and, with fly off, stepRig.
  // loads: everything hookable. s: the aircraft. r: the rig (null without a line). fly: flight physics on.
  // radius: the aircraft's collision sphere. Sets s.hit to the worst knock, s.wreck/s.wreckQ on a crash.
  // env.burning?.(x, z): is the ground on fire there. Returns this step's events: { type: 'boom' | 'splash', x, y, z, ... }.
  function step({ loads, s, r, env, fly, plane, boat, radius, deck }) {
    events.length = 0;
    if (deck) moveDeck(deck);
    time += DT; tick++;
    const isBoat = boat ?? ('steer' in s);
    const isHeli = !plane && !isBoat;
    const mass = (isBoat ? 35 : plane ? 3 : RIG.heliMass) * KG, roped = fly && isHeli && r;
    if (s !== craftS) { craftS = s; craftMode = ''; } // towed home: a fresh aircraft
    const want = s.wreck ? 'wreck' : fly && isHeli ? 'fly' : 'kin';
    if (want !== craftMode || radius !== craftR || isBoat !== craftBoat) setCraft(want, s, radius, mass, isBoat);
    else if (want === 'kin') {
      craft.setNextKinematicTranslation(s.pos);
      craft.setNextKinematicRotation(q.setFromEuler(new THREE.Euler(-(s.pitch || 0), s.yaw || 0, s.roll || 0, 'YXZ')));
    }
    if (want === 'fly') {
      // stepFlight has already moved s.pos by s.vel: replay that move in Rapier, with the rotor carrying the load.
      const lift = r?.taut && massOf(r) <= RIG.maxLift ? (massOf(r) * KG * 9.81 * DT) / mass : 0;
      craft.setTranslation({ x: s.pos.x - s.vel.x * DT, y: s.pos.y - s.vel.y * DT, z: s.pos.z - s.vel.z * DT }, true);
      craft.setRotation(q.setFromEuler(new THREE.Euler(-(s.pitch || 0), s.yaw || 0, s.roll || 0, 'YXZ')), true);
      craft.setLinvel(v0.set(s.vel.x, s.vel.y + lift, s.vel.z), true);
    }

    for (const [c, e] of bodies) if (!loads.includes(c)) {
      if (e.body === jointTo) dropJoint();
      world.removeRigidBody(e.body);
      bodies.delete(c);
    }
    const hook = r?.crate || null;
    for (const c of loads) {
      const e = bodies.get(c) || addLoad(c), body = e.body, mode = c === hook ? (roped ? 'rope' : 'held') : c.held ? 'off' : 'free';
      if (mode !== e.mode) {
        body.setEnabled(mode !== 'off');
        body.setBodyType(mode === 'held' ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Dynamic, true);
        if ((mode === 'free' || mode === 'rope') && e.mode !== 'free' && e.mode !== 'rope') { // pick up from wherever the hook or the mission left it
          body.setTranslation(c.pos, true);
          body.setRotation(c.quat, true);
          body.setLinvel(c.vel, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        e.mode = mode;
      }
      if (mode === 'held') {
        body.setNextKinematicTranslation(c.pos);
        body.setNextKinematicRotation(c.quat);
      }
    }

    // The rope: a joint from the belly to the tool or the hooked load, rebuilt when the winch changes its length.
    const end = roped && (hook ? bodies.get(hook).body : tool);
    tool.setEnabled(!!roped && !hook);
    if (!roped) dropJoint();
    else {
      const hang = hangOf(r);
      r.dLen = 0; // the joint does the winching
      if (!hook) {
        if (toolKind !== r.tool) {
          const rad = Math.min(radiusOf(r), hang / 2);
          toolCol.setShape(new R.Ball(rad));
          toolCol.setTranslationWrtParent({ x: 0, y: rad - hang, z: 0 });
          const dips = r.tool === 'bucket' || r.tool === 'snorkel';
          toolCol.setCollisionGroups(groups(TOOL, dips ? WORLD | LOOSE : WORLD | SEAG | LOOSE));
          toolKind = r.tool;
        }
        if (Math.abs(toolCol.mass() - massOf(r) * KG) > 1) toolCol.setMass(massOf(r) * KG);
        if (p.copy(tool.translation()).distanceTo(r.pos) > 0.5) { tool.setTranslation(r.pos, true); tool.setLinvel(r.vel, true); } // teleported: towed, refitted, swapped
      }
      const key = `${r.len.toFixed(2)} ${RIG.anchor}`;
      if (end !== jointTo) prevLen = r.len;
      if (end !== jointTo || key !== jointKey) {
        dropJoint();
        joint = world.createImpulseJoint(R.JointData.rope(r.len, { x: 0, y: RIG.anchor, z: 0 }, { x: 0, y: 0, z: 0 }), craft, end, true);
        jointTo = end; jointKey = key;
      }
      // Air drag toward the wind, a damped swing relative to the craft, and water drag on a dipped load.
      const v = tv0.copy(end.linvel()), w = env.wind || { x: 0, z: 0 }, k = RIG.airDrag * DT;
      v.x += (w.x - v.x) * k; v.y -= v.y * k; v.z += (w.z - v.z) * k;
      if (r.taut) v.addScaledVector(p.copy(v).sub(s.vel), -RIG.swingDamp * DT);
      if (r.dipped) v.multiplyScalar(Math.exp(-3 * DT));
      // When retracting the winch, pull the bucket/load up toward the anchor instead of letting the joint yank the chopper down.
      if (end === jointTo && prevLen > r.len && !r.overloaded) {
        anchor.set(0, RIG.anchor, 0).applyQuaternion(craft.rotation()).add(craft.translation());
        const d = p.subVectors(end.translation(), anchor), dist = d.length() || 1e-6;
        if (dist > r.len) {
          const dl = Math.min(dist - r.len, prevLen - r.len);
          d.divideScalar(dist);
          end.setTranslation(anchor.addScaledVector(d, dist - dl), true);
          const vAlong = v.dot(d) - s.vel.dot(d);
          if (vAlong > 0) v.addScaledVector(d, -vAlong);
        }
      }
      prevLen = r.len;
      end.setLinvel(v, true);
    }

    // Rotor downwash: pushes drums and loose cargo (not people) out from under a low helicopter.
    if (isHeli && !s.wreck) {
      const power = s.grounded ? 0.3 : 1;
      const blow = (body, size) => {
        if (!body.isEnabled()) return;
        const t = body.translation(), dx = t.x - s.pos.x, dz = t.z - s.pos.z, d = Math.hypot(dx, dz), below = s.pos.y + 1 - t.y;
        if (d > WASH.r || d < 0.1 || below < 0 || below > WASH.h) return;
        const f = WASH.push * size * power * (1 - below / WASH.h) * Math.min(d / 3, (WASH.r - d) / (WASH.r - 3));
        if (f > body.mass() * 1.5) body.applyImpulse({ x: (dx / d) * f * DT, y: 0, z: (dz / d) * f * DT }, true);
      };
      for (const d of drums) if (d.live) blow(d.body, 1);
      for (const [c, e] of bodies) if (e.mode === 'free' && c.spec !== RIG.person) blow(e.body, c.spec.radius);
    }

    // Rescue Cutter waterjet wash, side-thruster wash, and fire monitor water cannon impulse.
    if (isBoat && !s.wreck) {
      const fx = -Math.sin(s.yaw || 0), fz = -Math.cos(s.yaw || 0);
      const rx = Math.cos(s.yaw || 0), rz = -Math.sin(s.yaw || 0);
      const thr = s.throttle || 0;
      const jetPwr = Math.max(0.25, thr > 0 ? thr : 0.25);
      const sway = s.sway || 0;
      const hasJet = !!s.jet;
      const aimA = (s.yaw || 0) + (s.aim || 0);
      const jdx = -Math.sin(aimA), jdz = -Math.cos(aimA);

      const pushBoat = (body, size) => {
        if (!body.isEnabled()) return;
        const t = body.translation();
        const dx = t.x - s.pos.x, dz = t.z - s.pos.z;
        const lx = dx * rx + dz * rz;
        const lz = -(dx * fx + dz * fz);

        // 1. Transom waterjet wash (astern or ahead)
        if (thr >= 0) {
          const dAstern = lz - 10;
          if (dAstern > 0.5 && dAstern < 30) {
            const w = 2.5 + 0.35 * dAstern;
            if (Math.abs(lx) < w) {
              const fall = (1 - dAstern / 30) * (1 - Math.abs(lx) / w);
              const flz = 8000 * jetPwr * fall * size * DT;
              const flx = (lx / w) * 2000 * jetPwr * fall * size * DT;
              body.applyImpulse({ x: flx * rx - flz * fx, y: 0, z: flx * rz - flz * fz }, true);
            }
          }
        } else {
          // Reversing bucket deflects wash forward & outward
          const dAhead = 10 - lz;
          if (dAhead > 0 && dAhead < 20 && Math.abs(lx) < 6) {
            const fall = (1 - dAhead / 20) * Math.abs(thr);
            const flz = -6000 * fall * size * DT;
            const flx = Math.sign(lx || 1) * 2500 * fall * size * DT;
            body.applyImpulse({ x: flx * rx - flz * fx, y: 0, z: flx * rz - flz * fz }, true);
          }
        }

        // 2. Side thruster wash (bow / stern)
        if (sway) {
          const swayDir = -Math.sign(sway);
          const nearThruster = Math.abs(lz + 7.5) < 4 || Math.abs(lz - 7.5) < 4;
          if (nearThruster) {
            const distSide = lx * swayDir - 2.5;
            if (distSide > 0 && distSide < 14) {
              const fall = (1 - distSide / 14) * Math.abs(sway);
              const push = 5000 * fall * size * DT;
              body.applyImpulse({ x: swayDir * push * rx, y: 0, z: swayDir * push * rz }, true);
            }
          }
        }

        // 3. Fire monitor water cannon jet
        if (hasJet) {
          const dStream = dx * jdx + dz * jdz, k = s.jetK ?? 1, reach = 100 * k * k; // the monitors' pressure (s.jetK) sets the arc and where it lands
          if (dStream > 3 && dStream < reach + 3) {
            const dPerp = Math.hypot(dx - dStream * jdx, dz - dStream * jdz);
            const rStream = 2.0 + 0.06 * dStream;
            const tf = dStream / (26 * k);
            const hStream = s.pos.y + 3.5 + 19 * k * tf - 0.5 * 9.81 * tf * tf;
            const hitArc = dPerp < rStream && Math.abs(t.y - hStream) < rStream + 3;
            const hitLand = dStream >= reach * 0.65 && dStream <= reach * 0.96 && dPerp < 7.0 && t.y < 3.0;
            const hitClose = dStream <= 16 && dPerp < 3.8 && t.y < 5.0;
            if (hitArc || hitLand || hitClose) {
              const effR = hitLand ? 7.0 : hitClose ? 3.8 : rStream;
              const fall = (1 - dStream / (reach + 10)) * Math.max(0, 1 - dPerp / effR);
              const push = 12000 * fall * size * DT;
              body.applyImpulse({ x: jdx * push, y: -0.1 * push, z: jdz * push }, true);
            }
          }
        }
      };

      for (const d of drums) if (d.live) pushBoat(d.body, 1);
      for (const [c, e] of bodies) if (e.mode === 'free' && c.spec !== RIG.person) pushBoat(e.body, c.spec.radius);
    }
    for (const d of drums) if (d.live) swim(d, env);
    for (const e of bodies.values()) if (e.mode === 'free' || e.mode === 'rope') swim(e, env);
    if (craftMode === 'wreck') { // a wreck in the sea floods: it floats lower and lower, then goes under
      if (wreckFloat.wet) wreckFloat.draft = Math.min(2, wreckFloat.draft + 0.15 * DT);
      swim(wreckFloat, env);
    }

    world.step();

    // Drums: a hard knock sets one off at once, a fire under it after a moment.
    drums.forEach((d, i) => {
      if (!d.live) return;
      const v = d.body.linvel(), jolt = Math.hypot(v.x - d.v.x, v.y - d.v.y, v.z - d.v.z);
      d.v.copy(v);
      if (!d.fuse && jolt > DRUM.pop) d.fuse = DT;
      else if (!d.fuse && (tick + i) % 30 === 0 && env.burning) { const t = d.body.translation(); if (env.burning(t.x, t.z)) d.fuse = 0.5 + Math.random() * 2.5; }
      if (d.fuse && (d.fuse -= DT) <= 0) explode(d);
    });

    s.hit = s.hit || 0;
    if (craftMode !== 'kin') {
      const v = craft.linvel();
      if (craftMode === 'fly') {
        const dvx = v.x - s.vel.x, dvy = v.y - s.vel.y, dvz = v.z - s.vel.z, dv = Math.hypot(dvx, dvy, dvz);
        if (roped && r.taut && !r.overloaded && dv < 6) {
          // Smooth gentle rope-joint tug (especially vertical bounce) around s.vel without keeping the pre-load lift offset.
          v.x = s.vel.x + dvx * 0.65;
          v.y = s.vel.y + dvy * 0.35;
          v.z = s.vel.z + dvz * 0.65;
        } else s.hit = Math.max(s.hit, Math.hypot(v.x - v0.x, v.y - v0.y, v.z - v0.z));
      }
      s.pos.copy(craft.translation());
      s.vel.copy(v);
    }
    if (craftMode === 'wreck') { s.wreckQ.copy(craft.rotation()); s.grounded = false; }

    // Loose loads (and the one on the rope) take their pose from Rapier; hit is this step's jolt (impact speed).
    for (const [c, e] of bodies) {
      if (e.mode !== 'free' && e.mode !== 'rope') continue;
      const v = e.body.linvel();
      c.hit = Math.hypot(v.x - c.vel.x, v.y - c.vel.y, v.z - c.vel.z);
      c.vel.copy(v);
      c.pos.copy(e.body.translation());
      c.quat.copy(e.body.rotation());
      c.up.copy(Y).applyQuaternion(c.quat);
    }

    if (roped) {
      // Back into the rig: rope end, dipping (the bucket sinks a metre to scoop), tautness, then water and slosh.
      const hang = hangOf(r), v = end.linvel();
      r.prev.copy(r.pos);
      r.pos.copy(end.translation());
      const surf = surfaceUnder(r.pos, env);
      if (surf !== null && !hook && (r.tool === 'bucket' || r.tool === 'snorkel') && r.pos.y - hang < surf - 1.2) {
        r.pos.y = surf - 1.2 + hang; v.y = Math.max(0, v.y);
        end.setTranslation(r.pos, true); end.setLinvel(v, true);
      }
      r.dipped = surf !== null && r.pos.y - hang < surf;
      r.hit = Math.hypot(v.x - tv0.x, v.y - tv0.y, v.z - tv0.z);
      r.vel.copy(v);
      anchor.set(0, RIG.anchor, 0).applyQuaternion(craft.rotation()).add(craft.translation());
      const d = p.subVectors(r.pos, anchor), len = d.length() || 1e-6;
      d.divideScalar(len);
      r.taut = len >= r.len - 0.05;
      r.overloaded = !!hook && massOf(r) > RIG.maxLift;
      settleRig(r, s, DT, d.x, d.y, d.z);
    }

    // A crash: the aircraft lets go of its load and tumbles.
    if (fly && !s.wreck && s.hit > CRASH) {
      s.wreck = true;
      s.wreckQ = new THREE.Quaternion();
      setCraft('wreck', s, radius, mass);
    }
    return events;
  }

  function render() {
    drums.forEach((d, i) => drumMesh.setMatrixAt(i, d.live ? m.compose(p.copy(d.body.translation()), q.copy(d.body.rotation()), one) : m.makeScale(0, 0, 0)));
    drumMesh.instanceMatrix.needsUpdate = true;
  }

  world.step(); // the first step builds the broad phase (~50 ms): take that hitch while loading, not mid-flight
  return { step, render, reset };
}
