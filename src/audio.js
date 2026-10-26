// Sound is synthesized (rotor chop, turbine whine, airflow, water spray) except the plane's engines: a recorded twin-prop loop
// ("airplane prop loop" by AntumDeluge from a recording by jakobthiesen, CC BY 3.0, see README), pitched by throttle.
// If the file can't load, a synthesized twin-prop voice stands in.
let propLoop = null, propRate = null, propLp = null;
let ctx, master, noise, lfo, lfoDepth, rotorLp, chop, whine, whineGain, piston, pistonLp, pistonGain, windGain, waterBp, waterGain, engines, planeBus, turbine, muted = false;

function noiseSource() {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.start();
  return src;
}

// Browsers only allow audio after a user gesture, so this runs on the first key press.
export function startAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  // Rotor: low-passed noise whose gain and filter cutoff are swept at blade-pass rate ("whop-whop").
  rotorLp = ctx.createBiquadFilter();
  rotorLp.type = 'lowpass';
  rotorLp.frequency.value = 260;
  rotorLp.Q.value = 1.6;
  chop = ctx.createGain();
  chop.gain.value = 0.32;
  lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 17;
  lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.26;
  const filterMod = ctx.createGain();
  filterMod.gain.value = 95;
  lfo.connect(lfoDepth).connect(chop.gain);
  lfo.connect(filterMod).connect(rotorLp.frequency);
  lfo.start();
  noiseSource().connect(rotorLp).connect(chop).connect(master);

  whine = ctx.createOscillator();
  whine.type = 'sine';
  whine.frequency.value = 1250;
  whineGain = ctx.createGain();
  whineGain.gain.value = 0.009;
  whine.connect(whineGain).connect(master);
  whine.start();

  // Flat-six piston / heavy sub-thump voice (gives the Scout a warm piston purr and the Heavy Lifter chesty torque).
  piston = ctx.createOscillator();
  piston.type = 'sawtooth';
  piston.frequency.value = 96;
  pistonLp = ctx.createBiquadFilter();
  pistonLp.type = 'lowpass';
  pistonLp.frequency.value = 210;
  pistonLp.Q.value = 1.8;
  pistonGain = ctx.createGain();
  pistonGain.gain.value = 0;
  piston.connect(pistonLp).connect(pistonGain).connect(master);
  piston.start();

  // Plane: two engines, each a warm blade-pass tone (low-passed sawtooth) plus combustion rumble (band-passed noise
  // pulsed at the blade rate). The engines run ~1% apart, so they beat like unsynchronised props. A faint turbine on top.
  planeBus = ctx.createGain();
  planeBus.gain.value = 0;
  planeBus.connect(master);
  engines = [0, 1].map(() => {
    const buzz = ctx.createOscillator(), buzzLp = ctx.createBiquadFilter(), buzzGain = ctx.createGain();
    buzz.type = 'sawtooth';
    buzzLp.type = 'lowpass';
    buzzLp.Q.value = 1.4;
    buzzGain.gain.value = 0.22;
    buzz.connect(buzzLp).connect(buzzGain).connect(planeBus);
    buzz.start();
    const rumbleBp = ctx.createBiquadFilter(), pulse = ctx.createGain(), pulser = ctx.createOscillator(), depth = ctx.createGain();
    rumbleBp.type = 'bandpass';
    rumbleBp.Q.value = 0.9;
    pulse.gain.value = 0.55;
    depth.gain.value = 0.45;
    pulser.connect(depth).connect(pulse.gain);
    pulser.start();
    noiseSource().connect(rumbleBp).connect(pulse).connect(planeBus);
    return { buzz, buzzLp, rumbleBp, pulser };
  });
  turbine = ctx.createOscillator();
  turbine.type = 'sine';
  const turbineGain = ctx.createGain();
  turbineGain.gain.value = 0.015;
  turbine.connect(turbineGain).connect(planeBus);
  turbine.start();

  fetch(`${import.meta.env.BASE_URL}sfx/airplane_prop.wav`)
    .then((r) => r.arrayBuffer())
    .then((b) => ctx.decodeAudioData(b))
    .then((buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      propLp = ctx.createBiquadFilter();
      propLp.type = 'lowpass';
      propLp.frequency.value = 1200;
      propLoop = ctx.createGain();
      propLoop.gain.value = 0;
      src.connect(propLp).connect(propLoop).connect(master);
      src.start();
      propRate = src.playbackRate;
    })
    .catch(() => {}); // keep the synthesized voice

  const rush = ctx.createBiquadFilter();
  rush.type = 'bandpass';
  rush.frequency.value = 420;
  rush.Q.value = 0.7;
  windGain = ctx.createGain();
  windGain.gain.value = 0;
  noiseSource().connect(rush).connect(windGain).connect(master);

  // Water skim / scoop / bucket dip spray voice.
  waterBp = ctx.createBiquadFilter();
  waterBp.type = 'bandpass';
  waterBp.frequency.value = 680;
  waterBp.Q.value = 0.9;
  waterGain = ctx.createGain();
  waterGain.gain.value = 0;
  noiseSource().connect(waterBp).connect(waterGain).connect(master);
}

