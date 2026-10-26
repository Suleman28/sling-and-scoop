import assert from 'node:assert/strict';
import { COSTS, fuelBill, netOf, newCareer, recordShift, repairBill } from '../src/career.js';

const c = newCareer();
// Fuel scales with amount and airframe.
assert.equal(fuelBill(c, 'utility', 1), 2 * fuelBill(c, 'utility', 0.5));
assert.ok(fuelBill(c, 'scout', 1) < fuelBill(c, 'utility', 1) && fuelBill(c, 'utility', 1) < fuelBill(c, 'heavy', 1) && fuelBill(c, 'heavy', 1) <= fuelBill(c, 'bomber', 1));
// Gentle touchdowns are free; a crash costs far more than a scrape; heavier iron costs more.
assert.equal(repairBill(c, 'heavy', COSTS.repair.free), 0);
assert.equal(repairBill(c, 'heavy', 0), 0);
const scrape = repairBill(c, 'utility', 5), crash = repairBill(c, 'utility', 14);
assert.ok(scrape > 0 && crash > 3 * scrape);
assert.ok(repairBill(c, 'heavy', 14) > crash && repairBill(c, 'scout', 14) < crash);
// The net is banked (and may dip below zero); best shift tracks net.
const st = { earned: 2000, fuel: 400.4, repairs: 120.2, losses: 150 };
assert.equal(netOf(st), 1329);
assert.equal(recordShift(c, st.earned, st.earned - netOf(st)), true);
assert.equal(c.bank, 1329);
assert.equal(c.best, 1329);
assert.equal(recordShift(c, 500, 900), false);
assert.equal(c.bank, 929);
assert.equal(c.best, 1329);
recordShift(c, 0, 1000);
assert.equal(c.bank, -71);
console.log('costs ok');
