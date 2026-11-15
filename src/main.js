import * as THREE from 'three';
import { buildWorld, FOG, HARBOUR, LIGHTHOUSE, OILRIG, ROADS, SEAS, SOLIDS, waveAt, POND, setProjects, SITES, RUNWAY, onRunway, fuelAt, groundAt, heightAt, hitTrees, PAD, PAD_RADIUS, padLocal, PADS, resetScorch, scorch, SEA, SEED } from './world.js';
import { buildChopper, createFlight, stepFlight } from './chopper.js';
import { buildPlane, createPlane, drop, PLANE, stepPlane } from './plane.js';
import { BOAT, buildBoat, createBoat, stepBoat } from './boat.js';
import { buildShip, deckAt, SHIP, stepShip } from './ship.js';
import { boom, sfx, splosh, startAudio, thud, setVolume, toggleMute, updateAudio } from './audio.js';
import { makeParticles, makeRain, makeRings, makeWake } from './fx.js';
import { buildLife, SHIPS } from './life.js';
import { act, winch, buildRigView, splashReach, createRig, hangOf, massOf, nearestCrate, placeCrateMesh, RIG, stepCrate, stepRig, swapTool } from './tools.js';
import { buildFireView, cellCentre, cellOf, createFire, douse, ignite, resetFire, stepFire } from './fire.js';
import { AIRFRAMES, COSTS, applyLoadout, buyGear, dailySeed, RANKS, rankOf, buyOrSelectAirframe, buyUpgrade, buyProject, GEAR, hasTank, jobsOf, toolsOf, fuelBill, loadCareer, PROJECTS, MAX_LEVEL, netOf, recordShift, saveCareer, upgradeCost, UPGRADES, upgradesFor } from './career.js';
import { abandon, accept, comboMult, createDispatch, cycleFocus, douseAt, MAX_JOBS, disposeDispatch, onScorch, SHIFT, strike, updateDispatch, updateMarkers } from './missions.js';

const STEP = 1 / 60;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 5000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Career (money, upgrades, airframes) persists in localStorage, which may be missing or blocked.
let storage = null;
try { storage = localStorage; } catch {}
const career = loadCareer(storage);
// Options persist under one key; unknown or bad values fall back to the defaults.
const SETTINGS_KEY = 'rotorRelay.settings';
const opts = { volume: 1, sens: 1, invertY: false, autoCenter: false, fps: true, hint: false, tipSeen: false, physics: true };
try { Object.assign(opts, JSON.parse(storage.getItem(SETTINGS_KEY))); } catch {}
const saveOpts = () => { try { storage.setItem(SETTINGS_KEY, JSON.stringify(opts)); } catch {} };
const { sky, water, windsock, lighthouse, houses, surf, sun, hemi } = buildWorld(scene);
const updateLife = buildLife(scene);
setVolume(opts.volume);
applyLoadout(career);
const airframe = () => AIRFRAMES[career.airframe];
const isPlane = () => !!airframe().plane, isBoat = () => !!airframe().boat;
const hasLine = () => toolsOf(career).length > 0 && !rig.stowed; // the starter Scout and the bomber have no line; R can stow it
// The rig's tool must be one this airframe has (the Utility's bucket is bought separately).
const fitTool = () => {
  const t = toolsOf(career);
  if (!t.length) return;
  if (t[0] === 'snorkel') { rig.tool = 'snorkel'; rig.stowed = true; rig.len = RIG.snorkel.line; }
  else if (!t.includes(rig.tool)) swapTool(rig);
};
const buildCraft = () => (isPlane() ? buildPlane(airframe()) : isBoat() ? buildBoat(airframe()) : buildChopper({ ...airframe(), tank: hasTank(career) }));
let craft = buildCraft();
// The Rescue Cutter lies at her berth whenever you're not the one sailing her, riding the swell (scenery: nothing collides).
const moored = buildBoat(AIRFRAMES.boat), berth = createBoat(HARBOUR.x, HARBOUR.z, HARBOUR.yaw, true), mooredState = { light: false };
moored.group.rotation.order = 'YXZ';
scene.add(moored.group);
scene.add(craft.group);
// Dynamic contextual controls line: only shows what's relevant right now (full list lives in Settings).
const helpEl = document.getElementById('help');
let lastHelp = '';
function helpText() {
  const call = onShift() && dispatch?.calls.length && dispatch.jobs.length < MAX_JOBS ? ` · ${dispatch.calls.length > 1 ? `1–${dispatch.calls.length}` : '1'} take call` : '';
  const job = onShift() && dispatch?.job ? ' · X abandon' : '';
  if (isBoat()) {
    if (s?.moored) return `W/S throttle · R cast off · H hangar · M map${call}`;
    if (s?.anchored) return `R weigh anchor · Drag aim · Hold F spray · M map${call}`;
    return `W/S throttle · A/D wheel · Q/E thrusters · Drag aim · Hold F spray · R anchor · G horn${call}${job}`;
  }
  if (isPlane()) {
    if (s?.onSurface && !s?.onWater) return `Space throttle · S rotate at speed · H hangar · M map${call}`;
    if ((s?.water || 0) > 0.1) return `Hold F drop water · R ${s?.salvo ? 'salvo' : 'trail'} · W/S pitch · A/D bank · M map${call}${job}`;
    return `Skim sea >65 km/h to scoop · W/S pitch · A/D bank · Q/E rudder · M map${call}`;
  }
  if (s?.grounded) return `Space lift off · W/S/A/D fly · Q/E strafe · H hangar · M map${call}`;
  if (hasTank(career)) return `W/S/A/D fly · Space/Shift alt · ${rig?.stowed ? 'R drop snorkel' : (s?.tankWater || 0) > 0.05 ? 'Hold F drop water · R stow' : 'Z/C pipe · R stow'} · M map${call}${job}`;
  if (!toolsOf(career).length) return `W/S/A/D fly · Space/Shift alt · Q/E strafe · M map · Esc pause${call}${job}`;
  if (rig?.stowed) return `W/S/A/D fly · Space/Shift alt · R deploy line · M map${call}${job}`;
  if (rig?.crate) return `F release load · Z/C winch · W/S/A/D fly · M map${job}`;
  return `W/S/A/D fly · Space/Shift alt · F ${rig?.tool === 'bucket' ? 'dump water' : 'hook'} · Z/C winch · R tool/stow${call}${job}`;
}
function setHelp() {
  helpEl.hidden = !opts.hint;
  if (!opts.hint) return;
  const txt = helpText();
  if (txt !== lastHelp) { helpEl.textContent = txt; lastHelp = txt; }
}
function refit() {
  const was = craftKind;
  applyLoadout(career);
  if (!hasLine()) { if (rig.crate) act(rig, crates); Object.assign(rig, createRig(rigHome.x, PAD.y + 1.2, rigHome.z)); }
  fitTool();
  scene.remove(craft.group);
  craft = buildCraft();
  scene.add(craft.group);
  rig.water = Math.min(rig.water, RIG.cap);
  if (was !== kindNow()) towHome(); // switching between helicopter, plane and boat: you start at that craft's home
  setHelp();
  saveCareer(storage, career);
}

const shadow = new THREE.Mesh(new THREE.CircleGeometry(3.4, 16).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x1a1020, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
scene.add(shadow);

// Rotor wash puffs, water drops (bucket dumps and spills) and directional water-surface foam streaks/ribbons.
const wash = makeParticles(scene, 160, { opacity: 0.36 });
const drops = makeParticles(scene, 500, { opacity: 0.85, size: 0.18 });
const rings = makeRings(scene, 260), wake = makeWake(scene), shipWake = makeWake(scene, 75, 12);
const SPRAY = 0xeaf6f4, DUST = 0xd8b48c, WATER = 0x8fd3e8;
let washAcc = 0;
function spawnWash(dt, x, gy, z, alt, onWater, power) {
  for (washAcc += Math.max(0, 1 - alt / 20) * power * 150 * dt; washAcc >= 1; washAcc--) {
    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 3, sp = 8 + Math.random() * 8;
    wash.spawn(x + Math.cos(a) * r, gy + 0.3, z + Math.sin(a) * r, Math.cos(a) * sp, (onWater ? 2 : 1) + Math.random() * 2, Math.sin(a) * sp, onWater ? SPRAY : DUST, { life: 0.77 });
    if (onWater && Math.random() < 0.28) rings.spawn(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.35, 2.4, 0.65, Math.cos(a) * sp * 0.7, Math.sin(a) * sp * 0.7, SPRAY);
  }
}
// The cutter's fire water cannons: sea water thrown in an arc the way they're trained (s.aim, from the camera).
let jetAcc = 0;
function spawnJets() {
  const a = s.yaw + s.aim, dx = -Math.sin(a), dz = -Math.cos(a), cy = Math.cos(s.yaw), sy = Math.sin(s.yaw), k = s.jetK ?? 1, out = BOAT.jet[0] * k, up = BOAT.jet[1] * k; // range goes as k^2
  for (jetAcc += 70 * (BOAT.jetFlow || 1) * STEP; jetAcc >= 1; jetAcc--) {
    const [mx, my, mz] = BOAT.monitors[(Math.random() * 2) | 0];
    drops.spawn(s.pos.x + mx * cy + mz * sy + dx * 1.1, s.pos.y + my + 1.45, s.pos.z - mx * sy + mz * cy + dz * 1.1, dx * out + s.vel.x + rnd(2.5 * k), up + rnd(2 * k), dz * out + s.vel.z + rnd(2.5 * k), WATER,
      { life: 6, grav: -9.81, drag: 0.05, grow: 1.8, puff: false, onLand: (x, y, z) => splash(x, y, z, 1 / 250, 2) });
  }
}
// The boat's wake: twin waterjet foam ribbons & fine spray off the transom, directed bow/stern side-thruster foam streams,
// and a Kelvin V-bow wave + hull chine ribbons peeling outward as she cuts through the water.
let jetWakeAcc = 0, thrAcc = 0;
function spawnWake(dt) {
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
  const v = Math.abs(s.speed), thr = Math.abs(s.throttle || 0), rev = (s.throttle || 0) < -0.02;
  for (jetWakeAcc += thr * (30 - Math.min(v, 10) * 2) * dt; jetWakeAcc >= 1; jetWakeAcc--) { // churn at the jets; under way the trail (makeWake) takes over
    const noz = Math.random() < 0.5 ? -1 : 1, steer = (s.steer || 0) * 0.42 + rnd(0.18);
    const jx = -fx * Math.cos(steer) - rx * Math.sin(steer), jz = -fz * Math.cos(steer) - rz * Math.sin(steer);
    const sp = Math.max(1, (rev ? 5 : 8) + thr * 13 - v), dir = rev ? -0.55 : 1; // the jet leaves at about her speed, so its foam barely moves over the water
    const ox = s.pos.x - fx * 10.5 + rx * noz * 1.05 + rnd(0.35), oz = s.pos.z - fz * 10.5 + rz * noz * 1.05 + rnd(0.35);
    const vx = jx * sp * dir + rx * (rev ? noz * 3.8 : rnd(1.4)), vz = jz * sp * dir + rz * (rev ? noz * 3.8 : rnd(1.4));
    if (Math.random() < 0.55) drops.spawn(ox, s.pos.y + 0.05, oz, vx * 0.75 + rnd(2), (rev ? 1.1 : 1.4) + Math.random() * 1.8 * thr, vz * 0.75 + rnd(2), SPRAY, { life: 0.45, grav: -9.8, drag: 0.8, grow: 0.9, puff: false });
    else wash.spawn(ox, s.pos.y, oz, vx * 0.55, 0.4 + Math.random() * 0.6 * thr, vz * 0.55, SPRAY, { life: 0.38, grav: -5, drag: 2.2, grow: 0.42 + 0.28 * thr });
  }
  const sway = s.sway || 0, pivot = v < 6 ? (s.steer || 0) : 0, thrPwr = Math.max(Math.abs(sway), Math.abs(pivot));
  for (thrAcc += thrPwr * 52 * dt; thrAcc >= 1; thrAcc--) { // bow & stern side-thruster wash: directed fan of sleek foam streaks + low mist
    const fore = Math.random() < 0.5, tz = fore ? 7.6 : -7.2 + rnd(0.5), push = sway || (fore ? -pivot : pivot), side = push > 0 ? -1 : 1;
    const fan = rnd(0.32), dx = rx * side * Math.cos(fan) + fx * Math.sin(fan), dz = rz * side * Math.cos(fan) + fz * Math.sin(fan);
    const ox = s.pos.x + fx * tz + rx * side * 1.55, oz = s.pos.z + fz * tz + rz * side * 1.55, sp = (7.5 + Math.random() * 5.5) * thrPwr;
    const vx = dx * sp + s.vel.x * 0.35, vz = dz * sp + s.vel.z * 0.35;
    rings.spawn(ox, oz, 0.22 + Math.random() * 0.12, 1.8 + thrPwr * 1.6, 0.48 + Math.random() * 0.22, vx, vz, SPRAY);
    if (Math.random() < 0.6) drops.spawn(ox, s.pos.y + 0.04, oz, vx * 0.85, 0.8 + Math.random() * 1.1, vz * 0.85, SPRAY, { life: 0.38, grav: -9.8, drag: 1.2, grow: 0.8, puff: false });
  }
  if (Math.random() < dt * (4 + 12 * thr)) { // exhaust from the funnel
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    smoke.spawn(s.pos.x + 0.45 * sy + rnd(0.5) * cy, s.pos.y + 6.4, s.pos.z + 0.45 * cy, wind.x * 0.3 + s.vel.x * 0.3, 2 + Math.random() * 2, wind.z * 0.3 + s.vel.z * 0.3, 0x5a565c, { life: 1.8, grav: 0.4, drag: 0.5, grow: 0.7 + 0.9 * thr });
  }
}
// Water landing: splash, and douse the fire there (steam if it was burning).
const smoke = makeParticles(scene, 700, { opacity: 0.32 });
const fire = createFire(fuelAt, SEED);
const fireView = buildFireView(scene, groundAt, smoke);
const splash = (x, y, z, amount = 1 / 250, reach) => {
  if (dispatch && douseAt(dispatch, x, z, amount * 0.6)) smoke.spawn(x, y + 1, z, wind.x * 0.3, 3 + Math.random() * 2, wind.z * 0.3, 0xf4f1ee, { life: 2, grav: 0.5, drag: 0.3, grow: 2.5 }); // a burning boat: steam
  wash.spawn(x, y + 0.3, z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, SPRAY, { life: 0.6, grow: 0.8 });
  if (groundAt(x, z) <= SEA && Math.random() < 0.35) { const a = Math.random() * Math.PI * 2; rings.spawn(x, z, 0.3, 1.6, 0.55, Math.cos(a) * 2.5, Math.sin(a) * 2.5, SPRAY); }
  if (douse(fire, x, z, amount, reach) && Math.random() < 0.3) smoke.spawn(x, y + 1, z, wind.x * 0.3, 4 + Math.random() * 3, wind.z * 0.3, 0xf4f1ee, { life: 3, grav: 0.5, drag: 0.3, grow: 3 });
};
// Searchlight under the aircraft chin (L): starts off by default; turns on for night shifts.
const spotGeo = new THREE.ConeGeometry(8.5, 65, 14, 1, true).translate(0, -32.5, 0).rotateX(Math.PI / 2);
{
  const p = spotGeo.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const k = p.getZ(i) > -1 ? 1 : 0; c[i * 3] = k; c[i * 3 + 1] = k * 0.94; c[i * 3 + 2] = k * 0.75; }
  spotGeo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}
