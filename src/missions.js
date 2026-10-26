import * as THREE from 'three';
import { BASE, fuelAt, groundAt, heightAt, mulberry32, PAD_RADIUS, ROADS, SITES } from './world.js';
import { cellOf, FIRE, fireStatus, ignite } from './fire.js';
import { bodyBaker, DARK, GLASS } from './chopper.js';
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
  houseBurn: 75,              // seconds a house can stand in full flame before it's lost
  relief: 8,                  // chaos removed per completed job
  rescueTimeout: 180, cargoTimeout: 150,
  comboWindow: 60, comboStep: 0.25, comboMax: 3, // window: time to take the next call (it only runs while you're free and calls are waiting)
};
// Fire classes. A fire is never bigger than what you're flying can put out: power is water per load
// (Utility bucket 1, Heavy Lifter 2.8, bomber 6; more with upgrades).
const FIRES = [
  { name: 'Wildfire', power: 0, rate: 0.6, seed: [[1, 0]], reward: 400 },
  { name: 'Large wildfire', power: 2, rate: 1, seed: [[1, 0], [0, 1], [-1, 0], [0, -1]], reward: 750 },
  { name: 'Major wildfire', power: 5, rate: 1.5, seed: [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]], reward: 1200 },
];
const GOODS = { hospital: ['Medical supplies', 'Oxygen cylinders', 'Blood supplies'], town: ['Groceries', 'Building materials', 'A generator', 'Water tanks', 'Mail'], base: ['Spare parts', 'Fuel drums'] };
const FRAGILE = ['Medical supplies', 'Blood supplies'];
// Director ramps up: shorter gaps, more simultaneous calls, more simultaneous fires.
const spawnGap = (t) => Math.max(10, 28 - t / 12);
const callCap = (t) => Math.min(SHIFT.maxCalls, 2 + Math.floor(t / 75));
const fireCap = (t, big) => (big ? Math.min(3, 1 + Math.floor(t / 150)) : Math.min(2, 1 + Math.floor(t / 300)));
export const comboMult = (combo) => Math.min(SHIFT.comboMax, 1 + SHIFT.comboStep * Math.max(0, combo - 1));

