// Sound is synthesized (rotor chop, turbine whine, airflow) except the plane's engines: a recorded twin-prop loop
// ("airplane prop loop" by AntumDeluge from a recording by jakobthiesen, CC BY 3.0, see README), pitched by throttle.
// If the file can't load, a synthesized twin-prop voice stands in.
let propLoop = null, propRate = null;
let ctx, master, noise, lfo, rotorLp, chop, whine, whineGain, windGain, engines, planeBus, turbine, muted = false;

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

  // Rotor: low-passed noise whose gain is swept by a sawtooth at blade-pass rate ("whop-whop").
  rotorLp = ctx.createBiquadFilter();
  rotorLp.type = 'lowpass';
  rotorLp.frequency.value = 280;
  chop = ctx.createGain();
  chop.gain.value = 0.35;
  lfo = ctx.createOscillator();
  lfo.type = 'sawtooth';
  lfo.frequency.value = 17;
  const depth = ctx.createGain();
  depth.gain.value = 0.3;
  lfo.connect(depth).connect(chop.gain);
  lfo.start();
  noiseSource().connect(rotorLp).connect(chop).connect(master);

  whine = ctx.createOscillator();
  whine.type = 'triangle';
  whine.frequency.value = 1250;
  whineGain = ctx.createGain();
  whineGain.gain.value = 0.012;
  whine.connect(whineGain).connect(master);

  whine.start();

  // Plane: two engines, each a buzzy blade-pass tone (low-passed square) plus combustion rumble (band-passed noise
  // pulsed at the blade rate). The engines run ~1% apart, so they beat like unsynchronised props. A faint turbine on top.
  planeBus = ctx.createGain();
  planeBus.gain.value = 0;
  planeBus.connect(master);
  engines = [0, 1].map(() => {
    const buzz = ctx.createOscillator(), buzzLp = ctx.createBiquadFilter(), buzzGain = ctx.createGain();
    buzz.type = 'square';
    buzzLp.type = 'lowpass';
    buzzLp.Q.value = 1.5;
    buzzGain.gain.value = 0.35;
    buzz.connect(buzzLp).connect(buzzGain).connect(planeBus);
    buzz.start();
    const rumbleBp = ctx.createBiquadFilter(), pulse = ctx.createGain(), pulser = ctx.createOscillator(), depth = ctx.createGain();
    rumbleBp.type = 'bandpass';
    rumbleBp.Q.value = 0.8;
    pulse.gain.value = 0.6;
    depth.gain.value = 0.55;
    pulser.connect(depth).connect(pulse.gain);
    pulser.start();
    noiseSource().connect(rumbleBp).connect(pulse).connect(planeBus);
    return { buzz, buzzLp, rumbleBp, pulser };
  });
  turbine = ctx.createOscillator();
  turbine.type = 'sine';
  const turbineGain = ctx.createGain();
  turbineGain.gain.value = 0.025;
  turbine.connect(turbineGain).connect(planeBus);
  turbine.start();

  fetch(`${import.meta.env.BASE_URL}sfx/airplane_prop.wav`)
    .then((r) => r.arrayBuffer())
    .then((b) => ctx.decodeAudioData(b))
    .then((buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      propLoop = ctx.createGain();
      propLoop.gain.value = 0;
      src.connect(propLoop).connect(master);
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
}

// plane: switch from the rotor voice to the prop drone (lift is then the throttle mapped to -1..1).
export function updateAudio(lift, speed, plane = false) {
  if (!ctx) return;
  const t = ctx.currentTime;
  chop.gain.setTargetAtTime(plane ? 0 : 0.35, t, 0.2);
  whineGain.gain.setTargetAtTime(plane ? 0 : 0.012, t, 0.2);
  const thr = (lift + 1) / 2;
  planeBus.gain.setTargetAtTime(plane && !propLoop ? 0.12 + 0.1 * thr : 0, t, 0.2);
  if (propLoop) {
    propLoop.gain.setTargetAtTime(plane ? 0.45 + 0.55 * thr : 0, t, 0.25);
    propRate.setTargetAtTime(0.7 + 0.45 * thr + speed * 0.003, t, 0.6); // engines spool up with the throttle
  }
  if (plane && !propLoop) {
    const blade = 46 + 50 * thr + speed * 0.12; // blade-pass rate, Hz
    engines.forEach((e, i) => {
      const f = blade * (1 + 0.011 * i);
      e.buzz.frequency.setTargetAtTime(f, t, 0.5);
      e.pulser.frequency.setTargetAtTime(f, t, 0.5);
      e.buzzLp.frequency.setTargetAtTime(180 + 520 * thr, t, 0.5);
      e.rumbleBp.frequency.setTargetAtTime(110 + 220 * thr, t, 0.5);
    });
    turbine.frequency.setTargetAtTime(2400 + 900 * thr, t, 0.8);
  }
  lfo.frequency.setTargetAtTime(17 + lift * 2.5 + speed * 0.03, t, 0.3);
  rotorLp.frequency.setTargetAtTime(260 + lift * 120 + speed * 3, t, 0.3);
  whine.frequency.setTargetAtTime(1250 + lift * 90 + speed * 2, t, 0.5);
  windGain.gain.setTargetAtTime(Math.min(1, Math.max(0, speed - 15) / (plane ? 50 : 35)) ** 2 * (plane ? 0.07 : 0.04), t, 0.5); // gentle rush, only at speed
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
