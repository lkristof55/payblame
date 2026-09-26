// The scroll story mapped onto the PB-10: one continuous function from scroll position to
// { camera shot, explode, scrim, orbit }, with keyframes measured from the section layout.
// It also runs the carriage (idle shuttle, busy shuttle, diff sweep), the pin strikes and the callouts.
import { SHOTS, mixShot, V } from '../scene/stage.js';
import { SLOTS } from '../scene/printer.js';

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const carriageEase = (t) => { // cubic-bezier(0.45, 0, 0.2, 1), approximated
  return t < 0.5 ? 2.2 * t * t * (1 - 0.2 * t) : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

export function createDirector(st, { mobile, reduced, callouts }) {
  const base = mobile ? -0.4 : -0.9;
  const shots = {};
  let K = [];
  let windows = [];
  let vh = innerHeight;
  const state = { y: 0, ys: 0, explode: 0, scrim: 0, carriage: base, busy: false, diff: null, diffP: 0, dirty: true };
  const carriageAnim = { from: base, to: base, t0: 0, dur: 0, lastStrike: 0 };
  let nextIdle = performance.now() + 1400;
  let idleDir = 1;

  // ------------------------------------------------------------ shots for this viewport
  function mobilize(s, k = 1.6, sy = -0.26) {
    const t = s.target; const p = s.pos.map((v, i) => t[i] + (v - t[i]) * k);
    return { ...s, pos: p, shift: 0, shiftY: sy, fov: s.fov };
  }
  function headShot(explode, off, tOff, fov) {
    const hp = st.headWorld(explode, state.explode);
    return { pos: [hp.x + off[0], hp.y + off[1], hp.z + off[2]], target: [hp.x + tOff[0], hp.y + tOff[1], hp.z + tOff[2]], fov, shift: 0, shiftY: 0 };
  }
  // the print line region (paper around the line, head, rails) for the diff close-up
  const DIFF_PTS = [[-4.8, -1.2, 2.3], [4.8, -1.2, 2.3], [-4.8, 2.6, 0.3], [4.8, 2.6, 0.3]].map(V);
  const SCRIM = 0.96;
  function measure() {
    vh = innerHeight;
    st.P.setCarriage(base);
    if (mobile) {
      // every mobile shot centres the object at 26% of the viewport: the middle of a beat's 52vh window
      shots.hero = st.fit(SHOTS.heroMobile, [-0.14, 1.14, 0.04, 0.48]);
      shots.diff = st.fit(SHOTS.diff, [-0.1, 1.1, 0.08, 0.44], DIFF_PTS);
      shots.pinout = mobilize(headShot(0.24, [-0.9, 0.5, 3.4], [0, 0, 0], 24), 1.5, -0.24);
      shots.ring = mobilize(headShot(1, [-1.9, 1.5, 5.4], [-0.1, 0.35, -0.5], 30), 1.9, -0.24);
      shots.run = st.fit(SHOTS.heroMobile, [0.0, 1.0, 0.06, 0.46]);
      shots.measured = st.fit(SHOTS.measured, [0.04, 0.96, 0.06, 0.46]);
      shots.repo = st.fit(SHOTS.repo, [0.0, 1.0, 0.06, 0.46]);
    } else {
      shots.hero = st.fit(SHOTS.hero, [0.52, 1.24, 0.09, 1.12]);
      shots.diff = st.fit(SHOTS.diff, [0.47, 1.08, 0.2, 0.9], DIFF_PTS);
      const pin = headShot(0.24, [-0.9, 0.5, 3.4], [0, 0, 0], 24); pin.shift = -0.2;
      shots.pinout = pin;
      const ring = headShot(1, [-1.9, 1.5, 5.4], [-0.1, 0.35, -0.5], 30); ring.shift = -0.2;
      shots.ring = ring;
      shots.run = st.fit(SHOTS.hero, [0.55, 1.2, 0.12, 1.05]);
      shots.measured = st.fit(SHOTS.measured, [0.62, 1.0, 0.14, 0.54]);
      shots.repo = st.fit(SHOTS.repo, [0.6, 1.04, 0.14, 0.84]);
    }
    const sec = (id) => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); const top = r.top + scrollY; return { top, h: r.height, end: top + Math.max(0, r.height - vh) }; };
    const d = sec('how'), p = sec('pinout'), r = sec('ring'), run = sec('run'), code = sec('code'), repo = sec('repo');
    const k = (y, shot, explode = 0, scrim = 0, orbit = 0) => ({ y, shot, explode, scrim, orbit });
    if (mobile) {
      // each shot is reached as its window takes over the screen, and held while the window is up
      const w0 = vh * 0.72, w1 = vh * 0.5;
      K = [
        k(0, 'hero'),
        k(d.top - w0, 'diff'), k(d.top + w1, 'diff'),
        k(p.top - w0, 'pinout', 0.24, SCRIM), k(p.top + w1, 'pinout', 0.24, SCRIM),
        k(r.top - w0, 'ring', 1, SCRIM, 0), k(r.top + w1, 'ring', 1, SCRIM, 18),
        k(run.top - w0, 'run'), k(run.top + w1, 'run'),
        k(code.top - w0, 'measured'), k(code.top + w1, 'measured'),
        k(repo.top - w0, 'repo'),
      ];
      windows = [{ top: 0, h: vh * 0.48 }, ...[d, p, r, run, code, repo].map((x) => ({ top: x.top, h: vh * 0.52 }))];
    } else {
      K = [
        k(0, 'hero'),
        k(d.top, 'diff'), k(d.end, 'diff'),
        k(p.top + (p.end - p.top) * 0.35, 'pinout', 0.24, SCRIM), k(p.end, 'pinout', 0.24, SCRIM),
        k(r.top + (r.end - r.top) * 0.45, 'ring', 1, SCRIM, 6), k(r.end, 'ring', 1, SCRIM, 18),
        k(run.top, 'run'), k(run.top + Math.max(vh * 0.3, run.h - vh * 1.1), 'run'),
        k(code.top + vh * 0.1, 'measured'), k(code.top + code.h - vh * 0.8, 'measured'),
        k(repo.top, 'repo'),
      ];
    }
    state.sec = { d, p, r, run, code, repo };
    state.dirty = true;
  }

  function sample(y) {
    let i = 0; while (i < K.length - 1 && K[i + 1].y <= y) i++;
    const a = K[i], b = K[Math.min(K.length - 1, i + 1)];
    const t = a === b || b.y <= a.y ? 0 : smooth(clamp01((y - a.y) / (b.y - a.y)));
    const shot = mixShot(shots[a.shot], shots[b.shot], t);
    const orbit = a.orbit + (b.orbit - a.orbit) * t;
    if (orbit) { // orbit the camera around the target's vertical axis
      const ang = orbit * Math.PI / 180; const T = shot.target; const dx = shot.pos[0] - T[0], dz = shot.pos[2] - T[2];
      shot.pos = [T[0] + dx * Math.cos(ang) - dz * Math.sin(ang), shot.pos[1], T[2] + dx * Math.sin(ang) + dz * Math.cos(ang)];
    }
    return { shot, explode: a.explode + (b.explode - a.explode) * t, scrim: a.scrim + (b.scrim - a.scrim) * t };
  }

  // ------------------------------------------------------------ carriage
  function moveCarriage(to, now, speed = 12) {
    const from = st.P.carriage.position.x;
    carriageAnim.from = from; carriageAnim.to = to; carriageAnim.t0 = now; carriageAnim.dur = Math.max(60, Math.abs(to - from) / speed * 1000);
  }
  function randomMask(p = 0.5) { return SLOTS.map(() => Math.random() < p); }

  // ------------------------------------------------------------ callouts on the pins and solenoids
  const tipEls = [], solEls = [];
  if (callouts) {
    for (let i = 0; i < 10; i++) {
      const a = document.createElement('div'); a.className = 'co lead tip'; a.textContent = `slot ${i}  +${SLOTS[i].offset}`; a.style.transitionDelay = `${i * 40}ms`; callouts.appendChild(a); tipEls.push(a);
      const b = document.createElement('div'); b.className = 'co sol'; b.textContent = `+${SLOTS[i].offset}`; b.style.transitionDelay = `${i * 40}ms`; callouts.appendChild(b); solEls.push(b);
    }
  }
  let tipsOn = false, solsOn = false;
  function placeCallouts() {
    const e = state.explode;
    const wantTips = e > 0.2 && e < 0.3 && state.scrim > 0.8;
    const wantSols = e > 0.9;
    if (wantTips !== tipsOn) { tipsOn = wantTips; tipEls.forEach((el) => el.classList.toggle('on', wantTips)); }
    if (wantSols !== solsOn) { solsOn = wantSols; solEls.forEach((el) => el.classList.toggle('on', wantSols)); }
    if (tipsOn || e > 0.15) {
      const gap = mobile ? 30 : 64;
      tipEls.forEach((el, i) => {
        const s = st.toScreen(st.P.anchors.tip[i]);
        el.style.transform = `translate(${Math.round(s.x + gap)}px, ${Math.round(s.y - 10)}px)`;
      });
    }
    if (solsOn || e > 0.8) {
      solEls.forEach((el, i) => {
        const s = st.toScreen(st.P.anchors.solenoid[i]);
        el.style.transform = `translate(${Math.round(s.x - 22)}px, ${Math.round(s.y - 11)}px)`;
      });
    }
  }

  // ------------------------------------------------------------ per frame
  let last = performance.now();
  function frame(now, scrollY) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    state.y = scrollY;
    const prev = state.ys;
    state.ys = reduced ? scrollY : state.ys + (scrollY - state.ys) * (1 - Math.exp(-dt / 0.12));
    if (Math.abs(state.ys - scrollY) < 0.5) state.ys = scrollY;
    const moved = Math.abs(prev - state.ys) > 0.01 || state.dirty;
    let changed = moved;
    const s = sample(state.ys);
    if (moved) {
      if (mobile && windows.length) {
        // the object rides in the window of the beat that shows most of it (a 3D figure in the page flow)
        let best = windows[0], bv = -1;
        for (const w of windows) { const a = Math.max(0, w.top - state.ys), b = Math.min(vh, w.top - state.ys + w.h); const v = (b - a) / w.h; if (v > bv + 1e-3) { bv = v; best = w; } }
        s.shot.shiftY += (best.top - state.ys) / vh;
      }
      st.apply(s.shot);
      if (Math.abs(s.explode - state.explode) > 1e-4) { state.explode = s.explode; st.P.setExplode(s.explode); }
      if (Math.abs(s.scrim - state.scrim) > 1e-4) { state.scrim = s.scrim; st.P.setScrim(s.scrim); }
    }
    // carriage: diff sweep > busy shuttle > idle shuttle in the hero > rest at base
    const x = st.P.carriage.position.x;
    let want = null;
    const inDiff = state.sec && state.ys > state.sec.d.top - vh * 0.2 && state.ys < state.sec.d.end + vh * 0.2;
    if (!reduced && inDiff && state.diffSweep != null) want = state.diffSweep;
    if (want != null) {
      if (Math.abs(want - x) > 1e-3) { st.P.carriage.position.x = x + (want - x) * (1 - Math.exp(-dt / 0.06)); changed = true; }
      carriageAnim.dur = 0;
    } else if (carriageAnim.dur) {
      const t = clamp01((now - carriageAnim.t0) / carriageAnim.dur);
      st.P.carriage.position.x = carriageAnim.from + (carriageAnim.to - carriageAnim.from) * carriageEase(t);
      if (now - carriageAnim.lastStrike > 24 && t < 1) { st.P.strike(randomMask(0.45)); carriageAnim.lastStrike = now; }
      changed = true;
      if (t >= 1) carriageAnim.dur = 0;
    } else if (!reduced) {
      if (state.busy) { moveCarriage(x > 0 ? -3 : 3, now); }
      else if (state.ys < vh * 0.6 && state.explode < 0.01 && now > nextIdle && !document.hidden) {
        moveCarriage(base + 0.6 * idleDir, now); idleDir *= -1; nextIdle = now + 3300;
      } else if (state.ys >= vh * 0.6 && Math.abs(x - base) > 0.01 && state.explode < 0.01) moveCarriage(base, now);
    }
    // the head must sit at base before it lifts out (head-relative shots assume it)
    if (state.explode > 0.001 && Math.abs(st.P.carriage.position.x - base) > 1e-3 && want == null) { st.P.carriage.position.x = base; carriageAnim.dur = 0; changed = true; }
    // pin springs
    st.P.update(dt);
    if (state.striking > now) changed = true;
    if (changed || state.dirty) placeCallouts();
    state.dirty = false;
    return changed;
  }

  return {
    state, shots, measure, frame, moveCarriage,
    strike(mask) { st.P.strike(mask); state.striking = performance.now() + 140; },
    busy(on) { state.busy = on; if (!on) moveCarriage(base, performance.now()); },
    setDiffSweep(x) { state.diffSweep = x; },
    sample,
    get base() { return base; },
  };
}
