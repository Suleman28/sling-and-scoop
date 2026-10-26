import * as THREE from 'three';
import { BASE, fuelAt, groundAt, heightAt, mulberry32, PAD_RADIUS, SITES } from './world.js';
import { cellOf, FIRE, fireStatus, ignite } from './fire.js';
import { buildHeavyMesh, buildCrateMesh, buildPersonMesh, createCrate, RIG } from './tools.js';

const HOSPITAL = SITES.find((s) => s.hospital);
const STOPS = [BASE, ...SITES];
const COLOR = { fire: 0xff5a2a, cargo: 0xffc93c, rescue: 0x4fd6ff };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// Shift tuning. Chaos fills to 100 from whatever is left unattended; the shift ends when it's full.
export const SHIFT = {
  maxCalls: 5,
  firePressure: 0.025,        // chaos/s per burning cell (half for the fire you're working)
  rescuePressure: 0.12,       // chaos/s per waiting casualty (half while it's your active job)
  cargoPressure: 0.04,        // chaos/s per waiting delivery (half while active)
  houseChaos: 6, lostChaos: 15, expireChaos: 6,
  relief: 8,                  // chaos removed per completed job
  rescueTimeout: 180, cargoTimeout: 150,
  comboWindow: 80, comboStep: 0.25, comboMax: 3,
};
// Director ramps up: shorter gaps, more simultaneous calls, more simultaneous fires.
const spawnGap = (t) => Math.max(10, 28 - t / 12);
const callCap = (t) => Math.min(SHIFT.maxCalls, 2 + Math.floor(t / 75));
const fireCap = (t, big) => (big ? Math.min(3, 1 + Math.floor(t / 150)) : Math.min(2, 1 + Math.floor(t / 300)));
export const comboMult = (combo) => Math.min(SHIFT.comboMax, 1 + SHIFT.comboStep * Math.max(0, combo - 1));

// One shift. seed drives every director choice (type, place, timing), so a daily seed gives everyone the same shift.
// world: { scene, fire, houses, crates, can?, bigFires? } where crates is the shared list of hookable loads,
// can(type) says whether the current airframe can do that kind of job (the director only sends those), and
// bigFires() says the fleet has a water bomber: until then fires are small and rarer; after, some are major.
export function createDispatch(world, seed) {
  return {
    can: () => true, bigFires: () => false, ...world, rng: mulberry32(seed), calls: [], job: null, t: 0, spawnT: 3, nextId: 1,
    chaos: 0, combo: 0, comboT: 0, over: false,
    stats: { earned: 0, done: { fire: 0, cargo: 0, rescue: 0 }, bestCombo: 0, housesLost: 0, lost: 0 },
    view: buildMarkers(world.scene),
  };
}

const pick = (d, arr) => arr[Math.floor(d.rng() * arr.length)];
const incidents = (d) => (d.job ? [d.job, ...d.calls] : d.calls);

function addLoad(d, load, mesh) {
  load.mesh = mesh;
  d.scene.add(mesh);
  d.crates.push(load);
  return load;
}
function removeLoad(d, load) {
  d.scene.remove(load.mesh);
  d.crates.splice(d.crates.indexOf(load), 1);
}

// Remove everything this shift put in the world (crates, casualties, markers).
export function disposeDispatch(d) {
  for (const l of [...d.crates]) removeLoad(d, l);
  for (const m of Object.values(d.view)) d.scene.remove(m);
}

