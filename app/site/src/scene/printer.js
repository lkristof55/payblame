// PB-10: the payblame print mechanism, built procedurally. Units are inches.
// Shared by design/frames/hero.html, model previews, the GLB export and (copied) site/src.
//
//   const P = buildPrinter({ paperCanvas, paperNormal, paperRough, quality: 'high' | 'low' });
//   scene.add(P.group);
//   P.setCarriage(x)      // head x on the rail, inches, -3.9 .. 3.9
//   P.setExplode(t)       // 0 assembled .. 1 fully exploded (cover off, solenoid ring fanned, pins drawn)
//   P.strike(mask)        // fire pins: mask = array of 10 booleans (slot i hit)
//   P.update(dt)          // advance pin spring animation
//   P.anchors.solenoid[i] // Object3D per slot for DOM callouts (+80 .. +386)
//
// Axes: X along the platen (left/right), Y up, Z toward the viewer. The head strikes toward -Z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const PAL = {
  paper: '#F4F5F0', greenbar: '#DCE8D6', ink: '#1F2124', inkFaded: '#6E7176', red: '#C22A1E',
  field: '#DADCD6', platen: '#141517', steel: '#B8BDC1', anodized: '#1C1E21', plastic: '#2A2C30',
  frame: '#C7CAC4', coil: '#A8683C', perf: '#C6CDC0',
};

export const DIM = {
  R: 0.72,            // platen radius
  paperW: 9.5,        // 9.5" fanfold: 8.5" page + two 0.5" tractor strips
  ppi: 150,           // paper texture pixels per inch
  cpi: 12, lpi: 6,    // elite 12 cpi: a 100-column blame row is 8.33" on the 8.5" page; 6 lines per inch
  thIn: -38, thOut: 10, thPrint: -6, // wrap angles (deg, from +Z toward +Y)
  inLen: 2.6, outLen: 6.4, curlR: 2.2, curlDeg: 56,
  frameX: 5.7,
};

// Slot i of SharingConfig.shareholders sits at byte offset 80 + 34*i. One pin per slot.
export const SLOTS = Array.from({ length: 10 }, (_, i) => ({ slot: i, offset: 80 + 34 * i }));

const rad = Math.PI / 180;

// ---------------------------------------------------------------- paper path (YZ profile)
export function paperPath(d = DIM) {
  const Rp = d.R + 0.008;
  const pts = [];
  const t0 = d.thIn * rad;
  const P0 = { y: Rp * Math.sin(t0), z: Rp * Math.cos(t0) };
  const T0 = { y: Math.cos(t0), z: -Math.sin(t0) };
  const nIn = 24;
  for (let i = 0; i < nIn; i++) { const k = d.inLen * (1 - i / nIn); pts.push({ y: P0.y - T0.y * k, z: P0.z - T0.z * k }); }
  const nArc = 56;
  for (let i = 0; i <= nArc; i++) { const th = (d.thIn + (d.thOut - d.thIn) * i / nArc) * rad; pts.push({ y: Rp * Math.sin(th), z: Rp * Math.cos(th) }); }
  const t1 = d.thOut * rad; const P1 = { ...pts[pts.length - 1] }; const T1 = { y: Math.cos(t1), z: -Math.sin(t1) };
  const nOut = 70;
  for (let i = 1; i <= nOut; i++) { const k = d.outLen * i / nOut; pts.push({ y: P1.y + T1.y * k, z: P1.z + T1.z * k }); }
  const Pe = pts[pts.length - 1]; const n1 = { y: -T1.z, z: T1.y };
  const C = { y: Pe.y - d.curlR * n1.y, z: Pe.z - d.curlR * n1.z };
  const nCurl = 36;
  for (let i = 1; i <= nCurl; i++) { const ph = (d.thOut + d.curlDeg * i / nCurl) * rad; pts.push({ y: C.y + d.curlR * Math.sin(ph), z: C.z + d.curlR * Math.cos(ph) }); }
  let s = 0; pts[0].s = 0;
  for (let i = 1; i < pts.length; i++) { s += Math.hypot(pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z); pts[i].s = s; }
  const L = s;
  const sPrint = d.inLen + Rp * (d.thPrint - d.thIn) * rad;
  const sOut = d.inLen + Rp * (d.thOut - d.thIn) * rad;
  // frame at arc length s: position, tangent (up the paper), normal (printed face, toward viewer)
  function at(sq) {
    let i = 1; while (i < pts.length - 1 && pts[i].s < sq) i++;
    const a = pts[i - 1], b = pts[i]; const f = (sq - a.s) / Math.max(1e-6, b.s - a.s);
    const y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
    const ty = (b.y - a.y), tz = (b.z - a.z); const tl = Math.hypot(ty, tz) || 1;
    return { y, z, ty: ty / tl, tz: tz / tl, ny: -tz / tl, nz: ty / tl };
  }
  return { pts, L, sPrint, sOut, Rp, at };
}

