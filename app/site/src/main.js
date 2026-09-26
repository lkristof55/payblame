// payblame: boot. Lenis + ScrollTrigger, the PB-10 stage (code-split), the beats, the function UI.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { createPrintout } from './function/printout.js';
import { wireLookup, ledgerPrint, ledgerBlame, LISTED, REDACTED, diffLines, blameLines, autoRedactor, isMasked, squeeze, MASK } from './function/lookup.js';
import { receiptCanvas, receiptName } from './function/receipt.js';
import { ledger as fetchLedger, lookup, solComma, intComma } from './function/api.js';
import { sound } from './sound.js';
import { LAYOUT, hexLines, codeLines, REPO_URL, TOKEN_MINT, DEMO_MINT } from './sections/content.js';
import { createTear } from './sections/tear.js';
import { BENCH, BENCH_MACHINE } from './sections/bench.js';

gsap.registerPlugin(ScrollTrigger);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const mobile = matchMedia('(max-width: 768px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.toggle('reduced', reduced);

// ------------------------------------------------------------------ scroll
let lenis = null;
if (!reduced) {
  lenis = new Lenis({ duration: 1.1, easing: (t) => 1 - Math.pow(1 - t, 3) });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
const scrollToEl = (sel) => {
  const el = typeof sel === 'string' ? $(sel) : sel; if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset: 0, duration: 1.2 }); else el.scrollIntoView();
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]'); if (!a) return;
  const id = a.getAttribute('href'); if (id.length < 2) return;
  e.preventDefault(); closeMenu(); scrollToEl(id); history.replaceState(null, '', id);
});

// ------------------------------------------------------------------ top bar
// the control panel gets its opaque field band once content can pass under it
let underOn = null;
const syncUnder = () => { const on = scrollY > 12; if (on !== underOn) { underOn = on; document.documentElement.classList.toggle('under', on); } };
addEventListener('scroll', syncUnder, { passive: true }); syncUnder();
const lamp = $('#lamp'), lampT = $('#lamp-t'), lampS = $('#lamp-s');
function lampState({ busy, out } = {}) {
  if (busy != null) lamp.classList.toggle('busy', busy);
  if (out != null) { lamp.classList.toggle('out', out); lampT.textContent = out ? 'paper out' : 'on line'; }
}
const menuBtn = $('#menu'), menuPanel = $('#menu-panel');
function closeMenu() { menuPanel.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
menuBtn.addEventListener('click', () => { const open = menuPanel.hidden; menuPanel.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); });
function syncSound() { for (const b of [$('#snd'), $('#snd-m')]) { b.textContent = sound.on ? 'sound on' : 'sound off'; b.setAttribute('aria-pressed', String(sound.on)); b.classList.toggle('on', sound.on); } }
for (const b of [$('#snd'), $('#snd-m')]) b.addEventListener('click', () => { sound.set(!sound.on); syncSound(); if (sound.on) sound.feed(); });
syncSound();
$$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const t = b.textContent; try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; } catch { b.textContent = 'select it'; }
  setTimeout(() => { b.textContent = t; }, 1200);
}));
$('#repo-url').textContent = REPO_URL.replace('https://', '');
if (TOKEN_MINT) { $('#ca-row').hidden = false; $('#ca').textContent = TOKEN_MINT; }

