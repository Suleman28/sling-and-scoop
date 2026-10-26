import assert from 'node:assert/strict';
import { TUNE } from '../src/chopper.js';
import { RIG } from '../src/tools.js';
import { applyLoadout, buyOrSelectAirframe, buyUpgrade, loadCareer, newCareer, recordShift, saveCareer, UPGRADES } from '../src/career.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

// Buying: costs money, can't overspend, maxes out.
const c = newCareer();
assert.match(buyUpgrade(c, 'bucket'), /Need/);
c.bank = 100000;
for (let i = 0; i < 3; i++) buyUpgrade(c, 'bucket');
assert.equal(c.levels.bucket, 3);
assert.equal(c.bank, 100000 - UPGRADES.bucket.cost.reduce((a, b) => a + b));
assert.match(buyUpgrade(c, 'bucket'), /maxed/);

// Airframes: buy once, then switching is free.
const bank = c.bank;
buyOrSelectAirframe(c, 'heavy');
assert.ok(c.owned.includes('heavy') && c.airframe === 'heavy' && c.bank < bank);
const afterBuy = c.bank;
buyOrSelectAirframe(c, 'scout'); buyOrSelectAirframe(c, 'heavy');
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
applyLoadout(c);
const heavyCap = RIG.cap;
applyLoadout(c);
assert.equal(RIG.cap, heavyCap);
assert.ok(heavyCap > baseCap * 2 && TUNE.thrust < baseThrust);
applyLoadout(base);
assert.ok(RIG.cap === baseCap && TUNE.thrust === baseThrust && RIG.bucket.line === baseLine);

// Shift results: bank the pay, track bests separately for normal and daily shifts.
const r = newCareer();
assert.ok(recordShift(r, 1200));
assert.ok(!recordShift(r, 800));
assert.ok(recordShift(r, 500, '2026-10-25'));
assert.equal(r.bank, 2500);
assert.equal(r.best, 1200);
console.log('career ok');