// kind: 'scout' | 'utility' | 'heavy' | 'bomber' (or boolean true for bomber).
export function updateAudio(lift, speed, kind = 'utility', state = {}) {
  if (!ctx) return;
  const plane = kind === true || kind === 'bomber';
  const t = ctx.currentTime, thr = (lift + 1) / 2;
  const isScout = kind === 'scout', isHeavy = kind === 'heavy';
  const idle = !plane && state.grounded && lift <= 0 ? 0.55 : 1;
  const slap = 1 + Math.min(0.35, (state.turn || 0) * 0.6);
  chop.gain.setTargetAtTime(plane ? 0 : (isHeavy ? 0.42 : isScout ? 0.28 : 0.34) * idle * slap, t, 0.2);
  lfoDepth.gain.setTargetAtTime(plane ? 0 : (isHeavy ? 0.32 : isScout ? 0.22 : 0.26) * idle * slap, t, 0.2);
  whineGain.gain.setTargetAtTime(plane || isScout ? 0 : (isHeavy ? 0.006 : 0.004) * Math.max(0, lift), t, 0.3); // turbine only sings when you pull power
  pistonGain.gain.setTargetAtTime(plane ? 0 : (isScout ? 0.048 + 0.028 * Math.max(0, lift) : isHeavy ? 0.028 : 0.01) * idle, t, 0.2);
  if (!plane) {
    piston.frequency.setTargetAtTime(((isScout ? 88 : isHeavy ? 52 : 68) + lift * 16 + speed * 0.35) * (0.75 + 0.25 * idle), t, 0.25);
    pistonLp.frequency.setTargetAtTime((isScout ? 230 : 140) + Math.max(0, lift) * 85, t, 0.25);
  }
  // Layer warm synthesized twin-engine beat under the recorded prop loop so the bomber has deep stereo/phased chestiness.
  planeBus.gain.setTargetAtTime(plane ? (propLoop ? 0.055 + 0.065 * thr : 0.14 + 0.12 * thr) : 0, t, 0.2);
  if (propLoop) {
    propLoop.gain.setTargetAtTime(plane ? 0.38 + 0.52 * thr : 0, t, 0.25);
    propRate.setTargetAtTime(0.68 + 0.44 * thr + speed * 0.003, t, 0.5); // engines spool up with the throttle
    propLp.frequency.setTargetAtTime(750 + 1350 * thr + speed * 8, t, 0.35);
  }
  if (plane) {
    const blade = 46 + 50 * thr + speed * 0.12; // blade-pass rate, Hz
    engines.forEach((e, i) => {
      const f = blade * (1 + 0.012 * i);
      e.buzz.frequency.setTargetAtTime(f, t, 0.4);
      e.pulser.frequency.setTargetAtTime(f, t, 0.4);
      e.buzzLp.frequency.setTargetAtTime(170 + 480 * thr, t, 0.4);
      e.rumbleBp.frequency.setTargetAtTime(105 + 210 * thr, t, 0.4);
    });
    turbine.frequency.setTargetAtTime(2100 + 850 * thr, t, 0.7);
  }
  const baseLfo = (isScout ? 19.5 : isHeavy ? 13.5 : 17) * (0.78 + 0.22 * idle);
  const baseLp = isScout ? 310 : isHeavy ? 200 : 250;
  const baseWhine = isScout ? 760 : isHeavy ? 960 : 1220;
  lfo.frequency.setTargetAtTime(baseLfo + lift * 2.5 + speed * 0.035, t, 0.3);
  rotorLp.frequency.setTargetAtTime(baseLp + lift * 115 + speed * 3, t, 0.3);
  whine.frequency.setTargetAtTime(baseWhine + lift * 85 + speed * 2, t, 0.5);
  windGain.gain.setTargetAtTime(Math.min(1, Math.max(0, speed - 15) / (plane ? 50 : 35)) ** 2 * (plane ? 0.065 : 0.04), t, 0.4);
  const w = state.water || 0;
  waterGain.gain.setTargetAtTime(w * 0.16, t, 0.15);
  waterBp.frequency.setTargetAtTime(520 + w * 380 + speed * 6, t, 0.2);
}

// Synthesized one-shot effects for actions and dispatch feedback.
export function sfx(type) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const tone = (f0, f1, dur, wave = 'triangle', vol = 0.12, delay = 0) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(f0, t + delay);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
    g.gain.setValueAtTime(vol, t + delay);
    g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
    o.connect(g).connect(master);
    o.start(t + delay);
    o.stop(t + delay + dur + 0.02);
  };
  if (type === 'hook') { tone(180, 320, 0.09, 'square', 0.1); tone(520, 680, 0.08, 'triangle', 0.12, 0.05); }
  else if (type === 'release') { tone(420, 190, 0.11, 'triangle', 0.12); }
  else if (type === 'swap') { tone(360, 480, 0.06, 'sine', 0.08); }
  else if (type === 'dump') {
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise; bp.type = 'bandpass'; bp.frequency.setValueAtTime(520, t); bp.frequency.exponentialRampToValueAtTime(220, t + 0.45);
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(bp).connect(g).connect(master); src.start(t, Math.random()); src.stop(t + 0.5);
  } else if (type === 'accept') { tone(587, 587, 0.07, 'sine', 0.1); tone(880, 880, 0.12, 'sine', 0.12, 0.08); }
  else if (type === 'done') { tone(523, 523, 0.09, 'triangle', 0.14); tone(659, 659, 0.09, 'triangle', 0.14, 0.08); tone(784, 1046, 0.22, 'triangle', 0.16, 0.16); }
}

// Impact thump, strength 0..1.
export function thud(v) {
  if (!ctx) return;
  const t = ctx.currentTime, src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noise;
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  g.gain.setValueAtTime(v * 1.2, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  src.connect(lp).connect(g).connect(master);
  src.start(t, Math.random());
  src.stop(t + 0.45);
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
}
