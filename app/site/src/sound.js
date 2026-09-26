// Synthesized printer sounds (WebAudio, no files). Off by default; the choice lives in localStorage.
let ctx = null, noise = null;
let on = false;
try { on = localStorage.getItem('payblame:sound') === 'on'; } catch { /* private mode */ }

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export const sound = {
  get on() { return on; },
  set(v) { on = v; try { localStorage.setItem('payblame:sound', v ? 'on' : 'off'); } catch { /* ignore */ } if (v) ac(); },
  // one printed line: 60-100 bursts of 9 ms bandpassed noise, 1.4 ms apart (the dot-matrix screech)
  strike(chars = 60) {
    if (!on) return; const c = ac(); const t0 = c.currentTime + 0.01;
    const n = Math.max(20, Math.min(100, Math.round(chars * 1.1)));
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 6;
    const g = c.createGain(); g.gain.value = 0.08; bp.connect(g).connect(c.destination);
    for (let i = 0; i < n; i++) {
      const s = c.createBufferSource(); s.buffer = noise;
      const e = c.createGain(); e.gain.setValueAtTime(0, t0 + i * 0.0014); e.gain.linearRampToValueAtTime(1, t0 + i * 0.0014 + 0.001); e.gain.linearRampToValueAtTime(0, t0 + i * 0.0014 + 0.009);
      s.connect(e).connect(bp); s.start(t0 + i * 0.0014, Math.random() * 0.3, 0.012);
    }
  },
  feed() {
    if (!on) return; const c = ac(); const t = c.currentTime;
    const o = c.createOscillator(); const g = c.createGain(); o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.04);
    g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.06);
  },
  tear(vel = 1) {
    if (!on) return; const c = ac(); const t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = noise; s.playbackRate.value = Math.max(0.6, Math.min(1.6, vel));
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(4000, t + 0.28);
    const g = c.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    s.connect(lp).connect(g).connect(c.destination); s.start(t, 0, 0.3);
  },
};