// ---------------------------------------------------------------- paper texture
// lines: [{ t: 'text', c?: 'ink'|'red'|'faded', b?: bool (emphasized double strike) }], oldest first.
// The newest line sits one line above the print line. Returns { canvas, lineS } (lineS = s of each baseline).
export function drawPaper(canvas, { lines = [], path = paperPath(), d = DIM, font = 'Bitcount Grid Single', seed = 7, tofGap = 0.5, stamp } = {}) {
  const ppi = d.ppi; const W = Math.round(d.paperW * ppi); const H = Math.round(path.L * ppi);
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  let rs = seed; const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  const Y = (s) => (1 - s / path.L) * H; // canvas y of arc length s
  const pitchLine = 1 / d.lpi, pitchChar = ppi / d.cpi;
  const n = lines.length;
  const lineS = lines.map((_, i) => path.sPrint + (n - i) * pitchLine);
  const tof = path.sPrint + (n + 0.4) * pitchLine + tofGap; // top of form above the first line
  // stock
  g.fillStyle = PAL.paper; g.fillRect(0, 0, W, H);
  // greenbar: 0.5" bands measured down from top of form, only between the perforations
  const x0 = 0.5 * ppi, x1 = W - 0.5 * ppi;
  g.fillStyle = PAL.greenbar;
  for (let k = -40; k < 40; k++) {
    if (k % 2 !== 0) continue;
    const sTop = tof - 0.5 * k - 0.5, sBot = sTop - 0.5; // band k (even = green)
    const yA = Y(sTop + 0.5), yB = Y(sBot + 0.5);
    if (yB < 0 || yA > H) continue;
    g.fillRect(x0 + 2, yA, x1 - x0 - 4, yB - yA);
  }
  // paper fibre: faint speckle
  for (let i = 0; i < W * H / 900; i++) { g.fillStyle = `rgba(90,96,88,${0.02 + rnd() * 0.03})`; g.fillRect(rnd() * W, rnd() * H, 1, 1); }
  // micro-perforation between tractor strips and the page, and across at top of form
  g.fillStyle = PAL.perf;
  for (let y = 0; y < H; y += 7) { g.fillRect(x0 - 1, y, 2, 4.5); g.fillRect(x1 - 1, y, 2, 4.5); }
  for (let k = -2; k <= 2; k++) { const yy = Y(tof + 11 * k); if (yy < 0 || yy > H) continue; for (let x = 0; x < W; x += 7) g.fillRect(x, yy - 1, 4.5, 2); }
  // line numbers in the right tractor strip, like real greenbar stock (tiny, printed by the mill)
  g.fillStyle = 'rgba(120,150,112,0.55)'; g.font = `${Math.round(ppi * 0.07)}px ${font}`; g.textAlign = 'center';
  for (let k = 1; k <= 66; k++) { const yy = Y(tof - (k - 0.5) / 6); if (yy < 0 || yy > H) continue; if (k % 3 === 0) g.fillText(String(k), W - 0.5 * ppi + 0.36 * ppi, yy + 4); }
  g.textAlign = 'left';
  // ink
  const fs = pitchChar / 0.6; // Bitcount Grid Single advance is 0.6 em
  const colX = 0.5 * ppi + 0.14 * ppi;
  // All glyphs go onto one transparent ink layer (no per-glyph filters: those stall the rasterizer),
  // then the layer is struck onto the stock twice: a soft bleed pass and a crisp pass, multiplied.
  const ink = document.createElement('canvas'); ink.width = W; ink.height = H;
  const k2 = ink.getContext('2d');
  lines.forEach((ln, i) => {
    const y = Y(lineS[i]) - 0.02 * ppi; const text = ln.t ?? ln;
    const col = ln.c === 'red' ? PAL.red : ln.c === 'faded' ? PAL.inkFaded : PAL.ink;
    const density = ln.c === 'faded' ? 0.7 : 0.82 + rnd() * 0.16; // ribbon wear per line
    const wx = ln.w || 1;                       // 2 = double width (ESC W 1)
    const pc = (ppi / (ln.cpi || d.cpi)) * wx;  // character pitch in px
    const fsz = (ppi / (ln.cpi || d.cpi)) / 0.6;
    k2.font = `${ln.b ? 600 : 400} ${fsz.toFixed(2)}px "${font}"`;
    k2.fillStyle = col;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]; if (ch === ' ') continue;
      const x = colX + c * pc + (rnd() - 0.5) * 0.5;
      k2.setTransform(wx, 0, 0, 1, x, y + (rnd() - 0.5) * 0.35);
      k2.globalAlpha = density * (0.84 + rnd() * 0.16);
      k2.fillText(ch, 0, 0);
      if (ln.b) { k2.globalAlpha *= 0.8; k2.fillText(ch, fsz * 0.05, 0); } // emphasized: second strike offset half a dot
    }
  });
  k2.setTransform(1, 0, 0, 1, 0, 0); k2.globalAlpha = 1;
  if (stamp) stamp(k2, { Y, ppi, W, H, tof, lineS, colX, pitchChar, fs });
  g.globalCompositeOperation = 'multiply';
  g.filter = 'blur(0.7px)'; g.globalAlpha = 0.45; g.drawImage(ink, 0, 0);
  g.filter = 'none'; g.globalAlpha = 0.92; g.drawImage(ink, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  // tractor holes (cut out: alpha 0)
  g.globalCompositeOperation = 'destination-out';
  const hr = (5 / 32) * ppi / 2;
  for (let k = -60; k < 60; k++) {
    const yy = Y(tof - 0.25 - 0.5 * k); if (yy < -20 || yy > H + 20) continue;
    for (const xx of [0.25 * ppi, W - 0.25 * ppi]) { g.beginPath(); g.arc(xx, yy, hr, 0, Math.PI * 2); g.fill(); }
  }
  g.globalCompositeOperation = 'source-over';
  return { canvas, lineS, tof };
}