// ------------------------------------------------------------------ the 3D paper: the current job, in the printer's ink
const paper = { base: [{ t: 'PAYBLAME --LEDGER', w: 2, b: true, cpi: 10 }, { t: 'reading the snapshot of every SocialFeePda ...', c: 'faded' }], extra: [], dirty: true, last: 0 };
function toPaper(l) {
  if (l.cls === 'head') return { t: l.t, b: true };
  if (l.cls === 'minus' || l.cls === 'err') return { t: l.t, c: 'red' };
  if (l.cls === 'faded' || l.cls === 'tilde' || l.cls === 'prose' || (l.cls || '').includes('status')) return { t: l.t, c: 'faded' };
  return { t: l.t, b: l.cls === 'em' || l.cls === 'cmd' };
}
// the ledger on the 3D paper never names anyone: rows print as github:#### (see lookup.js redact)
function ledgerPaper(L) {
  const b = ledgerBlame(L, 22);
  return [
    { t: 'PAYBLAME --LEDGER', w: 2, b: true, cpi: 10 },
    { t: `${String(L.snapshotAt).slice(0, 16)}Z  getProgramAccounts pump_fees  ${L.accounts?.total ?? '?'} accounts`, c: 'faded' },
    { t: '' },
    ...b.slice(0, 2).map((t) => ({ t: t.replace(' logins=masked', ''), b: true, cpi: 10 })),
    { t: '' },
    ...b.slice(2).map((t) => ({ t })),
    { t: '' },
    { t: REDACTED, c: 'faded' },
    { t: LISTED, c: 'faded' },
  ];
}
// the job currently on the 3D paper, in printout form (what a hero tear turns into a receipt)
let paperJob = null;
function setPaper(base, extra = []) { paper.base = base; paper.extra = extra; paper.dirty = true; }
let feedTimer = null;
function feedPaper(lines) { // one line per 70 ms (feed), capped at 24, then the rest at once
  clearInterval(feedTimer);
  if (reduced) { setPaper(lines); return; }
  let k = Math.min(lines.length, 2);
  setPaper(lines.slice(0, k));
  feedTimer = setInterval(() => {
    k = k >= 24 ? lines.length : k + 1;
    setPaper(lines.slice(0, k)); sound.feed();
    if (k >= lines.length) clearInterval(feedTimer);
  }, 70);
}

// ------------------------------------------------------------------ stage (three.js is code-split)
let st = null, director = null, needRender = true;
const canvas = $('#stage');
async function bootStage() {
  const [{ createStage }, { createDirector }] = await Promise.all([import('./scene/stage.js'), import('./sections/director.js')]);
  await Promise.all([document.fonts.load('400 20px "Bitcount Grid Single"'), document.fonts.load('600 20px "Bitcount Grid Single"'), document.fonts.load('600 20px "Atkinson Hyperlegible Mono"')]).catch(() => {});
  const dpr = mobile ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2);
  st = await createStage(canvas, { width: innerWidth, height: innerHeight, dpr, lines: [...paper.base, ...paper.extra], quality: mobile ? 'low' : 'high', carriage: mobile ? -0.4 : -0.9 });
  paper.dirty = false;
  director = createDirector(st, { mobile, reduced, callouts: $('#callouts') });
  director.measure();
  director.frame(performance.now(), scrollY);
  st.render();
  canvas.classList.add('live');
  // page-load self-test: the carriage homes left, returns, then the lamp fills
  if (!reduced) {
    const now = performance.now();
    director.moveCarriage(-3.9, now, 10);
    setTimeout(() => director.moveCarriage(director.base, performance.now(), 4.3), 300);
  }
  setTimeout(() => lamp.classList.add('on'), reduced ? 0 : 1000);
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { st.resize(innerWidth, innerHeight); ScrollTrigger.refresh(); director.measure(); needRender = true; }, 120);
  });
  ScrollTrigger.addEventListener('refresh', () => { director.measure(); needRender = true; });
  document.addEventListener('visibilitychange', () => { needRender = true; });
  gsap.ticker.add(tick);
}
function tick() {
  if (!st || document.hidden) return;
  const now = performance.now();
  if (paper.dirty && now - paper.last > 60) {
    st.setLines([...paper.base, ...paper.extra].slice(-46)); paper.dirty = false; paper.last = now; needRender = true;
  }
  let y = lenis ? lenis.scroll : scrollY;
  if (reduced) y = heldY(y);
  const changed = director.frame(now, y);
  if (changed || needRender) { st.render(); needRender = false; tear.place(); }
}
// reduced motion: one fixed state per beat, jumped to when the section enters
function heldY(y) {
  const s = director.state.sec; if (!s) return 0;
  const mid = y + innerHeight * 0.5;
  if (mid >= s.repo.top) return s.repo.top;
  if (mid >= s.code.top) return s.code.top + innerHeight * 0.1;
  if (mid >= s.run.top) return s.run.top;
  if (mid >= s.r.top) return s.r.end;
  if (mid >= s.p.top) return s.p.end;
  if (mid >= s.d.top) return s.d.end;
  return 0;
}

