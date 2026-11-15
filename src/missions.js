import * as THREE from 'three';
import { BASE, fuelAt, groundAt, HARBOUR, heightAt, mulberry32, OILRIG, PAD_RADIUS, ROADS, SITES } from './world.js';
import { cellOf, extinguish, FIRE, fireStatus, ignite } from './fire.js';
import { bodyBaker, DARK, GLASS } from './chopper.js';
import { COSTS } from './career.js';
import { buildHeavyMesh, buildCrateMesh, buildPersonMesh, createCrate, RIG } from './tools.js';

const HOSPITAL = SITES.find((s) => s.hospital);
const STOPS = [BASE, ...SITES];
const COLOR = { fire: 0xff5a2a, cargo: 0xffc93c, rescue: 0x4fd6ff, spot: 0xff9a4a };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const CLINICS = SITES.filter((s) => !s.hospital), nearestClinic = (p) => CLINICS.reduce((a, b) => (dist(a, p) < dist(b, p) ? a : b));

// Shift tuning. Chaos fills to 100 from whatever is left unattended; the shift ends when it's full.
export const SHIFT = {
  firePressure: 0.025,        // chaos/s per burning cell (half for the fire you're working)
  rescuePressure: 0.12,       // chaos/s per waiting casualty (half while it's your active job)
  cargoPressure: 0.04,        // chaos/s per waiting delivery (half while active)
  houseChaos: 6, lostChaos: 15, expireChaos: 6,
  houseBurn: 75,              // seconds a house can stand in full flame before it's lost
  relief: 8,                  // chaos removed per completed job
  rescueTimeout: 180, cargoTimeout: 150,
  followBonus: 1.25,          // pay multiplier for taking a story's next step straight after the last
  comboWindow: 60, comboStep: 0.25, comboMax: 3, // window: time to take the next call (it only runs while you're free and calls are waiting)
  decaySerious: 1 / 260, decayMinor: 1 / 480, // a patient's condition (1 to 0) falls at this rate per second; pay scales 0.4-1 with it
  hospitalBonus: 1.25,        // a minor case taken past the clinic to the hospital
  spotReach: 140, spotTime: 2, // fire spotting: get within this (horizontally, under 250 m up) and hold it for this long
  vesselBurn: 360, vesselPressure: 0.08, vesselGrow: 0.004, // a boat on fire: lost after this long; chaos/s; how fast it creeps back
  nightPay: 1.3,
};
// Fire classes. A fire is never bigger than what you're flying can put out: power is water per load
// (Utility bucket 1, Heavy Lifter 2.8, bomber 6; more with upgrades).
// (Major: a 9-cell-wide diamond, ~85 cells. test/firefight.check.js checks each class against its aircraft.)
export const FIRES = [
  { name: 'Wildfire', power: 0, rate: 0.6, seed: [[1, 0]], reward: 400 },
  { name: 'Large wildfire', power: 2, rate: 1, seed: [[1, 0], [0, 1], [-1, 0], [0, -1]], reward: 750 },
  { name: 'Major wildfire', power: 5, rate: 3, seed: [...Array(81)].map((_, i) => [(i % 9) - 4, Math.floor(i / 9) - 4]).filter(([i, j]) => Math.abs(i) + Math.abs(j) < 7), reward: 1200 },
];
const GOODS = { hospital: ['Medical supplies', 'Oxygen cylinders', 'Blood supplies'], town: ['Groceries', 'Building materials', 'A generator', 'Water tanks', 'Mail', 'Gas bottles'], base: ['Spare parts', 'Fuel drums'] };
const FRAGILE = ['Medical supplies', 'Blood supplies'], VOLATILE = ['Fuel drums', 'Gas bottles']; // volatile: a hard knock and it explodes
// Director ramps up: shorter gaps, more simultaneous stories (follow-ups don't count), more simultaneous fires.
const spawnGap = (t) => Math.max(10, 28 - t / 12);
const storyCap = (t) => Math.min(3, 2 + Math.floor(t / 150));
const fireCap = (t, big) => (big ? Math.min(3, 1 + Math.floor(t / 150)) : Math.min(2, 1 + Math.floor(t / 300)));
export const comboMult = (combo) => Math.min(SHIFT.comboMax, 1 + SHIFT.comboStep * Math.max(0, combo - 1));

// One shift. seed drives every director choice (type, place, timing).
// world: { scene, fire, houses, crates, can?, firepower? } where crates is the shared list of hookable loads,
// can(type) says whether the current airframe can do that kind of job (the director only sends those), and
// firepower() is its water per load, which caps how big a wildfire gets.
// ship: the freighter's helideck as a live drop-off { name, deck: true, x, z, y, vx, vz, r }, or null.
export function createDispatch(world, seed) {
  for (const h of world.houses) h.burnT = 0;
  return {
    can: () => true, firepower: () => 1, lookout: () => false, sea: () => false, squall: () => false, ship: null, rank: 9, night: false, ...world, rng: mulberry32(seed), calls: [], jobs: [], focus: 0, job: null, t: 0, pos: { x: 0, z: 0 }, route: [], marks: [], routeT: 0, spawnT: 3, nextId: 1, props: [],
    chaos: 0, combo: 0, comboT: 0, lastId: 0, over: false,
    stats: { earned: 0, done: { fire: 0, cargo: 0, rescue: 0, spot: 0 }, bestCombo: 0, housesLost: 0, lost: 0, fuel: 0, losses: 0 },
    view: buildMarkers(world.scene),
  };
}