// ---------------------------------------------------------------- helpers
function frustum(wTip, hTip, wBase, hBase, depth) {
  // square-section frustum, tip at z=0, base at z=depth
  const g = new THREE.BoxGeometry(1, 1, depth, 1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i); const tip = z < 0;
    p.setX(i, p.getX(i) * (tip ? wTip : wBase)); p.setY(i, p.getY(i) * (tip ? hTip : hBase)); p.setZ(i, z + depth / 2);
  }
  g.computeVertexNormals();
  return g;
}
function stripAlong(curve, width, n) {
  // a flat ribbon along a curve, its width along world X (the carriage axis)
  const pos = [], idx = [];
  for (let i = 0; i <= n; i++) { const p = curve.getPoint(i / n); pos.push(-width / 2, p.y, p.z, width / 2, p.y, p.z); }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function cylX(r, len, seg = 48) { const g = new THREE.CylinderGeometry(r, r, len, seg, 1); g.rotateZ(Math.PI / 2); return g; }
function knurled(r, len, ridges = 40, depth = 0.018) {
  const seg = ridges * 2; const g = new THREE.CylinderGeometry(r, r, len, seg, 1); const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i); const a = Math.atan2(z, x); const rr = Math.hypot(x, z);
    if (rr < 1e-4) continue;
    const k = Math.round((a / (Math.PI * 2)) * seg); const nr = rr - (k % 2 ? depth : 0);
    p.setX(i, Math.cos(a) * nr); p.setZ(i, Math.sin(a) * nr);
  }
  g.computeVertexNormals(); g.rotateZ(Math.PI / 2); return g;
}

