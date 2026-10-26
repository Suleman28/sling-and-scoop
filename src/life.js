import * as THREE from 'three';
import { bodyBaker } from './chopper.js';
import { heightAt, mulberry32, SEED, SITES, LIGHTHOUSE } from './world.js';

// Ambient scenery that moves: drifting clouds, circling seabirds and sailboats. Pure decoration (no collision),
// one instanced draw call each.
const UP = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), p = new THREE.Vector3(), sc = new THREE.Vector3();

function clouds(scene, rng) {
  const b = bodyBaker();
  for (const [x, y, z, r] of [[0, 0, 0, 1], [1.1, -0.2, 0.3, 0.75], [-1, -0.25, -0.2, 0.7], [0.3, 0.35, -0.4, 0.6]]) b.add(new THREE.IcosahedronGeometry(r, 1), 0xfff3ea, x, y, z);
  const n = 34, mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x5a4050 }), n);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const list = Array.from({ length: n }, () => ({ x: (rng() - 0.5) * 4000, z: (rng() - 0.5) * 4000, y: 280 + rng() * 160, s: 22 + rng() * 40, yaw: rng() * 6.28 }));
  return (t) => {
    list.forEach((c, i) => {
      const x = ((c.x + t * 6 + 2000) % 4000) - 2000, z = ((c.z + t * 3 + 2000) % 4000) - 2000; // drift on the prevailing wind, wrapping
      mesh.setMatrixAt(i, m.compose(p.set(x, c.y, z), q.setFromAxisAngle(UP, c.yaw), sc.set(c.s, c.s * 0.55, c.s * 0.8)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// Gull flocks wheeling over the towns and the lighthouse. Wings flap by flipping the V's y scale.
function birds(scene, rng) {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.4, -1.4, 0.5, 0.1, 0, 0, 0.3, 0, 0, -0.4, 0, 0, 0.3, 1.4, 0.5, 0.1], 3));
  const flocks = [...SITES, LIGHTHOUSE].map((c) => ({ x: c.x, z: c.z, y: Math.max(c.y, 0) + 45 + rng() * 30, r: 50 + rng() * 60, w: (rng() < 0.5 ? -1 : 1) * (0.12 + rng() * 0.06) }));
  const per = 7, mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xf6efe8, side: THREE.DoubleSide }), flocks.length * per);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const birds = flocks.flatMap((f) => Array.from({ length: per }, () => ({ f, a: rng() * 0.9, dr: (rng() - 0.5) * 30, dy: (rng() - 0.5) * 14, flap: rng() * 6, rate: 7 + rng() * 3 })));
  return (t) => {
    birds.forEach((b, i) => {
      const f = b.f, a = f.w * t + b.a, r = f.r + b.dr + Math.sin(t * 0.3 + b.flap) * 10;
      const glide = Math.sin(t * 0.7 + b.flap) > 0.3; // flap in bursts, glide between
      e.set(0.05, a + (f.w > 0 ? 0 : Math.PI), -Math.sign(f.w) * 0.35);
      m.compose(p.set(f.x + Math.cos(a) * r, f.y + b.dy + Math.sin(t * 0.5 + b.flap) * 3, f.z - Math.sin(a) * r), q.setFromEuler(e), sc.set(1.3, glide ? 0.15 : 1.3 * Math.sin(t * b.rate + b.flap), 1.3));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

// Sailboats on slow loops through open water (each loop checked to stay clear of land).
function boats(scene, rng) {
  const b = bodyBaker();
  b.add(new THREE.BoxGeometry(2.4, 1.1, 6), (x, y) => (y > 0.75 ? 0x2f7c7a : 0xf6efe6), 0, 0.5, 0.4);
  b.add(new THREE.CylinderGeometry(0, 1.2, 2.6, 4, 1).rotateY(Math.PI / 4).scale(1.4, 1, 0.8).rotateX(-Math.PI / 2), 0xf6efe6, 0, 0.5, -3.7);
  b.add(new THREE.BoxGeometry(1.6, 0.8, 2), 0xd9c4b0, 0, 1.45, 1.2);
  b.add(new THREE.CylinderGeometry(0.08, 0.1, 8, 4), 0x2a2a32, 0, 5, -0.6);
  b.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(3.4, 0), new THREE.Vector2(0, 7)])).rotateY(-Math.PI / 2), 0xfff1d8, 0, 1.6, -0.5);
  b.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-1.1, 0), new THREE.Vector2(1.1, 0), new THREE.Vector2(4, 16), new THREE.Vector2(-4, 16)])).rotateX(-Math.PI / 2), 0xd7ecea, 0, 0.12, 3.4); // wake
  const loops = [];
  for (let tries = 0; tries < 400 && loops.length < 7; tries++) {
    const x = (rng() - 0.5) * 2600, z = (rng() - 0.5) * 2600, r = 80 + rng() * 220;
    if ([...Array(24)].some((_, k) => heightAt(x + Math.cos(k / 3.82) * (r + 25), z + Math.sin(k / 3.82) * (r + 25)) > -3 || heightAt(x + Math.cos(k / 3.82) * (r - 25), z + Math.sin(k / 3.82) * (r - 25)) > -3)) continue;
    loops.push({ x, z, r, w: ((rng() < 0.5 ? -1 : 1) * 5) / r, a: rng() * 6.28 });
  }
  const mesh = new THREE.InstancedMesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }), loops.length);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return (t) => {
    loops.forEach((l, i) => {
      const a = l.a + l.w * t;
      e.set(Math.sin(t * 0.9 + i) * 0.03, (l.w > 0 ? Math.PI : 0) - a, Math.sign(l.w) * 0.12 + Math.sin(t * 1.3 + i) * 0.05); // heel into the turn, bob on the swell
      mesh.setMatrixAt(i, m.compose(p.set(l.x + Math.cos(a) * l.r, Math.sin(t * 1.1 + i * 2) * 0.2 - 0.3, l.z + Math.sin(a) * l.r), q.setFromEuler(e), sc.set(1, 1, 1)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}

export function buildLife(scene) {
  const rng = mulberry32(SEED + 4), parts = [clouds, birds, boats].map((f) => f(scene, rng));
  return (t) => parts.forEach((u) => u(t));
}
