import * as THREE from 'three';
import { buildWorld, POND, setProjects, SITES, RUNWAY, onRunway, fuelAt, groundAt, heightAt, hitTrees, PAD, PAD_RADIUS, padLocal, PADS, resetScorch, scorch, SEA, SEED } from './world.js';
import { buildChopper, createFlight, stepFlight } from './chopper.js';
import { buildPlane, createPlane, drop, PLANE, stepPlane } from './plane.js';
import { sfx, startAudio, thud, setVolume, toggleMute, updateAudio } from './audio.js';
import { makeParticles } from './fx.js';
import { buildLife } from './life.js';
import { act, winch, buildRigView, splashReach, createRig, hangOf, massOf, nearestCrate, placeCrateMesh, RIG, stepCrate, stepRig, swapTool } from './tools.js';
import { buildFireView, createFire, douse, resetFire, stepFire } from './fire.js';
import { AIRFRAMES, applyLoadout, buyOrSelectAirframe, buyUpgrade, buyProject, fuelBill, loadCareer, PROJECTS, MAX_LEVEL, netOf, recordShift, saveCareer, upgradeCost, UPGRADES, upgradesFor } from './career.js';
import { abandon, accept, comboMult, createDispatch, disposeDispatch, onScorch, SHIFT, updateDispatch, updateMarkers } from './missions.js';

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

const { sky, water, windsock, lighthouse, houses } = buildWorld(scene);
const updateLife = buildLife(scene);
// Career (money, upgrades, airframes) persists in localStorage, which may be missing or blocked.
let storage = null;
try { storage = localStorage; } catch {}
const career = loadCareer(storage);
// Options persist under one key; unknown or bad values fall back to the defaults.
const SETTINGS_KEY = 'rotorRelay.settings';
const opts = { volume: 1, sens: 1, invertY: false, fps: true, hint: false, tipSeen: false };
try { Object.assign(opts, JSON.parse(storage.getItem(SETTINGS_KEY))); } catch {}
const saveOpts = () => { try { storage.setItem(SETTINGS_KEY, JSON.stringify(opts)); } catch {} };
setVolume(opts.volume);
if (import.meta.env.DEV) career.bank = Math.max(career.bank, 1_000_000); // dev server only: test money for trying everything
applyLoadout(career);
const airframe = () => AIRFRAMES[career.airframe];
const isPlane = () => !!airframe().plane;
const hasLine = () => airframe().tools.length > 0; // the starter Scout and the bomber have no line
const buildCraft = () => (isPlane() ? buildPlane(airframe()) : buildChopper(airframe()));
let craft = buildCraft();
scene.add(craft.group);
// Controls line follows the aircraft type; the full list lives in Settings.
function setHelp() {
  document.getElementById('help').hidden = !opts.hint;
  document.getElementById('help').textContent = isPlane()
    ? 'Space/Shift throttle · W/S pitch · A/D bank · skim the sea to scoop · F drop · 1–5 take call · X abandon · drag look · wheel zoom · M mute · Esc pause'
    : `W/S pitch · A/D turn · Q/E strafe · Space/Shift climb/descend${hasLine() ? ' · F action · R bucket/hook · Z/C winch' : ''} · 1–5 take call · X abandon · drag look · wheel zoom · M mute · Esc pause`;
}
setHelp();
function refit() {
  const wasPlane = 'throttle' in s; // plane state has a throttle; helicopter state doesn't
  applyLoadout(career);
  if (!hasLine()) { if (rig.crate) act(rig, crates); Object.assign(rig, createRig(rigHome.x, PAD.y + 1.2, rigHome.z)); }
  scene.remove(craft.group);
  craft = buildCraft();
  scene.add(craft.group);
  rig.water = Math.min(rig.water, RIG.cap);
  if (wasPlane !== isPlane()) towHome(); // switching between plane and helicopter: you start at that aircraft's home
  setHelp();
  saveCareer(storage, career);
}

