// A DOM printout on greenbar fanfold, with the signature move: tear-off along git's scissors line.
//
//   const po = createPrintout(figureEl, { reduced, mobile, onPrintLine })
//   await po.print(lines)   lines: [{ t, cls?, html? }] appended with the print reveal (45 ms stagger)
//   po.clear(); po.status(t) (a faded status line; returns a remover); po.setQuery(q)
import { gsap } from 'gsap';
import { sound } from '../sound.js';
import { receiptBlob, receiptName } from './receipt.js';

const SCISSORS = '-- >8 ' + '-'.repeat(48) + ' tear here -- >8 --';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function lineHTML(l) {
  if (l.html) return l.html;
  let h = esc(l.t);
  if (l.mutable) h = h.replace('MUTABLE', '<span class="r">MUTABLE</span>');
  return h || '&nbsp;';
}

export function createPrintout(fig, { reduced = false, mobile = false, onPrintLine, onExpand, wrap = false, label = 'printout' } = {}) {
  fig.classList.add('printout');
  fig.classList.toggle('wrap', wrap);
  fig.innerHTML = `<div class="sheet"><div class="lines" role="log" aria-live="polite" aria-label="${esc(label)}"></div><span class="ovf" aria-hidden="true">&gt;&gt;</span></div>
    <button class="perf" type="button" aria-label="tear off this printout as an image"><span class="cut" aria-hidden="true"></span><span class="scis" aria-hidden="true">${SCISSORS}</span></button>
    <div class="stub" aria-hidden="true"></div>`;
  const dock = document.createElement('div'); dock.className = 'dock'; fig.after(dock);
  let sheet = fig.querySelector('.sheet');
  let box = sheet.querySelector('.lines');
  const perf = fig.querySelector('.perf');
  const cut = perf.querySelector('.cut');
  let model = []; // printed lines, for the receipt
  let query = '';
  let job = 0;

  function makeLine(l, delay = 0) {
    const d = document.createElement('div');
    d.className = `ln ${l.cls || ''}`; d.innerHTML = lineHTML(l);
    if (l.n) d.dataset.n = l.n;
    if (l.step != null) d.dataset.step = l.step;
    if (!reduced) { d.style.animationDelay = `${delay}ms`; d.classList.add('strike'); }
    if (l.more) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'key more'; b.textContent = `print all ${l.more.length}`;
      b.addEventListener('click', () => expand(d, l));
      d.append(' ', b);
    }
    return d;
  }
  function addLine(l, delay = 0) {
    const d = makeLine(l, delay);
    box.appendChild(d); model.push(l);
    return d;
  }
  // the held-back rows print in place of the print-all line
  function expand(d, l) {
    const idx = model.indexOf(l);
    const frag = document.createDocumentFragment();
    l.more.forEach((m, i) => frag.appendChild(makeLine(m, reduced ? 0 : Math.min(i, 40) * 12)));
    d.replaceWith(frag);
    if (idx >= 0) model.splice(idx, 1, ...l.more);
    if (!reduced) sound.feed();
    checkOverflow();
    onExpand?.(model.slice());
  }
  // rows that must stay on one line scroll sideways; the right edge says so
  function checkOverflow() {
    const over = box.scrollWidth > box.clientWidth + 26; // a greenbar band may bleed 24px into the margin
    fig.classList.toggle('overflows', over);
    fig.classList.toggle('at-end', !over || box.scrollLeft + box.clientWidth >= box.scrollWidth - 26);
  }
  box.addEventListener('scroll', checkOverflow, { passive: true });
  new ResizeObserver(checkOverflow).observe(box);
  const api = {
    get lines() { return model.slice(); },
    get sheet() { return sheet; },
    setQuery(q) { query = q; },
    clear() { job++; box.innerHTML = ''; model = []; },
    status(t) {
      const d = addLine({ t, cls: 'faded status' });
      return () => { const i = model.findIndex((m) => m.t === t && m.cls === 'faded status'); if (i >= 0) model.splice(i, 1); d.remove(); };
    },
    async print(lines, { stagger = 45 } = {}) {
      const my = job;
      lines.forEach((l, i) => {
        addLine(l, reduced ? 0 : i * stagger);
        if (onPrintLine && !reduced) setTimeout(() => { if (my === job) onPrintLine(l, i); }, i * stagger);
        else if (onPrintLine && reduced && i === lines.length - 1) onPrintLine(l, i);
      });
      checkOverflow();
      if (!reduced) await new Promise((ok) => setTimeout(ok, lines.length * stagger + 90));
      checkOverflow();
    },
    tear,
  };

  // ------------------------------------------------------------ the tear
  const threshold = mobile ? 96 : 120;
  let drag = null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function setCut(p, fromLeft) {
    cut.style.width = `${(p * 100).toFixed(1)}%`;
    cut.style.left = fromLeft ? '0' : 'auto'; cut.style.right = fromLeft ? 'auto' : '0';
    fig.classList.toggle('stress', p > 0);
  }
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest?.('button.more')) return;
    const r = sheet.getBoundingClientRect();
    const onPerf = perf.contains(e.target);
    const nearBottom = sheet.contains(e.target) && e.clientY > r.bottom - 48;
    if (!onPerf && !nearBottom) return;
    if (!model.length) return;
    if (reduced) { e.preventDefault(); tear(); return; }
    e.preventDefault();
    const pr = perf.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, fromLeft: e.clientX < pr.left + pr.width / 2, p: 0, t: performance.now(), v: 0, id: e.pointerId };
    fig.setPointerCapture?.(e.pointerId);
    fig.classList.add('dragging');
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    let dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (mobile) dx = 0;
    const dist = Math.hypot(dx, dy);
    const now = performance.now(); drag.v = dist / Math.max(1, now - drag.t);
    drag.p = clamp(dist / threshold, 0, 1);
    const rot = clamp(dx / 300 * (180 / Math.PI) * 0.25, -4, 4);
    gsap.set(sheet, { x: dx * 0.9, y: dy * 0.9, rotation: rot, transformOrigin: drag.fromLeft ? '100% 0%' : '0% 0%' });
    setCut(drag.p, drag.fromLeft);
    if (drag.p >= 1) { const v = drag.v; end(); tear(v); }
  }
  function end() {
    if (!drag) return;
    try { fig.releasePointerCapture?.(drag.id); } catch { /* released */ }
    fig.classList.remove('dragging');
    const done = drag.p >= 1; drag = null;
    if (!done) {
      gsap.to(sheet, { x: 0, y: 0, rotation: 0, duration: 0.52, ease: 'elastic.out(1, 0.5)' });
      gsap.to(cut, { width: '0%', duration: 0.3, ease: 'power2.out', onComplete: () => fig.classList.remove('stress') });
    }
  }
  fig.addEventListener('pointerdown', onDown);
  fig.addEventListener('pointermove', onMove);
  fig.addEventListener('pointerup', end);
  fig.addEventListener('pointercancel', end);
  perf.addEventListener('click', (e) => { if (e.detail === 0) tear(); }); // keyboard: Enter / Space

  function tear(vel = 1) {
    if (!model.length) return;
    sound.tear(vel); navigator.vibrate?.(12);
    const lines = model.slice(); const q = query; const at = new Date();
    const old = sheet;
    const from = old.getBoundingClientRect();
    // the torn strip becomes a receipt card on the desk, below the fresh perforation
    dock.innerHTML = '';
    const card = document.createElement('div'); card.className = 'receipt';
    const keys = document.createElement('div'); keys.className = 'rkeys';
    const canShare = mobile && !!navigator.canShare;
    keys.innerHTML = `<button class="key k-save" type="button">save png</button><button class="key k-copy" type="button">${canShare ? 'share' : 'copy text'}</button><span class="fine">torn ${at.toISOString().slice(11, 19)}Z / listed != involved</span>`;
    old.classList.add('torn');
    card.appendChild(old); card.appendChild(keys); dock.appendChild(card);
    gsap.set(old, { clearProps: 'transform' });
    // fresh sheet where the old one was
    sheet = document.createElement('div'); sheet.className = 'sheet fresh';
    sheet.innerHTML = `<div class="lines" role="log" aria-live="polite" aria-label="${esc(label)}"></div><span class="ovf" aria-hidden="true">&gt;&gt;</span>`;
    box = sheet.querySelector('.lines'); model = [];
    box.addEventListener('scroll', checkOverflow, { passive: true });
    fig.prepend(sheet);
    addLine({ t: `# torn off ${at.toISOString().slice(0, 19)}Z. the next job prints here.`, cls: 'faded' }, 0);
    model = [];
    cut.style.width = '0%'; fig.classList.remove('stress');
    const to = card.getBoundingClientRect();
    if (reduced) gsap.set(card, { rotation: -2, scale: 1.03 });
    else {
      gsap.fromTo(card, { x: from.left - to.left, y: from.top - to.top, rotation: 0, scale: 1 }, { x: 0, y: 0, rotation: -2, scale: 1.03, duration: 0.6, ease: 'expo.out' });
      gsap.fromTo(sheet, { y: -24 }, { y: 0, duration: 0.07, ease: 'power2.out' });
    }
    keys.querySelector('.k-save').addEventListener('click', async (e) => {
      const b = e.currentTarget; const blob = await receiptBlob({ lines, q, printedAt: at });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = receiptName(q, at); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      b.textContent = 'saved'; setTimeout(() => { b.textContent = 'save png'; }, 1200);
    });
    keys.querySelector('.k-copy').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (canShare) {
        const blob = await receiptBlob({ lines, q, printedAt: at });
        const file = new File([blob], receiptName(q, at), { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text: `$ payblame ${q}` }); } catch { /* cancelled */ } return; }
      }
      try { await navigator.clipboard.writeText(lines.map((l) => l.t).join('\n')); b.textContent = 'copied'; } catch { b.textContent = 'copy blocked'; }
      setTimeout(() => { b.textContent = canShare ? 'share' : 'copy text'; }, 1200);
    });
    fig.dispatchEvent(new CustomEvent('torn', { detail: { lines, q } }));
  }
  return api;
}