export function makeMaterials({ paperMap, paperNormal, paperRough, env } = {}) {
  const M = {
    paper: new THREE.MeshStandardMaterial({ color: 0xffffff, map: paperMap || null, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 }),
    platen: new THREE.MeshPhysicalMaterial({ color: PAL.platen, roughness: 0.62, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.55 }),
    anod: new THREE.MeshPhysicalMaterial({ color: PAL.anodized, roughness: 0.34, metalness: 0.75, clearcoat: 0.4, clearcoatRoughness: 0.3, anisotropy: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: PAL.steel, roughness: 0.18, metalness: 1 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: '#5d6266', roughness: 0.3, metalness: 1 }),
    plastic: new THREE.MeshPhysicalMaterial({ color: PAL.plastic, roughness: 0.5, metalness: 0, clearcoat: 0.1 }),
    plasticLid: new THREE.MeshPhysicalMaterial({ color: '#3a3d42', roughness: 0.38, metalness: 0, clearcoat: 0.3 }),
    knob: new THREE.MeshPhysicalMaterial({ color: '#16171a', roughness: 0.42, metalness: 0, clearcoat: 0.3 }),
    frame: new THREE.MeshPhysicalMaterial({ color: PAL.frame, roughness: 0.48, metalness: 0.15, clearcoat: 0.2 }),
    graphite: new THREE.MeshPhysicalMaterial({ color: '#3a3d41', roughness: 0.62, metalness: 0.1, clearcoat: 0.15, clearcoatRoughness: 0.7 }),
    coil: new THREE.MeshStandardMaterial({ color: PAL.coil, roughness: 0.32, metalness: 1 }),
    ribbon: new THREE.MeshPhysicalMaterial({ color: '#17181a', roughness: 0.92, metalness: 0, sheen: 0.8, sheenColor: new THREE.Color('#3a3c40'), sheenRoughness: 0.6, side: THREE.DoubleSide }),
    rubber: new THREE.MeshStandardMaterial({ color: '#1b1c1e', roughness: 0.7 }),
    flex: new THREE.MeshPhysicalMaterial({ color: '#9fa39f', roughness: 0.35, metalness: 0, clearcoat: 0.6, side: THREE.DoubleSide }),
    red: new THREE.MeshStandardMaterial({ color: PAL.red, roughness: 0.5 }),
    ribbonRed: new THREE.MeshPhysicalMaterial({ color: PAL.red, roughness: 0.85, metalness: 0, sheen: 0.6, sheenColor: new THREE.Color('#e0645a'), side: THREE.DoubleSide }),
  };
  if (paperNormal) { M.paper.normalMap = paperNormal; M.paper.normalScale = new THREE.Vector2(0.35, 0.35); }
  if (paperRough) M.paper.roughnessMap = paperRough;
  return M;
}

