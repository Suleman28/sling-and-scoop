import * as THREE from 'three';

// A soft puff: a disc of radius r, solid out to half way, then fading to nothing at the rim (vertex alpha).
function puffGeometry(r, k = 10) {
  const pos = [0, 0, 0], col = [1, 1, 1, 1], idx = [];
  for (const [rr, a] of [[0.5, 1], [1, 0]]) for (let i = 0; i < k; i++) { const t = (i / k) * Math.PI * 2; pos.push(Math.cos(t) * r * rr, Math.sin(t) * r * rr, 0); col.push(1, 1, 1, a); }
  for (let i = 0; i < k; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % k);
    idx.push(0, a, b, a, a + k, b, b, a + k, b + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
// Turns each instance to face the camera (keeping its position and scale), for puffGeometry.
const billboard = (sh) => {
  sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mvPosition.xy += position.xy * length(instanceMatrix[0].xyz);
  gl_Position = projectionMatrix * mvPosition;`);
};

// Pooled particles in one instanced draw call. Oldest particle is recycled when full. soft: camera-facing puffs with
// fading edges (smoke, dust, spray, fire); otherwise little low-poly chunks (debris).
export function makeParticles(scene, n, { opacity = 0.5, size = 0.5, glow = false, soft = true } = {}) {
  const ps = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, rate: 1, grav: 0, drag: 0, grow: 1, puff: true, onLand: null }));
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, vertexColors: soft, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending });
  if (soft) mat.onBeforeCompile = billboard;
  const mesh = new THREE.InstancedMesh(soft ? puffGeometry(size * 1.3) : new THREE.IcosahedronGeometry(size, 0), mat, n);
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

// Surface foam: soft-edged blobs (bright centre, rim fades to nothing) that drift with their push (vx, vz), spread
// and fade. Overlapping blobs merge into a foam field. Additive, so a colour faded to black is invisible.
export function makeRings(scene, n = 260) {
  const rs = Array.from({ length: n }, () => ({ x: 0, z: 0, vx: 0, vz: 0, yaw: 0, w0: 0.35, l0: 1.4, w1: 0.75, l1: 3.2, life: 0, rate: 1, hex: 0xeff8fc }));
  const g = new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2), p = g.attributes.position, shade = new Float32Array(p.count * 3);
  for (let i = 1; i < p.count; i++) { const k = 0.75 + 0.25 * Math.abs(Math.sin(i * 2.3)); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } // ragged rim
  shade.fill(1, 0, 3); // only the centre is lit
  g.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }), n);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), color = new THREE.Color(), tint = new THREE.Color();
  let next = 0;
  function spawn(x, z, w0 = 0.35, l1 = 2.6, life = 0.8, vx = 0, vz = 0, hex = 0xe8f7fc) {
    const sp = Math.hypot(vx, vz);
    const yaw = sp > 0.05 ? Math.atan2(vx, vz) : Math.random() * Math.PI * 2;
    const l0 = Math.max(0.8, l1 * 0.45), w1 = Math.max(l1 * 0.6, w0 * 3); // soft ovals, only mildly stretched along the push
    Object.assign(rs[next], { x, z, vx, vz, yaw, w0, l0, w1, l1, life: 1, rate: 1 / life, hex });
    next = (next + 1) % n;
  }
  function update(dt, waveAt, lift = 0.3) {
    const drag = Math.exp(-2.4 * dt);
    rs.forEach((r, i) => {
      if (r.life > 0) {
        r.life -= dt * r.rate;
        r.vx *= drag; r.vz *= drag;
        r.x += r.vx * dt; r.z += r.vz * dt;
      }
      const u = 1 - Math.max(0, r.life), ease = 1 - (1 - u) * (1 - u);
      const w = r.life > 0 ? r.w0 + (r.w1 - r.w0) * ease : 0;
      const l = r.life > 0 ? r.l0 + (r.l1 - r.l0) * ease : 0;
      q.setFromAxisAngle(up, r.yaw);
      m.compose(pos.set(r.x, (waveAt ? waveAt(r.x, r.z) : 0) + lift, r.z), q, sc.set(w, 1, l));
      mesh.setMatrixAt(i, m);
      const fade = r.life > 0 ? Math.min(1, (1 - r.life) * 6) * r.life ** 1.5 : 0; // pops in, then thins out
      mesh.setColorAt(i, color.copy(tint.setHex(r.hex)).multiplyScalar(fade));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  return { spawn, update };
}

// A waterjet boat's wake, two draws. The trail: twin white jet streams off the transom that spread, merge and fade,
// and a bow wave that hugs the hull, then breaks into the two Kelvin arms spreading at ~19.5 degrees (0.34 x speed
// sideways) as patchy whitecaps. Built from crumbs dropped along her track, so it follows her turns; each strip fades out at its edges.
// The plumes: a churning mound of jet water thrown out of each nozzle (a low rooster tail), steered with the nozzles;
// with the reversing buckets down it boils out forward and to the sides of the stern instead.
const STRIPS = [[0, 5], [5, 3], [8, 3]], ROW = 11, NU = 8; // [first vertex, vertices across] per strip; plume rows along
export function makeWake(scene, n = 110, T = 9) {
  const crumbs = [], rows = n + 1, pos = new Float32Array(rows * ROW * 3), col = new Float32Array(rows * ROW * 4), idx = [];
  for (let i = 0; i < n; i++) for (const [s0, w] of STRIPS) for (let h = 0; h < w - 1; h++) {
    const a = i * ROW + s0 + h, b = a + ROW;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  for (let i = 0; i < col.length; i += 4) col.set([0.93, 0.97, 0.97], i); // foam white; alpha does the shaping
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  const pv = (NU + 1) * 5, ppos = new Float32Array(pv * 2 * 3), pcol = new Float32Array(pv * 2 * 4), pidx = [];
  for (let k = 0; k < 2; k++) for (let i = 0; i < NU; i++) for (let j = 0; j < 4; j++) {
    const a = k * pv + i * 5 + j, b = a + 5;
    pidx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  for (let i = 0; i < pcol.length; i += 4) pcol.set([1, 1, 1], i);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(ppos, 3).setUsage(THREE.DynamicDrawUsage));
  pg.setAttribute('color', new THREE.BufferAttribute(pcol, 4).setUsage(THREE.DynamicDrawUsage));
  pg.setIndex(pidx);
  const plume = new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, flatShading: true, side: THREE.DoubleSide, emissive: 0x3a4a52 }));
  plume.frustumCulled = false;
  plume.renderOrder = 2;
  scene.add(plume);
  let t = 0;

  // boat: { x, z, yaw, speed, throttle -1..1, steer -1..1, stern, bow, beam, jets: [nozzle x, nozzle z] } (her frame, m), or null.
  function update(dt, waveAt, lift, boat) {
    t += dt;
    for (const c of crumbs) c.age += dt;
    while (crumbs.length && (crumbs.length > n - 1 || crumbs[crumbs.length - 1].age > T)) crumbs.pop();
    let live = null;
    const thr = boat ? Math.abs(boat.throttle) : 0;
    if (boat) {
      const fx = -Math.sin(boat.yaw), fz = -Math.cos(boat.yaw), v = Math.abs(boat.speed);
      live = { x: boat.x - fx * boat.stern, z: boat.z - fz * boat.stern, bx: boat.x + fx * boat.bow, bz: boat.z + fz * boat.bow, rx: -fz, rz: fx, v, churn: thr, beam: boat.beam, sep: boat.jets[0], age: 0, k: 1, kl: 1, kr: 1 };
      const last = crumbs[0];
      if (!last || last.age > 0.4 || Math.hypot(live.x - last.x, live.z - last.z) > 2) crumbs.unshift({ ...live, k: 0.45 + Math.random() * 0.55, kl: 0.25 + 0.75 * Math.random() ** 1.5, kr: 0.25 + 0.75 * Math.random() ** 1.5 }); // k, kl, kr break the foam up (skewed dim, so the arms come out as patchy whitecaps)
    }
    const count = Math.min(rows, crumbs.length + (live ? 1 : 0));
    const drawCount = Math.max(0, count - 1) * 48;
    mesh.visible = drawCount > 0;
    if (mesh.visible) {
      g.setDrawRange(0, drawCount);
      for (let i = 0; i < count; i++) {
        const c = live ? (i === 0 ? live : crumbs[i - 1]) : crumbs[i];
        const f = Math.max(0, 1 - c.age / T), o = i * ROW, wy = waveAt(c.x, c.z) + lift;
        const put = (j, d, cx, cz, alpha) => { const v = o + j; pos[v * 3] = cx + c.rx * d; pos[v * 3 + 1] = wy; pos[v * 3 + 2] = cz + c.rz * d; col[v * 4 + 3] = alpha; };
        const a = Math.min(0.95, (Math.min(0.85, c.v / 9 + c.churn * 0.3) * (1 + 0.5 * Math.exp(-c.age * 1.5)))) * f ** 1.6 * (0.55 + 0.45 * c.k);
        const js = c.sep + c.age * 0.35, hw = (js + 1 + c.age * 0.6) * (0.85 + 0.15 * c.k), mid = a * (0.3 + 0.7 * Math.min(1, c.age / 1.8)); // twin streams merging
        put(0, -hw, c.x, c.z, 0); put(1, -js, c.x, c.z, a); put(2, 0, c.x, c.z, mid); put(3, js, c.x, c.z, a); put(4, hw, c.x, c.z, 0);
        // Bow wave, then Kelvin arm: wide solid white hugging the hull for her first second, then thin, patchy whitecaps that fade.
        const bow = Math.exp(-c.age * 2.5), fa = Math.max(0, 1 - c.age / 5), sp = Math.min(1, c.v / 8), spread = 0.4 + c.age * c.v * 0.34, aw = 0.5 + c.age * 0.5 + bow * 0.9;
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? -1 : 1, j0 = s === 0 ? 5 : 8, bx = c.bx + c.rx * side * spread, bz = c.bz + c.rz * side * spread;
          const arm = sp * fa * fa * Math.min(0.9, 0.55 * (side < 0 ? c.kl : c.kr) + 0.6 * bow);
          put(j0, -aw, bx, bz, 0); put(j0 + 1, 0, bx, bz, arm); put(j0 + 2, aw, bx, bz, 0);
        }
      }
      g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
    }

    plume.visible = thr > 0.02;
    if (!plume.visible) return;
    const v = Math.abs(boat.speed), rev = boat.throttle < 0, cy = Math.cos(boat.yaw), sy = Math.sin(boat.yaw), th = -boat.steer * 0.42;
    const H = rev ? thr * 0.5 : thr * (0.3 + 0.55 * Math.min(1, v / 14)), L = rev ? 1.2 + thr * 2.2 : 1.5 + thr * (2.5 + v * 0.3);
    for (let k = 0; k < 2; k++) {
      const sx = k === 0 ? -1 : 1;
      let dx = Math.sin(th), dz = Math.cos(th); // aft along the nozzle, in her frame
      if (rev) { dx = sx * 0.8; dz = -0.6; }    // buckets down: thrown forward and out under the quarters
      const ox = sx * boat.jets[0], oz = boat.jets[1];
      for (let i = 0; i <= NU; i++) for (let j = 0; j < 5; j++) {
        const u = i / NU, w = j / 2 - 1, half = 0.3 + u * (0.8 + 0.08 * L), along = L * u;
        const lx = ox + dx * along + dz * w * half, lz = oz + dz * along - dx * w * half;
        const x = boat.x + lx * cy + lz * sy, z = boat.z - lx * sy + lz * cy;
        const boil = 0.5 + 0.5 * Math.sin(t * 11 + u * 7.3 + w * 4.1 + k * 2) * Math.sin(t * 6.7 - u * 5 + w * 2.3 + k);
        const h = H * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8 * (1 - w * w) * (0.7 + 0.6 * boil);
        const vi = k * pv + i * 5 + j;
        ppos[vi * 3] = x; ppos[vi * 3 + 1] = waveAt(x, z) + lift + h; ppos[vi * 3 + 2] = z;
        pcol[vi * 4 + 3] = Math.min(0.95, 0.45 + thr * 0.6) * (1 - u) ** 0.8 * (1 - Math.abs(w) ** 3);
      }
    }
    pg.attributes.position.needsUpdate = pg.attributes.color.needsUpdate = true;
    pg.computeVertexNormals();
  }
  return { update };
}

// Rain: streaks in a box that travels with the camera, slanted by the wind. amount 0..1 sets how many fall.
export function makeRain(scene, n = 900) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.022, 1.6, 0.022), new THREE.MeshBasicMaterial({ color: 0xcfe0ee, transparent: true, opacity: 0.45, depthWrite: false, fog: false }), n);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  const seeds = Float32Array.from({ length: n * 3 }, Math.random), m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), dir = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const W = 70, Hh = 40, wrap = (v, w) => ((v % w) + w) % w - w / 2;
  let fall = 0;
  return (dt, cam, wind, amount) => {
    mesh.count = Math.floor(n * amount);
    if (!mesh.count) return;
    fall += dt * 26;
    q.setFromUnitVectors(up, dir.set(wind.x * 0.04, 1, wind.z * 0.04).normalize());
    for (let i = 0; i < mesh.count; i++) {
      const y = wrap(seeds[i * 3 + 1] * Hh - fall - cam.y, Hh), z = wrap(seeds[i * 3 + 2] * W - cam.z + wind.z * 0.04 * y, W);
      let x = wrap(seeds[i * 3] * W - cam.x + wind.x * 0.04 * y, W);
      if (x * x + z * z < 25) x += W / 2; // none right in the lens
      mesh.setMatrixAt(i, m.compose(p.set(cam.x + x, cam.y + y, cam.z + z), q, one));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
}
