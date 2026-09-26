// Stage for the PB-10: renderer, studio light, floor shadow, camera shots, auto-fit and the live paper.
// Ported from design/frames/scene.js. No page DOM assumptions: it takes a canvas and sizes.
//
//   const st = await createStage(canvas, { width, height, dpr, quality, lines });
//   st.setLines(lines)            reprint the 3D paper (lines: [{ t, c?, b?, w?, cpi? }])
//   st.apply(shot)                camera from a shot { pos, target, fov, shift, shiftY }
//   st.fit(shot, rect)            solve distance + lens shift so the mechanism lands in rect (viewport fractions)
//   st.render()
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { buildPrinter, drawPaper, paperPath, PAL, DIM } from './printer.js';

export const SHOTS = {
  hero: { pos: [-4.2, 7.8, 24], target: [0.9, 2.3, 0.4], fov: 23, shift: -0.235, shiftY: 0 },
  heroMobile: { pos: [-8.5, 9.5, 27], target: [0.3, 2.0, 0.4], fov: 30, shift: 0, shiftY: -0.2 },
  diff: { pos: [-2.6, 2.4, 11], target: [-0.6, 0.9, 0.6], fov: 26, shift: -0.2, shiftY: 0 },
  measured: { pos: [-6, 14, 16], target: [0.5, 1.5, 0], fov: 24, shift: -0.3, shiftY: -0.2 },
  repo: { pos: [0, 16, 6], target: [0, 5, -1], fov: 28, shift: -0.22, shiftY: 0 },
};

export const V = (a) => new THREE.Vector3(...a);

export function mixShot(a, b, t) {
  const l = (x, y) => x + (y - x) * t;
  return {
    pos: a.pos.map((v, i) => l(v, b.pos[i])),
    target: a.target.map((v, i) => l(v, b.target[i])),
    fov: l(a.fov, b.fov), shift: l(a.shift || 0, b.shift || 0), shiftY: l(a.shiftY || 0, b.shiftY || 0),
  };
}

