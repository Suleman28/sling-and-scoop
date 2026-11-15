import { TUNE } from './chopper.js';
import { bucketScale, RIG } from './tools.js';
import { PLANE } from './plane.js';
import { BOAT } from './boat.js';

// Career: money, upgrades and airframes, saved in localStorage. Stats are applied by rewriting TUNE/RIG
// from a pristine copy, so applying the same loadout twice is harmless.
const BASE_TUNE = { ...TUNE }, BASE_PLANE = { ...PLANE }, BASE_BOAT = { ...BOAT }, BASE_RIG = { ...RIG, bucket: { ...RIG.bucket }, hook: { ...RIG.hook }, snorkel: { ...RIG.snorkel } };

// tools: what hangs on the line; jobs: the calls the director sends while you fly it. The starter Scout has no line,
// so it only does rescues (land beside the casualty). The Water Bomber is a plane: fires only, and owning it brings major fires.
export const AIRFRAMES = {
  scout: { kind: 'scout', name: 'Scout', cost: 0, tools: [], jobs: ['rescue'], blurb: 'Starter bubble two-seater: fast and nimble, no line, so rescues only', cam: 0.95, scale: 1.15, price: 0.6, body: 0xf6d34a, trim: 0x2b2b33,
    tune: { thrust: 2.3, drag2: 0.0017, yawRate: 1.9, climb: 16, burn: 1 / 620, loadClimb: 0.6, bank: 0.42, agility: 1.35, probes: [[0, 2.28, 6.92]] }, rig: { cap: 0.7, heliMass: 0.7, anchor: 0.6, maxLift: 0.8 } },
  utility: { kind: 'utility', name: 'Utility', cost: 5000, tools: ['bucket', 'hook'], gear: { bucket: 2500 }, jobs: ['fire', 'cargo', 'rescue'], blurb: 'Hook for cargo and rescues; buy the bucket kit to fight fires (can lug containers & vehicles slowly)', cam: 1, scale: 1, price: 1, body: 0xfff1d8, trim: 0x1d6a70,
    tune: { probes: [[0, 3.3, 7.3]] }, rig: { maxLift: 2.05 } },
  heavy: { kind: 'heavy', name: 'Heavy Lifter', cost: 14000, tools: ['bucket', 'hook'], gear: { tank: 6500 }, jobs: ['fire', 'cargo', 'rescue'], blurb: 'Sky-crane: slow and thirsty, 3× torrent bucket, lifts containers, vehicles and cabins', cam: 1.25, scale: 0.85, price: 1.8, body: 0xd8dde0, trim: 0xc8452e,
    tune: { thrust: 1.7, drag2: 0.0026, yawRate: 1.1, climb: 11, burn: 1 / 450, loadClimb: 0.15, bank: 0.26, agility: 0.68, probes: [[0, 4.76, 8.67], [-2.02, 0.1, 1.15], [2.02, 0.1, 1.15], [0, 0.1, -4.46]] }, rig: { cap: 2.8, waterMass: 0.25, heliMass: 1.8, anchor: 2.45, maxLift: 2.6 } },
  bomber: { kind: 'bomber', plane: true, name: 'Water Bomber', cost: 22000, tools: [], jobs: ['fire'], blurb: 'Twin-prop amphibian: flies from the airstrip, skims the sea to scoop 6× a bucket. Brings major wildfires', cam: 1.6, scale: 1, price: 2.2, body: 0xf2c230, trim: 0xd8352a,
    tune: {}, rig: {} },
  boat: { kind: 'boat', boat: true, name: 'Rescue Cutter', cost: 9000, tools: [], jobs: ['rescue', 'fire'], blurb: '21 m fire & rescue cutter: runs from the harbour, pulls people out of the sea, fights shoreline fires with her water cannons', cam: 2, scale: 1, price: 1.2, body: 0xf2763a, trim: 0x2a2a32,
    tune: {}, rig: {} },
};