const a0 = (d) => d.rng() * Math.PI * 2;
const pick = (d, arr) => arr[Math.floor(d.rng() * arr.length)];
// Half the time, a place near where you are (calls on your way make two jobs at once worth it).
const nearPick = (d, arr) => (d.rng() < 0.5 ? pick(d, arr) : arr.reduce((b, o) => { const w = d.rng() / (dist(o, d.pos) + 250); return !b || w > b.w ? { o, w } : b; }, null).o);
const incidents = (d) => [...d.jobs, ...d.calls];
// Up to MAX_JOBS taken at once (pick up a second casualty on the way, say). d.job is the one in focus: the beacon,
// compass and objective text follow it; J moves the focus (cycleFocus). Everything else runs on every taken job.
export const MAX_JOBS = 2;
const refocus = (d) => { d.focus = Math.min(d.focus, Math.max(0, d.jobs.length - 1)); d.job = d.jobs[d.focus] ?? null; };
const drop = (d, j) => { d.jobs.splice(d.jobs.indexOf(j), 1); refocus(d); };
export function cycleFocus(d) { if (d.jobs.length > 1) { d.focus = (d.focus + 1) % d.jobs.length; refocus(d); } return d.job; }

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
  if (j.prop) { d.scene.remove(j.prop); d.props.splice(d.props.indexOf(j.prop), 1); j.prop = null; }
}
function carMesh(color) {
  const b = bodyBaker();
  b.add(new THREE.BoxGeometry(1.8, 0.7, 4.2), color, 0, 0.75, 0);
  b.add(new THREE.BoxGeometry(1.6, 0.6, 2.1), GLASS, 0, 1.4, 0.2);
  b.add(new THREE.BoxGeometry(1.66, 0.1, 2.16), color, 0, 1.74, 0.2);
  for (const sx of [-1, 1]) for (const sz of [-1.35, 1.35]) b.add(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 8).rotateZ(Math.PI / 2), DARK, sx * 0.85, 0.38, sz);
  return new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}