// ------------------------------------------------------------------ printouts
const onPrintLine = (l) => { sound.strike((l.t || '').length); director?.strike(Array.from({ length: 10 }, () => Math.random() < 0.5)); };
const runPO = createPrintout($('#run-print'), { reduced, mobile, onPrintLine, wrap: true, label: 'payblame output', onExpand: (all) => onRunExpand(all) });
const diffPO = createPrintout($('#diff-print'), { reduced, mobile, wrap: true, label: 'coin blame and diff' });
const layoutPO = createPrintout($('#layout-print'), { reduced, mobile, label: 'SharingConfig layout' });
const hexPO = createPrintout($('#hex-print'), { reduced, mobile, label: 'SharingConfig hex dump' });
const codePO = createPrintout($('#code-sheet'), { reduced, mobile, label: 'probeSharingConfigs source' });
const repoPO = createPrintout($('#repo-print'), { reduced, mobile, wrap: true, label: 'your receipt' });
layoutPO.setQuery('layout'); hexPO.setQuery('hexdump'); codePO.setQuery('probe'); diffPO.setQuery(DEMO_MINT);
runPO.print([{ t: '# the next job prints here: your github login, a pump mint or --ledger.', cls: 'faded' }], { stagger: 0 });

// ------------------------------------------------------------------ the ledger (hero feed)
let ledgerBody = null;
let lastJob = null;
// the receipt at the end of the page: the last job, cut to a postable length
function mirrorRepo(job) {
  lastJob = job;
  const body = job.lines.filter((l) => l.t !== LISTED && !l.more && !(l.t || '').startsWith('# done in'));
  const cap = 14;
  const lines = body.length > cap ? [...body.slice(0, cap), { t: `# ${body.length - cap} more lines in the full printout. the receipt keeps the top.`, cls: 'faded' }] : body;
  repoPO.clear(); repoPO.setQuery(job.q);
  repoPO.print([...lines, { t: LISTED, cls: 'faded' }], { stagger: 0 });
}
async function loadLedger() {
  const res = await fetchLedger();
  const stat = $('#stat');
  if (!res.ok || !res.body?.github) {
    stat.classList.add('out');
    $('#stat-n').textContent = '---'; $('#stat-n').classList.remove('wait');
    $('#stat-a').textContent = 'PAPER OUT. ledger snapshot unavailable. lookups still work.';
    $('#stat-src').textContent = 'GET /api/ledger did not answer';
    lampState({ out: true }); lampS.textContent = 'ledger --:--z';
    setPaper([{ t: 'PAYBLAME --LEDGER', w: 2, b: true, cpi: 10 }, { t: '' }, { t: 'PAPER OUT. ledger snapshot unavailable. lookups still work.', c: 'red' }]);
    paperJob = null;
    mirrorRepo({ q: 'ledger', lines: [{ t: '$ payblame --ledger', cls: 'cmd' }, { t: 'PAPER OUT. ledger snapshot unavailable. lookups still work.', cls: 'err' }] });
    return;
  }
  const L = ledgerBody = res.body;
  const g = L.github;
  $('#stat-n').textContent = solComma(g.unclaimedLamports); $('#stat-n').classList.remove('wait');
  $('#stat-a').innerHTML = `unclaimed in ${intComma(g.accounts)} GitHub social fee accounts. <span class="b">${intComma(g.neverClaimed)} never claimed.</span>`;
  const at = String(L.snapshotAt);
  $('#stat-src').textContent = `snapshot ${at.slice(0, 10)} ${at.slice(11, 16)}Z / one getProgramAccounts on pump_fees`;
  lampS.textContent = `ledger ${at.slice(11, 16)}z`;
  setPaper(ledgerPaper(L));
  paperJob = { q: '--ledger', lines: [{ t: '$ payblame --ledger', cls: 'cmd' }, ...ledgerPrint(L)] };
  mirrorRepo({ q: 'ledger', lines: paperJob.lines });
}