const shadow = new THREE.Mesh(new THREE.CircleGeometry(3.4, 16).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x1a1020, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
scene.add(shadow);

// Rotor wash puffs and water drops (bucket dumps and spills).
const wash = makeParticles(scene, 160, { opacity: 0.4 });
const drops = makeParticles(scene, 500, { opacity: 0.85, size: 0.18 });
const SPRAY = 0xeaf6f4, DUST = 0xd8b48c, WATER = 0x8fd3e8;
let washAcc = 0;
function spawnWash(dt, x, gy, z, alt, onWater, power) {
  for (washAcc += Math.max(0, 1 - alt / 20) * power * 150 * dt; washAcc >= 1; washAcc--) {
    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 3, sp = 8 + Math.random() * 8;
    wash.spawn(x + Math.cos(a) * r, gy + 0.3, z + Math.sin(a) * r, Math.cos(a) * sp, (onWater ? 2 : 1) + Math.random() * 2, Math.sin(a) * sp, onWater ? SPRAY : DUST, { life: 0.77 });
  }
}
// Water landing: splash, and douse the fire there (steam if it was burning).
const smoke = makeParticles(scene, 700, { opacity: 0.32 });
const fire = createFire(fuelAt, SEED);
const fireView = buildFireView(scene, groundAt, smoke);
const splash = (x, y, z, amount = 1 / 250, reach) => {
  wash.spawn(x, y + 0.3, z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, SPRAY, { life: 0.6, grow: 0.8 });
  if (douse(fire, x, z, amount, reach) && Math.random() < 0.3) smoke.spawn(x, y + 1, z, wind.x * 0.3, 4 + Math.random() * 3, wind.z * 0.3, 0xf4f1ee, { life: 3, grav: 0.5, drag: 0.3, grow: 3 });
};
// Aim marker: where a dump would land right now (bucket velocity carried through the fall).
const aim = new THREE.Mesh(new THREE.RingGeometry(8, 10, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.6, depthWrite: false, fog: false }));
scene.add(aim);
function updateAim(r) {
  // The bomber's drop starts under its belly; the bucket's under the bucket.
  const src = isPlane() ? s : r, bottom = isPlane() ? 0 : hangOf(r);
  aim.visible = isPlane() ? s.water > 0.1 && !s.onSurface : hasLine() && r.tool === 'bucket' && r.water > 0.05 && !r.dipped;
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
function updateWind(t) {
  const a = 0.8 + Math.sin(t * 0.013) * 0.6;
  wind.str = Math.max(0, 5 + 3 * Math.sin(t * 0.21) + 2 * Math.sin(t * 0.53 + 1));
  wind.x = Math.cos(a) * wind.str;
  wind.z = Math.sin(a) * wind.str;
}
const env = { groundAt, heightAt, trees: hitTrees, wind, loadMass: 0, pond: null };
// Island projects show in the world and switch on their effects (the dip tank joins the bucket's water sources).
const buildout = () => { setProjects(career.projects); env.pond = career.projects.includes('pond') ? POND : null; };
buildout();

// Input: keyboard state -> axes in [-1, 1].
const keys = new Set(), pending = { act: false, swap: false, accept: -1, abandon: false }; // one-shot actions, consumed by the next sim step
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input') && e.code !== 'Escape') return; // settings sliders and checkboxes keep their own keys
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (!e.repeat) press(e.code);
});
// Menu buttons and hangar rows carry the key they stand for, so clicking and typing do the same thing.
document.getElementById('overlay').addEventListener('click', (e) => { const k = e.target.closest('[data-key]')?.dataset.key; if (k) press(k); });
function press(code) {
  startAudio();
  if (code === 'KeyM') return toggleMute();
  if (mode === 'settings') return code === 'Escape' && closeSettings();
  if (mode === 'hangar') return hangarKey(code);
  if (mode === 'title' || mode === 'results') {
    if (code === 'Digit1') startShift();
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
  if (code === 'KeyR') pending.swap = true;
  if (/^Digit[1-5]$/.test(code) && mode === 'shift') pending.accept = +code.slice(5) - 1;
  if (code === 'KeyX') pending.abandon = true;
}
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// Mouse: drag to orbit the camera around the chopper, wheel to zoom. The orbit eases back behind you after release.
const orbit = { yaw: 0, pitch: 0, zoom: 1, dragging: false, idle: 9 };
renderer.domElement.addEventListener('pointerdown', (e) => { orbit.dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { orbit.dragging = false; orbit.idle = 0; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  orbit.yaw -= e.movementX * 0.006 * opts.sens;
  orbit.pitch = Math.min(1.2, Math.max(-0.35, orbit.pitch + e.movementY * 0.004 * opts.sens * (opts.invertY ? -1 : 1)));
});
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); orbit.zoom = Math.min(4, Math.max(0.6, orbit.zoom * Math.exp(e.deltaY * 0.001))); }, { passive: false });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const axis = (pos, neg) => (pos.some((c) => keys.has(c)) ? 1 : 0) - (neg.some((c) => keys.has(c)) ? 1 : 0);
const readInput = () => ({
  fwd: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
  turn: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
  lift: axis(['Space'], ['ShiftLeft', 'ShiftRight']),
  strafe: axis(['KeyE'], ['KeyQ']),
  winch: axis(['KeyC'], ['KeyZ']),
});