export async function createStage(canvas, { width, height, dpr = Math.min(globalThis.devicePixelRatio || 1, 2), lines = [], quality = 'high', carriage = -0.9, assetBase = '', shadowSize } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(dpr); renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tl = new THREE.TextureLoader();
  const [hdr, nrm, rgh] = await Promise.all([
    new HDRLoader().loadAsync(`${assetBase}/tex/monochrome_studio_02_1k.hdr`),
    tl.loadAsync(`${assetBase}/tex/paper001_normal.webp`),
    tl.loadAsync(`${assetBase}/tex/paper001_roughness.webp`),
  ]);
  scene.environment = pmrem.fromEquirectangular(hdr).texture; hdr.dispose(); pmrem.dispose();
  scene.environmentIntensity = 0.85;
  scene.environmentRotation = new THREE.Euler(0, 1.1, 0);

  const key = new THREE.DirectionalLight('#ffffff', 1.6); key.position.set(-6, 11, 8);
  const sm = shadowSize || (quality === 'low' ? 1024 : 2048);
  key.castShadow = true; key.shadow.mapSize.set(sm, sm); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -6, near: 1, far: 40 });
  scene.add(key);
  const rim = new THREE.DirectionalLight('#f2f4f7', 0.6); rim.position.set(7, 5, -6); scene.add(rim);

  // the paper: a canvas texture of the real printout, reprinted when the job changes
  const d = quality === 'low' ? { ...DIM, ppi: 110 } : DIM;
  const path = paperPath(d);
  const pc = (canvas.ownerDocument || document).createElement('canvas');
  drawPaper(pc, { lines, path, d });
  const paperTex = new THREE.CanvasTexture(pc); paperTex.colorSpace = THREE.SRGBColorSpace; paperTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const t of [nrm, rgh]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 6); }
  const P = buildPrinter({ paperTexture: paperTex, paperNormal: nrm, paperRough: rgh, quality, path, d });
  P.setCarriage(carriage);
  scene.add(P.group);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ color: '#2a2e2a', opacity: 0.2 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = path.at(path.sPrint).y - 1.92; ground.receiveShadow = true; scene.add(ground);

  const camera = new THREE.PerspectiveCamera(25, width / height, 0.1, 200);
  let W = width, H = height;
  const tgt = new THREE.Vector3();
  function apply(s) {
    camera.fov = s.fov; camera.aspect = W / H;
    camera.position.set(s.pos[0], s.pos[1], s.pos[2]); tgt.set(s.target[0], s.target[1], s.target[2]); camera.lookAt(tgt);
    camera.updateProjectionMatrix();
    const sx = s.shift || 0, sy = s.shiftY || 0;
    if (sx || sy) { camera.projectionMatrix.elements[8] = sx * 2; camera.projectionMatrix.elements[9] = sy * 2; camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert(); }
    camera.updateMatrixWorld();
  }
  const top = path.at(path.sOut + 4.2);
  const FIT_PTS = [
    [-6.55, -1.9, -1.4], [-6.55, -1.9, 3.0], [6.55, -1.9, 3.0], [6.55, -1.9, -1.4],
    [-6.55, 0.7, 0], [6.55, 0.7, 0], [-4.75, top.y, top.z], [4.75, top.y, top.z],
  ].map((p) => new THREE.Vector3(...p));
  // keep the shot's viewing direction; solve distance and lens shift so FIT_PTS land in rect
  function fit(shot, rect, pts = FIT_PTS) {
    const s = { ...shot };
    const t = V(s.target); const dir = V(s.pos).sub(t).normalize();
    let dist = V(s.pos).distanceTo(t);
    const wantW = (rect[1] - rect[0]) * 2, wantH = (rect[3] - rect[2]) * 2;
    const cx = (rect[0] + rect[1]) - 1, cy = 1 - (rect[2] + rect[3]);
    let box;
    for (let it = 0; it < 14; it++) {
      camera.position.copy(t).addScaledVector(dir, dist); camera.fov = s.fov; camera.aspect = W / H;
      camera.lookAt(t); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      box = { x0: 9, x1: -9, y0: 9, y1: -9 };
      for (const p of pts) { const v = p.clone().project(camera); box.x0 = Math.min(box.x0, v.x); box.x1 = Math.max(box.x1, v.x); box.y0 = Math.min(box.y0, v.y); box.y1 = Math.max(box.y1, v.y); }
      const k = Math.max((box.x1 - box.x0) / wantW, (box.y1 - box.y0) / wantH);
      dist *= 0.5 + 0.5 * k;
    }
    s.pos = camera.position.toArray();
    s.shift = ((box.x0 + box.x1) / 2 - cx) / 2; s.shiftY = ((box.y0 + box.y1) / 2 - cy) / 2;
    return s;
  }
  function setLines(next) {
    drawPaper(pc, { lines: next, path, d });
    paperTex.needsUpdate = true;
  }
  // ---------------------------------------------------------------- the tear-off, in 3D
  // tearBegin() snapshots the printed paper above the tear bar (the bail) into its own strip; the live paper
  // underneath can then be reprinted fresh. setTear({ p, fly, side }) bends it at the perforation while it is
  // pulled (p 0..1) and throws it up and back once it separates (fly 0..1). tearEnd() drops it.
  const sTear = path.sOut + 0.5;
  let torn = null;
  function tearBegin() {
    tearEnd();
    const snap = (canvas.ownerDocument || document).createElement('canvas');
    snap.width = pc.width; snap.height = pc.height; snap.getContext('2d').drawImage(pc, 0, 0);
    const tex = new THREE.CanvasTexture(snap); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = paperTex.anisotropy;
    const mat = P.materials.paper.clone(); mat.map = tex; mat.transparent = true; mat.alphaTest = 0.04;
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -4;
    const t0 = path.at(sTear); const pts = [{ ...t0, s: sTear }, ...path.pts.filter((q) => q.s > sTear + 1e-3)];
    const cols = 10, Wp = d.paperW; const pos = [], uv = [], idx = [];
    for (let i = 0; i < pts.length; i++) for (let j = 0; j <= cols; j++) { pos.push(-Wp / 2 + Wp * j / cols, pts[i].y - t0.y, pts[i].z - t0.z); uv.push(j / cols, pts[i].s / path.L); }
    for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, e = c + 1; idx.push(a, b, c, b, e, c); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat); mesh.castShadow = true;
    const pivot = new THREE.Group(); pivot.position.set(0, t0.y, t0.z); pivot.add(mesh); P.group.add(pivot);
    torn = { pivot, mesh, tex, mat, g, t0 };
  }
  function setTear({ p = 0, fly = 0, side = 1 } = {}) {
    if (!torn) return;
    const { pivot, mat, t0 } = torn;
    // it peels toward the viewer (a tear bar is torn against, not through), slides up and skews from the side it
    // was pulled, which opens a gap of fresh stock at the perforation; then it is thrown up and away
    const up = p * 0.55 + fly * fly * 9, fwd = p * 0.25 + fly * 1.6;
    pivot.position.set(side * (p * 0.18 + fly * 1.4), t0.y + t0.ty * up + t0.ny * fwd, t0.z + t0.tz * up + t0.nz * fwd);
    pivot.rotation.set(p * 0.1 + fly * 0.5, 0, side * (p * 0.045 + fly * 0.22));
    mat.opacity = 1 - Math.max(0, (fly - 0.55) / 0.45);
  }
  function tearEnd() {
    if (!torn) return;
    P.group.remove(torn.pivot); torn.g.dispose(); torn.mat.dispose(); torn.tex.dispose(); torn = null;
  }
  // screen position of the perforation at the tear bar (left and right paper edges), for the DOM cue
  // `below` sits on the left text margin just under the print line (on the ribbon), below the last printed row:
  // the cue's pull tab hangs there so it never covers a row
  const tearL = new THREE.Object3D(), tearR = new THREE.Object3D(), tearBelow = new THREE.Object3D();
  { const t = path.at(sTear + 0.16); tearL.position.set(-d.paperW / 2 + 0.5, t.y, t.z); tearR.position.set(d.paperW / 2 - 0.5, t.y, t.z); P.group.add(tearL, tearR); }
  { const t = path.at(path.sPrint - 0.02); tearBelow.position.set(-d.paperW / 2 + 0.5, t.y + t.ny * 0.06, t.z + t.nz * 0.06); P.group.add(tearBelow); }
  // the foot of the last printed row (it always sits one line pitch above the print line, descenders included),
  // at the left text margin and at the right end of the page: the cue keeps its tab under this line on every camera
  const rowL = new THREE.Object3D(), rowR = new THREE.Object3D();
  { const t = path.at(path.sPrint + 1 / d.lpi - 0.03); rowL.position.set(-d.paperW / 2 + 0.64, t.y + t.ny * 0.01, t.z + t.nz * 0.01); rowR.position.set(d.paperW / 2 - 0.5, t.y + t.ny * 0.01, t.z + t.nz * 0.01); P.group.add(rowL, rowR); }

  function resize(w, h, r) { W = w; H = h; if (r) renderer.setPixelRatio(r); renderer.setSize(w, h, false); camera.aspect = w / h; }
  // world position of an Object3D projected to CSS pixels
  const tmp = new THREE.Vector3();
  function toScreen(obj) { obj.getWorldPosition(tmp); tmp.project(camera); return { x: (tmp.x * 0.5 + 0.5) * W, y: (-tmp.y * 0.5 + 0.5) * H, behind: tmp.z > 1 }; }
  // where the head sits at a given explode value (for head-relative shots); restores `restore` after
  function headWorld(explode, restore = 0) {
    P.setExplode(explode); P.group.updateMatrixWorld(true);
    const hp = new THREE.Vector3(); P.head.getWorldPosition(hp); P.setExplode(restore); return hp;
  }
  const render = () => renderer.render(scene, camera);
  function dispose() { tearEnd(); renderer.dispose(); paperTex.dispose(); nrm.dispose(); rgh.dispose(); scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  return { renderer, scene, camera, P, path, apply, fit, setLines, resize, toScreen, headWorld, render, dispose, paperCanvas: pc, PAL,
    tearBegin, setTear, tearEnd, tearAnchors: { left: tearL, right: tearR, below: tearBelow, rowL, rowR }, get tearing() { return !!torn; } };
}