// ---------------------------------------------------------------- the head (PB-10)
// Local frame: origin at the pin column tip, head extends toward +Z (away from the platen).
function buildHead(M, quality) {
  const head = new THREE.Group(); head.name = 'head';
  const seg = quality === 'low' ? 16 : 32;
  // nose
  const nose = new THREE.Mesh(frustum(0.26, 0.62, 0.86, 0.9, 0.42), M.anod); nose.name = 'nose'; head.add(nose);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.56, 0.03), M.darkSteel); plate.position.z = 0.012; head.add(plate);
  const tips = [];
  for (let i = 0; i < 10; i++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.05, 12), M.steel); t.rotation.x = Math.PI / 2;
    t.position.set(0, 0.225 - i * 0.05, -0.006); head.add(t); tips.push(t);
  }
  // ribbon guide clip (the thing that keeps the ribbon off the paper)
  const guide = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.06), M.plastic); guide.position.set(0, -0.35, 0.02); head.add(guide);
  // cover: body + fins (lifts off in the explode)
  const cover = new THREE.Group(); cover.name = 'cover';
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.26, 1.02, 1.12, 4, 0.07), M.anod); body.position.z = 0.42 + 0.56; cover.add(body);
  const finG = new THREE.BoxGeometry(0.05, 0.3, 1.0);
  for (let k = 0; k < 9; k++) { const f = new THREE.Mesh(finG, M.anod); f.position.set(-0.56 + k * 0.14, 0.51 + 0.15, 0.98); cover.add(f); }
  for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.045, 0.9), M.anod); f.position.set(sx * (0.63 + 0.11), 0.36 - k * 0.16, 0.98); cover.add(f); }
  // engraved badge strip on the right cheek
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.5), M.steel); badge.position.set(0.633, -0.36, 0.98); cover.add(badge);
  for (const sy of [0.28, -0.28]) { const scr = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16), M.steel); scr.rotation.z = Math.PI / 2; scr.position.set(0.64, sy, 0.62); cover.add(scr); }
  head.add(cover);
  // silkscreened badge on the back face: the head's name and what its pins mean
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas'); c.width = 512; c.height = 320; const g = c.getContext('2d');
    g.fillStyle = '#e9ebe6'; g.font = '400 96px "Bitcount Grid Single"'; g.textBaseline = 'alphabetic'; g.fillText('PB-10', 28, 118);
    g.font = '600 34px "Atkinson Hyperlegible Mono", monospace'; g.fillText('10 PIN / 1 PER SLOT', 30, 186); g.fillText('OFFSET 80 + 34i', 30, 232);
    g.fillStyle = '#C22A1E'; g.beginPath(); g.arc(470, 64, 18, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.575), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }));
    decal.position.set(-0.06, 0.1, 0.42 + 1.12 + 0.004); decal.name = 'badge'; cover.add(decal);
  }
  // connector block where the flat cable plugs in (the cable itself is left out: it reads as a strap at hero scale)
  const conn = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.16, 0.12, 2, 0.03), M.plastic); conn.position.set(0, -0.36, 1.58); cover.add(conn);
  // internals: 10 solenoids on a ring, one per shareholder slot
  const inner = new THREE.Group(); inner.name = 'solenoids'; head.add(inner);
  const sols = [];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group(); g.name = `slot${i}`;
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.36, seg), M.coil); coil.rotation.x = Math.PI / 2; g.add(coil);
    for (const zz of [-0.19, 0.19]) { const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.025, seg), M.darkSteel); cap.rotation.x = Math.PI / 2; cap.position.z = zz; g.add(cap); }
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 12), M.steel); core.rotation.x = Math.PI / 2; g.add(core);
    const anchor = new THREE.Object3D(); anchor.position.z = -0.3; g.add(anchor);
    inner.add(g); sols.push({ g, anchor, a: (90 - i * 36) * rad, i });
  }
  // pins: steel wires from each solenoid to its row in the tip column
  const pinMeshes = [];
  for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(new THREE.BufferGeometry(), M.steel); inner.add(m); pinMeshes.push(m); }
  const state = { explode: -1, strike: new Float32Array(10), hold: new Float32Array(10) };
  // Explode timeline (one scalar, scrubbed by scroll):
  //   0.00-0.22  the head lifts out of the carriage and turns its nose to the viewer (the pinout beat)
  //   0.30-0.50  it turns 25 degrees off-axis while the cover lifts off
  //   0.50-0.95  the ten solenoids fan out into a ring around the nose, the pins stretch between ring and nose
  const base = new THREE.Vector3();
  function layout(t) {
    const S = THREE.MathUtils.smoothstep;
    const eLift = S(t, 0, 0.22), eBack = S(t, 0.3, 0.5), eCover = S(t, 0.32, 0.55), eRing = S(t, 0.5, 0.95);
    head.position.set(base.x, base.y + 2.4 * eLift, base.z + 2.9 * eLift);
    head.rotation.set(0.1 * eLift, Math.PI * (0.96 * eLift - 0.14 * eBack), 0);
    cover.position.set(0, eCover * 2.9, eCover * 0.6); cover.rotation.x = -eCover * 0.25;
    const ringR = 0.34 + eRing * 0.84, ringZ = 0.98 + eRing * 0.72;
    head.updateMatrixWorld(true);
    const aim = head.localToWorld(new THREE.Vector3(0, 0, -0.35));
    for (const s of sols) { s.g.position.set(Math.cos(s.a) * ringR, Math.sin(s.a) * ringR, ringZ - Math.max(state.strike[s.i], state.hold[s.i] * 0.8) * 0.05); s.g.updateMatrixWorld(); s.g.lookAt(aim); }
    for (let i = 0; i < 10; i++) {
      const s = sols[i]; const p0 = new THREE.Vector3(0, 0.225 - i * 0.05, 0.0);
      const dir = new THREE.Vector3(0, 0, -0.35).sub(s.g.position).normalize();
      const p3 = s.g.position.clone().addScaledVector(dir, 0.2);
      const p1 = new THREE.Vector3(0, p0.y, 0.3 + eRing * 0.25);
      const p2 = new THREE.Vector3(p3.x * 0.6, p3.y * 0.6, p3.z - 0.3 - eRing * 0.2);
      pinMeshes[i].geometry.dispose();
      pinMeshes[i].geometry = new THREE.TubeGeometry(new THREE.CubicBezierCurve3(p0, p1, p2, p3), quality === 'low' ? 16 : 32, 0.011, 6, false);
    }
    state.explode = t;
  }
  function setBase(v) { base.copy(v); layout(state.explode < 0 ? 0 : state.explode); }
  layout(0);
  return { head, cover, nose, tips, sols, pinMeshes, inner, layout, setBase, state };
}