const spawnCraft = () => (isPlane() ? createPlane(RUNWAY.start.x, RUNWAY.y, RUNWAY.start.z, RUNWAY.yaw) : createFlight(PAD.x, PAD.y, PAD.z, PAD.yaw));
let s = spawnCraft();
const prev = { pos: s.pos.clone(), yaw: s.yaw, pitch: s.pitch, roll: s.roll };
const rigHome = padLocal(PAD, 4.5, 1); // beside the chopper, out of the camera's line
const rig = createRig(rigHome.x, PAD.y + 1.2, rigHome.z);
const rigView = buildRigView(scene);
const crates = []; // everything the hook can carry: job crates and casualties

// Out of fuel and stopped (or switching aircraft): back to the pad or the dock, rig reset.
function towHome() {
  s = spawnCraft();
  window.__game && (window.__game.s = s);
  if (rig.crate) { rig.crate.held = false; rig.crate = null; }
  Object.assign(rig, createRig(rigHome.x, PAD.y + 1.2, rigHome.z), { tool: rig.tool });
  prev.pos.copy(s.pos);
}
const onPad = () => s.grounded && [...PADS, ...(career.projects.includes('stations') ? SITES.filter((p) => !p.hospital) : [])].some((p) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < PAD_RADIUS);
const atStrip = () => isPlane() && s.grounded && onRunway(s.pos.x, s.pos.z); // stopped on the airstrip: refuel and hangar
const atBase = () => atStrip() || (s.grounded && Math.hypot(s.pos.x - PAD.x, s.pos.z - PAD.z) < PAD_RADIUS); // hangar is open here, even mid-shift
const onShift = () => mode === 'shift' || (mode === 'hangar' && backTo === 'shift');           // shopping mid-shift doesn't stop the clock
const canHangar = () => resumeTo === 'free' || atBase();                                       // free roam: open anywhere
const view = new THREE.Vector3();
let camYaw = s.yaw, loadFocus = 0, ropeDrop = 0;
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
const menuHtml = () => `<h1>ROTOR RELAY</h1><p class="tag">Island air dispatch</p><nav class="menu">
  ${btn('Digit1', 'Start shift', 'Fight wildfires, sling cargo, pull people out of trouble')}
  ${btn('Digit2', 'Free roam', 'No calls, no clock, unlimited fuel')}
  ${btn('Digit3', 'Hangar', `Bank $${career.bank.toLocaleString()}`)}
  ${btn('Digit4', 'Settings', 'Controls, volume, look sensitivity')}</nav>
  <p class="dim small">Calls left waiting fill the chaos meter; when it's full the shift ends.<br>Finish jobs back to back to chain them for bonus pay.</p>
  <p class="credit">Bomber engine sound: "airplane prop loop" by AntumDeluge, from a recording by jakobthiesen (CC BY 3.0)</p>`;
const pauseHtml = () => `<h1>PAUSED</h1><nav class="menu">${btn('Escape', 'Resume')}${canHangar() ? btn('KeyH', 'Hangar') : ''}${btn('Digit3', 'Settings', 'Controls and options')}
  ${resumeTo === 'shift' ? btn('Digit2', 'End shift', 'Bank what you have earned so far') : btn('Digit2', 'Main menu')}</nav>`;
const kb = (...k) => k.map((x) => `<kbd>${x}</kbd>`).join('');
const group = (title, rows) => `<div><h3>${title}</h3><table>${rows.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('')}</table></div>`;
const CONTROLS = [
  ['Helicopter', [[kb('W', 'S'), 'Pitch forward / back'], [kb('A', 'D'), 'Turn'], [kb('Q', 'E'), 'Strafe'], [kb('Space', 'Shift'), 'Climb / descend'],
    [kb('F'), 'Action: dump, hook, release'], [kb('R'), 'Swap bucket / hook'], [kb('Z', 'C'), 'Winch in / out']]],
  ['Water Bomber', [[kb('Space', 'Shift'), 'Throttle up / down'], [kb('W', 'S'), 'Pitch nose down / up'], [kb('A', 'D'), 'Bank'], [kb('Q', 'E'), 'Rudder'],
    ['<span class="dim">Skim the sea</span>', 'Scoop water above ~65 km/h'], [kb('F'), 'Drop water']]],
  ['General', [[kb('1', '–', '5'), 'Take a call'], [kb('X'), 'Abandon the job'], [kb('H'), 'Hangar (at base, anywhere in free roam)'], [kb('M'), 'Mute'], [kb('Esc'), 'Pause / back'],
    [kb('Drag'), 'Look around'], [kb('Wheel'), 'Zoom']]],
];
const OPTS = [['volume', 'Master volume', 'range', 0, 1], ['sens', 'Mouse look sensitivity', 'range', 0.25, 2], ['invertY', 'Invert look Y'], ['fps', 'Show FPS'], ['hint', 'Show controls hint while flying']];
const optHtml = ([k, label, type, min, max]) => type
  ? `<label><span>${label}</span><input type="range" data-opt="${k}" min="${min}" max="${max}" step="0.05" value="${opts[k]}"><output>${Math.round(opts[k] * 100)}%</output></label>`
  : `<label><span>${label}</span><input type="checkbox" data-opt="${k}"${opts[k] ? ' checked' : ''}></label>`;
