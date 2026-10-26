import assert from 'node:assert/strict';
import { TUNE } from '../src/chopper.js';
import { RIG } from '../src/tools.js';
import { AIRFRAMES, applyLoadout, buyOrSelectAirframe, buyUpgrade, loadCareer, MAX_LEVEL, newCareer, recordShift, saveCareer, upgradeCost, upgradesFor } from '../src/career.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

// Buying: costs money, can't overspend, maxes out. Applies to the airframe being flown only.
const c = newCareer();
c.owned.push('utility', 'heavy');
c.airframe = 'utility';
assert.match(buyUpgrade(c, 'bucket'), /Need/);
c.bank = 1000000;
for (let i = 0; i < MAX_LEVEL; i++) buyUpgrade(c, 'bucket');
assert.equal(c.levels.utility.bucket, MAX_LEVEL);
assert.equal(c.levels.heavy.bucket, 0);
assert.equal(c.levels.scout.power, 0);
assert.equal(c.bank, 1000000 - [0, 1, 2, 3, 4].reduce((a, l) => a + upgradeCost('utility', 'bucket', l), 0));
assert.match(buyUpgrade(c, 'bucket'), /maxed/);

// Costs rise each level and scale with airframe class; only applicable upgrades are offered.
for (const f in AIRFRAMES) for (const k of upgradesFor(f)) for (let l = 1; l < MAX_LEVEL; l++) assert.ok(upgradeCost(f, k, l) > upgradeCost(f, k, l - 1));
assert.ok(upgradeCost('heavy', 'power', 0) > upgradeCost('utility', 'power', 0) && upgradeCost('utility', 'power', 0) > upgradeCost('scout', 'power', 0));
assert.deepEqual(upgradesFor('scout'), ['power', 'fuel']);
assert.deepEqual(upgradesFor('bomber'), ['bucket', 'power', 'fuel']);
assert.equal(upgradesFor('heavy').length, 4);
c.airframe = 'scout';
assert.match(buyUpgrade(c, 'line'), /doesn't apply/);

// Upgrading the Utility leaves the Heavy Lifter's stats alone.
const h = newCareer();
buyOrSelectAirframe(Object.assign(h, { bank: 1e6 }), 'heavy');
applyLoadout(h);
const heavyBefore = { cap: RIG.cap, thrust: TUNE.thrust, line: RIG.bucket.line };
buyOrSelectAirframe(h, 'utility');
for (let i = 0; i < 3; i++) buyUpgrade(h, 'bucket'), buyUpgrade(h, 'power'), buyUpgrade(h, 'line');
applyLoadout(h);
const utilCap = RIG.cap;
buyOrSelectAirframe(h, 'heavy');
applyLoadout(h);
assert.deepEqual({ cap: RIG.cap, thrust: TUNE.thrust, line: RIG.bucket.line }, heavyBefore);
assert.ok(utilCap > 1.4);

// Old-format save: the shared levels are copied to each owned airframe, clamped to what applies.
const old = mem();
old.setItem('rotor-relay-career', JSON.stringify({ bank: 50, levels: { bucket: 2, line: 1, power: 3, fuel: 9 }, owned: ['scout', 'heavy'], airframe: 'heavy', best: 7 }));
const m = loadCareer(old);
assert.deepEqual(m.levels.scout, { power: 3, fuel: 5 });
assert.deepEqual(m.levels.heavy, { bucket: 2, line: 1, power: 3, fuel: 5 });
assert.deepEqual(m.levels.utility, { bucket: 0, line: 0, power: 0, fuel: 0 });
assert.deepEqual(m.levels.bomber, { bucket: 0, power: 0, fuel: 0 });
assert.ok(m.bank === 50 && m.airframe === 'heavy' && m.best === 7);

// Airframes: buy once, then switching is free.
const bank = c.bank;
buyOrSelectAirframe(c, 'bomber');
assert.ok(c.owned.includes('heavy') && c.airframe === 'bomber' && c.bank < bank);
const afterBuy = c.bank;
buyOrSelectAirframe(c, 'scout'); buyOrSelectAirframe(c, 'bomber');
assert.equal(c.bank, afterBuy);

// Save/load round trip; broken or missing storage falls back to a new career.
const store = mem();
saveCareer(store, c);
assert.deepEqual(loadCareer(store), c);
assert.deepEqual(loadCareer({ getItem: () => { throw new Error('blocked'); } }), newCareer());
assert.deepEqual(loadCareer({ getItem: () => '{not json' }), newCareer());

// Loadout: stats change, and applying twice gives the same result.
const base = newCareer();
applyLoadout(base);
const baseCap = RIG.cap, baseThrust = TUNE.thrust, baseLine = RIG.bucket.line;
c.airframe = 'heavy';
applyLoadout(c);
const heavyCap = RIG.cap;
applyLoadout(c);
assert.equal(RIG.cap, heavyCap);
assert.ok(heavyCap > baseCap * 2 && TUNE.thrust < baseThrust);
applyLoadout(base);
assert.ok(RIG.cap === baseCap && TUNE.thrust === baseThrust && RIG.bucket.line === baseLine);

// Shift results: bank the pay, track the best shift.
const r = newCareer();
assert.ok(recordShift(r, 1200));
assert.ok(!recordShift(r, 800));
assert.equal(r.bank, 2000);
assert.equal(r.best, 1200);
console.log('career ok');
// Island projects: bought once, and the fuel farm discounts fuel.
{
  const { buyProject, fuelBill } = await import('../src/career.js');
  const c = newCareer();
  c.bank = 50000;
  const fuel = fuelBill(c, 'utility', 1);
  assert.match(buyProject(c, 'fuelFarm'), /built/);
  assert.match(buyProject(c, 'fuelFarm'), /already/);
  assert.ok(fuelBill(c, 'utility', 1) < fuel);
  assert.equal(c.bank, 50000 - 12000);
  c.bank = 1000;
  assert.match(buyProject(c, 'towers'), /Need/);
  console.log('projects ok');
}