// ---------------------------------------------------------------- the whole mechanism
export function buildPrinter({ paperTexture, paperNormal, paperRough, quality = 'high', path = paperPath(), d = DIM } = {}) {
  const M = makeMaterials({ paperMap: paperTexture, paperNormal, paperRough });
  const group = new THREE.Group(); group.name = 'PB-10';
  const seg = quality === 'low' ? 48 : 96;
  // platen, shaft, knobs
  const platen = new THREE.Mesh(cylX(d.R, 10.2, seg), M.platen); platen.name = 'platen'; group.add(platen);
  const shaft = new THREE.Mesh(cylX(0.19, 2 * d.frameX + 1.3, 32), M.steel); group.add(shaft);
  for (const sx of [-1, 1]) {
    const knob = new THREE.Mesh(knurled(0.64, 0.52, 44), M.knob); knob.position.x = sx * (d.frameX + 0.62); group.add(knob);
    const cap = new THREE.Mesh(cylX(0.5, 0.06, 48), M.darkSteel); cap.position.x = sx * (d.frameX + 0.9); group.add(cap);
    const collar = new THREE.Mesh(cylX(0.3, 0.2, 32), M.steel); collar.position.x = sx * (d.frameX + 0.26); group.add(collar);
  }
  // paper
  const cols = 10; const W = d.paperW; const P = path.pts; const pos = []; const uv = []; const idx = [];
  for (let i = 0; i < P.length; i++) for (let j = 0; j <= cols; j++) {
    const x = -W / 2 + W * j / cols; pos.push(x, P[i].y, P[i].z); uv.push(j / cols, P[i].s / path.L);
  }
  for (let i = 0; i < P.length - 1; i++) for (let j = 0; j < cols; j++) {
    const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, e = c + 1; idx.push(a, b, c, b, e, c);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); pg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); pg.setIndex(idx); pg.computeVertexNormals();
  const paper = new THREE.Mesh(pg, M.paper); paper.name = 'paper'; group.add(paper);
  // print line frame
  const pl = path.at(path.sPrint);
  const printPoint = new THREE.Vector3(0, pl.y, pl.z);
  // ribbon: a band across the full width, just off the paper at the print line
  const rib = path.at(path.sPrint + 0.02);
  // two-colour ribbon (black over red), the source of the only accent colour
  const ribbon = new THREE.Group(); ribbon.name = 'ribbon';
  const rb = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 0.2), M.ribbon); rb.position.y = 0.1; ribbon.add(rb);
  const rr = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 0.16), M.ribbonRed); rr.position.y = -0.08; ribbon.add(rr);
  ribbon.position.set(0, rib.y + rib.ny * 0.03, rib.z + rib.nz * 0.03); ribbon.lookAt(ribbon.position.x, ribbon.position.y + rib.ny, ribbon.position.z + rib.nz);
  group.add(ribbon);
  // paper bail with three rollers
  const bail = path.at(path.sOut + 0.5);
  const bailPos = new THREE.Vector3(0, bail.y + bail.ny * 0.13, bail.z + bail.nz * 0.13);
  const bar = new THREE.Mesh(cylX(0.045, 10.6, 16), M.steel); bar.position.copy(bailPos); group.add(bar);
  for (const bx of [-2.7, 0, 2.7]) { const r = new THREE.Mesh(cylX(0.12, 0.34, 24), M.rubber); r.position.set(bx, bailPos.y, bailPos.z); group.add(r); }
  // pull tractors on both paper edges
  for (const sx of [-1, 1]) {
    const f = path.at(path.sOut + 2.6);
    const t = new THREE.Group();
    // housing sits behind the paper edge, the hinged lid presses the strip onto the sprocket belt
    const housing = new THREE.Mesh(new RoundedBoxGeometry(0.9, 1.9, 0.34, 3, 0.05), M.plastic); housing.position.z = -0.2; t.add(housing);
    const lid = new THREE.Mesh(new RoundedBoxGeometry(0.5, 1.5, 0.07, 2, 0.03), M.plasticLid); lid.position.set(sx * 0.12, 0, 0.05); t.add(lid);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 12), M.steel); hinge.position.set(sx * 0.39, 0, 0.05); t.add(hinge);
    const lever = new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.42, 0.22, 2, 0.04), M.knob); lever.position.set(-sx * 0.5, -0.62, -0.05); t.add(lever);
    for (let k = 0; k < 2; k++) { const pin = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.09, 12), M.steel); pin.rotation.x = Math.PI / 2; pin.position.set(-sx * 0.2 + sx * 0.2, 1.0 + k * 0.5, 0.03); t.add(pin); }
    t.position.set(sx * (W / 2 - 0.3), f.y, f.z);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -f.ny, -f.nz), new THREE.Vector3(0, f.ty, f.tz));
    t.quaternion.setFromRotationMatrix(m);
    group.add(t);
  }
  // side frames (sheet steel, powder-coated), with a bearing boss for the shaft
  for (const sx of [-1, 1]) {
    const s = new THREE.Shape();
    const y0 = pl.y - 1.9, y1 = 1.25, z0 = -1.45, z1 = pl.z + 2.3, r = 0.18;
    s.moveTo(z0 + r, y0); s.lineTo(z1 - r, y0); s.quadraticCurveTo(z1, y0, z1, y0 + r); s.lineTo(z1, pl.y - 0.2); s.lineTo(z1 - 1.2, y1 - 0.1); s.lineTo(z0 + r, y1); s.quadraticCurveTo(z0, y1, z0, y1 - r); s.lineTo(z0, y0 + r); s.quadraticCurveTo(z0, y0, z0 + r, y0);
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.2, 0, Math.PI * 2, true); s.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 24 });
    g.rotateY(-Math.PI / 2); // shape (z,y) -> world: shape x = z
    const plate = new THREE.Mesh(g, M.graphite); plate.position.x = sx * d.frameX + (sx > 0 ? 0.1 : 0); group.add(plate);
    const boss = new THREE.Mesh(cylX(0.36, 0.16, 40), M.darkSteel); boss.position.x = sx * (d.frameX + 0.08); group.add(boss);
  }
  // carriage rails and belt
  const railY = pl.y - 0.86, railZ0 = pl.z + 0.62, railZ1 = pl.z + 1.42;
  for (const z of [railZ0, railZ1]) { const rail = new THREE.Mesh(cylX(0.11, 2 * d.frameX, 32), M.steel); rail.position.set(0, railY, z); group.add(rail); }
  const belt = new THREE.Mesh(new THREE.BoxGeometry(2 * d.frameX - 0.4, 0.2, 0.025), M.rubber); belt.position.set(0, railY - 0.3, railZ1 + 0.3); group.add(belt);
  for (const sx of [-1, 1]) { const pul = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 24), M.darkSteel); pul.rotation.z = 0; pul.rotation.x = 0; pul.position.set(sx * (d.frameX - 0.35), railY - 0.3, railZ1 + 0.3); pul.rotation.set(Math.PI / 2, 0, 0); group.add(pul); }
  // carriage + head
  const carriage = new THREE.Group(); carriage.name = 'carriage'; group.add(carriage);
  const sled = new THREE.Mesh(new RoundedBoxGeometry(1.4, 0.34, 1.36, 3, 0.05), M.plastic); sled.position.set(0, railY + 0.1, (railZ0 + railZ1) / 2); carriage.add(sled);
  const H = buildHead(M, quality);
  H.setBase(new THREE.Vector3(0, pl.y, pl.z + 0.06)); carriage.add(H.head);
  // shadows
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  paper.castShadow = true;

  // scrim: a field-coloured veil between the printout and the lifted head, so the explode beats read on a clean field
  const scrim = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), new THREE.MeshBasicMaterial({ color: PAL.field, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  scrim.position.set(0, pl.y + 3, pl.z + 0.3); scrim.visible = false; scrim.name = 'scrim'; scrim.renderOrder = 1; group.add(scrim);
  const anchors = { solenoid: H.sols.map((s) => s.anchor), tip: H.tips, printPoint };
  let explode = 0;
  const api = {
    group, paper, platen, ribbon, carriage, head: H.head, cover: H.cover, materials: M, path, anchors,
    setCarriage(x) { carriage.position.x = x; },
    setScrim(a) { scrim.material.opacity = a; scrim.visible = a > 0.001; },
    setExplode(t) { explode = t; H.layout(t); },
    strike(mask) { mask.forEach((on, i) => { if (on) H.state.strike[i] = 1; }); },
    // hold(mask): pins that stay fired (the ring beat scrubs the ten probes in slot order)
    hold(mask) {
      let ch = false;
      mask.forEach((on, i) => { const v = on ? 1 : 0; if (H.state.hold[i] !== v) { H.state.hold[i] = v; ch = true; } });
      if (ch) { for (let i = 0; i < 10; i++) H.tips[i].position.z = -0.006 - Math.max(H.state.strike[i], H.state.hold[i] * 0.8) * 0.04; H.layout(explode); }
      return ch;
    },
    update(dt) {
      let moving = false;
      for (let i = 0; i < 10; i++) { const v = H.state.strike[i]; if (v > 0) { H.state.strike[i] = Math.max(0, v - dt / 0.09); moving = true; } H.tips[i].position.z = -0.006 - Math.max(H.state.strike[i], H.state.hold[i] * 0.8) * 0.04; }
      if (moving) H.layout(explode);
    },
  };
  return api;
}

// ---------------------------------------------------------------- reusable module shape (site + brand-kit)
// createPrinter(scene, opts) -> { P, update(t, progress), dispose() }
// `progress` is optional: { explode, scrim, carriage } applied before the pin springs advance.
export function createPrinter(scene, opts = {}) {
  const P = buildPrinter(opts);
  scene.add(P.group);
  let last = null;
  return {
    P,
    update(t, progress) {
      if (progress) {
        if (progress.explode != null) P.setExplode(progress.explode);
        if (progress.scrim != null) P.setScrim(progress.scrim);
        if (progress.carriage != null) P.setCarriage(progress.carriage);
      }
      const dt = last == null ? 0 : Math.min(0.05, Math.max(0, t - last)); last = t;
      P.update(dt);
    },
    dispose() {
      scene.remove(P.group);
      P.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of Object.values(P.materials)) m.dispose();
    },
  };
}