const spot = new THREE.Mesh(spotGeo,
  new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
spot.on = false; spot.rotation.order = 'YXZ';
const SPOT_CHIN = { scout: [0, 0.52, -2.05], utility: [0, 0.72, -2.65], heavy: [0, 1.55, -5.1] };
scene.add(spot);
// Explosions (oil drums, wrecks): a flash, a fireball, flung debris and black smoke; it shakes the camera by distance
// and sets the ground alight if there's anything to burn.
const blast = makeParticles(scene, 260, { opacity: 0.6, size: 0.6, glow: true }), debris = makeParticles(scene, 120, { opacity: 1, size: 0.22, soft: false });
const FLAME = [0xfff1a8, 0xffb347, 0xf2763a, 0xd8452e], SOOT = 0x1c1a20, rnd = (n) => (Math.random() - 0.5) * n;
function explodeFx(x, y, z, size = 1) {
  blast.spawn(x, y + 1, z, 0, 0, 0, 0xfff6d0, { life: 0.25, grav: 0, drag: 0, grow: 7 * size });
  for (let i = 0; i < 22; i++) blast.spawn(x + rnd(1.5), y + 0.5, z + rnd(1.5), rnd(16), 3 + Math.random() * 10, rnd(16), FLAME[i % 4], { life: 0.5 + Math.random() * 0.6, grav: 4, drag: 3, grow: (2.5 + Math.random() * 3) * size });
  for (let i = 0; i < 12; i++) smoke.spawn(x + rnd(3), y + 1.5, z + rnd(3), rnd(6) + wind.x * 0.3, 4 + Math.random() * 5, rnd(6) + wind.z * 0.3, SOOT, { life: 3 + Math.random() * 2.5, grav: 0.6, drag: 0.9, grow: (4 + Math.random() * 4) * size });
  for (let i = 0; i < 14; i++) debris.spawn(x, y + 0.5, z, rnd(26), 6 + Math.random() * 16, rnd(26), i % 3 ? SOOT : 0xd8452e, { life: 2.5, grav: -9.81, drag: 0.2, grow: 0.4 + Math.random() * 0.6, puff: false });
  const near = Math.max(0, 1 - Math.hypot(x - s.pos.x, y - s.pos.y, z - s.pos.z) / 220);
  boom(0.25 + 0.75 * near * near);
  trauma = Math.min(1, trauma + near ** 4 * 1.2);
  ignite(fire, cellOf(x, z));
}
// A helicopter crash tears the main rotor off: it's lifted out of the model into the world and flung (see the frame loop).
let thrown = null;
function throwRotor(k) {
  const rot = craft.rotor, a = Math.random() * Math.PI * 2, out = 5 + 7 * k;
  scene.attach(rot);
  craft.disc.visible = false;
  thrown = { obj: rot, vel: new THREE.Vector3(s.vel.x * 0.6 + Math.cos(a) * out, 5 + 4 * k, s.vel.z * 0.6 + Math.sin(a) * out), spin: 14 + 10 * k, yaw: rot.rotation.y, tilt: 0.5 + Math.random() * 0.6 };
}
// Something heavy going into the water: a crown of spray and radial surface foam streaks.
function splashFx(x, y, z, v, size, sound = true) {
  const n = Math.min(30, 6 + v * 1.5);
  for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, out = 1 + Math.random() * 3; wash.spawn(x + Math.cos(a) * size, y + 0.2, z + Math.sin(a) * size, Math.cos(a) * out, 2 + Math.random() * Math.min(9, v * 0.6), Math.sin(a) * out, SPRAY, { life: 0.9, grav: -7, drag: 0.6, grow: 0.9 + size * 0.5 }); }
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + rnd(0.3), sp = 3 + v * 0.25; rings.spawn(x + Math.cos(a) * size * 0.5, z + Math.sin(a) * size * 0.5, 0.35 * size, 1.8 * size, 0.75, Math.cos(a) * sp, Math.sin(a) * sp, SPRAY); }
  if (sound) splosh(Math.min(1, v / 14));
}
// A hard landing on dry ground kicks up a ring of dust.
function dustFx(p, v) {
  if (groundAt(p.x, p.z) <= SEA) return;
  for (let i = 0; i < 8; i++) { const a = Math.random() * Math.PI * 2; wash.spawn(p.x, groundAt(p.x, p.z) + 0.3, p.z, Math.cos(a) * (2 + v * 0.3), 0.5 + Math.random(), Math.sin(a) * (2 + v * 0.3), DUST, { life: 0.9, grow: 1.6 }); }
}
// Aim marker: where a dump would land right now (bucket velocity carried through the fall).
const aim = new THREE.Mesh(new THREE.RingGeometry(8, 10, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.6, depthWrite: false, fog: false }));
const aimDot = new THREE.Mesh(new THREE.CircleGeometry(1.4, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.75, depthWrite: false, fog: false }));
aim.add(aimDot);
scene.add(aim);
function updateAim(r) {
  if (isBoat()) { // where the water cannons' jets come down, for the way they're trained
    const k = s.jetK ?? 1, a = s.yaw + s.aim, out = BOAT.jet[0] * k, up = BOAT.jet[1] * k, tf = ((up + Math.sqrt(up * up + 2 * 9.81 * 4)) / 9.81) * 0.9; // nozzles ~4 m up; the pressure (s.jetK) sets the throw
    const x = s.pos.x + (-Math.sin(a) * out + s.vel.x) * tf, z = s.pos.z + (-Math.cos(a) * out + s.vel.z) * tf;
    aim.visible = !s.wreck;
    aimDot.visible = true;
    aim.position.set(x, groundAt(x, z) + 0.5, z);
    aim.scale.setScalar(0.3 + 0.7 * k); // the jets spread less on a short throw
    return;
  }
  aimDot.visible = false;
  aim.scale.setScalar(1);
  // The bomber's or belly tank's drop starts under the belly; the bucket's under the bucket.
  const belly = isPlane() || hasTank(career), src = belly ? s : r, bottom = belly ? 0 : hangOf(r);
  aim.visible = isPlane() ? s.water > 0.1 && !s.onSurface : hasTank(career) ? (s.tankWater || 0) > 0.05 && !(hasLine() && rig.dipped) : hasLine() && r.tool === 'bucket' && r.water > 0.05 && !r.dipped;
  if (!aim.visible) return;
  const h = Math.max(0, src.pos.y - bottom - groundAt(src.pos.x, src.pos.z)), vy = src.vel.y - 1, t = (vy + Math.sqrt(vy * vy + 2 * 9.81 * h)) / 9.81;
  const x = src.pos.x + src.vel.x * t * 0.9, z = src.pos.z + src.vel.z * t * 0.9; // ~drop drag
  aim.position.set(x, groundAt(x, z) + 0.5, z);
}
// Bomber drop: fewer, heavier drops (70 per unit of water) so a full tank fits the particle pool.
function spawnPlaneDrops(amount) {
  const sp = Math.hypot(s.vel.x, s.vel.z) || 1, rx = -s.vel.z / sp, rz = s.vel.x / sp; // across the flight path
  for (dropAcc += amount * 70; dropAcc >= 1; dropAcc--) {
    const across = (Math.random() - 0.5) * 14, flare = (Math.random() - 0.5) * 6; // spread over most of the wingspan, fanning out
    drops.spawn(s.pos.x + rx * across, s.pos.y - 0.3, s.pos.z + rz * across,
      s.vel.x * 0.85 + rx * flare + (Math.random() - 0.5) * 3, s.vel.y - 2, s.vel.z * 0.85 + rz * flare + (Math.random() - 0.5) * 3, WATER,
      { life: 6, grav: -9.81, drag: 0.4, grow: 1.6, puff: false, onLand: (x, y, z) => splash(x, y, z, 1 / 70, PLANE.reach) });
  }
}
let dropAcc = 0;
function spawnBellyDrops(amount) {
  const reach = splashReach(RIG.cap), fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
  for (dropAcc += amount * 95; dropAcc >= 1; dropAcc--) {
    const along = (Math.random() - 0.5) * 2.2, side = (Math.random() - 0.5) * 1.4;
    drops.spawn(s.pos.x + fx * along + rx * side, s.pos.y + 1.1, s.pos.z + fz * along + rz * side,
      s.vel.x * 0.8 + (Math.random() - 0.5) * 3.5, s.vel.y - 2.5, s.vel.z * 0.8 + (Math.random() - 0.5) * 3.5, WATER,
      { life: 6, grav: -9.81, drag: 0.35, grow: 1.7, puff: false, onLand: (x, y, z) => splash(x, y, z, 1 / 95, reach) });
  }
}
function spawnDrops(r, amount, rim) {
  const h = hangOf(r), sc = h / 1.2;
  for (dropAcc += amount * 250; dropAcc >= 1; dropAcc--) {
    const a = Math.random() * Math.PI * 2, rad = (rim ? 0.85 : Math.random() * 0.5) * sc;
    drops.spawn(r.pos.x + Math.cos(a) * rad, r.pos.y - (rim ? 0.2 : h), r.pos.z + Math.sin(a) * rad,
      r.vel.x + (Math.random() - 0.5) * 1.5 * sc, r.vel.y - 1, r.vel.z + (Math.random() - 0.5) * 1.5 * sc, WATER, { life: 4, grav: -9.81, drag: 0.3, grow: 1, puff: false, onLand: (x, y, z) => splash(x, y, z, 1 / 250, splashReach()) });
  }
}

// Wind: slowly veering direction with layered gusts, 0..10 m/s.
const wind = { x: 0, z: 0, str: 0 };
// Weather: every five minutes or so a squall blows through for a minute and a half. storm (0..1) drives the wind,
// the sea state, the murk, the rain and the lightning, which can start fires (and, on shift, calls).
const weather = { storm: 0, flash: 0, was: false };
const rain = makeRain(scene), MURK = new THREE.Color(0x6f6a80), DIM = new THREE.Color(0x8a8898), WHITE = new THREE.Color(0xffffff);
const bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(30), 3)), new THREE.LineBasicMaterial({ color: 0xffffff, fog: false }));
bolt.frustumCulled = false; bolt.visible = false;
scene.add(bolt);
function stepWeather(t) {
  const w = weather;
  w.storm = Math.min(1, Math.max(0, (Math.sin(t * 0.0209 - 2.2) - 0.45) / 0.4));
  SEAS.h = 1 + 2 * w.storm;
  if (w.storm > 0 !== w.was) { w.was = w.storm > 0; say(w.was ? 'Squall coming in: wind and sea rising' : 'The squall has blown through', true); }
  if (w.storm > 0.6 && Math.random() < 0.07 * STEP) { // lightning: somewhere within a kilometre, on land if it can
    let x = 0, z = 0;
    for (let i = 0; i < 8 && (i === 0 || heightAt(x, z) < 2); i++) { const a = Math.random() * 6.28, r = 150 + Math.random() * 850; x = s.pos.x + Math.cos(a) * r; z = s.pos.z + Math.sin(a) * r; }
    const p = bolt.geometry.attributes.position, gy = groundAt(x, z);
    for (let i = 0; i < 10; i++) p.setXYZ(i, x + (i && i < 9 ? rnd(30) : 0) + (9 - i) * 6, gy + (9 - i) * 55, z + (i && i < 9 ? rnd(30) : 0));
    p.needsUpdate = true;
    w.flash = 1;
    const d = Math.hypot(x - s.pos.x, z - s.pos.z);
    setTimeout(() => boom(0.9 - d / 1600), d * 2); // thunder follows the flash
    if (heightAt(x, z) > 2 && Math.random() < 0.5) { if (onShift()) strike(dispatch, x, z); else ignite(fire, cellOf(x, z)); }
  }
}
let nightK = 0; // eases in and out with a night shift
const NIGHT = new THREE.Color(0x0e1228), NIGHT_SKY = new THREE.Color(0x141838);
function drawWeather(dt) {
  const w = weather, k = w.storm;
  nightK += ((dispatch?.night && onShift() ? 1 : 0) - nightK) * (1 - Math.exp(-0.8 * dt));
  w.flash = Math.max(0, w.flash - dt * 5);
  bolt.visible = w.flash > 0.45;
  scene.fog.color.copy(FOG).lerp(MURK, k * 0.85).lerp(NIGHT, nightK * 0.92).lerp(WHITE, w.flash * 0.5);
  scene.background = scene.fog.color;
  scene.fog.near = 350 - 230 * k; scene.fog.far = 2100 - 1150 * k;
  sky.material.color.copy(WHITE).lerp(DIM, k).lerp(NIGHT_SKY, nightK * 0.95).lerp(WHITE, w.flash);
  sun.intensity = (3.2 - 2.2 * k) * (1 - 0.9 * nightK); hemi.intensity = (1.5 - 0.45 * k) * (1 - 0.68 * nightK) + 4 * w.flash;
  rain(dt, camera.position, wind, k);
}
function updateWind(t) {
  const a = 0.8 + Math.sin(t * 0.013) * 0.6;
  wind.str = Math.max(0, 5 + 3 * Math.sin(t * 0.21) + 2 * Math.sin(t * 0.53 + 1)) * (1 + 1.3 * weather.storm) + 3 * weather.storm * Math.sin(t * 1.7);
  wind.x = Math.cos(a) * wind.str;
  wind.z = Math.sin(a) * wind.str;
}
// The freighter: under way round the island. Her flat deck is ground to aircraft and loads (land on it, ride it,
// refuel on it, deliver to it); her forecastle and superstructure are solid; to the cutter her hull is a shoal.
const ship = buildShip();
scene.add(ship.group);
const shipBox = (() => { // extents of her hull and of what stands above the deck at each end, from the model itself
  const p = ship.group.children[0].geometry.attributes.position, F = SHIP.flat, mk = () => ({ x: 0, z0: 1e9, z1: -1e9, y: 0 }), hull = mk(), fore = mk(), aft = mk();
  for (let i = 0; i < p.count; i++) {
    const x = Math.abs(p.getX(i)), y = p.getY(i), z = p.getZ(i);
    for (const b of [hull, ...(y > SHIP.deck + 0.6 ? [z < F.z0 ? fore : z > F.z1 ? aft : null] : [])]) if (b) { b.x = Math.max(b.x, x); b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z); b.y = Math.max(b.y, y); }
  }
  return { hull, fore, aft };
})();
const shipSolids = [shipBox.fore, shipBox.aft].map((b) => ({ live: true, ship: SHIP, lz: (b.z0 + b.z1) / 2, x: 0, y: 0, z: 0, hx: Math.min(b.x, SHIP.flat.hw + 2), hy: Math.min(b.y, 22) / 2, hz: (b.z1 - b.z0) / 2, yaw: 0 }));
for (const sh of SHIPS) {
  const sc = sh.scale;
  const boxes = sh.variant === 'cargo'
    ? [[-34.0, 3.2, 4.0, 5.2], [-23.1, 4.0, 6.1, 3.3], [-16.3, 4.0, 4.85, 3.3], [-9.5, 4.0, 6.1, 3.3], [-2.7, 4.0, 4.85, 3.3], [3.65, 6.5, 2.4, 3.15], [14.5, 6.5, 10.0, 7.8]]
    : [[-30.2, 3.6, 4.05, 5.7], [-17.0, 5.5, 7.2, 4.8], [-1.5, 6.4, 5.45, 10.0], [12.8, 2.3, 9.5, 3.2], [16.5, 6.2, 5.4, 7.2]];
  for (const [lz, hx, hy, hz] of boxes) shipSolids.push({ live: true, ship: sh, lz: lz * sc, x: 0, y: 0, z: 0, hx: hx * sc, hy: hy * sc, hz: hz * sc, yaw: 0 });
}
SOLIDS.push(...shipSolids);
const shipPad = { name: SHIP.name, deck: true, r: SHIP.pad.r + 1, x: 0, z: 0, y: 0, vx: 0, vz: 0 }; // her helideck, as a place calls can send cargo
function moveShip(time) {
  const prevYaw = SHIP.yaw;
  stepShip(time, env.waveAt);
  let dYaw = SHIP.yaw - prevYaw;
  while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
  while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
  SHIP.dYaw = dYaw;
  for (const sh of SHIPS) sh.update(time);
  for (const b of shipSolids) {
    const o = b.ship, sn = Math.sin(o.yaw), c = Math.cos(o.yaw);
    b.x = o.x + b.lz * sn; b.z = o.z + b.lz * c; b.y = o.y + b.hy; b.yaw = o.yaw;
  }
  const c = Math.cos(SHIP.yaw), sn = Math.sin(SHIP.yaw);
  Object.assign(shipPad, { x: SHIP.x + SHIP.pad.z * sn, z: SHIP.z + SHIP.pad.z * c, y: SHIP.y + SHIP.deck, vx: SHIP.vx, vz: SHIP.vz });
}
const anyDeckAt = (x, z) => {
  const d = deckAt(x, z);
  if (d !== null) return d;
  for (const sh of SHIPS) { const sd = sh.deckAt(x, z); if (sd !== null) return sd; }
  const rx = x - OILRIG.x, rz = z - OILRIG.z;
  if (Math.abs(rx) < 5.6 && rz >= -20 && rz <= -9) return OILRIG.y + OILRIG.helideck.y;
  if (Math.abs(rx) < 11.0 && Math.abs(rz) < 11.0 && (rx < 2.6 || rz < 1.6) && Math.hypot(rx + 1.5, rz + 1.5) > 2.8) return OILRIG.y + OILRIG.deck;
  return null;
};
const deckShip = () => {
  if (!s.grounded || isBoat()) return null;
  if (deckAt(s.pos.x, s.pos.z) !== null) return SHIP;
  for (const sh of SHIPS) if (sh.deckAt(s.pos.x, s.pos.z) !== null) return sh;
  return null;
};
const onDeck = () => deckShip() !== null;
const env = { groundAt: (x, z) => anyDeckAt(x, z) ?? groundAt(x, z), heightAt, trees: hitTrees, wind, loadMass: 0, pond: null, waveAt: (x, z) => waveAt(x, z, t), burning: (x, z) => fire.heat[cellOf(x, z)] > 0.3 };
// Island projects show in the world and switch on their effects (the dip tank joins the bucket's water sources).
const buildout = () => { setProjects(career.projects); env.pond = career.projects.includes('pond') ? POND : null; };
buildout();
// The cutter also stops against the jetty and the lighthouse breakwater: to her they're ground. (lx, lz) is the
// point in the structure's own frame; the margins leave room for her beam.
const inFrame = (o, ox, oz, x, z, test) => { const dx = x - ox, dz = z - oz, c = Math.cos(o.yaw), sn = Math.sin(o.yaw); return test(dx * c - dz * sn, dx * sn + dz * c); };
const boatEnv = Object.assign(Object.create(env), { atDock: () => atDock(), heightAt: (x, z) => (inFrame(HARBOUR, HARBOUR.hx, HARBOUR.hz, x, z, (lx, lz) =>
  (Math.abs(lx) < 5.8 && lz > 0 && lz < HARBOUR.len + 2) ||
  (Math.abs(lx) < 15.8 && lz > HARBOUR.len - 10 && lz < HARBOUR.len + 6) ||
  (Math.abs(lx) < 20.8 && lz > -10.8 && lz < 10.8) ||
  (lx > -17.3 && lx < -8.7 && lz > -29.8 && lz < -8.5) ||
  (lx > 5.2 && lx < 14.8 && lz > -39.5 && lz < -8.5) ||
  (lx > -29.5 && lx < -18.5 && lz > -8.5 && lz < 11.5) ||
  (lx > -35.8 && lx < -27.2 && lz > -31.5 && lz < 10.5) ||
  (lx > -32.5 && lx < -16.8 && lz > -32.0 && lz < -24.0) ||
  (lx > 18.8 && lx < 39.8 && lz > -9.8 && lz < 9.8))
  || inFrame(LIGHTHOUSE, LIGHTHOUSE.x, LIGHTHOUSE.z, x, z, (lx, lz) => Math.abs(lx) < 7 && lz > -8 && lz < LIGHTHOUSE.len + 16)
  || Math.hypot(x - OILRIG.x, z - OILRIG.z) < 13.5
  || inFrame(SHIP, SHIP.x, SHIP.z, x, z, (lx, lz) => Math.abs(lx) < shipBox.hull.x * (lz < -20 ? Math.max(0.2, (lz - shipBox.hull.z0) / (-20 - shipBox.hull.z0)) : 1) + 1.8 && lz > shipBox.hull.z0 - 2.0 && lz < shipBox.hull.z1 + 2.0)
  || SHIPS.some((sh) => inFrame(sh, sh.x, sh.z, x, z, (lx, lz) => Math.abs(lx) < 7.5 * sh.scale * (lz < -18 * sh.scale ? Math.max(0.2, (lz + 40 * sh.scale) / (22 * sh.scale)) : 1) + 1.8 && lz > -40 * sh.scale - 2.0 && lz < 32 * sh.scale + 2.0)) ? 1 : heightAt(x, z)) });

