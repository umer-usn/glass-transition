/* ==========================================================================
   Glass scroll block — scroll engine
   No dependencies. Drives every .glass-block on the page.

   Timeline (p = 0 → 1 across the pinned scroll range)
     0.02 – 0.56  the front glass card zooms toward you (headline + light stay put)
     0.42 – 0.70  we pass through the pane: refraction / dispersion / frost
     0.52 – 0.72  the card behind settles into the front card's exact size and place
     0.72 – 1.00  hold still, then the page scrolls on
   ========================================================================== */
(() => {
  'use strict';

  const CFG = {
    zoom: 6.5,        // final scale of the front card
    maxDisp: 300,     // peak displacement (SVG units; ±half of this at the edges)
    maxBlur: 3.2,       // peak blur inside the refraction filter (px)
    chroma: [1, 0.92, 0.84], // R,G,B displacement ratios → colour fringing
    ghostScale: 1.13, // Figma: back card is 416 wide vs 368 (relative to front card)
    ghostLift: -27.5, // Figma: back card centre sits 27.5px above the front card's
  };

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;

  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Safari mis-renders feDisplacementMap on HTML → use the CSS-only fallback there.
  const USE_SVG_FX = !isSafari;
  const LITE = coarse || (navigator.deviceMemory && navigator.deviceMemory < 4);

  /* ---- Displacement map: a radial "lens" with ripples + glass wobble ----- */
  function buildLensMap(aspect, w = 320, h = 180) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const diag = Math.hypot(aspect, 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = ((x + 0.5) / w) * 2 - 1;
        const ny = ((y + 0.5) / h) * 2 - 1;
        const sx = nx * aspect, sy = ny;
        const len = Math.hypot(sx, sy) || 1e-6;
        const q = len / diag;
        const f = smooth(clamp((q - 0.04) / 0.96));
        const ripple = 1 + 0.16 * Math.sin(q * 24);
        const wob = 0.1 * Math.sin(nx * 5.3 + ny * 3.1) * Math.cos(ny * 4.4 - nx * 2.2);
        // negative = sample from nearer the centre → content stretches outward
        const vx = clamp(-((sx / len) * f * ripple + wob * f), -1, 1);
        const vy = clamp(-((sy / len) * f * ripple + wob * 0.8 * f), -1, 1);
        const i = (y * w + x) * 4;
        d[i] = 127.5 + 127.5 * vx;
        d[i + 1] = 127.5 + 127.5 * vy;
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  const NS = 'http://www.w3.org/2000/svg';
  function buildFilter(root, id) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gb-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const mk = (tag, attrs, parent) => {
      const el = document.createElementNS(NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(el);
      return el;
    };
    const filter = mk('filter', {
      id, filterUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1, height: 1,
      'color-interpolation-filters': 'sRGB',
    });
    const img = mk('feImage', {
      x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'map',
    }, filter);
    const blur = mk('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0, result: 'src' }, filter);
    const disp = (res) => mk('feDisplacementMap', {
      in: 'src', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: res,
    }, filter);
    const chan = (src, vals, res) => mk('feColorMatrix', { in: src, type: 'matrix', values: vals, result: res }, filter);

    let disps;
    if (LITE) {
      disps = [disp('d')];
    } else {
      const dr = disp('dr'), dg = disp('dg'), db = disp('db');
      chan('dr', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', 'r');
      chan('dg', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', 'g');
      chan('db', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', 'b');
      mk('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }, filter);
      mk('feBlend', { in: 'rg', in2: 'b', mode: 'screen' }, filter);
      disps = [dr, dg, db];
    }
    root.appendChild(svg);
    return { filter, img, blur, disps };
  }

  /* ----------------------------------------------------------------------- */
  let uid = 0;
  function init(root) {
    const $ = (s) => root.querySelector(`[data-gb="${s}"]`);
    const stage = root.querySelector('.gb-stage');
    const el = {
      copy: $('copy'), slot: $('slot'),
      beam: $('beam'), sub: $('sub'), card1: $('card1'), card2: $('card2'), body1: $('body1'), body2: $('body2'),
      veil: $('veil'), ring1: $('ring1'), ring2: $('ring2'),
    };

    if (reduceMotion) {
      root.classList.add('is-static', 'is-lit');
      [el.card1, el.card2].forEach((c) => c.classList.add('is-active'));
      return;
    }

    const fid = `gb-refract-${++uid}`;
    let fx = null;
    if (USE_SVG_FX) fx = buildFilter(root, fid);

    let W = 0, H = 0, oy = 0, range = 1;
    let target = 0, cur = 0, frozen = false, raf = 0, last = 0, visible = true;
    let lastMapAspect = 0;

    function fit() {
      W = stage.clientWidth; H = stage.clientHeight;
      // Lay the composition out like the 1440×780 Figma frame (scaled down on small screens,
      // centred vertically when the viewport is taller).
      const k = clamp(Math.min(W / 1440, H / 780), 0.72, 1);
      const top = 64 * k + Math.max(0, (H - 780 * k) / 2);
      stage.style.setProperty('--k', k.toFixed(4));
      stage.style.setProperty('--gb-top', top.toFixed(1) + 'px');
      const subBottom = el.sub.offsetTop + el.sub.offsetHeight;
      stage.style.setProperty('--slot-top', (subBottom + 111 * k).toFixed(1) + 'px');
      stage.style.setProperty('--beam-y', (subBottom + 14 * k).toFixed(1) + 'px');
      oy = el.slot.offsetTop + el.slot.offsetHeight / 2;
      stage.style.setProperty('--oy', oy + 'px');
      range = Math.max(1, root.offsetHeight - H);
      if (fx) {
        const f = fx.filter;
        f.setAttribute('width', W); f.setAttribute('height', H);
        fx.img.setAttribute('width', W); fx.img.setAttribute('height', H);
        const aspect = +(W / H).toFixed(2);
        if (aspect !== lastMapAspect) {
          lastMapAspect = aspect;
          const url = buildLensMap(aspect);
          fx.img.setAttribute('href', url);
          fx.img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
        }
      }
      measure();
    }

    function measure() {
      const r = root.getBoundingClientRect();
      const vh = innerHeight;
      root.classList.toggle('is-lit', r.top < vh * 0.28 && r.bottom > vh * 0.2);
      visible = r.bottom > -50 && r.top < vh + 50;
      if (!frozen) {
        target = clamp(-r.top / range);
        wake();
      }
    }

    function wake() { if (!raf && visible) raf = requestAnimationFrame(tick); }

    function tick(t) {
      raf = 0;
      const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
      const k = 1 - Math.exp(-dt * 10);
      cur += (target - cur) * k;
      if (Math.abs(target - cur) < 0.0002) cur = target;
      render(cur);
      if (cur !== target) raf = requestAnimationFrame(tick); else last = 0;
    }

    /* ---- The choreography ------------------------------------------------ */
    let fxOn = false;
    function render(p) {
      // Only the cards move. Headline, subtitle and light stay put.
      // camera push into the front card
      const z = seg(p, 0.02, 0.56);
      const zl = lerp(z, smooth(z), 0.4);
      const s1 = Math.exp(Math.log(CFG.zoom) * zl);

      // refraction envelope — peaks as the card passes the lens
      const D = Math.pow(Math.sin(Math.PI * seg(p, 0.42, 0.70)), 1.5);

      // front card
      const gone = smooth(seg(p, 0.50, 0.60));
      el.card1.style.transform = `scale(${s1.toFixed(4)})`;
      el.card1.style.opacity = (1 - gone).toFixed(3);
      el.card1.style.visibility = gone >= 1 ? 'hidden' : 'visible';
      const t1 = seg(p, 0.14, 0.42);
      el.body1.style.opacity = (1 - t1).toFixed(3);
      el.body1.style.filter = t1 > 0.01 ? `blur(${(t1 * 14).toFixed(1)}px)` : 'none';
      el.card1.style.setProperty('--gb-fill', zl.toFixed(3));
      el.card1.style.setProperty('--gb-sheen', lerp(-0.4, 1.4, seg(p, 0.02, 0.44)).toFixed(3));

      // card behind: a still, blurred ghost (Figma position) until we pass through,
      // then it simply is the card — same size and place as the front card was
      const reveal = smooth(seg(p, 0.52, 0.72));
      el.card2.style.transform = `translateY(${(CFG.ghostLift * (1 - reveal)).toFixed(2)}px) scale(${lerp(CFG.ghostScale, 1, reveal).toFixed(4)})`;
      el.card2.style.opacity = lerp(0.6, 1, reveal).toFixed(3);
      const b2 = lerp(2, 0, reveal); // Figma: layer blur 4 → 2px
      el.card2.style.filter = b2 > 0.05 ? `blur(${b2.toFixed(2)}px)` : 'none';
      el.body2.style.opacity = lerp(0.35, 1, reveal).toFixed(3);
      el.card2.style.setProperty('--gb-fill', '0');
      el.card2.style.setProperty('--gb-sheen', '-0.4');

      // overlays: frost veil + expanding refraction rings
      el.veil.style.opacity = (0.22 * D).toFixed(3);
      const u1 = seg(p, 0.44, 0.68), u2 = seg(p, 0.48, 0.72);
      el.ring1.style.opacity = (Math.sin(Math.PI * u1) * 0.9).toFixed(3);
      el.ring1.style.transform = `scale(${lerp(0.15, 4.5, easeOut(u1)).toFixed(3)})`;
      el.ring2.style.opacity = (Math.sin(Math.PI * u2) * 0.5).toFixed(3);
      el.ring2.style.transform = `scale(${lerp(0.1, 3.2, easeOut(u2)).toFixed(3)})`;

      // interactivity: only the card that's showing is clickable / focusable
      const a1 = p < 0.22, a2 = p > 0.78;
      el.card1.classList.toggle('is-active', a1);
      el.card2.classList.toggle('is-active', a2);
      el.card1.inert = !a1;
      el.card2.inert = !a2;

      // the glass refraction itself
      const on = D > 0.002;
      if (fx && on) {
        const S = D * CFG.maxDisp;
        fx.blur.setAttribute('stdDeviation', (D * CFG.maxBlur).toFixed(2));
        fx.disps.forEach((n, i) => n.setAttribute('scale', (S * (LITE ? 1 : CFG.chroma[i])).toFixed(1)));
        if (!fxOn) { stage.style.filter = `url(#${fid})`; fxOn = true; }
      } else if (fx && fxOn) {
        stage.style.filter = 'none'; fxOn = false;
      } else if (!fx) {
        // CSS-only fallback (Safari)
        stage.style.filter = on ? `blur(${(D * 6).toFixed(1)}px) brightness(${(1 + 0.35 * D).toFixed(2)}) saturate(${(1 + 0.4 * D).toFixed(2)})` : 'none';
      }
    }

    /* ---- Wiring ---------------------------------------------------------- */
    addEventListener('scroll', measure, { passive: true });
    addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    fit();
    cur = target; render(cur);

    // Debug / tuning hook:  GlassBlock.set(0.5)  freezes the sequence at p; GlassBlock.release() unfreezes.
    (window.GlassBlock = window.GlassBlock || {}).set = (p) => { frozen = true; target = cur = clamp(p); render(cur); };
    window.GlassBlock.release = () => { frozen = false; measure(); };
  }

  const start = () => document.querySelectorAll('.glass-block').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
