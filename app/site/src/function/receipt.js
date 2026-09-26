// The receipt PNG: the torn strip redrawn on a canvas at 2x. Tractor holes on both strips, greenbar bands,
// torn top and bottom edges, the printout lines verbatim, and a footer with the query and print time.
const C = { paper: '#F4F5F0', greenbar: '#DCE8D6', ink: '#1F2124', ink2: '#6E7176', red: '#C22A1E', perf: '#C6CDC0' };

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// lines: [{ t, cls }] where cls in head | red | faded | minus | plus | tilde | prose | err
// a receipt is postable: the header and the top lines. Long printouts keep their first 22 lines,
// a count of what was cut, and the closing lines (timing, listed != involved).
export function receiptLines(lines, max = 26) {
  if (lines.length <= max) return lines;
  const tail = lines.slice(-3).filter((l) => (l.t || '').startsWith('#') || (l.t || '').startsWith('listed'));
  const head = lines.slice(0, max - tail.length - 1);
  return [...head, { t: `# ... ${lines.length - head.length - tail.length} more lines cut from this receipt`, cls: 'faded' }, ...tail];
}

export async function receiptCanvas({ lines: all, q, printedAt = new Date() }) {
  const lines = receiptLines(all);
  await document.fonts.load('600 16px "Bitcount Grid Single"').catch(() => {});
  await document.fonts.load('400 14px "Atkinson Hyperlegible Mono"').catch(() => {});
  const S = 2, LH = 24, strip = 48, pad = 24;
  const footer = `$ payblame ${q || ''}   printed ${printedAt.toISOString().slice(0, 16)}Z   listed != involved`;
  const m = document.createElement('canvas').getContext('2d');
  const fontFor = (l) => (l.cls === 'head' ? '600 16px "Bitcount Grid Single", monospace' : l.cls === 'prose' ? '400 14px "Atkinson Hyperlegible Next", sans-serif' : '400 14px "Atkinson Hyperlegible Mono", monospace');
  let tw = 0;
  for (const l of lines) { m.font = fontFor(l); tw = Math.max(tw, m.measureText(l.t).width); }
  m.font = '400 12px "Atkinson Hyperlegible Mono", monospace'; tw = Math.max(tw, m.measureText(footer).width);
  const W = Math.ceil(Math.min(1400, Math.max(560, tw + strip * 2 + pad * 2)));
  const top = 28, body = lines.length * LH, H = Math.ceil(top + pad + body + pad + LH + pad + 20);
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const g = cv.getContext('2d'); g.scale(S, S);
  // torn edges: the perforation ties (4.5 cut / 2.5 tie) with a little random jag, seeded by the query
  let seed = [...(q || 'payblame')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 7) || 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.beginPath(); g.moveTo(0, 10);
  for (let x = 0; x <= W; x += 3.5) g.lineTo(x, 10 + (rnd() - 0.5) * 3 + ((x / 7) % 1 < 0.5 ? 1.2 : -0.6));
  g.lineTo(W, H - 10);
  for (let x = W; x >= 0; x -= 3.5) g.lineTo(x, H - 10 + (rnd() - 0.5) * 3 + ((x / 7) % 1 < 0.5 ? -1.2 : 0.6));
  g.closePath(); g.fillStyle = C.paper; g.fill();
  g.save(); g.clip();
  // greenbar: 3-line bands from the first printed line
  g.fillStyle = C.greenbar;
  for (let y = top + pad, k = 0; y < H; y += LH * 3, k++) if (k % 2 === 0) g.fillRect(strip, y, W - strip * 2, LH * 3);
  // fibre
  for (let i = 0; i < (W * H) / 700; i++) { g.fillStyle = `rgba(90,96,88,${0.02 + rnd() * 0.03})`; g.fillRect(rnd() * W, rnd() * H, 1, 1); }
  // perforations along both strips
  g.fillStyle = C.perf; for (let y = 0; y < H; y += 7) { g.fillRect(strip - 1, y, 2, 4.5); g.fillRect(W - strip - 1, y, 2, 4.5); }
  // lines
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const y = top + pad + i * LH + 17; const x = strip + pad;
    g.font = fontFor(l);
    const col = l.cls === 'red' || l.cls === 'minus' || l.cls === 'err' ? C.red : l.cls === 'faded' || l.cls === 'tilde' ? C.ink2 : C.ink;
    g.fillStyle = col; g.globalAlpha = 0.9; g.fillText(l.t, x, y);
    g.globalAlpha = 0.45; g.fillText(l.t, x + 0.4, y); g.globalAlpha = 1;
    if (l.mutable) {
      // MUTABLE is struck in the red half of the ribbon
      const idx = l.t.indexOf('MUTABLE'); if (idx >= 0) { const pre = g.measureText(l.t.slice(0, idx)).width; g.fillStyle = C.paper; g.fillRect(x + pre, y - 13, g.measureText('MUTABLE').width + 1, 17); g.fillStyle = C.red; g.fillText('MUTABLE', x + pre, y); }
    }
  });
  g.font = '400 12px "Atkinson Hyperlegible Mono", monospace'; g.fillStyle = C.ink2;
  g.fillText(footer, strip + pad, top + pad + body + pad + 16);
  g.restore();
  // tractor holes, cut through
  g.globalCompositeOperation = 'destination-out';
  for (let y = 24; y < H - 8; y += 32) for (const x of [24, W - 24]) { g.beginPath(); g.arc(x, y, 7.5, 0, Math.PI * 2); g.fill(); }
  g.globalCompositeOperation = 'source-over';
  return cv;
}

export async function receiptBlob(opts) {
  const cv = await receiptCanvas(opts);
  return new Promise((ok) => cv.toBlob(ok, 'image/png'));
}

export function receiptName(q, d = new Date()) {
  const safe = String(q || 'ledger').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 44) || 'print';
  return `payblame-${safe}-${stamp(d)}.png`;
}