// ------------------------------------------------------------------ the function
let lastRun = null;
const runner = wireLookup({
  form: $('#run-form'), input: $('#run-q'), tries: $$('#run .try button'), printout: runPO,
  getLedger: fetchLedger,
  hooks: {
    busy(on) { lampState({ busy: on }); director?.busy(on); },
    out(on) { lampState({ out: on }); },
    result({ kind, lines, body }) {
      const q = $('#run-q').value.trim();
      const cmd = { t: `$ payblame ${q}`, cls: 'cmd' };
      feedPaper([cmd, ...lines].map(toPaper));
      paperJob = { q, lines: [cmd, ...lines] };
      if (kind === 'recipient') director?.strike(Array.from({ length: 10 }, (_, i) => (body.coins || []).some((c) => c.slot === i)));
      else if (kind === 'coin') director?.strike(Array.from({ length: 10 }, (_, i) => i < (body.config?.shareholders?.length || 0)));
      if (body?.meta?.timingMs) { lastRun = { q, ms: body.meta.timingMs.total, rpc: body.meta.rpcCalls, cached: body.meta.cached }; renderBench(); }
      mirrorRepo({ q, lines: [cmd, ...lines] });
    },
  },
});
// print all: the held-back rows join the paper, the mirror and the receipt
function onRunExpand(all) {
  const q = $('#run-q').value.trim();
  paperJob = { q, lines: all };
  setPaper(all.map(toPaper));
  mirrorRepo({ q, lines: all });
}
// the hero strip hands its job to the run beat
function heroRun(q) {
  $('#run-q').value = q;
  scrollToEl('#run');
  setTimeout(() => runner.run(q), reduced ? 0 : 500);
}
$('#hero-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#hero-q').value.trim(); if (q) heroRun(q); else $('#hero-q').focus(); });
$$('#ledger .try button').forEach((b) => b.addEventListener('click', () => { $('#hero-q').value = b.dataset.q; heroRun(b.dataset.q); }));
$('#ca-blame')?.addEventListener('click', () => heroRun(TOKEN_MINT));
$('#ca-copy')?.addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(TOKEN_MINT); e.currentTarget.textContent = 'copied'; } catch { /* ignore */ } });

// ------------------------------------------------------------------ beat 2: the diff (live coin blame of the demo mint)
let diff = null; // { lines (DOM), diffLn (paper lines), els }
async function loadDiff() {
  diffPO.clear();
  await diffPO.print([{ t: `$ payblame ${DEMO_MINT.slice(0, 8)}..pump`, cls: 'cmd' }], { stagger: 0 });
  const stop = diffPO.status('reading the mint, its SharingConfig and both vaults ...');
  const res = await lookup(DEMO_MINT, 100, { mask: true });
  stop();
  if (!res.ok || res.body?.kind !== 'coin') {
    await diffPO.print([{ t: 'PAPER OUT. the rpc did not answer in 8 s. the diff prints when it does.', cls: 'err' }], { stagger: 0 });
    return;
  }
  const r = res.body;
  // nobody typed this mint: the recipient's login and the coin's declared @handle are withheld here
  const hide = autoRedactor(r);
  const head = hide.lines(blameLines(r.blame));
  const dl = hide.lines(diffLines(r.diff || [])).map((l, i) => ({ ...l, step: i }));
  await diffPO.print([...head, { t: '' }, ...dl, { t: '# this job ran itself, so logins and declared handles are withheld. type the mint to print them.', cls: 'faded' }, { t: LISTED, cls: 'faded' }], { stagger: 0 });
  diff = { r, dl, els: $$('#diff-print .ln[data-step]'), paperHead: [{ t: '' }, { t: `$ payblame ${DEMO_MINT.slice(0, 8)}..pump`, b: true }, ...head.map(toPaper)] };
  $('#diff-body').textContent = hide(diffSentence(r));
  diffStep(reduced ? dl.length : diffShown, true);
}
// a masked shareholder (mask=1) has login '#…', userId null and address '#…': it prints as github:#### / x:@####
function label(s) {
  if (s.kind === 'github') return s.login && !isMasked(s.login) ? `github:${s.login}` : !isMasked(s.userId) ? `github:#${s.userId}` : `github:${MASK}`;
  if (s.kind === 'x') return s.login && !isMasked(s.login) ? `x:@${s.login}` : !isMasked(s.userId) ? `x:#${s.userId}` : `x:@${MASK}`;
  if (s.kind === 'social') return `social:${s.platform}:${isMasked(s.userId) ? MASK : '#' + s.userId}`;
  if (s.login) return isMasked(s.login) ? `${s.kind || 'account'}:${MASK}` : `${s.kind}:${s.login}`;
  const a = String(s.address || '');
  return isMasked(a) ? `wallet:${MASK}` : `wallet:${a.slice(0, 4)}..${a.slice(-4)}`;
}
function diffSentence(r) {
  if (!r.config) return 'This coin has no SharingConfig: the legacy creator wallet is paid directly on collect. Nothing is shared.';
  const pays = r.config.shareholders.map((s) => `${label(s)} ${s.bps} bps`).join(', ');
  const dec = r.declared || [];
  const src = [...new Set(dec.map((d) => d.source))].join(' and ');
  const said = dec.length ? `The ${src} names ${dec.map((d) => `${d.platform}:@${isMasked(d.handle) ? MASK : String(d.handle).replace(/^@/, '')}`).join(', ')}. ` : 'The name, symbol and description name nobody. ';
  const tail = r.mismatch ? ' The named account is not in the split. Any forwarding would happen off-chain, and not on-chain is not the same as not paid.' : '';
  return `${said}The SharingConfig pays ${pays}${r.config.adminRevoked ? ', locked' : ', MUTABLE'}.${tail}`;
}
let diffShown = 0;
function diffStep(k, force) {
  if (!diff) { diffShown = k; return; }
  k = Math.max(0, Math.min(diff.dl.length, k));
  if (k === diffShown && !force) return;
  diffShown = k;
  diff.els.forEach((el, i) => el.classList.toggle('shown', i < k));
  if (k > 0) { sound.strike(30); director?.strike(Array.from({ length: 10 }, () => Math.random() < 0.6)); }
  setPaper(paper.base, k ? [...diff.paperHead, ...diff.dl.slice(0, k).map(toPaper)] : []);
}

