// MetaCAM .pdg (2D drawing / flat pattern) reader. Depends on OLE2 (lib/ole2.js) only.
// PDG.read(ArrayBuffer, opts?) -> Promise<{ paths, texts, units, notes, layers }>
//   paths: [{ pts:[x0,y0,x1,y1,...], closed, layer, circle?:{x,y,r} }]   world coords, millimetres (units:'mm')
//   texts: [{ s (MTEXT-coded string), x, y (bottom-left of the last line), h (cap height), pitch (line spacing), rot (rad), layer }]
//   dims: [{ lines, fills, texts }] dimension graphics as drawing primitives (see dimPrims)
//   bend lines: layers Bend / MBend (or the file's own *Bend* layer), p.bendDir 'up' (Bend) | 'down' (MBend) | null
//   (bend data on another layer), and p.bendInfo {angle°, radius, deduction, die} (mm) when the line has a bend record
//   opts.all = true also returns MetaCAM helper geometry ("_"-prefixed layers, BendLimit) that it leaves out of DXF export
// Format notes: test/pdg/FINDINGS.md
(function (root) {
  const OLE2 = root.OLE2 || ((typeof module !== 'undefined' && typeof require === 'function') ? require('./ole2.js') : null);
  const NONE = 1e99;               // MetaCAM writes 1e100 for "no arc centre"
    const HDR_AFTER_LAYERS = 0xDA;   // fixed block (text style / LOGFONT, defaults) between last layer and entity count
  // layers MetaCAM leaves out of its DXF export: internal helpers (_BendOuter/_BendInner/...) and bend-zone limits
  const HIDDEN_RE = /^(_|bendlimit$)/i;

  function inflateDrawing(s) {
    for (let i = 0; i < 64 && i + 1 < s.length; i++)
      if (s[i] === 0x78 && (s[i + 1] === 0x9C || s[i + 1] === 0xDA || s[i + 1] === 0x01 || s[i + 1] === 0x5E)) return OLE2.inflate(s.subarray(i));
    return Promise.resolve(s);
  }

  // ---------------- Drawing stream -> raw entities ----------------
  function parseDrawing(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), len = b.length;
    const i32 = (o) => dv.getInt32(o, true), i16 = (o) => dv.getInt16(o, true), f64 = (o) => dv.getFloat64(o, true);
    const notes = [];
    // layer table: [i32 count] then per layer [.. i32 nameLen][name][04 99 95 51][rgb..flags]
    const nl = i32(0);
    if (!(nl > 0 && nl < 1000)) throw new Error('PDG: unrecognised Drawing stream (layer count ' + nl + ')');
    const layers = [];
    let o = 4, lastMagic = -1;
    for (let i = 0; i < nl; i++) {
      let m = -1;
      for (let q = o; q + 4 <= len && q < o + (i ? 160 : 400); q++)
        if (b[q] === 4 && b[q + 1] === 0x99 && b[q + 2] === 0x95 && b[q + 3] === 0x51) { m = q; break; }
      if (m < 0) { if (i) break; throw new Error('PDG: layer table not found'); } // leading count is not always exact
      let name = '';
      for (let k = 1; k < 256 && k + 4 <= m - o + 8 && m - k - 4 >= 0; k++)
        if (i32(m - k - 4) === k) { for (let j = m - k; j < m; j++) name += String.fromCharCode(b[j]); break; }
      layers.push({ name: name || ('L' + i), color: [b[m + 4], b[m + 5], b[m + 6]] });
      o = m + 4; lastMagic = m;
    }

    const ents = [];
    let resyncs = 0, skippedTypes = {};
    const ann = [], texts = [], dims = []; // non-polyline records: { t, at, end } (end = start of the next polyline)
    // strict check that a type-1 (polyline) record starts at q; returns end of vertex data or -1
    const polyAt = (q, strict) => {
      if (q + 24 > len || i32(q) !== 1 || !(i32(q + 4) === 0 || (!strict && i32(q + 4) === 1))) return -1;
      const n = i32(q + 8), a = i16(q + 12) & 0xFFFF, c = i16(q + 14) & 0xFFFF, L = i32(q + 16);
      if (n < 1 || n > 1e6 || L < 0 || L >= nl || !(c & 8) || c > 0xFFF) return -1;
      const end = q + 20 + 36 * n;
      if (end > len) return -1;
      for (let i = 0, p = q + 20; i < n; i++, p += 36) {
        const x = f64(p), y = f64(p + 8), cx = f64(p + 16), cy = f64(p + 24), fl = i32(p + 32);
        if (!(Math.abs(x) < 1e7 && Math.abs(y) < 1e7)) return -1;
        if (!(Math.abs(cx) < 1e7 && Math.abs(cy) < 1e7) && !(cx > NONE && cy > NONE)) return -1;
        if (fl & ~0x3FFFF) return -1;
        if (strict && (fl & 1) && cx > NONE) return -1;
      }
      if (strict && !(a & 0x20)) { // plain trailer: [u8 ?][00][i16 colour][00 00 00][u8 hasBendData]
        if (end + 8 > len || b[end + 1] !== 0 || b[end + 4] | b[end + 5] | b[end + 6] || b[end + 7] > 1) return -1;
      }
      return end;
    };
    const readPoly = (q, end) => {
      const n = i32(q + 8), a = i16(q + 12) & 0xFFFF, L = i32(q + 16), v = [];
      for (let i = 0, p = q + 20; i < n; i++, p += 36) v.push({ x: f64(p), y: f64(p + 8), cx: f64(p + 16), cy: f64(p + 24), fl: i32(p + 32) });
      return { type: 1, a, layer: L, v, at: q, end };
    };
    const resync = (from) => {
      resyncs++;
      for (let q = from; q + 24 <= len; q++) if (b[q] === 1 && polyAt(q, true) > 0) return q;
      return len;
    };

    // Annotation records sit back to back after a non-polyline record, so a run is walked record by record.
    // type 9 = note:
    //   +12 i32 layer, +16/+24 f64 x,y, +36 f64 box width (0 = plain text), +52 f64 text height (cell; cap height = /1.4),
    //   +60 f64 rotation (rad), +76 i32 length, +80 string (MTEXT codes, \P = new line) + NUL.
    //   (x,y) is the bottom-left of the LAST line; lines stack upward one cell height apart. +10 i16 (8/16) changes
    //   nothing visible. Checked against MetaCAM's own DXF export (single and multi-line notes).
    // types 2/15 = linear/aligned, 4 = angular, 5 = diameter/radius dimension:
    //   +16 i32 n, +20 text (n bytes) + 00 01 01, i32 style length (0x94), style (+12 f64 arrow width, +20 arrow length,
    //   +52 extension-line gap, +68 extension overshoot, +76 text cell height; DXF text height = cell * 0.6), then:
    //   2/15: P1, P2 (extension origins), P3, P4 (dimension line ends), P5 (text, bottom-centre), f64 angle (rad), ...
    //   4:    P1-P2 and P3-P4 (extension lines, along the two measured lines), P5 (text, on the arc; centre = where the lines cross)   5: P1 (arrow tip), P2 (text), P3 (centre)
    //   Tails are 100/104/132.. bytes (2/15), 104/108/136 (4), 68/72/100 (5); the reader finds the next record.
    const DIM_MIN = { 2: 100, 15: 100, 4: 104, 5: 68 };
    const nextOk = (q) => {
      if (q === len) return true;
      if (q + 12 > len) return false;
      const t = i32(q);
      return t === 1 ? i32(q + 4) === 0 : t >= 0 && t <= 15 && i32(q + 4) === 0 && i32(q + 8) === 0;
    };
    const pt = (q) => [f64(q), f64(q + 8)];
    const fin = (...v) => v.every(x => Number.isFinite(x) && Math.abs(x) < 1e7);
    function readAnn(q, end) {
      for (let guard = 0; guard < 100000 && q + 12 <= end; guard++) {
        const t = i32(q);
        if (t === 9) {
          if (q + 0x51 > len) return;
          const n = i32(q + 0x4c);
          if (!(n >= 0 && q + 0x51 + n <= len) || b[q + 0x50 + n] !== 0) return;
          let s = ''; for (let j = 0; j < n; j++) s += String.fromCharCode(b[q + 0x50 + j]);
          const x = f64(q + 16), y = f64(q + 24), h = f64(q + 52), rot = f64(q + 60);
          if (fin(x, y, rot) && h > 0 && h < 1e5) texts.push({ s, x, y, h: h / 1.4, pitch: h, rot, layer: i32(q + 12) });
          q += 0x51 + n; continue;
        }
        if (!DIM_MIN[t] || q + 24 > len) return;
        const n = i32(q + 16);
        if (!(n >= 0 && n < 256)) return;
        const bs = q + 20 + n + 7, bl = bs - 4 + 4 <= len ? i32(bs - 4) : -1;
        if (!(bl >= 0x60 && bl < 0x400) || bs + bl + DIM_MIN[t] > len) return;
        let s = ''; for (let j = 0; j < n; j++) s += String.fromCharCode(b[q + 20 + j]);
        const tl = bs + bl, st = { aw: f64(bs + 12), al: f64(bs + 20), gap: f64(bs + 52), over: f64(bs + 68), h: f64(bs + 76) * 0.6 };
        const P = (t === 5 ? [0, 16, 32] : [0, 16, 32, 48, 64]).map(k => pt(tl + k));
        if (fin(...P.flat(), st.aw, st.al, st.gap, st.over) && st.h > 0 && st.h < 1e5) {
          const d = dimPrims(t, s, P, t === 4 || t === 5 ? NaN : f64(tl + 80), st);
          if (d) { d.t = t; d.P = P; dims.push(d); }   // t, P: the raw record (P1 P2 = extension origins on 2/15)
        }
        let nx = -1;
        for (let k = DIM_MIN[t]; k <= 640 && tl + k <= len; k += 4) if (nextOk(tl + k)) { nx = tl + k; break; }
        if (nx < 0) return;
        q = nx;
      }
    }

    // entity list = [i32 count] then records; usually a fixed 0xDA bytes after the last layer's magic
    const annAt = (q) => { const t = q + 12 <= len ? i32(q) : 0; return t >= 2 && t < 64 && i32(q + 4) === 0 && (i32(q + 8) & 0xFFFF) === 0; };
    const listAt = (q) => {
      if (q < 0 || q + 4 > len) return false;
      const c = i32(q);
      if (c === 0) return q + 4 + 16 >= len;               // empty drawing
      return c > 0 && c < 1e7 && (polyAt(q + 4, true) > 0 || annAt(q + 4));
    };
    let count;
    o = lastMagic + HDR_AFTER_LAYERS;
    if (!listAt(o)) {
      o = -1;
      for (let q = lastMagic + 4; q + 8 <= len && q < lastMagic + 8192; q++) if (listAt(q)) { o = q; break; }
      if (o < 0) { notes.push('entity list not found; scanned for polylines'); o = resync(lastMagic + 4); count = Infinity; }
      else notes.push('entity list header at non-standard offset');
    }
    if (count === undefined) { count = i32(o); o += 4; }
    let k = 0;
    while (o + 8 <= len && k < count) {
      const t = i32(o);
      if (t === 1) {
        const end = polyAt(o, false);
        if (end < 0) { o = resync(o + 1); count = Infinity; continue; }
        const e = readPoly(o, end); ents.push(e); k++;
        if (e.a & 0x20) { o = resync(end); count = Infinity; continue; } // a&0x20: extra block of unknown layout follows
        const tr = end;
        if (tr + 8 > len || b[tr + 1] !== 0 || b[tr + 7] > 1) { o = resync(end); count = Infinity; continue; }
        e.bendData = b[tr + 7] === 1;
        o = tr + 8;
        if (e.bendData) {
          const ver = i32(o), bl = i32(o + 4);
          if (ver === 1 && bl >= 0 && bl < 4096 && o + 8 + bl + 40 <= len) { e.bend = parseBend(dv, o + 8, bl); o += 8 + bl + 40; }
          else { o = resync(o); count = Infinity; }
        }
      } else {
        if (t === 0 && k >= count) break;
        if (!(t === 9 || DIM_MIN[t])) skippedTypes[t] = (skippedTypes[t] || 0) + 1;
        k++;
        const at = o;
        o = resync(o + 4);
        ann.push({ t, at, end: o }); // dimensions (2), text (8/9), ... carry no cut geometry; skip to next polyline
        readAnn(at, o);
        if (count !== Infinity) count = Infinity;
      }
    }
    const st = Object.keys(skippedTypes);
    if (st.length) notes.push('skipped annotation records (leader/table/point/image), types ' + st.join(','));
    return { layers, ents, texts, dims, notes, resyncs, ann };
  }

  function parseBend(dv, o, n) {
    // 84-byte bend record (offsets from its start): +40 bend deduction, +48 inside radius, +56 angle (rad,
    // MetaCAM labels the bend 180 - this), +70 die V width; all mm. +32 looks like thickness (unconfirmed).
    if (n < 78) return null;
    const f = (k) => dv.getFloat64(o + k, true), r3 = (v) => Math.round(v * 1000) / 1000;
    const ang = f(56);
    if (!(ang > 0 && ang < 2 * Math.PI)) return null;
    return { angle: r3(180 - ang * 180 / Math.PI), radius: r3(f(48)), deduction: r3(f(40)), die: r3(f(70)) };
  }

  // ---------------- dimension record -> drawing primitives (what MetaCAM draws; matches its DXF export blocks) ----------------
  // returns { lines: [[x0,y0,x1,y1,...]], fills: [[x0,y0,x1,y1,x2,y2]], texts: [{ s, x, y, h, rot, ha, va }] }  (mm)
  const readable = (a) => { // text angle kept upright: (-90deg, 90deg]
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (a > Math.PI / 2 + 1e-9) a -= Math.PI; else if (a <= -Math.PI / 2 + 1e-9) a += Math.PI;
    return a;
  };
  function dimPrims(t, s, P, ang, st) {
    const lines = [], fills = [], texts = [];
    const sub = (a, c) => [a[0] - c[0], a[1] - c[1]], len = (v) => Math.hypot(v[0], v[1]);
    const unit = (v) => { const l = len(v); return l > 1e-9 ? [v[0] / l, v[1] / l] : null; };
    const at = (p, u, k) => [p[0] + u[0] * k, p[1] + u[1] * k];
    const arrow = (tip, back) => { // back: unit vector from the tip toward the arrow's tail
      if (!back || !(st.al > 0)) return;
      const b0 = at(tip, back, st.al), w = st.aw / 2;
      fills.push([tip[0], tip[1], b0[0] - back[1] * w, b0[1] + back[0] * w, b0[0] + back[1] * w, b0[1] - back[0] * w]);
    };
    if (t === 2 || t === 15) {
      const [P1, P2, P3, P4, P5] = P;
      for (const [o, e] of [[P1, P3], [P2, P4]]) { // extension lines: gap off the part, overshoot past the dimension line
        const u = unit(sub(e, o));
        if (u && len(sub(e, o)) > st.gap) { const a = at(o, u, st.gap), c = at(e, u, st.over); lines.push([a[0], a[1], c[0], c[1]]); }
      }
      lines.push([P3[0], P3[1], P4[0], P4[1]]);
      const u = unit(sub(P4, P3));
      if (u) { arrow(P3, u); arrow(P4, [-u[0], -u[1]]); }
      const rot = Number.isFinite(ang) ? ang : (u ? Math.atan2(u[1], u[0]) : 0);
      texts.push({ s, x: P5[0], y: P5[1], h: st.h, rot: readable(rot), ha: 0.5, va: 'bottom' });
    } else if (t === 4) {
      const [P1, P2, P3, P4, T] = P;
      const d1 = unit(sub(P2, P1)), d2 = unit(sub(P4, P3));
      if (!d1 || !d2) return null;
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-9) return null;
      const w = sub(P3, P1), k = (w[0] * d2[1] - w[1] * d2[0]) / den, C = at(P1, d1, k);
      const r = len(sub(T, C)); if (!(r > 1e-6)) return null;
      // the sector (between the two lines) that holds the text
      const TAU = 2 * Math.PI, norm = (a) => ((a % TAU) + TAU) % TAU, aT = norm(Math.atan2(T[1] - C[1], T[0] - C[0]));
      const rays = [d1, [-d1[0], -d1[1]], d2, [-d2[0], -d2[1]]].map(u => ({ u, a: norm(Math.atan2(u[1], u[0])) }));
      let lo = null, hi = null;
      for (const R of rays) {
        const dLo = norm(aT - R.a), dHi = norm(R.a - aT);
        if (!lo || dLo < norm(aT - lo.a)) lo = R;
        if (!hi || dHi < norm(hi.a - aT)) hi = R;
      }
      const sweep = norm(hi.a - lo.a) || TAU, n = Math.max(4, Math.ceil(sweep / (Math.PI / 36))), arc = [];
      for (let i = 0; i <= n; i++) { const a = lo.a + sweep * i / n; arc.push(C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)); }
      lines.push(arc);
      lines.push([P1[0], P1[1], P2[0], P2[1]], [P3[0], P3[1], P4[0], P4[1]]); // MetaCAM stores the extension lines as-is
      const e0 = at(C, lo.u, r), e1 = at(C, hi.u, r);
      arrow(e0, [-lo.u[1], lo.u[0]]); arrow(e1, [hi.u[1], -hi.u[0]]);
      texts.push({ s, x: T[0], y: T[1], h: st.h, rot: readable(Math.atan2(T[1] - C[1], T[0] - C[0]) + Math.PI / 2), ha: 0.5, va: 'bottom' });
    } else if (t === 5) {
      const [tip, T] = P;
      const u = unit(sub(T, tip)); if (!u) return null;
      lines.push([tip[0], tip[1], T[0], T[1]]);
      arrow(tip, u);
      const a = Math.atan2(u[1], u[0]), rot = readable(a);
      texts.push({ s, x: T[0], y: T[1], h: st.h, rot, ha: Math.abs(rot - a) < 1e-6 ? 0 : 1, va: 'bottom' });
    } else return null;
    return { lines, fills, texts };
  }

  // ---------------- raw polyline -> viewer paths ----------------
  const TAU = Math.PI * 2;
  function arcPts(out, sx, sy, ex, ey, cx, cy, ccw, full) {
    const r = Math.hypot(sx - cx, sy - cy);
    const a0 = Math.atan2(sy - cy, sx - cx);
    let a1 = Math.atan2(ey - cy, ex - cx);
    let sweep;
    if (ccw) { sweep = a1 - a0; while (sweep <= 1e-9) sweep += TAU; } else { sweep = a1 - a0; while (sweep >= -1e-9) sweep -= TAU; }
    if (full) sweep = ccw ? TAU : -TAU;
    if (!(r > 0)) { out.push(ex, ey); return; }
    const tol = 0.01; // mm chord error
    let step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
    step = Math.min(Math.PI / 6, Math.max(Math.PI / 60, step || Math.PI / 6));
    const ns = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    // sample uniformly, plus every cardinal angle crossed so bounding boxes are exact
    const angs = [];
    for (let i = 1; i < ns; i++) angs.push(sweep * i / ns);
    const q0 = a0;
    for (let qd = -8; qd <= 8; qd++) {
      const c = qd * Math.PI / 2; let d = c - q0;
      if (ccw ? (d > 1e-9 && d < sweep - 1e-9) : (d < -1e-9 && d > sweep + 1e-9)) angs.push(d);
    }
    angs.sort((p, q) => ccw ? p - q : q - p);
    for (const d of angs) out.push(cx + r * Math.cos(a0 + d), cy + r * Math.sin(a0 + d));
    if (full) out.push(sx, sy); else out.push(ex, ey);
  }

  function toPath(e, layerName) {
    const v = e.v, n = v.length;
    // a single arc vertex (flags 0x3) is a full circle: point on circle + centre
    if (n === 1) {
      const p = v[0];
      if (p.cx > NONE) return null;
      const r = Math.hypot(p.x - p.cx, p.y - p.cy), pts = [];
      arcPts(pts, p.x, p.y, p.x, p.y, p.cx, p.cy, !(p.fl & 0x10), true);
      pts.length -= 2; // drop the repeated start point
      return { pts: [p.x, p.y].concat(pts), closed: true, layer: layerName, circle: { x: p.cx, y: p.cy, r } };
    }
    const closed = !(e.a & 1); // bit 0 = open; 0x10 = outer contour (not a closed flag)
    const pts = [v[0].x, v[0].y];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p = v[i], q = v[(i + 1) % n];
      if ((p.fl & 1) && p.cx < NONE) arcPts(pts, p.x, p.y, q.x, q.y, p.cx, p.cy, !(p.fl & 0x10), false);
      else pts.push(q.x, q.y);
    }
    if (closed) { pts.length -= 2; } // last point == first
    if (pts.length < 4) return null;
    return { pts, closed, layer: layerName };
  }

  async function read(buf, opts) {
    opts = opts || {};
    if (!OLE2) throw new Error('PDG: lib/ole2.js must be loaded before lib/pdg.js');
    const { streams } = OLE2.read(buf);
    const raw = streams.get('Root/Drawing');
    if (!raw) throw new Error('PDG: no Drawing stream (not a MetaCAM 2D drawing)');
    const b = await inflateDrawing(raw);
    const d = parseDrawing(b);
    const paths = [];
    let hidden = 0;
    for (const e of d.ents) {
      let name = (d.layers[e.layer] || {}).name || '0', dir;
      if (!opts.all && HIDDEN_RE.test(name)) { hidden++; continue; }
      // MetaCAM: Bend = bend up, MBend = bend down. The bend record carries no direction,
      // so a line with bend data on another layer (nests put them on Dimension; Rib) is a bend of unmarked direction.
      // The has-bend-data trailer flag alone is not enough: some lines on 0 set it (trailer byte 0 = 2) with no valid
      // record behind it. What they are is unknown (they form corner marks around parts); counting them as cut makes
      // phantom parts, so they are drawn as marks, never measured.
      if (/^mbend$/i.test(name)) dir = 'down'; else if (/^bend$/i.test(name)) dir = 'up';
      if (e.bend && !/bend/i.test(name)) { name = 'Bend'; dir = null; }
      else if (e.bendData && !e.bend && !/bend/i.test(name)) name = 'Mark (MetaCAM flagged)';
      const p = toPath(e, name);
      if (p) { if (e.bend) p.bendInfo = e.bend; if (dir !== undefined) p.bendDir = dir; paths.push(p); }
    }
    const texts = [];
    for (const t of d.texts) {
      const name = (d.layers[t.layer] || {}).name || '0';
      if (!opts.all && HIDDEN_RE.test(name)) continue;
      texts.push({ s: t.s, x: t.x, y: t.y, h: t.h, pitch: t.pitch, rot: t.rot, layer: name });
    }
    const notes = d.notes.slice();
    notes.push('coordinates in mm (MetaCAM stores metric internally)');
    if (hidden) notes.push(hidden + ' MetaCAM helper entities hidden (bend-zone limits, _-layers)');
    if (!paths.length) notes.push('no geometry found');
    return { paths, texts, dims: d.dims, units: 'mm', notes, layers: d.layers.map(l => l.name) };
  }

  const api = { read, _parseDrawing: parseDrawing };
  if (typeof module !== 'undefined') module.exports = api; else root.PDG = api;
})(typeof window !== 'undefined' ? window : globalThis);