// Upgrades belong to each airframe: career.levels[airframe][upgrade], 5 levels each. cost[i] is the base price of
// level i + 1, times the airframe's `price` (its class). Only upgrades that apply to an airframe are offered.
export const MAX_LEVEL = 5;
export const UPGRADES = {
  bucket: { name: 'Water capacity', cost: [400, 800, 1300, 1800, 2200], blurb: '+16% water per level (bucket or bomber tank)' },
  line: { name: 'Long line', cost: [250, 500, 800, 1100, 1350], blurb: '+1.8 m of line per level: dip and hook from higher up' },
  scoop: { name: 'High-flow scoops', cost: [400, 800, 1300, 1800, 2300], blurb: '+20% sea-scooping speed & wider skim altitude per level' },
  aero: { name: 'Flaps & control surfaces', cost: [450, 900, 1450, 2000, 2500], blurb: 'Lower stall speed & crisper roll/pitch authority per level' },
  pump: { name: 'Water cannon pumps', cost: [450, 900, 1450, 2000, 2500], blurb: '+14% water cannon flow & +6% water throw range per level' },
  helm: { name: 'Thrusters & helm', cost: [350, 700, 1150, 1600, 2050], blurb: 'Faster turning, throttle response & side thrusters' },
  power: { name: 'Rotor power', cost: [500, 1000, 1600, 2200, 2700], blurb: 'More thrust, climb and lift capacity; less slowed by loads' },
  fuel: { name: 'Fuel tank', cost: [350, 650, 1100, 1500, 1900], blurb: '+20% flight time per level' },
};
export const upgradesFor = (frame) => {
  const a = AIRFRAMES[frame];
  return Object.keys(UPGRADES).filter((k) => (k === 'bucket' ? a.plane || a.tools.includes('bucket') : k === 'line' ? a.tools.includes('bucket') : (k === 'scoop' || k === 'aero') ? a.plane : (k === 'pump' || k === 'helm') ? a.boat : true));
};
// Gear: line tools or belly equipment an airframe can buy (gear: { item: price }); owned as 'airframe:item' in c.gear.
export const GEAR = {
  bucket: { name: 'Bucket kit', blurb: 'Fight fires: dip, carry and drop water' },
  tank: { name: 'Belly fire tank', blurb: '2.2× water capacity + hover snorkel; replaces cargo missions when fitted' },
};
export const hasTank = (c, frame = c.airframe) => frame === 'heavy' && !!c.gear?.includes('heavy:tank') && c.tankOn !== false;
export const jobsOf = (c, frame = c.airframe) => AIRFRAMES[frame].jobs.filter((j) => !(hasTank(c, frame) && j === 'cargo'));
export const toolsOf = (c, frame = c.airframe) => (hasTank(c, frame) ? ['snorkel'] : AIRFRAMES[frame].tools.filter((t) => !AIRFRAMES[frame].gear?.[t] || c.gear?.includes(`${frame}:${t}`)));
export function buyGear(c, tool) {
  const a = AIRFRAMES[c.airframe], cost = a.gear?.[tool];
  if (cost === undefined) return `The ${a.name} doesn't take a ${tool}`;
  if (c.gear.includes(`${c.airframe}:${tool}`)) {
    if (tool === 'tank') { c.tankOn = !hasTank(c); return c.tankOn ? 'Belly fire tank fitted (cargo disabled)' : 'Belly fire tank removed (cargo hook active)'; }
    return `${GEAR[tool].name}: already fitted`;
  }
  if (c.bank < cost) return `Need $${cost.toLocaleString()} for the ${GEAR[tool].name}`;
  c.bank -= cost;
  c.gear.push(`${c.airframe}:${tool}`);
  if (tool === 'tank') c.tankOn = true;
  return `${GEAR[tool].name} fitted to the ${a.name}`;
}
export const upgradeCost = (frame, key, lvl) => Math.round((UPGRADES[key].cost[lvl] * AIRFRAMES[frame].price) / 50) * 50;

const KEY = 'rotor-relay-career';
export function newCareer() {
  const levels = {};
  for (const f in AIRFRAMES) levels[f] = Object.fromEntries(upgradesFor(f).map((k) => [k, 0]));
  return { bank: 0, levels, owned: ['scout'], airframe: 'scout', best: 0, projects: [], gear: [], xp: 0, daily: null };
}