// Input: keyboard state -> axes in [-1, 1].
const keys = new Set(), pending = { act: false, swap: false, accept: -1, abandon: false }; // one-shot actions, consumed by the next sim step
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input') && e.code !== 'Escape') return; // settings sliders and checkboxes keep their own keys
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  if (!e.repeat) press(e.code);
});
// Menu buttons and hangar rows carry the key they stand for, so clicking and typing do the same thing.
document.getElementById('overlay').addEventListener('click', (e) => { const k = e.target.closest('[data-key]')?.dataset.key; if (k) press(k); });
function toggleLock() {
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
  else if ((mode === 'shift' || mode === 'free') && bigMap.hidden) renderer.domElement.requestPointerLock?.();
}
function press(code) {
  startAudio();
  if (code === 'KeyK') return toggleMute();
  if (code === 'KeyM') { if (bigMap.hidden && !bigBase) bigBase = paintIsland(BIG); bigMap.hidden = !bigMap.hidden; if (!bigMap.hidden && document.pointerLockElement === renderer.domElement) document.exitPointerLock?.(); return; }
  if (code === 'Tab' && (mode === 'shift' || mode === 'free')) { toggleLock(); return; }
  if (mode === 'settings') { const n = /^Tab(\d)$/.exec(code)?.[1]; if (n) { setTab = +n; render(settingsHtml(), 'settings'); } return code === 'Escape' && closeSettings(); }
  if (mode === 'hangar') return hangarKey(code);
  if (mode === 'title' || mode === 'results') {
    if (code === 'Digit1') startShift();
    if (code === 'Digit5' && mode === 'title') startShift(true);
    if (code === 'Digit2' && mode === 'title') startFree();
    if (code === 'Digit4' && mode === 'title') openSettings();
    if (code === 'KeyH' || (code === 'Digit3' && mode === 'title')) openHangar();
    if (code === 'Escape' && mode === 'results') setMode('title');
    return;
  }
  if (mode === 'paused') {
    if (code === 'Escape' || code === 'Digit1') setMode(resumeTo);
    if (code === 'KeyH' && canHangar()) openHangar();
    if (code === 'Digit3') openSettings();
    if (code === 'Digit2') resumeTo === 'shift' ? endShift(true) : setMode('title');
    return;
  }
  if (code === 'Escape') { resumeTo = mode; setMode('paused'); }
  if (code === 'KeyH' && canHangar()) openHangar();
  if (code === 'KeyF') pending.act = true;
  if (code === 'KeyG' && isBoat()) sfx('horn');
  if (code === 'KeyL') { spot.on = !spot.on; say(spot.on ? 'Searchlight on' : 'Searchlight off', true); }
  if (code === 'KeyV') { cockpit = !cockpit; say(cockpit ? 'Cockpit view' : 'Chase view', true); }
  if (code === 'KeyR') {
    if (isBoat() && !s.wreck) {
      if (atDock()) { s.moored = !s.moored; s.anchored = false; if (!s.moored) s.castOffT = 3.0; sfx('swap'); say(s.moored ? 'Moored at dock' : 'Lines cast off'); }
      else {
        s.anchored = !s.anchored; s.moored = false; sfx(s.anchored ? 'anchorDrop' : 'anchorWeigh'); say(s.anchored ? 'Anchor dropped' : 'Anchor weighed');
        if (s.anchored) { const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw); splashFx(s.pos.x + fx * 8.35 + rx * 1.90, SEA, s.pos.z + fz * 8.35 + rz * 1.90, 6, 0.9, false); }
      }
    } else pending.swap = true;
  }
  if (/^Digit[1-5]$/.test(code) && mode === 'shift') pending.accept = +code.slice(5) - 1;
  if (code === 'KeyJ' && mode === 'shift' && dispatch?.jobs.length > 1) { cycleFocus(dispatch); say(`Heading for: ${dispatch.job.title}`, true); }
  if (code === 'KeyX') pending.abandon = true;
}
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// Mouse: drag or right-click/Tab (pointer lock) to orbit/aim, double-click or middle-click to center, wheel to zoom.
const orbit = { yaw: 0, pitch: 0, zoom: 1, targetYaw: 0, targetPitch: 0, targetZoom: 1, dragging: false, locked: false, reset: false, idle: 9, lx: 0, ly: 0, moved: 0, btn: -1 };
const moveOrbit = (dx, dy) => {
  orbit.reset = false;
  orbit.idle = 0;
  orbit.targetYaw -= dx * 0.005 * opts.sens;
  orbit.targetPitch = Math.min(1.08, Math.max(-0.35, orbit.targetPitch + dy * 0.004 * opts.sens * (opts.invertY ? -1 : 1)));
};
addEventListener('pointerlockchange', () => { orbit.locked = document.pointerLockElement === renderer.domElement; });
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 1) { e.preventDefault(); orbit.reset = true; return; }
  orbit.dragging = true; orbit.btn = e.button; orbit.lx = e.clientX; orbit.ly = e.clientY; orbit.moved = 0; orbit.reset = false;
  renderer.domElement.setPointerCapture?.(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (orbit.btn === 2 && orbit.moved < 5) toggleLock();
  orbit.dragging = false; orbit.btn = -1; orbit.idle = 0;
});
renderer.domElement.addEventListener('pointercancel', () => { orbit.dragging = false; orbit.btn = -1; });
renderer.domElement.addEventListener('dblclick', () => { orbit.reset = true; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (orbit.locked) return moveOrbit(e.movementX, e.movementY);
  if (!orbit.dragging) return;
  const dx = e.clientX - orbit.lx, dy = e.clientY - orbit.ly;
  orbit.lx = e.clientX; orbit.ly = e.clientY;
  orbit.moved += Math.hypot(dx, dy);
  moveOrbit(dx, dy);
});
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); orbit.targetZoom = Math.min(4, Math.max(0.55, orbit.targetZoom * Math.exp(e.deltaY * 0.001))); }, { passive: false });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const axis = (pos, neg) => (pos.some((c) => keys.has(c)) ? 1 : 0) - (neg.some((c) => keys.has(c)) ? 1 : 0);
const readInput = () => ({
  fwd: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
  turn: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
  lift: axis(['Space'], ['ShiftLeft', 'ShiftRight']),
  strafe: axis(['KeyE'], ['KeyQ']),
  winch: axis(['KeyC'], ['KeyZ']),
});

const kindNow = () => (isPlane() ? 'plane' : isBoat() ? 'boat' : 'heli');
let craftKind = kindNow();
// A fresh craft at home. It's copied over the old state (Object.assign), so anything a flight adds (a wreck, damage,
// the last knock) has to be cleared here too, or a towed wreck comes home still burning.
const spawnCraft = () => Object.assign((craftKind = kindNow()) === 'plane' ? Object.assign(createPlane(RUNWAY.start.x, RUNWAY.y, RUNWAY.start.z, RUNWAY.yaw), { water: PLANE.tank })
  : craftKind === 'boat' ? createBoat(HARBOUR.x, HARBOUR.z, HARBOUR.yaw, true) // bow out to sea, moored until throttle/helm input
  : createFlight(PAD.x, PAD.y, PAD.z, PAD.yaw), { wreck: false, wreckQ: null, damage: 0, hit: 0, crashV: 0, ditched: false, tankWater: 0, tankFill: 0, tankDumping: false, snorkel: false, snorkelOut: false, snorkelTarget: 0 });
let s = spawnCraft();
const prev = { pos: s.pos.clone(), yaw: s.yaw, pitch: s.pitch, roll: s.roll };
const rigHome = padLocal(PAD, 4.5, 1); // beside the chopper, out of the camera's line
const rig = createRig(rigHome.x, PAD.y + 1.2, rigHome.z);
fitTool();
const rigView = buildRigView(scene);
const crates = []; // everything the hook can carry: job crates and casualties
// Rapier (WASM) loads in the background; until it's ready, loose loads fall with the simple stepCrate.
let physics = null;
import('./physics.js').then((m) => m.createPhysics(scene)).then((p) => { physics = p; }, (e) => console.warn('Physics off:', e));

// Out of fuel and stopped (or switching aircraft): back to the pad or the dock, rig reset.
function towHome() {
  Object.assign(s, spawnCraft());
  towT = 0;
  if (thrown) { scene.remove(thrown.obj, craft.group); thrown = null; craft = buildCraft(); scene.add(craft.group); } // a new rotor
  if (rig.crate) { rig.crate.held = false; rig.crate = null; }
  Object.assign(rig, createRig(rigHome.x, PAD.y + 1.2, rigHome.z), { tool: rig.tool });
  fitTool();
  prev.pos.copy(s.pos);
}
const onPad = () => onDeck() || s.grounded && [...PADS, ...(career.projects.includes('stations') ? SITES.filter((p) => !p.hospital) : [])].some((p) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < PAD_RADIUS);
const atRigRefuel = () => career.projects.includes('offshore') && ((isBoat() && Math.hypot(s.pos.x - OILRIG.x, s.pos.z - OILRIG.z) < 28 && Math.hypot(s.vel.x, s.vel.z) < 1.5) || (!isBoat() && !isPlane() && s.grounded && Math.hypot(s.pos.x - OILRIG.x, s.pos.z - (OILRIG.z - 14.5)) < 6));
const atStrip = () => isPlane() && s.grounded && onRunway(s.pos.x, s.pos.z); // stopped on the airstrip: refuel and hangar
const atDock = () => isBoat() && s.grounded && Math.hypot(s.pos.x - HARBOUR.x, s.pos.z - HARBOUR.z) < 26; // stopped at the jetty: refuel and hangar
const atBase = () => atStrip() || atDock() || (s.grounded && Math.hypot(s.pos.x - PAD.x, s.pos.z - PAD.z) < PAD_RADIUS); // hangar is open here, even mid-shift
const onShift = () => mode === 'shift' || (mode === 'hangar' && backTo === 'shift');           // shopping mid-shift doesn't stop the clock
const canHangar = () => resumeTo === 'free' || atBase();                                       // free roam: open anywhere
const view = new THREE.Vector3();
let camYaw = s.yaw, loadFocus = 0, ropeDrop = 0, cockpit = false; // cockpit: V swaps the chase camera for the pilot's seat
const EYE = { heli: [0, 1.85, -1.5], plane: [0, 2.5, -3.4], boat: [0, 5.0, -3.3] }, eye = new THREE.Vector3();
const camVel = new THREE.Vector3(); // smoothed chopper velocity: load yanks shouldn't jolt the camera
const look = s.pos.clone();
camera.position.set(s.pos.x + Math.sin(camYaw) * 16, s.pos.y + 6, s.pos.z + Math.cos(camYaw) * 16);

// Compass tape: 2 px per degree, north = -z. Labels run from -180 to 540 degrees so the visible window never runs off the end.
const compass = document.getElementById('compass'), tape = compass.querySelector('.tape'), goalMark = compass.querySelector('.goal');
const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
tape.innerHTML = Array.from({ length: 49 }, (_, i) => i * 15 - 180).map((d) => { const c = CARD[(d + 360) % 360]; return `<span class="${c ? `card${c === 'N' ? ' n' : ''}` : ''}" style="left:${(d + 180) * 2}px">${c || '|'}</span>`; }).join('');
const camDir = new THREE.Vector3();
function updateCompass(goal, type) {
  const half = compass.clientWidth / 2, d = camera.getWorldDirection(camDir), heading = (Math.atan2(d.x, -d.z) * 180) / Math.PI;
  tape.style.transform = `translateX(${half - (((heading + 360) % 360) + 180) * 2}px)`;
  goalMark.style.display = goal ? '' : 'none';
  if (!goal) return;
  let rel = (Math.atan2(goal.x - view.x, -(goal.z - view.z)) * 180) / Math.PI - heading;
  rel = ((rel + 540) % 360) - 180;
  const edge = Math.abs(rel) > (half - 30) / 2; // off the tape: pin to the edge, pointing the way to turn
  goalMark.className = `goal ${type}`;
  goalMark.style.left = `${half + Math.max(-(half - 30), Math.min(half - 30, rel * 2))}px`;
  goalMark.textContent = `${edge && rel < 0 ? '◀ ' : ''}◆ ${(goal.dist / 1000).toFixed(1)} km${edge && rel > 0 ? ' ▶' : ''}`;
}

