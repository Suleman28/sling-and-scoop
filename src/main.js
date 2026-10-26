import * as THREE from 'three';
import { buildWorld, RUNWAY, onRunway, fuelAt, groundAt, heightAt, hitTrees, PAD, PAD_RADIUS, padLocal, PADS, resetScorch, scorch, SEA, SEED } from './world.js';
import { buildChopper, createFlight, stepFlight } from './chopper.js';
import { buildPlane, createPlane, drop, PLANE, stepPlane } from './plane.js';
import { startAudio, thud, toggleMute, updateAudio } from './audio.js';
import { makeParticles } from './fx.js';
import { act, winch, buildRigView, createRig, hangOf, massOf, nearestCrate, placeCrateMesh, RIG, stepCrate, stepRig, swapTool } from './tools.js';
import { buildFireView, createFire, douse, resetFire, stepFire } from './fire.js';
import { AIRFRAMES, applyLoadout, buyOrSelectAirframe, buyUpgrade, loadCareer, recordShift, saveCareer, UPGRADES } from './career.js';
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

const { sky, water, windsock, houses } = buildWorld(scene);
// Career (money, upgrades, airframes) persists in localStorage, which may be missing or blocked.
let storage = null;
try { storage = localStorage; } catch {}
const career = loadCareer(storage);
if (import.meta.env.DEV) career.bank = Math.max(career.bank, 1_000_000); // dev server only: test money for trying everything
applyLoadout(career);
const airframe = () => AIRFRAMES[career.airframe];
const isPlane = () => !!airframe().plane;
const hasLine = () => airframe().tools.length > 0; // the starter Scout and the bomber have no line
const buildCraft = () => (isPlane() ? buildPlane(airframe()) : buildChopper(airframe()));
let craft = buildCraft();
scene.add(craft.group);
// Controls line follows the aircraft type.
function setHelp() {
  document.getElementById('help').textContent = isPlane()
    ? 'Space/Shift throttle · W/S pitch · A/D bank · skim the sea to scoop · F drop · 1–5 take call · X abandon · drag look · wheel zoom · M mute'
    : `W/S pitch · A/D turn · Q/E strafe · Space/Shift climb/descend${hasLine() ? ' · F action · R bucket/hook · Z/C winch' : ''} · 1–5 take call · X abandon · drag look · wheel zoom · M mute`;
}
setHelp();
function refit() {
  const wasPlane = 'throttle' in s; // plane state has a throttle; helicopter state doesn't
  applyLoadout(career);
  if (!hasLine()) { if (rig.crate) act(rig, crates); Object.assign(rig, createRig(s.pos.x, s.pos.y, s.pos.z)); }
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
const splash = (x, y, z, amount = 1 / 250) => {
  wash.spawn(x, y + 0.3, z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, SPRAY, { life: 0.6, grow: 0.8 });
  if (douse(fire, x, z, amount) && Math.random() < 0.3) smoke.spawn(x, y + 1, z, wind.x * 0.3, 4 + Math.random() * 3, wind.z * 0.3, 0xf4f1ee, { life: 3, grav: 0.5, drag: 0.3, grow: 3 });
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
      { life: 6, grav: -9.81, drag: 0.4, grow: 1.6, puff: false, onLand: (x, y, z) => splash(x, y, z, 1 / 70) });
  }
}
let dropAcc = 0;
function spawnDrops(r, amount, rim) {
  const h = hangOf(r);
  for (dropAcc += amount * 250; dropAcc >= 1; dropAcc--) {
    const a = Math.random() * Math.PI * 2, rad = rim ? 0.85 : Math.random() * 0.5;
    drops.spawn(r.pos.x + Math.cos(a) * rad, r.pos.y - (rim ? 0.2 : h), r.pos.z + Math.sin(a) * rad,
      r.vel.x + (Math.random() - 0.5) * 1.5, r.vel.y - 1, r.vel.z + (Math.random() - 0.5) * 1.5, WATER, { life: 4, grav: -9.81, drag: 0.3, grow: 1, puff: false, onLand: splash });
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
const env = { groundAt, heightAt, trees: hitTrees, wind, loadMass: 0 };

// Input: keyboard state -> axes in [-1, 1].
const keys = new Set(), pending = { act: false, swap: false, accept: -1, abandon: false }; // one-shot actions, consumed by the next sim step
addEventListener('keydown', (e) => {
  keys.add(e.code);
  startAudio();
  if (e.code === 'KeyM' && !e.repeat) toggleMute();
  if (mode === 'hangar' && !e.repeat) { hangarKey(e.code); return; }
  if (e.code === 'KeyH' && !e.repeat && (mode === 'title' || mode === 'results' || atBase())) openHangar();
  if (e.code === 'KeyF' && !e.repeat) pending.act = true;
  if (e.code === 'KeyR' && !e.repeat) pending.swap = true;
  if (/^Digit[1-5]$/.test(e.code) && !e.repeat) {
    if (mode === 'shift') pending.accept = +e.code.slice(5) - 1;
    else if (e.code === 'Digit1' || e.code === 'Digit2') startShift(e.code === 'Digit2');
  }
  if (e.code === 'KeyX' && !e.repeat) pending.abandon = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// Mouse: drag to orbit the camera around the chopper, wheel to zoom. The orbit eases back behind you after release.
const orbit = { yaw: 0, pitch: 0, zoom: 1, dragging: false, idle: 9 };
renderer.domElement.addEventListener('pointerdown', (e) => { orbit.dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { orbit.dragging = false; orbit.idle = 0; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  orbit.yaw -= e.movementX * 0.006;
  orbit.pitch = Math.min(1.2, Math.max(-0.35, orbit.pitch + e.movementY * 0.004));
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
const onPad = () => s.grounded && PADS.some((p) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < PAD_RADIUS);
const atStrip = () => isPlane() && s.grounded && onRunway(s.pos.x, s.pos.z); // stopped on the airstrip: refuel and hangar
const atBase = () => atStrip() || (s.grounded && Math.hypot(s.pos.x - PAD.x, s.pos.z - PAD.z) < PAD_RADIUS); // hangar is open here, even mid-shift
const onShift = () => mode === 'shift' || (mode === 'hangar' && backTo === 'shift');           // shopping mid-shift doesn't stop the clock
const view = new THREE.Vector3();
let camYaw = s.yaw, loadFocus = 0, ropeDrop = 0;
const camVel = new THREE.Vector3(); // smoothed chopper velocity: load yanks shouldn't jolt the camera
const look = s.pos.clone();
camera.position.set(s.pos.x + Math.sin(camYaw) * 16, s.pos.y + 6, s.pos.z + Math.cos(camYaw) * 16);

const hud = document.getElementById('hud'), prompt = document.getElementById('prompt'), board = document.getElementById('board');
let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0, t = 0, simT = 0, trauma = 0, towT = 0, flash = '', flashT = 0;
const say = (msg, minor) => { if (minor && flashT > 0) return; flash = msg; flashT = 2.5; }; // minor messages don't overwrite others

// Modes: 'title' (free flight, nothing happening), 'shift', 'results' (paused on the summary).
// A shift resets the island, then the director escalates until chaos fills. The daily shift seeds the director
// (and fire spread) from today's date, so everyone gets the same calls in the same places.
let mode = 'title', dispatch = null, daily = false, backTo = 'title';
const overlay = document.getElementById('overlay'), meter = document.getElementById('meter');
const today = new Date(), DAILY_SEED = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
const DAILY_DATE = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const titleHtml = overlay.innerHTML;
let resultsHtml = '';
function startShift(isDaily) {
  daily = isDaily;
  const seed = isDaily ? DAILY_SEED : (Math.random() * 2 ** 31) | 0;
  if (dispatch) disposeDispatch(dispatch);
  resetFire(fire, seed);
  resetScorch(houses);
  towHome();
  s.fuel = 1;
  rig.water = 0;
  simT = 0;
  dispatch = createDispatch({ scene, fire, houses, crates, can: (type) => airframe().jobs.includes(type), bigFires: () => career.owned.includes('bomber') }, seed);
  window.__game.dispatch = dispatch;
  mode = 'shift';
  overlay.style.display = 'none';
  meter.style.display = '';
}
function endShift() {
  mode = 'results';
  const st = dispatch.stats, best = recordShift(career, st.earned, daily ? DAILY_DATE : null);
  saveCareer(storage, career);
  const mins = `${Math.floor(dispatch.t / 60)}:${String(Math.floor(dispatch.t % 60)).padStart(2, '0')}`;
  overlay.innerHTML = resultsHtml = `<h1>SHIFT OVER</h1><p class="dim">${daily ? `Daily shift · ${DAILY_DATE}` : 'Shift'} · chaos took over at ${mins}</p>
    <table><tr><td>Fires out</td><td>${st.done.fire}</td></tr><tr><td>Deliveries</td><td>${st.done.cargo}</td></tr><tr><td>Rescues</td><td>${st.done.rescue}</td></tr>
    <tr><td>Best chain</td><td>${st.bestCombo} jobs (×${comboMult(st.bestCombo).toFixed(2)})</td></tr>
    <tr><td>Houses lost</td><td>${st.housesLost}</td></tr><tr><td>Casualties lost</td><td>${st.lost}</td></tr>
    <tr class="big"><td>Earned${best ? ' · NEW BEST' : ''}</td><td>$${st.earned.toLocaleString()}</td></tr>
    <tr><td>${daily ? "Today's best" : 'Best shift'}</td><td>$${(daily ? career.daily[DAILY_DATE] : career.best).toLocaleString()}</td></tr>
    <tr><td>Bank</td><td>$${career.bank.toLocaleString()}</td></tr></table>
    <p>1: New shift · 2: Daily shift · H: Hangar</p>`;
  overlay.style.display = '';
}

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += dt;
  t += dt;

  const input = readInput();
  let hit = 0;
  if (mode === 'results' || (mode === 'hangar' && !onShift())) acc = 0; // paused on the summary / in the hangar between shifts
  while (acc >= STEP) {
    prev.pos.copy(s.pos); prev.yaw = s.yaw; prev.pitch = s.pitch; prev.roll = s.roll;
    updateWind((simT += STEP));
    if (isPlane() && pending.act) say(drop(s) ? 'Drop!' : 'Tank empty: skim the sea to scoop');
    if (!hasLine()) { if (pending.swap) say(`The ${airframe().name} has no line`); pending.act = pending.swap = false; }
    if (pending.act) {
      const r = act(rig, crates), what = rig.crate?.spec === RIG.person ? 'Casualty' : 'Load';
      if (r === 'hooked') say(`${what} hooked`);
      if (r === 'released') say('Load released');
    }
    if (pending.accept >= 0 && dispatch) { const j = accept(dispatch, pending.accept); if (j) say(`Accepted: ${j.title}`); }
    if (pending.abandon && dispatch?.job) { if (rig.crate && dispatch.job.crate === rig.crate) act(rig, crates); abandon(dispatch); say('Job returned to the board'); }
    pending.accept = -1;
    pending.abandon = false;
    if (pending.swap) say(swapTool(rig) ? `Tool: ${rig.tool}` : 'Release the load first');
    pending.act = pending.swap = false;
    env.loadMass = hasLine() && rig.taut ? massOf(rig) : 0;
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
    if ((onPad() && input.lift <= 0) || (atStrip() && s.throttle < 0.1)) s.fuel = Math.min(1, s.fuel + 0.2 * STEP);
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
  craft.spin(dt, isPlane() ? s.throttle : input.lift > 0 ? 1 : 0);
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
    updateDispatch(dispatch, dt, s, say);
    goal = updateMarkers(dispatch, view);
    if (dispatch.over) endShift();
  }
  windsock.userData.update(wind);

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
  const working = hasLine() && (rig.crate || rig.water > 0.02 || rig.dipped || (alt < 25 && !s.grounded));
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
  if (isPlane()) camera.rotateZ(-(prev.roll + (s.roll - prev.roll) * a) * 0.18); // lean the horizon a little with the bank
  if (trauma > 0) { const q = trauma * trauma * 0.04; camera.rotation.x += (Math.random() - 0.5) * q; camera.rotation.y += (Math.random() - 0.5) * q; camera.rotation.z += (Math.random() - 0.5) * q; }
  updateAudio(isPlane() ? s.throttle * 2 - 1 : input.lift, speed, isPlane());
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
    : `${rig.tool === 'bucket' ? `BUCKET ${bar(rig.water / RIG.cap)} ${Math.round((rig.water / RIG.cap) * 100)}%` : `HOOK   ${held}`}\nLINE   ${rig.len.toFixed(1)} m (Z/C)`;
  hud.textContent = `ROTOR RELAY\nALT ${alt.toFixed(0).padStart(4)} m\nSPD ${(speed * 3.6).toFixed(0).padStart(4)} km/h\nV/S ${s.vel.y.toFixed(1).padStart(5)} m/s\nWND ${wind.str.toFixed(0).padStart(4)} m/s\nFUEL   ${bar(s.fuel)} ${Math.round(s.fuel * 100)}%\n${load}\n${fps} fps`;
  if (frames % 15 === 0) board.innerHTML = boardHtml(goal);
  if (onShift()) meter.innerHTML = meterHtml();
  flashT -= dt;
  prompt.textContent = flashT > 0 ? flash
    : s.fuel <= 0 ? (s.grounded ? 'Out of fuel. Towing you back to base…' : isPlane() ? 'ENGINES OUT: glide down onto the water' : 'ENGINE OUT: autorotating, find somewhere to land')
    : onPad() && s.fuel < 1 ? `Refuelling… ${Math.round(s.fuel * 100)}%${atBase() ? ' · H: Hangar' : ''}`
    : atBase() && mode !== 'hangar' ? 'H: Hangar'
    : s.fuel < 0.2 && t % 1 < 0.6 ? (isPlane() ? 'LOW FUEL: land on the airstrip to refuel' : 'LOW FUEL: land on a pad to refuel')
    : isPlane() ? planePrompt()
    : rig.overloaded ? `Too heavy for the ${airframe().name}! Needs the Heavy Lifter or more rotor power (F: let go)`
    : rig.crate ? 'F: release load'
    : rig.tool === 'hook' ? (nearestCrate(rig, crates) ? `F: hook ${nearestCrate(rig, crates).spec === RIG.person ? 'casualty' : 'crate'}` : '')
    : rig.dipped && rig.water < RIG.cap ? 'Filling…'
    : rig.water > 0.05 && !rig.dumping ? 'F: dump water' : '';
});

window.__game = { s, rig, crates, renderer, camera, scene, wind, heightAt, fire, dispatch, startShift };

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
  if (!d) return `<div class="head">DISPATCH <span>$${career.bank.toLocaleString()}</span></div><div class="dim">Off shift</div>`;
  const km = (o) => (Math.hypot(o.x - s.pos.x, o.z - s.pos.z) / 1000).toFixed(1);
  const late = (o) => (o.type === 'fire' ? '' : ` · <span class="dim">${Math.max(0, Math.ceil((o.type === 'rescue' ? SHIFT.rescueTimeout : SHIFT.cargoTimeout) - o.age))}s</span>`);
  const heavyTag = (o) => (o.heavy ? ` <b class="heavy">HEAVY</b>${RIG.maxLift < RIG[o.heavy].mass ? ' <span class="dim">(need more lift)</span>' : ''}` : '');
  const rows = d.calls.map((o, i) => `<div>[${i + 1}] ${tag(o.type)}${heavyTag(o)} ${o.title} · $${o.reward} · ${km(o)} km${late(o)}</div>`).join('') || '<div class="dim">No calls right now</div>';
  const job = d.job ? `<div class="job">${tag(d.job.type)} ${goal ? `${goal.text} · ${(goal.dist / 1000).toFixed(1)} km` : ''}<br><span class="dim">X: abandon</span></div>` : (d.calls.length ? `<div class="dim">Press ${d.calls.length > 1 ? `1–${d.calls.length}` : '1'} to take a call</div>` : '');
  return `<div class="head">DISPATCH <span>$${(career.bank + (mode === 'shift' ? d.stats.earned : 0)).toLocaleString()}</span></div>${rows}${job}`;
}

function meterHtml() {
  const d = dispatch, m = comboMult(d.combo), mins = `${Math.floor(d.t / 60)}:${String(Math.floor(d.t % 60)).padStart(2, '0')}`;
  const combo = d.comboT > 0 ? `<span class="combo">CHAIN ${d.combo} · ×${m.toFixed(2)}</span><div class="bar thin"><i style="width:${(d.comboT / SHIFT.comboWindow) * 100}%"></i></div>` : '<span class="dim">No chain</span>';
  return `<div class="row"><span>CHAOS</span><div class="bar"><i class="${d.chaos > 75 ? 'hot' : ''}" style="width:${d.chaos}%"></i></div><span>${mins}</span></div>${combo}`;
}

// ---- Hangar: spend the bank between shifts. Keys 1-4 upgrade, 5-7 buy or switch airframe. ----

const UPGRADE_KEYS = Object.keys(UPGRADES), AIRFRAME_KEYS = Object.keys(AIRFRAMES);
function openHangar(msg = '') {
  if (mode !== 'hangar') backTo = mode;
  mode = 'hangar';
  const pips = (n) => '▮'.repeat(n) + '▯'.repeat(3 - n);
  const ups = UPGRADE_KEYS.map((k, i) => {
    const u = UPGRADES[k], lvl = career.levels[k], cost = u.cost[lvl];
    return `<tr><td>[${i + 1}] ${u.name}</td><td>${pips(lvl)}</td><td class="dim">${u.blurb}</td><td>${cost ? `$${cost.toLocaleString()}` : 'MAX'}</td></tr>`;
  }).join('');
  const frames = AIRFRAME_KEYS.map((k, i) => {
    const a = AIRFRAMES[k], state = career.airframe === k ? 'FLYING' : career.owned.includes(k) ? 'owned' : `$${a.cost.toLocaleString()}`;
    return `<tr><td>[${UPGRADE_KEYS.length + i + 1}] ${a.name}</td><td></td><td class="dim">${a.blurb}</td><td>${state}</td></tr>`;
  }).join('');
  overlay.innerHTML = `<h1>HANGAR</h1><p>Bank <b>$${career.bank.toLocaleString()}</b></p>
    <table class="hangar"><tr><th colspan="4">Upgrades</th></tr>${ups}<tr><th colspan="4">Airframes</th></tr>${frames}</table>
    <p class="msg">${msg}</p>${backTo === 'shift' ? '<p class="dim">Your shift is still running!</p>' : ''}<p>H / Esc: back</p>`;
  overlay.style.display = '';
}
function hangarKey(code) {
  if (code === 'KeyH' || code === 'Escape') {
    mode = backTo;
    if (backTo === 'shift') overlay.style.display = 'none';
    else overlay.innerHTML = backTo === 'results' ? resultsHtml : titleHtml;
    return;
  }
  const n = /^Digit(\d)$/.exec(code)?.[1] - 1;
  if (!(n >= 0)) return;
  const msg = n < UPGRADE_KEYS.length ? buyUpgrade(career, UPGRADE_KEYS[n]) : AIRFRAME_KEYS[n - UPGRADE_KEYS.length] ? buyOrSelectAirframe(career, AIRFRAME_KEYS[n - UPGRADE_KEYS.length]) : '';
  if (!msg) return;
  refit();
  openHangar(msg);
}