// storage: anything with getItem/setItem (localStorage in the browser). Storage can be missing or blocked.
// Old saves had one shared levels object ({ bucket, line, power, fuel }): copy it to every owned airframe.
export function loadCareer(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY));
    if (saved) {
      const c = newCareer(), owned = [...new Set(['scout', ...(saved.owned || [])])], old = saved.levels, shared = typeof old?.power === 'number';
      for (const f in c.levels) for (const k in c.levels[f]) {
        const v = shared ? (owned.includes(f) ? old[k] : 0) : old?.[f]?.[k];
        c.levels[f][k] = Math.min(MAX_LEVEL, Math.max(0, Math.floor(Number(v)) || 0));
      }
      return { ...c, ...saved, levels: c.levels, owned, projects: (saved.projects || []).filter((k) => k in PROJECTS), gear: saved.gear || (owned.includes('utility') ? ['utility:bucket'] : []), xp: saved.xp ?? owned.reduce((t, f) => t + AIRFRAMES[f].cost * 2, 0) }; // saves from before gear keep the Utility's bucket; from before ranks, what they own counts as experience
    }
  } catch {}
  return newCareer();
}
export function saveCareer(storage, c) {
  try { storage.setItem(KEY, JSON.stringify(c)); } catch {}
}

export function applyLoadout(c) {
  const a = AIRFRAMES[c.airframe], L = { bucket: 0, line: 0, scoop: 0, aero: 0, power: 0, fuel: 0, pump: 0, helm: 0, ...c.levels[c.airframe] };
  Object.assign(TUNE, BASE_TUNE, a.tune);
  TUNE.thrust *= 1 + 0.05 * L.power;
  TUNE.climb *= 1 + 0.07 * L.power;
  TUNE.loadClimb *= 1 - 0.12 * L.power;
  TUNE.burn /= 1 + 0.2 * L.fuel;
  Object.assign(RIG, BASE_RIG, { bucket: { ...BASE_RIG.bucket }, hook: { ...BASE_RIG.hook }, snorkel: { ...BASE_RIG.snorkel } }, a.rig);
  RIG.cap *= 1 + 0.16 * L.bucket;
  if (hasTank(c)) { RIG.cap *= 2.2; RIG.waterMass *= 0.85; RIG.anchor = 2.68; }
  RIG.maxLift += 0.1 * L.power; // maxed power lets the Utility (just) lift heavy cargo
  Object.assign(PLANE, BASE_PLANE);
  PLANE.tank *= 1 + 0.16 * L.bucket;
  PLANE.thrust *= 1 + 0.05 * L.power;
  PLANE.burn /= 1 + 0.2 * L.fuel;
  PLANE.scoopRate *= 1 + 0.2 * L.scoop;
  PLANE.scoopHeight += 0.3 * L.scoop;
  PLANE.stall *= 1 - 0.05 * L.aero;
  PLANE.rollRate *= 1 + 0.08 * L.aero;
  PLANE.pitchRate *= 1 + 0.08 * L.aero;
  Object.assign(BOAT, BASE_BOAT, { jet: [...BASE_BOAT.jet] });
  BOAT.thrust *= 1 + 0.08 * L.power;
  BOAT.burn /= 1 + 0.2 * L.fuel;
  BOAT.jetFlow = 1 + 0.14 * L.pump;
  BOAT.jet = BASE_BOAT.jet.map((v) => v * (1 + 0.06 * L.pump));
  BOAT.turn *= 1 + 0.08 * L.helm;
  BOAT.spool *= 1 + 0.1 * L.helm;
  BOAT.thruster *= 1 + 0.1 * L.helm;
  RIG.bucket.hang = BASE_RIG.bucket.hang * bucketScale(RIG.cap); // bigger bucket hangs lower
  RIG.bucket.radius = BASE_RIG.bucket.radius * bucketScale(RIG.cap);
  RIG.bucket.line += 1.8 * L.line;
  RIG.hook.line += 1.8 * L.line;
  RIG.snorkel.line += 1.8 * L.line;
}

// Returns a message; mutates the career on success. Buys for the airframe being flown.
export function buyUpgrade(c, key) {
  const u = UPGRADES[key], lv = c.levels[c.airframe], lvl = lv[key];
  if (lvl === undefined) return `${u.name} doesn't apply to the ${AIRFRAMES[c.airframe].name}`;
  if (lvl >= MAX_LEVEL) return `${u.name} is maxed out`;
  const cost = upgradeCost(c.airframe, key, lvl);
  if (c.bank < cost) return `Need $${cost.toLocaleString()} for ${u.name}`;
  c.bank -= cost;
  lv[key]++;
  return `${u.name} upgraded to level ${lv[key]}`;
}