function trawlerMesh() { // going down by the stern
  const b = bodyBaker();
  b.add(new THREE.BoxGeometry(3.4, 1.8, 10), (x, y) => (y < 0.2 ? 0x7a2a22 : 0x2f5d4a), 0, 0.6, 0);
  b.add(new THREE.CylinderGeometry(0, 1.7, 3, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.6).rotateX(-Math.PI / 2), 0x2f5d4a, 0, 0.6, -6.4);
  b.add(new THREE.BoxGeometry(2.6, 2, 2.6), 0xf6efe6, 0, 2.5, 2.6);
  b.add(new THREE.BoxGeometry(2.7, 0.5, 2.7), GLASS, 0, 2.9, 2.6);
  b.add(new THREE.CylinderGeometry(0.08, 0.1, 5, 5), DARK, 0, 3.6, -1);
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

// ---- Stories: a first call plus plain-data follow-up steps (`rest`), built when the step before is done. ----

// What a step needs: an airframe that does that kind of job and, for heavy cargo, the lift.
const canDo = (d, s) => d.can(s.type) && !(s.heavy && RIG.maxLift < RIG[s.heavy].mass);
function story(d, j, rest) {
  rest = rest.filter((s) => canDo(d, s)); // steps this airframe can't do are skipped
  return Object.assign(j, { story: { name: j.title, of: 1 + rest.length }, step: 1, rest });
}
const wreckStep = (spot) => ({ type: 'cargo', heavy: 'vehicle', from: { x: spot.x, z: spot.z, name: `the road near ${spot.near}`, exact: true }, to: BASE, prop: true });
const flat = (x, z) => { const y = heightAt(x, z); return y >= 40 && y <= 150 && [[20, 0], [0, 20], [-20, 0], [0, -20]].every(([dx, dz]) => Math.abs(heightAt(x + dx, z + dz) - y) <= 6); };

function cargoCall(d, base, { heavy, goods, from, to, prop }) {
  const fragile = FRAGILE.includes(goods), volatile = VOLATILE.includes(goods), pay = heavy ? RIG[heavy].pay : volatile ? 1.9 : fragile ? 1.6 : 1;
  const reward = Math.round(((120 + dist(from, to) * 0.25) * pay) / 10) * 10;
  return { ...base, title: `${heavy ? RIG[heavy].label : goods}: ${from.name} → ${to.name}`, from, to, heavy, fragile, volatile, reward, x: from.x, z: from.z, keepProp: prop };
}
// Someone (or something) at (x, z) to fly to dest (the hospital unless told otherwise). severity makes it a patient whose
// condition falls while you're on the way (cond, 1 to 0, scales the pay); a minor case can go to the nearest town clinic
// (dest) or on to the hospital (alt) for a bonus. kind names it in messages; parcel carries a crate instead of a person.
function rescue(d, base, title, x, z, a, k, { boater, dest = HOSPITAL, y = groundAt(x, z), severity, kind = 'Casualty', parcel, cliff } = {}) {
  let alt = null;
  if (severity === 'minor' && dest === HOSPITAL) { dest = nearestClinic({ x, z }); alt = HOSPITAL; }
  const person = parcel ? addLoad(d, createCrate(x, y, z), buildCrateMesh()) : addLoad(d, createCrate(x, y, z, RIG.person), buildPersonMesh(!!boater));
  return { ...base, title, boater, dest, alt, person, x, z, kind, cliff, severity, cond: severity ? 1 : undefined, reward: Math.round((a + dist(person.pos, dest) * k) / 10) * 10 };
}
function makeStep(d, s) {
  const base = { id: d.nextId++, type: s.type, age: 0 };
  if (s.type === 'cargo') return cargoCall(d, base, s);
  if (s.sea) { const a = d.rng() * Math.PI * 2, r = 25 + d.rng() * 30; return rescue(d, base, s.title, s.sea.x + Math.cos(a) * r, s.sea.z + Math.sin(a) * r, 300, 0.25, { boater: true, dest: d.sea() ? HARBOUR : undefined, severity: 'serious' }); }
  if (s.near) {
    for (let i = 0; i < 30; i++) {
      const a = d.rng() * Math.PI * 2, r = 25 + d.rng() * 25, x = s.near.x + Math.cos(a) * r, z = s.near.z + Math.sin(a) * r;
      if (flat(x, z)) return rescue(d, base, 'Their friend is still up there', x, z, 250, 0.25, { severity: 'minor' });
    }
    return null;
  }
  const a = d.rng() * Math.PI * 2;
  return rescue(d, base, s.title, s.from.x + Math.cos(a) * 15, s.from.z + Math.sin(a) * 15, 150, 0.2, { dest: s.dest, kind: s.kind || 'Passenger', severity: s.severity });
}
// The step after a finished one (null ends the story). A wreck takes over the crash/burnt-out car prop.
function followUp(d, j) {
  while (j.rest?.length) {
    const c = makeStep(d, j.rest.shift());
    if (!c) continue;
    if (c.keepProp) { c.prop = j.prop; j.prop = null; }
    return Object.assign(c, { story: j.story, step: j.step + 1, rest: j.rest, after: j.id });
  }
  return null;
}

// Remove everything this shift put in the world (crates, casualties, props, markers).
export function disposeDispatch(d) {
  for (const l of [...d.crates]) removeLoad(d, l);
  for (const m of [...d.props, ...Object.values(d.view)]) d.scene.remove(m);
}

function spawn(d) {
  const fires = incidents(d).filter((j) => j.type === 'fire' || j.type === 'spot').length, power = d.firepower();
  // Can't fight fires (the Scout, a Utility with no bucket)? Spot them: fly out to reported smoke and confirm it, and the
  // ground crews take it from there.
  if (!d.sea() && !d.can('fire') && d.can('rescue') && fires < 1 && d.rng() < 0.3) {
    const id = d.nextId++;
    for (let i = 0; i < 200; i++) {
      const site = nearPick(d, SITES.filter((s) => !s.islet)), a = d.rng() * Math.PI * 2, r = 150 + d.rng() * 300, x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r;
      if (fuelAt(x, z) < 0.75 || !ignite(d.fire, cellOf(x, z), id)) continue;
      d.fire.rate.set(id, 0.4);
      return { id, type: 'spot', age: 0, title: `Smoke reported near ${site.name}`, x, z, reward: 260, spotT: 0, burnt: 0, housesLost: 0 };
    }
  }
  const big = power >= FIRES[2].power, types = (fires < fireCap(d.t, big) ? ['fire', 'cargo', 'rescue'] : ['cargo', 'rescue']).filter(d.can);
  if (!types.length) return null; // nothing this airframe can do right now (e.g. bomber at its fire cap)
  const fresh = types.filter((t) => !d.calls.some((o) => o.type === t));
  let type = pick(d, fresh.length ? fresh : types);
  if (type === 'fire' && !big && types.length > 1 && d.rng() < 0.4) type = pick(d, types.filter((t) => t !== 'fire')); // helicopters: fires a little rarer
  const id = d.nextId++, base = { id, type, age: 0 }, roll = d.rng();
  if (type === 'fire' && d.sea()) { // from the cutter: a boat on fire at sea, or a flare-up on the offshore Oil Rig
    if (d.rng() < 0.35 && !incidents(d).some((j) => j.oilRig)) {
      return { ...base, title: 'Fire on the Oil Rig!', x: OILRIG.x, z: OILRIG.z, y: OILRIG.y + OILRIG.deck, oilRig: true, reward: 620, vessel: true, heat: 1, burnt: 0, housesLost: 0 };
    }
    for (let i = 0; i < 300; i++) {
      const a = d.rng() * Math.PI * 2, r = 900 + d.rng() * 450, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (heightAt(x, z) > -8) continue;
      const j = { ...base, title: `${pick(d, ['Yacht', 'Fishing boat', 'Motor cruiser'])} on fire off ${nearestSite(x, z).name}`, x, z, reward: 480, vessel: true, heat: 1, burnt: 0, housesLost: 0 };
      const hull = trawlerMesh();
      hull.position.set(x, -0.5, z);
      hull.rotation.y = a0(d);
      addProp(d, j, hull);
      return j;
    }
    return null;
  }
  if (type === 'fire') {
    // A house on fire in town: put it out before it burns down (SHIFT.houseBurn). Spreads slowly into the gardens.
    const standing = d.houses.filter((h) => !h.burnt && !incidents(d).some((j) => j.house === h));
    if (d.rank >= 1 && roll < 0.3 && standing.length) {
      const h = pick(d, standing);
      if (ignite(d.fire, cellOf(h.x, h.z), id)) {
        d.fire.rate.set(id, 0.3);
        const j = { ...base, title: h.site.hospital ? `Fire at ${h.site.name}` : `House fire in ${h.site.name}`, house: h, x: h.x, z: h.z, reward: 450, burnt: 0, housesLost: 0 };
        const t = pick(d, SITES.filter((o) => !o.hospital && o !== h.site)); // the family needs a roof elsewhere, then materials
        return h.site.hospital ? j : story(d, j, [{ type: 'rescue', title: `Displaced family: ${h.site.name} → ${t.name}`, from: h.site, dest: t }, { type: 'cargo', goods: 'Building materials', from: BASE, to: t }]);
      }
    }
    // A car alight on a road: catch it before it sets the verges going.
    const spot = d.rank >= 1 && roll < 0.5 && roadSpot(d);
    if (spot && ignite(d.fire, cellOf(spot.x, spot.z), id)) {
      d.fire.rate.set(id, 0.4);
      const j = { ...base, title: `Car fire near ${spot.near}`, x: spot.x, z: spot.z, reward: 350, burnt: 0, housesLost: 0 };
      const car = carMesh(0x3a302c);
      car.position.set(spot.x, spot.y + 0.25, spot.z);
      car.rotation.y = spot.yaw;
      addProp(d, j, car);
      return story(d, j, [wreckStep(spot)]);
    }
    // Wildfire in forest a few hundred metres from a town, sized to what you're flying (the biggest you can fight, often).
    const fits = FIRES.filter((f, i) => power >= f.power && d.rank >= [0, 2, 3][i]), cls = d.rng() < 0.6 ? fits[fits.length - 1] : pick(d, fits);
    for (let i = 0; i < 200; i++) {
      const site = nearPick(d, SITES.filter((s) => !s.islet)), a = d.rng() * Math.PI * 2, r = 150 + d.rng() * 300; // wildfires are main-island (the islets are too small)
      const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r, c = cellOf(x, z);
      if (fuelAt(x, z) < 0.75 || !ignite(d.fire, c, id)) continue;
      d.fire.rate.set(id, cls.rate);
      if (!d.lookout()) for (const [di, dj] of cls.seed) ignite(d.fire, c + di + dj * FIRE.n, id); // lookouts call it in while it's one cell
      const j = { ...base, title: `${cls.name} near ${site.name}`, major: cls === FIRES[2], x, z, reward: cls.reward, burnt: 0, housesLost: 0 };
      return story(d, j, [{ type: 'cargo', goods: pick(d, ['Water tanks', 'Groceries']), from: BASE, to: site }]);
    }
    return null;
  }
  if (type === 'cargo') {
    // Heavy jobs (a quarter): a wrecked car off a road to base, or a container/cabin from base to a town. Big pay, but
    // they need the Heavy Lifter (a maxed Utility can just manage a container). Optional: no chaos while waiting,
    // expiring doesn't break your chain. Otherwise named goods go where they'd be needed.
    if (d.rank >= 2 && roll < 0.25) {
      const heavy = pick(d, ['container', 'vehicle', 'cabin']), spot = heavy === 'vehicle' && roadSpot(d);
      if (heavy === 'vehicle' && !spot) return null;
      return cargoCall(d, base, spot ? wreckStep(spot) : { heavy, from: BASE, to: pick(d, SITES.filter((s) => !s.hospital)) });
    }
    if (d.ship && d.rank >= 1 && roll < 0.5) { // out to the freighter: she doesn't stop for you
      const from = pick(d, [BASE, ...SITES.filter((s) => !s.hospital)]), j = cargoCall(d, base, { goods: pick(d, ['Ship stores', 'Engine spares', 'Mail sacks', 'A replacement pump']), from, to: d.ship });
      return Object.assign(j, { reward: Math.round((j.reward * 1.7) / 10) * 10 });
    }
    const from = nearPick(d, [BASE, ...SITES]), to = pick(d, [BASE, ...SITES].filter((s) => s !== from)), kind = to.hospital ? 'hospital' : to === BASE ? 'base' : 'town';
    const j = cargoCall(d, base, { goods: pick(d, GOODS[kind].filter((g) => d.rank >= 2 || !VOLATILE.includes(g))), from, to }); // volatile loads from Senior Pilot up
    if (!to.hospital) return j;
    const t = pick(d, SITES.filter((o) => !o.hospital)); // supplies in, then a patient out
    return story(d, j, [{ type: 'rescue', title: `Patient transfer: ${HOSPITAL.name} → ${t.name}`, from: HOSPITAL, dest: t, kind: 'Patient' }]);
  }
  // Rescue: a hiker high on the island, a boater adrift, a crash on a road, or a patient to move to the hospital; and
  // lighter work: passengers between towns and urgent medicine (most of the Scout's day). Calls lean towards where you are.
  if (!d.sea() && d.rng() < (d.can('cargo') ? 0.18 : 0.45)) {
    const from = nearPick(d, [BASE, ...SITES]), a = d.rng() * Math.PI * 2;
    if (d.rng() < 0.5) { const to = pick(d, [BASE, ...SITES].filter((s) => s !== from && !s.hospital)); return rescue(d, base, `Passenger: ${from.name} → ${to.name}`, from.x + Math.cos(a) * 15, from.z + Math.sin(a) * 15, 100, 0.18, { dest: to, kind: 'Passenger' }); }
    const to = nearestClinic(from) === from ? pick(d, CLINICS.filter((c) => c !== from)) : nearestClinic(from), src = HOSPITAL;
    return rescue(d, base, `Urgent medicine: ${src.name} → ${to.name}`, src.x + Math.cos(a) * 15, src.z + Math.sin(a) * 15, 140, 0.22, { dest: to, kind: 'Medicine', parcel: true, severity: 'serious' });
  }
  if (d.can('cargo') || d.sea()) { // hook (or cutter) only: a swimmer in a rip off a beach; a climber stuck on a cliff
    if (d.rank >= 1 && roll < 0.14) {
      for (let i = 0; i < 300; i++) {
        const a = d.rng() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
        let r = 1350;
        while (r > 0 && heightAt(dx * r, dz * r) < 0) r -= 6;
        let k = r + 20;
        while (k < r + 120 && heightAt(dx * k, dz * k) > (d.sea() ? -4.5 : -2.5)) k += 4;
        const x = dx * k, z = dz * k;
        if (r <= 0 || k >= r + 120) continue;
        return rescue(d, base, `Swimmer caught in a rip off ${nearestSite(x, z).name}`, x, z, 300, 0.25, { boater: true, dest: d.sea() ? HARBOUR : undefined, severity: 'minor' });
      }
    }
    if (!d.sea() && d.rank >= 2 && roll > 0.86) {
      for (let i = 0; i < 400; i++) {
        const x = (d.rng() - 0.5) * 1600, z = (d.rng() - 0.5) * 1600, y = heightAt(x, z), sl = Math.hypot(heightAt(x + 4, z) - y, heightAt(x, z + 4) - y) / 4;
        if (y < 30 || y > 150 || sl < 0.6 || sl > 1.1) continue;
        return rescue(d, base, `Climber stuck on the cliffs near ${nearestSite(x, z).name}`, x, z, 380, 0.25, { severity: 'serious', cliff: true });
      }
    }
  }
  if (d.ship && !d.sea() && d.rank >= 2 && roll > 0.88) { const S = d.ship; return rescue(d, base, `Injured sailor aboard ${S.name}`, S.x + S.vx * 0.5, S.z + S.vz * 0.5, 380, 0.3, { y: S.y + 0.05, severity: 'serious' }); } // on her helideck, under way
  if ((d.sea() && roll > 0.65) || (!d.sea() && d.rank >= 1 && roll > 0.8 && roll <= 0.88)) {
    const rx = d.sea() ? OILRIG.x + OILRIG.boatStage.x : OILRIG.x + OILRIG.helideck.x, rz = d.sea() ? OILRIG.z + OILRIG.boatStage.z : OILRIG.z + OILRIG.helideck.z;
    const ry = d.sea() ? OILRIG.y + 1.8 : OILRIG.y + OILRIG.helideck.y;
    return rescue(d, base, 'Injured worker on the Oil Rig', rx, rz, 360, 0.25, { boater: d.sea(), dest: d.sea() ? HARBOUR : undefined, y: ry, severity: 'serious' });
  }
  if (!d.sea() && d.rank >= 1 && roll < 0.25) {
    const spot = roadSpot(d);
    if (!spot) return null;
    const car = carMesh(pick(d, [0x2f7c7a, 0xd8a83a, 0xb84a39, 0xe8e2d6]));
    car.position.set(spot.x, spot.y + 0.25, spot.z);
    car.rotation.set(0, spot.yaw + 0.7, 0.12); // skewed across the road
    const j = rescue(d, base, `Car crash near ${spot.near}`, spot.x + Math.cos(spot.yaw) * 4, spot.z - Math.sin(spot.yaw) * 4, 280, 0.25, { severity: 'serious' });
    addProp(d, j, car);
    return story(d, j, [wreckStep(spot)]);
  }
  if (!d.sea() && roll < 0.45) {
    const site = nearPick(d, SITES.filter((s) => !s.hospital)), a = d.rng() * Math.PI * 2;
    return rescue(d, base, `Patient transfer: ${site.name} → hospital`, site.x + Math.cos(a) * 15, site.z + Math.sin(a) * 15, 150, 0.2, { kind: 'Patient', severity: 'serious' });
  }
  const boater = d.sea() || roll < 0.72; // a boat only gets the sea calls, and lands them at the harbour
  for (let i = 0; i < 400; i++) {
    let x, z;
    if (boater) { const a = d.rng() * Math.PI * 2, r = 950 + d.rng() * 350; x = Math.cos(a) * r; z = Math.sin(a) * r; if (heightAt(x, z) > -8) continue; }
    else if (d.rng() < 0.5) { x = d.pos.x + (d.rng() - 0.5) * 900; z = d.pos.z + (d.rng() - 0.5) * 900; if (!flat(x, z)) continue; } // near you
    else { x = (d.rng() - 0.5) * 1600; z = (d.rng() - 0.5) * 1600; if (!flat(x, z)) continue; }
    if (boater && d.rank >= 3 && (d.squall() || d.rng() < 0.18)) { // a trawler foundering: three crew in the water, one call after another
      const j = rescue(d, base, 'Trawler going down: crew in the water', x, z, 320, 0.25, { boater, dest: d.sea() ? HARBOUR : undefined, severity: 'serious' }), hull = trawlerMesh();
      hull.position.set(x + 9, -1.1, z + 4);
      hull.rotation.set(-0.28, a0(d), 0.45);
      addProp(d, j, hull);
      return story(d, j, [{ type: 'rescue', sea: { x, z }, title: 'Second crewman, still in the water' }, { type: 'rescue', sea: { x, z }, title: 'The skipper stayed to the last: find him' }]);
    }
    const j = rescue(d, base, boater ? pick(d, ['Boater adrift', 'Capsized kayaker', 'Swimmer swept out', 'Dinghy taking on water']) : 'Hiker stranded', x, z, 250, 0.25, { boater, dest: d.sea() ? HARBOUR : undefined, severity: d.rng() < 0.4 ? 'serious' : 'minor' });
    return boater || d.rng() < 0.6 ? j : story(d, j, [{ type: 'rescue', near: { x, z } }]); // sometimes a friend is still up there
  }
  return null;
}

export function accept(d, i) {
  if (d.jobs.length >= MAX_JOBS || !d.calls[i]) return null;
  const job = d.calls.splice(i, 1)[0];
  d.jobs.push(job);
  d.focus = d.jobs.length - 1; // the new one takes the focus
  refocus(d);
  job.chained = d.comboT > 0; // taken inside the window: finishing it extends the chain
  job.bonus = job.after && job.after === d.lastId ? SHIFT.followBonus : 1; // a story's next step, taken straight after the last
  d.lastId = 0;
  if (job.type === 'cargo' && !job.crate) {
    const a = d.rng() * Math.PI * 2, r = job.from.exact ? 0 : 17, x = job.from.x + Math.cos(a) * r, z = job.from.z + Math.sin(a) * r;
    job.crate = job.heavy ? addLoad(d, createCrate(x, groundAt(x, z), z, RIG[job.heavy]), buildHeavyMesh(job.heavy)) : addLoad(d, createCrate(x, groundAt(x, z), z), buildCrateMesh());
    job.worstHit = 0;
    if (job.volatile) job.crate.mesh.children[0].material.color.set(0xff7a5a); // red for danger
    if (job.keepProp) closeCall(d, job); // the wreck is hooked: the stand-in prop goes
  }
  return job;
}

// Back on the board as it is (a crate stays where you left it; a casualty aboard is set down here). Breaks the chain.
export function abandon(d) {
  const job = d.job;
  if (!job) return;
  d.combo = d.comboT = 0;
  job.bonus = 1;
  if (job.person?.aboard) { job.person.aboard = job.person.held = false; job.person.mesh.visible = true; }
  d.calls.unshift(job);
  drop(d, job);
}

// Objective position and text for a taken job (the focused one by default).
export function objective(d, j = d.job) {
  if (!j) return null;
  if (j.vessel) return { x: j.x, z: j.z, text: `${j.title}: aim the water cannons (drag / right-click to aim, look down to throw short) and hold F · fire ${Math.round(j.heat * 100)}%` };
  if (j.type === 'spot') { const f = fireStatus(d.fire, j.id); return { x: f.n ? f.x : j.x, z: f.n ? f.z : j.z, text: `${j.title}: fly over the smoke (under 250 m) and hold there to confirm it${j.spotT ? ` · ${Math.min(SHIFT.spotTime, j.spotT).toFixed(1)}/${SHIFT.spotTime} s` : ''}` }; }
  if (j.type === 'fire') {
    const f = fireStatus(d.fire, j.id);
    const left = j.house && !j.house.burnt ? ` · ${Math.ceil(SHIFT.houseBurn - j.house.burnT)} s before the house is lost` : '';
    return { x: f.n ? f.x : j.x, z: f.n ? f.z : j.z, text: `${j.title}: ${f.n} cells burning${left}. ${d.sea() ? 'Stand off the beach and aim the water cannons (drag / right-click to aim, hold F)' : 'Scoop sea water and dump it on the flames'}` };
  }
  if (j.type === 'cargo') {
    if (!j.crate.held && dist(j.crate.pos, j.to) > 14) return { x: j.crate.pos.x, z: j.crate.pos.z, text: `Hook the ${j.heavy ? RIG[j.heavy].cargo : 'crate'} at ${j.from.name} (R for the hook)${j.heavy && RIG.maxLift < RIG[j.heavy].mass ? '. Too heavy for this airframe' : ''}` };
    if (j.to.deck) return { x: j.to.x, z: j.to.z, y: j.to.y, ring: true, text: `Deliver to ${j.to.name}: match her speed and set it down on the helideck${j.volatile ? '. VOLATILE' : j.fragile ? '. FRAGILE' : ''}` };
    return { x: j.to.x, z: j.to.z, ring: true, text: `Deliver to ${j.to.name}: set it down gently in the ring${j.volatile ? '. VOLATILE: one hard knock and it goes up' : j.fragile ? '. FRAGILE' : ''}` };
  }
  const p = j.person, cond = j.cond === undefined ? '' : ` · condition ${Math.round(j.cond * 100)}%`, it = j.kind === 'Medicine' ? 'it' : 'them';
  if (!p.aboard && !p.held) return { x: p.pos.x, z: p.pos.z, y: /aboard/.test(j.title) ? p.pos.y - p.spec.hang : undefined, text: (/aboard/.test(j.title) ? `${j.title}: land on her helideck to take them off` : d.sea() ? `${j.title}: come alongside and stop to pull them aboard` : j.cliff ? `${j.title}: you can't land on a cliff. Hover and hook them` : `${j.title}: land nearby to pick ${it} up${(j.boater || j.kind === 'Medicine') && d.can('cargo') ? `, or hook ${it}` : ''}`) + cond };
  return { x: j.dest.x, z: j.dest.z, ring: true, text: (d.sea() ? `Run them back to ${j.dest.name}: stop at the jetty head` : `Fly ${it} to ${j.dest.name}${j.alt ? ` (or on to ${j.alt.name}: +${Math.round((SHIFT.hospitalBonus - 1) * 100)}%)` : ''}${p.held && !p.aboard ? `: lower ${it} into the ring` : ': land on the pad'}`) + cond };
}

// Lightning has struck at (x, z): if it catches, it's a call.
export function strike(d, x, z) {
  const id = d.nextId++;
  if (d.over || d.calls.length >= 5 || !d.can('fire') || !ignite(d.fire, cellOf(x, z), id)) return;
  d.fire.rate.set(id, 0.6);
  d.calls.push({ id, type: 'fire', age: 0, title: `Lightning strike near ${nearestSite(x, z).name}`, x, z, reward: 380, burnt: 0, housesLost: 0 });
}

// Water from the cutter's water cannons coming down at (x, z): a burning boat there takes it. Returns true if it hit one.
export function douseAt(d, x, z, amount) {
  const j = incidents(d).find((o) => o.vessel && o.heat > 0 && Math.hypot(o.x - x, o.z - z) < 14);
  if (j) j.heat = Math.max(0, j.heat - amount);
  return !!j;
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
  d.pos = { x: s.pos.x, z: s.pos.z };
  if ((d.routeT += dt) > 2) { d.routeT = 0; d.route.push([s.pos.x, s.pos.z]); } // the shift report's track
  const st = d.stats;

  const finish = (j, n, msg) => {
    d.combo = j.chained ? d.combo + 1 : 1;
    d.comboT = SHIFT.comboWindow;
    st.bestCombo = Math.max(st.bestCombo, d.combo);
    const m = comboMult(d.combo), paid = Math.round(n * m * (j.bonus || 1) * (d.night ? SHIFT.nightPay : 1));
    st.earned += paid;
    st.done[j.type]++;
    d.marks.push({ x: j.x, z: j.z, type: j.type }); // for the shift report
    d.chaos = Math.max(0, d.chaos - SHIFT.relief);
    say(`${msg}  +$${paid}${m > 1 ? `  (combo ×${m.toFixed(2)})` : ''}${j.bonus > 1 ? '  (follow-up bonus)' : ''}`);
    if (d.jobs.includes(j)) drop(d, j);
    d.lastId = j.id;
    const next = followUp(d, j);
    if (next) { d.calls.unshift(next); say(`Follow-up: ${next.title}`, true); }
    closeCall(d, j);
  };
  const fail = (j, msg, chaos) => {
    closeCall(d, j);
    d.combo = 0;
    d.comboT = 0;
    d.chaos += chaos;
    say(msg);
    if (d.jobs.includes(j)) drop(d, j);
    else d.calls.splice(d.calls.indexOf(j), 1);
  };

  if ((d.spawnT -= dt) <= 0 && new Set(incidents(d).map((j) => j.story || j)).size < storyCap(d.t)) {
    const o = spawn(d);
    if (o) { d.calls.push(o); say(`New call: ${o.title}`, true); }
    d.spawnT = spawnGap(d.t) * (0.7 + d.rng() * 0.6);
  }
  if (!d.jobs.length && d.calls.length) d.comboT = Math.max(0, d.comboT - dt); // the window waits while you work or the board is empty
  if (!d.comboT && !d.jobs.length) d.combo = 0;

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

  // Pressure from everything still out there; the job you're on counts half. Boat missions get longer timeouts and gentler decay.
  const seaScale = d.sea() ? 2.2 : 1, vesselScale = d.sea() ? 1.8 : 1;
  for (const j of incidents(d)) {
    j.age += dt;
    const active = d.jobs.includes(j) ? 0.5 : 1;
    if (j.cond !== undefined) j.cond = Math.max(0, j.cond - dt * (j.severity === 'serious' ? SHIFT.decaySerious : SHIFT.decayMinor) * (d.sea() ? 0.45 : 1));
    if (j.vessel) { d.chaos += SHIFT.vesselPressure * active * dt * (d.sea() ? 0.55 : 1); if (j.heat > 0) j.heat = Math.min(1, j.heat + SHIFT.vesselGrow * dt * (d.sea() ? 0.6 : 1)); }
    else if (j.type === 'fire' || j.type === 'spot') d.chaos += fireStatus(d.fire, j.id).n * SHIFT.firePressure * active * dt;
    else if (!j.heavy) d.chaos += (j.type === 'rescue' ? SHIFT.rescuePressure * (d.sea() ? 0.55 : 1) : SHIFT.cargoPressure) * active * dt;
  }

  // Unattended calls expire; an ignored fire can burn itself out.
  for (const j of [...d.calls]) {
    if (j.type === 'rescue' && j.age > SHIFT.rescueTimeout * seaScale) { removeLoad(d, j.person); st.lost++; fail(j, `Too late: ${j.title.toLowerCase()} was lost`, SHIFT.lostChaos); }
    else if (j.type === 'cargo' && j.age > SHIFT.cargoTimeout) {
      if (j.crate) removeLoad(d, j.crate);
      if (j.heavy) { closeCall(d, j); d.calls.splice(d.calls.indexOf(j), 1); say(`Contract went elsewhere: ${j.title}`, true); }
      else fail(j, `Delivery cancelled: ${j.title}`, SHIFT.expireChaos);
    }
    else if (j.vessel ? j.age > SHIFT.vesselBurn * vesselScale : false) fail(j, `${j.title}: she burned to the waterline`, SHIFT.lostChaos);
    else if (j.type === 'spot' && j.age > SHIFT.cargoTimeout) { extinguish(d.fire, j.id); fail(j, 'Nobody confirmed the smoke: the ground crews got there late', SHIFT.expireChaos); }
    else if (j.type === 'fire' && !j.vessel && !fireStatus(d.fire, j.id).n) { closeCall(d, j); d.calls.splice(d.calls.indexOf(j), 1); say(`${j.title} burned itself out: ${j.burnt} cells lost`); }
  }

  const pay = (j) => (j.cond === undefined ? 1 : 0.4 + 0.6 * j.cond); // a patient's condition scales the pay
  for (const j of [...d.jobs]) {
    if (j.vessel) {
      if (j.heat <= 0) finish(j, j.reward, j.oilRig ? 'Rig fire out! Crew are safe.' : 'Fire out! Her crew are safe.');
      else if (j.age > SHIFT.vesselBurn * vesselScale) fail(j, `${j.title}: she burned to the waterline`, SHIFT.lostChaos);
      continue;
    }
    if (j.type === 'spot') {
      const f = fireStatus(d.fire, j.id), over = f.n && Math.hypot(s.pos.x - f.x, s.pos.z - f.z) < SHIFT.spotReach && s.pos.y - groundAt(s.pos.x, s.pos.z) < 250;
      j.spotT = over ? j.spotT + dt : 0;
      if (j.spotT > SHIFT.spotTime || !f.n) { extinguish(d.fire, j.id); finish(j, j.reward, 'Fire confirmed: the ground crews are on it.'); }
      continue;
    }
    if (j.type === 'fire' && !fireStatus(d.fire, j.id).n) {
      finish(j, Math.max(100, j.reward - j.burnt * 8 - j.housesLost * 120), `Fire out! ${j.burnt} cells lost${j.housesLost ? `, ${j.housesLost} houses` : ''}.`);
    } else if (j.type === 'cargo') {
      const c = j.crate;
      j.worstHit = c.held ? 0 : Math.max(j.worstHit, c.hit);
      if (j.volatile && c.hit > 9) { d.blast?.(c.pos); removeLoad(d, c); st.losses += COSTS.loss.cargo; fail(j, `The ${j.title.split(':')[0].toLowerCase()} went up! No pay, combo lost.`, SHIFT.expireChaos); continue; }
      const T = j.to, aboard = T.deck && dist(c.pos, T) < T.r; // on the freighter's helideck: at rest means moving with her
      const resting = !c.held && (aboard ? (c.vel.x - T.vx) ** 2 + c.vel.y ** 2 + (c.vel.z - T.vz) ** 2 < 0.3 && c.pos.y - c.spec.hang - T.y < 0.3 : c.vel.lengthSq() < 0.05 && c.pos.y - c.spec.hang - groundAt(c.pos.x, c.pos.z) < 0.05);
      if (resting && (aboard || (!T.deck && dist(c.pos, j.to) < 14))) {
        const rough = j.worstHit > (j.fragile ? 5 : 9);
        removeLoad(d, c);
        if (rough && j.fragile) { st.losses += COSTS.loss.cargo; fail(j, 'Fragile cargo smashed. No pay, combo lost.', SHIFT.expireChaos); }
        else finish(j, rough ? Math.round(j.reward * 0.4) : j.reward, rough ? 'Cargo delivered, but damaged.' : 'Cargo delivered!');
      }
    } else if (j.type === 'rescue') {
      const p = j.person;
      if (!p.held && s.grounded && dist(s.pos, p.pos) < 25) {
        if ((j.boardT = (j.boardT || 0) + dt) > 1.5) { p.aboard = p.held = true; p.mesh.visible = false; say('Casualty aboard'); }
      } else j.boardT = 0;
      if (p.aboard) p.pos.copy(s.pos); // rides along (hidden) so abandoning sets them down where you are
      const landed = p.aboard && s.grounded && [j.dest, j.alt].find((t) => t && dist(s.pos, t) < PAD_RADIUS + 4); // the clinic, or on to the hospital
      const lowered = !p.held && p.vel.lengthSq() < 0.05 && [j.dest, j.alt].find((t) => t && dist(p.pos, t) < 16);
      const at = landed || lowered, n = at && Math.round(j.reward * pay(j) * (at === j.alt ? SHIFT.hospitalBonus : 1));
      if (landed) { removeLoad(d, p); finish(j, n, `${j.kind} delivered to ${at.name}!`); }
      else if (lowered) {
        removeLoad(d, p);
        if (p.hit > 8) st.losses += COSTS.loss.casualty;
        finish(j, p.hit > 8 ? Math.round(n / 2) : n, p.hit > 8 ? 'Delivered, but that landing hurt.' : `${j.kind} delivered to ${at.name}!`);
      }
    }
  }

  if (d.chaos >= 100) { d.chaos = 100; d.over = true; }
}

// ---- Markers: a light beacon at the objective and a ring for drop zones (the HUD compass points the way). ----

function buildMarkers(scene) {
  const glow = (geo, opacity) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const beacon = glow(new THREE.CylinderGeometry(2.5, 2.5, 400, 8, 1, true).translate(0, 200, 0), 0.22);
  const ring = glow(new THREE.RingGeometry(12, 14, 32).rotateX(-Math.PI / 2), 0.7);
  const other = glow(new THREE.CylinderGeometry(1.6, 1.6, 400, 8, 1, true).translate(0, 200, 0), 0.1); // the job not in focus
  scene.add(beacon, ring, other);
  return { beacon, ring, other };
}

// view: interpolated chopper position. Returns the objective (or null).
export function updateMarkers(d, view) {
  const { beacon, ring, other } = d.view, o = objective(d), j2 = d.jobs.find((j) => j !== d.job), o2 = j2 && objective(d, j2);
  if ((other.visible = !!o2)) { other.material.color.set(COLOR[j2.type]); other.position.set(o2.x, o2.y ?? groundAt(o2.x, o2.z), o2.z); }
  beacon.visible = ring.visible = !!o;
  if (!o) return null;
  const color = COLOR[d.job.type];
  for (const m of [beacon, ring]) m.material.color.set(color);
  beacon.position.set(o.x, o.y ?? groundAt(o.x, o.z), o.z);
  ring.visible = !!o.ring;
  ring.position.set(o.x, (o.y ?? groundAt(o.x, o.z)) + 0.3, o.z);
  o.dist = Math.hypot(o.x - view.x, o.z - view.z);
  beacon.material.opacity = 0.22 * Math.min(1, o.dist / 90); // fades as you arrive, so it never fills the view
  return o;
}