// One shift. seed drives every director choice (type, place, timing).
// world: { scene, fire, houses, crates, can?, firepower? } where crates is the shared list of hookable loads,
// can(type) says whether the current airframe can do that kind of job (the director only sends those), and
// firepower() is its water per load, which caps how big a wildfire gets.
export function createDispatch(world, seed) {
  for (const h of world.houses) h.burnT = 0;
  return {
    can: () => true, firepower: () => 1, ...world, rng: mulberry32(seed), calls: [], job: null, t: 0, spawnT: 3, nextId: 1, props: [],
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

// Scenery a call brings (a crashed or burning car), removed when the call ends.
function addProp(d, j, mesh) {
  j.prop = mesh;
  d.props.push(mesh);
  d.scene.add(mesh);
}
function closeCall(d, j) {
  if (j.prop) { d.scene.remove(j.prop); d.props.splice(d.props.indexOf(j.prop), 1); }
}
function carMesh(color) {
  const b = bodyBaker();
  b.add(new THREE.BoxGeometry(1.8, 0.7, 4.2), color, 0, 0.75, 0);
  b.add(new THREE.BoxGeometry(1.6, 0.6, 2.1), GLASS, 0, 1.4, 0.2);
  b.add(new THREE.BoxGeometry(1.66, 0.1, 2.16), color, 0, 1.74, 0.2);
  for (const sx of [-1, 1]) for (const sz of [-1.35, 1.35]) b.add(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 8).rotateZ(Math.PI / 2), DARK, sx * 0.85, 0.38, sz);
  return new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}
const nearestSite = (x, z) => SITES.reduce((a, b) => (Math.hypot(a.x - x, a.z - z) < Math.hypot(b.x - x, b.z - z) ? a : b));
// A spot on a road away from the towns and base: { x, z, y, yaw, near }.
function roadSpot(d) {
  for (let i = 0; i < 50; i++) {
    const r = pick(d, ROADS), k = 2 + Math.floor(d.rng() * (r.length - 4)), [x, z, y] = r[k], [x1, z1] = r[k + 1];
    if ([BASE, ...SITES].some((s) => Math.hypot(s.x - x, s.z - z) < 90)) continue;
    return { x, z, y, yaw: Math.atan2(x1 - x, z1 - z), near: nearestSite(x, z).name };
  }
  return null;
}

// Remove everything this shift put in the world (crates, casualties, props, markers).
export function disposeDispatch(d) {
  for (const l of [...d.crates]) removeLoad(d, l);
  for (const m of [...d.props, ...Object.values(d.view)]) d.scene.remove(m);
}

function spawn(d) {
  const fires = incidents(d).filter((j) => j.type === 'fire').length, power = d.firepower();
  const big = power >= FIRES[2].power, types = (fires < fireCap(d.t, big) ? ['fire', 'cargo', 'rescue'] : ['cargo', 'rescue']).filter(d.can);
  if (!types.length) return null; // nothing this airframe can do right now (e.g. bomber at its fire cap)
  const fresh = types.filter((t) => !d.calls.some((o) => o.type === t));
  let type = pick(d, fresh.length ? fresh : types);
  if (type === 'fire' && !big && types.length > 1 && d.rng() < 0.4) type = pick(d, types.filter((t) => t !== 'fire')); // helicopters: fires a little rarer
  const id = d.nextId++, base = { id, type, age: 0 }, roll = d.rng();
  if (type === 'fire') {
    // A house on fire in town: put it out before it burns down (SHIFT.houseBurn). Spreads slowly into the gardens.
    const standing = d.houses.filter((h) => !h.burnt && !incidents(d).some((j) => j.house === h));
    if (roll < 0.3 && standing.length) {
      const h = pick(d, standing);
      if (ignite(d.fire, cellOf(h.x, h.z), id)) {
        d.fire.rate.set(id, 0.3);
        return { ...base, title: h.site.hospital ? `Fire at ${h.site.name}` : `House fire in ${h.site.name}`, house: h, x: h.x, z: h.z, reward: 450, burnt: 0, housesLost: 0 };
      }
    }
    // A car alight on a road: catch it before it sets the verges going.
    const spot = roll < 0.5 && roadSpot(d);
    if (spot && ignite(d.fire, cellOf(spot.x, spot.z), id)) {
      d.fire.rate.set(id, 0.4);
      const j = { ...base, title: `Car fire near ${spot.near}`, x: spot.x, z: spot.z, reward: 350, burnt: 0, housesLost: 0 };
      const car = carMesh(0x3a302c);
      car.position.set(spot.x, spot.y + 0.25, spot.z);
      car.rotation.y = spot.yaw;
      addProp(d, j, car);
      return j;
    }
    // Wildfire in forest a few hundred metres from a town, sized to what you're flying (the biggest you can fight, often).
    const fits = FIRES.filter((f) => power >= f.power), cls = d.rng() < 0.6 ? fits[fits.length - 1] : pick(d, fits);
    for (let i = 0; i < 200; i++) {
      const site = pick(d, SITES), a = d.rng() * Math.PI * 2, r = 150 + d.rng() * 300;
      const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r, c = cellOf(x, z);
      if (fuelAt(x, z) < 0.75 || !ignite(d.fire, c, id)) continue;
      d.fire.rate.set(id, cls.rate);
      for (const [di, dj] of cls.seed) ignite(d.fire, c + di + dj * FIRE.n, id);
      return { ...base, title: `${cls.name} near ${site.name}`, major: cls === FIRES[2], x, z, reward: cls.reward, burnt: 0, housesLost: 0 };
    }
    return null;
  }
  if (type === 'cargo') {
    // Heavy jobs (a quarter): a wrecked car off a road to base, or a container/cabin from base to a town. Big pay, but
    // they need the Heavy Lifter (a maxed Utility can just manage a container). Optional: no chaos while waiting,
    // expiring doesn't break your chain. Otherwise named goods go where they'd be needed.
    if (roll < 0.25) {
      const heavy = pick(d, ['container', 'vehicle', 'cabin']), spot = heavy === 'vehicle' && roadSpot(d);
      const from = spot ? { x: spot.x, z: spot.z, name: `the road near ${spot.near}`, exact: true } : BASE, to = spot ? BASE : pick(d, SITES.filter((s) => !s.hospital));
      if (heavy === 'vehicle' && !spot) return null;
      const reward = Math.round(((120 + dist(from, to) * 0.25) * RIG[heavy].pay) / 10) * 10;
      return { ...base, title: `${RIG[heavy].label}: ${from.name} → ${to.name}`, from, to, heavy, reward, x: from.x, z: from.z };
    }
    const to = pick(d, [BASE, ...SITES]), kind = to.hospital ? 'hospital' : to === BASE ? 'base' : 'town';
    const from = pick(d, [BASE, ...SITES].filter((s) => s !== to));
    const goods = pick(d, GOODS[kind]), fragile = FRAGILE.includes(goods);
    const reward = Math.round(((120 + dist(from, to) * 0.25) * (fragile ? 1.6 : 1)) / 10) * 10;
    return { ...base, title: `${goods}: ${from.name} → ${to.name}`, from, to, fragile, reward, x: from.x, z: from.z };
  }
  // Rescue: a hiker high on the island, a boater adrift, a crash on a road, or a patient to move to the hospital.
  if (roll < 0.25) {
    const spot = roadSpot(d);
    if (!spot) return null;
    const j = { ...base, title: `Car crash near ${spot.near}`, reward: 0 };
    const car = carMesh(pick(d, [0x2f7c7a, 0xd8a83a, 0xb84a39, 0xe8e2d6]));
    car.position.set(spot.x, spot.y + 0.25, spot.z);
    car.rotation.set(0, spot.yaw + 0.7, 0.12); // skewed across the road
    addProp(d, j, car);
    const px = spot.x + Math.cos(spot.yaw) * 4, pz = spot.z - Math.sin(spot.yaw) * 4;
    j.person = addLoad(d, createCrate(px, groundAt(px, pz), pz, RIG.person), buildPersonMesh(false));
    Object.assign(j, { x: px, z: pz, reward: Math.round((280 + dist(j.person.pos, HOSPITAL) * 0.25) / 10) * 10 });
    return j;
  }
  if (roll < 0.45) {
    const site = pick(d, SITES.filter((s) => !s.hospital)), a = d.rng() * Math.PI * 2, x = site.x + Math.cos(a) * 15, z = site.z + Math.sin(a) * 15;
    const person = addLoad(d, createCrate(x, groundAt(x, z), z, RIG.person), buildPersonMesh(false));
    return { ...base, title: `Patient transfer: ${site.name} → hospital`, person, reward: Math.round((150 + dist(site, HOSPITAL) * 0.2) / 10) * 10, x, z };
  }
  const boater = roll < 0.72;
  for (let i = 0; i < 400; i++) {
    let x, z;
    if (boater) { const a = d.rng() * Math.PI * 2, r = 950 + d.rng() * 350; x = Math.cos(a) * r; z = Math.sin(a) * r; if (heightAt(x, z) > -8) continue; }
    else {
      x = (d.rng() - 0.5) * 1600; z = (d.rng() - 0.5) * 1600;
      const y = heightAt(x, z);
      if (y < 40 || y > 150 || [[20, 0], [0, 20], [-20, 0], [0, -20]].some(([dx, dz]) => Math.abs(heightAt(x + dx, z + dz) - y) > 6)) continue;
    }
    const person = addLoad(d, createCrate(x, groundAt(x, z), z, RIG.person), buildPersonMesh(boater));
    const reward = Math.round((250 + dist(person.pos, HOSPITAL) * 0.25) / 10) * 10;
    return { ...base, title: boater ? 'Boater adrift' : 'Hiker stranded', boater, person, reward, x, z };
  }
  return null;
}

export function accept(d, i) {
  if (d.job || !d.calls[i]) return null;
  const job = (d.job = d.calls.splice(i, 1)[0]);
  job.chained = d.comboT > 0; // taken inside the window: finishing it extends the chain
  if (job.type === 'cargo' && !job.crate) {
    const a = d.rng() * Math.PI * 2, r = job.from.exact ? 0 : 17, x = job.from.x + Math.cos(a) * r, z = job.from.z + Math.sin(a) * r;
    job.crate = job.heavy ? addLoad(d, createCrate(x, groundAt(x, z), z, RIG[job.heavy]), buildHeavyMesh(job.heavy)) : addLoad(d, createCrate(x, groundAt(x, z), z), buildCrateMesh());
    job.worstHit = 0;
  }
  return job;
}

// Back on the board as it is (a crate stays where you left it; a casualty aboard is set down here). Breaks the chain.
export function abandon(d) {
  const job = d.job;
  if (!job) return;
  d.combo = d.comboT = 0;
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
    const left = j.house && !j.house.burnt ? ` · ${Math.ceil(SHIFT.houseBurn - j.house.burnT)} s before the house is lost` : '';
    return { x: f.n ? f.x : j.x, z: f.n ? f.z : j.z, text: `${j.title}: ${f.n} cells burning${left}. Scoop sea water and dump it on the flames` };
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
    closeCall(d, j);
    d.combo = j.chained ? d.combo + 1 : 1;
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
    closeCall(d, j);
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
  if (!d.job && d.calls.length) d.comboT = Math.max(0, d.comboT - dt); // the window waits while you work or the board is empty
  if (!d.comboT && !d.job) d.combo = 0;

  // A house in full flame for SHIFT.houseBurn seconds is lost (cooling down slowly buys the time back).
  for (const h of d.houses) {
    const c = cellOf(h.x, h.z);
    if (h.burnt) continue;
    h.burnT = d.fire.heat[c] >= 0.6 ? h.burnT + dt : Math.max(0, h.burnT - dt * 0.5);
    if (h.burnT < SHIFT.houseBurn) continue;
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
      if (j.heavy) { closeCall(d, j); d.calls.splice(d.calls.indexOf(j), 1); say(`Contract went elsewhere: ${j.title}`, true); }
      else fail(j, `Delivery cancelled: ${j.title}`, SHIFT.expireChaos);
    }
    else if (j.type === 'fire' && !fireStatus(d.fire, j.id).n) { closeCall(d, j); d.calls.splice(d.calls.indexOf(j), 1); say(`${j.title} burned itself out: ${j.burnt} cells lost`); }
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

// ---- Markers: a light beacon at the objective and a ring for drop zones (the HUD compass points the way). ----

function buildMarkers(scene) {
  const glow = (geo, opacity) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const beacon = glow(new THREE.CylinderGeometry(2.5, 2.5, 400, 8, 1, true).translate(0, 200, 0), 0.22);
  const ring = glow(new THREE.RingGeometry(12, 14, 32).rotateX(-Math.PI / 2), 0.7);
  scene.add(beacon, ring);
  return { beacon, ring };
}

// view: interpolated chopper position. Returns the objective (or null).
export function updateMarkers(d, view) {
  const { beacon, ring } = d.view, o = objective(d);
  beacon.visible = ring.visible = !!o;
  if (!o) return null;
  const color = COLOR[d.job.type];
  for (const m of [beacon, ring]) m.material.color.set(color);
  beacon.position.set(o.x, groundAt(o.x, o.z), o.z);
  ring.visible = !!o.ring;
  ring.position.set(o.x, groundAt(o.x, o.z) + 0.3, o.z);
  o.dist = Math.hypot(o.x - view.x, o.z - view.z);
  return o;
}