// Island projects: one-off builds that change the world and the economy (see world.js for the models).
export const PROJECTS = {
  stations: { name: 'Town refuel stations', cost: 9000, blurb: 'Fuel pumps at every town pad: refuel without flying home' },
  pond: { name: 'Base dip tank', cost: 6000, blurb: 'An open water tank by the hangar: fill the bucket without going to sea' },
  fuelFarm: { name: 'Fuel farm', cost: 12000, blurb: 'Bulk fuel storage: fuel bills −40%' },
  towers: { name: 'Fire lookout towers', cost: 18000, blurb: 'Ridge-top lookouts spot wildfires early, before they spread' },
  offshore: { name: 'Offshore refuel', cost: 10000, blurb: 'Fuel pumps at the Oil Rig helideck & boat landing for long sea shifts' },
};
export function buyProject(c, key) {
  const p = PROJECTS[key];
  if (c.projects.includes(key)) return `${p.name}: already built`;
  if (c.bank < p.cost) return `Need $${p.cost.toLocaleString()} for the ${p.name}`;
  c.bank -= p.cost;
  c.projects.push(key);
  return `${p.name} built!`;
}

export function buyOrSelectAirframe(c, key) {
  const a = AIRFRAMES[key];
  if (!c.owned.includes(key)) {
    if (c.bank < a.cost) return `Need $${a.cost.toLocaleString()} for the ${a.name}`;
    c.bank -= a.cost;
    c.owned.push(key);
  }
  c.airframe = key;
  return `Flying the ${a.name}`;
}

// Running costs. fuel: $ per full tank; loss: charged when cargo is smashed or a casualty is hurt by a rough set-down.
// (Repairs come later, with a damage meter you pay off at a pad; see PLAN.md.)
export const COSTS = {
  fuel: { scout: 150, utility: 350, heavy: 700, bomber: 800, boat: 300 },
  loss: { cargo: 150, casualty: 200 },
  repair: 600, crash: 800,   // a full airframe repair at base; writing one off
};
// Bills take the career so island projects can apply discounts here later.
const has = (career, key) => career.projects?.includes(key);
export const fuelBill = (career, kind, amount) => COSTS.fuel[kind] * amount * (has(career, 'fuelFarm') ? 0.6 : 1);
export const netOf = (st) => Math.round(st.earned - st.fuel - st.losses);

// End of shift: bank the net (gross minus costs, may go negative) and record bests. Returns true for a new best.
// Pilot ranks: experience is what you earn (gross pay), and each rank opens up harder calls (see spawn in missions.js):
// house and car fires, the freighter, rip rescues and night shifts at Line Pilot; large wildfires, heavy and volatile
// cargo, cliff and shipboard rescues at Senior; major wildfires and foundering trawlers at Captain.
export const RANKS = [
  { name: 'Trainee', xp: 0 },
  { name: 'Line Pilot', xp: 2500, unlocks: 'house and car fires, freighter runs, rip rescues, night shifts' },
  { name: 'Senior Pilot', xp: 9000, unlocks: 'large wildfires, heavy and volatile cargo, cliff and shipboard rescues' },
  { name: 'Captain', xp: 20000, unlocks: 'major wildfires, foundering trawlers' },
  { name: 'Chief Pilot', xp: 40000, unlocks: 'the top job' },
];
export const rankOf = (c) => RANKS.reduce((r, k, i) => (c.xp >= k.xp ? i : r), 0);
// The daily challenge: the same shift for everyone on a given day (date → seed), best net pay kept per day.
export const dailySeed = (date) => ([...date].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7) >>> 0) % 2147483647;
export function recordShift(c, earned, costs = 0) {
  const net = Math.round(earned - costs);
  c.xp = (c.xp || 0) + Math.max(0, Math.round(earned));
  c.bank += net;
  const best = net > c.best;
  if (best) c.best = net;
  return best;
}
