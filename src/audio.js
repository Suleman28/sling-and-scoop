// All sound is synthesized: chopped noise for the rotor, a turbine whine, and airflow that rises with speed.
let ctx, master, noise, lfo, rotorLp, whine, windGain, muted = false;

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
  const chop = ctx.createGain();
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
  const wg = ctx.createGain();
  wg.gain.value = 0.012;
  whine.connect(wg).connect(master);
  whine.start();

  const rush = ctx.createBiquadFilter();
  rush.type = 'bandpass';
  rush.frequency.value = 420;
  rush.Q.value = 0.7;
  windGain = ctx.createGain();
  windGain.gain.value = 0;
  noiseSource().connect(rush).connect(windGain).connect(master);
}

export function updateAudio(lift, speed) {
  if (!ctx) return;
  const t = ctx.currentTime;
  lfo.frequency.setTargetAtTime(17 + lift * 2.5 + speed * 0.03, t, 0.3);
  rotorLp.frequency.setTargetAtTime(260 + lift * 120 + speed * 3, t, 0.3);
  whine.frequency.setTargetAtTime(1250 + lift * 90 + speed * 2, t, 0.5);
  windGain.gain.setTargetAtTime(Math.min(1, Math.max(0, speed - 15) / 35) ** 2 * 0.04, t, 0.5); // gentle rush, only at speed
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