function spawn(d) {
  const fires = incidents(d).filter((j) => j.type === 'fire').length;
  const big = d.bigFires(), types = (fires < fireCap(d.t, big) ? ['fire', 'cargo', 'rescue'] : ['cargo', 'rescue']).filter(d.can);
  if (!types.length) return null; // nothing this airframe can do right now (e.g. bomber at its fire cap)
  const fresh = types.filter((t) => !d.calls.some((o) => o.type === t));
  let type = pick(d, fresh.length ? fresh : types);
  if (type === 'fire' && !big && types.length > 1 && d.rng() < 0.5) type = pick(d, types.filter((t) => t !== 'fire')); // helicopter-only fleets: fires half as often
  const id = d.nextId++, base = { id, type, age: 0 };
  if (type === 'fire') {
    // Forest a few hundred metres from a town, so it threatens houses if left alone.
    for (let i = 0; i < 200; i++) {
      const site = pick(d, SITES), a = d.rng() * Math.PI * 2, r = 150 + d.rng() * 300;
      const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r, c = cellOf(x, z);
      if (fuelAt(x, z) < 0.75 || !ignite(d.fire, c, id)) continue;
      // Small fires (the only kind before the bomber) spread slowly; major ones start wide and run fast.
      const major = big && d.rng() < 0.5;
      d.fire.rate.set(id, major ? 1.5 : big ? 1 : 0.7);
      for (const [di, dj] of major ? [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] : [[1, 0], [0, 1]]) ignite(d.fire, c + di + dj * FIRE.n, id);
      return { ...base, title: `${major ? 'Major wildfire' : 'Wildfire'} near ${site.name}`, major, x, z, reward: major ? 1200 : 450, burnt: 0, housesLost: 0 };
    }
    return null;
  }
  if (type === 'cargo') {
    // A quarter are heavy loads (container, wrecked vehicle, prefab cabin): big pay, but they need the lift of the
    // Heavy Lifter (a maxed Utility can just manage a container). Optional: no chaos while waiting, expiring doesn't break your chain.
    const from = pick(d, STOPS), to = pick(d, STOPS.filter((s) => s !== from)), heavy = d.rng() < 0.25 ? pick(d, ['container', 'vehicle', 'cabin']) : null;
    const fragile = !heavy && d.rng() < 0.3;
    const reward = Math.round(((120 + dist(from, to) * 0.25) * (heavy ? RIG[heavy].pay : fragile ? 1.6 : 1)) / 10) * 10;
    return { ...base, title: `${heavy ? RIG[heavy].label : fragile ? 'Fragile cargo' : 'Cargo'}: ${from.name} → ${to.name}`, from, to, heavy, fragile, reward, x: from.x, z: from.z };
  }
  // Rescue: a hiker high on the island, or a boater adrift offshore.
  const boater = d.rng() < 0.5;
  for (let i = 0; i < 400; i++) {
    let x, z;
    if (boater) { const a = d.rng() * Math.PI * 2, r = 950 + d.rng() * 350; x = Math.cos(a) * r; z = Math.sin(a) * r; if (heightAt(x, z) > -8) continue; }
    else {
      x = (d.rng() - 0.5) * 1600; z = (d.rng() - 0.5) * 1600;
      const y = heightAt(x, z);
      if (y < 40 || y > 150 || [[20, 0], [0, 20], [-20, 0], [0, -20]].some(([dx, dz]) => Math.abs(heightAt(x + dx, z + dz) - y) > 6)) continue;
    }
    const mesh = buildPersonMesh();
    if (boater) mesh.add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.35, 8).translate(0, -1.9, 0), new THREE.MeshLambertMaterial({ color: 0xff6a2a, flatShading: true })));
    const person = addLoad(d, createCrate(x, groundAt(x, z), z, RIG.person), mesh);
    const reward = Math.round((250 + dist(person.pos, HOSPITAL) * 0.25) / 10) * 10;
    return { ...base, title: boater ? 'Boater adrift' : 'Hiker stranded', boater, person, reward, x, z };
  }
  return null;
}

export function accept(d, i) {
  if (d.job || !d.calls[i]) return null;
  const job = (d.job = d.calls.splice(i, 1)[0]);
  if (job.type === 'cargo' && !job.crate) {
    const a = d.rng() * Math.PI * 2, x = job.from.x + Math.cos(a) * 17, z = job.from.z + Math.sin(a) * 17;
    job.crate = job.heavy ? addLoad(d, createCrate(x, groundAt(x, z), z, RIG[job.heavy]), buildHeavyMesh(job.heavy)) : addLoad(d, createCrate(x, groundAt(x, z), z), buildCrateMesh());
    job.worstHit = 0;
  }
  return job;
}

// Back on the board as it is (a crate stays where you left it; a casualty aboard is set down here).
export function abandon(d) {
  const job = d.job;
  if (!job) return;
  if (job.person?.aboard) { job.person.aboard = job.person.held = false; job.person.mesh.visible = true; }
  d.calls.unshift(job);
  d.job = null;
}

