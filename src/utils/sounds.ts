const ctx = typeof AudioContext !== "undefined"
  ? new AudioContext()
  : typeof (window as any).webkitAudioContext !== "undefined"
    ? new (window as any).webkitAudioContext()
    : null;

function makeNoiseBuffer(duration: number) {
  if (!ctx) return null;
  const len = ctx.sampleRate * duration;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function playDoneSound(muted = false) {
  if (muted) return;
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();

  const now = ctx.currentTime;

  // soft pop tone
  const pop = ctx.createOscillator();
  const popGain = ctx.createGain();
  pop.type = "sine";
  pop.frequency.setValueAtTime(320, now);
  pop.frequency.exponentialRampToValueAtTime(120, now + 0.08);
  popGain.gain.setValueAtTime(0.18, now);
  popGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  pop.connect(popGain).connect(ctx.destination);
  pop.start(now);
  pop.stop(now + 0.12);

  // fizz bubbles - 3 quick filtered noise bursts
  const noise = makeNoiseBuffer(0.3);
  if (!noise) return;
  for (let i = 0; i < 3; i++) {
    const t = now + 0.03 + i * 0.04;
    const src = ctx.createBufferSource();
    src.buffer = noise;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2800 + i * 800;
    bp.Q.value = 1.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.08);
  }

  // soft rising bubble
  const bubble = ctx.createOscillator();
  const bGain = ctx.createGain();
  bubble.type = "sine";
  bubble.frequency.setValueAtTime(600, now + 0.08);
  bubble.frequency.exponentialRampToValueAtTime(900, now + 0.2);
  bGain.gain.setValueAtTime(0.08, now + 0.08);
  bGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  bubble.connect(bGain).connect(ctx.destination);
  bubble.start(now + 0.08);
  bubble.stop(now + 0.25);
}

export function playSendSound(muted = false) {
  if (muted) return;
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);
  gain.gain.setValueAtTime(0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}
