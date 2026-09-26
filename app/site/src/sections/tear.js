// The signature move in the hero: pull the 3D paper up past the tear bar and it separates along the
// perforation, flies off, and lands on the desk as a receipt PNG. DOM printouts torn anywhere on the page
// make the 3D paper tear too (react()). The stage does the geometry (stage.tearBegin / setTear / tearEnd).
import { gsap } from 'gsap';

export function createTear({ cue, dock, reduced, mobile, sound, stage, render, job, paperLines, inHero, receipt, receiptName, onTorn, floorY }) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const T = { p: 0, fly: 0, side: 1 };
  let drag = null, busy = false, prev = null, lblH = null;
  addEventListener('resize', () => { lblH = null; });
  function measureTab() { // heights of the stacked (three-line) and tight (two-line) tab
    const lbl = cue.querySelector('.lbl'); const had = cue.classList.contains('tight');
    cue.classList.remove('tight'); const tall = lbl.offsetHeight;
    cue.classList.add('tight'); const tightH = lbl.offsetHeight;
    cue.classList.toggle('tight', had);
    return { tall, tight: tightH };
  }
  const apply = () => { stage()?.setTear(T); render(); };

  function begin(side = 1) {
    const st = stage(); if (!st) return null;
    prev = paperLines();
    // form feed to the tear bar: the whole job clears the bail before it separates
    st.setLines([...prev, ...Array.from({ length: 6 }, () => ({ t: '' }))].slice(-52));
    st.tearBegin();
    const at = new Date();
    st.setLines([{ t: '' }, { t: `# torn off ${at.toISOString().slice(11, 16)}Z. the next job prints here.`, c: 'faded' }]);
    Object.assign(T, { p: 0, fly: 0, side }); apply();
    return at;
  }
  function cancel() {
    const st = stage(); if (!st) return;
    busy = true;
    gsap.to(T, { p: 0, duration: reduced ? 0 : 0.45, ease: 'elastic.out(1, 0.5)', onUpdate: apply,
      onComplete: () => { st.tearEnd(); st.setLines(prev); render(); busy = false; place(); } });
  }
  function finish(at, { withReceipt = true } = {}) {
    const st = stage(); const j = job();
    onTorn(at);
    sound.tear(1); navigator.vibrate?.(12);
    busy = true; cue.hidden = true;
    gsap.to(T, { p: 1, fly: 1, duration: reduced ? 0 : 0.95, ease: 'power2.in', onUpdate: apply,
      onComplete: () => { st.tearEnd(); render(); busy = false; place(); } });
    if (withReceipt && j) showReceipt(j, at);
  }

  // ------------------------------------------------------------ the receipt lands on the desk
  const img = dock.querySelector('img'); const note = dock.querySelector('.fine');
  let cur = null;
  async function showReceipt(j, at) {
    const cv = await receipt(j, at);
    cur = { cv, j, at };
    img.src = cv.toDataURL('image/png');
    img.alt = `receipt: $ payblame ${j.q}, torn ${at.toISOString().slice(0, 16)}Z`;
    note.textContent = `torn ${at.toISOString().slice(11, 19)}Z / listed != involved`;
    dock.hidden = false;
    if (reduced) gsap.set(dock, { rotation: -1.5, opacity: 1 });
    else gsap.fromTo(dock, { y: -90, rotation: 4, opacity: 0 }, { y: 0, rotation: -1.5, opacity: 1, duration: 0.6, ease: 'expo.out', delay: 0.3 });
  }
  const flash = (b, t, back) => { b.textContent = t; setTimeout(() => { b.textContent = back; }, 1200); };
  dock.querySelector('.k-save').addEventListener('click', (e) => {
    if (!cur) return; const b = e.currentTarget;
    cur.cv.toBlob((blob) => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = receiptName(cur.j.q, cur.at);
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      flash(b, 'saved', 'save png');
    }, 'image/png');
  });
  dock.querySelector('.k-copy').addEventListener('click', async (e) => {
    if (!cur) return; const b = e.currentTarget;
    try { await navigator.clipboard.writeText(cur.j.lines.map((l) => l.t).join('\n')); flash(b, 'copied', 'copy text'); } catch { flash(b, 'copy blocked', 'copy text'); }
  });
  dock.querySelector('.k-close').addEventListener('click', () => {
    if (reduced) { dock.hidden = true; return; }
    gsap.to(dock, { y: 40, opacity: 0, duration: 0.25, ease: 'power2.in', onComplete: () => { dock.hidden = true; } });
  });

  // ------------------------------------------------------------ the cue: a perforation drawn over the 3D tear bar
  cue.addEventListener('pointerdown', (e) => {
    if (busy || drag || !job() || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    const r = cue.getBoundingClientRect();
    const at = begin(e.clientX < r.left + r.width / 2 ? 1 : -1); if (!at) return;
    drag = { y: e.clientY, x: e.clientX, id: e.pointerId, at, moved: false };
    cue.setPointerCapture?.(e.pointerId);
    cue.classList.add('dragging');
  });
  cue.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY, dx = e.clientX - drag.x;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    T.p = clamp(Math.max(0, dy) / (mobile ? 90 : 130), 0, 1); apply();
    cue.style.setProperty('--p', T.p.toFixed(3));
    if (T.p >= 1) { const at = drag.at; end(); finish(at); }
  });
  function end() {
    if (!drag) return;
    try { cue.releasePointerCapture?.(drag.id); } catch { /* released */ }
    drag = null; cue.classList.remove('dragging'); cue.style.setProperty('--p', 0);
  }
  cue.addEventListener('pointerup', () => { if (!drag) return; const d = drag; end(); if (d.moved) cancel(); else finish(d.at); });
  cue.addEventListener('pointercancel', () => { if (!drag) return; end(); cancel(); });
  cue.addEventListener('click', (e) => { if (e.detail !== 0 || busy || !job()) return; const at = begin(1); if (at) finish(at); }); // Enter / Space

  function place() {
    const st = stage();
    const show = !!drag || (!!st && !!job() && inHero() && !busy);
    if (cue.hidden === show) cue.hidden = !show;
    if (!show || !st) return;
    const a = st.toScreen(st.tearAnchors.left), b = st.toScreen(st.tearAnchors.right);
    const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    cue.style.width = `${Math.round(len)}px`;
    cue.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px) rotate(${ang.toFixed(4)}rad) translateY(-50%)`;
    // the pull tab hangs below the last printed row (the `below` anchor on the ribbon, in the cue's rotated frame),
    // tied to the perforation by a dashed tether down the text margin. The tab is set parallel to the printed rows
    // (they converge differently from the tear bar under a high mobile camera) and its top edge is held a few px
    // under the foot of the last row across its whole width, so no printed line sits under it on any viewport.
    if (st.tearAnchors.below) {
      const co = Math.cos(-ang), si = Math.sin(-ang);
      const loc = (p) => { const vx = p.x - a.x, vy = p.y - a.y; return { x: vx * co - vy * si, y: vx * si + vy * co }; };
      const c = loc(st.toScreen(st.tearAnchors.below));
      // mobile: the platen is foreshortened under the high camera, so the tab also clears the whole ribbon band
      const lx = c.x; let ly = Math.max(8, c.y + (mobile ? 12 : 0)), tilt = 0;
      if (st.tearAnchors.rowL && st.tearAnchors.rowR) {
        const L = loc(st.toScreen(st.tearAnchors.rowL)), R = loc(st.toScreen(st.tearAnchors.rowR));
        const k = (R.y - L.y) / ((R.x - L.x) || 1);
        tilt = Math.atan(k);
        const foot = L.y + (lx - L.x) * k; // the foot of the last row, under the tab's left edge
        ly = Math.max(ly, foot + (mobile ? 20 : 6) - 2); // the CSS sets the tab 2 px under --ly
        // short phones: the wordmark rides up over the printer. Lift the tab to end above it, but never above
        // the foot of the last row (the rows stay readable; the tab may then sit on the ribbon)
        // (the tab first drops from three short lines to two)
        const floor = floorY?.();
        let tight = false;
        if (floor != null && Number.isFinite(floor)) {
          const h = lblH || (lblH = measureTab());
          const room = (hh) => (floor - 6 - a.y) / Math.cos(ang) - hh - 2; // tab top (cue frame) ending 6 px above the wordmark
          if (ly > room(h.tall)) { tight = true; ly = Math.max(foot + 3, Math.min(ly, room(h.tight))); }
        }
        if (cue.classList.contains('tight') !== tight) cue.classList.toggle('tight', tight);
      }
      cue.style.setProperty('--lx', `${lx.toFixed(1)}px`); cue.style.setProperty('--ly', `${ly.toFixed(1)}px`);
      cue.style.setProperty('--tl', `${Math.hypot(lx, ly).toFixed(1)}px`); cue.style.setProperty('--ta', `${Math.atan2(ly, lx).toFixed(4)}rad`);
      cue.style.setProperty('--tilt', `${tilt.toFixed(4)}rad`);
    }
  }
  // a DOM printout was torn: the 3D paper separates too (no second receipt)
  function react() {
    const st = stage(); if (!st || busy || drag || st.tearing) return;
    const at = begin(1); if (at) finish(at, { withReceipt: false });
  }
  return { place, react };
}