let settingsFrom = 'title';
function openSettings() { settingsFrom = mode; setMode('settings'); }
function closeSettings() { setMode(settingsFrom); }
const settingsHtml = () => `<div><h1>SETTINGS</h1><h2>Controls</h2>
  <div class="ctl">${CONTROLS.map(([t, r]) => group(t, r)).join('')}</div>
  <p class="dim small">Arrow keys also fly: up/down pitch, left/right turn (bank).</p>
  <h2>Options</h2><div class="opts">${OPTS.map(optHtml).join('')}</div>
  <nav class="menu row">${btn('Escape', 'Back')}</nav></div>`;
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
  if (m === 'title') overlay.innerHTML = menuHtml();
  if (m === 'results') overlay.innerHTML = resultsHtml;
  if (m === 'paused') overlay.innerHTML = pauseHtml();
  if (m === 'settings') overlay.innerHTML = settingsHtml();
}
setMode('title');
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
  towHome();
  resumeTo = 'free';
  setMode('free');
  tip();
}
function startShift() {
  const seed = (Math.random() * 2 ** 31) | 0;
  if (dispatch) disposeDispatch(dispatch);
  resetFire(fire, seed);
  resetScorch(houses);
  towHome();
  s.fuel = 1;
  rig.water = 0;
  simT = 0;
  dispatch = createDispatch({ scene, fire, houses, crates, can: (type) => airframe().jobs.includes(type), firepower: () => (isPlane() ? PLANE.tank : hasLine() ? RIG.cap : 0), lookout: () => career.projects.includes('towers') }, seed);
  window.__game.dispatch = dispatch;
  resumeTo = 'shift';
  setMode('shift');
  tip();
}
const cost = (n) => (Math.round(n) ? `−$${Math.round(n).toLocaleString()}` : '<span class="dim">—</span>');
function endShift(quit) {
  const st = dispatch.stats, net = netOf(st), best = recordShift(career, st.earned, st.earned - net);
  saveCareer(storage, career);
  const mins = `${Math.floor(dispatch.t / 60)}:${String(Math.floor(dispatch.t % 60)).padStart(2, '0')}`;
  resultsHtml = `<h1>SHIFT OVER</h1><p class="dim">Shift · ${quit ? 'clocked off' : 'chaos took over'} at ${mins}</p>
    <table><tr><td>Fires out</td><td>${st.done.fire}</td></tr><tr><td>Deliveries</td><td>${st.done.cargo}</td></tr><tr><td>Rescues</td><td>${st.done.rescue}</td></tr>
    <tr><td>Best chain</td><td>${st.bestCombo} jobs (×${comboMult(st.bestCombo).toFixed(2)})</td></tr>
    <tr><td>Houses lost</td><td>${st.housesLost}</td></tr><tr><td>Casualties lost</td><td>${st.lost}</td></tr>
    <tr><td>Earned</td><td>$${st.earned.toLocaleString()}</td></tr>
    <tr><td>Fuel</td><td>${cost(st.fuel)}</td></tr><tr><td>Losses</td><td>${cost(st.losses)}</td></tr>
    <tr class="big"><td>Net${best ? ' · NEW BEST' : ''}</td><td>${net < 0 ? '−' : ''}$${Math.abs(net).toLocaleString()}</td></tr>
    <tr><td>Best shift</td><td>$${career.best.toLocaleString()}</td></tr>
    <tr><td>Bank</td><td>$${career.bank.toLocaleString()}</td></tr></table>
    <nav class="menu row">${btn('Digit1', 'New shift')}${btn('KeyH', 'Hangar')}${btn('Escape', 'Main menu')}</nav>`;
  setMode('results');
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
    updateWind((simT += STEP));
    if (isPlane() && pending.act) { const ok = drop(s); if (ok) sfx('dump'); say(ok ? 'Drop!' : 'Tank empty: skim the sea to scoop'); }
    if (!hasLine()) { if (pending.swap) say(`The ${airframe().name} has no line`); pending.act = pending.swap = false; }
    if (pending.act) {
      const r = act(rig, crates), what = rig.crate?.spec === RIG.person ? 'Casualty' : 'Load';
      if (r === 'hooked') { sfx('hook'); say(`${what} hooked`); }
      if (r === 'released') { sfx('release'); say('Load released'); }
      if (r === 'dump') sfx('dump');
    }
    if (pending.accept >= 0 && dispatch) { const j = accept(dispatch, pending.accept); if (j) { sfx('accept'); say(`Accepted: ${j.title}`); } }
    if (pending.abandon && dispatch?.job) { if (rig.crate && dispatch.job.crate === rig.crate) act(rig, crates); abandon(dispatch); say('Job returned to the board'); }
    pending.accept = -1;
    pending.abandon = false;
    if (pending.swap) { const ok = swapTool(rig); if (ok) sfx('swap'); say(ok ? `Tool: ${rig.tool}` : 'Release the load first'); }
    pending.act = pending.swap = false;
    env.loadMass = hasLine() && rig.taut ? massOf(rig) : 0;
    if (mode === 'free') s.fuel = 1;
    if (isPlane()) { stepPlane(s, input, STEP, env); spawnPlaneDrops(s.poured); }
    else stepFlight(s, input, STEP, env);
    if (hasLine()) { winch(rig, input.winch, STEP); stepRig(rig, s, STEP, env); }
    if (rig.hit > 4) thud(Math.min(1, rig.hit / 25));
    for (const c of crates) if (!c.held) { stepCrate(c, STEP, env); if (c.hit > 4) thud(Math.min(1, c.hit / 20)); }
    stepFire(fire, STEP, wind);
    for (const c of fire.scorched) { scorch(c); if (dispatch) onScorch(dispatch, c); }
    fire.scorched.length = 0;
    spawnDrops(rig, rig.poured, false);
    spawnDrops(rig, rig.spilled, true);
    if ((onPad() && input.lift <= 0) || (atStrip() && s.throttle < 0.1)) {
      const add = Math.min(1 - s.fuel, 0.2 * STEP);
      s.fuel += add;
      if (onShift()) dispatch.stats.fuel += fuelBill(career, career.airframe, add); // free roam is free
    }
    towT = s.fuel <= 0 && s.grounded ? towT + STEP : 0;
    if (towT > 3) towHome();
    hit = Math.max(hit, s.hit);
    acc -= STEP;
  }
  // Hard landings, cliff and tree strikes: shake + thump. Gentle touchdowns stay silent.
  if (hit > 2.5) { trauma = Math.min(1, trauma + hit / 20); thud(Math.min(1, hit / 15)); }
  trauma = Math.max(0, trauma - dt * 1.5);

  // Interpolate between the last two sim states for smooth rendering.
  const a = acc / STEP;
  view.lerpVectors(prev.pos, s.pos, a);
  craft.group.position.copy(view);
  craft.group.rotation.set(-(prev.pitch + (s.pitch - prev.pitch) * a), prev.yaw + (s.yaw - prev.yaw) * a, prev.roll + (s.roll - prev.roll) * a);
  craft.spin(dt, isPlane() ? s.throttle : input.lift > 0 ? 1 : 0, s);
  craft.beacon.visible = t % 1.1 < 0.12;
  craft.strobe.visible = (t + 0.5) % 1.4 < 0.06;

  const gy = groundAt(view.x, view.z), alt = view.y - gy;
  shadow.position.set(view.x, gy + (gy <= SEA ? 0.5 : 0.15), view.z);
  shadow.scale.setScalar(1 + alt * 0.01);
  shadow.material.opacity = Math.max(0, 0.45 - alt * 0.004);
  spawnWash(dt, view.x, gy, view.z, alt, gy <= SEA, isPlane() ? (s.scooping ? 2 : 0) : s.grounded && input.lift <= 0 ? 0.3 : 1);
  wash.update(dt);
  drops.update(dt, groundAt);
  const end = rigView(rig, view, a, hasLine());
  updateAim(rig);
  for (const c of crates) { placeCrateMesh(c.mesh, c); if (c === rig.crate) c.mesh.position.copy(end); }
  smoke.update(dt);
  fireView(fire, dt, t, wind);
  let goal = null;
  if (onShift()) {
    const prevEarned = dispatch.stats.earned;
    updateDispatch(dispatch, dt, s, say);
    if (dispatch.stats.earned > prevEarned) sfx('done');
    goal = updateMarkers(dispatch, view);
    if (dispatch.over) endShift();
  }
  windsock.userData.update(wind);
  lighthouse.userData.update(t);
  updateLife(t);

  // Chase camera: trails heading, pulls back and widens with speed.
  camVel.lerp(s.vel, 1 - Math.exp(-2 * dt));
  const speed = Math.hypot(camVel.x, camVel.z);
  let dy = s.yaw - camYaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  const turn = dy * (1 - Math.exp(-(isPlane() ? 3.5 : 2.5) * dt));
  camYaw += turn;
  // While looking around (dragging, or just let go) the view holds its world direction instead of swinging with the nose.
  const looking = orbit.dragging || orbit.idle < 1.5;
  if (looking) orbit.yaw -= turn;
  // Pull back and up to frame the slung load when it matters (carrying, water aboard, working low); close otherwise.
  const working = hasLine() && (rig.crate || rig.water > 0.02 || rig.dipped || (alt < 25 && !s.grounded && rig.len > 0.5));
  loadFocus += ((working ? 1 : 0) - loadFocus) * (1 - Math.exp(-1.5 * dt));
  const cam = airframe().cam, dist = (14 + 5 * loadFocus) * cam + speed * 0.07, height = (5.5 + 1.5 * loadFocus) * cam + speed * 0.04, k = 1 - Math.exp(-(6 - 2 * loadFocus) * dt);
  if (!orbit.dragging && (orbit.idle += dt) > 1.5) { const r = 1 - Math.exp(-2 * dt); orbit.yaw -= Math.atan2(Math.sin(orbit.yaw), Math.cos(orbit.yaw)) * r; orbit.pitch -= orbit.pitch * r; }
  // The plane's camera also follows its pitch (sits lower as the nose comes up) and trails a little looser.
  const planeCam = isPlane(), cy = camYaw + orbit.yaw, elev = Math.atan2(height, dist) + orbit.pitch + (planeCam ? s.pitch * 0.6 : 0), reach = Math.hypot(dist, height) * orbit.zoom;
  camera.position.lerp({ x: view.x + Math.sin(cy) * Math.cos(elev) * reach, y: view.y + Math.sin(elev) * reach, z: view.z + Math.cos(cy) * Math.cos(elev) * reach }, planeCam ? 1 - Math.exp(-4 * dt) : k);
  camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 2, SEA + 1.5);
  // Aim partway down the rope so chopper and load share the frame.
  // Frame by the rope's average drop, not the swinging load; look ahead less while orbiting with the mouse.
  ropeDrop += (end.y - view.y - 2 - ropeDrop) * (1 - Math.exp(-1.5 * dt));
  const ahead = 0.3 * Math.max(0, 1 - Math.abs(Math.atan2(Math.sin(orbit.yaw), Math.cos(orbit.yaw))) - Math.abs(orbit.pitch));
  if (planeCam) look.lerp(new THREE.Vector3(0, 0, -12 * (ahead / 0.3)).applyQuaternion(craft.group.quaternion).add(view).setY(view.y + 3 - s.pitch * 12 * (ahead / 0.3)), 1 - Math.exp(-6 * dt)); // ahead along the nose
  else look.lerp({ x: view.x + camVel.x * ahead, y: view.y + 2 + camVel.y * 0.15 + ropeDrop * 0.35 * loadFocus, z: view.z + camVel.z * ahead }, 1 - Math.exp(-6 * dt));
  camera.lookAt(look);
  if (mode === 'title' || (mode === 'hangar' && backTo === 'title')) { // menu backdrop: a slow orbit of the parked aircraft, framed right of the menu
    const o = t * 0.04 + s.yaw + 2.2;
    camera.position.set(s.pos.x + Math.sin(o) * 60, 0, s.pos.z + Math.cos(o) * 60);
    camera.position.y = Math.max(s.pos.y + 20, heightAt(camera.position.x, camera.position.z) + 8);
    camera.lookAt(s.pos.x, s.pos.y + 5, s.pos.z);
    camera.rotateY(0.28);
  }
  if (isPlane()) camera.rotateZ(-(prev.roll + (s.roll - prev.roll) * a) * 0.18); // lean the horizon a little with the bank
  if (trauma > 0) { const q = trauma * trauma * 0.04; camera.rotation.x += (Math.random() - 0.5) * q; camera.rotation.y += (Math.random() - 0.5) * q; camera.rotation.z += (Math.random() - 0.5) * q; }
  updateAudio(isPlane() ? s.throttle * 2 - 1 : input.lift, speed, career.airframe, {
    grounded: s.grounded,
    turn: Math.abs(s.roll),
    water: isPlane() ? (s.scooping ? 1 : s.onWater ? Math.min(1, s.speed / 22) * 0.55 : 0) : hasLine() && rig.dipped ? 0.45 : 0,
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
  const load = isPlane() ? `THR    ${bar(s.throttle)} ${Math.round(s.throttle * 100)}%\nTANK   ${bar(s.water / PLANE.tank)} ${Math.round((s.water / PLANE.tank) * 100)}%`
    : !hasLine() ? 'LINE   none (rescues only)'
    : `${rig.tool === 'bucket' ? `BUCKET ${bar(rig.water / RIG.cap)} ${Math.round((rig.water / RIG.cap) * 100)}%` : `HOOK   ${held}`}\nLINE   ${rig.len <= 0.15 ? 'stowed' : `${rig.len.toFixed(1)} m`} (Z/C)`;
  hud.textContent = `ROTOR RELAY\nALT ${alt.toFixed(0).padStart(4)} m\nSPD ${(speed * 3.6).toFixed(0).padStart(4)} km/h\nV/S ${s.vel.y.toFixed(1).padStart(5)} m/s\nWND ${wind.str.toFixed(0).padStart(4)} m/s\nFUEL   ${bar(s.fuel)} ${Math.round(s.fuel * 100)}%\n${load}${opts.fps ? `\n${fps} fps` : ''}`;
  if (frames % 15 === 0) board.innerHTML = boardHtml(goal);
  if (onShift()) meter.innerHTML = meterHtml();
  updateCompass(goal, dispatch?.job?.type);
  flashT -= dt;
  prompt.textContent = flashT > 0 ? flash
    : s.fuel <= 0 ? (s.grounded ? 'Out of fuel. Towing you back to base…' : isPlane() ? 'ENGINES OUT: glide down onto the water' : 'ENGINE OUT: autorotating, find somewhere to land')
    : onPad() && s.fuel < 1 ? `Refuelling… ${Math.round(s.fuel * 100)}%${onShift() ? ` · −$${Math.round(dispatch.stats.fuel).toLocaleString()}` : ''}${atBase() ? ' · H: Hangar' : ''}`
    : atBase() && mode !== 'hangar' ? 'H: Hangar'
    : s.fuel < 0.2 && t % 1 < 0.6 ? (isPlane() ? 'LOW FUEL: land on the airstrip to refuel' : 'LOW FUEL: land on a pad to refuel')
    : isPlane() ? planePrompt()
    : rig.overloaded ? `Too heavy for the ${airframe().name}! Needs the Heavy Lifter or more rotor power (F: let go)`
    : rig.crate ? 'F: release load'
    : rig.tool === 'hook' ? (nearestCrate(rig, crates) ? `F: hook ${nearestCrate(rig, crates).spec === RIG.person ? 'casualty' : 'crate'}` : '')
    : rig.dipped && rig.water < RIG.cap ? 'Filling…'
    : rig.water > 0.05 && !rig.dumping ? 'F: dump water' : '';
});