// ------------------------------------------------------------------ static sheets print when their beat enters
function printOnce(sel, po, lines) {
  let done = false;
  const go = () => { if (done) return; done = true; po.print(lines, { stagger: reduced ? 0 : 30 }); };
  if (reduced) go(); else ScrollTrigger.create({ trigger: sel, start: 'top 85%', once: true, onEnter: go });
}
printOnce('#pinout', layoutPO, LAYOUT);
printOnce('#ring', hexPO, hexLines({ perRow: mobile ? 8 : 16 }));
printOnce('#code', codePO, codeLines());

function renderBench() {
  const el = $('#bench');
  const rows = BENCH.map((b) => `<div class="b"><div class="num">${b.value}<small> ${b.unit}</small></div><div class="what">${b.what}</div><div class="cmd">${b.cmd}</div></div>`).join('');
  const live = lastRun ? `<div class="b"><div class="num">${intComma(lastRun.ms)}<small> ms</small></div><div class="what">your lookup of ${lastRun.q.length > 20 ? lastRun.q.slice(0, 8) + '..' + lastRun.q.slice(-4) : lastRun.q}, end to end on the server${lastRun.cached ? ' (cached)' : ''}</div><div class="cmd">meta.timingMs.total / ${lastRun.rpc} rpc calls / measured on this page just now</div></div>` : '';
  const note = BENCH.length ? `<p class="note">${BENCH_MACHINE}</p>` : '<p class="note"><span class="planned">planned</span>&nbsp; the bench/ numbers print here once they are measured on this mac with the command beside them. no number appears here that was not measured. run a lookup above and its real timing prints here.</p>';
  el.innerHTML = rows + live + note;
}
renderBench();