// Minimap: the island from above (painted once from the heightmap), then fires, pads, calls, the objective and you.
const MAP = 176, SPAN = 3200, mini = Object.assign(document.createElement('canvas'), { id: 'minimap', width: MAP, height: MAP }), mctx = mini.getContext('2d');
document.body.appendChild(mini);
// M opens the big map: the same layers at 760 px, with place names, labelled calls, legend, and wheel zoom / drag pan.
const BIG = 760, bigMap = Object.assign(document.createElement('canvas'), { id: 'bigmap', width: BIG, height: BIG, hidden: true }), bctx = bigMap.getContext('2d');
document.body.appendChild(bigMap);
const mapView = { zoom: 1, x: 0, z: 0, dragging: false, lx: 0, ly: 0 };
const clampMap = () => {
  const max = SPAN * 0.5 * (1 - 1 / mapView.zoom);
  mapView.x = Math.max(-max, Math.min(max, mapView.x));
  mapView.z = Math.max(-max, Math.min(max, mapView.z));
};
bigMap.addEventListener('wheel', (e) => {
  e.preventDefault(); e.stopPropagation();
  const r = bigMap.getBoundingClientRect(), ux = (e.clientX - r.left) / r.width - 0.5, uz = (e.clientY - r.top) / r.height - 0.5;
  const old = mapView.zoom, next = Math.min(6, Math.max(1, old * Math.exp(-e.deltaY * 0.0015)));
  mapView.x += ux * SPAN * (1 / old - 1 / next);
  mapView.z += uz * SPAN * (1 / old - 1 / next);
  mapView.zoom = next;
  clampMap();
}, { passive: false });
bigMap.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  mapView.dragging = true; mapView.lx = e.clientX; mapView.ly = e.clientY;
  bigMap.classList.add('drag');
  bigMap.setPointerCapture?.(e.pointerId);
});
bigMap.addEventListener('pointermove', (e) => {
  if (!mapView.dragging) return;
  const r = bigMap.getBoundingClientRect(), span = SPAN / mapView.zoom;
  mapView.x -= ((e.clientX - mapView.lx) / r.width) * span;
  mapView.z -= ((e.clientY - mapView.ly) / r.height) * span;
  mapView.lx = e.clientX; mapView.ly = e.clientY;
  clampMap();
});
const stopMapDrag = () => { mapView.dragging = false; bigMap.classList.remove('drag'); };
bigMap.addEventListener('pointerup', stopMapDrag);
bigMap.addEventListener('pointercancel', stopMapDrag);
bigMap.addEventListener('dblclick', (e) => { e.stopPropagation(); mapView.zoom = 1; mapView.x = mapView.z = 0; });
const paintIsland = (size) => { // the island from the heightmap, once per size
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size }), g = c.getContext('2d'), img = g.createImageData(size, size);
  const tint = (h) => (h < -6 ? [38, 82, 104] : h < -0.3 ? [74, 150, 150] : h < 2 ? [226, 200, 150] : h < 60 ? [112, 150, 78] : h < 130 ? [90, 120, 66] : [150, 126, 138]);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) img.data.set([...tint(heightAt((i / size - 0.5) * SPAN, (j / size - 0.5) * SPAN)), 235], (j * size + i) * 4);
  g.putImageData(img, 0, 0);
  return c;
};
const mapBase = paintIsland(MAP);
let bigBase = null; // painted the first time the big map opens
const PLACES = [{ ...PAD, name: 'Base' }, { ...PADS[1], name: 'Islet depot' }, ...SITES, { ...HARBOUR, x: HARBOUR.hx, z: HARBOUR.hz, name: 'Harbour' }, { ...RUNWAY, name: 'Airstrip' }, { ...LIGHTHOUSE, name: 'Lighthouse' }, { ...OILRIG, name: 'Oil Rig' }];
const CALL_COLOR = { fire: '#ff7a4a', cargo: '#ffd060', rescue: '#6fdcff', spot: '#ffae6a' };
function drawMap(g, size, goal, big) {
  const zm = big ? mapView.zoom : 1, cx = big ? mapView.x : 0, cz = big ? mapView.z : 0;
  const k = size / MAP, mpx = (v) => ((v - cx) / (SPAN / zm) + 0.5) * size, mpz = (v) => ((v - cz) / (SPAN / zm) + 0.5) * size;
  const dot = (x, z, r, color) => { g.fillStyle = color; g.beginPath(); g.arc(mpx(x), mpz(z), r * k ** 0.5, 0, 6.3); g.fill(); };
  const label = (text, x, z, color = '#fff', dy = -9) => { // kept inside the frame
    g.font = '600 12px ui-monospace, monospace'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = '#0009';
    const px = mpx(x), pz = mpz(z);
    if (px < -40 || px > size + 40 || pz < -40 || pz > size + 40) return;
    const half = g.measureText(text).width / 2 + 4, lx = Math.min(size - half, Math.max(half, px)), ly = Math.min(size - 6, Math.max(14, pz + dy));
    g.strokeText(text, lx, ly); g.fillStyle = color; g.fillText(text, lx, ly);
  };
  g.clearRect(0, 0, size, size);
  if (big) {
    const sw = size / zm, sx = (cx / SPAN + 0.5) * size - sw / 2, sy = (cz / SPAN + 0.5) * size - sw / 2;
    g.drawImage(bigBase, sx, sy, sw, sw, 0, 0, size, size);
  } else g.drawImage(mapBase, 0, 0);
  const pxPerM = (size * zm) / SPAN;
  g.strokeStyle = '#d8c49a77'; g.lineWidth = Math.max(1, 3.2 * pxPerM); g.lineCap = 'round'; g.lineJoin = 'round';
  for (const r of ROADS) {
    g.beginPath();
    r.forEach(([x, z], i) => (i ? g.lineTo(mpx(x), mpz(z)) : g.moveTo(mpx(x), mpz(z))));
    g.stroke();
  }
  g.save();
  g.translate(mpx(RUNWAY.x), mpz(RUNWAY.z));
  g.rotate(-RUNWAY.yaw);
  const rw = Math.max(3, RUNWAY.width * pxPerM), rl = Math.max(12, RUNWAY.len * pxPerM);
  g.fillStyle = '#363842'; g.fillRect(-rw / 2, -rl / 2, rw, rl);
  g.strokeStyle = '#fffb'; g.lineWidth = Math.max(1, 0.8 * k ** 0.5);
  g.beginPath(); g.moveTo(0, -rl * 0.42); g.lineTo(0, rl * 0.42); g.stroke();
  g.restore();
  g.fillStyle = '#ff5a1e';
  for (const c of fire.burning) { const p = cellCentre(c); g.fillRect(mpx(p.x) - k * zm ** 0.5, mpz(p.z) - k * zm ** 0.5, 2.5 * k * zm ** 0.5, 2.5 * k * zm ** 0.5); }
  for (const p of SITES) {
    const sx = mpx(p.x), sz = mpz(p.z), tr = Math.max(4 * k ** 0.5, (p.islet ? 28 : 42) * pxPerM);
    g.fillStyle = '#2d243866'; g.beginPath(); g.arc(sx, sz, tr, 0, 6.3); g.fill();
    g.fillStyle = '#e8a87c';
    const b = Math.max(1.8, 6 * pxPerM);
    for (const [ox, oz] of [[-0.45, -0.35], [0.3, -0.4], [-0.35, 0.35], [0.4, 0.3]]) g.fillRect(sx + ox * tr - b / 2, sz + oz * tr - b / 2, b, b);
    if (p.hospital) {
      const cr = Math.max(3, 5 * k ** 0.5);
      g.fillStyle = '#fff'; g.fillRect(sx - cr, sz - cr, cr * 2, cr * 2);
      g.fillStyle = '#d8352a'; g.fillRect(sx - cr * 0.65, sz - cr * 0.22, cr * 1.3, cr * 0.44); g.fillRect(sx - cr * 0.22, sz - cr * 0.65, cr * 0.44, cr * 1.3);
    }
  }
  for (const p of [...PADS, ...SITES]) if (!p.hospital) { g.fillStyle = '#ffffffc8'; g.fillRect(mpx(p.x) - 2 * k ** 0.5, mpz(p.z) - 2 * k ** 0.5, 4 * k ** 0.5, 4 * k ** 0.5); }
  dot(HARBOUR.x, HARBOUR.z, 2.5, '#9fd0ff');
  g.save(); g.translate(mpx(OILRIG.x), mpz(OILRIG.z)); g.scale(k ** 0.5, k ** 0.5);
  g.fillStyle = '#f2b632'; g.strokeStyle = '#000a'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, -4.5); g.lineTo(4.5, 0); g.lineTo(0, 4.5); g.lineTo(-4.5, 0); g.closePath(); g.fill(); g.stroke();
  g.restore();
  const shipIcon = (x, z, yaw, variant) => {
    g.save(); g.translate(mpx(x), mpz(z)); g.rotate(-yaw); g.scale(k ** 0.5, k ** 0.5);
    g.fillStyle = variant === 'passenger' ? '#ffffff' : variant === 'cargo' ? '#ffb366' : '#dfe5f2';
    g.strokeStyle = '#000a'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, -6.5); g.lineTo(2.4, -2.2); g.lineTo(2.4, 5.0); g.lineTo(1.7, 6.0); g.lineTo(-1.7, 6.0); g.lineTo(-2.4, 5.0); g.lineTo(-2.4, -2.2); g.closePath();
    g.fill(); g.stroke();
    if (variant === 'passenger') { g.fillStyle = '#3ec5d4'; g.fillRect(-1.2, -2.5, 2.4, 5.6); }
    else if (variant === 'cargo') { g.fillStyle = '#d8452e'; g.fillRect(-1.3, -2.8, 2.6, 2.0); g.fillStyle = '#2b6e8c'; g.fillRect(-1.3, 0.0, 2.6, 2.0); }
    else { g.fillStyle = '#ffd060'; g.beginPath(); g.arc(0, -1.5, 1.3, 0, 6.3); g.fill(); }
    g.restore();
  };
  shipIcon(SHIP.x, SHIP.z, SHIP.yaw, 'helideck');
  for (const sh of SHIPS) shipIcon(sh.x, sh.z, sh.yaw, sh.variant);
  if (big) {
    for (const p of PLACES) label(p.name, p.x, p.z, p.hospital ? '#ffd060' : '#fff');
    label('MV Kestrel', SHIP.x, SHIP.z, '#cfd6e6', 16);
    for (const sh of SHIPS) label(sh.name, sh.x, sh.z, sh.variant === 'passenger' ? '#9fe8f5' : '#ffd08a', sh.variant === 'passenger' ? -12 : 16);
  }
  if (dispatch && (big || t % 1 < 0.7)) for (const o of dispatch.calls) { dot(o.x, o.z, 3.5, CALL_COLOR[o.type]); if (big) label(o.type.toUpperCase(), o.x, o.z, CALL_COLOR[o.type], 18); }
  if (goal) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(mpx(goal.x), mpz(goal.z), 6 * k ** 0.5, 0, 6.3); g.stroke(); }
  g.save(); // you: an arrow along your heading (north, -z, is up)
  g.translate(mpx(s.pos.x), mpz(s.pos.z)); g.rotate(-s.yaw); g.scale(k ** 0.5, k ** 0.5);
  g.fillStyle = '#fff'; g.strokeStyle = '#000a'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, -7); g.lineTo(4.5, 5); g.lineTo(0, 2.5); g.lineTo(-4.5, 5); g.closePath(); g.fill(); g.stroke();
  g.restore();
  if (big) { // legend, zoom indicator & controls
    g.font = '12px ui-monospace, monospace'; g.textAlign = 'left';
    [['Fire', CALL_COLOR.fire], ['Cargo', CALL_COLOR.cargo], ['Rescue', CALL_COLOR.rescue], ['Burning', '#ff5a1e'], ['Oil Rig', '#ffb84d'], ['Cargo ship', '#ffd08a'], ['Ferry', '#9fe8f5'], ['Settlement', '#e8a87c']].forEach(([n, c], i) => { g.fillStyle = '#0008'; g.fillRect(10, 10 + i * 18, 104, 16); g.fillStyle = c; g.fillRect(14, 14 + i * 18, 8, 8); g.fillStyle = '#fff'; g.fillText(n, 28, 22 + i * 18); });
    g.fillStyle = '#0008'; g.fillRect(size - 96, 10, 86, 28);
    g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(`ZOOM ${zm.toFixed(1)}×`, size - 16, 24);
    g.fillStyle = '#fff3'; g.fillRect(size - 90, 29, 74, 4);
    g.fillStyle = '#ffd060'; g.fillRect(size - 90, 29, 74 * ((zm - 1) / 5), 4);
    const hint = 'Wheel: zoom · Drag: pan · Dbl-click: reset · M: close';
    const hw = g.measureText(hint).width + 14;
    g.fillStyle = '#0008'; g.fillRect(size - hw - 8, size - 26, hw, 18);
    g.fillStyle = '#fffe'; g.textAlign = 'right'; g.fillText(hint, size - 15, size - 13);
  } else {
    g.font = 'bold 11px ui-monospace, monospace'; g.textAlign = 'right';
    g.fillStyle = '#0008'; g.fillRect(size - 52, size - 20, 47, 15);
    g.fillStyle = '#fffd'; g.fillText('M: Map', size - 9, size - 9);
  }
}
const drawMini = (goal) => { drawMap(mctx, MAP, goal, false); if (!bigMap.hidden) drawMap(bctx, BIG, goal, true); };

const hud = document.getElementById('hud'), prompt = document.getElementById('prompt'), board = document.getElementById('board');
let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0, t = 0, simT = 0, trauma = 0, towT = 0, flash = '', flashT = 0;
const say = (msg, minor) => { if (minor && flashT > 0) return; flash = msg; flashT = 2.5; }; // minor messages don't overwrite others

// Modes: 'title' (menu over a parked aircraft), 'shift', 'free' (free roam: no calls, endless fuel), 'paused',
// 'results' (the shift summary) and 'hangar'.
// A shift resets the island, then the director escalates until chaos fills.
// (and fire spread) from today's date, so everyone gets the same calls in the same places.
let mode = 'title', dispatch = null, backTo = 'title', resumeTo = 'free';
const overlay = document.getElementById('overlay'), meter = document.getElementById('meter');
let resultsHtml = '';
const btn = (key, label, sub = '') => `<button data-key="${key}"><b>${key === 'Escape' ? 'Esc' : key.replace(/^(Digit|Key)/, '')}</b>${label}<span>${sub}</span></button>`;
const today = () => new Date().toISOString().slice(0, 10);
// Rank progress: a bar from this rank to the next (gained: the part just earned, drawn brighter), and what the next unlocks.
const rankLine = (gained = 0) => {
  const r = rankOf(career), cur = RANKS[r], next = RANKS[r + 1], xp = career.xp || 0;
  if (!next) return `<span class="rankhead"><b>${cur.name}</b> · top rank · ${xp.toLocaleString()} XP</span>`;
  const span = next.xp - cur.xp, now = ((xp - cur.xp) / span) * 100, was = Math.max(0, ((xp - gained - cur.xp) / span) * 100);
  return `<span class="rankhead"><b>${cur.name}</b><span>${(xp - cur.xp).toLocaleString()} / ${span.toLocaleString()} XP</span></span>
    <span class="xpbar"><i style="width:${was}%"></i><i class="new" style="left:${was}%;width:${now - was}%"></i></span>
    <span class="dim">Next: <b>${next.name}</b> unlocks ${next.unlocks}</span>`;
};
const track = (name, props) => { try { window.plausible?.(name, props ? { props } : undefined); } catch {} };