window.__game = { s, rig, crates, renderer, camera, scene, wind, heightAt, fire, dispatch, startShift, press };

function planePrompt() {
  if (!s.onSurface && s.lift < 1) return 'STALL! Nose down (W) and throttle up (Space)';
  if (s.scooping) return s.water < PLANE.tank ? 'Scooping…' : 'Tank full: pull up (S)';
  if (s.water > 0.1 && !s.dumping) return s.onSurface ? 'Throttle up and lift off (S) to make a drop' : 'F: drop water';
  if (s.onSurface && !s.onWater && s.speed < 25) return s.water < 0.1 ? 'Throttle up (Space), rotate at speed (S). Scoop by skimming the sea' : 'Throttle up (Space) and rotate (S) to take off';
  if (s.onWater && s.speed < PLANE.scoopSpeed) return 'Faster! Skim the sea above 65 km/h to scoop';
  return '';
}

function boardHtml(goal) {
  const d = dispatch, tag = (t) => `<b class="${t}">${t.toUpperCase()}</b>`;
  if (mode === 'free') return `<div class="head">FREE ROAM <span>$${career.bank.toLocaleString()}</span></div><div class="dim">H: Hangar · Esc: Menu</div>`;
  if (!d) return `<div class="head">DISPATCH <span>$${career.bank.toLocaleString()}</span></div><div class="dim">Off shift</div>`;
  const km = (o) => (Math.hypot(o.x - s.pos.x, o.z - s.pos.z) / 1000).toFixed(1);
  const late = (o) => (o.type === 'fire' ? (o.house ? ` · <span class="dim">house lost in ${Math.ceil(SHIFT.houseBurn - o.house.burnT)}s</span>` : '') : ` · <span class="dim">${Math.max(0, Math.ceil((o.type === 'rescue' ? SHIFT.rescueTimeout : SHIFT.cargoTimeout) - o.age))}s</span>`);
  const heavyTag = (o) => (o.heavy ? ` <b class="heavy">HEAVY</b>${RIG.maxLift < RIG[o.heavy].mass ? ' <span class="dim">(need more lift)</span>' : ''}` : '');
  const part = (o) => (o.story?.of > 1 ? `<div class="dim">${o.step > 1 ? '<b class="follow">FOLLOW-UP</b> · ' : ''}${o.story.name} · ${o.step}/${o.story.of}</div>` : '');
  const bonus = (o) => (o.after && o.after === d.lastId ? ` <b class="follow">+${Math.round((SHIFT.followBonus - 1) * 100)}%</b>` : '');
  const rows = d.calls.map((o, i) => `<div>[${i + 1}] ${tag(o.type)}${heavyTag(o)} ${o.title} · $${o.reward}${bonus(o)} · ${km(o)} km${late(o)}${part(o)}</div>`).join('') || '<div class="dim">No calls right now</div>';
  const job = d.job ? `<div class="job">${tag(d.job.type)} ${goal ? `${goal.text} · ${(goal.dist / 1000).toFixed(1)} km` : ''}<br><span class="dim">X: abandon</span></div>` : (d.calls.length ? `<div class="dim">Press ${d.calls.length > 1 ? `1–${d.calls.length}` : '1'} to take a call</div>` : '');
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
function openHangar(msg = '') {
  if (mode !== 'hangar') backTo = mode;
  setMode('hangar');
  const pips = (n) => '▮'.repeat(n) + '▯'.repeat(MAX_LEVEL - n);
  const upKeys = upgradesFor(career.airframe);
  const ups = upKeys.map((k, i) => {
    const u = UPGRADES[k], lvl = career.levels[career.airframe][k], cost = lvl < MAX_LEVEL && upgradeCost(career.airframe, k, lvl);
    return `<tr data-key="Digit${i + 1}"><td>[${i + 1}] ${u.name}</td><td>${pips(lvl)}</td><td class="dim">${u.blurb}</td><td>${cost ? `$${cost.toLocaleString()}` : 'MAX'}</td></tr>`;
  }).join('');
  const frames = AIRFRAME_KEYS.map((k, i) => {
    const a = AIRFRAMES[k], state = career.airframe === k ? 'FLYING' : career.owned.includes(k) ? 'owned' : `$${a.cost.toLocaleString()}`;
    return `<tr data-key="Digit${upKeys.length + i + 1}"><td>[${upKeys.length + i + 1}] ${a.name}</td><td></td><td class="dim">${a.blurb}</td><td>${state}</td></tr>`;
  }).join('');
  const projects = PROJECT_KEYS.map((k, i) => {
    const p = PROJECTS[k], built = career.projects.includes(k);
    return `<tr data-key="Key${LETTERS[i]}"><td>[${LETTERS[i]}] ${p.name}</td><td></td><td class="dim">${p.blurb}</td><td>${built ? 'BUILT' : `$${p.cost.toLocaleString()}`}</td></tr>`;
  }).join('');
  overlay.innerHTML = `<h1>HANGAR</h1><p>Bank <b>$${career.bank.toLocaleString()}</b></p>
    <table class="hangar"><tr><th colspan="4">Upgrades: ${airframe().name}</th></tr>${ups}<tr><th colspan="4">Airframes</th></tr>${frames}<tr><th colspan="4">Island projects</th></tr>${projects}</table>
    <p class="msg">${msg}</p>${backTo === 'shift' ? '<p class="dim">Your shift is still running!</p>' : ''}<nav class="menu row">${btn('Escape', 'Back')}</nav>`;
}
function hangarKey(code) {
  if (code === 'KeyH' || code === 'Escape') return setMode(backTo);
  const p = LETTERS.indexOf(/^Key([A-E])$/.exec(code)?.[1]);
  if (PROJECT_KEYS[p] && code !== 'KeyH') { const msg = buyProject(career, PROJECT_KEYS[p]); buildout(); saveCareer(storage, career); return openHangar(msg); }
  const n = /^Digit(\d)$/.exec(code)?.[1] - 1, upKeys = upgradesFor(career.airframe);
  if (!(n >= 0)) return;
  const msg = n < upKeys.length ? buyUpgrade(career, upKeys[n]) : AIRFRAME_KEYS[n - upKeys.length] ? buyOrSelectAirframe(career, AIRFRAME_KEYS[n - upKeys.length]) : '';
  if (!msg) return;
  refit();
  openHangar(msg);
}