// ------------------------------------------------------------------ scroll beats
function beats() {
  // diff: the four diff lines strike at 25% steps; the head sweeps the line as it prints
  ScrollTrigger.create({ trigger: '#how', start: mobile ? 'top 95%' : 'top bottom', once: true, onEnter: loadDiff });
  if (!reduced) {
    ScrollTrigger.create({
      trigger: '#how', start: mobile ? 'top 55%' : 'top top', end: mobile ? 'bottom 45%' : 'bottom bottom',
      onUpdate(s) {
        const n = diff ? diff.dl.length : 4; const span = 0.8 / n;
        const p = s.progress; const k = p < 0.04 ? 0 : Math.min(n, Math.floor((p - 0.04) / span) + 1);
        diffStep(k);
        const f = ((p - 0.04) % span) / span; const dir = (k % 2) ? 1 : -1;
        const sweep = Math.min(1, Math.max(0, f / 0.4));
        director?.setDiffSweep(k === 0 || p > 0.04 + span * n ? null : dir * (-3.2 + 6.4 * sweep));
      },
      onLeave() { director?.setDiffSweep(null); },
      onLeaveBack() { director?.setDiffSweep(null); diffStep(0); },
    });
  }
  // ring: the ten probes run in slot order as the beat scrolls. Probe i fires pin i and holds it, lights the
  // 34-byte window at 80 + 34i in the hex dump and the solenoid's offset tag. Scrolling back retracts them.
  let fired = -1, wins = null;
  const probe = $('#probe');
  const setFired = (k) => {
    if (k === fired) return;
    const prev = fired; fired = k;
    if (!wins || !wins.length) wins = $$('#hex-print .w[data-slot]').map((el) => [el, +el.dataset.slot]);
    for (const [el, i] of wins) { el.classList.toggle('hit', i >= 0 && i < k - 1); el.classList.toggle('cur', i >= 0 && i === k - 1); }
    $$('#callouts .co.sol').forEach((el, i) => { el.classList.toggle('hit', i < k - 1); el.classList.toggle('cur', i === k - 1); });
    if (st) { st.P.hold(Array.from({ length: 10 }, (_, i) => i < k)); needRender = true; }
    if (k > prev && prev >= 0 && !reduced) { director?.strike(Array.from({ length: 10 }, (_, i) => i >= prev && i < k)); sound.strike(12); }
    const o = 80 + 34 * (k - 1);
    probe.innerHTML = k <= 0
      ? 'probe <b>0/10</b>&nbsp; scroll to run the ten memcmp filters'
      : `probe <b>${k}/10</b>&nbsp; memcmp { offset: <b>${o}</b> } &nbsp;slot ${k - 1}${k === 10 ? ' &nbsp;/ all ten slots searched by the node' : ''}`;
  };
  setFired(0);
  if (reduced) ScrollTrigger.create({ trigger: '#ring', start: 'top 60%', once: true, onEnter: () => setFired(10) });
  else {
    const a = mobile ? 0.12 : 0.5, b = mobile ? 0.62 : 0.92;
    ScrollTrigger.create({
      trigger: '#ring', start: mobile ? 'top 60%' : 'top top', end: mobile ? 'bottom 40%' : 'bottom bottom',
      onUpdate(s) { const f = (s.progress - a) / (b - a); setFired(f < 0 ? 0 : Math.min(10, Math.floor(f * 10) + 1)); },
      onLeave() { setFired(0); },
      onLeaveBack() { setFired(0); },
    });
  }
  // the control panel key for the section in view
  const keyFor = { ledger: 'ledger', how: 'how', pinout: 'how', ring: 'how', run: 'run', code: 'code', repo: 'repo' };
  for (const id of Object.keys(keyFor)) {
    ScrollTrigger.create({ trigger: `#${id}`, start: 'top 50%', end: 'bottom 50%', onToggle(s) { if (s.isActive) $$('.bar .keys .key').forEach((k) => k.classList.toggle('on', k.getAttribute('href') === `#${keyFor[id]}`)); } });
  }
}

// ------------------------------------------------------------------ the tear-off (signature move), in 3D
const tear = createTear({
  cue: $('#tearcue'), dock: $('#hero-receipt'), reduced, mobile, sound,
  stage: () => st, render: () => { needRender = true; },
  job: () => paperJob,
  paperLines: () => [...paper.base, ...paper.extra].slice(-46),
  inHero: () => (director ? director.state.ys < innerHeight * 0.3 : scrollY < innerHeight * 0.3),
  // on short phones the hero column rides up over the printer: the pull tab stays above the wordmark
  floorY: mobile ? () => $('.hero-col')?.getBoundingClientRect().top ?? Infinity : null,
  receipt: (job, at) => receiptCanvas({ lines: job.lines, q: job.q, printedAt: at }),
  receiptName,
  onTorn(at) {
    clearInterval(feedTimer);
    paper.base = [{ t: '' }, { t: `# torn off ${at.toISOString().slice(11, 16)}Z. the next job prints here.`, c: 'faded' }];
    paper.extra = []; paper.dirty = false;
    paperJob = null;
  },
});
// a DOM printout torn anywhere on the page tears the 3D paper too
for (const sel of ['#run-print', '#repo-print', '#diff-print']) $(sel).addEventListener('torn', () => tear.react());

// printouts change the page height: re-measure the scroll story when they do
let roT;
new ResizeObserver(() => { clearTimeout(roT); roT = setTimeout(() => { ScrollTrigger.refresh(); }, 200); }).observe($('main'));

// ------------------------------------------------------------------ boot
const ready = (async () => {
  const stage = bootStage().catch((e) => { console.warn('stage', e); });
  await Promise.all([loadLedger(), stage]);
  beats();
  ScrollTrigger.refresh();
  director?.measure();
  needRender = true;
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
})();
setTimeout(() => { if (!window.__ready) window.__ready = true; }, 7000);
export { ready };
