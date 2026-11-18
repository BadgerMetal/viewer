// PDF -> vector geometry -> DXF, for the PDF "Import as vector" tool.
// Reads a page's drawing operators through pdf.js (lib/pdf.min.js + lib/pdf.worker.min.js, Apache-2.0), keeps the
// stroked and filled paths and the visible text, scales them from PDF points to real size, and writes an R12 DXF.
// Bezier curves that are really circular arcs (how CAD programs export arcs and circles) come out as true ARC /
// CIRCLE entities; other curves are flattened. Works in the browser (window.pdfjsLib) and under Node (PDFVEC.use).
(function (root) {
  'use strict';
  const PDFVEC = {};
  let lib = null;
  const P = () => lib || root.pdfjsLib;
  PDFVEC.use = (pdfjs) => { lib = pdfjs; };

  // the viewer loads pdf.worker.min.js as a plain <script> (globalThis.pdfjsWorker), so pdf.js runs it on the
  // page itself: Chrome won't start a Worker from file://, and the Drive copy runs from file://
  PDFVEC.open = (buf) => P().getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  }).promise;

  // page size in inches + a preview canvas about px wide
  PDFVEC.pageInfo = async (doc, n) => {
    const pg = await doc.getPage(n), vp = pg.getViewport({ scale: 1 });
    return { w: vp.width / 72, h: vp.height / 72 };
  };
  PDFVEC.thumb = async (doc, n, px) => {
    const pg = await doc.getPage(n), vp1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: px / Math.max(vp1.width, vp1.height) });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  };

  // "1:4", "2:1", "1/4\" = 1'-0\"", "1in = 2ft", "3/16=1", "4" -> real size / paper size (4 = drawn at quarter size)
  PDFVEC.parseScale = (s) => {
    s = String(s || '').trim().toLowerCase().replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
    if (!s) return NaN;
    let m = s.match(/^([\d.\/\s-]+):([\d.\/\s-]+)$/);
    if (m) { const a = num(m[1]), b = num(m[2]); return a > 0 && b > 0 ? b / a : NaN; }
    m = s.split('=');
    if (m.length === 2) { const a = len(m[0]), b = len(m[1]); return a > 0 && b > 0 ? b / a : NaN; }
    const v = num(s);
    return v > 0 ? v : NaN;
  };
  // what a measured line should be: a bare number is in the drawing's units, anything with units is converted
  PDFVEC.parseLen = (s, units) => {
    s = String(s || '').trim().toLowerCase().replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
    const bare = num(s);
    if (bare > 0) return bare;
    const inch = len(s);
    return inch > 0 ? (units === 'mm' ? inch * 25.4 : inch) : NaN;
  };
  // 4 -> "1:4", 0.5 -> "2:1", 33.8612 -> "1:33.8612"
  PDFVEC.scaleText = (k) => { const r = (v) => String(+v.toFixed(4)); return k >= 1 ? '1:' + r(k) : r(1 / k) + ':1'; };
  // 1, 1.5, 3/16, 1 1/2, 1-1/2
  function num(t) {
    t = t.trim();
    let m = t.match(/^(\d+(?:\.\d+)?)(?:[\s-]+(\d+)\/(\d+))?$/);
    if (m) return +m[1] + (m[2] ? m[2] / m[3] : 0);
    m = t.match(/^(\d+)\/(\d+)$/);
    if (m) return m[1] / m[2];
    return NaN;
  }
  // a length with units, in inches: 1/4" 1' 1'-0" 1ft 6in 25mm 2.5cm 1m ; bare numbers count as inches
  function len(t) {
    t = t.trim();
    let m = t.match(/^(.+?)\s*(?:'|ft|feet|foot)\s*(?:-?\s*(.+?)\s*(?:"|in|inch|inches)?)?$/);
    if (m) { const f = num(m[1]), i = m[2] ? num(m[2]) : 0; return f * 12 + i; }
    m = t.match(/^(.+?)\s*(mm|cm|m)$/);
    if (m) return num(m[1]) / 25.4 * { mm: 1, cm: 10, m: 1000 }[m[2]];
    m = t.match(/^(.+?)\s*(?:"|in|inch|inches)?$/);
    return m ? num(m[1]) : NaN;
  }

  // a * b: apply b first, then a (pdf.js / PDF matrix order)
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const app = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // -> { items: [{ layer, closed, segs: [...] } | { layer, circle: {x, y, r} }], texts: [{ s, x, y, h, rot }], w, h, units }
  // segs: { t: 'L', x0, y0, x, y } | { t: 'A', x0, y0, x, y, cx, cy, r, ccw, sw (sweep, rad) } | { t: 'C', x0, y0, x1, y1, x2, y2, x, y }
  // opts.scale = real / paper (PDFVEC.parseScale), opts.units = 'in' | 'mm' (what the numbers in the result mean)
  PDFVEC.extract = async (doc, n, opts) => {
    const O = P().OPS;
    const pg = await doc.getPage(n), vp = pg.getViewport({ scale: 1 });
    const k = (opts.scale || 1) / 72 * (opts.units === 'mm' ? 25.4 : 1);
    // PDF user space -> viewport (y down, handles /Rotate and the media box offset) -> flipped back to y up, real size
    const base = mul([k, 0, 0, -k, 0, vp.height * k], vp.transform);
    const tolF = 0.1 * k;              // 0.1 pt on paper: what counts as "the same" for arcs, joins and duplicates
    const ol = await pg.getOperatorList();
    const fns = ol.fnArray, args = ol.argsArray;

    const raw = [];                    // [{ subs, fill, stroke }]
    let ctm = base, stack = [];
    let gs = { fill: [0, 0, 0], tmode: 0, font: null, fs: 1, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0 };
    let subs = [], sp = null, cx = 0, cy = 0;
    let tm = [1, 0, 0, 1, 0, 0], lm = tm;
    const texts = [];
    let images = 0;                    // scanned pages are one big picture: nothing to import
    const newSub = (x, y) => { sp = { x0: x, y0: y, segs: [], closed: false }; subs.push(sp); cx = x; cy = y; };
    const lineTo = (x, y) => { if (!sp) newSub(cx, cy); if (x !== cx || y !== cy) sp.segs.push({ t: 'L', x0: cx, y0: cy, x, y }); cx = x; cy = y; };
    const curveTo = (x1, y1, x2, y2, x, y) => { if (!sp) newSub(cx, cy); sp.segs.push({ t: 'C', x0: cx, y0: cy, x1, y1, x2, y2, x, y }); cx = x; cy = y; };
    const close = () => { if (sp) { if (cx !== sp.x0 || cy !== sp.y0) lineTo(sp.x0, sp.y0); sp.closed = true; cx = sp.x0; cy = sp.y0; sp = null; } };
    const paint = (stroke, fill) => {
      if (subs.length) raw.push({ subs, stroke, fill: fill ? gs.fill.slice() : null });
      subs = []; sp = null;
    };
    const fontOf = (ref) => { try { return pg.commonObjs.get(ref); } catch (e) { try { return pg.objs.get(ref); } catch (e2) { return null; } } };

    for (let i = 0; i < fns.length; i++) {
      const fn = fns[i], a = args[i];
      switch (fn) {
        case O.save: stack.push([ctm, Object.assign({}, gs)]); break;
        case O.restore: if (stack.length) [ctm, gs] = stack.pop(); break;
        case O.transform: ctm = mul(ctm, a); break;
        case O.paintFormXObjectBegin: stack.push([ctm, Object.assign({}, gs)]); if (a && a[0]) ctm = mul(ctm, a[0]); break;
        case O.paintFormXObjectEnd: if (stack.length) [ctm, gs] = stack.pop(); break;
        case O.setFillRGBColor: gs.fill = [a[0], a[1], a[2]]; break;
        case O.constructPath: {
          const ops = a[0], v = a[1];
          let j = 0;
          for (const op of ops) {
            if (op === O.moveTo) { const [x, y] = app(ctm, v[j], v[j + 1]); j += 2; newSub(x, y); }
            else if (op === O.lineTo) { const [x, y] = app(ctm, v[j], v[j + 1]); j += 2; lineTo(x, y); }
            else if (op === O.curveTo) {
              const p1 = app(ctm, v[j], v[j + 1]), p2 = app(ctm, v[j + 2], v[j + 3]), p3 = app(ctm, v[j + 4], v[j + 5]); j += 6;
              curveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
            } else if (op === O.curveTo2) {   // v: first control point = current point
              const p2 = app(ctm, v[j], v[j + 1]), p3 = app(ctm, v[j + 2], v[j + 3]); j += 4;
              curveTo(cx, cy, p2[0], p2[1], p3[0], p3[1]);
            } else if (op === O.curveTo3) {   // y: second control point = end point
              const p1 = app(ctm, v[j], v[j + 1]), p3 = app(ctm, v[j + 2], v[j + 3]); j += 4;
              curveTo(p1[0], p1[1], p3[0], p3[1], p3[0], p3[1]);
            } else if (op === O.closePath) close();
            else if (op === O.rectangle) {
              const x = v[j], y = v[j + 1], w = v[j + 2], h = v[j + 3]; j += 4;
              const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => app(ctm, p[0], p[1]));
              newSub(q[0][0], q[0][1]); lineTo(q[1][0], q[1][1]); lineTo(q[2][0], q[2][1]); lineTo(q[3][0], q[3][1]); close();
            }
          }
          break;
        }
        case O.stroke: paint(true, false); break;
        case O.closeStroke: close(); paint(true, false); break;
        case O.fill: case O.eoFill: paint(false, true); break;
        case O.fillStroke: case O.eoFillStroke: paint(true, true); break;
        case O.closeFillStroke: case O.closeEOFillStroke: close(); paint(true, true); break;
        case O.endPath: subs = []; sp = null; break;   // clipping paths and the like: never drawn
        case O.paintImageXObject: case O.paintInlineImageXObject: case O.paintImageMaskXObject: case O.paintJpegXObject: images++; break;

        // ---- text: placed the way pdf.js's canvas places it, so text drawn invisibly (render mode 3 / 7: the
        // searchable copy AutoCAD lays over its SHX lettering) can be left out ----
        case O.beginText: tm = lm = [1, 0, 0, 1, 0, 0]; break;
        case O.setFont: gs.font = fontOf(a[0]); gs.fs = a[1]; break;
        case O.setCharSpacing: gs.cs = a[0]; break;
        case O.setWordSpacing: gs.ws = a[0]; break;
        case O.setHScale: gs.hs = a[0] / 100; break;
        case O.setLeading: gs.lead = -a[0]; break;
        case O.setTextRise: gs.rise = a[0]; break;
        case O.setTextRenderingMode: gs.tmode = a[0]; break;
        case O.setTextMatrix: tm = lm = a.slice(0, 6); break;
        case O.moveText: tm = lm = mul(lm, [1, 0, 0, 1, a[0], a[1]]); break;
        case O.setLeadingMoveText: gs.lead = a[1]; tm = lm = mul(lm, [1, 0, 0, 1, a[0], a[1]]); break;
        case O.nextLine: tm = lm = mul(lm, [1, 0, 0, 1, 0, gs.lead]); break;
        case O.showText: case O.showSpacedText: {
          const f = gs.font, fm = (f && f.fontMatrix) || [0.001, 0, 0, 0.001, 0, 0], vert = f && f.vertical;
          const glyphs = a[0] || [];
          const fs = gs.fs, hide = (gs.tmode & 3) === 3;
          let x = 0, run = null;
          const flush = () => { if (run && run.s.trim() && !hide && !vert) placeText(run.s, run.x); run = null; };
          const placeText = (s, x0) => {
            const T = mul(ctm, mul(tm, [fs * gs.hs, 0, 0, fs, x0 * gs.hs, gs.rise]));
            const o = app(T, 0, 0), ex = app(T, 1, 0), ey = app(T, 0, 1);
            const em = Math.hypot(ey[0] - o[0], ey[1] - o[1]);
            if (!(em > 0)) return;
            texts.push({ s: s.replace(/\s+$/, ''), x: o[0], y: o[1], h: em * 0.7, em, rot: Math.atan2(ex[1] - o[1], ex[0] - o[0]) });
          };
          for (const g of glyphs) {
            if (typeof g === 'number') {
              const d = -g * fs / 1000 * (vert ? -1 : 1);
              if (d > fs * 1.2) flush();          // a wide gap inside one TJ: two separate notes
              x += d;
              continue;
            }
            if (!g) continue;
            const w = (g.width || 0) * fm[0] * fs + gs.cs + (g.isSpace ? gs.ws : 0);
            if (!run) run = { s: '', x };
            run.s += g.unicode != null ? g.unicode : (g.fontChar || '');
            x += w;
          }
          flush();
          tm = mul(tm, [1, 0, 0, 1, x * gs.hs, 0]);
          break;
        }
      }
    }

    // ---- paths -> items: fills that are pure white (masks, page backgrounds) dropped, true arcs found, duplicates out ----
    const items = [], seen = new Set();
    for (const r of raw) {
      if (!r.stroke && r.fill && r.fill[0] >= 250 && r.fill[1] >= 250 && r.fill[2] >= 250) continue;
      const layer = r.stroke ? 'PDF_Geometry' : 'PDF_Fills';
      for (const s of r.subs) {
        if (!s.closed && s.segs.length && Math.hypot(cx2(s) - s.x0, cy2(s) - s.y0) < tolF * 0.01) s.closed = true;
        const segs = simplify(s.segs, tolF);
        if (!segs.length) continue;
        const it = asCircle(segs, s.closed, tolF) || { segs, closed: s.closed };
        it.layer = layer;
        const key = keyOf(it, tolF);
        if (seen.has(key)) continue;
        seen.add(key); items.push(it);
      }
    }
    const sz = (opts.scale || 1) * (opts.units === 'mm' ? 25.4 : 1) / 72;   // w, h: the page at real size
    return { items, texts: mergeTexts(texts), images, w: vp.width * sz, h: vp.height * sz, units: opts.units || 'in' };
  };
  const cx2 = (s) => s.segs[s.segs.length - 1].x, cy2 = (s) => s.segs[s.segs.length - 1].y;

  // char-by-char or word-by-word text from the same line joined back into one note
  function mergeTexts(ts) {
    const out = [];
    for (const t of ts) {
      const p = out[out.length - 1];
      if (p && Math.abs(p.em - t.em) < p.em * 0.05 && Math.abs(p.rot - t.rot) < 0.01) {
        const c = Math.cos(t.rot), s = Math.sin(t.rot), dx = t.x - p.ex, dy = t.y - p.ey;
        const along = dx * c + dy * s, perp = -dx * s + dy * c;
        if (Math.abs(perp) < p.em * 0.1 && along > -p.em * 0.3 && along < p.em * 0.6) {
          p.s += (along > p.em * 0.15 ? ' ' : '') + t.s;
          const e = endOf(t); p.ex = e[0]; p.ey = e[1];
          continue;
        }
      }
      const e = endOf(t);
      out.push(Object.assign({}, t, { ex: e[0], ey: e[1] }));
    }
    return out.map(t => ({ s: t.s, x: t.x, y: t.y, h: t.h, rot: t.rot }));
  }
  // rough end of a text run (0.55 em a character) - only used to decide whether the next run continues it
  const endOf = (t) => [t.x + Math.cos(t.rot) * t.s.length * t.em * 0.55, t.y + Math.sin(t.rot) * t.s.length * t.em * 0.55];

  const bez = (s, t) => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * s.x0 + b * s.x1 + c * s.x2 + d * s.x, a * s.y0 + b * s.y1 + c * s.y2 + d * s.y];
  };
  // circle through three points -> [cx, cy, r] or null (collinear)
  function circ3(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return [x, y, Math.hypot(a[0] - x, a[1] - y)];
  }
  const TAU = Math.PI * 2;
  const normA = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

  // curves that are straight -> lines; curves on a circle -> arcs; neighbouring arcs of one circle -> one arc
  function simplify(segs, tol) {
    const out = [];
    for (const s of segs) {
      let q = s;
      if (s.t === 'C') {
        const L = Math.hypot(s.x - s.x0, s.y - s.y0);
        const off = (x, y) => L > 0 ? Math.abs((s.x - s.x0) * (y - s.y0) - (s.y - s.y0) * (x - s.x0)) / L : Math.hypot(x - s.x0, y - s.y0);
        const inside = (x, y) => { const t = L > 0 ? ((x - s.x0) * (s.x - s.x0) + (y - s.y0) * (s.y - s.y0)) / (L * L) : 0; return t > -0.01 && t < 1.01; };
        if (off(s.x1, s.y1) < tol && off(s.x2, s.y2) < tol && inside(s.x1, s.y1) && inside(s.x2, s.y2)) {
          q = L > 0 ? { t: 'L', x0: s.x0, y0: s.y0, x: s.x, y: s.y } : null;
        } else {
          const m = bez(s, 0.5), c = circ3([s.x0, s.y0], m, [s.x, s.y]);
          if (c && c[2] < 1e6 * tol) {
            const etol = Math.max(tol, c[2] * 1e-3);
            let ok = true;
            for (const t of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) { const p = bez(s, t); if (Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - c[2]) > etol) { ok = false; break; } }
            if (ok) {
              const ccw = (m[0] - s.x0) * (s.y - m[1]) - (m[1] - s.y0) * (s.x - m[0]) > 0;
              const a0 = Math.atan2(s.y0 - c[1], s.x0 - c[0]), a1 = Math.atan2(s.y - c[1], s.x - c[0]);
              let sw = ccw ? normA(a1 - a0) : normA(a0 - a1);
              if (sw < 1e-9) sw = TAU;
              q = { t: 'A', x0: s.x0, y0: s.y0, x: s.x, y: s.y, cx: c[0], cy: c[1], r: c[2], ccw, sw };
            }
          }
        }
      } else if (Math.hypot(s.x - s.x0, s.y - s.y0) < 1e-12) q = null;
      if (!q) continue;
      const p = out[out.length - 1];
      if (q.t === 'A' && p && p.t === 'A' && p.ccw === q.ccw && Math.hypot(p.cx - q.cx, p.cy - q.cy) < Math.max(tol, p.r * 2e-3) &&
          Math.abs(p.r - q.r) < Math.max(tol, p.r * 2e-3) && p.sw + q.sw < TAU + 1e-6) {
        out[out.length - 1] = Object.assign({}, p, { x: q.x, y: q.y, sw: p.sw + q.sw });
        continue;
      }
      out.push(q);
    }
    return out;
  }
  // a closed path that is all one circle (pdf writers draw circles as 4 bezier quarters)
  function asCircle(segs, closed, tol) {
    if (!closed) return null;
    let a = segs;
    if (a.length === 2 && a[0].t === 'A' && a[1].t === 'A' && a[0].ccw === a[1].ccw && Math.hypot(a[0].cx - a[1].cx, a[0].cy - a[1].cy) < Math.max(tol, a[0].r * 2e-3)) {
      a = [Object.assign({}, a[0], { sw: a[0].sw + a[1].sw })];
    }
    if (a.length !== 1 || a[0].t !== 'A' || Math.abs(a[0].sw - TAU) > 0.01) return null;
    return { circle: { x: a[0].cx, y: a[0].cy, r: a[0].r } };
  }
  // same shape drawn twice (fill + outline, or stacked copies) -> one; direction doesn't matter
  function keyOf(it, tol) {
    const q = (v) => Math.round(v / (tol * 2));
    if (it.circle) return `c${q(it.circle.x)},${q(it.circle.y)},${q(it.circle.r)}`;
    const pts = [[it.segs[0].x0, it.segs[0].y0], ...it.segs.map(s => [s.x, s.y])].map(p => q(p[0]) + ',' + q(p[1]));
    const types = it.segs.map(s => s.t).join('');
    const f = pts.join(' '), b = pts.slice().reverse().join(' ');
    return (it.closed ? 'z' : 'o') + types.length + ':' + (f < b ? f : b);
  }

  // ---- for the 2D viewer: [{ pts, closed, layer, circle? }] + texts [{ s, x, y, h, rot, layer }] (DXF.fromPaths) ----
  PDFVEC.forViewer = (res) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const it of res.items) {
      if (it.circle) { grow(it.circle.x - it.circle.r, it.circle.y - it.circle.r); grow(it.circle.x + it.circle.r, it.circle.y + it.circle.r); }
      else for (const s of it.segs) { grow(s.x0, s.y0); grow(s.x, s.y); }
    }
    const tol = Number.isFinite(x0) ? Math.max(Math.hypot(x1 - x0, y1 - y0) * 1.5e-4, 1e-6) : 1e-3;
    const paths = res.items.map(it => {
      if (it.circle) {
        const { x, y, r } = it.circle, n = arcN(r, TAU, tol), pts = [];
        for (let i = 0; i < n; i++) { const a = i / n * TAU; pts.push(x + r * Math.cos(a), y + r * Math.sin(a)); }
        return { pts, closed: true, layer: it.layer, circle: { x, y, r } };
      }
      const pts = [it.segs[0].x0, it.segs[0].y0];
      for (const s of it.segs) flat(s, tol, pts);
      if (it.closed && pts.length > 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
      return { pts, closed: it.closed, layer: it.layer };
    });
    const texts = res.texts.map(t => ({ s: t.s.replace(/\\/g, '\\\\').replace(/[{}]/g, '\\$&'), x: t.x, y: t.y, h: t.h, rot: t.rot, layer: 'PDF_Text' }));
    return { paths, texts };
  };
  const arcN = (r, sw, tol) => Math.max(2, Math.min(720, Math.ceil(sw / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol)))))));
  // add a segment's points after its start (already in pts)
  function flat(s, tol, pts) {
    if (s.t === 'L') { pts.push(s.x, s.y); return; }
    if (s.t === 'A') {
      const n = arcN(s.r, s.sw, tol), a0 = Math.atan2(s.y0 - s.cy, s.x0 - s.cx), d = (s.ccw ? 1 : -1) * s.sw / n;
      for (let i = 1; i < n; i++) pts.push(s.cx + s.r * Math.cos(a0 + d * i), s.cy + s.r * Math.sin(a0 + d * i));
      pts.push(s.x, s.y); return;
    }
    const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2);
    const n = Math.max(2, Math.min(200, Math.ceil(Math.sqrt(L / tol) * 0.6)));
    for (let i = 1; i < n; i++) { const p = bez(s, i / n); pts.push(p[0], p[1]); }
    pts.push(s.x, s.y);
  }

  // ---- DXF (R12 ASCII: LINE, ARC, CIRCLE, POLYLINE with bulges, TEXT - opens in AutoCAD, CypNest, MetaCAM...) ----
  PDFVEC.toDxf = (res) => {
    const o = [];
    const g = (c, v) => { o.push(String(c), String(v)); };
    const f = (v) => { const s = (Math.abs(v) < 5e-10 ? 0 : v).toFixed(6).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
    const deg = (a) => f(normA(a) * 180 / Math.PI);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const it of res.items) {
      if (it.circle) { grow(it.circle.x - it.circle.r, it.circle.y - it.circle.r); grow(it.circle.x + it.circle.r, it.circle.y + it.circle.r); }
      else for (const s of it.segs) { grow(s.x0, s.y0); grow(s.x, s.y); }
    }
    for (const t of res.texts) grow(t.x, t.y);
    if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
    const tol = Math.max(Math.hypot(x1 - x0, y1 - y0) * 1e-4, 1e-6);

    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSUNITS'); g(70, res.units === 'mm' ? 4 : 1);
    g(9, '$MEASUREMENT'); g(70, res.units === 'mm' ? 1 : 0);
    g(9, '$EXTMIN'); g(10, f(x0)); g(20, f(y0)); g(30, 0);
    g(9, '$EXTMAX'); g(10, f(x1)); g(20, f(y1)); g(30, 0);
    g(0, 'ENDSEC');
    // layers so they arrive with sensible colours: geometry white, fills grey, text yellow
    const layers = [['PDF_Geometry', 7], ['PDF_Fills', 8], ['PDF_Text', 2]];
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length + 1);
    for (const [n, c] of [['0', 7], ...layers]) { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, c); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
    g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 0.2); g(3, 'txt'); g(4, '');
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const it of res.items) {
      const L = it.layer;
      if (it.circle) { g(0, 'CIRCLE'); g(8, L); g(10, f(it.circle.x)); g(20, f(it.circle.y)); g(30, 0); g(40, f(it.circle.r)); continue; }
      const segs = it.segs;
      if (segs.length === 1 && !it.closed && segs[0].t === 'L') {
        const s = segs[0];
        g(0, 'LINE'); g(8, L); g(10, f(s.x0)); g(20, f(s.y0)); g(30, 0); g(11, f(s.x)); g(21, f(s.y)); g(31, 0); continue;
      }
      if (segs.length === 1 && !it.closed && segs[0].t === 'A') {
        const s = segs[0], a0 = Math.atan2(s.y0 - s.cy, s.x0 - s.cx), a1 = Math.atan2(s.y - s.cy, s.x - s.cx);
        g(0, 'ARC'); g(8, L); g(10, f(s.cx)); g(20, f(s.cy)); g(30, 0); g(40, f(s.r));
        g(50, deg(s.ccw ? a0 : a1)); g(51, deg(s.ccw ? a1 : a0)); continue;
      }
      // polyline: vertices with bulges for arcs, curves flattened
      const vs = [];   // [x, y, bulge to next]
      for (const s of segs) {
        if (!vs.length) vs.push([s.x0, s.y0, 0]);
        const last = vs[vs.length - 1];
        if (s.t === 'L') vs.push([s.x, s.y, 0]);
        else if (s.t === 'A') {
          // a bulge can't reach a full turn: split arcs over 180 deg in two
          const parts = s.sw > Math.PI ? 2 : 1, a0 = Math.atan2(s.y0 - s.cy, s.x0 - s.cx), d = (s.ccw ? 1 : -1) * s.sw / parts;
          let prev = last;
          for (let i = 1; i <= parts; i++) {
            prev[2] = (s.ccw ? 1 : -1) * Math.tan(s.sw / parts / 4);
            const p = i === parts ? [s.x, s.y, 0] : [s.cx + s.r * Math.cos(a0 + d * i), s.cy + s.r * Math.sin(a0 + d * i), 0];
            vs.push(p); prev = p;
          }
        } else { const pts = []; flat(s, tol, pts); for (let i = 0; i < pts.length; i += 2) vs.push([pts[i], pts[i + 1], 0]); }
      }
      if (it.closed && vs.length > 2) {
        const a = vs[0], b = vs[vs.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) vs.pop();
      }
      g(0, 'POLYLINE'); g(8, L); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, it.closed ? 1 : 0);
      for (const v of vs) { g(0, 'VERTEX'); g(8, L); g(10, f(v[0])); g(20, f(v[1])); g(30, 0); if (v[2]) g(42, f(v[2])); }
      g(0, 'SEQEND'); g(8, L);
    }
    for (const t of res.texts) {
      g(0, 'TEXT'); g(8, 'PDF_Text'); g(10, f(t.x)); g(20, f(t.y)); g(30, 0); g(40, f(t.h)); g(1, dxfStr(t.s));
      if (Math.abs(t.rot) > 1e-6) g(50, deg(t.rot));
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return o.join('\r\n') + '\r\n';
  };
  // AutoCAD's codes for the drawing symbols; anything else outside ASCII as \U+XXXX
  const dxfStr = (s) => s.replace(/%/g, '%%%').replace(/[°Ø⌀±]/g, c => ({ '°': '%%d', 'Ø': '%%c', '⌀': '%%c', '±': '%%p' })[c])
    .replace(/[^\x20-\x7e]/g, c => '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

  root.PDFVEC = PDFVEC;
  if (typeof module !== 'undefined') module.exports = PDFVEC;
})(typeof window !== 'undefined' ? window : globalThis);
