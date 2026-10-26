import { TUNE } from './chopper.js';
import { bucketScale, RIG } from './tools.js';
import { PLANE } from './plane.js';

// Career: money, upgrades and airframes, saved in localStorage. Stats are applied by rewriting TUNE/RIG
// from a pristine copy, so applying the same loadout twice is harmless.
const BASE_TUNE = { ...TUNE }, BASE_PLANE = { ...PLANE }, BASE_RIG = { ...RIG, bucket: { ...RIG.bucket }, hook: { ...RIG.hook } };

// tools: what hangs on the line; jobs: the calls the director sends while you fly it. The starter Scout has no line,
// so it only does rescues (land beside the casualty). The Water Bomber is a plane: fires only, and owning it brings major fires.
export const AIRFRAMES = {
  scout: { kind: 'scout', name: 'Scout', cost: 0, tools: [], jobs: ['rescue'], blurb: 'Starter bubble two-seater: fast and nimble, no line, so rescues only', cam: 0.95, scale: 1.15, body: 0xf6d34a, trim: 0x2b2b33,
    tune: { thrust: 2.3, drag2: 0.0017, yawRate: 1.9, climb: 16, burn: 1 / 620, loadClimb: 0.6, bank: 0.42, agility: 1.35 }, rig: { cap: 0.7, heliMass: 0.7, anchor: 0.6, maxLift: 0.8 } },
  utility: { kind: 'utility', name: 'Utility', cost: 4000, tools: ['bucket', 'hook'], jobs: ['fire', 'cargo', 'rescue'], blurb: 'Bucket and hook: fights fires, slings cargo (can lug containers & vehicles slowly)', cam: 1, scale: 1, body: 0xfff1d8, trim: 0x1d6a70,
    tune: {}, rig: { maxLift: 2.05 } },
  heavy: { kind: 'heavy', name: 'Heavy Lifter', cost: 10000, tools: ['bucket', 'hook'], jobs: ['fire', 'cargo', 'rescue'], blurb: 'Sky-crane: slow and thirsty, 3× torrent bucket, lifts containers, vehicles and cabins', cam: 1.25, scale: 0.85, body: 0xd8dde0, trim: 0xc8452e,
    tune: { thrust: 1.7, drag2: 0.0026, yawRate: 1.1, climb: 11, burn: 1 / 450, loadClimb: 0.15, bank: 0.26, agility: 0.68 }, rig: { cap: 2.8, waterMass: 0.25, heliMass: 1.8, anchor: 2.45, maxLift: 2.6 } },
  bomber: { kind: 'bomber', plane: true, name: 'Water Bomber', cost: 15000, tools: [], jobs: ['fire'], blurb: 'Twin-prop amphibian: flies from the airstrip, skims the sea to scoop 6× a bucket. Brings major wildfires', cam: 1.6, scale: 1, body: 0xf2c230, trim: 0xd8352a,
    tune: {}, rig: {} },
};

// Each upgrade has 3 levels; cost[i] buys level i + 1.
export const UPGRADES = {
  bucket: { name: 'Water capacity', cost: [900, 2200, 4500], blurb: '+30% water per level (bucket and bomber tank)' },
  line: { name: 'Long line', cost: [600, 1500, 3000], blurb: '+2.5 m of line per level: dip and hook from higher up' },
  power: { name: 'Rotor power', cost: [1200, 2800, 5500], blurb: 'More thrust, climb and lift capacity; less slowed by loads' },
  fuel: { name: 'Fuel tank', cost: [700, 1600, 3200], blurb: '+30% flight time per level' },
};

const KEY = 'rotor-relay-career';
export function newCareer() {
  return { bank: 0, levels: { bucket: 0, line: 0, power: 0, fuel: 0 }, owned: ['scout'], airframe: 'scout', best: 0 };
}

// storage: anything with getItem/setItem (localStorage in the browser). Storage can be missing or blocked.
export function loadCareer(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY));
    if (saved) { const c = newCareer(); return { ...c, ...saved, levels: { ...c.levels, ...saved.levels }, owned: [...new Set(['scout', ...(saved.owned || [])])] }; }
  } catch {}
  return newCareer();
}
export function saveCareer(storage, c) {
  try { storage.setItem(KEY, JSON.stringify(c)); } catch {}
}

export function applyLoadout(c) {
  const a = AIRFRAMES[c.airframe], L = c.levels;
  Object.assign(TUNE, BASE_TUNE, a.tune);
  TUNE.thrust *= 1 + 0.07 * L.power;
  TUNE.climb *= 1 + 0.1 * L.power;
  TUNE.loadClimb *= 1 - 0.2 * L.power;
  TUNE.burn /= 1 + 0.3 * L.fuel;
  Object.assign(RIG, BASE_RIG, { bucket: { ...BASE_RIG.bucket }, hook: { ...BASE_RIG.hook } }, a.rig);
  RIG.cap *= 1 + 0.3 * L.bucket;
  RIG.maxLift += 0.15 * L.power; // maxed power lets the Utility (just) lift heavy cargo
  Object.assign(PLANE, BASE_PLANE);
  PLANE.tank *= 1 + 0.3 * L.bucket;
  PLANE.thrust *= 1 + 0.07 * L.power;
  PLANE.burn /= 1 + 0.3 * L.fuel;
  RIG.bucket.hang = BASE_RIG.bucket.hang * bucketScale(RIG.cap); // bigger bucket hangs lower
  RIG.bucket.radius = BASE_RIG.bucket.radius * bucketScale(RIG.cap);
  RIG.bucket.line += 2.5 * L.line;
  RIG.hook.line += 2.5 * L.line;
}

// Returns a message; mutates the career on success.
export function buyUpgrade(c, key) {
  const u = UPGRADES[key], lvl = c.levels[key];
  if (lvl >= u.cost.length) return `${u.name} is maxed out`;
  if (c.bank < u.cost[lvl]) return `Need $${u.cost[lvl].toLocaleString()} for ${u.name}`;
  c.bank -= u.cost[lvl];
  c.levels[key]++;
  return `${u.name} upgraded to level ${c.levels[key]}`;
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

// End of shift: bank the pay and record bests. Returns true for a new best.
export function recordShift(c, earned) {
  c.bank += earned;
  const best = earned > c.best;
  if (best) c.best = earned;
  return best;
}
