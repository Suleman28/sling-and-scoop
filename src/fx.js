import * as THREE from 'three';

// Pooled low-poly particles in one instanced draw call. Oldest particle is recycled when full.
export function makeParticles(scene, n, { opacity = 0.5, size = 0.5 } = {}) {
  const ps = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, rate: 1, grav: 0, drag: 0, grow: 1, puff: true, onLand: null }));
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(size, 0), new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false }), n);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), color = new THREE.Color();
  let next = 0;

  // puff: grows then shrinks (dust, mist). Otherwise a constant-size drop. onLand(x, y, z) fires when a drop hits groundAt.
  function spawn(x, y, z, vx, vy, vz, hex, { life = 1, grav = -3, drag = 2, grow = 1.2, puff = true, onLand = null } = {}) {
    Object.assign(ps[next], { x, y, z, vx, vy, vz, life: 1, rate: 1 / life, grav, drag, grow, puff, onLand });
    mesh.setColorAt(next, color.set(hex));
    next = (next + 1) % n;
  }

  function update(dt, groundAt) {
    ps.forEach((p, i) => {
      if (p.life > 0) {
        p.life -= dt * p.rate;
        const d = Math.exp(-p.drag * dt);
        p.vx *= d; p.vz *= d; p.vy += p.grav * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.onLand && p.y < groundAt(p.x, p.z)) { p.life = 0; p.onLand(p.x, p.y, p.z); }
      }
      const s = p.life > 0 ? (p.puff ? Math.sin(p.life * Math.PI) : 1) * p.grow : 0;
      m.compose(pos.set(p.x, p.y, p.z), q, sc.setScalar(s));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return { spawn, update };
}