// Objective position and text for the active job.
export function objective(d) {
  const j = d.job;
  if (!j) return null;
  if (j.type === 'fire') {
    const f = fireStatus(d.fire, j.id);
    return { x: f.n ? f.x : j.x, z: f.n ? f.z : j.z, text: `${j.title}: ${f.n} cells burning. Scoop sea water and dump it on the flames` };
  }
  if (j.type === 'cargo') {
    if (!j.crate.held && dist(j.crate.pos, j.to) > 14) return { x: j.crate.pos.x, z: j.crate.pos.z, text: `Hook the ${j.heavy ? RIG[j.heavy].cargo : 'crate'} at ${j.from.name} (R for the hook)${j.heavy && RIG.maxLift < RIG[j.heavy].mass ? '. Too heavy for this airframe' : ''}` };
    return { x: j.to.x, z: j.to.z, ring: true, text: `Deliver to ${j.to.name}: set it down gently in the ring${j.fragile ? '. FRAGILE' : ''}` };
  }
  const p = j.person;
  if (!p.aboard && !p.held) return { x: p.pos.x, z: p.pos.z, text: `${j.title}: land nearby to pick them up${j.boater && d.can('cargo') ? ', or hook them' : ''}` };
  return { x: HOSPITAL.x, z: HOSPITAL.z, ring: true, text: `Fly them to ${HOSPITAL.name}${p.held && !p.aboard ? ': lower them into the ring' : ': land on the pad'}` };
}

// A burnt-out cell: charge it to the fire that burned it.
export function onScorch(d, c) {
  const inc = incidents(d).find((j) => j.type === 'fire' && j.id === d.fire.owner[c]);
  if (inc) inc.burnt++;
}

