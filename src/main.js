import * as THREE from 'three';
import { buildWorld, groundAt, heightAt, hitTrees, PAD, SEA } from './world.js';
import { buildChopper, createFlight, stepFlight } from './chopper.js';
import { startAudio, thud, toggleMute, updateAudio } from './audio.js';

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

const { sky, water, windsock } = buildWorld(scene);
const heli = buildChopper();
scene.add(heli.group);

const shadow = new THREE.Mesh(new THREE.CircleGeometry(3.4, 16).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x1a1020, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
scene.add(shadow);

// Rotor wash: pooled low-poly puffs thrown outward from the ground point under the rotor.
const WASH = 160, washPuffs = Array.from({ length: WASH }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 }));
const wash = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }), WASH);
wash.frustumCulled = false;
wash.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(wash);
const SPRAY = new THREE.Color(0xeaf6f4), DUST = new THREE.Color(0xd8b48c), washM = new THREE.Matrix4(), washQ = new THREE.Quaternion(), washS = new THREE.Vector3(), washP = new THREE.Vector3();
let washNext = 0, washAcc = 0;
function updateWash(dt, x, gy, z, alt, onWater, power) {
  washAcc += Math.max(0, 1 - alt / 20) * power * 150 * dt;
  for (; washAcc >= 1; washAcc--) {
    const p = washPuffs[washNext], a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 3, sp = 8 + Math.random() * 8;
    Object.assign(p, { x: x + Math.cos(a) * r, y: gy + 0.3, z: z + Math.sin(a) * r, vx: Math.cos(a) * sp, vy: (onWater ? 2 : 1) + Math.random() * 2, vz: Math.sin(a) * sp, life: 1 });
    wash.setColorAt(washNext, onWater ? SPRAY : DUST);
    washNext = (washNext + 1) % WASH;
  }
  const drag = Math.exp(-2 * dt);
  washPuffs.forEach((p, i) => {
    if (p.life > 0) {
      p.life -= dt * 1.3;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= drag; p.vz *= drag; p.vy -= 3 * dt;
    }
    washM.compose(washP.set(p.x, p.y, p.z), washQ, washS.setScalar(p.life > 0 ? Math.sin(p.life * Math.PI) * 1.2 : 0));
    wash.setMatrixAt(i, washM);
  });
  wash.instanceMatrix.needsUpdate = true;
  if (wash.instanceColor) wash.instanceColor.needsUpdate = true;
}

// Wind: slowly veering direction with layered gusts, 0..10 m/s.
const wind = { x: 0, z: 0, str: 0 };
function updateWind(t) {
  const a = 0.8 + Math.sin(t * 0.013) * 0.6;
  wind.str = Math.max(0, 5 + 3 * Math.sin(t * 0.21) + 2 * Math.sin(t * 0.53 + 1));
  wind.x = Math.cos(a) * wind.str;
  wind.z = Math.sin(a) * wind.str;
}
const env = { groundAt, trees: hitTrees, wind };

// Input: keyboard state -> axes in [-1, 1].
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  startAudio();
  if (e.code === 'KeyM' && !e.repeat) toggleMute();
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const axis = (pos, neg) => (pos.some((c) => keys.has(c)) ? 1 : 0) - (neg.some((c) => keys.has(c)) ? 1 : 0);
const readInput = () => ({
  fwd: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
  turn: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
  lift: axis(['Space'], ['ShiftLeft', 'ShiftRight']),
  strafe: axis(['KeyE'], ['KeyQ']),
});

const s = createFlight(PAD.x, PAD.y, PAD.z, PAD.yaw);
const prev = { pos: s.pos.clone(), yaw: s.yaw, pitch: s.pitch, roll: s.roll };
const view = new THREE.Vector3();
let camYaw = s.yaw, rotorSpin = 0;
const look = s.pos.clone();
camera.position.set(s.pos.x + Math.sin(camYaw) * 16, s.pos.y + 6, s.pos.z + Math.cos(camYaw) * 16);