const LOGO = `<svg viewBox="0 0 436 116" role="img" aria-label="Sling &amp; Scoop">
  <defs>
    <clipPath id="badgeClip">
      <polygon points="22,6 92,6 108,22 108,90 92,106 22,106 6,90 6,22"/>
    </clipPath>
    <linearGradient id="gSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#231c3d"/>
      <stop offset="65%" stop-color="#48294a"/>
      <stop offset="100%" stop-color="#1a3958"/>
    </linearGradient>
    <linearGradient id="gSun" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd060" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#f2763a" stop-opacity="0.22"/>
    </linearGradient>
    <linearGradient id="gSling" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff6eb"/>
      <stop offset="48%" stop-color="#ffd060"/>
      <stop offset="100%" stop-color="#f2763a"/>
    </linearGradient>
    <linearGradient id="gScoop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#9fe8f5"/>
      <stop offset="100%" stop-color="#2ebbd6"/>
    </linearGradient>
    <linearGradient id="gWake" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1a4d6b" stop-opacity="0.25"/>
      <stop offset="22%" stop-color="#2b6e8c" stop-opacity="0.95"/>
      <stop offset="72%" stop-color="#3ec5d4" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#9fe8f5" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gCrest" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#6fdcff" stop-opacity="0.35"/>
      <stop offset="35%" stop-color="#9fe8f5" stop-opacity="1"/>
      <stop offset="82%" stop-color="#fff4e6" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Left Aviation Crest (consistent with the browser favicon) -->
  <polygon points="24,9 94,9 110,25 110,93 94,109 24,109 8,93 8,25" fill="#0d0919" opacity="0.7"/>
  <g clip-path="url(#badgeClip)">
    <rect x="6" y="6" width="102" height="100" fill="url(#gSky)"/>
    <circle cx="57" cy="78" r="31" fill="url(#gSun)"/>
    <polygon points="6,84 31,52 51,67 77,42 108,84" fill="#18132b"/>
    <polygon points="31,52 41,64 21,84 6,84" fill="#f2763a" opacity="0.28"/>
    <polygon points="77,42 86,58 67,84 51,67" fill="#ffd060" opacity="0.2"/>

    <!-- Rotor blades (tilted slightly for motion) -->
    <g transform="rotate(-5 57 23)">
      <polygon points="12,21 102,21 100,25 14,25" fill="#ffd060"/>
      <polygon points="12,21 27,21 26,25 14,25" fill="#f2763a"/>
      <polygon points="87,21 102,21 100,25 88,25" fill="#f2763a"/>
      <rect x="26" y="21" width="62" height="1.3" fill="#fff4e6" opacity="0.75"/>
      <polygon points="51,17 63,17 65,25 49,25" fill="#fff4e6"/>
    </g>

    <!-- Winch mast & orange '&' sling hook -->
    <rect x="54.5" y="24" width="5" height="9" fill="#fff4e6"/>
    <line x1="57" y1="33" x2="57" y2="40" stroke="#ffd060" stroke-width="2.4"/>
    <g transform="translate(1.5,2.5)" opacity="0.75">
      <circle cx="57" cy="44" r="5" fill="#0d0919"/>
      <path d="M57 49 L46 57 C39 62 41 74 50 77 C60 80 70 75 73 65 L66 62 C64 68 58 70 53 68 C49 66 49 62 53 59 L62 52 Z" fill="#0d0919"/>
    </g>
    <circle cx="57" cy="44" r="5" fill="#18132b" stroke="#ffd060" stroke-width="2.6"/>
    <path d="M57 49 L46 57 C39 62 41 74 50 77 C60 80 70 75 73 65 L66 62 C64 68 58 70 53 68 C49 66 49 62 53 59 L62 52 Z" fill="#f2763a" stroke="#fff4e6" stroke-width="1" stroke-linejoin="round"/>

    <!-- Low-poly ocean wave at badge base -->
    <polygon points="6,86 33,80 58,86 83,79 108,85 108,106 6,106" fill="#1e5473"/>
    <polygon points="33,80 58,86 44,106 6,106 6,86" fill="#2b6e8c"/>
    <path d="M6 86 L33 80 L58 86 L83 79 L108 85" fill="none" stroke="#6fdcff" stroke-width="3" stroke-linejoin="round"/>
  </g>
  <polygon points="22,6 92,6 108,22 108,90 92,106 22,106 6,90 6,22" fill="none" stroke="#ffd060" stroke-width="1.8" opacity="0.7"/>
  <polyline points="6,88 22,104 92,104 108,88" fill="none" stroke="#6fdcff" stroke-width="1.8" opacity="0.6"/>

  <!-- Wordmark Lockup -->
  <g font-family="'Arial Black', 'Avenir Next', Impact, system-ui, sans-serif" font-weight="900" font-style="italic" letter-spacing="2">
    <text x="127" y="49" font-size="45" fill="#0d0919">SLING</text>
    <text x="124" y="45" font-size="45" fill="url(#gSling)" stroke="#140f26" stroke-width="6" paint-order="stroke" stroke-linejoin="round">SLING</text>

    <text x="128" y="92" font-size="34" fill="#0d0919">&amp;</text>
    <text x="125" y="88" font-size="34" fill="#f2763a" stroke="#140f26" stroke-width="5" paint-order="stroke" stroke-linejoin="round">&amp;</text>

    <text x="163" y="93" font-size="45" fill="#0d0919">SCOOP</text>
    <text x="160" y="89" font-size="45" fill="url(#gScoop)" stroke="#140f26" stroke-width="6" paint-order="stroke" stroke-linejoin="round">SCOOP</text>
  </g>

  <!-- Sweeping Scoop Wake -->
  <path d="M120 101 C182 97 238 102 308 98 C358 95 394 97 424 89 C404 102 356 105 292 106 C214 107 156 104 120 101 Z" fill="url(#gWake)"/>
  <path d="M120 101 C182 97 238 102 308 98 C358 95 394 97 424 89" fill="none" stroke="url(#gCrest)" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
const menuHtml = () => `<div class="brand">${LOGO}</div><p class="tag">Island air dispatch</p><nav class="menu">
  ${btn('Digit1', 'Start shift', 'Fight wildfires, sling cargo, pull people out of trouble')}
  ${btn('Digit2', 'Free roam', 'No calls, no clock, unlimited fuel')}
  ${btn('Digit3', 'Hangar', `Bank $${career.bank.toLocaleString()}`)}
  ${btn('Digit4', 'Settings', 'Controls, volume, look sensitivity')}
  ${btn('Digit5', 'Daily challenge', `Today's shift, the same for everyone${career.daily?.date === today() ? ` · your best $${career.daily.best.toLocaleString()}` : ''}`)}</nav>
  <div class="rank">${rankLine()}</div>
  <p class="dim small">Calls left waiting fill the chaos meter; when it's full the shift ends. Finish jobs back to back to chain them for bonus pay.</p>
  <p class="credit">Bomber engine sound: "airplane prop loop" by AntumDeluge, from a recording by jakobthiesen (CC BY 3.0)</p>
  <p class="about">Built entirely by AI models · open source · <a href="https://github.com/Suleman28/sling-and-scoop" target="_blank" rel="noopener">github.com/Suleman28/sling-and-scoop</a></p>`;
const pauseHtml = () => `<section class="card"><h1>Paused</h1><div class="rank">${rankLine()}${resumeTo === 'shift' && dispatch?.stats.earned ? `<span class="dim">+${Math.round(dispatch.stats.earned).toLocaleString()} XP this shift, added when you clock off</span>` : ''}</div><nav class="menu">${btn('Escape', 'Resume')}${canHangar() ? btn('KeyH', 'Hangar') : ''}
  ${resumeTo === 'shift' ? btn('Digit2', 'End shift', 'Bank what you have earned so far') : btn('Digit2', 'Main menu')}${btn('Digit3', 'Settings', 'Controls and options')}</nav></section>`;
const kb = (...k) => k.map((x) => `<kbd>${x}</kbd>`).join('');
const group = (title, rows) => `<div><h3>${title}</h3><table>${rows.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('')}</table></div>`;
const CONTROLS = [
  ['Helicopter', [[kb('W', 'S'), 'Pitch forward / back'], [kb('A', 'D'), 'Turn'], [kb('Q', 'E'), 'Strafe'], [kb('Space', 'Shift'), 'Climb / descend'],
    [kb('F'), 'Action: dump, hook, release'], [kb('R'), 'Swap bucket / hook'], [kb('Z', 'C'), 'Winch in / out']]],
  ['Water Bomber', [[kb('Space', 'Shift'), 'Throttle up / down'], [kb('W', 'S'), 'Pitch nose down / up'], [kb('A', 'D'), 'Bank'], [kb('Q', 'E'), 'Rudder'],
    [kb('Skim'), 'Skim the sea above ~65 km/h to scoop water'], [kb('F'), 'Drop water']]],
  ['Rescue Cutter', [[kb('W', 'S'), 'Throttle ahead / astern'], [kb('A', 'D'), 'Wheel (waterjets + thrusters)'], [kb('Q', 'E'), 'Bow & stern side thrusters'], [kb('R'), 'Moor / drop anchor'], [kb('Drag / Right-click'), 'Aim the water cannons and searchlight: left/right to train, look down to throw shorter'], [kb('F'), 'Hold: fire water cannons'], [kb('G'), 'Horn'], [kb('Auto'), 'Stop alongside to pull a casualty aboard; land them at the jetty head']]],
  // (the list above is the Rescue Cutter's)
  ['General', [[kb('1', '–', '5'), 'Take a call (up to two at once)'], [kb('J'), 'Switch between your two jobs'], [kb('V'), 'Cockpit / chase view'], [kb('L'), 'Searchlight (helicopters, cutter)'], [kb('X'), 'Abandon the job'], [kb('H'), 'Hangar (at base, anywhere in free roam)'], [kb('M'), 'Big map with place names'], [kb('K'), 'Mute'], [kb('Esc'), 'Pause / back'],
    [kb('Drag'), 'Look around'], [kb('Right-click / Tab'), 'Toggle free-look (pointer lock)'], [kb('Double-click / Middle'), 'Center camera behind craft'], [kb('Wheel'), 'Zoom']]],
];
const OPTS = [['volume', 'Master volume', 'range', 0, 1], ['sens', 'Mouse look sensitivity', 'range', 0.25, 2], ['invertY', 'Invert look Y'], ['autoCenter', 'Auto-center aircraft camera'], ['fps', 'Show FPS'], ['hint', 'Show controls hint while flying'], ['physics', 'Physics flight: real rope, collisions, crashes']];
const optHtml = ([k, label, type, min, max]) => type
  ? `<label><span>${label}</span><input type="range" data-opt="${k}" min="${min}" max="${max}" step="0.05" value="${opts[k]}"><output>${Math.round(opts[k] * 100)}%</output></label>`
  : `<label><span>${label}</span><input type="checkbox" data-opt="${k}"${opts[k] ? ' checked' : ''}></label>`;
let settingsFrom = 'title';
function openSettings() { settingsFrom = mode; setMode('settings'); }
function closeSettings() { setMode(settingsFrom); }
let setTab = 0; // settings pages: Options, one per CONTROLS group, About
const TABS = ['Options', ...CONTROLS.map(([t]) => t), 'About'];
const settingsHtml = () => {
  const c = CONTROLS[setTab - 1], body = setTab === 0 ? `<div class="opts">${OPTS.map(optHtml).join('')}</div>`
    : c ? `<div class="ctl">${group(c[0], c[1])}</div>${setTab > 2 ? '' : '<p class="dim small">Arrow keys also fly: up/down pitch, left/right turn (bank).</p>'}`
    : '<p class="about">Built entirely by AI models · open source · <a href="https://github.com/Suleman28/sling-and-scoop" target="_blank" rel="noopener">github.com/Suleman28/sling-and-scoop</a></p>';
  return `<div><h1>Settings</h1><nav class="tabs">${TABS.map((t, n) => `<button data-key="Tab${n}"${n === setTab ? ' class="on"' : ''}>${t}</button>`).join('')}</nav><section class="tabbody" data-fresh="${setTab + 1}">${body}</section>
  <nav class="menu row">${btn('Escape', 'Back')}</nav></div>`;
};
overlay.addEventListener('input', (e) => {
  const el = e.target, k = el.dataset.opt;
  if (!k) return;
  opts[k] = el.type === 'checkbox' ? el.checked : +el.value;
  if (el.type === 'range') el.nextElementSibling.textContent = `${Math.round(opts[k] * 100)}%`;
  if (k === 'volume') setVolume(opts.volume);
  if (k === 'hint') setHelp();
  saveOpts();
});
// The overlay and which HUD parts show (CSS keys off body[data-mode]) follow the mode.
function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  overlay.className = m === 'title' ? 'side' : m === 'settings' ? 'settings' : '';
  overlay.style.display = m === 'shift' || m === 'free' ? 'none' : '';
  if (m === 'shift' || m === 'free') shown = '';
  else if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
  if (m === 'title') render(menuHtml(), m);
  if (m === 'results') render(resultsHtml, m);
  if (m === 'paused') render(pauseHtml(), m);
  if (m === 'settings') render(settingsHtml(), m);
}
// Menus are written as HTML strings. A new screen replaces the overlay (and plays its entrance); the same screen again
// (a purchase, a tab, the showroom arrows) is morphed onto the new markup, so only what changed is touched: no
// flicker, no replayed animation, the scroll stays put.
let shown = '';
function render(html, screen) {
  const next = document.createElement('div');
  next.innerHTML = html;
  if (screen !== shown) { overlay.replaceChildren(...next.childNodes); overlay.scrollTop = 0; shown = screen; }
  else morph(overlay, next);
}
const patch = (el, html) => { const n = document.createElement('div'); n.innerHTML = html; morph(el, n); }; // the in-flight board and meter, too
// Make a's children match b's, reusing nodes where the tag is the same. data-keep: built in code (the showroom canvas),
// left alone; data-fresh: replaced when its value changes, so it plays its entrance again (a new hangar message).
function morph(a, b) {
  const an = [...a.childNodes], bn = [...b.childNodes];
  bn.forEach((n, i) => {
    const o = an[i];
    if (!o) return a.appendChild(n);
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName || (n.dataset?.fresh && n.dataset.fresh !== o.dataset.fresh)) return a.replaceChild(n, o);
    if (n.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; }
    for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
    for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
    if (!o.hasAttribute('data-keep')) morph(o, n);
  });
  for (let i = an.length - 1; i >= bn.length; i--) a.removeChild(an[i]);
}
setMode('title');
setHelp();
// With the hint off, tell new players once where the controls went.
function tip() {
  if (opts.hint || opts.tipSeen) return;
  opts.tipSeen = true; saveOpts();
  say('Esc: pause · Settings for controls'); flashT = 6;
}
// A fresh island to fly around: no calls, fires out, back at home.
function startFree() {
  if (dispatch) disposeDispatch(dispatch);
  dispatch = window.__game.dispatch = null;
  resetFire(fire, 1);
  resetScorch(houses);
  physics?.reset();
  towHome();
  resumeTo = 'free';
  setMode('free');
  track('free_roam', { airframe: career.airframe });
  tip();
}
function startShift(daily = false) {
  const seed = daily ? dailySeed(today()) : (Math.random() * 2 ** 31) | 0, rank = rankOf(career);
  if (dispatch) disposeDispatch(dispatch);
  resetFire(fire, seed);
  resetScorch(houses);
  physics?.reset();
  towHome();
  s.fuel = 1;
  s.tankWater = 0; s.tankDumping = false; s.snorkel = false;
  rig.water = 0;
  simT = 0;
  dispatch = createDispatch({ scene, fire, houses, crates, can: (type) => jobsOf(career).includes(type) && (type !== 'fire' || isPlane() || isBoat() || hasTank(career) || toolsOf(career).includes('bucket')), firepower: () => (isPlane() ? PLANE.tank : (hasTank(career) || toolsOf(career).includes('bucket')) ? RIG.cap : 0), sea: isBoat, ship: isBoat() || isPlane() ? null : shipPad, squall: () => weather.storm > 0.3, blast: (p) => explodeFx(p.x, p.y, p.z), lookout: () => career.projects.includes('towers') }, seed);
  // Night shifts (from Line Pilot): a quarter of shifts, decided by the seed, so a daily challenge is the same for everyone.
  Object.assign(dispatch, { rank, daily, night: rank >= 1 && ((seed >>> 3) & 3) === 0 });
  spot.on = !!dispatch.night;
  if (dispatch.night) say(`Night shift: pay +${Math.round((SHIFT.nightPay - 1) * 100)}%. Searchlight on (L)`);
  window.__game.dispatch = dispatch;
  resumeTo = 'shift';
  setMode('shift');
  track('shift_start', { airframe: career.airframe, daily });
  tip();
}
const cost = (n) => (Math.round(n) ? `−$${Math.round(n).toLocaleString()}` : '<span class="dim">—</span>');
function endShift(quit) {
  const rank0 = rankOf(career), st = dispatch.stats, net = netOf(st), best = recordShift(career, st.earned, st.earned - net), rank1 = rankOf(career);
  const dailyBest = dispatch.daily && (career.daily?.date !== today() || net > career.daily.best);
  if (dispatch.daily && dailyBest) career.daily = { date: today(), best: net };
  saveCareer(storage, career);
  const mins = `${Math.floor(dispatch.t / 60)}:${String(Math.floor(dispatch.t % 60)).padStart(2, '0')}`;
  const score = net - 400 * (st.lost + st.housesLost), grade = score >= 4500 ? 'S' : score >= 2800 ? 'A' : score >= 1400 ? 'B' : score >= 500 ? 'C' : 'D';
  resultsHtml = `<section class="card"><h1>Shift over</h1><p class="grade">${grade}</p><p class="dim">Shift · ${quit ? 'clocked off' : 'chaos took over'} at ${mins}</p>
    ${rank1 > rank0 ? `<p class="rankup">PROMOTED: ${RANKS[rank1].name}! New kinds of call open up.</p>` : ''}<div class="rank">${rankLine(Math.max(0, Math.round(st.earned)))}</div>${dispatch.daily || dispatch.night ? `<p class="dim small">${[dispatch.daily && `Daily challenge${dailyBest ? ': new best for today' : ''}`, dispatch.night && 'Night shift'].filter(Boolean).join(' · ')}</p>` : ''}
    <table><tr><td>Fires out</td><td>${st.done.fire}</td></tr><tr><td>Deliveries</td><td>${st.done.cargo}</td></tr><tr><td>Rescues &amp; runs</td><td>${st.done.rescue}</td></tr>${st.done.spot ? `<tr><td>Smoke spotted</td><td>${st.done.spot}</td></tr>` : ''}
    <tr><td>Best chain</td><td>${st.bestCombo} jobs (×${comboMult(st.bestCombo).toFixed(2)})</td></tr>
    <tr><td>Houses lost</td><td>${st.housesLost}</td></tr><tr><td>Casualties lost</td><td>${st.lost}</td></tr>
    <tr><td>Earned</td><td>$${st.earned.toLocaleString()}</td></tr>
    <tr><td>Fuel</td><td>${cost(st.fuel)}</td></tr><tr><td>Repairs &amp; losses</td><td>${cost(st.losses)}</td></tr>
    <tr class="big"><td>Net${best ? ' · NEW BEST' : ''}</td><td>${net < 0 ? '−' : ''}$${Math.abs(net).toLocaleString()}</td></tr>
    <tr><td>Best shift</td><td>$${career.best.toLocaleString()}</td></tr>
    <tr><td>Bank</td><td>$${career.bank.toLocaleString()}</td></tr></table>
    <canvas class="route" width="300" height="300"></canvas><p class="dim small">Your route this shift, and where each job ended</p>
    <nav class="menu row">${btn('Digit1', 'New shift')}${btn('KeyH', 'Hangar')}${btn('Escape', 'Main menu')}</nav></section>`;
  setMode('results');
  track('shift_end', { airframe: career.airframe, grade, quit: !!quit });
  drawReport(overlay.querySelector('canvas.route'), dispatch);
}
// The shift report: the island, your track (sampled every 2 s) and a dot where each job finished.
let reportBase = null;
function drawReport(c, d) {
  if (!c) return;
  const g = c.getContext('2d'), n = c.width, mp = (v) => (v / SPAN + 0.5) * n;
  g.drawImage((reportBase ||= paintIsland(n)), 0, 0);
  g.strokeStyle = '#ffffffcc'; g.lineWidth = 1.5; g.lineJoin = 'round'; g.beginPath();
  d.route.forEach(([x, z], i) => (i ? g.lineTo(mp(x), mp(z)) : g.moveTo(mp(x), mp(z))));
  g.stroke();
  for (const m of d.marks) { g.fillStyle = CALL_COLOR[m.type] || '#fff'; g.strokeStyle = '#000a'; g.beginPath(); g.arc(mp(m.x), mp(m.z), 4, 0, 6.3); g.fill(); g.stroke(); }
}

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += dt;
  t += dt;

  const input = readInput();
  let hit = 0;
  if (mode !== 'free' && !onShift()) acc = 0; // menus, pause, results and the hangar between shifts freeze the sim
  while (acc >= STEP) {
    prev.pos.copy(s.pos); prev.yaw = s.yaw; prev.pitch = s.pitch; prev.roll = s.roll;
    stepWeather((simT += STEP));
    updateWind(simT);
    moveShip(simT);
    const dShip = deckShip();
    if (dShip && !s.wreck) {
      if (dShip.dYaw) {
        const dx = s.pos.x - dShip.x, dz = s.pos.z - dShip.z;
        const c = Math.cos(dShip.dYaw), sn = Math.sin(dShip.dYaw);
        s.pos.x = dShip.x + dx * c + dz * sn;
        s.pos.z = dShip.z - dx * sn + dz * c;
        s.yaw += dShip.dYaw;
      }
      s.pos.x += dShip.vx * STEP; s.pos.z += dShip.vz * STEP; s.pos.y = anyDeckAt(s.pos.x, s.pos.z) ?? s.pos.y;
    } // parked on her deck: carried along
    if (isPlane()) {
      if (keys.has('KeyF') && !s.wreck) {
        if (!s.dumping && drop(s)) { sfx('dump'); say(s.salvo ? 'Salvo drop!' : 'Trail drop!'); }
        else if (pending.act && s.water < 0.1) say('Tank empty: skim the sea to scoop');
      } else if (s.dumping) s.dumping = false;
    }
    if (isPlane() && pending.swap) { s.salvo = !s.salvo; sfx('swap'); say(s.salvo ? 'Drop: Salvo (concentrated)' : 'Drop: Trail (long line)'); pending.swap = false; }
    if (pending.swap && toolsOf(career).length) { // R: the next tool, then stowed (no line at all), then round again
      if (toolsOf(career)[0] === 'snorkel') {
        if (rig.stowed || !s.snorkelTarget) {
          if (rig.stowed) Object.assign(rig, createRig(s.pos.x, s.pos.y + RIG.anchor - 0.3, s.pos.z), { tool: 'snorkel', stowed: false, len: 0.3 });
          s.snorkelTarget = RIG.snorkel.line;
          sfx('swap'); say('Snorkel pipe dropping (Z/C length, R retract)');
        } else {
          s.snorkelTarget = 0;
          sfx('swap'); say('Retracting snorkel pipe…');
        }
      } else {
        const list = [...toolsOf(career), 'stowed'], next = list[(list.indexOf(rig.stowed ? 'stowed' : rig.tool) + 1) % list.length];
        if (rig.crate || rig.dumping) say('Release the load first');
        else if (next === 'stowed') { rig.stowed = true; rig.water = 0; sfx('swap'); say('Line stowed'); }
        else {
          if (rig.stowed) Object.assign(rig, createRig(s.pos.x, s.pos.y - 1, s.pos.z), { tool: rig.tool, stowed: false }); // let the line out from under her
          if (next !== rig.tool) swapTool(rig);
          sfx('swap'); say(`Tool: ${rig.tool}`);
        }
      }
      pending.swap = false;
    }
    if (!hasLine()) { if (pending.swap) say(`The ${airframe().name} has no line`); pending.act = pending.swap = false; }
    if (s.wreck) pending.act = pending.swap = false;
    if (pending.act) {
      const r = act(rig, crates), what = rig.crate?.spec === RIG.person ? 'Casualty' : 'Load';
      if (r === 'hooked') { sfx('hook'); say(`${what} hooked`); }
      if (r === 'released') { sfx('release'); say('Load released'); }
      if (r === 'dump') sfx('dump');
    }
    if (pending.accept >= 0 && dispatch) {
      const j = accept(dispatch, pending.accept);
      if (j) { sfx('accept'); say(`Accepted: ${j.title}${dispatch.jobs.length > 1 ? ' (J switches between your jobs)' : ''}`); }
      else if (dispatch.jobs.length >= MAX_JOBS && dispatch.calls[pending.accept]) say(`You have ${MAX_JOBS} jobs on: finish one, or X to hand one back`);
    }
    if (pending.abandon && dispatch?.job) { if (rig.crate && (dispatch.job.crate === rig.crate || dispatch.job.person === rig.crate)) act(rig, crates); abandon(dispatch); say('Job returned to the board'); }
    pending.accept = -1;
    pending.abandon = false;
    pending.act = pending.swap = false;
    env.loadMass = (hasLine() && rig.taut ? massOf(rig) : 0) + (hasTank(career) ? (s.tankWater || 0) * RIG.waterMass : 0);
    env.power = 1 - 0.3 * (s.damage || 0);
    if (mode === 'free') s.fuel = 1;
    const fly = !!physics && opts.physics; // flight physics: Rapier carries the aircraft and the rope (see physics.js)
    if (s.wreck) { s.hit = 0; s.tankDumping = false; s.snorkel = false; }
    else if (isPlane()) { stepPlane(s, input, STEP, env); spawnPlaneDrops(s.poured); }
    else if (isBoat()) { stepBoat(s, input, STEP, boatEnv); if ((s.jet = keys.has('KeyF') && s.fuel > 0)) spawnJets(); }
    else {
      stepFlight(s, input, STEP, env);
      if (hasTank(career)) {
        s.snorkel = hasLine() && rig.dipped;
        if (s.snorkel && (s.tankWater || 0) < RIG.cap) {
          s.tankWater = Math.min(RIG.cap, (s.tankWater || 0) + (RIG.cap / 11) * STEP); // ~11 s to pump a full 2.2x belly tank
          if (s.tankWater >= RIG.cap) { sfx('swap'); say('Belly tank full!'); }
          if (Math.random() < 0.35) rings.spawn(rig.pos.x, rig.pos.z, 0.25, 1.5, 0.5, 0, 0, SPRAY);
        }
        if (keys.has('KeyF') && (s.tankWater || 0) > 0.05 && !s.snorkel) {
          if (!s.tankDumping) sfx('dump');
          s.tankDumping = true;
          const poured = Math.min(s.tankWater, RIG.dumpRate * 0.9 * RIG.cap * STEP);
          s.tankWater -= poured;
          spawnBellyDrops(poured);
        } else s.tankDumping = false;
        s.tankFill = (s.tankWater || 0) / RIG.cap;
      }
      s.snorkelOut = hasTank(career) && hasLine();
    }
    if (hasLine()) {
      if (rig.tool === 'snorkel') {
        if (s.snorkelTarget > 0) {
          if (input.winch) { winch(rig, input.winch, STEP); s.snorkelTarget = rig.len; }
          else if (rig.len < s.snorkelTarget) rig.len = Math.min(s.snorkelTarget, rig.len + 8 * STEP);
        } else {
          rig.len = Math.max(0.15, rig.len - 10 * STEP);
          if (rig.len <= 0.25) rig.stowed = true;
        }
      } else winch(rig, input.winch, STEP);
      if (!fly) stepRig(rig, s, STEP, env);
    }
    if (physics) for (const e of physics.step({ loads: crates, s, r: hasLine() ? rig : null, env, fly, plane: isPlane() || isBoat(), boat: isBoat(), radius: isBoat() ? 4 : isPlane() ? 2.5 : 1.8,
      deck: { x: SHIP.x + ((SHIP.flat.z0 + SHIP.flat.z1) / 2) * Math.sin(SHIP.yaw), y: SHIP.y + SHIP.deck, z: SHIP.z + ((SHIP.flat.z0 + SHIP.flat.z1) / 2) * Math.cos(SHIP.yaw), yaw: SHIP.yaw, hw: SHIP.flat.hw, hl: (SHIP.flat.z1 - SHIP.flat.z0) / 2 } })) {
      if (e.type === 'boom') explodeFx(e.x, e.y, e.z);
      else splashFx(e.x, e.y, e.z, e.v, e.size);
    }
    else for (const c of crates) if (!c.held) stepCrate(c, STEP, env);
    // Airframe damage: knocks over 8 m/s, short of a crash, add up. It costs power and trails smoke; at 100% she's a write-off.
    // Stopped at base (pad, strip or jetty) the ground crew put it right, at a price.
    if (!s.wreck && s.hit > 8) {
      s.damage = Math.min(1, (s.damage || 0) + (s.hit - 8) / 30);
      if (s.damage >= 1) { s.wreck = true; s.wreckQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-s.pitch, s.yaw, s.roll, 'YXZ')); }
    }
    if (s.wreck && !towT) s.crashV = Math.max(s.crashV || 0, hit, s.hit); // how hard she went in (physics sets s.wreck on its own)
    if (s.damage > 0 && !s.wreck && atBase()) {
      const fix = Math.min(s.damage, 0.15 * STEP);
      s.damage -= fix;
      if (onShift()) dispatch.stats.losses += COSTS.repair * fix;
    }
    if (s.wreck && !towT && onShift()) dispatch.stats.losses += COSTS.crash;
    if (s.wreck && !towT) { // first wrecked step: drop the load; on land she goes up in flames, at sea she ditches and sinks
      if (rig.crate) act(rig, crates);
      s.ditched = groundAt(s.pos.x, s.pos.z) <= SEA && s.pos.y < SEA + 4;
      const k = Math.min(1.6, Math.max(0.5, ((s.crashV || 20) - 10) / 20)); // a 20 m/s crash is a 0.5 blast, 42 m/s and up the full 1.6
      if (s.ditched) { splashFx(s.pos.x, SEA, s.pos.z, 10 + (s.crashV || 20), 3); say('DITCHED! Towing you back to base…'); }
      else { explodeFx(s.pos.x, s.pos.y, s.pos.z, 0.6 + 0.8 * k); say('CRASHED! Towing you back to base…'); }
      flashT = 5;
      if (craft.rotor && !s.ditched) throwRotor(k);
    }
    if (rig.hit > 4) thud(Math.min(1, rig.hit / 25));
    for (const c of crates) if (!c.held && c.hit > 4) { thud(Math.min(1, c.hit / 20)); dustFx(c.pos, c.hit); }
    stepFire(fire, STEP, wind, weather.storm);
    for (const c of fire.scorched) { scorch(c); if (dispatch) onScorch(dispatch, c); }
    fire.scorched.length = 0;
    spawnDrops(rig, rig.poured, false);
    spawnDrops(rig, rig.spilled, true);
    if ((onPad() && input.lift <= 0) || (atStrip() && s.throttle < 0.1) || atDock() || atRigRefuel()) {
      const add = Math.min(1 - s.fuel, 0.2 * STEP);
      s.fuel += add;
      if (atStrip() && s.throttle < 0.1) s.water = Math.min(PLANE.tank, s.water + 0.35 * PLANE.tank * STEP);
      if (onShift()) dispatch.stats.fuel += fuelBill(career, career.airframe, add); // free roam is free
    }
    towT = (s.fuel <= 0 && s.grounded) || s.wreck ? towT + STEP : 0; // out of fuel, or wrecked
    if (towT > (s.wreck ? 5 : 3)) towHome();
    hit = Math.max(hit, s.hit);
    acc -= STEP;
  }
  // Hard landings, cliff and tree strikes: shake + thump. Gentle touchdowns stay silent.
  if (hit > 2.5) { trauma = Math.min(1, trauma + hit / 20); thud(Math.min(1, hit / 15)); }
  trauma = Math.max(0, trauma - dt * 1.5, 0.35 * Math.max(s.vrs || 0, s.buffet || 0)); // settling with power and fire thermals shudder

  // Interpolate between the last two sim states for smooth rendering.
  const a = acc / STEP;
  view.lerpVectors(prev.pos, s.pos, a);
  craft.group.position.copy(view);
  if (s.wreck) craft.group.quaternion.copy(s.wreckQ);
  else craft.group.rotation.set(-(prev.pitch + (s.pitch - prev.pitch) * a), prev.yaw + (s.yaw - prev.yaw) * a, prev.roll + (s.roll - prev.roll) * a);
  if (isBoat()) {
    s.aim = Math.max(-2.4, Math.min(2.4, Math.atan2(Math.sin(camYaw + orbit.yaw - s.yaw), Math.cos(camYaw + orbit.yaw - s.yaw)))); // water cannons and searchlight follow the camera
    s.jetK = 1 - 0.75 * Math.min(1, Math.max(0, (orbit.pitch + 0.2) / 1.15)); // and its pitch: look down to throw short (~10 m), level for full reach (~100 m)
    s.light = spot.on;
  }
  craft.spin(dt, s.wreck ? 0 : isPlane() ? s.throttle : input.lift > 0 ? 1 : 0, s);
  craft.beacon.visible = t % 1.1 < 0.12;
  craft.strobe.visible = (t + 0.5) % 1.4 < 0.06;

  const gy = env.groundAt(view.x, view.z), alt = view.y - gy;
  ship.update(dt);
  if ((moored.group.visible = !isBoat())) {
    const w = env.waveAt, bx = berth.pos.x, bz = berth.pos.z;
    moored.group.position.set(bx, w(bx, bz) * 0.6, bz);
    moored.group.rotation.set((w(bx + Math.sin(berth.yaw) * 8, bz + Math.cos(berth.yaw) * 8) - w(bx, bz)) * 0.02, berth.yaw, (w(bx + Math.cos(berth.yaw) * 3, bz - Math.sin(berth.yaw) * 3) - w(bx, bz)) * 0.05);
    moored.spin(dt, 0, mooredState);
  }
  shadow.position.set(view.x, gy + (gy <= SEA ? 0.5 : 0.15), view.z);
  shadow.scale.setScalar(1 + alt * 0.01);
  shadow.material.opacity = Math.max(0, 0.45 - alt * 0.004);
  spot.visible = spot.on && !isBoat() && !isPlane() && !s.wreck && !s.grounded && mode !== 'title';
  if (spot.visible) {
    spot.position.fromArray(SPOT_CHIN[career.airframe] || SPOT_CHIN.utility).multiplyScalar(airframe().scale).applyQuaternion(craft.group.quaternion).add(view);
    spot.rotation.set(-0.48 - s.pitch * 0.5, s.yaw, 0);
    spot.material.opacity = 0.07 + 0.14 * Math.max(nightK, weather.storm * 0.7);
  }
  if (isBoat() && !s.wreck) spawnWake(dt);
  spawnWash(dt, view.x, gy, view.z, alt, gy <= SEA, s.wreck || isBoat() ? 0 : isPlane() ? (s.scooping ? 2 : 0) : s.grounded && input.lift <= 0 ? 0.3 : 1);
  if (s.damage > 0.35 && !s.wreck && Math.random() < dt * 40 * s.damage) smoke.spawn(view.x + rnd(1), view.y + 1.5, view.z + rnd(1), s.vel.x * 0.4 + rnd(1), 1 + Math.random() * 2, s.vel.z * 0.4 + rnd(1), SOOT, { life: 2, grav: 0.5, drag: 0.6, grow: 1 + 2 * s.damage });
  if (dispatch) for (const j of [...dispatch.jobs, ...dispatch.calls]) if (j.vessel && j.heat > 0 && Math.random() < dt * 30 * j.heat) { // a boat on fire
    blast.spawn(j.x + rnd(4), 2 + Math.random() * 2, j.z + rnd(4), rnd(1), 3 + Math.random() * 3, rnd(1), FLAME[(Math.random() * 4) | 0], { life: 0.7, grav: 3, drag: 1, grow: 1.5 + 2 * j.heat });
    smoke.spawn(j.x + rnd(3), 5, j.z + rnd(3), wind.x * 0.4, 4 + Math.random() * 3, wind.z * 0.4, SOOT, { life: 4, grav: 0.5, drag: 0.4, grow: 3 + 3 * j.heat });
  }
  if (thrown) { // the main rotor, torn off in the crash: flung, spinning, until it lands and skids to a stop
    const r = thrown, gr = groundAt(r.obj.position.x, r.obj.position.z);
    if (r.obj.position.y > gr + 0.15) { r.vel.y -= 9.81 * dt; r.spin *= Math.exp(-0.3 * dt); }
    else { r.obj.position.y = gr + 0.15; r.vel.y = 0; r.vel.multiplyScalar(Math.exp(-4 * dt)); r.spin *= Math.exp(-5 * dt); r.tilt *= Math.exp(-6 * dt); }
    r.obj.position.addScaledVector(r.vel, dt);
    r.yaw += r.spin * dt;
    r.obj.rotation.set(r.tilt, r.yaw, r.tilt * 0.6);
  }
  if (s.wreck && s.ditched && Math.random() < dt * 8 && towT < 2) smoke.spawn(view.x + rnd(2), SEA + 0.5, view.z + rnd(2), wind.x * 0.3, 2 + Math.random() * 2, wind.z * 0.3, 0xf4f1ee, { life: 2.5, grav: 0.4, drag: 0.5, grow: 2 + Math.random() * 2 }); // steam
  if (s.wreck && !s.ditched && Math.random() < dt * 30) { // the wreck burns
    blast.spawn(view.x + rnd(2), view.y + 1, view.z + rnd(2), rnd(2), 3 + Math.random() * 3, rnd(2), FLAME[(Math.random() * 4) | 0], { life: 0.6, grav: 3, drag: 1, grow: 1.5 + Math.random() * 1.5 });
    smoke.spawn(view.x + rnd(2), view.y + 2, view.z + rnd(2), wind.x * 0.4 + rnd(1), 5 + Math.random() * 3, wind.z * 0.4 + rnd(1), SOOT, { life: 4, grav: 0.5, drag: 0.4, grow: 3 + Math.random() * 3 });
  }
  wash.update(dt);
  const lift = 0.1 + 0.15 * SEAS.h; // the 35 m water facets sag up to ~0.12 x SEAS.h below the true swell
  rings.update(dt, env.waveAt, lift);
  wake.update(dt, env.waveAt, lift, isBoat() && !s.wreck ? { x: s.pos.x, z: s.pos.z, yaw: s.yaw, speed: s.speed, throttle: s.throttle || 0, steer: s.steer || 0, stern: 10.5, bow: 10, beam: 5.8, jets: [1.1, 10.8] } : null);
  shipWake.update(dt, env.waveAt, 0.16, { x: SHIP.x, z: SHIP.z, yaw: SHIP.yaw, speed: SHIP.speed, throttle: 0.45, steer: 0, stern: 32, bow: 40, beam: 15, jets: [1.8, 32] });
  blast.update(dt);
  debris.update(dt);
  drops.update(dt, groundAt);
  const end = rigView(rig, view, a, hasLine(), s.yaw);
  updateAim(rig);
  for (const c of crates) { placeCrateMesh(c.mesh, c); if (c === rig.crate) c.mesh.position.copy(end); }
  physics?.render();
  smoke.update(dt);
  fireView(fire, dt, t, wind);
  let goal = null;
  if (onShift()) {
    const prevEarned = dispatch.stats.earned;
    updateDispatch(dispatch, dt, s, say);
    if (rig.crate && !crates.includes(rig.crate)) rig.crate = null; // the load on the hook is gone (it blew up)
    if (dispatch.stats.earned > prevEarned) sfx('done');
    goal = updateMarkers(dispatch, view);
    if (dispatch.over) endShift();
  }
  drawWeather(dt);
  surf.userData.update(t);
  windsock.userData.update(wind);
  lighthouse.userData.update(t, nightK);
  updateLife(t);

  // Chase camera: trails heading, pulls back and widens with speed.
  camVel.lerp(s.vel, 1 - Math.exp(-2 * dt));
  const speed = Math.hypot(camVel.x, camVel.z);
  let dy = s.yaw - camYaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  const turn = dy * (1 - Math.exp(-(isPlane() ? 3.5 : 2.5) * dt));
  camYaw += turn;
  // While looking around or aiming (not centering), hold world direction instead of swinging with the craft's nose/bow.
  const looking = orbit.dragging || orbit.locked || (!orbit.reset && (Math.abs(Math.atan2(Math.sin(orbit.targetYaw), Math.cos(orbit.targetYaw))) > 0.02 || Math.abs(orbit.targetPitch) > 0.02));
  if (looking) { orbit.targetYaw -= turn; orbit.yaw -= turn; }
  // Pull back and up to frame the slung load when it matters (carrying, water aboard, working low); close otherwise.
  const working = hasLine() && (rig.crate || rig.water > 0.02 || rig.dipped || (alt < 25 && !s.grounded && rig.len > 0.5));
  loadFocus += ((working ? 1 : 0) - loadFocus) * (1 - Math.exp(-1.5 * dt));
  const cam = airframe().cam, dist = (14 + 5 * loadFocus) * cam + speed * 0.07, height = (5.5 + 1.5 * loadFocus) * cam + speed * 0.04, k = 1 - Math.exp(-(6 - 2 * loadFocus) * dt);
  if (orbit.reset) {
    const wy = Math.atan2(Math.sin(orbit.targetYaw), Math.cos(orbit.targetYaw)), r = 1 - Math.exp(-9 * dt);
    orbit.targetYaw = wy * (1 - r);
    orbit.targetPitch *= 1 - r;
    if (Math.abs(orbit.targetYaw) < 0.002 && Math.abs(orbit.targetPitch) < 0.002) { orbit.targetYaw = orbit.targetPitch = 0; orbit.reset = false; }
  } else if (opts.autoCenter && !isBoat() && !orbit.dragging && !orbit.locked && (orbit.idle += dt) > 2.5) {
    const r = 1 - Math.exp(-2 * dt);
    orbit.targetYaw -= Math.atan2(Math.sin(orbit.targetYaw), Math.cos(orbit.targetYaw)) * r;
    orbit.targetPitch -= orbit.targetPitch * r;
  }
  const damp = 1 - Math.exp(-24 * dt);
  orbit.yaw += Math.atan2(Math.sin(orbit.targetYaw - orbit.yaw), Math.cos(orbit.targetYaw - orbit.yaw)) * damp;
  orbit.pitch += (orbit.targetPitch - orbit.pitch) * damp;
  orbit.zoom += (orbit.targetZoom - orbit.zoom) * damp;
  // The plane's camera also follows its pitch (sits lower as the nose comes up) and trails a little looser.
  const planeCam = isPlane(), cy = camYaw + orbit.yaw, elev = Math.min(1.45, Math.max(-0.22, Math.atan2(height, dist) + orbit.pitch + (planeCam ? s.pitch * 0.6 : 0))), reach = Math.hypot(dist, height) * orbit.zoom;
  camera.position.lerp(eye.set(view.x + Math.sin(cy) * Math.cos(elev) * reach, view.y + Math.sin(elev) * reach, view.z + Math.cos(cy) * Math.cos(elev) * reach), planeCam ? 1 - Math.exp(-4 * dt) : k);
  camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 2, SEA + 1.5);
  // Aim partway down the rope so chopper and load share the frame.
  // Frame by the rope's average drop, not the swinging load; look ahead less while orbiting with the mouse.
  ropeDrop += (end.y - view.y - 2 - ropeDrop) * (1 - Math.exp(-1.5 * dt));
  const ahead = (isBoat() ? 0.12 : 0.3) * Math.max(0, 1 - Math.abs(Math.atan2(Math.sin(orbit.yaw), Math.cos(orbit.yaw))) - Math.abs(orbit.pitch));
  if (planeCam) look.lerp(eye.set(0, 0, -12 * (ahead / 0.3)).applyQuaternion(craft.group.quaternion).add(view).setY(view.y + 3 - s.pitch * 12 * (ahead / 0.3)), 1 - Math.exp(-6 * dt)); // ahead along the nose
  else look.lerp(eye.set(view.x + camVel.x * ahead, view.y + 2 + camVel.y * 0.15 + ropeDrop * 0.35 * loadFocus, view.z + camVel.z * ahead), 1 - Math.exp(-6 * dt));
  camera.lookAt(look);
  if (mode === 'title' || (mode === 'hangar' && backTo === 'title')) { // menu backdrop: a slow orbit of the parked aircraft, framed right of the menu
    const o = t * 0.04 + s.yaw + 2.2;
    camera.position.set(s.pos.x + Math.sin(o) * 60, 0, s.pos.z + Math.cos(o) * 60);
    camera.position.y = Math.max(s.pos.y + 20, heightAt(camera.position.x, camera.position.z) + 8);
    camera.lookAt(s.pos.x, s.pos.y + 5, s.pos.z);
    camera.rotateY(0.28);
  }
  if (cockpit && !s.wreck && (mode === 'shift' || mode === 'free')) { // pilot's seat: the craft's own attitude, drag to look round
    camera.position.copy(eye.fromArray(EYE[craftKind]).multiplyScalar(airframe().scale).applyQuaternion(craft.group.quaternion).add(view));
    camera.quaternion.copy(craft.group.quaternion);
    camera.rotateY(orbit.yaw); camera.rotateX(-orbit.pitch - 0.08);
  } else if (isPlane()) camera.rotateZ(-Math.sin(prev.roll + (s.roll - prev.roll) * a) * 0.18); // lean the horizon a little with the bank (sin: s.roll keeps counting past 2pi through a barrel roll)
  if (trauma > 0) { const q = trauma * trauma * 0.04; camera.rotation.x += (Math.random() - 0.5) * q; camera.rotation.y += (Math.random() - 0.5) * q; camera.rotation.z += (Math.random() - 0.5) * q; }
  updateAudio(isPlane() ? s.throttle * 2 - 1 : isBoat() ? Math.abs(s.throttle) : input.lift, speed, career.airframe, {
    grounded: s.grounded,
    turn: Math.abs(Math.sin(s.roll)),
    water: Math.max(weather.storm * 0.45, isBoat() ? Math.min(1, Math.abs(s.speed) / 17) * 0.5 + (s.jet ? 0.5 : 0) : isPlane() ? (s.scooping ? 1 : s.onWater ? Math.min(1, s.speed / 22) * 0.55 : 0) : hasTank(career) ? (s.snorkel && (s.tankWater || 0) < RIG.cap ? 0.55 : s.tankDumping ? 0.45 : 0) : hasLine() && rig.dipped ? 0.45 : 0),
  });
  const fov = 62 + speed * 0.16;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * k; camera.updateProjectionMatrix(); }

  sky.position.copy(camera.position);
  water.userData.update(t, camera.position);
  renderer.render(scene, camera);

  frames++;
  if (now - fpsT > 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  const bar = (v) => '█'.repeat(Math.round(v * 10)).padEnd(10, '░');
  const held = !rig.crate ? '—' : rig.crate.spec === RIG.person ? 'casualty' : rig.crate.spec.cargo || 'crate';
  const load = isBoat() ? `THR    ${bar(Math.abs(s.throttle))} ${s.throttle < -0.02 ? 'astern' : `${Math.round(s.throttle * 100)}%`}` : isPlane() ? `THR    ${bar(s.throttle)} ${Math.round(s.throttle * 100)}%\nTANK   ${bar(s.water / PLANE.tank)} ${Math.round((s.water / PLANE.tank) * 100)}% [${s.salvo ? 'SALVO' : 'TRAIL'}]`
    : hasTank(career) ? `TANK   ${bar((s.tankWater || 0) / RIG.cap)} ${Math.round(((s.tankWater || 0) / RIG.cap) * 100)}%\nPIPE   ${rig.stowed ? 'stowed (R to drop)' : `${rig.len.toFixed(1)} m (Z/C · R stow)`}`
    : rig.stowed ? 'LINE   stowed (R to let it out)'
    : !hasLine() ? 'LINE   none (rescues only)'
    : `${rig.tool === 'bucket' ? `BUCKET ${bar(rig.water / RIG.cap)} ${Math.round((rig.water / RIG.cap) * 100)}%` : `HOOK   ${held}`}\nLINE   ${rig.len <= 0.15 ? 'stowed' : `${rig.len.toFixed(1)} m`} (Z/C)`;
  hud.textContent = `SLING & SCOOP\nALT ${alt.toFixed(0).padStart(4)} m\nSPD ${(speed * 3.6).toFixed(0).padStart(4)} km/h\nV/S ${s.vel.y.toFixed(1).padStart(5)} m/s\nWND ${wind.str.toFixed(0).padStart(4)} m/s${weather.storm > 0.05 ? ' SQUALL' : ''}\nFUEL   ${bar(s.fuel)} ${Math.round(s.fuel * 100)}%\n${s.damage > 0.005 ? `HULL   ${bar(1 - s.damage)} ${Math.round((1 - s.damage) * 100)}%\n` : ''}${load}${opts.fps ? `\n${fps} fps` : ''}`;
  if (frames % 15 === 0) { patch(board, boardHtml(goal)); setHelp(); }
  if (frames % 6 === 0) drawMini(goal);
  if (onShift()) patch(meter, meterHtml());
  updateCompass(goal, dispatch?.job?.type);
  flashT -= dt;
  prompt.textContent = flashT > 0 ? flash
    : s.fuel <= 0 ? (s.grounded ? 'Out of fuel. Towing you back to base…' : isPlane() ? 'ENGINES OUT: glide down onto the water' : `ENGINE OUT: keep your speed up, hold Space to flare before touchdown (${Math.round((s.rotorE || 0) * 100)}% rotor)`)
    : s.damage > 0.005 && atBase() ? `Repairing… ${Math.round((1 - s.damage) * 100)}%${onShift() ? ` · −$${Math.round(dispatch.stats.losses).toLocaleString()}` : ''}`
    : s.damage > 0.6 && t % 1 < 0.6 ? 'DAMAGED: losing power. Get back to base for repairs'
    : (onPad() || atDock() || atRigRefuel()) && s.fuel < 1 ? `Refuelling… ${Math.round(s.fuel * 100)}%${onShift() ? ` · −$${Math.round(dispatch.stats.fuel).toLocaleString()}` : ''}${atBase() ? ' · H: Hangar' : ''}`
    : onDeck() ? `On deck: ${deckShip().name}${s.fuel < 1 && deckShip() === SHIP ? ' · refuelling' : ''}`
    : atBase() && mode !== 'hangar' ? 'H: Hangar'
    : s.fuel < 0.2 && t % 1 < 0.6 ? (isBoat() ? 'LOW FUEL: stop at the harbour jetty to refuel' : isPlane() ? 'LOW FUEL: land on the airstrip to refuel' : 'LOW FUEL: land on a pad to refuel')
    : isPlane() ? planePrompt()
    : isBoat() ? (s.anchored ? 'Anchored (R to weigh anchor)' : s.moored ? 'Moored at dock (W/S or R to cast off)' : s.hit > 0 ? 'Aground! Back off (S)' : dispatch?.job?.type === 'fire' ? 'Drag or right-click/Tab to aim · hold F: fire water cannons' : '')
    : s.vrs > 0.4 ? 'SETTLING WITH POWER! Fly forward (W) into clean air'
    : hasTank(career) ? (s.snorkel && (s.tankWater || 0) < RIG.cap ? 'Siphoning water…' : rig.stowed && (s.tankWater || 0) < 0.05 ? 'R: drop snorkel pipe over water' : (s.tankWater || 0) > 0.05 && !s.tankDumping ? 'F (hold): drop water' : '')
    : rig.overloaded ? `Too heavy for the ${airframe().name}! Needs the Heavy Lifter or more rotor power (F: let go)`
    : rig.crate ? 'F: release load'
    : rig.tool === 'hook' ? (nearestCrate(rig, crates) ? `F: hook ${nearestCrate(rig, crates).spec === RIG.person ? 'casualty' : 'crate'}` : '')
    : rig.dipped && rig.water < RIG.cap ? 'Filling…'
    : rig.water > 0.05 && !rig.dumping ? 'F: dump water' : '';
});

window.__game = { s, career, orbit, rig, crates, renderer, camera, scene, wind, heightAt, fire, dispatch, startShift, press, weather, skip: (to) => { simT = to; } }; // skip: jump the sim clock (testing weather)

function planePrompt() {
  if (!s.onSurface && s.lift < 1) return 'STALL! Nose down (W) and throttle up (Space)';
  if (s.scooping) return s.water < PLANE.tank ? 'Scooping…' : 'Tank full: pull up (S)';
  if (s.water > 0.1 && !s.dumping) return s.onSurface ? 'Throttle up and lift off (S) to make a drop' : `Hold F: drop water · R: ${s.salvo ? 'salvo' : 'trail'}`;
  if (s.onSurface && !s.onWater && s.speed < 25) return s.water < 0.1 ? 'Throttle up (Space), rotate at speed (S). Scoop by skimming the sea' : 'Throttle up (Space) and rotate (S) to take off';
  if (s.onWater && s.speed < PLANE.scoopSpeed) return 'Faster! Skim the sea above 65 km/h to scoop';
  return '';
}

function boardHtml(goal) {
  const d = dispatch, tag = (t) => `<b class="${t}">${t.toUpperCase()}</b>`;
  if (mode === 'free') return `<div class="head">FREE ROAM <span>$${career.bank.toLocaleString()}</span></div><div class="dim">H: Hangar · Esc: Menu</div>`;
  if (!d) return `<div class="head">DISPATCH <span>$${career.bank.toLocaleString()}</span></div><div class="dim">Off shift</div>`;
  const km = (o) => (Math.hypot(o.x - s.pos.x, o.z - s.pos.z) / 1000).toFixed(1);
  const late = (o) => (o.vessel ? ` · <span class="dim">${Math.max(0, Math.ceil(SHIFT.vesselBurn * (isBoat() ? 1.8 : 1) - o.age))}s</span>` : o.type === 'fire' ? (o.house ? ` · <span class="dim">house lost in ${Math.ceil(SHIFT.houseBurn - o.house.burnT)}s</span>` : '') : ` · <span class="dim">${Math.max(0, Math.ceil((o.type === 'rescue' ? SHIFT.rescueTimeout * (isBoat() ? 2.2 : 1) : SHIFT.cargoTimeout) - o.age))}s</span>`);
  const heavyTag = (o) => (o.heavy ? ` <b class="heavy">HEAVY</b>${RIG.maxLift < RIG[o.heavy].mass ? ' <span class="dim">(need more lift)</span>' : ''}` : '');
  const part = (o) => (o.story?.of > 1 ? `<div class="dim">${o.step > 1 ? '<b class="follow">FOLLOW-UP</b> · ' : ''}${o.story.name} · ${o.step}/${o.story.of}</div>` : '');
  const bonus = (o) => (o.after && o.after === d.lastId ? ` <b class="follow">+${Math.round((SHIFT.followBonus - 1) * 100)}%</b>` : '');
  const rows = d.calls.map((o, i) => `<div>[${i + 1}] ${tag(o.type)}${heavyTag(o)} ${o.title} · $${o.reward}${bonus(o)} · ${km(o)} km${late(o)}${part(o)}</div>`).join('') || '<div class="dim">No calls right now</div>';
  const other = d.jobs.filter((j) => j !== d.job).map((j) => `<div class="dim">▸ also on: ${tag(j.type)} ${j.title} · ${km(j)} km</div>`).join(''); // the job not in focus
  const job = d.job ? `<div class="job">${tag(d.job.type)} ${goal ? `${goal.text} · ${(goal.dist / 1000).toFixed(1)} km` : ''}${other}<br><span class="dim">X: hand back${d.jobs.length > 1 ? ' · J: switch job' : d.calls.length ? ' · take one more on the way' : ''}</span></div>` : (d.calls.length ? `<div class="dim">Press ${d.calls.length > 1 ? `1–${d.calls.length}` : '1'} to take a call (up to ${MAX_JOBS} at once)</div>` : '');
  return `<div class="head">DISPATCH <span>$${(career.bank + (onShift() ? netOf(d.stats) : 0)).toLocaleString()}</span></div>${rows}${job}`;
}

function meterHtml() {
  const d = dispatch, m = comboMult(d.combo), mins = `${Math.floor(d.t / 60)}:${String(Math.floor(d.t % 60)).padStart(2, '0')}`;
  const combo = d.job?.chained ? `<span class="combo">CHAIN ${d.combo} · finish this job for ×${comboMult(d.combo + 1).toFixed(2)}</span>`
    : d.comboT > 0 ? `<span class="combo">CHAIN ${d.combo} · ×${m.toFixed(2)} · take a call to keep it</span><div class="bar thin"><i style="width:${(d.comboT / SHIFT.comboWindow) * 100}%"></i></div>`
    : '<span class="dim">No chain</span>';
  return `<div class="row"><span>CHAOS</span><div class="bar"><i class="${d.chaos > 75 ? 'hot' : ''}" style="width:${d.chaos}%"></i></div><span>${mins}</span></div>${combo}`;
}

// ---- Hangar: spend the bank between shifts. Keys 1-n upgrade the airframe you're flying, then buy or switch airframe. ----

const AIRFRAME_KEYS = Object.keys(AIRFRAMES), PROJECT_KEYS = Object.keys(PROJECTS), LETTERS = 'ABCDE'; // projects take letter keys
// Showroom: a turntable of the airframe being viewed (arrows cycle), in its own small renderer that only runs in the hangar.
let msgN = 0, hangarTab = 0, viewing = '', showR, showScene, showCam, showModel, showKey = '';
function showroom(host) {
  if (!showR) {
    showR = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    showScene = new THREE.Scene(); showCam = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.4); sun.position.set(-3, 4, -2);
    showScene.add(new THREE.HemisphereLight(0xffd9b0, 0x4a3a70, 2), sun);
  }
  const r = host.getBoundingClientRect(), w = Math.max(1, r.width | 0), h = Math.max(1, r.height | 0);
  showR.setPixelRatio(Math.min(devicePixelRatio, 2)); showR.setSize(w, h); showCam.aspect = w / h; showCam.updateProjectionMatrix();
  host.appendChild(showR.domElement);
  const wantKey = viewing === 'heavy' ? `heavy:${hasTank(career)}` : viewing;
  if (showKey !== wantKey) {
    if (showModel) showScene.remove(showModel);
    const a = AIRFRAMES[viewing], g = (a.plane ? buildPlane(a) : a.boat ? buildBoat(a) : buildChopper({ ...a, tank: viewing === 'heavy' && hasTank(career) })).group, beams = [];
    g.traverse((o) => o.material?.blending === THREE.AdditiveBlending && beams.push(o)); beams.forEach((o) => o.removeFromParent());
    const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3()), k = (a.boat ? 8 : 12) / box.getSize(new THREE.Vector3()).length();
    g.position.sub(c); showModel = new THREE.Group(); showModel.add(g); showModel.scale.setScalar(k); showScene.add(showModel); showKey = wantKey;
    showCam.position.set(0, 3.2, 10.5); showCam.lookAt(0, 0, 0);
  }
  showModel.rotation.y = 2.5; showR.render(showScene, showCam); // a still ¾ front view, no loop
}
function openHangar(msg = '') {
  if (mode !== 'hangar') { backTo = mode; viewing = career.airframe; }
  setMode('hangar');
  const pips = (n) => `<span class="lvl" title="Level ${n} of ${MAX_LEVEL}">${[...Array(MAX_LEVEL)].map((_, i) => `<i${i < n ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const price = (c, label = '') => `<i class="buy${c > career.bank ? ' poor' : ''}">${label}$${c.toLocaleString()}</i>`;
  const bar = (v, max) => `<i class="track"><s style="width:${Math.min(100, (v / max) * 100)}%"></s></i>`;
  const tile = (key, kc, name, body, badge, tip, cls = '') => `<div class="tile ${cls}" data-key="${key}" title="${tip.replace(/"/g, '&quot;')}"><b>${name}</b><em>${kc}</em>${body}${badge}</div>`;
  const upKeys = upgradesFor(career.airframe);
  const ups = upKeys.map((k, i) => {
    const u = UPGRADES[k], lvl = career.levels[career.airframe][k], cost = lvl < MAX_LEVEL && upgradeCost(career.airframe, k, lvl);
    return tile(`Digit${i + 1}`, i + 1, u.name, `${pips(lvl)}<small>${u.blurb}</small>`, cost ? price(cost) : '<i class="buy max">Maxed</i>', u.blurb);
  }).join('');
  const frames = AIRFRAME_KEYS.map((k, i) => {
    const a = AIRFRAMES[k], t = a.tune || {}, on = career.airframe === k, own = career.owned.includes(k), n = upKeys.length + i + 1, kc = n === 10 ? 0 : n;
    const spd = a.plane ? 2.2 : a.boat ? 1.1 : t.thrust ?? 2, agl = a.plane ? 1.15 : a.boat ? 0.75 : t.agility ?? 1;
    const stats = `<div class="stats"><span>Speed${bar(spd, 2.3)}</span><span>Agility${bar(agl, 1.4)}</span><span>Jobs<u>${jobsOf(career, k).length}</u></span></div>`;
    return tile(`Digit${n}`, kc, a.name, stats, on ? '<i class="buy on">In use</i>' : own ? '<i class="buy own">Owned</i>' : price(a.cost), a.blurb, on ? 'cur' : '');
  }).join('');
  const projects = PROJECT_KEYS.map((k, i) => {
    const p = PROJECTS[k], built = career.projects.includes(k);
    return tile(`Key${LETTERS[i]}`, LETTERS[i], p.name, `<small>${p.blurb}</small>`, built ? '<i class="buy on">Built</i>' : price(p.cost), p.blurb);
  }).join('');
  const gear = airframe().gear?.bucket ? (() => { const own = career.gear?.includes(career.airframe + ':bucket'), c = airframe().gear.bucket;
    return tile('KeyG', 'G', 'Bucket kit', '<small>Dip, carry and drop water</small>', own ? '<i class="buy on">Owned</i>' : price(c), 'Fight fires: dip, carry and drop water'); })()
    : airframe().gear?.tank ? (() => { const own = career.gear?.includes('heavy:tank'), on = hasTank(career), c = airframe().gear.tank;
      return tile('KeyG', 'G', GEAR.tank.name, `<small>${GEAR.tank.blurb}</small>`, on ? '<i class="buy on">Fitted (G)</i>' : own ? '<i class="buy own">Removed (G)</i>' : price(c), GEAR.tank.blurb, on ? 'cur' : ''); })() : '';
  const v = AIRFRAMES[viewing], vn = AIRFRAME_KEYS.indexOf(viewing) + upKeys.length + 1, vs = viewing === career.airframe ? 'In use' : career.owned.includes(viewing) ? 'Use it' : `Buy $${v.cost.toLocaleString()}`;
  const showcase = `<div class="show"><div class="vp" data-keep></div><button class="nav l" data-key="ArrowLeft">◀</button><button class="nav r" data-key="ArrowRight">▶</button>
    <div class="info"><h3>${v.name}</h3><small>${v.blurb}</small><button class="go${viewing === career.airframe ? ' on' : !career.owned.includes(viewing) && v.cost > career.bank ? ' poor' : ''}" data-key="Digit${vn}">${vs}</button></div></div>`;
  // Three tabs, so each fits a laptop screen; every key still works from any tab.
  const TABS = [['Upgrades', `${gear}${ups}`], ['Vehicles', `<div class="garage">${showcase}<div class="tiles two">${frames}</div></div>`], ['Island projects', projects]];
  render(`<section class="card hq"><header><h1>Hangar</h1><nav class="tabs">${TABS.map(([t], n) => `<button data-key="HTab${n}"${n === hangarTab ? ' class="on"' : ''}>${t}</button>`).join('')}</nav><div class="bank">$${career.bank.toLocaleString()}<small>BANK</small></div></header>
    <p class="msg" data-fresh="${msg ? ++msgN : 0}">${msg}</p>${backTo === 'shift' ? '<p class="dim">Your shift is still running!</p>' : ''}
    <section class="tabbody" data-fresh="h${hangarTab}">${hangarTab === 0 ? `<h2>${airframe().name}</h2>` : ''}<div class="${hangarTab === 1 ? '' : 'tiles'}">${TABS[hangarTab][1]}</div></section>
    <nav class="menu row">${btn('Escape', 'Back')}</nav></section>`, 'hangar');
  const vp = overlay.querySelector('.vp');
  if (vp) showroom(vp);
}
function hangarKey(code) {
  if (code === 'KeyH' || code === 'Escape') return setMode(backTo);
  const tab = /^HTab(\d)$/.exec(code)?.[1];
  if (tab) { hangarTab = +tab; return openHangar(); }
  if (code === 'ArrowLeft' || code === 'ArrowRight') { viewing = AIRFRAME_KEYS[(AIRFRAME_KEYS.indexOf(viewing) + (code === 'ArrowLeft' ? -1 : 1) + AIRFRAME_KEYS.length) % AIRFRAME_KEYS.length]; return openHangar(); }
  if (code === 'KeyG') { const item = airframe().gear?.tank ? 'tank' : 'bucket', msg = buyGear(career, item); refit(); return openHangar(msg); } // gear: Utility's bucket kit or Heavy's belly fire tank
  const p = LETTERS.indexOf(/^Key([A-E])$/.exec(code)?.[1]);
  if (PROJECT_KEYS[p] && code !== 'KeyH') { const msg = buyProject(career, PROJECT_KEYS[p]); buildout(); saveCareer(storage, career); return openHangar(msg); }
  const d = /^Digit(\d+)$/.exec(code)?.[1];
  if (d === undefined) return;
  const n = d === '0' ? 9 : +d - 1, upKeys = upgradesFor(career.airframe);
  if (!(n >= 0)) return;
  const picked = AIRFRAME_KEYS[n - upKeys.length];
  if (picked) viewing = picked;
  const msg = n < upKeys.length ? buyUpgrade(career, upKeys[n]) : picked ? buyOrSelectAirframe(career, picked) : '';
  if (!msg) return picked ? openHangar() : undefined;
  refit();
  openHangar(msg);
}