// Per-frame: director, chaos, combo, pickups, deliveries, house fires. say(msg, minor) flashes a message.
export function updateDispatch(d, dt, s, say) {
  if (d.over) return;
  d.t += dt;
  const st = d.stats;

  const finish = (j, n, msg) => {
    d.combo = d.comboT > 0 ? d.combo + 1 : 1;
    d.comboT = SHIFT.comboWindow;
    st.bestCombo = Math.max(st.bestCombo, d.combo);
    const m = comboMult(d.combo), paid = Math.round(n * m);
    st.earned += paid;
    st.done[j.type]++;
    d.chaos = Math.max(0, d.chaos - SHIFT.relief);
    say(`${msg}  +$${paid}${m > 1 ? `  (combo ×${m.toFixed(2)})` : ''}`);
    if (d.job === j) d.job = null;
  };
  const fail = (j, msg, chaos) => {
    d.combo = 0;
    d.comboT = 0;
    d.chaos += chaos;
    say(msg);
    if (d.job === j) d.job = null;
    else d.calls.splice(d.calls.indexOf(j), 1);
  };

  if ((d.spawnT -= dt) <= 0 && d.calls.length < callCap(d.t)) {
    const o = spawn(d);
    if (o) { d.calls.push(o); say(`New call: ${o.title}`, true); }
    d.spawnT = spawnGap(d.t) * (0.7 + d.rng() * 0.6);
  }
  d.comboT = Math.max(0, d.comboT - dt);

  for (const h of d.houses) {
    const c = cellOf(h.x, h.z);
    if (h.burnt || d.fire.heat[c] < 0.6) continue;
    h.burnt = true;
    for (const m of h.mats) m.color.set(0x3a302c);
    const inc = incidents(d).find((j) => j.id === d.fire.owner[c]);
    if (inc) inc.housesLost++;
    st.housesLost++;
    d.chaos += SHIFT.houseChaos;
    say(`A house in ${h.site.name} burned down!`);
  }

  // Pressure from everything still out there; the job you're on counts half.
  for (const j of incidents(d)) {
    j.age += dt;
    const active = j === d.job ? 0.5 : 1;
    if (j.type === 'fire') d.chaos += fireStatus(d.fire, j.id).n * SHIFT.firePressure * active * dt;
    else if (!j.heavy) d.chaos += (j.type === 'rescue' ? SHIFT.rescuePressure : SHIFT.cargoPressure) * active * dt;
  }

  // Unattended calls expire; an ignored fire can burn itself out.
  for (const j of [...d.calls]) {
    if (j.type === 'rescue' && j.age > SHIFT.rescueTimeout) { removeLoad(d, j.person); st.lost++; fail(j, `Too late: ${j.title.toLowerCase()} was lost`, SHIFT.lostChaos); }
    else if (j.type === 'cargo' && j.age > SHIFT.cargoTimeout) {
      if (j.crate) removeLoad(d, j.crate);
      if (j.heavy) { d.calls.splice(d.calls.indexOf(j), 1); say(`Contract went elsewhere: ${j.title}`, true); }
      else fail(j, `Delivery cancelled: ${j.title}`, SHIFT.expireChaos);
    }
    else if (j.type === 'fire' && !fireStatus(d.fire, j.id).n) { d.calls.splice(d.calls.indexOf(j), 1); say(`${j.title} burned itself out: ${j.burnt} cells lost`); }
  }

  const j = d.job;
  if (j?.type === 'fire' && !fireStatus(d.fire, j.id).n) {
    finish(j, Math.max(100, j.reward - j.burnt * 8 - j.housesLost * 120), `Fire out! ${j.burnt} cells lost${j.housesLost ? `, ${j.housesLost} houses` : ''}.`);
  } else if (j?.type === 'cargo') {
    const c = j.crate;
    j.worstHit = c.held ? 0 : Math.max(j.worstHit, c.hit);
    const resting = !c.held && c.vel.lengthSq() < 0.05 && c.pos.y - c.spec.hang - groundAt(c.pos.x, c.pos.z) < 0.05;
    if (resting && dist(c.pos, j.to) < 14) {
      const rough = j.worstHit > (j.fragile ? 5 : 9);
      removeLoad(d, c);
      if (rough && j.fragile) fail(j, 'Fragile cargo smashed. No pay, combo lost.', SHIFT.expireChaos);
      else finish(j, rough ? Math.round(j.reward * 0.4) : j.reward, rough ? 'Cargo delivered, but damaged.' : 'Cargo delivered!');
    }
  } else if (j?.type === 'rescue') {
    const p = j.person;
    if (!p.held && s.grounded && dist(s.pos, p.pos) < 25) {
      if ((j.boardT = (j.boardT || 0) + dt) > 1.5) { p.aboard = p.held = true; p.mesh.visible = false; say('Casualty aboard'); }
    } else j.boardT = 0;
    if (p.aboard) p.pos.copy(s.pos); // rides along (hidden) so abandoning sets them down where you are
    if (p.aboard && s.grounded && dist(s.pos, HOSPITAL) < PAD_RADIUS + 4) { removeLoad(d, p); finish(j, j.reward, 'Casualty delivered to hospital!'); }
    else if (!p.held && dist(p.pos, HOSPITAL) < 16 && p.vel.lengthSq() < 0.05) {
      removeLoad(d, p);
      finish(j, p.hit > 8 ? Math.round(j.reward / 2) : j.reward, p.hit > 8 ? 'Delivered, but that landing hurt.' : 'Casualty delivered to hospital!');
    }
  }

  if (d.chaos >= 100) { d.chaos = 100; d.over = true; }
}

// ---- Markers: a light beacon at the objective, a ring for drop zones, and an arrow over the chopper. ----

function buildMarkers(scene) {
  const glow = (geo, opacity) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const beacon = glow(new THREE.CylinderGeometry(2.5, 2.5, 400, 8, 1, true).translate(0, 200, 0), 0.22);
  const ring = glow(new THREE.RingGeometry(12, 14, 32).rotateX(-Math.PI / 2), 0.7);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ fog: false }));
  scene.add(beacon, ring, arrow);
  return { beacon, ring, arrow };
}

// view: interpolated chopper position. Returns the objective (or null).
export function updateMarkers(d, view) {
  const { beacon, ring, arrow } = d.view, o = objective(d);
  beacon.visible = ring.visible = arrow.visible = !!o;
  if (!o) return null;
  const color = COLOR[d.job.type];
  for (const m of [beacon, ring, arrow]) m.material.color.set(color);
  beacon.position.set(o.x, groundAt(o.x, o.z), o.z);
  ring.visible = !!o.ring;
  ring.position.set(o.x, groundAt(o.x, o.z) + 0.3, o.z);
  const dx = o.x - view.x, dz = o.z - view.z, far = Math.hypot(dx, dz);
  arrow.visible = far > 40;
  arrow.position.set(view.x + (dx / far) * 5, view.y + 6, view.z + (dz / far) * 5);
  arrow.rotation.set(0, Math.atan2(-dx, -dz), 0);
  o.dist = far;
  return o;
}