const hud = document.getElementById('hud');
let acc = 0, last = performance.now(), frames = 0, fpsT = last, fps = 0, t = 0, simT = 0, trauma = 0;

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += dt;
  t += dt;

  const input = readInput();
  let hit = 0;
  while (acc >= STEP) {
    prev.pos.copy(s.pos); prev.yaw = s.yaw; prev.pitch = s.pitch; prev.roll = s.roll;
    updateWind((simT += STEP));
    stepFlight(s, input, STEP, env);
    hit = Math.max(hit, s.hit);
    acc -= STEP;
  }
  // Hard landings, cliff and tree strikes: shake + thump. Gentle touchdowns stay silent.
  if (hit > 2.5) { trauma = Math.min(1, trauma + hit / 20); thud(Math.min(1, hit / 15)); }
  trauma = Math.max(0, trauma - dt * 1.5);

  // Interpolate between the last two sim states for smooth rendering.
  const a = acc / STEP;
  view.lerpVectors(prev.pos, s.pos, a);
  heli.group.position.copy(view);
  heli.group.rotation.set(-(prev.pitch + (s.pitch - prev.pitch) * a), prev.yaw + (s.yaw - prev.yaw) * a, prev.roll + (s.roll - prev.roll) * a);

  // Rotors: deliberately slow apparent spin so it reads instead of strobing.
  rotorSpin += dt * (input.lift > 0 ? 26 : 21);
  heli.rotor.rotation.y = rotorSpin;
  heli.tail.rotation.x = rotorSpin * 1.7;
  heli.disc.material.opacity = 0.1 + (input.lift > 0 ? 0.05 : 0);
  heli.beacon.visible = t % 1.1 < 0.12;
  heli.strobe.visible = (t + 0.5) % 1.4 < 0.06;

  const gy = groundAt(view.x, view.z), alt = view.y - gy;
  shadow.position.set(view.x, gy + (gy <= SEA ? 0.5 : 0.15), view.z);
  shadow.scale.setScalar(1 + alt * 0.01);
  shadow.material.opacity = Math.max(0, 0.45 - alt * 0.004);
  updateWash(dt, view.x, gy, view.z, alt, gy <= SEA, s.grounded && input.lift <= 0 ? 0.3 : 1);
  windsock.userData.update(wind);

  // Chase camera: trails heading, pulls back and widens with speed.
  const speed = Math.hypot(s.vel.x, s.vel.z);
  let dy = s.yaw - camYaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  camYaw += dy * (1 - Math.exp(-2.5 * dt));
  const dist = 14 + speed * 0.07, k = 1 - Math.exp(-6 * dt);
  camera.position.lerp({ x: view.x + Math.sin(camYaw) * dist, y: view.y + 5.5 + speed * 0.04, z: view.z + Math.cos(camYaw) * dist }, k);
  camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 2, SEA + 1.5);
  look.lerp({ x: view.x + s.vel.x * 0.3, y: view.y + 2 + s.vel.y * 0.15, z: view.z + s.vel.z * 0.3 }, 1 - Math.exp(-10 * dt));
  camera.lookAt(look);
  if (trauma > 0) { const q = trauma * trauma * 0.04; camera.rotation.x += (Math.random() - 0.5) * q; camera.rotation.y += (Math.random() - 0.5) * q; camera.rotation.z += (Math.random() - 0.5) * q; }
  updateAudio(input.lift, speed);
  const fov = 62 + speed * 0.16;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * k; camera.updateProjectionMatrix(); }

  sky.position.copy(camera.position);
  water.userData.update(t, camera.position);
  renderer.render(scene, camera);

  frames++;
  if (now - fpsT > 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  hud.textContent = `ROTOR RELAY\nALT ${alt.toFixed(0).padStart(4)} m\nSPD ${(speed * 3.6).toFixed(0).padStart(4)} km/h\nV/S ${s.vel.y.toFixed(1).padStart(5)} m/s\nWND ${wind.str.toFixed(0).padStart(4)} m/s\n${fps} fps`;
});

window.__game = { s, renderer, camera, scene, wind };
